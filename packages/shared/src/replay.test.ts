import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyUnitNames,
  buildBattleReplay,
  buildContext,
  createGame,
  runTurn,
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

/** 用固定种子真实结算一场战斗，取回 battle 事件（格子行军跨回合，逐旬推进至遭遇）。 */
function realBattleEvent(): GameEvent {
  let state = createGame(seed, { gameId: 'replay-test', factionKey: 'HUN', playerRole: 'ruler', seed: 424242 });
  for (let turn = 0; turn < 8; turn++) {
    const army = state.armies.find((item) => item.armyId === 'HUN-ARMY-02');
    state.pendingOrders =
      army && army.status !== 'marching'
        ? [{ orderId: `b${turn}`, kind: 'move_army', armyId: 'HUN-ARMY-02', targetRegionId: 'YONG-REG03' }]
        : [];
    const result = runTurn(state, ctx);
    const ev = result.report.events.find((e) => e.type === 'battle');
    if (ev) return ev;
    state = result.state;
  }
  throw new Error('固定种子下未产生战斗事件');
}

describe('战报回放', () => {
  it('同一事件两次构建结果深相等（确定性）', () => {
    const ev = realBattleEvent();
    const a = buildBattleReplay(ev);
    const b = buildBattleReplay(ev);
    expect(a).toEqual(b);
  });

  it('最终阶段兵力与事件 after 完全一致，阶段数 3-6，伤亡单调且合计不矛盾', () => {
    const ev = realBattleEvent();
    const after = ev.after as Record<string, number>;
    const replay = buildBattleReplay(ev);
    expect(replay.stages.length).toBeGreaterThanOrEqual(3);
    expect(replay.stages.length).toBeLessThanOrEqual(6);

    const last = replay.stages[replay.stages.length - 1];
    expect(last.attackerTroops).toBe(after.attackerRemaining);
    expect(last.defenderTroops).toBe(after.defenderRemaining);
    expect(last.key).toBe('decisive');

    const sumA = replay.stages.reduce((s, st) => s + st.attackerLosses, 0);
    const sumD = replay.stages.reduce((s, st) => s + st.defenderLosses, 0);
    expect(sumA).toBe(replay.initialAttackerTroops - after.attackerRemaining);
    expect(sumD).toBe(replay.initialDefenderTroops - after.defenderRemaining);

    for (let i = 1; i < replay.stages.length; i++) {
      expect(replay.stages[i].attackerTroops).toBeLessThanOrEqual(replay.stages[i - 1].attackerTroops);
      expect(replay.stages[i].defenderTroops).toBeLessThanOrEqual(replay.stages[i - 1].defenderTroops);
    }
    expect(replay.stages[0].attackerTroops).toBeLessThanOrEqual(replay.initialAttackerTroops);
  });

  it('含伏兵加成的事件回放中出现伏兵阶段', () => {
    const ev = realBattleEvent();
    const withAmbush: GameEvent = {
      ...ev,
      payload: { ...(ev.payload as Record<string, unknown>), ambushBonus: 0.15 },
    };
    const replay = buildBattleReplay(withAmbush);
    const ambush = replay.stages.find((s) => s.key === 'ambush');
    expect(ambush).toBeTruthy();
    expect(ambush!.text).toContain('伏兵');
    expect(replay.stages.length).toBe(4);
  });

  it('佯攻与迂回加成也会生成对应阶段（阶段数最多 6）', () => {
    const ev = realBattleEvent();
    const withAll: GameEvent = {
      ...ev,
      payload: {
        ...(ev.payload as Record<string, unknown>),
        ambushBonus: 0.15,
        maneuverBonus: 0.12,
        diversionBonus: 0.1,
      },
    };
    const replay = buildBattleReplay(withAll);
    expect(replay.stages.map((s) => s.key)).toEqual(['diversion', 'engage', 'ambush', 'maneuver', 'grind', 'decisive']);
    expect(replay.stages.find((s) => s.key === 'maneuver')!.text).toContain('迂回');
    expect(replay.stages.find((s) => s.key === 'diversion')!.text).toContain('佯攻');
    const last = replay.stages[replay.stages.length - 1];
    const after = ev.after as Record<string, number>;
    expect(last.attackerTroops).toBe(after.attackerRemaining);
    expect(last.defenderTroops).toBe(after.defenderRemaining);
  });

  it('非战斗事件抛出错误', () => {
    const ev = realBattleEvent();
    expect(() => buildBattleReplay({ ...ev, type: 'army_move' })).toThrow('NOT_BATTLE_EVENT');
  });
});
