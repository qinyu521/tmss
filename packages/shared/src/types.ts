/**
 * 天命史书 · 共享类型
 * 世界事实由规则引擎产生；前端只提交意图（Order），不直接写状态。
 */

export type FactionKey = 'HUN' | 'YONG' | 'CHU';
export const FACTION_KEYS: FactionKey[] = ['HUN', 'YONG', 'CHU'];

export type PlayerRole = 'ruler' | 'governor' | 'general' | 'strategist';

export const PLAYER_ROLES: { key: PlayerRole; label: string; blurb: string }[] = [
  { key: 'ruler', label: '君主', blurb: '总揽国政：任命、征调、外交与全局军令' },
  { key: 'governor', label: '郡守/州牧', blurb: '经营本州：税粮、治安、地方军与世家协商' },
  { key: 'general', label: '将军', blurb: '执掌授权军区：行军、驻防、侦察与战场命令' },
  { key: 'strategist', label: '军师', blurb: '分析已知情报、提出方案；不能直接改动国政与军队' },
];

/* ------------------------------------------------------------------ */
/* 种子数据类型（与 data/source JSON 对齐，保持原字段名）            */
/* ------------------------------------------------------------------ */

export interface FactionSeed {
  key: FactionKey;
  name: string;
  ruler_title: string;
  consort_title: string;
  heir_title: string;
  royal_surname: string;
  surname_pool: string[];
  capital: string;
  government_style: string;
  regions: string[][];
  military: string[][];
  houses: string[][];
  warlords: string[][];
  free_talents: string[][];
  honors: string[];
  initial_force_total: number;
  initial_force_total_label: string;
  force_accounting_note: string;
  economy_profile: {
    population_and_recruitment: string;
    food_production: string;
    food_status: string;
    salt_production: string;
    salt_status: string;
    iron_production: string;
    iron_status: string;
    horse_production: string;
    horse_status: string;
    cash_and_trade: string;
    relative_ratings_0_5: Record<string, number>;
  };
  strategic_doctrine: {
    strengths: string[];
    weaknesses: string[];
    strategic_rules: string[];
  };
}

export interface CharacterSeed {
  person_id: string;
  faction_key: FactionKey;
  faction: string;
  name: string;
  gender: string;
  age_band: string;
  identity_type: string;
  current_position_standard: string;
  current_position_local: string;
  institution: string;
  region: string;
  house_or_clan: string;
  warlord_group: string;
  power_base: string;
  archetype_id: string;
  historical_archetype: string;
  archetype_trait: string;
  archetype_risk: string;
  governance: number;
  command: number;
  strategy: number;
  intrigue: number;
  commerce: number;
  loyalty: number;
  potential: number;
  status: string;
  allegiance: string;
  relationship_note: string;
  design_note: string;
  archetype_affinity: string;
  archetype_affinity_note: string;
  archetype_faction_match: string;
}

export interface AppointmentSeed {
  assignment_id: string;
  faction: string;
  person_id: string;
  person_name: string;
  institution_type: string;
  standard_position: string;
  local_title: string;
  region_or_station: string;
  house_or_clan: string;
  status: string;
  authority_scope: string;
  historical_archetype_id: string;
  historical_archetype_name: string;
  archetype_affinity: string;
  archetype_faction_match: string;
  archetype_affinity_note: string;
}

export interface TerritorySeed {
  faction: string;
  region_id: string;
  region: string;
  capital_or_seat: string;
  regional_profile: string;
  key_locations: string;
  governor_id: string;
  governor: string;
  deputy_id: string;
  deputy: string;
  local_commander_id: string;
  local_commander: string;
  risk: string;
  map_x: number;
  map_y: number;
  gameplay_note: string;
}

export interface MilitaryDistrictSeed {
  faction: string;
  district_id: string;
  military_district: string;
  command_area: string;
  mission: string;
  commander_id: string;
  commander: string;
  deputy_id: string;
  deputy: string;
  base_region: string;
  readiness: string;
  loyalty_risk: string;
  design_note: string;
}

export interface HouseSeed {
  faction: string;
  house_id: string;
  house_name: string;
  patriarch_id: string;
  patriarch: string;
  heir_id: string;
  heir: string;
  chief_adviser_id: string;
  chief_adviser: string;
  power_base_region: string;
  assets_and_network: string;
  institutional_influence: string;
  current_agenda: string;
  principal_rival: string;
  private_force: string;
  political_risk: string;
}

