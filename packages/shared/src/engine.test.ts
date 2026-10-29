import { describe, expect, it } from 'vitest';
import { battleDefeatLoyaltyPenalty, resolveCommanderDefectionThreats } from './engine/turn.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BALANCE,
  computeEconomy,
  grainDemandForTroops,
  perThousandDemand,
  shortageTags,
  UNIT_PROFILES,
  applyOrder,
  applyUnitNames,
  buildContext,
  buildAdjacency,
  buildMapAdjacency,
  capitalMapNodeId,
  dayCostsFor,
  findMapPath,
  findPath,
  routeCapacityMultiplier,
  migrateState,
  buildPlayerView,
  createGame,
  resolveBattle,
  runTurn,
  validateOrder,
  generateNpcOrders,
  type GameEvent,
  type GameState,
  type Order,
  type SeedRoster,
} from './index.js';

const seedPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../data/source/tianming_world_roster_v0_3_1.json',
);
const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8')) as SeedRoster;
applyUnitNames(seed.military_units);
const ctx = buildContext(seed);

const newGame = (factionKey: 'HUN' | 'YONG' | 'CHU', playerRole: 'ruler' | 'governor' | 'general' | 'strategist' = 'ruler', gameId = 'test') =>
  createGame(seed, { gameId, factionKey, playerRole, seed: 424242 });

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe('初始世界', () => {
  it('三国初始兵力精确等于种子分配（40/80/30 万）', () => {
    const expected = { HUN: 400_000, YONG: 800_000, CHU: 300_000 };
    for (const key of ['HUN', 'YONG', 'CHU'] as const) {
      const state = newGame(key);
      const total = state.armies.filter((a) => a.faction === key).reduce((s, a) => s + a.troops, 0);
      expect(total).toBe(expected[key]);
      expect(state.factions[key].nominalTroops).toBe(expected[key]);
      expect(state.armies.filter((a) => a.faction === key)).toHaveLength(6);
      expect(Object.values(state.regions).filter((r) => r.faction === key)).toHaveLength(8);
    }
  });

  it('22 个特殊兵种的部署数量不超过各自上限', () => {
    for (const key of ['HUN', 'YONG', 'CHU'] as const) {
      const state = newGame(key);
      const counts: Record<string, number> = {};
      for (const army of state.armies) {
        for (const u of army.units) {
          counts[u.unitId] = (counts[u.unitId] ?? 0) + u.count;
          expect(UNIT_PROFILES[u.unitId]).toBeTruthy();
          expect(u.count).toBe(UNIT_PROFILES[u.unitId].initialFormationSize);
        }
        expect(army.troops).toBe(army.levies + army.units.reduce((s, u) => s + u.count, 0));
      }
      for (const [unitId, count] of Object.entries(counts)) {
        const profile = UNIT_PROFILES[unitId];
        expect(profile).toBeTruthy();
        expect(count).toBeLessThanOrEqual(profile.capPerFaction);
      }
    }
  });

  it('精锐按成建制规模部署，但总兵力仍严格守恒', () => {
    const expectedForce = { HUN: 400_000, YONG: 800_000, CHU: 300_000 };
    const expectedElite = { HUN: 96_000, YONG: 97_000, CHU: 75_000 };
    for (const key of ['HUN', 'YONG', 'CHU'] as const) {
      const state = newGame(key);
      const armies = state.armies.filter((a) => a.faction === key);
      const total = armies.reduce((sum, army) => sum + army.troops, 0);
      const elite = armies.reduce(
        (sum, army) => sum + army.units.reduce((unitSum, unit) => unitSum + unit.count, 0),
        0,
      );
      expect(total).toBe(expectedForce[key]);
      expect(elite).toBe(expectedElite[key]);
      expect(armies.every((army) => army.troops === army.levies + army.units.reduce((sum, unit) => sum + unit.count, 0))).toBe(true);
    }
  });

  it('24 个州府与 72 个地图节点均分配完成，地图连通', () => {
    expect(Object.keys(seed.map_nodes)).toHaveLength(72);
    const names = new Set(seed.territories.map((t) => t.region));
    for (const edge of seed.map_edges) {
      expect(names.has(edge.from_region)).toBe(true);
      expect(names.has(edge.to_region)).toBe(true);
    }
  });

  it('72 个节点进入运行时控制状态，附属据点能通过父子支路抵达', () => {
    const state = newGame('HUN');
    expect(Object.keys(state.mapNodes ?? {})).toHaveLength(72);
    expect(Object.keys(buildMapAdjacency(ctx))).toHaveLength(72);
    const capital = seed.map_nodes.find((node) => node.node_id === 'HUN-MAP001')!;
    const child = seed.map_nodes.find((node) => node.parent_node_id === capital.node_id)!;
    expect(state.mapNodes?.[capital.node_id]?.nodeType).toBe('州府/主城');
    const route = findMapPath(state, ctx, 'HUN', capital.node_id, child.node_id);
    expect(route.ok).toBe(true);
    expect(route.path).toEqual([child.node_id]);
    expect(route.costs).toEqual([1]);
    for (const army of state.armies) {
      expect(state.mapNodes?.[army.mapNodeId ?? '']?.regionId).toBe(army.nodeId);
    }
  });

  it('军令可以瞄准同一州府下的具体粮仓/据点，不再被州府 ID 限制', () => {
    const state = newGame('YONG');
    const army = state.armies.find((item) => item.faction === 'YONG')!;
    const regionName = state.regions[army.nodeId].name;
    const capital = seed.map_nodes.find((node) => node.node_type === '州府/主城' && node.region === regionName)!;
    const child = seed.map_nodes.find((node) => node.parent_node_id === capital.node_id)!;
    const result = validateOrder(state, ctx, {
      orderId: 'target-secondary-node',
      kind: 'move_army',
      armyId: army.armyId,
      targetRegionId: army.nodeId,
      targetMapNodeId: child.node_id,
    });
    expect(result.ok).toBe(true);
    expect(result.preview).toContain(child.node_name);
  });

  it('节点行军跨回合保留剩余路段，并在下一回合按剩余日数抵达', () => {
    const state = newGame('HUN');
    const army = state.armies.find((item) => item.faction === 'HUN')!;
    const origin = army.mapNodeId!;
    const target = seed.map_nodes.find((node) => node.parent_node_id === origin)!;
    army.mapPath = [target.node_id];
    army.mapHopCosts = [10];
    army.mapCurrentHopDaysTotal = 10;
    army.targetMapNodeId = target.node_id;
    army.targetRegionId = army.nodeId;
    army.path = [];
    army.hopCosts = [];
    army.status = 'marching';
    army.stance = 'march';
    army.marchDaysTotal = 10;
    army.marchDaysLeft = 10;

    const first = runTurn(state, ctx);
    const firstArmy = first.state.armies.find((item) => item.armyId === army.armyId)!;
    expect(firstArmy.mapNodeId).toBe(origin);
    expect(firstArmy.mapPath).toEqual([target.node_id]);
    expect(firstArmy.mapHopCosts).toEqual([3]);
    expect(firstArmy.mapCurrentHopDaysTotal).toBe(10);
    expect(firstArmy.marchDaysLeft).toBe(3);

    const second = runTurn(first.state, ctx);
    const secondArmy = second.state.armies.find((item) => item.armyId === army.armyId)!;
    expect(secondArmy.mapNodeId).toBe(target.node_id);
    expect(secondArmy.mapPath).toEqual([]);
    expect(secondArmy.status).toBe('idle');
  });

  it('旧存档迁移会幂等补齐 72 节点，且不覆盖已发生的节点易手', () => {
    const oldState = JSON.parse(JSON.stringify(newGame('HUN'))) as GameState;
    oldState.schemaVersion = 3;
    delete oldState.mapNodes;
    for (const army of oldState.armies) {
      delete army.mapNodeId;
      delete army.mapPath;
      delete army.mapHopCosts;
      delete army.targetMapNodeId;
    }
    const restored = migrateState(oldState, seed.characters, seed);
    expect(Object.keys(restored.mapNodes ?? {})).toHaveLength(72);
    const child = seed.map_nodes.find((node) => node.parent_node_id)!;
    restored.mapNodes![child.node_id].faction = 'CHU';
    const restoredAgain = migrateState(restored, seed.characters, seed);
    expect(restoredAgain.mapNodes![child.node_id].faction).toBe('CHU');
  });

  it('初始短缺符合国情：匈奴缺粮盐、大雍缺盐马、大楚缺马铁', () => {
    const hun = newGame('HUN');
    expect(hun.factions.HUN.resources.grain).toBeLessThan(200_000);
    expect(hun.factions.HUN.resources.salt).toBeLessThan(1_500);
    const yong = newGame('YONG');
    expect(yong.factions.YONG.resources.salt).toBeLessThan(4_000);
    expect(yong.factions.YONG.resources.horses).toBeLessThan(4_000);
    const chu = newGame('CHU');
    expect(chu.factions.CHU.resources.horses).toBeLessThan(2_000);
    expect(chu.factions.CHU.resources.iron).toBeLessThan(1_000);
  });
});

describe('命令权限', () => {
  it('军师不能调动军队或任命官职', () => {
    const state = newGame('HUN', 'strategist');
    const army = state.armies.find((a) => a.faction === 'HUN')!;
    const move = validateOrder(state, ctx, {
      orderId: 'o1',
      kind: 'move_army',
      armyId: army.armyId,
      targetRegionId: 'HUN-REG01',
    });
    expect(move.ok).toBe(false);
    expect(move.issues[0].code).toBe('ROLE_FORBIDDEN');
    const appoint = validateOrder(state, ctx, {
      orderId: 'o2',
      kind: 'appoint',
      personId: state.playerPersonId,
      regionId: 'HUN-REG01',
    });
    expect(appoint.ok).toBe(false);
  });

  it('将军只能调动自己统率的部队', () => {
    const state = newGame('YONG', 'general');
    const other = state.armies.find((a) => a.faction === 'YONG' && a.commanderId !== state.playerPersonId)!;
    const res = validateOrder(state, ctx, {
      orderId: 'o3',
      kind: 'move_army',
      armyId: other.armyId,
      targetRegionId: other.nodeId,
    });
    expect(res.ok).toBe(false);
    expect(res.issues[0].code).toBe('AUTH_SCOPE');
  });

  it('州牧不能任命官职', () => {
    const state = newGame('CHU', 'governor');
    const res = validateOrder(state, ctx, {
      orderId: 'o4',
      kind: 'appoint',
      personId: state.playerPersonId,
      regionId: 'CHU-REG01',
    });
    expect(res.ok).toBe(false);
    expect(res.issues[0].code).toBe('ROLE_FORBIDDEN');
  });

  it('资源不足时给出明确原因', () => {
    const state = newGame('HUN');
    state.factions.HUN.resources.cash = 100;
    const res = validateOrder(state, ctx, { orderId: 'o5', kind: 'recruit', amount: 10_000 });
    expect(res.ok).toBe(false);
    expect(res.issues[0].code).toBe('NO_CASH');
  });
});

