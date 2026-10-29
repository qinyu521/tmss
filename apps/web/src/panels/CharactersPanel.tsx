import { useEffect, useState } from 'react';
import { FACTION_VISUALS, ROLE_LABEL } from '@tianming/shared';
import { api, type CharacterSummary } from '../api/client';
import { useApp } from '../state/store';
import { Empty, Modal, Portrait } from '../components/ui';

export default function CharactersPanel() {
  const view = useApp((s) => s.view);
  const setNav = useApp((s) => s.setNav);
  const [faction, setFaction] = useState<string>(view?.factionKey ?? 'HUN');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<CharacterSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [active, setActive] = useState<string | null>(null);
  const [detail, setDetail] = useState<any>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .characters({ faction, q, page: String(page), pageSize: '36', ...(view?.gameId ? { gameId: view.gameId } : {}) })
      .then((res) => {
        if (cancelled) return;
        setItems(res.items);
        setTotal(res.total);
        if (!active && res.items[0]) setActive(res.items[0].person_id);
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [faction, page, q, view?.gameId]);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    api
      .character(active, view?.gameId)
      .then((data) => !cancelled && setDetail(data))
      .catch(() => !cancelled && setDetail(null));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, view?.gameId]);

  if (!view) return null;
  const c = detail?.character;
  const runtime = detail?.runtime as {
    alive?: boolean;
    deathCause?: string;
    growthNote?: string;
    militaryLoyalty?: number;
    defectionWarningTurn?: number;
    defectionTargetFaction?: string;
    allegianceFaction?: string;
  } | null | undefined;
  const currentFactionKey = (detail?.currentFactionKey ?? c?.faction_key ?? 'HUN') as 'HUN' | 'YONG' | 'CHU';
  const currentFactionVisual = FACTION_VISUALS[currentFactionKey];
  const originalFactionKey = detail?.originalFactionKey as string | undefined;

  return (
    <Modal
      title="人物檔案"
      subtitle={`共 ${total} 人 · 原型只作设计参考，人物为原创`}
      onClose={() => setNav('map')}
      width={1320}
    >
      <div style={{ display: 'grid', gridTemplateColumns: '380px minmax(0,1fr)', gap: 18 }}>
        <div>
          <div className="form-row">
            <label>势力</label>
            <select value={faction} onChange={(e) => { setFaction(e.target.value); setPage(1); setActive(null); }}>
              <option value="HUN">匈奴</option>
              <option value="YONG">大雍</option>
              <option value="CHU">大楚</option>
            </select>
          </div>
          <div className="form-row">
            <label>检索</label>
            <input value={q} placeholder="姓名 / 职位 / 关键词" onChange={(e) => { setQ(e.target.value); setPage(1); setActive(null); }} />
          </div>
          <div className="small muted" style={{ marginBottom: 6 }}>
            第 {page} 页 · {loading ? '载入中…' : `${items.length} / ${total}`}
          </div>
          <div className="scroll" style={{ maxHeight: 'calc(88vh - 240px)', paddingRight: 4 }}>
            {items.map((it) => (
              <button
                key={it.person_id}
                className={`char-card ${active === it.person_id ? 'selected' : ''}`}
                style={{ width: '100%', marginBottom: 6, borderColor: active === it.person_id ? 'var(--gold)' : undefined }}
                onClick={() => setActive(it.person_id)}
              >
                <Portrait personId={it.person_id} size="sm" alt={it.name} deceased={it.alive === false} />
                <div style={{ minWidth: 0 }}>
                  <div className="cc-name">
                    {it.name}
                    {it.defectionWarningTurn !== undefined && it.defectionTargetFaction && (
                      <span style={{ marginLeft: 6, fontSize: 11, padding: '1px 6px', border: '1px solid var(--danger)', borderRadius: 3, color: 'var(--danger)' }}>
                        {it.allegianceFaction ? '归附动摇' : '倒戈预警'}
                      </span>
                    )}
                    {it.originalFactionKey && it.allegianceFaction && (
                      <span style={{ marginLeft: 6, fontSize: 11, padding: '1px 6px', border: '1px solid var(--gold)', borderRadius: 3, color: 'var(--gold)' }}>
                        已倒戈
                      </span>
                    )}
                    {it.alive === false && (
                      <span style={{ marginLeft: 6, fontSize: 11, padding: '1px 6px', border: '1px solid var(--line)', borderRadius: 3, opacity: 0.75 }}>已故{it.deathCause ? `·${it.deathCause}` : ''}</span>
                    )}
                  </div>
                  <div className="cc-pos">{it.current_position_standard}</div>
                  <div className="cc-meta">
                    {it.identity_type} · {it.region} · 忠诚 {it.loyalty}
                    {it.militaryLoyalty !== undefined ? ` · 军令忠诚 ${Math.round(it.militaryLoyalty)}` : ''}
                  </div>
                </div>
              </button>
            ))}
            {items.length === 0 && !loading && <Empty>没有符合条件的人物。</Empty>}
          </div>
          <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
            <button className="btn small" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>上一页</button>
            <button className="btn small" disabled={page * 36 >= total} onClick={() => setPage((p) => p + 1)}>下一页</button>
          </div>
        </div>

        <div className="detail-grid" style={{ gridTemplateColumns: '190px minmax(0,1fr)' }}>
          <div>
            {active && <Portrait personId={active} size="lg" alt={c?.name} deceased={runtime?.alive === false} />}
            {c && (
              <>
                <div className="pc-name" style={{ marginTop: 10, fontSize: 20 }}>
                  {c.name}
                  {runtime?.alive === false && (
                    <span style={{ marginLeft: 8, fontSize: 12, padding: '1px 8px', border: '1px solid var(--line)', borderRadius: 3, opacity: 0.8 }}>已故{runtime.deathCause ? ` · ${runtime.deathCause}` : ''}</span>
                  )}
                </div>
                <div className="small" style={{ color: currentFactionVisual.mapBorder }}>
                  {currentFactionVisual.shortName} · 当前效忠 · {c.status}
                </div>
                {originalFactionKey && originalFactionKey !== currentFactionKey && (
                  <div className="small" style={{ color: 'var(--gold)', marginTop: 4 }}>
                    原归属：{FACTION_VISUALS[originalFactionKey as 'HUN' | 'YONG' | 'CHU']?.shortName ?? originalFactionKey}
                    {' → '}现效忠：{currentFactionVisual.shortName}
                  </div>
                )}
                {runtime?.defectionWarningTurn !== undefined && !runtime.allegianceFaction && (
                  <div className="card small" style={{ marginTop: 8, borderColor: 'var(--danger)', color: 'var(--danger)', lineHeight: 1.65 }}>
                    倒戈风险预警：军令忠诚 {Math.round(runtime.militaryLoyalty ?? c.loyalty)}。
                    {runtime.defectionTargetFaction
                      ? `与敌对势力 ${FACTION_VISUALS[runtime.defectionTargetFaction as 'HUN' | 'YONG' | 'CHU']?.shortName ?? runtime.defectionTargetFaction} 存在强关系。`
                      : '存在明确的敌对势力关系。'}
                    请在下一旬前赏赐将领或更换统将。
                  </div>
                )}
                <div className="small muted" style={{ marginTop: 6, lineHeight: 1.7 }}>
                  {c.identity_type}<br />
                  {c.current_position_standard}<br />
                  {c.region} · {c.house_or_clan || '无世家归属'}
                </div>
                <div className="divider" />
                <div className="small muted">性别/年龄：{c.gender} · {c.age_band}</div>
                <div className="small muted">原型：{c.historical_archetype}（{c.archetype_id}）</div>
                {runtime?.growthNote && <div className="small" style={{ color: 'var(--gold)' }}>{runtime.growthNote}</div>}
              </>
            )}
          </div>

          <div>
            {!c && <Empty>从左侧选择人物查看档案。</Empty>}
            {c && (
              <>
                <div className="attr-grid">
                  {(['governance', 'command', 'strategy', 'intrigue', 'commerce', 'loyalty', 'potential'] as const).map((k) => {
                    const labels: Record<string, string> = { governance: '治理', command: '统率', strategy: '谋略', intrigue: '权谋', commerce: '经商', loyalty: '忠诚', potential: '潜力' };
                    const grown = (detail?.runtime?.attrs as Record<string, number> | undefined)?.[k];
                    return (
                      <div className="attr" key={k}>
                        <div className="k">{labels[k]}</div>
                        <div className="v">{grown ?? c[k]}{grown !== undefined ? ' ↑' : ''}</div>
                      </div>
                    );
                  })}
                </div>

                <div className="section-title">原型借鉴与风险</div>
                <div className="card small" style={{ lineHeight: 1.75 }}>
                  <div>历史原型：<span className="gold">{c.historical_archetype}</span>（{detail?.archetype?.era_or_state}）</div>
                  <div className="muted">借鉴特质：{c.archetype_trait}</div>
                  <div className="muted">原型风险：{c.archetype_risk}</div>
                  <div className="muted" style={{ marginTop: 6 }}>{c.archetype_affinity_note}</div>
                  {detail?.audit?.match_status && detail.audit.match_status !== '主归属一致' && (
                    <div className="danger-text" style={{ marginTop: 6 }}>
                      审计提示：{detail.audit.match_status}。该记录仅作核对，不改写任何原始数据。
                    </div>
                  )}
                  {detail?.coreConflict?.conflict && (
                    <div className="danger-text" style={{ marginTop: 6 }}>
                      原型归属差异：按用户既定核心归属，{c.historical_archetype} 期望归属 {detail.coreConflict.expectedFaction}。
                      种子数据未改，仅作核对提示。
                    </div>
                  )}
                </div>

                <div className="section-title">任职与关系</div>
                <div className="sheet-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))' }}>
                  {detail?.appointment && (
                    <div className="card small">
                      <div className="gold">{detail.appointment.standard_position}</div>
                      <div className="muted">{detail.appointment.institution_type} · {detail.appointment.region_or_station}</div>
                      <div className="muted">权限：{detail.appointment.authority_scope}</div>
                    </div>
                  )}
                  {detail?.house && (
                    <div className="card small">
                      <div className="gold">{detail.house.house_name} · 世家</div>
                      <div className="muted">{detail.house.assets_and_network}</div>
                      <div className="muted">诉求：{detail.house.current_agenda}</div>
                    </div>
                  )}
                  {detail?.warlord && (
                    <div className="card small">
                      <div className="gold">{detail.warlord.warlord_group} · 军阀/藩镇</div>
                      <div className="muted">{detail.warlord.force_composition} · 中央忠诚 {detail.warlord.central_loyalty}</div>
                      <div className="muted">诉求：{detail.warlord.current_aim}</div>
                    </div>
                  )}
                  {detail?.title && (
                    <div className="card small">
                      <div className="gold">{detail.title.noble_title} · 爵位</div>
                      <div className="muted">{detail.title.origin_of_rank} · {detail.title.rights_and_limits}</div>
                    </div>
                  )}
                  {detail?.territory && (
                    <div className="card small">
                      <div className="gold">{detail.territory.region} · 州府任职</div>
                      <div className="muted">{detail.territory.regional_profile}</div>
                      <div className="muted">风险：{detail.territory.risk}</div>
                    </div>
                  )}
                </div>

                <div className="section-title">人物关系</div>
                {detail?.relationships?.length ? (
                  <table className="table">
                    <thead><tr><th>关系</th><th>对象</th><th>强度</th><th>备注</th></tr></thead>
                    <tbody>
                      {detail.relationships.map((r: any, i: number) => {
                        const otherId = r.source_person_id === c.person_id ? r.target_person_id : r.source_person_id;
                        const otherName = r.source_person_id === c.person_id ? r.target_name : r.source_name;
                        return (
                          <tr key={i} style={{ cursor: 'pointer' }} onClick={() => setActive(otherId)}>
                            <td>{r.relation}</td>
                            <td className="gold">{otherName}</td>
                            <td>{r.strength}</td>
                            <td className="muted">{r.notes}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                ) : (
                  <div className="small muted">无记录在册的关系。</div>
                )}

                <div className="form-note">
                  人物不是全知的：他/她只能依据职位、亲历、奏报与关系网获得情报。属性与关系会影响规则结算，
                  但不会自动改写战果、财政或领土。
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}
