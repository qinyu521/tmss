import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import apiPkg from '../package.json';
import { buildApp, type BuiltApp } from './app.js';
import { getGameState, insertEvents, saveGameState, StaleGameStateError } from './gameRepo.js';
import type { LlmFetcher } from './llm.js';

let built: BuiltApp;
let app: FastifyInstance;
let tmpDir: string;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tianming-test-'));
  built = await buildApp({
    dbPath: path.join(tmpDir, 'test.db'),
    logger: false,
    serveWeb: false,
  });
  app = built.app;
  await app.ready();
}, 60_000);

afterAll(async () => {
  await built.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('API 集成', () => {
  let gameId = '';

  it('健康检查返回种子计数', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.version).toBe(apiPkg.version);
    expect(body.seedCounts.characters).toBe(336);
    expect(body.seedCounts.map_nodes).toBe(72);
    expect(body.seedCounts.military_units).toBe(22);
  });

  it('原型审计不把合法中立人才误报为冲突', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/audit' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(336);
    expect(body.consistent).toBe(336);
    expect(body.mismatches).toEqual([]);
    expect(body.coreConflicts).toEqual([]);
  });

  it('地图返回 72 节点与 31 条原始边', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/map' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.nodes).toHaveLength(72);
    expect(body.edges).toHaveLength(31);
    expect(body.territories).toHaveLength(24);
    expect(body.derivedNote).toContain('连通');
  });

  it('人物分页与详情包含原型、关系与任命', async () => {
    const list = await app.inject({ method: 'GET', url: '/api/characters?faction=HUN&pageSize=10' });
    expect(list.statusCode).toBe(200);
    const body = list.json();
    expect(body.total).toBe(112);
    expect(body.items).toHaveLength(10);
    const detail = await app.inject({ method: 'GET', url: `/api/characters/${body.items[0].person_id}` });
    expect(detail.statusCode).toBe(200);
    const d = detail.json();
    expect(d.character.name).toBeTruthy();
    expect(d.archetype).toBeTruthy();
    expect(Array.isArray(d.relationships)).toBe(true);
    expect(d.appointment).toBeTruthy();
    // 未携带 gameId：保持静态档案，runtime 为空
    expect(d.runtime).toBeNull();
  });

  it('携带 gameId 时人物详情返回该局运行时状态', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/games',
      payload: { factionKey: 'YONG', playerRole: 'ruler', seed: 20261028 },
    });
    expect(created.statusCode).toBe(200);
    const gid = created.json().gameId as string;
    const list = await app.inject({ method: 'GET', url: `/api/characters?faction=YONG&pageSize=5&gameId=${gid}` });
    expect(list.statusCode).toBe(200);
    const items = list.json().items as any[];
    expect(items.every((it) => it.alive === true)).toBe(true);
    const detail = await app.inject({ method: 'GET', url: `/api/characters/${items[0].person_id}?gameId=${gid}` });
    expect(detail.statusCode).toBe(200);
    const d = detail.json();
    expect(d.runtime).toBeTruthy();
    expect(d.runtime.alive).toBe(true);
    expect(d.runtime.ageBand).toBeTruthy();
    // 结算数旬后仍一致（生死由引擎决定，接口只读）
    await app.inject({ method: 'POST', url: `/api/games/${gid}/turn` });
    const after = await app.inject({ method: 'GET', url: `/api/characters/${items[0].person_id}?gameId=${gid}` });
    expect(after.json().runtime).toBeTruthy();
  });

  it('22 个兵种含派生数值档案', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/units' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveLength(22);
    expect(body.every((u: any) => u.profile && u.profile.capPerFaction > 0)).toBe(true);
  });

  it('创建游戏并校验权限错误原因', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/games',
      payload: { factionKey: 'HUN', playerRole: 'strategist', seed: 1234 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    gameId = body.gameId;
    expect(body.view.own.fieldTroops).toBe(400_000);
    const ownArmy = body.view.armies.find((a: any) => a.own);
    expect(ownArmy).toBeTruthy();

    const armyId = ownArmy.armyId;
    const order = await app.inject({
      method: 'POST',
      url: `/api/games/${gameId}/orders`,
      payload: {
        orders: [{ orderId: 'x1', kind: 'move_army', armyId, targetRegionId: 'HUN-REG01' }],
      },
    });
    expect(order.statusCode).toBe(200);
    const orderBody = order.json();
    expect(orderBody.rejected).toHaveLength(1);
    expect(orderBody.rejected[0].issues[0].code).toBe('ROLE_FORBIDDEN');
    expect(orderBody.view.pendingOrders).toHaveLength(0);
  });

  it('君主可下达行军命令，结束回合推进日期', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/games',
      payload: { factionKey: 'YONG', playerRole: 'ruler', seed: 99 },
    });
    const gid = created.json().gameId;
    const state = created.json().view;
    const army = state.armies.find((a: any) => a.own && a.nodeId === 'YONG-REG01');
    const target = 'YONG-REG02';
    const order = await app.inject({
      method: 'POST',
      url: `/api/games/${gid}/orders`,
      payload: { orders: [{ orderId: 'm1', kind: 'move_army', armyId: army.armyId, targetRegionId: target }] },
    });
    expect(order.statusCode).toBe(200);
    expect(order.json().accepted).toHaveLength(1);
    const turn = await app.inject({ method: 'POST', url: `/api/games/${gid}/turn`, payload: {} });
    expect(turn.statusCode).toBe(200);
    const turnBody = turn.json();
    expect(turnBody.view.date.turn).toBe(2);
    expect(turnBody.report.events.length).toBeGreaterThan(0);
    expect(turnBody.report.chronicle.length).toBeGreaterThan(0);
  });

  it('朝议议案通过 API 提交，并在结束本回合后生成投票事件', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/games',
      payload: { factionKey: 'YONG', playerRole: 'ruler', seed: 20261029 },
    });
    expect(created.statusCode).toBe(200);
    const gid = created.json().gameId as string;
    const submit = await app.inject({
      method: 'POST',
      url: `/api/games/${gid}/orders`,
      payload: {
        orders: [{
          orderId: 'court-api-test',
          kind: 'court_debate',
          topic: 'factions',
          resolution: 'balance',
        }],
      },
    });
    expect(submit.statusCode).toBe(200);
    expect(submit.json().accepted).toHaveLength(1);

    const turn = await app.inject({ method: 'POST', url: `/api/games/${gid}/turn`, payload: {} });
    expect(turn.statusCode).toBe(200);
    const debate = turn.json().report.events.find((event: any) => event.title.startsWith('朝议·派系与朝局议案'));
    expect(debate).toBeTruthy();
    expect(debate.type).toBe('politics');
    expect(typeof debate.after.passed).toBe('boolean');
    expect(Array.isArray(debate.payload.supporters)).toBe(true);
    expect(Array.isArray(debate.payload.opponents)).toBe(true);
  });

  it('人物 API 只向玩家暴露本势力目标，不泄露敌方目标', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/games',
      payload: { factionKey: 'HUN', playerRole: 'ruler', seed: 3030 },
    });
    expect(created.statusCode).toBe(200);
    const gid = created.json().gameId as string;

    const own = await app.inject({ method: 'GET', url: `/api/characters?faction=HUN&pageSize=5&gameId=${gid}` });
    const enemy = await app.inject({ method: 'GET', url: `/api/characters?faction=YONG&pageSize=5&gameId=${gid}` });
    expect(own.statusCode).toBe(200);
    expect(enemy.statusCode).toBe(200);
    expect(own.json().items[0].goal).toBe('idle');
    expect(Object.prototype.hasOwnProperty.call(enemy.json().items[0], 'goal')).toBe(false);

    const enemyDetail = await app.inject({
      method: 'GET',
      url: `/api/characters/${enemy.json().items[0].person_id}?gameId=${gid}`,
    });
    expect(enemyDetail.statusCode).toBe(200);
    expect(Object.prototype.hasOwnProperty.call(enemyDetail.json().runtime ?? {}, 'goal')).toBe(false);
  });

  it('API 可直接向 72 节点中的附属据点下达行军命令', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/games',
      payload: { factionKey: 'HUN', playerRole: 'ruler', seed: 20261029 },
    });
    expect(created.statusCode).toBe(200);
    const gid = created.json().gameId as string;
    const view = created.json().view;
    const army = view.armies.find((a: any) => a.own && a.mapNodeId);
    expect(army).toBeTruthy();

    const mapResponse = await app.inject({ method: 'GET', url: '/api/map' });
    const child = mapResponse.json().nodes.find((node: any) => node.parent_node_id === army.mapNodeId);
    expect(child).toBeTruthy();
    const targetRegion = view.regions.find((region: any) => region.name === child.region);
    expect(targetRegion).toBeTruthy();

    const order = await app.inject({
      method: 'POST',
      url: `/api/games/${gid}/orders`,
      payload: {
        orders: [{
          orderId: 'map-node-api',
          kind: 'move_army',
          armyId: army.armyId,
          targetRegionId: targetRegion.regionId,
          targetMapNodeId: child.node_id,
        }],
      },
    });
    expect(order.statusCode).toBe(200);
    expect(order.json().accepted).toHaveLength(1);
    expect(order.json().view.pendingOrders).toHaveLength(1);
  });

  it('分兵/州兵/计谋可通过 API 下达并结算', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/games',
      payload: { factionKey: 'YONG', playerRole: 'ruler', seed: 2026 },
    });
    const body = created.json();
    const gid = body.gameId;
    const view = body.view;
    expect(view.factions.find((f: any) => f.key === 'CHU')?.atWar).toBe(true);

    const chars = await app.inject({ method: 'GET', url: '/api/characters?faction=YONG&pageSize=80' });
    const commanders = chars.json().items.filter(
      (c: any) => !view.armies.some((a: any) => a.commanderId === c.person_id),
    );
    const commander = commanders[0];
    const army = view.armies.find((a: any) => a.own);
    const target = view.regions.find((r: any) => r.owned && r.regionId !== army.nodeId);
    const split = await app.inject({
      method: 'POST',
      url: `/api/games/${gid}/orders`,
      payload: {
        orders: [{
          orderId: 'split-api',
          kind: 'move_army',
          armyId: army.armyId,
          targetRegionId: target.regionId,
          amount: 10_000,
          commanderId: commander.person_id,
        }],
      },
    });
    expect(split.statusCode).toBe(200);
    expect(split.json().accepted).toHaveLength(1);
    await app.inject({ method: 'POST', url: `/api/games/${gid}/turn`, payload: {} });
    const after = (await app.inject({ method: 'GET', url: `/api/games/${gid}` })).json();
    const det = after.view.armies.find((a: any) => a.isDetachment && a.commanderId === commander.person_id);
    expect(det).toBeTruthy();
    expect(det.troops).toBe(10_000);

    // 调遣州兵
    const garrisonRegion = after.view.regions.find((r: any) => r.owned && (r.garrison ?? 0) > 2000);
    const target2 = after.view.regions.find((r: any) => r.owned && r.regionId !== garrisonRegion.regionId);
    const beforeGarrison = garrisonRegion.garrison;
    const dispatch = await app.inject({
      method: 'POST',
      url: `/api/games/${gid}/orders`,
      payload: {
        orders: [{
          orderId: 'gar-api',
          kind: 'dispatch_garrison',
          regionId: garrisonRegion.regionId,
          targetRegionId: target2.regionId,
          amount: 2_000,
        }],
      },
    });
    expect(dispatch.json().accepted).toHaveLength(1);
    await app.inject({ method: 'POST', url: `/api/games/${gid}/turn`, payload: {} });
    const after2 = (await app.inject({ method: 'GET', url: `/api/games/${gid}` })).json();
    expect(after2.view.regions.find((r: any) => r.regionId === garrisonRegion.regionId).garrison).toBe(beforeGarrison - 2_000);

    // 计谋：君主可施伏兵
    const scheme = await app.inject({
      method: 'POST',
      url: `/api/games/${gid}/orders`,
      payload: {
        orders: [{
          orderId: 'scheme-api',
          kind: 'scheme',
          scheme: 'ambush',
          targetRegionId: target2.regionId,
        }],
      },
    });
    expect(scheme.json().accepted).toHaveLength(1);
    const turn3 = await app.inject({ method: 'POST', url: `/api/games/${gid}/turn`, payload: {} });
    const schemeEvent = turn3.json().report.events.find((e: any) => e.type === 'scheme');
    expect(schemeEvent).toBeTruthy();
    expect(schemeEvent.payload.chance).toBeGreaterThan(0);
  });

  it('存档、事件、史官与读档一致', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/games',
      payload: { factionKey: 'CHU', playerRole: 'ruler', seed: 7 },
    });
    const gid = created.json().gameId;
    await app.inject({ method: 'POST', url: `/api/games/${gid}/turn`, payload: {} });
    const save = await app.inject({ method: 'POST', url: `/api/games/${gid}/save`, payload: { label: '测试存档' } });
    expect(save.statusCode).toBe(200);
    const saveId = save.json().save.saveId;
    const events = await app.inject({ method: 'GET', url: `/api/games/${gid}/events` });
    expect(events.json().items.length).toBeGreaterThan(0);
    const chronicle = await app.inject({ method: 'GET', url: `/api/games/${gid}/chronicle` });
    expect(chronicle.json().items.length).toBeGreaterThan(0);

    await app.inject({ method: 'POST', url: `/api/games/${gid}/turn`, payload: {} });
    const loaded = await app.inject({ method: 'POST', url: `/api/games/${gid}/load/${saveId}`, payload: {} });
    expect(loaded.statusCode).toBe(200);
    expect(loaded.json().view.date.turn).toBe(2);
    expect(loaded.json().loadedSave.label).toBe('测试存档');
  });

  it('战报回放：battle 事件返回确定性分阶段脚本，非 battle 返回 400', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/games',
      payload: { factionKey: 'HUN', playerRole: 'ruler', seed: 424242 },
    });
    const gid = created.json().gameId;
    const order = await app.inject({
      method: 'POST',
      url: `/api/games/${gid}/orders`,
      payload: { orders: [{ orderId: 'rb1', kind: 'move_army', armyId: 'HUN-ARMY-02', targetRegionId: 'YONG-REG03' }] },
    });
    expect(order.statusCode).toBe(200);
    expect(order.json().accepted).toHaveLength(1);

    // 格子行军跨回合推进：连续结算直至前线遭遇，战报回放接口再针对真实 battle 事件断言。
    let events: any[] = [];
    let battle: any;
    for (let turn = 0; turn < 8 && !battle; turn++) {
      await app.inject({ method: 'POST', url: `/api/games/${gid}/turn`, payload: {} });
      events = (await app.inject({ method: 'GET', url: `/api/games/${gid}/events` })).json().items;
      battle = events.find((e: any) => e.type === 'battle');
    }
    expect(battle).toBeTruthy();

    const ok = await app.inject({ method: 'GET', url: `/api/games/${gid}/battles/${battle.eventId}/replay` });
    expect(ok.statusCode).toBe(200);
    const replay = ok.json().replay;
    expect(replay.stages.length).toBeGreaterThanOrEqual(3);
    expect(replay.stages.length).toBeLessThanOrEqual(6);
    const last = replay.stages[replay.stages.length - 1];
    expect(last.attackerTroops).toBe(battle.after.attackerRemaining);
    expect(last.defenderTroops).toBe(battle.after.defenderRemaining);

    // 同一事件两次请求结果完全一致
    const again = await app.inject({ method: 'GET', url: `/api/games/${gid}/battles/${battle.eventId}/replay` });
    expect(again.json().replay).toEqual(replay);

    const nonBattle = events.find((e: any) => e.type !== 'battle');
    const bad = await app.inject({ method: 'GET', url: `/api/games/${gid}/battles/${nonBattle.eventId}/replay` });
    expect(bad.statusCode).toBe(400);

    const missing = await app.inject({ method: 'GET', url: `/api/games/${gid}/battles/ev-none/replay` });
    expect(missing.statusCode).toBe(404);

    const noGame = await app.inject({ method: 'GET', url: `/api/games/g-none/battles/${battle.eventId}/replay` });
    expect(noGame.statusCode).toBe(404);
  });

  it('非法输入被拒绝', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/games', payload: { factionKey: 'XXX' } });
    expect(res.statusCode).toBe(400);
  });

  it('配置接口包含平衡表与身份权限说明', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/config' });
    const body = res.json();
    expect(body.balance.turnDays).toBe(7);
    expect(body.roles).toHaveLength(4);
    expect(Object.keys(body.unitProfiles)).toHaveLength(22);
  });

  it('拒绝复用 orderId，避免绕过每类命令配额', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/games',
      payload: { factionKey: 'YONG', playerRole: 'ruler', seed: 8181 },
    });
    const gid = created.json().gameId as string;
    const debate = { orderId: 'dup-debate', kind: 'court_debate', topic: 'factions', resolution: 'balance' };

    const first = await app.inject({
      method: 'POST',
      url: `/api/games/${gid}/orders`,
      payload: { orders: [debate] },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().accepted).toHaveLength(1);

    const reused = await app.inject({
      method: 'POST',
      url: `/api/games/${gid}/orders`,
      payload: { orders: [debate] },
    });
    expect(reused.statusCode).toBe(200);
    expect(reused.json().rejected[0].issues[0].code).toBe('DUPLICATE_ORDER_ID');
    expect(reused.json().view.pendingOrders).toHaveLength(1);

    const withinPayload = await app.inject({
      method: 'POST',
      url: `/api/games/${gid}/orders`,
      payload: { orders: [debate, debate] },
    });
    expect(withinPayload.statusCode).toBe(400);
  });

  it('隐藏战报不能通过猜 eventId 回放', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/games',
      payload: { factionKey: 'HUN', playerRole: 'ruler', seed: 9191 },
    });
    const gid = created.json().gameId as string;
    insertEvents(built.db, [
      {
        eventId: `hidden-battle-${gid}`,
        gameId: gid,
        turn: 1,
        dateLabel: 'test',
        type: 'battle',
        factionKey: 'YONG',
        actorName: '甲',
        targetLabel: '乙',
        title: 'NPC 间战斗',
        summary: '不可见',
        source: 'npc_ai',
        visibleToPlayer: false,
        payload: {},
      } as any,
    ]);
    const res = await app.inject({
      method: 'GET',
      url: `/api/games/${gid}/battles/hidden-battle-${gid}/replay`,
    });
    expect(res.statusCode).toBe(404);
  });

  it('管理端 NPC 意图默认关闭，显式开启后按 gameId 返回', async () => {
    const closed = await app.inject({ method: 'GET', url: '/api/admin/npc-intent' });
    expect(closed.statusCode).toBe(403);

    const previous = process.env.ALLOW_ADMIN_ENDPOINT;
    process.env.ALLOW_ADMIN_ENDPOINT = '1';
    try {
      const created = await app.inject({
        method: 'POST',
        url: '/api/games',
        payload: { factionKey: 'CHU', playerRole: 'ruler', seed: 6161 },
      });
      const gid = created.json().gameId as string;
      const opened = await app.inject({
        method: 'GET',
        url: `/api/admin/npc-intent?gameId=${gid}`,
      });
      expect(opened.statusCode).toBe(200);
      expect(Array.isArray(opened.json().items)).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.ALLOW_ADMIN_ENDPOINT;
      else process.env.ALLOW_ADMIN_ENDPOINT = previous;
    }
  });

  it('敌方生死不从人物列表与详情泄露', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/games',
      payload: { factionKey: 'HUN', playerRole: 'ruler', seed: 7171 },
    });
    const gid = created.json().gameId as string;
    const enemy = await app.inject({
      method: 'GET',
      url: `/api/characters?faction=YONG&pageSize=1&gameId=${gid}`,
    });
    const enemyId = enemy.json().items[0].person_id as string;
    const state = getGameState(built.db, gid, built.seed.characters, built.seed)!;
    state.characters[enemyId].alive = false;
    state.characters[enemyId].deathTurn = 1;
    state.characters[enemyId].deathCause = '测试';
    saveGameState(built.db, state);

    const list = await app.inject({
      method: 'GET',
      url: `/api/characters?faction=YONG&pageSize=1&gameId=${gid}`,
    });
    expect(Object.prototype.hasOwnProperty.call(list.json().items[0], 'alive')).toBe(false);

    const detail = await app.inject({
      method: 'GET',
      url: `/api/characters/${enemyId}?gameId=${gid}`,
    });
    expect(Object.prototype.hasOwnProperty.call(detail.json().runtime ?? {}, 'alive')).toBe(false);
  });

  it('存档乐观锁拒绝基于旧回合的写入', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/games',
      payload: { factionKey: 'HUN', playerRole: 'ruler', seed: 5151 },
    });
    const gid = created.json().gameId as string;
    const state = getGameState(built.db, gid, built.seed.characters, built.seed)!;
    const expected = state.date.turn;
    saveGameState(built.db, state, { expectedTurn: expected });
    state.date.turn = expected + 1;
    saveGameState(built.db, state, { expectedTurn: expected });
    expect(() => saveGameState(built.db, state, { expectedTurn: expected })).toThrow(
      StaleGameStateError,
    );
  });

  it('终局后拒绝继续下达命令或推进回合', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/games',
      payload: { factionKey: 'CHU', playerRole: 'ruler', seed: 6161 },
    });
    const gid = created.json().gameId as string;
    const state = getGameState(built.db, gid, built.seed.characters, built.seed)!;
    state.outcome = {
      status: 'defeat',
      winner: 'YONG',
      reason: '测试用终局：社稷倾覆。',
      turn: state.date.turn,
      dateLabel: state.date.label,
    };
    saveGameState(built.db, state);

    const view = await app.inject({ method: 'GET', url: `/api/games/${gid}` });
    expect(view.json().view.outcome?.status).toBe('defeat');

    const orders = await app.inject({
      method: 'POST',
      url: `/api/games/${gid}/orders`,
      payload: { orders: [] },
    });
    expect(orders.statusCode).toBe(409);
    expect(orders.json().error).toBe('GAME_OVER');

    const turn = await app.inject({ method: 'POST', url: `/api/games/${gid}/turn`, payload: {} });
    expect(turn.statusCode).toBe(409);
    expect(turn.json().error).toBe('GAME_OVER');
  });
});