describe('资源消耗单位', () => {
  it('把每千人每周消耗换算为实际部队消耗，不放大千倍', () => {
    expect(grainDemandForTroops(400_000)).toBe(48_000);
    expect(grainDemandForTroops(400_000, 3)).toBe(144_000);
    expect(grainDemandForTroops(800_000)).toBe(96_000);
    expect(perThousandDemand(800_000, BALANCE.saltPerThousandPerWeek, 3)).toBe(3_600);
  });

  it('经济账本与粮草短缺标签使用相同的单位口径', () => {
    const yong = newGame('YONG');
    expect(computeEconomy(yong, ctx).YONG.grainUsed).toBe(96_000);
    expect(shortageTags(yong, 'YONG')).not.toContain('粮草紧张');

    const hun = newGame('HUN');
    expect(shortageTags(hun, 'HUN')).toContain('粮草紧张');
  });

  it('NPC 在真实储粮阈值以下才生成征粮命令', () => {
    const state = newGame('HUN');
    state.factions.YONG.resources.grain = 250_000;
    const orders = generateNpcOrders(state, ctx);
    expect(orders.some((order) => order.orderId.startsWith('npc-YONG') && order.kind === 'levy_grain')).toBe(false);
  });
});

describe('正式朝议', () => {
  it('朝议使用确定性投票，记录表态、票数与政策前后状态', () => {
    const state = newGame('YONG', 'ruler', 'court-debate');
    const order: Order = {
      orderId: 'court-balance-1',
      kind: 'court_debate',
      topic: 'factions',
      resolution: 'balance',
    };
    const validation = validateOrder(state, ctx, order);
    expect(validation.ok).toBe(true);
    expect(validation.preview).toContain('列席官员');
    const submitted = clone(state);
    submitted.pendingOrders.push(order);

    const first = runTurn(submitted, ctx);
    const second = runTurn(submitted, ctx);
    const event = first.report.events.find((item) => item.title.startsWith('朝议·派系与朝局议案'));
    const repeated = second.report.events.find((item) => item.title.startsWith('朝议·派系与朝局议案'));
    expect(event).toBeTruthy();
    expect(event?.type).toBe('politics');
    expect(event?.before?.politicalMetric).toBeTypeOf('number');
    expect(event?.after?.passed).toBeTypeOf('boolean');
    expect(event?.payload?.supportVotes).toBeTypeOf('number');
    expect(event?.payload?.opposeVotes).toBeTypeOf('number');
    expect(event?.payload?.supporters).toBeInstanceOf(Array);
    expect(event?.payload?.opponents).toBeInstanceOf(Array);
    expect(repeated?.payload).toEqual(event?.payload);
    expect(repeated?.after).toEqual(event?.after);
    const passed = event?.after?.passed;
    if (passed === true) {
      expect(event?.after?.stability).toBe((event?.before?.stability as number) + 3);
    } else {
      expect(event?.after?.stability).toBe(event?.before?.stability);
    }
  });

  it('朝议不接受不匹配的议题与裁决，并校验政策资源成本', () => {
    const state = newGame('HUN');
    const invalid: Order = {
      orderId: 'court-invalid-pair',
      kind: 'court_debate',
      topic: 'factions',
      resolution: 'mobilize',
    };
    expect(validateOrder(state, ctx, invalid).issues[0].code).toBe('BAD_DEBATE');

    state.factions.HUN.resources.grain = 0;
    const tooExpensive: Order = {
      orderId: 'court-no-grain',
      kind: 'court_debate',
      topic: 'military',
      resolution: 'mobilize',
    };
    expect(validateOrder(state, ctx, tooExpensive).issues[0].code).toBe('NO_GRAIN');
  });
});


describe('将领军令忠诚与倒戈', () => {
  it('强关系、低忠诚且处于战争时先预警，下一回合才携军与州府倒戈', () => {
    const localSeed = clone(seed);
    const localCtx = buildContext(localSeed);
    const state = newGame('YONG', 'ruler', 'defection-warning');
    const army = state.armies.find((item) => item.faction === 'YONG')!;
    const home = Object.values(state.regions).find((region) =>
      region.faction === 'YONG' &&
      !state.armies.some((other) => other.armyId !== army.armyId && other.faction === 'YONG' && other.nodeId === region.regionId),
    );
    if (!home) throw new Error('测试缺少无友军驻扎的本方州府。');
    army.nodeId = home.regionId;
    army.mapNodeId = capitalMapNodeId(ctx, home.regionId);
    army.status = 'idle';
    army.path = [];
    army.hopCosts = [];
    army.mapPath = [];
    army.mapHopCosts = [];
    army.targetRegionId = null;
    army.targetMapNodeId = null;
    army.marchDaysTotal = 0;
    army.marchDaysLeft = 0;

    const commander = localCtx.charactersById[army.commanderId];
    const target = localSeed.characters.find((person) => person.faction_key === 'HUN' && person.person_id !== army.commanderId);
    if (!commander || !target) throw new Error('测试缺少有效的跨阵营关系人物。');
    state.characters[commander.person_id].militaryLoyalty = 10;
    state.diplomacy['HUN|YONG'] = -60;
    localCtx.seed.relationships = [...localCtx.seed.relationships, {
      faction: '测试关系',
      source_person_id: commander.person_id,
      source_name: commander.name,
      relation: '私交',
      target_person_id: target.person_id,
      target_name: target.name,
      strength: '强',
      notes: '确定性测试用跨阵营强关系',
    }];

    const warningEvents: GameEvent[] = [];
    resolveCommanderDefectionThreats(state, localCtx, warningEvents);
    expect(state.characters[commander.person_id].defectionWarningTurn).toBe(state.date.turn);
    expect(state.characters[commander.person_id].defectionTargetFaction).toBe('HUN');
    expect(army.faction).toBe('YONG');
    expect(home.faction).toBe('YONG');
    expect(warningEvents.some((event) => event.title.includes('倒戈预警'))).toBe(true);

    state.date.turn += 1;
    const defectionEvents: GameEvent[] = [];
    resolveCommanderDefectionThreats(state, localCtx, defectionEvents);
    expect(army.faction).toBe('HUN');
    expect(army.name).toContain('降将军团');
    expect(home.faction).toBe('HUN');
    expect(Object.values(state.mapNodes ?? {}).filter((node) => node.regionId === home.regionId).every((node) => node.faction === 'HUN')).toBe(true);
    expect(state.characters[commander.person_id].allegianceFaction).toBe('HUN');
    expect(defectionEvents.some((event) => event.title.includes('携军倒戈'))).toBe(true);
  });

  it('君主可用固定成本赏赐将领并解除已预警的倒戈风险', () => {
    const state = newGame('YONG', 'ruler', 'defection-reward');
    const army = state.armies.find((item) => item.faction === 'YONG')!;
    const runtime = state.characters[army.commanderId];
    runtime.militaryLoyalty = 10;
    runtime.defectionWarningTurn = state.date.turn;
    runtime.defectionTargetFaction = 'HUN';
    const beforeCash = state.factions.YONG.resources.cash;
    const order: Order = { orderId: 'reward-commander', kind: 'reward_commander', personId: army.commanderId };
    expect(validateOrder(state, ctx, order).ok).toBe(true);
    const events: GameEvent[] = [];
    applyOrder(state, ctx, order, events);
    expect(state.factions.YONG.resources.cash).toBe(beforeCash - BALANCE.militaryLoyalty.rewardCost);
    expect(runtime.militaryLoyalty).toBe(35);
    expect(runtime.defectionWarningTurn).toBeUndefined();
    expect(runtime.defectionTargetFaction).toBeUndefined();
    expect(events[0]?.summary).toContain('军令忠诚由 10 升至 35');
  });

  it('旧存档升级至 schema v7 会补齐军令忠诚且不自动制造倒戈预警', () => {
    const state = newGame('YONG', 'ruler', 'defection-migration');
    state.schemaVersion = 6;
    const person = ctx.seed.characters.find((candidate) => candidate.faction_key === 'YONG')!;
    state.characters[person.person_id].militaryLoyalty = undefined;
    const migrated = migrateState(state, ctx.seed.characters);
    expect(migrated.schemaVersion).toBe(7);
    expect(migrated.characters[person.person_id].militaryLoyalty).toBe(person.loyalty);
    expect(migrated.characters[person.person_id].defectionWarningTurn).toBeUndefined();
  });
});


