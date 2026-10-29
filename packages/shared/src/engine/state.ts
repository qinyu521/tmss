import type {
  Army,
  CharacterSeed,
  FactionKey,
  FactionSpecial,
  FactionState,
  GameState,
  HousePowerState,
  IntelEntry,
  PlayerRole,
  PrinceState,
  TribeState,
} from '../types.js';
import { FACTION_KEYS } from '../types.js';
import { BALANCE, INITIAL_RESOURCES } from '../balance.js';
import { FACTION_VISUALS, makeDate, ROLE_LABEL } from '../constants.js';
import { buildContext, buildInitialArmies, buildRegions, DerivedContext, diplomacyKey } from '../dataset.js';
import type { SeedRoster } from '../types.js';

export const SCHEMA_VERSION = 5;

const clamp = (n: number, lo = 0, hi = 100) => Math.min(hi, Math.max(lo, n));

export function factionNameOf(ctx: DerivedContext, key: FactionKey): string {
  return ctx.factionsByKey[key].name;
}

export function selectPlayerPerson(
  ctx: DerivedContext,
  factionKey: FactionKey,
  role: PlayerRole,
): CharacterSeed {
  const chars = ctx.seed.characters.filter((c) => c.faction_key === factionKey);
  const regions = ctx.regionsByFaction[factionKey];
  if (role === 'ruler') {
    const ruler = chars.find((c) => c.identity_type === '君主');
    if (ruler) return ruler;
  }
  if (role === 'governor') {
    const t = regions[0];
    const gov = chars.find((c) => c.person_id === t.governor_id);
    if (gov) return gov;
  }
  if (role === 'general') {
    const district = ctx.districtsByFaction[factionKey][0];
    const cmd = chars.find((c) => c.person_id === district.commander_id);
    if (cmd) return cmd;
  }
  if (role === 'strategist') {
    const strategist =
      chars.find((c) => /情报机构|国史院|枢密|中枢文书|密报/.test(c.identity_type)) ??
      chars.find((c) => c.identity_type === '监察首长');
    if (strategist) return strategist;
  }
  return chars[0];
}

function buildTribes(ctx: DerivedContext, factionKey: FactionKey, nominal: number): TribeState[] {
  const houses = ctx.housesByFaction[factionKey];
  const regions = ctx.regionsByFaction[factionKey];
  return houses.map((h, i) => {
    const char = ctx.charactersById[h.patriarch_id];
    const region = regions.find((r) => r.region === h.power_base_region) ?? regions[i % regions.length];
    const loyalty = clamp((char?.loyalty ?? 55) + 2);
    return {
      tribeId: h.house_id,
      name: h.house_name,
      regionId: region.region_id,
      chiefId: h.patriarch_id,
      chiefName: h.patriarch,
      loyalty,
      greed: clamp(100 - (char?.commerce ?? 50) + 20),
      troops: Math.round(nominal / houses.length / 100) * 100,
      stance: loyalty >= 65 ? 'eager' : loyalty >= 50 ? 'watchful' : loyalty >= 38 ? 'reluctant' : 'refusing',
      lastGiftTurn: 0,
      demand: h.current_agenda,
    };
  });
}

function buildPrinces(ctx: DerivedContext, factionKey: FactionKey): PrinceState[] {
  const chars = ctx.seed.characters.filter((c) => c.faction_key === factionKey);
  const wanted = ['储君', '皇子/宗王二支', '皇子/宗王三支'];
  const picked = wanted
    .map((t) => chars.find((c) => c.identity_type === t))
    .filter((c): c is CharacterSeed => Boolean(c));
  return picked.map((c, i) => ({
    personId: c.person_id,
    name: c.name,
    factionKey,
    influence: clamp(48 - i * 4 + Math.round(c.intrigue / 8) + Math.round(c.governance / 10)),
    ambition: clamp(100 - c.loyalty + 18),
    trust: clamp(c.loyalty),
    supporters: chars
      .filter((x) => x.house_or_clan && x.house_or_clan === c.house_or_clan && x.person_id !== c.person_id)
      .slice(0, 3)
      .map((x) => x.name),
    agenda: c.relationship_note || '争取更多任命与军费',
    isCrownPrince: c.identity_type === '储君',
  }));
}

