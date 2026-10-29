import type { Army, FactionKey, GameState } from '../types.js';
import type { DerivedContext } from '../dataset.js';
import { isAtWar } from '../dataset.js';
import { BALANCE } from '../balance.js';
import { UNIT_PROFILES } from '../unitProfiles.js';
import { isRiverRoute, type Season } from './season.js';

export interface AdjacentRegion {
  to: string;
  cost: number;
  edgeId: string;
  routeType: string;
  throughput: string;
}

/**
 * 大军通过低容量道路时需为辎重、队列展开和交通拥堵付出额外时间。
 * 小部队通常无需承担该惩罚；这些是行军成本修正，不是道路封锁判定。
 */
export function routeCapacityMultiplier(troops: number, throughput: string): number {
  const size = Math.max(0, troops);
  if (/高/.test(throughput)) return 1;
  if (/争议/.test(throughput)) {
    if (size >= 50_000) return 1.6;
    if (size >= 25_000) return 1.3;
    return 1.1;
  }
  if (/低/.test(throughput)) {
    if (size >= 50_000) return 1.4;
    if (size >= 25_000) return 1.18;
    return 1;
  }
  if (/中/.test(throughput)) return size >= 50_000 ? 1.1 : 1;
  return 1;
}

export function buildAdjacency(ctx: DerivedContext): Record<string, AdjacentRegion[]> {
  const adj: Record<string, AdjacentRegion[]> = {};
  const idByName = new Map(ctx.territories.map((t) => [t.region, t.region_id]));
  const add = (
    from: string,
    to: string,
    edgeId: string,
    cost: number,
    routeType: string,
    throughput: string,
  ) => {
    adj[from] ??= [];
    adj[from].push({ to, cost, edgeId, routeType, throughput });
  };
  for (const edge of ctx.edges) {
    const from = idByName.get(edge.from_region) ?? edge.from_region;
    const to = idByName.get(edge.to_region) ?? edge.to_region;
    add(from, to, edge.edge_id, edge.base_movement_cost, edge.route_type, edge.throughput);
    add(to, from, edge.edge_id, edge.base_movement_cost, edge.route_type, edge.throughput);
  }
  return adj;
}

export function regionIdByName(ctx: DerivedContext, name: string): string | undefined {
  return ctx.territories.find((t) => t.region === name)?.region_id;
}

export function regionNameById(ctx: DerivedContext, id: string): string {
  return ctx.territories.find((t) => t.region_id === id)?.region ?? id;
}

/** 行军允许穿越：本国州府、交战国州府；目的地可为交战国。 */
export function canTraverse(state: GameState, ctx: DerivedContext, faction: FactionKey, regionId: string): boolean {
  const region = state.regions[regionId];
  if (!region) return false;
  if (region.faction === faction) return true;
  return isAtWar(state.diplomacy, faction, region.faction);
}

export interface PathResult {
  ok: boolean;
  path: string[];
  costs: number[];
  /** 与 costs 对齐的边类型（用于季节/地形行军修正） */
  routeTypes: string[];
  totalDays: number;
  error?: string;
}

export function armyMobility(army: Army): number {
  const total = army.troops || 1;
  const elite = army.units.reduce((s, u) => s + u.count, 0);
  const eliteMobility = army.units.reduce(
    (s, u) => s + u.count * (UNIT_PROFILES[u.unitId]?.mobility ?? 55),
    0,
  );
  const base = 55 * (army.levies / total) + (elite > 0 ? eliteMobility / elite : 55) * (elite / total);
  return Math.round(base);
}

/** 重甲与疲劳会拖慢行军；骑兵与轻装则更快。 */
export function marchSpeedMultiplier(army: Army): number {
  const mobility = armyMobility(army);
  const fatigue = 1 + army.fatigue / 220;
  return Math.max(0.55, Math.min(1.45, (0.72 + mobility / 130) / fatigue));
}

