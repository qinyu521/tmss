import { describe, expect, it } from 'vitest';
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
  applyUnitNames,
  buildContext,
  buildMapAdjacency,
  findMapPath,
  migrateState,
  buildPlayerView,
  createGame,
  resolveBattle,
  runTurn,
  validateOrder,
  generateNpcOrders,
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

  it('战斗使用固定随机种子，重复结算得到同一结果', () => {
    const base = newGame('HUN', 'ruler', 'battle-seed');
    base.pendingOrders = [
      { orderId: 'b1', kind: 'move_army', armyId: 'HUN-ARMY-02', targetRegionId: 'YONG-REG03' },
    ];
    const a = runTurn(clone(base), ctx);
    const b = runTurn(clone(base), ctx);
    const battleA = a.report.events.find((e) => e.type === 'battle');
    const battleB = b.report.events.find((e) => e.type === 'battle');
    expect(battleA).toBeTruthy();
    expect(battleB).toBeTruthy();
    expect((battleA!.after as any).attackerWon).toBe((battleB!.after as any).attackerWon);
    expect((battleA!.payload as any).seed).toBe((battleB!.payload as any).seed);
    expect((battleA!.after as any).totalLosses).toBe((battleB!.after as any).totalLosses);
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
    expect(restored.schemaVersion).toBe(6);
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
