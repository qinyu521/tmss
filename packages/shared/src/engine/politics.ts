import type { GameEvent, GameState } from '../types.js';
import type { DerivedContext } from '../dataset.js';
import { BALANCE } from '../balance.js';
import { emitEvent } from './events.js';
import { clamp, isCharacterAlive } from './state.js';
import { successionNetworkInfluence } from './relationships.js';

/** 三国国情机制：匈奴部落协调、大雍皇子争储、大楚世家掣肘。 */
export function runPolitics(state: GameState, ctx: DerivedContext, events: GameEvent[]): void {
  const turn = state.date.turn;
  const rng = mulberryFrom(state.seed + turn * 7919);

  const hun = state.special.HUN;
  if (hun.tribes && hun.tribes.length > 0) {
    for (const tribe of hun.tribes) {
      tribe.loyalty = clamp(tribe.loyalty - BALANCE.politics.hun.loyaltyDecay - tribe.greed / 400);
      tribe.stance =
        tribe.loyalty >= 65 ? 'eager' : tribe.loyalty >= 50 ? 'watchful' : tribe.loyalty >= 38 ? 'reluctant' : 'refusing';
      if (tribe.stance === 'refusing') {
        events.push(
          emitEvent(state, {
            type: 'politics',
            title: `匈奴·${tribe.name}拒绝听令`,
            summary: `${tribe.name}首领${tribe.chiefName}以「${tribe.demand}」为由拖延军令。该部辖下兵马不可被统一调动，直至联盟协调度恢复。`,
            actorId: tribe.chiefId,
            actorName: tribe.chiefName,
            factionKey: 'HUN',
            targetId: tribe.tribeId,
            targetLabel: tribe.name,
            after: { loyalty: Math.round(tribe.loyalty), stance: tribe.stance },
            evidence: '部落忠诚低于拒命阈值 38；协调度折减可统一调动兵力',
            visibleToPlayer: state.factionKey === 'HUN',
          }),
        );
      }
    }
    const avg = hun.tribes.reduce((s, t) => s + t.loyalty, 0) / hun.tribes.length;
    const cohesionFromLoyalty = BALANCE.politics.hun.baseCohesion + (avg - 55) * 0.7;
    // 联盟协调度可被王庭议事直接改变；部落忠诚是重要输入，但不能每旬将政治决策完全覆盖。
    const currentCohesion = hun.cohesion ?? cohesionFromLoyalty;
    hun.cohesion = clamp(currentCohesion * 0.8 + cohesionFromLoyalty * 0.2);
    const refusal = hun.tribes.some((t) => t.stance === 'refusing');
    if (refusal !== state.flags.tribalRefusal) {
      state.flags.tribalRefusal = refusal;
      events.push(
        emitEvent(state, {
          type: 'politics',
          title: refusal ? '匈奴·联盟出现拒命' : '匈奴·联盟重归号令',
          summary: refusal
            ? '若干部落公开拖延出兵；名义兵力与实际可调动兵力出现缺口。'
            : '各部重新接受王庭调遣，联盟协调度回升。',
          actorId: 'system',
          actorName: '王庭议事',
          factionKey: 'HUN',
          after: { cohesion: Math.round(hun.cohesion ?? 0), tribalRefusal: refusal },
          evidence: '部落 stance 汇总',
          visibleToPlayer: state.factionKey === 'HUN',
        }),
      );
    }
    state.factions.HUN.stability = clamp(hun.cohesion ?? 55);
    state.factions.HUN.taxCompliance = 0.5 + (hun.cohesion ?? 55) / 200;
  }

  const yong = state.special.YONG;
  if (yong.princes && yong.princes.length > 0) {
    for (const p of yong.princes) {
      const networkInfluence = state.flags.successionCrisis
        ? successionNetworkInfluence(
            ctx.seed.relationships,
            p.personId,
            (personId) => ctx.charactersById[personId]?.faction_key === 'YONG' && isCharacterAlive(state, personId),
          )
        : 0;
      p.influence = clamp(
        p.influence +
          (p.ambition - 45) / 22 -
          (p.trust - 55) / 60 +
          BALANCE.politics.yong.princeInfluenceDrift +
          networkInfluence,
      );
      p.trust = clamp(p.trust + (p.isCrownPrince ? 0.8 : -0.2) - (state.flags.successionCrisis ? 1.5 : 0));
    }
    const sorted = [...yong.princes].sort((a, b) => b.influence - a.influence);
    const top = sorted[0];
    const second = sorted[1];
    yong.courtStability = clamp(
      (yong.courtStability ?? 60) -
        Math.max(0, (top.influence - 62) / 10) +
        (Math.abs(top.influence - (second?.influence ?? 50)) < 10 ? 1.4 : 0.2),
    );
    const crisis = (yong.courtStability ?? 62) < BALANCE.politics.yong.crisisThreshold;
    if (crisis !== state.flags.successionCrisis) {
      state.flags.successionCrisis = crisis;
      events.push(
        emitEvent(state, {
          type: 'succession',
          title: crisis ? '大雍·夺嫡危机爆发' : '大雍·朝局暂稳',
          summary: crisis
            ? `${top.name}一系势力压过朝局平衡，台谏与军区开始站队。行政效率与征募能力下调。`
            : '皇帝与辅政大臣重新压住各皇子派系，朝局暂时稳定。',
          actorId: top.personId,
          actorName: top.name,
          factionKey: 'YONG',
          after: { courtStability: Math.round(yong.courtStability ?? 0), topInfluence: Math.round(top.influence) },
          evidence: '朝局稳定低于 34 触发夺嫡危机',
          visibleToPlayer: state.factionKey === 'YONG',
        }),
      );
    }
    state.factions.YONG.stability = clamp(yong.courtStability ?? 60);
    state.factions.YONG.adminEfficiency = clamp(
      (state.flags.successionCrisis ? 52 : 76) * 0.9 + (yong.courtStability ?? 60) / 12,
    );
  }

  const chu = state.special.CHU;
  if (chu.houses && chu.houses.length > 0) {
    for (const h of chu.houses) {
      h.support = clamp(h.support - 0.35);
      h.taxCompliance = Math.round((0.6 + h.support / 250) * 100) / 100;
      h.privateForce = Math.round(3_000 + h.support * BALANCE.politics.chu.privateForcePerSupport);
    }
    const averageHouseSupport = chu.houses.reduce((sum, house) => sum + house.support, 0) / chu.houses.length;
    // 中枢权威是独立政治资本，不应每旬被世家平均支持度直接覆盖；支持度变化以 20% 权重缓慢传导。
    const currentAuthority = chu.centralAuthority ?? averageHouseSupport;
    chu.centralAuthority = Math.round(clamp(currentAuthority * 0.8 + averageHouseSupport * 0.2));
    // 世家平均支持跌破阈值会直接触发集体抵制；中枢权威另作独立政治资本缓慢演变。
    const boycott = averageHouseSupport < BALANCE.politics.chu.boycottThreshold ||
      (chu.centralAuthority ?? 55) < BALANCE.politics.chu.boycottThreshold;
    if (boycott !== state.flags.houseBoycott) {
      state.flags.houseBoycott = boycott;
      events.push(
        emitEvent(state, {
          type: 'politics',
          title: boycott ? '大楚·世家集体抵制' : '大楚·世家复归合作',
          summary: boycott
            ? '数家世族联合拖延税赋与征兵，地方官员消极执行。中央税收与征募效率下降。'
            : '经过协商，世家恢复输粮纳税，地方行政重新运转。',
          actorId: 'system',
          actorName: '尚书省',
          factionKey: 'CHU',
          after: { centralAuthority: chu.centralAuthority, houseBoycott: boycott },
          evidence: '世家平均支持度低于 38',
          visibleToPlayer: state.factionKey === 'CHU',
        }),
      );
    }
    state.factions.CHU.stability = clamp(chu.centralAuthority ?? 55);
    state.factions.CHU.taxCompliance = Math.round(
      (0.6 + (chu.centralAuthority ?? 55) / 250) * 100,
    ) / 100;
  }

  // 每个势力每两回合产生一次可读的政治动向，给情报与史官提供素材。
  if (turn % 2 === 0) {
    for (const key of ['HUN', 'YONG', 'CHU'] as const) {
      const roll = rng();
      const visible = state.factionKey === key;
      if (key === 'HUN' && hun.tribes) {
        const tribe = hun.tribes[Math.floor(roll * hun.tribes.length) % hun.tribes.length];
        events.push(
          emitEvent(state, {
            type: 'politics',
            title: `匈奴·${tribe.name}索要战利品`,
            summary: `${tribe.name}首领${tribe.chiefName}要求下一次出征所得优先分配，否则将保留本部骑兵。`,
            actorId: tribe.chiefId,
            actorName: tribe.chiefName,
            factionKey: 'HUN',
            targetId: tribe.tribeId,
            targetLabel: tribe.name,
            after: { demand: tribe.demand },
            evidence: '政治动向模板 + 种子随机',
            visibleToPlayer: visible,
          }),
        );
      }
      if (key === 'YONG' && yong.princes) {
        const prince = yong.princes[Math.floor(roll * yong.princes.length) % yong.princes.length];
        events.push(
          emitEvent(state, {
            type: 'politics',
            title: `大雍·${prince.name}宴请勋贵`,
            summary: `${prince.name}在府中宴请勋贵与军区使者，影响力继续累积（当前 ${Math.round(prince.influence)}）。`,
            actorId: prince.personId,
            actorName: prince.name,
            factionKey: 'YONG',
            targetId: prince.personId,
            targetLabel: prince.name,
            after: { influence: Math.round(prince.influence) },
            evidence: '政治动向模板 + 种子随机',
            visibleToPlayer: visible,
          }),
        );
      }
      if (key === 'CHU' && chu.houses) {
        const house = chu.houses[Math.floor(roll * chu.houses.length) % chu.houses.length];
        events.push(
          emitEvent(state, {
            type: 'politics',
            title: `大楚·${house.name}上疏请减赋`,
            summary: `${house.name}家主${house.patriarchName}以地方凋敝为由请求减赋，暗示将影响今岁输粮。`,
            actorId: house.patriarchId,
            actorName: house.patriarchName,
            factionKey: 'CHU',
            targetId: house.houseId,
            targetLabel: house.name,
            after: { support: Math.round(house.support) },
            evidence: '政治动向模板 + 种子随机',
            visibleToPlayer: visible,
          }),
        );
      }
    }
  }

  // 战后政治仇怨会在后续旬期转化为一次有代价的反击，并设冷却防止事件刷屏。
  resolvePoliticalGrudgeResponses(state, ctx, events);
}

