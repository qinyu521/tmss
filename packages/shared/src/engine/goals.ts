import type { CharacterGoalType, FactionKey, GameEvent, GameState } from '../types.js';
import type { DerivedContext } from '../dataset.js';
import { isAtWar } from '../dataset.js';
import { buildAdjacency } from './movement.js';
import { emitEvent } from './events.js';
import { clamp } from './state.js';

interface GoalDraft {
  goal: CharacterGoalType;
  targetId?: string;
  targetLabel: string;
  reason: string;
  factionKey: FactionKey;
  priority: number;
}

const GOAL_LABEL: Record<CharacterGoalType, string> = {
  idle: '暂无急务',
  restore_readiness: '整军恢复战备',
  press_frontier: '推进边境战事',
  stabilize_region: '整饬地方秩序',
  demand_patronage: '向王庭施压求援',
  consolidate_power: '扩张个人政治影响',
  protect_house: '维护家族利益',
};

/** 根据实际职位关联与运行时危机刷新目标；不遍历 336 人逐个决策。 */
export function refreshCharacterGoals(state: GameState, ctx: DerivedContext, events: GameEvent[]): void {
  const desired = new Map<string, GoalDraft>();
  const add = (personId: string | undefined, draft: GoalDraft) => {
    if (!personId || !ctx.charactersById[personId] || state.characters[personId]?.alive === false) return;
    const previous = desired.get(personId);
    if (!previous || draft.priority > previous.priority) desired.set(personId, draft);
  };

  const adjacency = buildAdjacency(ctx);
  const enemyAtFrontier = (faction: FactionKey, regionId: string) =>
    (adjacency[regionId] ?? []).some((edge) => {
      const neighbor = state.regions[edge.to];
      return Boolean(neighbor && neighbor.faction !== faction && isAtWar(state.diplomacy, faction, neighbor.faction));
    });

  // 1) 将领目标：战备不足优先整军；每个交战势力至多一支主攻军团。
  for (const army of state.armies) {
    if (army.status !== 'idle') continue;
    if (army.supply < 48 || army.fatigue >= 55 || army.morale < 42) {
      add(army.commanderId, {
        goal: 'restore_readiness',
        targetId: army.armyId,
        targetLabel: army.name,
        reason: '补给、疲劳或士气已越过整军警戒线。',
        factionKey: army.faction,
        priority: 100,
      });
    }
  }
  for (const factionKey of ['HUN', 'YONG', 'CHU'] as const) {
    const enemies = (['HUN', 'YONG', 'CHU'] as const).filter(
      (other) => other !== factionKey && isAtWar(state.diplomacy, factionKey, other),
    );
    if (enemies.length === 0) continue;
    const candidates = state.armies
      .filter((army) =>
        army.faction === factionKey &&
        army.status === 'idle' &&
        army.troops > 4_000 &&
        army.supply >= 58 &&
        army.fatigue < 48 &&
        army.morale >= 48 &&
        !desired.has(army.commanderId) &&
        enemyAtFrontier(factionKey, army.nodeId),
      )
      .sort((a, b) =>
        (b.troops * (0.55 + b.morale / 300 + b.supply / 500 - b.fatigue / 400)) -
        (a.troops * (0.55 + a.morale / 300 + a.supply / 500 - a.fatigue / 400)) ||
        a.armyId.localeCompare(b.armyId),
      );
    const vanguard = candidates[0];
    if (vanguard) {
      add(vanguard.commanderId, {
        goal: 'press_frontier',
        targetId: vanguard.armyId,
        targetLabel: vanguard.name,
        reason: '本军团战备合格，且己方与敌方在边境存在可交战接触。',
        factionKey,
        priority: 40,
      });
    }
  }

  // 2) 地方主官：每个势力只让最急需处理的两个州府进入主动整饬目标。
  for (const factionKey of ['HUN', 'YONG', 'CHU'] as const) {
    const unstable = Object.values(state.regions)
      .filter((region) => region.faction === factionKey && (region.order < 55 || region.loyalty < 50))
      .sort((a, b) =>
        Math.min(a.order, a.loyalty) - Math.min(b.order, b.loyalty) ||
        a.regionId.localeCompare(b.regionId),
      )
      .slice(0, 2);
    for (const region of unstable) {
      add(region.governorId, {
        goal: 'stabilize_region',
        targetId: region.regionId,
        targetLabel: region.name,
        reason: `地方秩序为 ${Math.round(region.order)}、民心为 ${Math.round(region.loyalty)}，已低于整饬目标线。`,
        factionKey,
        priority: 85,
      });
    }
  }

  // 3) 政治集团：只追踪当下最紧迫的领袖，避免每回合让所有人物同时做决定。
  const dissatisfiedTribe = [...(state.special.HUN.tribes ?? [])]
    .filter((tribe) => tribe.loyalty < 50)
    .sort((a, b) => a.loyalty - b.loyalty || a.tribeId.localeCompare(b.tribeId))[0];
  if (dissatisfiedTribe) {
    add(dissatisfiedTribe.chiefId, {
      goal: 'demand_patronage',
      targetId: dissatisfiedTribe.tribeId,
      targetLabel: dissatisfiedTribe.name,
      reason: `部落忠诚降至 ${Math.round(dissatisfiedTribe.loyalty)}，诉求尚未解决。`,
      factionKey: 'HUN',
      priority: 80,
    });
  }

  const yong = state.special.YONG;
  const leadingPrince = [...(yong.princes ?? [])].sort(
    (a, b) => b.influence - a.influence || a.personId.localeCompare(b.personId),
  )[0];
  if (leadingPrince && (state.flags.successionCrisis || (leadingPrince.ambition >= 65 && leadingPrince.influence >= 60))) {
    add(leadingPrince.personId, {
      goal: 'consolidate_power',
      targetId: leadingPrince.personId,
      targetLabel: leadingPrince.name,
      reason: `皇子野心 ${Math.round(leadingPrince.ambition)}、影响力 ${Math.round(leadingPrince.influence)}，正在争取更大政治空间。`,
      factionKey: 'YONG',
      priority: 78,
    });
  }

  const lowestHouse = [...(state.special.CHU.houses ?? [])].sort(
    (a, b) => a.support - b.support || a.houseId.localeCompare(b.houseId),
  )[0];
  if (lowestHouse && (state.flags.houseBoycott || lowestHouse.support < 52)) {
    add(lowestHouse.patriarchId, {
      goal: 'protect_house',
      targetId: lowestHouse.houseId,
      targetLabel: lowestHouse.name,
      reason: `世家支持度为 ${Math.round(lowestHouse.support)}，家族开始优先维护自身利益。`,
      factionKey: 'CHU',
      priority: 76,
    });
  }

  // 统一写回：同一目标跨回合保持，不每回合随机换动机。
  for (const [personId, runtime] of Object.entries(state.characters)) {
    const draft = desired.get(personId);
    const nextGoal = draft?.goal ?? 'idle';
    const nextTarget = draft?.targetId;
    const oldGoal = runtime.goal ?? 'idle';
    const oldTarget = runtime.goalTargetId;
    const changed = oldGoal !== nextGoal || (oldTarget ?? '') !== (nextTarget ?? '');
    if (!changed) {
      runtime.goal ??= 'idle';
      runtime.goalSinceTurn ??= state.date.turn;
      continue;
    }

    runtime.goal = nextGoal;
    runtime.goalTargetId = nextTarget;
    runtime.goalReason = draft?.reason;
    runtime.goalSinceTurn = state.date.turn;
    runtime.goalLastActionTurn = undefined;

    // 只记录活跃目标之间的变化，首次初始化与回到 idle 不制造叙事噪音。
    if (state.date.turn > 1 && oldGoal !== 'idle' && nextGoal !== 'idle' && draft) {
      const person = ctx.charactersById[personId];
      events.push(
        emitEvent(state, {
          type: 'npc_action',
          title: `${person?.name ?? personId}调整个人目标`,
          summary: `${person?.name ?? personId}由「${GOAL_LABEL[oldGoal]}」转向「${GOAL_LABEL[nextGoal]}」：${draft.reason}`,
          actorId: personId,
          actorName: person?.name ?? personId,
          factionKey: draft.factionKey,
          targetId: draft.targetId,
          targetLabel: draft.targetLabel,
          after: { goal: nextGoal, goalTargetId: nextTarget, goalSinceTurn: state.date.turn },
          payload: { action: 'goal_changed', previousGoal: oldGoal, goal: nextGoal, reason: draft.reason },
          evidence: '人物目标由在世状态、职务关系、军团战备和政治集团指标按确定性规则推导。',
          source: 'engine',
          visibleToPlayer: draft.factionKey === state.factionKey,
        }),
      );
    }
  }
}

