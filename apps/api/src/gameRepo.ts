import type { CharacterSeed, ChronicleEntry, GameEvent, GameState, SeedRoster } from '@tianming/shared';
import { migrateState } from '@tianming/shared';
import type { Db } from './db.js';

export class StaleGameStateError extends Error {
  constructor(
    readonly gameId: string,
    readonly expectedTurn: number,
    readonly actualTurn: number | null,
  ) {
    super(
      `存档已被其他请求更新：期望回合 ${expectedTurn}，当前回合 ${actualTurn ?? '游戏不存在'}。请刷新后重试。`,
    );
    this.name = 'StaleGameStateError';
  }
}

/**
 * 保存游戏状态。传入 expectedTurn 时做乐观锁校验：
 * 只有数据库中的回合与调用方读取时一致才写入，避免并发结算互相覆盖。
 * 调用方应把“读取 → 结算 → 保存”包在 withTransaction 中。
 */
export function saveGameState(
  db: Db,
  state: GameState,
  opts: { expectedTurn?: number } = {},
): void {
  if (opts.expectedTurn !== undefined) {
    const row = db.prepare('SELECT turn FROM games WHERE game_id = ?').get(state.gameId) as
      | { turn: number }
      | undefined;
    if (!row || row.turn !== opts.expectedTurn) {
      throw new StaleGameStateError(state.gameId, opts.expectedTurn, row?.turn ?? null);
    }
  }
  db.prepare(
    `INSERT INTO games(game_id, schema_version, seed, faction_key, player_role, player_person_id, turn, date_label, state_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(game_id) DO UPDATE SET
       schema_version=excluded.schema_version,
       turn=excluded.turn,
       date_label=excluded.date_label,
       state_json=excluded.state_json,
       updated_at=excluded.updated_at`,
  ).run(
    state.gameId,
    state.schemaVersion,
    state.seed,
    state.factionKey,
    state.playerRole,
    state.playerPersonId,
    state.date.turn,
    state.date.label,
    JSON.stringify(state),
    state.createdAt,
    new Date().toISOString(),
  );
}

/** 读取游戏状态；旧版本存档在此按迁移框架补齐字段（roster 用于补人物运行时默认）。 */
export function getGameState(db: Db, gameId: string, roster?: CharacterSeed[], mapSeed?: SeedRoster): GameState | null {
  const row = db.prepare('SELECT state_json FROM games WHERE game_id = ?').get(gameId) as
    | { state_json: string }
    | undefined;
  if (!row) return null;
  return migrateState(JSON.parse(row.state_json) as GameState, roster, mapSeed);
}

export function listGames(db: Db): any[] {
  const rows = db
    .prepare('SELECT game_id, faction_key, player_role, turn, date_label, created_at, updated_at FROM games ORDER BY updated_at DESC LIMIT 50')
    .all() as any[];
  return rows;
}

export function deleteGame(db: Db, gameId: string): void {
  db.prepare('DELETE FROM game_events WHERE game_id = ?').run(gameId);
  db.prepare('DELETE FROM chronicle_entries WHERE game_id = ?').run(gameId);
  db.prepare('DELETE FROM saves WHERE game_id = ?').run(gameId);
  db.prepare('DELETE FROM games WHERE game_id = ?').run(gameId);
}

