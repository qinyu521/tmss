import { useEffect, useRef, useState } from 'react';
import { FACTION_VISUALS } from '@tianming/shared';
import { useApp, type LayerKey } from '../state/store';
import { MapScene } from '../three/mapScene';

const LAYERS: { key: LayerKey; label: string }[] = [
  { key: 'political', label: '政治' },
  { key: 'grain', label: '粮食' },
  { key: 'salt', label: '盐' },
  { key: 'iron', label: '铁' },
  { key: 'horses', label: '战马' },
  { key: 'order', label: '治安' },
  { key: 'loyalty', label: '忠诚' },
  { key: 'supply', label: '补给' },
  { key: 'threat', label: '威胁' },
  { key: 'intel', label: '情报' },
];

const LEGEND_TEXT: Record<LayerKey, { title: string; note: string; threat?: boolean }> = {
  political: { title: '政治归属', note: '本势力 / 邻国 / 未知皆按控制方着色；边界为势力色。' },
  grain: { title: '粮食产出（本国州府）', note: '敌方州府的产出不予公开，显示为灰色；需侦察获取军情。' },
  salt: { title: '盐产出（本国州府）', note: '盐短缺会降低士气、伤病恢复与军粮保存。' },
  iron: { title: '铁料产出（本国州府）', note: '铁料影响甲械维护、训练与重装部队补员。' },
  horses: { title: '战马产出（本国州府）', note: '战马限制骑兵扩编、机动与追击能力。' },
  order: { title: '治安（本国州府）', note: '征粮与加税会压低治安，影响税收与兵员。' },
  loyalty: { title: '民心/忠诚（本国州府）', note: '忠诚过低会成为叛乱与世家抵制的温床。' },
  supply: { title: '补给水平（本国州府）', note: '补给不足时，行军损耗与战力下降。' },
  threat: { title: '战争威胁', note: '依据相邻敌军与边境紧张度估算，不是精确军力。', threat: true },
  intel: { title: '情报可见度', note: '青色=已有斥候情报；灰色=未侦察。情报有可靠度，不等于事实。' },
};

