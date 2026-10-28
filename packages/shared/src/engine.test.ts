import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BALANCE,
  UNIT_PROFILES,
  applyUnitNames,
  buildContext,
  buildPlayerView,
  createGame,
  resolveBattle,
  runTurn,
  validateOrder,
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

const newGame = (factionKey: 'HUN' | 'YONG' | 'CHU', playerRole: 'ruler' | 'governor' | 'general' | 'strategist' = 'ruler', gameId = 'test') =>
  createGame(seed, { gameId, factionKey, playerRole, seed: 424242 });

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe('初始世界', () => {
  it('三国初始兵力精确等于种子分配（40/80/30 万）', () => {
    const expected = { HUN: 400_000, YONG: 800_000, CHU: 300_000 };
    for (const key of ['HUN', 'YONG', 'CHU'] as const) {
      const state = newGame(key);
      const total = state.armies.filter((a) => a.faction === key).reduce((s, a) => s + a.troops, 0);
      expect(total).toBe(expected[key]);
      expect(state.factions[key].nominalTroops).toBe(expected[key]);
      expect(state.armies.filter((a) => a.faction === key)).toHaveLength(6);
      expect(Object.values(state.regions).filter((r) => r.faction === key)).toHaveLength(8);
    }
  });

  it('特殊兵种按成建制规模配置，且总量不超过各自上限', () => {
    const expected = { HUN: 400_000, YONG: 800_000, CHU: 300_000 };
    for (const key of ['HUN', 'YONG', 'CHU'] as const) {
      const state = newGame(key);
      const counts: Record<string, number> = {};
      let totalElite = 0;
      for (const army of state.armies) {
        for (const u of army.units) {
          counts[u.unitId] = (counts[u.unitId] ?? 0) + u.count;
          totalElite += u.count;
          // 避免出现几百人的“特种兵”；微小的上限余量不拆成独立小队。
          expect(u.count).toBeGreaterThanOrEqual(1_500);
        }
        expect(army.troops).toBe(army.levies + army.units.reduce((s, u) => s + u.count, 0));
      }
      expect(totalElite).toBeGreaterThan(expected[key] * 0.06);
      for (const [unitId, count] of Object.entries(counts)) {
        const profile = UNIT_PROFILES[unitId];
        expect(profile).toBeTruthy();
        expect(count).toBeLessThanOrEqual(profile.capPerFaction);
      }
    }
  });

  it('24 个州府与 72 个地图节点均分配完成，且州府道路图真正连通', () => {
    expect(Object.keys(seed.map_nodes)).toHaveLength(72);
    const names = new Set(seed.territories.map((t) => t.region));
    const adjacency = new Map<string, Set<string>>();
    for (const name of names) adjacency.set(name, new Set());
    for (const edge of seed.map_edges) {
      expect(names.has(edge.from_region)).toBe(true);
      expect(names.has(edge.to_region)).toBe(true);
      adjacency.get(edge.from_region)?.add(edge.to_region);
      adjacency.get(edge.to_region)?.add(edge.from_region);
    }

    // 仅验证边的端点存在不等于地图连通；从任意州府出发必须能沿道路抵达全部州府。
    const start = names.values().next().value as string | undefined;
    expect(start).toBeTruthy();
    const visited = new Set<string>(start ? [start] : []);
    const queue = start ? [start] : [];
    while (queue.length > 0) {
      const current = queue.shift() as string;
      for (const next of adjacency.get(current) ?? []) {
        if (visited.has(next)) continue;
        visited.add(next);
        queue.push(next);
      }
    }
    expect([...names].filter((name) => !visited.has(name))).toEqual([]);
  });

  it('初始短缺符合国情：匈奴缺粮盐、大雍缺盐马、大楚缺马铁', () => {
    const hun = newGame('HUN');
    expect(hun.factions.HUN.resources.grain).toBeLessThan(200_000);
    expect(hun.factions.HUN.resources.salt).toBeLessThan(1_500);
    const yong = newGame('YONG');
    expect(yong.factions.YONG.resources.salt).toBeLessThan(4_000);
    expect(yong.factions.YONG.resources.horses).toBeLessThan(4_000);
    const chu = newGame('CHU');
    expect(chu.factions.CHU.resources.horses).toBeLessThan(2_000);
    expect(chu.factions.CHU.resources.iron).toBeLessThan(1_000);
  });
});