export interface WarlordSeed {
  faction: string;
  warlord_id: string;
  warlord_group: string;
  force_composition: string;
  leader_id: string;
  leader: string;
  deputy_id: string;
  deputy: string;
  chief_strategist_id: string;
  chief_strategist: string;
  base_region: string;
  current_aim: string;
  initial_strength: string;
  central_loyalty: string;
  political_risk: string;
  recruitment_or_resolution: string;
}

export interface NobleTitleSeed {
  faction: string;
  rank_id: string;
  noble_title: string;
  holder_id: string;
  holder: string;
  family_or_clan: string;
  origin_of_rank: string;
  rights_and_limits: string;
  design_note: string;
}

export interface RelationshipSeed {
  faction: string;
  source_person_id: string;
  source_name: string;
  relation: string;
  target_person_id: string;
  target_name: string;
  strength: string;
  notes: string;
}

export interface MapNodeSeed {
  node_id: string;
  faction_key?: FactionKey;
  faction: string;
  region: string;
  node_name: string;
  node_type: string;
  parent_node_id: string;
  location_role: string;
  controller_id: string;
  controller_name: string;
  local_military_id: string;
  local_military: string;
  resource_profile: string;
  terrain_and_risk: string;
  map_x: number;
  map_y: number;
  visibility_rule: string;
}

export interface MapEdgeSeed {
  edge_id: string;
  from_region: string;
  to_region: string;
  from_faction: string;
  to_faction: string;
  route_type: string;
  base_movement_cost: number;
  throughput: string;
  control_or_interdiction: string;
  simulation_rule: string;
  /** 派生边标记：source 为原始种子，derived 为补充生成 */
  origin?: 'source' | 'derived';
  derived_reason?: string;
}

/** 派生边：由 scripts/build-derived 或 API 启动时生成的补充连接。 */
export interface DerivedEdge {
  edge_id: string;
  from_region: string;
  to_region: string;
  from_faction: FactionKey;
  to_faction: FactionKey;
  route_type: string;
  base_movement_cost: number;
  throughput: string;
  derived_reason: string;
}

export interface MilitaryUnitSeed {
  unit_id: string;
  faction_key: FactionKey;
  faction_name: string;
  unit_name: string;
  unit_type: string;
  game_role: string;
  historical_prototype_note: string;
  historical_period_or_reference: string;
  unlock_and_recruitment_requirements: string;
  strengths: string;
  weaknesses: string;
  resource_constraints: string;
  balance_cap: string;
  source_urls: string[];
  design_status: string;
}

export interface ForceAllocationSeed {
  allocation_id: string;
  faction_key: FactionKey;
  faction_name: string;
  military_district: string;
  initial_force_count: number;
  force_count_label: string;
  accounting_note: string;
}

export interface ArchetypeSeed {
  archetype_id: string;
  historical_name: string;
  era_or_state: string;
  historical_role_type: string;
  abstract_traits: string;
  limitations_or_risk: string;
  game_design_use: string;
  usage_note: string;
  primary_faction_key: string;
  primary_faction_direction: string;
  affinity_note: string;
  initial_role_guidance: string;
}

export interface SeedRoster {
  project?: unknown;
  factions: FactionSeed[];
  historical_archetypes: ArchetypeSeed[];
  characters: CharacterSeed[];
  appointments: AppointmentSeed[];
  territories: TerritorySeed[];
  military_districts: MilitaryDistrictSeed[];
  houses: HouseSeed[];
  warlord_groups: WarlordSeed[];
  noble_titles: NobleTitleSeed[];
  relationships: RelationshipSeed[];
  map_nodes: MapNodeSeed[];
  map_edges: MapEdgeSeed[];
  military_units: MilitaryUnitSeed[];
  national_force_allocations: ForceAllocationSeed[];
  prototype_affinity_audit?: unknown[];
  archetype_allocation_rules?: unknown[];
  version_log?: unknown[];
}

/* ------------------------------------------------------------------ */
/* 兵种派生档案                                                        */
/* ------------------------------------------------------------------ */

