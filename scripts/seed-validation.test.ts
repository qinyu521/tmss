import { describe, expect, it } from 'vitest';
import { loadSeed, validateSeed } from './seed-validation';

const seed = loadSeed(process.cwd());
const result = validateSeed(seed);
const archetypeByName = new Map(seed.historical_archetypes.map((a: any) => [a.historical_name, a]));

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

  it('当前人物映射符合历史原型主归属与中立岗位规则', () => {
    expect(result.conflicts).toEqual([]);
    expect(result.stats.archetype_faction_conflicts).toBe(0);
  });

  it('明确核心原型保持用户指定的归属方向', () => {
    const expected: Record<string, string> = {
      '李靖': 'YONG',
      '诸葛亮': 'YONG',
      '赵奢': 'YONG',
      '曹操': 'YONG',
      '司马懿': 'YONG',
      '祖逖': 'YONG',
      '房玄龄': 'YONG',
      '杜如晦': 'YONG',
      '赵普': 'YONG',
      '包拯': 'YONG',
      '朱元璋': 'YONG',
      '徐达': 'YONG',
      '戚继光': 'YONG',
      '韩信': 'CHU',
      '周瑜': 'CHU',
      '鲁肃': 'CHU',
      '陆逊': 'CHU',
      '孟珙': 'CHU',
      '左宗棠': 'CHU',
      '木华黎': 'HUN',
      '速不台': 'HUN',
      '王猛': 'HUN',
      '慕容垂': 'HUN',
      '耶律阿保机': 'HUN',
      '耶律楚材': 'HUN',
      '拓跋珪': 'HUN',
      '完颜宗弼': 'HUN',
      '伯颜': 'HUN',
      '脱脱': 'HUN',
      '秦始皇': 'COMMON',
      '隋文帝': 'COMMON',
      '孙武': 'COMMON',
      '羊祜': 'COMMON',
      '杜预': 'COMMON',
      '郭威': 'COMMON',
      '柴荣': 'COMMON',
      '钱镠': 'COMMON',
      '王建（前蜀）': 'COMMON',
    };

    for (const [name, factionKey] of Object.entries(expected)) {
      const archetype = archetypeByName.get(name) as any;
      expect(archetype, `缺少历史原型：${name}`).toBeTruthy();
      expect(archetype.primary_faction_key, `原型归属错误：${name}`).toBe(factionKey);
    }
  });

  it('中立原型只用于在野、地方官、世家或军阀类岗位', () => {
    const byId = new Map(seed.historical_archetypes.map((a: any) => [a.archetype_id, a]));
    const allowed = /(在野|州府.*(?:主官|副官)|家主|嫡系继承人|首席谋士|总掌柜|郡县|地方官|县令|郡守|太守|门客|幕僚|军阀|藩镇)/;
    const misuse = seed.characters.filter((c: any) => {
      const archetype = byId.get(c.archetype_id) as any;
      return archetype?.primary_faction_key === 'COMMON' && !allowed.test(c.current_position_standard ?? '');
    });
    expect(misuse.map((c: any) => c.person_id)).toEqual([]);
  });

  it('姓名没有机械化批量使用「承」字', () => {
    expect(result.stats.cheng_name_count).toBeLessThanOrEqual(12);
  });
});
