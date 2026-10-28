import fs from 'node:fs';
import path from 'node:path';

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  conflicts: string[];
  stats: Record<string, number>;
}

const EXPECTED = {
  factions: 3,
  historical_archetypes: 100,
  characters: 336,
  appointments: 336,
  territories: 24,
  military_districts: 18,
  houses: 18,
  warlord_groups: 12,
  noble_titles: 24,
  relationships: 183,
  map_nodes: 72,
  map_edges: 31,
  military_units: 22,
  national_force_allocations: 18,
};

const EXPECTED_FORCE: Record<string, number> = { HUN: 400_000, YONG: 800_000, CHU: 300_000 };
const EXPECTED_UNIT_NAMES: Record<string, string[]> = {
  HUN: ['铁浮屠', '西夏铁鹞子', '蒙古怯薛军', '辽国铁林军', '清朝索伦兵'],
  CHU: ['无当飞军', '锦帆贼', '白马义从', '神臂弓手', '先登死士', '魏武卒', '陷阵营', '北府兵', '白袍军'],
  YONG: ['背嵬军', '虎豹骑', '白毦兵', '玄甲军', '虎贲军', '西凉铁骑', '戚家军', '羽林骑'],
};
/**
 * 经用户最新规则确认的核心原型归属。
 * 注意：杜预、羊祜等晋代原型在本版明确标为 COMMON 候选，允许用于在野、
 * 州府地方官与世家人物；不能再用旧规则强制要求所有相关角色都属于大楚。
 * 朱元璋、朱棣、张居正、徐达、戚继光等明代原型归大雍；
 * 汉、宋原型通常归大楚，赵普、包拯等用户先前明确指定的大雍核心原型保留为例外。
 */
const CORE_ARCHETYPE_OVERRIDES: Record<string, string[]> = {
  YONG: [
    '李靖', '诸葛亮', '赵奢', '李勣', '曹操', '司马懿', '祖逖',
    '房玄龄', '杜如晦', '赵普', '包拯',
    '朱元璋', '朱棣', '张居正', '徐达', '戚继光', '魏忠贤',
  ],
  CHU: [
    '韩信', '陆逊', '周瑜', '鲁肃', '谢安', '孟珙', '左宗棠',
    '刘邦', '汉文帝', '汉武帝', '刘秀', '刘备', '孙权',
    '萧何', '张良', '陈平', '贾谊', '桑弘羊',
    '赵匡胤', '王安石', '岳飞', '韩世忠', '秦桧', '蔡京', '童贯', '高俅',
  ],
  HUN: [
    '木华黎', '速不台', '王猛', '慕容垂', '耶律阿保机', '耶律楚材',
    '拓跋珪', '完颜宗弼', '伯颜', '脱脱', '刘渊', '石勒', '苻坚',
    '完颜阿骨打', '成吉思汗', '忽必烈', '努尔哈赤', '皇太极',
    '和珅', '多尔衮', '鳌拜', '耶律德光', '萧绰', '李克用',
    '李存勖', '石敬瑭', '刘知远', '安禄山', '史思明',
  ],
};