export type UnitCategory =
  | 'heavy_cavalry'
  | 'guard_cavalry'
  | 'horse_archer'
  | 'light_cavalry'
  | 'heavy_infantry'
  | 'shock_infantry'
  | 'guard_infantry'
  | 'spearman'
  | 'crossbow'
  | 'naval_raider'
  | 'light_infantry';

export interface TerrainMods {
  plain: number;
  hill: number;
  mountain: number;
  forest: number;
  river: number;
  fort: number;
}

export interface UnitProfile {
  unitId: string;
  name: string;
  faction: FactionKey;
  category: UnitCategory;
  attack: number;
  defense: number;
  ranged: number;
  mobility: number;
  morale: number;
  supplyCost: number;
  upkeepCash: number;
  terrain: TerrainMods;
  counters: UnitCategory[];
  counteredBy: UnitCategory[];
  recruit: {
    manpower: number;
    iron: number;
    horses: number;
    salt: number;
    cash: number;
    minTraining: number;
  };
  capPerFaction: number;
  visual: {
    icon: string;
    mount: boolean;
    bow: boolean;
    shield: boolean;
    weapon: 'spear' | 'sword' | 'bow' | 'crossbow' | 'axe' | 'halberd';
    armor: 'light' | 'medium' | 'heavy';
    banner: 'horse' | 'wolf' | 'sun' | 'eagle' | 'river' | 'serpent' | 'phoenix' | 'tiger';
  };
  note: string;
}

/* ------------------------------------------------------------------ */
/* 游戏运行时状态                                                      */
/* ------------------------------------------------------------------ */

export interface Resources {
  grain: number;
  salt: number;
  iron: number;
  horses: number;
  cash: number;
  manpower: number;
}

export interface GameDate {
  year: number;
  month: number;
  day: number;
  turn: number;
  label: string;
  dayIndex: number;
}

export interface RegionState {
  regionId: string;
  name: string;
  faction: FactionKey;
  governorId: string;
  governorName: string;
  population: number;
  foodStore: number;
  saltStore: number;
  ironStore: number;
  horseStock: number;
  order: number;
  loyalty: number;
  fortification: number;
  supplyLevel: number;
  threat: number;
  garrison: number;
  foodOutput: number;
  saltOutput: number;
  ironOutput: number;
  horseOutput: number;
  taxOutput: number;
  /** 州府地形关键词：plain/hill/mountain/forest/river */
  terrain: 'plain' | 'hill' | 'mountain' | 'forest' | 'river';
  x: number;
  y: number;
            /** 当前控制者是否已实际驻军（州兵不计入名义总兵力） */
  garrisoned: boolean;
  /** 州兵统带（来自种子州府守将） */
  garrisonCommanderId: string;
  garrisonCommanderName: string;
  /** 伏击加成（由计谋设置，下一场本州战斗生效后清零） */
  ambushBonus: number;
  /** 佯攻/声东击西：指定势力进攻本州时获得加成 */
  diversionBonus: number;
  diversionFor?: FactionKey | null;
}

/** 72 个战略地图节点的运行时控制状态；与州府行政归属分离。 */
export interface MapNodeState {
  nodeId: string;
  name: string;
  regionId: string;
  nodeType: string;
  faction: FactionKey;
  garrison: number;
  fortification: number;
  supplyLevel: number;
  terrain: RegionState['terrain'];
  resourceProfile: string;
}

export interface ArmyUnitStack {
  unitId: string;
  name: string;
  category: UnitCategory;
  count: number;
}

export type ArmyStance = 'defend' | 'march' | 'siege' | 'retreat';
export type ArmyStatus = 'idle' | 'marching' | 'fighting';

export interface Army {
  armyId: string;
  faction: FactionKey;
  name: string;
  commanderId: string;
  commanderName: string;
  districtId: string;
  /** 行政州府 ID，供现有政务、军区权限和经济规则使用。 */
  nodeId: string;
  /** 实际战场地图节点 ID；旧存档缺失时回退到州府节点。 */
  mapNodeId?: string;
  /** 当前行军路线上的战略节点 ID（不含起点）。 */
  mapPath?: string[];
  mapHopCosts?: number[];
  /** 当前地图路段的完整日数，用于跨旬位置显示。 */
  mapCurrentHopDaysTotal?: number;
  targetMapNodeId?: string | null;
  units: ArmyUnitStack[];
  levies: number;
  troops: number;
  morale: number;
  training: number;
  supply: number;
  fatigue: number;
  stance: ArmyStance;
  status: ArmyStatus;
  path: string[];
  hopCosts: number[];
  targetRegionId: string | null;
  marchDaysTotal: number;
  marchDaysLeft: number;
  lastBattleTurn: number | null;
  originRegionId: string;
  /** 分遣队（由主力或州兵拆分） */
  isDetachment?: boolean;
  /** 州兵临时编成的野战部队 */
  isMilitia?: boolean;
}

