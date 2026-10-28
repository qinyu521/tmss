import type {
  Army,
  CharacterSeed,
  GameEvent,
  GameState,
  IntelEntry,
  Order,
  OrderIssue,
  OrderKind,
  OrderValidation,
  CourtAgenda,
  CourtDecision,
  PlayerRole,
  FactionKey,
  RegionState,
  SchemeKind,
} from '../types.js';
import type { DerivedContext } from '../dataset.js';
import { hashString } from '../dataset.js';
import { BALANCE } from '../balance.js';
import { FACTION_SHORT, ROLE_ALLOWED_ORDERS, ROLE_LABEL, SCHEME_LABELS } from '../constants.js';
import { emitEvent } from './events.js';
import { clamp, isCharacterAlive } from './state.js';
import { assignMarch, dayCostsFor, findPath, regionNameById } from './movement.js';
import { seasonOf } from './season.js';
import { applyArmyLosses } from './battle.js';
import { UNIT_PROFILES } from '../unitProfiles.js';
import { courtCost, courtDecisionForResolution, courtOpinion, courtRelationshipAffinity, courtSkill } from './court.js';
import { appointmentRelationshipEffect, successionCommandRisk } from './relationships.js';

const ROLE_ALLOWED: Record<PlayerRole, OrderKind[]> = ROLE_ALLOWED_ORDERS as Record<PlayerRole, OrderKind[]>;

const TRADE_LIMITS: Record<string, number> = { grain: 20_000, salt: 500, iron: 500, horses: 200 };

const COURT_AGENDA_LABEL: Record<CourtAgenda, string> = {
  war_council: '军务与边防',
  succession: '皇嗣与储位',
  tribal_alliance: '部落盟约',
  clan_relations: '世家与中枢',
};
const COURT_DECISION_LABEL: Record<CourtDecision, string> = {
  assertive: '强硬推进',
  balanced: '折中调和',
  conciliatory: '怀柔让步',
};

function courtDebateEdge(
  state: GameState,
  ctx: DerivedContext,
  agenda: CourtAgenda,
  speakerPersonId?: string,
  oppositionPersonId?: string,
): {
  edge: number;
  speaker?: CharacterSeed;
  opposition?: CharacterSeed;
  speakerScore: number;
  oppositionScore: number;
  speakerStanding: number;
  oppositionStanding: number;
} {
  const speaker = speakerPersonId ? ctx.charactersById[speakerPersonId] : undefined;
  const opposition = oppositionPersonId ? ctx.charactersById[oppositionPersonId] : undefined;
  const speakerStanding = speakerPersonId ? (state.characters[speakerPersonId]?.courtStanding ?? 50) : 50;
  const oppositionStanding = oppositionPersonId ? (state.characters[oppositionPersonId]?.courtStanding ?? 50) : 50;
  const factionKey = speaker?.faction_key ?? opposition?.faction_key ?? state.factionKey;
  const politicalTargetIds = agenda === 'succession'
    ? (state.special.YONG.princes ?? []).map((prince) => prince.personId)
    : agenda === 'tribal_alliance'
      ? (state.special.HUN.tribes ?? []).map((tribe) => tribe.chiefId)
      : agenda === 'clan_relations'
        ? (state.special.CHU.houses ?? []).map((house) => house.patriarchId)
        : state.armies.filter((army) => army.faction === factionKey).map((army) => army.commanderId);
  const speakerScore = (courtSkill(speaker ? { ...speaker, courtStanding: speakerStanding } : undefined, agenda)
    + (speakerPersonId ? courtRelationshipAffinity(ctx.seed.relationships, speakerPersonId, agenda, politicalTargetIds) : 0));
  const oppositionScore = (courtSkill(opposition ? { ...opposition, courtStanding: oppositionStanding } : undefined, agenda)
    + (oppositionPersonId ? courtRelationshipAffinity(ctx.seed.relationships, oppositionPersonId, agenda, politicalTargetIds) : 0));
  // 双方能力与声望差每 15 点改变 1 点议案效果，上下限为 3，避免人物属性压过君主裁决本身。
  const edge = speaker && opposition ? Math.max(-3, Math.min(3, Math.round((speakerScore - oppositionScore) / 15))) : 0;
  return {
    edge,
    speaker,
    opposition,
    speakerScore: Math.round(speakerScore),
    oppositionScore: Math.round(oppositionScore),
    speakerStanding,
    oppositionStanding,
  };
}

function adjustCourtStanding(state: GameState, ctx: DerivedContext, personId: string | undefined, delta: number): number | undefined {
  if (!personId || !ctx.charactersById[personId]) return undefined;
  const person = ctx.charactersById[personId];
  const runtime = state.characters[personId] ?? {
    personId,
    alive: true,
    ageBand: person.age_band,
    courtStanding: 50,
  };
  runtime.courtStanding = clamp((runtime.courtStanding ?? 50) + delta);
  state.characters[personId] = runtime;
  return runtime.courtStanding;
}

function resolveBattleCasePolitics(
  state: GameState,
  ctx: DerivedContext,
  commanderId: string,
  action: 'relieve' | 'discipline' | 'replace' | 'demote' | 'trial',
): string {
  const runtime = state.characters[commanderId];
  const person = ctx.charactersById[commanderId];
  const caseType = runtime?.pendingBattleCase;
  const opponentId = runtime?.battlePoliticalOpponentId;
  if (!runtime || !person || !caseType) return '';

  let outcome = '';
  if (caseType === 'impeachment' && opponentId && ctx.charactersById[opponentId]) {
    const backsCommander = action === 'relieve';
    const commandStandingDelta = action === 'relieve' ? 3 : action === 'demote' ? -3 : action === 'trial' ? -10 : -5;
    const opponentStandingDelta = action === 'relieve' ? -4 : action === 'demote' ? 2 : action === 'trial' ? 5 : 3;
    adjustCourtStanding(state, ctx, commanderId, commandStandingDelta);
    adjustCourtStanding(state, ctx, opponentId, opponentStandingDelta);
    const mild = action === 'demote';
    const publicTrial = action === 'trial';
    if (person.faction_key === 'YONG') {
      const prince = (state.special.YONG.princes ?? []).find((item) => item.personId === opponentId);
      if (prince) {
        prince.influence = clamp(prince.influence + (backsCommander ? -2 : mild ? 1 : publicTrial ? 4 : 2));
        state.special.YONG.courtStability = clamp((state.special.YONG.courtStability ?? 50) + (backsCommander ? -2 : mild ? 0 : publicTrial ? -4 : 1));
      }
    } else if (person.faction_key === 'HUN') {
      const tribe = (state.special.HUN.tribes ?? []).find((item) => item.chiefId === opponentId);
      if (tribe) {
        tribe.loyalty = clamp(tribe.loyalty + (backsCommander ? -4 : mild ? 2 : publicTrial ? 6 : 3));
        state.special.HUN.cohesion = clamp((state.special.HUN.cohesion ?? 50) + (backsCommander ? -2 : mild ? 1 : publicTrial ? 3 : 1));
      }
    } else if (person.faction_key === 'CHU') {
      const house = (state.special.CHU.houses ?? []).find((item) => item.patriarchId === opponentId);
      if (house) {
        house.support = clamp(house.support + (backsCommander ? -4 : mild ? 2 : publicTrial ? 7 : 3));
        state.special.CHU.centralAuthority = clamp((state.special.CHU.centralAuthority ?? 50) + (backsCommander ? 2 : mild ? -1 : publicTrial ? -5 : -2));
      }
    }
    outcome = backsCommander
      ? '君主驳回' + ctx.charactersById[opponentId].name + '的弹劾，败将声望 +3、弹劾者声望 -4；相关派系因裁决出现反弹。'
      : publicTrial
        ? '君主公开审判' + person.name + '，败将声望 -10、弹劾者声望 +5；公开审判放大了' + ctx.charactersById[opponentId].name + '及其政治派系的影响，但也加剧了朝局震荡。'
        : mild
          ? '君主降职' + person.name + '，败将声望 -3、弹劾者声望 +2；朝廷部分采纳问责，但未完全站到弹劾一方。'
          : '君主采纳' + ctx.charactersById[opponentId].name + '的弹劾，败将声望 -5、弹劾者声望 +3；相关政治派系获得回应。';
  } else if (caseType === 'transfer_request') {
    const delta = action === 'replace' ? 2 : action === 'relieve' ? 1 : action === 'demote' ? -5 : action === 'trial' ? -10 : -4;
    adjustCourtStanding(state, ctx, commanderId, delta);
    if (action === 'trial' && person.faction_key === 'YONG') {
      state.special.YONG.courtStability = clamp((state.special.YONG.courtStability ?? 50) - 3);
    } else if (action === 'trial' && person.faction_key === 'HUN') {
      state.special.HUN.cohesion = clamp((state.special.HUN.cohesion ?? 50) - 3);
    } else if (action === 'trial' && person.faction_key === 'CHU') {
      state.special.CHU.centralAuthority = clamp((state.special.CHU.centralAuthority ?? 50) + 3);
    }
    outcome = action === 'replace'
      ? '君主批准调离前线的请求，将领在朝声望 +2。'
      : action === 'relieve'
        ? '君主抚恤并决定留用该将领，其在朝声望 +1。'
        : action === 'demote'
          ? '君主驳回请调但予以降职，将领在朝声望 -5。'
          : action === 'trial'
            ? '君主决定公开审判该将领，其在朝声望 -10；公开审理也给国家政治秩序留下冲击。'
            : '君主驳回调任请求并追责，将领在朝声望 -4。';
  }
  runtime.pendingBattleCase = undefined;
  runtime.battlePoliticalOpponentId = undefined;
  state.characters[commanderId] = runtime;
  return outcome;
}

function courtAgendaAllowed(faction: FactionKey, agenda: CourtAgenda): boolean {
  if (agenda === 'war_council') return true;
  if (agenda === 'succession') return faction === 'YONG';
  if (agenda === 'tribal_alliance') return faction === 'HUN';
  if (agenda === 'clan_relations') return faction === 'CHU';
  return false;
}

const SCHEME_COST: Record<SchemeKind, number> = {
  fire: 8_000,
  cut_supply: 6_000,
  sow_discord: 7_000,
  ambush: 4_000,
  feint: 5_000,
};

export function governedRegionId(state: GameState): string | null {
  const region = Object.values(state.regions).find((r) => r.governorId === state.playerPersonId);
  return region?.regionId ?? null;
}

export function armiesCommandable(state: GameState): Army[] {
  const factionArmies = state.armies.filter((a) => a.faction === state.factionKey);
  if (state.playerRole === 'ruler') return factionArmies;
  const govRegion = governedRegionId(state);
  if (state.playerRole === 'governor') {
    return factionArmies.filter((a) => a.nodeId === govRegion || a.commanderId === state.playerPersonId);
  }
  if (state.playerRole === 'general') {
    return factionArmies.filter((a) => a.commanderId === state.playerPersonId);
  }
  return [];
}

function issues(code: string, message: string): OrderValidation {
  return { ok: false, issues: [{ code, message }] };
}

function countPending(state: GameState, kind: OrderKind, excludeOrderId?: string): number {
  return state.pendingOrders.filter((o) => o.kind === kind && o.orderId !== excludeOrderId).length;
}

function orderKindLimit(kind: OrderKind): number {
  if (kind === 'scout') return 2;
  if (kind === 'levy_grain' || kind === 'levy_tax') return 3;
  if (kind === 'move_army' || kind === 'dispatch_garrison') return 3;
  if (kind === 'scheme') return 2;
  if (kind === 'rest_army') return 2;
  return 1;
}