function buildHousePowers(ctx: DerivedContext, factionKey: FactionKey): HousePowerState[] {
  const houses = ctx.housesByFaction[factionKey];
  const regions = ctx.regionsByFaction[factionKey];
  return houses.map((h, i) => {
    const char = ctx.charactersById[h.patriarch_id];
    const support = clamp(BALANCE.politics.chu.houseSupportBase + Math.round(((char?.loyalty ?? 55) - 55) / 2));
    const region = regions.find((r) => r.region === h.power_base_region) ?? regions[i % regions.length];
    return {
      houseId: h.house_id,
      name: h.house_name,
      factionKey,
      patriarchId: h.patriarch_id,
      patriarchName: h.patriarch,
      regionId: region.region_id,
      support,
      taxCompliance: Math.round((0.6 + support / 250) * 100) / 100,
      privateForce: 3_000 + support * BALANCE.politics.chu.privateForcePerSupport,
      agenda: h.current_agenda,
      rival: h.principal_rival,
      lastNegotiationTurn: 0,
    };
  });
}

function initialIntel(ctx: DerivedContext, factionKey: FactionKey, dateLabel: string): IntelEntry[] {
  const enemies = FACTION_KEYS.filter((k) => k !== factionKey);
  const entries: IntelEntry[] = [];
  const ownArmies = buildInitialArmies(ctx).filter((a) => a.faction === factionKey);
  if (ownArmies[0]) {
    entries.push({
      intelId: 'intel-own-1',
      subjectType: 'army',
      subjectId: ownArmies[0].armyId,
      subjectLabel: ownArmies[0].name,
      factionKnownTo: factionKey,
      source: 'report',
      sourceEventId: 'seed-initial',
      reliability: 1,
      status: 'confirmed',
      observedAt: dateLabel,
      knownAt: dateLabel,
      text: `本部奏报：${ownArmies[0].name}驻于本州，兵员 ${ownArmies[0].troops.toLocaleString()}，补给与士气见军册。`,
    });
  }
  enemies.slice(0, 2).forEach((enemy, i) => {
    const enemyArmies = buildInitialArmies(ctx).filter((a) => a.faction === enemy);
    const sample = enemyArmies[(i + 1) % enemyArmies.length];
    const visual = FACTION_VISUALS[enemy];
    entries.push({
      intelId: `intel-border-${i}`,
      subjectType: 'army',
      subjectId: sample.armyId,
      subjectLabel: sample.name,
      factionKnownTo: factionKey,
      source: 'report',
      sourceEventId: 'seed-initial',
      reliability: 0.55,
      status: 'unconfirmed',
      observedAt: dateLabel,
      knownAt: dateLabel,
      text: `边报（未证实）：${visual.shortName} ${sample.name} 似在边境集结，旗号与兵力尚待斥候核实。`,
    });
  });
  return entries;
}

