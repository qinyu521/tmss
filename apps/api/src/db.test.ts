import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, withTransaction } from './db.js';

function tempDbPath(name: string): { dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `tianming-${name}-`));
  return { dir, file: path.join(dir, 'test.db') };
}

describe('数据库迁移与事务', () => {
  it('迁移只执行一次，重开数据库不会重复执行', () => {
    const { dir, file } = tempDbPath('migrate');
    try {
      const first = openDatabase(file);
      const applied = first.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as { n: number };
      expect(applied.n).toBeGreaterThan(0);
      const version = first.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as {
        value: string;
      };
      expect(Number(version.value)).toBe(applied.n);
      first.close();

      const second = openDatabase(file);
      const after = second.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as { n: number };
      expect(after.n).toBe(applied.n);
      second.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('事务内抛错时整体回滚', () => {
    const { dir, file } = tempDbPath('tx');
    try {
      const db = openDatabase(file);
      db.exec('CREATE TABLE tx_probe(x INTEGER)');
      expect(() =>
        withTransaction(db, () => {
          db.exec('INSERT INTO tx_probe VALUES (1)');
          throw new Error('boom');
        }),
      ).toThrow('boom');
      const count = db.prepare('SELECT COUNT(*) AS n FROM tx_probe').get() as { n: number };
      expect(count.n).toBe(0);
      db.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