describe('道路通行能力与大军寻路', () => {
  it('按容量标签和兵力阈值稳定计算通行倍率', () => {
    expect(routeCapacityMultiplier(10_000, '高')).toBe(1);
    expect(routeCapacityMultiplier(10_000, '低')).toBe(1);
    expect(routeCapacityMultiplier(25_000, '低')).toBe(1.18);
    expect(routeCapacityMultiplier(49_999, '低')).toBe(1.18);
    expect(routeCapacityMultiplier(50_000, '低')).toBe(1.4);
    expect(routeCapacityMultiplier(24_999, '争议')).toBe(1.1);
    expect(routeCapacityMultiplier(25_000, '争议')).toBe(1.3);
    expect(routeCapacityMultiplier(50_000, '中低')).toBe(1.6);
    expect(routeCapacityMultiplier(50_000, '中')).toBe(1.1);
    expect(routeCapacityMultiplier(60_000, '未标注')).toBe(1);
  });

  it('小部队走短支路，大军改走高容量官道（州府图和72节点地图）', () => {
    const routingCtx = clone(ctx);
    const [origin, middle, destination] = ctx.territories.slice(0, 3);
    if (!origin || !middle || !destination || !routingCtx.edges[0]) throw new Error('测试州府或道路种子缺失。');
    const makeEdge = (edgeId: string, from: typeof origin, to: typeof middle, cost: number, throughput: string) => ({
      ...routingCtx.edges[0],
      edge_id: edgeId,
      from_region: from.region,
      to_region: to.region,
      base_movement_cost: cost,
      route_type: throughput === '高' ? '官道' : '山道/支路',
      throughput,
    });
    routingCtx.edges = [
      makeEdge('TEST-A-B-LOW', origin, middle, 2, '低'),
      makeEdge('TEST-B-C-LOW', middle, destination, 2, '低'),
      makeEdge('TEST-A-C-HIGH', origin, destination, 5, '高'),
    ];

    const state = newGame('HUN', 'ruler', 'road-capacity-routing');
    for (const region of Object.values(state.regions)) region.faction = 'HUN';
    for (const node of Object.values(state.mapNodes ?? {})) node.faction = 'HUN';

    const smallRegionPath = findPath(state, routingCtx, 'HUN', origin.region_id, destination.region_id, { troops: 10_000 });
    const largeRegionPath = findPath(state, routingCtx, 'HUN', origin.region_id, destination.region_id, { troops: 60_000 });
    expect(smallRegionPath.ok).toBe(true);
    expect(largeRegionPath.ok).toBe(true);
    expect(smallRegionPath.path).toEqual([middle.region_id, destination.region_id]);
    expect(largeRegionPath.path).toEqual([destination.region_id]);
    expect(largeRegionPath.totalDays).toBe(5);
    expect(smallRegionPath.totalDays).toBe(4);

    const originNode = capitalMapNodeId(routingCtx, origin.region_id);
    const middleNode = capitalMapNodeId(routingCtx, middle.region_id);
    const destinationNode = capitalMapNodeId(routingCtx, destination.region_id);
    if (!originNode || !middleNode || !destinationNode) throw new Error('测试州府缺少主城节点。');
    const smallMapPath = findMapPath(state, routingCtx, 'HUN', originNode, destinationNode, { troops: 10_000 });
    const largeMapPath = findMapPath(state, routingCtx, 'HUN', originNode, destinationNode, { troops: 60_000 });
    expect(smallMapPath.ok).toBe(true);
    expect(largeMapPath.ok).toBe(true);
    expect(smallMapPath.path).toEqual([middleNode, destinationNode]);
    expect(largeMapPath.path).toEqual([destinationNode]);

    const sampleArmy = {
      ...state.armies.find((army) => army.faction === 'HUN')!,
      troops: 60_000,
      levies: 60_000,
      units: [],
    };
    expect(dayCostsFor(sampleArmy, [1], { season: 'spring' })).toEqual([1]);
    // 如果逐段四舍五入，1.4 / 当前速度很可能仍只有 1 天；容量成本累计后至少落实为额外整日。
    expect(dayCostsFor(sampleArmy, [1.4], { season: 'spring' })).toEqual([2]);
  });
});

describe('正式外交行动', () => {
  it('修好使团有明确成本并改变邦交关系', () => {
    const state = newGame('HUN', 'ruler', 'diplomacy-improve');
    for (const key of Object.keys(state.diplomacy)) state.diplomacy[key] = 100;
    state.diplomacy['HUN|CHU'] = 10;
    state.factions.HUN.resources.cash = 80_000;
    const order: Order = {
      orderId: 'diplomacy-improve-1',
      kind: 'diplomatic_action',
      action: 'improve_relations',
      targetFaction: 'CHU',
    };
    expect(validateOrder(state, ctx, order).ok).toBe(true);
    const beforeCash = state.factions.HUN.resources.cash;
    state.pendingOrders = [order];
    const result = runTurn(state, ctx);
    expect(result.state.diplomacy['HUN|CHU']).toBe(28);
    const event = result.report.events.find((item) => item.payload?.action === 'improve_relations');
    expect(event?.type).toBe('diplomacy');
    expect(event?.before?.relation).toBe(10);
    expect(event?.after?.relation).toBe(28);
    expect((event?.before?.cash as number) - (event?.after?.cash as number)).toBe(12_000);
    // 本回合后续经济结算可能增加国库；使团自身成本由事件账本精确断言。
  });

  it('宣战会立即跨过战争阈值，并留下声望/稳定代价', () => {
    const state = newGame('HUN', 'ruler', 'diplomacy-war');
    for (const key of Object.keys(state.diplomacy)) state.diplomacy[key] = 100;
    state.diplomacy['HUN|CHU'] = 0;
    const beforeReputation = state.factions.HUN.reputation;
    const beforeStability = state.factions.HUN.stability;
    state.pendingOrders = [{
      orderId: 'diplomacy-war-1',
      kind: 'diplomatic_action',
      action: 'declare_war',
      targetFaction: 'CHU',
    }];
    const result = runTurn(state, ctx);
    expect(result.state.diplomacy['HUN|CHU']).toBeLessThanOrEqual(-25);
    const warEvent = result.report.events.find((item) => item.payload?.warDeclared === true);
    expect(warEvent?.type).toBe('diplomacy');
    expect(warEvent?.before?.reputation).toBe(beforeReputation);
    expect(warEvent?.after?.reputation).toBe(beforeReputation - 3);
    expect(warEvent?.before?.stability).toBe(beforeStability);
    expect(warEvent?.after?.stability).toBe(beforeStability - 2);
  });

  it('关系接近且战事持续时，议和可停止战争', () => {
    const state = newGame('HUN', 'ruler', 'diplomacy-peace');
    for (const key of Object.keys(state.diplomacy)) state.diplomacy[key] = 100;
    state.diplomacy['HUN|YONG'] = -30;
    state.factions.HUN.resources.cash = 80_000;
    state.pendingOrders = [{
      orderId: 'diplomacy-peace-1',
      kind: 'diplomatic_action',
      action: 'offer_peace',
      targetFaction: 'YONG',
    }];
    const result = runTurn(state, ctx);
    expect(result.state.diplomacy['HUN|YONG']).toBe(-5);
    const event = result.report.events.find((item) => item.payload?.action === 'offer_peace');
    expect(event?.payload?.accepted).toBe(true);
    expect(event?.after?.atWar).toBe(false);
  });

  it('结盟成功后存在八回合防御盟约，期满会在下一回合记录并终止', () => {
    const state = newGame('HUN', 'ruler', 'diplomacy-alliance');
    for (const key of Object.keys(state.diplomacy)) state.diplomacy[key] = 100;
    state.diplomacy['HUN|CHU'] = 50;
    state.factions.HUN.resources.cash = 100_000;
    state.pendingOrders = [{
      orderId: 'diplomacy-alliance-1',
      kind: 'diplomatic_action',
      action: 'propose_alliance',
      targetFaction: 'CHU',
    }];
    const first = runTurn(state, ctx);
    const treaty = first.state.treaties.find((item) => item.a === 'HUN' && item.b === 'CHU');
    expect(treaty).toBeTruthy();
    expect(treaty?.status).toBe('active');
    expect(treaty?.endTurn).toBe(8);
    expect(first.state.diplomacy['HUN|CHU']).toBeGreaterThanOrEqual(45);

    const atExpiry = clone(first.state);
    atExpiry.date.turn = 9;
    const expired = runTurn(atExpiry, ctx);
    expect(expired.state.treaties.find((item) => item.treatyId === treaty?.treatyId)?.status).toBe('expired');
    expect(expired.report.events.some((item) => item.payload?.action === 'treaty_expired')).toBe(true);
  });

  it('宣战会召援目标的有效防御盟友', () => {
    const state = newGame('HUN', 'ruler', 'diplomacy-call-to-arms');
    for (const key of Object.keys(state.diplomacy)) state.diplomacy[key] = 0;
    state.treaties = [{
      treatyId: 'treaty-yong-chu',
      kind: 'alliance',
      a: 'YONG',
      b: 'CHU',
      startTurn: 1,
      endTurn: 8,
      status: 'active',
    }];
    state.pendingOrders = [{
      orderId: 'diplomacy-call-to-arms-1',
      kind: 'diplomatic_action',
      action: 'declare_war',
      targetFaction: 'YONG',
    }];
    const result = runTurn(state, ctx);
    expect(result.state.diplomacy['HUN|YONG']).toBeLessThanOrEqual(-25);
    expect(result.state.diplomacy['HUN|CHU']).toBeLessThanOrEqual(-25);
    expect(result.report.events.some((item) => item.payload?.action === 'defensive_call_to_arms' && item.targetId === 'CHU')).toBe(true);
  });

  it('防御盟约召援会让盟友同回合真实下达并执行反击行军', () => {
    const state = newGame('HUN', 'ruler', 'diplomacy-alliance-mobilization');
    state.date.turn = 2;
    for (const key of Object.keys(state.diplomacy)) state.diplomacy[key] = 0;
    state.diplomacy['CHU|YONG'] = 50;
    state.treaties = [{
      treatyId: 'treaty-yong-chu-mobilization',
      kind: 'alliance',
      a: 'YONG',
      b: 'CHU',
      startTurn: 1,
      endTurn: 8,
      status: 'active',
    }];

    // 用真实道路图中的一条边构造最小战线：唯一可达敌州不依赖种子里三国的初始接壤关系。
    const edge = Object.entries(buildAdjacency(ctx))
      .flatMap(([from, links]) => links.map((link) => [from, link.to] as const))[0];
    expect(edge).toBeDefined();
    const [homeRegionId, targetRegionId] = edge!;
    for (const region of Object.values(state.regions)) {
      region.faction = region.regionId === homeRegionId
        ? 'CHU'
        : region.regionId === targetRegionId
          ? 'HUN'
          : 'YONG';
    }
    state.regions[targetRegionId].garrison = 0;
    state.regions[targetRegionId].fortification = 0;
    state.regions[targetRegionId].loyalty = 50;

    const homeNodeId = capitalMapNodeId(ctx, homeRegionId);
    const targetNodeId = capitalMapNodeId(ctx, targetRegionId);
    if (!homeNodeId || !targetNodeId || !state.mapNodes) {
      throw new Error('测试战线缺少对应州府主城节点。');
    }
    for (const [nodeId, node] of Object.entries(state.mapNodes)) {
      const seedNode = ctx.seed.map_nodes.find((item) => item.node_id === nodeId);
      const regionId = ctx.territories.find((item) => item.region === seedNode?.region)?.region_id;
      node.faction = regionId === homeRegionId ? 'CHU' : regionId === targetRegionId ? 'HUN' : 'YONG';
    }

    const safeRegionId = Object.values(state.regions)
      .find((region) => region.regionId !== targetRegionId && region.regionId !== homeRegionId)?.regionId;
    if (!safeRegionId) throw new Error('测试地图缺少可安置后方军团的州府。');
    state.armies = state.armies.map((army) => {
      if (army.faction === 'CHU') {
        return {
          ...army,
          nodeId: homeRegionId,
          mapNodeId: homeNodeId,
          status: 'idle',
          supply: 100,
          fatigue: 0,
          morale: 100,
          training: 100,
          path: [],
          hopCosts: [],
          mapPath: [],
          mapHopCosts: [],
          targetRegionId: null,
          targetMapNodeId: null,
          marchDaysTotal: 0,
          marchDaysLeft: 0,
        };
      }
      if (army.faction === 'HUN' && army.nodeId === targetRegionId) {
        return { ...army, nodeId: safeRegionId, mapNodeId: capitalMapNodeId(ctx, safeRegionId) };
      }
      return army;
    });

    state.pendingOrders = [{
      orderId: 'diplomacy-alliance-mobilization-declare-war',
      kind: 'diplomatic_action',
      action: 'declare_war',
      targetFaction: 'YONG',
    }];
    const result = runTurn(state, ctx);

    expect(result.state.diplomacy['HUN|YONG']).toBeLessThanOrEqual(-25);
    expect(result.state.diplomacy['HUN|CHU']).toBeLessThanOrEqual(-25);
    const counterMarch = result.report.events.find((event) =>
      event.type === 'army_move' &&
      event.factionKey === 'CHU' &&
      event.source === 'npc_ai' &&
      event.after?.target === targetRegionId,
    );
    expect(counterMarch).toBeDefined();
  });

  it('非君主不能下达正式外交，且同回合不能排队两项外交', () => {
    const general = newGame('HUN', 'general', 'diplomacy-auth');
    const order: Order = {
      orderId: 'diplomacy-auth-1',
      kind: 'diplomatic_action',
      action: 'declare_war',
      targetFaction: 'CHU',
    };
    expect(validateOrder(general, ctx, order).issues[0]?.code).toBe('ROLE_FORBIDDEN');

    const ruler = newGame('HUN', 'ruler', 'diplomacy-limit');
    ruler.pendingOrders = [order];
    const second = validateOrder(ruler, ctx, { ...order, orderId: 'diplomacy-auth-2', action: 'offer_peace', targetFaction: 'YONG' });
    expect(second.ok).toBe(false);
  });
});

