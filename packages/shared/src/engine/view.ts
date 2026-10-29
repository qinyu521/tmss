import type {
  Army,
  FactionKey,
  FactionSpecial,
  GameDate,
  GameState,
  IntelEntry,
  Order,
  PlayerRole,
  RegionState,
  Resources,
} from '../types.js';
import { FACTION_KEYS } from '../types.js';
import type { DerivedContext } from '../dataset.js';
import { isAtWar } from '../dataset.js';
import { FACTION_VISUALS, fmt } from '../constants.js';
import { factionTroops } from './economy.js';
import { effectiveAttr } from './state.js';
import { SEASON_LABELS, seasonOf, type Season } from './season.js';

export interface DeceasedEntry {
  personId: string;
  name: string;
  deathCause?: string;
  deathTurn?: number;
}

export interface OwnFactionView {
  key: FactionKey;
  name: string;
  shortName: string;
  color: string;
  resources: Resources;
  nominalTroops: number;
  fieldTroops: number;
  statusTags: string[];
  reputation: number;
  adminEfficiency: number;
  stability: number;
  taxCompliance: number;
  notes: string[];
  controlCount: number;
}

export interface PublicFactionView {
  key: FactionKey;
  name: string;
  shortName: string;
  color: string;
  atWar: boolean;
  regionsCount: number;
  knownTroops?: number;
  troopsLabel: string;
  stance: string;
  publicTags: string[];
}

export interface RegionView {
  regionId: string;
  name: string;
  faction: FactionKey;
  ownerShort: string;
  x: number;
  y: number;
  terrain: RegionState['terrain'];
  fortification: number;
  threat: number;
  owned: boolean;
  order?: number;
  loyalty?: number;
  garrison?: number;
  supplyLevel?: number;
  foodOutput?: number;
  saltOutput?: number;
  ironOutput?: number;
  horseOutput?: number;
  population?: number;
  governorName?: string;
  garrisonCommanderName?: string;
  intel?: { reliability: number; garrisonEstimate?: number; status: string };
}

export interface ArmyView {
  armyId: string;
  faction: FactionKey;
  ownerShort: string;
  name: string;
  commanderName: string;
  commanderId?: string;
  commanderCommand?: number;
  commanderStrategy?: number;
  nodeId: string;
  regionName: string;
  own: boolean;
  status: Army['status'];
  stance: Army['stance'];
  path: string[];
  targetRegionId: string | null;
  progress: number;
  troops?: number;
  troopsLabel: string;
  units?: Army['units'];
  levies?: number;
  morale?: number;
  training?: number;
  supply?: number;
  fatigue?: number;
  confidence?: string;
  intelText?: string;
  isMilitia?: boolean;
  isDetachment?: boolean;
  /** 仅向本方公开实际战略节点位置与路线。 */
  mapNodeId?: string;
  mapPath?: string[];
  targetMapNodeId?: string | null;
}

export interface MapNodeView {
  nodeId: string;
  name: string;
  regionId: string;
  nodeType: string;
  faction: FactionKey;
  ownerShort: string;
  x: number;
  y: number;
  owned: boolean;
  garrison?: number;
  fortification?: number;
  supplyLevel?: number;
}

export interface DiplomacyView {
  key: string;
  a: FactionKey;
  b: FactionKey;
  value: number;
  state: 'war' | 'tense' | 'neutral' | 'friendly';
  label: string;
  allianceActive: boolean;
  allianceEndTurn?: number;
}

export interface PlayerView {
  gameId: string;
  factionKey: FactionKey;
  playerRole: PlayerRole;
  playerPersonId: string;
  playerPersonName: string;
  date: GameDate;
  /** 当前季节（由日期推导，含一句影响提示） */
  season: { key: Season; label: string; desc: string; hint: string };
  own: OwnFactionView;
  factions: PublicFactionView[];
  regions: RegionView[];
  /** 72 个战略节点的控制态；敌方具体驻军仍不对玩家公开。 */
  mapNodes: MapNodeView[];
  armies: ArmyView[];
  diplomacy: DiplomacyView[];
  special: FactionSpecial;
  intel: IntelEntry[];
  pendingOrders: Order[];
  statistics: GameState['statistics'];
  flags: GameState['flags'];
  /** 本国已故人物名单（他国讣闻只能通过事件/情报获知，不在此下发） */
  deceased: DeceasedEntry[];
  schemaVersion: number;
}