/** 目标转为有代价、有冷却的行动；本函数只改规则状态并留下事件，不改写历史事实。 */
export function advanceCharacterGoals(state: GameState, ctx: DerivedContext, events: GameEvent[]): void {
  const turn = state.date.turn;
  const cooldownReady = (lastActionTurn?: number) => lastActionTurn === undefined || turn - lastActionTurn >= 4;

  const record = (
    factionKey: FactionKey,
    actorId: string,
    actorName: string,
    targetId: string,
    targetLabel: string,
    title: string,
    summary: string,
    before: Record<string, unknown>,
    after: Record<string, unknown>,
    action: string,
  ) => {
    events.push(
      emitEvent(state, {
        type: 'npc_action',
        title,
        summary,
        actorId,
        actorName,
        factionKey,
        targetId,
        targetLabel,
        before,
        after,
        payload: { action, goal: state.characters[actorId]?.goal, goalSinceTurn: state.characters[actorId]?.goalSinceTurn },
        evidence: '自主行动由当前目标、职位关联、现实阈值和四回合冷却规则共同决定。',
        source: 'npc_ai',
        visibleToPlayer: factionKey === state.factionKey,
      }),
    );
  };

  for (const [personId, runtime] of Object.entries(state.characters).sort(([a], [b]) => a.localeCompare(b))) {
    const goal = runtime.goal ?? 'idle';
    if (goal === 'idle' || !cooldownReady(runtime.goalLastActionTurn)) continue;
    const person = ctx.charactersById[personId];
    if (!person || !runtime.alive) continue;

    if (goal === 'stabilize_region' && runtime.goalTargetId) {
      const region = state.regions[runtime.goalTargetId];
      if (!region || region.faction !== person.faction_key || region.governorId !== personId) continue;
      const faction = state.factions[person.faction_key];
      if ((region.order >= 58 && region.loyalty >= 58) || faction.resources.cash < 4_000) continue;
      const before = {
        cash: Math.round(faction.resources.cash),
        order: Math.round(region.order),
        loyalty: Math.round(region.loyalty),
      };
      faction.resources.cash -= 4_000;
      region.order = clamp(region.order + 3);
      region.loyalty = clamp(region.loyalty + 2);
      runtime.goalLastActionTurn = turn;
      record(person.faction_key, personId, person.name, region.regionId, region.name, `${person.name}整饬${region.name}`,
        `${person.name}判断地方秩序与民心已成隐患，拨银 4,000 两修复治安与民心；秩序 +3，民心 +2。`,
        before, { cash: Math.round(faction.resources.cash), order: Math.round(region.order), loyalty: Math.round(region.loyalty) }, 'stabilize_region');
      continue;
    }

    if (goal === 'demand_patronage' && runtime.goalTargetId && person.faction_key === 'HUN') {
      const tribe = state.special.HUN.tribes?.find((item) => item.tribeId === runtime.goalTargetId);
      if (!tribe || tribe.loyalty >= 48) continue;
      const before = { loyalty: Math.round(tribe.loyalty), stance: tribe.stance };
      tribe.loyalty = clamp(tribe.loyalty - 2);
      tribe.stance = tribe.loyalty >= 65 ? 'eager' : tribe.loyalty >= 50 ? 'watchful' : tribe.loyalty >= 38 ? 'reluctant' : 'refusing';
      runtime.goalLastActionTurn = turn;
      record('HUN', personId, person.name, tribe.tribeId, tribe.name, `${person.name}再呈请命`,
        `${tribe.name}认为诉求仍未获满足，首领${person.name}再次向王庭施压；部落忠诚 -2。`,
        before, { loyalty: Math.round(tribe.loyalty), stance: tribe.stance }, 'demand_patronage');
      continue;
    }

    if (goal === 'consolidate_power' && runtime.goalTargetId && person.faction_key === 'YONG') {
      const prince = state.special.YONG.princes?.find((item) => item.personId === runtime.goalTargetId);
      const court = state.special.YONG;
      if (!prince || prince.ambition < 65 || prince.influence < 60) continue;
      if (!state.flags.successionCrisis && (court.courtStability ?? 60) >= 55) continue;
      const before = {
        influence: Math.round(prince.influence),
        trust: Math.round(prince.trust),
        courtStability: Math.round(court.courtStability ?? 60),
      };
      prince.influence = clamp(prince.influence + 2);
      prince.trust = clamp(prince.trust - 1);
      runtime.goalLastActionTurn = turn;
      record('YONG', personId, person.name, prince.personId, prince.name, `${person.name}经营自身派系`,
        `${person.name}乘朝局未稳扩充亲信与影响力；影响力 +2，皇帝信任 -1。`,
        before, { influence: Math.round(prince.influence), trust: Math.round(prince.trust), courtStability: Math.round(court.courtStability ?? 60) }, 'consolidate_power');
      continue;
    }

    if (goal === 'protect_house' && runtime.goalTargetId && person.faction_key === 'CHU') {
      const house = state.special.CHU.houses?.find((item) => item.houseId === runtime.goalTargetId);
      if (!house || house.support >= 48 || house.lastNegotiationTurn >= turn) continue;
      const before = { support: Math.round(house.support), taxCompliance: house.taxCompliance };
      house.support = clamp(house.support - 1);
      house.taxCompliance = Math.round((0.6 + house.support / 250) * 100) / 100;
      runtime.goalLastActionTurn = turn;
      record('CHU', personId, person.name, house.houseId, house.name, `${house.name}转向自保`,
        `${person.name}认为世家利益未获保障，动员家族消极配合；支持度 -1。`,
        before, { support: Math.round(house.support), taxCompliance: house.taxCompliance }, 'protect_house');
    }
  }
}
