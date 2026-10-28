import type { CharacterSeed, GameEvent, GameState } from '../types.js';
import type { DerivedContext } from '../dataset.js';
import { hashString, mulberry32 } from '../dataset.js';
import { BALANCE } from '../balance.js';
import { FACTION_SHORT } from '../constants.js';
import { emitEvent } from './events.js';
import { clamp, isCharacterAlive } from './state.js';

/**
 * 人物生命周期：每回合一次（在政治机制之后结算）。
 * - 死亡掷骰使用确定性 mulberry32(hashString(`${seed}-life-${turn}`))，可重放；
 * - 死亡只由本模块产生，每次死亡生成唯一 succession 事件（含前后状态与证据）；
 * - 继承在本模块内立即完成：州府主官/部队主将/部落首领/世家家主/皇子/玩家人物。
 */
export function runLifecycle(state: GameState, ctx: DerivedContext, events: GameEvent[]): void {
  const turn = state.date.turn;
  const rng = mulberry32(hashString(`${state.seed}-life-${turn}`));
  const L = BALANCE.lifecycle;
  // 本旬参战的部队主将（战斗在行军阶段已结算，lastBattleTurn 由 battle 流程写入）
  const battledCommanders = new Set(
    state.armies.filter((a) => a.lastBattleTurn === turn).map((a) => a.commanderId),
  );

  for (const char of ctx.seed.characters) {
    const rt = state.characters[char.person_id];
    if (rt && !rt.alive) continue;
    const band = rt?.ageBand ?? char.age_band;
    let p = L.mortalityPerTurn[band] ?? L.defaultMortality;
    const inBattle = battledCommanders.has(char.person_id);
    if (inBattle) p += L.battleDeathBonus;
    if (rng() >= p) continue;
    const cause = inBattle ? '战死' : band === '老成' ? '寿终' : band === '中年' ? '病逝' : '暴卒';
    applyDeath(state, ctx, events, char, cause);
  }

  runGrowth(state, ctx);
}

/**
 * 让一名人物死亡并完成全部继承结算（导出供测试直接驱动继承逻辑）。
 * 幂等保护：已死亡人物不会重复结算。
 */
export function applyDeath(
  state: GameState,
  ctx: DerivedContext,
  events: GameEvent[],
  char: CharacterSeed,
  cause: string,
): void {
  const turn = state.date.turn;
  const rt = ensureRuntime(state, char);
  if (!rt.alive) return;
  rt.alive = false;
  rt.deathTurn = turn;
  rt.deathCause = cause;

  const notes: string[] = [];
  const successors: Record<string, string> = {};
  const roles: string[] = [];
  // 君主不一定兼任州府/军区职位，单独标记以保证讣闻规格
  if (char.identity_type === '君主') roles.push('君主');

  succeedRegions(state, ctx, char, notes, successors, roles);
  succeedArmies(state, ctx, char, notes, successors, roles);
  succeedTribe(state, ctx, char, notes, successors, roles);
  succeedHouse(state, ctx, char, notes, successors, roles);
  succeedPrince(state, char, notes, roles);
  succeedPlayer(state, ctx, char, notes, roles);

  const important = roles.length > 0;
  events.push(
    emitEvent(state, {
      type: 'succession',
      title: `${FACTION_SHORT[char.faction_key]}·${char.name}${cause}`,
      summary:
        `${char.name}（${char.identity_type}，${rt.ageBand}）于${state.date.label}${cause}。` +
        (notes.length > 0 ? notes.join('；') : '身后无在职权责，无需更动。'),
      actorId: char.person_id,
      actorName: char.name,
      factionKey: char.faction_key,
      targetId: char.person_id,
      targetLabel: char.name,
      before: { alive: true, ageBand: rt.ageBand },
      after: { alive: false, cause, successors },
      payload: { lifecycle: true, important, cause, ageBand: rt.ageBand, roles },
      evidence: `生命周期结算：年龄段基础概率 + 参战加成；随机种子 ${state.seed}-life-${turn}，可重放`,
      source: 'engine',
      visibleToPlayer: char.faction_key === state.factionKey,
    }),
  );
}