export interface FactionState {
  key: FactionKey;
  name: string;
  shortName: string;
  color: string;
  resources: Resources;
  nominalTroops: number;
  reputation: number;
  adminEfficiency: number;
  stability: number;
  taxCompliance: number;
  control: string[];
  statusTags: string[];
  notes: string[];
}

export interface TribeState {
  tribeId: string;
  name: string;
  regionId: string;
  chiefId: string;
  chiefName: string;
  loyalty: number;
  greed: number;
  troops: number;
  stance: 'eager' | 'watchful' | 'reluctant' | 'refusing';
  lastGiftTurn: number;
  demand: string;
}

export interface PrinceState {
  personId: string;
  name: string;
  factionKey: FactionKey;
  influence: number;
  ambition: number;
  trust: number;
  supporters: string[];
  agenda: string;
  isCrownPrince: boolean;
}

export interface HousePowerState {
  houseId: string;
  name: string;
  factionKey: FactionKey;
  patriarchId: string;
  patriarchName: string;
  regionId: string;
  support: number;
  taxCompliance: number;
  privateForce: number;
  agenda: string;
  rival: string;
  lastNegotiationTurn: number;
}

export interface FactionSpecial {
  /** 匈奴：联盟协调度 0-100 */
  cohesion?: number;
  tribes?: TribeState[];
  /** 大雍：皇子派系与朝局稳定 */
  princes?: PrinceState[];
  courtStability?: number;
  /** 大楚：世家支持度与中央权威 */
  houses?: HousePowerState[];
  centralAuthority?: number;
}

export interface IntelEntry {
  intelId: string;
  subjectType: 'army' | 'region' | 'faction' | 'character' | 'battle';
  subjectId: string;
  subjectLabel: string;
  factionKnownTo: FactionKey;
  source: 'scout' | 'report' | 'market' | 'diplomacy' | 'battle' | 'event';
  sourceEventId: string;
  reliability: number;
  status: 'unconfirmed' | 'reliable' | 'confirmed' | 'speculative';
  observedAt: string;
  knownAt: string;
  text: string;
  /** 侦察/奏报给出的估算值，允许有误差；不得当作世界真实值使用 */
  estimate?: { troops?: number; garrison?: number; note?: string };
}

export type OrderKind =
  | 'move_army'
  | 'dispatch_garrison'
  | 'recruit'
  | 'levy_grain'
  | 'levy_tax'
  | 'trade'
  | 'appease_tribe'
  | 'balance_princes'
  | 'negotiate_house'
  | 'appoint'
  | 'rest_army'
  | 'scout'
  | 'scheme';

export type SchemeKind = 'fire' | 'cut_supply' | 'sow_discord' | 'ambush' | 'feint';

export type Order =
  | {
      orderId: string;
      kind: 'move_army';
      armyId: string;
      targetRegionId: string;
      /** 可选：直接指定 72 节点地图中的具体据点；缺省为目标州府。 */
      targetMapNodeId?: string;
      /** 本次调动的总兵力；缺省为全军 */
      amount?: number;
      /** 随军调走的特殊兵种与数量；其余按征集兵计算 */
      units?: { unitId: string; count: number }[];
      /** 分兵/分遣时的统兵官 */
      commanderId?: string;
    }
  | {
      orderId: string;
      kind: 'dispatch_garrison';
      regionId: string;
      targetRegionId: string;
      amount: number;
      commanderId?: string;
    }
  | {
      orderId: string;
      kind: 'recruit';
      amount: number;
      regionId?: string;
      commanderId?: string;
      formNewArmy?: boolean;
    }
  | { orderId: string; kind: 'levy_grain'; amount: number }
  | { orderId: string; kind: 'levy_tax'; amount: number }
  | { orderId: string; kind: 'trade'; resource: 'salt' | 'iron' | 'horses' | 'grain'; amount: number }
  | { orderId: string; kind: 'appease_tribe'; tribeId: string; amount: number }
  | { orderId: string; kind: 'balance_princes'; amount: number }
  | { orderId: string; kind: 'negotiate_house'; houseId: string; amount: number }
  | { orderId: string; kind: 'appoint'; personId: string; regionId: string }
  | { orderId: string; kind: 'rest_army'; armyId: string }
  | { orderId: string; kind: 'scout'; regionId: string }
  | {
      orderId: string;
      kind: 'scheme';
      scheme: SchemeKind;
      targetRegionId?: string;
      targetArmyId?: string;
      /** 施计者；缺省为当前玩家人物（军师/君主） */
      strategistId?: string;
    };

