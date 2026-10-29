import type { CourtAgenda, CourtDecision, CourtResolution, FactionKey, GameState, Order } from '../types.js';
import { FACTION_KEYS } from '../types.js';
import type { DerivedContext } from '../dataset.js';
import { isAtWar } from '../dataset.js';
import { hashString, mulberry32 } from '../dataset.js';
import { BALANCE } from '../balance.js';
import { courtCost, courtRecommendedDecision, courtRelationshipAffinity, courtSkill } from './court.js';
import { buildAdjacency, estimatePathDays, findPath } from './movement.js';
import { factionTroops } from './economy.js';
import { clamp, isCharacterAlive } from './state.js';
import { findDefectionAllegiance } from './relationships.js';
import { seasonOf } from './season.js';

function currentFactionOfCharacter(state: GameState, ctx: DerivedContext, personId: string): FactionKey | undefined {
  return state.characters[personId]?.allegianceFaction ?? ctx.charactersById[personId]?.faction_key;
}

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

    // 0) 若上旬已收到倒戈预警，优先以最低必要赏赐挽回军心。
    const defectionProtection = generateNpcDefectionProtection(state, ctx, key, res.cash, oid);
    if (defectionProtection) orders.push(defectionProtection);

    // 1) 战败善后：NPC 君主会先处理上旬留下的败将案件，再安排其他国策。
    const battleSettlement = generateNpcBattleSettlement(state, ctx, key, oid);
    if (battleSettlement) orders.push(battleSettlement);

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
      const path = findPath(state, ctx, key, army.nodeId, hostileRegion, { troops: army.troops });
      if (path.ok && estimatePathDays(army, path, seasonOf(state.date.month)) <= BALANCE.turnDays * 2) {
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

/**
 * NPC 战后裁决：结合败将/弹劾者声望、同僚显式关系网络以及案件严重程度，
 * 确定性地选择留任、降职、追责、撤换或公开审判。每个势力每旬最多处理一名败将。
 */
function generateNpcDefectionProtection(
  state: GameState,
  ctx: DerivedContext,
  factionKey: FactionKey,
  cash: number,
  nextOrderId: () => string,
): Order | null {
  const risks = state.armies
    .filter((army) => army.faction === factionKey)
    .map((army) => {
      const commander = ctx.charactersById[army.commanderId];
      const runtime = state.characters[army.commanderId];
      const region = state.regions[army.nodeId];
      if (!commander || !runtime || !region ||
        currentFactionOfCharacter(state, ctx, commander.person_id) !== factionKey ||
        region.faction !== factionKey ||
        runtime.defectionWarningTurn === undefined ||
        runtime.defectionWarningTurn >= state.date.turn) return null;
      if (state.armies.some((other) =>
        other.armyId !== army.armyId &&
        other.faction === factionKey &&
        other.nodeId === army.nodeId,
      )) return null;
      const loyalty = runtime.militaryLoyalty ?? commander.loyalty;
      if (loyalty > 15) return null;
      const target = findDefectionAllegiance(
        ctx.seed.relationships,
        ctx.charactersById,
        commander.person_id,
        factionKey,
        (personId) => state.characters[personId]?.allegianceFaction ?? ctx.charactersById[personId]?.faction_key,
        (personId, targetFaction) =>
          state.characters[personId]?.alive !== false &&
          isAtWar(state.diplomacy, factionKey, targetFaction),
        runtime.defectionTargetFaction,
      );
      if (!target || target.targetFaction !== runtime.defectionTargetFaction) return null;
      return { army, personId: commander.person_id, loyalty, warningTurn: runtime.defectionWarningTurn };
    })
    .filter((risk): risk is NonNullable<typeof risk> => risk !== null)
    .sort((a, b) =>
      a.warningTurn - b.warningTurn ||
      a.loyalty - b.loyalty ||
      b.army.troops - a.army.troops ||
      a.army.armyId.localeCompare(b.army.armyId),
    );

  const risk = risks[0];
  if (!risk) return null;
  // 用能把忠诚提升到 15 以上的最低档赏赐，避免 AI 为保一个将领过度挥霍国库。
  const amount = [5_000, 10_000, 20_000].find(
    (candidate) => cash >= candidate && risk.loyalty + candidate / 1_000 > 15,
  );
  if (!amount) return null;
  return {
    orderId: nextOrderId(),
    kind: 'reward_commander',
    personId: risk.personId,
    amount,
  };
}

function generateNpcBattleSettlement(
  state: GameState,
  ctx: DerivedContext,
  factionKey: FactionKey,
  nextOrderId: () => string,
): Order | null {
  const candidates = Object.values(state.characters)
    .filter((runtime) => {
      const person = ctx.charactersById[runtime.personId];
      return currentFactionOfCharacter(state, ctx, runtime.personId) === factionKey &&
        runtime.alive &&
        runtime.lastBattleOutcome === 'defeat' &&
        runtime.pendingBattleSettlement === true &&
        isCharacterAlive(state, runtime.personId);
    })
    .sort((a, b) =>
      (b.lastBattleLossRate ?? 0) - (a.lastBattleLossRate ?? 0) ||
      a.personId.localeCompare(b.personId),
    );
  const runtime = candidates[0];
  if (!runtime) return null;
  const commander = ctx.charactersById[runtime.personId];
  if (!commander) return null;

  const army = state.armies.find((item) => item.faction === factionKey && item.commanderId === commander.person_id);
  const opponentId = runtime.battlePoliticalOpponentId;
  const opponent = opponentId ? ctx.charactersById[opponentId] : undefined;
  const ruler = ctx.seed.characters.find((person) => person.faction_key === factionKey && person.identity_type === '君主');
  const standingOf = (personId: string): number => state.characters[personId]?.courtStanding ?? 50;

  const networkBacking = (personId: string, excludedId?: string): { score: number; supporters: number } => {
    let total = 0;
    const supporters = new Set<string>();
    for (const edge of ctx.seed.relationships) {
      const otherId = edge.source_person_id === personId
        ? edge.target_person_id
        : edge.target_person_id === personId
          ? edge.source_person_id
          : '';
      if (!otherId || otherId === excludedId || otherId === personId) continue;
      const other = ctx.charactersById[otherId];
      if (!other || currentFactionOfCharacter(state, ctx, otherId) !== factionKey || !isCharacterAlive(state, otherId)) continue;
      const relationText = `${edge.relation} ${edge.notes}`;
      const weight = edge.strength === '强' ? 1.5 : edge.strength === '中' ? 1 : 0.5;
      if (/竞争|制衡|敌对|不和/.test(relationText)) {
        total -= weight;
      } else {
        total += weight;
        supporters.add(otherId);
      }
    }
    const rulerDisfavor = ruler ? (state.characters[ruler.person_id]?.politicalGrudges?.[personId] ?? 0) : 0;
    return {
      score: Math.max(-8, Math.min(8, total)) - rulerDisfavor * 0.5,
      supporters: supporters.size,
    };
  };
  const commanderBacking = networkBacking(commander.person_id, opponentId);
  const commanderScore = standingOf(commander.person_id) + commanderBacking.score * 2;
  const opponentBacking = opponent && currentFactionOfCharacter(state, ctx, opponent.person_id) === factionKey
    ? networkBacking(opponent.person_id, commander.person_id)
    : { score: 0, supporters: 0 };
  const opponentScore = opponent && currentFactionOfCharacter(state, ctx, opponent.person_id) === factionKey
    ? standingOf(opponent.person_id) + opponentBacking.score * 2
    : 50;
  const loyalty = runtime.militaryLoyalty ?? commander.loyalty;
  const lossRate = runtime.lastBattleLossRate ?? 0;
  const resources = state.factions[factionKey].resources;
  let action: 'relieve' | 'discipline' | 'replace' | 'demote' | 'trial' = 'discipline';
  let replacementPersonId: string | undefined;

  if (runtime.pendingBattleCase === 'impeachment' && opponent && currentFactionOfCharacter(state, ctx, opponent.person_id) === factionKey) {
    if (commanderScore >= opponentScore + 6 && resources.cash >= 12_000) {
      action = 'relieve';
    } else if (opponentScore >= commanderScore + 18 && lossRate >= 0.35) {
      action = 'trial';
    } else if (opponentScore > commanderScore) {
      action = 'demote';
    } else if (resources.cash >= 12_000 && loyalty < 45 && lossRate < 0.4) {
      action = 'relieve';
    }
  } else if (commanderScore >= 68 && loyalty >= 42 && resources.cash >= 12_000) {
    action = 'relieve';
  } else if (lossRate >= 0.45 && army) {
    const replacement = ctx.seed.characters
      .filter((person) => currentFactionOfCharacter(state, ctx, person.person_id) === factionKey && person.person_id !== commander.person_id)
      .filter((person) => isCharacterAlive(state, person.person_id))
      .filter((person) => !state.armies.some((item) => item.faction === factionKey && item.commanderId === person.person_id))
      .filter((person) => !Object.values(state.regions).some((region) => region.faction === factionKey && region.garrisonCommanderId === person.person_id))
      .sort((a, b) => b.command - a.command || a.person_id.localeCompare(b.person_id))[0];
    if (replacement) {
      action = 'replace';
      replacementPersonId = replacement.person_id;
    } else {
      action = 'demote';
    }
  } else if (lossRate >= 0.25) {
    action = 'demote';
  }

  const opponentName = opponent?.name ?? '未明弹劾者';
  const rulingNote = runtime.pendingBattleCase === 'impeachment' && opponent && currentFactionOfCharacter(state, ctx, opponent.person_id) === factionKey
    ? `关系网络裁量：败将声望 ${Math.round(standingOf(commander.person_id))}、同僚支持 ${commanderBacking.supporters} 人；弹劾者${opponent.name}声望 ${Math.round(standingOf(opponent.person_id))}、同僚支持 ${opponentBacking.supporters} 人。裁决按双方声望、显式关系与伤亡程度自动作出。`
    : `战后善后裁量：败将声望 ${Math.round(standingOf(commander.person_id))}、同僚支持 ${commanderBacking.supporters} 人、伤亡 ${Math.round(lossRate * 100)}%、军令忠诚 ${Math.round(loyalty)}；按损失严重程度与国库状况选择处置。`;
  return {
    orderId: nextOrderId(),
    kind: 'settle_defeated_commander',
    personId: commander.person_id,
    action,
    replacementPersonId,
    npcRulingNote: rulingNote,
  };
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
    .filter((person) => currentFactionOfCharacter(state, ctx, person.person_id) === factionKey && isCharacterAlive(state, person.person_id))
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
