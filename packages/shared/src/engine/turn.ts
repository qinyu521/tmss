import type {
  Army,
  ChronicleEntry,
  FactionKey,
  GameEvent,
  GameState,
  Order,
  OrderIssue,
  TurnReport,
} from '../types.js';
import { FACTION_KEYS } from '../types.js';
import type { DerivedContext } from '../dataset.js';
import { hashString, isAtWar } from '../dataset.js';
import { BALANCE } from '../balance.js';
import { FACTION_SHORT, makeDate, TURN_DAYS } from '../constants.js';
import { emitEvent } from './events.js';
import { applyOrder, validateOrder } from './orders.js';
import { generateNpcOrders } from './npc.js';
import { clearMarch, buildAdjacency, isRouteWaypointId, ROUTE_WAYPOINT_PREFIX } from './movement.js';
import { marchFatigueSeasonFactor, SEASON_LABELS, seasonOf } from './season.js';
import { retreatRegion as retreatGuard, resolveBattle } from './battle.js';
import { runEconomy, politicalTags, shortageTags } from './economy.js';
import { runPolitics } from './politics.js';
import { courtCost } from './court.js';
import { runLifecycle } from './lifecycle.js';
import { buildChronicle } from './chronicle.js';
import { clamp, factionNameOf, isCharacterAlive } from './state.js';
import { battleLoyaltyDelta, findDefectionAllegiance } from './relationships.js';

export interface TurnResult {
  state: GameState;
  report: TurnReport;
  rejected: { orderId: string; issues: OrderIssue[] }[];
}

export function runTurn(stateInput: GameState, ctx: DerivedContext): TurnResult {
  const state: GameState = structuredClone(stateInput);
  const events: GameEvent[] = [];
  const turn = state.date.turn;
  const turnLabel = state.date.label;
  const rejected: { orderId: string; issues: OrderIssue[] }[] = [];

  // 季节：由当月月份推导（3-5 春 / 6-8 夏 / 9-11 秋 / 12-2 冬）
  const season = seasonOf(state.date.month);
  const seasonInfo = SEASON_LABELS[season];
  // 跨季的第一旬（月份进入 3/6/9/12 的第一回合）额外发一条时令事件
  const prevSeason = state.date.turn <= 1 ? null : seasonOf(makeDate(state.date.dayIndex - TURN_DAYS, state.date.turn - 1).month);
  if (prevSeason === null || prevSeason !== season) {
    events.push(
      emitEvent(state, {
        type: 'season',
        title: `时令入${seasonInfo.label}`,
        summary: `${seasonInfo.desc}。${seasonInfo.hint}。`,
        actorId: 'system',
        actorName: '司天监',
        factionKey: 'NEUTRAL',
        targetLabel: '天下',
        after: { season, month: state.date.month },
        evidence: '季节由日期推导，修正系数见 balance.ts seasons 块',
        source: 'engine',
      }),
    );
  }

  events.push(
    emitEvent(state, {
      type: 'turn_start',
      title: `${turnLabel} · 旬始`,
      summary: `${seasonInfo.desc}，${seasonInfo.hint}。各势力在同一回合内提交命令，按规则统一结算；玩家不能无限抢先行动。`,
      actorId: 'system',
      actorName: '史官',
      factionKey: state.factionKey,
      targetLabel: '天下',
      evidence: '一回合 = 7 天，命令按序结算',
      source: 'engine',
    }),
  );

  // 1) 玩家命令：先校验，再按提交顺序结算
  for (const order of state.pendingOrders) {
    const check = validateOrder(state, ctx, order);
    if (!check.ok) {
      rejected.push({ orderId: order.orderId, issues: check.issues });
      events.push(
        emitEvent(state, {
          type: 'order_rejected',
          title: '命令被驳回',
          summary: check.issues.map((i) => i.message).join('；'),
          actorId: state.playerPersonId,
          actorName: state.playerPersonName,
          factionKey: state.factionKey,
          targetId: order.orderId,
          targetLabel: order.kind,
          after: { issues: check.issues },
          evidence: '后端权限/资源/地形校验',
          source: 'engine',
        }),
      );
      continue;
    }
    applyOrder(state, ctx, order, events, 'player_order');
  }

  // 2) NPC 行动
  const npcOrders = generateNpcOrders(state, ctx);
  const npcEventStart = events.length;
  for (const order of npcOrders) {
    if (!npcAffordable(state, order)) continue;
    applyOrder(state, ctx, order, events, 'npc_ai', npcFactionOf(order));
  }
  // NPC 的内部命令默认不可见；玩家只能通过斥候、烽燧与战报获知。
  for (let i = npcEventStart; i < events.length; i++) {
    if (events[i].source === 'npc_ai' && events[i].factionKey !== state.factionKey) {
      events[i].visibleToPlayer = false;
    }
  }

  // 3) 行军与战斗
  processMovement(state, ctx, events);

  // 3.5) 低忠诚将领的倒戈危机：先预警一旬，仍未挽回才会携军献城。
  resolveCommanderDefectionThreats(state, ctx, events);

  // 4) 经济账本
  const economy = runEconomy(state, ctx, events);

  // 5) 政治机制
  runPolitics(state, ctx, events);

  // 5.5) 人物生命周期：衰老死亡/继承/成长（确定性掷骰，紧随政治结算）
  runLifecycle(state, ctx, events);

  // 6) 战争威胁与情报更新
  updateThreat(state, ctx);
  addNpcBorderIntel(state, ctx, events);

  // 7) 状态标签（每回合按真实资源与政治状态重建，不保留过期标签）
  for (const key of FACTION_KEYS) {
    const tags = [...shortageTags(state, key), ...politicalTags(state, key)];
    state.factions[key].statusTags = Array.from(new Set(tags));
  }

  // 8) 史官记录（事实层与文学层分离）
  const chronicle = buildChronicle(state, events, turn, turnLabel);

  // 9) 推进日期
  state.date = advanceToNextDay(state.date);
  state.statistics.turnsPlayed += 1;
  state.pendingOrders = [];

  const battles = events.filter((e) => e.type === 'battle');
  const summary =
    `${turnLabel}结算：事件 ${events.length} 条，战斗 ${battles.length} 次，` +
    `驳回命令 ${rejected.length} 条；新旬为 ${state.date.label}。`;
  const report: TurnReport = {
    turn,
    dateLabel: turnLabel,
    events,
    chronicle,
    summary,
    rejectedOrders: rejected,
  };
  return { state, report, rejected };
}

