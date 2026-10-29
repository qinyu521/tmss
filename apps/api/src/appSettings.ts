import type { Db } from './db.js';

export function getAppSetting(db: Db, key: string): string | null {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setAppSetting(db: Db, key: string, value: string): void {
  db.prepare(
    `INSERT INTO app_settings(key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, new Date().toISOString());
}

export function deleteAppSetting(db: Db, key: string): void {
  db.prepare('DELETE FROM app_settings WHERE key = ?').run(key);
}