function commanderOf(ctx: DerivedContext, id?: string): CharacterSeed | undefined {
  return id ? ctx.charactersById[id] : undefined;
}

function commanderInUse(state: GameState, faction: FactionKey, commanderId: string): boolean {
  return state.armies.some((a) => a.faction === faction && a.commanderId === commanderId);
}

function commanderReserved(state: GameState, commanderId: string, excludeOrderId: string): boolean {
  return state.pendingOrders.some(
    (o) => o.orderId !== excludeOrderId && 'commanderId' in o && o.commanderId === commanderId,
  );
}

function commanderTaken(state: GameState, commanderId: string, excludeOrderId: string): boolean {
  return commanderInUse(state, state.factionKey, commanderId) || commanderReserved(state, commanderId, excludeOrderId);
}

function freeCommander(state: GameState, ctx: DerivedContext, faction: FactionKey, excludeIds: string[] = []): CharacterSeed | undefined {
  const candidates = ctx.seed.characters
    .filter((c) => c.faction_key === faction)
    // 已故人物不可统兵
    .filter((c) => isCharacterAlive(state, c.person_id))
    .filter((c) => /将|军|帅|守|兵|禁军|武/.test(`${c.identity_type} ${c.current_position_standard}`))
    .filter((c) => !commanderInUse(state, faction, c.person_id) && !excludeIds.includes(c.person_id))
    .sort((a, b) => b.command + b.strategy - (a.command + a.strategy));
  const fallback = ctx.seed.characters.find(
    (c) => c.faction_key === faction && c.identity_type === '君主' && isCharacterAlive(state, c.person_id),
  );
  return candidates[0] ?? fallback;
}

function schemeTerrainModifier(scheme: SchemeKind, region?: RegionState): number {
  if (!region) return 0;
  if (scheme === 'fire') {
    if (region.terrain === 'forest') return 0.14;
    if (region.terrain === 'river') return -0.1;
    if (region.terrain === 'mountain') return -0.05;
  }
  if (scheme === 'ambush') {
    if (region.terrain === 'forest') return 0.12;
    if (region.terrain === 'mountain') return 0.1;
    if (region.terrain === 'plain') return -0.06;
  }
  if (scheme === 'feint' && region.terrain === 'plain') return 0.05;
  return 0;
}

export function schemeChance(
  state: GameState,
  ctx: DerivedContext,
  scheme: SchemeKind,
  strategist: CharacterSeed | undefined,
  targetArmy?: Army,
  region?: RegionState,
): number {
  const base: Record<SchemeKind, number> = { fire: 0.42, cut_supply: 0.5, sow_discord: 0.48, ambush: 0.64, feint: 0.54 };
  const targetCommander = targetArmy ? ctx.charactersById[targetArmy.commanderId] : undefined;
  const strategy = strategist?.strategy ?? 55;
  const intrigue = targetCommander?.intrigue ?? 50;
  const chance =
    base[scheme] +
    strategy / 320 -
    intrigue / 420 +
    schemeTerrainModifier(scheme, region) +
    (scheme === 'ambush' && region?.faction === state.factionKey ? 0.06 : 0);
  return Math.max(0.15, Math.min(0.9, chance));
}

