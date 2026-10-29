import type { CourtAgenda, CourtDecision, CourtResolution, RelationshipSeed } from '../types.js';

/** Only the character attributes needed to reason about an agenda; shared by engine and UI. */
export interface CourtAdvisorProfile {
  name: string;
  identity_type: string;
  current_position_standard: string;
  house_or_clan: string;
  command: number;
  strategy: number;
  intrigue: number;
  governance: number;
  commerce: number;
  loyalty: number;
  courtStanding?: number;
}

/** Shared policy costs; NPC and player councils must pay the same costs. */
export function courtCost(agenda: CourtAgenda, decision: CourtDecision): number {
  const costs: Record<CourtAgenda, Record<CourtDecision, number>> = {
    war_council: { assertive: 12_000, balanced: 6_000, conciliatory: 0 },
    succession: { assertive: 8_000, balanced: 12_000, conciliatory: 10_000 },
    tribal_alliance: { assertive: 0, balanced: 6_000, conciliatory: 12_000 },
    clan_relations: { assertive: 0, balanced: 6_000, conciliatory: 12_000 },
  };
  return costs[agenda][decision];
}

export function courtSkill(person: CourtAdvisorProfile | undefined, agenda: CourtAgenda): number {
  if (!person) return 50;
  const standingModifier = ((person.courtStanding ?? 50) - 50) * 0.12;
  if (agenda === 'war_council') return person.strategy * 0.6 + person.command * 0.4 + standingModifier;
  if (agenda === 'succession') return person.intrigue * 0.45 + person.loyalty * 0.3 + person.governance * 0.25 + standingModifier;
  if (agenda === 'tribal_alliance') return person.loyalty * 0.5 + person.command * 0.2 + person.intrigue * 0.3 + standingModifier;
  return person.governance * 0.45 + person.commerce * 0.35 + person.intrigue * 0.2 + standingModifier;
}

/**
 * A character's established ties to the people directly involved in an agenda
 * add political weight to their arguments. Only explicit seed relationship
 * edges count; family/clan labels are never inferred from names.
 */
export function courtRelationshipAffinity(
  relationships: readonly RelationshipSeed[],
  personId: string,
  agenda: CourtAgenda,
  politicalTargetIds: readonly string[],
): number {
  if (!personId || politicalTargetIds.length === 0) return 0;
  const targets = new Set(politicalTargetIds.filter((id) => id && id !== personId));
  let best = 0;
  for (const relationship of relationships) {
    const connected = relationship.source_person_id === personId
      ? targets.has(relationship.target_person_id)
      : relationship.target_person_id === personId && targets.has(relationship.source_person_id);
    if (!connected) continue;
    let score = relationship.strength === '强' ? 8 : relationship.strength === '中' ? 4 : 2;
    if (/竞争|制衡/.test(relationship.relation)) score += 4;
    const contextPattern: Record<CourtAgenda, RegExp> = {
      war_council: /主君|副将|军师|统帅|副帅|部堂|州府|协同|制衡/,
      succession: /配偶|父|母族|兄妹|宗|继承|皇|制衡|竞争/,
      tribal_alliance: /主君|副将|军师|统帅|首领|部落|继承|制衡|竞争/,
      clan_relations: /家主|谋士|管家|世家|竞争|制衡|主君|副手|州府/,
    };
    if (contextPattern[agenda].test(relationship.relation)) score += 2;
    best = Math.max(best, score);
  }
  return Math.min(14, best);
}

/**
 * Long-running political grudges make an adviser less persuasive when the agenda
 * directly concerns someone they resent. The penalty is deterministic, saved in
 * character runtime state, and capped so one feud cannot silence an adviser.
 */
export function politicalGrudgeCourtPenalty(
  grudges: Readonly<Record<string, number>> | undefined,
  politicalTargetIds: readonly string[],
): number {
  if (!grudges || politicalTargetIds.length === 0) return 0;
  const total = Array.from(new Set(politicalTargetIds.filter(Boolean))).reduce(
    (sum, targetId) => sum + Math.max(0, Number.isFinite(grudges[targetId]) ? grudges[targetId] : 0),
    0,
  );
  return Math.min(10, Math.round((total / 3) * 100) / 100);
}

