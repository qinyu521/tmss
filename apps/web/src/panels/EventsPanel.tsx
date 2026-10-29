import { useMemo, useState } from 'react';
import type { BattleReplay } from '@tianming/shared';
import { useApp } from '../state/store';
import { api } from '../api/client';
import { Empty, Modal } from '../components/ui';
import BattleReplayModal from '../components/BattleReplay';

const TYPE_LABELS: Record<string, string> = {
  turn_start: '旬始', season: '时令', resource: '账本', shortage: '短缺', order_accepted: '政令', order_rejected: '驳回',
  army_move: '行军', battle: '战斗', occupation: '易帜', politics: '朝局', succession: '夺嫡',
  scheme: '计谋', recruit: '征兵', intel: '情报', npc_action: '他国动向', diplomacy: '外交', chronicle: '史官',
  endgame: '终局',
};

export default function EventsPanel() {
  const view = useApp((s) => s.view);
  const events = useApp((s) => s.events);
  const chronicle = useApp((s) => s.chronicle);
  const config = useApp((s) => s.config);
  const gameId = useApp((s) => s.gameId);
  const refreshGame = useApp((s) => s.refreshGame);
  const notify = useApp((s) => s.notify);
  const setNav = useApp((s) => s.setNav);
  const select = useApp((s) => s.select);
  const [tab, setTab] = useState<'events' | 'chronicle'>('events');
  const [type, setType] = useState('all');
  const [turn, setTurn] = useState('');
  const [llmBusy, setLlmBusy] = useState(false);
  const [llmError, setLlmError] = useState('');
  const [replay, setReplay] = useState<BattleReplay | null>(null);
  const [replayBusy, setReplayBusy] = useState('');

  const filtered = useMemo(
    () =>
      events.filter(
        (e) => (type === 'all' || e.type === type) && (!turn || String(e.turn) === turn),
      ),
    [events, type, turn],
  );

  // 「本旬」以史官最新条目的回合为准（结算后日期已推进到下一旬）
  const latestChronicleTurn = chronicle[0]?.turn;

  if (!view) return null;

  const polishWithLlm = async () => {
    if (!gameId || latestChronicleTurn == null) return;
    setLlmBusy(true);
    setLlmError('');
    try {
      const res = await api.polishChronicleLlm(gameId, latestChronicleTurn);
      await refreshGame();
      notify(`AI 史官已润色 ${res.updated} 条本旬记录（事实层未改动）`, 'success');
    } catch (err: any) {
      setLlmError(err?.message ?? 'AI 润色失败');
    } finally {
      setLlmBusy(false);
    }
  };

  const openReplay = async (eventId: string) => {
    if (!gameId) return;
    setReplayBusy(eventId);
    try {
      const res = await api.battleReplay(gameId, eventId);
      setReplay(res.replay);
    } catch (err: any) {
      notify(err?.message ?? '战报回放加载失败', 'error');
    } finally {
      setReplayBusy('');
    }
  };

  const jump = (targetId: string, targetLabel: string) => {
    const region = view.regions.find((r) => r.regionId === targetId || r.name === targetLabel);
    const army = view.armies.find((a) => a.armyId === targetId);
    if (region) {
      select({ type: 'region', id: region.regionId });
      setNav('map');
    } else if (army) {
      select({ type: 'army', id: army.armyId });
      setNav('map');
    }
  };

  return (
    <>
    <Modal
      title="事件日志与 AI 史官"
      subtitle="事实层由规则引擎生成；文学表达不得改写事实"
      onClose={() => setNav('map')}
      width={1280}
      tabs={[
        { key: 'events', label: '规则事件' },
        { key: 'chronicle', label: '史官记录' },
      ]}
      activeTab={tab}
      onTab={(k) => setTab(k as any)}
    >
      {tab === 'events' && (
        <>
          <div className="form-row" style={{ flexWrap: 'wrap' }}>
            <label>类型</label>
            <select value={type} onChange={(e) => setType(e.target.value)} style={{ maxWidth: 180 }}>
              <option value="all">全部</option>
              {Object.entries(TYPE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
            <label>回合</label>
            <input value={turn} placeholder="如 2" style={{ maxWidth: 100 }} onChange={(e) => setTurn(e.target.value.replace(/\D/g, ''))} />
            <span className="muted small" style={{ marginLeft: 'auto' }}>共 {filtered.length} 条（仅显示玩家可见事件）</span>
          </div>
          {filtered.length === 0 && <Empty>暂无符合条件的事件。推进回合后，规则结算会生成唯一事件。</Empty>}
          {filtered.map((e) => (
            <div className="event-row" key={e.eventId}>
              <div>
                <div className="small muted">{e.dateLabel}</div>
                <div className="small" style={{ color: 'var(--gold-soft)' }}>{TYPE_LABELS[e.type] ?? e.type}</div>
              </div>
              <div className="small muted">{e.factionKey === 'NEUTRAL' ? '诸国' : e.actorName}</div>
              <div>
                <div className="e-title">{e.title}</div>
                <div className="e-summary">{e.summary}</div>
                {e.type === 'battle' && (
                  <div className="small muted" style={{ marginTop: 4, lineHeight: 1.7 }}>
                    兵力比 {(e.payload as any)?.attackerPower ?? '—'} : {(e.payload as any)?.defenderPower ?? '—'}
                    {(e.payload as any)?.attackerCommander && ` · 攻方 ${(e.payload as any).attackerCommander.name}（统率 ${(e.payload as any).attackerCommander.command} / 谋略 ${(e.payload as any).attackerCommander.strategy}）`}
                    {(e.payload as any)?.defenderCommander && ` · 守方 ${(e.payload as any).defenderCommander.name}（统率 ${(e.payload as any).defenderCommander.command} / 谋略 ${(e.payload as any).defenderCommander.strategy}）`}
                    {(e.payload as any)?.maneuverBonus > 0 && ' · 骑兵迂回'}
                    {(e.payload as any)?.ambushBonus > 0 && ' · 伏兵'}
                    {(e.payload as any)?.diversionBonus > 0 && ' · 佯攻'}
                    {' · 种子 '}{(e.payload as any)?.seed ?? '—'}
                  </div>
                )}
                {e.type === 'scheme' && (
                  <div className="small" style={{ marginTop: 4, color: 'var(--gold-soft)' }}>
                    成功率 {(e.payload as any)?.chance ?? '—'}%，判定 {(e.payload as any)?.roll ?? '—'} · {(e.payload as any)?.success ? '计成' : '被识破'}
                  </div>
                )}
                {(e.targetId || e.targetLabel) && (
                  <button className="btn small ghost" style={{ marginTop: 4 }} onClick={() => jump(e.targetId, e.targetLabel)}>
                    定位：{e.targetLabel || e.targetId}
                  </button>
                )}
                {e.type === 'battle' && (
                  <button
                    className="btn small"
                    style={{ marginTop: 4, marginLeft: 6 }}
                    disabled={replayBusy === e.eventId}
                    onClick={() => openReplay(e.eventId)}
                  >
                    {replayBusy === e.eventId ? '载入中…' : '回放'}
                  </button>
                )}
              </div>
              <div className="e-evidence">{e.evidence}<br />#{e.eventId}</div>
            </div>
          ))}
        </>
      )}

      {tab === 'chronicle' && (
        <>
          {config?.llmEnabled && latestChronicleTurn != null && (
            <div className="form-row" style={{ alignItems: 'center' }}>
              <button className="btn small" disabled={llmBusy} onClick={polishWithLlm}>
                {llmBusy ? 'AI 史官润色中…' : 'AI 润色本旬'}
              </button>
              <span className="muted small">仅改写文学润色与推断层；事实层由规则引擎生成，永不改动。</span>
              {llmError && <span className="small" style={{ color: 'var(--red, #c66)' }}>{llmError}</span>}
            </div>
          )}
          {chronicle.length === 0 && <Empty>史官尚未落笔。完成一次回合结算后，将生成编年、列传与史论。</Empty>}
          {chronicle.map((c) => (
            <div className="chronicle-entry" key={c.entryId}>
              <div className="c-title">
                {c.title}
                <span className="layer-badge">{c.kind === 'biography' ? '列传' : c.kind === 'analysis' ? '史论' : '编年'}</span>
                <span className="layer-badge">{c.dateLabel}</span>
                <span className="layer-badge">{c.generatedBy === 'llm' ? 'AI 润色' : '模板'}</span>
              </div>
              <div className="c-facts"><strong className="gold">〔事实〕</strong>{c.facts}</div>
              {c.literary && <div className="c-lit">〔文学润色，不改变事实〕{c.literary}</div>}
              {c.inference && <div className="c-infer">〔史官推断〕{c.inference}</div>}
              <div className="small muted" style={{ marginTop: 4 }}>依据事件：{c.sourceEventIds.join('、')}</div>
            </div>
          ))}
        </>
      )}
    </Modal>
    {replay && <BattleReplayModal replay={replay} onClose={() => setReplay(null)} />}
    </>
  );
}
