import type { Army, FactionKey, GameEvent, GameState } from '../types.js';
import { FACTION_KEYS } from '../types.js';
import type { DerivedContext } from '../dataset.js';
import { BALANCE, grainDemandForTroops, perThousandDemand } from '../balance.js';
import { FACTION_SHORT, signed } from '../constants.js';
import { emitEvent } from './events.js';
import { clamp, cohesionFactor, housesCompliance } from './state.js';
import { expeditionPenalty } from './movement.js';
import { seasonOf } from './season.js';
import { UNIT_PROFILES } from '../unitProfiles.js';

export interface FactionEconomyTotals {
  troops: number;
  mountedTroops: number;
  grainProduced: number;
  grainUsed: number;
  saltProduced: number;
  saltUsed: number;
  ironProduced: number;
  ironUsed: number;
  horseProduced: number;
  horseUsed: number;
  taxIncome: number;
  armyPay: number;
  net: { grain: number; salt: number; iron: number; horses: number; cash: number };
  shortages: string[];
}

export function factionTroops(state: GameState, key: FactionKey): number {
  return state.armies.filter((a) => a.faction === key).reduce((s, a) => s + a.troops, 0);
}

function mountedTroopsOf(state: GameState, key: FactionKey): number {
  let mounted = 0;
  for (const army of state.armies.filter((a) => a.faction === key)) {
    for (const u of army.units) {
      if (UNIT_PROFILES[u.unitId]?.visual.mount) mounted += u.count;
    }
    mounted += army.levies * (BALANCE.economy.horsesPerCavalryRatio[key] ?? 0.1);
  }
  return Math.round(mounted);
}

export function shortageTags(state: GameState, key: FactionKey): string[] {
  const f = state.factions[key];
  const troops = Math.max(1, factionTroops(state, key));
  const tags: string[] = [];
  if (f.resources.grain < grainDemandForTroops(troops, 3)) tags.push('粮草紧张');
  if (f.resources.salt < perThousandDemand(troops, BALANCE.saltPerThousandPerWeek, 3)) tags.push('缺盐');
  if (f.resources.iron < perThousandDemand(troops, BALANCE.ironPerThousandPerWeek, 3)) tags.push('铁料不足');
  if (f.resources.horses < troops * 0.02) tags.push('缺战马');
  if (f.resources.cash < troops * 0.06 * 2) tags.push('军饷紧张');
  return tags;
}

export function computeEconomy(state: GameState, ctx: DerivedContext): Record<FactionKey, FactionEconomyTotals> {
  const result = {} as Record<FactionKey, FactionEconomyTotals>;
  // 季节修正：秋收、冬藏、晒盐等系数全部来自 balance.seasons
  const season = seasonOf(state.date.month);
  const seasonCfg = BALANCE.seasons[season];
  for (const key of FACTION_KEYS) {
    const f = state.factions[key];
    const regions = Object.values(state.regions).filter((r) => r.faction === key);
    const troops = factionTroops(state, key);
    const mounted = mountedTroopsOf(state, key);
    const orderFactor = regions.reduce((s, r) => s + (0.68 + r.order / 220), 0) / Math.max(1, regions.length);
    const grainProduced = Math.round(regions.reduce((s, r) => s + r.foodOutput, 0) * orderFactor * seasonCfg.foodOutput);
    const saltProduced = Math.round(regions.reduce((s, r) => s + r.saltOutput, 0) * orderFactor * seasonCfg.saltOutput);
    const ironProduced = Math.round(regions.reduce((s, r) => s + r.ironOutput, 0) * orderFactor);
    const horseProduced = Math.round(regions.reduce((s, r) => s + r.horseOutput, 0) * orderFactor);
    const expedition = expeditionPenalty(state, ctx, key);
    // 冬季匈奴远征草料难继，全军粮耗上浮
    const winterGrain = season === 'winter' && key === 'HUN' ? BALANCE.seasons.winter.hunGrainUse : 1;
    const grainUsed = grainDemandForTroops(troops, 1, (1 + expedition) * winterGrain);
    const saltUsed = perThousandDemand(troops, BALANCE.saltPerThousandPerWeek);
    const ironUsed =
      perThousandDemand(troops, BALANCE.ironPerThousandPerWeek) +
      state.armies.filter((a) => a.faction === key && a.status === 'marching').length * 90;
    const horseUsed = perThousandDemand(mounted, BALANCE.horsePerThousandCavalry) + (key === 'HUN' ? 40 : 10);
    let compliance = f.taxCompliance;
    if (key === 'HUN') compliance = 0.5 + (state.special.HUN.cohesion ?? 55) / 200;
    if (key === 'CHU') compliance = housesCompliance(state) * 0.95;
    if (key === 'YONG') {
      compliance = (state.flags.successionCrisis ? 0.72 : 1) * (0.55 + f.adminEfficiency / 220);
    }
    const taxes = Math.round(
      regions.reduce(
        // 冬季河网封冻，河网州府漕运与市易受阻，税收打折
        (s, r) =>
          s +
          r.taxOutput *
            (season === 'winter' && r.terrain === 'river' ? BALANCE.seasons.winter.riverTax : 1) *
            (0.6 + r.order / 200) *
            (0.75 + r.loyalty / 300),
        0,
      ) * compliance,
    );
    const armyPay = Math.round(troops * BALANCE.cashPerSoldierPerWeek + regions.reduce((s, r) => s + r.garrison * 0.004, 0));
    result[key] = {
      troops,
      mountedTroops: mounted,
      grainProduced,
      grainUsed,
      saltProduced,
      saltUsed,
      ironProduced,
      ironUsed,
      horseProduced,
      horseUsed,
      taxIncome: taxes,
      armyPay,
      net: {
        grain: grainProduced - grainUsed,
        salt: saltProduced - saltUsed,
        iron: ironProduced - ironUsed,
        horses: horseProduced - horseUsed,
        cash: taxes - armyPay,
      },
      shortages: [],
    };
  }
  return result;
}

