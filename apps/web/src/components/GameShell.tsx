import { useApp } from '../state/store';
import TopBar from './TopBar';
import LeftRail from './LeftRail';
import MapView from './MapView';
import RightPanel from './RightPanel';
import BottomBar from './BottomBar';
import OrdersSheet from './OrdersSheet';
import FactionPanel from '../panels/FactionPanel';
import CharactersPanel from '../panels/CharactersPanel';
import ArmyPanel from '../panels/ArmyPanel';
import CourtPanel from '../panels/CourtPanel';
import UnitsPanel from '../panels/UnitsPanel';
import EventsPanel from '../panels/EventsPanel';
import SavePanel from '../panels/SavePanel';
import SettingsPanel from '../panels/SettingsPanel';

export default function GameShell() {
  const nav = useApp((s) => s.nav);
  const ordersOpen = useApp((s) => s.ordersOpen);
  const toast = useApp((s) => s.toast);
  const busy = useApp((s) => s.busy);
  const view = useApp((s) => s.view);

  return (
    <div className="app-shell">
      <TopBar />
      {view?.outcome && (
        <div className={`endgame-banner ${view.outcome.status}`}>
          <div className="t">{view.outcome.status === 'victory' ? '天下一统' : '社稷倾覆'}</div>
          <div className="d">{view.outcome.reason} · {view.outcome.dateLabel}</div>
        </div>
      )}
      <div className="workspace">
        <LeftRail />
        <MapView />
        <RightPanel />
      </div>
      <BottomBar />

      {nav === 'faction' && <FactionPanel />}
      {nav === 'characters' && <CharactersPanel />}
      {nav === 'army' && <ArmyPanel />}
      {nav === 'court' && <CourtPanel />}
      {nav === 'units' && <UnitsPanel />}
      {nav === 'events' && <EventsPanel />}
      {nav === 'saves' && <SavePanel />}
      {nav === 'settings' && <SettingsPanel />}
      {ordersOpen && <OrdersSheet />}

      {toast && <div className={`toast ${toast.kind}`}>{toast.message}</div>}
      {busy && (
        <div className="busy-veil">
          <div className="b">正在推演天下大势…</div>
        </div>
      )}
    </div>
  );
}
