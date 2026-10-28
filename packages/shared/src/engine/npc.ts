import type { CourtAgenda, CourtDecision, CourtResolution, FactionKey, GameState, Order } from '../types.js';
import { FACTION_KEYS } from '../types.js';
import type { DerivedContext } from '../dataset.js';
import { isAtWar } from '../dataset.js';
import { hashString, mulberry32 } from '../dataset.js';
import { BALANCE } from '../balance.js';
import { courtCost, courtRecommendedDecision, courtRelationshipAffinity, courtSkill } from './court.js';
import { buildAdjacency, findPath } from './movement.js';
import { factionTroops } from './economy.js';
import { clamp, isCharacterAlive } from './state.js';

/**
 * NPC 决策：基于自身利益、资源、已知边境与性格的启发式。
 * 只生成合法意图；真正状态改由 applyOrder 与规则引擎执行。
 */
export function generateNpcOrders(state: GameState, ctx: DerivedContext): Order[] {
  const orders: Order[] = [];
  for (const key of FACTION_KEYS) {
    if (key === state.factionKey) continue;
    const rng = mulberry32(hashString(`${state.seed}-${state.date.turn}-${key}`));
    const faction = state.factions[key];
    const troops = Math.max(1, factionTroops(state, key));
    const res = faction.resources;
    let seq = 0;
    const oid = () => `npc-${key}-T${state.date.turn}-${++seq}`;

    // 1) 粮食与财政自保
    if (res.grain < troops * BALANCE.grainPerThousandPerWeek * 2.5) {
      const stores = Object.values(state.regions)
        .filter((r) => r.faction === key)
        .reduce((s, r) => s + r.foodStore, 0);
      if (stores > BALANCE.levyGrain.grainPerRegion * 0.5) {
        orders.push({ orderId: oid(), kind: 'levy_grain', amount: rng() > 0.4 ? 2 : 1 });
      }
    }
    if (res.cash < troops * 0.06 * 2 && rng() > 0.3) {
      orders.push({ orderId: oid(), kind: 'levy_tax', amount: 1 });
    }
    // 2) 资源短板通过贸易缓解
    if (res.salt < troops * 0.0015 * 3 && res.cash > 30_000) {
      orders.push({ orderId: oid(), kind: 'trade', resource: 'salt', amount: 120 });
    } else if (res.iron < troops * 0.0008 * 3 && res.cash > 40_000) {
      orders.push({ orderId: oid(), kind: 'trade', resource: 'iron', amount: 120 });
    }

    // 3) 军队补员
    if (troops < faction.nominalTroops * 0.82 && res.cash > 45_000 && res.manpower > 12_000) {
      orders.push({ orderId: oid(), kind: 'recruit', amount: 8_000 });
    }

    // 4) 军事行动：选择兵力较弱且与本国接壤的敌方州府
    const hostileRegion = pickEnemyBorderRegion(state, ctx, key);
    const idleArmies = state.armies
      .filter((a) => a.faction === key && a.status === 'idle' && a.troops > 4_000 && a.supply > 45)
      .sort((a, b) => b.troops - a.troops);
    if (hostileRegion && idleArmies.length > 0 && rng() > 0.2) {
      const army = idleArmies[0];
      const path = findPath(state, ctx, key, army.nodeId, hostileRegion);
      if (path.ok && path.totalDays <= BALANCE.turnDays * 2) {
        orders.push({ orderId: oid(), kind: 'move_army', armyId: army.armyId, targetRegionId: hostileRegion });
      }
    } else {
      const tired = state.armies
        .filter((a) => a.faction === key && a.status === 'idle')
        .sort((a, b) => a.supply - b.supply)[0];
      if (tired && tired.supply < 70) {
        orders.push({ orderId: oid(), kind: 'rest_army', armyId: tired.armyId });
      }
    }

    // 5) 国情政治
    if (key === 'HUN' && state.special.HUN.tribes) {
      const lowest = [...state.special.HUN.tribes].sort((a, b) => a.loyalty - b.loyalty)[0];
      if ((state.special.HUN.cohesion ?? 55) < 60 && lowest && res.cash > 20_000) {
        orders.push({ orderId: oid(), kind: 'appease_tribe', tribeId: lowest.tribeId, amount: 6_000 });
      }
    }
    if (key === 'YONG' && (state.special.YONG.courtStability ?? 60) < 52 && res.cash > 60_000) {
      orders.push({ orderId: oid(), kind: 'balance_princes', amount: 1 });
    }
    if (key === 'CHU' && state.special.CHU.houses) {
      const lowest = [...state.special.CHU.houses].sort((a, b) => a.support - b.support)[0];
      if (lowest && lowest.support < 50 && res.cash > 40_000) {
        orders.push({ orderId: oid(), kind: 'negotiate_house', houseId: lowest.houseId, amount: 1 });
      }
    }

    // 6) 自动廷议：每势力每三旬轮到一次，由自身局势与在朝人物属性决定议题与主张。
    const courtOrder = generateNpcCourtOrder(state, ctx, key, oid);
    if (courtOrder) orders.push(courtOrder);
  }
  return orders;
}

