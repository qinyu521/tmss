import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GRID_HEIGHT,
  GRID_WIDTH,
  TILE_TERRAIN_INFO,
  applyUnitNames,
  buildContext,
  createGame,
  findTilePath,
  getTileMap,
  runTurn,
  tileAt,
  tileCenter,
  tileOfArmy,
  tileOfNode,
  tileOfRegion,
  validateOrder,
  type GameState,
  type MapTile,
  type Order,
  type SeedRoster,
  type TileMap,
} from './index.js';

const seedPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../data/source/tianming_world_roster_v0_3_1.json',
);
const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8')) as SeedRoster;
applyUnitNames(seed.military_units);
const ctx = buildContext(seed);

const newGame = () => createGame(seed, { gameId: 'tile-test', factionKey: 'HUN', playerRole: 'ruler', seed: 424242 });

function blankMap(size = 3): TileMap {
  const tiles: MapTile[] = [];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      tiles.push({ x, y, terrain: 'plain', cost: 1, passable: true, regionId: 'R' });
    }
  }
  return {
    width: size,
    height: size,
    tiles,
    nodeTiles: {},
    regionTiles: {},
    regionNames: { R: '测试州' },
  };
}

function block(map: TileMap, x: number, y: number): void {
  const tile = map.tiles[y * map.width + x];
  tile.terrain = 'mountain';
  tile.cost = TILE_TERRAIN_INFO.mountain.cost;
  tile.passable = false;
}

