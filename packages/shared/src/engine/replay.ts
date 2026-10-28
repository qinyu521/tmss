/**
 * 战报回放：把已结算的 battle 事件确定性展开为分阶段脚本。
 * 回放不是重新结算——伤亡总数、胜负完全来自事件的 before/after；
 * 只有阶段划分与文案由 mulberry32(payload.seed) 程序化生成，同一事件结果永远相同。
 */
import type { FactionKey, GameEvent } from '../types.js';
import { mulberry32 } from '../dataset.js';

export type ReplayStageKey = 'diversion' | 'engage' | 'ambush' | 'maneuver' | 'grind' | 'decisive';

export interface BattleReplayStage {
  index: number;
  key: ReplayStageKey;
  /** 阶段名，如 接战 / 相持 / 决胜 */
  name: string;
  /** 本阶段攻方损失 */
  attackerLosses: number;
  /** 本阶段守方损失（含州兵） */
  defenderLosses: number;
  /** 阶段结束时攻方剩余兵力 */
  attackerTroops: number;
  /** 阶段结束时守方剩余兵力 */
  defenderTroops: number;
  attackerMorale: number;
  defenderMorale: number;
  /** 关键转折文字 */
  text: string;
}

export interface ReplayCommander {
  id: string;
  name: string;
  command: number;
  strategy: number;
}

export interface BattleReplay {
  eventId: string;
  seed: number;
  regionName: string;
  terrain: string;
  terrainLabel: string;
  fort: number;
  attackerWon: boolean;
  attackerFaction: FactionKey;
  defenderFaction: FactionKey;
  attackerName: string;
  defenderName: string;
  attackerCommander?: ReplayCommander;
  defenderCommander?: ReplayCommander;
  initialAttackerTroops: number;
  initialDefenderTroops: number;
  finalAttackerTroops: number;
  finalDefenderTroops: number;
  stages: BattleReplayStage[];
}

const TERRAIN_LABELS: Record<string, string> = {
  plain: '平原',
  hill: '丘陵',
  mountain: '山地',
  forest: '密林',
  river: '河网',
};

const STAGE_NAMES: Record<ReplayStageKey, string> = {
  diversion: '佯攻',
  engage: '接战',
  ambush: '伏兵',
  maneuver: '迂回',
  grind: '相持',
  decisive: '决胜',
};

/** 各阶段分摊伤亡的基础权重（决胜最重，佯攻最轻） */
const STAGE_WEIGHTS: Record<ReplayStageKey, number> = {
  diversion: 0.35,
  engage: 0.9,
  ambush: 1.25,
  maneuver: 1.05,
  grind: 0.7,
  decisive: 1.7,
};

const clampMorale = (v: number) => Math.max(5, Math.min(95, Math.round(v)));

function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function commanderOf(v: unknown): ReplayCommander | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const c = v as Record<string, unknown>;
  if (typeof c.id !== 'string' || typeof c.name !== 'string') return undefined;
  return { id: c.id, name: c.name, command: num(c.command), strategy: num(c.strategy) };
}

/** 按权重把总伤亡摊到各阶段；累计取整保证单调，末阶段精确等于总结算结果。 */
function distributeLosses(total: number, plan: ReplayStageKey[], rng: () => number): number[] {
  const weights = plan.map((k) => STAGE_WEIGHTS[k] * (0.6 + rng() * 0.8));
  const sum = weights.reduce((s, w) => s + w, 0);
  let acc = 0;
  let prev = 0;
  return weights.map((w, i) => {
    acc += w;
    const cum = i === weights.length - 1 ? total : Math.round((total * acc) / sum);
    const stage = cum - prev;
    prev = cum;
    return stage;
  });
}

function pick<T>(rng: () => number, items: T[]): T {
  return items[Math.floor(rng() * items.length) % items.length];
}

/**
 * 由一条 type='battle' 的 GameEvent 构建确定性回放脚本。
 * 事件非战斗或缺少结算数据时抛出错误（API 层已先行校验类型）。
 */