/** 州府主官身故：种子副手优先，其次同势力在世且未主政他州者中治理最高者。 */
function succeedRegions(
  state: GameState,
  ctx: DerivedContext,
  char: CharacterSeed,
  notes: string[],
  successors: Record<string, string>,
  roles: string[],
): void {
  for (const region of Object.values(state.regions)) {
    if (region.governorId !== char.person_id) continue;
    roles.push('州府主官');
    const terr = ctx.territories.find((t) => t.region_id === region.regionId);
    const deputy = terr?.deputy_id ? ctx.charactersById[terr.deputy_id] : undefined;
    let successor: CharacterSeed | undefined;
    if (deputy && deputy.faction_key === region.faction && isCharacterAlive(state, deputy.person_id)) {
      successor = deputy;
    } else {
      successor = ctx.seed.characters
        .filter(
          (c) =>
            c.faction_key === region.faction &&
            isCharacterAlive(state, c.person_id) &&
            !Object.values(state.regions).some((r) => r.governorId === c.person_id),
        )
        .sort((a, b) => b.governance - a.governance)[0];
    }
    if (!successor) continue;
    const old = region.governorName;
    region.governorId = successor.person_id;
    region.governorName = successor.name;
    successors[`region:${region.regionId}`] = successor.name;
    notes.push(`${region.name}主官由${successor.name}接任（原任${old}）`);
  }
}

/** 部队主将身故：军区副将优先，其次同势力在世且未统军者中统率最高者；士气受挫。 */
function succeedArmies(
  state: GameState,
  ctx: DerivedContext,
  char: CharacterSeed,
  notes: string[],
  successors: Record<string, string>,
  roles: string[],
): void {
  for (const army of state.armies) {
    if (army.commanderId !== char.person_id) continue;
    roles.push('部队主将');
    const district = ctx.seed.military_districts.find((d) => d.district_id === army.districtId);
    const deputy = district?.deputy_id ? ctx.charactersById[district.deputy_id] : undefined;
    let successor: CharacterSeed | undefined;
    if (deputy && deputy.faction_key === army.faction && isCharacterAlive(state, deputy.person_id)) {
      successor = deputy;
    } else {
      successor = ctx.seed.characters
        .filter(
          (c) =>
            c.faction_key === army.faction &&
            isCharacterAlive(state, c.person_id) &&
            !state.armies.some((a) => a.commanderId === c.person_id),
        )
        .sort((a, b) => b.command - a.command)[0];
    }
    if (!successor) continue;
    const old = army.commanderName;
    army.commanderId = successor.person_id;
    army.commanderName = successor.name;
    army.morale = clamp(army.morale - BALANCE.lifecycle.armyMoraleLossOnCommanderDeath);
    successors[`army:${army.armyId}`] = successor.name;
    notes.push(`${army.name}由${successor.name}接统（故帅${old}），军中士气受挫`);
  }
}

/** 匈奴部落首领身故：种子该部继承人接任，忠诚震荡。 */
function succeedTribe(
  state: GameState,
  ctx: DerivedContext,
  char: CharacterSeed,
  notes: string[],
  successors: Record<string, string>,
  roles: string[],
): void {
  const tribes = state.special.HUN.tribes ?? [];
  for (const tribe of tribes) {
    if (tribe.chiefId !== char.person_id) continue;
    roles.push('部落首领');
    const house = ctx.seed.houses.find((h) => h.house_id === tribe.tribeId);
    const heir = house?.heir_id ? ctx.charactersById[house.heir_id] : undefined;
    const successor =
      heir && isCharacterAlive(state, heir.person_id)
        ? heir
        : ctx.seed.characters
            .filter((c) => c.faction_key === 'HUN' && isCharacterAlive(state, c.person_id))
            .sort((a, b) => b.governance - a.governance)[0];
    if (!successor) continue;
    tribe.chiefId = successor.person_id;
    tribe.chiefName = successor.name;
    tribe.loyalty = clamp(tribe.loyalty - BALANCE.lifecycle.tribeLoyaltyLossOnChiefDeath);
    successors[`tribe:${tribe.tribeId}`] = successor.name;
    notes.push(`${tribe.name}首领之位由${successor.name}继承，部众观望，忠诚下降`);
  }
}

/** 大楚世家家主身故：种子继承人接任，支持度震荡。 */
function succeedHouse(
  state: GameState,
  ctx: DerivedContext,
  char: CharacterSeed,
  notes: string[],
  successors: Record<string, string>,
  roles: string[],
): void {
  const houses = state.special.CHU.houses ?? [];
  for (const house of houses) {
    if (house.patriarchId !== char.person_id) continue;
    roles.push('世家家主');
    const houseSeed = ctx.seed.houses.find((h) => h.house_id === house.houseId);
    const heir = houseSeed?.heir_id ? ctx.charactersById[houseSeed.heir_id] : undefined;
    const successor =
      heir && isCharacterAlive(state, heir.person_id)
        ? heir
        : ctx.seed.characters
            .filter((c) => c.faction_key === 'CHU' && isCharacterAlive(state, c.person_id))
            .sort((a, b) => b.governance - a.governance)[0];
    if (!successor) continue;
    house.patriarchId = successor.person_id;
    house.patriarchName = successor.name;
    house.support = clamp(house.support - BALANCE.lifecycle.houseSupportLossOnPatriarchDeath);
    successors[`house:${house.houseId}`] = successor.name;
    notes.push(`${house.name}家主之位由${successor.name}继承，支持度下降`);
  }
}