function npcFactionOf(order: Order): FactionKey | undefined {
  const match = order.orderId.match(/^npc-(HUN|YONG|CHU)-/);
  return (match?.[1] as FactionKey | undefined) ?? undefined;
}

function npcAffordable(state: GameState, order: Order): boolean {
  const factionKey = npcFactionOf(order);
  if (!factionKey) return false;
  const res = state.factions[factionKey].resources;
  switch (order.kind) {
    case 'trade':
      return res.cash >= BALANCE.prices[order.resource] * order.amount * BALANCE.tradePremium;
    case 'reward_commander':
      return res.cash >= order.amount;
    case 'recruit':
      return res.cash >= order.amount * BALANCE.recruit.cashPerMan && res.manpower >= order.amount;
    case 'appease_tribe':
      return res.cash >= order.amount;
    case 'balance_princes':
      return res.cash >= BALANCE.balancePrinces.cashCost;
    case 'negotiate_house':
      return res.cash >= BALANCE.negotiateHouse.cashCost;
    case 'hold_court':
      return res.cash >= courtCost(order.agenda, order.decision);
    case 'levy_grain':
      return Object.values(state.regions)
        .filter((r) => r.faction === factionKey)
        .some((r) => r.foodStore > 0);
    default:
      return true;
  }
}


/**
 * A strong cross-faction tie plus critically low command loyalty creates a
 * visible, deterministic warning. The ruler gets one full turn to restore
 * loyalty; if ignored, the commander may defect with their isolated army and
 * hand over its current prefecture. We cap this at one defection per faction
 * per turn and never turn a random roll into a province loss.
 */
