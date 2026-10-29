import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';
import {
  BALANCE,
  FACTION_KEYS,
  FACTION_VISUALS,
  INITIAL_RESOURCES,
  PLAYER_ROLES,
  ROLE_LABEL,
  SCHEMA_VERSION,
  UNIT_PROFILES,
  applyUnitNames,
  buildBattleReplay,
  buildContext,
  buildPlayerView,
  createGame,
  generateNpcOrders,
  migrateState,
  runTurn,
  selectPlayerPerson,
  validateOrder,
  type DerivedContext,
  type FactionKey,
  type GameState,
  type Order,
  type PlayerRole,
  type SeedRoster,
} from '@tianming/shared';
import { openDatabase, resolveDbPath, ROOT, backupDatabase, type Db } from './db.js';
import { loadSeed, referenceCounts, syncReferenceData } from './seed.js';
import {
  createSave,
  deleteGame,
  getEvent,
  getGameState,
  getSave,
  insertChronicle,
  insertEvents,
  listChronicle,
  listChronicleForTurn,
  listEvents,
  listGames,
  listSaves,
  pruneAfterTurn,
  referenceSummary,
  saveGameState,
  updateChroniclePolish,
} from './gameRepo.js';
import { loadLlmConfig, polishChronicle, type LlmFetcher } from './llm.js';
import { assertSupportedDeploymentMode, resolveTrustProxy } from './security.js';

const factionEnum = z.enum(['HUN', 'YONG', 'CHU']);
const roleEnum = z.enum(['ruler', 'governor', 'general', 'strategist']);

/** 按权威原型表核验用户已确认的归属规则；避免 UI 与种子校验器各自维护不同名单。 */
function coreConflictOf(
  character: any,
  archetypes: any[],
): { conflict: boolean; expectedFaction?: string; reason?: string } {
  const archetype = archetypes.find((a) => a.historical_name === character.historical_archetype);
  if (!archetype) {
    return { conflict: true, expectedFaction: 'MISSING', reason: '人物引用的历史原型不存在' };
  }

  const expectedFaction = archetype.primary_faction_key;
  if (['HUN', 'YONG', 'CHU'].includes(expectedFaction) && character.faction_key !== expectedFaction) {
    return { conflict: true, expectedFaction, reason: '人物阵营与原型主归属不一致' };
  }

  if (expectedFaction === 'COMMON') {
    const neutralRolePattern = /(在野|州府.*(?:主官|副官)|家主|嫡系继承人|首席谋士|总掌柜|郡县|地方官|县令|郡守|太守|门客|幕僚|军阀|藩镇)/;
    if (!neutralRolePattern.test(character.current_position_standard ?? '')) {
      return {
        conflict: true,
        expectedFaction: 'COMMON',
        reason: '中立候选原型被用于非在野/地方官/世家/军阀岗位',
      };
    }
  }
  return { conflict: false };
}

