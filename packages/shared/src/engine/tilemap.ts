import type { Army, FactionKey, GameState, MapEdgeSeed, MapNodeSeed, TerritorySeed } from '../types.js';
import type { DerivedContext } from '../dataset.js';
import { isAtWar } from '../dataset.js';
import art from '../../../../data/derived/map_art.json';

/**
 * 真·格子战略地图：把 24 州府、72 据点和既有美术地形栅格化为可寻路的方格。
 * 州府行政、战斗与人物规则仍沿用原有引擎，格子只负责“怎么走、走到哪”。
 */

export const TILE_SIZE = 0.1;
export const GRID_MIN_X = 1.1;
export const GRID_MIN_Y = -0.9;
export const GRID_MAX_X = 8.3;
export const GRID_MAX_Y = 7.3;
export const GRID_WIDTH = Math.round((GRID_MAX_X - GRID_MIN_X) / TILE_SIZE);
export const GRID_HEIGHT = Math.round((GRID_MAX_Y - GRID_MIN_Y) / TILE_SIZE);
/** 每格折算的行军日数（7 日 / 20 点移动力）。 */
export const TILE_COST_DAYS = 7 / 20;
/** 一次行军的移动力上限基准，机动性会在此上下浮动。 */
export const TILE_MP_BASE = 20;

export type TileTerrain =
  | 'plain'
  | 'forest'
  | 'hill'
  | 'mountain'
  | 'river'
  | 'lake'
  | 'sea'
  | 'road'
  | 'bridge'
  | 'pass'
  | 'city'
  | 'node';

export const TILE_TERRAIN_INFO: Record<
  TileTerrain,
  { label: string; cost: number; passable: boolean; color: string }
> = {
  plain: { label: '平原', cost: 1, passable: true, color: '#6d6746' },
  forest: { label: '森林', cost: 2, passable: true, color: '#3f5a3c' },
  hill: { label: '丘陵', cost: 2, passable: true, color: '#746449' },
  mountain: { label: '山岭', cost: 3, passable: false, color: '#575148' },
  river: { label: '河流', cost: 3, passable: false, color: '#2f5b67' },
  lake: { label: '湖泊', cost: 3, passable: false, color: '#2a5461' },
  sea: { label: '海域', cost: 3, passable: false, color: '#16333c' },
  road: { label: '道路', cost: 1, passable: true, color: '#b49a63' },
  bridge: { label: '桥梁', cost: 1, passable: true, color: '#c9ad6e' },
  pass: { label: '关隘', cost: 1, passable: true, color: '#a98a56' },
  city: { label: '城池', cost: 1, passable: true, color: '#c8a35d' },
  node: { label: '据点', cost: 1, passable: true, color: '#b28e5b' },
};

export interface ArmyTile {
  x: number;
  y: number;
}

export interface MapTile {
  x: number;
  y: number;
  terrain: TileTerrain;
  cost: number;
  passable: boolean;
  regionId: string;
  nodeId?: string;
}

export interface TileMap {
  width: number;
  height: number;
  tiles: MapTile[];
  nodeTiles: Record<string, ArmyTile>;
  regionTiles: Record<string, ArmyTile>;
  regionNames: Record<string, string>;
}

export interface TileMapArt {
  rivers: { name?: string; points: number[][] }[];
  lakes: { name?: string; x: number; y: number; rx: number; ry: number }[];
  mountainRanges: { name?: string; points: number[][]; height?: number }[];
  forests: { name?: string; x: number; y: number; spread: number }[];
  coastline: number[][];
}

export interface TileMapSource {
  nodes: Pick<MapNodeSeed, 'node_id' | 'region' | 'node_name' | 'node_type' | 'parent_node_id' | 'map_x' | 'map_y'>[];
  edges: Pick<MapEdgeSeed, 'from_region' | 'to_region'>[];
  territories: Pick<TerritorySeed, 'region_id' | 'region' | 'map_x' | 'map_y'>[];
  art?: TileMapArt;
}

export interface TileStep {
  x: number;
  y: number;
  terrain: TileTerrain;
  cost: number;
  diagonal: boolean;
}