export function resolveCommanderDefectionThreats(
  state: GameState,
  ctx: DerivedContext,
  events: GameEvent[],
): void {
  const turn = state.date.turn;
  const activeCommanderIds = new Set(state.armies.map((army) => army.commanderId));

  // If an army was dissolved or its commander was replaced, its warning is stale.
  for (const runtime of Object.values(state.characters)) {
    if (runtime.defectionWarningTurn === undefined || activeCommanderIds.has(runtime.personId)) continue;
    runtime.defectionWarningTurn = undefined;
    runtime.defectionTargetFaction = undefined;
  }

  const ready: {
    army: Army;
    targetFaction: FactionKey;
    targetPersonId: string;
    targetPersonName: string;
    strength: number;
    loyalty: number;
    warningTurn: number;
  }[] = [];

  for (const army of [...state.armies].sort((a, b) => a.faction.localeCompare(b.faction) || a.armyId.localeCompare(b.armyId))) {
    const runtime = state.characters[army.commanderId];
    const commander = ctx.charactersById[army.commanderId];
    if (!runtime || !commander) continue;
    const currentCommanderFaction = runtime.allegianceFaction ?? commander.faction_key;
    if (currentCommanderFaction !== army.faction) continue;
    // A former defector only risks returning after an explicit amnesty offer sets a warning.
    if (runtime.allegianceFaction && runtime.defectionWarningTurn === undefined) continue;

    const region = state.regions[army.nodeId];
    const hasExclusiveControl = Boolean(region && region.faction === army.faction) &&
      !state.armies.some((other) =>
        other.armyId !== army.armyId &&
        other.faction === army.faction &&
        other.nodeId === army.nodeId,
      );
    const loyalty = runtime.militaryLoyalty ?? commander.loyalty ?? 50;
    const target = loyalty <= 15 && hasExclusiveControl
      ? findDefectionAllegiance(
          ctx.seed.relationships,
          ctx.charactersById,
          commander.person_id,
          army.faction,
          (personId) => state.characters[personId]?.allegianceFaction ?? ctx.charactersById[personId]?.faction_key,
          (personId, factionKey) =>
            state.characters[personId]?.alive !== false &&
            isAtWar(state.diplomacy, army.faction, factionKey),
          runtime.defectionWarningTurn === undefined ? undefined : runtime.defectionTargetFaction,
        )
      : null;

    if (!target) {
      runtime.defectionWarningTurn = undefined;
      runtime.defectionTargetFaction = undefined;
      continue;
    }

    if (
      runtime.defectionWarningTurn === undefined ||
      runtime.defectionTargetFaction !== target.targetFaction
    ) {
      runtime.defectionWarningTurn = turn;
      runtime.defectionTargetFaction = target.targetFaction;
      const returnWarning = Boolean(runtime.allegianceFaction);
      events.push(emitEvent(state, {
        type: 'politics',
        title: returnWarning ? `归附关系动摇预警·${commander.name}` : `倒戈风险预警·${commander.name}`,
        summary: returnWarning
          ? `${commander.name}现归附${state.factions[army.faction].name}，军令忠诚仅 ${Math.round(loyalty)}。旧主势力${state.factions[target.targetFaction].name}凭与其的明确强关系发动招抚；若下一旬前仍未恢复忠诚，${commander.name}可能率军与驻地${region?.name ?? ''}归还旧主。归附方君主可继续赏赐或撤换统将。`
          : `${commander.name}军令忠诚仅 ${Math.round(loyalty)}，且与交战势力${state.factions[target.targetFaction].name}的${target.targetPersonName}存在明确强关系。其所部暂未叛离，但若下一旬前仍未恢复忠诚，可能携军倒戈并献出${region?.name ?? '驻地'}。君主可先行赏赐；战后待处置将领也可撤换。`,
        actorId: commander.person_id,
        actorName: commander.name,
        factionKey: army.faction,
        targetId: army.armyId,
        targetLabel: army.name,
        before: { militaryLoyalty: loyalty, targetFaction: army.faction, regionFaction: region?.faction },
        after: { warningTurn: turn, defectionTargetFaction: target.targetFaction, targetPersonId: target.targetPersonId, returnToOriginalFaction: returnWarning && target.targetFaction === commander.faction_key },
        evidence: returnWarning
          ? '旧主招抚后的确定性预警：归附将领忠诚 ≤15、与原属势力在世人物存在明确强关系、独占当前驻地；仍保留一整回合反制窗口'
          : '确定性预警条件：将领军令忠诚 ≤15、与交战势力在世人物存在明确强关系、军团独占本方驻地；未触发随机判定',
        source: 'engine',
        visibleToPlayer: state.factionKey === army.faction || state.factionKey === target.targetFaction,
      }));
      continue;
    }

    if (runtime.defectionWarningTurn < turn) {
      ready.push({
        army,
        targetFaction: target.targetFaction,
        targetPersonId: target.targetPersonId,
        targetPersonName: target.targetPersonName,
        strength: target.strength,
        loyalty,
        warningTurn: runtime.defectionWarningTurn,
      });
    }
  }

  const resolvedFactions = new Set<FactionKey>();
  ready.sort((a, b) =>
    a.warningTurn - b.warningTurn ||
    a.loyalty - b.loyalty ||
    b.strength - a.strength ||
    a.army.armyId.localeCompare(b.army.armyId),
  );
  for (const candidate of ready) {
    const { army, targetFaction, targetPersonId, targetPersonName, loyalty } = candidate;
    const oldFaction = army.faction;
    if (resolvedFactions.has(oldFaction)) continue;
    // Re-check after earlier defections: this location must still be a solely held prefecture.
    const region = state.regions[army.nodeId];
    if (!region || region.faction !== oldFaction ||
      state.armies.some((other) => other.armyId !== army.armyId && other.faction === oldFaction && other.nodeId === army.nodeId)) {
      continue;
    }
    const ruler = ctx.seed.characters.find((person) =>
      person.faction_key === targetFaction && person.identity_type === '君主',
    );
    const runtime = state.characters[army.commanderId];
    if (!runtime) continue;
    const returningToOriginalFaction = Boolean(runtime.allegianceFaction && targetFaction === ctx.charactersById[army.commanderId]?.faction_key);
    const before = {
      armyFaction: oldFaction,
      regionFaction: region.faction,
      troops: army.troops,
      regionGarrison: region.garrison,
      regionLoyalty: region.loyalty,
      regionOrder: region.order,
      militaryLoyalty: loyalty,
    };

    // The garrison and prefecture change hands with the defecting field army.
    army.faction = targetFaction;
    army.name = `${army.name}·归附军`;
    army.morale = clamp(army.morale - 10);
    army.stance = 'defend';
    army.status = 'idle';
    army.path = [];
    army.hopCosts = [];
    army.targetRegionId = null;
    army.marchDaysLeft = 0;
    army.marchDaysTotal = 0;
    army.currentHopDaysTotal = 0;
    runtime.allegianceFaction = returningToOriginalFaction ? undefined : targetFaction;
    if (returningToOriginalFaction) runtime.militaryLoyalty = Math.max(30, loyalty);
    runtime.defectionWarningTurn = undefined;
    runtime.defectionTargetFaction = undefined;
    runtime.pendingBattleSettlement = false;
    runtime.pendingBattleCase = undefined;
    runtime.battlePoliticalOpponentId = undefined;
    runtime.politicalGrudges = {};
    runtime.politicalGrudgeNextResponseTurn = {};
    region.faction = targetFaction;
    region.governorId = ruler?.person_id ?? army.commanderId;
    region.governorName = ruler?.name ?? army.commanderName;
    region.garrisonCommanderId = army.commanderId;
    region.garrisonCommanderName = army.commanderName;
    region.garrisoned = true;
    region.order = clamp(region.order - (returningToOriginalFaction ? 5 : 15));
    region.loyalty = clamp(region.loyalty - (returningToOriginalFaction ? 5 : 12));
    region.threat = clamp(region.threat + (returningToOriginalFaction ? 4 : 12));
    state.factions[oldFaction].stability = clamp(state.factions[oldFaction].stability - 5);
    state.factions[targetFaction].stability = clamp(state.factions[targetFaction].stability + (returningToOriginalFaction ? 3 : -2));
    for (const key of FACTION_KEYS) {
      state.factions[key].control = Object.values(state.regions)
        .filter((ownedRegion) => ownedRegion.faction === key)
        .map((ownedRegion) => ownedRegion.regionId);
    }
    resolvedFactions.add(oldFaction);

    events.push(emitEvent(state, {
      type: 'politics',
      title: returningToOriginalFaction
        ? `旧主招抚成功·${region.name}归还${state.factions[targetFaction].name}`
        : `将领倒戈·${region.name}归附${state.factions[targetFaction].name}`,
      summary: returningToOriginalFaction
        ? `${army.commanderName}接受旧主招抚，率 ${Math.round(army.troops).toLocaleString()} 人与${region.name}州府重归${state.factions[targetFaction].name}。回归后的军令忠诚托底至 30；地方秩序 ${Math.round(before.regionOrder)}→${Math.round(region.order)}、民心 ${Math.round(before.regionLoyalty)}→${Math.round(region.loyalty)}。当前归附势力稳定 -5，原属势力稳定 +3。`
        : `${army.commanderName}在忠诚长期跌至 ${Math.round(loyalty)}、且与${state.factions[targetFaction].name}的${targetPersonName}有强关系后，越过朝廷预警期限，率 ${Math.round(army.troops).toLocaleString()} 人倒戈。军团与${region.name}州府一并归附；地方秩序 ${Math.round(before.regionOrder)}→${Math.round(region.order)}、民心 ${Math.round(before.regionLoyalty)}→${Math.round(region.loyalty)}，旧势力稳定 -5，新势力稳定 -2。`,
      actorId: army.commanderId,
      actorName: army.commanderName,
      factionKey: oldFaction,
      targetId: region.regionId,
      targetLabel: region.name,
      before,
      after: {
        armyFaction: targetFaction,
        regionFaction: targetFaction,
        troops: army.troops,
        militaryLoyalty: runtime.militaryLoyalty ?? before.militaryLoyalty,
        regionOrder: region.order,
        regionLoyalty: region.loyalty,
        oldFactionStability: state.factions[oldFaction].stability,
        targetFactionStability: state.factions[targetFaction].stability,
        defectionTargetPersonId: targetPersonId,
        returnedToOriginalFaction: returningToOriginalFaction,
      },
      evidence: returningToOriginalFaction
        ? '旧主招抚需先经过独立预警期限；到期后军团与独占驻地同步归还原属势力，归附将领忠诚托底 30，驻地承受较轻秩序惩罚'
        : '同一倒戈条件需连续跨越预警回合；将领军团与其独占驻地同步改变势力，避免在原势力腹地生成无法交战的敌军团',
      source: 'engine',
      visibleToPlayer: state.factionKey === oldFaction || state.factionKey === targetFaction,
    }));
    // Explicitly recorded old subordinates may lose faith when their commander defects.
    // Limit the ripple to three active commanders; they must still pass the normal warning window.
    const subordinatePattern = /旧部|部属|主从|效忠|知遇|门生|追随|部下|恩主|副将|旧主/;
    const hostilePattern = /竞争|制衡|敌对|不和|争夺|仇敌|追杀/;
    const followerCandidates = new Map<string, { weight: number; army: Army }>();
    for (const edge of ctx.seed.relationships) {
      const followerId = edge.source_person_id === army.commanderId
        ? edge.target_person_id
        : edge.target_person_id === army.commanderId
          ? edge.source_person_id
          : '';
      if (!followerId || followerId === army.commanderId || edge.strength !== '强') continue;
      const follower = ctx.charactersById[followerId];
      const followerRuntime = state.characters[followerId];
      const relationText = `${edge.relation} ${edge.notes}`;
      if (!follower || !followerRuntime || !isCharacterAlive(state, followerId)) continue;
      if ((followerRuntime.allegianceFaction ?? follower.faction_key) !== oldFaction) continue;
      if (!subordinatePattern.test(relationText) || hostilePattern.test(relationText)) continue;
      const followerArmy = state.armies.find((item) => item.faction === oldFaction && item.commanderId === followerId);
      if (!followerArmy) continue;
      const weight = 3;
      const previous = followerCandidates.get(followerId);
      if (!previous || weight > previous.weight) followerCandidates.set(followerId, { weight, army: followerArmy });
    }
    const followers = [...followerCandidates.entries()]
      .map(([personId, value]) => ({ personId, ...value }))
      .sort((a, b) => b.weight - a.weight || a.personId.localeCompare(b.personId))
      .slice(0, 3);
    for (const follower of followers) {
      const followerRuntime = state.characters[follower.personId];
      const followerSeed = ctx.charactersById[follower.personId];
      if (!followerRuntime || !followerSeed) continue;
      const loyaltyBefore = followerRuntime.militaryLoyalty ?? followerSeed.loyalty ?? 50;
      const loyaltyAfter = clamp(loyaltyBefore - 6);
      followerRuntime.militaryLoyalty = loyaltyAfter;
      state.characters[follower.personId] = followerRuntime;
      events.push(emitEvent(state, {
        type: 'politics',
        title: `旧部动摇·${followerSeed.name}`,
        summary: `${army.commanderName}倒戈后，其旧部${followerSeed.name}受到牵连，军令忠诚由 ${Math.round(loyaltyBefore)} 降至 ${Math.round(loyaltyAfter)}。若忠诚跌至 15 以下且其与新势力存在明确强关系，将依照正常规则先收到倒戈预警，不会立即叛离。`,
        actorId: army.commanderId,
        actorName: army.commanderName,
        factionKey: oldFaction,
        targetId: follower.army.armyId,
        targetLabel: follower.army.name,
        before: { militaryLoyalty: loyaltyBefore, armyFaction: follower.army.faction, defectorId: army.commanderId },
        after: { militaryLoyalty: loyaltyAfter, commanderId: follower.personId, targetFaction, defectionWarningRequired: loyaltyAfter <= 15 },
        evidence: '仅由强度为强且明确标记旧部/主从/效忠/知遇等关系的边触发；每次倒戈最多影响三名仍在本方统兵的旧部，后续倒戈必须再次满足独立条件并经历预警期',
        source: 'engine',
        visibleToPlayer: state.factionKey === oldFaction || state.factionKey === targetFaction,
      }));
    }
  }
}

