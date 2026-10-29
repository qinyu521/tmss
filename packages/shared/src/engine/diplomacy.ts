import type {
  DiplomaticAction,
  DiplomaticTreaty,
  FactionKey,
  GameEvent,
  GameState,
  Order,
  OrderValidation,
} from '../types.js';
import { BALANCE } from '../balance.js';
import { diplomacyKey, isAtWar } from '../dataset.js';
import { emitEvent } from './events.js';

const RELATIONSHIP_COST = 12_000;
const PEACE_MISSION_COST = 5_000;
const ALLIANCE_MISSION_COST = 25_000;
const WAR_THRESHOLD = BALANCE.warThreshold;

const clampRelation = (value: number) => Math.max(-100, Math.min(100, Math.round(value)));
const treatyActive = (state: GameState, treaty: DiplomaticTreaty) =>
  treaty.kind === 'alliance' && treaty.status === 'active' && state.date.turn <= treaty.endTurn;

export function activeAlliance(state: GameState, a: FactionKey, b: FactionKey): DiplomaticTreaty | undefined {
  if (a === b) return undefined;
  return (state.treaties ?? []).find((treaty) =>
    treatyActive(state, treaty) &&
    ((treaty.a === a && treaty.b === b) || (treaty.a === b && treaty.b === a)),
  );
}

function anyActiveAlliance(state: GameState, faction: FactionKey): DiplomaticTreaty | undefined {
  return (state.treaties ?? []).find((treaty) =>
    treatyActive(state, treaty) && (treaty.a === faction || treaty.b === faction),
  );
}

function activeAlliancePartner(state: GameState, treaty: DiplomaticTreaty, faction: FactionKey): FactionKey {
  return treaty.a === faction ? treaty.b : treaty.a;
}

function relationship(state: GameState, a: FactionKey, b: FactionKey): number {
  return state.diplomacy[diplomacyKey(a, b)] ?? 0;
}

function allianceCanBeFormed(state: GameState, a: FactionKey, b: FactionKey): boolean {
  // One active bilateral alliance per faction prevents contradictory three-way blocs in a three-faction world.
  return !anyActiveAlliance(state, a) && !anyActiveAlliance(state, b);
}

function diplomacyIssue(code: string, message: string): OrderValidation {
  return { ok: false, issues: [{ code, message }] };
}

export function validateDiplomaticAction(
  state: GameState,
  order: Extract<Order, { kind: 'diplomatic_action' }>,
): OrderValidation {
  const self = state.factionKey;
  const target = order.targetFaction;
  if (self === target) return diplomacyIssue('TARGET_SELF', '不能对本势力进行外交行动。');
  if (!state.factions[target]) return diplomacyIssue('TARGET_NOT_FOUND', '目标势力不存在。');
  const relation = relationship(state, self, target);
  const atWar = isAtWar(state.diplomacy, self, target);
  const alliance = activeAlliance(state, self, target);
  const cash = state.factions[self].resources.cash;

  switch (order.action) {
    case 'improve_relations':
      if (atWar) return diplomacyIssue('AT_WAR', '双方仍在交战，必须先议和，才能恢复正常邦交。');
      if (alliance) return diplomacyIssue('ALLIED', '双方已有有效盟约，无需重复派遣修好使团。');
      if (relation >= 85) return diplomacyIssue('RELATIONS_HIGH', '双方关系已相当友好，可改为提出盟约。');
      if (cash < RELATIONSHIP_COST) return diplomacyIssue('NO_CASH', `修好使团需要 ${RELATIONSHIP_COST.toLocaleString()} 两。`);
      return {
        ok: true,
        issues: [],
        preview: `派遣使团修好 ${state.factions[target].shortName}，耗银 ${RELATIONSHIP_COST.toLocaleString()} 两，关系预计 +18（上限 100）。`,
      };
    case 'declare_war':
      if (atWar) return diplomacyIssue('ALREADY_AT_WAR', '双方已经处于交战状态。');
      if (alliance) return diplomacyIssue('ALLIED', '不能直接向盟友宣战；须先废止盟约并承担失信代价。');
      return {
        ok: true,
        issues: [],
        preview: `对 ${state.factions[target].shortName} 宣战；声望 -3、稳定 -2。若对方有有效盟友，该盟友将按防御盟约参战。`,
      };
    case 'offer_peace':
      if (!atWar) return diplomacyIssue('NOT_AT_WAR', '双方并未交战，无需议和。');
      if (cash < PEACE_MISSION_COST) return diplomacyIssue('NO_CASH', `议和使团需要 ${PEACE_MISSION_COST.toLocaleString()} 两；即使对方拒绝也会产生使节开销。`);
      return {
        ok: true,
        issues: [],
        preview: `派遣议和使团，耗银 ${PEACE_MISSION_COST.toLocaleString()} 两；是否停战取决于对方战损、疆土与军需压力，拒绝也会留下外交记录。`,
      };
    case 'propose_alliance':
      if (atWar) return diplomacyIssue('AT_WAR', '交战双方须先停战，才能缔结盟约。');
      if (alliance) return diplomacyIssue('ALLIED', '双方已有有效盟约。');
      if (relation < 25) return diplomacyIssue('RELATIONSHIP_TOO_LOW', '关系至少达到 25 才适合提出盟约；可先派使团修好。');
      if (!allianceCanBeFormed(state, self, target)) {
        return diplomacyIssue('ALLIANCE_BLOCK', '你方或对方已有有效盟友。当前三国局势下，为避免互相矛盾的三角盟约，须先处理既有盟约。');
      }
      if (cash < ALLIANCE_MISSION_COST) return diplomacyIssue('NO_CASH', `缔盟使团需要 ${ALLIANCE_MISSION_COST.toLocaleString()} 两。`);
      return {
        ok: true,
        issues: [],
        preview: `向 ${state.factions[target].shortName} 提出 8 回合防御盟约，耗银 ${ALLIANCE_MISSION_COST.toLocaleString()} 两；对方会依据关系与共同敌人决定是否接受。`,
      };
    case 'break_alliance':
      if (!alliance) return diplomacyIssue('NO_TREATY', '双方没有有效盟约可供废止。');
      return {
        ok: true,
        issues: [],
        preview: `废止与 ${state.factions[target].shortName} 的盟约；关系将显著恶化，声望 -5、稳定 -3。本回合不能再提交第二项外交行动。`,
      };
    default:
      return diplomacyIssue('BAD_DIPLOMATIC_ACTION', '未知外交行动。');
  }
}