export function loadSeed(root = process.cwd()): any {
  const p = path.join(root, 'data/source/tianming_world_roster_v0_3_1.json');
  if (!fs.existsSync(p)) throw new Error(`缺少权威种子数据：${p}`);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

export function validateSeed(seed: any): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const conflicts: string[] = [];
  const stats: Record<string, number> = {};

  for (const [table, count] of Object.entries(EXPECTED)) {
    const actual = Array.isArray(seed[table]) ? seed[table].length : -1;
    stats[table] = actual;
    if (actual !== count) errors.push(`表 ${table} 记录数为 ${actual}，期望 ${count}`);
  }

  const dupCheck = (table: string, key: string) => {
    const seen = new Set<string>();
    for (const row of seed[table] ?? []) {
      const v = row[key];
      if (!v) {
        errors.push(`${table} 存在空 ${key}`);
        continue;
      }
      if (seen.has(v)) errors.push(`${table} 主键重复：${v}`);
      seen.add(v);
    }
  };
  dupCheck('characters', 'person_id');
  dupCheck('map_nodes', 'node_id');
  dupCheck('map_edges', 'edge_id');
  dupCheck('military_units', 'unit_id');
  dupCheck('territories', 'region_id');
  dupCheck('military_districts', 'district_id');
  dupCheck('houses', 'house_id');
  dupCheck('warlord_groups', 'warlord_id');
  dupCheck('noble_titles', 'rank_id');
  dupCheck('appointments', 'assignment_id');
  dupCheck('historical_archetypes', 'archetype_id');
  dupCheck('national_force_allocations', 'allocation_id');

  const persons = new Set(seed.characters.map((c: any) => c.person_id));
  const archetypes = new Set(seed.historical_archetypes.map((a: any) => a.archetype_id));
  const regions = new Set(seed.territories.map((t: any) => t.region));
  const nodeNames = new Set(seed.map_nodes.map((n: any) => n.node_name));

  for (const k of ['HUN', 'YONG', 'CHU']) {
    const chars = seed.characters.filter((c: any) => c.faction_key === k);
    stats[`characters_${k}`] = chars.length;
    if (chars.length !== 112) errors.push(`${k} 原创人物数为 ${chars.length}，期望 112`);
  }

  for (const c of seed.characters) {
    if (!archetypes.has(c.archetype_id)) errors.push(`人物 ${c.person_id} 的原型 ${c.archetype_id} 不存在`);
    if (c.house_or_clan && c.house_or_clan !== '宗室' && c.faction_key && !seed.houses.some((h: any) => h.faction === c.faction && h.house_name === c.house_or_clan)) {
      warnings.push(`人物 ${c.person_id} 的世家 ${c.house_or_clan} 未在 houses 表中找到同名记录`);
    }
  }

  for (const r of seed.relationships) {
    if (!persons.has(r.source_person_id)) errors.push(`关系 ${r.source_person_id}→${r.target_person_id} 源人物不存在`);
    if (!persons.has(r.target_person_id)) errors.push(`关系 ${r.source_person_id}→${r.target_person_id} 目标人物不存在`);
  }
  for (const a of seed.appointments) {
    if (!persons.has(a.person_id)) errors.push(`任命 ${a.assignment_id} 引用不存在的人物 ${a.person_id}`);
    const c = seed.characters.find((x: any) => x.person_id === a.person_id);
    if (c && c.faction !== a.faction) errors.push(`任命 ${a.assignment_id} 的势力与人物 ${a.person_id} 不一致`);
  }
  for (const n of seed.map_nodes) {
    if (n.controller_id && !persons.has(n.controller_id)) errors.push(`地图节点 ${n.node_id} 控制者 ${n.controller_id} 不存在`);
    if (n.local_military_id && !persons.has(n.local_military_id)) errors.push(`地图节点 ${n.node_id} 驻将 ${n.local_military_id} 不存在`);
    if (!regions.has(n.region)) errors.push(`地图节点 ${n.node_id} 的州府 ${n.region} 不在 territories 中`);
  }
  for (const t of seed.territories) {
    for (const key of ['governor_id', 'deputy_id', 'local_commander_id']) {
      if (!persons.has(t[key])) errors.push(`州府 ${t.region_id} 的 ${key}=${t[key]} 不存在`);
    }
  }
  for (const d of seed.military_districts) {
    for (const key of ['commander_id', 'deputy_id']) {
      if (!persons.has(d[key])) errors.push(`军区 ${d.district_id} 的 ${key} 不存在`);
    }
  }
  for (const h of seed.houses) {
    for (const key of ['patriarch_id', 'heir_id', 'chief_adviser_id']) {
      if (!persons.has(h[key])) errors.push(`世家 ${h.house_id} 的 ${key} 不存在`);
    }
  }
  for (const w of seed.warlord_groups) {
    for (const key of ['leader_id', 'deputy_id', 'chief_strategist_id']) {
      if (!persons.has(w[key])) errors.push(`军阀 ${w.warlord_id} 的 ${key} 不存在`);
    }
  }
  for (const t of seed.noble_titles) {
    if (!persons.has(t.holder_id)) errors.push(`爵位 ${t.rank_id} 持有者 ${t.holder_id} 不存在`);
  }

  for (const e of seed.map_edges) {
    if (!regions.has(e.from_region)) errors.push(`地图边 ${e.edge_id} 起点 ${e.from_region} 不存在`);
    if (!regions.has(e.to_region)) errors.push(`地图边 ${e.edge_id} 终点 ${e.to_region} 不存在`);
  }

  // 州府级连通性（把 24 个州府视为图节点）
  const adjacency: Record<string, Set<string>> = {};
  for (const e of seed.map_edges) {
    adjacency[e.from_region] ??= new Set();
    adjacency[e.to_region] ??= new Set();
    adjacency[e.from_region].add(e.to_region);
    adjacency[e.to_region].add(e.from_region);
  }
  const start = seed.territories[0].region;
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length) {
    const cur = queue.shift() as string;
    for (const nxt of adjacency[cur] ?? []) {
      if (!seen.has(nxt)) {
        seen.add(nxt);
        queue.push(nxt);
      }
    }
  }
  stats.connected_regions = seen.size;
  if (seen.size !== seed.territories.length) {
    errors.push(`州府连通性不足：${seen.size}/${seed.territories.length}，需要派生连接（不得改写原始边）`);
  }
  for (const node of seed.map_nodes) {
    // 每个节点的州府都应有至少一条道路（可由区域主城边覆盖）
    if (!adjacency[node.region]) warnings.push(`州府 ${node.region} 没有任何道路边`);
  }

  for (const k of Object.keys(EXPECTED_FORCE)) {
    const rows = seed.national_force_allocations.filter((a: any) => a.faction_key === k);
    const sum = rows.reduce((s: number, a: any) => s + a.initial_force_count, 0);
    stats[`force_${k}`] = sum;
    if (sum !== EXPECTED_FORCE[k]) errors.push(`${k} 兵力分配合计 ${sum}，期望 ${EXPECTED_FORCE[k]}`);
    if (rows.length !== 6) errors.push(`${k} 军区兵力分配记录数为 ${rows.length}，期望 6`);
    const faction = seed.factions.find((f: any) => f.key === k);
    if (faction && faction.initial_force_total !== EXPECTED_FORCE[k]) {
      errors.push(`${k} factions.initial_force_total=${faction.initial_force_total} 与分配合计不一致`);
    }
    const units = seed.military_units.filter((u: any) => u.faction_key === k);
    const names = units.map((u: any) => u.unit_name);
    if (units.length !== EXPECTED_UNIT_NAMES[k].length) errors.push(`${k} 特殊兵种数为 ${units.length}`);
    for (const expected of EXPECTED_UNIT_NAMES[k]) {
      if (!names.includes(expected)) errors.push(`${k} 缺少特殊兵种 ${expected}`);
    }
  }

  // 原型归属审计：以种子中每个历史原型的 primary_faction_key 为主规则，
  // 并叠加用户明确指定的核心例外；COMMON 仅允许用于在野/地方官/世家等候选岗位。
  const archetypeById = new Map<string, any>(
    seed.historical_archetypes.map((a: any) => [a.archetype_id, a]),
  );
  const archetypeByName = new Map<string, any>(
    seed.historical_archetypes.map((a: any) => [a.historical_name, a]),
  );
  const neutralRolePattern = /(在野|州府.*(?:主官|副官)|家主|嫡系继承人|首席谋士|总掌柜|郡县|地方官|县令|郡守|太守|门客|幕僚|军阀|藩镇)/;

  for (const c of seed.characters) {
    const archetype = archetypeById.get(c.archetype_id);
    if (!archetype) continue; // 引用缺失已在上方作为硬性错误报告
    const expectedFaction = archetype.primary_faction_key;
    if (['HUN', 'YONG', 'CHU'].includes(expectedFaction) && c.faction_key !== expectedFaction) {
      conflicts.push(
        `原型规则冲突：${archetype.historical_name} 主归属为 ${expectedFaction}，但人物 ${c.person_id}(${c.name}) 属于 ${c.faction_key}，职位 ${c.current_position_standard}`,
      );
    } else if (expectedFaction === 'COMMON' && !neutralRolePattern.test(c.current_position_standard ?? '')) {
      conflicts.push(
        `原型规则冲突：${archetype.historical_name} 属于中立候选原型，但人物 ${c.person_id}(${c.name}) 的岗位「${c.current_position_standard}」不是在野/地方官/世家类岗位`,
      );
    }
  }

  for (const [factionKey, names] of Object.entries(CORE_ARCHETYPE_OVERRIDES)) {
    for (const name of names) {
      const archetype = archetypeByName.get(name);
      if (!archetype) {
        warnings.push(`核心原型规则中的人物「${name}」未出现在 historical_archetypes 表中`);
        continue;
      }
      if (archetype.primary_faction_key !== factionKey) {
        conflicts.push(
          `原型规则冲突：核心原型「${name}」应归属 ${factionKey}，但 historical_archetypes.primary_faction_key 为 ${archetype.primary_faction_key}`,
        );
      }
    }
  }
  stats.archetype_faction_conflicts = conflicts.length;

  // 名称多样性：检测机械化单字堆叠
  const familyCharCount = new Map<string, number>();
  for (const c of seed.characters) {
    const first = c.name?.[0];
    if (first) familyCharCount.set(first, (familyCharCount.get(first) ?? 0) + 1);
  }
  const topSurname = [...familyCharCount.entries()].sort((a, b) => b[1] - a[1])[0];
  stats.top_surname_repeat = topSurname?.[1] ?? 0;
  if (topSurname && topSurname[1] > 40) {
    warnings.push(`姓氏「${topSurname[0]}」出现 ${topSurname[1]} 次，请确认不是机械生成`);
  }
  const chengCount = seed.characters.filter((c: any) => c.name.includes('承')).length;
  stats.cheng_name_count = chengCount;
  if (chengCount > 12) warnings.push(`人物名中包含「承」的有 ${chengCount} 人，可能违反命名多样性要求`);

  // 派生内容检测：种子中不得夹带 origin=derived 的边
  const derivedInSeed = seed.map_edges.filter((e: any) => e.origin === 'derived');
  if (derivedInSeed.length > 0) errors.push('原始种子中出现了标记为 derived 的边；派生边必须写入 data/derived');

  return { ok: errors.length === 0, errors, warnings, conflicts, stats };
}

