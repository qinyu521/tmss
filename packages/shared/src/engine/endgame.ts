import type { FactionKey, GameOutcome, GameState } from '../types.js';
import { FACTION_KEYS } from '../types.js';

/** 统一或覆灭判定：只在回合结算末调用，已结束的存档保持原结果。 */
export function evaluateOutcome(state: GameState): GameOutcome | null {
  if (state.outcome) return state.outcome;
  const regions = Object.values(state.regions);
  if (regions.length === 0) return null;

  for (const key of FACTION_KEYS) {
    if (regions.every((region) => region.faction === key)) {
      return {
        status: key === state.factionKey ? 'victory' : 'defeat',
        winner: key,
        reason:
          key === state.factionKey
            ? `${state.factions[key].name}尽有天下州郡，四海归一，史官奉为正统。`
            : `${state.factions[key].name}已并吞诸州，${state.factions[state.factionKey].name}社稷倾覆。`,
        turn: state.date.turn,
        dateLabel: state.date.label,
      };
    }
  }

  const playerRegions = regions.filter((region) => region.faction === state.factionKey).length;
  const playerArmies = state.armies.filter(
    (army) => army.faction === state.factionKey && army.troops > 0,
  ).length;
  if (playerRegions === 0 && playerArmies === 0) {
    const winner = FACTION_KEYS.filter((key) => key !== state.factionKey).sort(
      (a, b) => countRegions(state, b) - countRegions(state, a),
    )[0];
    return {
      status: 'defeat',
      winner,
      reason: `${state.factions[state.factionKey].name}失尽州郡与野战军，宗庙不守，社稷倾覆。`,
      turn: state.date.turn,
      dateLabel: state.date.label,
    };
  }

  return null;
}

function countRegions(state: GameState, key: FactionKey): number {
  return Object.values(state.regions).filter((region) => region.faction === key).length;
}