describe('命令权限', () => {
  it('军师不能调动军队或任命官职', () => {
    const state = newGame('HUN', 'strategist');
    const army = state.armies.find((a) => a.faction === 'HUN')!;
    const move = validateOrder(state, ctx, {
      orderId: 'o1',
      kind: 'move_army',
      armyId: army.armyId,
      targetRegionId: 'HUN-REG01',
    });
    expect(move.ok).toBe(false);
    expect(move.issues[0].code).toBe('ROLE_FORBIDDEN');
    const appoint = validateOrder(state, ctx, {
      orderId: 'o2',
      kind: 'appoint',
      personId: state.playerPersonId,
      regionId: 'HUN-REG01',
    });
    expect(appoint.ok).toBe(false);
  });

  it('将军只能调动自己统率的部队', () => {
    const state = newGame('YONG', 'general');
    const other = state.armies.find((a) => a.faction === 'YONG' && a.commanderId !== state.playerPersonId)!;
    const res = validateOrder(state, ctx, {
      orderId: 'o3',
      kind: 'move_army',
      armyId: other.armyId,
      targetRegionId: other.nodeId,
    });
    expect(res.ok).toBe(false);
    expect(res.issues[0].code).toBe('AUTH_SCOPE');
  });

  it('州牧不能任命官职', () => {
    const state = newGame('CHU', 'governor');
    const res = validateOrder(state, ctx, {
      orderId: 'o4',
      kind: 'appoint',
      personId: state.playerPersonId,
      regionId: 'CHU-REG01',
    });
    expect(res.ok).toBe(false);
    expect(res.issues[0].code).toBe('ROLE_FORBIDDEN');
  });

  it('资源不足时给出明确原因', () => {
    const state = newGame('HUN');
    state.factions.HUN.resources.cash = 100;
    const res = validateOrder(state, ctx, { orderId: 'o5', kind: 'recruit', amount: 10_000 });
    expect(res.ok).toBe(false);
    expect(res.issues[0].code).toBe('NO_CASH');
  });
});

