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

/** 道路容量体现大军队列、辎重与交通拥堵的额外时间成本，不代表封路。 */
export function routeCapacityMultiplier(troops: number, throughput: string): number {
  const size = Math.max(0, Number.isFinite(troops) ? troops : 0);
  if (/高/.test(throughput)) return 1;
  if (/争议|中低/.test(throughput)) {
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
  const add = (from: string, to: string, edgeId: string, cost: number, routeType: string, throughput: string) => {
    adj[from] ??= [];
    adj[from].push({ to, cost, edgeId, routeType, throughput });
  };
  for (const edge of ctx.edges) {
    const from = idByName.get(edge.from_region) ?? edge.from_region;
    const to = idByName.get(edge.to_region) ?? edge.to_region;
    add(from, to, edge.edge_id, edge.base_movement_cost, edge.route_type, edge.throughput ?? '');
    add(to, from, edge.edge_id, edge.base_movement_cost, edge.route_type, edge.throughput ?? '');
  }
  return adj;
}

export function regionIdByName(ctx: DerivedContext, name: string): string | undefined {
  return ctx.territories.find((t) => t.region === name)?.region_id;
}

export function regionNameById(ctx: DerivedContext, id: string): string {
  return ctx.territories.find((t) => t.region_id === id)?.region ?? id;
}

export function mapNodeNameById(ctx: DerivedContext, id: string): string {
  return ctx.seed.map_nodes.find((n) => n.node_id === id)?.node_name ?? id;
}

export function mapNodeRegionId(ctx: DerivedContext, mapNodeId: string): string | undefined {
  const node = ctx.seed.map_nodes.find((n) => n.node_id === mapNodeId);
  return node ? regionIdByName(ctx, node.region) : undefined;
}

export function capitalMapNodeId(ctx: DerivedContext, regionId: string): string | undefined {
  const regionName = regionNameById(ctx, regionId);
  return ctx.seed.map_nodes.find(
    (n) => n.region === regionName && n.node_type === '州府/主城',
  )?.node_id;
}

export interface AdjacentMapNode {
  to: string;
  cost: number;
  edgeId: string;
  routeType: string;
  throughput: string;
}

/** 用原始州府道路连接 24 座主城，再按 parent_node_id 接通其附属据点。 */
export function buildMapAdjacency(ctx: DerivedContext): Record<string, AdjacentMapNode[]> {
  const adj: Record<string, AdjacentMapNode[]> = {};
  const capitalByRegionName = new Map(
    ctx.seed.map_nodes.filter((n) => n.node_type === '州府/主城').map((n) => [n.region, n.node_id]),
  );
  const add = (from: string, to: string, edgeId: string, cost: number, routeType: string, throughput: string) => {
    adj[from] ??= [];
    adj[from].push({ to, cost, edgeId, routeType, throughput });
  };
  for (const edge of ctx.edges) {
    const from = capitalByRegionName.get(edge.from_region);
    const to = capitalByRegionName.get(edge.to_region);
    if (!from || !to) continue;
    add(from, to, edge.edge_id, edge.base_movement_cost, edge.route_type, edge.throughput ?? '');
    add(to, from, edge.edge_id, edge.base_movement_cost, edge.route_type, edge.throughput ?? '');
  }
  for (const node of ctx.seed.map_nodes) {
    if (!node.parent_node_id || !ctx.seed.map_nodes.some((n) => n.node_id === node.parent_node_id)) continue;
    const isPass = /关隘|边塞/.test(node.node_type);
    const isPort = /水军|渡口|港埠/.test(node.node_type);
    const cost = isPass || isPort ? 2 : 1;
    const routeType = isPass ? '关隘支路' : isPort ? '河网水路支路' : '地方支路';
    const throughput = '低';
    add(node.parent_node_id, node.node_id, 'LOCAL-' + node.node_id, cost, routeType, throughput);
    add(node.node_id, node.parent_node_id, 'LOCAL-' + node.node_id, cost, routeType, throughput);
  }
  return adj;
}

export function findMapPath(
  state: GameState,
  ctx: DerivedContext,
  faction: FactionKey,
  from: string,
  to: string,
  options: { troops?: number } = {},
): PathResult {
  if (from === to) return { ok: false, path: [], costs: [], routeTypes: [], totalDays: 0, error: '部队已在该地图节点。' };
  if (!state.mapNodes?.[from] || !state.mapNodes?.[to]) {
    return { ok: false, path: [], costs: [], routeTypes: [], totalDays: 0, error: '战略地图节点不存在或存档尚未迁移。' };
  }
  const canTraverseNode = (nodeId: string) => {
    const node = state.mapNodes?.[nodeId];
    return Boolean(node && (node.faction === faction || isAtWar(state.diplomacy, faction, node.faction)));
  };
  if (!canTraverseNode(to)) {
    const target = state.mapNodes[to];
    return { ok: false, path: [], costs: [], routeTypes: [], totalDays: 0, error: '目标据点由' + target.name + '方面控制，双方尚未交战，不能进军。' };
  }
  const adj = buildMapAdjacency(ctx);
  const troops = options.troops ?? 0;
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
      if (visited.has(link.to) || !canTraverseNode(link.to)) continue;
      const effectiveCost = link.cost * routeCapacityMultiplier(troops, link.throughput);
      const candidate = dist[node] + effectiveCost;
      if (dist[link.to] === undefined || candidate < dist[link.to]) {
        dist[link.to] = candidate;
        prev[link.to] = { node, cost: effectiveCost, routeType: link.routeType };
        queue.push(link.to);
      }
    }
  }
  if (dist[to] === undefined) {
    return { ok: false, path: [], costs: [], routeTypes: [], totalDays: 0, error: '没有可用道路抵达目标据点（可能被未交战势力阻隔）。' };
  }
  const path: string[] = [];
  const costs: number[] = [];
  const routeTypes: string[] = [];
  let cursor = to;
  while (cursor !== from) {
    const previous = prev[cursor];
    if (!previous) return { ok: false, path: [], costs: [], routeTypes: [], totalDays: 0, error: '战略路线数据不完整。' };
    path.unshift(cursor);
    costs.unshift(previous.cost);
    routeTypes.unshift(previous.routeType);
    cursor = previous.node;
  }
  return { ok: true, path, costs, routeTypes, totalDays: costs.reduce((sum, cost) => sum + cost, 0) };
}

