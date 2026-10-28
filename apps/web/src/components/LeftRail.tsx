import type { NavKey } from '../state/store';
import { useApp } from '../state/store';

const ITEMS: { key: NavKey; glyph: string; label: string }[] = [
  { key: 'map', glyph: '圖', label: '地图' },
  { key: 'faction', glyph: '國', label: '国家' },
  { key: 'characters', glyph: '人', label: '人物' },
  { key: 'army', glyph: '軍', label: '军队' },
  { key: 'court', glyph: '朝', label: '朝议' },
  { key: 'units', glyph: '兵', label: '兵种' },
  { key: 'events', glyph: '史', label: '史官' },
  { key: 'saves', glyph: '檔', label: '存档' },
];

export default function LeftRail() {
  const nav = useApp((s) => s.nav);
  const setNav = useApp((s) => s.setNav);
  return (
    <nav className="rail" aria-label="功能导航">
      {ITEMS.map((it) => (
        <button
          key={it.key}
          className={nav === it.key ? 'active' : ''}
          onClick={() => setNav(it.key)}
          title={it.label}
        >
          <span className="glyph">{it.glyph}</span>
          <span className="lbl">{it.label}</span>
        </button>
      ))}
      <div className="spacer" />
      <button
        className={nav === 'settings' ? 'active' : ''}
        onClick={() => setNav('settings')}
        title="设置"
      >
        <span className="glyph">設</span>
        <span className="lbl">设置</span>
      </button>
    </nav>
  );
}