function applyShortageEffects(state: GameState, key: FactionKey, resource: 'grain' | 'salt' | 'iron' | 'horses'): void {
  const armies = state.armies.filter((a) => a.faction === key);
  if (resource === 'grain') {
    for (const army of armies) {
      army.morale = clamp(army.morale - BALANCE.economy.grainShortageMorale);
      const desert = Math.round(army.troops * BALANCE.economy.grainShortageDesertion);
      if (desert > 0) {
        army.levies = Math.max(0, army.levies - Math.min(army.levies, desert));
        army.troops = army.levies + army.units.reduce((s, u) => s + u.count, 0);
      }
      army.supply = clamp(army.supply - 8);
    }
    for (const r of Object.values(state.regions).filter((x) => x.faction === key)) {
      r.order = clamp(r.order - 4);
      r.loyalty = clamp(r.loyalty - 3);
    }
    state.factions[key].stability = clamp(state.factions[key].stability - 4);
  }
  if (resource === 'salt') {
    for (const army of armies) {
      army.morale = clamp(army.morale - BALANCE.economy.saltShortageMorale);
      army.supply = clamp(army.supply - 4);
    }
    state.factions[key].adminEfficiency = clamp(
      state.factions[key].adminEfficiency - BALANCE.economy.saltShortageRecovery,
    );
  }
  if (resource === 'iron') {
    for (const army of armies) army.training = clamp(army.training - BALANCE.economy.ironShortageEquipment);
  }
  if (resource === 'horses') {
    for (const army of armies) {
      for (const u of army.units) {
        if (UNIT_PROFILES[u.unitId]?.visual.mount) {
          u.count = Math.max(0, Math.round(u.count * 0.98));
        }
      }
      army.units = army.units.filter((u) => u.count > 0);
      army.troops = army.levies + army.units.reduce((s, u) => s + u.count, 0);
    }
    state.factions[key].statusTags = Array.from(new Set([...state.factions[key].statusTags, '骑兵受损']));
  }
}

