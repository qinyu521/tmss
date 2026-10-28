import { useState } from 'react';
import { ROLE_LABEL } from '@tianming/shared';
import { useApp } from '../state/store';
import { Empty, Modal } from '../components/ui';

export default function SavePanel() {
  const view = useApp((s) => s.view);
  const saves = useApp((s) => s.saves);
  const games = useApp((s) => s.games);
  const saveGame = useApp((s) => s.saveGame);
  const loadSave = useApp((s) => s.loadSave);
  const deleteGame = useApp((s) => s.deleteGame);
  const continueGame = useApp((s) => s.continueGame);
  const setNav = useApp((s) => s.setNav);
  const [label, setLabel] = useState('');

  if (!view) return null;

  return (
    <Modal
      title="存档与时间线"
      subtitle={`当前存档 schema v${view.schemaVersion} · ${view.date.label}`}
      onClose={() => setNav('map')}
    >
      <div className="form-row">
        <label>存档名</label>
        <input value={label} placeholder={`${view.date.label} 手动存档`} onChange={(e) => setLabel(e.target.value)} />
        <button className="btn primary" onClick={() => { void saveGame(label || undefined); setLabel(''); }}>保存</button>
      </div>
      <div className="form-note">
        每回合结算后自动存档（最多保留 10 份自动存档）。读档会恢复到该回合的完整状态，并清除该回合之后的事件记录。
        含版本号，可在后续版本做迁移；当前 schema v{view.schemaVersion}。
      </div>

      <div className="section-title">本时间线存档（{saves.length}）</div>
      {saves.length === 0 && <Empty>暂无存档。</Empty>}
      <table className="table">
        <thead><tr><th>存档名</th><th>日期</th><th>回合</th><th>类型</th><th>时间</th><th></th></tr></thead>
        <tbody>
          {saves.map((s) => (
            <tr key={s.save_id}>
              <td>{s.label}</td>
              <td>{s.date_label}</td>
              <td>{s.turn}</td>
              <td>{s.autosave ? '自动' : '手动'}</td>
              <td className="muted small">{new Date(s.created_at).toLocaleString('zh-CN')}</td>
              <td><button className="btn small" onClick={() => void loadSave(s.save_id)}>载入</button></td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="section-title">全部时间线</div>
      <table className="table">
        <thead><tr><th>势力/身份</th><th>日期</th><th>回合</th><th>更新时间</th><th></th></tr></thead>
        <tbody>
          {games.map((g) => (
            <tr key={g.game_id}>
              <td>{g.faction_key} · {ROLE_LABEL[g.player_role as 'ruler']}{g.game_id === view.gameId ? '（当前）' : ''}</td>
              <td>{g.date_label}</td>
              <td>{g.turn}</td>
              <td className="muted small">{new Date(g.updated_at).toLocaleString('zh-CN')}</td>
              <td style={{ display: 'flex', gap: 4 }}>
                {g.game_id !== view.gameId && <button className="btn small" onClick={() => void continueGame(g.game_id)}>切换</button>}
                <button
                  className="btn small danger"
                  onClick={() => {
                    if (confirm('删除该时间线及全部存档与事件？不可恢复。')) void deleteGame(g.game_id);
                  }}
                >
                  删除
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Modal>
  );
}