function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function validateOrder(state: GameState, ctx: DerivedContext, order: Order): OrderValidation {
  const role = state.playerRole;
  if (!ROLE_ALLOWED[role].includes(order.kind)) {
    return issues(
      'ROLE_FORBIDDEN',
      `${ROLE_LABEL[role]}无权下达「${order.kind}」命令。此类命令需要更高权限或不同身份。`,
    );
  }
  const faction = state.factions[state.factionKey];
  if (countPending(state, order.kind, order.orderId) >= orderKindLimit(order.kind)) {
    return issues('ORDER_LIMIT', '本回合该类型命令已达上限，请等待下回合。');
  }

  switch (order.kind) {
    case 'move_army': {
      const army = state.armies.find((a) => a.armyId === order.armyId);
      if (!army || army.faction !== state.factionKey) return issues('ARMY_NOT_FOUND', '该部队不属于你的势力。');
      if (army.status === 'marching') return issues('ARMY_MARCHING', '该部队正在行军途中，须先抵达或休整。');
      if (army.troops < 60) return issues('ARMY_EMPTY', '部队已溃散或兵力不足，无法行动。');
      const commandable = armiesCommandable(state);
      if (!commandable.some((a) => a.armyId === army.armyId)) {
        return issues('AUTH_SCOPE', `你的身份只能调动授权范围内的部队（${ROLE_LABEL[role]}）。`);
      }
      if (army.faction === 'YONG' && state.flags.successionCrisis) {
        const commander = ctx.charactersById[army.commanderId];
        const risk = successionCommandRisk(
          ctx.seed.relationships,
          state.special.YONG.princes ?? [],
          army.commanderId,
          state.characters[army.commanderId]?.militaryLoyalty ?? commander?.loyalty ?? 50,
          state.flags.successionCrisis,
        );
        if (risk) {
          return issues(
            'COMMANDER_POLITICAL_SPLIT',
            `${army.commanderName}与${risk.rivalPrinceName}存在强关系网络，且其对朝廷忠诚不足；夺嫡危机中拒绝执行调兵令。请先稳定朝局或更换统将。`,
          );
        }
      }
      if (state.factionKey === 'HUN') {
        const tribe = state.special.HUN.tribes?.find((t) => t.regionId === army.nodeId);
        if (tribe && tribe.stance === 'refusing') {
          return issues(
            'TRIBE_REFUSAL',
            `${tribe.name}首领${tribe.chiefName}拒绝出兵（忠诚 ${Math.round(tribe.loyalty)}）。可先赏赐部落或以其他方式恢复协调度。`,
          );
        }
      }
      const path = findPath(state, ctx, army.faction, army.nodeId, order.targetRegionId);
      if (!path.ok) return issues('NO_PATH', path.error ?? '无法抵达目标州府。');

      const amount = order.amount ?? army.troops;
      if (!Number.isFinite(amount) || amount < 1_000) return issues('BAD_AMOUNT', '调动兵力至少 1000 人。');
      if (amount > army.troops) return issues('BAD_AMOUNT', `调动兵力不能超过该部现有 ${army.troops.toLocaleString()} 人。`);
      const unitRequests = order.units ?? [];
      const isSplit = amount < army.troops || unitRequests.length > 0;
      let unitSum = 0;
      const seenUnits = new Set<string>();
      if (isSplit) {
        for (const req of unitRequests) {
          if (seenUnits.has(req.unitId)) return issues('BAD_UNITS', '同一兵种只能填写一次。');
          seenUnits.add(req.unitId);
          if (!Number.isFinite(req.count) || req.count <= 0) return issues('BAD_UNITS', '特殊兵种数量必须大于 0。');
          const stack = army.units.find((u) => u.unitId === req.unitId);
          if (!stack) return issues('BAD_UNITS', `该部没有 ${UNIT_PROFILES[req.unitId]?.name ?? req.unitId}。`);
          if (req.count > stack.count) return issues('BAD_UNITS', `调走的 ${stack.name} 超过该部现有 ${stack.count}。`);
          unitSum += req.count;
        }
        if (unitSum > amount) return issues('BAD_UNITS', '特殊兵种合计不能超过调动总兵力。');
        const leviesNeeded = amount - unitSum;
        if (leviesNeeded > army.levies) {
          return issues('BAD_UNITS', `该部征集兵仅 ${army.levies.toLocaleString()} 人，无法凑足 ${amount.toLocaleString()} 人；请减少特殊兵种或总兵力。`);
        }
      }
      let commanderNote = '';
      if (isSplit) {
        if (!order.commanderId) return issues('COMMANDER_REQUIRED', '分兵需要指定一名统兵官（不能由原统兵官同时统领两军）。');
        if (order.commanderId === army.commanderId) return issues('COMMANDER_DUPLICATE', '分遣队必须另选统兵官。');
        const cmd = commanderOf(ctx, order.commanderId);
        if (!cmd || cmd.faction_key !== state.factionKey) return issues('COMMANDER_INVALID', '统兵官必须属于本国。');
        if (!isCharacterAlive(state, cmd.person_id)) return issues('COMMANDER_DEAD', '该将领已故，无法统兵。');
        if (commanderTaken(state, cmd.person_id, order.orderId)) return issues('COMMANDER_IN_USE', '该将领已在统率其他部队或已被本旬命令占用。');
        commanderNote = `，由 ${cmd.name} 统带（统率 ${cmd.command} / 谋略 ${cmd.strategy}）`;
      }
      return {
        ok: true,
        issues: [],
        preview: `${isSplit ? `分兵 ${amount.toLocaleString()} 人` : '全军'}${commanderNote}，${unitSum > 0 ? `随军特殊兵种 ${unitSum.toLocaleString()} 人，` : ''}经 ${path.path.map((id) => regionNameById(ctx, id)).join(' → ')}，预计 ${path.totalDays} 日（约 ${Math.ceil(path.totalDays / BALANCE.turnDays)} 回合）。`,
      };
    }
    case 'recruit': {
      if (!Number.isFinite(order.amount) || order.amount < 1_000 || order.amount > 30_000) {
        return issues('BAD_AMOUNT', '征募人数需在 1000 至 30000 之间。');
      }
      const crisisMult = state.factionKey === 'YONG' && state.flags.successionCrisis ? 1.3 : 1;
      const cash = Math.round(order.amount * BALANCE.recruit.cashPerMan * crisisMult);
      const grain = Math.round(order.amount * BALANCE.recruit.grainPerMan * crisisMult);
      if (faction.resources.cash < cash) return issues('NO_CASH', `银钱不足：需 ${cash}，现有 ${Math.round(faction.resources.cash)}。`);
      if (faction.resources.grain < grain) return issues('NO_GRAIN', `粮不足：需 ${grain}，现有 ${Math.round(faction.resources.grain)}。`);
      if (faction.resources.manpower < order.amount) {
        return issues('NO_MANPOWER', `可征发兵员不足：需 ${order.amount}，现有 ${Math.round(faction.resources.manpower)}。`);
      }
      if (state.factionKey === 'CHU' && state.flags.houseBoycott) {
        return issues('HOUSE_BOYCOTT', '世家抵制期间征兵受阻：须先与世家协商，恢复支持度。');
      }
      const ownRegions = Object.values(state.regions).filter((r) => r.faction === state.factionKey);
      const regionId = order.regionId ?? governedRegionId(state) ?? ownRegions[0]?.regionId;
      const region = regionId ? state.regions[regionId] : undefined;
      if (!region || region.faction !== state.factionKey) return issues('REGION_INVALID', '征兵州府必须在本国控制下。');
      if (order.formNewArmy && order.commanderId) {
        const cmd = commanderOf(ctx, order.commanderId);
        if (!cmd || cmd.faction_key !== state.factionKey) return issues('COMMANDER_INVALID', '统兵官必须属于本国。');
        if (!isCharacterAlive(state, cmd.person_id)) return issues('COMMANDER_DEAD', '该将领已故，无法统兵。');
        if (commanderTaken(state, cmd.person_id, order.orderId)) return issues('COMMANDER_IN_USE', '该将领已在统率其他部队或已被本旬命令占用。');
      }
      const commander = order.commanderId
        ? commanderOf(ctx, order.commanderId)
        : order.formNewArmy
          ? freeCommander(state, ctx, state.factionKey)
          : undefined;
      return {
        ok: true,
        issues: [],
        preview: `在${region.name}征募 ${order.amount.toLocaleString()} 人，耗银 ${cash}、粮 ${grain}；${order.formNewArmy ? `编为新军团${commander ? `，由 ${commander.name} 统带` : ''}` : '补入当地驻军或军团'}。`,
      };
    }
    case 'levy_grain': {
      const regions = Math.round(order.amount);
      if (regions < 1 || regions > BALANCE.levyGrain.maxPerTurn) return issues('BAD_AMOUNT', '征粮州府数量需为 1-3。');
      const own = Object.values(state.regions).filter((r) => r.faction === state.factionKey);
      const available = own.reduce((s, r) => s + r.foodStore, 0);
      if (available < BALANCE.levyGrain.grainPerRegion) return issues('NO_STORES', '各州官仓已空，无粮可征；需先恢复生产或贸易。');
      return {
        ok: true,
        issues: [],
        preview: `从 ${regions} 个州府征粮，预计入库 ${regions * BALANCE.levyGrain.grainPerRegion} 石；治安与民心下降。`,
      };
    }
    case 'levy_tax': {
      const regions = Math.round(order.amount);
      if (regions < 1 || regions > BALANCE.levyTax.maxPerTurn) return issues('BAD_AMOUNT', '加征州府数量需为 1-3。');
      return {
        ok: true,
        issues: [],
        preview: `加征 ${regions} 个州府商税，预计入库 ${regions * BALANCE.levyTax.cashPerRegion} 两；治安、世家支持下降。`,
      };
    }
    case 'trade': {
      const limit = TRADE_LIMITS[order.resource] ?? 0;
      if (!Number.isFinite(order.amount) || order.amount < 1 || order.amount > limit) {
        return issues('BAD_AMOUNT', `单次贸易量需在 1 至 ${limit} 之间。`);
      }
      const cost = Math.round(BALANCE.prices[order.resource] * order.amount * BALANCE.tradePremium);
      if (faction.resources.cash < cost) return issues('NO_CASH', `银钱不足：需 ${cost}，现有 ${Math.round(faction.resources.cash)}。`);
      return { ok: true, issues: [], preview: `购入 ${order.amount} 单位${order.resource}，耗银 ${cost}（含边市溢价）。` };
    }
    case 'appease_tribe': {
      if (state.factionKey !== 'HUN') return issues('WRONG_FACTION', '只有匈奴的部落联盟存在赏赐部落机制。');
      const tribe = state.special.HUN.tribes?.find((t) => t.tribeId === order.tribeId);
      if (!tribe) return issues('NOT_FOUND', '部落不存在。');
      if (order.amount < 900) return issues('BAD_AMOUNT', '赏赐至少需要 900 两。');
      if (faction.resources.cash < order.amount) return issues('NO_CASH', '银钱不足。');
      return {
        ok: true,
        issues: [],
        preview: `赏赐 ${tribe.name} ${order.amount} 两，忠诚约 +${Math.min(10, order.amount / BALANCE.appeaseTribe.cashPerPoint)}。`,
      };
    }
    case 'balance_princes': {
      if (state.factionKey !== 'YONG') return issues('WRONG_FACTION', '只有大雍存在皇子派系平衡机制。');
      if (state.playerRole !== 'ruler') return issues('ROLE_FORBIDDEN', '只有君主可以平衡皇子派系。');
      if (faction.resources.cash < BALANCE.balancePrinces.cashCost) return issues('NO_CASH', '银钱不足。');
      return {
        ok: true,
        issues: [],
        preview: `以 ${BALANCE.balancePrinces.cashCost} 两安抚各皇子派系，朝局稳定 +${BALANCE.balancePrinces.stabilityGain}。`,
      };
    }
    case 'negotiate_house': {
      if (state.factionKey !== 'CHU') return issues('WRONG_FACTION', '只有大楚存在世家协商机制。');
      const house = state.special.CHU.houses?.find((h) => h.houseId === order.houseId);
      if (!house) return issues('NOT_FOUND', '世家不存在。');
      if (faction.resources.cash < BALANCE.negotiateHouse.cashCost) return issues('NO_CASH', '银钱不足。');
      if (state.date.turn - house.lastNegotiationTurn < BALANCE.politics.chu.negotiationCooldown) {
        return issues('COOLDOWN', '该世家近期已协商过，需等待冷却。');
      }
      return {
        ok: true,
        issues: [],
        preview: `与 ${house.name} 协商，耗银 ${BALANCE.negotiateHouse.cashCost}，支持度 +${BALANCE.negotiateHouse.supportGain}。`,
      };
    }
    case 'hold_court': {
      if (state.playerRole !== 'ruler') return issues('ROLE_FORBIDDEN', '召集廷议需君主权限。');
      if (!courtAgendaAllowed(state.factionKey, order.agenda)) {
        return issues('WRONG_FACTION', '该廷议议题不属于本势力的政制矛盾。');
      }
      if (!['assertive', 'balanced', 'conciliatory'].includes(order.decision)) {
        return issues('BAD_DECISION', '未知廷议议案政策。');
      }
      if (order.resolution && !['adopt_speaker', 'adopt_opposition', 'compromise'].includes(order.resolution)) {
        return issues('BAD_RESOLUTION', '未知君主裁定方式。');
      }
      if (Boolean(order.speakerPersonId) !== Boolean(order.oppositionPersonId)) {
        return issues('COURT_PAIR_REQUIRED', '廷议须同时选择主议臣与反对臣，才能计算双方的论证效果。');
      }
      if (order.resolution && (!order.speakerPersonId || !order.oppositionPersonId)) {
        return issues('COURT_PAIR_REQUIRED', '采纳或驳回某方意见前，必须指定主议臣与反对臣。');
      }
      for (const personId of [order.speakerPersonId, order.oppositionPersonId].filter((id): id is string => Boolean(id))) {
        const person = ctx.charactersById[personId];
        if (!person || person.faction_key !== state.factionKey) return issues('COURT_PERSON_INVALID', '主议臣与反对臣必须来自本势力。');
        if (!isCharacterAlive(state, person.person_id)) return issues('COURT_PERSON_DEAD', `${person.name}已故，无法参与廷议。`);
      }
      if (order.speakerPersonId && order.speakerPersonId === order.oppositionPersonId) {
        return issues('COURT_PAIR_DUPLICATE', '主议臣与反对臣不能由同一人担任。');
      }
      const debate = courtDebateEdge(state, ctx, order.agenda, order.speakerPersonId, order.oppositionPersonId);
      const decision = courtDecisionForResolution(order.agenda, order.resolution, debate.speaker, debate.opposition, order.decision);
      const cost = courtCost(order.agenda, decision);
      if (faction.resources.cash < cost) return issues('NO_CASH', `廷议与执行需银 ${cost.toLocaleString()} 两，现有 ${Math.round(faction.resources.cash).toLocaleString()}。`);
      const speakerOpinion = debate.speaker ? courtOpinion(debate.speaker, order.agenda) : '廷臣依据议题共议，采用默认效果';
      const oppositionOpinion = debate.opposition ? courtOpinion(debate.opposition, order.agenda) : '未指定反对臣';
      const argument = order.agenda === 'war_council'
        ? '兵部请整军备边，仓曹提醒军饷与军粮不可脱离国力'
        : order.agenda === 'succession'
          ? '太子一党要求明确储位，诸王宾客警告过度倾斜将激化争储'
          : order.agenda === 'tribal_alliance'
            ? '诸部首领要求兑现盟约，主战派则要求统一号令'
            : '世家要求保全地方利益，台谏主张中枢不得失去征税与任官之权';
      const resolutionLabel = order.resolution === 'adopt_speaker'
        ? `采纳主议臣意见（${debate.speaker?.name ?? '主议臣'}）`
        : order.resolution === 'adopt_opposition'
          ? `驳回主议、采纳反对臣意见（${debate.opposition?.name ?? '反对臣'}）`
          : order.resolution === 'compromise'
            ? '折中调和双方意见'
            : '君主直接裁定政策方向';
      return {
        ok: true,
        issues: [],
        preview: `廷议「${COURT_AGENDA_LABEL[order.agenda]}」：${argument}；${debate.speaker && debate.opposition ? `主议臣${debate.speaker.name}主张「${speakerOpinion}」，反对臣${debate.opposition.name}提出「${oppositionOpinion}」；双方议题能力 ${debate.speakerScore}/${debate.oppositionScore}，争辩修正 ${debate.edge > 0 ? '+' : ''}${debate.edge}。` : '未指定辩论人选时采用廷臣集议默认效果。'} 君主选择「${resolutionLabel}」，最终政策为「${COURT_DECISION_LABEL[decision]}」，执行成本 ${cost.toLocaleString()} 两。`,
      };
    }
    case 'reward_commander': {
      if (state.playerRole !== 'ruler') return issues('ROLE_FORBIDDEN', '赏赐将领需君主权限。');
      const person = ctx.charactersById[order.personId];
      if (!person || person.faction_key !== state.factionKey) return issues('NOT_FOUND', '该人物不属于你的势力。');
      if (!isCharacterAlive(state, person.person_id)) return issues('PERSON_DEAD', '该人物已故，不能受赏。');
      const commandsArmy = state.armies.some((army) => army.faction === state.factionKey && army.commanderId === person.person_id);
      const commandsGarrison = Object.values(state.regions).some((region) => region.faction === state.factionKey && region.garrisonCommanderId === person.person_id);
      if (!commandsArmy && !commandsGarrison) return issues('NOT_COMMANDER', '只能赏赐当前统领军团或州兵的将领。');
      if (![5_000, 10_000, 20_000].includes(order.amount)) return issues('BAD_AMOUNT', '赏赐金额只能选择 5000、10000 或 20000 两。');
      if (faction.resources.cash < order.amount) return issues('NO_CASH', `赏赐需银 ${order.amount.toLocaleString()} 两。`);
      const current = state.characters[person.person_id]?.militaryLoyalty ?? person.loyalty;
      const gain = Math.min(100, current + order.amount / 1_000) - current;
      return {
        ok: true,
        issues: [],
        preview: `赏赐${person.name}白银 ${order.amount.toLocaleString()} 两，军令忠诚度 ${Math.round(current)} → ${Math.round(current + gain)}（+ ${Math.round(gain)}）。`,
      };
    }
    case 'settle_defeated_commander': {
      if (state.playerRole !== 'ruler') return issues('ROLE_FORBIDDEN', '战后处置败将需君主权限。');
      const person = ctx.charactersById[order.personId];
      if (!person || person.faction_key !== state.factionKey) return issues('NOT_FOUND', '该人物不属于你的势力。');
      if (!isCharacterAlive(state, person.person_id)) return issues('PERSON_DEAD', '该人物已故，不能接受战后处置。');
      const runtime = state.characters[person.person_id];
      if (
        runtime?.lastBattleOutcome !== 'defeat' ||
        runtime.pendingBattleSettlement !== true
      ) {
        return issues('NO_RECENT_DEFEAT', '只能处置尚未善后的最近一场战败；不能重复追责旧战或凭空制造战败。');
      }
      const army = state.armies.find((item) => item.faction === state.factionKey && item.commanderId === person.person_id);
      if (order.action === 'replace') {
        if (!army) return issues('NO_ACTIVE_ARMY', '原军团已溃散或不复存在，无法在战后撤换统将。');
        if (!order.replacementPersonId) return issues('REPLACEMENT_REQUIRED', '撤换统将必须指定接任人选。');
        const replacement = ctx.charactersById[order.replacementPersonId];
        if (
          !replacement ||
          replacement.faction_key !== state.factionKey ||
          replacement.person_id === person.person_id
        ) {
          return issues('INVALID_REPLACEMENT', '接任人选必须是另一名本方人物。');
        }
        if (!isCharacterAlive(state, replacement.person_id)) {
          return issues('PERSON_DEAD', '接任人选已故，不能统兵。');
        }
        const commandsArmy = state.armies.some(
          (item) => item.faction === state.factionKey && item.commanderId === replacement.person_id,
        );
        const commandsGarrison = Object.values(state.regions).some(
          (region) => region.faction === state.factionKey && region.garrisonCommanderId === replacement.person_id,
        );
        if (commandsArmy || commandsGarrison) {
          return issues('COMMANDER_BUSY', '接任人选已统领其他军团或州兵，不能重复任命；请先选择未掌兵的将领。');
        }
        return {
          ok: true,
          issues: [],
          preview: '撤换败将' + person.name + '，由' + replacement.name + '接掌' + army.name + '；不耗银，但旧将军令忠诚 -10，交接使所部士气 -5。',
        };
      }
      if (order.action === 'demote') {
        const current = runtime.militaryLoyalty ?? person.loyalty;
        const effectiveCommand = Math.max(1, person.command - (runtime.commandPenalty ?? 0));
        return { ok: true, issues: [], preview: '降职' + person.name + '：不耗银，军令忠诚 -6、有效统率 ' + effectiveCommand + ' → ' + Math.max(1, effectiveCommand - 8) + '，' + (army ? '所部训练 +2、士气 -2。' : '不改变已不存在军团的状态。') };
      }
      if (order.action === 'trial') {
        const current = runtime.militaryLoyalty ?? person.loyalty;
        const effectiveCommand = Math.max(1, person.command - (runtime.commandPenalty ?? 0));
        return { ok: true, issues: [], preview: '公开审判' + person.name + '：不耗银，军令忠诚 ' + Math.round(current) + ' → ' + Math.max(0, Math.round(current) - 15) + '，有效统率 ' + effectiveCommand + ' → ' + Math.max(1, effectiveCommand - 12) + '，' + (army ? '所部士气 -5、训练 +3；政治声望将受到重创。' : '将领声望与统率受罚，原军团已不复存在。') };
      }
      if (order.action === 'relieve') {
        if (faction.resources.cash < 12_000) return issues('NO_CASH', '抚恤败军需银 12000 两。');
        const current = runtime.militaryLoyalty ?? person.loyalty;
        return {
          ok: true,
          issues: [],
          preview: `抚恤${person.name}及其败军，耗银 12000 两；军令忠诚 ${Math.round(current)} → ${Math.round(Math.min(100, current + 8))}，仍存部队士气${army ? ' +6' : '不变（军团已不存在）'}。`,
        };
      }
      const current = runtime.militaryLoyalty ?? person.loyalty;
      return {
        ok: true,
        issues: [],
        preview: `追责${person.name}：不耗银，军令忠诚 ${Math.round(current)} → ${Math.round(Math.max(0, current - 8))}；仍存部队训练 +5、士气 -3。`,
      };
    }
    case 'appoint': {
      if (state.playerRole !== 'ruler') return issues('ROLE_FORBIDDEN', '任命官职需君主权限。');
      const person = ctx.charactersById[order.personId];
      if (!person || person.faction_key !== state.factionKey) return issues('NOT_FOUND', '该人物不属于你的势力。');
      if (!isCharacterAlive(state, person.person_id)) return issues('PERSON_DEAD', '该人物已故，无法任命。');
      const region = state.regions[order.regionId];
      if (!region || region.faction !== state.factionKey) return issues('NOT_FOUND', '目标州府不在你的控制之下。');
      if (region.governorId === order.personId) return issues('ALREADY', '该人物已任此州主官。');
      if (faction.resources.cash < 8_000) return issues('NO_CASH', '任命仪注与安抚需银 8000 两。');
      return {
        ok: true,
        issues: [],
        preview: `任命 ${person.name} 为${region.name}州府主官（原任 ${region.governorName}）。`,
      };
    }
    case 'rest_army': {
      const army = state.armies.find((a) => a.armyId === order.armyId);
      if (!army || army.faction !== state.factionKey) return issues('ARMY_NOT_FOUND', '该部队不属于你的势力。');
      if (state.playerRole === 'general' && army.commanderId !== state.playerPersonId) {
        return issues('AUTH_SCOPE', '你只能整训自己统率的部队。');
      }
      if (state.playerRole === 'governor' && army.nodeId !== governedRegionId(state)) {
        return issues('AUTH_SCOPE', '你只能整训驻本州的部队。');
      }
      if (army.supply >= 98 && army.fatigue <= 4) return issues('NO_NEED', '该部补给充足、疲劳已消，无须整训。');
      return { ok: true, issues: [], preview: `${army.name}就地休整：补给 +12、疲劳 -12、士气 +3。` };
    }
    case 'scout': {
      const region = state.regions[order.regionId];
      if (!region) return issues('NOT_FOUND', '州府不存在。');
      if (region.faction === state.factionKey) return issues('OWN_REGION', '无需侦察本国州府。');
      if (faction.resources.cash < 1_200) return issues('NO_CASH', '斥候行动需银 1200 两。');
      return {
        ok: true,
        issues: [],
        preview: `遣斥候侦察${region.name}，获得该地驻军与补给的情报（可靠度取决于行动结果）。`,
      };
    }
    case 'dispatch_garrison': {
      const region = state.regions[order.regionId];
      if (!region || region.faction !== state.factionKey) return issues('REGION_INVALID', '只能调遣本国州府的州兵。');
      if (!Number.isFinite(order.amount) || order.amount < 1_000) return issues('BAD_AMOUNT', '调遣州兵至少 1000 人。');
      if (order.amount > region.garrison) {
        return issues('BAD_AMOUNT', `${region.name}州兵仅 ${region.garrison.toLocaleString()} 人，无法调出 ${order.amount.toLocaleString()} 人。`);
      }
      if (order.regionId === order.targetRegionId) return issues('BAD_TARGET', '州兵已在目标州府，无须调遣。');
      const path = findPath(state, ctx, state.factionKey, order.regionId, order.targetRegionId);
      if (!path.ok) return issues('NO_PATH', path.error ?? '无法抵达目标州府。');
      let commanderId = order.commanderId;
      if (commanderId) {
        const cmd = commanderOf(ctx, commanderId);
        if (!cmd || cmd.faction_key !== state.factionKey) return issues('COMMANDER_INVALID', '统兵官必须属于本国。');
        if (!isCharacterAlive(state, cmd.person_id)) return issues('COMMANDER_DEAD', '该将领已故，无法统兵。');
        if (commanderTaken(state, commanderId, order.orderId)) return issues('COMMANDER_IN_USE', '该将领已在统率其他部队或已被本旬命令占用。');
      } else {
        const local = region.garrisonCommanderId;
        commanderId = local && isCharacterAlive(state, local) && !commanderInUse(state, state.factionKey, local)
          ? local
          : freeCommander(state, ctx, state.factionKey)?.person_id;
      }
      const cmd = commanderOf(ctx, commanderId);
      return {
        ok: true,
        issues: [],
        preview: `从${region.name}调出州兵 ${order.amount.toLocaleString()} 人${cmd ? `，由 ${cmd.name} 统带（统率 ${cmd.command} / 谋略 ${cmd.strategy}）` : ''}，经 ${path.path.map((id) => regionNameById(ctx, id)).join(' → ')}，约 ${path.totalDays} 日。`,
      };
    }
    case 'scheme': {
      const cost = SCHEME_COST[order.scheme];
      if (!cost) return issues('BAD_SCHEME', '未知计谋。');
      if (faction.resources.cash < cost) return issues('NO_CASH', `施展「${SCHEME_LABELS[order.scheme]}」需银 ${cost} 两。`);
      const strategist = commanderOf(ctx, order.strategistId ?? state.playerPersonId);
      if (!strategist || strategist.faction_key !== state.factionKey) return issues('COMMANDER_INVALID', '施计者必须属于本国。');
      const targetArmy = order.targetArmyId ? state.armies.find((a) => a.armyId === order.targetArmyId) : undefined;
      if (order.targetArmyId && !targetArmy) return issues('ARMY_NOT_FOUND', '目标部队不存在或已不在视野内。');
      const region = order.targetRegionId
        ? state.regions[order.targetRegionId]
        : targetArmy
          ? state.regions[targetArmy.nodeId]
          : undefined;
      if (!region) return issues('BAD_TARGET', '请选择计谋目标州府或敌军部队。');
      if (order.scheme !== 'ambush' && region.faction === state.factionKey) {
        return issues('BAD_TARGET', '该计谋须施于敌国州府或敌军。');
      }
      if (order.scheme === 'ambush' && region.faction !== state.factionKey) {
        return issues('BAD_TARGET', '伏兵只能设在本国州府。');
      }
      if (order.scheme === 'cut_supply' && !targetArmy) {
        return issues('BAD_TARGET', '断粮须指定一支已知敌军。');
      }
      if (order.scheme === 'ambush' && region.ambushBonus > 0) {
        return issues('ALREADY', '该州已有伏兵布置。');
      }
      const chance = schemeChance(state, ctx, order.scheme, strategist, targetArmy, region);
      return {
        ok: true,
        issues: [],
        preview: `${strategist.name}（谋略 ${strategist.strategy}）施展「${SCHEME_LABELS[order.scheme]}」于${region.name}${targetArmy ? ` · ${targetArmy.name}` : ''}；耗银 ${cost} 两，预计成功率约 ${Math.round(chance * 100)}%（受地形与敌将权谋影响，非必成）。`,
      };
    }
    default:
      return issues('UNKNOWN_ORDER', '未知命令。');
  }
}

