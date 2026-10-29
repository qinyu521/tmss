import { useState } from 'react';
import { fmt, type CourtResolution, type CourtTopic } from '@tianming/shared';
import { useApp } from '../state/store';
import { Modal, StatLine } from '../components/ui';

export default function CourtPanel() {
  const view = useApp((s) => s.view);
  const events = useApp((s) => s.events);
  const setNav = useApp((s) => s.setNav);
  const openOrders = useApp((s) => s.openOrders);
  const submitOrders = useApp((s) => s.submitOrders);
  const busy = useApp((s) => s.busy);
  const [debateNote, setDebateNote] = useState('');
  if (!view) return null;
  const pendingDebate = view.pendingOrders.find((order) => order.kind === 'court_debate');
  const s = view.special;
  const submitDebate = async (topic: CourtTopic, resolution: CourtResolution) => {
    if (busy || pendingDebate) return;
    const result = await submitOrders([{
      orderId: `court-${view.gameId}-T${view.date.turn}`,
      kind: 'court_debate',
      topic,
      resolution,
    }]);
    setDebateNote(
      result.accepted
        ? '议案已列入本旬朝议。结束本旬后，列席官员将按人物能力与身份影响投票；未获通过的议案不会执行政策。'
        : result.issues.join('；') || '议案未提交。',
    );
  };
  const politicsEvents = events.filter((e) => ['politics', 'succession', 'scheme', 'shortage'].includes(e.type)).slice(0, 8);
  const topics: string[] = [];
  if (view.flags.successionCrisis) topics.push('大雍式夺嫡危机：皇子派系与军区开始站队，需尽快平衡或立储。');
  if (view.flags.tribalRefusal) topics.push('部落拒命：若干部落已拖延军令，需赏赐或谈判以恢复联盟协调。');
  if (view.flags.houseBoycott) topics.push('世家抵制：税赋与征兵受阻，需与世家协商或调整征调。');
  if (view.own.statusTags.includes('粮草紧张')) topics.push('军粮告急：征粮、贸易或缩短远征，避免士气与逃兵恶化。');
  if (view.own.statusTags.includes('缺盐')) topics.push('盐供应不足：影响军需与民生，可边市购入或争夺盐场。');
  if (view.own.statusTags.includes('缺战马')) topics.push('战马短缺：骑兵扩编受限，优先保护牧马地或用贸易补充。');
  if (topics.length === 0) topics.push('本旬无迫在眉睫的危机，可积蓄粮秣、整军或谋划边境。');

  return (
    <Modal
      title="朝廷 / 部落议政"
      subtitle={`${view.date.label} · ${view.own.shortName}`}
      onClose={() => setNav('map')}
    >
      <div className="form-note">
        三国国情机制不是说明文字，而是每回合参与结算的变量：协调度决定可调动兵力，皇子派系影响行政与征募，
        世家支持影响税赋与征兵。玩家的处置与资源短缺都会改变这些数值。
      </div>

      {s.tribes && (
        <>
          <div className="section-title">匈奴 · 部落联盟</div>
          <StatLine label="联盟协调" value={s.cohesion ?? 0} mode="green" />
          <div className="small muted" style={{ marginBottom: 8 }}>
            名义 40 万不能全部转化为同一指挥下的野战兵力。协调度越低，可统一调动比例越低；忠诚低至拒命阈值时，该部驻地部队将拒绝执行行军命令。
          </div>
          <table className="table">
            <thead><tr><th>部落</th><th>首领</th><th>驻地</th><th>忠诚</th><th>兵力名册</th><th>态度</th><th>诉求</th><th></th></tr></thead>
            <tbody>
              {s.tribes.map((t) => (
                <tr key={t.tribeId}>
                  <td>{t.name}</td>
                  <td>{t.chiefName}</td>
                  <td>{view.regions.find((r) => r.regionId === t.regionId)?.name ?? t.regionId}</td>
                  <td className={t.loyalty < 38 ? 'danger-text' : t.loyalty < 50 ? 'gold' : ''}>{Math.round(t.loyalty)}</td>
                  <td>{fmt(t.troops)}</td>
                  <td>{t.stance === 'refusing' ? '拒命' : t.stance === 'reluctant' ? '拖延' : t.stance === 'watchful' ? '观望' : '听命'}</td>
                  <td className="small muted">{t.demand}</td>
                  <td>
                    <button className="btn small" onClick={() => openOrders({ kind: 'appease_tribe' })}>赏赐</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {s.princes && (
        <>
          <div className="section-title">大雍 · 皇子与朝局</div>
          <StatLine label="朝局稳定" value={s.courtStability ?? 0} mode="green" />
          <div className="small muted" style={{ marginBottom: 8 }}>
            皇子派系会争夺任命、军费、声望与皇帝信任。稳定度低于 34 触发夺嫡危机：行政效率与征募成本恶化，军区可能站队。
          </div>
          <div className="sheet-grid">
            {s.princes.map((p) => (
              <div className="card" key={p.personId}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <strong style={{ fontFamily: 'var(--font-display)', fontSize: 15 }}>{p.name}</strong>
                  {p.isCrownPrince && <span className="chip gold">储君</span>}
                </div>
                <div className="small muted" style={{ marginTop: 4 }}>影响力 {Math.round(p.influence)} · 野心 {Math.round(p.ambition)} · 皇帝信任 {Math.round(p.trust)}</div>
                <div className="bar" style={{ marginTop: 6 }}><i style={{ width: `${p.influence}%` }} /></div>
                <div className="small muted" style={{ marginTop: 6 }}>支持者：{p.supporters.join('、') || '尚未公开结党'}</div>
                <div className="small muted">议程：{p.agenda}</div>
              </div>
            ))}
          </div>
          <div style={{ marginTop: 10 }}>
            <button className="btn primary" onClick={() => openOrders({ kind: 'balance_princes' })}>平衡皇子派系（耗银）</button>
          </div>
        </>
      )}

      {s.houses && (
        <>
          <div className="section-title">大楚 · 世家掣肘</div>
          <StatLine label="中央权威/世家支持" value={s.centralAuthority ?? 0} mode="green" />
          <div className="small muted" style={{ marginBottom: 8 }}>
            世家控制土地、户籍、粮仓、盐场与商路。支持度影响税赋配合与征兵；强征能短期获得钱粮，但会压低支持并可能导致集体抵制。
          </div>
          <table className="table">
            <thead><tr><th>世家</th><th>家主</th><th>根基</th><th>支持</th><th>税赋配合</th><th>私兵</th><th>诉求</th><th></th></tr></thead>
            <tbody>
              {s.houses.map((h) => (
                <tr key={h.houseId}>
                  <td>{h.name}</td>
                  <td>{h.patriarchName}</td>
                  <td>{view.regions.find((r) => r.regionId === h.regionId)?.name ?? h.regionId}</td>
                  <td>{Math.round(h.support)}</td>
                  <td>{(h.taxCompliance * 100).toFixed(0)}%</td>
                  <td>{fmt(h.privateForce)}</td>
                  <td className="small muted">{h.agenda}（宿敌：{h.rival || '无'}）</td>
                  <td><button className="btn small" onClick={() => openOrders({ kind: 'negotiate_house' })}>协商</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <div className="section-title">本旬朝议议题</div>
      <div className="card small" style={{ lineHeight: 1.8 }}>
        {topics.map((t, i) => <div key={i}>· {t}</div>)}
      </div>

      <div className="section-title">正式朝议 · 提出一项议案</div>
      <div className="form-note">
        每旬最多提出一项。五名列席官员按能力画像形成赞成或反对立场；君主拥有额外裁决权，州牧、将军、军师在各自擅长议题上更有影响。
        议案必须经投票通过才会生效；用兵、赋税和派系处置都有实际代价。
      </div>
      {pendingDebate ? (
        <div className="card small" style={{ lineHeight: 1.8 }}>
          <strong>本旬已有待议案</strong>
          <div>议题：{pendingDebate.topic === 'military' ? '军务与战备' : pendingDebate.topic === 'taxation' ? '赋役与民生' : '派系与朝局'}</div>
          <div>主张：{pendingDebate.resolution === 'mobilize' ? '积极用兵' : pendingDebate.resolution === 'consolidate' ? '整军休养' : pendingDebate.resolution === 'raise' ? '加征军需税' : pendingDebate.resolution === 'relieve' ? '蠲免赋役' : pendingDebate.resolution === 'balance' ? '协调各派' : '扶持主导派系'}</div>
          <div className="muted">结束本旬后才会计票；本旬不能重复提出第二项。</div>
        </div>
      ) : (
        <div className="sheet-grid">
          <div className="card">
            <strong>一、军务与战备</strong>
            <div className="small muted" style={{ margin: '6px 0 10px', lineHeight: 1.7 }}>积极用兵提升士气与训练，但消耗军费和粮秣；整军休养能恢复补给、降低疲劳。</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <button className="btn small primary" disabled={busy} onClick={() => void submitDebate('military', 'mobilize')}>积极用兵 · 银 12,000 / 粮 15,000</button>
              <button className="btn small" disabled={busy} onClick={() => void submitDebate('military', 'consolidate')}>整军休养 · 银 4,000</button>
            </div>
          </div>
          <div className="card">
            <strong>二、赋役与民生</strong>
            <div className="small muted" style={{ margin: '6px 0 10px', lineHeight: 1.7 }}>加征军需税可取得收入，但地方治安、民心及利益集团支持会下降；蠲免赋役则需要国库承担成本。</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <button className="btn small primary" disabled={busy} onClick={() => void submitDebate('taxation', 'raise')}>加征军需税 · 最多三州</button>
              <button className="btn small" disabled={busy} onClick={() => void submitDebate('taxation', 'relieve')}>蠲免赋役 · 银 15,000</button>
            </div>
          </div>
          <div className="card">
            <strong>三、派系与朝局</strong>
            <div className="small muted" style={{ margin: '6px 0 10px', lineHeight: 1.7 }}>
              协调各派会照顾最弱势的政治集团；扶持主导派系能在短期内增强核心盟友，但会扩大内部差距。
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <button className="btn small primary" disabled={busy} onClick={() => void submitDebate('factions', 'balance')}>协调各派</button>
              <button className="btn small" disabled={busy} onClick={() => void submitDebate('factions', 'patronize')}>扶持主导派系</button>
            </div>
          </div>
        </div>
      )}
      {debateNote && <div className="form-note">{debateNote}</div>}
      <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
        <button className="btn small primary" onClick={() => openOrders()}>其他政务命令</button>
        <button className="btn small" onClick={() => setNav('events')}>查看近期朝局记录</button>
      </div>

      <div className="section-title">近期朝局与战事密报</div>
      {politicsEvents.length === 0 ? (
        <div className="empty">暂无朝局记录。推进一旬后，政治动向、计谋与短缺会记录在此。</div>
      ) : (
        <table className="table">
          <thead><tr><th>日期</th><th>类型</th><th>事项</th><th>摘要</th></tr></thead>
          <tbody>
            {politicsEvents.map((e) => (
              <tr key={e.eventId}>
                <td>{e.dateLabel.replace('天命', '')}</td>
                <td>{e.type === 'succession' ? '夺嫡' : e.type === 'scheme' ? '计谋' : e.type === 'shortage' ? '短缺' : '朝局'}</td>
                <td>{e.title}</td>
                <td className="muted small">{e.summary}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="section-title">外邦朝局（仅公开情报）</div>
      <div className="sheet-grid">
        {view.factions.filter((f) => f.key !== view.factionKey).map((f) => (
          <div className="card small" key={f.key}>
            <div className="gold">{f.shortName}</div>
            <div className="muted">控制 {f.regionsCount} 州 · {f.stance} · 兵力 {f.troopsLabel}</div>
            <div className="muted">内部派系与朝局细节须通过使节、商路传闻与情报网获取，不能直接查看。</div>
          </div>
        ))}
      </div>

      <div className="form-note" style={{ marginTop: 14 }}>
        所有政治行动都会产生唯一事件记录（含前后状态与证据）。史官只能记录结果，不能改动事实。
      </div>
    </Modal>
  );
}