describe('战略节点后勤补给', () => {
  function logisticsScenario(supplyLevel: number, regionAdminFaction: 'HUN' | 'YONG' | 'CHU' = 'HUN') {
    const state = newGame('HUN', 'ruler', `node-logistics-${supplyLevel}`);
    for (const key of Object.keys(state.diplomacy)) state.diplomacy[key] = 100;
    const seedNode = ctx.seed.map_nodes.find((node) => /粮仓|驻军营地|集镇|补给/.test(node.node_type));
    if (!seedNode) throw new Error('种子地图缺少仓储或补给节点。');
    const regionId = ctx.territories.find((region) => region.region === seedNode.region)?.region_id;
    if (!regionId) throw new Error('仓储节点缺少对应州府。');
    for (const region of Object.values(state.regions)) region.faction = 'HUN';
    for (const node of Object.values(state.mapNodes ?? {})) node.faction = 'HUN';
    const node = state.mapNodes![seedNode.node_id];
    state.regions[regionId].faction = regionAdminFaction;
    node.supplyLevel = supplyLevel;
    const army = state.armies[0];
    state.armies = [{
      ...army,
      nodeId: regionId,
      mapNodeId: node.nodeId,
      status: 'idle',
      supply: 40,
      fatigue: 40,
      morale: 60,
      path: [],
      hopCosts: [],
      mapPath: [],
      mapHopCosts: [],
      targetRegionId: null,
      targetMapNodeId: null,
      marchDaysTotal: 0,
      marchDaysLeft: 0,
      currentHopDaysTotal: 0,
      mapCurrentHopDaysTotal: 0,
    }];
    state.factions.HUN.resources.cash = 1_000_000;
    state.factions.HUN.resources.grain = 1_000_000;
    state.factions.HUN.resources.salt = 1_000_000;
    state.factions.HUN.resources.iron = 1_000_000;
    state.factions.HUN.resources.horses = 1_000_000;
    state.factions.HUN.resources.manpower = 1_000_000;
    return { state, nodeId: node.nodeId };
  }

  it('驻扎在己方仓储节点时额外恢复补给并消耗节点库存', () => {
    const { state, nodeId } = logisticsScenario(70);
    const result = runTurn(state, ctx);
    const army = result.state.armies.find((item) => item.faction === 'HUN');
    const node = result.state.mapNodes![nodeId];
    expect(army?.supply).toBe(56);
    // 行政归属一致的后方节点先恢复 2 点储备，再支出 4 点为驻军补给。
    expect(node.supplyLevel).toBe(68);
    const event = result.report.events.find((item) =>
      item.type === 'resource' &&
      item.payload?.action === 'node_resupply' &&
      item.targetId === nodeId,
    );
    expect(event).toBeTruthy();
    expect(event?.before?.nodeSupplyLevel).toBe(72);
    expect(event?.after?.nodeSupplyLevel).toBe(68);
    expect(event?.after?.logisticsBonus).toBe(8);
    expect(event?.visibleToPlayer).toBe(true);
  });

  it('节点库存耗尽时不再提供额外补给或生成后勤事件', () => {
    // 敌方行政州府内的孤立附属据点没有本土后勤线，库存归零后不会自动补充。
    const { state, nodeId } = logisticsScenario(0, 'CHU');
    const result = runTurn(state, ctx);
    const army = result.state.armies.find((item) => item.faction === 'HUN');
    expect(army?.supply).toBe(32);
    expect(result.state.mapNodes![nodeId].supplyLevel).toBe(0);
    expect(result.report.events.some((item) =>
      item.type === 'resource' && item.payload?.action === 'node_resupply' && item.targetId === nodeId,
    )).toBe(false);
  });
  it('敌方控制的节点会切断常规补给，低于阈值后触发孤军减员', () => {
    const { state, nodeId } = logisticsScenario(0, 'HUN');
    const node = state.mapNodes![nodeId];
    node.faction = 'CHU';
    const armyBefore = state.armies[0];
    if (!armyBefore) throw new Error('测试缺少孤立军团。');
    armyBefore.supply = 25;
    const troopsBefore = armyBefore.troops;

    const result = runTurn(state, ctx);
    const army = result.state.armies.find((item) => item.faction === 'HUN');
    expect(army).toBeDefined();
    expect(army?.supply).toBe(17);
    expect(army?.troops).toBeLessThan(troopsBefore);

    const isolationEvent = result.report.events.find((item) =>
      item.type === 'shortage' && item.payload?.action === 'isolated_army_supply' && item.targetId === army?.armyId,
    );
    expect(isolationEvent).toBeTruthy();
    expect(isolationEvent?.before?.supply).toBe(25);
    expect(isolationEvent?.after?.supply).toBe(17);
    expect(isolationEvent?.after?.attritionLosses).toBe(troopsBefore - (army?.troops ?? 0));
    expect(isolationEvent?.visibleToPlayer).toBe(true);
  });
});