const orderSchema = z.discriminatedUnion('kind', [
  z.object({
    orderId: z.string().min(1).max(80),
    kind: z.literal('move_army'),
    armyId: z.string().min(1),
    targetRegionId: z.string().min(1),
    amount: z.number().finite().optional(),
    units: z.array(z.object({ unitId: z.string().min(1), count: z.number().int().positive() })).max(5).optional(),
    commanderId: z.string().min(1).optional(),
  }),
  z.object({
    orderId: z.string().min(1).max(80),
    kind: z.literal('dispatch_garrison'),
    regionId: z.string().min(1),
    targetRegionId: z.string().min(1),
    amount: z.number().finite(),
    commanderId: z.string().min(1).optional(),
  }),
  z.object({
    orderId: z.string().min(1).max(80),
    kind: z.literal('recruit'),
    amount: z.number().finite(),
    regionId: z.string().min(1).optional(),
    commanderId: z.string().min(1).optional(),
    formNewArmy: z.boolean().optional(),
  }),
  z.object({ orderId: z.string().min(1).max(80), kind: z.literal('levy_grain'), amount: z.number().finite() }),
  z.object({ orderId: z.string().min(1).max(80), kind: z.literal('levy_tax'), amount: z.number().finite() }),
  z.object({ orderId: z.string().min(1).max(80), kind: z.literal('trade'), resource: z.enum(['salt', 'iron', 'horses', 'grain']), amount: z.number().finite() }),
  z.object({ orderId: z.string().min(1).max(80), kind: z.literal('appease_tribe'), tribeId: z.string().min(1), amount: z.number().finite() }),
  z.object({ orderId: z.string().min(1).max(80), kind: z.literal('balance_princes'), amount: z.number().finite() }),
  z.object({ orderId: z.string().min(1).max(80), kind: z.literal('negotiate_house'), houseId: z.string().min(1), amount: z.number().finite() }),
  z.object({ orderId: z.string().min(1).max(80), kind: z.literal('appoint'), personId: z.string().min(1), regionId: z.string().min(1) }),
  z.object({ orderId: z.string().min(1).max(80), kind: z.literal('rest_army'), armyId: z.string().min(1) }),
  z.object({ orderId: z.string().min(1).max(80), kind: z.literal('scout'), regionId: z.string().min(1) }),
  z.object({
    orderId: z.string().min(1).max(80),
    kind: z.literal('scheme'),
    scheme: z.enum(['fire', 'cut_supply', 'sow_discord', 'ambush', 'feint']),
    targetRegionId: z.string().min(1).optional(),
    targetArmyId: z.string().min(1).optional(),
    strategistId: z.string().min(1).optional(),
  }),
]);

const createGameSchema = z.object({
  factionKey: factionEnum,
  playerRole: roleEnum,
  seed: z.number().int().optional(),
});

const ordersBodySchema = z.object({ orders: z.array(orderSchema).min(1).max(6) });
const saveBodySchema = z.object({ label: z.string().min(1).max(60).optional() });
const chronicleLlmSchema = z.object({ turn: z.number().int().min(0).max(100_000) });

interface BuildOptions {
  dbPath?: string;
  seed?: SeedRoster;
  logger?: boolean;
  serveWeb?: boolean;
  /** 测试用：注入假的 LLM fetch 实现；生产缺省使用全局 fetch */
  llmFetcher?: LlmFetcher;
}

export interface BuiltApp {
  app: FastifyInstance;
  db: Db;
  dbPath: string;
  ctx: DerivedContext;
  seed: SeedRoster;
  close: () => Promise<void>;
}

const rateBuckets = new Map<string, number[]>();