export function createGame(
  seed: SeedRoster,
  opts: { gameId: string; factionKey: FactionKey; playerRole: PlayerRole; seed?: number; now?: string },
): GameState {
  const ctx = buildContext(seed);
  const factionKey = opts.factionKey;
  const date = makeDate(0, 1);
  const armies = buildInitialArmies(ctx);
  const regions = buildRegions(ctx, INITIAL_RESOURCES);
  const persona = selectPlayerPerson(ctx, factionKey, opts.playerRole);

  const factions = {} as Record<FactionKey, FactionState>;
  for (const key of FACTION_KEYS) {
    const fs = ctx.factionsByKey[key];
    const res = { ...INITIAL_RESOURCES[key] };
    factions[key] = {
      key,
      name: fs.name,
      shortName: FACTION_VISUALS[key].shortName,
      color: FACTION_VISUALS[key].primary,
      resources: res,
      nominalTroops: fs.initial_force_total,
      reputation: key === 'HUN' ? 51 : key === 'YONG' ? 68 : 61,
      adminEfficiency: key === 'HUN' ? 46 : key === 'YONG' ? 76 : 63,
      stability: key === 'HUN' ? 52 : key === 'YONG' ? 62 : 57,
      taxCompliance: key === 'HUN' ? 0.7 : key === 'YONG' ? 0.86 : 0.79,
      control: regionsOf(ctx, regions, key),
      statusTags:
        key === 'HUN'
          ? ['缺粮', '缺盐', '铁料受限', '联盟协调度']
          : key === 'YONG'
            ? ['缺盐', '缺优质战马', '皇子争储']
            : ['缺战马', '缺铁', '世家掣肘'],
      notes:
        key === 'HUN'
          ? fs.strategic_doctrine.strategic_rules.slice()
          : key === 'YONG'
            ? ['中央、禁军、地方与军区指挥权限不同，任何单一将领不能一键调动全国八十万。', '皇子派系影响力长期变动，处置不当会触发朝局危机。']
            : ['钱粮盐相对充足，但世家可影响税赋、征兵与输粮。', '弓弩兵需要阵地与侦察保护，被包抄时风险极高。'],
    };
  }

  const tribes = buildTribes(ctx, 'HUN', factions.HUN.nominalTroops);
  const cohesion = Math.round(
    BALANCE.politics.hun.baseCohesion +
      (tribes.reduce((s, t) => s + t.loyalty, 0) / tribes.length - 55) * 0.7,
  );
  const princes = buildPrinces(ctx, 'YONG');
  const houses = buildHousePowers(ctx, 'CHU');
  const special: Record<FactionKey, FactionSpecial> = {
    HUN: { cohesion: clamp(cohesion), tribes },
    YONG: { princes, courtStability: BALANCE.politics.yong.baseCourtStability },
    CHU: {
      houses,
      centralAuthority: Math.round(houses.reduce((s, h) => s + h.support, 0) / houses.length),
    },
  };

  const diplomacy: Record<string, number> = { ...BALANCE.initialDiplomacy };
  for (const key of FACTION_KEYS) {
    if (!(diplomacyKey(key, key) in diplomacy)) diplomacy[diplomacyKey(key, key)] = 100;
  }

  const state: GameState = {
    schemaVersion: SCHEMA_VERSION,
    gameId: opts.gameId,
    seed: opts.seed ?? 20261028,
    factionKey,
    playerRole: opts.playerRole,
    playerPersonId: persona.person_id,
    playerPersonName: persona.name,
    createdAt: opts.now ?? new Date().toISOString(),
    date,
    factions,
    regions,
    armies,
    diplomacy,
    special,
    intel: initialIntel(ctx, factionKey, date.label),
    pendingOrders: [],
    nextEventSeq: 1,
    // 生命周期：开局全员在世，年龄段取自种子
    characters: Object.fromEntries(
      seed.characters.map((c) => [
        c.person_id,
        { personId: c.person_id, alive: true, ageBand: c.age_band, courtStanding: 50, militaryLoyalty: c.loyalty },
      ]),
    ),
    statistics: { battles: 0, casualties: 0, turnsPlayed: 0, occupiedRegions: 0 },
    flags: { successionCrisis: false, tribalRefusal: false, houseBoycott: false },
  };
  return state;
}

function regionsOf(ctx: DerivedContext, regions: GameState['regions'], key: FactionKey): string[] {
  return Object.values(regions)
    .filter((r) => r.faction === key)
    .map((r) => r.regionId);
}

export function playerRoleLabel(role: PlayerRole): string {
  return ROLE_LABEL[role];
}

/**
 * 存档迁移框架：按版本号顺序应用迁移函数数组。
 * 新增 schema 版本时，只需向 MIGRATIONS 追加 `{ from, to, apply }`；
 * apply 只做增量修补，必须幂等且不得改写种子数据。
 */
interface Migration {
  from: number;
  to: number;
  apply: (state: GameState, roster?: CharacterSeed[]) => void;
}

/** v1 → v2：补充人物生命周期运行时状态，旧档全员在世。 */
function migrateV1toV2(state: GameState, roster?: CharacterSeed[]): void {
  if (!state.characters) state.characters = {};
  for (const c of roster ?? []) {
    if (!state.characters[c.person_id]) {
      state.characters[c.person_id] = { personId: c.person_id, alive: true, ageBand: c.age_band };
    }
  }
}

/** v2 → v3：为旧档人物补充朝廷声望，不改写其存活状态与既有属性。 */
function migrateV2toV3(state: GameState, roster?: CharacterSeed[]): void {
  if (!state.characters) state.characters = {};
  for (const c of roster ?? []) {
    if (!state.characters[c.person_id]) {
      state.characters[c.person_id] = { personId: c.person_id, alive: true, ageBand: c.age_band, courtStanding: 50 };
    }
  }
  for (const runtime of Object.values(state.characters)) runtime.courtStanding ??= 50;
}