describe('真·格子地图', () => {
  it('72×82 网格完整覆盖 24 州府与 72 据点，主城占据城池格', () => {
    const map = getTileMap(ctx);
    expect(map.width).toBe(GRID_WIDTH);
    expect(map.height).toBe(GRID_HEIGHT);
    expect(map.tiles).toHaveLength(GRID_WIDTH * GRID_HEIGHT);
    expect(Object.keys(map.nodeTiles)).toHaveLength(72);
    expect(Object.keys(map.regionTiles)).toHaveLength(24);
    const terrainKinds = new Set(map.tiles.map((tile) => tile.terrain));
    for (const kind of ['plain', 'forest', 'hill', 'mountain', 'river', 'sea', 'road', 'bridge', 'pass', 'city', 'node'] as const) {
      expect(terrainKinds.has(kind)).toBe(true);
    }
    for (const node of seed.map_nodes.filter((item) => item.node_type === '州府/主城')) {
      const tile = tileOfNode(map, node.node_id)!;
      expect(tile).toBeTruthy();
      expect(tileAt(map, tile.x, tile.y)?.terrain).toBe('city');
      for (const [dx, dy] of [[-1, -1], [1, 1], [-1, 1], [1, -1]] as const) {
        const near = tileAt(map, tile.x + dx, tile.y + dy)!;
        // 依附州府的据点会保留自身地貌，但依然落在主城 3×3 范围内。
        if (near.nodeId) continue;
        expect(near.terrain).toBe('city');
      }
    }
  });

  it('山地、河流、湖泊与海域不可通行，道路与桥梁可通行', () => {
    const map = getTileMap(ctx);
    for (const tile of map.tiles) {
      expect(tile.passable).toBe(TILE_TERRAIN_INFO[tile.terrain].passable);
      expect(tile.cost).toBe(TILE_TERRAIN_INFO[tile.terrain].cost);
    }
    expect(map.tiles.some((tile) => tile.terrain === 'mountain' && !tile.passable)).toBe(true);
    expect(map.tiles.some((tile) => tile.terrain === 'bridge' && tile.passable)).toBe(true);
  });

  it('A* 寻路跨州可行、逐格相邻且结果确定', () => {
    const map = getTileMap(ctx);
    const start = tileOfNode(map, 'HUN-MAP001')!;
    const target = tileOfNode(map, 'YONG-MAP001')!;
    const route = findTilePath(map, start, target, (tile) => tile.passable);
    expect(route.ok).toBe(true);
    expect(route.steps.length).toBeGreaterThan(10);
    expect(route.totalCost).toBeGreaterThan(0);
    let previous = start;
    for (const step of route.steps) {
      expect(Math.abs(step.x - previous.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(step.y - previous.y)).toBeLessThanOrEqual(1);
      expect(step.x !== previous.x || step.y !== previous.y).toBe(true);
      expect(tileAt(map, step.x, step.y)?.passable).toBe(true);
      previous = step;
    }
    expect({ x: previous.x, y: previous.y }).toEqual(target);
    const again = findTilePath(map, start, target, (tile) => tile.passable);
    expect(again.steps).toEqual(route.steps);
    expect(again.totalCost).toBe(route.totalCost);
  });

  it('A* 禁止斜穿两块阻挡地形之间的角，目标被围死时返回失败', () => {
    const open = blankMap();
    const diagonal = findTilePath(open, { x: 0, y: 0 }, { x: 1, y: 1 }, (tile) => tile.passable);
    expect(diagonal.ok).toBe(true);
    expect(diagonal.steps).toHaveLength(1);
    expect(diagonal.steps[0].diagonal).toBe(true);
    expect(diagonal.totalCost).toBeCloseTo(1.4);

    const corner = blankMap();
    block(corner, 1, 0);
    block(corner, 0, 1);
    const cornered = findTilePath(corner, { x: 0, y: 0 }, { x: 1, y: 1 }, (tile) => tile.passable);
    expect(cornered.ok).toBe(false);

    const detour = blankMap();
    block(detour, 0, 1);
    const around = findTilePath(detour, { x: 0, y: 0 }, { x: 1, y: 1 }, (tile) => tile.passable);
    expect(around.ok).toBe(true);
    expect(around.steps.every((step) => !step.diagonal)).toBe(true);
    expect(around.steps).toHaveLength(2);

    const blockedTarget = blankMap();
    block(blockedTarget, 1, 1);
    expect(findTilePath(blockedTarget, { x: 0, y: 0 }, { x: 1, y: 1 }, (tile) => tile.passable).ok).toBe(false);
  });

  it('格子坐标与州府/部队位置互换一致；陈旧格坐标不会越过州府校验', () => {
    const map = getTileMap(ctx);
    for (const [x, y] of [[0, 0], [17, 33], [GRID_WIDTH - 1, GRID_HEIGHT - 1]] as const) {
      const center = tileCenter(x, y);
      const owner = tileAt(map, x, y)!.regionId;
      const back = tileOfArmy(newGame(), ctx, { nodeId: owner, tileX: x, tileY: y } as never);
      expect(back).toEqual({ x, y });
      expect(Number.isFinite(center.x) && Number.isFinite(center.y)).toBe(true);
    }
    const state = newGame();
    const army = state.armies.find((item) => item.armyId === 'HUN-ARMY-01')!;
    const foreign = map.tiles.find((tile) => tile.passable && tile.regionId !== army.nodeId && tile.terrain !== 'city')!;
    army.tileX = foreign.x;
    army.tileY = foreign.y;
    const resolved = tileOfArmy(state, ctx, army);
    expect(tileAt(map, resolved.x, resolved.y)?.regionId).toBe(army.nodeId);
  });
});

describe('格子行军', () => {
  it('指定目标格下达军令：预览路线日数，逐旬推进并抵达', () => {
    const state = newGame();
    for (const pair of ['HUN|YONG', 'HUN|CHU', 'YONG|CHU']) state.diplomacy[pair] = 100;
    for (const army of state.armies) if (army.faction !== 'HUN') army.status = 'fighting';
    const map = getTileMap(ctx);
    const army = state.armies.find((item) => item.armyId === 'HUN-ARMY-01')!;
    const start = { x: army.tileX!, y: army.tileY! };
    const target = tileOfRegion(map, 'HUN-REG04')!;
    const order: Order = {
      orderId: 'tile-move',
      kind: 'move_army',
      armyId: army.armyId,
      targetRegionId: 'HUN-REG04',
      targetTile: target,
    };
    const check = validateOrder(state, ctx, order);
    expect(check.ok).toBe(true);
    expect(check.preview).toContain('格');
    expect(check.preview).toContain('预计');
    expect(check.preview).toContain('回合');

    const supplyBefore = army.supply;
    state.pendingOrders = [order];
    let current = runTurn(state, ctx);
    expect(current.report.events.some((event) => event.type === 'army_move' && event.title.includes('奉命开拔'))).toBe(true);
    let mover = current.state.armies.find((item) => item.armyId === army.armyId)!;
    expect(mover.status).toBe('marching');
    expect(mover.tilePath?.length).toBeGreaterThan(0);
    expect(mover.tileX !== start.x || mover.tileY !== start.y).toBe(true);
    expect(mover.supply).toBeLessThan(supplyBefore);

    for (let turn = 0; turn < 20 && mover.status === 'marching'; turn++) {
      current = runTurn(current.state, ctx);
      mover = current.state.armies.find((item) => item.armyId === army.armyId)!;
    }
    expect(mover.status).toBe('idle');
    expect([mover.tileX, mover.tileY]).toEqual([target.x, target.y]);
    expect(mover.tilePath).toEqual([]);
    expect(mover.targetTile).toBeNull();
    expect(mover.nodeId).toBe('HUN-REG04');
  });

  it('与目标格所在州府不一致、或目标格属未交战势力时拒绝军令', () => {
    const state = newGame();
    for (const pair of ['HUN|YONG', 'HUN|CHU', 'YONG|CHU']) state.diplomacy[pair] = 100;
    for (const army of state.armies) if (army.faction !== 'HUN') army.status = 'fighting';
    const map = getTileMap(ctx);
    const army = state.armies.find((item) => item.armyId === 'HUN-ARMY-01')!;

    const wrongRegion = validateOrder(state, ctx, {
      orderId: 'wrong-region',
      kind: 'move_army',
      armyId: army.armyId,
      targetRegionId: 'HUN-REG01',
      targetTile: tileOfRegion(map, 'HUN-REG04')!,
    });
    expect(wrongRegion.ok).toBe(false);
    expect(wrongRegion.issues[0].message).toContain('不一致');

    const foreignTile = map.tiles.find((tile) => tile.regionId === 'YONG-REG03' && tile.passable)!;
    const enemy = validateOrder(state, ctx, {
      orderId: 'enemy-peace',
      kind: 'move_army',
      armyId: army.armyId,
      targetRegionId: 'YONG-REG03',
      targetTile: { x: foreignTile.x, y: foreignTile.y },
    });
    expect(enemy.ok).toBe(false);
    expect(enemy.issues[0].code).toBe('NO_PATH');
  });
});

describe('格子野战', () => {
  function fieldSetup() {
    const state: GameState = newGame();
    const map = getTileMap(ctx);
    const region = Object.values(state.regions).find((item) => item.faction === 'YONG')!;
    let pair: { a: MapTile; b: MapTile } | null = null;
    for (const a of map.tiles) {
      if (a.regionId !== region.regionId || !a.passable || a.nodeId || a.terrain === 'city') continue;
      for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1]] as const) {
        const b = tileAt(map, a.x + dx, a.y + dy);
        if (b && b.passable && b.regionId === a.regionId && !b.nodeId && b.terrain !== 'city') {
          pair = { a, b };
          break;
        }
      }
      if (pair) break;
    }
    expect(pair).toBeTruthy();
    const attacker = state.armies.find((item) => item.armyId === 'HUN-ARMY-01')!;
    const defender = state.armies.find((item) => item.faction === 'YONG')!;
    for (const army of state.armies) if (army.armyId !== attacker.armyId) army.status = 'fighting';
    attacker.nodeId = pair!.a.regionId;
    attacker.tileX = pair!.a.x;
    attacker.tileY = pair!.a.y;
    attacker.tilePath = [{ x: pair!.b.x, y: pair!.b.y }];
    attacker.targetTile = { x: pair!.b.x, y: pair!.b.y };
    attacker.tileMpLeft = 20;
    attacker.status = 'marching';
    attacker.stance = 'march';
    attacker.path = [];
    attacker.mapPath = [];
    defender.nodeId = pair!.b.regionId;
    defender.tileX = pair!.b.x;
    defender.tileY = pair!.b.y;
    defender.tilePath = [];
    defender.status = 'fighting';
    defender.stance = 'defend';
    return { state, attacker, defender, pair: pair! };
  }

  it('两军进入同一格时以该格地形触发野战，结果可复现', () => {
    const run = () => {
      const setup = fieldSetup();
      const result = runTurn(setup.state, ctx);
      const battle = result.report.events.find(
        (event) =>
          event.type === 'battle' &&
          event.payload?.fieldBattle === true &&
          event.payload?.defenderArmy === setup.defender.name,
      );
      expect(battle).toBeTruthy();
      expect(battle?.payload?.tile).toMatchObject({ x: setup.pair.b.x, y: setup.pair.b.y });
      expect(battle?.before?.attackerTroops).toBe(setup.attacker.troops);
      expect(battle?.before?.defenderTroops).toBe(setup.defender.troops);
      return battle!;
    };
    const first = run();
    const second = run();
    expect(first.payload?.seed).toBe(second.payload?.seed);
    expect(first.after).toEqual(second.after);
    expect(first.payload?.fieldBattle).toBe(true);
  });
});