export interface TilePathResult {
  ok: boolean;
  steps: TileStep[];
  totalCost: number;
  error?: string;
}

const DEFAULT_ART = art as TileMapArt;
const REGION_OFFSET = { dx: 0.38, dy: 0.42 };

export function tileId(width: number, x: number, y: number): number {
  return y * width + x;
}

export function tileInBounds(x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < GRID_WIDTH && y < GRID_HEIGHT;
}

export function mapCoordToTile(x: number, y: number): ArmyTile {
  return {
    x: Math.max(0, Math.min(GRID_WIDTH - 1, Math.floor((x - GRID_MIN_X) / TILE_SIZE))),
    y: Math.max(0, Math.min(GRID_HEIGHT - 1, Math.floor((y - GRID_MIN_Y) / TILE_SIZE))),
  };
}

export function tileCenter(x: number, y: number): { x: number; y: number } {
  return {
    x: GRID_MIN_X + (x + 0.5) * TILE_SIZE,
    y: GRID_MIN_Y + (y + 0.5) * TILE_SIZE,
  };
}

export function tileAt(map: TileMap, x: number, y: number): MapTile | undefined {
  if (x < 0 || y < 0 || x >= map.width || y >= map.height) return undefined;
  return map.tiles[y * map.width + x];
}

function tileAtCoord(map: TileMap, mapX: number, mapY: number): MapTile | undefined {
  const tile = mapCoordToTile(mapX, mapY);
  return tileAt(map, tile.x, tile.y);
}

export function tileOfNode(map: TileMap, nodeId: string | undefined | null): ArmyTile | undefined {
  return nodeId ? map.nodeTiles[nodeId] : undefined;
}

export function tileOfRegion(map: TileMap, regionId: string | undefined | null): ArmyTile | undefined {
  return regionId ? map.regionTiles[regionId] : undefined;
}

export function terrainLabel(terrain: TileTerrain): string {
  return TILE_TERRAIN_INFO[terrain].label;
}

/* ----------------------------- 地图构建 ----------------------------- */

function pointSegmentDistance(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len = dx * dx + dy * dy || 1;
  let t = ((px - ax) * dx + (py - ay) * dy) / len;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function distanceToPolylines(
  px: number,
  py: number,
  lines: { points: number[][] }[],
): number {
  let best = Infinity;
  for (const line of lines) {
    for (let i = 0; i < line.points.length - 1; i++) {
      const a = line.points[i];
      const b = line.points[i + 1];
      best = Math.min(best, pointSegmentDistance(px, py, a[0], a[1], b[0], b[1]));
    }
  }
  return best;
}

/** 海岸线以东/以南为海；返回 true 表示海域。 */
function isSeaTile(px: number, py: number, coastline: number[][]): boolean {
  let best = Infinity;
  let side = 1;
  for (let i = 0; i < coastline.length - 1; i++) {
    const a = coastline[i];
    const b = coastline[i + 1];
    const distance = pointSegmentDistance(px, py, a[0], a[1], b[0], b[1]);
    if (distance < best) {
      best = distance;
      side = (b[0] - a[0]) * (py - a[1]) - (b[1] - a[1]) * (px - a[0]);
    }
  }
  return side < 0;
}

function setTileTerrain(tile: MapTile, terrain: TileTerrain, nodeId?: string): void {
  tile.terrain = terrain;
  tile.cost = TILE_TERRAIN_INFO[terrain].cost;
  tile.passable = TILE_TERRAIN_INFO[terrain].passable;
  if (nodeId) tile.nodeId = nodeId;
}

function paintRoad(map: TileMap, ax: number, ay: number, bx: number, by: number): void {
  const length = Math.hypot(bx - ax, by - ay);
  const steps = Math.max(1, Math.ceil(length / 0.02));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = ax + (bx - ax) * t;
    const y = ay + (by - ay) * t;
    const tile = tileAtCoord(map, x, y);
    if (!tile) continue;
    if (tile.terrain === 'city' || tile.terrain === 'node' || tile.terrain === 'pass') continue;
    if (tile.terrain === 'river' || tile.terrain === 'lake' || tile.terrain === 'sea') {
      setTileTerrain(tile, 'bridge');
    } else if (tile.terrain === 'mountain') {
      setTileTerrain(tile, 'pass');
    } else {
      setTileTerrain(tile, 'road');
    }
  }
}

