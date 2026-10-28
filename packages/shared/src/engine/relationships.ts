import type { RelationshipSeed } from '../types.js';

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