/** 大雍皇子身故：退出派系序列，影响力由其余皇子分摊，朝局受冲击。 */
function succeedPrince(state: GameState, char: CharacterSeed, notes: string[], roles: string[]): void {
  const yong = state.special.YONG;
  const prince = (yong.princes ?? []).find((p) => p.personId === char.person_id);
  if (!prince) return;
  roles.push(char.identity_type === '储君' ? '储君' : '皇子');
  yong.princes = (yong.princes ?? []).filter((p) => p.personId !== char.person_id);
  const rest = yong.princes;
  if (rest.length > 0) {
    const share = prince.influence / rest.length;
    for (const p of rest) p.influence = clamp(p.influence + share);
    // 储君亡故则由剩余影响力最高者继为储君
    if (prince.isCrownPrince) {
      const top = [...rest].sort((a, b) => b.influence - a.influence)[0];
      top.isCrownPrince = true;
      notes.push(`${top.name}继为储君，诸皇子影响力重排`);
    } else {
      notes.push('诸皇子影响力重排');
    }
  }
  yong.courtStability = clamp(
    (yong.courtStability ?? 60) - BALANCE.lifecycle.courtStabilityLossOnPrinceDeath,
  );
}

/** 玩家人物身故：身份转交同势力在世继任者，玩家不进入「死人视角」。 */
function succeedPlayer(
  state: GameState,
  ctx: DerivedContext,
  char: CharacterSeed,
  notes: string[],
  roles: string[],
): void {
  if (state.playerPersonId !== char.person_id) return;
  roles.push('玩家人物');
  const alive = ctx.seed.characters.filter(
    (c) => c.faction_key === char.faction_key && isCharacterAlive(state, c.person_id),
  );
  let successor: CharacterSeed | undefined;
  if (state.playerRole === 'ruler') {
    // 君主：储君优先，其次治理最高者
    const crown = (state.special[char.faction_key].princes ?? []).find(
      (p) => p.isCrownPrince && isCharacterAlive(state, p.personId),
    );
    successor =
      (crown ? alive.find((c) => c.person_id === crown.personId) : undefined) ??
      [...alive].sort((a, b) => b.governance - a.governance)[0];
  } else {
    // 其他身份：同身份类型优先，其次潜力最高者（身份最接近者）
    successor =
      alive
        .filter((c) => c.identity_type === char.identity_type)
        .sort((a, b) => b.potential - a.potential)[0] ??
      [...alive].sort((a, b) => b.potential - a.potential)[0];
  }
  if (!successor) return;
  const old = state.playerPersonName;
  state.playerPersonId = successor.person_id;
  state.playerPersonName = successor.name;
  notes.push(`你所扮演的${old}已故，身份由${successor.name}承继（身份不变）`);
}

/** 成长：每年（每 growthIntervalTurns 旬）高潜力在世人物主属性 +1，仅写入运行时记录。 */
function runGrowth(state: GameState, ctx: DerivedContext): void {
  const L = BALANCE.lifecycle;
  if (state.date.turn % L.growthIntervalTurns !== 0) return;
  for (const char of ctx.seed.characters) {
    if (char.potential < L.growthMinPotential) continue;
    if (!isCharacterAlive(state, char.person_id)) continue;
    const rt = ensureRuntime(state, char);
    const keys = ['governance', 'command', 'strategy', 'intrigue', 'commerce'] as const;
    const valueOf = (k: (typeof keys)[number]) => rt.attrs?.[k] ?? char[k];
    // 主属性 = 当前最高项
    const top = [...keys].sort((a, b) => valueOf(b) - valueOf(a))[0];
    if (valueOf(top) >= L.growthCap) continue;
    rt.attrs = { ...rt.attrs, [top]: valueOf(top) + 1 };
    rt.growthNote = `${state.date.label}：历练增进，${ATTR_LABEL[top]}升至 ${rt.attrs[top]}`;
  }
}

const ATTR_LABEL = {
  governance: '治理',
  command: '统率',
  strategy: '谋略',
  intrigue: '权谋',
  commerce: '经商',
} as const;

function ensureRuntime(state: GameState, char: CharacterSeed) {
  if (!state.characters) state.characters = {};
  if (!state.characters[char.person_id]) {
    state.characters[char.person_id] = { personId: char.person_id, alive: true, ageBand: char.age_band, courtStanding: 50 };
  }
  return state.characters[char.person_id];
}