describe('多回合围城与解围', () => {
  function capitalSiegeScenario(gameId: string) {
    const state = newGame('HUN', 'ruler', gameId);
    for (const key of Object.keys(state.diplomacy)) state.diplomacy[key] = 100;
    state.diplomacy['HUN|YONG'] = -40;
    const adjacency = buildMapAdjacency(ctx);
    const seedNodes = new Map(ctx.seed.map_nodes.map((node) => [node.node_id, node]));
    const pair = Object.entries(adjacency)
      .filter(([from]) => seedNodes.get(from)?.node_type === '州府/主城')
      .flatMap(([from, links]) => links
        .filter((link) => seedNodes.get(link.to)?.node_type === '州府/主城')
        .map((link) => ({ sourceNodeId: from, targetNodeId: link.to, cost: link.cost })))
      .sort((a, b) => a.cost - b.cost || a.sourceNodeId.localeCompare(b.sourceNodeId))
      .find(({ sourceNodeId, targetNodeId }) => sourceNodeId !== targetNodeId);
    if (!pair) throw new Error('种子地图缺少相邻州府主城道路。');
    const sourceSeed = seedNodes.get(pair.sourceNodeId)!;
    const targetSeed = seedNodes.get(pair.targetNodeId)!;
    const sourceRegionId = ctx.territories.find((region) => region.region === sourceSeed.region)?.region_id;
    const targetRegionId = ctx.territories.find((region) => region.region === targetSeed.region)?.region_id;
    if (!sourceRegionId || !targetRegionId) throw new Error('测试主城缺少对应州府。');

    for (const region of Object.values(state.regions)) region.faction = 'HUN';
    for (const node of Object.values(state.mapNodes ?? {})) node.faction = 'HUN';
    state.regions[targetRegionId].faction = 'YONG';
    const source = state.mapNodes![pair.sourceNodeId];
    const target = state.mapNodes![pair.targetNodeId];
    source.faction = 'HUN';
    target.faction = 'YONG';
    target.fortification = 60;
    target.garrison = 60_000;
    target.supplyLevel = 70;
    state.regions[targetRegionId].fortification = 60;
    state.regions[targetRegionId].garrison = 60_000;
    state.regions[targetRegionId].garrisoned = true;

    const army = clone(state.armies.find((item) => item.faction === 'HUN')!);
    army.nodeId = sourceRegionId;
    army.mapNodeId = source.nodeId;
    army.status = 'idle';
    army.stance = 'defend';
    army.supply = 95;
    army.fatigue = 0;
    army.morale = 90;
    army.training = 85;
    army.path = [];
    army.hopCosts = [];
    army.mapPath = [];
    army.mapHopCosts = [];
    army.targetRegionId = null;
    army.targetMapNodeId = null;
    army.marchDaysTotal = 0;
    army.marchDaysLeft = 0;
    army.currentHopDaysTotal = 0;
    army.mapCurrentHopDaysTotal = 0;
    army.levies = 140_000;
    army.troops = army.levies + army.units.reduce((sum, unit) => sum + unit.count, 0);
    state.armies = [army];
    state.pendingOrders = [{
      orderId: 'siege-start',
      kind: 'move_army',
      armyId: army.armyId,
      targetRegionId,
      targetMapNodeId: pair.targetNodeId,
    }];
    return { state, sourceNodeId: pair.sourceNodeId, targetNodeId: pair.targetNodeId, targetRegionId, armyId: army.armyId };
  }

  it('攻入高城防主城会建立围城，下一回合才开始消耗城防、守军和储备', () => {
    const scenario = capitalSiegeScenario('siege-start-progress');
    const first = runTurn(scenario.state, ctx);
    const node = first.state.mapNodes![scenario.targetNodeId];
    const army = first.state.armies.find((item) => item.armyId === scenario.armyId);
    expect(node.siege).toEqual(expect.objectContaining({
      besiegerFaction: 'HUN',
      besiegerArmyIds: [scenario.armyId],
      startedTurn: 1,
      progress: 0,
      turns: 0,
    }));
    expect(node.faction).toBe('YONG');
    expect(army?.mapNodeId).toBe(scenario.sourceNodeId);
    expect(army?.stance).toBe('siege');
    expect(army?.targetMapNodeId).toBe(scenario.targetNodeId);
    expect(first.report.events.some((event) => event.payload?.action === 'siege_started')).toBe(true);

    const second = runTurn(first.state, ctx);
    const progressed = second.state.mapNodes![scenario.targetNodeId];
    expect(progressed.siege?.progress).toBeGreaterThan(0);
    expect(progressed.siege?.turns).toBe(1);
    expect(progressed.fortification).toBeLessThan(60);
    expect(progressed.garrison).toBeLessThan(60_000);
    expect(progressed.supplyLevel).toBeLessThan(72);
    expect(second.report.events.some((event) => event.payload?.action === 'siege_progress')).toBe(true);
  });

  it('围城突破后仍通过既有战斗规则攻城，不直接强制占领', () => {
    const scenario = capitalSiegeScenario('siege-assault-capture');
    const first = runTurn(scenario.state, ctx);
    const next = first.state;
    const node = next.mapNodes![scenario.targetNodeId];
    const region = next.regions[scenario.targetRegionId];
    node.siege!.progress = 99;
    node.garrison = 0;
    node.fortification = 0;
    node.supplyLevel = 0;
    region.garrison = 0;
    region.fortification = 0;
    region.garrisoned = false;
    next.date.turn = Math.max(2, next.date.turn);

    const result = runTurn(next, ctx);
    expect(result.state.mapNodes![scenario.targetNodeId].siege).toBeNull();
    expect(result.report.events.some((event) => event.payload?.action === 'siege_assault')).toBe(true);
    expect(result.report.events.some((event) => event.type === 'battle' && event.targetId === scenario.targetRegionId)).toBe(true);
    expect(result.state.regions[scenario.targetRegionId].faction).toBe('HUN');
    expect(result.state.mapNodes![scenario.targetNodeId].faction).toBe('HUN');
  });

  it('旧版 v7 存档迁移添加空围城状态，且不覆盖节点控制者', () => {
    const state = newGame('HUN', 'ruler', 'siege-v7-migration');
    state.schemaVersion = 7;
    const target = Object.values(state.mapNodes!)[0];
    target.faction = 'CHU';
    delete target.siege;
    const migrated = migrateState(state, seed.characters, seed);
    expect(migrated.schemaVersion).toBe(8);
    expect(migrated.mapNodes![target.nodeId].faction).toBe('CHU');
    expect(migrated.mapNodes![target.nodeId].siege).toBeNull();
    expect(migrateState(migrated, seed.characters, seed).mapNodes![target.nodeId].siege).toBeNull();
  });
});

describe('NPC 前线防御调兵', () => {
  it('敌军压到守备薄弱的友方主城时，NPC 会派另一支军团及时增援', () => {
    const state = newGame('HUN', 'ruler', 'npc-frontline-defense');
    state.date.turn = 2;
    for (const pair of Object.keys(state.diplomacy)) state.diplomacy[pair] = 100;
    state.diplomacy['HUN|CHU'] = -40;

    const adjacency = buildMapAdjacency(ctx);
    const seedNodes = new Map(ctx.seed.map_nodes.map((node) => [node.node_id, node]));
    const pair = Object.entries(adjacency)
      .filter(([targetNodeId]) => seedNodes.get(targetNodeId)?.node_type === '州府/主城')
      .flatMap(([targetNodeId, links]) =>
        links
          .filter((link) => seedNodes.get(link.to)?.node_type === '州府/主城')
          .map((link) => ({ targetNodeId, enemyNodeId: link.to })),
      )
      .find(({ targetNodeId, enemyNodeId }) =>
        (adjacency[targetNodeId] ?? []).some((link) => link.to !== enemyNodeId),
      );
    expect(pair).toBeDefined();
    const { targetNodeId, enemyNodeId } = pair!;
    const safeNodeId = (adjacency[targetNodeId] ?? []).find((link) => link.to !== enemyNodeId)?.to;
    if (!safeNodeId) throw new Error('测试主城缺少可供增援军团驻留的友方相邻节点。');

    for (const region of Object.values(state.regions)) region.faction = 'CHU';
    for (const node of Object.values(state.mapNodes ?? {})) node.faction = 'CHU';
    const targetNode = state.mapNodes![targetNodeId];
    const enemyNode = state.mapNodes![enemyNodeId];
    targetNode.garrison = 0;
    targetNode.fortification = 0;
    enemyNode.faction = 'HUN';
    enemyNode.garrison = 0;
    enemyNode.fortification = 0;
    state.regions[targetNode.regionId].garrison = 0;
    state.regions[targetNode.regionId].fortification = 0;

    const originalHun = state.armies.find((army) => army.faction === 'HUN');
    const originalChu = state.armies.find((army) => army.faction === 'CHU');
    if (!originalHun || !originalChu) throw new Error('测试缺少攻守两方军团。');
    const setTroops = (army: NonNullable<typeof originalHun>, total: number) => {
      const elite = army.units.reduce((sum, unit) => sum + unit.count, 0);
      army.levies = Math.max(0, total - elite);
      army.troops = army.levies + elite;
      army.morale = 90;
      army.training = 85;
      army.supply = 90;
      army.fatigue = 0;
      army.status = 'idle';
      army.path = [];
      army.hopCosts = [];
      army.mapPath = [];
      army.mapHopCosts = [];
      army.targetRegionId = null;
      army.targetMapNodeId = null;
      army.marchDaysTotal = 0;
      army.marchDaysLeft = 0;
      army.currentHopDaysTotal = 0;
      army.mapCurrentHopDaysTotal = 0;
    };
    const enemy = clone(originalHun);
    enemy.nodeId = enemyNode.regionId;
    enemy.mapNodeId = enemyNodeId;
    setTroops(enemy, 120_000);
    const defender = clone(originalChu);
    defender.nodeId = state.mapNodes![safeNodeId].regionId;
    defender.mapNodeId = safeNodeId;
    setTroops(defender, 50_000);
    state.armies = [enemy, defender];

    const first = generateNpcOrders(state, ctx).filter((order) =>
      order.orderId.startsWith('npc-CHU-') && order.kind === 'move_army',
    );
    const second = generateNpcOrders(clone(state), ctx).filter((order) =>
      order.orderId.startsWith('npc-CHU-') && order.kind === 'move_army',
    );
    expect(first).toEqual(second);
    expect(first).toContainEqual(expect.objectContaining({
      kind: 'move_army',
      armyId: defender.armyId,
      targetRegionId: targetNode.regionId,
      targetMapNodeId: targetNodeId,
    }));
  });
});

