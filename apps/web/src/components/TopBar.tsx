import { ROLE_LABEL, FACTION_VISUALS, fmt } from '@tianming/shared';
import { useApp } from '../state/store';
import { ResourceCell } from './ui';

const SHORTAGE_MARK: Record<string, string> = {
  粮草紧张: '粮草紧张',
  缺盐: '缺盐',
  铁料不足: '铁料不足',
  缺战马: '缺战马',
  军饷紧张: '军饷紧张',
};

export default function TopBar() {
  const view = useApp((s) => s.view);
  const persona = useApp((s) => s.persona);
  const busy = useApp((s) => s.busy);
  const endTurn = useApp((s) => s.endTurn);
  const openOrders = useApp((s) => s.openOrders);
  const saveGame = useApp((s) => s.saveGame);
  if (!view) return null;
  const res = view.own.resources;
  const tags = view.own.statusTags;
  const low = (name: string) => tags.includes(name);
  const faction = FACTION_VISUALS[view.factionKey];
  const ended = Boolean(view.outcome);

  return (
    <header className="topbar">
      <div className="brand">
        <div className="seal" style={{ borderColor: faction.mapBorder, color: faction.mapBorder }}>{faction.bannerGlyph}</div>
        <div>
          <div className="name" style={{ color: faction.mapBorder }}>{view.own.shortName}</div>
          <div className="persona">{persona?.name ?? view.playerPersonName} · {ROLE_LABEL[view.playerRole]}</div>
        </div>
      </div>

      <div className="top-date">
        <div>
          <div className="d">{view.date.label} · {view.season.label}</div>
          <div className="turn">第 {view.date.turn} 回合 · 七日一旬</div>
          <div className="turn" title={view.season.desc}>{view.season.hint}</div>
        </div>
      </div>

      <div className="resource-strip">
        <ResourceCell k="粮" v={res.grain} unit="石" low={low('粮草紧张') || res.grain <= 0} />
        <ResourceCell k="盐" v={res.salt} unit="担" low={low('缺盐') || res.salt <= 0} />
        <ResourceCell k="铁" v={res.iron} unit="担" low={low('铁料不足') || res.iron <= 0} />
        <ResourceCell k="马" v={res.horses} unit="匹" low={low('缺战马') || res.horses <= 0} />
        <ResourceCell k="银" v={res.cash} unit="两" low={low('军饷紧张') || res.cash <= 0} />
        <div className="res">
          <span className="k">野战兵</span>
          <span className="v">{fmt(view.own.fieldTroops, '人')}</span>
        </div>
        <div className="res">
          <span className="k">名义兵</span>
          <span className="v">{fmt(view.own.nominalTroops, '人')}</span>
        </div>
      </div>

      <div className="top-tags">
        {tags.slice(0, 5).map((t) => (
          <span key={t} className={`chip ${Object.values(SHORTAGE_MARK).includes(t) || /危机|拒命|抵制/.test(t) ? 'danger' : ''}`}>
            {t}
          </span>
        ))}
      </div>

      <div className="top-actions">
        <button className="btn" onClick={() => openOrders()} disabled={busy || ended}>
          命令{view.pendingOrders.length > 0 ? `（${view.pendingOrders.length}）` : ''}
        </button>
        <button className="btn" onClick={() => void saveGame()} disabled={busy}>存档</button>
        <button className="btn primary" onClick={() => void endTurn()} disabled={busy || ended}>
          {ended ? '天下已定' : busy ? '推演中…' : '结束本旬'}
        </button>
      </div>
    </header>
  );
}
