import { useState } from 'react';
import { FACTION_VISUALS, PLAYER_ROLES, fmt, ROLE_LABEL } from '@tianming/shared';
import { useApp } from '../state/store';
import { Modal, Portrait } from './ui';
import LlmSettings from './LlmSettings';

export default function StartScreen() {
  const factions = useApp((s) => s.factions);
  const games = useApp((s) => s.games);
  const busy = useApp((s) => s.busy);
  const startGame = useApp((s) => s.startGame);
  const continueGame = useApp((s) => s.continueGame);
  const deleteGame = useApp((s) => s.deleteGame);
  const [faction, setFaction] = useState<'HUN' | 'YONG' | 'CHU'>('YONG');
  const [role, setRole] = useState('ruler');
  const [aiOpen, setAiOpen] = useState(false);

  const selected = factions.find((f) => f.key === faction);
  const visual = FACTION_VISUALS[faction];

  return (
    <div className="start-screen">
      <div className="start-inner">
        <div className="hero">
          <div>
            <h1 className="title">天命史书</h1>
            <div className="subtitle">AI · 架空历史 · 大地图策略</div>
            <p className="muted small" style={{ maxWidth: 620, marginTop: 14, lineHeight: 1.8 }}>
              三分天下：北庭部落联盟、大雍中央帝国、大楚世家政权。规则引擎裁决一切事实，
              史官只记录与评述。选择你的势力与身份，在七日一旬的时序里经营、行军与决断。
            </p>
          </div>
          <div className="verse">
            天命有常，史笔无私。<br />
            粮盐铁马，皆为刀兵之母。<br />
            人心向背，方是社稷之基。
          </div>
        </div>

        <div className="faction-grid">
          {(['HUN', 'YONG', 'CHU'] as const).map((key) => {
            const f = factions.find((x) => x.key === key);
            const v = FACTION_VISUALS[key];
            if (!f) return null;
            return (
              <button
                key={key}
                className={`faction-card ${faction === key ? 'selected' : ''}`}
                style={{ ['--faction-color' as any]: v.primary }}
                onClick={() => setFaction(key)}
                aria-pressed={faction === key}
              >
                <div className="banner">
                  <div className="seal">{v.bannerGlyph}</div>
                  <Portrait personId={`${key}-P001`} size="lg" alt={f.name} />
                </div>
                <div className="body">
                  <div className="name" style={{ color: v.mapBorder }}>{v.shortName}</div>
                  <div className="tagline">{v.tagline}</div>
                  <div className="facts">
                    <span className="chip gold">兵力 {fmt(f.initial_force_total, '人')}</span>
                    <span className="chip">人口 {f.economy_profile.relative_ratings_0_5.population}/5</span>
                    <span className="chip">骑兵 {f.economy_profile.relative_ratings_0_5.cavalry}/5</span>
                    <span className="chip">{f.regions.length} 州</span>
                  </div>
                  <div className="small muted" style={{ marginTop: 8, lineHeight: 1.7 }}>
                    {f.strategic_doctrine.strengths.slice(0, 2).join('；')}
                  </div>
                  <div className="facts" style={{ marginTop: 8 }}>
                    <span className="chip danger">粮 {f.economy_profile.food_status}</span>
                    <span className="chip danger">盐 {f.economy_profile.salt_status}</span>
                    <span className="chip warn">铁 {f.economy_profile.iron_status}</span>
                    <span className="chip ok">马 {f.economy_profile.horse_status}</span>
                  </div>
                </div>
              </button>
            );
          })}
        </div>

        <div className="start-controls">
          <div>
            <div className="section-title">选择身份</div>
            <div className="role-list">
              {PLAYER_ROLES.map((r) => (
                <button
                  key={r.key}
                  className={`role-card ${role === r.key ? 'selected' : ''}`}
                  onClick={() => setRole(r.key)}
                >
                  <div className="r-label">{r.label}</div>
                  <div className="r-blurb">{r.blurb}</div>
                </button>
              ))}
            </div>
            <div className="form-note">
              身份权限由规则引擎校验：军师只能侦察与建言，将军只能调动授权军区，州牧只能经营本州。
              自然语言输入不能绕过权限。
            </div>
            <div className="start-actions">
              <button
                className="btn primary"
                disabled={busy || !selected}
                onClick={() => void startGame(faction, role)}
              >
                {busy ? '正在推演…' : `开局 · ${visual.shortName} / ${ROLE_LABEL[role as 'ruler']}`}
              </button>
              <span className="muted small">一回合 = 7 天 · 三国 NPC 同步行动</span>
            </div>
          </div>

          <div>
            <div className="section-title">
              继续时间线
              <span className="muted small" style={{ fontFamily: 'var(--font-ui)', marginLeft: 'auto' }}>本机 SQLite 存档</span>
            </div>
            <div className="timeline-list">
              {games.length === 0 && <div className="empty">尚无时间线。选择势力与身份后开局。</div>}
              {games.map((g) => {
                const v = FACTION_VISUALS[g.faction_key as 'HUN'];
                return (
                  <div className="timeline-row" key={g.game_id}>
                    <div style={{ minWidth: 0 }}>
                      <span style={{ color: v?.mapBorder, fontFamily: 'var(--font-display)' }}>
                        {v?.shortName} · {ROLE_LABEL[g.player_role as 'ruler']}
                      </span>
                      <div className="muted small">
                        {g.date_label}（第 {g.turn} 回合） · {new Date(g.updated_at).toLocaleString('zh-CN')}
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button className="btn small" onClick={() => void continueGame(g.game_id)}>继续</button>
                      <button
                        className="btn small danger"
                        onClick={() => {
                          if (confirm('删除该时间线及其存档？此操作不可恢复。')) void deleteGame(g.game_id);
                        }}
                      >
                        删
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="form-note" style={{ marginTop: 14 }}>
              模式：单机/个人部署，无登录鉴权；请勿直接暴露公网。未配置 LLM 密钥时，史官使用本地模板，
              核心玩法完整可玩。
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 10, flexWrap: 'wrap' }}>
              <button className="btn small" onClick={() => setAiOpen(true)}>AI 史官设置</button>
              <span className="small muted">接入 OpenAI 兼容接口，把每旬记录润色成演义长篇。</span>
            </div>
          </div>
        </div>
      </div>
      {aiOpen && (
        <Modal
          title="AI 史官设置"
          subtitle="OpenAI 兼容接口 · 密钥仅存本机"
          onClose={() => setAiOpen(false)}
          width={720}
        >
          <LlmSettings />
        </Modal>
      )}
    </div>
  );
}
