import { loadSeed, validateSeed, writeReport } from './seed-validation.js';

const seed = loadSeed(process.cwd());
const result = validateSeed(seed);
const reportPath = writeReport(result);

console.log('天命史书 · 种子数据校验');
console.log(`硬性错误：${result.errors.length}，警告：${result.warnings.length}，原型冲突：${result.conflicts.length}`);
for (const [k, v] of Object.entries(result.stats)) console.log(`  ${k}: ${v}`);
if (result.errors.length) {
  console.error('\n错误：');
  for (const e of result.errors) console.error('  - ' + e);
}
if (result.conflicts.length) {
  console.warn('\n原型冲突（只报告，不覆盖）：');
  for (const c of result.conflicts) console.warn('  - ' + c);
}
if (result.warnings.length) {
  console.warn(`\n警告 ${result.warnings.length} 条（详见 ${reportPath}）`);
}
console.log(`\n报告已写入 ${reportPath}`);
process.exit(result.ok ? 0 : 1);