describe('NPC 战略地图节点进攻', () => {
  it('防御盟约响应会优先向敌方独立据点下令，而非只选州府主城', () => {
    const state = newGame('HUN', 'ruler', 'npc-strategic-node-target');
    state.date.turn = 2;
    for (const key of Object.keys(state.diplomacy)) state.diplomacy[key] = 100;
    state.diplomacy['HUN|YONG'] = -40;
    state.diplomacy['YONG|CHU'] = -40;
    state.diplomacy['HUN|CHU'] = 50;
    state.treaties = [{
      treatyId: 'treaty-hun-chu-map-target',
      kind: 'alliance',
      a: 'HUN',
      b: 'CHU',
      startTurn: 1,
      endTurn: 8,
      status: 'active',
    }];

    const adjacency = buildMapAdjacency(ctx);
    const mapSeedById = new Map(ctx.seed.map_nodes.map((node) => [node.node_id, node]));
    const targetEdge = Object.entries(adjacency)
      .flatMap(([from, links]) => links.map((link) => ({ from, to: link.to })))
      .find(({ to }) => mapSeedById.get(to)?.node_type !== '州府/主城');
    expect(targetEdge).toBeDefined();
    const { from: sourceNodeId, to: targetNodeId } = targetEdge!;
    const targetSeed = mapSeedById.get(targetNodeId)!;
    const sourceSeed = mapSeedById.get(sourceNodeId)!;
    expect(targetSeed.node_type).not.toBe('州府/主城');

    for (const region of Object.values(state.regions)) region.faction = 'CHU';
    for (const node of Object.values(state.mapNodes ?? {})) node.faction = 'CHU';
    state.mapNodes![targetNodeId].faction = 'YONG';
    state.mapNodes![targetNodeId].garrison = 0;
    state.mapNodes![targetNodeId].fortification = 0;

    const sourceRegionId = ctx.territories.find((region) => region.region === sourceSeed.region)?.region_id;
    const targetRegionId = ctx.territories.find((region) => region.region === targetSeed.region)?.region_id;
    if (!sourceRegionId || !targetRegionId) throw new Error('测试战略节点缺少对应州府。');

    const chuArmies = state.armies.filter((army) => army.faction === 'CHU');
    const activeArmyId = chuArmies[0]?.armyId;
    if (!activeArmyId) throw new Error('测试缺少大楚军团。');
    const safeNodeId = Object.keys(state.mapNodes ?? {}).find(
      (nodeId) => nodeId !== sourceNodeId && nodeId !== targetNodeId,
    );
    if (!safeNodeId) throw new Error('测试地图缺少可安置后方军团的节点。');
    const safeRegionId = state.mapNodes![safeNodeId].regionId;
    state.armies = state.armies.map((army) => {
      if (army.faction === 'CHU') {
        if (army.armyId === activeArmyId) {
          return {
            ...army,
            nodeId: sourceRegionId,
            mapNodeId: sourceNodeId,
            status: 'idle',
            supply: 100,
            fatigue: 0,
            morale: 100,
            training: 100,
          };
        }
        return { ...army, status: 'marching' };
      }
      // 避免原始 YONG 军团偶然驻在测试目标节点，让本例只测节点选敌。
      return { ...army, nodeId: safeRegionId, mapNodeId: safeNodeId, status: 'marching' };
    });

    const orders = generateNpcOrders(state, ctx).filter(
      (order) => order.kind === 'move_army' && order.orderId.startsWith('npc-CHU-'),
    );
    expect(orders).toContainEqual(expect.objectContaining({
      kind: 'move_army',
      armyId: activeArmyId,
      targetRegionId,
      targetMapNodeId: targetNodeId,
    }));
  });
});

describe('NPC 战略节点战斗闭环', () => {
  it('NPC 的节点目标命令会在回合结算中触发据点战并只改变节点控制权', () => {
    const state = newGame('HUN', 'ruler', 'npc-node-battle-integration');
    state.date.turn = 2;
    for (const key of Object.keys(state.diplomacy)) state.diplomacy[key] = 100;
    state.diplomacy['HUN|YONG'] = -40;
    state.diplomacy['YONG|CHU'] = -40;
    state.diplomacy['HUN|CHU'] = 50;
    state.treaties = [{
      treatyId: 'treaty-hun-chu-node-battle',
      kind: 'alliance',
      a: 'HUN',
      b: 'CHU',
      startTurn: 1,
      endTurn: 8,
      status: 'active',
    }];

    const adjacency = buildMapAdjacency(ctx);
    const mapSeedById = new Map(ctx.seed.map_nodes.map((node) => [node.node_id, node]));
    const targetEdge = Object.entries(adjacency)
      .flatMap(([from, links]) => links.map((link) => ({ from, to: link.to })))
      .find(({ to }) => mapSeedById.get(to)?.node_type !== '州府/主城');
    expect(targetEdge).toBeDefined();
    const { from: sourceNodeId, to: targetNodeId } = targetEdge!;
    const sourceSeed = mapSeedById.get(sourceNodeId)!;
    const targetSeed = mapSeedById.get(targetNodeId)!;
    const sourceRegionId = ctx.territories.find((region) => region.region === sourceSeed.region)?.region_id;
    const targetRegionId = ctx.territories.find((region) => region.region === targetSeed.region)?.region_id;
    if (!sourceRegionId || !targetRegionId) throw new Error('测试战略节点缺少对应州府。');

    for (const region of Object.values(state.regions)) region.faction = 'CHU';
    for (const node of Object.values(state.mapNodes ?? {})) node.faction = 'CHU';
    state.mapNodes![targetNodeId].faction = 'YONG';
    state.mapNodes![targetNodeId].garrison = 0;
    state.mapNodes![targetNodeId].fortification = 0;

    const chuArmy = state.armies.find((army) => army.faction === 'CHU');
    if (!chuArmy) throw new Error('测试缺少大楚军团。');
    const safeNodeId = Object.keys(state.mapNodes ?? {}).find(
      (nodeId) => nodeId !== sourceNodeId && nodeId !== targetNodeId,
    );
    if (!safeNodeId) throw new Error('测试地图缺少后方安置节点。');
    const safeRegionId = state.mapNodes![safeNodeId].regionId;
    state.armies = state.armies.map((army) => {
      if (army.armyId === chuArmy.armyId) {
        return {
          ...army,
          nodeId: sourceRegionId,
          mapNodeId: sourceNodeId,
          troops: 300_000,
          levies: 300_000,
          units: [],
          status: 'idle',
          stance: 'defend',
          supply: 100,
          fatigue: 0,
          morale: 100,
          training: 100,
          path: [],
          hopCosts: [],
          mapPath: [],
          mapHopCosts: [],
          targetRegionId: null,
          targetMapNodeId: null,
          marchDaysTotal: 0,
          marchDaysLeft: 0,
          currentHopDaysTotal: 0,
          mapCurrentHopDaysTotal: 0,
        };
      }
      return {
        ...army,
        nodeId: safeRegionId,
        mapNodeId: safeNodeId,
        status: 'marching',
        path: [],
        hopCosts: [],
        mapPath: [],
        mapHopCosts: [],
        targetRegionId: null,
        targetMapNodeId: null,
        marchDaysTotal: 0,
        marchDaysLeft: 0,
        currentHopDaysTotal: 0,
        mapCurrentHopDaysTotal: 0,
      };
    });

    const beforeOccupiedNodes = state.statistics.occupiedMapNodes ?? 0;
    const result = runTurn(state, ctx);
    const battle = result.report.events.find((event) =>
      event.type === 'battle' && event.payload?.mapNodeId === targetNodeId,
    );
    const occupation = result.report.events.find((event) =>
      event.type === 'occupation' && event.targetId === targetNodeId,
    );

    expect(battle).toBeDefined();
    expect(battle?.after?.attackerWon).toBe(true);
    expect(occupation).toBeDefined();
    expect(result.state.mapNodes?.[targetNodeId]?.faction).toBe('CHU');
    // 攻占附属据点不直接转移州府行政归属。
    expect(result.state.regions[targetRegionId].faction).toBe('CHU');
    expect(result.state.statistics.occupiedMapNodes).toBe(beforeOccupiedNodes + 1);
  });

});

describe('NPC 外交自主决策', () => {
  it('同一状态重复生成外交意图完全一致，战事与国库压力会触发议和', () => {
    const state = newGame('HUN', 'ruler', 'npc-diplomacy-determinism');
    state.date.turn = 3;
    for (const key of Object.keys(state.diplomacy)) state.diplomacy[key] = 100;
    state.diplomacy['HUN|YONG'] = -30;
    state.factions.YONG.resources.cash = 100_000;
    state.factions.YONG.resources.grain = 10_000;

    const first = generateNpcOrders(state, ctx).filter((order) => order.kind === 'diplomatic_action');
    const second = generateNpcOrders(clone(state), ctx).filter((order) => order.kind === 'diplomatic_action');
    expect(first).toEqual(second);
    expect(first).toContainEqual(expect.objectContaining({
      orderId: expect.stringMatching(/^npc-YONG-/),
      kind: 'diplomatic_action',
      action: 'offer_peace',
      targetFaction: 'HUN',
    }));
  });

  it('NPC 向玩家提出议和时，规则会结算停战并让外交结果可见', () => {
    const state = newGame('HUN', 'ruler', 'npc-diplomacy-visible');
    state.date.turn = 3;
    for (const key of Object.keys(state.diplomacy)) state.diplomacy[key] = 100;
    state.diplomacy['HUN|YONG'] = -30;
    state.factions.YONG.resources.cash = 100_000;
    state.factions.YONG.resources.grain = 10_000;

    const result = runTurn(state, ctx);
    expect(result.state.diplomacy['HUN|YONG']).toBeGreaterThan(-25);
    const event = result.report.events.find((item) =>
      item.source === 'npc_ai' &&
      item.type === 'diplomacy' &&
      item.payload?.action === 'offer_peace' &&
      item.factionKey === 'YONG' &&
      item.targetId === 'HUN',
    );
    expect(event).toBeTruthy();
    expect(event?.visibleToPlayer).toBe(true);
  });
});

