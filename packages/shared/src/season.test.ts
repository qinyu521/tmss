import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyUnitNames,
  buildContext,
  computeEconomy,
  createGame,
  dayCostsFor,
  makeDate,
  runTurn,
  seasonOf,
  SEASON_LABELS,
  type Army,
  type SeedRoster,
} from './index.js';

const seedPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../data/source/tianming_world_roster_v0_3_1.json',
);
const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8')) as SeedRoster;
applyUnitNames(seed.military_units);
const ctx = buildContext(seed);

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** 以 3 月 1 日为 dayIndex 0，给出指定月份首日的日期（monthAdvance = month - 3） */
const dateOfMonth = (month: number, turn = 1) => makeDate((month - 3) * 30, turn);

const hunCavalryArmy = (): Army => ({
  armyId: 'test-cav',
  faction: 'HUN',
  name: '测试骑军',
  commanderId: '',
  commanderName: '',
  districtId: '',
  nodeId: '',
  originRegionId: '',
  units: [{ unitId: 'HUN-U001', name: '铁骑', category: 'heavy_cavalry', count: 5000 }],
  levies: 1000,
  troops: 6000,
  morale: 60,
  training: 55,
  supply: 80,
  fatigue: 0,
  stance: 'march',
  status: 'marching',
  path: [],
  hopCosts: [],
  targetRegionId: null,
  marchDaysTotal: 0,
  marchDaysLeft: 0,
  lastBattleTurn: null,
});

describe('季节推导', () => {
  it('seasonOf 边界：12/1/2 为冬，3-5 春，6-8 夏，9-11 秋', () => {
    expect(seasonOf(12)).toBe('winter');
    expect(seasonOf(1)).toBe('winter');
    expect(seasonOf(2)).toBe('winter');
    expect(seasonOf(3)).toBe('spring');
    expect(seasonOf(5)).toBe('spring');
    expect(seasonOf(6)).toBe('summer');
    expect(seasonOf(8)).toBe('summer');
    expect(seasonOf(9)).toBe('autumn');
    expect(seasonOf(11)).toBe('autumn');
  });

  it('每季都有中文描述与影响提示', () => {
    for (const key of ['spring', 'summer', 'autumn', 'winter'] as const) {
      expect(SEASON_LABELS[key].label.length).toBe(1);
      expect(SEASON_LABELS[key].desc.length).toBeGreaterThan(0);
      expect(SEASON_LABELS[key].hint.length).toBeGreaterThan(0);
    }
  });
});

describe('季节经济修正', () => {
  it('同一状态下秋季粮产高于春季（秋收 ×1.6 对 青黄不接 ×0.9）', () => {
    const spring = createGame(seed, { gameId: 't', factionKey: 'YONG', playerRole: 'ruler', seed: 1 });
    spring.date = dateOfMonth(3);
    const autumn = clone(spring);
    autumn.date = dateOfMonth(9);
    const springGrain = computeEconomy(spring, ctx).YONG.grainProduced;
    const autumnGrain = computeEconomy(autumn, ctx).YONG.grainProduced;
    expect(autumnGrain).toBeGreaterThan(springGrain);
    expect(autumnGrain / springGrain).toBeGreaterThan(1.5);
  });

  it('冬季匈奴粮耗高于夏季（冬季远征草料难继 ×1.25）', () => {
    const summer = createGame(seed, { gameId: 't', factionKey: 'HUN', playerRole: 'ruler', seed: 1 });
    summer.date = dateOfMonth(6);
    const winter = clone(summer);
    winter.date = dateOfMonth(12);
    const summerUsed = computeEconomy(summer, ctx).HUN.grainUsed;
    const winterUsed = computeEconomy(winter, ctx).HUN.grainUsed;
    expect(winterUsed).toBeGreaterThan(summerUsed);
    expect(winterUsed / summerUsed).toBeGreaterThan(1.2);
  });

  it('冬季粮产大幅低于秋季（冬藏 ×0.35）', () => {
    const autumn = createGame(seed, { gameId: 't', factionKey: 'CHU', playerRole: 'ruler', seed: 1 });
    autumn.date = dateOfMonth(9);
    const winter = clone(autumn);
    winter.date = dateOfMonth(12);
    expect(computeEconomy(winter, ctx).CHU.grainProduced).toBeLessThan(computeEconomy(autumn, ctx).CHU.grainProduced);
  });
});

describe('季节行军修正', () => {
  it('冬季河网边对匈奴骑兵为主的部队行军成本下降（×0.8 封冻涉渡）', () => {
    const army = hunCavalryArmy();
    const winter = dayCostsFor(army, [10], { routeTypes: ['河谷官道'], season: 'winter' });
    const summer = dayCostsFor(army, [10], { routeTypes: ['河谷官道'], season: 'summer' });
    expect(winter[0]).toBeLessThan(summer[0]);
  });

  it('非河网边或非骑兵部队不受冬季涉渡加成', () => {
    const army = hunCavalryArmy();
    const winter = dayCostsFor(army, [10], { routeTypes: ['官道'], season: 'winter' });
    const summer = dayCostsFor(army, [10], { routeTypes: ['官道'], season: 'summer' });
    expect(winter[0]).toBe(summer[0]);
    // 大雍征集兵骑兵占比仅 16%，不构成骑兵为主
    const infantry = { ...hunCavalryArmy(), faction: 'YONG' as const, units: [], levies: 6000 };
    const wInf = dayCostsFor(infantry, [10], { routeTypes: ['河谷官道'], season: 'winter' });
    const sInf = dayCostsFor(infantry, [10], { routeTypes: ['河谷官道'], season: 'summer' });
    expect(wInf[0]).toBe(sInf[0]);
  });
});

describe('季节事件与确定性', () => {
  it('开局入春发一条时令事件，旬始摘要含季节提示；次旬未跨季则无新时令事件', () => {
    const state = createGame(seed, { gameId: 't', factionKey: 'YONG', playerRole: 'ruler', seed: 7 });
    const first = runTurn(state, ctx);
    const seasonEvent = first.report.events.find((e) => e.type === 'season');
    expect(seasonEvent).toBeTruthy();
    expect((seasonEvent!.after as { season: string }).season).toBe('spring');
    const turnStart = first.report.events.find((e) => e.type === 'turn_start')!;
    expect(turnStart.summary).toContain(SEASON_LABELS.spring.hint);
    const second = runTurn(first.state, ctx);
    expect(second.report.events.some((e) => e.type === 'season')).toBe(false);
  });

  it('同种子同日期两次 runTurn 结果一致（秋季结算确定性）', () => {
    const base = createGame(seed, { gameId: 'det-season', factionKey: 'HUN', playerRole: 'ruler', seed: 99 });
    base.date = dateOfMonth(9, 26);
    const a = runTurn(clone(base), ctx);
    const b = runTurn(clone(base), ctx);
    expect(JSON.stringify(a.report.events)).toBe(JSON.stringify(b.report.events));
    expect(a.state.factions.HUN.resources).toEqual(b.state.factions.HUN.resources);
    expect(a.state.factions.YONG.resources).toEqual(b.state.factions.YONG.resources);
  });
});