function displayOffsetsFor(territories: TileMapSource['territories']): {
  byRegionId: Map<string, { dx: number; dy: number }>;
  byRegionName: Map<string, { dx: number; dy: number }>;
} {
  const used = new Set<string>();
  const byRegionId = new Map<string, { dx: number; dy: number }>();
  const byRegionName = new Map<string, { dx: number; dy: number }>();
  for (const territory of territories) {
    const key = `${territory.map_x.toFixed(2)},${territory.map_y.toFixed(2)}`;
    if (used.has(key)) {
      byRegionId.set(territory.region_id, REGION_OFFSET);
      byRegionName.set(territory.region, REGION_OFFSET);
    } else {
      used.add(key);
    }
  }
  return { byRegionId, byRegionName };
}

export function buildTileMap(source: TileMapSource): TileMap {
  const artSource = source.art ?? DEFAULT_ART;
  const map: TileMap = {
    width: GRID_WIDTH,
    height: GRID_HEIGHT,
    tiles: [],
    nodeTiles: {},
    regionTiles: {},
    regionNames: {},
  };

  const offsets = displayOffsetsFor(source.territories);
  const centers = source.territories.map((territory) => {
    const offset = offsets.byRegionId.get(territory.region_id);
    return {
      regionId: territory.region_id,
      region: territory.region,
      x: territory.map_x + (offset?.dx ?? 0),
      y: territory.map_y + (offset?.dy ?? 0),
    };
  });
  for (const center of centers) {
    map.regionNames[center.regionId] = center.region;
    map.regionTiles[center.regionId] = mapCoordToTile(center.x, center.y);
  }

  const nodeCoords = new Map<string, { x: number; y: number }>();
  for (const node of source.nodes) {
    const offset = offsets.byRegionName.get(node.region);
    nodeCoords.set(node.node_id, {
      x: node.map_x + (offset?.dx ?? 0),
      y: node.map_y + (offset?.dy ?? 0),
    });
  }

  const rivers = artSource.rivers ?? [];
  const mountains = artSource.mountainRanges ?? [];
  const forests = artSource.forests ?? [];
  const lakes = artSource.lakes ?? [];
  const coastline = artSource.coastline ?? [];

  for (let y = 0; y < GRID_HEIGHT; y++) {
    for (let x = 0; x < GRID_WIDTH; x++) {
      const center = tileCenter(x, y);
      let nearestRegion = '';
      let bestDistance = Infinity;
      for (const region of centers) {
        const distance = (center.x - region.x) ** 2 + (center.y - region.y) ** 2;
        if (
          distance < bestDistance ||
          (distance === bestDistance && region.regionId.localeCompare(nearestRegion) < 0)
        ) {
          bestDistance = distance;
          nearestRegion = region.regionId;
        }
      }

      const tile: MapTile = {
        x,
        y,
        terrain: 'plain',
        cost: 1,
        passable: true,
        regionId: nearestRegion,
      };
      for (const lake of lakes) {
        const dx = (center.x - lake.x) / Math.max(0.01, lake.rx);
        const dy = (center.y - lake.y) / Math.max(0.01, lake.ry);
        if (dx * dx + dy * dy <= 1) {
          setTileTerrain(tile, 'lake');
          break;
        }
      }
      if (tile.terrain === 'plain' && isSeaTile(center.x, center.y, coastline)) {
        setTileTerrain(tile, 'sea');
      }
      if (tile.terrain === 'plain' && distanceToPolylines(center.x, center.y, rivers) <= 0.055) {
        setTileTerrain(tile, 'river');
      }
      if (tile.terrain === 'plain' || tile.terrain === 'forest') {
        const mountainDistance = distanceToPolylines(center.x, center.y, mountains);
        if (mountainDistance <= 0.09) setTileTerrain(tile, 'mountain');
        else if (mountainDistance <= 0.17) setTileTerrain(tile, 'hill');
      }
      if (tile.terrain === 'plain') {
        for (const forest of forests) {
          if (Math.hypot(center.x - forest.x, center.y - forest.y) <= forest.spread) {
            setTileTerrain(tile, 'forest');
            break;
          }
        }
      }
      map.tiles.push(tile);
    }
  }

  const regionCenters = new Map(centers.map((center) => [center.region, center]));
  for (const edge of source.edges) {
    const from = regionCenters.get(edge.from_region);
    const to = regionCenters.get(edge.to_region);
    if (!from || !to) continue;
    paintRoad(map, from.x, from.y, to.x, to.y);
  }

  for (const node of source.nodes) {
    if (!node.parent_node_id) continue;
    const parent = nodeCoords.get(node.parent_node_id);
    const child = nodeCoords.get(node.node_id);
    if (!parent || !child) continue;
    paintRoad(map, parent.x, parent.y, child.x, child.y);
  }

  for (const node of source.nodes) {
    const coord = nodeCoords.get(node.node_id);
    if (!coord) continue;
    const tile = tileAtCoord(map, coord.x, coord.y);
    if (!tile) continue;
    const isCapital = node.node_type === '州府/主城';
    const terrain: TileTerrain = isCapital
      ? 'city'
      : /关隘|边塞/.test(node.node_type)
        ? 'pass'
        : 'node';
    setTileTerrain(tile, terrain, node.node_id);
    map.nodeTiles[node.node_id] = { x: tile.x, y: tile.y };
    if (isCapital) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const near = tileAt(map, tile.x + dx, tile.y + dy);
          if (near && (dx !== 0 || dy !== 0)) setTileTerrain(near, 'city');
        }
      }
    }
  }

  return map;
}

