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
  mortalityChancePerTurn,
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

  it('迁移框架：v1 存档补 characters（全在世）并迁移到当前 schema v6，且迁移幂等', () => {
    const state = newGame('HUN');
    const legacy = JSON.parse(JSON.stringify(state)) as GameState;
    delete (legacy as Partial<GameState>).characters;
    legacy.schemaVersion = 1;
    const migrated = migrateState(legacy, seed.characters, seed);
    expect(migrated.schemaVersion).toBe(6);
    expect(Object.keys(migrated.characters)).toHaveLength(seed.characters.length);
    expect(Object.values(migrated.characters).every((c) => c.alive)).toBe(true);
    expect(migrated.characters[seed.characters[0].person_id].ageBand).toBe(seed.characters[0].age_band);
    // 幂等：再次迁移不产生变化
    const again = migrateState(JSON.parse(JSON.stringify(migrated)) as GameState, seed.characters, seed);
    expect(again.schemaVersion).toBe(6);
    expect(again.characters).toEqual(migrated.characters);
  });

  it('v4 旧存档迁移到 v6 时补齐 idle 目标和条约账本，且重复迁移不重置目标', () => {
    const legacy = JSON.parse(JSON.stringify(newGame('HUN'))) as GameState;
    legacy.schemaVersion = 4;
    for (const runtime of Object.values(legacy.characters)) {
      delete runtime.goal;
      delete runtime.goalTargetId;
      delete runtime.goalSinceTurn;
      delete runtime.goalLastActionTurn;
      delete runtime.goalReason;
    }
    const migrated = migrateState(legacy, seed.characters, seed);
    expect(migrated.schemaVersion).toBe(6);
    expect(Object.values(migrated.characters).every((runtime) => runtime.goal === 'idle')).toBe(true);
    expect(migrated.treaties).toEqual([]);
    const selected = Object.values(migrated.characters)[0];
    selected.goal = 'stabilize_region';
    selected.goalTargetId = 'HUN-REG01';
    selected.goalSinceTurn = 8;
    const again = migrateState(JSON.parse(JSON.stringify(migrated)) as GameState, seed.characters, seed);
    expect(again.schemaVersion).toBe(6);
    expect(again.characters[selected.personId].goal).toBe('stabilize_region');
    expect(again.characters[selected.personId].goalTargetId).toBe('HUN-REG01');
    expect(again.characters[selected.personId].goalSinceTurn).toBe(8);
  });

  it('v5 存档迁移补空条约账本并保留既有人物目标', () => {
    const legacy = JSON.parse(JSON.stringify(newGame('HUN'))) as GameState;
    legacy.schemaVersion = 5;
    delete (legacy as Partial<GameState>).treaties;
    const personId = Object.keys(legacy.characters)[0];
    legacy.characters[personId].goal = 'press_frontier';
    legacy.characters[personId].goalTargetId = 'army-test';
    const migrated = migrateState(legacy, seed.characters, seed);
    expect(migrated.schemaVersion).toBe(6);
    expect(migrated.treaties).toEqual([]);
    expect(migrated.characters[personId].goal).toBe('press_frontier');
    expect(migrated.characters[personId].goalTargetId).toBe('army-test');
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

  it('成长：第 52 回合高潜力在世人物主属性 +1 并留下备注（上限 95）', () => {
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

  it('死亡率按年折算到 7 天回合，老成档单回合低于 0.2%', () => {
    const elder = mortalityChancePerTurn('老成');
    expect(elder).toBeGreaterThan(0.0015);
    expect(elder).toBeLessThan(0.002);
    expect(mortalityChancePerTurn('青年')).toBeLessThan(0.0002);
    // 52 个回合约等于一年，累计应回到 9% 年率附近。
    expect(1 - Math.pow(1 - elder, 365 / 7)).toBeCloseTo(0.09, 2);
  });
});


describe('行军存档迁移', () => {
  it('v2 旧档的节点行军会转换为等价格子路线，迁移可重复执行', () => {
    const legacy = JSON.parse(JSON.stringify(newGame('HUN', 'movement-migration'))) as GameState;
    legacy.schemaVersion = 2;
    const army = legacy.armies.find((a) => a.faction === 'HUN')!;
    const destinations = Object.values(legacy.regions)
      .filter((region) => region.faction === 'HUN' && region.regionId !== army.nodeId)
      .slice(0, 2)
      .map((region) => region.regionId);
    army.path = destinations;
    army.hopCosts = [10, 4];
    army.targetRegionId = destinations[destinations.length - 1];
    army.marchDaysTotal = 14;
    army.marchDaysLeft = 7;
    army.status = 'marching';
    army.stance = 'march';
    delete army.currentHopDaysTotal;

    const migrated = migrateState(legacy, seed.characters, seed);
    const migratedArmy = migrated.armies.find((a) => a.armyId === army.armyId)!;
    expect(migrated.schemaVersion).toBe(6);
    expect(migratedArmy.status).toBe('marching');
    expect(migratedArmy.path).toEqual([]);
    expect(migratedArmy.hopCosts).toEqual([]);
    expect(migratedArmy.tilePath!.length).toBeGreaterThan(0);
    expect(migratedArmy.targetTile).toBeTruthy();
    expect(migratedArmy.tileX).toBeTypeOf('number');
    expect(migratedArmy.tileY).toBeTypeOf('number');
    expect(migratedArmy.targetRegionId).toBe(destinations[destinations.length - 1]);

    const again = migrateState(JSON.parse(JSON.stringify(migrated)) as GameState, seed.characters, seed);
    expect(again.schemaVersion).toBe(6);
    expect(again.armies.find((a) => a.armyId === army.armyId)).toEqual(migratedArmy);
  });
});
