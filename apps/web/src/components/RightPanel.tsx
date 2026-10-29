import { CATEGORY_LABELS, FACTION_VISUALS, fmt, ORDER_LABELS, ROLE_ALLOWED_ORDERS, ROLE_LABEL } from '@tianming/shared';
import { useApp } from '../state/store';
import { Portrait, StatLine, TraitChips, UnitIcon } from './ui';

export default function RightPanel() {
  const view = useApp((s) => s.view);
  const mapData = useApp((s) => s.mapData);
  const selected = useApp((s) => s.selected);
  const events = useApp((s) => s.events);
  const openOrders = useApp((s) => s.openOrders);
  const setNav = useApp((s) => s.setNav);
  const select = useApp((s) => s.select);
  const role = view?.playerRole ?? 'ruler';
  const allowed = ROLE_ALLOWED_ORDERS[role];

  if (!view) return null;
  const region = selected?.type === 'region' ? view.regions.find((r) => r.regionId === selected.id) : undefined;
  const node = selected?.type === 'node' ? mapData?.nodes.find((n) => n.node_id === selected.id) : undefined;
  const army = selected?.type === 'army' ? view.armies.find((a) => a.armyId === selected.id) : undefined;

  if (region) {
    return <aside className="right-panel">{regionDetail(region, node)}</aside>;
  }

  return <aside className="right-panel">{renderContent()}</aside>;

  function renderContent() {
    if (region) return null;
    if (army) return armyDetail(army);
    if (node) return nodeDetail(node);
    return overview();
  }

  function regionDetail(rv: NonNullable<typeof region>, _node: typeof node) {
    const territory = mapData?.territories.find((t) => t.region_id === rv.regionId);
    const faction = FACTION_VISUALS[rv.faction];
    const regionEvents = events.filter((e) => e.targetId === rv.regionId || e.targetLabel === rv.name).slice(0, 4);
    const canScout = allowed.includes('scout') && !rv.owned;
    return (
      <>
        <div className="rp-head">
          <div className="kicker">{rv.owned ? '本国州府' : rv.intel ? '敌情 · 有情报' : '外国州府 · 情报未详'}</div>
          <div className="title">
            <span className="owner-dot" style={{ color: faction.mapBorder, background: faction.mapBorder }} />
            {rv.name}
          </div>
          <div className="small muted">{faction.shortName} · {territory?.regional_profile ?? ''}</div>
          <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
            <span className="chip">地形 {terrainLabel(rv.terrain)}</span>
            <span className="chip">城防 {rv.fortification}</span>
            {rv.threat > 10 && <span className="chip danger">威胁 {rv.threat}</span>}
          </div>
        </div>
        <div className="rp-body">
          {rv.owned ? (
            <>
              <div className="subhead">州府治理</div>
              <div className="kv">
                <div className="item"><div className="k">主官</div><div className="v" style={{ fontSize: 13 }}>{rv.governorName}</div></div>
                <div className="item"><div className="k">人口</div><div className="v">{fmt(rv.population ?? 0)}</div></div>
              </div>
              <StatLine label="治安" value={rv.order ?? 0} />
              <StatLine label="民心" value={rv.loyalty ?? 0} />
              <StatLine label="补给" value={rv.supplyLevel ?? 0} />
              <div className="subhead">产出（每旬）</div>
              <div className="kv">
                <div className="item"><div className="k">粮</div><div className="v">{fmt(rv.foodOutput ?? 0, '石')}</div></div>
                <div className="item"><div className="k">盐</div><div className="v">{fmt(rv.saltOutput ?? 0, '担')}</div></div>
                <div className="item"><div className="k">铁</div><div className="v">{fmt(rv.ironOutput ?? 0, '担')}</div></div>
                <div className="item"><div className="k">战马</div><div className="v">{fmt(rv.horseOutput ?? 0, '匹')}</div></div>
              </div>
              <div className="subhead">州兵与城防</div>
              <div className="kv" style={{ marginTop: 8 }}>
                <div className="item"><div className="k">州兵（不计名义兵力）</div><div className="v">{fmt(rv.garrison ?? 0)}</div></div>
                <div className="item"><div className="k">州兵统带</div><div className="v" style={{ fontSize: 13 }}>{rv.garrisonCommanderName ?? '—'}</div></div>
                <div className="item"><div className="k">城防系数</div><div className="v">{rv.fortification}</div></div>
              </div>
              <div className="form-note">州兵为地方守备，可整批或分批调出野战；调出后本州防御下降，敌军来攻时守备减少。</div>
            </>
          ) : (
            <>
              <div className="subhead">已知情报</div>
              {rv.intel ? (
                <div className="card">
                  <div className="small">来源可靠度：<span className="gold">{Math.round(rv.intel.reliability * 100)}%</span> · 状态：{intelStatusLabel(rv.intel.status)}</div>
                  <div className="small muted" style={{ marginTop: 6 }}>
                    州兵估算约 {fmt(rv.intel.garrisonEstimate ?? 0)}；粮秣、治安、民心与真实兵力未详。
                  </div>
                </div>
              ) : (
                <div className="empty">尚无可靠情报。斥候只能确认旗号、大致兵力与城防，不能提供全部内情。</div>
              )}
              <div className="subhead">公开地理</div>
              <div className="small muted">{territory?.key_locations ?? '—'}</div>
              <div className="small muted" style={{ marginTop: 6 }}>风险：{territory?.risk ?? '未知'}</div>
            </>
          )}

          <div className="subhead">相关记事</div>
          {regionEvents.length === 0 ? (
            <div className="small muted">暂无直接记录。</div>
          ) : (
            regionEvents.map((e) => (
              <div className="feed-row" key={e.eventId}>
                <span className="date">{e.dateLabel.replace('天命', '')}</span>
                <span className="title">{e.title}</span>
                <span className="summary">{e.summary}</span>
              </div>
            ))
          )}
        </div>
        <div className="rp-foot">
          {allowed.includes('scheme') && (
            <button className="btn small" onClick={() => openOrders({ kind: 'scheme', targetRegionId: rv.regionId, scheme: rv.owned ? 'ambush' : 'fire' })}>
              {rv.owned ? '设伏兵' : '对其施计'}
            </button>
          )}
          {rv.owned && allowed.includes('dispatch_garrison') && (rv.garrison ?? 0) > 0 && (
            <button className="btn small" onClick={() => openOrders({ kind: 'dispatch_garrison', regionId: rv.regionId })}>
              调遣州兵
            </button>
          )}
          {canScout && (
            <button className="btn small" onClick={() => openOrders({ kind: 'scout', regionId: rv.regionId })}>
              遣斥候侦察
            </button>
          )}
          {allowed.includes('move_army') && (
            <button className="btn small primary" onClick={() => openOrders({ kind: 'move_army', targetRegionId: rv.regionId })}>
              令军前往
            </button>
          )}
          {rv.owned && allowed.includes('appoint') && (
            <button className="btn small" onClick={() => openOrders({ kind: 'appoint', regionId: rv.regionId })}>任命主官</button>
          )}
          <button className="btn small ghost" onClick={() => setNav('faction')}>国家面板</button>
        </div>
      </>
    );
  }

  function armyDetail(armyView: NonNullable<typeof army>) {
    const faction = FACTION_VISUALS[armyView.faction];
    return (
      <>
        <div className="rp-head">
          <div className="kicker">{armyView.own ? '我军兵团' : armyView.confidence === 'confirmed' ? '敌军 · 已确认' : '敌军 · 情报'}</div>
          <div className="title">
            <span className="owner-dot" style={{ color: faction.mapBorder, background: faction.mapBorder }} />
            {armyView.name}
          </div>
          <div className="small muted">{faction.shortName} · 驻 {armyView.regionName} · {armyView.status === 'marching' ? '行军中' : armyView.status === 'fighting' ? '交战中' : '驻防'}</div>
        </div>
        <div className="rp-body">
          <div className="person-card">
            {armyView.commanderId ? <Portrait personId={armyView.commanderId} /> : <div className="portrait" />}
            <div>
              <div className="pc-name">{armyView.commanderName}</div>
              <div className="pc-role">统兵官 · {armyView.own ? '直属我军' : '敌方'}</div>
              <div className="small muted" style={{ marginTop: 2 }}>兵力 {armyView.troopsLabel}</div>
              {armyView.own && (
                <div className="small" style={{ marginTop: 2, color: 'var(--gold-soft)' }}>
                  统率 {armyView.commanderCommand ?? '—'} / 谋略 {armyView.commanderStrategy ?? '—'}
                </div>
              )}
            </div>
          </div>
          {armyView.isMilitia && <span className="chip warn">州兵临时编成</span>}
          {armyView.isDetachment && !armyView.isMilitia && <span className="chip">分遣队</span>}
          {armyView.own ? (
            <>
              <div className="subhead">军情</div>
              <StatLine label="士气" value={armyView.morale ?? 0} />
              <StatLine label="训练" value={armyView.training ?? 0} />
              <StatLine label="补给" value={armyView.supply ?? 0} mode={(armyView.supply ?? 0) < 40 ? 'red' : 'green'} />
              <StatLine label="疲劳" value={armyView.fatigue ?? 0} mode="red" />
              <div className="kv" style={{ marginTop: 8 }}>
                <div className="item"><div className="k">可战兵</div><div className="v">{fmt(armyView.troops ?? 0)}</div></div>
                <div className="item"><div className="k">征集兵</div><div className="v">{fmt(armyView.levies ?? 0)}</div></div>
              </div>
              <div className="subhead">精锐编制</div>
              {(armyView.units ?? []).length === 0 ? <div className="small muted">无特殊兵种分遣队。</div> : null}
              {(armyView.units ?? []).map((u) => (
                <div className="unit-row" key={u.unitId}>
                  <UnitIcon unitId={u.unitId} name={u.name} />
                  <div>
                    <div className="u-name">{u.name}</div>
                    <div className="u-cat">{CATEGORY_LABELS[u.category] ?? u.category}</div>
                  </div>
                  <div className="u-count">{u.count.toLocaleString()}</div>
                </div>
              ))}
              {armyView.path.length > 0 && (
                <>
                  <div className="subhead">行军</div>
                  <div className="small">目标：{regionName(mapData, armyView.targetRegionId)}</div>
                  <div className="bar" style={{ marginTop: 4 }}><i style={{ width: `${Math.round(armyView.progress * 100)}%` }} /></div>
                  <div className="small muted" style={{ marginTop: 4 }}>剩余路线：{armyView.path.map((id) => regionName(mapData, id)).join(' → ')}</div>
                </>
              )}
            </>
          ) : (
            <>
              <div className="subhead">情报评估</div>
              <div className="card">
                <div className="small">情报等级：<span className="gold">{armyView.confidence === 'confirmed' ? '已确认' : armyView.confidence === 'reliable' ? '可靠' : '未证实'}</span></div>
                <div className="small muted" style={{ marginTop: 6 }}>{armyView.intelText ?? '尚无斥候回报。可见敌军旗号与所在州府，但兵力与补给未知。'}</div>
              </div>
              <div className="form-note">不要轻信单一来源：斥候估算可能有误差，敌军真实兵力只有交战或多次侦察后才能确认。</div>
            </>
          )}
        </div>
        <div className="rp-foot">
          {armyView.own && allowed.includes('move_army') && armyView.status !== 'marching' && (
            <button className="btn small primary" onClick={() => openOrders({ kind: 'move_army', armyId: armyView.armyId })}>行军/分兵</button>
          )}
          {armyView.own && allowed.includes('scheme') && (
            <button className="btn small" onClick={() => openOrders({ kind: 'scheme', scheme: 'cut_supply', targetArmyId: '' })}>计谋</button>
          )}
          {armyView.own && allowed.includes('rest_army') && (
            <button className="btn small" onClick={() => openOrders({ kind: 'rest_army', armyId: armyView.armyId })}>整军休整</button>
          )}
          <button className="btn small ghost" onClick={() => setNav('army')}>军团总览</button>
        </div>
      </>
    );
  }

  function nodeDetail(nodeView: NonNullable<typeof node>) {
    const rv = view!.regions.find((r) => r.name === nodeView.region);
    const nodeState = view!.mapNodes.find((n) => n.nodeId === nodeView.node_id);
    const nodeTerritory = mapData?.territories.find((t) => t.region === nodeView.region);
    return (
      <>
        <div className="rp-head">
          <div className="kicker">{nodeView.node_type}</div>
          <div className="title">{nodeView.node_name}</div>
          <div className="small muted">{nodeView.region} · 当前控制：{nodeState?.ownerShort ?? nodeView.faction}</div>
        </div>
        <div className="rp-body">
          <div className="subhead">地点档案</div>
          <div className="card small" style={{ lineHeight: 1.7 }}>
            <div>{nodeView.location_role}</div>
            <div className="muted" style={{ marginTop: 6 }}>资源：{nodeView.resource_profile}</div>
            <div className="muted">风险：{nodeView.terrain_and_risk}</div>
          </div>
          <div className="subhead">控制与驻防</div>
          <div className="kv">
            <div className="item"><div className="k">当前势力</div><div className="v" style={{ fontSize: 13 }}>{nodeState?.ownerShort ?? nodeView.controller_name}</div></div>
            {nodeState?.owned && nodeState.garrison !== undefined && <div className="item"><div className="k">节点守军</div><div className="v">{fmt(nodeState.garrison)}</div></div>}
            <div className="item"><div className="k">本州主官</div><div className="v" style={{ fontSize: 13 }}>{rv?.governorName ?? '未详'}</div></div>
            <div className="item"><div className="k">地方驻将</div><div className="v" style={{ fontSize: 13 }}>{nodeView.local_military || '—'}</div></div>
            <div className="item"><div className="k">州府</div><div className="v" style={{ fontSize: 13 }}>{nodeView.region}</div></div>
          </div>
          <div className="form-note">可见性规则：{nodeView.visibility_rule}</div>
        </div>
        <div className="rp-foot">
          {rv && (
            <button className="btn small" onClick={() => select({ type: 'region', id: rv.regionId })}>查看州府详情</button>
          )}
          {rv && !rv.owned && allowed.includes('scout') && (
            <button className="btn small" onClick={() => openOrders({ kind: 'scout', regionId: rv.regionId })}>遣斥候</button>
          )}
          {nodeTerritory && allowed.includes('move_army') && (
            <button className="btn small primary" onClick={() => openOrders({
              kind: 'move_army',
              targetRegionId: nodeTerritory.region_id,
              targetMapNodeId: nodeView.node_id,
            })}>令军前往此据点</button>
          )}
        </div>
      </>
    );
  }

  function overview() {
    return (
      <>
        <div className="rp-head">
          <div className="kicker">势力总览</div>
          <div className="title">{view!.own.shortName}</div>
          <div className="small muted">{view!.own.name} · {view!.playerPersonName}（{ROLE_LABEL[view!.playerRole]}）</div>
          <div style={{ display: 'flex', gap: 6, marginTop: 7, flexWrap: 'wrap' }}>
            <TraitChips tags={view!.own.statusTags} limit={8} />
          </div>
        </div>
        <div className="rp-body">
          <div className="subhead">国力</div>
          <div className="kv">
            <div className="item"><div className="k">控制州府</div><div className="v">{view!.own.controlCount}</div></div>
            <div className="item"><div className="k">野战兵力</div><div className="v">{fmt(view!.own.fieldTroops)}</div></div>
            <div className="item"><div className="k">行政效率</div><div className="v">{view!.own.adminEfficiency}</div></div>
            <div className="item"><div className="k">稳定</div><div className="v">{view!.own.stability}</div></div>
          </div>
          <div className="subhead">国情机制</div>
          {view!.special.cohesion !== undefined && (
            <>
              <StatLine label="联盟协调" value={view!.special.cohesion} mode="green" />
              <div className="small muted">可调动兵力按协调度折算，部落可能拒绝出兵。</div>
              {view!.special.tribes?.slice(0, 4).map((t) => (
                <div className="feed-row" key={t.tribeId}>
                  <span className="title">{t.name}</span>
                  <span className="summary">忠诚 {Math.round(t.loyalty)} · {t.stance === 'refusing' ? '拒命' : t.stance === 'reluctant' ? '观望' : t.stance === 'eager' ? '踊跃' : '听命'}</span>
                </div>
              ))}
            </>
          )}
          {view!.special.princes && (
            <>
              <StatLine label="朝局稳定" value={view!.special.courtStability ?? 0} mode="green" />
              {view!.special.princes.map((p) => (
                <div className="stat-line" key={p.personId}>
                  <span className="lbl" style={{ width: 70 }}>{p.name}</span>
                  <span className="bar"><i style={{ width: `${p.influence}%`, background: p.isCrownPrince ? 'var(--gold)' : undefined }} /></span>
                  <span className="num">{Math.round(p.influence)}</span>
                </div>
              ))}
            </>
          )}
          {view!.special.houses && (
            <>
              <StatLine label="世家支持" value={view!.special.centralAuthority ?? 0} mode="green" />
              {view!.special.houses.slice(0, 4).map((h) => (
                <div className="feed-row" key={h.houseId}>
                  <span className="title">{h.name}</span>
                  <span className="summary">支持 {Math.round(h.support)} · 税赋配合 {(h.taxCompliance * 100).toFixed(0)}%</span>
                </div>
              ))}
            </>
          )}
          <div className="subhead">当前悬而未决</div>
          {view!.pendingOrders.length === 0 ? (
            <div className="small muted">本旬尚未下达命令。可点击州府或部队，或打开命令面板。</div>
          ) : (
            view!.pendingOrders.map((o) => (
              <div className="order-mini" key={o.orderId}>
                <span className="kind">{ORDER_LABELS[o.kind]}</span>
                <span className="muted">{orderSummary(o)}</span>
              </div>
            ))
          )}
          <div className="subhead">操作提示</div>
          <div className="form-note">
            1. 选择州府查看产出与敌情；2. 选择部队下达行军/整军；3. 打开命令面板进行征募、征粮、贸易或政治协商；
            4. 点击「结束本旬」推进 7 天，NPC 同时行动；5. 战报与史官条目保留每一笔事实。
          </div>
        </div>
        <div className="rp-foot">
          <button className="btn small primary" disabled={Boolean(view!.outcome)} onClick={() => openOrders()}>下达命令</button>
          <button className="btn small" onClick={() => setNav('characters')}>人物</button>
          <button className="btn small" onClick={() => setNav('events')}>史官</button>
        </div>
      </>
    );
  }
}

function terrainLabel(t: string): string {
  return { plain: '平原', hill: '丘陵', mountain: '山地', forest: '森林', river: '河网' }[t] ?? t;
}

function intelStatusLabel(s: string): string {
  return { confirmed: '已证实', reliable: '较可靠', unconfirmed: '未证实', speculative: '推测' }[s] ?? s;
}

function regionName(mapData: any, id: string | null): string {
  if (!id) return '—';
  return mapData?.territories.find((t: any) => t.region_id === id)?.region ?? id;
}

function orderSummary(o: any): string {
  if (o.kind === 'move_army') return `${o.armyId} → ${o.targetRegionId}`;
  if (o.kind === 'trade') return `${o.resource} × ${o.amount}`;
  if (o.kind === 'appoint') return `${o.personId} @ ${o.regionId}`;
  if ('amount' in o) return `数量 ${o.amount}`;
  if ('regionId' in o) return o.regionId;
  if ('armyId' in o) return o.armyId;
  return '';
}