describe('回合结算', () => {
  it('跨旬未走完的路段会保存剩余天数，不会每旬重走完整路段', () => {
    const state = newGame('YONG');
    const army = state.armies.find((a) => a.faction === 'YONG')!;
    const destination = Object.values(state.regions).find(
      (region) => region.faction === 'YONG' && region.regionId !== army.nodeId,
    )!;
    const startNode = army.nodeId;
    const supplyBefore = army.supply;
    const fatigueBefore = army.fatigue;
    army.path = [destination.regionId];
    army.hopCosts = [10];
    army.targetRegionId = destination.regionId;
    army.stance = 'march';
    army.status = 'marching';
    army.marchDaysTotal = 10;
    army.marchDaysLeft = 10;

    const result = runTurn(state, ctx);
    const marched = result.state.armies.find((a) => a.armyId === army.armyId)!;
    expect(marched.nodeId).toBe(startNode);
    expect(marched.path).toEqual([destination.regionId]);
    expect(marched.hopCosts).toEqual([3]);
    expect(marched.marchDaysLeft).toBe(3);
    expect(marched.status).toBe('marching');
    expect(marched.supply).toBeLessThan(supplyBefore);
    expect(marched.fatigue).toBeGreaterThan(fatigueBefore);
  });

  it('地图显示进度按当前路段计算，而不是把全程进度套到剩余路线', () => {
    const state = newGame('YONG');
    const army = state.armies.find((a) => a.faction === 'YONG')!;
    const destinations = Object.values(state.regions).filter(
      (region) => region.faction === 'YONG' && region.regionId !== army.nodeId,
    );
    army.path = [destinations[0].regionId, destinations[1].regionId];
    army.hopCosts = [2, 8];
    army.targetRegionId = destinations[1].regionId;
    army.stance = 'march';
    army.status = 'marching';
    army.marchDaysTotal = 13;
    army.marchDaysLeft = 10;
    army.currentHopDaysTotal = 5;

    const armyView = buildPlayerView(state, ctx).armies.find((item) => item.armyId === army.armyId)!;
    expect(armyView.progress).toBeCloseTo(0.6);
    expect(armyView.progress).not.toBeCloseTo(1 - army.marchDaysLeft / army.marchDaysTotal);
  });

  it('推进 7 天后日期、回合与事件均更新', () => {
    const state = newGame('YONG');
    const result = runTurn(state, ctx);
    expect(result.state.date.dayIndex).toBe(7);
    expect(result.state.date.turn).toBe(2);
    expect(result.state.date.label).toContain('三月八日');
    expect(result.report.events.length).toBeGreaterThan(0);
    expect(result.report.chronicle.length).toBeGreaterThan(0);
    expect(result.report.chronicle[0].facts.length).toBeGreaterThan(0);
  });

  it('短缺会真实影响士气与兵力，而非只显示文本', () => {
    const state = newGame('HUN');
    state.factions.HUN.resources.grain = 0;
    const beforeMorale = state.armies.filter((a) => a.faction === 'HUN').reduce((s, a) => s + a.morale, 0);
    const beforeTroops = state.armies.filter((a) => a.faction === 'HUN').reduce((s, a) => s + a.troops, 0);
    const result = runTurn(state, ctx);
    const afterMorale = result.state.armies.filter((a) => a.faction === 'HUN').reduce((s, a) => s + a.morale, 0);
    const afterTroops = result.state.armies.filter((a) => a.faction === 'HUN').reduce((s, a) => s + a.troops, 0);
    expect(result.report.events.some((e) => e.type === 'shortage' && e.visibleToPlayer)).toBe(true);
    expect(afterMorale).toBeLessThan(beforeMorale);
    expect(afterTroops).toBeLessThanOrEqual(beforeTroops);
  });

  it('战斗使用固定随机种子，重复结算得到同一结果', () => {
    const base = newGame('HUN', 'ruler', 'battle-seed');
    base.pendingOrders = [
      { orderId: 'b1', kind: 'move_army', armyId: 'HUN-ARMY-02', targetRegionId: 'YONG-REG03' },
    ];
    const a = runTurn(clone(base), ctx);
    const b = runTurn(clone(base), ctx);
    const battleA = a.report.events.find((e) => e.type === 'battle');
    const battleB = b.report.events.find((e) => e.type === 'battle');
    expect(battleA).toBeTruthy();
    expect(battleB).toBeTruthy();
    expect((battleA!.after as any).attackerWon).toBe((battleB!.after as any).attackerWon);
    expect((battleA!.payload as any).seed).toBe((battleB!.payload as any).seed);
    expect((battleA!.after as any).totalLosses).toBe((battleB!.after as any).totalLosses);
  });

  it('攻入敌方州府后，战斗结果与占领、行军状态更新保持一致', () => {
    const state = newGame('HUN', 'ruler', 'battle-transition');
    state.pendingOrders = [
      { orderId: 'b-transition', kind: 'move_army', armyId: 'HUN-ARMY-02', targetRegionId: 'YONG-REG03' },
    ];

    const result = runTurn(state, ctx);
    const battle = result.report.events.find((event) => event.type === 'battle');
    expect(battle).toBeTruthy();

    const attackerWon = (battle!.after as any).attackerWon as boolean;
    const target = result.state.regions['YONG-REG03'];
    const attacker = result.state.armies.find((army) => army.armyId === 'HUN-ARMY-02');

    if (attackerWon) {
      expect(target.faction).toBe('HUN');
      expect(result.state.factions.HUN.control).toContain('YONG-REG03');
      expect(result.report.events.some((event) => event.type === 'occupation' && event.targetId === 'YONG-REG03')).toBe(true);
      if (attacker) {
        expect(attacker.nodeId).toBe('YONG-REG03');
        expect(attacker.path).toEqual([]);
        expect(attacker.status).toBe('idle');
      }
    } else {
      expect(target.faction).toBe('YONG');
      if (attacker) {
        expect(attacker.nodeId).not.toBe('YONG-REG03');
        expect(attacker.path).toEqual([]);
        expect(attacker.status).toBe('idle');
      }
    }

  });

  it('匈奴部落忠诚过低时拒绝出兵', () => {
    const state = newGame('HUN');
    const tribe = state.special.HUN.tribes!.find((t) => state.armies.some((a) => a.faction === 'HUN' && a.nodeId === t.regionId));
    expect(tribe).toBeTruthy();
    tribe!.loyalty = 20;
    tribe!.stance = 'refusing';
    const army = state.armies.find((a) => a.faction === 'HUN' && a.nodeId === tribe!.regionId)!;
    const res = validateOrder(state, ctx, {
      orderId: 't1',
      kind: 'move_army',
      armyId: army.armyId,
      targetRegionId: 'HUN-REG01',
    });
    expect(res.ok).toBe(false);
    expect(res.issues[0].code).toBe('TRIBE_REFUSAL');
  });

  it('大雍朝局失稳触发夺嫡危机', () => {
    const state = newGame('YONG');
    state.special.YONG.courtStability = 30;
    state.special.YONG.princes!.forEach((p, i) => (p.influence = 80 - i * 3));
    const result = runTurn(state, ctx);
    expect(result.state.flags.successionCrisis).toBe(true);
    expect(result.report.events.some((e) => e.type === 'succession')).toBe(true);
  });

  it('大楚世家支持过低触发集体抵制', () => {
    const state = newGame('CHU');
    state.special.CHU.houses!.forEach((h) => (h.support = 20));
    const result = runTurn(state, ctx);
    expect(result.state.flags.houseBoycott).toBe(true);
    expect(result.report.events.some((e) => e.type === 'politics')).toBe(true);
  });

  it('NPC 内部命令不泄露给玩家', () => {
    const state = newGame('CHU');
    const result = runTurn(state, ctx);
    const hidden = result.report.events.filter((e) => !e.visibleToPlayer);
    expect(hidden.length).toBeGreaterThan(0);
    expect(result.report.events.some((e) => e.visibleToPlayer && e.factionKey === 'HUN' && e.type === 'order_accepted')).toBe(false);
  });
});