function emitDiplomacyEvent(
  state: GameState,
  events: GameEvent[],
  factionKey: FactionKey,
  actorId: string,
  actorName: string,
  targetFaction: FactionKey,
  title: string,
  summary: string,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  payload: Record<string, unknown>,
  source: GameEvent['source'],
): void {
  events.push(
    emitEvent(state, {
      type: 'diplomacy',
      title,
      summary,
      actorId,
      actorName,
      factionKey,
      targetId: targetFaction,
      targetLabel: state.factions[targetFaction].name,
      before,
      after,
      payload,
      evidence: '外交规则：关系数值、有效盟约、军政压力与明示行动共同决定；不由 LLM 改写结算。',
      source,
      visibleToPlayer: state.factionKey === factionKey || state.factionKey === targetFaction,
    }),
  );
}

function peaceAcceptanceScore(state: GameState, proposer: FactionKey, target: FactionKey): number {
  const targetRegions = Object.values(state.regions).filter((region) => region.faction === target).length;
  const lostRegions = Math.max(0, 8 - targetRegions);
  const resources = state.factions[target].resources;
  const shortageBonus = (resources.cash < 15_000 ? 8 : 0) + (resources.grain < 40_000 ? 8 : 0);
  return relationship(state, proposer, target) + 20 + lostRegions * 12 + shortageBonus;
}

