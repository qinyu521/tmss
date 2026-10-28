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
import { assignMarch, dayCostsFor, estimatePathDays, findPath, regionNameById } from './movement.js';
import { seasonOf } from './season.js';
import { applyArmyLosses } from './battle.js';
import { UNIT_PROFILES } from '../unitProfiles.js';

const ROLE_ALLOWED: Record<PlayerRole, OrderKind[]> = ROLE_ALLOWED_ORDERS as Record<PlayerRole, OrderKind[]>;

const TRADE_LIMITS: Record<string, number> = { grain: 20_000, salt: 500, iron: 500, horses: 200 };

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
      if (state.factionKey === 'HUN') {
        const tribe = state.special.HUN.tribes?.find((t) => t.regionId === army.nodeId);
        if (tribe && tribe.stance === 'refusing') {
          return issues(
            'TRIBE_REFUSAL',
            `${tribe.name}首领${tribe.chiefName}拒绝出兵（忠诚 ${Math.round(tribe.loyalty)}）。可先赏赐部落或以其他方式恢复协调度。`,
          );
        }
      }
      const path = findPath(state, ctx, army.faction, army.nodeId, order.targetRegionId, { troops: order.amount ?? army.troops });
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
      const previewArmy = isSplit
        ? {
            faction: army.faction,
            troops: amount,
            levies: amount - unitSum,
            units: unitRequests.map((req) => {
              const stack = army.units.find((u) => u.unitId === req.unitId);
              return { ...stack!, count: req.count };
            }),
            fatigue: army.fatigue,
          }
        : army;
      const estimatedDays = estimatePathDays(previewArmy, path, seasonOf(state.date.month));
      return {
        ok: true,
        issues: [],
        preview: `${isSplit ? `分兵 ${amount.toLocaleString()} 人` : '全军'}${commanderNote}，${unitSum > 0 ? `随军特殊兵种 ${unitSum.toLocaleString()} 人，` : ''}经 ${path.path.map((id) => regionNameById(ctx, id)).join(' → ')}，预计 ${estimatedDays} 日（约 ${Math.ceil(estimatedDays / BALANCE.turnDays)} 回合）。`,
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
      const path = findPath(state, ctx, state.factionKey, order.regionId, order.targetRegionId, { troops: order.amount });
      if (!path.ok) return issues('NO_PATH', path.error ?? '无法抵达目标州府。');
      const estimatedDays = estimatePathDays(
        { faction: state.factionKey, troops: order.amount, levies: order.amount, units: [], fatigue: 8 },
        path,
        seasonOf(state.date.month),
      );
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
        preview: `从${region.name}调出州兵 ${order.amount.toLocaleString()} 人${cmd ? `，由 ${cmd.name} 统带（统率 ${cmd.command} / 谋略 ${cmd.strategy}）` : ''}，经 ${path.path.map((id) => regionNameById(ctx, id)).join(' → ')}，约 ${estimatedDays} 日。`,
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
      const path = findPath(state, ctx, army.faction, army.nodeId, order.targetRegionId, { troops: order.amount ?? army.troops });
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
    case 'appoint': {
      const person = ctx.charactersById[order.personId];
      const region = state.regions[order.regionId];
      if (!person || !region) return;
      faction.resources.cash -= 8_000;
      const old = region.governorName;
      region.governorId = person.person_id;
      region.governorName = person.name;
      region.loyalty = clamp(region.loyalty + 4);
      events.push(
        emitEvent(state, {
          type: 'order_accepted',
          title: `任命 ${person.name} 为${region.name}主官`,
          summary: `原任 ${old} 调离；新任官员能力（治理 ${person.governance}）将影响该州执行效率。`,
          actorId,
          actorName,
          factionKey: fk,
          targetId: person.person_id,
          targetLabel: person.name,
          before: { governor: old },
          after: { governor: person.name },
          evidence: '任命需君主权限并耗银 8000',
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
      const path = findPath(state, ctx, fk, region.regionId, order.targetRegionId, { troops: amount });
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
