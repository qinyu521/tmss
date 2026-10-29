import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyDeath,
  applyUnitNames,
  buildContext,
  createGame,
  isCharacterAlive,
  migrateState,
  runTurn,
  type GameEvent,
  type GameState,
  type SeedRoster,
} from './index.js';

const seedPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../data/source/tianming_world_roster_v0_3_1.json',
);
const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8')) as SeedRoster;
applyUnitNames(seed.military_units);
const ctx = buildContext(seed);

const newGame = (factionKey: 'HUN' | 'YONG' | 'CHU', gameId = 'life-test', seedNo = 424242): GameState =>
  createGame(seed, { gameId, factionKey, playerRole: 'ruler', seed: seedNo });

/** 固定种子连跑 60 回合，汇总全部事件。 */
function run60(factionKey: 'HUN' | 'YONG' | 'CHU', seedNo: number) {
  let state = newGame(factionKey, `g-${factionKey}-${seedNo}`, seedNo);
  const allEvents: GameEvent[] = [];
  for (let i = 0; i < 60; i++) {
    const r = runTurn(state, ctx);
    state = r.state;
    allEvents.push(...r.report.events);
  }
  return { state, allEvents };
}

const deathList = (state: GameState) =>
  Object.values(state.characters)
    .filter((c) => !c.alive)
    .map((c) => `${c.personId}:${c.deathCause}@${c.deathTurn}`)
    .sort();

describe('生命周期', () => {
  it('60 回合：每名死者都有 succession 事件，州府主官与部队主将均由活人接任', () => {
    const { state, allEvents } = run60('YONG', 424242);
    const dead = Object.values(state.characters).filter((c) => !c.alive);
    expect(dead.length).toBeGreaterThan(0);
    const deathEvents = allEvents.filter(
      (e) => e.type === 'succession' && (e.payload as { lifecycle?: boolean } | undefined)?.lifecycle === true,
    );
    for (const d of dead) {
      expect(deathEvents.some((e) => e.actorId === d.personId)).toBe(true);
      expect(d.deathCause).toBeTruthy();
      expect(d.deathTurn).toBeGreaterThan(0);
    }
    // 继承不变量：任何州府主官/部队主将/部落首领/世家家主/皇子均为在世人物
    for (const region of Object.values(state.regions)) {
      expect(isCharacterAlive(state, region.governorId)).toBe(true);
    }
    for (const army of state.armies) {
      expect(isCharacterAlive(state, army.commanderId)).toBe(true);
    }
    for (const tribe of state.special.HUN.tribes ?? []) {
      expect(isCharacterAlive(state, tribe.chiefId)).toBe(true);
    }
    for (const house of state.special.CHU.houses ?? []) {
      expect(isCharacterAlive(state, house.patriarchId)).toBe(true);
    }
    for (const prince of state.special.YONG.princes ?? []) {
      expect(isCharacterAlive(state, prince.personId)).toBe(true);
    }
    expect(isCharacterAlive(state, state.playerPersonId)).toBe(true);
  });

  it('迁移框架：v1 存档补 characters（全在世）且 schemaVersion 升为 3，且迁移幂等', () => {
    const state = newGame('HUN');
    const legacy = JSON.parse(JSON.stringify(state)) as GameState;
    delete (legacy as Partial<GameState>).characters;
    legacy.schemaVersion = 1;
    const migrated = migrateState(legacy, seed.characters);
    expect(migrated.schemaVersion).toBe(3);
    expect(Object.keys(migrated.characters)).toHaveLength(seed.characters.length);
    expect(Object.values(migrated.characters).every((c) => c.alive)).toBe(true);
    expect(migrated.characters[seed.characters[0].person_id].ageBand).toBe(seed.characters[0].age_band);
    // 幂等：再次迁移不产生变化
    const again = migrateState(JSON.parse(JSON.stringify(migrated)) as GameState, seed.characters);
    expect(again.schemaVersion).toBe(3);
    expect(again.characters).toEqual(migrated.characters);
  });

  it('确定性：同种子两局 60 回合死亡名单完全一致', () => {
    const a = run60('CHU', 777);
    const b = run60('CHU', 777);
    expect(deathList(a.state)).toEqual(deathList(b.state));
    expect(deathList(a.state).length).toBeGreaterThan(0);
  });

  it('玩家君主身故后身份由活人承继，不进入死人视角', () => {
    const state = newGame('YONG');
    const rulerId = state.playerPersonId;
    const char = ctx.charactersById[rulerId];
    expect(char).toBeTruthy();
    const events: GameEvent[] = [];
    applyDeath(state, ctx, events, char, '病逝');
    expect(state.playerPersonId).not.toBe(rulerId);
    expect(isCharacterAlive(state, state.playerPersonId)).toBe(true);
    expect(state.playerRole).toBe('ruler');
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('succession');
    expect(events[0].summary).toContain(state.playerPersonName);
    // 重复死亡结算幂等
    applyDeath(state, ctx, events, char, '病逝');
    expect(events).toHaveLength(1);
  });

  it('成长：第 52 旬高潜力在世人物主属性 +1 并留下备注（上限 95）', () => {
    let state = newGame('HUN', 'growth-test', 424242);
    for (let i = 0; i < 52; i++) {
      state = runTurn(state, ctx).state;
    }
    const grown = Object.values(state.characters).filter((c) => c.growthNote);
    expect(grown.length).toBeGreaterThan(0);
    for (const g of grown) {
      expect(g.alive).toBe(true);
      for (const v of Object.values(g.attrs ?? {})) {
        expect(v).toBeLessThanOrEqual(95);
      }
    }
  });
});
