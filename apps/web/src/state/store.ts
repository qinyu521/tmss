import { create } from 'zustand';
import type { ChronicleEntry, GameEvent, Order, PlayerView } from '@tianming/shared';
import { api, type CharacterSummary, type ConfigData, type FactionSeedLike, type MapData, type SaveMeta } from '../api/client';

export type LayerKey =
  | 'political'
  | 'grain'
  | 'salt'
  | 'iron'
  | 'horses'
  | 'order'
  | 'loyalty'
  | 'supply'
  | 'threat'
  | 'intel';

export type NavKey = 'map' | 'faction' | 'characters' | 'army' | 'court' | 'events' | 'units' | 'saves' | 'settings';

export interface Selection {
  type: 'region' | 'army' | 'node';
  id: string;
}

interface Toast {
  message: string;
  kind: 'info' | 'success' | 'error';
}

interface AppState {
  status: 'boot' | 'start' | 'playing' | 'error';
  bootError: string | null;
  config: ConfigData | null;
  mapData: MapData | null;
  factions: FactionSeedLike[];
  view: PlayerView | null;
  gameId: string | null;
  persona: CharacterSummary | null;
  events: GameEvent[];
  chronicle: ChronicleEntry[];
  saves: SaveMeta[];
  games: { game_id: string; faction_key: string; player_role: string; turn: number; date_label: string; updated_at: string }[];
  nav: NavKey;
  layer: LayerKey;
  selected: Selection | null;
  labels: boolean;
  quality: 'high' | 'low';
  ordersOpen: boolean;
  orderPreset: Record<string, any> | null;
  busy: boolean;
  toast: Toast | null;

  boot: () => Promise<void>;
  startGame: (factionKey: string, playerRole: string) => Promise<void>;
  continueGame: (gameId: string) => Promise<void>;
  refreshGame: () => Promise<void>;
  submitOrders: (orders: Order[]) => Promise<{ accepted: number; rejected: number; previews: string[]; issues: string[] }>;
  cancelOrder: (orderId: string) => Promise<void>;
  endTurn: () => Promise<void>;
  saveGame: (label?: string) => Promise<void>;
  loadSave: (saveId: string) => Promise<void>;
  deleteGame: (gameId: string) => Promise<void>;
  setNav: (nav: NavKey) => void;
  setLayer: (layer: LayerKey) => void;
  select: (selection: Selection) => void;
  toggleLabels: () => void;
  setQuality: (q: 'high' | 'low') => void;
  setOrdersOpen: (open: boolean) => void;
  openOrders: (preset?: Record<string, any> | null) => void;
  notify: (message: string, kind?: Toast['kind']) => void;
}

const LAST_GAME = 'tianming.lastGameId';

function capitalName(view: PlayerView, factions: FactionSeedLike[]): string {
  const f = factions.find((x) => x.key === view.factionKey);
  const capital = f ? (f as any).capital : '';
  return capital && view.regions.some((r) => r.owned && r.name === capital) ? capital : '';
}