function processMovement(state: GameState, ctx: DerivedContext, events: GameEvent[]): void {
  // 夏季暑热：行军疲劳 +20%，匈奴骑兵不耐暑再 +15%（系数在 balance.seasons）
  const season = seasonOf(state.date.month);
  const movementArmies = state.armies.filter((a) => a.path.length > 0);
  for (const army of movementArmies) {
    if (!state.armies.some((a) => a.armyId === army.armyId)) continue;
    let remainingDays = TURN_DAYS;
    while (remainingDays > 0 && army.path.length > 0) {
      const hop = Math.max(1, army.hopCosts[0] ?? 1);
      if (remainingDays < hop) {
        // 本旬只走完当前路段的一部分：保存剩余天数，并立即结算已行军天数的补给与疲劳。
        // 若等抵达州府才结算，长途行军途中将不会消耗补给，也不会累积疲劳。
        const traveledDays = remainingDays;
        // 为旧存档补齐当前路段基准：旧版本没有 currentHopDaysTotal，无法准确显示路段进度。
        army.currentHopDaysTotal ??= hop;
        army.hopCosts[0] = hop - traveledDays;
        army.marchDaysLeft = army.hopCosts.reduce((sum, days) => sum + days, 0);
        army.supply = clamp(army.supply - traveledDays * BALANCE.army.marchSupplyDrainPerDay);
        army.fatigue = clamp(
          army.fatigue + traveledDays * BALANCE.army.fatigueMarchPerDay * marchFatigueSeasonFactor(season, army.faction),
        );
        remainingDays = 0;
        break;
      }
      remainingDays -= hop;
      const nextNodeId = army.path.shift() as string;
      army.hopCosts.shift();
      army.currentHopDaysTotal = army.hopCosts[0] ?? 0;
      army.marchDaysLeft = army.hopCosts.reduce((s, d) => s + d, 0);
      army.supply = clamp(army.supply - hop * BALANCE.army.marchSupplyDrainPerDay);
      army.fatigue = clamp(army.fatigue + hop * BALANCE.army.fatigueMarchPerDay * marchFatigueSeasonFactor(season, army.faction));

      if (isRouteWaypointId(nextNodeId)) {
        army.positionNodeId = nextNodeId;
        const edgeId = nextNodeId.slice(ROUTE_WAYPOINT_PREFIX.length);
        const edge = ctx.edges.find((item) => item.edge_id === edgeId);
        events.push(
          emitEvent(state, {
            type: 'army_move',
            title: \`${army.name}推进至道路中段\`,
            summary: \`${army.name}已沿\${edge?.route_type ?? '道路'}推进至中途节点，仍需 \${army.marchDaysLeft} 日抵达目标州府。\`,
            actorId: army.commanderId,
            actorName: army.commanderName,
            factionKey: army.faction,
            targetId: army.armyId,
            targetLabel: edge?.route_type ?? '道路中段',
            after: { positionNodeId: nextNodeId, remainingDays: army.marchDaysLeft },
            evidence: '中途节点由长道路确定性拆分生成；不改变行政控制区或战斗结果',
            source: 'engine',
            visibleToPlayer: army.faction === state.factionKey,
          }),
        );
        continue;
      }

      const nextRegionId = nextNodeId;
      const previous = army.nodeId;
      army.nodeId = nextRegionId;
      army.positionNodeId = nextRegionId;
      army.originRegionId = previous;
      const region = state.regions[nextRegionId];

      if (region.faction !== army.faction) {
        if (isAtWar(state.diplomacy, army.faction, region.faction)) {
          const battleEvents = handleBattle(state, ctx, army, nextRegionId);
          events.push(...battleEvents);
          break;
        }
        army.nodeId = previous;
        clearMarch(army);
        events.push(
          emitEvent(state, {
            type: 'army_move',
            title: `${army.name}被边境拒止`,
            summary: `目标${region.name}属${FACTION_SHORT[region.faction]}，双方并未交战，部队退回${state.regions[previous]?.name ?? previous}。`,
            actorId: army.commanderId,
            actorName: army.commanderName,
            factionKey: army.faction,
            targetId: army.armyId,
            targetLabel: army.name,
            source: 'engine',
            visibleToPlayer: army.faction === state.factionKey,
          }),
        );
        break;
      }

      army.supply = clamp(army.supply + 4);
      if (army.path.length === 0) {
        clearMarch(army);
        events.push(
          emitEvent(state, {
            type: 'army_move',
            title: `${army.name}抵达${region.name}`,
            summary: `部队完成行军，转入驻防；补给 ${Math.round(army.supply)}，疲劳 ${Math.round(army.fatigue)}。`,
            actorId: army.commanderId,
            actorName: army.commanderName,
            factionKey: army.faction,
            targetId: army.armyId,
            targetLabel: army.name,
            source: 'engine',
            visibleToPlayer: army.faction === state.factionKey,
          }),
        );
      }
    }
    // 旬末补给与疲劳
    if (army.status === 'marching') {
      army.supply = clamp(army.supply - 5);
      army.fatigue = clamp(army.fatigue + 6);
      if (army.supply < BALANCE.army.attritionSupplyBelow) {
        const lose = Math.round(army.troops * BALANCE.army.attritionRatePerDay * TURN_DAYS);
        army.levies = Math.max(0, army.levies - Math.min(army.levies, lose));
        army.troops = army.levies + army.units.reduce((s, u) => s + u.count, 0);
        events.push(
          emitEvent(state, {
            type: 'shortage',
            title: `${army.name}行军减员`,
            summary: `补给不足导致约 ${lose} 人流亡/掉队。`,
            actorId: army.commanderId,
            actorName: army.commanderName,
            factionKey: army.faction,
            targetId: army.armyId,
            targetLabel: army.name,
            source: 'engine',
            visibleToPlayer: army.faction === state.factionKey,
          }),
        );
      }
    }
  }

  // 休整中的部队恢复
  for (const army of state.armies) {
    if (army.status === 'idle' && army.nodeId) {
      const region = state.regions[army.nodeId];
      if (region && region.faction === army.faction) {
        army.supply = clamp(army.supply + 8);
        army.fatigue = clamp(army.fatigue - 8);
        army.morale = clamp(army.morale + 1);
      }
    }
  }

  // 清除已被歼灭的部队
  state.armies = state.armies.filter((a) => a.troops >= 60);
}

function handleBattle(state: GameState, ctx: DerivedContext, attacker: Army, regionId: string): GameEvent[] {
  const events: GameEvent[] = [];
  const region = state.regions[regionId];
  const originalOwner = region.faction;
  const defender = state.armies.find(
    (a) => a.faction === region.faction && a.nodeId === regionId && a.troops > 0 && a.armyId !== attacker.armyId,
  );
  const seed = hashString(`${state.seed}-${attacker.armyId}-${regionId}-${state.date.turn}`);
  const before = {
    regionOwner: originalOwner,
    region: region.name,
    attackerTroops: attacker.troops,
    defenderTroops: (defender?.troops ?? 0) + region.garrison,
    garrison: region.garrison,
  };
  const attackerTroopsBefore = Math.max(1, attacker.troops);
  const defenderArmyTroopsBefore = Math.max(1, defender?.troops ?? region.garrison);
  const garrisonTroopsBefore = Math.max(1, region.garrison);
  const attackerCommanderId = attacker.commanderId;
  const attackerCommanderName = attacker.commanderName;
  const defenderCommanderId = defender?.commanderId ?? region.garrisonCommanderId;
  const defenderCommanderName = defender?.commanderName ?? region.garrisonCommanderName;
  const defenderCommanderFaction = defender?.faction ?? originalOwner;
  const outcome = resolveBattle(state, ctx, attacker, defender ?? null, region, seed);

  // 战果改变本局军令忠诚：败军将领因溃败与伤亡失去威望，胜方则小幅增加军心。
  // 只把玩家自己势力的忠诚数值写进可见战报，避免透出敌方人物的精确状态。
  const allCommanderLoyaltyChanges: {
    personId: string;
    personName: string;
    factionKey: FactionKey;
    side: 'victor' | 'defeated';
    before: number;
    after: number;
    delta: number;
  }[] = [];
  const applyBattleLoyalty = (
    personId: string,
    personName: string,
    factionKey: FactionKey,
    won: boolean,
    casualtyRate: number,
  ) => {
    const person = ctx.charactersById[personId];
    if (!personId || !person) return;
    const runtime = state.characters[personId] ?? {
      personId,
      alive: true,
      ageBand: person.age_band,
      courtStanding: 50,
      militaryLoyalty: person.loyalty,
    };
    const before = clamp(runtime.militaryLoyalty ?? person.loyalty);
    const after = clamp(before + battleLoyaltyDelta(won, casualtyRate));
    runtime.militaryLoyalty = after;
    runtime.lastBattleTurn = state.date.turn;
    runtime.lastBattleOutcome = won ? 'victory' : 'defeat';
    runtime.lastBattleLossRate = Math.max(0, Math.min(1, casualtyRate));
    runtime.pendingBattleSettlement = !won;
    const normalizedLossRate = Math.max(0, Math.min(1, Number.isFinite(casualtyRate) ? casualtyRate : 0));
    const hostileLinks = !won && normalizedLossRate >= 0.25
      ? ctx.seed.relationships
          .filter((edge) => {
            const otherId = edge.source_person_id === personId
              ? edge.target_person_id
              : edge.target_person_id === personId
                ? edge.source_person_id
                : '';
            const other = otherId ? ctx.charactersById[otherId] : undefined;
            return Boolean(
              otherId &&
              otherId !== personId &&
              (state.characters[otherId]?.allegianceFaction ?? other?.faction_key) === factionKey &&
              state.characters[otherId]?.alive !== false &&
              /竞争|制衡|敌对|不和|争夺/.test(edge.relation + ' ' + edge.notes)
            );
          })
          .sort((a, b) => {
            const weight = (strength: string) => strength === '强' ? 3 : strength === '中' ? 2 : 1;
            return weight(b.strength) - weight(a.strength);
          })
      : [];
    const hostileEdge = hostileLinks[0];
    const opponentId = hostileEdge
      ? hostileEdge.source_person_id === personId
        ? hostileEdge.target_person_id
        : hostileEdge.source_person_id
      : undefined;
    if (!won && normalizedLossRate >= 0.25) {
      runtime.pendingBattleCase = opponentId ? 'impeachment' : 'transfer_request';
      runtime.battlePoliticalOpponentId = opponentId;
    } else {
      runtime.pendingBattleCase = undefined;
      runtime.battlePoliticalOpponentId = undefined;
    }
    state.characters[personId] = runtime;
    allCommanderLoyaltyChanges.push({
      personId,
      personName,
      factionKey,
      side: won ? 'victor' : 'defeated',
      before,
      after,
      delta: after - before,
    });
  };
  const attackerLossRate = outcome.attackerLosses / attackerTroopsBefore;
  const defenderLossRate = defender
    ? outcome.defenderLosses / defenderArmyTroopsBefore
    : outcome.garrisonLosses / garrisonTroopsBefore;
  applyBattleLoyalty(attackerCommanderId, attackerCommanderName, attacker.faction, outcome.attackerWon, attackerLossRate);
  applyBattleLoyalty(defenderCommanderId, defenderCommanderName, defenderCommanderFaction, !outcome.attackerWon, defenderLossRate);
  for (const change of allCommanderLoyaltyChanges.filter((item) => item.side === 'defeated')) {
    const runtime = state.characters[change.personId];
    if (!runtime?.pendingBattleCase) continue;
    const opponent = runtime.battlePoliticalOpponentId
      ? ctx.charactersById[runtime.battlePoliticalOpponentId]
      : undefined;
    const impeachment = runtime.pendingBattleCase === 'impeachment';
    events.push(emitEvent(state, {
      type: 'politics',
      title: impeachment ? '战败后遭弹劾·' + change.personName : '战败将领请调·' + change.personName,
      summary: impeachment
        ? change.personName + '部战损达到 ' + Math.round((runtime.lastBattleLossRate ?? 0) * 100) + '%。' +
          (opponent
            ? opponent.name + '凭借两人之间明确记载的竞争/制衡关系，弹劾其用兵失当。君主可抚恤以护其留任、追责以支持弹劾，或撤换统将。'
            : '朝中对其用兵提出质疑，要求君主裁断。')
        : change.personName + '所部战损达到 ' + Math.round((runtime.lastBattleLossRate ?? 0) * 100) + '%，将领以军心受挫、难以继续统兵为由呈请调离前线。君主可抚恤留用、追责驳回或另换统将。',
      actorId: opponent?.person_id ?? change.personId,
      actorName: opponent?.name ?? (impeachment ? '朝中言官' : change.personName),
      factionKey: change.factionKey,
      targetId: change.personId,
      targetLabel: change.personName,
      before: { pendingBattleCase: runtime.pendingBattleCase, casualtyRate: runtime.lastBattleLossRate },
      after: { pendingBattleSettlement: true, politicalOpponentId: opponent?.person_id },
      evidence: impeachment
        ? '战损比例达到 25% 且人物关系种子中存在明确的竞争/制衡/敌对关系，生成弹劾案'
        : '战损比例达到 25%，且未发现符合条件的显式敌对关系，生成统将请调案',
      source: 'engine',
      visibleToPlayer: change.factionKey === state.factionKey,
    }));
  }
  const visibleCommanderLoyaltyChanges = allCommanderLoyaltyChanges.filter((change) => change.factionKey === state.factionKey);
  const commanderLoyaltySummary = visibleCommanderLoyaltyChanges.length
    ? `己方统将军令忠诚变化：${visibleCommanderLoyaltyChanges.map((change) => `${change.personName} ${change.delta > 0 ? '+' : ''}${change.delta}` ).join('、')}。`
    : '';

  // 记录本旬参战主将，生命周期据此追加战死概率
  attacker.lastBattleTurn = state.date.turn;
  if (defender) defender.lastBattleTurn = state.date.turn;
  state.statistics.battles += 1;
  state.statistics.casualties += outcome.attackerLosses + outcome.defenderLosses + outcome.garrisonLosses;
  const visible = attacker.faction === state.factionKey || originalOwner === state.factionKey;

  events.push(
    emitEvent(state, {
      type: 'battle',
      title: `${attacker.name}战于${region.name}`,
      summary: `${outcome.narrative}${commanderLoyaltySummary ? ` ${commanderLoyaltySummary}` : ''}`,
      actorId: attacker.commanderId,
      actorName: attacker.commanderName,
      factionKey: attacker.faction,
      targetId: region.regionId,
      targetLabel: region.name,
      before,
      after: {
        totalLosses: outcome.attackerLosses + outcome.defenderLosses + outcome.garrisonLosses,
        attackerLosses: outcome.attackerLosses,
        defenderLosses: outcome.defenderLosses + outcome.garrisonLosses,
        attackerRemaining: outcome.attackerRemaining,
        defenderRemaining: outcome.defenderRemaining,
        attackerWon: outcome.attackerWon,
        commanderLoyaltyChanges: visibleCommanderLoyaltyChanges,
      },
      payload: {
        ratio: outcome.replay.ratio,
        terrain: outcome.replay.terrain,
        fort: outcome.replay.fort,
        seed: outcome.seed,
        attackerPower: outcome.attackerPower,
        defenderPower: outcome.defenderPower,
        defenderFaction: originalOwner,
        defenderArmy: defender?.name ?? '州兵',
        attackerCommander: outcome.replay.attackerCommander,
        defenderCommander: outcome.replay.defenderCommander,
        maneuverBonus: outcome.replay.maneuverBonus,
        ambushBonus: outcome.replay.ambushBonus,
        diversionBonus: outcome.replay.diversionBonus,
      },
      evidence: `随机种子 ${outcome.seed}；兵力比 ${outcome.attackerPower} : ${outcome.defenderPower}，可重放`,
      source: 'engine',
      visibleToPlayer: visible,
    }),
  );

  if (outcome.attackerWon) {
    // 占领
    region.faction = attacker.faction;
    region.governorId = attacker.commanderId;
    region.governorName = attacker.commanderName;
    region.order = clamp(region.order - 14);
    region.loyalty = clamp(region.loyalty - 18);
    region.threat = 30;
    region.garrison = 0;
    region.garrisoned = false;
    for (const key of FACTION_KEYS) {
      state.factions[key].control = Object.values(state.regions)
        .filter((r) => r.faction === key)
        .map((r) => r.regionId);
    }
    state.statistics.occupiedRegions += 1;
    attacker.nodeId = regionId;
    clearMarch(attacker);
    attacker.supply = clamp(attacker.supply - 6);
    attacker.fatigue = clamp(attacker.fatigue + 8);
    if (attacker.troops < 60) {
      state.armies = state.armies.filter((a) => a.armyId !== attacker.armyId);
    }

    // 守军后撤或溃散
    if (defender) {
      if (defender.troops >= 60) {
        const retreat = retreatGuard(state, ctx, defender, regionId);
        if (retreat) {
          defender.nodeId = retreat;
          defender.supply = clamp(defender.supply - 18);
          defender.morale = clamp(defender.morale - 12);
          clearMarch(defender);
        } else {
          state.armies = state.armies.filter((a) => a.armyId !== defender.armyId);
        }
      } else {
        state.armies = state.armies.filter((a) => a.armyId !== defender.armyId);
      }
    }

    events.push(
      emitEvent(state, {
        type: 'occupation',
        title: `${FACTION_SHORT[attacker.faction]}占据${region.name}`,
        summary: `${attacker.name}攻占${region.name}，原守军${defender ? `（${defender.name}）` : '（州兵）'}退出。治安与民心因战乱下降。`,
        actorId: attacker.commanderId,
        actorName: attacker.commanderName,
        factionKey: attacker.faction,
        targetId: region.regionId,
        targetLabel: region.name,
        before: { owner: originalOwner, governor: region.governorName },
        after: { owner: attacker.faction, governor: attacker.commanderName },
        evidence: '战斗胜利后按规则转移州府控制权',
        source: 'engine',
        visibleToPlayer: visible,
      }),
    );
  } else {
    const retreat = retreatGuard(state, ctx, attacker, regionId);
    if (retreat) {
      attacker.nodeId = retreat;
    } else {
      state.armies = state.armies.filter((a) => a.armyId !== attacker.armyId);
    }
    clearMarch(attacker);
    attacker.morale = clamp(attacker.morale - 10);
    attacker.supply = clamp(attacker.supply - 12);
    if (attacker.troops < 60) {
      state.armies = state.armies.filter((a) => a.armyId !== attacker.armyId);
    }
  }
  return events;
}

function updateThreat(state: GameState, ctx: DerivedContext): void {
  const adjacency = buildAdjacency(ctx);
  for (const region of Object.values(state.regions)) {
    let threat = 0;
    for (const army of state.armies) {
      if (army.faction === region.faction) continue;
      if (!isAtWar(state.diplomacy, army.faction, region.faction)) continue;
      if (army.nodeId === region.regionId) threat += 45;
      if ((adjacency[region.regionId] ?? []).some((l) => l.to === army.nodeId)) threat += 22;
    }
    region.threat = clamp(Math.max(region.threat, threat));
  }
}

function addNpcBorderIntel(state: GameState, ctx: DerivedContext, events: GameEvent[]): void {
  const playerRegions = new Set(
    Object.values(state.regions)
      .filter((r) => r.faction === state.factionKey)
      .map((r) => r.name),
  );
  const suspicious = state.armies.find(
    (a) =>
      a.faction !== state.factionKey &&
      isAtWar(state.diplomacy, a.faction, state.factionKey) &&
      (a.status === 'marching' || playerRegions.has(state.regions[a.nodeId]?.name ?? '')),
  );
  if (!suspicious) return;
  const region = state.regions[suspicious.nodeId];
  events.push(
    emitEvent(state, {
      type: 'intel',
      title: '边报（未证实）',
      summary: `${FACTION_SHORT[suspicious.faction]}一支兵团在${region?.name ?? '边境'}一带活动，旗号疑似${suspicious.name}；兵力与意图不明，须派斥候核实。`,
      actorId: 'border-post',
      actorName: '边境烽燧',
      factionKey: state.factionKey,
      targetId: region?.regionId ?? '',
      targetLabel: region?.name ?? '边境',
      payload: { reliability: 0.45, exactTroopsKnown: false },
      evidence: '烽燧观察只能确认旗号与大致方向，不能确认兵力',
      source: 'engine',
      visibleToPlayer: true,
    }),
  );
}

export { makeDate, factionNameOf };

function advanceToNextDay(date: GameState['date']): GameState['date'] {
  return makeDate(date.dayIndex + TURN_DAYS, date.turn + 1);
}
