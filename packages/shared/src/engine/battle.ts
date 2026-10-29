import type { Army, ArmyUnitStack, GameState, RegionState } from '../types.js';
import type { DerivedContext } from '../dataset.js';
import { BALANCE } from '../balance.js';
import { armyEffectiveTroops, clamp } from './state.js';
import { armyMobility, buildAdjacency } from './movement.js';
import { seasonOf } from './season.js';
import { UNIT_PROFILES } from '../unitProfiles.js';

export interface BattleOutcome {
  attackerWon: boolean;
  attackerPower: number;
  defenderPower: number;
  attackerLosses: number;
  defenderLosses: number;
  garrisonLosses: number;
  attackerRemaining: number;
  defenderRemaining: number;
  seed: number;
  narrative: string;
  replay: {
    seed: number;
    ratio: number;
    terrain: string;
    fort: number;
    attackerCommander?: { id: string; name: string; command: number; strategy: number };
    defenderCommander?: { id: string; name: string; command: number; strategy: number };
    maneuverBonus?: number;
    ambushBonus?: number;
    diversionBonus?: number;
    attackerStance?: Army['stance'];
    defenderStance?: Army['stance'];
  };
}

function unitQuality(stack: ArmyUnitStack, side: 'attack' | 'defense'): number {
  const p = UNIT_PROFILES[stack.unitId];
  if (!p) return 0.5;
  return side === 'attack'
    ? (p.attack * 0.6 + p.defense * 0.22 + p.ranged * 0.18) / 100
    : (p.defense * 0.56 + p.attack * 0.24 + p.ranged * 0.2) / 100;
}

function counterBonus(attacker: Army, defender: Army | null, region: RegionState): number {
  const defenderCategories = new Set<string>();
  if (defender) for (const u of defender.units) defenderCategories.add(u.category);
  let relations = 0;
  let matched = 0;
  for (const u of attacker.units) {
    const profile = UNIT_PROFILES[u.unitId];
    if (!profile) continue;
    for (const c of profile.counters) {
      relations++;
      if (defenderCategories.has(c)) matched++;
    }
  }
  const terrainBonus = region.terrain === 'plain' ? 0.02 : 0;
  return 1 + Math.min(0.16, matched * 0.035 + relations * 0.008) + terrainBonus;
}

function armyPower(
  state: GameState,
  ctx: DerivedContext,
  army: Army,
  side: 'attack' | 'defense',
  region: RegionState,
): { power: number; troops: number } {
  const commander = ctx.charactersById[army.commanderId];
  // 冬季河网封冻：水军袭扰受限，弓骑/轻骑如履平地（系数在 balance.seasons.winter）
  const frozenRiver = seasonOf(state.date.month) === 'winter' && region.terrain === 'river';
  let elitePower = 0;
  let eliteCount = 0;
  for (const u of army.units) {
    const p = UNIT_PROFILES[u.unitId];
    let mod = p ? p.terrain[region.terrain] : 1;
    if (frozenRiver && p) {
      if (u.category === 'naval_raider') mod *= BALANCE.seasons.winter.navalRaiderRiverPower;
      if (u.category === 'horse_archer' || u.category === 'light_cavalry') mod *= BALANCE.seasons.winter.riverCavalryPower;
    }
    elitePower += u.count * unitQuality(u, side) * mod;
    eliteCount += u.count;
  }
  const levies = Math.max(0, army.levies);
  const levyPower = levies * (side === 'attack' ? 0.42 : 0.46) * (region.terrain === 'plain' ? 1 : 0.94);
  const raw = elitePower + levyPower;
  const troops = eliteCount + levies;
  const effective = armyEffectiveTroops(state, army);
  const scale = troops > 0 ? effective / troops : 1;

  const morale = 0.6 + army.morale / 150;
  const training = 0.7 + army.training / 200;
  const supply = 0.55 + army.supply / 150;
  const fatigue = Math.max(0.7, 1 - army.fatigue / 240);
  // 统兵官的统率/谋略权重提高，名将与庸将差距显著
  const command = 0.72 + ((commander?.command ?? 55) * 0.72 + (commander?.strategy ?? 55) * 0.28) / 145;
  const cohesion = army.faction === 'HUN' ? Math.max(0.7, 0.72 + (state.special.HUN.cohesion ?? 55) / 320) : 1;
  const saltPenalty =
    state.factions[army.faction].resources.salt <= 0 ? 1 - BALANCE.economy.saltShortageMorale / 100 : 1;
  const ironPenalty =
    state.factions[army.faction].resources.iron <= 0 ? BALANCE.economy.ironShortageEquipment : 1;
  const stance = stanceModifier(army, side);
  const multiplier =
    morale * training * supply * fatigue * command * cohesion * saltPenalty * ironPenalty * scale * stance;
  return { power: raw * multiplier, troops };
}