export function applyDiplomaticAction(
  state: GameState,
  order: Extract<Order, { kind: 'diplomatic_action' }>,
  events: GameEvent[],
  source: GameEvent['source'],
  factionKey: FactionKey,
  actorId: string,
  actorName: string,
): void {
  const self = factionKey;
  const target = order.targetFaction;
  if (self === target || !state.factions[target]) return;
  const relationKey = diplomacyKey(self, target);
  const beforeRelation = relationship(state, self, target);
  const beforeCash = Math.round(state.factions[self].resources.cash);
  const faction = state.factions[self];

  switch (order.action) {
    case 'improve_relations': {
      faction.resources.cash -= RELATIONSHIP_COST;
      state.diplomacy[relationKey] = clampRelation(beforeRelation + 18);
      emitDiplomacyEvent(
        state, events, self, actorId, actorName, target,
        `修好使团抵达${state.factions[target].shortName}`,
        `耗银 ${RELATIONSHIP_COST.toLocaleString()} 两，双方关系由 ${beforeRelation} 升至 ${state.diplomacy[relationKey]}。`,
        { relation: beforeRelation, cash: beforeCash },
        { relation: state.diplomacy[relationKey], cash: Math.round(faction.resources.cash) },
        { action: order.action, relationDelta: state.diplomacy[relationKey] - beforeRelation },
        source,
      );
      return;
    }
    case 'declare_war': {
      state.diplomacy[relationKey] = clampRelation(Math.min(beforeRelation - 20, WAR_THRESHOLD - 1));
      const oldReputation = Math.round(faction.reputation);
      const oldStability = Math.round(faction.stability);
      faction.reputation = Math.max(0, faction.reputation - 3);
      faction.stability = Math.max(0, faction.stability - 2);
      emitDiplomacyEvent(
        state, events, self, actorId, actorName, target,
        `${state.factions[self].shortName}向${state.factions[target].shortName}宣战`,
        `邦交由 ${beforeRelation} 降至 ${state.diplomacy[relationKey]}，声望 -3、稳定 -2；战争状态立即生效。`,
        { relation: beforeRelation, reputation: oldReputation, stability: oldStability },
        { relation: state.diplomacy[relationKey], reputation: Math.round(faction.reputation), stability: Math.round(faction.stability) },
        { action: order.action, warDeclared: true },
        source,
      );

      // 防御盟约：被宣战的一方若有盟友，盟友会加入防守方。每个势力只可有一个有效盟友，避免三角盟约冲突。
      const defensiveTreaty = (state.treaties ?? []).find((treaty) =>
        treatyActive(state, treaty) && (treaty.a === target || treaty.b === target),
      );
      if (defensiveTreaty) {
        const ally = activeAlliancePartner(state, defensiveTreaty, target);
        if (ally !== self && !isAtWar(state.diplomacy, self, ally)) {
          const allyRelationKey = diplomacyKey(self, ally);
          const oldAllyRelation = relationship(state, self, ally);
          state.diplomacy[allyRelationKey] = clampRelation(Math.min(oldAllyRelation - 20, WAR_THRESHOLD - 1));
          emitDiplomacyEvent(
            state, events, self, 'system', '盟约使节', ally,
            `${state.factions[ally].shortName}响应防御盟约`,
            `由于${state.factions[target].shortName}遭到宣战，盟友依约加入防守方；与${state.factions[self].shortName}关系由 ${oldAllyRelation} 降至 ${state.diplomacy[allyRelationKey]}。`,
            { relation: oldAllyRelation, treatyId: defensiveTreaty.treatyId, treatyEndTurn: defensiveTreaty.endTurn },
            { relation: state.diplomacy[allyRelationKey], atWar: true },
            { action: 'defensive_call_to_arms', treatyId: defensiveTreaty.treatyId, defendingFaction: target },
            source,
          );
        }
      }
      return;
    }
    case 'offer_peace': {
      faction.resources.cash -= PEACE_MISSION_COST;
      const score = peaceAcceptanceScore(state, self, target);
      const accepted = score >= -10;
      if (accepted) {
        state.diplomacy[relationKey] = clampRelation(Math.max(beforeRelation + 25, WAR_THRESHOLD + 5));
      } else {
        state.diplomacy[relationKey] = clampRelation(beforeRelation + 2);
      }
      emitDiplomacyEvent(
        state, events, self, actorId, actorName, target,
        accepted ? `议和成功：与${state.factions[target].shortName}停战` : `议和遭拒：${state.factions[target].shortName}不肯罢兵`,
        accepted
          ? `对方接受和平条件，双方停止交战；关系由 ${beforeRelation} 调整至 ${state.diplomacy[relationKey]}。`
          : `对方拒绝和平条件（议和评估分 ${score}，需至少 -10）；使节往返仍耗银 ${PEACE_MISSION_COST.toLocaleString()} 两，关系小幅改善。`,
        { relation: beforeRelation, cash: beforeCash, targetControlledRegions: Object.values(state.regions).filter((region) => region.faction === target).length },
        { relation: state.diplomacy[relationKey], cash: Math.round(faction.resources.cash), atWar: isAtWar(state.diplomacy, self, target), accepted },
        { action: order.action, accepted, acceptanceScore: score, peaceMissionCost: PEACE_MISSION_COST },
        source,
      );
      return;
    }
    case 'propose_alliance': {
      faction.resources.cash -= ALLIANCE_MISSION_COST;
      const commonEnemy = (['HUN', 'YONG', 'CHU'] as const).some(
        (third) => third !== self && third !== target &&
          isAtWar(state.diplomacy, self, third) && isAtWar(state.diplomacy, target, third),
      );
      const score = beforeRelation + (commonEnemy ? 15 : 0);
      const accepted = score >= 40;
      if (accepted) {
        const treaty: DiplomaticTreaty = {
          treatyId: `treaty-${state.gameId}-${relationKey.replace('|', '-')}-T${state.date.turn}`,
          kind: 'alliance',
          a: self,
          b: target,
          startTurn: state.date.turn,
          endTurn: state.date.turn + 7,
          status: 'active',
        };
        state.treaties.push(treaty);
        state.diplomacy[relationKey] = clampRelation(Math.max(beforeRelation, 45));
        emitDiplomacyEvent(
          state, events, self, actorId, actorName, target,
          `盟约成立：${state.factions[self].shortName}与${state.factions[target].shortName}`,
          `对方接受防御盟约，有效期至第 ${treaty.endTurn} 回合结束；关系由 ${beforeRelation} 调整至 ${state.diplomacy[relationKey]}。`,
          { relation: beforeRelation, cash: beforeCash },
          { relation: state.diplomacy[relationKey], cash: Math.round(faction.resources.cash), treatyEndTurn: treaty.endTurn, atWar: false },
          { action: order.action, accepted, acceptanceScore: score, treatyId: treaty.treatyId, kind: treaty.kind },
          source,
        );
      } else {
        state.diplomacy[relationKey] = clampRelation(beforeRelation + 2);
        emitDiplomacyEvent(
          state, events, self, actorId, actorName, target,
          `结盟未成：${state.factions[target].shortName}拒绝缔盟`,
          `对方认为条件不足（评估分 ${score}，需至少 40）；使团耗银 ${ALLIANCE_MISSION_COST.toLocaleString()} 两，邦交略有改善。`,
          { relation: beforeRelation, cash: beforeCash },
          { relation: state.diplomacy[relationKey], cash: Math.round(faction.resources.cash), accepted: false },
          { action: order.action, accepted, acceptanceScore: score, allianceMissionCost: ALLIANCE_MISSION_COST },
          source,
        );
      }
      return;
    }
    case 'break_alliance': {
      const treaty = activeAlliance(state, self, target);
      if (!treaty) return;
      treaty.status = 'broken';
      state.diplomacy[relationKey] = clampRelation(Math.min(beforeRelation - 40, -20));
      faction.reputation = Math.max(0, faction.reputation - 5);
      faction.stability = Math.max(0, faction.stability - 3);
      emitDiplomacyEvent(
        state, events, self, actorId, actorName, target,
        `盟约废止：与${state.factions[target].shortName}决裂`,
        `盟约在第 ${state.date.turn} 回合被废止，关系由 ${beforeRelation} 降至 ${state.diplomacy[relationKey]}；声望 -5、稳定 -3。宣战须另下军令。`,
        { relation: beforeRelation, treatyId: treaty.treatyId, reputation: Math.round(faction.reputation + 5), stability: Math.round(faction.stability + 3) },
        { relation: state.diplomacy[relationKey], status: treaty.status, reputation: Math.round(faction.reputation), stability: Math.round(faction.stability) },
        { action: order.action, treatyId: treaty.treatyId, treatyBroken: true },
        source,
      );
      return;
    }
  }
}

/** 在回合开始时结束到期盟约，留存历史记录但不影响既有关系或战争事实。 */
export function expireDiplomaticTreaties(state: GameState, events: GameEvent[]): void {
  for (const treaty of state.treaties ?? []) {
    if (treaty.status !== 'active' || state.date.turn <= treaty.endTurn) continue;
    const beforeRelation = relationship(state, treaty.a, treaty.b);
    treaty.status = 'expired';
    const key = diplomacyKey(treaty.a, treaty.b);
    state.diplomacy[key] = clampRelation(beforeRelation + 5);
    emitDiplomacyEvent(
      state, events, treaty.a, 'system', '盟约簿吏', treaty.b,
      `盟约期满：${state.factions[treaty.a].shortName}与${state.factions[treaty.b].shortName}`,
      `第 ${treaty.endTurn} 回合的防御盟约已期满；双方关系由 ${beforeRelation} 改善至 ${state.diplomacy[key]}，此后不再自动相互防卫。`,
      { relation: beforeRelation, treatyId: treaty.treatyId, endTurn: treaty.endTurn },
      { relation: state.diplomacy[key], status: treaty.status },
      { action: 'treaty_expired', treatyId: treaty.treatyId },
      'engine',
    );
  }
}