/** The policy each adviser prefers; the ruler may adopt either side or choose a compromise. */
export function courtRecommendedDecision(person: CourtAdvisorProfile, agenda: CourtAgenda): CourtDecision {
  const position = `${person.identity_type} ${person.current_position_standard}`;
  if (agenda === 'war_council') {
    if (person.command >= 75 && person.command >= person.strategy + 6) return 'assertive';
    if (person.strategy >= 75) return 'balanced';
    if (person.loyalty < 45) return 'conciliatory';
    return 'balanced';
  }
  if (agenda === 'succession') {
    if (/储君|太子/.test(position)) return person.loyalty >= 60 ? 'assertive' : 'balanced';
    if (/皇子|宗王|藩王/.test(position) || person.intrigue >= 78) {
      return person.intrigue >= 72 && person.loyalty < 62 ? 'assertive' : 'balanced';
    }
    if (person.governance >= 72 && person.loyalty >= 65) return 'balanced';
    return 'conciliatory';
  }
  if (agenda === 'tribal_alliance') {
    if (/首领|部落|盟主|酋长/.test(position) || person.loyalty >= 76) return 'conciliatory';
    if (person.command >= 74) return 'assertive';
    return 'balanced';
  }
  if (person.house_or_clan.trim() || /世家|家主|宗族|地方豪强/.test(position)) return 'conciliatory';
  if (person.governance >= 75 && person.commerce >= 65) return 'balanced';
  if (person.intrigue >= 75) return 'assertive';
  return 'balanced';
}

export function courtDecisionForResolution(
  agenda: CourtAgenda,
  resolution: CourtResolution | undefined,
  speaker: CourtAdvisorProfile | undefined,
  opposition: CourtAdvisorProfile | undefined,
  fallback: CourtDecision = 'balanced',
): CourtDecision {
  if (resolution === 'compromise') return 'balanced';
  if (resolution === 'adopt_speaker' && speaker) return courtRecommendedDecision(speaker, agenda);
  if (resolution === 'adopt_opposition' && opposition) return courtRecommendedDecision(opposition, agenda);
  return fallback;
}

/** Attribute- and position-driven arguments. They are deterministic, so the same character speaks consistently. */
export function courtOpinion(person: CourtAdvisorProfile, agenda: CourtAgenda): string {
  const position = `${person.identity_type} ${person.current_position_standard}`;
  if (agenda === 'war_council') {
    if (person.command >= 75 && person.command >= person.strategy + 6) {
      return '主张集中兵力、抢占战机，以强军先制敌；反对久议失机';
    }
    if (person.strategy >= 75) {
      return '主张先核道路、粮道与敌情，再决定出兵节奏，避免胜而无粮';
    }
    if (person.loyalty < 45) {
      return '担忧军心与军饷承压，主张先整顿军纪、补足后勤';
    }
    return '主张有限备边、保留机动兵力，避免同时拉开多条战线';
  }
  if (agenda === 'succession') {
    if (/储君|太子/.test(position)) {
      return person.loyalty >= 60
        ? '主张确认储位名分，以制度压住诸王争议'
        : '主张暂缓公开定储，先争取朝臣与军区支持';
    }
    if (/皇子|宗王|藩王/.test(position) || person.intrigue >= 78) {
      return person.intrigue >= 72 && person.loyalty < 62
        ? '主张保留派系议价空间，反对过早把权力尽付一方'
        : '主张约束最强宗室派系，避免其势力凌驾中枢';
    }
    if (person.governance >= 72 && person.loyalty >= 65) {
      return '主张先稳行政与军区，设定清晰程序，避免朝局因争储停摆';
    }
    return '主张兼顾名分与宗室体面，以调职、任命和制度换取暂时平衡';
  }
  if (agenda === 'tribal_alliance') {
    if (/首领|部落|盟主|酋长/.test(position) || person.loyalty >= 76) {
      return '主张兑现盟约与战利品分配，先恢复各部信任再谈统一号令';
    }
    if (person.command >= 74) {
      return '主张统一军令与出征期限，避免各部只听本部首领调遣';
    }
    if (person.intrigue >= 74) {
      return '主张以赏赐、联姻与分化竞争部落降低公开对抗成本';
    }
    return '主张以盟约约束各部，同时保留协商余地，避免强压引发拒命';
  }
  if (person.house_or_clan.trim() || /世家|家主|宗族|地方豪强/.test(position)) {
    return person.loyalty < 55
      ? '主张保全地方税赋与私兵，警告强行收权将拖延输粮与征募'
      : '主张以减赋、任官和地方自治换取世家持续合作';
  }
  if (person.governance >= 75 && person.commerce >= 65) {
    return '主张先统一税籍与审计，再逐步收回财赋权限，避免地方生产受损';
  }
  if (person.intrigue >= 75) {
    return '主张拉拢一部分世家、压制其竞争对手，分阶段恢复中央权威';
  }
  return '主张中枢与世家分权协作，以可执行的税赋和任官条件换取稳定';
}
