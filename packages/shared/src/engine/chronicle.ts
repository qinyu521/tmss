import type { ChronicleEntry, GameEvent, GameState } from '../types.js';
import { FACTION_SHORT } from '../constants.js';

/**
 * 史官系统第一版：模板生成。
 * 规则事实层（facts）直接取自事件 summary/evidence，任何文风都不得改写。
 */
export function buildChronicle(
  state: GameState,
  events: GameEvent[],
  turn: number,
  turnLabel: string,
): ChronicleEntry[] {
  const visible = events.filter((e) => e.visibleToPlayer || e.factionKey === state.factionKey);
  const entries: ChronicleEntry[] = [];
  let seq = 0;
  const id = () => `chron-${state.gameId}-T${turn}-${String(++seq).padStart(3, '0')}`;

  // 重要人物讣闻（君主/皇子/首领/家主/主将）必录为 biography，不被 slice 截断
  const obituaries = visible
    .filter((e) => e.type === 'succession' && e.payload?.lifecycle === true && e.payload?.important === true)
    .slice(0, 3);
  for (const e of obituaries) {
    entries.push({
      entryId: id(),
      gameId: state.gameId,
      turn,
      dateLabel: turnLabel,
      kind: 'biography',
      title: `${e.targetLabel}传`,
      facts: `${e.summary}（记录依据：${e.evidence}）`,
      literary: obituaryFor(e),
      inference: inferenceFor(e),
      sourceEventIds: [e.eventId],
      generatedBy: 'template',
    });
  }

  const significant = visible
    .filter((e) =>
      ['battle', 'occupation', 'succession', 'shortage', 'politics', 'intel', 'recruit', 'diplomacy', 'scheme'].includes(e.type),
    )
    .filter((e) => !obituaries.some((o) => o.eventId === e.eventId))
    .slice(0, Math.max(0, 6 - obituaries.length));

  for (const e of significant) {
    const literary = literaryFor(e);
    const inference = inferenceFor(e);
    entries.push({
      entryId: id(),
      gameId: state.gameId,
      turn,
      dateLabel: turnLabel,
      kind: e.type === 'battle' ? 'biography' : 'annal',
      title: e.title,
      facts: `${e.summary}（记录依据：${e.evidence}）`,
      literary,
      inference,
      sourceEventIds: [e.eventId],
      generatedBy: 'template',
    });
  }

  const counts = visible.reduce<Record<string, number>>((m, e) => {
    m[e.type] = (m[e.type] ?? 0) + 1;
    return m;
  }, {});
  const battles = visible.filter((e) => e.type === 'battle');
  const casualties = battles.reduce((s, e) => s + Number((e.after as { totalLosses?: number } | undefined)?.totalLosses ?? 0), 0);
  const overviewFacts =
    `本旬共录事件 ${visible.length} 条；战斗 ${counts.battle ?? 0} 次，累计伤亡约 ${casualties.toLocaleString()} 人；` +
    `政治事件 ${(counts.politics ?? 0) + (counts.succession ?? 0)} 条；短缺 ${counts.shortage ?? 0} 次。` +
    `以上数字为规则引擎结算结果，未经文学修饰。`;
  entries.unshift({
    entryId: id(),
    gameId: state.gameId,
    turn,
    dateLabel: turnLabel,
    kind: 'annal',
    title: `${turnLabel} · 旬录`,
    facts: overviewFacts,
    inference: battles.length > 0 ? '史官按：兵事渐起，诸国边境皆须戒备。' : '史官按：此旬无大战，然粮秣、人事与朝局仍在推移。',
    sourceEventIds: visible.slice(0, 20).map((e) => e.eventId),
    generatedBy: 'template',
  });
  return entries;
}

/** 讣闻悼词（文学层模板，不改写事实） */
function obituaryFor(e: GameEvent): string {
  const p = (e.payload ?? {}) as { ageBand?: string; cause?: string };
  const cause = p.cause ?? '身故';
  const band = p.ageBand ?? '盛年';
  const battle = cause === '战死';
  return battle
    ? `${e.actorName}以${band}之躯殁于王事，马革裹尸，${e.factionKey === 'NEUTRAL' ? '天下' : '国人'}惜之。`
    : `${e.actorName}以${band}之年${cause}，闻者扼腕；盖棺定论，功过留与后人评说。`;
}

function literaryFor(e: GameEvent): string {
  const faction = e.factionKey === 'NEUTRAL' ? '诸国' : FACTION_SHORT[e.factionKey as 'HUN' | 'YONG' | 'CHU'] ?? '诸国';
  switch (e.type) {
    case 'battle':
      return `鼓角相闻，${faction}之众与敌相搏于${e.targetLabel || '边地'}。尘沙蔽日，血流沟渠，军中号令几不可辨。`;
    case 'occupation':
      return `城头易帜，${e.targetLabel || '边城'}归于${e.actorName}所部；残兵扶伤而走，市井闭户。`;
    case 'succession':
      return `宫门夜启，甲士宿卫；${e.actorName}之势渐盛，朝臣低语于廊下。`;
    case 'shortage':
      return `仓廪告匮，军中襦裤不继；马无夜草，卒有菜色。`;
    case 'politics':
      return `朝堂之上，${e.actorName}进言，众议纷然；有人称善，有人袖手。`;
    case 'intel':
      return `斥候夜行，得报于帐前；烛影摇动，主将展图而不语。`;
    case 'scheme':
      return `密使夜出，火烛忽起；一纸书信、一句流言，胜似千军。`;
    case 'recruit':
      return `县邑张榜，丁壮集于校场；父老送子，哭声与号令相杂。`;
    default:
      return `有司承令，簿册俱在；一旬之事，录于简牍。`;
  }
}

function inferenceFor(e: GameEvent): string | undefined {
  if (e.type === 'battle') {
    const ratio = (e.payload as { ratio?: number } | undefined)?.ratio;
    if (typeof ratio === 'number') {
      if (ratio > 0.62) return '史官推断：胜方兵势占优，然若补给线继续拉长，追击未必有利。';
      if (ratio < 0.54) return '史官推断：胜负在毫厘之间，双方皆已疲敝，短期难再大举。';
      return '史官推断：战局尚可延续，关键在下一旬的粮道与援军。';
    }
  }
  if (e.type === 'shortage') return '史官推断：短缺若持续，军心与地方秩序将先后受损；此非一次征发可解。';
  if (e.type === 'succession') return '史官推断：皇子派系一旦与军区合流，废立之争便不再限于宫墙之内。';
  if (e.type === 'politics') return '史官推断：此类交涉多为利益交换，承诺能否兑现取决于下一次危机。';
  return undefined;
}
