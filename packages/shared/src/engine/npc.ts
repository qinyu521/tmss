import type { FactionKey, GameState, Order } from '../types.js';
import { FACTION_KEYS } from '../types.js';
import type { DerivedContext } from '../dataset.js';
import { isAtWar } from '../dataset.js';
import { hashString, mulberry32 } from '../dataset.js';
import { BALANCE, grainDemandForTroops, perThousandDemand } from '../balance.js';
import { buildAdjacency, findPath } from './movement.js';
import type { Army, RegionState } from '../types.js';
import { factionTroops } from './economy.js';
import { clamp } from './state.js';

/**
 * NPC 决策：基于自身利益、资源、已知边境与性格的启发式。
 * 只生成合法意图；真正状态改由 applyOrder 与规则引擎执行。
 */
export function generateNpcOrders(state: GameState, ctx: DerivedContext): Order[] {
  const orders: Order[] = [];
  for (const key of FACTION_KEYS) {
    if (key === state.factionKey) continue;
    const rng = mulberry32(hashString(`${state.seed}-${state.date.turn}-${key}`));
    const faction = state.factions[key];
    const troops = Math.max(1, factionTroops(state, key));
    const res = faction.resources;
    let seq = 0;
    const oid = () => `npc-${key}-T${state.date.turn}-${++seq}`;

    // 1) 粮食与财政自保
    if (res.grain < grainDemandForTroops(troops, 2.5)) {
      const stores = Object.values(state.regions)
        .filter((r) => r.faction === key)
        .reduce((s, r) => s + r.foodStore, 0);
      if (stores > BALANCE.levyGrain.grainPerRegion * 0.5) {
        orders.push({ orderId: oid(), kind: 'levy_grain', amount: rng() > 0.4 ? 2 : 1 });
      }
    }
    if (res.cash < troops * BALANCE.cashPerSoldierPerWeek * 2 && rng() > 0.3) {
      orders.push({ orderId: oid(), kind: 'levy_tax', amount: 1 });
    }
    // 2) 资源短板通过贸易缓解
    if (res.salt < perThousandDemand(troops, BALANCE.saltPerThousandPerWeek, 3) && res.cash > 30_000) {
      orders.push({ orderId: oid(), kind: 'trade', resource: 'salt', amount: 120 });
    } else if (res.iron < perThousandDemand(troops, BALANCE.ironPerThousandPerWeek, 3) && res.cash > 40_000) {
      orders.push({ orderId: oid(), kind: 'trade', resource: 'iron', amount: 120 });
    }

    // 3) 军队补员
    if (troops < faction.nominalTroops * 0.82 && res.cash > 45_000 && res.manpower > 12_000) {
      orders.push({ orderId: oid(), kind: 'recruit', amount: 8_000 });
    }

    // 4) 军事行动：以部队战备、将领统率与敌方守备共同评估，不再无条件挑最大军团。
    const idleArmies = state.armies
      .filter((army) => army.faction === key && army.status === 'idle' && army.troops > 4_000 && army.supply > 35)
      .sort((a, b) => armyReadiness(b, ctx) - armyReadiness(a, ctx));
    const attack = pickEnemyAttack(state, ctx, key, idleArmies);
    const commander = attack ? ctx.charactersById[attack.army.commanderId] : undefined;
    const command = commander?.command ?? 50;
    const strategy = commander?.strategy ?? 50;
    let attackChance = 0.38 + (command - 50) / 220 + (strategy - 50) / 300;
    if (key === 'HUN' && (state.special.HUN.cohesion ?? 55) < 42) attackChance -= 0.12;
    if (key === 'YONG' && state.flags.successionCrisis) attackChance -= 0.14;
    if (key === 'CHU' && state.flags.houseBoycott) attackChance -= 0.12;
    if (res.grain < grainDemandForTroops(troops, 1.5)) attackChance -= 0.12;
    attackChance = clamp(attackChance, 0.12, 0.92);

    if (attack && rng() < attackChance) {
      orders.push({
        orderId: oid(),
        kind: 'move_army',
        armyId: attack.army.armyId,
        targetRegionId: attack.region.regionId,
      });
    } else {
      const tired = state.armies
        .filter((army) => army.faction === key && army.status === 'idle')
        .sort((a, b) => restPriority(a) - restPriority(b))[0];
      if (tired && (tired.supply < 75 || tired.fatigue > 30 || tired.morale < 45)) {
        orders.push({ orderId: oid(), kind: 'rest_army', armyId: tired.armyId });
      }
    }

    // 5) 国情政治：优先处置真正触发危机的集团，而非只看全局均值。
    if (key === 'HUN' && state.special.HUN.tribes) {
      const tribes = state.special.HUN.tribes;
      const dissatisfied = tribes.filter((tribe) => tribe.stance === 'refusing' || tribe.loyalty < 40);
      const target = dissatisfied.sort(
        (a, b) => Number(b.stance === 'refusing') - Number(a.stance === 'refusing') || a.loyalty - b.loyalty,
      )[0] ?? [...tribes].sort((a, b) => a.loyalty - b.loyalty)[0];
      if ((state.special.HUN.cohesion ?? 55) < 60 && target && target.loyalty < 60 && res.cash > 20_000) {
        orders.push({ orderId: oid(), kind: 'appease_tribe', tribeId: target.tribeId, amount: 6_000 });
      }
    }
    if (key === 'YONG') {
      const court = state.special.YONG;
      const dominantPrince = [...(court.princes ?? [])].sort((a, b) => b.influence - a.influence)[0];
      const needsBalance =
        state.flags.successionCrisis ||
        (court.courtStability ?? 60) < 52 ||
        (dominantPrince?.influence ?? 0) >= 76;
      if (needsBalance && res.cash > Math.max(45_000, BALANCE.balancePrinces.cashCost * 2.5)) {
        orders.push({ orderId: oid(), kind: 'balance_princes', amount: 1 });
      }
    }
    if (key === 'CHU' && state.special.CHU.houses) {
      const houses = state.special.CHU.houses;
      const lowest = [...houses].sort((a, b) => a.support - b.support)[0];
      const needsNegotiation = state.flags.houseBoycott || (lowest?.support ?? 100) < 50;
      if (lowest && needsNegotiation && res.cash > Math.max(35_000, BALANCE.negotiateHouse.cashCost * 2.5)) {
        orders.push({ orderId: oid(), kind: 'negotiate_house', houseId: lowest.houseId, amount: 1 });
      }
    }
  }
  return orders;
}

