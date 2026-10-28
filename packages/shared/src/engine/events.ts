import type { FactionKey, GameEvent, GameEventType, GameState } from '../types.js';

export interface EventInput {
  type: GameEventType;
  title: string;
  summary: string;
  actorId?: string;
  actorName?: string;
  factionKey?: FactionKey | 'NEUTRAL';
  targetId?: string;
  targetLabel?: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  source?: GameEvent['source'];
  evidence?: string;
  payload?: Record<string, unknown>;
  visibleToPlayer?: boolean;
  turn?: number;
  dateLabel?: string;
}

/** 每个状态变化都必须调用此函数，保证 event_id 唯一、可追溯。 */
export function emitEvent(state: GameState, input: EventInput): GameEvent {
  const seq = state.nextEventSeq++;
  const turn = input.turn ?? state.date.turn;
  const event: GameEvent = {
    eventId: `evt-${state.gameId}-T${turn}-${String(seq).padStart(4, '0')}`,
    gameId: state.gameId,
    turn,
    dateLabel: input.dateLabel ?? state.date.label,
    type: input.type,
    actorId: input.actorId ?? state.playerPersonId,
    actorName: input.actorName ?? state.playerPersonName,
    factionKey: input.factionKey ?? state.factionKey,
    targetId: input.targetId ?? '',
    targetLabel: input.targetLabel ?? '',
    title: input.title,
    summary: input.summary,
    before: input.before,
    after: input.after,
    source: input.source ?? 'engine',
    evidence: input.evidence ?? '规则引擎结算',
    visibleToPlayer: input.visibleToPlayer ?? true,
    payload: input.payload,
  };
  return event;
}

export function eventVisibleToPlayer(event: GameEvent, state: GameState): boolean {
  if (event.visibleToPlayer) return true;
  return event.factionKey === state.factionKey;
}
