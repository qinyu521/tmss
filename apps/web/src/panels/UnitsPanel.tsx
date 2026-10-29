import { useEffect, useMemo, useState } from 'react';
import { CATEGORY_LABELS, FACTION_VISUALS, fmt } from '@tianming/shared';
import { api } from '../api/client';
import { useApp } from '../state/store';
import { Empty, Modal } from '../components/ui';

export default function UnitsPanel() {
  const view = useApp((s) => s.view);
  const setNav = useApp((s) => s.setNav);
  const [units, setUnits] = useState<any[]>([]);
  const [faction, setFaction] = useState<'all' | 'HUN' | 'YONG' | 'CHU'>('all');

  useEffect(() => {
    api.units().then(setUnits).catch(() => setUnits([]));
  }, []);

  const list = useMemo(
    () => units.filter((u) => faction === 'all' || u.seed.faction_key === faction),
    [units, faction],
  );

  if (!view) return null;

  return (
    <Modal
      title="特殊兵种档案"
      subtitle={`22 种 · 名称与描述来自种子数据，数值为原创平衡设定`}
      onClose={() => setNav('map')}
      width={1320}
    >
      <div className="layer-switch" style={{ position: 'static', marginBottom: 12, maxWidth: 'none', pointerEvents: 'auto' }}>
        {(['all', 'HUN', 'YONG', 'CHU'] as const).map((k) => (
          <button key={k} className={faction === k ? 'active' : ''} onClick={() => setFaction(k)}>
            {k === 'all' ? '全部' : FACTION_VISUALS[k].shortName}
          </button>
        ))}
      </div>
      {list.length === 0 && <Empty>兵种数据载入中…</Empty>}
      <div className="sheet-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))' }}>
        {list.map(({ seed, profile }) => (
          <div className="card" key={seed.unit_id}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
              <img src={`/assets/units/${seed.unit_id}.svg`} alt={seed.unit_name} style={{ width: 54, height: 54, borderRadius: 8, border: '1px solid var(--line)' }} />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontFamily: 'var(--font-display)', fontSize: 17, letterSpacing: '0.06em' }}>{seed.unit_name}</div>
                <div className="small" style={{ color: FACTION_VISUALS[seed.faction_key as 'HUN'].mapBorder }}>
                  {FACTION_VISUALS[seed.faction_key as 'HUN'].shortName} · {seed.unit_type} · {CATEGORY_LABELS[profile?.category] ?? ''}
                </div>
                <div className="small muted" style={{ marginTop: 3 }}>{seed.game_role}</div>
              </div>
            </div>

            <div className="attr-grid" style={{ gridTemplateColumns: 'repeat(4, minmax(0,1fr))', marginTop: 10 }}>
              <div className="attr"><div className="k">冲击</div><div className="v">{profile?.attack ?? '—'}</div></div>
              <div className="attr"><div className="k">防护</div><div className="v">{profile?.defense ?? '—'}</div></div>
              <div className="attr"><div className="k">远程</div><div className="v">{profile?.ranged ?? '—'}</div></div>
              <div className="attr"><div className="k">机动</div><div className="v">{profile?.mobility ?? '—'}</div></div>
            </div>
            <div className="small muted" style={{ marginTop: 8, lineHeight: 1.65 }}>
              <div>优势：{seed.strengths}</div>
              <div>弱点：{seed.weaknesses}</div>
              <div>初始成建制编制 {fmt(profile?.initialFormationSize ?? 0)} 人 · 全国同时部署上限 {fmt(profile?.capPerFaction ?? 0)}</div>
              <div>补给权重 ×{profile?.supplyCost ?? 1} · 招募门槛：训练 {profile?.recruit?.minTraining ?? '—'}</div>
              <div>克制：{(profile?.counters ?? []).map((c: string) => CATEGORY_LABELS[c] ?? c).join('、') || '无'}</div>
              <div>被克：{(profile?.counteredBy ?? []).map((c: string) => CATEGORY_LABELS[c] ?? c).join('、') || '无'}</div>
              <div>资源约束：{seed.resource_constraints}</div>
              <div style={{ marginTop: 4 }}>招募要求：{seed.unlock_and_recruitment_requirements}</div>
              <div style={{ marginTop: 4, color: 'var(--gold-soft)' }}>{seed.historical_prototype_note}</div>
            </div>
          </div>
        ))}
      </div>
      <div className="form-note" style={{ marginTop: 12 }}>
        兵种差异同时体现在数值、地形修正、克制关系、补给消耗、招募门槛与地图模型上。没有任何一个兵种在所有场景都强：
        重骑怕拒马与山地，弓弩怕近身包抄，水军在陆战正面孱弱，轻装部队难以承受正面消耗。
      </div>
    </Modal>
  );
}
