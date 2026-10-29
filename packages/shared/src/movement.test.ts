import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyUnitNames,
  buildContext,
  createGame,
  dayCostsFor,
  estimatePathDays,
  findPath,
  routeCapacityMultiplier,
  type MapEdgeSeed,
  type SeedRoster,
} from './index.js';

const seedPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../data/source/tianming_world_roster_v0_3_1.json',
);
const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8')) as SeedRoster;
applyUnitNames(seed.military_units);
const ctx = buildContext(seed);
const state = createGame(seed, {
  gameId: 'movement-capacity-test',
  factionKey: 'HUN',
  playerRole: 'ruler',
  seed: 20261028,
});

const factions = new Map(seed.factions.map((f) => [f.key, f.name]));
const edge = (
  edge_id: string,
  from_region: string,
  to_region: string,
  base_movement_cost: number,
  throughput: string,
): MapEdgeSeed => ({
  edge_id,
  from_region,
  to_region,
  from_faction: factions.get('HUN') ?? '匈奴',
  to_faction: factions.get('HUN') ?? '匈奴',
  route_type: throughput === '高' ? '官道' : '山道/支路',
  base_movement_cost,
  throughput,
  control_or_interdiction: '测试路线',
  simulation_rule: '用于回归测试',
});

describe('行军路线与道路通行能力', () => {
  it('按道路通行能力与部队规模计算拥堵成本', () => {
    expect(routeCapacityMultiplier(10_000, '高')).toBe(1);
    expect(routeCapacityMultiplier(10_000, '低')).toBe(1);
    expect(routeCapacityMultiplier(30_000, '低')).toBe(1.18);
    expect(routeCapacityMultiplier(60_000, '中')).toBe(1.1);
    expect(routeCapacityMultiplier(60_000, '低')).toBe(1.4);
    expect(routeCapacityMultiplier(60_000, '争议/中低')).toBe(1.6);
  });

  it('小部队可以走短支路，大军会优先选择通行能力更高的官道', () => {
    const routeCtx = {
      ...ctx,
      edges: [
        edge('TEST-DIRECT-LOW', '龙庭京府', '赤河州', 3, '争议/中低'),
        edge('TEST-ROAD-A', '龙庭京府', '白山州', 2, '高'),
        edge('TEST-ROAD-B', '白山州', '赤河州', 2, '高'),
      ],
    };

    const small = findPath(
      state,
      routeCtx,
      'HUN',
      'HUN-REG01',
      'HUN-REG05',
      { troops: 10_000 },
    );
    const large = findPath(
      state,
      routeCtx,
      'HUN',
      'HUN-REG01',
      'HUN-REG05',
      { troops: 80_000 },
    );

    expect(small.ok).toBe(true);
    expect(small.path).toEqual(['HUN-REG05']);
    expect(small.costs).toEqual([3.3]);
    const smallLevyProfile = {
      faction: 'HUN' as const,
      troops: 10_000,
      levies: 10_000,
      units: [],
      fatigue: 0,
    };
    expect(estimatePathDays(smallLevyProfile, small, 'spring')).toBe(7);
    expect(small.totalDays).toBe(3.3); // 路线成本与实际行军日分开计算

    expect(large.ok).toBe(true);
    expect(large.path).toEqual(['HUN-REG02', 'HUN-REG05']);
    expect(large.costs).toEqual([2, 2]);
    expect(large.totalDays).toBe(4); // Dijkstra 成本用于选路；实际天数由 estimatePathDays 换算。
  });

  it('道路成本换算为实际行军日，标准军团会自然跨旬', () => {
    const standardArmy = {
      faction: 'YONG' as const,
      troops: 10_000,
      levies: 10_000,
      units: [],
      fatigue: 0,
    };
    // 基础机动、春季非河路：道路成本 2/3/4/5 约为 4/7/9/11 天。
    expect(dayCostsFor(standardArmy, [2, 3, 4, 5], {
      routeTypes: ['官道', '官道', '官道', '官道'],
      season: 'spring',
    })).toEqual([4, 7, 9, 11]);
    expect(estimatePathDays(standardArmy, { costs: [2, 3], routeTypes: ['官道', '官道'] }, 'spring')).toBe(11);
  });
});
