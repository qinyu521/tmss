import type { FactionKey, GameState, Order } from '../types.js';
import { FACTION_KEYS } from '../types.js';
import type { DerivedContext } from '../dataset.js';
import { isAtWar } from '../dataset.js';
import { hashString, mulberry32 } from '../dataset.js';
import { BALANCE } from '../balance.js';
import { buildAdjacency, estimatePathDays, findPath } from './movement.js';
import { factionTroops } from './economy.js';
import { clamp } from './state.js';
import { seasonOf } from './season.js';

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
    if (res.grain < troops * BALANCE.grainPerThousandPerWeek * 2.5) {
      const stores = Object.values(state.regions)
        .filter((r) => r.faction === key)
        .reduce((s, r) => s + r.foodStore, 0);
      if (stores > BALANCE.levyGrain.grainPerRegion * 0.5) {
        orders.push({ orderId: oid(), kind: 'levy_grain', amount: rng() > 0.4 ? 2 : 1 });
      }
    }
    if (res.cash < troops * 0.06 * 2 && rng() > 0.3) {
      orders.push({ orderId: oid(), kind: 'levy_tax', amount: 1 });
    }
    // 2) 资源短板通过贸易缓解
    if (res.salt < troops * 0.0015 * 3 && res.cash > 30_000) {
      orders.push({ orderId: oid(), kind: 'trade', resource: 'salt', amount: 120 });
    } else if (res.iron < troops * 0.0008 * 3 && res.cash > 40_000) {
      orders.push({ orderId: oid(), kind: 'trade', resource: 'iron', amount: 120 });
    }

    // 3) 军队补员
    if (troops < faction.nominalTroops * 0.82 && res.cash > 45_000 && res.manpower > 12_000) {
      orders.push({ orderId: oid(), kind: 'recruit', amount: 8_000 });
    }

    // 4) 军事行动：选择兵力较弱且与本国接壤的敌方州府
    const hostileRegion = pickEnemyBorderRegion(state, ctx, key);
    const idleArmies = state.armies
      .filter((a) => a.faction === key && a.status === 'idle' && a.troops > 4_000 && a.supply > 45)
      .sort((a, b) => b.troops - a.troops);
    if (hostileRegion && idleArmies.length > 0 && rng() > 0.2) {
      const army = idleArmies[0];
      const path = findPath(state, ctx, key, army.nodeId, hostileRegion, { troops: army.troops });
      const estimatedDays = path.ok ? estimatePathDays(army, path, seasonOf(state.date.month)) : Infinity;
      if (path.ok && estimatedDays <= BALANCE.turnDays * 2) {
        orders.push({ orderId: oid(), kind: 'move_army', armyId: army.armyId, targetRegionId: hostileRegion });
      }
    } else {
      const tired = state.armies
        .filter((a) => a.faction === key && a.status === 'idle')
        .sort((a, b) => a.supply - b.supply)[0];
      if (tired && tired.supply < 70) {
        orders.push({ orderId: oid(), kind: 'rest_army', armyId: tired.armyId });
      }
    }

    // 5) 国情政治
    if (key === 'HUN' && state.special.HUN.tribes) {
      const lowest = [...state.special.HUN.tribes].sort((a, b) => a.loyalty - b.loyalty)[0];
      if ((state.special.HUN.cohesion ?? 55) < 60 && lowest && res.cash > 20_000) {
        orders.push({ orderId: oid(), kind: 'appease_tribe', tribeId: lowest.tribeId, amount: 6_000 });
      }
    }
    if (key === 'YONG' && (state.special.YONG.courtStability ?? 60) < 52 && res.cash > 60_000) {
      orders.push({ orderId: oid(), kind: 'balance_princes', amount: 1 });
    }
    if (key === 'CHU' && state.special.CHU.houses) {
      const lowest = [...state.special.CHU.houses].sort((a, b) => a.support - b.support)[0];
      if (lowest && lowest.support < 50 && res.cash > 40_000) {
        orders.push({ orderId: oid(), kind: 'negotiate_house', houseId: lowest.houseId, amount: 1 });
      }
    }
  }
  return orders;
}

function pickEnemyBorderRegion(state: GameState, ctx: DerivedContext, factionKey: FactionKey): string | null {
  const adj = buildAdjacency(ctx);
  const ownRegionIds = Object.values(state.regions)
    .filter((r) => r.faction === factionKey)
    .map((r) => r.regionId);
  const candidates: { regionId: string; score: number }[] = [];
  for (const ownId of ownRegionIds) {
    for (const link of adj[ownId] ?? []) {
      const target = state.regions[link.to];
      if (!target) continue;
      if (target.faction === factionKey) continue;
      if (!isAtWar(state.diplomacy, factionKey, target.faction)) continue;
      const defenderArmies = state.armies
        .filter((a) => a.faction === target.faction && a.nodeId === target.regionId)
        .reduce((s, a) => s + a.troops, 0);
      const score = defenderArmies + target.garrison * 0.6 + target.fortification * 120;
      candidates.push({ regionId: target.regionId, score });
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.score - b.score);
  return candidates[0].regionId;
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
