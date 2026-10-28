import { useEffect } from 'react';
import { useApp } from './state/store';
import StartScreen from './components/StartScreen';
import GameShell from './components/GameShell';

export default function App() {
  const status = useApp((s) => s.status);
  const bootError = useApp((s) => s.bootError);
  const boot = useApp((s) => s.boot);

  useEffect(() => {
    void boot();
  }, [boot]);

  if (status === 'boot') {
    return (
      <div className="loading-screen">
        <div className="loading-mark">天命史书</div>
        <div className="muted small">正在校验种子数据、装配大地图与规则引擎…</div>
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className="error-screen">
        <div className="loading-mark" style={{ fontSize: 30 }}>无法载入</div>
        <div className="danger-text">{bootError}</div>
        <div className="muted small">
          请确认后端已启动（npm run dev:api），且 data/source/tianming_world_roster_v0_3_1.json 存在。
        </div>
        <button className="btn" onClick={() => void boot()}>重试</button>
      </div>
    );
  }

  if (status === 'start') return <StartScreen />;
  return <GameShell />;
}