describe('人物目标与自主行动', () => {
  it('地方主官会付出银钱整饬低秩序地区，并记录行动前后事实', () => {
    const state = newGame('HUN', 'ruler', 'goal-governor');
    for (const key of Object.keys(state.diplomacy)) state.diplomacy[key] = 100;
    const region = Object.values(state.regions)
      .filter((item) => item.faction === 'YONG')
      .sort((a, b) => a.regionId.localeCompare(b.regionId))[0];
    region.order = 25;
    region.loyalty = 30;
    const governorId = region.governorId;

    const result = runTurn(state, ctx);
    const action = result.report.events.find(
      (event) => event.type === 'npc_action' && event.payload?.action === 'stabilize_region' && event.targetId === region.regionId,
    );
    expect(action).toBeTruthy();
    expect(action?.before?.cash).toBeGreaterThan(action?.after?.cash as number);
    expect((action?.before?.cash as number) - (action?.after?.cash as number)).toBe(4_000);
    expect(action?.before?.order).toBe(25);
    expect(action?.after?.order).toBe(28);
    expect(action?.before?.loyalty).toBe(30);
    expect(action?.after?.loyalty).toBe(32);
    expect(result.state.characters[governorId].goal).toBe('stabilize_region');
    expect(result.state.characters[governorId].goalLastActionTurn).toBe(1);
  });

  it('未获安抚的匈奴部落会每四回合施压，记录忠诚变化', () => {
    const state = newGame('YONG', 'ruler', 'goal-tribe');
    const tribe = state.special.HUN.tribes![0];
    tribe.loyalty = 35;
    tribe.lastGiftTurn = 0;
    state.factions.HUN.resources.cash = 0;
    const result = runTurn(state, ctx);
    const action = result.report.events.find(
      (event) => event.type === 'npc_action' && event.payload?.action === 'demand_patronage' && event.targetId === tribe.tribeId,
    );
    expect(action).toBeTruthy();
    expect(action?.before?.loyalty).toBe(35);
    expect(action?.after?.loyalty).toBe(33);
    expect(result.state.characters[tribe.chiefId].goal).toBe('demand_patronage');
  });

  it('NPC 将领的整军目标会优先生成休整军令', () => {
    const state = newGame('YONG', 'ruler', 'goal-army');
    for (const key of Object.keys(state.diplomacy)) state.diplomacy[key] = 100;
    const army = state.armies.find((item) => item.faction === 'CHU')!;
    army.supply = 40;
    army.fatigue = 60;
    army.morale = 35;
    state.characters[army.commanderId].goal = 'restore_readiness';
    state.characters[army.commanderId].goalTargetId = army.armyId;

    const orders = generateNpcOrders(state, ctx);
    expect(orders.some((order) => order.orderId.startsWith('npc-CHU') && order.kind === 'rest_army' && order.armyId === army.armyId)).toBe(true);
  });
});

describe('回合结算', () => {
  it('推进 7 天后日期、回合与事件均更新', () => {
    const state = newGame('YONG');
    const result = runTurn(state, ctx);
    expect(result.state.date.dayIndex).toBe(7);
    expect(result.state.date.turn).toBe(2);
    expect(result.state.date.label).toContain('三月八日');
    expect(result.report.events.length).toBeGreaterThan(0);
    expect(result.report.chronicle.length).toBeGreaterThan(0);
    expect(result.report.chronicle[0].facts.length).toBeGreaterThan(0);
  });

  it('短缺会真实影响士气与兵力，而非只显示文本', () => {
    const state = newGame('HUN');
    state.factions.HUN.resources.grain = 0;
    const beforeMorale = state.armies.filter((a) => a.faction === 'HUN').reduce((s, a) => s + a.morale, 0);
    const beforeTroops = state.armies.filter((a) => a.faction === 'HUN').reduce((s, a) => s + a.troops, 0);
    const result = runTurn(state, ctx);
    const afterMorale = result.state.armies.filter((a) => a.faction === 'HUN').reduce((s, a) => s + a.morale, 0);
    const afterTroops = result.state.armies.filter((a) => a.faction === 'HUN').reduce((s, a) => s + a.troops, 0);
    expect(result.report.events.some((e) => e.type === 'shortage' && e.visibleToPlayer)).toBe(true);
    expect(afterMorale).toBeLessThan(beforeMorale);
    expect(afterTroops).toBeLessThanOrEqual(beforeTroops);
  });

  it('战斗可重放且战败忠诚惩罚严格按伤亡阈值结算', () => {
    const base = newGame('HUN', 'ruler', 'battle-seed');
    base.pendingOrders = [
      { orderId: 'b1', kind: 'move_army', armyId: 'HUN-ARMY-02', targetRegionId: 'YONG-REG03' },
    ];
    const a = runTurn(clone(base), ctx);
    const b = runTurn(clone(base), ctx);
    const battleA = a.report.events.find((event) => event.type === 'battle');
    const battleB = b.report.events.find((event) => event.type === 'battle');
    expect(battleA).toBeTruthy();
    expect(battleB).toBeTruthy();
    expect((battleA!.after as any).attackerWon).toBe((battleB!.after as any).attackerWon);
    expect((battleA!.payload as any).seed).toBe((battleB!.payload as any).seed);
    expect((battleA!.after as any).totalLosses).toBe((battleB!.after as any).totalLosses);

    const outcome = (battleA!.after as any).attackerWon as boolean;
    const payload = battleA!.payload as any;
    const defeatedCommanderId = outcome ? payload.defenderCommander?.id : payload.attackerCommander?.id;
    expect(defeatedCommanderId).toBeTruthy();
    const defeatedSeed = ctx.charactersById[defeatedCommanderId];
    const loyaltyBefore = base.characters[defeatedCommanderId].militaryLoyalty ?? defeatedSeed?.loyalty ?? 50;
    const loyaltyEvent = a.report.events.find((event) =>
      event.type === 'politics' &&
      event.title.includes('战败失威') &&
      event.actorId === defeatedCommanderId,
    );
    expect(loyaltyEvent).toBeTruthy();
    const casualtyRate = Number(loyaltyEvent!.before?.casualtyRate);
    const expectedNormalPenalty = BALANCE.militaryLoyalty.battleLossPenalty +
      (casualtyRate >= BALANCE.militaryLoyalty.heavyCasualtyRate
        ? BALANCE.militaryLoyalty.heavyCasualtyPenalty
        : 0);
    expect(loyaltyEvent!.after?.penalty).toBe(expectedNormalPenalty);
    expect(loyaltyEvent!.before?.loyalty).toBe(loyaltyBefore);
    expect(a.state.characters[defeatedCommanderId].militaryLoyalty).toBe(
      Math.max(0, loyaltyBefore - expectedNormalPenalty),
    );

    // 明确覆盖普通阈值、精确边界与重伤亡区间，不修改全局平衡常量。
    expect(battleDefeatLoyaltyPenalty(0)).toBe(BALANCE.militaryLoyalty.battleLossPenalty);
    expect(battleDefeatLoyaltyPenalty(BALANCE.militaryLoyalty.heavyCasualtyRate - 0.000001))
      .toBe(BALANCE.militaryLoyalty.battleLossPenalty);
    expect(battleDefeatLoyaltyPenalty(BALANCE.militaryLoyalty.heavyCasualtyRate))
      .toBe(BALANCE.militaryLoyalty.battleLossPenalty + BALANCE.militaryLoyalty.heavyCasualtyPenalty);
    expect(battleDefeatLoyaltyPenalty(0.75))
      .toBe(BALANCE.militaryLoyalty.battleLossPenalty + BALANCE.militaryLoyalty.heavyCasualtyPenalty);
  });

  it('匈奴部落忠诚过低时拒绝出兵', () => {
    const state = newGame('HUN');
    const tribe = state.special.HUN.tribes!.find((t) => state.armies.some((a) => a.faction === 'HUN' && a.nodeId === t.regionId));
    expect(tribe).toBeTruthy();
    tribe!.loyalty = 20;
    tribe!.stance = 'refusing';
    const army = state.armies.find((a) => a.faction === 'HUN' && a.nodeId === tribe!.regionId)!;
    const res = validateOrder(state, ctx, {
      orderId: 't1',
      kind: 'move_army',
      armyId: army.armyId,
      targetRegionId: 'HUN-REG01',
    });
    expect(res.ok).toBe(false);
    expect(res.issues[0].code).toBe('TRIBE_REFUSAL');
  });

  it('大雍朝局失稳触发夺嫡危机', () => {
    const state = newGame('YONG');
    state.special.YONG.courtStability = 30;
    state.special.YONG.princes!.forEach((p, i) => (p.influence = 80 - i * 3));
    const result = runTurn(state, ctx);
    expect(result.state.flags.successionCrisis).toBe(true);
    expect(result.report.events.some((e) => e.type === 'succession')).toBe(true);
  });

  it('大楚世家支持过低触发集体抵制', () => {
    const state = newGame('CHU');
    state.special.CHU.houses!.forEach((h) => (h.support = 20));
    const result = runTurn(state, ctx);
    expect(result.state.flags.houseBoycott).toBe(true);
    expect(result.report.events.some((e) => e.type === 'politics')).toBe(true);
  });

  it('NPC 遭遇夺嫡危机时优先平衡皇子派系', () => {
    const state = newGame('CHU', 'ruler', 'npc-yong-crisis');
    state.factions.YONG.resources.cash = 100_000;
    state.special.YONG.courtStability = 20;
    state.flags.successionCrisis = true;

    const orders = generateNpcOrders(state, ctx);
    expect(orders.some((order) => order.kind === 'balance_princes')).toBe(true);
  });

  it('匈奴 NPC 优先安抚拒命部落，而非只按忠诚最低排序', () => {
    const state = newGame('CHU', 'ruler', 'npc-hun-refusal');
    state.special.HUN.cohesion = 45;
    state.factions.HUN.resources.cash = 50_000;
    const tribes = state.special.HUN.tribes!;
    tribes[0].loyalty = 20;
    tribes[0].stance = 'watchful';
    tribes[1].loyalty = 48;
    tribes[1].stance = 'refusing';

    const orders = generateNpcOrders(state, ctx);
    const appeasement = orders.find((order) => order.kind === 'appease_tribe');
    expect(appeasement?.kind).toBe('appease_tribe');
    if (appeasement?.kind === 'appease_tribe') {
      expect(appeasement.tribeId).toBe(tribes[1].tribeId);
    }
  });

  it('NPC 在敌方守备压倒性占优时不会发起无意义进攻', () => {
    const state = newGame('CHU', 'ruler', 'npc-no-suicide');
    state.diplomacy['HUN|YONG'] = -80;
    state.diplomacy['HUN|CHU'] = -80;
    state.diplomacy['YONG|CHU'] = -80;
    for (const region of Object.values(state.regions)) {
      region.garrison = 900_000;
      region.fortification = 100;
    }
    for (const army of state.armies) {
      army.status = 'idle';
      army.supply = 100;
      army.morale = 100;
      army.training = 100;
      army.fatigue = 0;
    }

    const orders = generateNpcOrders(state, ctx);
    expect(orders.some((order) => order.kind === 'move_army')).toBe(false);
  });

  it('NPC 内部命令不泄露给玩家', () => {
    const state = newGame('CHU');
    const result = runTurn(state, ctx);
    const hidden = result.report.events.filter((e) => !e.visibleToPlayer);
    expect(hidden.length).toBeGreaterThan(0);
    expect(result.report.events.some((e) => e.visibleToPlayer && e.factionKey === 'HUN' && e.type === 'order_accepted')).toBe(false);
  });
});

