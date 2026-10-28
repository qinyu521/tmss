import { describe, expect, it } from 'vitest';
import { loadSeed, validateSeed } from './seed-validation';

const seed = loadSeed(process.cwd());
const result = validateSeed(seed);

describe('权威种子数据校验', () => {
  it('无硬性错误', () => {
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('关键表计数符合规格', () => {
    expect(result.stats.factions).toBe(3);
    expect(result.stats.historical_archetypes).toBe(100);
    expect(result.stats.characters).toBe(336);
    expect(result.stats.characters_HUN).toBe(112);
    expect(result.stats.characters_YONG).toBe(112);
    expect(result.stats.characters_CHU).toBe(112);
    expect(result.stats.map_nodes).toBe(72);
    expect(result.stats.map_edges).toBe(31);
    expect(result.stats.military_units).toBe(22);
    expect(result.stats.relationships).toBe(183);
    expect(result.stats.territories).toBe(24);
    expect(result.stats.military_districts).toBe(18);
    expect(result.stats.houses).toBe(18);
    expect(result.stats.warlord_groups).toBe(12);
    expect(result.stats.noble_titles).toBe(24);
  });

  it('三国兵力合计精确', () => {
    expect(result.stats.force_HUN).toBe(400_000);
    expect(result.stats.force_YONG).toBe(800_000);
    expect(result.stats.force_CHU).toBe(300_000);
    expect(result.stats.connected_regions).toBe(24);
  });

  it('原始种子不包含派生边', () => {
    expect(seed.map_edges.every((e: any) => e.origin !== 'derived')).toBe(true);
  });

  it('原型跨阵营冲突只报告、不修改数据', () => {
    expect(Array.isArray(result.conflicts)).toBe(true);
    expect(result.conflicts.every((c) => c.startsWith('原型规则冲突：'))).toBe(true);
    // 冲突存在时必须由报告记录，且种子未被修改
    expect(seed.characters.filter((c: any) => c.faction_key === 'HUN')).toHaveLength(112);
  });

  it('姓名没有机械化批量使用「承」字', () => {
    expect(result.stats.cheng_name_count).toBeLessThanOrEqual(12);
  });
});
