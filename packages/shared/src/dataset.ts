import type {
  Army,
  CharacterSeed,
  FactionKey,
  FactionSeed,
  ForceAllocationSeed,
  HouseSeed,
  MapEdgeSeed,
  MilitaryDistrictSeed,
  RegionState,
  SeedRoster,
  TerritorySeed,
  WarlordSeed,
} from './types.js';
import { FACTION_KEYS } from './types.js';
import { BALANCE, INITIAL_RESOURCES } from './balance.js';
import { UNIT_PROFILES } from './unitProfiles.js';

/** 确定性伪随机（同一输入永远产生同一世界，便于测试与重放） */
export function hashString(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface DerivedContext {
  seed: SeedRoster;
  factionsByKey: Record<FactionKey, FactionSeed>;
  charactersById: Record<string, CharacterSeed>;
  territories: TerritorySeed[];
  regionsByFaction: Record<FactionKey, TerritorySeed[]>;
  districtsByFaction: Record<FactionKey, MilitaryDistrictSeed[]>;
  housesByFaction: Record<FactionKey, HouseSeed[]>;
  warlordsByFaction: Record<FactionKey, WarlordSeed[]>;
  allocationsByFaction: Record<FactionKey, ForceAllocationSeed[]>;
  edges: MapEdgeSeed[];
  /** 州府 → 所属军区（用于将军权限与部队归属） */
  regionToDistrict: Record<string, string>;
  /** 派生州府经济（由关键词规则 + 势力修正得出） */
  regionEconomy: Record<string, RegionEconomy>;
}

export interface RegionEconomy {
  population: number;
  foodOutput: number;
  saltOutput: number;
  ironOutput: number;
  horseOutput: number;
  taxOutput: number;
  terrain: RegionState['terrain'];
}

const FACTION_POP_BASE: Record<FactionKey, number> = { HUN: 620_000, YONG: 1_860_000, CHU: 1_340_000 };
const FRACTION_OUTPUT_MULT: Record<
  FactionKey,
  { food: number; salt: number; iron: number; horse: number }
> = {
  HUN: { food: 1.38, salt: 0.85, iron: 0.56, horse: 4.6 },
  YONG: { food: 1.26, salt: 0.68, iron: 2.4, horse: 0.16 },
  CHU: { food: 1.22, salt: 1.95, iron: 0.6, horse: 0.2 },
};

function keywordsOf(t: TerritorySeed): string {
  return `${t.region} ${t.regional_profile} ${t.key_locations} ${t.capital_or_seat}`;
}

/** 地形由州府档案关键词推导（明确记录规则，避免随机贴图）。 */
export function deriveTerrain(text: string): RegionState['terrain'] {
  if (/山|关|岭|峡|剑门|塞/.test(text)) return 'mountain';
  if (/河|江|渡|运河|航|漕|港|海|湖泊/.test(text)) return 'river';
  if (/林|猎/.test(text)) return 'forest';
  if (/丘|坡|陇/.test(text)) return 'hill';
  return 'plain';
}

export function deriveRegionEconomy(t: TerritorySeed, factionKey: FactionKey, index: number): RegionEconomy {
  const text = keywordsOf(t);
  const terrain = deriveTerrain(text);
  const jitter = 0.92 + ((hashString(t.region_id) % 17) / 100);
  let popMod = 1;
  if (/牧|草|沙|边贸|戈壁|绿洲/.test(text)) popMod = 0.78;
  if (/农|河谷|粮|屯田|漕运/.test(text)) popMod = 1.22;
  if (/港|商|海贸|市/.test(text)) popMod = 1.08;
  if (/矿|工坊|军械/.test(text)) popMod = 0.92;
  const population = Math.round((FACTION_POP_BASE[factionKey] * popMod * jitter) / 1000) * 1000;
  const mult = FRACTION_OUTPUT_MULT[factionKey];
  const saltKw = (text.match(/盐/g) ?? []).length > 0 ? 1 : 0;
  const ironKw = (text.match(/矿|铁/g) ?? []).length > 0 ? 1 : 0;
  const smithKw = (text.match(/工坊|军械|作坊|工造/g) ?? []).length > 0 ? 1 : 0;
  const horseKw = (text.match(/牧场|马场|马市|骑|草场/g) ?? []).length > 0 ? 1 : 0;
  const foodOutput = Math.round(
    population *
      0.0065 *
      (terrain === 'river' ? 1.12 : terrain === 'mountain' ? 0.8 : 1) *
      mult.food *
      (1 + (index % 3) * 0.02),
  );
  const saltOutput = Math.round((30 + saltKw * 260) * mult.salt);
  const ironOutput = Math.round((20 + ironKw * 100 + smithKw * 40) * mult.iron);
  const horseOutput = Math.round((30 + horseKw * 420) * mult.horse);
  const taxOutput = Math.round(population * 0.016 * jitter);
  return {
    population,
    foodOutput,
    saltOutput,
    ironOutput,
    horseOutput,
    taxOutput,
    terrain,
  };
}

export function buildContext(seed: SeedRoster): DerivedContext {
  const factionsByKey = Object.fromEntries(seed.factions.map((f) => [f.key, f])) as Record<FactionKey, FactionSeed>;
  const charactersById: Record<string, CharacterSeed> = {};
  for (const c of seed.characters) charactersById[c.person_id] = c;

  const territories = [...seed.territories];
  const regionsByFaction = Object.fromEntries(
    FACTION_KEYS.map((k) => [k, territories.filter((t) => t.faction === factionsByKey[k].name)]),
  ) as Record<FactionKey, TerritorySeed[]>;

  const districtsByFaction = Object.fromEntries(
    FACTION_KEYS.map((k) => [k, seed.military_districts.filter((d) => d.faction === factionsByKey[k].name)]),
  ) as Record<FactionKey, MilitaryDistrictSeed[]>;

  const housesByFaction = Object.fromEntries(
    FACTION_KEYS.map((k) => [k, seed.houses.filter((h) => h.faction === factionsByKey[k].name)]),
  ) as Record<FactionKey, HouseSeed[]>;

  const warlordsByFaction = Object.fromEntries(
    FACTION_KEYS.map((k) => [k, seed.warlord_groups.filter((w) => w.faction === factionsByKey[k].name)]),
  ) as Record<FactionKey, WarlordSeed[]>;

  const allocationsByFaction = Object.fromEntries(
    FACTION_KEYS.map((k) => [k, seed.national_force_allocations.filter((a) => a.faction_key === k)]),
  ) as Record<FactionKey, ForceAllocationSeed[]>;

  const regionToDistrict: Record<string, string> = {};
  for (const k of FACTION_KEYS) {
    const regions = regionsByFaction[k];
    const districts = districtsByFaction[k];
    const baseOf = (d: MilitaryDistrictSeed) => districtBaseRegion(d, regions);
    districts.forEach((d) => {
      const base = baseOf(d);
      if (base) regionToDistrict[base.region_id] = d.district_id;
    });
    regions.forEach((r) => {
      if (!regionToDistrict[r.region_id]) {
        const d = districts.find((x) => baseOf(x)?.region_id === r.region_id) ?? districts[0];
        regionToDistrict[r.region_id] = d.district_id;
      }
    });
  }

  const regionEconomy: Record<string, RegionEconomy> = {};
  for (const k of FACTION_KEYS) {
    regionsByFaction[k].forEach((t, i) => {
      regionEconomy[t.region_id] = deriveRegionEconomy(t, k, i);
    });
  }

  return {
    seed,
    factionsByKey,
    charactersById,
    territories,
    regionsByFaction,
    districtsByFaction,
    housesByFaction,
    warlordsByFaction,
    allocationsByFaction,
    edges: seed.map_edges,
    regionToDistrict,
    regionEconomy,
  };
}

/**
 * 初始部队：以 18 条军区兵力分配为唯一兵员总量来源，按州府顺序部署；
 * 精锐兵种作为名册内的分遣队（不额外增加兵力），剩余为普通征集兵。
 */
/** 军区驻地：由军区名称与防区描述推导（别名表记录在本函数，便于审计）。 */
const DISTRICT_REGION_ALIASES: Record<string, string> = {
  北境军区: '河朔州',
  西陲军区: '陇右州',
  中原机动军区: '关中州',
  长江中游水军区: '荆襄州',
  两淮边防军区: '两淮州',
  吴越海防军区: '吴越州',
  巴东山地军区: '巴东州',
  岭南远征军区: '岭南州',
  京畿禁卫军区: '京畿府',
  建康禁卫军区: '建康府',
};

function districtBaseRegion(district: MilitaryDistrictSeed, regions: TerritorySeed[]): TerritorySeed | undefined {
  const alias = DISTRICT_REGION_ALIASES[district.military_district];
  if (alias) {
    const hit = regions.find((r) => r.region === alias);
    if (hit) return hit;
  }
  const text = `${district.military_district} ${district.command_area} ${district.base_region}`;
  const hits = regions.filter((r) => text.includes(r.region.replace(/[州府]$/, '')));
  if (hits.length > 0) return hits[0];
  return regions.find((r) => r.region === district.base_region);
}

export function buildInitialArmies(ctx: DerivedContext): Army[] {
  const armies: Army[] = [];
  for (const factionKey of FACTION_KEYS) {
    const regions = ctx.regionsByFaction[factionKey];
    const districts = ctx.districtsByFaction[factionKey];
    const allocations = ctx.allocationsByFaction[factionKey];
    const profiles = Object.values(UNIT_PROFILES).filter((p) => p.faction === factionKey);
    const remainingCap = new Map(profiles.map((p) => [p.unitId, p.capPerFaction]));

    districts.forEach((district, di) => {
      const allocation = allocations[di % allocations.length];
      const region = districtBaseRegion(district, regions) ?? regions[di % regions.length];
      const readiness = district.readiness;
      const baseSupply = readiness === '高' ? 90 : readiness === '中' ? 80 : 68;
      const baseTraining = readiness === '高' ? 68 : readiness === '中' ? 58 : 48;
      const baseMorale = district.loyalty_risk === '高' ? 58 : 66;

      const units: Army['units'] = [];
      let allocated = 0;
      const slots = [
        { profile: profiles[(di * 2) % profiles.length], ratio: 0.0075 },
        { profile: profiles[(di * 2 + 1) % profiles.length], ratio: 0.0045 },
      ];
      for (const slot of slots) {
        if (!slot.profile) continue;
        const remaining = remainingCap.get(slot.profile.unitId) ?? 0;
        const desired = Math.min(
          remaining,
          Math.round((allocation.initial_force_count * slot.ratio) / 100) * 100,
        );
        if (desired <= 0) continue;
        remainingCap.set(slot.profile.unitId, remaining - desired);
        units.push({
          unitId: slot.profile.unitId,
          name: slot.profile.name || slot.profile.unitId,
          category: slot.profile.category,
          count: desired,
        });
        allocated += desired;
      }
      const levies = Math.max(0, allocation.initial_force_count - allocated);
      armies.push({
        armyId: `${factionKey}-ARMY-${String(di + 1).padStart(2, '0')}`,
        faction: factionKey,
        name: `${district.military_district}军团`,
        commanderId: district.commander_id,
        commanderName: district.commander,
        districtId: district.district_id,
        nodeId: region.region_id,
        originRegionId: region.region_id,
        units,
        levies,
        troops: levies + allocated,
        morale: baseMorale,
        training: baseTraining,
        supply: baseSupply,
        fatigue: 12 + (di % 4) * 4,
        stance: 'defend',
        status: 'idle',
        path: [],
        hopCosts: [],
        targetRegionId: null,
        marchDaysTotal: 0,
        marchDaysLeft: 0,
        lastBattleTurn: null,
      });
    });
  }
  return armies;
}

export function buildRegions(ctx: DerivedContext, initial: Record<string, { grain: number }>): Record<string, RegionState> {
  const regions: Record<string, RegionState> = {};
  for (const factionKey of FACTION_KEYS) {
    const list = ctx.regionsByFaction[factionKey];
    list.forEach((t) => {
      const eco = ctx.regionEconomy[t.region_id];
      const share = list.length;
      regions[t.region_id] = {
        regionId: t.region_id,
        name: t.region,
        faction: factionKey,
        governorId: t.governor_id,
        governorName: t.governor,
        population: eco.population,
        foodStore: Math.round((initial[factionKey].grain * 0.42) / share),
        saltStore: Math.round((INITIAL_RESOURCES[factionKey].salt * 0.3) / share),
        ironStore: Math.round((INITIAL_RESOURCES[factionKey].iron * 0.3) / share),
        horseStock: Math.round((INITIAL_RESOURCES[factionKey].horses * 0.25) / share),
        order: factionKey === 'HUN' ? 58 : factionKey === 'YONG' ? 64 : 62,
        loyalty: factionKey === 'HUN' ? 55 : factionKey === 'YONG' ? 62 : 58,
        fortification: eco.terrain === 'mountain' ? 58 : eco.terrain === 'river' ? 50 : 45,
        supplyLevel: 78,
        threat: 0,
        garrison: Math.round((3000 + eco.population * 0.011) / 100) * 100,
        garrisonCommanderId: t.local_commander_id,
        garrisonCommanderName: t.local_commander,
        ambushBonus: 0,
        diversionBonus: 0,
        diversionFor: null,
        foodOutput: eco.foodOutput,
        saltOutput: eco.saltOutput,
        ironOutput: eco.ironOutput,
        horseOutput: eco.horseOutput,
        taxOutput: eco.taxOutput,
        terrain: eco.terrain,
        x: t.map_x,
        y: t.map_y,
        garrisoned: true,
      };
    });
  }
  return regions;
}

const DIPLOMACY_ORDER: Record<FactionKey, number> = { HUN: 0, YONG: 1, CHU: 2 };

export function diplomacyKey(a: FactionKey, b: FactionKey): string {
  return [a, b].sort((x, y) => DIPLOMACY_ORDER[x] - DIPLOMACY_ORDER[y]).join('|');
}

export function isAtWar(diplomacy: Record<string, number>, a: FactionKey, b: FactionKey): boolean {
  if (a === b) return false;
  return (diplomacy[diplomacyKey(a, b)] ?? 0) <= BALANCE.warThreshold;
}
