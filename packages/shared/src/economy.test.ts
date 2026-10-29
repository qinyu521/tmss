import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyUnitNames,
  buildContext,
  createGame,
  runEconomy,
  type GameEvent,
  type SeedRoster,
} from './index.js';

const seedPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../data/source/tianming_world_roster_v0_3_1.json',
);
const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8')) as SeedRoster;
applyUnitNames(seed.military_units);
const ctx = buildContext(seed);

describe('经济欠饷', () => {
  it('国库透支时现金夹到 0，并施加士气/治安惩罚与一次性事件', () => {
    const state = createGame(seed, {
      gameId: 'arrears-test',
      factionKey: 'YONG',
      playerRole: 'ruler',
      seed: 7,
    });
    for (const region of Object.values(state.regions)) {
      if (region.faction === 'YONG') region.taxOutput = 0;
    }
    state.factions.YONG.resources.cash = 0;
    const army = state.armies.find((a) => a.faction === 'YONG' && a.troops > 0);
    expect(army).toBeTruthy();
    const moraleBefore = army!.morale;
    const events: GameEvent[] = [];

    const totals = runEconomy(state, ctx, events);

    expect(totals.YONG.net.cash).toBeLessThan(0);
    expect(state.factions.YONG.resources.cash).toBe(0);
    expect(state.factions.YONG.statusTags).toContain('欠饷');
    expect(army!.morale).toBeLessThan(moraleBefore);
    expect(events.some((event) => event.title.includes('国库透支'))).toBe(true);
  });

  it('连续透支不会每回合重复刷事件', () => {
    const state = createGame(seed, {
      gameId: 'arrears-repeat',
      factionKey: 'YONG',
      playerRole: 'ruler',
      seed: 7,
    });
    for (const region of Object.values(state.regions)) {
      if (region.faction === 'YONG') region.taxOutput = 0;
    }
    state.factions.YONG.resources.cash = 0;
    const first: GameEvent[] = [];
    runEconomy(state, ctx, first);
    expect(first.filter((event) => event.title.includes('国库透支'))).toHaveLength(1);

    const second: GameEvent[] = [];
    runEconomy(state, ctx, second);
    expect(second.filter((event) => event.title.includes('国库透支'))).toHaveLength(0);
  });
});
