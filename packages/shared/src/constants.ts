import type { FactionKey, GameDate, PlayerRole } from './types.js';

/**
 * 势力视觉 Token —— 唯一来源，前端与 3D 地图都从这里取色，禁止组件内硬编码。
 */
export const FACTION_VISUALS: Record<
  FactionKey,
  {
    shortName: string;
    name: string;
    primary: string;
    secondary: string;
    accent: string;
    ink: string;
    mapFill: string;
    mapBorder: string;
    bannerGlyph: string;
    tagline: string;
  }
> = {
  HUN: {
    shortName: '匈奴',
    name: '匈奴（架空北庭联盟）',
    primary: '#a8322c',
    secondary: '#c9a227',
    accent: '#7c4a2d',
    ink: '#f4e6cf',
    mapFill: '#a8322c',
    mapBorder: '#e0b45c',
    bannerGlyph: '狼',
    tagline: '高机动 · 低整合 · 草原联盟',
  },
  YONG: {
    shortName: '大雍',
    name: '大雍',
    primary: '#243b6b',
    secondary: '#d4b24c',
    accent: '#171a22',
    ink: '#f2ead6',
    mapFill: '#2f4a82',
    mapBorder: '#d4b24c',
    bannerGlyph: '鼎',
    tagline: '制度动员 · 宫廷暗流 · 中央帝国',
  },
  CHU: {
    shortName: '大楚',
    name: '大楚',
    primary: '#1f6f6a',
    secondary: '#e6ddc6',
    accent: '#8c9aa6',
    ink: '#f3efe2',
    mapFill: '#2c8a80',
    mapBorder: '#c9e3d6',
    bannerGlyph: '江',
    tagline: '富庶江左 · 世家掣肘 · 水陆弓弩',
  },
};

export const ROLE_LABEL: Record<PlayerRole, string> = {
  ruler: '君主',
  governor: '郡守/州牧',
  general: '将军',
  strategist: '军师',
};

export const FACTION_SHORT: Record<FactionKey, string> = {
  HUN: '匈奴',
  YONG: '大雍',
  CHU: '大楚',
};

export const RELATION_LABELS: Record<string, string> = {
  HUN: '匈奴（架空北庭联盟）',
  YONG: '大雍',
  CHU: '大楚',
};

export const ERAS = {
  eraName: '天命',
  year: 1,
  month: 3,
  day: 1,
  monthLength: 30,
};

const CN_NUM = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];

export function cnNumber(n: number): string {
  if (n <= 10) return CN_NUM[n];
  if (n < 20) return `十${n % 10 === 0 ? '' : CN_NUM[n % 10]}`;
  if (n < 100) {
    const tens = Math.floor(n / 10);
    const ones = n % 10;
    return `${CN_NUM[tens]}十${ones === 0 ? '' : CN_NUM[ones]}`;
  }
  return String(n);
}

export function formatDate(date: GameDate): string {
  return `${ERAS.eraName}${cnNumber(date.year)}年 ${cnNumber(date.month)}月${cnNumber(date.day)}日`;
}

export function makeDate(dayIndex: number, turn: number): GameDate {
  const total = ERAS.day + dayIndex;
  const monthAdvance = Math.floor((total - 1) / ERAS.monthLength);
  const day = ((total - 1) % ERAS.monthLength) + 1;
  const month = ERAS.month + monthAdvance;
  const year = ERAS.year + Math.floor((month - 1) / 12);
  const m = ((month - 1) % 12) + 1;
  const date: GameDate = {
    year,
    month: m,
    day,
    turn,
    dayIndex,
    label: '',
  };
  date.label = formatDate(date);
  return date;
}

export const TURN_DAYS = 7;

export const CATEGORY_LABELS: Record<string, string> = {
  heavy_cavalry: '重装冲击骑兵',
  guard_cavalry: '禁卫骑兵',
  horse_archer: '弓骑兵',
  light_cavalry: '轻骑兵',
  heavy_infantry: '重装步兵',
  shock_infantry: '突击步兵',
  guard_infantry: '禁卫步兵',
  spearman: '长矛/拒马步兵',
  crossbow: '强弩兵',
  naval_raider: '水军袭扰',
  light_infantry: '轻装山地步兵',
};

export const ORDER_LABELS: Record<string, string> = {
  move_army: '行军/分兵',
  dispatch_garrison: '调遣州兵',
  recruit: '征募扩军',
  levy_grain: '征粮',
  levy_tax: '加征商税',
  trade: '边市贸易',
  appease_tribe: '赏赐部落',
  balance_princes: '平衡皇子',
  negotiate_house: '协商世家',
  hold_court: '召集廷议',
  reward_commander: '赏赐将领',
  appoint: '任命官职',
  rest_army: '整军休整',
  scout: '遣斥候侦察',
  scheme: '施展计谋',
};

export const SCHEME_LABELS: Record<string, string> = {
  fire: '火攻',
  cut_supply: '断其粮道',
  sow_discord: '离间',
  ambush: '预设伏兵',
  feint: '声东击西',
};

/** 各身份的可用命令范围（前端展示与后端校验共用同一份常量）。 */
export const ROLE_ALLOWED_ORDERS: Record<PlayerRole, string[]> = {
  ruler: [
    'move_army',
    'dispatch_garrison',
    'recruit',
    'levy_grain',
    'levy_tax',
    'trade',
    'appease_tribe',
    'balance_princes',
    'negotiate_house',
    'hold_court',
    'reward_commander',
    'appoint',
    'rest_army',
    'scout',
    'scheme',
  ],
  governor: [
    'move_army',
    'dispatch_garrison',
    'recruit',
    'levy_grain',
    'levy_tax',
    'trade',
    'appease_tribe',
    'negotiate_house',
    'rest_army',
    'scout',
    'scheme',
  ],
  general: ['move_army', 'dispatch_garrison', 'rest_army', 'scout', 'scheme'],
  strategist: ['scout', 'scheme'],
};

export const SHORTAGE_LABEL: Record<string, string> = {
  grain: '粮',
  salt: '盐',
  iron: '铁',
  horses: '战马',
  cash: '银钱',
  manpower: '兵员',
};

/** 数字展示：大数字转为万/亿，避免 UI 失控 */
export function fmt(n: number, unit = ''): string {
  const abs = Math.abs(n);
  if (abs >= 100_000_000) return `${(n / 100_000_000).toFixed(2)}亿${unit}`;
  if (abs >= 10_000) return `${(n / 10_000).toFixed(abs >= 100_000 ? 0 : 1)}万${unit}`;
  if (abs >= 100) return `${Math.round(n)}${unit}`;
  return `${n.toFixed(abs < 10 ? 1 : 0).replace(/\.0$/, '')}${unit}`;
}

export function pct(n: number): string {
  return `${Math.round(n)}%`;
}

/** 带符号数字（用于账本摘要，负数显示 - 而不是 +-） */
export function signed(n: number, unit = ''): string {
  const rounded = Math.abs(n) >= 1000 ? Math.round(n) : Math.round(n * 10) / 10;
  return `${rounded >= 0 ? '+' : ''}${rounded.toLocaleString()}${unit}`;
}