export async function buildApp(options: BuildOptions = {}): Promise<BuiltApp> {
  assertSupportedDeploymentMode();
  const seed = options.seed ?? loadSeed();
  applyUnitNames(seed.military_units);
  const dbPath = options.dbPath ?? resolveDbPath();
  const db = openDatabase(dbPath);
  syncReferenceData(db, seed);
  const ctx = buildContext(seed);

  const app = Fastify({
    logger:
      options.logger === false
        ? false
        : {
            level: process.env.LOG_LEVEL ?? 'info',
            transport: undefined,
          },
    bodyLimit: 256 * 1024,
    trustProxy: resolveTrustProxy(),
  });

  await app.register(cors, {
    origin: (process.env.CORS_ORIGIN ?? 'http://localhost:5173,http://127.0.0.1:5173')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  });

  // 简易限速：单机部署防止误操作与脚本刷接口
  app.addHook('onRequest', async (req: FastifyRequest, reply) => {
    if (req.method !== 'POST' && req.method !== 'DELETE') return;
    const ip = req.ip ?? 'local';
    const now = Date.now();
    const bucket = (rateBuckets.get(ip) ?? []).filter((t) => now - t < 60_000);
    bucket.push(now);
    rateBuckets.set(ip, bucket);
    if (bucket.length > 120) {
      reply.code(429).send({ error: 'RATE_LIMITED', message: '请求过于频繁，请稍后再试。' });
    }
  });

  registerStatic(app, options.serveWeb ?? process.env.SERVE_WEB !== '0');

  /* ------------------------------ 基础信息 ------------------------------ */

  app.get('/api/health', async () => ({
    ok: true,
    version: '0.6.0',
    schemaVersion: SCHEMA_VERSION,
    mode: 'single-player',
    db: path.basename(dbPath),
    seedCounts: referenceCounts(db),
    llm: process.env.LLM_PROVIDER ? 'configured（可选）' : 'disabled（本地模板史官）',
  }));

  app.get('/api/config', async () => ({
    balance: BALANCE,
    factions: FACTION_VISUALS,
    roles: PLAYER_ROLES,
    unitProfiles: UNIT_PROFILES,
    initialResources: INITIAL_RESOURCES,
    turnDays: BALANCE.turnDays,
    schemaVersion: SCHEMA_VERSION,
    singlePlayer: true,
    llmEnabled: Boolean(process.env.LLM_PROVIDER && process.env.LLM_API_KEY),
  }));

  app.get('/api/map', async () => {
    const nodes = db.prepare('SELECT payload FROM map_nodes ORDER BY node_id').all() as any[];
    const edges = db.prepare('SELECT payload FROM map_edges ORDER BY edge_id').all() as any[];
    const territoriesRows = db.prepare('SELECT payload FROM territories ORDER BY region_id').all() as any[];
    const derived = readDerivedMap();
    return {
      nodes: nodes.map((r) => JSON.parse(r.payload)),
      edges: [...edges.map((r) => JSON.parse(r.payload)), ...derived.edges],
      derivedNote: derived.note,
      territories: territoriesRows.map((r) => JSON.parse(r.payload)),
      factions: FACTION_VISUALS,
    };
  });

  app.get('/api/factions', async () => {
    const rows = db.prepare('SELECT payload FROM factions ORDER BY key').all() as any[];
    return rows.map((r) => JSON.parse(r.payload));
  });

  app.get('/api/factions/:key', async (req, reply) => {
    const key = factionEnum.safeParse((req.params as any).key);
    if (!key.success) return reply.code(400).send({ error: 'BAD_FACTION', message: '阵营不存在。' });
    const factionRow = db.prepare('SELECT payload FROM factions WHERE key = ?').get(key.data) as any;
    if (!factionRow) return reply.code(404).send({ error: 'NOT_FOUND', message: '阵营不存在。' });
    const name = JSON.parse(factionRow.payload).name;
    const pick = (sql: string) => (db.prepare(sql).all(name) as any[]).map((r) => JSON.parse(r.payload));
    return {
      faction: JSON.parse(factionRow.payload),
      territories: pick('SELECT payload FROM territories WHERE faction = ? ORDER BY region_id'),
      districts: pick('SELECT payload FROM military_districts WHERE faction = ? ORDER BY district_id'),
      houses: pick('SELECT payload FROM houses WHERE faction = ? ORDER BY house_id'),
      warlords: pick('SELECT payload FROM warlord_groups WHERE faction = ? ORDER BY warlord_id'),
      titles: pick('SELECT payload FROM noble_titles WHERE faction = ? ORDER BY rank_id'),
      units: (db.prepare('SELECT payload FROM military_units WHERE faction_key = ?').all(key.data) as any[]).map(
        (r) => JSON.parse(r.payload),
      ),
      allocations: (db
        .prepare('SELECT payload FROM national_force_allocations WHERE faction_key = ? ORDER BY allocation_id')
        .all(key.data) as any[]).map((r) => JSON.parse(r.payload)),
      traits: descriptiveTraits(key.data),
    };
  });

  app.get('/api/characters', async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const page = Math.max(1, Number(q.page ?? 1));
    const pageSize = Math.min(80, Math.max(1, Number(q.pageSize ?? 40)));
    const clauses: string[] = [];
    const params: any[] = [];
    if (q.faction && FACTION_KEYS.includes(q.faction as FactionKey)) {
      clauses.push('faction_key = ?');
      params.push(q.faction);
    }
    if (q.q) {
      clauses.push('(name LIKE ? OR identity_type LIKE ? OR current_position_standard LIKE ? OR payload LIKE ?)');
      const like = `%${q.q}%`;
      params.push(like, like, like, like);
    }
    if (q.region) {
      clauses.push('region = ?');
      params.push(q.region);
    }
    if (q.house) {
      clauses.push('house_or_clan = ?');
      params.push(q.house);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const total = (db.prepare(`SELECT COUNT(*) AS n FROM characters ${where}`).get(...params) as { n: number }).n;
    const rows = db
      .prepare(`SELECT payload FROM characters ${where} ORDER BY faction_key, person_id LIMIT ? OFFSET ?`)
      .all(...params, pageSize, (page - 1) * pageSize) as any[];
    // 携带 gameId 时合并该局人物运行时状态（生死/死因）；人物档案本就公开属性，生死讣闻同理公开
    const runtimeMap = q.gameId ? (getGameState(db, q.gameId, seed.characters, seed)?.characters ?? null) : null;
    return {
      total,
      page,
      pageSize,
      items: rows.map((r) => {
        const item = summariseCharacter(JSON.parse(r.payload));
        const rt = runtimeMap?.[item.person_id];
        return rt ? { ...item, alive: rt.alive, deathCause: rt.deathCause } : item;
      }),
    };
  });

  app.get('/api/characters/:id', async (req, reply) => {
    const id = String((req.params as any).id);
    const row = db.prepare('SELECT payload FROM characters WHERE person_id = ?').get(id) as any;
    if (!row) return reply.code(404).send({ error: 'NOT_FOUND', message: '人物不存在。' });
    const character = JSON.parse(row.payload);
    const appointment = (db.prepare('SELECT payload FROM appointments WHERE person_id = ?').get(id) as any)?.payload;
    const archetype = (db.prepare('SELECT payload FROM historical_archetypes WHERE archetype_id = ?').get(character.archetype_id) as any)?.payload;
    const rels = db
      .prepare('SELECT payload FROM relationships WHERE source_person_id = ? OR target_person_id = ?')
      .all(id, id) as any[];
    const house = (db
      .prepare(
        "SELECT payload FROM houses WHERE json_extract(payload,'$.patriarch_id') = ? OR json_extract(payload,'$.heir_id') = ? OR json_extract(payload,'$.chief_adviser_id') = ?",
      )
      .get(id, id, id) as any)?.payload;
    const warlord = (db
      .prepare(
        "SELECT payload FROM warlord_groups WHERE json_extract(payload,'$.leader_id') = ? OR json_extract(payload,'$.deputy_id') = ? OR json_extract(payload,'$.chief_strategist_id') = ?",
      )
      .get(id, id, id) as any)?.payload;
    const title = (db.prepare('SELECT payload FROM noble_titles WHERE holder_id = ?').get(id) as any)?.payload;
    const territory = (db
      .prepare(
        "SELECT payload FROM territories WHERE json_extract(payload,'$.governor_id') = ? OR json_extract(payload,'$.deputy_id') = ? OR json_extract(payload,'$.local_commander_id') = ?",
      )
      .get(id, id, id) as any)?.payload;
    const audit = (seed.prototype_affinity_audit ?? []).find((a: any) => a.person_id === id);
    const relationships = rels.map((r) => JSON.parse(r.payload));
    // 携带 gameId 时返回该局运行时状态（存活/死因/成长/有效属性），否则保持纯静态档案
    const gameId = (req.query as Record<string, string | undefined>).gameId;
    const runtime = gameId ? (getGameState(db, gameId, seed.characters, seed)?.characters?.[id] ?? null) : null;
    return {
      character,
      runtime,
      coreConflict: coreConflictOf(character, seed.historical_archetypes),
      appointment: appointment ? JSON.parse(appointment) : null,
      archetype: archetype ? JSON.parse(archetype) : null,
      audit: audit ?? null,
      relationships,
      outgoing: relationships.filter((r: any) => r.source_person_id === id),
      incoming: relationships.filter((r: any) => r.target_person_id === id),
      house: house ? JSON.parse(house) : null,
      warlord: warlord ? JSON.parse(warlord) : null,
      title: title ? JSON.parse(title) : null,
      territory: territory ? JSON.parse(territory) : null,
    };
  });

  app.get('/api/units', async () => {
    const units = (db.prepare('SELECT payload FROM military_units ORDER BY faction_key, unit_id').all() as any[]).map(
      (r) => JSON.parse(r.payload),
    );
    return units.map((u: any) => ({
      seed: u,
      profile: UNIT_PROFILES[u.unit_id] ?? null,
      icon: `/assets/units/${u.unit_id}.svg`,
    }));
  });

  app.get('/api/archetypes', async () => {
    return (db.prepare('SELECT payload FROM historical_archetypes ORDER BY archetype_id').all() as any[]).map((r) =>
      JSON.parse(r.payload),
    );
  });

  app.get('/api/audit', async () => {
    const audit = (seed.prototype_affinity_audit ?? []) as any[];
    const validStatuses = new Set([
      '主归属一致',
      '中立原型用于在野/地方/世家岗位，符合归属规则',
    ]);
    const mismatches = audit.filter((a) => !validStatuses.has(a.match_status));
    const coreConflicts = seed.characters
      .map((c) => ({ character: c, result: coreConflictOf(c, seed.historical_archetypes) }))
      .filter((entry) => entry.result.conflict)
      .map(({ character: c, result }) => ({
        person_id: c.person_id,
        name: c.name,
        faction_key: c.faction_key,
        historical_archetype: c.historical_archetype,
        expectedFaction: result.expectedFaction,
        reason: result.reason,
      }));
    return {
      total: audit.length,
      consistent: audit.length - mismatches.length,
      mismatches,
      coreConflicts,
      note: '审计按历史原型主归属与中立候选岗位规则核验；合法中立角色不计为冲突。',
    };
  });

  /* -------------------------------- 游戏 -------------------------------- */

  app.get('/api/games', async () => ({ items: listGames(db) }));

  app.post('/api/games', async (req, reply) => {
    const parsed = createGameSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: parsed.error.issues.map((i) => i.message).join(';') });
    }
    const gameId = `g-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
    const state = createGame(seed, {
      gameId,
      factionKey: parsed.data.factionKey as FactionKey,
      playerRole: parsed.data.playerRole as PlayerRole,
      seed: parsed.data.seed,
    });
    saveGameState(db, state);
    createSave(db, state, '开局存档', true);
    const persona = selectPlayerPerson(ctx, state.factionKey, state.playerRole);
    return {
      gameId,
      view: buildPlayerView(state, ctx),
      persona,
      usage: {
        note: '单机/个人部署模式，无登录鉴权；请勿直接暴露到公网而不做网关保护。',
        turnDays: BALANCE.turnDays,
      },
    };
  });

  app.get('/api/games/:id', async (req, reply) => {
    const state = getGameState(db, String((req.params as any).id), seed.characters, seed);
    if (!state) return reply.code(404).send({ error: 'NOT_FOUND', message: '存档/游戏不存在。' });
    return {
      view: buildPlayerView(state, ctx),
      events: listEvents(db, state.gameId, { limit: 200 }),
      chronicle: listChronicle(db, state.gameId, 60),
      saves: listSaves(db, state.gameId),
    };
  });

  app.delete('/api/games/:id', async (req) => {
    deleteGame(db, String((req.params as any).id));
    return { ok: true };
  });

  app.post('/api/games/:id/orders', async (req, reply) => {
    const state = getGameState(db, String((req.params as any).id), seed.characters, seed);
    if (!state) return reply.code(404).send({ error: 'NOT_FOUND', message: '游戏不存在。' });
    const parsed = ordersBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: parsed.error.issues.map((i) => i.message).join(';') });
    }
    const working = [...state.pendingOrders];
    if (working.length >= 6) {
      return reply.code(400).send({ error: 'TOO_MANY_ORDERS', message: '一回合最多提交 6 条命令。' });
    }
    const accepted: { order: Order; preview?: string }[] = [];
    const rejected: { orderId: string; issues: any[] }[] = [];
    for (const raw of parsed.data.orders) {
      const order = raw as Order;
      const candidateState: GameState = { ...state, pendingOrders: working };
      const check = validateOrder(candidateState, ctx, order);
      if (check.ok) {
        if (working.length >= 6) {
          rejected.push({ orderId: order.orderId, issues: [{ code: 'TOO_MANY_ORDERS', message: '一回合最多 6 条命令。' }] });
          continue;
        }
        working.push(order);
        accepted.push({ order, preview: check.preview });
      } else {
        rejected.push({ orderId: order.orderId, issues: check.issues });
      }
    }
    state.pendingOrders = working;
    saveGameState(db, state);
    return { accepted, rejected, view: buildPlayerView(state, ctx) };
  });

  app.delete('/api/games/:id/orders/:orderId', async (req, reply) => {
    const state = getGameState(db, String((req.params as any).id), seed.characters, seed);
    if (!state) return reply.code(404).send({ error: 'NOT_FOUND', message: '游戏不存在。' });
    const orderId = String((req.params as any).orderId);
    state.pendingOrders = state.pendingOrders.filter((o) => o.orderId !== orderId);
    saveGameState(db, state);
    return { ok: true, view: buildPlayerView(state, ctx) };
  });

  app.post('/api/games/:id/turn', async (req, reply) => {
    const state = getGameState(db, String((req.params as any).id), seed.characters, seed);
    if (!state) return reply.code(404).send({ error: 'NOT_FOUND', message: '游戏不存在。' });
    const result = runTurn(state, ctx);
    saveGameState(db, result.state);
    insertEvents(db, result.report.events);
    insertChronicle(db, result.report.chronicle);
    createSave(db, result.state, `${result.state.date.label} 自动存档`, true);
    return {
      view: buildPlayerView(result.state, ctx),
      report: {
        ...result.report,
        events: result.report.events.filter((e) => e.visibleToPlayer || e.factionKey === result.state.factionKey),
      },
      rejected: result.rejected,
    };
  });

  app.get('/api/games/:id/events', async (req, reply) => {
    const gameId = String((req.params as any).id);
    if (!getGameState(db, gameId, seed.characters, seed)) return reply.code(404).send({ error: 'NOT_FOUND', message: '游戏不存在。' });
    const q = req.query as Record<string, string | undefined>;
    return {
      items: listEvents(db, gameId, {
        type: q.type,
        turn: q.turn ? Number(q.turn) : undefined,
        limit: q.limit ? Number(q.limit) : 300,
      }),
    };
  });

  // 战报回放：交战双方数据属战报公开内容，直接返回确定性展开的分阶段脚本
  app.get('/api/games/:id/battles/:eventId/replay', async (req, reply) => {
    const gameId = String((req.params as any).id);
    if (!getGameState(db, gameId, seed.characters, seed)) return reply.code(404).send({ error: 'NOT_FOUND', message: '游戏不存在。' });
    const eventId = String((req.params as any).eventId);
    const event = getEvent(db, gameId, eventId);
    if (!event) return reply.code(404).send({ error: 'NOT_FOUND', message: '事件不存在。' });
    if (event.type !== 'battle') {
      return reply.code(400).send({ error: 'NOT_BATTLE', message: '该事件不是战斗，无法生成战报回放。' });
    }
    return { replay: buildBattleReplay(event) };
  });

  app.get('/api/games/:id/chronicle', async (req, reply) => {
    const gameId = String((req.params as any).id);
    if (!getGameState(db, gameId, seed.characters, seed)) return reply.code(404).send({ error: 'NOT_FOUND', message: '游戏不存在。' });
    return { items: listChronicle(db, gameId, 200) };
  });

  // 可选 LLM 史官：只读本旬条目的事实层与事件摘要，仅回写 literary/inference 表达层
  app.post('/api/games/:id/chronicle/llm', async (req, reply) => {
    const gameId = String((req.params as any).id);
    if (!getGameState(db, gameId, seed.characters, seed)) return reply.code(404).send({ error: 'NOT_FOUND', message: '游戏不存在。' });
    const parsed = chronicleLlmSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: parsed.error.issues.map((i) => i.message).join(';') });
    }
    const config = loadLlmConfig();
    if (!config) {
      return reply.code(503).send({ error: 'LLM_DISABLED', message: '未配置 LLM_PROVIDER/LLM_API_KEY，史官仍为本地模板。' });
    }
    const turn = parsed.data.turn;
    const entries = listChronicleForTurn(db, gameId, turn);
    if (entries.length === 0) {
      return reply.code(404).send({ error: 'NO_CHRONICLE', message: '该回合尚无史官条目，请先完成回合结算。' });
    }
    const events = listEvents(db, gameId, { turn, includeHidden: false });
    const result = await polishChronicle(entries, events, { config, fetcher: options.llmFetcher });
    if (!result.ok) {
      return reply.code(502).send({ error: result.code, message: result.message });
    }
    const updated = updateChroniclePolish(db, gameId, turn, result.entries);
    return { ok: true, turn, updated, items: listChronicleForTurn(db, gameId, turn) };
  });

  app.post('/api/games/:id/save', async (req, reply) => {
    const state = getGameState(db, String((req.params as any).id), seed.characters, seed);
    if (!state) return reply.code(404).send({ error: 'NOT_FOUND', message: '游戏不存在。' });
    const parsed = saveBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'BAD_REQUEST', message: '存档名不合法。' });
    const save = createSave(db, state, parsed.data.label ?? `${state.date.label} 手动存档`);
    return { save, items: listSaves(db, state.gameId) };
  });

  app.get('/api/games/:id/saves', async (req, reply) => {
    const gameId = String((req.params as any).id);
    if (!getGameState(db, gameId, seed.characters, seed)) return reply.code(404).send({ error: 'NOT_FOUND', message: '游戏不存在。' });
    return { items: listSaves(db, gameId) };
  });

  app.post('/api/games/:id/load/:saveId', async (req, reply) => {
    const gameId = String((req.params as any).id);
    const saveId = String((req.params as any).saveId);
    const save = getSave(db, gameId, saveId);
    if (!save) return reply.code(404).send({ error: 'NOT_FOUND', message: '存档不存在。' });
    const state = migrateState(save.state as GameState, seed.characters, seed);
    saveGameState(db, state);
    pruneAfterTurn(db, gameId, state.date.turn);
    return {
      view: buildPlayerView(state, ctx),
      events: listEvents(db, gameId, { limit: 200 }),
      chronicle: listChronicle(db, gameId, 60),
      loadedSave: { saveId, label: save.label, turn: save.turn, dateLabel: save.date_label },
    };
  });

  app.post('/api/admin/backup', async (_req, reply) => {
    if (process.env.ALLOW_BACKUP_ENDPOINT !== '1') {
      return reply.code(403).send({ error: 'DISABLED', message: '备份接口默认关闭；请在服务器直接执行备份命令。' });
    }
    const file = backupDatabase(db, dbPath);
    return { ok: true, file };
  });

  app.get('/api/admin/npc-intent', async () => {
    const games = listGames(db).slice(0, 5);
    const state = games[0] ? getGameState(db, games[0].game_id, seed.characters, seed) : null;
    if (!state) return { items: [] };
    return { items: generateNpcOrders(state, ctx).map((o) => ({ kind: o.kind, orderId: o.orderId })) };
  });

  // 统一错误处理：不泄露内部堆栈
  app.setErrorHandler((error, _req, reply) => {
    app.log.error({ err: error }, 'api error');
    if (process.env.DEBUG_API === '1') console.error(error);
    reply.code(500).send({ error: 'INTERNAL', message: '服务器结算异常，已记录日志。' });
  });

  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) {
      return reply.code(404).send({ error: 'NOT_FOUND', message: '接口不存在。' });
    }
    const dist = path.join(ROOT, 'apps/web/dist/index.html');
    if (fs.existsSync(dist)) {
      return reply.type('text/html').send(fs.readFileSync(dist, 'utf8'));
    }
    return reply.code(404).send({ error: 'NOT_FOUND', message: '前端尚未构建：请先运行 npm run build。' });
  });

  return {
    app,
    db,
    dbPath,
    ctx,
    seed,
    close: async () => {
      await app.close();
      db.close();
    },
  };
}

function summariseCharacter(c: any) {
  return {
    person_id: c.person_id,
    faction_key: c.faction_key,
    name: c.name,
    gender: c.gender,
    age_band: c.age_band,
    identity_type: c.identity_type,
    current_position_standard: c.current_position_standard,
    region: c.region,
    house_or_clan: c.house_or_clan,
    warlord_group: c.warlord_group,
    historical_archetype: c.historical_archetype,
    archetype_trait: c.archetype_trait,
    governance: c.governance,
    command: c.command,
    strategy: c.strategy,
    intrigue: c.intrigue,
    commerce: c.commerce,
    loyalty: c.loyalty,
    status: c.status,
    portrait: `/assets/portraits/${c.person_id}.svg`,
  };
}

function descriptiveTraits(key: FactionKey) {
  if (key === 'HUN') {
    return {
      identity: '架空北庭部落联盟',
      strengths: ['骑兵与骑射', '侦察与迂回', '快速集结'],
      constraints: ['缺粮', '缺盐', '铁料受限', '联盟协调度决定可调动兵力'],
      system: 'tribal-cohesion',
    };
  }
  if (key === 'YONG') {
    return {
      identity: '中央官僚帝国',
      strengths: ['人口与粮食', '步兵与军械', '屯田与多战区轮换'],
      constraints: ['缺盐', '缺优质战马', '皇子争储牵制行政效率'],
      system: 'prince-succession',
    };
  }
  return {
    identity: '富庶江左的江河政权',
    strengths: ['钱粮盐充足', '弓弩与水陆协同', '河网运输与商贸'],
    constraints: ['缺战马', '缺铁', '世家掣肘税赋与征兵'],
    system: 'house-bargaining',
  };
}

function readDerivedMap(): { edges: any[]; note: string } {
  const file = path.join(ROOT, 'data/derived/map_extra.json');
  if (!fs.existsSync(file)) return { edges: [], note: '无派生地图数据文件。' };
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { edges: data.edges ?? [], note: data.note ?? '' };
  } catch {
    return { edges: [], note: '派生地图数据解析失败，已忽略。' };
  }
}

function registerStatic(app: FastifyInstance, serveWeb: boolean): void {
  const assetsDir = path.join(ROOT, 'apps/web/public/assets');
  if (fs.existsSync(assetsDir)) {
    app.register(fastifyStatic, {
      root: assetsDir,
      prefix: '/assets/',
      decorateReply: false,
      maxAge: '7d',
    });
  }
  const distDir = path.join(ROOT, 'apps/web/dist');
  if (serveWeb && fs.existsSync(distDir)) {
    app.register(fastifyStatic, {
      root: distDir,
      prefix: '/',
      decorateReply: false,
      wildcard: false,
    });
  }
}
