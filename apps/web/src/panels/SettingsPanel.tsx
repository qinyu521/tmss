import { useState } from 'react';
import { useApp } from '../state/store';
import { Modal } from '../components/ui';
import LlmSettings from '../components/LlmSettings';

export default function SettingsPanel() {
  const view = useApp((s) => s.view);
  const config = useApp((s) => s.config);
  const labels = useApp((s) => s.labels);
  const quality = useApp((s) => s.quality);
  const toggleLabels = useApp((s) => s.toggleLabels);
  const setQuality = useApp((s) => s.setQuality);
  const deleteGame = useApp((s) => s.deleteGame);
  const setNav = useApp((s) => s.setNav);
  const [audio, setAudio] = useState(false);

  if (!view) return null;

  return (
    <Modal title="设置" subtitle="AI 史官 · 视觉 · 数据" onClose={() => setNav('map')}>
      <div className="section-title">AI 史官</div>
      <div className="small muted" style={{ lineHeight: 1.8, marginBottom: 8 }}>
        接入任意 OpenAI 兼容接口后，可把每旬的模板史官条目润色为《三国演义》式的长段落；
        也可设为每旬自动润色。规则事实（兵力、胜负、伤亡、任免、领土）永不改写。
      </div>
      <LlmSettings />

      <div className="section-title" style={{ marginTop: 18 }}>视觉</div>
      <label className="form-row" style={{ cursor: 'pointer' }}>
        <span style={{ width: 120, color: 'var(--muted)' }}>地图标签</span>
        <input type="checkbox" checked={labels} onChange={toggleLabels} style={{ flex: '0 0 auto' }} />
        <span className="small muted">显示州府/部队/资源点标签</span>
      </label>
      <div className="form-row">
        <label>画质</label>
        <select value={quality} onChange={(e) => setQuality(e.target.value as any)} style={{ maxWidth: 240 }}>
          <option value="high">高（树木、岩石、资源点标签更丰富）</option>
          <option value="low">低（低端/1 核 2G 设备建议）</option>
        </select>
      </div>
      <div className="form-row">
        <label>动画</label>
        <span className="small muted">地图与镜头过渡动画常开；低画质会减少装饰与标签绘制。</span>
      </div>
      <div className="form-row">
        <label>音效</label>
        <input type="checkbox" checked={audio} onChange={() => setAudio(!audio)} />
        <span className="small muted">音效系统预留，当前版本无音频资源。</span>
      </div>

      <div className="section-title">存档与时间线</div>
      <div className="small muted" style={{ lineHeight: 1.8 }}>
        存档保存于本机 SQLite（`data/runtime/tianming.db`）。生产部署时请挂载持久化卷并定期备份。
        LLM 史官：{config?.llmEnabled ? `已配置（${config.llmProvider} / ${config.llmModel}）` : '未配置，使用本地模板'}。
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
        <button className="btn" onClick={() => { localStorage.removeItem('tianming.lastGameId'); location.reload(); }}>
          返回开始页（保留存档）
        </button>
        <button
          className="btn danger"
          onClick={() => {
            if (confirm('删除当前时间线及全部存档、事件？不可恢复。')) void deleteGame(view.gameId);
          }}
        >
          删除当前时间线
        </button>
      </div>

      <div className="section-title">关于</div>
      <div className="small muted" style={{ lineHeight: 1.85 }}>
        天命史书 · AI 架空历史世界模拟器（原型版本 {config?.appVersion ?? '0.9.1'}）。所有地图、头像、旗帜与 3D 剪影均为程序化原创资源，
        不使用商业游戏素材。历史人物仅作为能力、制度与战略原型，游戏人物拥有独立姓名、关系与命运。
        <br />
        规则引擎决定性、可重放；AI 史官仅做记录与评述，不能改写兵力、伤亡、任免与领土。
        <br />
        部署模式：{config?.singlePlayer ? '单机/个人（无多用户鉴权）' : '多用户（需自行补齐鉴权）'}。
        1 核 2 GB 仅适合个人或极小规模使用，不应宣称可承载大规模并发。
      </div>
    </Modal>
  );
}
