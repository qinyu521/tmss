import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp, type BuiltApp } from './app.js';
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

  it('API 接受廷议议案，并在结算后返回真实政治事件', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/games',
      payload: { factionKey: 'YONG', playerRole: 'ruler', seed: 20261028 },
    });
    expect(created.statusCode).toBe(200);
    const gid = created.json().gameId as string;
    const roster = await app.inject({
      method: 'GET',
      url: `/api/characters?faction=YONG&pageSize=8&gameId=${gid}`,
    });
    const officials = roster.json().items.filter((person: any) => person.alive !== false);
    expect(officials.length).toBeGreaterThanOrEqual(2);
    expect(typeof officials[0].courtStanding).toBe('number');
    const speakerStandingBefore = officials[0].courtStanding;
    const oppositionStandingBefore = officials[1].courtStanding;
    const order = await app.inject({
      method: 'POST',
      url: `/api/games/${gid}/orders`,
      payload: {
        orders: [{
          orderId: 'court-api',
          kind: 'hold_court',
          agenda: 'succession',
          decision: 'assertive',
          resolution: 'compromise',
          speakerPersonId: officials[0].person_id,
          oppositionPersonId: officials[1].person_id,
        }],
      },
    });
    expect(order.statusCode).toBe(200);
    expect(order.json().accepted).toHaveLength(1);
    expect(order.json().view.pendingOrders[0].kind).toBe('hold_court');

    const turn = await app.inject({ method: 'POST', url: `/api/games/${gid}/turn`, payload: {} });
    expect(turn.statusCode).toBe(200);
    const body = turn.json();
    const court = body.report.events.find((event: any) => event.type === 'politics' && event.title.includes('皇嗣与储位'));
    expect(court).toBeTruthy();
    expect(court.after.courtStability).toBeGreaterThan(0);
    expect(court.after.speakerPersonId).toBe(officials[0].person_id);
    expect(court.after.oppositionPersonId).toBe(officials[1].person_id);
    expect(court.after.resolution).toBe('compromise');
    expect(court.after.decision).toBe('balanced');
    expect(court.after.speakerStandingAfter).toBe(speakerStandingBefore + 1);
    expect(court.after.oppositionStandingAfter).toBe(oppositionStandingBefore + 1);
    expect(court.summary).toContain(officials[0].name);
    const updatedRoster = await app.inject({ method: 'GET', url: `/api/characters?faction=YONG&pageSize=8&gameId=${gid}` });
    const updatedSpeaker = updatedRoster.json().items.find((person: any) => person.person_id === officials[0].person_id);
    expect(updatedSpeaker.courtStanding).toBe(speakerStandingBefore + 1);
    expect(body.view.special.courtStability).toBeGreaterThan(0);
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
    await app.inject({ method: 'POST', url: `/api/games/${gid}/turn`, payload: {} });

    const events = (await app.inject({ method: 'GET', url: `/api/games/${gid}/events` })).json().items;
    const battle = events.find((e: any) => e.type === 'battle');
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
      captured = { url, body: JSON.parse(init.body) };
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