/** 玩家视图：只暴露通过侦察、奏报、亲历获得的信息；敌方精确库存与军力不外泄。 */
export function buildPlayerView(state: GameState, ctx: DerivedContext): PlayerView {
  const ownKey = state.factionKey;
  const ownRegions = Object.values(state.regions).filter((r) => r.faction === ownKey);
  const intelByArmy = new Map(
    state.intel.filter((i) => i.subjectType === 'army').map((i) => [i.subjectId, i]),
  );
  const intelByRegion = new Map(
    state.intel.filter((i) => i.subjectType === 'region').map((i) => [i.subjectId, i]),
  );
  const adjacency = adjacencyNames(state);

  const regions: RegionView[] = Object.values(state.regions).map((region) => {
    const owned = region.faction === ownKey;
    const scouted = intelByRegion.get(region.regionId);
    const view: RegionView = {
      regionId: region.regionId,
      name: region.name,
      faction: region.faction,
      ownerShort: FACTION_VISUALS[region.faction].shortName,
      x: region.x,
      y: region.y,
      terrain: region.terrain,
      // 敌方城防与威胁只给十位档位；精确值须经斥候/情报获得。
      fortification: owned ? region.fortification : Math.round(region.fortification / 10) * 10,
      threat: owned ? region.threat : Math.round(region.threat / 10) * 10,
      owned,
    };
    if (owned) {
      view.order = Math.round(region.order);
      view.loyalty = Math.round(region.loyalty);
      view.garrison = region.garrison;
      view.supplyLevel = region.supplyLevel;
      view.foodOutput = region.foodOutput;
      view.saltOutput = region.saltOutput;
      view.ironOutput = region.ironOutput;
      view.horseOutput = region.horseOutput;
      view.population = region.population;
      view.governorName = region.governorName;
      view.garrisonCommanderName = region.garrisonCommanderName;
    } else if (scouted && scouted.estimate) {
      view.intel = {
        reliability: scouted.reliability,
        garrisonEstimate: scouted.estimate.garrison,
        status: scouted.status,
      };
    }
    return view;
  });

  const mapNodes: MapNodeView[] = Object.values(state.mapNodes ?? {}).map((node) => {
    const owned = node.faction === ownKey;
    const seedNode = ctx.seed.map_nodes.find((n) => n.node_id === node.nodeId);
    const result: MapNodeView = {
      nodeId: node.nodeId,
      name: node.name,
      regionId: node.regionId,
      nodeType: node.nodeType,
      faction: node.faction,
      ownerShort: FACTION_VISUALS[node.faction].shortName,
      x: seedNode?.map_x ?? 0,
      y: seedNode?.map_y ?? 0,
      owned,
    };
    if (owned) {
      result.garrison =
        node.nodeType === '州府/主城'
          ? state.regions[node.regionId]?.garrison ?? node.garrison
          : node.garrison;
      result.fortification = node.fortification;
      result.supplyLevel = node.supplyLevel;
    }
    return result;
  });

  const armies: ArmyView[] = [];
  for (const army of state.armies) {
    const own = army.faction === ownKey;
    const region = state.regions[army.nodeId];
    const intel = intelByArmy.get(army.armyId);
    const adjacent =
      region && (adjacency[region.regionId] ?? []).some((id) => state.regions[id]?.faction === ownKey);
    if (!own && !intel && !adjacent) continue;
    armies.push({
      armyId: army.armyId,
      faction: army.faction,
      ownerShort: FACTION_VISUALS[army.faction].shortName,
      name: own || intel ? army.name : `${FACTION_VISUALS[army.faction].shortName}未知兵团`,
      commanderName: own || intel ? army.commanderName : '未详',
      commanderId: own ? army.commanderId : undefined,
      commanderCommand: own
        ? effectiveAttr(state, army.commanderId, 'command', ctx.charactersById[army.commanderId]?.command ?? 0)
        : undefined,
      commanderStrategy: own
        ? effectiveAttr(state, army.commanderId, 'strategy', ctx.charactersById[army.commanderId]?.strategy ?? 0)
        : undefined,
      nodeId: army.nodeId,
      regionName: region?.name ?? '',
      mapNodeId: own ? army.mapNodeId : undefined,
      mapPath: own ? (army.mapPath ?? []) : [],
      targetMapNodeId: own ? army.targetMapNodeId : null,
      own,
      status: army.status,
      stance: army.stance,
      path: own ? army.path : [],
      targetRegionId: own ? army.targetRegionId : null,
      progress: own && (army.mapPath?.length ?? 0) > 0 && (army.mapCurrentHopDaysTotal ?? 0) > 0
        ? Math.max(0, Math.min(1, 1 - (army.mapHopCosts?.[0] ?? 0) / (army.mapCurrentHopDaysTotal ?? 1)))
        : own && army.path.length > 0 && (army.currentHopDaysTotal ?? army.hopCosts[0] ?? 0) > 0
          ? Math.max(0, Math.min(1, 1 - (army.hopCosts[0] ?? 0) / (army.currentHopDaysTotal ?? army.hopCosts[0] ?? 1)))
          : 0,
      troops: own ? army.troops : undefined,
      troopsLabel: own
        ? `${fmt(army.troops)}人`
        : intel?.estimate?.troops
          ? `约 ${fmt(Math.round(intel.estimate.troops * 0.75))}–${fmt(Math.round(intel.estimate.troops * 1.25))}人`
          : '未详',
      units: own ? army.units : undefined,
      levies: own ? army.levies : undefined,
      morale: own ? Math.round(army.morale) : undefined,
      training: own ? Math.round(army.training) : undefined,
      supply: own ? Math.round(army.supply) : undefined,
      fatigue: own ? Math.round(army.fatigue) : undefined,
      confidence: own ? 'confirmed' : intel ? intel.status : 'speculative',
      intelText: intel?.text,
      isMilitia: army.isMilitia,
      isDetachment: army.isDetachment,
    });
  }

  const factions: PublicFactionView[] = FACTION_KEYS.map((key) => {
    const f = state.factions[key];
    const own = key === ownKey;
    const knownArmies = state.armies.filter(
      (a) => a.faction === key && (a.faction === ownKey || intelByArmy.has(a.armyId)),
    );
    const knownTroops = own ? factionTroops(state, key) : knownArmies.length
      ? knownArmies.reduce((s, a) => s + (intelByArmy.get(a.armyId)?.estimate?.troops ?? 0), 0)
      : undefined;
    return {
      key,
      name: f.name,
      shortName: FACTION_VISUALS[key].shortName,
      color: FACTION_VISUALS[key].primary,
      atWar: isAtWar(state.diplomacy, ownKey, key),
      regionsCount: Object.values(state.regions).filter((r) => r.faction === key).length,
      knownTroops: knownTroops || undefined,
      troopsLabel: own ? `${fmt(factionTroops(state, key))}人（实有）` : knownTroops ? `${fmt(knownTroops)}人（情报汇总）` : '未详',
      stance: isAtWar(state.diplomacy, ownKey, key) ? '交战' : (state.diplomacy[pairKey(ownKey, key)] ?? 0) < 0 ? '戒备' : '未定',
      publicTags: own ? f.statusTags : [],
    };
  });

  const diplomacy: DiplomacyView[] = [];
  for (let i = 0; i < FACTION_KEYS.length; i++) {
    for (let j = i + 1; j < FACTION_KEYS.length; j++) {
      const a = FACTION_KEYS[i];
      const b = FACTION_KEYS[j];
      const value = state.diplomacy[pairKey(a, b)] ?? 0;
      const treaty = (state.treaties ?? []).find((item) =>
        item.kind === 'alliance' &&
        item.status === 'active' &&
        state.date.turn <= item.endTurn &&
        ((item.a === a && item.b === b) || (item.a === b && item.b === a)),
      );
      diplomacy.push({
        key: pairKey(a, b),
        a,
        b,
        value,
        state: value <= -25 ? 'war' : value < 0 ? 'tense' : value < 25 ? 'neutral' : 'friendly',
        label: value <= -25 ? '交战' : value < 0 ? '戒备' : value < 25 ? '中立' : '友好',
        allianceActive: Boolean(treaty),
        allianceEndTurn: treaty?.endTurn,
      });
    }
  }

  const own = state.factions[ownKey];
  return {
    gameId: state.gameId,
    factionKey: ownKey,
    playerRole: state.playerRole,
    playerPersonId: state.playerPersonId,
    playerPersonName: state.playerPersonName,
    date: state.date,
    season: { key: seasonOf(state.date.month), ...SEASON_LABELS[seasonOf(state.date.month)] },
    own: {
      key: ownKey,
      name: own.name,
      shortName: own.shortName,
      color: own.color,
      resources: { ...own.resources },
      nominalTroops: own.nominalTroops,
      fieldTroops: factionTroops(state, ownKey),
      statusTags: own.statusTags,
      reputation: Math.round(own.reputation),
      adminEfficiency: Math.round(own.adminEfficiency),
      stability: Math.round(own.stability),
      taxCompliance: own.taxCompliance,
      notes: own.notes,
      controlCount: ownRegions.length,
    },
    factions,
    regions,
    mapNodes,
    armies,
    diplomacy,
    special: state.special[ownKey],
    intel: state.intel,
    pendingOrders: state.pendingOrders,
    statistics: state.statistics,
    flags: state.flags,
    deceased: Object.values(state.characters ?? {})
      .filter((r) => !r.alive && ctx.charactersById[r.personId]?.faction_key === ownKey)
      .map((r) => ({
        personId: r.personId,
        name: ctx.charactersById[r.personId]?.name ?? r.personId,
        deathCause: r.deathCause,
        deathTurn: r.deathTurn,
      })),
    schemaVersion: state.schemaVersion,
  };
}

function pairKey(a: FactionKey, b: FactionKey): string {
  const order: Record<FactionKey, number> = { HUN: 0, YONG: 1, CHU: 2 };
  return [a, b].sort((x, y) => order[x] - order[y]).join('|');
}

function adjacencyNames(state: GameState): Record<string, string[]> {
  // 仅按州府邻接判断是否在边境可感知；真正的道路连通由地图边数据决定。
  const map: Record<string, string[]> = {};
  const coords = Object.values(state.regions);
  for (const a of coords) {
    map[a.regionId] = coords
      .filter((b) => b.regionId !== a.regionId && Math.hypot(b.x - a.x, b.y - a.y) < 1.55)
      .map((b) => b.regionId);
  }
  return map;
}
