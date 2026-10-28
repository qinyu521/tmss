import { useEffect, useState } from 'react';
import { FACTION_VISUALS, fmt, type BattleReplay, type FactionKey } from '@tianming/shared';
import { Modal } from './ui';

const PLAY_INTERVAL_MS = 1800;

/** 战报回放模态框：按阶段自动播放/手动步进，兵力与士气随阶段推进变化。 */
export default function BattleReplayModal({ replay, onClose }: { replay: BattleReplay; onClose: () => void }) {
  const [idx, setIdx] = useState(0);
  const [playing, setPlaying] = useState(true);
  const lastIndex = replay.stages.length - 1;

  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => {
      setIdx((i) => Math.min(i + 1, lastIndex));
    }, PLAY_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [playing, lastIndex]);

  useEffect(() => {
    if (idx >= lastIndex) setPlaying(false);
  }, [idx, lastIndex]);

  const stage = replay.stages[idx];
  const atkVisual = FACTION_VISUALS[replay.attackerFaction as FactionKey];
  const defVisual = FACTION_VISUALS[replay.defenderFaction as FactionKey];
  const atkColor = atkVisual?.primary ?? 'var(--gold)';
  const defColor = defVisual?.primary ?? 'var(--muted)';
  const atkPct = replay.initialAttackerTroops > 0 ? (stage.attackerTroops / replay.initialAttackerTroops) * 100 : 0;
  const defPct = replay.initialDefenderTroops > 0 ? (stage.defenderTroops / replay.initialDefenderTroops) * 100 : 0;
  // 战场上每个剪影代表一支小队，而不是按人头逐一渲染；数量随回放阶段的剩余兵力变化。
  const formationSize = 18;
  const visibleAttackers = replay.initialAttackerTroops > 0
    ? Math.round((stage.attackerTroops / replay.initialAttackerTroops) * formationSize)
    : 0;
  const visibleDefenders = replay.initialDefenderTroops > 0
    ? Math.round((stage.defenderTroops / replay.initialDefenderTroops) * formationSize)
    : 0;
  const winnerClass = idx === lastIndex ? (replay.attackerWon ? 'winner-attacker' : 'winner-defender') : '';
  const terrainClass = ['plain', 'hill', 'mountain', 'forest', 'river'].includes(replay.terrain)
    ? `terrain-${replay.terrain}`
    : 'terrain-plain';

  return (
    <Modal
      title={`战报回放 · ${replay.regionName}`}
      subtitle={`${replay.attackerName} 对 ${replay.defenderName} · 种子 ${replay.seed} · ${replay.terrainLabel}${replay.fort > 0 ? ` · 城防 ${replay.fort}` : ''}`}
      onClose={onClose}
      width={720}
    >
      <div
        className={`battlefield ${terrainClass} phase-${stage.key} ${winnerClass}`}
        role="img"
        aria-label={`${replay.terrainLabel}战场，${stage.name}阶段。攻方剩余${fmt(stage.attackerTroops)}人，守方剩余${fmt(stage.defenderTroops)}人。`}
      >
        <div className="battlefield-sky" />
        <div className="battlefield-ridge ridge-back" />
        <div className="battlefield-ridge ridge-front" />
        <div className="battlefield-ground" />
        <div className="battlefield-road" />
        <div className="battlefield-vs">VS</div>
        <div className="battle-formation attacker" style={{ color: atkColor }}>
          <div className="battle-banner"><span>攻</span></div>
          <div className="battle-soldiers">
            {Array.from({ length: formationSize }, (_, i) => (
              <span key={i} className={`battle-soldier ${i >= visibleAttackers ? 'fallen' : ''}`}><i /><b /></span>
            ))}
          </div>
          <div className="battle-formation-label">{replay.attackerName}</div>
        </div>
        <div className="battle-formation defender" style={{ color: defColor }}>
          <div className="battle-banner"><span>守</span></div>
          <div className="battle-soldiers">
            {Array.from({ length: formationSize }, (_, i) => (
              <span key={i} className={`battle-soldier ${i >= visibleDefenders ? 'fallen' : ''}`}><i /><b /></span>
            ))}
          </div>
          <div className="battle-formation-label">{replay.defenderName}</div>
        </div>
        <div className="battlefield-phase"><i />{stage.name}<i /></div>
        <div className="battlefield-terrain-label">{replay.terrainLabel}{replay.fort > 0 ? ` · 城防 ${replay.fort}` : ''}</div>
      </div>

      <div className="replay-side">
        <div className="replay-side-head">
          <span style={{ color: atkVisual?.mapBorder ?? 'var(--gold-soft)' }}>
            攻方 · {replay.attackerName}
            {replay.attackerCommander && `（${replay.attackerCommander.name}）`}
          </span>
          <span className="num">{fmt(stage.attackerTroops)} / {fmt(replay.initialAttackerTroops)}</span>
        </div>
        <div className="replay-bar"><i style={{ width: `${atkPct}%`, background: atkColor }} /></div>
        <div className="small muted">士气 {stage.attackerMorale}</div>
      </div>

      <div className="replay-side">
        <div className="replay-side-head">
          <span style={{ color: defVisual?.mapBorder ?? 'var(--muted)' }}>
            守方 · {replay.defenderName}
            {replay.defenderCommander && `（${replay.defenderCommander.name}）`}
          </span>
          <span className="num">{fmt(stage.defenderTroops)} / {fmt(replay.initialDefenderTroops)}</span>
        </div>
        <div className="replay-bar"><i style={{ width: `${defPct}%`, background: defColor }} /></div>
        <div className="small muted">士气 {stage.defenderMorale}</div>
      </div>

      <div className="replay-steps">
        {replay.stages.map((s, i) => (
          <button
            key={s.key + i}
            className={`replay-step ${i === idx ? 'active' : ''} ${i < idx ? 'done' : ''}`}
            onClick={() => { setIdx(i); setPlaying(false); }}
          >
            {i + 1}·{s.name}
          </button>
        ))}
      </div>

      <div className="replay-text">
        <strong className="gold">【{stage.name}】</strong>
        {stage.text}
      </div>

      <div className="form-row" style={{ alignItems: 'center', marginTop: 8 }}>
        <button className="btn small ghost" disabled={idx === 0} onClick={() => { setIdx(idx - 1); setPlaying(false); }}>
          上一阶段
        </button>
        <button
          className="btn small"
          onClick={() => {
            if (idx >= lastIndex) setIdx(0);
            setPlaying(!playing);
          }}
        >
          {playing ? '暂停' : idx >= lastIndex ? '重播' : '播放'}
        </button>
        <button className="btn small ghost" disabled={idx >= lastIndex} onClick={() => { setIdx(idx + 1); setPlaying(false); }}>
          下一阶段
        </button>
        <span className="muted small" style={{ marginLeft: 'auto' }}>
          {replay.attackerWon ? '攻方获胜' : '守方击退进攻'} · 阶段 {idx + 1}/{replay.stages.length}
        </span>
      </div>
    </Modal>
  );
}
