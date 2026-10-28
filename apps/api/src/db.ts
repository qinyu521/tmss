import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Node 22 内置 SQLite。通过 createRequire 加载，避免 Vite/Vitest 对 `node:sqlite`
 * 内置模块解析失败，同时保持同步 API 与零原生编译依赖（无 MSVC 环境也可运行）。
 */
const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');

type DatabaseSyncType = InstanceType<typeof DatabaseSync>;

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '../../..');
export const MIGRATIONS_DIR = path.join(ROOT, 'apps/api/migrations');
export const SEED_PATH = path.join(ROOT, 'data/source/tianming_world_roster_v0_3_1.json');

export type Db = DatabaseSyncType;

export function resolveDbPath(): string {
  const configured = process.env.TIANMING_DB ?? 'data/runtime/tianming.db';
  return path.isAbsolute(configured) ? configured : path.join(ROOT, configured);
}

export function openDatabase(dbPath = resolveDbPath()): Db {
  const dir = path.dirname(dbPath);
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 4000;');
  migrate(db);
  return db;
}

export function migrate(db: Db): void {
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const file of files) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    db.exec(sql);
  }
  db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run('schema_version', '1');
}

export function backupDatabase(db: Db, dbPath: string): string {
  const dir = path.join(path.dirname(dbPath), 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = path.join(dir, `tianming-${stamp}.db`);
  const escaped = target.replace(/'/g, "''");
  db.exec(`VACUUM INTO '${escaped}'`);
  return target;
}