export function insertEvents(db: Db, events: GameEvent[]): void {
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO game_events(event_id, game_id, turn, date_label, type, faction_key, actor_name, target_label, title, summary, source, visible, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const now = new Date().toISOString();
  for (const e of events) {
    stmt.run(
      e.eventId,
      e.gameId,
      e.turn,
      e.dateLabel,
      e.type,
      e.factionKey,
      e.actorName,
      e.targetLabel,
      e.title,
      e.summary,
      e.source,
      e.visibleToPlayer ? 1 : 0,
      JSON.stringify(e),
      now,
    );
  }
}

export function listEvents(
  db: Db,
  gameId: string,
  opts: { type?: string; turn?: number; includeHidden?: boolean; limit?: number; beforeTurn?: number } = {},
): GameEvent[] {
  const clauses = ['game_id = ?'];
  const params: any[] = [gameId];
  if (!opts.includeHidden) clauses.push('visible = 1');
  if (opts.type) {
    clauses.push('type = ?');
    params.push(opts.type);
  }
  if (opts.turn) {
    clauses.push('turn = ?');
    params.push(opts.turn);
  }
  if (opts.beforeTurn) {
    clauses.push('turn <= ?');
    params.push(opts.beforeTurn);
  }
  params.push(Math.min(500, opts.limit ?? 200));
  const rows = db
    .prepare(`SELECT payload_json FROM game_events WHERE ${clauses.join(' AND ')} ORDER BY turn DESC, event_id DESC LIMIT ?`)
    .all(...params) as any[];
  return rows.map((r) => JSON.parse(r.payload_json) as GameEvent);
}

/** 按 ID 取单条事件（含不可见事件；战报回放等场景需要完整 payload）。 */
export function getEvent(db: Db, gameId: string, eventId: string): GameEvent | null {
  const row = db
    .prepare('SELECT payload_json FROM game_events WHERE game_id = ? AND event_id = ?')
    .get(gameId, eventId) as { payload_json: string } | undefined;
  return row ? (JSON.parse(row.payload_json) as GameEvent) : null;
}

export function insertChronicle(db: Db, entries: ChronicleEntry[]): void {
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO chronicle_entries(entry_id, game_id, turn, date_label, kind, title, facts, literary, inference, source_event_ids, generated_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const now = new Date().toISOString();
  for (const e of entries) {
    stmt.run(
      e.entryId,
      e.gameId,
      e.turn,
      e.dateLabel,
      e.kind,
      e.title,
      e.facts,
      e.literary ?? null,
      e.inference ?? null,
      JSON.stringify(e.sourceEventIds),
      e.generatedBy,
      now,
    );
  }
}

export function listChronicleForTurn(db: Db, gameId: string, turn: number): ChronicleEntry[] {
  const rows = db
    .prepare('SELECT * FROM chronicle_entries WHERE game_id = ? AND turn = ? ORDER BY entry_id')
    .all(gameId, turn) as any[];
  return rows.map((r) => ({
    entryId: r.entry_id,
    gameId: r.game_id,
    turn: r.turn,
    dateLabel: r.date_label,
    kind: r.kind,
    title: r.title,
    facts: r.facts,
    literary: r.literary ?? undefined,
    inference: r.inference ?? undefined,
    sourceEventIds: JSON.parse(r.source_event_ids),
    generatedBy: r.generated_by,
  }));
}

/**
 * 仅更新史官条目的表达层（literary/inference）并标记 generated_by='llm'。
 * facts、标题与来源事件一律不回写。
 */
export function updateChroniclePolish(
  db: Db,
  gameId: string,
  turn: number,
  updates: { entryId: string; literary?: string; inference?: string }[],
): number {
  const stmt = db.prepare(
    `UPDATE chronicle_entries SET literary = ?, inference = ?, generated_by = 'llm'
     WHERE game_id = ? AND turn = ? AND entry_id = ?`,
  );
  let updated = 0;
  for (const u of updates) {
    const res = stmt.run(u.literary ?? null, u.inference ?? null, gameId, turn, u.entryId);
    updated += Number(res.changes ?? 0);
  }
  return updated;
}

export function listChronicle(db: Db, gameId: string, limit = 100): ChronicleEntry[] {
  const rows = db
    .prepare('SELECT * FROM chronicle_entries WHERE game_id = ? ORDER BY turn DESC, entry_id DESC LIMIT ?')
    .all(gameId, limit) as any[];
  return rows.map((r) => ({
    entryId: r.entry_id,
    gameId: r.game_id,
    turn: r.turn,
    dateLabel: r.date_label,
    kind: r.kind,
    title: r.title,
    facts: r.facts,
    literary: r.literary ?? undefined,
    inference: r.inference ?? undefined,
    sourceEventIds: JSON.parse(r.source_event_ids),
    generatedBy: r.generated_by,
  }));
}

export function createSave(db: Db, state: GameState, label: string, autosave = false): any {
  const saveId = `save-${state.gameId}-${Date.now().toString(36)}`;
  db.prepare(
    `INSERT INTO saves(save_id, game_id, label, turn, date_label, schema_version, state_json, autosave, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    saveId,
    state.gameId,
    label,
    state.date.turn,
    state.date.label,
    state.schemaVersion,
    JSON.stringify(state),
    autosave ? 1 : 0,
    new Date().toISOString(),
  );
  if (autosave) {
    db.prepare(
      `DELETE FROM saves WHERE save_id IN (
         SELECT save_id FROM saves WHERE game_id = ? AND autosave = 1 ORDER BY created_at DESC LIMIT -1 OFFSET 10
       )`,
    ).run(state.gameId);
  }
  return { saveId, label, turn: state.date.turn, dateLabel: state.date.label, autosave };
}

export function listSaves(db: Db, gameId: string): any[] {
  return db
    .prepare('SELECT save_id, label, turn, date_label, autosave, created_at FROM saves WHERE game_id = ? ORDER BY created_at DESC LIMIT 30')
    .all(gameId) as any[];
}

export function getSave(db: Db, gameId: string, saveId: string): any | null {
  const row = db.prepare('SELECT * FROM saves WHERE game_id = ? AND save_id = ?').get(gameId, saveId) as any;
  if (!row) return null;
  return { ...row, state: JSON.parse(row.state_json) };
}

export function pruneAfterTurn(db: Db, gameId: string, turn: number): void {
  db.prepare('DELETE FROM game_events WHERE game_id = ? AND turn > ?').run(gameId, turn);
  db.prepare('DELETE FROM chronicle_entries WHERE game_id = ? AND turn > ?').run(gameId, turn);
}

export function referenceSummary(db: Db): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of [
    'factions',
    'historical_archetypes',
    'characters',
    'appointments',
    'territories',
    'military_districts',
    'houses',
    'warlord_groups',
    'noble_titles',
    'relationships',
    'map_nodes',
    'map_edges',
    'military_units',
    'national_force_allocations',
  ]) {
    out[t] = (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
  }
  return out;
}