/** 姿态不是摆设：行军突击、驻防结阵与溃退都会改变战力。 */
function stanceModifier(army: Army, side: 'attack' | 'defense'): number {
  if (side === 'attack') {
    if (army.stance === 'march') return 1 + BALANCE.battle.stanceMarchAttack;
    if (army.stance === 'retreat') return 1 - BALANCE.battle.stanceRetreatPenalty;
    return 1;
  }
  if (army.stance === 'defend') return 1 + BALANCE.battle.stanceDefendDefense;
  if (army.stance === 'march') return 1 - BALANCE.battle.stanceMarchVulnerable;
  if (army.stance === 'retreat') return 1 - BALANCE.battle.stanceRetreatPenalty;
  return 1;
}

function stanceLabel(stance: Army['stance']): string {
  return stance === 'march' ? '行军突击' : stance === 'defend' ? '结阵驻防' : stance === 'siege' ? '围城' : '溃退';
}

export function resolveBattle(
  state: GameState,
  ctx: DerivedContext,
  attacker: Army,
  defender: Army | null,
  region: RegionState,
  rngSeed: number,
): BattleOutcome {
  const atk = armyPower(state, ctx, attacker, 'attack', region);
  let def = 0;
  let defTroops = 0;
  if (defender) {
    const d = armyPower(state, ctx, defender, 'defense', region);
    def += d.power;
    defTroops += d.troops;
  }
  const fortFactor = 1 + region.fortification / 120;
  const garrisonPower = region.garrison * BALANCE.battle.garrisonQuality * fortFactor;
  def += garrisonPower;
  defTroops += region.garrison;

  const counters = counterBonus(attacker, defender, region);
  const defenderCounter = defender ? counterBonus(defender, attacker, region) : 1;
  const attackerCommander = ctx.charactersById[attacker.commanderId];
  const defenderCommander = defender ? ctx.charactersById[defender.commanderId] : undefined;
  const maneuverBonus =
    defender &&
    (region.terrain === 'plain' || region.terrain === 'hill') &&
    armyMobility(attacker) - armyMobility(defender) >= 25
      ? 0.12
      : 0;
  const ambushBonus = region.ambushBonus ?? 0;
  const diversionBonus = region.diversionFor === attacker.faction ? (region.diversionBonus ?? 0) : 0;
  const atkPower = atk.power * counters * (1 + maneuverBonus + diversionBonus);
  const defPower = def * defenderCounter * (1 + ambushBonus);

  // 确定性随机：保留种子，战报可重放
  let s = rngSeed >>> 0;
  const rand = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const noiseA = 1 + (rand() * 2 - 1) * BALANCE.battle.randomSpread;
  const noiseD = 1 + (rand() * 2 - 1) * BALANCE.battle.randomSpread;
  const a = atkPower * noiseA;
  const d = defPower * noiseD;
  const ratio = a / Math.max(1, a + d);
  const attackerWon = ratio >= 0.5;

  const intensity = Math.abs(ratio - 0.5) * 2;
  const attackerLossRate = attackerWon
    ? Math.min(0.2, BALANCE.battle.winnerLossRate * (1.2 - intensity * 0.7))
    : Math.min(BALANCE.battle.maxLossRate, BALANCE.battle.loserLossRate * (1 + intensity * 0.9));
  const defenderLossRate = attackerWon
    ? Math.min(BALANCE.battle.maxLossRate, BALANCE.battle.loserLossRate * (1 + intensity * 0.9))
    : Math.min(0.2, BALANCE.battle.winnerLossRate * (1.2 - intensity * 0.7));

  const attackerLosses = Math.round(atk.troops * attackerLossRate);
  const defenderLosses = defender ? Math.round(defender.troops * defenderLossRate) : 0;
  const garrisonLosses = Math.round(region.garrison * defenderLossRate);

  applyArmyLosses(attacker, attackerLosses);
  if (defender) applyArmyLosses(defender, defenderLosses);
  region.garrison = Math.max(0, region.garrison - garrisonLosses);
  region.garrisoned = region.garrison > 0;

  const trickLabels: string[] = [];
  if (maneuverBonus > 0) trickLabels.push('骑兵迂回');
  if (ambushBonus > 0) trickLabels.push('伏兵');
  if (diversionBonus > 0) trickLabels.push('佯攻奏效');
  const narrative =
    (attackerWon
      ? `${attacker.name}于${region.name}击破守军，双方战损约 ${attackerLosses.toLocaleString()} 对 ${(defenderLosses + garrisonLosses).toLocaleString()} 人。`
      : `${attacker.name}在${region.name}受挫，被迫退却，战损约 ${attackerLosses.toLocaleString()} 人。`) +
    (trickLabels.length ? `战场变量：${trickLabels.join('、')}。` : '') +
    `阵势：${stanceLabel(attacker.stance)}${defender ? `对${stanceLabel(defender.stance)}` : '对州兵守备'}。` +
    `统兵：${attacker.commanderName}（统率 ${attackerCommander?.command ?? '?'} / 谋略 ${attackerCommander?.strategy ?? '?'}）` +
    (defender
      ? ` 对 ${defender.commanderName}（统率 ${defenderCommander?.command ?? '?'} / 谋略 ${defenderCommander?.strategy ?? '?'}）。`
      : ' 对州兵守将。');

  region.ambushBonus = 0;
  region.diversionBonus = 0;
  region.diversionFor = null;

  return {
    attackerWon,
    attackerPower: Math.round(atkPower),
    defenderPower: Math.round(defPower),
    attackerLosses,
    defenderLosses,
    garrisonLosses,
    attackerRemaining: attacker.troops,
    defenderRemaining: (defender?.troops ?? 0) + region.garrison,
    seed: rngSeed,
    narrative,
    replay: {
      seed: rngSeed,
      ratio: Math.round(ratio * 1000) / 1000,
      terrain: region.terrain,
      fort: region.fortification,
      attackerCommander: attackerCommander
        ? {
            id: attackerCommander.person_id,
            name: attackerCommander.name,
            command: attackerCommander.command,
            strategy: attackerCommander.strategy,
          }
        : undefined,
      defenderCommander: defenderCommander
        ? {
            id: defenderCommander.person_id,
            name: defenderCommander.name,
            command: defenderCommander.command,
            strategy: defenderCommander.strategy,
          }
        : undefined,
      maneuverBonus,
      ambushBonus,
      diversionBonus,
      attackerStance: attacker.stance,
      defenderStance: defender?.stance,
    },
  };
}

