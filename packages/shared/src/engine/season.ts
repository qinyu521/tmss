import { BALANCE } from '../balance.js';
import type { FactionKey, GameDate } from '../types.js';

/**
 * 季节系统 —— 由 GameDate.month 推导，全部修正系数集中在 balance.ts 的 seasons 块。
 * 推导与展示均为纯函数，不引入任何随机性。
 */
export type Season = 'spring' | 'summer' | 'autumn' | 'winter';

/** 3-5 月春 / 6-8 月夏 / 9-11 月秋 / 12-2 月冬 */
export function seasonOf(month: number): Season {
  if (month >= 3 && month <= 5) return 'spring';
  if (month >= 6 && month <= 8) return 'summer';
  if (month >= 9 && month <= 11) return 'autumn';
  return 'winter';
}

export function seasonOfDate(date: GameDate): Season {
  return seasonOf(date.month);
}

/** 每季一句中文描述与一句玩法影响提示（事件与顶栏共用） */
export const SEASON_LABELS: Record<Season, { label: string; desc: string; hint: string }> = {
  spring: {
    label: '春',
    desc: '冰雪消融，万物复苏',
    hint: '青黄不接，粮产略减；农闲入伍，兵员恢复加快',
  },
  summer: {
    label: '夏',
    desc: '暑气蒸腾，盐田丰收',
    hint: '盐产增加；暑热行军疲劳加剧，匈奴骑兵尤不耐暑',
  },
  autumn: {
    label: '秋',
    desc: '秋高马肥，收粮在即',
    hint: '粮产大增，兵员恢复加快，宜积蓄备战',
  },
  winter: {
    label: '冬',
    desc: '河流封冻，骑军可涉',
    hint: '粮产锐减；匈奴粮耗增加，然其骑军可涉渡封冻河面，水军受限',
  },
};

/** 地图边是否属于河网/水路（route_type 为中文自由文本，按水意关键词判定） */
export function isRiverRoute(routeType: string): boolean {
  return /河|江|漕|渡|航/.test(routeType);
}

/** 行军疲劳的季节系数：夏季全军 +20%，匈奴夏季再额外 +15%（不耐暑） */
export function marchFatigueSeasonFactor(season: Season, faction: FactionKey): number {
  const cfg = BALANCE.seasons[season];
  return cfg.marchFatigue * (faction === 'HUN' ? cfg.hunMarchFatigue : 1);
}
