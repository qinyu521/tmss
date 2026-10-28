import { FACTION_VISUALS, fmt } from '@tianming/shared';
import { useApp } from '../state/store';
import { Modal, TraitChips } from '../components/ui';

export default function FactionPanel() {
  const view = useApp((s) => s.view);
  const setNav = useApp((s) => s.setNav);
  const select = useApp((s) => s.select);
  if (!view) return null;
  const ownRegions = view.regions.filter((r) => r.owned);
  const sum = (key: 'foodOutput' | 'saltOutput' | 'ironOutput' | 'horseOutput') =>
    ownRegions.reduce((s, r) => s + (r[key] ?? 0), 0);
  const res = view.own.resources;
  const faction = FACTION_VISUALS[view.factionKey];

  return (
    <Modal
      title={`${view.own.shortName} · 国家面板`}
      subtitle={`${view.date.label} · 第 ${view.date.turn} 回合`}
      onClose={() => setNav('map')}
    >
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
        <TraitChips tags={view.own.statusTags} limit={10} />
      </div>

      <div className="kv" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))' }}>
        <div className="item"><div className="k">控制州府</div><div className="v">{view.own.controlCount}</div></div>
        <div className="item"><div className="k">野战兵力</div><div className="v">{fmt(view.own.fieldTroops)}</div></div>
        <div className="item"><div className="k">名义兵力</div><div className="v">{fmt(view.own.nominalTroops)}</div></div>
        <div className="item"><div className="k">行政效率</div><div className="v">{view.own.adminEfficiency}</div></div>
        <div className="item"><div className="k">稳定</div><div className="v">{view.own.stability}</div></div>
        <div className="item"><div className="k">声望</div><div className="v">{view.own.reputation}</div></div>
      </div>

      <div className="section-title">资源账本</div>
      <div className="kv" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))' }}>
        <div className="item"><div className="k">粮（石）</div><div className="v">{fmt(res.grain)}</div></div>
        <div className="item"><div className="k">盐（担）</div><div className="v">{fmt(res.salt)}</div></div>
        <div className="item"><div className="k">铁（担）</div><div className="v">{fmt(res.iron)}</div></div>
        <div className="item"><div className="k">战马（匹）</div><div className="v">{fmt(res.horses)}</div></div>
        <div className="item"><div className="k">银钱（两）</div><div className="v">{fmt(res.cash)}</div></div>
        <div className="item"><div className="k">可征兵员</div><div className="v">{fmt(res.manpower)}</div></div>
      </div>
      <div className="form-note">
        州府每旬合计产出：粮 {fmt(sum('foodOutput'), '石')}、盐 {fmt(sum('saltOutput'), '担')}、铁 {fmt(sum('ironOutput'), '担')}、马 {fmt(sum('horseOutput'), '匹')}。
        实际入库还受治安、民心、世家配合/联盟协调/朝局稳定影响。
      </div>

      <div className="section-title">州府控制</div>
      <table className="table">
        <thead>
          <tr><th>州府</th><th>主官</th><th>治安</th><th>民心</th><th>州兵</th><th>威胁</th><th>产出（粮/盐/铁/马）</th></tr>
        </thead>
        <tbody>
          {ownRegions.map((r) => (
            <tr key={r.regionId} onClick={() => { select({ type: 'region', id: r.regionId }); setNav('map'); }} style={{ cursor: 'pointer' }}>
              <td>{r.name}</td>
              <td>{r.governorName}</td>
              <td>{r.order}</td>
              <td>{r.loyalty}</td>
              <td>{fmt(r.garrison ?? 0)}</td>
              <td className={r.threat > 20 ? 'danger-text' : ''}>{r.threat}</td>
              <td className="mono small">{fmt(r.foodOutput ?? 0)} / {fmt(r.saltOutput ?? 0)} / {fmt(r.ironOutput ?? 0)} / {fmt(r.horseOutput ?? 0)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="section-title">野战军团</div>
      <table className="table">
        <thead>
          <tr><th>军团</th><th>统兵官</th><th>驻地</th><th>兵力</th><th>士气</th><th>补给</th><th>状态</th></tr>
        </thead>
        <tbody>
          {view.armies.filter((a) => a.own).map((a) => (
            <tr key={a.armyId} onClick={() => { select({ type: 'army', id: a.armyId }); setNav('map'); }} style={{ cursor: 'pointer' }}>
              <td>{a.name}</td>
              <td>{a.commanderName}</td>
              <td>{a.regionName}</td>
              <td>{fmt(a.troops ?? 0)}</td>
              <td>{a.morale ?? 0}</td>
              <td>{a.supply ?? 0}</td>
              <td>{a.status === 'marching' ? `行军 ${Math.round(a.progress * 100)}%` : a.status === 'fighting' ? '交战' : '驻防'}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="section-title">国策与告诫</div>
      <div className="card small" style={{ lineHeight: 1.8 }}>
        {view.own.notes.map((n, i) => <div key={i}>· {n}</div>)}
        <div className="muted" style={{ marginTop: 6 }}>势力色：<span style={{ color: faction.mapBorder }}>{faction.shortName}</span>。</div>
      </div>

      <div className="section-title">他国概况（公开信息）</div>
      <div className="sheet-grid">
        {view.factions.filter((f) => f.key !== view.factionKey).map((f) => {
          const v = FACTION_VISUALS[f.key];
          return (
            <div className="card" key={f.key}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span className="owner-dot" style={{ background: v.mapBorder, color: v.mapBorder }} />
                <strong style={{ color: v.mapBorder, fontFamily: 'var(--font-display)', fontSize: 15 }}>{f.shortName}</strong>
                <span className={`chip ${f.atWar ? 'danger' : ''}`}>{f.stance}</span>
              </div>
              <div className="small muted" style={{ marginTop: 6 }}>
                控制 {f.regionsCount} 州 · 兵力：{f.troopsLabel}
              </div>
              <div className="small muted">公开军情只能通过斥候、使节、商路与战报间接推断。</div>
            </div>
          );
        })}
      </div>
    </Modal>
  );
}