describe('AI 史官本机设置（SQLite）', () => {
  const savedEnv = { provider: process.env.LLM_PROVIDER, key: process.env.LLM_API_KEY };
  let built3: BuiltApp | null = null;
  let fetcherCalls: { url: string; body: any; method?: string }[] = [];
  let polishEntryId = '';
  const fakeFetcher: LlmFetcher = async (url, init) => {
    const body = JSON.parse(init.body ?? '{}');
    fetcherCalls.push({ url, body, method: init.method });
    if (init.method === 'GET') {
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }] }),
      };
    }
    const prompt = JSON.stringify(body);
    const isProbe = prompt.includes('回复 OK');
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          {
            message: {
              content: isProbe
                ? 'OK'
                : JSON.stringify({
                    entries: [{ entryId: polishEntryId, literary: '演义体长文', inference: '史官推断' }],
                  }),
            },
          },
        ],
      }),
    };
  };

  beforeAll(async () => {
    delete process.env.LLM_PROVIDER;
    delete process.env.LLM_API_KEY;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tianming-llm-settings-'));
    built3 = await buildApp({
      dbPath: path.join(dir, 'test.db'),
      logger: false,
      serveWeb: false,
      llmFetcher: fakeFetcher,
    });
    (built3 as any).testDir = dir;
    await built3.app.ready();
  });

  afterAll(async () => {
    if (built3) {
      const dir = (built3 as any).testDir as string;
      await built3.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
    process.env.LLM_PROVIDER = savedEnv.provider;
    process.env.LLM_API_KEY = savedEnv.key;
  });

  it('本机设置可保存、掩码回传，并驱动连接测试与史官润色', async () => {
    const initial = await built3!.app.inject({ method: 'GET', url: '/api/llm/config' });
    expect(initial.statusCode).toBe(200);
    expect(initial.json().configured).toBe(false);

    const saved = await built3!.app.inject({
      method: 'PUT',
      url: '/api/llm/config',
      payload: {
        provider: 'deepseek',
        apiKey: 'secret-key-abcd',
        baseUrl: 'api.deepseek.com',
        model: 'deepseek-chat',
        timeoutMs: 15000,
        style: 'yanyi',
        autoPolish: true,
      },
    });
    expect(saved.statusCode).toBe(200);
    const status = saved.json();
    expect(status.configured).toBe(true);
    expect(status.hasKey).toBe(true);
    expect(status.keyHint).toBe('••••abcd');
    expect(status.source).toBe('settings');
    expect(status.style).toBe('yanyi');
    expect(status.autoPolish).toBe(true);
    expect(status.baseUrl).toBe('https://api.deepseek.com/v1');
    expect(JSON.stringify(status)).not.toContain('secret-key-abcd');

    const config = (await built3!.app.inject({ method: 'GET', url: '/api/config' })).json();
    expect(config.llmEnabled).toBe(true);
    expect(config.llmAutoPolish).toBe(true);
    expect(config.llmStyle).toBe('yanyi');
    expect(config.llmModel).toBe('deepseek-chat');

    const modelList = await built3!.app.inject({ method: 'POST', url: '/api/llm/models' });
    expect(modelList.statusCode).toBe(200);
    expect(modelList.json().ok).toBe(true);
    expect(modelList.json().models).toEqual(['deepseek-chat', 'deepseek-reasoner']);
    expect(fetcherCalls.some((call) => call.method === 'GET' && call.url === 'https://api.deepseek.com/v1/models')).toBe(true);

    const probe = await built3!.app.inject({ method: 'POST', url: '/api/llm/test' });
    expect(probe.statusCode).toBe(200);
    expect(probe.json().ok).toBe(true);
    const chatCall = fetcherCalls.find((call) => call.url.endsWith('/chat/completions'));
    expect(chatCall?.url).toBe('https://api.deepseek.com/v1/chat/completions');
    expect(chatCall?.body.model).toBe('deepseek-chat');

    const created = await built3!.app.inject({
      method: 'POST',
      url: '/api/games',
      payload: { factionKey: 'CHU', playerRole: 'ruler', seed: 909 },
    });
    const gid = created.json().gameId;
    await built3!.app.inject({ method: 'POST', url: `/api/games/${gid}/turn`, payload: {} });
    const chronicle = (await built3!.app.inject({ method: 'GET', url: `/api/games/${gid}/chronicle` })).json().items;
    polishEntryId = chronicle[0].entryId;
    const polished = await built3!.app.inject({
      method: 'POST',
      url: `/api/games/${gid}/chronicle/llm`,
      payload: { turn: chronicle[0].turn },
    });
    expect(polished.statusCode).toBe(200);
    expect(polished.json().updated).toBe(1);
  });

  it('显式清除本机密钥后回到未配置状态', async () => {
    const cleared = await built3!.app.inject({
      method: 'PUT',
      url: '/api/llm/config',
      payload: { clearApiKey: true },
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().configured).toBe(false);
    expect(cleared.json().hasKey).toBe(false);
  });

  it('本机端点允许免密钥，并自动补全 /v1', async () => {
    const local = await built3!.app.inject({
      method: 'PUT',
      url: '/api/llm/config',
      payload: { provider: 'ollama', baseUrl: 'http://127.0.0.1:11434', model: 'qwen2.5:7b' },
    });
    expect(local.statusCode).toBe(200);
    expect(local.json().configured).toBe(true);
    expect(local.json().hasKey).toBe(false);
    expect(local.json().baseUrl).toBe('http://127.0.0.1:11434/v1');

    const probe = await built3!.app.inject({ method: 'POST', url: '/api/llm/test' });
    expect(probe.statusCode).toBe(200);
    expect(probe.json().ok).toBe(true);
    const calls = fetcherCalls.filter((call) => call.url === 'http://127.0.0.1:11434/v1/chat/completions');
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[calls.length - 1].body.model).toBe('qwen2.5:7b');
  });

  it('对已下线端点给出可操作诊断', async () => {
    const deadFetcher: LlmFetcher = async () => ({
      ok: false,
      status: 404,
      headers: { get: (name) => (name.toLowerCase() === 'x-render-routing' ? 'no-server' : null) },
      text: async () => 'Not Found',
      json: async () => ({}),
    });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tianming-llm-dead-'));
    const deadApp = await buildApp({
      dbPath: path.join(dir, 'test.db'),
      logger: false,
      serveWeb: false,
      llmFetcher: deadFetcher,
    });
    try {
      await deadApp.app.ready();
      await deadApp.app.inject({
        method: 'PUT',
        url: '/api/llm/config',
        payload: { provider: 'proxy', apiKey: 'dead-key', baseUrl: 'https://dead.example.com/v1' },
      });
      const probe = await deadApp.app.inject({ method: 'POST', url: '/api/llm/test' });
      expect(probe.statusCode).toBe(200);
      expect(probe.json().ok).toBe(false);
      expect(probe.json().message).toContain('Render 服务不存在');
      expect(probe.json().message).toContain('Not Found');

      const models = await deadApp.app.inject({ method: 'POST', url: '/api/llm/models' });
      expect(models.statusCode).toBe(200);
      expect(models.json().ok).toBe(false);
      expect(models.json().message).toContain('获取模型失败');
    } finally {
      await deadApp.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('LLM 史官（可选 Provider）', () => {
  const savedEnv = { provider: process.env.LLM_PROVIDER, key: process.env.LLM_API_KEY };

  afterAll(() => {
    process.env.LLM_PROVIDER = savedEnv.provider;
    process.env.LLM_API_KEY = savedEnv.key;
  });

  it('无 LLM 配置时返回 LLM_DISABLED，且史官条目不变', async () => {
    delete process.env.LLM_PROVIDER;
    delete process.env.LLM_API_KEY;
    const created = await app.inject({
      method: 'POST',
      url: '/api/games',
      payload: { factionKey: 'HUN', playerRole: 'ruler', seed: 2026 },
    });
    const gid = created.json().gameId;
    await app.inject({ method: 'POST', url: `/api/games/${gid}/turn`, payload: {} });
    const before = (await app.inject({ method: 'GET', url: `/api/games/${gid}/chronicle` })).json().items;
    expect(before.length).toBeGreaterThan(0);

    const res = await app.inject({
      method: 'POST',
      url: `/api/games/${gid}/chronicle/llm`,
      payload: { turn: 1 },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('LLM_DISABLED');

    const after = (await app.inject({ method: 'GET', url: `/api/games/${gid}/chronicle` })).json().items;
    expect(after).toEqual(before);
    expect(after.every((c: any) => c.generatedBy === 'template')).toBe(true);
  });

  it('假 fetcher 成功时仅更新 literary/inference，facts 不变，generatedBy 变为 llm', async () => {
    process.env.LLM_PROVIDER = 'test-llm';
    process.env.LLM_API_KEY = 'test-key-not-real';
    const tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'tianming-llm-test-'));
    let captured: { url: string; body: any } | null = null;
    let responseEntries: { entryId: string; literary: string; inference: string }[] = [];
    const fakeFetcher: LlmFetcher = async (url, init) => {
      captured = { url, body: JSON.parse(init.body ?? '{}') };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  entries: [
                    ...responseEntries,
                    { entryId: 'chron-nonexistent', literary: '应被忽略', inference: null },
                  ],
                }),
              },
            },
          ],
        }),
      };
    };
    let built2: BuiltApp | null = null;
    try {
      built2 = await buildApp({
        dbPath: path.join(tmpDir2, 'test.db'),
        logger: false,
        serveWeb: false,
        llmFetcher: fakeFetcher,
      });
      await built2.app.ready();
      const created = await built2.app.inject({
        method: 'POST',
        url: '/api/games',
        payload: { factionKey: 'YONG', playerRole: 'ruler', seed: 55 },
      });
      const gid = created.json().gameId;
      await built2.app.inject({ method: 'POST', url: `/api/games/${gid}/turn`, payload: {} });
      const chronicle = (await built2.app.inject({ method: 'GET', url: `/api/games/${gid}/chronicle` })).json().items;
      expect(chronicle.length).toBeGreaterThan(0);
      const target = chronicle[0];
      responseEntries = [{ entryId: target.entryId, literary: '血染黄沙，鼓角声咽。', inference: '史官推断：兵事方殷。' }];

      const res = await built2.app.inject({
        method: 'POST',
        url: `/api/games/${gid}/chronicle/llm`,
        payload: { turn: target.turn },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.ok).toBe(true);
      expect(body.updated).toBe(1);

      // 只把条目事实层与事件摘要发给 LLM（不含世界状态快照）
      expect(captured!.url).toContain('/chat/completions');
      const promptText = JSON.stringify(captured!.body);
      expect(promptText).toContain(target.entryId);
      expect(promptText).toContain('facts');
      expect(promptText).not.toContain('state_json');

      const after = (await built2.app.inject({ method: 'GET', url: `/api/games/${gid}/chronicle` })).json().items;
      const polished = after.find((c: any) => c.entryId === target.entryId);
      expect(polished.literary).toBe('血染黄沙，鼓角声咽。');
      expect(polished.inference).toBe('史官推断：兵事方殷。');
      expect(polished.generatedBy).toBe('llm');
      expect(polished.facts).toBe(target.facts);
      expect(polished.title).toBe(target.title);
      expect(polished.sourceEventIds).toEqual(target.sourceEventIds);
      for (const c of after.filter((x: any) => x.entryId !== target.entryId)) {
        expect(c.generatedBy).toBe('template');
      }
    } finally {
      if (built2) await built2.close();
      fs.rmSync(tmpDir2, { recursive: true, force: true });
      delete process.env.LLM_PROVIDER;
      delete process.env.LLM_API_KEY;
    }
  });
});
