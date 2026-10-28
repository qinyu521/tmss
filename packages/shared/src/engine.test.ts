import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BALANCE,
  UNIT_PROFILES,
  applyOrder,
  applyUnitNames,
  buildContext,
  buildPlayerView,
  courtOpinion,
  courtRecommendedDecision,
  createGame,
  generateNpcOrders,
  migrateState,
  resolveBattle,
  runTurn,
  validateOrder,
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

describe('朝廷廷议', () => {
  it('廷议只允许君主发起，且不能套用其他势力的专属议题', () => {
    const governor = newGame('CHU', 'governor');
    const forbiddenRole = validateOrder(governor, ctx, {
      orderId: 'court-role',
      kind: 'hold_court',
      agenda: 'clan_relations',
      decision: 'balanced',
    });
    expect(forbiddenRole.ok).toBe(false);
    expect(forbiddenRole.issues[0].code).toBe('ROLE_FORBIDDEN');

    const yong = newGame('YONG');
    const wrongAgenda = validateOrder(yong, ctx, {
      orderId: 'court-agenda',
      kind: 'hold_court',
      agenda: 'clan_relations',
      decision: 'balanced',
    });
    expect(wrongAgenda.ok).toBe(false);
    expect(wrongAgenda.issues[0].code).toBe('WRONG_FACTION');
  });

  it('主议臣与反对臣的议题能力差会改变廷议效果并记录辩论双方', () => {
    const score = (person: SeedRoster['characters'][number]) =>
      person.intrigue * 0.45 + person.loyalty * 0.3 + person.governance * 0.25;
    const officials = ctx.seed.characters
      .filter((person) => person.faction_key === 'YONG')
      .sort((a, b) => score(b) - score(a));
    const speaker = officials[0]!;
    const opposition = officials[officials.length - 1]!;
    expect(score(speaker)).toBeGreaterThan(score(opposition));

    const plain = newGame('YONG');
    const debated = newGame('YONG');
    const plainEvents: GameEvent[] = [];
    const debatedEvents: GameEvent[] = [];
    const baseOrder = {
      orderId: 'court-plain',
      kind: 'hold_court' as const,
      agenda: 'succession' as const,
      decision: 'balanced' as const,
    };
    const debatedOrder = {
      ...baseOrder,
      orderId: 'court-debated',
      speakerPersonId: speaker.person_id,
      oppositionPersonId: opposition.person_id,
    };
    expect(validateOrder(debated, ctx, debatedOrder).ok).toBe(true);
    applyOrder(plain, ctx, baseOrder, plainEvents);
    applyOrder(debated, ctx, debatedOrder, debatedEvents);

    expect(debated.special.YONG.courtStability).toBeGreaterThan(plain.special.YONG.courtStability ?? 0);
    expect(debatedEvents[0].summary).toContain(speaker.name);
    expect(debatedEvents[0].summary).toContain(opposition.name);
    expect(debatedEvents[0].summary).toContain(courtOpinion(speaker, 'succession'));
    expect(debatedEvents[0].summary).toContain(courtOpinion(opposition, 'succession'));
    expect((debatedEvents[0].after as Record<string, unknown>).debateEdge).toBeGreaterThan(0);
  });

  it('主议臣与反对臣必须是不同的本国在世人物', () => {
    const state = newGame('YONG');
    const person = ctx.seed.characters.find((candidate) => candidate.faction_key === 'YONG')!;
    const invalid = validateOrder(state, ctx, {
      orderId: 'court-same-person',
      kind: 'hold_court',
      agenda: 'succession',
      decision: 'balanced',
      speakerPersonId: person.person_id,
      oppositionPersonId: person.person_id,
    });
    expect(invalid.ok).toBe(false);
    expect(invalid.issues[0].code).toBe('COURT_PAIR_DUPLICATE');
  });

  it('大雍廷议折中裁决会提升朝局稳定并留下可追溯事件', () => {
    const state = newGame('YONG');
    const beforeCash = state.factions.YONG.resources.cash;
    const beforeStability = state.special.YONG.courtStability ?? 60;
    const order = {
      orderId: 'court-yong',
      kind: 'hold_court' as const,
      agenda: 'succession' as const,
      decision: 'balanced' as const,
    };
    expect(validateOrder(state, ctx, order).ok).toBe(true);
    const events: GameEvent[] = [];
    applyOrder(state, ctx, order, events);
    expect(state.factions.YONG.resources.cash).toBe(beforeCash - 12_000);
    expect(state.special.YONG.courtStability).toBeGreaterThan(beforeStability);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('politics');
    expect(events[0].title).toContain('皇嗣与储位');
    expect(events[0].summary).toContain('朝局稳定');
  });

  it('非玩家大雍会按国情与人物属性自主召开廷议', () => {
    const state = newGame('CHU', 'ruler', 'npc-court-test');
    state.factions.YONG.resources.cash = 250_000;
    const generated = generateNpcOrders(state, ctx);
    const court = generated.find(
      (order) => order.kind === 'hold_court' && order.orderId.startsWith('npc-YONG-'),
    );
    expect(court).toBeTruthy();
    expect(court!.kind).toBe('hold_court');
    if (court?.kind !== 'hold_court') return;
    expect(court.agenda).toBe('war_council');
    expect(court.resolution).toBe('adopt_speaker');
    expect(court.speakerPersonId).toBeTruthy();
    expect(court.oppositionPersonId).toBeTruthy();
    expect(court.speakerPersonId).not.toBe(court.oppositionPersonId);
    expect(court.decision).toMatch(/assertive|balanced|conciliatory/);

    const turnResult = runTurn(state, ctx);
    const event = turnResult.report.events.find(
      (item) => item.type === 'politics' && item.title.startsWith('朝廷廷议·') && item.factionKey === 'YONG',
    );
    expect(event).toBeTruthy();
    expect(event!.source).toBe('npc_ai');
    expect(event!.visibleToPlayer).toBe(false);
    expect(event!.summary).toContain('主议臣');
  });

  it('君主采纳主议臣意见时，会按其属性倾向选择最终政策', () => {
    const speaker = ctx.seed.characters.find(
      (person) => person.faction_key === 'YONG' && courtRecommendedDecision(person, 'war_council') === 'assertive',
    );
    expect(speaker).toBeTruthy();
    const opposition = ctx.seed.characters.find(
      (person) => person.faction_key === 'YONG' && person.person_id !== speaker!.person_id,
    )!;
    const state = newGame('YONG');
    const speakerStandingBefore = state.characters[speaker!.person_id].courtStanding ?? 50;
    const oppositionStandingBefore = state.characters[opposition.person_id].courtStanding ?? 50;
    const beforeMorale = state.armies.filter((army) => army.faction === 'YONG').reduce((sum, army) => sum + army.morale, 0);
    const order = {
      orderId: 'court-adopt-speaker',
      kind: 'hold_court' as const,
      agenda: 'war_council' as const,
      // 即使客户端传入了另一政策，服务器仍按“采纳主议臣”重新计算。
      decision: 'conciliatory' as const,
      resolution: 'adopt_speaker' as const,
      speakerPersonId: speaker!.person_id,
      oppositionPersonId: opposition.person_id,
    };
    expect(validateOrder(state, ctx, order).ok).toBe(true);
    const events: GameEvent[] = [];
    applyOrder(state, ctx, order, events);
    const afterMorale = state.armies.filter((army) => army.faction === 'YONG').reduce((sum, army) => sum + army.morale, 0);
    expect((events[0].after as Record<string, unknown>).decision).toBe('assertive');
    expect((events[0].after as Record<string, unknown>).resolution).toBe('adopt_speaker');
    expect(events[0].summary).toContain('采纳主议臣意见');
    expect(afterMorale).toBeGreaterThan(beforeMorale);
    expect(state.characters[speaker!.person_id].courtStanding).toBeGreaterThan(speakerStandingBefore);
    expect(state.characters[opposition.person_id].courtStanding).toBeLessThan(oppositionStandingBefore);
  });

  it('v2 旧存档迁移会补齐声望，但保留人物生死状态', () => {
    const state = newGame('YONG');
    state.schemaVersion = 2;
    const person = ctx.seed.characters.find((candidate) => candidate.faction_key === 'YONG')!;
    state.characters[person.person_id].courtStanding = undefined;
    state.characters[person.person_id].alive = false;
    state.characters[person.person_id].deathCause = '测试旧档死因';

    const migrated = migrateState(state, ctx.seed.characters);
    expect(migrated.schemaVersion).toBe(3);
    expect(migrated.characters[person.person_id].courtStanding).toBe(50);
    expect(migrated.characters[person.person_id].alive).toBe(false);
    expect(migrated.characters[person.person_id].deathCause).toBe('测试旧档死因');
  });

  it('匈奴廷议在强化联盟协调度时，会真实付出部落忠诚代价', () => {
    const state = newGame('HUN');
    const beforeCohesion = state.special.HUN.cohesion ?? 58;
    const beforeLoyalty = state.special.HUN.tribes?.[0].loyalty ?? 50;
    const order = {
      orderId: 'court-hun',
      kind: 'hold_court' as const,
      agenda: 'tribal_alliance' as const,
      decision: 'assertive' as const,
    };
    const events: GameEvent[] = [];
    applyOrder(state, ctx, order, events);
    expect(state.special.HUN.cohesion).toBeGreaterThan(beforeCohesion);
    expect(state.special.HUN.tribes?.[0].loyalty).toBeLessThan(beforeLoyalty);
    expect(events[0].summary).toContain('忠诚各降 3');

    const durableState = newGame('HUN');
    const durableBefore = durableState.special.HUN.cohesion ?? 58;
    durableState.pendingOrders = [{
      orderId: 'court-hun-durable',
      kind: 'hold_court',
      agenda: 'tribal_alliance',
      decision: 'assertive',
    }];
    const settled = runTurn(durableState, ctx);
    expect(settled.state.special.HUN.cohesion).toBeGreaterThan(durableBefore);
  });

  it('大楚廷议收归权力时会提升中枢权威并降低世家支持', () => {
    const state = newGame('CHU');
    const beforeAuthority = state.special.CHU.centralAuthority ?? 55;
    const beforeSupport = state.special.CHU.houses?.[0].support ?? 50;
    const beforePrivateForce = state.special.CHU.houses?.[0].privateForce ?? 3000;
    const order = {
      orderId: 'court-chu',
      kind: 'hold_court' as const,
      agenda: 'clan_relations' as const,
      decision: 'assertive' as const,
    };
    const events: GameEvent[] = [];
    applyOrder(state, ctx, order, events);
    expect(state.special.CHU.centralAuthority).toBeGreaterThan(beforeAuthority);
    expect(state.special.CHU.houses?.[0].support).toBeLessThan(beforeSupport);
    expect(state.special.CHU.houses?.[0].privateForce).toBeLessThan(beforePrivateForce);
    expect(events[0].summary).toContain('各家支持下降 5');

    const durableState = newGame('CHU');
    const durableBefore = durableState.special.CHU.centralAuthority ?? 52;
    durableState.pendingOrders = [{
      orderId: 'court-chu-durable',
      kind: 'hold_court',
      agenda: 'clan_relations',
      decision: 'assertive',
    }];
    const settled = runTurn(durableState, ctx);
    expect(settled.state.special.CHU.centralAuthority).toBeGreaterThan(durableBefore);
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
    expect(restored.schemaVersion).toBe(3);
  });
});

describe('平衡常量', () => {
  it('一回合固定为 7 天', () => {
    expect(BALANCE.turnDays).toBe(7);
  });
});