export function findPath(
  state: GameState,
  ctx: DerivedContext,
  faction: FactionKey,
  from: string,
  to: string,
  options: { troops?: number } = {},
): PathResult {
  if (from === to) return { ok: false, path: [], costs: [], routeTypes: [], totalDays: 0, error: '部队已在该州府。' };
  if (!state.regions[from] || !state.regions[to]) {
    return { ok: false, path: [], costs: [], routeTypes: [], totalDays: 0, error: '州府不存在。' };
  }
  if (!canTraverse(state, ctx, faction, to)) {
    const target = state.regions[to];
    return {
      ok: false,
      path: [],
      costs: [],
      routeTypes: [],
      totalDays: 0,
      error: `目标州府由${target.faction}控制，双方尚未交战，不能进军。`,
    };
  }
  const adj = buildAdjacency(ctx);
  const dist: Record<string, number> = { [from]: 0 };
  const prev: Record<string, { node: string; cost: number; routeType: string }> = {};
  const visited = new Set<string>();
  const queue: string[] = [from];
  while (queue.length > 0) {
    queue.sort((a, b) => dist[a] - dist[b]);
    const node = queue.shift() as string;
    if (visited.has(node)) continue;
    visited.add(node);
    if (node === to) break;
    for (const link of adj[node] ?? []) {
      if (!visited.has(link.to) && !canTraverse(state, ctx, faction, link.to)) continue;
      const effectiveCost =
        Math.round(link.cost * routeCapacityMultiplier(options.troops ?? 0, link.throughput) * 100) / 100;
      const candidate = dist[node] + effectiveCost;
      if (dist[link.to] === undefined || candidate < dist[link.to]) {
        dist[link.to] = candidate;
        prev[link.to] = { node, cost: effectiveCost, routeType: link.routeType };
        queue.push(link.to);
      }
    }
  }
  if (dist[to] === undefined) {
    return { ok: false, path: [], costs: [], routeTypes: [], totalDays: 0, error: '没有可用道路抵达目标（可能被中立州府阻隔）。' };
  }
  const path: string[] = [];
  const costs: number[] = [];
  const routeTypes: string[] = [];
  let cursor = to;
  while (cursor !== from) {
    path.unshift(cursor);
    costs.unshift(prev[cursor].cost);
    routeTypes.unshift(prev[cursor].routeType);
    cursor = prev[cursor].node;
  }
  return { ok: true, path, costs, routeTypes, totalDays: costs.reduce((s, c) => s + c, 0) };
}

/** 骑兵是否占全军半数以上（冬季涉渡封冻河面的前提） */
export function cavalryDominant(army: Army): boolean {
  const total = Math.max(1, army.troops);
  let mounted = army.levies * (BALANCE.economy.horsesPerCavalryRatio[army.faction] ?? 0.1);
  for (const u of army.units) {
    if (UNIT_PROFILES[u.unitId]?.visual.mount) mounted += u.count;
  }
  return mounted >= total / 2;
}

/**
 * 按部队机动性把地图成本换算为行军天数。
 * 季节修正（可选，保持纯函数与确定性）：冬季匈奴骑兵为主的部队
 * 行经河网/水路边的成本 ×0.8（河流封冻可涉渡，南下窗口），系数在 balance.seasons。
 */
export function dayCostsFor(
  army: Army,
  costs: number[],
  opts?: { routeTypes?: string[]; season?: Season },
): number[] {
  const speed = marchSpeedMultiplier(army);
  const frozenFord =
    opts?.season === 'winter' && army.faction === 'HUN' && cavalryDominant(army)
      ? BALANCE.seasons.winter.hunCavalryRiverCost
      : 1;
  return costs.map((c, i) => {
    const routeType = opts?.routeTypes?.[i] ?? '';
    const seasonal = frozenFord !== 1 && isRiverRoute(routeType) ? frozenFord : 1;
    return Math.max(1, Math.round((c * seasonal) / speed));
  });
}

export function assignMarch(army: Army, path: string[], dayCosts: number[], targetRegionId: string): void {
  army.path = path;
  army.hopCosts = dayCosts;
  army.targetRegionId = targetRegionId;
  army.stance = 'march';
  army.status = 'marching';
  army.marchDaysTotal = dayCosts.reduce((s, d) => s + d, 0);
  army.marchDaysLeft = army.marchDaysTotal;
  army.currentHopDaysTotal = dayCosts[0] ?? 0;
}

export function clearMarch(army: Army): void {
  army.path = [];
  army.hopCosts = [];
  army.targetRegionId = null;
  army.marchDaysLeft = 0;
  army.marchDaysTotal = 0;
  army.currentHopDaysTotal = 0;
  army.stance = 'defend';
  army.status = 'idle';
}

export function marchProgress(army: Army): number {
  if (army.marchDaysTotal <= 0) return 0;
  return Math.max(0, Math.min(1, 1 - army.marchDaysLeft / army.marchDaysTotal));
}

/** 计算到首都/本国最近州府的跳数，用于匈奴远征补给惩罚。 */
export function distanceToNearestOwned(
  state: GameState,
  ctx: DerivedContext,
  faction: FactionKey,
  regionId: string,
): number {
  const adj = buildAdjacency(ctx);
  const seen = new Set([regionId]);
  let frontier = [regionId];
  let depth = 0;
  while (frontier.length > 0 && depth < 12) {
    const next: string[] = [];
    for (const node of frontier) {
      if (state.regions[node]?.faction === faction) return depth;
      for (const link of adj[node] ?? []) {
        if (!seen.has(link.to)) {
          seen.add(link.to);
          next.push(link.to);
        }
      }
    }
    frontier = next;
    depth++;
  }
  return 6;
}

export function expeditionPenalty(state: GameState, ctx: DerivedContext, faction: FactionKey): number {
  if (faction !== 'HUN') return 0;
  let penalty = 0;
  for (const army of state.armies.filter((a) => a.faction === faction && a.status === 'marching')) {
    const hops = distanceToNearestOwned(state, ctx, faction, army.nodeId);
    penalty += Math.min(
      BALANCE.hunExpedition.maxPenalty,
      hops * BALANCE.hunExpedition.distanceGrainPenaltyPerHop,
    );
  }
  return Math.min(1.2, penalty);
}
