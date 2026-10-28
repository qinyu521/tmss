import type { ReactNode } from 'react';
import { fmt } from '@tianming/shared';

export function Portrait({
  personId,
  size = 'md',
  alt,
  deceased = false,
}: {
  personId: string;
  size?: 'sm' | 'md' | 'lg';
  alt?: string;
  /** 已故人物：灰度显示 */
  deceased?: boolean;
}) {
  return (
    <img
      className={`portrait ${size === 'md' ? '' : size}`}
      src={`/assets/portraits/${personId}.svg`}
      alt={alt ?? personId}
      loading="lazy"
      style={deceased ? { filter: 'grayscale(1)', opacity: 0.72 } : undefined}
      onError={(e) => {
        (e.currentTarget as HTMLImageElement).style.opacity = '0.25';
      }}
    />
  );
}

export function UnitIcon({ unitId, name }: { unitId: string; name: string }) {
  return <img src={`/assets/units/${unitId}.svg`} alt={name} loading="lazy" />;
}

export function StatLine({ label, value, max = 100, mode }: { label: string; value: number; max?: number; mode?: 'red' | 'green' }) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div className="stat-line">
      <span className="lbl">{label}</span>
      <span className={`bar ${mode ?? ''}`}>
        <i style={{ width: `${pct}%` }} />
      </span>
      <span className="num">{Math.round(value)}</span>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Modal({
  title,
  subtitle,
  onClose,
  tabs,
  activeTab,
  onTab,
  children,
  width,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  tabs?: { key: string; label: string }[];
  activeTab?: string;
  onTab?: (key: string) => void;
  children: ReactNode;
  width?: number;
}) {
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet" style={width ? { width: `min(${width}px, 94vw)` } : undefined}>
        <div className="sheet-head">
          <h2>{title}</h2>
          {subtitle && <span className="sub">{subtitle}</span>}
          <button className="btn ghost small close" onClick={onClose}>关闭 ✕</button>
        </div>
        <div className="sheet-body">
          {tabs && tabs.length > 0 && (
            <div className="sheet-tabs">
              {tabs.map((t) => (
                <button key={t.key} className={activeTab === t.key ? 'active' : ''} onClick={() => onTab?.(t.key)}>
                  {t.label}
                </button>
              ))}
            </div>
          )}
          <div className="sheet-main">{children}</div>
        </div>
      </div>
    </div>
  );
}

export function ResourceCell({ k, v, unit, low }: { k: string; v: number; unit?: string; low?: boolean }) {
  return (
    <div className={`res ${low ? 'low' : ''}`} title={`${k}：${Math.round(v).toLocaleString()}${unit ?? ''}`}>
      <span className="k">{k}</span>
      <span className="v">{fmt(v, unit)}</span>
    </div>
  );
}

export function TraitChips({ tags, limit = 6 }: { tags: string[]; limit?: number }) {
  return (
    <>
      {tags.slice(0, limit).map((t) => {
        const tone = /危机|拒命|抵制|紧张|不足|缺|荒/.test(t) ? 'danger' : /协调|稳定|支持/.test(t) ? 'ok' : '';
        return (
          <span key={t} className={`chip ${tone}`}>
            {t}
          </span>
        );
      })}
    </>
  );
}