export function buildBattleReplay(event: GameEvent): BattleReplay {
  if (event.type !== 'battle') {
    throw new Error(`NOT_BATTLE_EVENT: ${event.type}`);
  }
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const before = (event.before ?? {}) as Record<string, unknown>;
  const after = (event.after ?? {}) as Record<string, unknown>;

  const seed = num(payload.seed);
  const terrain = typeof payload.terrain === 'string' ? payload.terrain : 'plain';
  const fort = num(payload.fort);
  const maneuverBonus = num(payload.maneuverBonus);
  const ambushBonus = num(payload.ambushBonus);
  const diversionBonus = num(payload.diversionBonus);

  const initialAttacker = Math.max(0, Math.round(num(before.attackerTroops)));
  const initialDefender = Math.max(0, Math.round(num(before.defenderTroops)));
  const finalAttacker = Math.max(0, Math.round(num(after.attackerRemaining)));
  const finalDefender = Math.max(0, Math.round(num(after.defenderRemaining)));
  const attackerWon = after.attackerWon === true;

  // 攻方军团名取自事件标题模板「{军团}战于{州府}」；兜底用统兵官所部
  const titleMatch = /^(.+?)战于(.+)$/.exec(event.title ?? '');
  const attackerName = titleMatch?.[1] ?? `${event.actorName}所部`;
  const regionName = (typeof before.region === 'string' && before.region) || titleMatch?.[2] || event.targetLabel || '战场';
  const defenderName = typeof payload.defenderArmy === 'string' && payload.defenderArmy ? payload.defenderArmy : '州兵';
  const attackerCommander = commanderOf(payload.attackerCommander);
  const defenderCommander = commanderOf(payload.defenderCommander);
  const atkCmdName = attackerCommander?.name ?? event.actorName;
  const defCmdName = defenderCommander?.name ?? '州兵守将';
  const terrainLabel = TERRAIN_LABELS[terrain] ?? '旷野';

  // 阶段编排：佯攻先于接战，伏兵在接战之后，迂回居中，相持兜底，决胜收尾（3-6 阶段）
  const plan: ReplayStageKey[] = [];
  if (diversionBonus > 0) plan.push('diversion');
  plan.push('engage');
  if (ambushBonus > 0) plan.push('ambush');
  if (maneuverBonus > 0) plan.push('maneuver');
  plan.push('grind');
  plan.push('decisive');

  const rng = mulberry32(seed);
  const atkLossPlan = distributeLosses(initialAttacker - finalAttacker, plan, rng);
  const defLossPlan = distributeLosses(initialDefender - finalDefender, plan, rng);

  let attackerMorale = clampMorale(70 + rng() * 8);
  let defenderMorale = clampMorale(66 + rng() * 8 + (fort >= 40 ? 3 : 0));

  const stageText = (key: ReplayStageKey, aLoss: number, dLoss: number): string => {
    const lossNote = `是合攻方损 ${aLoss.toLocaleString()}，守方损 ${dLoss.toLocaleString()}。`;
    switch (key) {
      case 'diversion':
        return pick(rng, [
          `${atkCmdName}遣偏师佯攻他处，${defCmdName}分兵驰援，正面守备为之一虚。${lossNote}`,
          `攻方佯攻他路，擂鼓扬尘作大举状，守军判断失误，预备队被调离主战场。${lossNote}`,
        ]);
      case 'engage':
        return pick(rng, [
          `两军于${regionName}外的${terrainLabel}列阵相接，${attackerName}先锋直逼阵前，${defenderName}凭垒固守。${lossNote}`,
          `${attackerName}渡壕叩阵，${defenderName}以弓弩还击，${terrainLabel}上箭如飞蝗。${lossNote}`,
        ]);
      case 'ambush':
        return pick(rng, [
          `守军伏兵自${terrain === 'forest' ? '林间' : terrain === 'mountain' ? '山口' : '阵后'}杀出，攻方前锋大乱，血流盈壕。${lossNote}`,
          `伏兵发动。攻方侧翼骤遭夹击，${atkCmdName}急令收束队形，死伤甚众。${lossNote}`,
        ]);
      case 'maneuver':
        return pick(rng, [
          `${atkCmdName}亲率精骑迂回守军侧翼，${defenderName}阵脚松动，号令渐乱。${lossNote}`,
          `骑兵迂回奏效：攻方铁骑绕出${terrainLabel}，直插守军背后，前后受敌。${lossNote}`,
        ]);
      case 'grind':
        return pick(rng, [
          `两军相持，尸相枕藉，鼓声渐哑，双方皆在硬撑。${lossNote}`,
          `战线犬牙交错，攻守数易其手；${atkCmdName}与${defCmdName}各自督战不前。${lossNote}`,
        ]);
      case 'decisive':
        return attackerWon
          ? pick(rng, [
              `决胜时刻：${attackerName}破阵而入，${defenderName}溃不成军，${regionName}守势瓦解。${lossNote}`,
              `${atkCmdName}麾军直捣中坚，守军全线崩溃，${regionName}易帜在即。${lossNote}`,
            ])
          : pick(rng, [
              `决胜时刻：${attackerName}攻势衰竭，${defenderName}反击得手，攻方败退。${lossNote}`,
              `${atkCmdName}久攻不下，士卒离心，只得鸣金收兵；${regionName}仍在守军之手。${lossNote}`,
            ]);
    }
  };

  const stages: BattleReplayStage[] = plan.map((key, index) => {
    const attackerLosses = atkLossPlan[index];
    const defenderLosses = defLossPlan[index];
    const attackerTroops = index === plan.length - 1 ? finalAttacker : initialAttacker - atkLossPlan.slice(0, index + 1).reduce((s, v) => s + v, 0);
    const defenderTroops = index === plan.length - 1 ? finalDefender : initialDefender - defLossPlan.slice(0, index + 1).reduce((s, v) => s + v, 0);

    // 士气变化：特殊阶段倾向对应方；其余按本阶段相对损耗定优劣
    if (key === 'ambush') {
      attackerMorale = clampMorale(attackerMorale - 6 - rng() * 3);
      defenderMorale = clampMorale(defenderMorale + 4);
    } else if (key === 'maneuver' || key === 'diversion') {
      attackerMorale = clampMorale(attackerMorale + 4);
      defenderMorale = clampMorale(defenderMorale - 4 - rng() * 3);
    } else if (key !== 'decisive') {
      const prevA = index === 0 ? initialAttacker : stagesPrev(attackerTroops, attackerLosses);
      const prevD = index === 0 ? initialDefender : stagesPrev(defenderTroops, defenderLosses);
      const aRate = attackerLosses / Math.max(1, prevA);
      const dRate = defenderLosses / Math.max(1, prevD);
      if (aRate <= dRate) {
        attackerMorale = clampMorale(attackerMorale + 1 + rng() * 2);
        defenderMorale = clampMorale(defenderMorale - 3 - rng() * 3);
      } else {
        attackerMorale = clampMorale(attackerMorale - 3 - rng() * 3);
        defenderMorale = clampMorale(defenderMorale + 1 + rng() * 2);
      }
    } else {
      // 决胜：胜者士气回升，败者崩盘
      if (attackerWon) {
        attackerMorale = clampMorale(62 + rng() * 10);
        defenderMorale = clampMorale(6 + rng() * 8);
      } else {
        attackerMorale = clampMorale(8 + rng() * 8);
        defenderMorale = clampMorale(60 + rng() * 10);
      }
    }

    return {
      index,
      key,
      name: STAGE_NAMES[key],
      attackerLosses,
      defenderLosses,
      attackerTroops,
      defenderTroops,
      attackerMorale,
      defenderMorale,
      text: stageText(key, attackerLosses, defenderLosses),
    };
  });

  return {
    eventId: event.eventId,
    seed,
    regionName,
    terrain,
    terrainLabel,
    fort,
    attackerWon,
    attackerFaction: event.factionKey as FactionKey,
    defenderFaction: (payload.defenderFaction as FactionKey) ?? ('NEUTRAL' as FactionKey),
    attackerName,
    defenderName,
    attackerCommander,
    defenderCommander,
    initialAttackerTroops: initialAttacker,
    initialDefenderTroops: initialDefender,
    finalAttackerTroops: finalAttacker,
    finalDefenderTroops: finalDefender,
    stages,
  };
}

function stagesPrev(current: number, losses: number): number {
  return current + losses;
}
