import type { CharacterSeed, FactionKey, RelationshipSeed } from '../types.js';

export interface DefectionAllegiance {
  targetFaction: FactionKey;
  targetPersonId: string;
  targetPersonName: string;
  strength: number;
}

/**
 * A commander can consider defecting only when a strong, explicit, non-hostile
 * relationship connects them to a living person of another faction. War status
 * and runtime allegiance are injected by the caller, so this helper stays pure.
 */
export function findDefectionAllegiance(
  relationships: readonly RelationshipSeed[],
  charactersById: Record<string, CharacterSeed>,
  commanderId: string,
  currentFaction: FactionKey,
  targetFactionOf: (personId: string) => FactionKey | undefined,
  isEligibleTarget: (personId: string, factionKey: FactionKey) => boolean,
): DefectionAllegiance | null {
  const hostile = /竞争|制衡|敌对|不和|争夺|仇敌|追杀/;
  const candidates = new Map<string, DefectionAllegiance>();
  for (const edge of relationships) {
    const targetId = edge.source_person_id === commanderId
      ? edge.target_person_id
      : edge.target_person_id === commanderId
        ? edge.source_person_id
        : '';
    if (!targetId || targetId === commanderId || edge.strength !== '强') continue;
    const target = charactersById[targetId];
    const targetFaction = targetFactionOf(targetId);
    if (!target || !targetFaction || targetFaction === currentFaction) continue;
    if (hostile.test(`${edge.relation} ${edge.notes}`)) continue;
    if (!isEligibleTarget(targetId, targetFaction)) continue;
    const existing = candidates.get(targetId);
    const candidate = {
      targetFaction,
      targetPersonId: targetId,
      targetPersonName: target.name,
      strength: 3,
    };
    if (!existing || candidate.strength > existing.strength) candidates.set(targetId, candidate);
  }
  return [...candidates.values()].sort(
    (a, b) => b.strength - a.strength ||
      a.targetFaction.localeCompare(b.targetFaction) ||
      a.targetPersonId.localeCompare(b.targetPersonId),
  )[0] ?? null;
}

export interface AppointmentRelationshipEffect {
  orderDelta: number;
  loyaltyDelta: number;
  explanation: string;
}

/**
 * Personnel changes are easier to absorb when the incoming official has
 * an explicit working tie to the outgoing governor or the local garrison
 * commander. Explicit rivalries instead create handover friction.
 */
export function appointmentRelationshipEffect(
  relationships: readonly RelationshipSeed[],
  appointeeId: string,
  incumbentId: string,
  localCommanderId: string,
): AppointmentRelationshipEffect {
  const relevant = new Set([incumbentId, localCommanderId].filter((id) => id && id !== appointeeId));
  let orderDelta = 0;
  let loyaltyDelta = 0;
  let positiveTies = 0;
  let hostileTies = 0;

  for (const edge of relationships) {
    const connected = edge.source_person_id === appointeeId
      ? relevant.has(edge.target_person_id)
      : edge.target_person_id === appointeeId && relevant.has(edge.source_person_id);
    if (!connected) continue;

    const relationText = `${edge.relation} ${edge.notes}`;
    const strength = edge.strength === '强' ? 1 : edge.strength === '中' ? 0.65 : 0.4;
    if (/竞争|敌对|不和|争夺|制衡/.test(relationText)) {
      hostileTies += 1;
      orderDelta -= Math.round(3 * strength);
      loyaltyDelta -= Math.round(3 * strength);
      continue;
    }
    if (/副手|副官|协同|副帅|军师|管家|主从|主君/.test(relationText)) {
      positiveTies += 1;
      orderDelta += Math.round(2 * strength);
      loyaltyDelta += Math.round(3 * strength);
      continue;
    }
    if (/配偶|父子|父女|母族|兄妹|同宗|继承/.test(relationText)) {
      positiveTies += 1;
      orderDelta += Math.round(strength);
      loyaltyDelta += Math.round(2 * strength);
    }
  }

  orderDelta = Math.max(-4, Math.min(4, orderDelta));
  loyaltyDelta = Math.max(-4, Math.min(4, loyaltyDelta));
  const explanation = hostileTies > 0
    ? `发现 ${hostileTies} 条显式竞争/制衡关系，交接受掣肘（治安秩序 ${orderDelta >= 0 ? '+' : ''}${orderDelta}，地方忠诚 ${loyaltyDelta >= 0 ? '+' : ''}${loyaltyDelta}）。`
    : positiveTies > 0
      ? `发现 ${positiveTies} 条显式协作/亲缘关系，有助于交接（治安秩序 ${orderDelta >= 0 ? '+' : ''}${orderDelta}，地方忠诚 ${loyaltyDelta >= 0 ? '+' : ''}${loyaltyDelta}）。`
      : '未发现与原任或驻军统领的直接关系，按常规程序交接。';
  return { orderDelta, loyaltyDelta, explanation };
}

