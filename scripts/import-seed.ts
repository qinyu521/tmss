import fs from 'node:fs';
import path from 'node:path';
import { loadSeed, validateSeed } from './seed-validation.js';
import { openDatabase, resolveDbPath } from '../apps/api/src/db.js';
import { referenceCounts, syncReferenceData } from '../apps/api/src/seed.js';

const seed = loadSeed(process.cwd());
const result = validateSeed(seed);
if (!result.ok) {
  console.error('种子校验失败，导入中止：');
  for (const e of result.errors) console.error(' - ' + e);
  process.exit(1);
}
if (result.conflicts.length) {
  console.warn(`原型归属冲突 ${result.conflicts.length} 条（仅报告，不修改原始数据；详见 docs/DATA_VALIDATION_REPORT.md）`);
}

const dbPath = resolveDbPath();
const db = openDatabase(dbPath);
syncReferenceData(db, seed);
const counts = referenceCounts(db);
db.close();

fs.mkdirSync(path.dirname(dbPath), { recursive: true });
console.log(`种子已导入：${dbPath}`);
for (const [k, v] of Object.entries(counts)) console.log(`  ${k}: ${v}`);