export function writeReport(result: ValidationResult, root = process.cwd()): string {
  const lines: string[] = [];
  lines.push('# 种子数据校验报告');
  lines.push('');
  lines.push(`生成时间：${new Date().toISOString()}`);
  lines.push('');
  lines.push(`结论：**${result.ok ? '通过（硬性错误 0）' : `未通过（${result.errors.length} 项硬性错误）`}**`);
  lines.push('');
  lines.push('## 计数');
  lines.push('');
  lines.push('| 表 | 记录数 |');
  lines.push('| --- | --- |');
  for (const [k, v] of Object.entries(result.stats)) lines.push(`| ${k} | ${v} |`);
  lines.push('');
  lines.push('## 硬性错误');
  lines.push('');
  lines.push(result.errors.length ? result.errors.map((e) => `- ${e}`).join('\n') : '- 无');
  lines.push('');
  lines.push('## 警告');
  lines.push('');
  lines.push(result.warnings.length ? [...new Set(result.warnings)].map((e) => `- ${e}`).join('\n') : '- 无');
  lines.push('');
  lines.push('## 原型归属审计（按当前分配规则校验）');
  lines.push('');
  lines.push(result.conflicts.length ? result.conflicts.map((e) => `- ${e}`).join('\n') : '- 无');
  lines.push('');
  lines.push('> 原始种子 `data/source/tianming_world_roster_v0_3_1.json` 为权威数据，校验脚本不会改写。');
  lines.push('');
  const out = path.join(root, 'docs/DATA_VALIDATION_REPORT.md');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, lines.join('\n'));
  return out;
}