/** v3 → v4：把人物的军令忠诚变为本局运行时数据，旧档从种子忠诚度起算。 */
function migrateV3toV4(state: GameState, roster?: CharacterSeed[]): void {
  if (!state.characters) state.characters = {};
  for (const person of roster ?? []) {
    if (!state.characters[person.person_id]) {
      state.characters[person.person_id] = {
        personId: person.person_id,
        alive: true,
        ageBand: person.age_band,
        courtStanding: 50,
        militaryLoyalty: person.loyalty,
      };
    } else {
      state.characters[person.person_id].militaryLoyalty ??= person.loyalty;
    }
  }
  for (const runtime of Object.values(state.characters)) {
    runtime.courtStanding ??= 50;
    runtime.militaryLoyalty ??= 50;
  }
}

/**
 * v4 → v5: repair legacy in-flight marches saved before current-hop progress existed.
 * Older versions reduced marchDaysLeft for partial travel but left hopCosts[0]
 * unchanged. The difference between the remaining hop-cost sum and marchDaysLeft
 * is therefore the elapsed time on the current hop. Newer saves already have
 * currentHopDaysTotal and are left untouched.
 */
function migrateV4toV5(state: GameState): void {
  for (const army of state.armies ?? []) {
    if (army.status !== 'marching' || !army.path?.length || !army.hopCosts?.length) continue;
    if (Number.isFinite(army.currentHopDaysTotal) && (army.currentHopDaysTotal ?? 0) > 0) continue;

    const firstHopTotal = Math.max(1, army.hopCosts[0] ?? 1);
    const remainingRouteCosts = army.hopCosts.reduce((sum, days) => sum + Math.max(0, days), 0);
    const savedRemainingDays = Math.max(0, Math.min(remainingRouteCosts, army.marchDaysLeft ?? remainingRouteCosts));
    const elapsedOnCurrentHop = Math.max(0, Math.min(firstHopTotal, remainingRouteCosts - savedRemainingDays));
    army.currentHopDaysTotal = firstHopTotal;
    if (elapsedOnCurrentHop > 0) {
      army.hopCosts[0] = Math.max(1, firstHopTotal - elapsedOnCurrentHop);
    }
    army.marchDaysLeft = army.hopCosts.reduce((sum, days) => sum + Math.max(0, days), 0);
  }
}

const MIGRATIONS: Migration[] = [
  { from: 1, to: 2, apply: migrateV1toV2 },
  { from: 2, to: 3, apply: migrateV2toV3 },
  { from: 3, to: 4, apply: migrateV3toV4 },
  { from: 4, to: 5, apply: migrateV4toV5 },
]

/** 旧存档迁移入口：先做跨版本幂等修补，再按版本链顺序迁移到当前版本。 */
export function migrateState(state: GameState, roster?: CharacterSeed[]): GameState {
  if (!state.schemaVersion) state.schemaVersion = 1;
  if (!state.intel) state.intel = [];
  if (!state.flags) state.flags = { successionCrisis: false, tribalRefusal: false, houseBoycott: false };
  for (const m of MIGRATIONS) {
    if (state.schemaVersion === m.from) {
      m.apply(state, roster);
      state.schemaVersion = m.to;
    }
  }
  return state;
}

/** 人物是否在世；缺失条目（旧档/种子外人物）按在世处理。 */
export function isCharacterAlive(state: GameState, personId: string): boolean {
  return state.characters?.[personId]?.alive ?? true;
}

/** 取人物有效属性：成长覆盖值优先于种子值（种子永不改写）。 */
export function effectiveAttr(
  state: GameState,
  personId: string,
  attr: 'governance' | 'command' | 'strategy' | 'intrigue' | 'commerce',
  seedValue: number,
): number {
  return state.characters?.[personId]?.attrs?.[attr] ?? seedValue;
}

/** 匈奴：名义兵力 → 当前可统一调动兵力的折算系数 */
export function cohesionFactor(state: GameState): number {
  const c = state.special.HUN.cohesion ?? 55;
  return Math.max(
    BALANCE.politics.hun.mobilizableFloor,
    Math.min(BALANCE.politics.hun.mobilizableCeiling, BALANCE.politics.hun.mobilizableFloor + c / 200),
  );
}

export function armyEffectiveTroops(state: GameState, army: Army): number {
  if (army.faction !== 'HUN') return army.troops;
  return Math.round(army.troops * cohesionFactor(state));
}

export function housesCompliance(state: GameState): number {
  const houses = state.special.CHU.houses ?? [];
  if (houses.length === 0) return 1;
  return houses.reduce((s, h) => s + h.taxCompliance, 0) / houses.length;
}

export function isPlayerFaction(state: GameState, key: FactionKey): boolean {
  return state.factionKey === key;
}

export { clamp };