export interface OrderIssue {
  code: string;
  message: string;
}

/** 人物运行时状态：生死/死因/成长记录；种子属性只读，成长增量存于 attrs。 */
export interface CharacterRuntime {
  personId: string;
  alive: boolean;
  ageBand: string;
  deathTurn?: number;
  deathCause?: string;
  /** 成长提示（仅人物视图展示，不发事件刷屏） */
  growthNote?: string;
  /** 成长带来的属性增量覆盖值（绝对值，非增量）；键为 governance/command/strategy/intrigue/commerce */
  attrs?: Partial<Record<'governance' | 'command' | 'strategy' | 'intrigue' | 'commerce', number>>;
}

export interface OrderValidation {
  ok: boolean;
  issues: OrderIssue[];
  preview?: string;
}

export interface GameState {
  schemaVersion: number;
  gameId: string;
  seed: number;
  factionKey: FactionKey;
  playerRole: PlayerRole;
  playerPersonId: string;
  playerPersonName: string;
  createdAt: string;
  date: GameDate;
  factions: Record<FactionKey, FactionState>;
  regions: Record<string, RegionState>;
  /** 缺失于历史存档；加载时基于权威种子幂等补齐。 */
  mapNodes?: Record<string, MapNodeState>;
  armies: Army[];
  diplomacy: Record<string, number>;
  special: Record<FactionKey, FactionSpecial>;
  intel: IntelEntry[];
  pendingOrders: Order[];
  nextEventSeq: number;
  /** 人物生命周期运行时状态（schema v2 新增；缺失条目按在世处理） */
  characters: Record<string, CharacterRuntime>;
  statistics: {
    battles: number;
    casualties: number;
    turnsPlayed: number;
    occupiedRegions: number;
    /** 被夺取的粮仓、关隘、港埠等非州府节点数。 */
    occupiedMapNodes?: number;
  };
  flags: {
    successionCrisis: boolean;
    tribalRefusal: boolean;
    houseBoycott: boolean;
  };
}

export type GameEventType =
  | 'turn_start'
  | 'season'
  | 'resource'
  | 'shortage'
  | 'order_accepted'
  | 'order_rejected'
  | 'army_move'
  | 'battle'
  | 'occupation'
  | 'politics'
  | 'diplomacy'
  | 'recruit'
  | 'intel'
  | 'npc_action'
  | 'succession'
  | 'scheme'
  | 'chronicle';

export interface GameEvent {
  eventId: string;
  gameId: string;
  turn: number;
  dateLabel: string;
  type: GameEventType;
  actorId: string;
  actorName: string;
  factionKey: FactionKey | 'NEUTRAL';
  targetId: string;
  targetLabel: string;
  title: string;
  summary: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  source: 'engine' | 'player_order' | 'npc_ai' | 'chronicle';
  evidence: string;
  visibleToPlayer: boolean;
  payload?: Record<string, unknown>;
}

export interface ChronicleEntry {
  entryId: string;
  gameId: string;
  turn: number;
  dateLabel: string;
  kind: 'annal' | 'biography' | 'analysis' | 'scene';
  title: string;
  /** 规则事实层：不得被文风改写 */
  facts: string;
  /** 文学层：明确标为文学润色 */
  literary?: string;
  /** 史官推断层 */
  inference?: string;
  sourceEventIds: string[];
  generatedBy: 'template' | 'llm';
}

export interface TurnReport {
  turn: number;
  dateLabel: string;
  events: GameEvent[];
  chronicle: ChronicleEntry[];
  summary: string;
  rejectedOrders: { orderId: string; issues: OrderIssue[] }[];
}