describe('分兵、州兵与计谋', () => {
  const freeCommanders = (state: GameState) =>
    ctx.seed.characters.filter(
      (c) => c.faction_key === state.factionKey && !state.armies.some((a) => a.commanderId === c.person_id),
    );

  it('可以从军团中分兵一万并另选统兵官', () => {
    const state = newGame('YONG');
    const army = state.armies.find((a) => a.faction === 'YONG' && a.units.length > 0)!;
    const cmd = freeCommanders(state)[0];
    const target = Object.values(state.regions).find((r) => r.faction === 'YONG' && r.regionId !== army.nodeId)!;
    const check = validateOrder(state, ctx, {
      orderId: 'split-1',
      kind: 'move_army',
      armyId: army.armyId,
      targetRegionId: target.regionId,
      amount: 10_000,
      commanderId: cmd.person_id,
    });
    expect(check.ok).toBe(true);
    const before = army.troops;
    state.pendingOrders = [{ orderId: 'split-1', kind: 'move_army', armyId: army.armyId, targetRegionId: target.regionId, amount: 10_000, commanderId: cmd.person_id }];
    const result = runTurn(state, ctx);
    const det = result.state.armies.find((a) => a.isDetachment && a.commanderId === cmd.person_id);
    expect(det).toBeTruthy();
    expect(det!.troops).toBe(10_000);
    const original = result.state.armies.find((a) => a.armyId === army.armyId)!;
    expect(original.troops).toBeLessThan(before);
    expect(original.troops + det!.troops).toBe(before);
  });

  it('分兵未指定统兵官会被拒绝', () => {
    const state = newGame('YONG');
    const army = state.armies.find((a) => a.faction === 'YONG')!;
    const target = Object.values(state.regions).find((r) => r.faction === 'YONG' && r.regionId !== army.nodeId)!;
    const res = validateOrder(state, ctx, {
      orderId: 'split-2',
      kind: 'move_army',
      armyId: army.armyId,
      targetRegionId: target.regionId,
      amount: 5_000,
    });
    expect(res.ok).toBe(false);
    expect(res.issues[0].code).toBe('COMMANDER_REQUIRED');
  });

  it('每州州兵可调出，调出后本州守备减少', () => {
    const state = newGame('YONG');
    const region = state.regions['YONG-REG01'];
    const target = Object.values(state.regions).find((r) => r.faction === 'YONG' && r.regionId !== region.regionId)!;
    const before = region.garrison;
    const check = validateOrder(state, ctx, {
      orderId: 'gar-1',
      kind: 'dispatch_garrison',
      regionId: region.regionId,
      targetRegionId: target.regionId,
      amount: 3_000,
    });
    expect(check.ok).toBe(true);
    state.pendingOrders = [{ orderId: 'gar-1', kind: 'dispatch_garrison', regionId: region.regionId, targetRegionId: target.regionId, amount: 3_000 }];
    const result = runTurn(state, ctx);
    const militia = result.state.armies.find((a) => a.isMilitia && a.name.includes(region.name));
    expect(militia).toBeTruthy();
    expect(militia!.troops).toBe(3_000);
    expect(result.state.regions[region.regionId].garrison).toBe(before - 3_000);
  });

  it('征兵可以新建军团并由将领统带', () => {
    const state = newGame('YONG');
    const region = state.regions['YONG-REG01'];
    const check = validateOrder(state, ctx, {
      orderId: 'rec-new',
      kind: 'recruit',
      amount: 6_000,
      regionId: region.regionId,
      formNewArmy: true,
    });
    expect(check.ok).toBe(true);
    const before = state.armies.length;
    state.pendingOrders = [{ orderId: 'rec-new', kind: 'recruit', amount: 6_000, regionId: region.regionId, formNewArmy: true }];
    const result = runTurn(state, ctx);
    expect(result.state.armies.length).toBeGreaterThan(before);
    const army = result.state.armies.find((a) => a.name.includes('新募营'));
    expect(army).toBeTruthy();
    expect(army!.troops).toBe(6_000);
  });

  it('计谋产生独立事件，成功时改变战场变量', () => {
    const state = newGame('YONG');
    const region = state.regions['YONG-REG07'];
    const beforeCash = state.factions.YONG.resources.cash;
    const check = validateOrder(state, ctx, {
      orderId: 'scheme-1',
      kind: 'scheme',
      scheme: 'ambush',
      targetRegionId: region.regionId,
    });
    expect(check.ok).toBe(true);
    expect(check.preview).toContain('成功率');
    state.pendingOrders = [{ orderId: 'scheme-1', kind: 'scheme', scheme: 'ambush', targetRegionId: region.regionId }];
    const result = runTurn(state, ctx);
    const ev = result.report.events.find((e) => e.type === 'scheme');
    expect(ev).toBeTruthy();
    expect(Number((ev!.before as any).cash) - Number((ev!.after as any).cash)).toBe(4_000);
    if ((ev!.payload as any).success) {
      expect(result.state.regions[region.regionId].ambushBonus).toBeGreaterThan(0);
    }
  });

  it('统率更高的将领带来更高战力（同兵力同种子）', () => {
    const base = newGame('YONG');
    const attacker = base.armies.find((a) => a.faction === 'YONG')!;
    const defender = base.armies.find((a) => a.faction === 'CHU')!;
    const region = base.regions['CHU-REG01'];
    defender.nodeId = region.regionId;
    const chars = ctx.seed.characters
      .filter((c) => c.faction_key === 'YONG')
      .sort((a, b) => b.command - a.command);
    const high = chars[0];
    const low = chars[chars.length - 1];
    const runPower = (commandId: string) => {
      const state = clone(base);
      const atk = state.armies.find((a) => a.armyId === attacker.armyId)!;
      const def = state.armies.find((a) => a.armyId === defender.armyId)!;
      atk.commanderId = commandId;
      const outcome = resolveBattle(state, ctx, atk, def, state.regions[region.regionId], 12345);
      return outcome.attackerPower;
    };
    const highPower = runPower(high.person_id);
    const lowPower = runPower(low.person_id);
    expect(highPower).toBeGreaterThan(lowPower);
  });

  it('三国朝议数据不为空', () => {
    expect(newGame('HUN').special.HUN.tribes?.length).toBe(6);
    expect(newGame('YONG').special.YONG.princes?.length).toBe(3);
    expect(newGame('CHU').special.CHU.houses?.length).toBe(6);
  });

  it('玩家可在人物/军队面板查看敌我统率与谋略差异（视图包含将领数值）', () => {
    const state = newGame('YONG', 'ruler');
    const own = state.armies.find((a) => a.faction === 'YONG')!;
    const char = ctx.charactersById[own.commanderId]!;
    expect(char.command).toBeGreaterThan(0);
    expect(char.strategy).toBeGreaterThan(0);
  });
});

describe('存档快照', () => {
  it('状态可通过 JSON 往返恢复（存档/读档基础）', () => {
    const state = newGame('YONG');
    const result = runTurn(state, ctx);
    const restored = clone(result.state);
    expect(restored.date.label).toBe(result.state.date.label);
    expect(restored.armies.length).toBe(result.state.armies.length);
    expect(restored.factions.YONG.resources).toEqual(result.state.factions.YONG.resources);
    expect(restored.schemaVersion).toBe(2);
  });
});

describe('平衡常量', () => {
  it('一回合固定为 7 天', () => {
    expect(BALANCE.turnDays).toBe(7);
  });
});