/* ----------------------------- 运行时缓存 ----------------------------- */

const contextCache = new WeakMap<object, TileMap>();
const sourceCache = new WeakMap<object, TileMap>();

export function getTileMap(ctx: DerivedContext): TileMap {
  const cached = contextCache.get(ctx);
  if (cached) return cached;
  const built = buildTileMap({
    nodes: ctx.seed.map_nodes,
    edges: ctx.seed.map_edges,
    territories: ctx.seed.territories,
    art: DEFAULT_ART,
  });
  contextCache.set(ctx, built);
  return built;
}

export function buildTileMapFromMapData(mapData: {
  nodes: TileMapSource['nodes'];
  edges: TileMapSource['edges'];
  territories: TileMapSource['territories'];
}): TileMap {
  const cached = sourceCache.get(mapData);
  if (cached) return cached;
  const built = buildTileMap({ ...mapData, art: DEFAULT_ART });
  sourceCache.set(mapData, built);
  return built;
}

/* ----------------------------- 寻路 ----------------------------- */

export function tileOfArmy(state: GameState, ctx: DerivedContext, army: Army): ArmyTile {
  const map = getTileMap(ctx);
  const current = army.tileX !== undefined && army.tileY !== undefined
    ? tileAt(map, army.tileX, army.tileY)
    : undefined;
  // 外部改派（旧档、战斗后撤或测试布置）可能只更新州府而留下旧格子，不能盲信。
  if (current && (!army.nodeId || current.regionId === army.nodeId)) {
    return { x: current.x, y: current.y };
  }
  const nodeTile = tileOfNode(map, army.mapNodeId);
  if (nodeTile) return nodeTile;
  const regionTile = tileOfRegion(map, army.nodeId);
  if (regionTile) return regionTile;
  return { x: 0, y: 0 };
}

export function syncArmyTileFromNode(state: GameState, ctx: DerivedContext, army: Army): void {
  const map = getTileMap(ctx);
  const nodeTile = tileOfNode(map, army.mapNodeId) ?? tileOfRegion(map, army.nodeId);
  if (!nodeTile) return;
  army.tileX = nodeTile.x;
  army.tileY = nodeTile.y;
}

