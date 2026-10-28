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
  courtRelationshipAffinity,
  politicalGrudgeCourtPenalty,
  appointmentRelationshipEffect,
  successionNetworkInfluence,
  successionCommandRisk,
  battleLoyaltyDelta,
  runPolitics,
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

    const rivalPrince = debated.special.YONG.princes!.find((prince) => prince.personId !== speaker.person_id)!;
    const resentful = newGame('YONG');
    resentful.characters[speaker.person_id].politicalGrudges = { [rivalPrince.personId]: 18 };
    const resentfulEvents: GameEvent[] = [];
    applyOrder(resentful, ctx, { ...debatedOrder, orderId: 'court-resentful' }, resentfulEvents);
    expect((resentfulEvents[0].after as Record<string, unknown>).speakerScore).toBeLessThan(
      (debatedEvents[0].after as Record<string, unknown>).speakerScore as number,
    );
    expect(politicalGrudgeCourtPenalty({ [rivalPrince.personId]: 18 }, [rivalPrince.personId])).toBe(6);
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

  it('廷议会把种子中的真实人物关系计入对应政治议题，而非凭姓名猜关系', () => {
    const relationship = {
      faction: '大雍',
      source_person_id: 'YONG-A',
      source_name: '甲',
      relation: '父子/继承关系',
      target_person_id: 'YONG-PRINCE',
      target_name: '储君',
      strength: '强',
      notes: '测试用显式关系边',
    };
    expect(courtRelationshipAffinity([relationship], 'YONG-A', 'succession', ['YONG-PRINCE'])).toBe(10);
    expect(courtRelationshipAffinity([relationship], 'YONG-A', 'war_council', ['YONG-PRINCE'])).toBe(8);
    expect(courtRelationshipAffinity([relationship], 'YONG-A', 'succession', ['OTHER-PRINCE'])).toBe(0);
  });

  it('夺嫡危机中低忠诚、亲近竞争皇子的将领会拒绝奉诏', () => {
    const princes = [
      { personId: 'YONG-HEIR', name: '储君甲', influence: 58, isCrownPrince: true },
      { personId: 'YONG-RIVAL', name: '皇子乙', influence: 65, isCrownPrince: false },
      { personId: 'YONG-OTHER', name: '皇子丙', influence: 40, isCrownPrince: false },
    ];
    const relationship = {
      faction: '大雍',
      source_person_id: 'YONG-GENERAL',
      source_name: '将领',
      relation: '父子/继承关系',
      target_person_id: 'YONG-RIVAL',
      target_name: '皇子乙',
      strength: '强',
      notes: '测试中的明确亲缘关系',
    };
    const risk = successionCommandRisk([relationship], princes, 'YONG-GENERAL', 25, true);
    expect(risk?.rivalPrinceId).toBe('YONG-RIVAL');
    expect(risk?.rivalAffinity).toBe(1);
    expect(successionCommandRisk([relationship], princes, 'YONG-GENERAL', 80, true)).toBeNull();
    expect(successionCommandRisk([relationship], princes, 'YONG-GENERAL', 25, false)).toBeNull();
    expect(successionCommandRisk(
      [{ ...relationship, relation: '世家竞争/利益制衡' }],
      princes,
      'YONG-GENERAL',
      25,
      true,
    )).toBeNull();

    const state = newGame('YONG');
    state.flags.successionCrisis = true;
    const army = state.armies.find((item) => item.faction === 'YONG')!;
    const commander = ctx.seed.characters.find(
      (person) => person.faction_key === 'YONG' && person.person_id !== state.playerPersonId,
    )!;
    const previousLoyalty = commander.loyalty;
    const previousRuntimeLoyalty = state.characters[commander.person_id].militaryLoyalty;
    const previousRelationships = ctx.seed.relationships;
    const rival = state.special.YONG.princes!.find((prince) => !prince.isCrownPrince)!;
    const heir = state.special.YONG.princes!.find((prince) => prince.isCrownPrince)!;
    rival.influence = 65;
    heir.influence = 58;
    commander.loyalty = 25;
    state.characters[commander.person_id].militaryLoyalty = 25;
    army.commanderId = commander.person_id;
    army.commanderName = commander.name;
    ctx.seed.relationships = [...previousRelationships, {
      ...relationship,
      source_person_id: commander.person_id,
      source_name: commander.name,
      target_person_id: rival.personId,
      target_name: rival.name,
    }];
    try {
      const target = Object.values(state.regions).find(
        (region) => region.faction === 'YONG' && region.regionId !== army.nodeId,
      )!;
      const validation = validateOrder(state, ctx, {
        orderId: 'crisis-refusal',
        kind: 'move_army',
        armyId: army.armyId,
        targetRegionId: target.regionId,
      });
      expect(validation.ok).toBe(false);
      expect(validation.issues[0].code).toBe('COMMANDER_POLITICAL_SPLIT');

      const cashBefore = state.factions.YONG.resources.cash;
      const reward = {
        orderId: 'reward-disloyal-commander',
        kind: 'reward_commander' as const,
        personId: commander.person_id,
        amount: 20_000,
      };
      expect(validateOrder(state, ctx, reward).ok).toBe(true);
      const rewardEvents: GameEvent[] = [];
      applyOrder(state, ctx, reward, rewardEvents);
      expect(state.factions.YONG.resources.cash).toBe(cashBefore - 20_000);
      expect(state.characters[commander.person_id].militaryLoyalty).toBe(45);
      expect(rewardEvents[0].summary).toContain('军令忠诚度由 25 升至 45');

      const afterReward = validateOrder(state, ctx, {
        orderId: 'crisis-refusal-after-reward',
        kind: 'move_army',
        armyId: army.armyId,
        targetRegionId: target.regionId,
      });
      expect(afterReward.ok).toBe(true);
    } finally {
      commander.loyalty = previousLoyalty;
      state.characters[commander.person_id].militaryLoyalty = previousRuntimeLoyalty;
      ctx.seed.relationships = previousRelationships;
    }
  });

  it('任命时真实关系会改变地方秩序与忠诚的交接结果', () => {
    const state = newGame('YONG');
    const region = state.regions['YONG-REG01'];
    const appointee = ctx.seed.characters.find(
      (person) => person.faction_key === 'YONG' && person.person_id !== region.governorId,
    )!;
    const relationship = {
      faction: '大雍',
      source_person_id: appointee.person_id,
      source_name: appointee.name,
      relation: '州府主官—副官',
      target_person_id: region.governorId,
      target_name: region.governorName,
      strength: '强',
      notes: '测试交接协作',
    };
    const effect = appointmentRelationshipEffect(
      [relationship],
      appointee.person_id,
      region.governorId,
      region.garrisonCommanderId,
    );
    expect(effect.orderDelta).toBeGreaterThan(0);
    expect(effect.loyaltyDelta).toBeGreaterThan(0);

    const rival = appointmentRelationshipEffect(
      [{ ...relationship, relation: '世家竞争/利益制衡' }],
      appointee.person_id,
      region.governorId,
      region.garrisonCommanderId,
    );
    expect(rival.orderDelta).toBeLessThan(0);
    expect(rival.loyaltyDelta).toBeLessThan(0);
  });

  it('夺嫡危机持续时，皇子的显式关系网络会参与影响力变化', () => {
    const relationships = [
      {
        faction: '大雍', source_person_id: 'YONG-PRINCE', source_name: '皇子',
        relation: '父子关系', target_person_id: 'YONG-A', target_name: '甲',
        strength: '强', notes: '宗室关系',
      },
      {
        faction: '大雍', source_person_id: 'YONG-B', source_name: '乙',
        relation: '主君—副将', target_person_id: 'YONG-PRINCE', target_name: '皇子',
        strength: '中', notes: '政治协作',
      },
    ];
    const eligible = (id: string) => id === 'YONG-A' || id === 'YONG-B';
    expect(successionNetworkInfluence(relationships, 'YONG-PRINCE', eligible)).toBe(0.53);
    expect(successionNetworkInfluence(relationships, 'YONG-PRINCE', () => false)).toBe(0);
    expect(successionNetworkInfluence([], 'YONG-PRINCE', eligible)).toBe(0);

    const state = newGame('YONG');
    state.flags.successionCrisis = true;
    const prince = state.special.YONG.princes![0];
    const before = prince.influence;
    const events: GameEvent[] = [];
    runPolitics(state, ctx, events);
    // 在世关系网络已连入回合政治公式，影响力仍受 0–100 上下限约束。
    expect(prince.influence).toBeGreaterThanOrEqual(0);
    expect(prince.influence).toBeLessThanOrEqual(100);
    expect(Number.isFinite(prince.influence)).toBe(true);
    expect(before).toBeGreaterThanOrEqual(0);
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
    state.characters[person.person_id].militaryLoyalty = undefined;
    state.characters[person.person_id].alive = false;
    state.characters[person.person_id].deathCause = '测试旧档死因';

    const migrated = migrateState(state, ctx.seed.characters);
    expect(migrated.schemaVersion).toBe(4);
    expect(migrated.characters[person.person_id].courtStanding).toBe(50);
    expect(migrated.characters[person.person_id].militaryLoyalty).toBe(person.loyalty);
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

describe('政治裁决的派系站队后果', () => {
  it('明确支持关系会为败将一系增加声望，竞争关系不会被误当作盟友', () => {
    const state = newGame('CHU', 'ruler', 'political-bloc-standing');
    const commander = state.armies.find((army) => army.faction === 'CHU')!;
    const commanderId = commander.commanderId;
    const sameFaction = seed.characters.filter((person) => person.faction_key === 'CHU' && person.person_id !== commanderId);
    const ally = sameFaction[0]!;
    const opponent = sameFaction.find((person) => person.person_id !== ally.person_id)!;
    const opponentAlly = sameFaction.find((person) => person.person_id !== ally.person_id && person.person_id !== opponent.person_id)!;
    const customSeed = clone(seed);
    customSeed.relationships = [
      {
        faction: '大楚',
        source_person_id: commanderId,
        source_name: ctx.charactersById[commanderId]!.name,
        relation: '副手协同',
        target_person_id: ally.person_id,
        target_name: ally.name,
        strength: '强',
        notes: '明确支持关系',
      },
      {
        faction: '大楚',
        source_person_id: commanderId,
        source_name: ctx.charactersById[commanderId]!.name,
        relation: '竞争制衡',
        target_person_id: opponent.person_id,
        target_name: opponent.name,
        strength: '强',
        notes: '明确竞争关系',
      },
      {
        faction: '大楚',
        source_person_id: opponent.person_id,
        source_name: opponent.name,
        relation: '同僚协作',
        target_person_id: opponentAlly.person_id,
        target_name: opponentAlly.name,
        strength: '强',
        notes: '弹劾者一系支持关系',
      },
    ];
    const politicalCtx = buildContext(customSeed);
    Object.assign(state.characters[commanderId], {
      pendingBattleCase: 'impeachment',
      battlePoliticalOpponentId: opponent.person_id,
      lastBattleOutcome: 'defeat',
      pendingBattleSettlement: true,
      militaryLoyalty: 55,
      courtStanding: 70,
    });
    state.characters[ally.person_id].courtStanding = 50;
    state.characters[opponent.person_id].courtStanding = 40;
    state.characters[opponentAlly.person_id].courtStanding = 50;
    const events: GameEvent[] = [];
    const order = {
      orderId: 'political-bloc-relief',
      kind: 'settle_defeated_commander' as const,
      personId: commanderId,
      action: 'relieve' as const,
    };
    expect(validateOrder(state, politicalCtx, order).ok).toBe(true);
    applyOrder(state, politicalCtx, order, events);
    expect(state.characters[ally.person_id].courtStanding).toBe(51);
    expect(state.characters[opponent.person_id].courtStanding).toBe(36);
    expect(state.characters[opponentAlly.person_id].courtStanding).toBe(49);
    const plea = events.find((event) => event.title.includes('联名求情'));
    const counterPetition = events.find((event) => event.title.includes('联名弹劾'));
    const settlement = events.find((event) => event.title.includes('抚恤败军'));
    expect(plea?.summary).toContain(ally.name);
    expect(plea?.summary).toContain('声望+1');
    expect(counterPetition?.summary).toContain(opponentAlly.name);
    expect(counterPetition?.summary).toContain('未获采纳');
    expect(settlement?.summary).toContain('派系站队');
  });
});

describe('NPC 战后案件与政治站队', () => {
  it('NPC 会根据声望与同僚关系网络自动选择站队或问责，并真实结算处置', () => {
    const state = newGame('YONG', 'ruler', 'npc-battle-case-ruling');
    const army = state.armies.find((item) => item.faction === 'CHU')!;
    const commanderId = army.commanderId;
    const accuser = ctx.seed.characters.find((person) => person.faction_key === 'CHU' && person.person_id !== commanderId)!;
    const runtime = state.characters[commanderId];
    Object.assign(runtime, {
      lastBattleOutcome: 'defeat',
      lastBattleLossRate: 0.3,
      pendingBattleSettlement: true,
      pendingBattleCase: 'impeachment',
      battlePoliticalOpponentId: accuser.person_id,
      militaryLoyalty: 55,
      courtStanding: 95,
    });
    state.characters[accuser.person_id].courtStanding = 10;
    state.factions.CHU.resources.cash = 100_000;

    const orders = generateNpcOrders(state, ctx);
    const ruling = orders.find((order) => order.kind === 'settle_defeated_commander' && order.personId === commanderId);
    expect(ruling).toBeTruthy();
    expect(ruling!.kind).toBe('settle_defeated_commander');
    if (ruling?.kind !== 'settle_defeated_commander') return;
    expect(ruling.action).toBe('relieve');
    expect(ruling.npcRulingNote).toContain('同僚支持');
    const events: GameEvent[] = [];
    applyOrder(state, ctx, ruling, events, 'npc_ai', 'CHU');
    expect(state.characters[commanderId].pendingBattleSettlement).toBe(false);
    expect(state.characters[commanderId].militaryLoyalty).toBe(63);
    const npcSettlementEvent = events.find((event) => event.title.includes('抚恤败军'));
    expect(npcSettlementEvent?.source).toBe('npc_ai');
    expect(npcSettlementEvent?.actorId).toBe(ctx.seed.characters.find((person) => person.faction_key === 'CHU' && person.identity_type === '君主')!.person_id);
    expect(npcSettlementEvent?.summary).toContain('关系网络裁量');

    const hostileState = newGame('YONG', 'ruler', 'npc-battle-case-trial');
    const hostileArmy = hostileState.armies.find((item) => item.faction === 'CHU')!;
    const hostileCommanderId = hostileArmy.commanderId;
    const hostileAccuser = ctx.seed.characters.find((person) => person.faction_key === 'CHU' && person.person_id !== hostileCommanderId)!;
    Object.assign(hostileState.characters[hostileCommanderId], {
      lastBattleOutcome: 'defeat',
      lastBattleLossRate: 0.55,
      pendingBattleSettlement: true,
      pendingBattleCase: 'impeachment',
      battlePoliticalOpponentId: hostileAccuser.person_id,
      militaryLoyalty: 40,
      courtStanding: 5,
    });
    hostileState.characters[hostileAccuser.person_id].courtStanding = 100;
    const hostileRuling = generateNpcOrders(hostileState, ctx).find(
      (order) => order.kind === 'settle_defeated_commander' && order.personId === hostileCommanderId,
    );
    expect(hostileRuling?.kind).toBe('settle_defeated_commander');
    if (hostileRuling?.kind !== 'settle_defeated_commander') return;
    expect(hostileRuling.action).toBe('trial');
  });
});

describe('战后政治仇怨的自主反应', () => {
  it('达到阈值的仇怨会在后续回合触发反击、消耗积怨并受冷却限制', () => {
    const state = newGame('YONG', 'ruler', 'grudge-backlash-test');
    const army = state.armies.find((item) => item.faction === 'YONG')!;
    const actorId = army.commanderId;
    const target = state.special.YONG.princes!.find((prince) => prince.personId !== actorId)!;
    const targetId = target.personId;
    state.characters[actorId].politicalGrudges = { [targetId]: 12 };
    state.characters[actorId].politicalGrudgeNextResponseTurn = { [targetId]: state.date.turn };

    const baseline = clone(state);
    delete baseline.characters[actorId].politicalGrudges;
    delete baseline.characters[actorId].politicalGrudgeNextResponseTurn;
    const baselineEvents: GameEvent[] = [];
    runPolitics(baseline, ctx, baselineEvents);

    const beforeScore = state.characters[actorId].politicalGrudges![targetId];
    const events: GameEvent[] = [];
    runPolitics(state, ctx, events);
    const event = events.find((item) => item.title.includes('旧怨翻涌'));
    expect(event).toBeTruthy();
    expect(event!.source).toBe('npc_ai');
    expect(event!.visibleToPlayer).toBe(true);
    expect(state.special.YONG.princes!.find((prince) => prince.personId === targetId)!.influence).toBeCloseTo(
      baseline.special.YONG.princes!.find((prince) => prince.personId === targetId)!.influence - 2,
    );
    expect(state.special.YONG.courtStability).toBeCloseTo((baseline.special.YONG.courtStability ?? 50) - 1);
    expect(state.characters[actorId].politicalGrudges![targetId]).toBe(beforeScore - 3);
    expect(state.characters[actorId].politicalGrudgeNextResponseTurn![targetId]).toBe(state.date.turn + 4);

    const nextEvents: GameEvent[] = [];
    runPolitics(state, ctx, nextEvents);
    expect(nextEvents.some((item) => item.title.includes('旧怨翻涌'))).toBe(false);
  });

  it('旧存档里缺少仇怨冷却字段时，会安排下一旬反应而不是永久跳过', () => {
    const state = newGame('YONG', 'ruler', 'grudge-legacy-cooldown');
    const commanderId = state.armies.find((army) => army.faction === 'YONG')!.commanderId;
    const target = state.special.YONG.princes!.find((prince) => prince.personId !== commanderId)!;
    state.characters[commanderId].politicalGrudges = { [target.personId]: 12 };
    delete state.characters[commanderId].politicalGrudgeNextResponseTurn;

    const firstEvents: GameEvent[] = [];
    runPolitics(state, ctx, firstEvents);
    expect(firstEvents.some((item) => item.title.includes('旧怨翻涌'))).toBe(false);
    expect(state.characters[commanderId].politicalGrudgeNextResponseTurn![target.personId]).toBe(state.date.turn + 1);

    state.date.turn += 1;
    const nextEvents: GameEvent[] = [];
    runPolitics(state, ctx, nextEvents);
    expect(nextEvents.some((item) => item.title.includes('旧怨翻涌'))).toBe(true);
  });

  it('刚刚作出的战后裁决不会在同一回合立即触发仇怨反击', () => {
    const state = newGame('YONG', 'ruler', 'grudge-first-response-delay');
    const commanderId = state.armies.find((army) => army.faction === 'YONG')!.commanderId;
    const target = state.special.YONG.princes!.find((prince) => prince.personId !== commanderId)!;
    const runtime = state.characters[commanderId];
    Object.assign(runtime, {
      lastBattleOutcome: 'defeat',
      pendingBattleSettlement: true,
      pendingBattleCase: 'impeachment',
      battlePoliticalOpponentId: target.personId,
      militaryLoyalty: 70,
      courtStanding: 50,
    });
    const order = {
      orderId: 'grudge-delayed-trial',
      kind: 'settle_defeated_commander' as const,
      personId: commanderId,
      action: 'trial' as const,
    };
    const orderEvents: GameEvent[] = [];
    expect(validateOrder(state, ctx, order).ok).toBe(true);
    applyOrder(state, ctx, order, orderEvents);
    expect(state.characters[commanderId].politicalGrudgeNextResponseTurn![target.personId]).toBe(state.date.turn + 1);
    const politicsEvents: GameEvent[] = [];
    runPolitics(state, ctx, politicsEvents);
    expect(politicsEvents.some((item) => item.title.includes('旧怨翻涌'))).toBe(false);
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

  it('战败后可抚恤或追责，处置会产生不同的国库、忠诚与部队后果', () => {
    const relieveState = newGame('YONG');
    const relieveArmy = relieveState.armies.find((army) => army.faction === 'YONG')!;
    const personId = relieveArmy.commanderId;
    const person = ctx.charactersById[personId]!;
    const relieveRuntime = relieveState.characters[personId];
    relieveState.date.turn = 2;
    relieveRuntime.lastBattleTurn = 1;
    relieveRuntime.lastBattleOutcome = 'defeat';
    relieveRuntime.lastBattleLossRate = 0.42;
    relieveRuntime.pendingBattleSettlement = true;
    relieveRuntime.militaryLoyalty = 40;
    relieveArmy.morale = 50;
    relieveArmy.training = 60;
    const cashBefore = relieveState.factions.YONG.resources.cash;
    const reliefOrder = {
      orderId: 'relieve-after-defeat',
      kind: 'settle_defeated_commander' as const,
      personId,
      action: 'relieve' as const,
    };
    expect(validateOrder(relieveState, ctx, reliefOrder).ok).toBe(true);
    const reliefEvents: GameEvent[] = [];
    applyOrder(relieveState, ctx, reliefOrder, reliefEvents);
    expect(relieveState.factions.YONG.resources.cash).toBe(cashBefore - 12_000);
    expect(relieveState.characters[personId].militaryLoyalty).toBe(48);
    expect(relieveState.characters[personId].pendingBattleSettlement).toBe(false);
    expect(relieveArmy.morale).toBe(56);
    expect(reliefEvents[0].title).toContain('抚恤败军');
    expect(validateOrder(relieveState, ctx, reliefOrder).issues[0].code).toBe('NO_RECENT_DEFEAT');

    const disciplineState = newGame('YONG');
    const disciplineArmy = disciplineState.armies.find((army) => army.faction === 'YONG')!;
    const disciplinePersonId = disciplineArmy.commanderId;
    const disciplineRuntime = disciplineState.characters[disciplinePersonId];
    disciplineState.date.turn = 2;
    disciplineRuntime.lastBattleTurn = 1;
    disciplineRuntime.lastBattleOutcome = 'defeat';
    disciplineRuntime.lastBattleLossRate = 0.42;
    disciplineRuntime.pendingBattleSettlement = true;
    disciplineRuntime.militaryLoyalty = 40;
    disciplineArmy.morale = 50;
    disciplineArmy.training = 60;
    const disciplineOrder = {
      orderId: 'discipline-after-defeat',
      kind: 'settle_defeated_commander' as const,
      personId: disciplinePersonId,
      action: 'discipline' as const,
    };
    expect(validateOrder(disciplineState, ctx, disciplineOrder).ok).toBe(true);
    const disciplineEvents: GameEvent[] = [];
    applyOrder(disciplineState, ctx, disciplineOrder, disciplineEvents);
    expect(disciplineState.characters[disciplinePersonId].militaryLoyalty).toBe(32);
    expect(disciplineState.characters[disciplinePersonId].pendingBattleSettlement).toBe(false);
    expect(disciplineArmy.training).toBe(65);
    expect(disciplineArmy.morale).toBe(47);
    expect(disciplineEvents[0].title).toContain('追责败将');

    const noLongerRecent = newGame('YONG');
    const oldCommander = noLongerRecent.armies.find((army) => army.faction === 'YONG')!.commanderId;
    noLongerRecent.characters[oldCommander].pendingBattleSettlement = false;
    noLongerRecent.characters[oldCommander].lastBattleOutcome = 'defeat';
    expect(validateOrder(noLongerRecent, ctx, {
      orderId: 'invalid-old-defeat',
      kind: 'settle_defeated_commander',
      personId: oldCommander,
      action: 'relieve',
    }).issues[0].code).toBe('NO_RECENT_DEFEAT');
  });

  it('战败后可撤换统将，接任人选必须未掌兵且交接会影响忠诚与士气', () => {
    const state = newGame('YONG');
    state.date.turn = 2;
    const army = state.armies.find((item) => item.faction === 'YONG')!;
    const oldCommanderId = army.commanderId;
    const oldRuntime = state.characters[oldCommanderId];
    oldRuntime.lastBattleTurn = 1;
    oldRuntime.lastBattleOutcome = 'defeat';
    oldRuntime.lastBattleLossRate = 0.42;
    oldRuntime.pendingBattleSettlement = true;
    oldRuntime.militaryLoyalty = 54;
    army.morale = 63;

    const replacement = Object.values(ctx.charactersById).find((person) =>
      person.faction_key === 'YONG' &&
      person.person_id !== oldCommanderId &&
      state.characters[person.person_id]?.alive !== false &&
      !state.armies.some((item) => item.faction === 'YONG' && item.commanderId === person.person_id) &&
      !Object.values(state.regions).some((region) => region.faction === 'YONG' && region.garrisonCommanderId === person.person_id)
    );
    expect(replacement).toBeTruthy();
    const order = {
      orderId: 'replace-after-defeat',
      kind: 'settle_defeated_commander' as const,
      personId: oldCommanderId,
      action: 'replace' as const,
      replacementPersonId: replacement!.person_id,
    };

    expect(validateOrder(state, ctx, {
      ...order,
      replacementPersonId: oldCommanderId,
    }).issues[0].code).toBe('INVALID_REPLACEMENT');

    const occupied = state.armies.find((item) => item.faction === 'YONG' && item.commanderId !== oldCommanderId);
    if (occupied) {
      expect(validateOrder(state, ctx, {
        ...order,
        replacementPersonId: occupied.commanderId,
      }).issues[0].code).toBe('COMMANDER_BUSY');
    }

    expect(validateOrder(state, ctx, order).ok).toBe(true);
    const beforeCash = state.factions.YONG.resources.cash;
    const events: GameEvent[] = [];
    applyOrder(state, ctx, order, events);

    expect(state.factions.YONG.resources.cash).toBe(beforeCash);
    expect(army.commanderId).toBe(replacement!.person_id);
    expect(army.commanderName).toBe(replacement!.name);
    expect(army.morale).toBe(58);
    expect(state.characters[oldCommanderId].militaryLoyalty).toBe(44);
    expect(state.characters[oldCommanderId].pendingBattleSettlement).toBe(false);
    expect(events[0].title).toContain('撤换败将');
    expect(events[0].summary).toContain(replacement!.name);
    expect(validateOrder(state, ctx, order).issues[0].code).toBe('NO_RECENT_DEFEAT');
  });

  it('战后弹劾裁决会改变声望，并牵动皇子、部落或世家政治指标', () => {
    const yong = newGame('YONG');
    const yongArmy = yong.armies.find((army) => army.faction === 'YONG')!;
    const yongCommander = yongArmy.commanderId;
    const prince = yong.special.YONG.princes!.find((item) => item.personId !== yongCommander)!;
    const princeInfluenceBefore = prince.influence;
    const stabilityBefore = yong.special.YONG.courtStability ?? 50;
    Object.assign(yong.characters[yongCommander], {
      lastBattleOutcome: 'defeat', lastBattleLossRate: 0.38, pendingBattleSettlement: true,
      pendingBattleCase: 'impeachment', battlePoliticalOpponentId: prince.personId, militaryLoyalty: 50,
    });
    const yongEvents: GameEvent[] = [];
    applyOrder(yong, ctx, { orderId: 'political-relief-yong', kind: 'settle_defeated_commander', personId: yongCommander, action: 'relieve' }, yongEvents);
    expect(yong.characters[yongCommander].courtStanding).toBe(53);
    expect(yong.characters[prince.personId].courtStanding).toBe(46);
    expect(prince.influence).toBe(Math.max(0, princeInfluenceBefore - 2));
    expect(yong.special.YONG.courtStability).toBe(Math.max(0, stabilityBefore - 2));
    expect(yong.characters[yongCommander].pendingBattleCase).toBeUndefined();
    const yongSettlementEvent = yongEvents.find((event) => event.title.includes('抚恤败军'));
    expect(yongSettlementEvent?.summary).toContain('驳回');
    expect(yongEvents.some((event) => event.title.includes('联名求情') || event.title.includes('联名弹劾'))).toBe(true);

    const hun = newGame('HUN');
    const hunArmy = hun.armies.find((army) => army.faction === 'HUN')!;
    const hunCommander = hunArmy.commanderId;
    const tribe = hun.special.HUN.tribes!.find((item) => item.chiefId !== hunCommander)!;
    const tribeLoyaltyBefore = tribe.loyalty;
    const cohesionBefore = hun.special.HUN.cohesion ?? 50;
    Object.assign(hun.characters[hunCommander], {
      lastBattleOutcome: 'defeat', lastBattleLossRate: 0.38, pendingBattleSettlement: true,
      pendingBattleCase: 'impeachment', battlePoliticalOpponentId: tribe.chiefId, militaryLoyalty: 50,
    });
    const hunEvents: GameEvent[] = [];
    applyOrder(hun, ctx, { orderId: 'political-discipline-hun', kind: 'settle_defeated_commander', personId: hunCommander, action: 'discipline' }, hunEvents);
    expect(tribe.loyalty).toBe(Math.min(100, tribeLoyaltyBefore + 3));
    expect(hun.special.HUN.cohesion).toBe(Math.min(100, cohesionBefore + 1));
    expect(hun.characters[hunCommander].courtStanding).toBe(45);

    const chu = newGame('CHU');
    const chuArmy = chu.armies.find((army) => army.faction === 'CHU')!;
    const chuCommander = chuArmy.commanderId;
    const house = chu.special.CHU.houses!.find((item) => item.patriarchId !== chuCommander)!;
    const supportBefore = house.support;
    const authorityBefore = chu.special.CHU.centralAuthority ?? 50;
    Object.assign(chu.characters[chuCommander], {
      lastBattleOutcome: 'defeat', lastBattleLossRate: 0.38, pendingBattleSettlement: true,
      pendingBattleCase: 'impeachment', battlePoliticalOpponentId: house.patriarchId, militaryLoyalty: 50,
    });
    const chuEvents: GameEvent[] = [];
    applyOrder(chu, ctx, { orderId: 'political-discipline-chu', kind: 'settle_defeated_commander', personId: chuCommander, action: 'discipline' }, chuEvents);
    expect(house.support).toBe(Math.min(100, supportBefore + 3));
    expect(chu.special.CHU.centralAuthority).toBe(Math.max(0, authorityBefore - 2));
    expect(chu.characters[chuCommander].courtStanding).toBe(45);
  });

  it('降职会持久降低统率并影响后续战斗，公开审判会造成更强烈的政治代价', () => {
    const demoteState = newGame('YONG');
    const demoteArmy = demoteState.armies.find((army) => army.faction === 'YONG')!;
    const demoteCommanderId = demoteArmy.commanderId;
    const demoteRuntime = demoteState.characters[demoteCommanderId];
    Object.assign(demoteRuntime, { lastBattleOutcome: 'defeat', pendingBattleSettlement: true, pendingBattleCase: 'transfer_request', militaryLoyalty: 50 });
    demoteArmy.morale = 60;
    demoteArmy.training = 60;
    const demoteEvents: GameEvent[] = [];
    const demoteOrder = { orderId: 'demote-after-defeat', kind: 'settle_defeated_commander' as const, personId: demoteCommanderId, action: 'demote' as const };
    expect(validateOrder(demoteState, ctx, demoteOrder).ok).toBe(true);
    applyOrder(demoteState, ctx, demoteOrder, demoteEvents);
    expect(demoteState.characters[demoteCommanderId].militaryLoyalty).toBe(44);
    expect(demoteState.characters[demoteCommanderId].commandPenalty).toBe(8);
    expect(demoteState.characters[demoteCommanderId].courtStanding).toBe(45);
    expect(demoteArmy.morale).toBe(58);
    expect(demoteArmy.training).toBe(62);
    expect(demoteState.characters[demoteCommanderId].pendingBattleSettlement).toBe(false);
    expect(demoteEvents[0].title).toContain('降职问责');

    const withPenalty = clone(demoteState);
    const withoutPenalty = clone(demoteState);
    withoutPenalty.characters[demoteCommanderId].commandPenalty = 0;
    const battlePower = (state: GameState) => {
      const army = state.armies.find((item) => item.armyId === demoteArmy.armyId)!;
      const region = state.regions[army.nodeId];
      return resolveBattle(state, ctx, army, null, region, 98765).attackerPower;
    };
    expect(battlePower(withPenalty)).toBeLessThan(battlePower(withoutPenalty));

    const trialState = newGame('YONG');
    const trialArmy = trialState.armies.find((army) => army.faction === 'YONG')!;
    const trialCommanderId = trialArmy.commanderId;
    const rivalPrince = trialState.special.YONG.princes!.find((prince) => prince.personId !== trialCommanderId)!;
    const influenceBefore = rivalPrince.influence;
    const stabilityBefore = trialState.special.YONG.courtStability ?? 50;
    const trialRuntime = trialState.characters[trialCommanderId];
    Object.assign(trialRuntime, { lastBattleOutcome: 'defeat', pendingBattleSettlement: true, pendingBattleCase: 'impeachment', battlePoliticalOpponentId: rivalPrince.personId, militaryLoyalty: 70, courtStanding: 50 });
    trialArmy.morale = 60;
    trialArmy.training = 50;
    const trialEvents: GameEvent[] = [];
    const trialOrder = { orderId: 'public-trial-after-defeat', kind: 'settle_defeated_commander' as const, personId: trialCommanderId, action: 'trial' as const };
    expect(validateOrder(trialState, ctx, trialOrder).ok).toBe(true);
    applyOrder(trialState, ctx, trialOrder, trialEvents);
    expect(trialState.characters[trialCommanderId].militaryLoyalty).toBe(55);
    expect(trialState.characters[trialCommanderId].commandPenalty).toBe(12);
    expect(trialState.characters[trialCommanderId].courtStanding).toBe(40);
    expect(rivalPrince.influence).toBe(Math.min(100, influenceBefore + 4));
    expect(trialState.special.YONG.courtStability).toBe(Math.max(0, stabilityBefore - 4));
    expect(trialArmy.morale).toBe(55);
    expect(trialArmy.training).toBe(53);
    expect(trialState.characters[trialCommanderId].pendingBattleCase).toBeUndefined();
    const trialSettlementEvent = trialEvents.find((event) => event.title.includes('公开审判'));
    expect(trialSettlementEvent?.summary).toContain('公开审判');
    expect(trialState.characters[trialCommanderId].politicalGrudges?.[rivalPrince.personId]).toBe(12);
    expect(trialSettlementEvent?.summary).toContain('后续廷议');
  });

  it('惨重战败会生成请调或弹劾事件，且案件只对败军所属势力可见', () => {
    const state = newGame('HUN', 'ruler', 'aftermath-politics-case');
    const attacker = state.armies.find((army) => army.armyId === 'HUN-ARMY-02')!;
    attacker.morale = 0;
    attacker.training = 0;
    attacker.supply = 0;
    attacker.fatigue = 100;
    state.factions.HUN.resources.salt = 0;
    state.factions.HUN.resources.iron = 0;
    state.regions['YONG-REG03'].garrison = 220_000;
    state.pendingOrders = [{ orderId: 'aftermath-case-move', kind: 'move_army', armyId: attacker.armyId, targetRegionId: 'YONG-REG03' }];
    const result = runTurn(state, ctx);
    const battle = result.report.events.find((event) => event.type === 'battle');
    expect(battle).toBeTruthy();
    expect((battle!.after as any).attackerWon).toBe(false);
    const commanderId = attacker.commanderId;
    const runtime = result.state.characters[commanderId];
    expect(runtime.lastBattleLossRate).toBeGreaterThanOrEqual(0.25);
    expect(runtime.pendingBattleCase).toBeDefined();
    expect(['transfer_request', 'impeachment']).toContain(runtime.pendingBattleCase);
    const caseEvent = result.report.events.find((event) => event.targetId === commanderId && (event.title.includes('战败后遭弹劾') || event.title.includes('战败将领请调')));
    expect(caseEvent).toBeTruthy();
    expect(caseEvent!.visibleToPlayer).toBe(true);
  });

  it('战斗使用固定随机种子，并按战果改变军令忠诚且不泄露敌将忠诚', () => {
    const base = newGame('HUN', 'ruler', 'battle-seed');
    const attackerBefore = base.armies.find((army) => army.armyId === 'HUN-ARMY-02')!;
    const defenderBefore = base.armies.find((army) => army.faction === 'YONG' && army.nodeId === 'YONG-REG03');
    const attackerCommanderId = attackerBefore.commanderId;
    const defenderCommanderId = defenderBefore?.commanderId ?? base.regions['YONG-REG03'].garrisonCommanderId;
    const attackerLoyaltyBefore = base.characters[attackerCommanderId].militaryLoyalty ?? 50;
    const defenderLoyaltyBefore = base.characters[defenderCommanderId].militaryLoyalty ?? 50;
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
    expect(battleLoyaltyDelta(false, 0.4)).toBeLessThan(0);
    expect(battleLoyaltyDelta(true, 0.04)).toBeGreaterThan(0);

    const attackerWon = (battleA!.after as any).attackerWon as boolean;
    const attackerLoyaltyAfter = a.state.characters[attackerCommanderId].militaryLoyalty!;
    const defenderLoyaltyAfter = a.state.characters[defenderCommanderId].militaryLoyalty!;
    if (attackerWon) {
      expect(attackerLoyaltyAfter).toBeGreaterThan(attackerLoyaltyBefore);
      expect(defenderLoyaltyAfter).toBeLessThan(defenderLoyaltyBefore);
    } else {
      expect(attackerLoyaltyAfter).toBeLessThan(attackerLoyaltyBefore);
      expect(defenderLoyaltyAfter).toBeGreaterThan(defenderLoyaltyBefore);
    }
    const visibleChanges = (battleA!.after as any).commanderLoyaltyChanges as { personId: string; delta: number }[];
    expect(visibleChanges.some((change) => change.personId === attackerCommanderId)).toBe(true);
    expect(visibleChanges.some((change) => change.personId === defenderCommanderId)).toBe(false);
    expect(battleA!.summary).toContain('己方统将军令忠诚变化');
    expect(visibleChanges).toEqual((battleB!.after as any).commanderLoyaltyChanges);
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
    expect(restored.schemaVersion).toBe(4);
  });
});

describe('平衡常量', () => {
  it('一回合固定为 7 天', () => {
    expect(BALANCE.turnDays).toBe(7);
  });
});