export function runEconomy(state: GameState, ctx: DerivedContext, events: GameEvent[]): Record<FactionKey, FactionEconomyTotals> {
  const totals = computeEconomy(state, ctx);
  for (const key of FACTION_KEYS) {
    const f = state.factions[key];
    const before = { ...f.resources };
    const t = totals[key];
    const res = f.resources;
    res.grain += t.net.grain;
    res.salt += t.net.salt;
    res.iron += t.net.iron;
    res.horses += t.net.horses;
    res.cash += t.net.cash;
    const shortages: string[] = [];
    for (const resource of ['grain', 'salt', 'iron', 'horses'] as const) {
      if (res[resource] < 0) {
        shortages.push(resource);
        applyShortageEffects(state, key, resource);
        res[resource] = 0;
      }
    }
    t.shortages = shortages;
    // 兵员恢复：春耕/秋收后农闲，入伍加快（系数在 balance.seasons）
    const manpowerRegen = BALANCE.seasons[seasonOf(state.date.month)].manpowerRegen;
    res.manpower = Math.min(
      f.nominalTroops * 0.6,
      res.manpower + Math.round(
        Object.values(state.regions).filter((r) => r.faction === key).reduce((s, r) => s + r.population, 0) *
          BALANCE.economy.manpowerRegenPerPopulation *
          manpowerRegen,
      ),
    );
    // 州府库存与治安自然恢复
    for (const r of Object.values(state.regions).filter((x) => x.faction === key)) {
      r.foodStore = Math.min(r.foodStore + Math.round(r.foodOutput * 0.25), Math.round(r.foodOutput * 6));
      r.order = clamp(r.order + BALANCE.drift.orderRecovery);
      r.loyalty = clamp(r.loyalty + BALANCE.drift.loyaltyRecovery);
      r.threat = clamp(r.threat - BALANCE.drift.threatDecay);
      r.supplyLevel = clamp(
        Math.round((f.resources.grain > 0 ? 85 : 45) + (f.resources.salt > 0 ? 8 : -15)),
      );
    }
    f.stability = clamp(f.stability);
    f.reputation = clamp(f.reputation - BALANCE.drift.reputationDecay);
    f.statusTags = Array.from(new Set([...shortageTags(state, key), ...politicalTags(state, key)]));

    if (key === state.factionKey) {
      events.push(
        emitEvent(state, {
          type: 'resource',
          title: `${FACTION_SHORT[key]}·国库奏报`,
          summary: `粮 ${signed(t.net.grain)}，盐 ${signed(t.net.salt)}，铁 ${signed(t.net.iron)}，战马 ${signed(t.net.horses)}，银钱 ${signed(t.net.cash)}。`,
          actorId: 'system',
          actorName: '户部/王庭账房',
          factionKey: key,
          targetLabel: '国家资源账本',
          before,
          after: { ...f.resources },
          evidence: `产出 粮${t.grainProduced}/盐${t.saltProduced}/铁${t.ironProduced}/马${t.horseProduced}；消耗 粮${t.grainUsed}/盐${t.saltUsed}/铁${t.ironUsed}/马${t.horseUsed}`,
          source: 'engine',
        }),
      );
    }
    for (const resource of shortages) {
      events.push(
        emitEvent(state, {
          type: 'shortage',
          title: `${FACTION_SHORT[key]}·${resource === 'grain' ? '粮荒' : resource === 'salt' ? '盐竭' : resource === 'iron' ? '铁料告罄' : '战马不足'}`,
          summary: `库存见底：${resource}。相关惩罚已按规则结算（士气、逃兵、训练、骑兵损耗）。`,
          actorId: 'system',
          actorName: '度支/军需官',
          factionKey: key,
          targetLabel: FACTION_SHORT[key],
          after: { resource, shortage: true },
          evidence: `库存为 0，消耗继续；系数来自 config/balance.ts`,
          visibleToPlayer: key === state.factionKey,
        }),
      );
    }
  }
  return totals;
}

export function politicalTags(state: GameState, key: FactionKey): string[] {
  if (key === 'HUN') {
    const tags = [`联盟协调度 ${Math.round(state.special.HUN.cohesion ?? 0)}`];
    if (state.flags.tribalRefusal) tags.push('部落拒命');
    return tags;
  }
  if (key === 'YONG') {
    const tags = [`朝局稳定 ${Math.round(state.special.YONG.courtStability ?? 0)}`];
    if (state.flags.successionCrisis) tags.push('夺嫡危机');
    return tags;
  }
  const tags = [`世家支持 ${Math.round(state.special.CHU.centralAuthority ?? 0)}`];
  if (state.flags.houseBoycott) tags.push('世家抵制');
  return tags;
}