/** 路径可进入判定：不可通行地形；未交战势力的州府/据点。 */
export function canEnterTile(
  state: GameState,
  faction: FactionKey,
  tile: MapTile,
): boolean {
  if (!tile.passable) return false;
  const region = state.regions[tile.regionId];
  if (region && region.faction !== faction && !isAtWar(state.diplomacy, faction, region.faction)) {
    return false;
  }
  if (tile.nodeId) {
    const node = state.mapNodes?.[tile.nodeId];
    if (node && node.faction !== faction && !isAtWar(state.diplomacy, faction, node.faction)) {
      return false;
    }
  }
  return true;
}

class MinHeap {
  private ids: number[] = [];
  private fs: number[] = [];
  private hs: number[] = [];

  get size(): number {
    return this.ids.length;
  }

  push(id: number, f: number, h: number): void {
    let index = this.ids.length;
    this.ids.push(id);
    this.fs.push(f);
    this.hs.push(h);
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (!this.less(index, parent)) break;
      this.swap(index, parent);
      index = parent;
    }
  }

  pop(): number | undefined {
    if (this.ids.length === 0) return undefined;
    const top = this.ids[0];
    const last = this.ids.length - 1;
    this.swap(0, last);
    this.ids.pop();
    this.fs.pop();
    this.hs.pop();
    let index = 0;
    const length = this.ids.length;
    while (index < length) {
      const left = index * 2 + 1;
      const right = left + 1;
      let smallest = index;
      if (left < length && this.less(left, smallest)) smallest = left;
      if (right < length && this.less(right, smallest)) smallest = right;
      if (smallest === index) break;
      this.swap(index, smallest);
      index = smallest;
    }
    return top;
  }

  private less(a: number, b: number): boolean {
    if (this.fs[a] !== this.fs[b]) return this.fs[a] < this.fs[b];
    if (this.hs[a] !== this.hs[b]) return this.hs[a] < this.hs[b];
    return this.ids[a] < this.ids[b];
  }

  private swap(a: number, b: number): void {
    [this.ids[a], this.ids[b]] = [this.ids[b], this.ids[a]];
    [this.fs[a], this.fs[b]] = [this.fs[b], this.fs[a]];
    [this.hs[a], this.hs[b]] = [this.hs[b], this.hs[a]];
  }
}

function octileHeuristic(ax: number, ay: number, bx: number, by: number): number {
  const dx = Math.abs(ax - bx);
  const dy = Math.abs(ay - by);
  // 十分之一单位下的八方向距离：直行 10，斜行 14。
  return 10 * (dx + dy) - 6 * Math.min(dx, dy);
}

