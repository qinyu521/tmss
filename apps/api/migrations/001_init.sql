-- 天命史书 · SQLite 初始迁移（schema v1）
-- 说明：参考数据以 JSON payload 保存，同时抽出常用查询列并建索引；
--       游戏状态按快照保存，事件与史官记录单独入库以便筛选与增量查询。

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS factions (
  key TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  payload TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS historical_archetypes (
  archetype_id TEXT PRIMARY KEY,
  historical_name TEXT NOT NULL,
  primary_faction_key TEXT,
  payload TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS characters (
  person_id TEXT PRIMARY KEY,
  faction_key TEXT NOT NULL,
  name TEXT NOT NULL,
  identity_type TEXT NOT NULL,
  region TEXT,
  house_or_clan TEXT,
  warlord_group TEXT,
  archetype_id TEXT NOT NULL,
  status TEXT,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_characters_faction ON characters(faction_key);
CREATE INDEX IF NOT EXISTS idx_characters_name ON characters(name);
CREATE INDEX IF NOT EXISTS idx_characters_house ON characters(house_or_clan);

CREATE TABLE IF NOT EXISTS appointments (
  assignment_id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL,
  faction TEXT NOT NULL,
  region_or_station TEXT,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_appointments_person ON appointments(person_id);

CREATE TABLE IF NOT EXISTS territories (
  region_id TEXT PRIMARY KEY,
  faction TEXT NOT NULL,
  region TEXT NOT NULL,
  governor_id TEXT NOT NULL,
  payload TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS military_districts (
  district_id TEXT PRIMARY KEY,
  faction TEXT NOT NULL,
  military_district TEXT NOT NULL,
  commander_id TEXT NOT NULL,
  payload TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS houses (
  house_id TEXT PRIMARY KEY,
  faction TEXT NOT NULL,
  house_name TEXT NOT NULL,
  patriarch_id TEXT NOT NULL,
  payload TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS warlord_groups (
  warlord_id TEXT PRIMARY KEY,
  faction TEXT NOT NULL,
  warlord_group TEXT NOT NULL,
  leader_id TEXT NOT NULL,
  payload TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS noble_titles (
  rank_id TEXT PRIMARY KEY,
  faction TEXT NOT NULL,
  noble_title TEXT NOT NULL,
  holder_id TEXT NOT NULL,
  payload TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS relationships (
  relationship_id INTEGER PRIMARY KEY AUTOINCREMENT,
  faction TEXT NOT NULL,
  source_person_id TEXT NOT NULL,
  target_person_id TEXT NOT NULL,
  relation TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rel_source ON relationships(source_person_id);
CREATE INDEX IF NOT EXISTS idx_rel_target ON relationships(target_person_id);

CREATE TABLE IF NOT EXISTS map_nodes (
  node_id TEXT PRIMARY KEY,
  faction TEXT NOT NULL,
  region TEXT NOT NULL,
  node_name TEXT NOT NULL,
  node_type TEXT NOT NULL,
  map_x REAL NOT NULL,
  map_y REAL NOT NULL,
  controller_id TEXT,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_nodes_region ON map_nodes(region);

CREATE TABLE IF NOT EXISTS map_edges (
  edge_id TEXT PRIMARY KEY,
  from_region TEXT NOT NULL,
  to_region TEXT NOT NULL,
  from_faction TEXT NOT NULL,
  to_faction TEXT NOT NULL,
  base_movement_cost INTEGER NOT NULL,
  origin TEXT NOT NULL DEFAULT 'source',
  payload TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS military_units (
  unit_id TEXT PRIMARY KEY,
  faction_key TEXT NOT NULL,
  unit_name TEXT NOT NULL,
  unit_type TEXT NOT NULL,
  payload TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS national_force_allocations (
  allocation_id TEXT PRIMARY KEY,
  faction_key TEXT NOT NULL,
  military_district TEXT NOT NULL,
  initial_force_count INTEGER NOT NULL,
  payload TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS games (
  game_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  seed INTEGER NOT NULL,
  faction_key TEXT NOT NULL,
  player_role TEXT NOT NULL,
  player_person_id TEXT NOT NULL,
  turn INTEGER NOT NULL,
  date_label TEXT NOT NULL,
  state_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS game_events (
  event_id TEXT PRIMARY KEY,
  game_id TEXT NOT NULL,
  turn INTEGER NOT NULL,
  date_label TEXT NOT NULL,
  type TEXT NOT NULL,
  faction_key TEXT NOT NULL,
  actor_name TEXT,
  target_label TEXT,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  source TEXT NOT NULL,
  visible INTEGER NOT NULL DEFAULT 1,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_game_turn ON game_events(game_id, turn);
CREATE INDEX IF NOT EXISTS idx_events_game_type ON game_events(game_id, type);
CREATE INDEX IF NOT EXISTS idx_events_visible ON game_events(game_id, visible);

CREATE TABLE IF NOT EXISTS chronicle_entries (
  entry_id TEXT PRIMARY KEY,
  game_id TEXT NOT NULL,
  turn INTEGER NOT NULL,
  date_label TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  facts TEXT NOT NULL,
  literary TEXT,
  inference TEXT,
  source_event_ids TEXT NOT NULL,
  generated_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chronicle_game_turn ON chronicle_entries(game_id, turn);

CREATE TABLE IF NOT EXISTS saves (
  save_id TEXT PRIMARY KEY,
  game_id TEXT NOT NULL,
  label TEXT NOT NULL,
  turn INTEGER NOT NULL,
  date_label TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  state_json TEXT NOT NULL,
  autosave INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_saves_game ON saves(game_id, created_at);

INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', '1');
