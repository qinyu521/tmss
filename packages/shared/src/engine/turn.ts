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
import { clearMarch, buildAdjacency } from './movement.js';
import { marchFatigueSeasonFactor, SEASON_LABELS, seasonOf } from './season.js';
import { retreatRegion as retreatGuard, resolveBattle } from './battle.js';
import { runEconomy, politicalTags, shortageTags } from './economy.js';
import { runPolitics } from './politics.js';
import { runLifecycle } from './lifecycle.js';
import { buildChronicle } from './chronicle.js';
import { clamp, factionNameOf } from './state.js';

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
    case 'recruit':
      return res.cash >= order.amount * BALANCE.recruit.cashPerMan && res.manpower >= order.amount;
    case 'appease_tribe':
      return res.cash >= order.amount;
    case 'balance_princes':
      return res.cash >= BALANCE.balancePrinces.cashCost;
    case 'negotiate_house':
      return res.cash >= BALANCE.negotiateHouse.cashCost;
    case 'levy_grain':
      return Object.values(state.regions)
        .filter((r) => r.faction === factionKey)
        .some((r) => r.foodStore > 0);
    default:
      return true;
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
        army.marchDaysLeft = Math.max(0, army.marchDaysLeft - remainingDays);
        remainingDays = 0;
        break;
      }
      remainingDays -= hop;
      const nextRegionId = army.path.shift() as string;
      army.hopCosts.shift();
      army.marchDaysLeft = army.hopCosts.reduce((s, d) => s + d, 0);
      const previous = army.nodeId;
      army.nodeId = nextRegionId;
      army.originRegionId = previous;
      const region = state.regions[nextRegionId];
      army.supply = clamp(army.supply - hop * BALANCE.army.marchSupplyDrainPerDay);
      army.fatigue = clamp(army.fatigue + hop * BALANCE.army.fatigueMarchPerDay * marchFatigueSeasonFactor(season, army.faction));

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
  const outcome = resolveBattle(state, ctx, attacker, defender ?? null, region, seed);
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
      summary: outcome.narrative,
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