export function applyOrder(
  state: GameState,
  ctx: DerivedContext,
  order: Order,
  events: GameEvent[],
  source: GameEvent['source'] = 'player_order',
  factionKeyOverride?: FactionKey,
): void {
  const fk = factionKeyOverride ?? state.factionKey;
  const faction = state.factions[fk];
  const actorId = source === 'npc_ai' ? orderActorFor(state, order) : state.playerPersonId;
  const actorName = source === 'npc_ai' ? orderActorNameFor(state, order) : state.playerPersonName;
  switch (order.kind) {
    case 'move_army': {
      const army = state.armies.find((a) => a.armyId === order.armyId);
      if (!army) return;
      if (army.faction === 'YONG' && state.flags.successionCrisis) {
        const commander = ctx.charactersById[army.commanderId];
        const risk = successionCommandRisk(
          ctx.seed.relationships,
          state.special.YONG.princes ?? [],
          army.commanderId,
          state.characters[army.commanderId]?.militaryLoyalty ?? commander?.loyalty ?? 50,
          state.flags.successionCrisis,
        );
        if (risk) {
          events.push(emitEvent(state, {
            type: 'politics',
            title: `大雍·${army.commanderName}拒绝奉诏`,
            summary: `夺嫡危机中，${army.commanderName}因与${risk.rivalPrinceName}的关系网络及自身低忠诚拒绝调兵；其部暂留原地。朝廷需先稳定局势或更换统将。`,
            actorId: army.commanderId,
            actorName: army.commanderName,
            factionKey: 'YONG',
            targetId: army.armyId,
            targetLabel: army.name,
            after: { refusal: true, rivalPrinceId: risk.rivalPrinceId, rivalAffinity: risk.rivalAffinity, crownPrinceAffinity: risk.crownPrinceAffinity },
            evidence: '夺嫡危机 + 统将低忠诚 + 对竞争皇子的显式关系权重高于储君关系',
            source,
            visibleToPlayer: state.factionKey === 'YONG',
          }));
          return;
        }
      }
      const path = findPath(state, ctx, army.faction, army.nodeId, order.targetRegionId);
      if (!path.ok) return;
      const amount = order.amount ?? army.troops;
      const unitRequests = (order.units ?? []).filter((u) => u.count > 0);
      const isSplit = amount < army.troops || unitRequests.length > 0;
      let mover = army;
      if (isSplit) {
        const unitSum = unitRequests.reduce((s, u) => s + u.count, 0);
        const leviesTake = Math.max(0, Math.min(army.levies, amount - unitSum));
        const commander = commanderOf(ctx, order.commanderId) ?? freeCommander(state, ctx, army.faction);
        const detId = `${army.armyId}-D${state.date.turn}-${state.nextEventSeq}`;
        const det: Army = {
          ...army,
          armyId: detId,
          name: `${army.name}·分遣`,
          commanderId: commander?.person_id ?? army.commanderId,
          commanderName: commander?.name ?? army.commanderName,
          units: unitRequests.map((u) => {
            const stack = army.units.find((item) => item.unitId === u.unitId)!;
            return { ...stack, count: u.count };
          }),
          levies: leviesTake,
          troops: unitSum + leviesTake,
          status: 'idle',
          stance: 'defend',
          path: [],
          hopCosts: [],
          targetRegionId: null,
          marchDaysTotal: 0,
          marchDaysLeft: 0,
          lastBattleTurn: null,
          isDetachment: true,
          fatigue: clamp(army.fatigue + 4),
        };
        for (const req of unitRequests) {
          const stack = army.units.find((u) => u.unitId === req.unitId);
          if (stack) stack.count -= req.count;
        }
        army.units = army.units.filter((u) => u.count > 0);
        army.levies -= leviesTake;
        army.troops = army.levies + army.units.reduce((s, u) => s + u.count, 0);
        state.armies.push(det);
        mover = det;
        events.push(
          emitEvent(state, {
            type: 'order_accepted',
            title: `${army.name}分兵`,
            summary: `分出 ${amount.toLocaleString()} 人（特殊兵种 ${unitSum.toLocaleString()}）组成分遣队，由 ${det.commanderName} 统带。`,
            actorId,
            actorName,
            factionKey: army.faction,
            targetId: det.armyId,
            targetLabel: det.name,
            before: { troops: army.troops + amount },
            after: { troops: army.troops, detachment: det.troops },
            evidence: '分兵按指定兵力与特殊兵种拆分，征集兵补足',
            source,
            visibleToPlayer: true,
          }),
        );
      }
      const days = dayCostsFor(mover, path.costs, { routeTypes: path.routeTypes, season: seasonOf(state.date.month) });
      assignMarch(mover, path.path, days, order.targetRegionId);
      events.push(
        emitEvent(state, {
          type: 'army_move',
          title: `${mover.name}奉命开拔`,
          summary: `兵力 ${mover.troops.toLocaleString()}，目标${regionNameById(ctx, order.targetRegionId)}，行程 ${days.reduce((s, d) => s + d, 0)} 日。`,
          actorId,
          actorName,
          factionKey: mover.faction,
          targetId: mover.armyId,
          targetLabel: mover.name,
          after: { path: path.path, target: order.targetRegionId, days, troops: mover.troops },
          evidence: '路径由地图边权与行军速度计算',
          source,
          visibleToPlayer: mover.faction === fk || source === 'player_order',
        }),
      );
      return;
    }
    case 'recruit': {
      const amount = Math.round(order.amount);
      const crisisMult = fk === 'YONG' && state.flags.successionCrisis ? 1.3 : 1;
      faction.resources.cash -= Math.round(amount * BALANCE.recruit.cashPerMan * crisisMult);
      faction.resources.grain -= Math.round(amount * BALANCE.recruit.grainPerMan * crisisMult);
      faction.resources.iron -= Math.round(amount * BALANCE.recruit.ironPerMan);
      faction.resources.salt -= Math.round(amount * BALANCE.recruit.saltPerMan);
      faction.resources.horses -= Math.round(amount * BALANCE.recruit.horsesPerMan);
      faction.resources.manpower -= amount;
      const ownRegions = Object.values(state.regions).filter((r) => r.faction === fk);
      const region =
        (order.regionId ? state.regions[order.regionId] : undefined) ??
        (fk === state.factionKey ? state.regions[governedRegionId(state) ?? ''] : undefined) ??
        ownRegions[0];
      let targetName = '';
      let targetId = '';
      if (order.formNewArmy) {
        const commander = commanderOf(ctx, order.commanderId) ?? freeCommander(state, ctx, fk);
        const newArmy: Army = {
          armyId: `${fk}-NEW-${state.date.turn}-${state.nextEventSeq}`,
          faction: fk,
          name: `${region?.name ?? '京畿'}新募营`,
          commanderId: commander?.person_id ?? state.playerPersonId,
          commanderName: commander?.name ?? state.playerPersonName,
          districtId: '',
          nodeId: region?.regionId ?? ownRegions[0]?.regionId ?? '',
          originRegionId: region?.regionId ?? '',
          units: [],
          levies: amount,
          troops: amount,
          morale: 55,
          training: 44,
          supply: 76,
          fatigue: 6,
          stance: 'defend',
          status: 'idle',
          path: [],
          hopCosts: [],
          targetRegionId: null,
          marchDaysTotal: 0,
          marchDaysLeft: 0,
          lastBattleTurn: null,
          isDetachment: true,
        };
        state.armies.push(newArmy);
        targetName = newArmy.name;
        targetId = newArmy.armyId;
      } else {
        const target = state.armies.find((a) => a.faction === fk && a.nodeId === region?.regionId);
        if (target) {
          target.levies += amount;
          target.troops += amount;
          target.morale = clamp(target.morale + 1);
          targetName = target.name;
          targetId = target.armyId;
        } else if (region) {
          region.garrison += amount;
          region.garrisoned = true;
          targetName = `${region.name}州兵`;
          targetId = region.regionId;
        }
      }
      events.push(
        emitEvent(state, {
          type: 'recruit',
          title: `${FACTION_SHORT[fk]}征兵 ${amount.toLocaleString()} 人`,
          summary: `新兵编入${targetName || '地方军'}（${region?.name ?? '—'}），银钱与粮秣相应扣减。`,
          actorId,
          actorName,
          factionKey: fk,
          targetId,
          targetLabel: targetName,
          after: { troops: amount, cash: Math.round(faction.resources.cash) },
          evidence: '征募成本来自 balance.recruit；可编入现有军团、州兵或新建军团',
          source,
          visibleToPlayer: true,
        }),
      );
      return;
    }
    case 'levy_grain': {
      const count = Math.round(order.amount);
      const own = Object.values(state.regions)
        .filter((r) => r.faction === fk)
        .sort((a, b) => b.foodStore - a.foodStore)
        .slice(0, count);
      let gained = 0;
      for (const r of own) {
        const take = Math.min(r.foodStore, BALANCE.levyGrain.grainPerRegion);
        r.foodStore -= take;
        gained += take;
        r.order = clamp(r.order - BALANCE.levyGrain.orderCost);
        r.loyalty = clamp(r.loyalty - BALANCE.levyGrain.supportCost);
      }
      faction.resources.grain += gained;
      if (fk === 'CHU') {
        for (const h of state.special.CHU.houses ?? []) h.support = clamp(h.support - 1.5);
      }
      events.push(
        emitEvent(state, {
          type: 'order_accepted',
          title: `${FACTION_SHORT[fk]}征粮`,
          summary: `自 ${own.length} 个州府征得 ${gained} 石，治安与民心下降。`,
          actorId,
          actorName,
          factionKey: fk,
          targetId: own[0]?.regionId ?? '',
          targetLabel: own.map((r) => r.name).join('、'),
          before: { grain: Math.round(faction.resources.grain - gained) },
          after: { grain: Math.round(faction.resources.grain), order: Math.round(own[0]?.order ?? 0) },
          evidence: '征粮上限与代价见 balance.levyGrain',
          source,
        }),
      );
      return;
    }
    case 'levy_tax': {
      const count = Math.round(order.amount);
      const own = Object.values(state.regions)
        .filter((r) => r.faction === fk)
        .sort((a, b) => b.taxOutput - a.taxOutput)
        .slice(0, count);
      const gained = own.length * BALANCE.levyTax.cashPerRegion;
      for (const r of own) {
        r.order = clamp(r.order - BALANCE.levyTax.orderCost);
        r.loyalty = clamp(r.loyalty - BALANCE.levyTax.supportCost / 2);
      }
      faction.resources.cash += gained;
      if (fk === 'CHU') {
        for (const h of state.special.CHU.houses ?? []) h.support = clamp(h.support - BALANCE.levyTax.supportCost);
      }
      events.push(
        emitEvent(state, {
          type: 'order_accepted',
          title: `${FACTION_SHORT[fk]}加征商税`,
          summary: `从 ${own.length} 个州府加征 ${gained} 两；地方怨言上升。`,
          actorId,
          actorName,
          factionKey: fk,
          targetLabel: own.map((r) => r.name).join('、'),
          before: { cash: Math.round(faction.resources.cash - gained) },
          after: { cash: Math.round(faction.resources.cash) },
          evidence: '加征代价见 balance.levyTax',
          source,
        }),
      );
      return;
    }
    case 'trade': {
      const cost = Math.round(BALANCE.prices[order.resource] * order.amount * BALANCE.tradePremium);
      faction.resources.cash -= cost;
      if (order.resource === 'grain') faction.resources.grain += order.amount;
      if (order.resource === 'salt') faction.resources.salt += order.amount;
      if (order.resource === 'iron') faction.resources.iron += order.amount;
      if (order.resource === 'horses') faction.resources.horses += order.amount;
      events.push(
        emitEvent(state, {
          type: 'order_accepted',
          title: `${FACTION_SHORT[fk]}边市贸易`,
          summary: `购入 ${order.resource} ${order.amount}，耗银 ${cost}。`,
          actorId,
          actorName,
          factionKey: fk,
          targetLabel: '边市',
          before: { cash: Math.round(faction.resources.cash + cost) },
          after: { cash: Math.round(faction.resources.cash) },
          evidence: `价格 ${BALANCE.prices[order.resource]} × 溢价 ${BALANCE.tradePremium}`,
          source,
        }),
      );
      return;
    }
    case 'appease_tribe': {
      faction.resources.cash -= order.amount;
      const tribe = state.special.HUN.tribes?.find((t) => t.tribeId === order.tribeId);
      if (tribe) {
        tribe.loyalty = clamp(tribe.loyalty + Math.min(10, order.amount / BALANCE.appeaseTribe.cashPerPoint));
        tribe.lastGiftTurn = state.date.turn;
        tribe.stance =
          tribe.loyalty >= 65 ? 'eager' : tribe.loyalty >= 50 ? 'watchful' : tribe.loyalty >= 38 ? 'reluctant' : 'refusing';
      }
      events.push(
        emitEvent(state, {
          type: 'politics',
          title: `匈奴·赏赐${tribe?.name ?? '部落'}`,
          summary: `分赐 ${order.amount} 两，忠诚回升至 ${Math.round(tribe?.loyalty ?? 0)}。`,
          actorId,
          actorName,
          factionKey: 'HUN',
          targetId: tribe?.tribeId ?? '',
          targetLabel: tribe?.name ?? '',
          before: { loyalty: Math.round((tribe?.loyalty ?? 0) - Math.min(10, order.amount / BALANCE.appeaseTribe.cashPerPoint)) },
          after: { loyalty: Math.round(tribe?.loyalty ?? 0) },
          evidence: '赏赐规则 balance.appeaseTribe',
          source,
          visibleToPlayer: fk === 'HUN',
        }),
      );
      return;
    }
    case 'balance_princes': {
      faction.resources.cash -= BALANCE.balancePrinces.cashCost;
      const yong = state.special.YONG;
      yong.courtStability = clamp((yong.courtStability ?? 60) + BALANCE.balancePrinces.stabilityGain);
      const top = [...(yong.princes ?? [])].sort((a, b) => b.influence - a.influence)[0];
      if (top) top.influence = clamp(top.influence - BALANCE.balancePrinces.topInfluenceDrop);
      events.push(
        emitEvent(state, {
          type: 'succession',
          title: '大雍·皇帝平衡诸皇子',
          summary: `赐宴、调职与赏赐并用，朝局稳定升至 ${Math.round(yong.courtStability ?? 0)}。`,
          actorId,
          actorName,
          factionKey: 'YONG',
          targetId: top?.personId ?? '',
          targetLabel: top?.name ?? '',
          after: { courtStability: Math.round(yong.courtStability ?? 0) },
          evidence: '平衡规则 balance.balancePrinces',
          source,
          visibleToPlayer: fk === 'YONG',
        }),
      );
      return;
    }
    case 'negotiate_house': {
      faction.resources.cash -= BALANCE.negotiateHouse.cashCost;
      const house = state.special.CHU.houses?.find((h) => h.houseId === order.houseId);
      if (house) {
        house.support = clamp(house.support + BALANCE.negotiateHouse.supportGain);
        house.taxCompliance = Math.round((0.6 + house.support / 250) * 100) / 100;
        house.privateForce = Math.round(3_000 + house.support * BALANCE.politics.chu.privateForcePerSupport);
        house.lastNegotiationTurn = state.date.turn;
      }
      events.push(
        emitEvent(state, {
          type: 'politics',
          title: `大楚·与${house?.name ?? '世家'}协商`,
          summary: `以 ${BALANCE.negotiateHouse.cashCost} 两换取合作，支持度升至 ${Math.round(house?.support ?? 0)}。`,
          actorId,
          actorName,
          factionKey: 'CHU',
          targetId: house?.houseId ?? '',
          targetLabel: house?.name ?? '',
          after: { support: Math.round(house?.support ?? 0) },
          evidence: '协商规则 balance.negotiateHouse',
          source,
          visibleToPlayer: fk === 'CHU',
        }),
      );
      return;
    }
    case 'hold_court': {
      const debate = courtDebateEdge(state, ctx, order.agenda, order.speakerPersonId, order.oppositionPersonId);
      const decision = courtDecisionForResolution(order.agenda, order.resolution, debate.speaker, debate.opposition, order.decision);
      const cost = courtCost(order.agenda, decision);
      faction.resources.cash -= cost;
      const speakerOpinion = debate.speaker ? courtOpinion(debate.speaker, order.agenda) : '廷臣依据议题共议，采用默认效果';
      const oppositionOpinion = debate.opposition ? courtOpinion(debate.opposition, order.agenda) : '未指定反对臣';
      const agendaLabel = COURT_AGENDA_LABEL[order.agenda];
      const decisionLabel = COURT_DECISION_LABEL[decision];
      let summary = '';
      let after: Record<string, unknown> = { agenda: order.agenda, decision, resolution: order.resolution ?? 'direct_policy', cost };

      if (order.agenda === 'war_council') {
        const armies = state.armies.filter((a) => a.faction === fk);
        for (const army of armies) {
          if (decision === 'assertive') {
            army.morale = clamp(army.morale + 5);
            army.training = clamp(army.training + 2);
            army.fatigue = clamp(army.fatigue + 3);
          } else if (decision === 'balanced') {
            army.morale = clamp(army.morale + 3);
            army.training = clamp(army.training + 1);
          } else {
            army.morale = clamp(army.morale + 1);
            army.fatigue = clamp(army.fatigue - 5);
            army.supply = clamp(army.supply + 2);
          }
        }
        summary = decision === 'assertive'
          ? `兵部主张立即整军备边，仓曹警告军饷压力。廷议决定强硬推进：${armies.length} 支军队士气 +5、训练 +2、疲劳 +3。`
          : decision === 'balanced'
            ? `诸将与文臣折中议定：${armies.length} 支军队士气 +3、训练 +1，以有限军费改善战备。`
            : `廷议采纳缓进整训：${armies.length} 支军队士气 +1、疲劳 -5、补给 +2，暂不追加军费。`;
        after = { ...after, affectedArmies: armies.length, moraleDelta: decision === 'assertive' ? 5 : decision === 'balanced' ? 3 : 1, trainingDelta: decision === 'assertive' ? 2 : decision === 'balanced' ? 1 : 0 };
      } else if (order.agenda === 'succession') {
        const yong = state.special.YONG;
        const princes = yong.princes ?? [];
        const heir = princes.find((p) => p.isCrownPrince);
        const strongest = [...princes].sort((a, b) => b.influence - a.influence)[0];
        if (decision === 'assertive') {
          if (heir) {
            heir.influence = clamp(heir.influence + 10);
            heir.trust = clamp(heir.trust + 4);
          }
          for (const prince of princes) if (prince.personId !== heir?.personId) prince.trust = clamp(prince.trust - 4);
          yong.courtStability = clamp((yong.courtStability ?? 60) - 4);
        } else if (decision === 'balanced') {
          yong.courtStability = clamp((yong.courtStability ?? 60) + 7);
          if (strongest && strongest.personId !== heir?.personId) strongest.influence = clamp(strongest.influence - 5);
          for (const prince of princes) prince.trust = clamp(prince.trust + 2);
        } else {
          yong.courtStability = clamp((yong.courtStability ?? 60) + 4);
          for (const prince of princes) prince.trust = clamp(prince.trust + 5);
          if (heir) heir.influence = clamp(heir.influence - 3);
        }
        summary = decision === 'assertive'
          ? `中书主张尊储以定名分，诸王宾客反对偏袒。朝廷公开支持${heir?.name ?? '储君'}，其影响力上升，但朝局稳定下降至 ${Math.round(yong.courtStability ?? 0)}。`
          : decision === 'balanced'
            ? `廷议压低最强藩王的扩张空间、安抚各方，朝局稳定升至 ${Math.round(yong.courtStability ?? 0)}。`
            : `皇帝暂缓站队，给各皇子留足体面；信任回升，但储位支持度有所稀释。朝局稳定升至 ${Math.round(yong.courtStability ?? 0)}。`;
        after = { ...after, courtStability: yong.courtStability, crownPrinceInfluence: heir?.influence, strongestPrinceInfluence: strongest?.influence };
      } else if (order.agenda === 'tribal_alliance') {
        const hun = state.special.HUN;
        const tribes = hun.tribes ?? [];
        if (decision === 'assertive') {
          hun.cohesion = clamp((hun.cohesion ?? 58) + 8);
          for (const tribe of tribes) tribe.loyalty = clamp(tribe.loyalty - 3);
        } else if (decision === 'balanced') {
          hun.cohesion = clamp((hun.cohesion ?? 58) + 4);
          for (const tribe of tribes) tribe.loyalty = clamp(tribe.loyalty + 2);
        } else {
          hun.cohesion = clamp((hun.cohesion ?? 58) + 2);
          for (const tribe of tribes) tribe.loyalty = clamp(tribe.loyalty + 5);
        }
        for (const tribe of tribes) {
          tribe.stance = tribe.loyalty >= 65 ? 'eager' : tribe.loyalty >= 50 ? 'watchful' : tribe.loyalty >= 38 ? 'reluctant' : 'refusing';
        }
        summary = decision === 'assertive'
          ? `诸将要求统一号令，君主以强令整合联盟：协调度升至 ${Math.round(hun.cohesion ?? 0)}，但各部忠诚各降 3。`
          : decision === 'balanced'
            ? `廷议以赏赐与军令折中：协调度升至 ${Math.round(hun.cohesion ?? 0)}，各部忠诚 +2。`
            : `廷议优先兑现盟约，各部忠诚 +5，联盟协调度升至 ${Math.round(hun.cohesion ?? 0)}。`;
        after = { ...after, cohesion: hun.cohesion, tribes: tribes.map((t) => ({ id: t.tribeId, loyalty: t.loyalty, stance: t.stance })) };
      } else {
        const chu = state.special.CHU;
        const houses = chu.houses ?? [];
        if (decision === 'assertive') {
          chu.centralAuthority = clamp((chu.centralAuthority ?? 55) + 10);
          for (const house of houses) house.support = clamp(house.support - 5);
        } else if (decision === 'balanced') {
          chu.centralAuthority = clamp((chu.centralAuthority ?? 55) + 4);
          for (const house of houses) house.support = clamp(house.support + 2);
        } else {
          chu.centralAuthority = clamp((chu.centralAuthority ?? 55) - 3);
          for (const house of houses) house.support = clamp(house.support + 6);
        }
        for (const house of houses) {
          house.taxCompliance = Math.round((0.6 + house.support / 250) * 100) / 100;
          house.privateForce = Math.round(3_000 + house.support * BALANCE.politics.chu.privateForcePerSupport);
        }
        summary = decision === 'assertive'
          ? `台谏要求收归财赋与任官之权，世家代表警告反弹。中枢权威升至 ${Math.round(chu.centralAuthority ?? 0)}，各家支持下降 5。`
          : decision === 'balanced'
            ? `廷议以让利换取合作：中枢权威升至 ${Math.round(chu.centralAuthority ?? 0)}，各家支持 +2。`
            : `朝廷允诺地方保留更多利益，各家支持 +6，但中枢权威降至 ${Math.round(chu.centralAuthority ?? 0)}。`;
        after = { ...after, centralAuthority: chu.centralAuthority, houses: houses.map((h) => ({ id: h.houseId, support: h.support, taxCompliance: h.taxCompliance })) };
      }
      if (debate.edge !== 0) {
        if (order.agenda === 'war_council') {
          for (const army of state.armies.filter((a) => a.faction === fk)) {
            army.morale = clamp(army.morale + debate.edge);
          }
        } else if (order.agenda === 'succession') {
          const yong = state.special.YONG;
          yong.courtStability = clamp((yong.courtStability ?? 60) + debate.edge);
          state.factions.YONG.stability = clamp(yong.courtStability);
          after = { ...after, courtStability: yong.courtStability };
        } else if (order.agenda === 'tribal_alliance') {
          const hun = state.special.HUN;
          hun.cohesion = clamp((hun.cohesion ?? 58) + debate.edge);
          state.factions.HUN.stability = clamp(hun.cohesion);
          after = { ...after, cohesion: hun.cohesion };
        } else {
          const chu = state.special.CHU;
          chu.centralAuthority = clamp((chu.centralAuthority ?? 55) + debate.edge);
          state.factions.CHU.stability = clamp(chu.centralAuthority);
          after = { ...after, centralAuthority: chu.centralAuthority };
        }
        summary += ` 双方论证能力差使议案主要效果${debate.edge > 0 ? '增强' : '减弱'} ${debate.edge > 0 ? '+' : ''}${debate.edge}。`;
      }
      const resolutionLabel = order.resolution === 'adopt_speaker'
        ? `采纳主议臣意见（${debate.speaker?.name ?? '主议臣'}）`
        : order.resolution === 'adopt_opposition'
          ? `驳回主议、采纳反对臣意见（${debate.opposition?.name ?? '反对臣'}）`
          : order.resolution === 'compromise'
            ? '折中调和双方意见'
            : '君主直接裁定政策方向';
      let speakerStandingAfter: number | undefined;
      let oppositionStandingAfter: number | undefined;
      if (order.resolution === 'adopt_speaker') {
        speakerStandingAfter = adjustCourtStanding(state, ctx, debate.speaker?.person_id, 5);
        oppositionStandingAfter = adjustCourtStanding(state, ctx, debate.opposition?.person_id, -4);
      } else if (order.resolution === 'adopt_opposition') {
        speakerStandingAfter = adjustCourtStanding(state, ctx, debate.speaker?.person_id, -4);
        oppositionStandingAfter = adjustCourtStanding(state, ctx, debate.opposition?.person_id, 5);
      } else if (order.resolution === 'compromise') {
        speakerStandingAfter = adjustCourtStanding(state, ctx, debate.speaker?.person_id, 1);
        oppositionStandingAfter = adjustCourtStanding(state, ctx, debate.opposition?.person_id, 1);
      }
      const decisionRecord = {
        resolutionLabel,
        finalPolicy: COURT_DECISION_LABEL[decision],
        speakerStandingBefore: debate.speakerStanding,
        oppositionStandingBefore: debate.oppositionStanding,
        speakerStandingAfter: speakerStandingAfter ?? debate.speakerStanding,
        oppositionStandingAfter: oppositionStandingAfter ?? debate.oppositionStanding,
      };
      after = { ...after, ...decisionRecord };
      const debateRecord = {
        speakerPersonId: debate.speaker?.person_id ?? null,
        speakerName: debate.speaker?.name ?? '廷臣集议',
        speakerScore: debate.speakerScore,
        oppositionPersonId: debate.opposition?.person_id ?? null,
        oppositionName: debate.opposition?.name ?? '未指定反对臣',
        oppositionScore: debate.oppositionScore,
        speakerStandingBefore: debate.speakerStanding,
        oppositionStandingBefore: debate.oppositionStanding,
        speakerStandingAfter: state.characters[debate.speaker?.person_id ?? '']?.courtStanding ?? debate.speakerStanding,
        oppositionStandingAfter: state.characters[debate.opposition?.person_id ?? '']?.courtStanding ?? debate.oppositionStanding,
        debateEdge: debate.edge,
      };
      after = { ...after, ...debateRecord };
      events.push(
        emitEvent(state, {
          type: 'politics',
          title: `朝廷廷议·${agendaLabel}：${decisionLabel}`,
          summary: `${resolutionLabel}；最终政策「${COURT_DECISION_LABEL[decision]}」。 ${debate.speaker && debate.opposition ? `主议臣${debate.speaker.name}主张「${speakerOpinion}」，反对臣${debate.opposition.name}提出「${oppositionOpinion}」。 ` : ''}${summary} 廷议所列分歧：${order.agenda === 'war_council' ? '兵部主战、仓曹顾虑军需' : order.agenda === 'succession' ? '储位名分与诸王平衡' : order.agenda === 'tribal_alliance' ? '盟约兑现与统一军令' : '世家利益与中枢权威'}。执行耗银 ${cost.toLocaleString()} 两。`,
          actorId,
          actorName,
          factionKey: fk,
          targetId: `court-${state.date.turn}-${order.agenda}`,
          targetLabel: agendaLabel,
          before: {},
          after,
          evidence: '廷议根据议题相关能力比较主议臣与反对臣；能力差每 15 点修正 1 点主要效果，最高 ±3；裁决后果记录在事件账本。',
          source,
          visibleToPlayer: fk === state.factionKey || source === 'player_order',
        }),
      );
      return;
    }
    case 'reward_commander': {
      const person = ctx.charactersById[order.personId];
      if (!person) return;
      const runtime = state.characters[person.person_id] ?? {
        personId: person.person_id,
        alive: true,
        ageBand: person.age_band,
        courtStanding: 50,
        militaryLoyalty: person.loyalty,
      };
      const before = clamp(runtime.militaryLoyalty ?? person.loyalty);
      const after = clamp(before + order.amount / 1_000);
      runtime.militaryLoyalty = after;
      state.characters[person.person_id] = runtime;
      faction.resources.cash -= order.amount;
      events.push(emitEvent(state, {
        type: 'order_accepted',
        title: `君主赏赐将领·${person.name}`,
        summary: `赐银 ${order.amount.toLocaleString()} 两，${person.name}军令忠诚度由 ${Math.round(before)} 升至 ${Math.round(after)}。忠诚度会影响夺嫡危机期间的拒命风险。`,
        actorId,
        actorName,
        factionKey: fk,
        targetId: person.person_id,
        targetLabel: person.name,
        before: { militaryLoyalty: before, cash: faction.resources.cash + order.amount },
        after: { militaryLoyalty: after, loyaltyGain: after - before, cash: faction.resources.cash },
        evidence: '军令忠诚属于本局人物运行时数据；赏赐金额 1000 两换取 1 点忠诚，忠诚上限 100',
        source,
      }));
      return;
    }
    case 'settle_defeated_commander': {
      const person = ctx.charactersById[order.personId];
      if (!person) return;
      const runtime = state.characters[person.person_id];
      if (!runtime) return;
      const before = clamp(runtime.militaryLoyalty ?? person.loyalty);
      const army = state.armies.find((item) => item.faction === fk && item.commanderId === person.person_id);
      if (order.action === 'replace') {
        const replacement = order.replacementPersonId ? ctx.charactersById[order.replacementPersonId] : null;
        if (!army || !replacement || !state.characters[replacement.person_id]) return;
        const loyaltyAfter = clamp(before - 10);
        const moraleBefore = army.morale;
        const moraleAfter = clamp(army.morale - 5);
        const previousCommanderId = army.commanderId;
        const previousCommanderName = army.commanderName;
        army.commanderId = replacement.person_id;
        army.commanderName = replacement.name;
        army.morale = moraleAfter;
        runtime.militaryLoyalty = loyaltyAfter;
        const politicalOutcome = resolveBattleCasePolitics(state, ctx, person.person_id, order.action);
        runtime.pendingBattleSettlement = false;
        state.characters[person.person_id] = runtime;
        events.push(emitEvent(state, {
          type: 'politics',
          title: '撤换败将·' + person.name + ' → ' + replacement.name,
          summary: '君主撤换战败统将' + person.name + '，改由' + replacement.name + '接掌' + army.name + '。旧将军令忠诚由 ' + Math.round(before) + ' 降至 ' + Math.round(loyaltyAfter) + '；新旧指挥交接使所部士气 ' + Math.round(moraleBefore) + ' → ' + Math.round(moraleAfter) + '。' + (politicalOutcome ? ' ' + politicalOutcome : ''),
          actorId,
          actorName,
          factionKey: fk,
          targetId: army.armyId,
          targetLabel: army.name,
          before: {
            commanderId: previousCommanderId,
            commanderName: previousCommanderName,
            militaryLoyalty: before,
            morale: moraleBefore,
          },
          after: {
            action: order.action,
            commanderId: replacement.person_id,
            commanderName: replacement.name,
            dismissedCommanderId: person.person_id,
            militaryLoyalty: loyaltyAfter,
            loyaltyDelta: loyaltyAfter - before,
            morale: moraleAfter,
          },
          evidence: '仅允许君主撤换尚未善后的本方战败统将；接任人选必须在世、同属本方且未统领其他军团或州兵',
          source,
        }));
        return;
      }
      const cashBefore = faction.resources.cash;
      let loyaltyAfter = before;
      let moraleBefore: number | undefined;
      let moraleAfter: number | undefined;
      let trainingBefore: number | undefined;
      let trainingAfter: number | undefined;
      if (order.action === 'relieve') {
        faction.resources.cash -= 12_000;
        loyaltyAfter = clamp(before + 8);
        if (army) {
          moraleBefore = army.morale;
          army.morale = clamp(army.morale + 6);
          moraleAfter = army.morale;
        }
      } else {
        loyaltyAfter = clamp(before - 8);
        if (army) {
          moraleBefore = army.morale;
          trainingBefore = army.training;
          army.training = clamp(army.training + 5);
          army.morale = clamp(army.morale - 3);
          moraleAfter = army.morale;
          trainingAfter = army.training;
        }
      }
      runtime.militaryLoyalty = loyaltyAfter;
      const politicalOutcome = resolveBattleCasePolitics(state, ctx, person.person_id, order.action);
      runtime.pendingBattleSettlement = false;
      state.characters[person.person_id] = runtime;
      const isRelief = order.action === 'relieve';
      events.push(emitEvent(state, {
        type: 'politics',
        title: isRelief ? `抚恤败军·${person.name}` : `追责败将·${person.name}`,
        summary: (isRelief
          ? `君主拨银 12000 两抚恤败军，${person.name}军令忠诚由 ${Math.round(before)} 升至 ${Math.round(loyaltyAfter)}。${army ? '所部士气得到恢复。' : '原军团已不复存在，抚恤仅影响将领忠诚。'}`
          : `君主追究${person.name}战败之责，军令忠诚由 ${Math.round(before)} 降至 ${Math.round(loyaltyAfter)}。${army ? '所部训练加强，但士气受挫。' : '原军团已不复存在，追责仅影响将领忠诚。'}`) + (politicalOutcome ? ' ' + politicalOutcome : ''),
        actorId,
        actorName,
        factionKey: fk,
        targetId: person.person_id,
        targetLabel: person.name,
        before: {
          militaryLoyalty: before,
          cash: cashBefore,
          morale: moraleBefore,
          training: trainingBefore,
        },
        after: {
          action: order.action,
          militaryLoyalty: loyaltyAfter,
          loyaltyDelta: loyaltyAfter - before,
          cash: faction.resources.cash,
          morale: moraleAfter,
          training: trainingAfter,
          armyId: army?.armyId,
        },
        evidence: '仅允许处置上一回合记录为战败的在世将领；抚恤/追责结果由规则引擎结算',
        source,
      }));
      return;
    }
    case 'appoint': {
      const person = ctx.charactersById[order.personId];
      const region = state.regions[order.regionId];
      if (!person || !region) return;
      faction.resources.cash -= 8_000;
      const old = region.governorName;
      const oldGovernorId = region.governorId;
      const orderBefore = region.order;
      const loyaltyBefore = region.loyalty;
      const relationshipEffect = appointmentRelationshipEffect(
        ctx.seed.relationships,
        person.person_id,
        oldGovernorId,
        region.garrisonCommanderId,
      );
      region.governorId = person.person_id;
      region.governorName = person.name;
      region.order = clamp(region.order + relationshipEffect.orderDelta);
      region.loyalty = clamp(region.loyalty + 4 + relationshipEffect.loyaltyDelta);
      events.push(
        emitEvent(state, {
          type: 'order_accepted',
          title: `任命 ${person.name} 为${region.name}主官`,
          summary: `原任 ${old} 调离；新任官员治理 ${person.governance}。交接评估：${relationshipEffect.explanation}`,
          actorId,
          actorName,
          factionKey: fk,
          targetId: person.person_id,
          targetLabel: person.name,
          before: { governor: old, order: orderBefore, loyalty: loyaltyBefore },
          after: {
            governor: person.name,
            order: region.order,
            loyalty: region.loyalty,
            relationshipOrderDelta: relationshipEffect.orderDelta,
            relationshipLoyaltyDelta: relationshipEffect.loyaltyDelta,
          },
          evidence: '任命需君主权限并耗银 8000；交接修正只由种子显式人物关系触发',
          source,
        }),
      );
      return;
    }
    case 'rest_army': {
      const army = state.armies.find((a) => a.armyId === order.armyId);
      if (!army) return;
      army.supply = clamp(army.supply + 12);
      army.fatigue = clamp(army.fatigue - 12);
      army.morale = clamp(army.morale + 3);
      army.stance = 'defend';
      events.push(
        emitEvent(state, {
          type: 'order_accepted',
          title: `${army.name}整军休整`,
          summary: `补给 ${Math.round(army.supply)}、疲劳 ${Math.round(army.fatigue)}、士气 ${Math.round(army.morale)}。`,
          actorId,
          actorName,
          factionKey: army.faction,
          targetId: army.armyId,
          targetLabel: army.name,
          after: { supply: army.supply, fatigue: army.fatigue, morale: army.morale },
          source,
        }),
      );
      return;
    }
    case 'scout': {
      faction.resources.cash -= 1_200;
      const region = state.regions[order.regionId];
      const enemyArmies = state.armies.filter((a) => a.faction === region.faction && a.nodeId === region.regionId);
      const reliability = 0.62 + (state.date.turn % 7) * 0.03;
      let s = (state.seed + state.date.turn * 37 + region.regionId.length * 13) >>> 0;
      const rand = () => {
        s = (s + 0x6d2b79f5) >>> 0;
        let t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
      const observed = enemyArmies[0] ? Math.round((enemyArmies[0].troops * (0.75 + rand() * 0.4)) / 100) * 100 : 0;
      const intel: IntelEntry = {
        intelId: `intel-${state.gameId}-T${state.date.turn}-${state.intel.length + 1}`,
        subjectType: 'region',
        subjectId: region.regionId,
        subjectLabel: region.name,
        factionKnownTo: fk,
        source: 'scout',
        sourceEventId: `evt-${state.gameId}-T${state.date.turn}-${state.nextEventSeq}`,
        reliability: Math.round(reliability * 100) / 100,
        status: reliability > 0.72 ? 'reliable' : 'unconfirmed',
        observedAt: state.date.label,
        knownAt: state.date.label,
        text: enemyArmies[0]
          ? `斥候回报：${region.name}驻有${enemyArmies[0].name}，兵力约 ${observed.toLocaleString()}（估算，可能有误差）；城防 ${Math.round(region.fortification)}，粮秣状况不明。`
          : `斥候回报：${region.name}未见敌军野战部队，州兵约 ${Math.round(region.garrison * (0.8 + rand() * 0.4))}（估算）。`,
        estimate: enemyArmies[0]
          ? { troops: observed, garrison: region.garrison, note: '斥候估算，可靠度有限' }
          : { garrison: Math.round(region.garrison * (0.8 + rand() * 0.4)), note: '斥候估算' },
      };
      state.intel.unshift(intel);
      state.intel = state.intel.slice(0, 80);
      events.push(
        emitEvent(state, {
          type: 'intel',
          title: `斥候侦察${region.name}`,
          summary: intel.text,
          actorId,
          actorName,
          factionKey: fk,
          targetId: region.regionId,
          targetLabel: region.name,
          after: { reliability: intel.reliability, status: intel.status },
          evidence: `侦察获得时间为${state.date.label}；数据为估算值`,
          source,
        }),
      );
      return;
    }
    case 'dispatch_garrison': {
      const region = state.regions[order.regionId];
      if (!region) return;
      const amount = Math.min(Math.round(order.amount), region.garrison);
      if (amount < 60) return;
      const path = findPath(state, ctx, fk, region.regionId, order.targetRegionId);
      if (!path.ok) return;
      const commander =
        commanderOf(ctx, order.commanderId) ??
        (region.garrisonCommanderId && !commanderInUse(state, fk, region.garrisonCommanderId)
          ? commanderOf(ctx, region.garrisonCommanderId)
          : freeCommander(state, ctx, fk));
      const army: Army = {
        armyId: `${fk}-GAR-${state.date.turn}-${state.nextEventSeq}`,
        faction: fk,
        name: `${region.name}州兵`,
        commanderId: commander?.person_id ?? region.garrisonCommanderId,
        commanderName: commander?.name ?? region.garrisonCommanderName,
        districtId: '',
        nodeId: region.regionId,
        originRegionId: region.regionId,
        units: [],
        levies: amount,
        troops: amount,
        morale: 52,
        training: 42,
        supply: 72,
        fatigue: 8,
        stance: 'march',
        status: 'idle',
        path: [],
        hopCosts: [],
        targetRegionId: null,
        marchDaysTotal: 0,
        marchDaysLeft: 0,
        lastBattleTurn: null,
        isDetachment: true,
        isMilitia: true,
      };
      region.garrison -= amount;
      region.garrisoned = region.garrison > 0;
      state.armies.push(army);
      const days = dayCostsFor(army, path.costs, { routeTypes: path.routeTypes, season: seasonOf(state.date.month) });
      assignMarch(army, path.path, days, order.targetRegionId);
      events.push(
        emitEvent(state, {
          type: 'order_accepted',
          title: `${region.name}州兵奉命出征`,
          summary: `调出州兵 ${amount.toLocaleString()} 人，由 ${army.commanderName} 统带，前往${regionNameById(ctx, order.targetRegionId)}；${region.name}尚余州兵 ${region.garrison.toLocaleString()} 人。`,
          actorId,
          actorName,
          factionKey: fk,
          targetId: army.armyId,
          targetLabel: army.name,
          before: { garrison: region.garrison + amount },
          after: { garrison: region.garrison, armyTroops: amount },
          evidence: '州兵属地方守备，不计入名义总兵力；调出后本州防御下降',
          source,
          visibleToPlayer: true,
        }),
      );
      return;
    }
    case 'scheme': {
      const cost = SCHEME_COST[order.scheme] ?? 0;
      const strategist = commanderOf(ctx, order.strategistId ?? state.playerPersonId);
      const targetArmy = order.targetArmyId ? state.armies.find((a) => a.armyId === order.targetArmyId) : undefined;
      const region = order.targetRegionId
        ? state.regions[order.targetRegionId]
        : targetArmy
          ? state.regions[targetArmy.nodeId]
          : undefined;
      if (!region) return;
      faction.resources.cash -= cost;
      const chance = schemeChance(state, ctx, order.scheme, strategist, targetArmy, region);
      const seed = hashString(`${state.gameId}-${state.date.turn}-${order.orderId}-${order.scheme}`);
      const rand = mulberry(seed);
      const roll = rand();
      const success = roll < chance;
      const label = SCHEME_LABELS[order.scheme] ?? order.scheme;
      const schemeActorId = strategist?.person_id ?? actorId;
      const schemeActorName = strategist?.name ?? actorName;
      if (success) {
        if (order.scheme === 'fire') {
          const lossRate = 0.05 + rand() * 0.08;
          if (targetArmy) {
            const loss = Math.round(targetArmy.troops * lossRate);
            applyArmyLosses(targetArmy, loss);
            targetArmy.supply = clamp(targetArmy.supply - 18);
            targetArmy.morale = clamp(targetArmy.morale - 8);
            if (targetArmy.troops < 60) state.armies = state.armies.filter((a) => a.armyId !== targetArmy.armyId);
          } else {
            region.garrison = Math.round(region.garrison * (1 - lossRate));
            region.foodStore = Math.max(0, region.foodStore - 3_000);
          }
          region.order = clamp(region.order - 5);
          region.loyalty = clamp(region.loyalty - 4);
        } else if (order.scheme === 'cut_supply' && targetArmy) {
          targetArmy.supply = clamp(targetArmy.supply - 30);
          targetArmy.morale = clamp(targetArmy.morale - 12);
          applyArmyLosses(targetArmy, Math.round(targetArmy.troops * 0.02));
        } else if (order.scheme === 'sow_discord') {
          const targetFaction = targetArmy?.faction ?? region.faction;
          if (targetFaction === 'HUN') {
            const tribe = [...(state.special.HUN.tribes ?? [])].sort((a, b) => a.loyalty - b.loyalty)[0];
            if (tribe) tribe.loyalty = clamp(tribe.loyalty - 8);
          } else if (targetFaction === 'YONG') {
            state.special.YONG.courtStability = clamp((state.special.YONG.courtStability ?? 60) - 5);
          } else {
            const house = [...(state.special.CHU.houses ?? [])].sort((a, b) => a.support - b.support)[0];
            if (house) house.support = clamp(house.support - 6);
          }
          if (targetArmy) targetArmy.morale = clamp(targetArmy.morale - 6);
          region.loyalty = clamp(region.loyalty - 3);
        } else if (order.scheme === 'ambush') {
          region.ambushBonus = Math.max(region.ambushBonus, 0.18);
        } else if (order.scheme === 'feint') {
          region.diversionBonus = Math.max(region.diversionBonus, 0.12);
          region.diversionFor = fk;
          region.garrison = Math.round(region.garrison * 0.95);
        }
      }
      events.push(
        emitEvent(state, {
          type: 'scheme',
          title: `${schemeActorName}施${label}`,
          summary: success
            ? `计成：${label}在${region.name}奏效${targetArmy ? `，敌军「${targetArmy.name}」受损` : ''}。`
            : `计谋被识破：${label}未能在${region.name}奏效，银钱已耗。`,
          actorId: schemeActorId,
          actorName: schemeActorName,
          factionKey: fk,
          targetId: targetArmy?.armyId ?? region.regionId,
          targetLabel: targetArmy?.name ?? region.name,
          before: { cash: Math.round(faction.resources.cash + cost) },
          after: {
            cash: Math.round(faction.resources.cash),
            success,
            chance: Math.round(chance * 100),
            targetTroops: targetArmy?.troops,
            ambushBonus: region.ambushBonus,
            diversionBonus: region.diversionBonus,
          },
          payload: { scheme: order.scheme, success, chance, roll: Math.round(roll * 1000) / 1000, seed },
          evidence: `成功率 ${Math.round(chance * 100)}%，判定值 ${Math.round(roll * 1000) / 1000}，种子 ${seed}`,
          source,
          visibleToPlayer: true,
        }),
      );
      return;
    }
  }
}

function orderActorFor(state: GameState, order: Order): string {
  if (order.kind === 'move_army' || order.kind === 'rest_army') {
    const army = state.armies.find((a) => a.armyId === order.armyId);
    return army?.commanderId ?? 'npc';
  }
  return 'npc';
}

function orderActorNameFor(state: GameState, order: Order): string {
  if (order.kind === 'move_army' || order.kind === 'rest_army') {
    const army = state.armies.find((a) => a.armyId === order.armyId);
    return army?.commanderName ?? '边将';
  }
  return '朝廷/王庭';
}

export function findCharacter(ctx: DerivedContext, id: string): CharacterSeed | undefined {
  return ctx.charactersById[id];
}

function npcActor(ctx: DerivedContext, factionKey: FactionKey): { id: string; name: string } {
  const ruler = ctx.seed.characters.find((c) => c.faction_key === factionKey && c.identity_type === '君主');
  return { id: ruler?.person_id ?? 'npc', name: ruler?.name ?? '朝廷' };
}
