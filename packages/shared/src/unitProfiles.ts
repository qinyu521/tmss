import type { FactionKey, UnitProfile } from './types.js';

/**
 * 22 个特殊兵种的派生档案（数值为原创设定，名称/描述来自 data/source JSON）。
 * 每个兵种在机动、冲击、防护、远程、补给、地形、克制与招募门槛上有可识别差异。
 */
const P = (
  unitId: string,
  faction: FactionKey,
  category: UnitProfile['category'],
  v: {
    attack: number;
    defense: number;
    ranged: number;
    mobility: number;
    morale: number;
    supplyCost: number;
    terrain: Partial<UnitProfile['terrain']>;
    counters?: UnitProfile['counters'];
    counteredBy?: UnitProfile['counteredBy'];
    cap: number;
    recruit: Partial<UnitProfile['recruit']>;
    visual: UnitProfile['visual'];
    note: string;
  },
): UnitProfile => ({
  unitId,
  name: '',
  faction,
  category,
  attack: v.attack,
  defense: v.defense,
  ranged: v.ranged,
  mobility: v.mobility,
  morale: v.morale,
  supplyCost: v.supplyCost,
  upkeepCash: Math.round((v.attack + v.defense) * 1.1),
  terrain: {
    plain: 1,
    hill: 0.95,
    mountain: 0.85,
    forest: 0.9,
    river: 0.95,
    fort: 0.95,
    ...v.terrain,
  },
  counters: v.counters ?? [],
  counteredBy: v.counteredBy ?? [],
  recruit: {
    manpower: Math.round(v.cap * 0.25),
    iron: 0,
    horses: 0,
    salt: 0,
    cash: 0,
    minTraining: 50,
    ...v.recruit,
  },
  capPerFaction: v.cap,
  visual: v.visual,
  note: v.note,
});

