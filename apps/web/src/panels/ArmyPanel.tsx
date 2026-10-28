import { CATEGORY_LABELS, FACTION_VISUALS, fmt } from '@tianming/shared';
import { useApp } from '../state/store';
import { Modal, Portrait, StatLine, UnitIcon } from '../components/ui';

export default function ArmyPanel() {
  const view = useApp((s) => s.view);
  const setNav = useApp((s) => s.setNav);
  const select = useApp((s) => s.select);
  const openOrders = useApp((s) => s.openOrders);
  if (!view) return null;
  const own = view.armies.filter((a) => a.own);
  const foreign = view.armies.filter((a) => !a.own);
  const total = own.reduce((s, a) => s + (a.troops ?? 0), 0);

  return (
    <Modal
      title="军团面板"
      subtitle={`直属野战 ${fmt(total)} 人 · 名义 ${fmt(view.own.nominalTroops)} 人 · 州兵不计入名义兵力`}
      onClose={() => setNav('map')}
      width={1280}
    >
      <div className="form-note">
        军区司令不等于全图总指挥：部队调动受身份权限、道路、粮道、军饷与中央命令影响。
        精锐兵种数量受上限约束，损失后补充需要资源与训练时间。
      </div>

      {own.map((a) => (
        <div className="card" key={a.armyId} style={{ marginBottom: 12 }}>
          <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <div className="person-card" style={{ flex: '0 0 auto' }}>
              {a.commanderId ? <Portrait personId={a.commanderId} /> : <div className="portrait" />}
              <div>
                <div className="pc-name">{a.name}</div>
                <div className="pc-role">{a.commanderName} · 驻 {a.regionName}</div>
                <div className="small muted">
                  {a.status === 'marching' ? `行军中 ${Math.round(a.progress * 100)}%` : a.status === 'fighting' ? '交战中' : '驻防'}
                </div>
              </div>
            </div>
            <div style={{ flex: '1 1 280px', minWidth: 240 }}>
              <StatLine label="士气" value={a.morale ?? 0} />
              <StatLine label="训练" value={a.training ?? 0} />
              <StatLine label="补给" value={a.supply ?? 0} mode={(a.supply ?? 0) < 40 ? 'red' : 'green'} />
              <StatLine label="疲劳" value={a.fatigue ?? 0} mode="red" />
            </div>
            <div className="kv" style={{ flex: '1 1 220px' }}>
              <div className="item"><div className="k">可战兵</div><div className="v">{fmt(a.troops ?? 0)}</div></div>
              <div className="item"><div className="k">征集兵</div><div className="v">{fmt(a.levies ?? 0)}</div></div>
            </div>
          </div>

          <div className="divider" />
          <div className="sheet-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))' }}>
            {(a.units ?? []).length === 0 && <div className="small muted">无特殊兵种分遣队（全部为征集兵）。</div>}
            {(a.units ?? []).map((u) => (
              <div className="unit-row" key={u.unitId}>
                <UnitIcon unitId={u.unitId} name={u.name} />
                <div>
                  <div className="u-name">{u.name}</div>
                  <div className="u-cat">{CATEGORY_LABELS[u.category] ?? u.category}</div>
                </div>
                <div className="u-count">{u.count.toLocaleString()}</div>
              </div>
            ))}
          </div>

          {a.path.length > 0 && (
            <div className="small muted" style={{ marginTop: 8 }}>
              行军路线：{a.path.map((id) => view.regions.find((r) => r.regionId === id)?.name ?? id).join(' → ')}
            </div>
          )}

          <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
            <button className="btn small" onClick={() => { select({ type: 'army', id: a.armyId }); setNav('map'); }}>在地图定位</button>
            <button className="btn small" disabled={a.status === 'marching'} onClick={() => openOrders({ kind: 'move_army', armyId: a.armyId })}>行军/分兵</button>
            <button className="btn small" onClick={() => openOrders({ kind: 'rest_army', armyId: a.armyId })}>整军休整</button>
            <button className="btn small" onClick={() => openOrders({ kind: 'scheme', scheme: 'cut_supply' })}>计谋</button>
          </div>
        </div>
      ))}

      <div className="section-title">州府守备（州兵不计入名义兵力）</div>
      <table className="table">
        <thead><tr><th>州府</th><th>州兵</th><th>统带</th><th>威胁</th><th>操作</th></tr></thead>
        <tbody>
          {view.regions.filter((r) => r.owned).map((r) => (
            <tr key={r.regionId}>
              <td>{r.name}</td>
              <td>{fmt(r.garrison ?? 0)}</td>
              <td>{r.garrisonCommanderName ?? '—'}</td>
              <td className={r.threat > 20 ? 'danger-text' : ''}>{r.threat}</td>
              <td style={{ display: 'flex', gap: 4 }}>
                <button className="btn small" disabled={(r.garrison ?? 0) <= 0} onClick={() => openOrders({ kind: 'dispatch_garrison', regionId: r.regionId })}>调州兵</button>
                <button className="btn small ghost" onClick={() => openOrders({ kind: 'scheme', scheme: 'ambush', targetRegionId: r.regionId })}>设伏</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="section-title">已知敌军动向</div>
      {foreign.length === 0 && <div className="empty">尚无可见的敌军兵团。请派遣斥候获取情报。</div>}
      <div className="sheet-grid">
        {foreign.map((a) => (
          <div className="card" key={a.armyId}>
            <div style={{ color: FACTION_VISUALS[a.faction].mapBorder }}>{a.name}</div>
            <div className="small muted">驻 {a.regionName} · {a.troopsLabel}</div>
            <div className="small muted">情报：{a.confidence === 'confirmed' ? '已确认' : a.confidence === 'reliable' ? '较可靠' : '未证实'}</div>
            <div className="small muted" style={{ marginTop: 4, lineHeight: 1.6 }}>{a.intelText ?? '兵力与意图不明。'}</div>
            {a.own === false && (
              <button className="btn small" style={{ marginTop: 6 }} onClick={() => openOrders({ kind: 'scheme', scheme: 'cut_supply', targetArmyId: a.armyId })}>断其粮道</button>
            )}
          </div>
        ))}
      </div>
    </Modal>
  );
}