/**
 * During a succession crisis, a prince's explicit ties to living same-faction
 * characters help mobilize a political camp. Only recorded graph edges count;
 * this is a small per-turn influence drift, capped to avoid runaway snowballing.
 */
export function successionNetworkInfluence(
  relationships: readonly RelationshipSeed[],
  princeId: string,
  isEligibleSupporter: (personId: string) => boolean,
): number {
  let influence = 0;
  for (const edge of relationships) {
    const otherId = edge.source_person_id === princeId
      ? edge.target_person_id
      : edge.target_person_id === princeId
        ? edge.source_person_id
        : '';
    if (!otherId || otherId === princeId || !isEligibleSupporter(otherId)) continue;
    const weight = edge.strength === '强' ? 0.35 : edge.strength === '中' ? 0.18 : 0.1;
    influence += weight;
  }
  return Math.min(1.5, Math.round(influence * 100) / 100);
}

export interface SuccessionCommandRisk {
  rivalPrinceId: string;
  rivalPrinceName: string;
  rivalAffinity: number;
  crownPrinceAffinity: number;
}

/**
 * During an active succession crisis, a low-loyalty commander may refuse a
 * movement order when explicit ties strongly favor a rival prince whose
 * influence is close to or above the crown prince's. Rivalry edges are not
 * treated as allegiance, and the ruler's side's ties offset the risk.
 */
export function successionCommandRisk(
  relationships: readonly RelationshipSeed[],
  princes: readonly { personId: string; name: string; influence: number; isCrownPrince: boolean }[],
  commanderId: string,
  commanderLoyalty: number,
  crisis: boolean,
): SuccessionCommandRisk | null {
  if (!crisis || commanderLoyalty >= 42 || !commanderId) return null;
  const crown = princes.find((prince) => prince.isCrownPrince);
  if (!crown) return null;

  const affinity = (princeId: string): number => {
    let total = 0;
    for (const edge of relationships) {
      const directlyConnected =
        (edge.source_person_id === commanderId && edge.target_person_id === princeId) ||
        (edge.target_person_id === commanderId && edge.source_person_id === princeId);
      if (!directlyConnected) continue;
      const relationText = `${edge.relation} ${edge.notes}`;
      if (/竞争|制衡|敌对|不和/.test(relationText)) continue;
      const weight = edge.strength === '强' ? 1 : edge.strength === '中' ? 0.6 : 0.3;
      total += weight;
    }
    return Math.min(2, Math.round(total * 100) / 100);
  };

  const crownAffinity = affinity(crown.personId);
  const candidates = princes
    .filter((prince) => !prince.isCrownPrince && prince.influence >= crown.influence - 5)
    .map((prince) => ({ prince, affinity: affinity(prince.personId) }))
    .filter((candidate) => candidate.affinity >= 0.6 && candidate.affinity > crownAffinity + 0.25)
    .sort((a, b) => b.affinity - a.affinity || b.prince.influence - a.prince.influence);
  const strongest = candidates[0];
  if (!strongest) return null;
  return {
    rivalPrinceId: strongest.prince.personId,
    rivalPrinceName: strongest.prince.name,
    rivalAffinity: strongest.affinity,
    crownPrinceAffinity: crownAffinity,
  };
}

/**
 * A battle changes a commander's standing inside the army:
 * - victory restores confidence (larger gain when own losses were modest);
 * - defeat dents command loyalty in proportion to the losses suffered.
 * The caller applies the result to the save's mutable runtime state.
 */
export function battleLoyaltyDelta(won: boolean, casualtyRate: number): number {
  const rate = Math.max(0, Math.min(1, Number.isFinite(casualtyRate) ? casualtyRate : 0));
  if (won) return rate <= 0.08 ? 2 : 1;
  return -Math.min(12, 4 + Math.floor(rate * 18));
}