export const UNIT_PROFILES: Record<string, UnitProfile> = {
  /* ---------------- 匈奴 5 ---------------- */
  'HUN-U001': P('HUN-U001', 'HUN', 'heavy_cavalry', {
    attack: 93, defense: 90, ranged: 10, mobility: 38, morale: 80, supplyCost: 3.6,
    terrain: { plain: 1.16, hill: 0.86, mountain: 0.5, forest: 0.58, river: 0.72, fort: 0.66 },
    counters: ['crossbow', 'spearman'], counteredBy: ['spearman', 'shock_infantry'],
    cap: 8000,
    recruit: { manpower: 1800, iron: 90, horses: 900, salt: 6, cash: 16_000, minTraining: 72 },
    visual: { icon: 'cavalry_heavy', mount: true, bow: false, shield: false, weapon: 'spear', armor: 'heavy', banner: 'wolf' },
    note: '人马列阵的重装冲击骑兵；平原冲锋极强，山林泥泞中几乎失去价值。',
  }),
  'HUN-U002': P('HUN-U002', 'HUN', 'heavy_cavalry', {
    attack: 86, defense: 92, ranged: 10, mobility: 42, morale: 78, supplyCost: 3.4,
    terrain: { plain: 1.1, hill: 0.9, mountain: 0.55, forest: 0.62, river: 0.75, fort: 0.8 },
    counters: ['heavy_infantry'], counteredBy: ['spearman', 'crossbow'],
    cap: 6000,
    recruit: { manpower: 1500, iron: 110, horses: 800, salt: 5, cash: 14_000, minTraining: 70 },
    visual: { icon: 'cavalry_heavy', mount: true, bow: false, shield: true, weapon: 'spear', armor: 'heavy', banner: 'wolf' },
    note: '以铁甲与阵型稳固见长，守而不乱；追击与迂回不如轻骑。',
  }),
  'HUN-U003': P('HUN-U003', 'HUN', 'guard_cavalry', {
    attack: 88, defense: 74, ranged: 52, mobility: 92, morale: 88, supplyCost: 3.0,
    terrain: { plain: 1.12, hill: 1.0, mountain: 0.8, forest: 0.88, river: 0.9, fort: 0.78 },
    counters: ['light_infantry', 'crossbow', 'horse_archer'], counteredBy: ['spearman', 'heavy_cavalry'],
    cap: 5000,
    recruit: { manpower: 1200, iron: 42, horses: 1000, salt: 4, cash: 18_000, minTraining: 76 },
    visual: { icon: 'cavalry_guard', mount: true, bow: true, shield: false, weapon: 'bow', armor: 'medium', banner: 'wolf' },
    note: '王庭宿卫，骑射与近战兼备；数量极少，损失难以补充。',
  }),
  'HUN-U004': P('HUN-U004', 'HUN', 'heavy_cavalry', {
    attack: 84, defense: 86, ranged: 12, mobility: 46, morale: 80, supplyCost: 3.3,
    terrain: { plain: 1.12, hill: 0.9, mountain: 0.55, forest: 0.64, river: 0.78, fort: 0.8 },
    counters: ['heavy_infantry'], counteredBy: ['spearman'],
    cap: 7000,
    recruit: { manpower: 1400, iron: 80, horses: 850, salt: 5, cash: 13_000, minTraining: 68 },
    visual: { icon: 'cavalry_heavy', mount: true, bow: false, shield: true, weapon: 'spear', armor: 'heavy', banner: 'wolf' },
    note: '林间铁骑以纪律弥补地形劣势；离开草原补给线后维持成本陡增。',
  }),
  'HUN-U005': P('HUN-U005', 'HUN', 'light_infantry', {
    attack: 74, defense: 66, ranged: 58, mobility: 82, morale: 78, supplyCost: 1.7,
    terrain: { plain: 0.95, hill: 1.06, mountain: 1.28, forest: 1.22, river: 0.95, fort: 0.9 },
    counters: ['crossbow', 'naval_raider'], counteredBy: ['heavy_cavalry', 'shock_infantry'],
    cap: 6000,
    recruit: { manpower: 900, iron: 20, horses: 0, salt: 2, cash: 7_000, minTraining: 58 },
    visual: { icon: 'infantry_light', mount: false, bow: true, shield: false, weapon: 'bow', armor: 'light', banner: 'wolf' },
    note: '山林猎手，擅长侦察与伏击；正面阵列战脆弱。',
  }),

  /* ---------------- 大楚 9 ---------------- */
  'CHU-U001': P('CHU-U001', 'CHU', 'light_infantry', {
    attack: 78, defense: 70, ranged: 44, mobility: 84, morale: 80, supplyCost: 1.8,
    terrain: { plain: 0.92, hill: 1.08, mountain: 1.3, forest: 1.16, river: 1.0, fort: 0.95 },
    counters: ['crossbow', 'horse_archer'], counteredBy: ['heavy_cavalry', 'shock_infantry'],
    cap: 6000,
    recruit: { manpower: 1000, iron: 18, horses: 0, salt: 2, cash: 8_000, minTraining: 60 },
    visual: { icon: 'infantry_light', mount: false, bow: true, shield: false, weapon: 'bow', armor: 'light', banner: 'river' },
    note: '山地飞军，越岭如履平地；不擅平原结阵对抗重骑。',
  }),
  'CHU-U002': P('CHU-U002', 'CHU', 'naval_raider', {
    attack: 76, defense: 60, ranged: 48, mobility: 90, morale: 74, supplyCost: 2.0,
    terrain: { plain: 0.9, hill: 0.85, mountain: 0.7, forest: 0.95, river: 1.4, fort: 0.7 },
    counters: ['heavy_infantry', 'crossbow'], counteredBy: ['guard_cavalry'],
    cap: 4000,
    recruit: { manpower: 800, iron: 25, horses: 0, salt: 3, cash: 9_000, minTraining: 62 },
    visual: { icon: 'naval_raider', mount: false, bow: true, shield: false, weapon: 'sword', armor: 'light', banner: 'river' },
    note: '水寨夜袭与劫粮部队，渡口与河网战力倍增，陆战正面孱弱。',
  }),
  'CHU-U003': P('CHU-U003', 'CHU', 'horse_archer', {
    attack: 70, defense: 62, ranged: 80, mobility: 96, morale: 80, supplyCost: 2.6,
    terrain: { plain: 1.12, hill: 1.0, mountain: 0.72, forest: 0.8, river: 0.9, fort: 0.7 },
    counters: ['heavy_infantry', 'spearman'], counteredBy: ['spearman', 'crossbow'],
    cap: 5000,
    recruit: { manpower: 900, iron: 20, horses: 900, salt: 3, cash: 15_000, minTraining: 74 },
    visual: { icon: 'cavalry_archer', mount: true, bow: true, shield: false, weapon: 'bow', armor: 'light', banner: 'phoenix' },
    note: '白马轻骑，骚扰与追击之王；大楚缺马，规模被严格限制。',
  }),
  'CHU-U004': P('CHU-U004', 'CHU', 'crossbow', {
    attack: 52, defense: 60, ranged: 97, mobility: 40, morale: 72, supplyCost: 2.2,
    terrain: { plain: 1.05, hill: 1.12, mountain: 1.0, forest: 0.9, river: 1.0, fort: 1.18 },
    counters: ['heavy_cavalry', 'guard_cavalry', 'shock_infantry'], counteredBy: ['shock_infantry', 'light_cavalry', 'naval_raider'],
    cap: 8000,
    recruit: { manpower: 1100, iron: 40, horses: 0, salt: 2, cash: 12_000, minTraining: 66 },
    visual: { icon: 'crossbow', mount: false, bow: true, shield: false, weapon: 'crossbow', armor: 'light', banner: 'phoenix' },
    note: '神臂强弩，正面破甲极强；需阵列保护，被近身突袭即溃。',
  }),
  'CHU-U005': P('CHU-U005', 'CHU', 'shock_infantry', {
    attack: 90, defense: 64, ranged: 12, mobility: 56, morale: 82, supplyCost: 2.4,
    terrain: { plain: 1.0, hill: 1.02, mountain: 0.9, forest: 0.98, river: 0.85, fort: 1.15 },
    counters: ['crossbow', 'spearman'], counteredBy: ['heavy_cavalry', 'guard_infantry'],
    cap: 4000,
    recruit: { manpower: 1200, iron: 35, horses: 0, salt: 3, cash: 11_000, minTraining: 68 },
    visual: { icon: 'infantry_shock', mount: false, bow: false, shield: true, weapon: 'sword', armor: 'medium', banner: 'phoenix' },
    note: '先登死士，攻城先登与破阵突击；伤亡极高，不宜久战。',
  }),
  'CHU-U006': P('CHU-U006', 'CHU', 'heavy_infantry', {
    attack: 84, defense: 90, ranged: 8, mobility: 42, morale: 84, supplyCost: 2.6,
    terrain: { plain: 1.02, hill: 1.0, mountain: 0.9, forest: 0.86, river: 0.95, fort: 1.1 },
    counters: ['light_infantry', 'shock_infantry'], counteredBy: ['crossbow', 'horse_archer'],
    cap: 6000,
    recruit: { manpower: 1300, iron: 45, horses: 0, salt: 3, cash: 10_000, minTraining: 64 },
    visual: { icon: 'infantry_heavy', mount: false, bow: false, shield: true, weapon: 'spear', armor: 'heavy', banner: 'phoenix' },
    note: '魏武卒式重装步兵，纪律严整；机动与追击不足。',
  }),
  'CHU-U007': P('CHU-U007', 'CHU', 'shock_infantry', {
    attack: 94, defense: 72, ranged: 10, mobility: 60, morale: 85, supplyCost: 2.8,
    terrain: { plain: 1.05, hill: 1.0, mountain: 0.86, forest: 0.94, river: 0.9, fort: 1.1 },
    counters: ['heavy_infantry', 'crossbow'], counteredBy: ['spearman', 'guard_infantry'],
    cap: 3000,
    recruit: { manpower: 1000, iron: 48, horses: 0, salt: 3, cash: 13_000, minTraining: 74 },
    visual: { icon: 'infantry_shock', mount: false, bow: false, shield: true, weapon: 'halberd', armor: 'heavy', banner: 'phoenix' },
    note: '陷阵死士，突破能力冠绝楚军；数量极少，补充极慢。',
  }),
  'CHU-U008': P('CHU-U008', 'CHU', 'heavy_infantry', {
    attack: 80, defense: 92, ranged: 6, mobility: 44, morale: 86, supplyCost: 2.5,
    terrain: { plain: 1.0, hill: 1.02, mountain: 0.94, forest: 0.9, river: 1.05, fort: 1.15 },
    counters: ['light_cavalry', 'shock_infantry'], counteredBy: ['crossbow', 'heavy_cavalry'],
    cap: 10_000,
    recruit: { manpower: 1400, iron: 40, horses: 0, salt: 3, cash: 9_000, minTraining: 62 },
    visual: { icon: 'infantry_heavy', mount: false, bow: false, shield: true, weapon: 'spear', armor: 'heavy', banner: 'river' },
    note: '北府兵，守城与结阵的中坚；进攻锐度有限。',
  }),
  'CHU-U009': P('CHU-U009', 'CHU', 'light_cavalry', {
    attack: 82, defense: 68, ranged: 28, mobility: 94, morale: 82, supplyCost: 2.5,
    terrain: { plain: 1.1, hill: 0.95, mountain: 0.75, forest: 0.85, river: 0.9, fort: 0.72 },
    counters: ['crossbow', 'light_infantry'], counteredBy: ['spearman', 'heavy_cavalry'],
    cap: 4000,
    recruit: { manpower: 800, iron: 20, horses: 900, salt: 2, cash: 14_000, minTraining: 76 },
    visual: { icon: 'cavalry_light', mount: true, bow: false, shield: false, weapon: 'spear', armor: 'light', banner: 'phoenix' },
    note: '白袍轻骑，奔袭与断粮迅捷；铁料短缺使其甲械不易补充。',
  }),

  /* ---------------- 大雍 8 ---------------- */
  'YONG-U001': P('YONG-U001', 'YONG', 'heavy_infantry', {
    attack: 92, defense: 88, ranged: 10, mobility: 52, morale: 88, supplyCost: 2.8,
    terrain: { plain: 1.05, hill: 1.02, mountain: 0.92, forest: 0.9, river: 0.95, fort: 1.12 },
    counters: ['light_cavalry', 'shock_infantry'], counteredBy: ['crossbow', 'horse_archer'],
    cap: 9000,
    recruit: { manpower: 1500, iron: 50, horses: 0, salt: 4, cash: 13_000, minTraining: 76 },
    visual: { icon: 'infantry_heavy', mount: false, bow: false, shield: true, weapon: 'halberd', armor: 'heavy', banner: 'sun' },
    note: '背嵬军式重步，攻守兼备；依赖军饷与盐，缺盐则士气受损。',
  }),
  'YONG-U002': P('YONG-U002', 'YONG', 'heavy_cavalry', {
    attack: 92, defense: 82, ranged: 12, mobility: 66, morale: 84, supplyCost: 3.4,
    terrain: { plain: 1.15, hill: 0.92, mountain: 0.56, forest: 0.65, river: 0.78, fort: 0.75 },
    counters: ['spearman', 'crossbow'], counteredBy: ['spearman', 'crossbow'],
    cap: 7000,
    recruit: { manpower: 1500, iron: 100, horses: 950, salt: 5, cash: 17_000, minTraining: 74 },
    visual: { icon: 'cavalry_heavy', mount: true, bow: false, shield: false, weapon: 'spear', armor: 'heavy', banner: 'tiger' },
    note: '虎豹骑，冲击力强；大雍缺马，扩编受限且损耗恢复慢。',
  }),
  'YONG-U003': P('YONG-U003', 'YONG', 'guard_infantry', {
    attack: 80, defense: 94, ranged: 6, mobility: 46, morale: 86, supplyCost: 2.5,
    terrain: { plain: 0.98, hill: 1.02, mountain: 0.94, forest: 0.9, river: 0.98, fort: 1.25 },
    counters: ['shock_infantry', 'light_cavalry'], counteredBy: ['crossbow', 'heavy_cavalry'],
    cap: 6000,
    recruit: { manpower: 1400, iron: 55, horses: 0, salt: 4, cash: 12_000, minTraining: 70 },
    visual: { icon: 'infantry_guard', mount: false, bow: false, shield: true, weapon: 'spear', armor: 'heavy', banner: 'sun' },
    note: '白毦禁卫，护卫与守城极稳；野战追击乏力。',
  }),
  'YONG-U004': P('YONG-U004', 'YONG', 'heavy_cavalry', {
    attack: 90, defense: 88, ranged: 8, mobility: 58, morale: 82, supplyCost: 3.5,
    terrain: { plain: 1.12, hill: 0.94, mountain: 0.58, forest: 0.66, river: 0.8, fort: 0.8 },
    counters: ['heavy_infantry', 'crossbow'], counteredBy: ['spearman', 'guard_infantry'],
    cap: 8000,
    recruit: { manpower: 1600, iron: 120, horses: 980, salt: 6, cash: 18_000, minTraining: 78 },
    visual: { icon: 'cavalry_heavy', mount: true, bow: false, shield: true, weapon: 'halberd', armor: 'heavy', banner: 'sun' },
    note: '玄甲军，人马俱甲；铁马耗材巨大，需要稳定军械体系。',
  }),
  'YONG-U005': P('YONG-U005', 'YONG', 'guard_infantry', {
    attack: 86, defense: 84, ranged: 8, mobility: 54, morale: 82, supplyCost: 2.6,
    terrain: { plain: 1.02, hill: 1.0, mountain: 0.9, forest: 0.88, river: 0.95, fort: 1.2 },
    counters: ['shock_infantry'], counteredBy: ['crossbow', 'heavy_cavalry'],
    cap: 7000,
    recruit: { manpower: 1200, iron: 45, horses: 0, salt: 3, cash: 11_000, minTraining: 68 },
    visual: { icon: 'infantry_guard', mount: false, bow: false, shield: true, weapon: 'sword', armor: 'medium', banner: 'eagle' },
    note: '虎贲军，京师仪仗与近战兼备；野战耐久一般。',
  }),
  'YONG-U006': P('YONG-U006', 'YONG', 'heavy_cavalry', {
    attack: 88, defense: 76, ranged: 10, mobility: 72, morale: 80, supplyCost: 3.2,
    terrain: { plain: 1.12, hill: 0.95, mountain: 0.6, forest: 0.7, river: 0.85, fort: 0.78 },
    counters: ['light_infantry', 'crossbow'], counteredBy: ['spearman'],
    cap: 6000,
    recruit: { manpower: 1300, iron: 80, horses: 920, salt: 4, cash: 14_000, minTraining: 68 },
    visual: { icon: 'cavalry_heavy', mount: true, bow: false, shield: false, weapon: 'spear', armor: 'medium', banner: 'eagle' },
    note: '西凉铁骑，来自西陲的精锐；战马补充依赖陇右牧场。',
  }),
  'YONG-U007': P('YONG-U007', 'YONG', 'spearman', {
    attack: 78, defense: 88, ranged: 20, mobility: 50, morale: 84, supplyCost: 2.0,
    terrain: { plain: 1.05, hill: 1.02, mountain: 0.95, forest: 1.05, river: 1.0, fort: 1.18 },
    counters: ['heavy_cavalry', 'guard_cavalry', 'light_cavalry', 'horse_archer'], counteredBy: ['crossbow', 'shock_infantry'],
    cap: 12_000,
    recruit: { manpower: 1000, iron: 35, horses: 0, salt: 2, cash: 8_000, minTraining: 64 },
    visual: { icon: 'infantry_spear', mount: false, bow: false, shield: true, weapon: 'spear', armor: 'medium', banner: 'eagle' },
    note: '戚家军式拒马长阵，专克骑兵；面对强弩与突击则显被动。',
  }),
  'YONG-U008': P('YONG-U008', 'YONG', 'guard_cavalry', {
    attack: 82, defense: 80, ranged: 35, mobility: 76, morale: 84, supplyCost: 3.0,
    terrain: { plain: 1.08, hill: 0.98, mountain: 0.7, forest: 0.8, river: 0.88, fort: 0.85 },
    counters: ['naval_raider', 'light_infantry'], counteredBy: ['spearman', 'crossbow'],
    cap: 6000,
    recruit: { manpower: 1100, iron: 55, horses: 880, salt: 3, cash: 15_000, minTraining: 72 },
    visual: { icon: 'cavalry_guard', mount: true, bow: true, shield: false, weapon: 'bow', armor: 'heavy', banner: 'sun' },
    note: '羽林骑，禁军骑兵，可侦察可护卫；不宜作为消耗品。',
  }),
};

/** 名字由种子 JSON 注入，保证名称唯一来源是 data/source。 */
export function applyUnitNames(units: { unit_id: string; unit_name: string }[]): void {
  for (const u of units) {
    const p = UNIT_PROFILES[u.unit_id];
    if (p) p.name = u.unit_name;
  }
}

export function profileOf(unitId: string): UnitProfile | undefined {
  return UNIT_PROFILES[unitId];
}

export function unitProfilesFor(faction: FactionKey): UnitProfile[] {
  return Object.values(UNIT_PROFILES).filter((p) => p.faction === faction);
}