export default function MapView() {
  const containerRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<MapScene | null>(null);
  const focusedRef = useRef(false);
  const mapData = useApp((s) => s.mapData);
  const view = useApp((s) => s.view);
  const gameId = useApp((s) => s.gameId);
  const layer = useApp((s) => s.layer);
  const labels = useApp((s) => s.labels);
  const quality = useApp((s) => s.quality);
  const selected = useApp((s) => s.selected);
  const setLayer = useApp((s) => s.setLayer);
  const select = useApp((s) => s.select);
  const [tooltip, setTooltip] = useState<{ title: string; subtitle: string; x: number; y: number } | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const scene = new MapScene(containerRef.current, {
      onSelectRegion: (regionId) => useApp.getState().select({ type: 'region', id: regionId }),
      onSelectArmy: (armyId) => useApp.getState().select({ type: 'army', id: armyId }),
      onSelectNode: (nodeId) => useApp.getState().select({ type: 'node', id: nodeId }),
      onHover: (info) => setTooltip(info),
    });
    sceneRef.current = scene;
    return () => {
      scene.dispose();
      sceneRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (sceneRef.current && mapData) sceneRef.current.setMap(mapData);
  }, [mapData]);

  useEffect(() => {
    focusedRef.current = false;
  }, [gameId]);

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const target = ev.target as HTMLElement;
      if (target && /INPUT|SELECT|TEXTAREA/.test(target.tagName)) return;
      const scene = sceneRef.current;
      if (!scene) return;
      const key = ev.key.toLowerCase();
      if (key === 'q') scene.rotateBy(0.12);
      else if (key === 'e') scene.rotateBy(-0.12);
      else if (key === 'r') scene.resetCamera();
      else if (key === 'w') scene.panBy(0, -18);
      else if (key === 's') scene.panBy(0, 18);
      else if (key === 'a') scene.panBy(-18, 0);
      else if (key === 'd') scene.panBy(18, 0);
      else if (key === '+' || key === '=') scene.zoomBy(0.85);
      else if (key === '-') scene.zoomBy(1.18);
      else if (key === 'c') {
        const cap = useApp.getState().view?.regions.find((r) => r.owned);
        if (cap) scene.focusRegion(cap.regionId);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (sceneRef.current && view) sceneRef.current.setView(view);
  }, [view]);

  useEffect(() => {
    sceneRef.current?.setLayer(layer);
  }, [layer]);

  useEffect(() => {
    sceneRef.current?.setLabels(labels);
  }, [labels]);

  useEffect(() => {
    sceneRef.current?.setQuality(quality);
  }, [quality]);

  useEffect(() => {
    if (!sceneRef.current || !selected) return;
    if (selected.type === 'region') {
      sceneRef.current.selectRegion(selected.id);
    } else if (selected.type === 'node' && mapData) {
      const node = mapData.nodes.find((n) => n.node_id === selected.id);
      const region = mapData.territories.find((t) => t.region === node?.region);
      if (region) sceneRef.current.selectRegion(region.region_id);
    }
  }, [selected, mapData]);

  const legend = LEGEND_TEXT[layer];

  return (
    <div className="map-stage" ref={containerRef}>
      <div className="map-hud">
        <div className="map-hud-top">
          <div className="layer-switch" role="tablist" aria-label="地图图层">
            {LAYERS.map((l) => (
              <button
                key={l.key}
                className={layer === l.key ? 'active' : ''}
                onClick={() => setLayer(l.key)}
                role="tab"
                aria-selected={layer === l.key}
              >
                {l.label}
              </button>
            ))}
          </div>
          <div className="map-controls" aria-label="镜头控制">
            <button className="icon-btn" title="放大" onClick={() => sceneRef.current?.zoomBy(0.82)}>＋</button>
            <button className="icon-btn" title="缩小" onClick={() => sceneRef.current?.zoomBy(1.22)}>－</button>
            <button className="icon-btn" title="左旋（Q）" onClick={() => sceneRef.current?.rotateBy(0.18)}>⟲</button>
            <button className="icon-btn" title="右旋（E）" onClick={() => sceneRef.current?.rotateBy(-0.18)}>⟳</button>
            <button className="icon-btn" title="回到首都（C）" onClick={() => {
              const current = useApp.getState();
              const cap = current.view?.regions.find((r) => r.owned);
              if (cap) sceneRef.current?.focusRegion(cap.regionId);
            }}>都</button>
            <button className="icon-btn" title="重置镜头（R）" onClick={() => sceneRef.current?.resetCamera()}>⤾</button>
            <button className="icon-btn" title="显示/隐藏标签" onClick={() => useApp.getState().toggleLabels()}>{labels ? '文' : '无'}</button>
          </div>
        </div>
        <div className="map-hud-bottom">
          <div className={`legend ${legend.threat ? 'threat' : ''}`}>
            <strong style={{ color: 'var(--gold-soft)' }}>{legend.title}</strong>
            {layer === 'political' ? (
              <div style={{ display: 'flex', gap: 10, marginTop: 5, flexWrap: 'wrap' }}>
                {(['HUN', 'YONG', 'CHU'] as const).map((k) => (
                  <span key={k} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <i style={{ width: 10, height: 10, display: 'inline-block', background: FACTION_VISUALS[k].mapFill, border: `1px solid ${FACTION_VISUALS[k].mapBorder}` }} />
                    {FACTION_VISUALS[k].shortName}
                  </span>
                ))}
              </div>
            ) : (
              <div className="gradient" />
            )}
            <div>{legend.note}</div>
            <div className="muted" style={{ marginTop: 4 }}>
              拖拽平移 · 右键/Shift 旋转 · 滚轮缩放 · 双击定位
            </div>
          </div>
          <div className="legend" style={{ maxWidth: 260 }}>
            <strong style={{ color: 'var(--gold-soft)' }}>{view?.own.shortName} · 本旬</strong>
            <div>第 {view?.date.turn ?? 0} 回合 · {view?.date.label}</div>
            <div className="muted">点击州府/军队查看详情；军队行军路径与旗标随回合推进。</div>
          </div>
        </div>
      </div>
      {tooltip && (
        <div className="map-tooltip" style={{ left: tooltip.x, top: tooltip.y }}>
          <div className="t">{tooltip.title}</div>
          <div className="s">{tooltip.subtitle}</div>
        </div>
      )}
    </div>
  );
}