interface AttackCandidate {
  army: Army;
  region: RegionState;
  score: number;
}

function armyReadiness(army: Army, ctx: DerivedContext): number {
  const commander = ctx.charactersById[army.commanderId];
  const command = commander?.command ?? 50;
  const morale = clamp(army.morale) / 100;
  const training = clamp(army.training) / 100;
  const supply = clamp(army.supply) / 100;
  const fatigue = clamp(army.fatigue) / 100;
  const condition = clamp(0.54 + morale * 0.2 + training * 0.16 + supply * 0.16 - fatigue * 0.14, 0.42, 1.08);
  return army.troops * condition * (0.82 + clamp(command) / 500);
}

function restPriority(army: Army): number {
  return army.supply - army.fatigue * 0.7 - (100 - army.morale) * 0.35;
}

/**
 * 在“可走到的接壤目标”之间评估兵力比和行军成本，挑一个能打的军团-目标组合。
 * 极端不利（我军战备力量不足敌方守备的 58%）时不发起无意义的送死进攻。
 */
function pickEnemyAttack(
  state: GameState,
  ctx: DerivedContext,
  factionKey: FactionKey,
  armies: Army[],
): AttackCandidate | null {
  if (armies.length === 0) return null;
  const adjacency = buildAdjacency(ctx);
  const ownRegionIds = Object.values(state.regions)
    .filter((region) => region.faction === factionKey)
    .map((region) => region.regionId);
  const candidateIds = new Set<string>();

  for (const ownId of ownRegionIds) {
    for (const link of adjacency[ownId] ?? []) {
      const target = state.regions[link.to];
      if (!target || target.faction === factionKey) continue;
      if (!isAtWar(state.diplomacy, factionKey, target.faction)) continue;
      candidateIds.add(target.regionId);
    }
  }

  const candidates: AttackCandidate[] = [];
  for (const regionId of candidateIds) {
    const region = state.regions[regionId];
    if (!region) continue;
    const defenderArmies = state.armies
      .filter((army) => army.faction === region.faction && army.nodeId === regionId && army.troops > 0)
      .reduce((sum, army) => sum + armyReadiness(army, ctx), 0);
    const defenderPower = defenderArmies + region.garrison * 0.62 + region.fortification * 260;

    for (const army of armies) {
      const path = findPath(state, ctx, factionKey, army.nodeId, regionId);
      if (!path.ok || path.totalDays > BALANCE.turnDays * 2) continue;
      const attackPower = armyReadiness(army, ctx);
      if (attackPower < Math.max(1, defenderPower) * 0.58) continue;

      const commander = ctx.charactersById[army.commanderId];
      const commandAdvantage = ((commander?.command ?? 50) + (commander?.strategy ?? 50)) / 200;
      const localUnrest = (100 - region.loyalty) / 100;
      const defenseRatio = defenderPower / Math.max(1, attackPower);
      const travelPenalty = (path.totalDays / BALANCE.turnDays) * 0.08;
      const score = defenseRatio + travelPenalty - localUnrest * 0.08 - commandAdvantage * 0.025;
      candidates.push({ army, region, score });
    }
  }

  candidates.sort(
    (a, b) =>
      a.score - b.score ||
      b.army.troops - a.army.troops ||
      a.region.regionId.localeCompare(b.region.regionId),
  );
  return candidates[0] ?? null;
}

/** 军师/玩家可读的 NPC 意图摘要（不泄露精确状态）。 */
export function describeNpcPosture(state: GameState): { faction: FactionKey; text: string }[] {
  const out: { faction: FactionKey; text: string }[] = [];
  for (const key of FACTION_KEYS) {
    if (key === state.factionKey) continue;
    const f = state.factions[key];
    const pressure = f.statusTags.join('、');
    out.push({
      faction: key,
      text: `${f.shortName}：${pressure}。边境调动需斥候核实，朝中动向只能从使节与商路传闻推测。`,
    });
  }
  return out;
}

export function clampMorale(n: number): number {
  return clamp(n);
}
