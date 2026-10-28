import type {
  BattleReplay,
  ChronicleEntry,
  GameEvent,
  Order,
  PlayerView,
} from '@tianming/shared';

const BASE = import.meta.env.VITE_API_BASE ?? '';

export interface FactionSeedLike {
  key: 'HUN' | 'YONG' | 'CHU';
  name: string;
  ruler_title: string;
  initial_force_total: number;
  initial_force_total_label: string;
  strategy?: unknown;
  economy_profile: {
    food_status: string;
    salt_status: string;
    iron_status: string;
    horse_status: string;
    relative_ratings_0_5: Record<string, number>;
  };
  strategic_doctrine: { strengths: string[]; weaknesses: string[] };
  regions: string[][];
}

export interface MapNode {
  node_id: string;
  faction: string;
  region: string;
  node_name: string;
  node_type: string;
  map_x: number;
  map_y: number;
  controller_name: string;
  local_military: string;
  resource_profile: string;
  terrain_and_risk: string;
  location_role: string;
  visibility_rule: string;
}

export interface MapEdge {
  edge_id: string;
  from_region: string;
  to_region: string;
  from_faction: string;
  to_faction: string;
  route_type: string;
  base_movement_cost: number;
  origin?: 'source' | 'derived';
}

export interface TerritorySeed {
  region_id: string;
  faction: string;
  region: string;
  capital_or_seat: string;
  regional_profile: string;
  key_locations: string;
  governor_id: string;
  governor: string;
  risk: string;
  map_x: number;
  map_y: number;
}

export interface MapData {
  nodes: MapNode[];
  edges: MapEdge[];
  territories: TerritorySeed[];
  derivedNote: string;
  factions: Record<string, { primary: string; secondary: string; mapFill: string; mapBorder: string; shortName: string }>;
}

export interface ConfigData {
  balance: Record<string, any>;
  factions: Record<string, any>;
  roles: { key: string; label: string; blurb: string }[];
  unitProfiles: Record<string, any>;
  turnDays: number;
  singlePlayer: boolean;
  llmEnabled: boolean;
  schemaVersion: number;
}

export interface CharacterSummary {
  person_id: string;
  faction_key: string;
  name: string;
  gender: string;
  age_band: string;
  identity_type: string;
  current_position_standard: string;
  region: string;
  house_or_clan: string;
  warlord_group: string;
  historical_archetype: string;
  archetype_trait: string;
  governance: number;
  command: number;
  strategy: number;
  intrigue: number;
  commerce: number;
  loyalty: number;
  status: string;
  portrait: string;
  /** 携带 gameId 查询时返回：该局生死与死因 */
  alive?: boolean;
  deathCause?: string;
  /** 本局廷议声望（0-100）；未加载运行时数据时为空 */
  courtStanding?: number;
  /** 本局军令忠诚度（0-100）；未加载运行时数据时默认为人物种子忠诚 */
  militaryLoyalty?: number;
  lastBattleTurn?: number;
  lastBattleOutcome?: 'victory' | 'defeat';
  lastBattleLossRate?: number;
  pendingBattleSettlement?: boolean;
  pendingBattleCase?: 'transfer_request' | 'impeachment';
  battlePoliticalOpponentId?: string;
}

export interface GameListItem {
  game_id: string;
  faction_key: string;
  player_role: string;
  turn: number;
  date_label: string;
  updated_at: string;
}

export interface SaveMeta {
  save_id: string;
  label: string;
  turn: number;
  date_label: string;
  autosave: number;
  created_at: string;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${url}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: 'BAD_RESPONSE', message: text.slice(0, 200) };
  }
  if (!res.ok) {
    const err = new Error(data?.message ?? `请求失败（${res.status}）`);
    (err as any).detail = data;
    throw err;
  }
  return data as T;
}

export const api = {
  health: () => request<{ ok: boolean; seedCounts: Record<string, number>; mode: string }>('/api/health'),
  config: () => request<ConfigData>('/api/config'),
  map: () => request<MapData>('/api/map'),
  factions: () => request<FactionSeedLike[]>('/api/factions'),
  faction: (key: string) => request<any>(`/api/factions/${key}`),
  units: () => request<any[]>('/api/units'),
  characters: (params: Record<string, string>) => {
    const qs = new URLSearchParams(params).toString();
    return request<{ total: number; page: number; pageSize: number; items: CharacterSummary[] }>(`/api/characters?${qs}`);
  },
  character: (id: string, gameId?: string) =>
    request<any>(`/api/characters/${encodeURIComponent(id)}${gameId ? `?gameId=${encodeURIComponent(gameId)}` : ''}`),
  archetypes: () => request<any[]>('/api/archetypes'),
  audit: () => request<any>('/api/audit'),
  games: () => request<{ items: GameListItem[] }>('/api/games'),
  createGame: (body: { factionKey: string; playerRole: string; seed?: number }) =>
    request<{ gameId: string; view: PlayerView; persona: CharacterSummary }>('/api/games', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  game: (id: string) =>
    request<{ view: PlayerView; events: GameEvent[]; chronicle: ChronicleEntry[]; saves: SaveMeta[] }>(`/api/games/${id}`),
  deleteGame: (id: string) => request<{ ok: boolean }>(`/api/games/${id}`, { method: 'DELETE' }),
  submitOrders: (id: string, orders: Order[]) =>
    request<{
      accepted: { order: Order; preview?: string }[];
      rejected: { orderId: string; issues: { code: string; message: string }[] }[];
      view: PlayerView;
    }>(`/api/games/${id}/orders`, { method: 'POST', body: JSON.stringify({ orders }) }),
  cancelOrder: (id: string, orderId: string) =>
    request<{ ok: boolean; view: PlayerView }>(`/api/games/${id}/orders/${encodeURIComponent(orderId)}`, {
      method: 'DELETE',
    }),
  endTurn: (id: string) =>
    request<{
      view: PlayerView;
      report: { turn: number; dateLabel: string; events: GameEvent[]; chronicle: ChronicleEntry[]; summary: string; rejectedOrders: any[] };
      rejected: any[];
    }>(`/api/games/${id}/turn`, { method: 'POST', body: '{}' }),
  events: (id: string, params: Record<string, string> = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request<{ items: GameEvent[] }>(`/api/games/${id}/events?${qs}`);
  },
  chronicle: (id: string) => request<{ items: ChronicleEntry[] }>(`/api/games/${id}/chronicle`),
  battleReplay: (id: string, eventId: string) =>
    request<{ replay: BattleReplay }>(`/api/games/${id}/battles/${encodeURIComponent(eventId)}/replay`),
  polishChronicleLlm: (id: string, turn: number) =>
    request<{ ok: boolean; turn: number; updated: number; items: ChronicleEntry[] }>(
      `/api/games/${id}/chronicle/llm`,
      { method: 'POST', body: JSON.stringify({ turn }) },
    ),
  save: (id: string, label?: string) =>
    request<{ save: any; items: SaveMeta[] }>(`/api/games/${id}/save`, {
      method: 'POST',
      body: JSON.stringify({ label }),
    }),
  saves: (id: string) => request<{ items: SaveMeta[] }>(`/api/games/${id}/saves`),
  load: (id: string, saveId: string) =>
    request<{ view: PlayerView; events: GameEvent[]; chronicle: ChronicleEntry[]; loadedSave: any }>(
      `/api/games/${id}/load/${encodeURIComponent(saveId)}`,
      { method: 'POST', body: '{}' },
    ),
};