function resolvePoliticalGrudgeResponses(
  state: GameState,
  ctx: DerivedContext,
  events: GameEvent[],
): void {
  const turn = state.date.turn;
  for (const [actorId, actorRuntime] of Object.entries(state.characters)) {
    const actor = ctx.charactersById[actorId];
    if (!actor || !actorRuntime.alive || !actorRuntime.politicalGrudges) continue;
    const grudges = { ...actorRuntime.politicalGrudges };
    const nextResponses = { ...(actorRuntime.politicalGrudgeNextResponseTurn ?? {}) };
    const candidates = Object.entries(grudges)
      .filter(([targetId, score]) => {
        const target = ctx.charactersById[targetId];
        return score >= 10 &&
          !!target &&
          target.faction_key === actor.faction_key &&
          (nextResponses[targetId] ?? Number.POSITIVE_INFINITY) <= turn &&
          isCharacterAlive(state, targetId);
      })
      .sort(([idA, scoreA], [idB, scoreB]) => scoreB - scoreA || idA.localeCompare(idB));
    const candidate = candidates[0];
    if (!candidate) continue;

    const [targetId, scoreBefore] = candidate;
    const target = ctx.charactersById[targetId];
    if (!target) continue;
    const before: Record<string, unknown> = { grudge: scoreBefore };
    let effect = '';
    if (actor.faction_key === 'YONG') {
      const prince = (state.special.YONG.princes ?? []).find((item) => item.personId === targetId);
      if (prince) {
        before.influence = Math.round(prince.influence * 100) / 100;
        prince.influence = clamp(prince.influence - 2);
        state.special.YONG.courtStability = clamp((state.special.YONG.courtStability ?? 50) - 1);
        effect = `其影响力下降 2，朝局稳定下降 1。`;
      }
    } else if (actor.faction_key === 'HUN') {
      const tribe = (state.special.HUN.tribes ?? []).find((item) => item.chiefId === targetId);
      if (tribe) {
        before.loyalty = Math.round(tribe.loyalty * 100) / 100;
        tribe.loyalty = clamp(tribe.loyalty - 2);
        state.special.HUN.cohesion = clamp((state.special.HUN.cohesion ?? 50) - 1);
        effect = `其部落忠诚下降 2，联盟协调度下降 1。`;
      }
    } else if (actor.faction_key === 'CHU') {
      const house = (state.special.CHU.houses ?? []).find((item) => item.patriarchId === targetId);
      if (house) {
        before.support = Math.round(house.support * 100) / 100;
        house.support = clamp(house.support - 2);
        state.special.CHU.centralAuthority = clamp((state.special.CHU.centralAuthority ?? 50) + 1);
        effect = `该世家支持下降 2，中枢权威上升 1。`;
      }
    }
    if (!effect) {
      const targetRuntime = state.characters[targetId] ?? {
        personId: targetId,
        alive: true,
        ageBand: target.age_band,
      };
      before.courtStanding = targetRuntime.courtStanding ?? 50;
      targetRuntime.courtStanding = clamp((targetRuntime.courtStanding ?? 50) - 2);
      state.characters[targetId] = targetRuntime;
      effect = `其在朝声望下降 2。`;
    }

    // 反击会消耗一部分积怨；仍然强烈的仇怨最早四旬后再升级一次。
    const scoreAfter = Math.max(0, scoreBefore - 3);
    grudges[targetId] = scoreAfter;
    nextResponses[targetId] = turn + 4;
    actorRuntime.politicalGrudges = grudges;
    actorRuntime.politicalGrudgeNextResponseTurn = nextResponses;
    state.characters[actorId] = actorRuntime;

    events.push(emitEvent(state, {
      type: 'politics',
      title: actor.faction_key === 'YONG'
        ? `大雍·旧怨翻涌·${actor.name}向${target.name}发难`
        : actor.faction_key === 'HUN'
          ? `匈奴·旧怨牵动部落·${actor.name}向${target.name}发难`
          : `大楚·旧怨引发朝争·${actor.name}向${target.name}发难`,
      summary: `${actor.name}因战后裁决对${target.name}积怨已久，终于在本旬发动政治反击；${effect}仇怨由 ${scoreBefore} 降至 ${scoreAfter}，若仍未化解，至少四旬后才可能再次升级。`,
      actorId,
      actorName: actor.name,
      factionKey: actor.faction_key,
      targetId,
      targetLabel: target.name,
      before,
      after: { ...before, grudge: scoreAfter, nextResponseTurn: turn + 4 },
      evidence: '战后裁决留下的显式人物仇怨达到 10；每名人物每旬最多反击一次，反击后设四旬冷却并消耗 3 点仇怨',
      source: 'npc_ai',
      visibleToPlayer: state.factionKey === actor.faction_key,
    }));
  }
}

function mulberryFrom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