export function applyArmyLosses(army: Army, losses: number): void {
  if (losses <= 0 || army.troops <= 0) return;
  const total = army.troops;
  const rate = Math.min(1, losses / total);
  let remaining = losses;
  for (const stack of army.units) {
    const lost = Math.min(stack.count, Math.round(stack.count * rate));
    stack.count -= lost;
    remaining -= lost;
  }
  const levyLoss = Math.min(army.levies, Math.max(0, remaining));
  army.levies = Math.max(0, army.levies - levyLoss);
  army.troops = army.levies + army.units.reduce((s, u) => s + u.count, 0);
  army.units = army.units.filter((u) => u.count > 0);
  if (army.troops < 60) {
    army.troops = 0;
    army.levies = 0;
    army.units = [];
    army.status = 'idle';
    army.stance = 'retreat';
  }
  army.morale = clamp(army.morale - 3);
  army.fatigue = clamp(army.fatigue + 14);
}

/** 战败后撤往相邻本国州府；无路可退则返回 null（部队溃散）。 */
export function retreatRegion(
  state: GameState,
  ctx: DerivedContext,
  army: Army,
  fromRegionId: string,
): string | null {
  const adj = buildAdjacency(ctx);
  const candidates = (adj[fromRegionId] ?? [])
    .map((l) => l.to)
    .filter((id) => state.regions[id]?.faction === army.faction && id !== fromRegionId);
  return candidates.length > 0 ? candidates[0] : null;
}