export function assignMapMarch(
  army: Army,
  path: string[],
  dayCosts: number[],
  targetMapNodeId: string,
  targetRegionId: string,
): void {
  army.path = [];
  army.hopCosts = [];
  army.currentHopDaysTotal = 0;
  army.mapPath = path;
  army.mapHopCosts = dayCosts;
  army.mapCurrentHopDaysTotal = dayCosts[0] ?? 0;
  army.targetMapNodeId = targetMapNodeId;
  army.targetRegionId = targetRegionId;
  army.stance = 'march';
  army.status = 'marching';
  army.marchDaysTotal = dayCosts.reduce((sum, days) => sum + days, 0);
  army.marchDaysLeft = army.marchDaysTotal;
}

export function retreatMapNode(
  state: GameState,
  ctx: DerivedContext,
  army: Army,
  fromMapNodeId: string,
): string | null {
  if (!state.mapNodes) return null;
  const adjacency = buildMapAdjacency(ctx);
  const candidates = (adjacency[fromMapNodeId] ?? [])
    .map((edge) => edge.to)
    .filter((nodeId) => nodeId !== fromMapNodeId && state.mapNodes?.[nodeId]?.faction === army.faction);
  return candidates[0] ?? null;
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
  const troops = options.troops ?? 0;
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
      const effectiveCost = link.cost * routeCapacityMultiplier(troops, link.throughput);
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
  const exactDays = costs.map((c, i) => {
    const routeType = opts?.routeTypes?.[i] ?? '';
    const seasonal = frozenFord !== 1 && isRiverRoute(routeType) ? frozenFord : 1;
    return (c * seasonal) / speed;
  });

  // 只有容量倍率产生了小数成本时，才按累计行程向上分配整日，避免 1.1/1.4 天被逐段 round 回 1 天而完全抹掉拥堵代价。
  // 整数成本路线继续沿用旧的逐段 round 行为，避免无容量修正的存档路线平衡发生改变。
  if (costs.some((cost) => Math.abs(cost - Math.round(cost)) > 1e-9)) {
    let cumulativeExact = 0;
    let cumulativeScheduled = 0;
    return exactDays.map((days, i) => {
      cumulativeExact += days;
      const nextScheduled = Math.max(i + 1, Math.ceil(cumulativeExact - 1e-9));
      const scheduled = Math.max(1, nextScheduled - cumulativeScheduled);
      cumulativeScheduled += scheduled;
      return scheduled;
    });
  }

  return exactDays.map((days) => Math.max(1, Math.round(days)));
}

/** 将有效道路成本换算为行军天数，供 NPC 判断是否能及时抵达战线。 */
export function estimatePathDays(army: Army, path: PathResult, season?: Season): number {
  if (!path.ok) return Number.POSITIVE_INFINITY;
  return dayCostsFor(army, path.costs, { routeTypes: path.routeTypes, season })
    .reduce((sum, days) => sum + days, 0);
}

export function assignMarch(army: Army, path: string[], dayCosts: number[], targetRegionId: string): void {
  army.mapPath = [];
  army.mapHopCosts = [];
  army.mapCurrentHopDaysTotal = 0;
  army.targetMapNodeId = null;
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
  army.currentHopDaysTotal = 0;
  army.mapPath = [];
  army.mapHopCosts = [];
  army.mapCurrentHopDaysTotal = 0;
  army.targetMapNodeId = null;
  army.targetRegionId = null;
  army.marchDaysLeft = 0;
  army.marchDaysTotal = 0;
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