describe('分兵、州兵与计谋', () => {
  const freeCommanders = (state: GameState) =>
    ctx.seed.characters.filter(
      (c) => c.faction_key === state.factionKey && !state.armies.some((a) => a.commanderId === c.person_id),
    );

  it('可以从军团中分兵一万并另选统兵官', () => {
    const state = newGame('YONG');
    const army = state.armies.find((a) => a.faction === 'YONG' && a.units.length > 0)!;
    const cmd = freeCommanders(state)[0];
    const target = Object.values(state.regions).find((r) => r.faction === 'YONG' && r.regionId !== army.nodeId)!;
    const check = validateOrder(state, ctx, {
      orderId: 'split-1',
      kind: 'move_army',
      armyId: army.armyId,
      targetRegionId: target.regionId,
      amount: 10_000,
      commanderId: cmd.person_id,
    });
    expect(check.ok).toBe(true);
    const before = army.troops;
    state.pendingOrders = [{ orderId: 'split-1', kind: 'move_army', armyId: army.armyId, targetRegionId: target.regionId, amount: 10_000, commanderId: cmd.person_id }];
    const result = runTurn(state, ctx);
    const det = result.state.armies.find((a) => a.isDetachment && a.commanderId === cmd.person_id);
    expect(det).toBeTruthy();
    expect(det!.troops).toBe(10_000);
    const original = result.state.armies.find((a) => a.armyId === army.armyId)!;
    expect(original.troops).toBeLessThan(before);
    expect(original.troops + det!.troops).toBe(before);
  });

  it('分兵未指定统兵官会被拒绝', () => {
    const state = newGame('YONG');
    const army = state.armies.find((a) => a.faction === 'YONG')!;
    const target = Object.values(state.regions).find((r) => r.faction === 'YONG' && r.regionId !== army.nodeId)!;
    const res = validateOrder(state, ctx, {
      orderId: 'split-2',
      kind: 'move_army',
      armyId: army.armyId,
      targetRegionId: target.regionId,
      amount: 5_000,
    });
    expect(res.ok).toBe(false);
    expect(res.issues[0].code).toBe('COMMANDER_REQUIRED');
  });

  it('每州州兵可调出，调出后本州守备减少', () => {
    const state = newGame('YONG');
    const region = state.regions['YONG-REG01'];
    const target = Object.values(state.regions).find((r) => r.faction === 'YONG' && r.regionId !== region.regionId)!;
    const before = region.garrison;
    const check = validateOrder(state, ctx, {
      orderId: 'gar-1',
      kind: 'dispatch_garrison',
      regionId: region.regionId,
      targetRegionId: target.regionId,
      amount: 3_000,
    });
    expect(check.ok).toBe(true);
    state.pendingOrders = [{ orderId: 'gar-1', kind: 'dispatch_garrison', regionId: region.regionId, targetRegionId: target.regionId, amount: 3_000 }];
    const result = runTurn(state, ctx);
    const militia = result.state.armies.find((a) => a.isMilitia && a.name.includes(region.name));
    expect(militia).toBeTruthy();
    expect(militia!.troops).toBe(3_000);
    expect(result.state.regions[region.regionId].garrison).toBe(before - 3_000);
  });

  it('征兵可以新建军团并由将领统带', () => {
    const state = newGame('YONG');
    const region = state.regions['YONG-REG01'];
    const check = validateOrder(state, ctx, {
      orderId: 'rec-new',
      kind: 'recruit',
      amount: 6_000,
      regionId: region.regionId,
      formNewArmy: true,
    });
    expect(check.ok).toBe(true);
    const before = state.armies.length;
    state.pendingOrders = [{ orderId: 'rec-new', kind: 'recruit', amount: 6_000, regionId: region.regionId, formNewArmy: true }];
    const result = runTurn(state, ctx);
    expect(result.state.armies.length).toBeGreaterThan(before);
    const army = result.state.armies.find((a) => a.name.includes('新募营'));
    expect(army).toBeTruthy();
    expect(army!.troops).toBe(6_000);
  });

  it('计谋产生独立事件，成功时改变战场变量', () => {
    const state = newGame('YONG');
    const region = state.regions['YONG-REG07'];
    const beforeCash = state.factions.YONG.resources.cash;
    const check = validateOrder(state, ctx, {
      orderId: 'scheme-1',
      kind: 'scheme',
      scheme: 'ambush',
      targetRegionId: region.regionId,
    });
    expect(check.ok).toBe(true);
    expect(check.preview).toContain('成功率');
    state.pendingOrders = [{ orderId: 'scheme-1', kind: 'scheme', scheme: 'ambush', targetRegionId: region.regionId }];
    const result = runTurn(state, ctx);
    const ev = result.report.events.find((e) => e.type === 'scheme');
    expect(ev).toBeTruthy();
    expect(Number((ev!.before as any).cash) - Number((ev!.after as any).cash)).toBe(4_000);
    if ((ev!.payload as any).success) {
      expect(result.state.regions[region.regionId].ambushBonus).toBeGreaterThan(0);
    }
  });

  it('统率更高的将领带来更高战力（同兵力同种子）', () => {
    const base = newGame('YONG');
    const attacker = base.armies.find((a) => a.faction === 'YONG')!;
    const defender = base.armies.find((a) => a.faction === 'CHU')!;
    const region = base.regions['CHU-REG01'];
    defender.nodeId = region.regionId;
    const chars = ctx.seed.characters
      .filter((c) => c.faction_key === 'YONG')
      .sort((a, b) => b.command - a.command);
    const high = chars[0];
    const low = chars[chars.length - 1];
    const runPower = (commandId: string) => {
      const state = clone(base);
      const atk = state.armies.find((a) => a.armyId === attacker.armyId)!;
      const def = state.armies.find((a) => a.armyId === defender.armyId)!;
      atk.commanderId = commandId;
      const outcome = resolveBattle(state, ctx, atk, def, state.regions[region.regionId], 12345);
      return outcome.attackerPower;
    };
    const highPower = runPower(high.person_id);
    const lowPower = runPower(low.person_id);
    expect(highPower).toBeGreaterThan(lowPower);
  });

  it('三国朝议数据不为空', () => {
    expect(newGame('HUN').special.HUN.tribes?.length).toBe(6);
    expect(newGame('YONG').special.YONG.princes?.length).toBe(3);
    expect(newGame('CHU').special.CHU.houses?.length).toBe(6);
  });

  it('玩家可在人物/军队面板查看敌我统率与谋略差异（视图包含将领数值）', () => {
    const state = newGame('YONG', 'ruler');
    const own = state.armies.find((a) => a.faction === 'YONG')!;
    const char = ctx.charactersById[own.commanderId]!;
    expect(char.command).toBeGreaterThan(0);
    expect(char.strategy).toBeGreaterThan(0);
  });
});

describe('存档快照', () => {
  it('状态可通过 JSON 往返恢复（存档/读档基础）', () => {
    const state = newGame('YONG');
    const result = runTurn(state, ctx);
    const restored = clone(result.state);
    expect(restored.date.label).toBe(result.state.date.label);
    expect(restored.armies.length).toBe(result.state.armies.length);
    expect(restored.factions.YONG.resources).toEqual(result.state.factions.YONG.resources);
    expect(restored.schemaVersion).toBe(7);
  });
});

describe('平衡常量', () => {
  it('一回合固定为 7 天', () => {
    expect(BALANCE.turnDays).toBe(7);
  });
});


describe('跨回合行军与当前路段进度', () => {
  it('10 天路段在 7 天回合末保留 3 天，下一回合再走 3 天抵达，地图显示 70% 进度', () => {
    let state = newGame('HUN', 'ruler', 'cross-turn-march');
    // 隔离测试变量：其他部队静止，外交全为和平，避免 NPC 战局影响目标节点。
    for (const key of Object.keys(state.diplomacy)) state.diplomacy[key] = 100;
    state.armies = state.armies.map((a) => ({
      ...a,
      path: [],
      hopCosts: [],
      targetRegionId: null,
      marchDaysTotal: 0,
      marchDaysLeft: 0,
      currentHopDaysTotal: 0,
      status: 'idle' as const,
      stance: 'defend' as const,
    }));
    const army = state.armies.find((a) => a.faction === 'HUN')!;
    const source = army.nodeId;
    const target = Object.values(state.regions).find(
      (region) => region.faction === 'HUN' && region.regionId !== source,
    )!;
    const armyId = army.armyId;
    army.path = [target.regionId];
    army.hopCosts = [10];
    army.targetRegionId = target.regionId;
    army.marchDaysTotal = 10;
    army.marchDaysLeft = 10;
    army.currentHopDaysTotal = 10;
    army.status = 'marching';
    army.stance = 'march';

    const first = runTurn(state, ctx).state;
    const afterFirst = first.armies.find((a) => a.armyId === armyId)!;
    expect(afterFirst.nodeId).toBe(source);
    expect(afterFirst.hopCosts).toEqual([3]);
    expect(afterFirst.marchDaysLeft).toBe(3);
    expect(afterFirst.currentHopDaysTotal).toBe(10);
    const armyView = buildPlayerView(first, ctx).armies.find((a) => a.armyId === armyId)!;
    expect(armyView.progress).toBeCloseTo(0.7, 5);

    const second = runTurn(first, ctx).state;
    const afterSecond = second.armies.find((a) => a.armyId === armyId)!;
    expect(afterSecond.nodeId).toBe(target.regionId);
    expect(afterSecond.path).toHaveLength(0);
    expect(afterSecond.status).toBe('idle');
    expect(afterSecond.marchDaysLeft).toBe(0);
    expect(afterSecond.currentHopDaysTotal).toBe(0);
  });
});