export function findTilePath(
  map: TileMap,
  from: ArmyTile,
  to: ArmyTile,
  canEnter: (tile: MapTile) => boolean,
): TilePathResult {
  if (from.x === to.x && from.y === to.y) {
    return { ok: false, steps: [], totalCost: 0, error: '部队已在该格。' };
  }
  const target = tileAt(map, to.x, to.y);
  if (!target) return { ok: false, steps: [], totalCost: 0, error: '目标格不在地图范围内。' };
  if (!canEnter(target)) {
    return {
      ok: false,
      steps: [],
      totalCost: 0,
      error: `${terrainLabel(target.terrain)}不可通行，或该地由未交战势力控制。`,
    };
  }
  const total = map.width * map.height;
  const costs = new Float64Array(total).fill(Infinity);
  const cameFrom = new Int32Array(total).fill(-1);
  const closed = new Uint8Array(total);
  const startId = tileId(map.width, from.x, from.y);
  const goalId = tileId(map.width, to.x, to.y);
  const heap = new MinHeap();
  costs[startId] = 0;
  heap.push(startId, octileHeuristic(from.x, from.y, to.x, to.y), octileHeuristic(from.x, from.y, to.x, to.y));

  while (heap.size > 0) {
    const currentId = heap.pop() as number;
    if (closed[currentId]) continue;
    if (currentId === goalId) break;
    closed[currentId] = 1;
    const cx = currentId % map.width;
    const cy = Math.floor(currentId / map.width);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= map.width || ny >= map.height) continue;
        const neighbor = map.tiles[ny * map.width + nx];
        if (!neighbor.passable) continue;
        if (!canEnter(neighbor)) continue;
        const diagonal = dx !== 0 && dy !== 0;
        if (diagonal) {
          const sideA = map.tiles[cy * map.width + nx];
          const sideB = map.tiles[ny * map.width + cx];
          if (!sideA.passable || !sideB.passable || !canEnter(sideA) || !canEnter(sideB)) continue;
        }
        const neighborId = ny * map.width + nx;
        if (closed[neighborId]) continue;
        const stepCost = diagonal ? Math.round(neighbor.cost * 14) : neighbor.cost * 10;
        const candidate = costs[currentId] + stepCost;
        if (candidate >= costs[neighborId]) continue;
        costs[neighborId] = candidate;
        cameFrom[neighborId] = currentId;
        const h = octileHeuristic(nx, ny, to.x, to.y);
        heap.push(neighborId, candidate + h, h);
      }
    }
  }

  if (cameFrom[goalId] === -1) {
    return {
      ok: false,
      steps: [],
      totalCost: 0,
      error: '没有可行路线抵达目标格（山川阻隔或未交战势力封锁）。',
    };
  }
  const ids: number[] = [];
  let cursor = goalId;
  while (cursor !== startId) {
    ids.push(cursor);
    cursor = cameFrom[cursor];
    if (cursor === -1) return { ok: false, steps: [], totalCost: 0, error: '路线回溯失败。' };
  }
  ids.reverse();
  const steps: TileStep[] = [];
  let previousX = from.x;
  let previousY = from.y;
  for (const id of ids) {
    const x = id % map.width;
    const y = Math.floor(id / map.width);
    const tile = map.tiles[id];
    steps.push({
      x,
      y,
      terrain: tile.terrain,
      cost: tile.cost,
      diagonal: Math.abs(x - previousX) === 1 && Math.abs(y - previousY) === 1,
    });
    previousX = x;
    previousY = y;
  }
  return { ok: true, steps, totalCost: costs[goalId] / 10 };
}

export function findTilePathForArmy(
  state: GameState,
  ctx: DerivedContext,
  army: Army,
  target: ArmyTile,
): TilePathResult {
  const map = getTileMap(ctx);
  const from = tileOfArmy(state, ctx, army);
  return findTilePath(map, from, target, (tile) => canEnterTile(state, army.faction, tile));
}

export function findTilePathForNodes(
  state: GameState,
  ctx: DerivedContext,
  army: Army,
  targetMapNodeId: string,
): TilePathResult {
  const map = getTileMap(ctx);
  const target = tileOfNode(map, targetMapNodeId);
  if (!target) return { ok: false, steps: [], totalCost: 0, error: '目标据点没有对应格子。' };
  return findTilePathForArmy(state, ctx, army, target);
}

export function findTilePathForRegions(
  state: GameState,
  ctx: DerivedContext,
  faction: FactionKey,
  fromRegionId: string,
  toRegionId: string,
): TilePathResult {
  const map = getTileMap(ctx);
  const from = tileOfRegion(map, fromRegionId);
  const to = tileOfRegion(map, toRegionId);
  if (!from || !to) return { ok: false, steps: [], totalCost: 0, error: '州府没有对应格子。' };
  return findTilePath(map, from, to, (tile) => canEnterTile(state, faction, tile));
}

export function tilePathDays(totalCost: number): number {
  return Math.max(1, Math.round(totalCost * TILE_COST_DAYS));
}

export function describeTile(map: TileMap, tile: ArmyTile): string {
  const current = tileAt(map, tile.x, tile.y);
  if (!current) return `(${tile.x},${tile.y})`;
  const regionName = map.regionNames[current.regionId] ?? current.regionId;
  const nodeSuffix = current.nodeId ? ` · 据点` : '';
  return `${regionName} · ${terrainLabel(current.terrain)}${nodeSuffix} (${tile.x},${tile.y})`;
}
