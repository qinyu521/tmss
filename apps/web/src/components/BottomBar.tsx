import { useState } from 'react';
import { ORDER_LABELS } from '@tianming/shared';
import { useApp } from '../state/store';

const TYPE_LABELS: Record<string, string> = {
  turn_start: '旬始',
  season: '时令',
  resource: '账本',
  shortage: '短缺',
  order_accepted: '政令',
  order_rejected: '驳回',
  army_move: '行军',
  battle: '战报',
  occupation: '易帜',
  politics: '朝局',
  succession: '夺嫡',
  scheme: '计谋',
  recruit: '征兵',
  intel: '情报',
  npc_action: '他国',
  diplomacy: '外交',
  chronicle: '史官',
};

export default function BottomBar() {
  const view = useApp((s) => s.view);
  const events = useApp((s) => s.events);
  const chronicle = useApp((s) => s.chronicle);
  const cancelOrder = useApp((s) => s.cancelOrder);
  const openOrders = useApp((s) => s.openOrders);
  const [tab, setTab] = useState<'orders' | 'report' | 'chronicle'>('report');
  if (!view) return null;

  return (
    <div className="bottom-bar">
      <div className="bb-left">
        <div className="bb-tabs">
          <button className={tab === 'orders' ? 'active' : ''} onClick={() => setTab('orders')}>命令</button>
          <button className={tab === 'report' ? 'active' : ''} onClick={() => setTab('report')}>战报</button>
          <button className={tab === 'chronicle' ? 'active' : ''} onClick={() => setTab('chronicle')}>史官</button>
        </div>
        <div className="small muted">
          {tab === 'orders' ? `待结算 ${view.pendingOrders.length} 条` : tab === 'report' ? `近期 ${events.length} 条` : `史官 ${chronicle.length} 条`}
        </div>
        <div style={{ marginTop: 'auto', display: 'flex', gap: 6 }}>
          <button className="btn small primary" onClick={() => openOrders()}>下达命令</button>
        </div>
      </div>

      <div className="bb-feed">
        {tab === 'orders' && (
          view.pendingOrders.length === 0 ? (
            <div className="empty">本旬尚未下达命令。命令会在「结束本旬」时统一校验并结算。</div>
          ) : (
            view.pendingOrders.map((o) => (
              <div className="order-mini" key={o.orderId} style={{ padding: '4px 0', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                <span className="kind">{ORDER_LABELS[o.kind] ?? o.kind}</span>
                <span className="muted">{describe(o)}</span>
                <button className="x" title="撤销命令" onClick={() => void cancelOrder(o.orderId)}>✕</button>
              </div>
            ))
          )
        )}

        {tab === 'report' && (
          events.length === 0 ? <div className="empty">尚无战报。结束本旬后此处会列出规则引擎结算的事件。</div> :
            events.slice(0, 40).map((e) => (
              <div className={`feed-row ${e.type}`} key={e.eventId}>
                <span className="date">{e.dateLabel.replace('天命', '')}</span>
                <span className="type">{TYPE_LABELS[e.type] ?? e.type}</span>
                <span className="title">{e.title}</span>
                <span className="summary">{e.summary}</span>
              </div>
            ))
        )}

        {tab === 'chronicle' && (
          chronicle.length === 0 ? <div className="empty">史官尚未落笔。每旬结算后生成事实摘要与文学条目。</div> :
            chronicle.slice(0, 30).map((c) => (
              <div className="feed-row" key={c.entryId} style={{ alignItems: 'flex-start' }}>
                <span className="date">{c.dateLabel.replace('天命', '')}</span>
                <span className="type">{c.kind === 'biography' ? '列传' : c.kind === 'analysis' ? '史论' : '编年'}</span>
                <span className="title">{c.title}</span>
                <span className="summary" style={{ whiteSpace: 'normal', color: 'var(--ink-dim)' }}>
                  {c.facts}
                  {c.literary && <em style={{ color: '#a99a7d' }}>　〔文学润色〕{c.literary}</em>}
                  {c.inference && <span style={{ color: 'var(--gold-soft)' }}>　〔史官推断〕{c.inference}</span>}
                </span>
              </div>
            ))
        )}
      </div>

      <div className="bb-right">
        <div className="small muted">本旬待结算命令</div>
        {view.pendingOrders.length === 0 ? (
          <div className="small muted">无</div>
        ) : (
          view.pendingOrders.slice(0, 3).map((o) => (
            <div className="order-mini" key={o.orderId}>
              <span className="kind">{ORDER_LABELS[o.kind]}</span>
              <span className="muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{describe(o)}</span>
              <button className="x" onClick={() => void cancelOrder(o.orderId)}>✕</button>
            </div>
          ))
        )}
        <div className="divider" />
        <div className="small muted">状态：{view.flags.successionCrisis ? '大雍夺嫡危机' : view.flags.tribalRefusal ? '匈奴部落拒命' : view.flags.houseBoycott ? '大楚世家抵制' : '暂无重大危机'}</div>
      </div>
    </div>
  );
}

function describe(o: any): string {
  if (o.kind === 'move_army') return `${o.armyId} → ${o.targetRegionId}`;
  if (o.kind === 'recruit') return `征募 ${o.amount} 人`;
  if (o.kind === 'levy_grain') return `征粮 ${o.amount} 州`;
  if (o.kind === 'levy_tax') return `加征 ${o.amount} 州`;
  if (o.kind === 'trade') return `${o.resource} × ${o.amount}`;
  if (o.kind === 'appease_tribe') return `${o.tribeId} · ${o.amount} 两`;
  if (o.kind === 'negotiate_house') return `${o.houseId}`;
  if (o.kind === 'appoint') return `${o.personId} → ${o.regionId}`;
  if (o.kind === 'scout') return o.regionId;
  if (o.kind === 'rest_army') return o.armyId;
  if (o.kind === 'balance_princes') return '平衡皇子派系';
  return '';
}