function generateNpcCourtOrder(
  state: GameState,
  ctx: DerivedContext,
  factionKey: FactionKey,
  nextOrderId: () => string,
): Order | null {
  // 将三国的朝会错开，避免每旬所有势力同时开会；turn 以 1 起算。
  if (state.date.turn % 3 !== FACTION_KEYS.indexOf(factionKey)) return null;

  let agenda: CourtAgenda = 'war_council';
  let situationPreference: CourtDecision | undefined;
  if (factionKey === 'HUN') {
    agenda = (state.special.HUN.cohesion ?? 58) < 64 ||
      (state.special.HUN.tribes ?? []).some((tribe) => tribe.loyalty < 58)
      ? 'tribal_alliance'
      : 'war_council';
    const lowest = [...(state.special.HUN.tribes ?? [])].sort((a, b) => a.loyalty - b.loyalty)[0];
    if (lowest && lowest.loyalty < 40) situationPreference = 'conciliatory';
    else if ((state.special.HUN.cohesion ?? 58) < 50) situationPreference = 'balanced';
  } else if (factionKey === 'YONG') {
    agenda = state.flags.successionCrisis || (state.special.YONG.courtStability ?? 62) < 62
      ? 'succession'
      : 'war_council';
    if (state.flags.successionCrisis || (state.special.YONG.courtStability ?? 62) < 38) situationPreference = 'balanced';
    else if ((state.special.YONG.courtStability ?? 62) > 78) situationPreference = 'assertive';
  } else {
    const houses = state.special.CHU.houses ?? [];
    const averageSupport = houses.length
      ? houses.reduce((sum, house) => sum + house.support, 0) / houses.length
      : 50;
    agenda = state.flags.houseBoycott || averageSupport < 62 ? 'clan_relations' : 'war_council';
    if (state.flags.houseBoycott || averageSupport < 40) situationPreference = 'conciliatory';
    else if (averageSupport > 76) situationPreference = 'assertive';
  }

  if (agenda === 'war_council') {
    const armies = state.armies.filter((army) => army.faction === factionKey);
    const averageSupply = armies.length ? armies.reduce((sum, army) => sum + army.supply, 0) / armies.length : 60;
    const averageMorale = armies.length ? armies.reduce((sum, army) => sum + army.morale, 0) / armies.length : 60;
    if (averageSupply < 35 || averageMorale < 42) situationPreference = 'conciliatory';
    else if (averageMorale < 58) situationPreference = 'balanced';
  }

  const politicalTargetIds = agenda === 'succession'
    ? (state.special.YONG.princes ?? []).map((prince) => prince.personId)
    : agenda === 'tribal_alliance'
      ? (state.special.HUN.tribes ?? []).map((tribe) => tribe.chiefId)
      : agenda === 'clan_relations'
        ? (state.special.CHU.houses ?? []).map((house) => house.patriarchId)
        : state.armies.filter((army) => army.faction === factionKey).map((army) => army.commanderId);

  const advisors = ctx.seed.characters
    .filter((person) => person.faction_key === factionKey && isCharacterAlive(state, person.person_id))
    .map((person) => ({
      person,
      decision: courtRecommendedDecision(person, agenda),
      score: courtSkill({
        ...person,
        courtStanding: state.characters[person.person_id]?.courtStanding ?? 50,
      }, agenda) + courtRelationshipAffinity(ctx.seed.relationships, person.person_id, agenda, politicalTargetIds),
    }))
    .sort((a, b) => b.score - a.score);
  if (advisors.length < 2) return null;

  // 有明确国情压力时，优先寻找能提出所需政策的人；否则由议题能力最强者主议。
  const speaker = situationPreference
    ? advisors.find((advisor) => advisor.decision === situationPreference) ?? advisors[0]
    : advisors[0];
  const opposition = advisors.find(
    (advisor) => advisor.person.person_id !== speaker.person.person_id && advisor.decision !== speaker.decision,
  ) ?? advisors.find((advisor) => advisor.person.person_id !== speaker.person.person_id)!;
  const resolution: CourtResolution = 'adopt_speaker';
  // NPC 与玩家使用同一套决策解析与成本：order.decision 仍需携带最终政策供可支付性预检使用。
  const decision = speaker.decision;
  return {
    orderId: nextOrderId(),
    kind: 'hold_court',
    agenda,
    decision,
    resolution,
    speakerPersonId: speaker.person.person_id,
    oppositionPersonId: opposition.person.person_id,
  };
}

function pickEnemyBorderRegion(state: GameState, ctx: DerivedContext, factionKey: FactionKey): string | null {
  const adj = buildAdjacency(ctx);
  const ownRegionIds = Object.values(state.regions)
    .filter((r) => r.faction === factionKey)
    .map((r) => r.regionId);
  const candidates: { regionId: string; score: number }[] = [];
  for (const ownId of ownRegionIds) {
    for (const link of adj[ownId] ?? []) {
      const target = state.regions[link.to];
      if (!target) continue;
      if (target.faction === factionKey) continue;
      if (!isAtWar(state.diplomacy, factionKey, target.faction)) continue;
      const defenderArmies = state.armies
        .filter((a) => a.faction === target.faction && a.nodeId === target.regionId)
        .reduce((s, a) => s + a.troops, 0);
      const score = defenderArmies + target.garrison * 0.6 + target.fortification * 120;
      candidates.push({ regionId: target.regionId, score });
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.score - b.score);
  return candidates[0].regionId;
}

/** 军师/玩家可读的 NPC 意图摘要（不泄露精确状态）。 */
export function describeNpcPosture(state: GameState): { faction: FactionKey; text: string }[] {
  const out: { faction: FactionKey; text: string }[] = [];
  for (const key of FACTION_KEYS) {
    if (key === state.factionKey) continue;
    const f = state.factions[key];
    const pressure = f.statusTags.join('、');
    out.push({
      faction: key,
      text: `${f.shortName}：${pressure}。边境调动需斥候核实，朝中动向只能从使节与商路传闻推测。`,
    });
  }
  return out;
}

export function clampMorale(n: number): number {
  return clamp(n);
}