export const useApp = create<AppState>((set, get) => ({
  status: 'boot',
  bootError: null,
  config: null,
  mapData: null,
  factions: [],
  view: null,
  gameId: null,
  persona: null,
  events: [],
  chronicle: [],
  saves: [],
  games: [],
  nav: 'map',
  layer: 'political',
  selected: null,
  labels: true,
  quality: 'high',
  ordersOpen: false,
  orderPreset: null,
  busy: false,
  toast: null,

  boot: async () => {
    try {
      const [config, mapData, factions, games] = await Promise.all([
        api.config(),
        api.map(),
        api.factions(),
        api.games(),
      ]);
      const last = localStorage.getItem(LAST_GAME);
      set({ config, mapData, factions, games: games.items, bootError: null });
      if (last) {
        try {
          const data = await api.game(last);
          set({
            view: data.view,
            gameId: last,
            events: data.events,
            chronicle: data.chronicle,
            saves: data.saves,
            status: 'playing',
            selected: defaultSelection(data.view, factions),
          });
          return;
        } catch {
          localStorage.removeItem(LAST_GAME);
        }
      }
      set({ status: 'start', games: games.items });
    } catch (err: any) {
      set({ status: 'error', bootError: err?.message ?? '无法连接后端' });
    }
  },

  startGame: async (factionKey, playerRole) => {
    set({ busy: true });
    try {
      const data = await api.createGame({ factionKey, playerRole });
      localStorage.setItem(LAST_GAME, data.gameId);
      set({
        gameId: data.gameId,
        view: data.view,
        persona: data.persona,
        events: [],
        chronicle: [],
        saves: [],
        status: 'playing',
        nav: 'map',
        layer: 'political',
        busy: false,
        selected: defaultSelection(data.view, get().factions),
      });
      get().notify(`已开局：${data.view.own.name} · ${data.persona.name}`, 'success');
      const games = await api.games();
      set({ games: games.items });
    } catch (err: any) {
      set({ busy: false });
      get().notify(err?.message ?? '开局失败', 'error');
    }
  },

  continueGame: async (gameId) => {
    set({ busy: true });
    try {
      const data = await api.game(gameId);
      localStorage.setItem(LAST_GAME, gameId);
      set({
        gameId,
        view: data.view,
        events: data.events,
        chronicle: data.chronicle,
        saves: data.saves,
        status: 'playing',
        busy: false,
        nav: 'map',
        selected: defaultSelection(data.view, get().factions),
      });
    } catch (err: any) {
      set({ busy: false });
      get().notify(err?.message ?? '载入失败', 'error');
    }
  },

  refreshGame: async () => {
    const id = get().gameId;
    if (!id) return;
    try {
      const data = await api.game(id);
      set({ view: data.view, events: data.events, chronicle: data.chronicle, saves: data.saves });
    } catch (err: any) {
      get().notify(err?.message ?? '刷新失败', 'error');
    }
  },

  submitOrders: async (orders) => {
    const id = get().gameId;
    if (!id) return { accepted: 0, rejected: 0, previews: [], issues: [] };
    set({ busy: true });
    try {
      const res = await api.submitOrders(id, orders);
      set({ view: res.view, busy: false });
      if (res.accepted.length) get().notify(`已下达 ${res.accepted.length} 条命令`, 'success');
      if (res.rejected.length) {
        get().notify(res.rejected[0].issues.map((i) => i.message).join('；'), 'error');
      }
      return {
        accepted: res.accepted.length,
        rejected: res.rejected.length,
        previews: res.accepted.map((a) => a.preview ?? '').filter(Boolean),
        issues: res.rejected.flatMap((r) => r.issues.map((i) => i.message)),
      };
    } catch (err: any) {
      set({ busy: false });
      get().notify(err?.message ?? '命令提交失败', 'error');
      return { accepted: 0, rejected: 1, previews: [], issues: [err?.message ?? '命令提交失败'] };
    }
  },

  cancelOrder: async (orderId) => {
    const id = get().gameId;
    if (!id) return;
    try {
      const res = await api.cancelOrder(id, orderId);
      set({ view: res.view });
    } catch (err: any) {
      get().notify(err?.message ?? '撤销失败', 'error');
    }
  },

  endTurn: async () => {
    const id = get().gameId;
    if (!id) return;
    set({ busy: true });
    try {
      const res = await api.endTurn(id);
      set({
        view: res.view,
        events: [...res.report.events].reverse(),
        chronicle: res.report.chronicle.concat(get().chronicle),
        busy: false,
      });
      const saves = await api.saves(id);
      set({ saves: saves.items });
      get().notify(res.report.summary, 'info');
    } catch (err: any) {
      set({ busy: false });
      get().notify(err?.message ?? '回合结算失败', 'error');
    }
  },

  saveGame: async (label) => {
    const id = get().gameId;
    if (!id) return;
    try {
      const res = await api.save(id, label);
      set({ saves: res.items });
      get().notify('存档已保存', 'success');
    } catch (err: any) {
      get().notify(err?.message ?? '保存失败', 'error');
    }
  },

  loadSave: async (saveId) => {
    const id = get().gameId;
    if (!id) return;
    set({ busy: true });
    try {
      const res = await api.load(id, saveId);
      set({
        view: res.view,
        events: res.events,
        chronicle: res.chronicle,
        busy: false,
        nav: 'map',
      });
      get().notify(`已载入：${res.loadedSave.label}`, 'success');
    } catch (err: any) {
      set({ busy: false });
      get().notify(err?.message ?? '读档失败', 'error');
    }
  },

  deleteGame: async (gameId) => {
    try {
      await api.deleteGame(gameId);
      const games = await api.games();
      if (get().gameId === gameId) {
        localStorage.removeItem(LAST_GAME);
        set({ gameId: null, view: null, status: 'start', games: games.items, nav: 'map' });
      } else {
        set({ games: games.items });
      }
      get().notify('时间线已删除', 'info');
    } catch (err: any) {
      get().notify(err?.message ?? '删除失败', 'error');
    }
  },

  setNav: (nav) => set({ nav }),
  setLayer: (layer) => set({ layer }),
  select: (selection) => set({ selected: selection }),
  toggleLabels: () => set({ labels: !get().labels }),
  setQuality: (quality) => set({ quality }),
  setOrdersOpen: (ordersOpen) => set({ ordersOpen }),
  openOrders: (preset = null) => set({ ordersOpen: true, orderPreset: preset }),
  notify: (message, kind = 'info') => {
    set({ toast: { message, kind } });
    setTimeout(() => {
      if (get().toast?.message === message) set({ toast: null });
    }, 4200);
  },
}));

function defaultSelection(view: PlayerView, factions: FactionSeedLike[]): Selection | null {
  const capital = capitalName(view, factions);
  const region = view.regions.find((r) => r.owned && r.name === capital) ?? view.regions.find((r) => r.owned);
  return region ? { type: 'region', id: region.regionId } : null;
}
