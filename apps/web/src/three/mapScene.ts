import * as THREE from 'three';
import type { FactionKey, MapTile, PlayerView, TileMap } from '@tianming/shared';
import {
  FACTION_VISUALS,
  TILE_SIZE,
  TILE_TERRAIN_INFO,
  buildTileMapFromMapData,
  mapCoordToTile,
  tileAt,
  tileCenter,
} from '@tianming/shared';
import type { MapData, MapEdge, MapNode, TerritorySeed } from '../api/client';
import art from '../../../../data/derived/map_art.json';

export type LayerKey =
  | 'political'
  | 'grain'
  | 'salt'
  | 'iron'
  | 'horses'
  | 'order'
  | 'loyalty'
  | 'supply'
  | 'threat'
  | 'intel';

export interface SceneCallbacks {
  onSelectRegion: (regionId: string) => void;
  onSelectArmy: (armyId: string) => void;
  onSelectNode: (nodeId: string) => void;
  onSelectTile: (tile: { x: number; y: number }, regionId: string) => void;
  onHover: (info: { title: string; subtitle: string; x: number; y: number } | null) => void;
}

interface ArmyMarker {
  armyId: string;
  group: THREE.Group;
  detailed: THREE.Group;
  icon: THREE.Sprite | null;
  label: HTMLDivElement;
  position: THREE.Vector3;
  route: THREE.Line | null;
  isOwn: boolean;
  marching: boolean;
}

interface MarchAnimation {
  marker: ArmyMarker;
  points: THREE.Vector3[];
  elapsed: number;
  duration: number;
}

const SCALE = 125;
const ORIGIN_X = 4.55;
const ORIGIN_Y = 3.15;

export function mapToWorld(x: number, y: number): { x: number; z: number } {
  return { x: (x - ORIGIN_X) * SCALE, z: (y - ORIGIN_Y) * SCALE };
}

const FACTION_KEY_BY_NAME: Record<string, FactionKey> = {
  '匈奴（架空北庭联盟）': 'HUN',
  大雍: 'YONG',
  大楚: 'CHU',
};

function factionOf(name: string): FactionKey {
  return FACTION_KEY_BY_NAME[name] ?? 'YONG';
}

function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeValueNoise(seed: number): (x: number, y: number) => number {
  const rand = mulberry(seed);
  const grid = new Float32Array(256 * 256);
  for (let i = 0; i < grid.length; i++) grid[i] = rand();
  const at = (x: number, y: number) => grid[(y & 255) * 256 + (x & 255)];
  return (x: number, y: number) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = x - xi;
    const yf = y - yi;
    const u = xf * xf * (3 - 2 * xf);
    const v = yf * yf * (3 - 2 * yf);
    const a = at(xi, yi);
    const b = at(xi + 1, yi);
    const c = at(xi, yi + 1);
    const d = at(xi + 1, yi + 1);
    return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v;
  };
}

function segmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len = dx * dx + dy * dy || 1;
  let t = ((px - ax) * dx + (py - ay) * dy) / len;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function layerColor(view: PlayerView | null, region: PlayerView['regions'][number], layer: LayerKey): { color: string; alpha: number } {
  const faction = FACTION_VISUALS[region.faction];
  if (layer === 'political') {
    const fill = new THREE.Color(faction.mapFill).lerp(new THREE.Color('#efe6d2'), 0.3);
    return { color: `#${fill.getHexString()}`, alpha: region.owned ? 0.66 : 0.54 };
  }
  if (!region.owned) {
    if (layer === 'threat') return { color: threatColor(region.threat), alpha: 0.34 };
    if (layer === 'intel') {
      return region.intel ? { color: '#4c8f86', alpha: 0.4 } : { color: '#585750', alpha: 0.18 };
    }
    return { color: '#55534b', alpha: 0.16 };
  }
  const value = (() => {
    switch (layer) {
      case 'grain':
        return norm(region.foodOutput ?? 0, 4000, 30000);
      case 'salt':
        return norm(region.saltOutput ?? 0, 0, 300);
      case 'iron':
        return norm(region.ironOutput ?? 0, 0, 220);
      case 'horses':
        return norm(region.horseOutput ?? 0, 0, 1200);
      case 'order':
        return norm(region.order ?? 0, 0, 100);
      case 'loyalty':
        return norm(region.loyalty ?? 0, 0, 100);
      case 'supply':
        return norm(region.supplyLevel ?? 0, 0, 100);
      case 'threat':
        return norm(region.threat, 0, 100);
      default:
        return 0.5;
    }
  })();
  if (layer === 'threat') return { color: threatColor(value * 100), alpha: 0.5 };
  if (layer === 'order' || layer === 'loyalty' || layer === 'supply') return { color: mix('#6b2f2a', '#7fb39a', value), alpha: 0.5 };
  return { color: mix('#2b3a3c', '#d8b04c', value), alpha: 0.52 };
}

function norm(v: number, lo: number, hi: number): number {
  return Math.max(0, Math.min(1, (v - lo) / (hi - lo || 1)));
}

function threatColor(threat: number): string {
  return mix('#4a3a28', '#c14236', norm(threat, 0, 100));
}

function mix(a: string, b: string, t: number): string {
  const ca = new THREE.Color(a);
  const cb = new THREE.Color(b);
  return `#${ca.lerp(cb, t).getHexString()}`;
}

export class MapScene {
  private container: HTMLElement;
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private callbacks: SceneCallbacks;
  private map: MapData | null = null;
  private view: PlayerView | null = null;
  private layer: LayerKey = 'political';
  private labels = true;
  private quality: 'high' | 'low' = 'high';

  private cells: { regionId: string; name: string; faction: FactionKey; center: THREE.Vector3 }[] = [];
  private nodeGroups: { group: THREE.Group; node: MapNode }[] = [];
  private armyMarkers: ArmyMarker[] = [];
  private marchAnimations: MarchAnimation[] = [];
  private labelLayer: HTMLDivElement;
  private regionLabels: { el: HTMLButtonElement; position: THREE.Vector3; regionId: string; priority: boolean }[] = [];
  private nodeLabels: { el: HTMLDivElement; position: THREE.Vector3; nodeId: string }[] = [];
  private hovered: string | null = null;
  private selectedRegionId: string | null = null;
  private selectionRing: THREE.Mesh;
  private hoverRing: THREE.Mesh;
  private terrain?: THREE.Mesh;
  private terrainBaseColors: number[] = [];
  private terrainRegionIds: string[] = [];
  private regionCenters: { id: string; x: number; z: number }[] = [];
  private displayOffsets = new Map<string, { dx: number; dy: number }>();
  private terrainSegments = 120;
  private terrainSize = 1700;
  private roadGroup?: THREE.Group;
  private decorGroup?: THREE.Group;
  private tileMap: TileMap | null = null;
  private tileOverlay?: THREE.Group;
  private tileGrid?: THREE.LineSegments;
  private tileCursor?: THREE.LineLoop;
  private tileCursorFill?: THREE.Mesh;
  private hoveredTile: { x: number; y: number } | null = null;
  private heightAt: (x: number, z: number) => number = () => 0;
  private animations: { ring: number; time: number } = { ring: 0, time: 0 };
  private frame = 0;
  private disposed = false;
  private dragging = false;
  private dragMode: 'pan' | 'rotate' = 'pan';
  private lastPointer = { x: 0, y: 0 };
  private downPointer = { x: 0, y: 0 };
  private target = new THREE.Vector3(55, 0, 20);
  private desiredTarget = new THREE.Vector3(55, 0, 20);
  private yaw = 0.48;
  private pitch = 1.02;
  private distance = 900;
  private desiredDistance = 900;
  private resizeObserver: ResizeObserver;
  private pointerHandlers: Array<[string, EventListener]> = [];

  constructor(container: HTMLElement, callbacks: SceneCallbacks) {
    this.container = container;
    this.callbacks = callbacks;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.setClearColor('#d8cfba');
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.08;
    this.renderer.domElement.style.display = 'block';
    this.renderer.domElement.style.cursor = 'grab';
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    // 纸色远景仅用于边界收束，不遮住主地图
    this.scene.fog = new THREE.Fog('#d8cfba', 1650, 3800);
    this.camera = new THREE.PerspectiveCamera(42, container.clientWidth / Math.max(1, container.clientHeight), 4, 4000);
    this.scene.add(new THREE.HemisphereLight('#fff7e4', '#8a795f', 2.35));
    this.scene.add(new THREE.AmbientLight('#fff5df', 0.45));
    const sun = new THREE.DirectionalLight('#fff0cd', 1.05);
    sun.position.set(-420, 620, -260);
    this.scene.add(sun);
    const rim = new THREE.DirectionalLight('#cfe0dc', 0.35);
    rim.position.set(500, 220, 420);
    this.scene.add(rim);

    this.labelLayer = document.createElement('div');
    this.labelLayer.className = 'map-labels';
    container.appendChild(this.labelLayer);

    this.selectionRing = new THREE.Mesh(
      new THREE.RingGeometry(11, 15, 48),
      new THREE.MeshBasicMaterial({ color: '#e7c66b', transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false }),
    );
    this.selectionRing.rotation.x = -Math.PI / 2;
    this.selectionRing.visible = false;
    this.scene.add(this.selectionRing);

    this.hoverRing = new THREE.Mesh(
      new THREE.RingGeometry(9, 12, 40),
      new THREE.MeshBasicMaterial({ color: '#f0dfae', transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false }),
    );
    this.hoverRing.rotation.x = -Math.PI / 2;
    this.hoverRing.visible = false;
    this.scene.add(this.hoverRing);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.bindPointer();
    this.animate();
  }

  setMap(map: MapData): void {
    this.map = map;
    this.tileMap = buildTileMapFromMapData(map);
    this.buildWorld();
  }

  setView(view: PlayerView | null): void {
    const previous = this.view;
    this.view = view;
    this.refreshOwnership();
    this.rebuildArmies(previous);
  }

  setLayer(layer: LayerKey): void {
    this.layer = layer;
    this.refreshOwnership();
  }

  setLabels(labels: boolean): void {
    this.labels = labels;
    this.labelLayer.style.display = labels ? 'block' : 'none';
  }

  setQuality(quality: 'high' | 'low'): void {
    this.quality = quality;
    this.labelLayer.classList.toggle('low-quality', quality === 'low');
  }

  focusRegion(regionId: string): void {
    this.selectedRegionId = regionId;
    const cell = this.cells.find((c) => c.regionId === regionId);
    if (!cell) return;
    this.desiredTarget.copy(cell.center);
    this.desiredDistance = Math.min(this.desiredDistance, 380);
    this.selectionRing.position.copy(cell.center).setY(cell.center.y + 6);
    this.selectionRing.visible = true;
  }

  /** 把镜头移到格子中心，用于行军演出时跟到目的地。 */
  focusTile(x: number, y: number): void {
    const center = tileCenter(x, y);
    const world = mapToWorld(center.x, center.y);
    this.desiredTarget.set(world.x, this.heightAt(world.x, world.z), world.z);
    this.desiredDistance = Math.min(this.desiredDistance, 560);
  }

  resetCamera(): void {
    this.desiredTarget.set(55, 0, 20);
    this.yaw = 0.48;
    this.pitch = 1.02;
    this.desiredDistance = 900;
  }

  zoomBy(factor: number): void {
    this.desiredDistance = THREE.MathUtils.clamp(this.desiredDistance * factor, 180, 1400);
  }

  rotateBy(delta: number): void {
    this.yaw += delta;
  }

  panBy(dx: number, dz: number): void {
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const forward = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    this.desiredTarget.addScaledVector(right, dx * 1.6).addScaledVector(forward, dz * 1.6);
  }

  selectRegion(regionId: string | null): void {
    this.selectedRegionId = regionId;
    if (!regionId) {
      this.selectionRing.visible = false;
      return;
    }
    const cell = this.cells.find((c) => c.regionId === regionId);
    if (cell) {
      this.selectionRing.position.copy(cell.center).setY(cell.center.y + 6);
      this.selectionRing.visible = true;
    }
  }

  resize(): void {
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    if (width === 0 || height === 0) return;
    this.renderer.setSize(width, height);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    this.resizeObserver.disconnect();
    for (const [name, fn] of this.pointerHandlers) {
      this.renderer.domElement.removeEventListener(name, fn);
    }
    this.scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const mat = (mesh as any).material;
      if (Array.isArray(mat)) mat.forEach((m: any) => m?.dispose?.());
      else mat?.dispose?.();
    });
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.labelLayer.remove();
  }

  /* ----------------------------- 世界构建 ----------------------------- */

  private buildWorld(): void {
    if (!this.map) return;
    this.scene.children
      .filter((o) => o !== this.selectionRing && o !== this.hoverRing)
      .forEach((obj) => {
        if (obj !== this.scene.children[0] && obj.type !== 'HemisphereLight' && obj.type !== 'DirectionalLight') {
          this.scene.remove(obj);
        }
      });
    this.cells = [];
    this.nodeGroups = [];
    this.armyMarkers = [];
    this.marchAnimations = [];
    this.regionLabels = [];
    this.nodeLabels = [];
    this.labelLayer.innerHTML = '';
    this.displayOffsets.clear();
    this.tileOverlay = undefined;
    this.tileGrid = undefined;
    this.tileCursor = undefined;
    this.tileCursorFill = undefined;
    this.hoveredTile = null;
    const usedCoords = new Set<string>();
    for (const t of this.map.territories) {
      const key = `${t.map_x.toFixed(2)},${t.map_y.toFixed(2)}`;
      if (usedCoords.has(key)) {
        // 原始种子中赤河州与辽东州共用 (5,2)。仅做显示偏移，不修改种子。
        this.displayOffsets.set(t.region_id, { dx: 0.38, dy: 0.42 });
      } else {
        usedCoords.add(key);
      }
    }
    this.regionCenters = this.map.territories.map((t) => {
      const coords = this.displayCoord(t.region, t.map_x, t.map_y);
      const w = mapToWorld(coords.x, coords.y);
      return { id: t.region_id, x: w.x, z: w.z };
    });

    this.buildTerrain();
    this.buildRegionCells();
    this.buildRoads();
    this.buildRivers();
    this.buildDecorations();
    this.buildTileLayer();
    this.buildNodes();
    this.buildRegionLabels();
    this.inspectGeometry();
  }

  private buildTerrain(): void {
    const noiseA = makeValueNoise(1337);
    const noiseB = makeValueNoise(4242);
    const fbm = (x: number, y: number) =>
      noiseA(x, y) * 0.55 + noiseA(x * 2.1, y * 2.1) * 0.26 + noiseB(x * 4.3, y * 4.3) * 0.12 + noiseB(x * 8.7, y * 8.7) * 0.07;

    const ridges = art.mountainRanges.flatMap((r) =>
      r.points.slice(0, -1).map((p, i) => ({ a: p, b: r.points[i + 1], h: r.height })),
    );
    const coast = art.coastline.map(([x, y]) => mapToWorld(x, y));

    const heightAt = (wx: number, wz: number): number => {
      let h = fbm(wx * 0.0022, wz * 0.0022) * 24 + fbm(wx * 0.008, wz * 0.008) * 5 - 6;
      h += Math.max(0, 1 - Math.abs(wz) / 900) * 3;
      for (const seg of ridges) {
        const ax = mapToWorld(seg.a[0], seg.a[1]).x;
        const az = mapToWorld(seg.a[0], seg.a[1]).z;
        const bx = mapToWorld(seg.b[0], seg.b[1]).x;
        const bz = mapToWorld(seg.b[0], seg.b[1]).z;
        const d = segmentDistance(wx, wz, ax, az, bx, bz);
        if (d < 170) h += Math.pow(1 - d / 170, 2) * 52 * seg.h;
      }
      // 海岸：东侧与南侧为海，东南大海湾
      const eastCoast = 420 + Math.sin(wz * 0.006) * 55;
      const southCoast = 430 + Math.sin(wx * 0.005) * 45;
      if (wx > eastCoast) h -= (wx - eastCoast) * 0.55;
      if (wz > southCoast) h -= (wz - southCoast) * 0.5;
      const sea = Math.max(0, -h + 2);
      h -= sea * 0.2;
      return h;
    };
    this.heightAt = heightAt;

    const size = 1700;
    const segments = this.quality === 'low' ? 90 : 180;
    this.terrainSize = size;
    this.terrainSegments = segments;
    const geo = new THREE.PlaneGeometry(size, size, segments, segments);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const colors: number[] = [];
    const grass = new THREE.Color('#aba77e');
    const dry = new THREE.Color('#c8b183');
    const rock = new THREE.Color('#a99c83');
    const snow = new THREE.Color('#e8e1cf');
    const sand = new THREE.Color('#d9c7a2');
    const under = new THREE.Color('#809da0');
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const h = heightAt(x, z);
      pos.setY(i, h);
      const c = new THREE.Color();
      if (h < -2) c.copy(under).lerp(new THREE.Color('#6e8e93'), Math.min(1, -h / 30));
      else if (h < 4) c.copy(sand);
      else if (h < 26) c.copy(grass).lerp(dry, Math.min(1, (h - 4) / 24));
      else if (h < 62) c.copy(rock).lerp(new THREE.Color('#c9bda5'), Math.min(1, (h - 26) / 40));
      else c.copy(rock).lerp(snow, Math.min(1, (h - 62) / 45));
      const jitter = (noiseB(x * 0.03, z * 0.03) - 0.5) * 0.045;
      c.offsetHSL(0, 0, jitter);
      colors.push(c.r, c.g, c.b);
    }
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    this.terrainBaseColors = colors.slice();
    this.terrainRegionIds = [];
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      let nearest = '';
      let best = Infinity;
      for (const c of this.regionCenters) {
        const d = (x - c.x) ** 2 + (z - c.z) ** 2;
        if (d < best) {
          best = d;
          nearest = c.id;
        }
      }
      this.terrainRegionIds.push(nearest);
    }
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.96, metalness: 0, flatShading: false });
    this.terrain = new THREE.Mesh(geo, mat);
    this.scene.add(this.terrain);

    const water = new THREE.Mesh(
      new THREE.PlaneGeometry(4000, 4000),
      new THREE.MeshStandardMaterial({ color: '#8fadb1', roughness: 0.82, metalness: 0.04, transparent: true, opacity: 0.9 }),
    );
    water.rotation.x = -Math.PI / 2;
    water.position.y = -3.7;
    this.scene.add(water);

    const foamMat = new THREE.LineBasicMaterial({ color: '#4d5b58', transparent: true, opacity: 0.5 });
    const coastGeo = new THREE.BufferGeometry().setFromPoints(
      coast.map((p) => new THREE.Vector3(p.x, 1.2, p.z)),
    );
    this.scene.add(new THREE.Line(coastGeo, foamMat));
    this.buildMountainInk(ridges);
  }

  /** 山脉皴线：用几条淡墨脊线替代厚重雾气，让山势更接近水墨制图。 */
  private buildMountainInk(ridges: { a: number[]; b: number[]; h: number }[]): void {
    const material = new THREE.LineBasicMaterial({ color: '#5f5545', transparent: true, opacity: 0.2 });
    const materialSoft = new THREE.LineBasicMaterial({ color: '#5f5545', transparent: true, opacity: 0.1 });
    for (const seg of ridges) {
      const wa = mapToWorld(seg.a[0], seg.a[1]);
      const wb = mapToWorld(seg.b[0], seg.b[1]);
      for (const [offset, mat] of [[0, material], [-18, materialSoft], [18, materialSoft]] as const) {
        const dx = wb.x - wa.x;
        const dz = wb.z - wa.z;
        const len = Math.hypot(dx, dz) || 1;
        const nx = (-dz / len) * offset;
        const nz = (dx / len) * offset;
        const points: THREE.Vector3[] = [];
        for (let i = 0; i <= 12; i++) {
          const t = i / 12;
          const x = THREE.MathUtils.lerp(wa.x, wb.x, t) + nx;
          const z = THREE.MathUtils.lerp(wa.z, wb.z, t) + nz;
          points.push(new THREE.Vector3(x, this.heightAt(x, z) + 3.5, z));
        }
        this.scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), mat));
      }
    }
  }

  private displayCoord(regionName: string, x: number, y: number): { x: number; y: number } {
    const t = this.map?.territories.find((item) => item.region === regionName);
    const offset = t ? this.displayOffsets.get(t.region_id) : undefined;
    return offset ? { x: x + offset.dx, y: y + offset.dy } : { x, y };
  }

  private buildRegionCells(): void {
    if (!this.map) return;
    for (const t of this.map.territories) {
      const coords = this.displayCoord(t.region, t.map_x, t.map_y);
      const w = mapToWorld(coords.x, coords.y);
      this.cells.push({
        regionId: t.region_id,
        name: t.region,
        faction: factionOf(t.faction),
        center: new THREE.Vector3(w.x, this.heightAt(w.x, w.z), w.z),
      });
    }

    // 边界由地形网格上的最近州府分配推导，保证无空洞、无重叠压盖。
    const geometry = this.terrain?.geometry as THREE.BufferGeometry | undefined;
    const pos = geometry?.attributes?.position as THREE.BufferAttribute | undefined;
    if (!pos) {
      this.inspectGeometry();
      return;
    }
    const cols = this.terrainSegments + 1;
    const spacing = this.terrainSize / this.terrainSegments;
    const half = spacing / 2;
    const verts: number[] = [];
    for (let row = 0; row < this.terrainSegments; row++) {
      for (let col = 0; col < this.terrainSegments; col++) {
        const index = row * cols + col;
        const id = this.terrainRegionIds[index];
        if (col < this.terrainSegments && this.terrainRegionIds[index + 1] !== id) {
          const x = (pos.getX(index) + pos.getX(index + 1)) / 2;
          const z = (pos.getZ(index) + pos.getZ(index + 1)) / 2;
          const y = this.heightAt(x, z) + 12;
          verts.push(x, y, z - half, x, y, z + half);
        }
        if (row < this.terrainSegments && this.terrainRegionIds[index + cols] !== id) {
          const x = (pos.getX(index) + pos.getX(index + cols)) / 2;
          const z = (pos.getZ(index) + pos.getZ(index + cols)) / 2;
          const y = this.heightAt(x, z) + 12;
          verts.push(x - half, y, z, x + half, y, z);
        }
      }
    }
    const borderGeo = new THREE.BufferGeometry();
    borderGeo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    const borders = new THREE.LineSegments(
      borderGeo,
      new THREE.LineBasicMaterial({ color: '#67583f', transparent: true, opacity: 0.46 }),
    );
    this.scene.add(borders);
    this.inspectGeometry();
  }

  private nearestRegionAt(x: number, z: number): string | null {
    let nearest: string | null = null;
    let best = Infinity;
    for (const c of this.regionCenters) {
      const d = (x - c.x) ** 2 + (z - c.z) ** 2;
      if (d < best) {
        best = d;
        nearest = c.id;
      }
    }
    return nearest;
  }

  private buildRoads(): void {
    if (!this.map) return;
    const centerByName = new Map(this.map.territories.map((t) => [t.region, t]));
    const group = new THREE.Group();
    for (const edge of this.map.edges as MapEdge[]) {
      const a = centerByName.get(edge.from_region);
      const b = centerByName.get(edge.to_region);
      if (!a || !b) continue;
      const ca = this.displayCoord(a.region, a.map_x, a.map_y);
      const cb = this.displayCoord(b.region, b.map_x, b.map_y);
      const wa = mapToWorld(ca.x, ca.y);
      const wb = mapToWorld(cb.x, cb.y);
      const points: THREE.Vector3[] = [];
      const steps = 14;
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const x = THREE.MathUtils.lerp(wa.x, wb.x, t);
        const z = THREE.MathUtils.lerp(wa.z, wb.z, t);
        points.push(new THREE.Vector3(x, this.heightAt(x, z) + 6, z));
      }
      const geo = new THREE.BufferGeometry().setFromPoints(points);
      const isRiver = /航道|水路|漕运|运河|江路|峡江|沿海/.test(edge.route_type);
      const material = new THREE.LineDashedMaterial({
        color: isRiver ? '#5c8288' : '#8b6c40',
        dashSize: 6,
        gapSize: 10,
        transparent: true,
        opacity: isRiver ? 0.38 : 0.34,
      });
      const line = new THREE.Line(geo, material);
      line.computeLineDistances();
      group.add(line);
    }
    this.roadGroup = group;
    this.scene.add(group);
  }

  private buildRivers(): void {
    const material = new THREE.MeshBasicMaterial({ color: '#5b8288', transparent: true, opacity: 0.74 });
    for (const river of art.rivers) {
      const curve = new THREE.CatmullRomCurve3(
        river.points.map(([x, y]) => {
          const w = mapToWorld(x, y);
          return new THREE.Vector3(w.x, 0, w.z);
        }),
      );
      const pts = curve.getPoints(90);
      const positions: number[] = [];
      const width = 7;
      for (let i = 0; i < pts.length - 1; i++) {
        const p = pts[i];
        const q = pts[i + 1];
        const dx = q.x - p.x;
        const dz = q.z - p.z;
        const len = Math.hypot(dx, dz) || 1;
        const nx = (-dz / len) * width;
        const nz = (dx / len) * width;
        const y1 = this.heightAt(p.x, p.z) + 2.2;
        const y2 = this.heightAt(q.x, q.z) + 2.2;
        positions.push(p.x + nx, y1, p.z + nz, p.x - nx, y1, p.z - nz, q.x + nx, y2, q.z + nz);
        positions.push(q.x + nx, y2, q.z + nz, p.x - nx, y1, p.z - nz, q.x - nx, y2, q.z - nz);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geo.computeVertexNormals();
      this.scene.add(new THREE.Mesh(geo, material));
    }
    for (const lake of art.lakes) {
      const w = mapToWorld(lake.x, lake.y);
      const geo = new THREE.CircleGeometry(1, 40);
      const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: '#5b8288', transparent: true, opacity: 0.76 }));
      mesh.rotation.x = -Math.PI / 2;
      mesh.scale.set(lake.rx * SCALE, lake.ry * SCALE, 1);
      mesh.position.set(w.x, this.heightAt(w.x, w.z) + 2.2, w.z);
      this.scene.add(mesh);
    }
  }

  private buildDecorations(): void {
    const rand = mulberry(9081);
    const treeGeo = new THREE.ConeGeometry(2.4, 9, 5);
    const trunkGeo = new THREE.CylinderGeometry(0.5, 0.7, 3, 4);
    const treeMat = new THREE.MeshStandardMaterial({ color: '#5d6b4b', roughness: 1, flatShading: true });
    const trunkMat = new THREE.MeshStandardMaterial({ color: '#5a4938', roughness: 1 });
    const treeCount = this.quality === 'low' ? 60 : 150;
    const treeMeshes = new THREE.InstancedMesh(treeGeo, treeMat, treeCount);
    const trunkMeshes = new THREE.InstancedMesh(trunkGeo, trunkMat, treeCount);
    const dummy = new THREE.Object3D();
    let placed = 0;
    for (const forest of art.forests) {
      const perForest = Math.floor(treeCount / art.forests.length);
      for (let i = 0; i < perForest; i++) {
        if (placed >= treeCount) break;
        const w = mapToWorld(forest.x, forest.y);
        const radius = forest.spread * SCALE;
        const x = w.x + (rand() - 0.5) * radius * 2;
        const z = w.z + (rand() - 0.5) * radius * 2;
        const h = this.heightAt(x, z);
        if (h < 2) continue;
        const scale = 1.1 + rand() * 1.1;
        dummy.position.set(x, h + 5, z);
        dummy.scale.setScalar(scale);
        dummy.rotation.y = rand() * Math.PI;
        dummy.updateMatrix();
        treeMeshes.setMatrixAt(placed, dummy.matrix);
        dummy.position.y = h + 1.5;
        dummy.updateMatrix();
        trunkMeshes.setMatrixAt(placed, dummy.matrix);
        placed++;
      }
    }
    treeMeshes.count = placed;
    trunkMeshes.count = placed;
    const decor = new THREE.Group();
    decor.add(treeMeshes, trunkMeshes);

    const rockGeo = new THREE.DodecahedronGeometry(4, 0);
    const rockMat = new THREE.MeshStandardMaterial({ color: '#9a8f7b', roughness: 1, flatShading: true });
    const rockCount = this.quality === 'low' ? 40 : 140;
    const rocks = new THREE.InstancedMesh(rockGeo, rockMat, rockCount);
    for (let i = 0; i < rockCount; i++) {
      const x = (rand() - 0.5) * 1300;
      const z = (rand() - 0.5) * 1300;
      const h = this.heightAt(x, z);
      if (h < 10) continue;
      dummy.position.set(x, h + 2, z);
      dummy.scale.set(0.4 + rand() * 1.4, 0.6 + rand() * 1.6, 0.4 + rand() * 1.2);
      dummy.rotation.set(rand(), rand(), rand());
      dummy.updateMatrix();
      rocks.setMatrixAt(i, dummy.matrix);
    }
    this.scene.add(rocks);
    rocks.visible = false;
    decor.add(rocks);
    this.decorGroup = decor;
    this.scene.add(decor);
  }

  /** 真·格子地图：地形色块 + 方格网 + 悬停光标。 */
  private buildTileLayer(): void {
    if (!this.tileMap) return;
    const group = new THREE.Group();
    const positions: number[] = [];
    const colors: number[] = [];
    const indices: number[] = [];
    const tint = new THREE.Color();
    let quads = 0;
    for (const tile of this.tileMap.tiles) {
      if (tile.terrain === 'plain') continue;
      const center = tileCenter(tile.x, tile.y);
      tint.set(TILE_TERRAIN_INFO[tile.terrain].color);
      const base = quads * 4;
      for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
        const w = mapToWorld(center.x + sx * TILE_SIZE * 0.5, center.y + sy * TILE_SIZE * 0.5);
        positions.push(w.x, this.heightAt(w.x, w.z) + 2.4, w.z);
        colors.push(tint.r, tint.g, tint.b);
      }
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
      quads++;
    }
    if (quads > 0) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
      geometry.setIndex(indices);
      const mesh = new THREE.Mesh(
        geometry,
        new THREE.MeshBasicMaterial({
          vertexColors: true,
          transparent: true,
          opacity: 0.28,
          depthWrite: false,
          side: THREE.DoubleSide,
        }),
      );
      mesh.renderOrder = 1;
      group.add(mesh);
    }

    const grid: number[] = [];
    const x0 = tileCenter(0, 0).x - TILE_SIZE / 2;
    const y0 = tileCenter(0, 0).y - TILE_SIZE / 2;
    const stride = this.quality === 'low' ? 2 : 1;
    for (let x = 0; x <= this.tileMap.width; x += stride) {
      let previous: THREE.Vector3 | null = null;
      for (let y = 0; y <= this.tileMap.height; y++) {
        const w = mapToWorld(x0 + x * TILE_SIZE, y0 + y * TILE_SIZE);
        const point = new THREE.Vector3(w.x, this.heightAt(w.x, w.z) + 2.6, w.z);
        if (previous) grid.push(previous.x, previous.y, previous.z, point.x, point.y, point.z);
        previous = point;
      }
    }
    for (let y = 0; y <= this.tileMap.height; y += stride) {
      let previous: THREE.Vector3 | null = null;
      for (let x = 0; x <= this.tileMap.width; x++) {
        const w = mapToWorld(x0 + x * TILE_SIZE, y0 + y * TILE_SIZE);
        const point = new THREE.Vector3(w.x, this.heightAt(w.x, w.z) + 2.6, w.z);
        if (previous) grid.push(previous.x, previous.y, previous.z, point.x, point.y, point.z);
        previous = point;
      }
    }
    const gridGeometry = new THREE.BufferGeometry();
    gridGeometry.setAttribute('position', new THREE.Float32BufferAttribute(grid, 3));
    this.tileGrid = new THREE.LineSegments(
      gridGeometry,
      new THREE.LineBasicMaterial({
        color: '#5d5546',
        transparent: true,
        opacity: this.quality === 'low' ? 0.09 : 0.16,
        depthWrite: false,
      }),
    );
    this.tileGrid.renderOrder = 2;
    group.add(this.tileGrid);

    const cursorGeometry = new THREE.BufferGeometry();
    cursorGeometry.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(12), 3));
    this.tileCursor = new THREE.LineLoop(
      cursorGeometry,
      new THREE.LineBasicMaterial({ color: '#f4d47a', transparent: true, opacity: 0.95, depthWrite: false }),
    );
    this.tileCursor.visible = false;
    this.tileCursor.renderOrder = 4;
    const fillGeometry = new THREE.PlaneGeometry(TILE_SIZE * SCALE * 0.9, TILE_SIZE * SCALE * 0.9);
    fillGeometry.rotateX(-Math.PI / 2);
    this.tileCursorFill = new THREE.Mesh(
      fillGeometry,
      new THREE.MeshBasicMaterial({
        color: '#f0d27c',
        transparent: true,
        opacity: 0.14,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    this.tileCursorFill.visible = false;
    this.tileCursorFill.renderOrder = 3;
    group.add(this.tileCursor, this.tileCursorFill);
    this.tileOverlay = group;
    this.scene.add(group);
  }

  private updateTileCursor(tile: { x: number; y: number } | null): void {
    if (!this.tileCursor || !this.tileCursorFill) return;
    if (!tile) {
      this.tileCursor.visible = false;
      this.tileCursorFill.visible = false;
      this.hoveredTile = null;
      return;
    }
    const same = this.hoveredTile && this.hoveredTile.x === tile.x && this.hoveredTile.y === tile.y;
    this.hoveredTile = { x: tile.x, y: tile.y };
    if (same && this.tileCursor.visible) return;
    const center = tileCenter(tile.x, tile.y);
    const attribute = this.tileCursor.geometry.getAttribute('position') as THREE.BufferAttribute;
    ([[-1, -1], [1, -1], [1, 1], [-1, 1]] as const).forEach(([sx, sy], index) => {
      const w = mapToWorld(center.x + sx * TILE_SIZE * 0.5, center.y + sy * TILE_SIZE * 0.5);
      attribute.setXYZ(index, w.x, this.heightAt(w.x, w.z) + 3, w.z);
    });
    attribute.needsUpdate = true;
    this.tileCursor.geometry.computeBoundingSphere();
    this.tileCursor.visible = true;
    const w = mapToWorld(center.x, center.y);
    this.tileCursorFill.position.set(w.x, this.heightAt(w.x, w.z) + 2.9, w.z);
    this.tileCursorFill.visible = true;
  }

  private buildNodes(): void {
    if (!this.map) return;
    const typeGroups = new Map<string, THREE.BufferGeometry[]>();
    for (const node of this.map.nodes) {
      const coords = this.displayCoord(node.region, node.map_x, node.map_y);
      const w = mapToWorld(coords.x, coords.y);
      const faction = factionOf(node.faction);
      const color = FACTION_VISUALS[faction].mapBorder;
      const mainColor = FACTION_VISUALS[faction].primary;
      const group = new THREE.Group();
      const isCapital = node.node_type === '州府/主城';
      const baseY = this.heightAt(w.x, w.z) + 3;

      const disc = new THREE.Mesh(
        new THREE.CylinderGeometry(isCapital ? 7 : 4.5, isCapital ? 8 : 5, 1.8, 8),
        new THREE.MeshStandardMaterial({ color: '#2b2823', roughness: 0.9 }),
      );
      disc.position.y = 0.5;
      group.add(disc);

      const type = node.node_type;
      const mat = new THREE.MeshStandardMaterial({ color: mainColor, roughness: 0.62, metalness: 0.15, flatShading: true });
      mat.userData.tone = 'primary';
      const accentMat = new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0.25, flatShading: true });
      accentMat.userData.tone = 'accent';
      if (type === '州府/主城') {
        const body = new THREE.Mesh(new THREE.BoxGeometry(9, 9, 9), mat);
        body.position.y = 5.5;
        const roof = new THREE.Mesh(new THREE.ConeGeometry(7.6, 5, 4), accentMat);
        roof.position.y = 12.4;
        roof.rotation.y = Math.PI / 4;
        const flag = this.buildFlag(mainColor, accentMat.color.getStyle(), 1);
        flag.position.set(6.5, 8, 4);
        group.add(body, roof, flag);
      } else if (type.includes('关隘')) {
        const tower = new THREE.Mesh(new THREE.BoxGeometry(4, 10, 4), mat);
        tower.position.set(-3, 5, 0);
        const tower2 = tower.clone();
        tower2.position.x = 3;
        const gate = new THREE.Mesh(new THREE.BoxGeometry(9, 3, 4), accentMat);
        gate.position.y = 3;
        group.add(tower, tower2, gate);
      } else if (type.includes('水军') || type.includes('渡口') || type.includes('港埠')) {
        const dock = new THREE.Mesh(new THREE.BoxGeometry(11, 1.6, 4), accentMat);
        dock.position.y = 1.2;
        const hull = new THREE.Mesh(new THREE.CylinderGeometry(2.4, 1.4, 7, 6), mat);
        hull.rotation.z = Math.PI / 2;
        hull.position.set(0, 2.6, 4);
        const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 8, 4), accentMat);
        mast.position.set(0, 6, 3);
        group.add(dock, hull, mast);
      } else if (type.includes('粮仓') || type.includes('粮盐')) {
        const silo = new THREE.Mesh(new THREE.CylinderGeometry(3, 3.4, 7, 8), mat);
        silo.position.y = 4;
        const roof = new THREE.Mesh(new THREE.ConeGeometry(3.8, 2.6, 8), accentMat);
        roof.position.y = 8.8;
        group.add(silo, roof);
      } else if (type.includes('矿')) {
        const hill = new THREE.Mesh(new THREE.ConeGeometry(5, 8, 5), new THREE.MeshStandardMaterial({ color: '#5a5148', roughness: 1, flatShading: true }));
        hill.position.y = 4;
        const mouth = new THREE.Mesh(new THREE.BoxGeometry(2.6, 3, 2.6), new THREE.MeshStandardMaterial({ color: '#1d1b18' }));
        mouth.position.set(3, 1.6, 0);
        group.add(hill, mouth);
      } else if (type.includes('牧场')) {
        const fence = new THREE.Mesh(new THREE.TorusGeometry(5, 0.35, 4, 18), accentMat);
        fence.rotation.x = -Math.PI / 2;
        fence.position.y = 2;
        const horse = new THREE.Mesh(new THREE.BoxGeometry(4, 2.4, 1.8), mat);
        horse.position.set(0, 3.2, 0);
        group.add(fence, horse);
      } else if (type.includes('市场') || type.includes('商路')) {
        const tent = new THREE.Mesh(new THREE.ConeGeometry(4.2, 4.5, 4), mat);
        tent.position.y = 3;
        const crate = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), accentMat);
        crate.position.set(4, 1.5, 1.6);
        group.add(tent, crate);
      } else if (type.includes('集镇') || type.includes('补给')) {
        const house = new THREE.Mesh(new THREE.BoxGeometry(6, 4, 5), mat);
        house.position.y = 2.6;
        group.add(house);
      } else {
        const marker = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 1.6, 6, 6), mat);
        marker.position.y = 3;
        group.add(marker);
      }

      group.position.set(w.x, baseY, w.z);
      group.userData = { type: 'node', nodeId: node.node_id, regionId: node.region };
      group.scale.setScalar(isCapital ? 1.28 : 0.82);
      this.scene.add(group);
      this.nodeGroups.push({ group, node });
      void typeGroups;
    }
  }

  private buildFlag(main: string, accent: string, glyphIndex: number): THREE.Group {
    const group = new THREE.Group();
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.35, 0.35, 20, 5),
      new THREE.MeshStandardMaterial({ color: '#7a6a52', roughness: 0.9 }),
    );
    pole.position.y = 10;
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 80;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = main;
    ctx.fillRect(0, 0, 128, 80);
    ctx.strokeStyle = accent;
    ctx.lineWidth = 5;
    ctx.strokeRect(4, 4, 120, 72);
    ctx.beginPath();
    ctx.moveTo(64, 18);
    ctx.lineTo(76, 34);
    ctx.lineTo(64, 62);
    ctx.lineTo(52, 34);
    ctx.closePath();
    ctx.fillStyle = accent;
    ctx.globalAlpha = 0.85;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.beginPath();
    ctx.moveTo(64, 24);
    ctx.lineTo(64, 54);
    ctx.strokeStyle = main;
    ctx.lineWidth = 4;
    ctx.stroke();
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const flag = new THREE.Mesh(
      new THREE.PlaneGeometry(16, 10),
      new THREE.MeshStandardMaterial({ map: texture, side: THREE.DoubleSide, transparent: true }),
    );
    flag.position.set(glyphIndex * 7, 16, 0);
    group.add(pole, flag);
    return group;
  }

  private buildRegionLabels(): void {
    if (!this.map) return;
    for (const t of this.map.territories) {
      const coords = this.displayCoord(t.region, t.map_x, t.map_y);
      const w = mapToWorld(coords.x, coords.y);
      const el = document.createElement('button');
      el.className = 'map-region-label';
      el.type = 'button';
      el.innerHTML = `<span class="rl-name">${t.region}</span><span class="rl-owner" data-region="${t.region_id}"></span><span class="rl-garrison"></span>`;
      el.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this.callbacks.onSelectRegion(t.region_id);
      });
      this.labelLayer.appendChild(el);
      this.regionLabels.push({
        el,
        position: new THREE.Vector3(w.x, this.heightAt(w.x, w.z) + 26, w.z),
        regionId: t.region_id,
        priority: false,
      });
    }
    for (const { node } of this.nodeGroups) {
      if (node.node_type === '州府/主城') continue;
      const coords = this.displayCoord(node.region, node.map_x, node.map_y);
      const w = mapToWorld(coords.x, coords.y);
      const el = document.createElement('div');
      el.className = 'map-node-label';
      el.textContent = node.node_name;
      this.labelLayer.appendChild(el);
      this.nodeLabels.push({
        el,
        position: new THREE.Vector3(w.x, this.heightAt(w.x, w.z) + 16, w.z),
        nodeId: node.node_id,
      });
    }
    this.refreshOwnership();
  }

  private refreshOwnership(): void {
    if (!this.view) return;
    const ownerByRegion = new Map(this.view.regions.map((r) => [r.regionId, r]));
    for (const cell of this.cells) {
      const region = ownerByRegion.get(cell.regionId);
      if (region) cell.faction = region.faction;
    }
    const ownerByMapNode = new Map(this.view.mapNodes.map((mapNode) => [mapNode.nodeId, mapNode]));
    for (const { group, node } of this.nodeGroups) {
      const region = ownerByRegion.get(node.region);
      const mapNode = ownerByMapNode.get(node.node_id);
      const faction = mapNode?.faction ?? region?.faction;
      if (!faction) continue;
      const colorPrimary = FACTION_VISUALS[faction].primary;
      const colorAccent = FACTION_VISUALS[faction].mapBorder;
      group.traverse((obj) => {
        const mat = (obj as THREE.Mesh).material as THREE.MeshStandardMaterial;
        if (!mat || !mat.color) return;
        if (mat.userData?.tone === 'accent') mat.color.set(colorAccent);
        else if (mat.userData?.tone === 'primary') mat.color.set(colorPrimary);
      });
    }
    for (const label of this.regionLabels) {
      const owner = label.el.querySelector('.rl-owner') as HTMLElement;
      const garrison = label.el.querySelector('.rl-garrison') as HTMLElement;
      const region = ownerByRegion.get(label.regionId);
      if (owner && region) {
        owner.textContent = FACTION_VISUALS[region.faction].shortName;
        owner.style.color = FACTION_VISUALS[region.faction].primary;
      }
      if (garrison) {
        if (region?.owned) {
          garrison.textContent = `守 ${formatTroops(region.garrison ?? 0)}`;
        } else if (region?.intel?.garrisonEstimate) {
          garrison.textContent = `守 ~${formatTroops(region.intel.garrisonEstimate)}（估）`;
        } else {
          garrison.textContent = '';
        }
      }
      label.el.classList.toggle('selected', label.regionId === this.selectedRegionId);
      label.el.classList.toggle('enemy', !region?.owned);
      label.priority = Boolean(region?.owned);
    }
    this.applyTerrainTint();
  }

  /** 地形顶点着色：确保 24 个州府完整覆盖大陆，不留空洞、不互相压盖。 */
  private applyTerrainTint(): void {
    const geometry = this.terrain?.geometry as THREE.BufferGeometry | undefined;
    const attr = geometry?.attributes?.color as THREE.BufferAttribute | undefined;
    if (!attr || !this.view) return;
    const regionById = new Map(this.view.regions.map((r) => [r.regionId, r]));
    const colors = attr.array as Float32Array;
    for (let i = 0; i < this.terrainRegionIds.length; i++) {
      const baseIndex = i * 3;
      const base = new THREE.Color(
        this.terrainBaseColors[baseIndex],
        this.terrainBaseColors[baseIndex + 1],
        this.terrainBaseColors[baseIndex + 2],
      );
      const region = regionById.get(this.terrainRegionIds[i]);
      if (region) {
        const tint = layerColor(this.view, region, this.layer);
        base.lerp(new THREE.Color(tint.color), Math.min(0.84, tint.alpha * 1.25));
      }
      colors[baseIndex] = base.r;
      colors[baseIndex + 1] = base.g;
      colors[baseIndex + 2] = base.b;
    }
    attr.needsUpdate = true;
  }

  private rebuildArmies(previousView?: PlayerView | null): void {
    for (const marker of this.armyMarkers) {
      this.scene.remove(marker.group);
      marker.label.remove();
      if (marker.route) {
        this.scene.remove(marker.route);
        marker.route.geometry.dispose();
      }
    }
    this.armyMarkers = [];
    this.marchAnimations = [];
    if (!this.view || !this.map) return;
    const territories = new Map(this.map.territories.map((t) => [t.region_id, t]));
    const mapNodes = new Map(this.map.nodes.map((node) => [node.node_id, node]));
    for (const army of this.view.armies) {
      const currentMapNode = army.mapNodeId ? mapNodes.get(army.mapNodeId) : undefined;
      const territory = territories.get(army.nodeId);
      if (!territory && !currentMapNode) continue;
      const coord = currentMapNode
        ? this.displayCoord(currentMapNode.region, currentMapNode.map_x, currentMapNode.map_y)
        : this.displayCoord(territory!.region, territory!.map_x, territory!.map_y);
      const tilePosition =
        army.own && army.tileX !== undefined && army.tileY !== undefined
          ? tileCenter(army.tileX, army.tileY)
          : null;
      const w = tilePosition ? mapToWorld(tilePosition.x, tilePosition.y) : mapToWorld(coord.x, coord.y);
      const group = new THREE.Group();
      const base = new THREE.Mesh(
        new THREE.CylinderGeometry(9, 10, 2, 16),
        new THREE.MeshStandardMaterial({
          color: FACTION_VISUALS[army.faction].primary,
          transparent: true,
          opacity: army.own ? 0.9 : 0.65,
          roughness: 0.7,
        }),
      );
      base.position.y = 1;
      group.add(base);
      const detailed = new THREE.Group();
      const unit = army.units?.[0];
      const unitId = unit?.unitId ?? defaultUnitFor(army.faction);
      const figures = Math.min(3, Math.max(1, Math.round((army.troops ?? 40000) / 60000) + 1));
      for (let i = 0; i < figures; i++) {
        const figure = buildUnitFigure(unitId, army.faction, army.own);
        figure.position.set((i - (figures - 1) / 2) * 11, 0, (i % 2) * 4);
        figure.rotation.y = Math.PI * 0.15;
        detailed.add(figure);
      }
      const flag = this.buildFlag(
        FACTION_VISUALS[army.faction].primary,
        FACTION_VISUALS[army.faction].mapBorder,
        1,
      );
      flag.scale.setScalar(0.9);
      flag.position.set(-10, 0, -8);
      detailed.add(flag);
      group.add(detailed);

      let icon: THREE.Sprite | null = null;
      if (army.own && unit) {
        const spriteMat = new THREE.SpriteMaterial({ depthTest: true, transparent: true });
        const texture = new THREE.TextureLoader().load(`/assets/units/${unit.unitId}.svg`, (t) => {
          t.colorSpace = THREE.SRGBColorSpace;
          spriteMat.map = t;
          spriteMat.needsUpdate = true;
        });
        void texture;
        icon = new THREE.Sprite(spriteMat);
        icon.scale.set(26, 26, 1);
        icon.position.y = 30;
        icon.visible = false;
        group.add(icon);
      }

      const position = new THREE.Vector3(w.x, this.heightAt(w.x, w.z) + 4, w.z);
      let routeLine: THREE.Line | null = null;
      const mapPath = army.mapPath ?? [];
      const tilePath = army.own ? army.tilePath ?? [] : [];
      let routePoints: THREE.Vector3[] = [];
      let tileRoute = false;
      if (army.own && tilePath.length > 0) {
        tileRoute = true;
        const startTile =
          army.tileX !== undefined && army.tileY !== undefined
            ? { x: army.tileX, y: army.tileY }
            : mapCoordToTile(coord.x, coord.y);
        routePoints = [startTile, ...tilePath].map((step) => {
          const center = tileCenter(step.x, step.y);
          const p = mapToWorld(center.x, center.y);
          return new THREE.Vector3(p.x, this.heightAt(p.x, p.z) + 8, p.z);
        });
      } else if (army.own && army.mapNodeId && mapPath.length > 0) {
        routePoints = [army.mapNodeId, ...mapPath]
          .map((id) => {
            const node = mapNodes.get(id);
            if (!node) return null;
            const c = this.displayCoord(node.region, node.map_x, node.map_y);
            const p = mapToWorld(c.x, c.y);
            return new THREE.Vector3(p.x, this.heightAt(p.x, p.z) + 8, p.z);
          })
          .filter((p): p is THREE.Vector3 => Boolean(p));
      } else if (army.own && army.path.length > 0) {
        routePoints = [army.nodeId, ...army.path]
          .map((id) => {
            const t = territories.get(id);
            if (!t) return null;
            const c = this.displayCoord(t.region, t.map_x, t.map_y);
            const p = mapToWorld(c.x, c.y);
            return new THREE.Vector3(p.x, this.heightAt(p.x, p.z) + 8, p.z);
          })
          .filter((p): p is THREE.Vector3 => Boolean(p));
      }
      if (routePoints.length > 1) {
        const routeGeo = new THREE.BufferGeometry().setFromPoints(routePoints);
        routeLine = new THREE.Line(
          routeGeo,
          new THREE.LineDashedMaterial({ color: '#e5c46d', dashSize: 14, gapSize: 8, transparent: true, opacity: 0.85 }),
        );
        routeLine.computeLineDistances();
        this.scene.add(routeLine);
        if (!tileRoute) {
          const routePoint = pointAlong(routePoints, army.progress);
          position.set(routePoint.x, routePoint.y + 4, routePoint.z);
        }
      }
      group.position.copy(position);
      group.scale.setScalar(1.3);
      group.userData = { type: 'army', armyId: army.armyId };
      this.scene.add(group);

      const label = document.createElement('div');
      label.className = `map-army-label ${army.own ? 'own' : 'enemy'}`;
      label.style.setProperty('--faction-color', FACTION_VISUALS[army.faction].primary);
      const marchBadge = army.own && army.status === 'marching' ? '<span class="al-status">行军中</span>' : '';
      label.innerHTML = `<span class="al-name">${army.own ? army.name : '敌踪'}</span><span class="al-troops">${army.troopsLabel}</span>${marchBadge}`;
      label.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this.callbacks.onSelectArmy(army.armyId);
      });
      this.labelLayer.appendChild(label);

      const marker: ArmyMarker = {
        armyId: army.armyId,
        group,
        detailed,
        icon,
        label,
        position: position.clone(),
        route: routeLine,
        isOwn: army.own,
        marching: Boolean(army.own && army.status === 'marching'),
      };
      this.armyMarkers.push(marker);
      const waypoints = this.marchWaypoints(previousView, army);
      if (waypoints) {
        marker.group.position.copy(waypoints[0]);
        marker.position.copy(waypoints[0]);
        if (marker.route) marker.route.visible = false;
        this.marchAnimations.push({
          marker,
          points: waypoints,
          elapsed: -this.marchAnimations.length * 0.07,
          duration: THREE.MathUtils.clamp((waypoints.length - 1) * 0.16, 0.8, 4.2),
        });
      }
    }
    this.refreshOwnership();
    this.inspectGeometry();
  }

  /** 对比上一回合的 PlayerView，若本回合确有位移，则沿原计划路线逐格播放行军。 */
  private marchWaypoints(
    previousView: PlayerView | null | undefined,
    army: PlayerView['armies'][number],
  ): THREE.Vector3[] | null {
    if (!previousView || !this.view) return null;
    if (previousView.gameId !== this.view.gameId) return null;
    if (previousView.date.turn + 1 !== this.view.date.turn) return null;
    if (!army.own || army.tileX === undefined || army.tileY === undefined) return null;
    const previous = previousView.armies.find((item) => item.armyId === army.armyId);
    if (!previous?.own || previous.tileX === undefined || previous.tileY === undefined) return null;
    const from = { x: previous.tileX, y: previous.tileY };
    const to = { x: army.tileX, y: army.tileY };
    if (from.x === to.x && from.y === to.y) return null;
    const planned = [from, ...(previous.tilePath ?? [])];
    let index = -1;
    for (let i = planned.length - 1; i >= 1; i--) {
      if (planned[i].x === to.x && planned[i].y === to.y) {
        index = i;
        break;
      }
    }
    let tiles: { x: number; y: number }[];
    if (index >= 1) {
      tiles = planned.slice(0, index + 1);
    } else {
      // 战败撤退、换路或旧档修正不在原路线内：近距离滑行，远距离直接落位，避免穿山越岭。
      if (Math.hypot(to.x - from.x, to.y - from.y) > 8) return null;
      tiles = [from, to];
    }
    return tiles.map((tile) => {
      const center = tileCenter(tile.x, tile.y);
      const point = mapToWorld(center.x, center.y);
      return new THREE.Vector3(point.x, this.heightAt(point.x, point.z) + 4, point.z);
    });
  }

  /* ----------------------------- 输入与循环 ----------------------------- */

  private bindPointer(): void {
    const el = this.renderer.domElement;
    const down = (ev: PointerEvent) => {
      this.dragging = true;
      this.dragMode = ev.button === 2 || ev.shiftKey ? 'rotate' : 'pan';
      this.lastPointer = { x: ev.clientX, y: ev.clientY };
      this.downPointer = { x: ev.clientX, y: ev.clientY };
      el.style.cursor = 'grabbing';
    };
    const move = (ev: PointerEvent) => {
      this.pointer.x = (ev.clientX / el.clientWidth) * 2 - 1;
      this.pointer.y = -(ev.clientY / el.clientHeight) * 2 + 1;
      if (this.dragging) {
        const dx = ev.clientX - this.lastPointer.x;
        const dy = ev.clientY - this.lastPointer.y;
        this.lastPointer = { x: ev.clientX, y: ev.clientY };
        if (this.dragMode === 'rotate') {
          this.yaw -= dx * 0.005;
          this.pitch = THREE.MathUtils.clamp(this.pitch + dy * 0.004, 0.32, 1.42);
        } else {
          this.panBy(-dx * (this.distance / 700), -dy * (this.distance / 700));
        }
        return;
      }
      this.hover(ev);
    };
    const up = (ev: PointerEvent) => {
      const wasDragging = this.dragging;
      this.dragging = false;
      el.style.cursor = 'grab';
      if (!wasDragging) return;
      void ev;
    };
    const click = (ev: MouseEvent) => {
      const moved = Math.hypot(ev.clientX - this.downPointer.x, ev.clientY - this.downPointer.y);
      if (moved > 4) return;
      this.pick(ev);
    };
    const dbl = (ev: MouseEvent) => {
      const hit = this.pickRegion(ev);
      if (hit) this.focusRegion(hit.regionId);
    };
    const leave = () => {
      this.hoverRing.visible = false;
      this.updateTileCursor(null);
      this.callbacks.onHover(null);
    };
    const context = (ev: Event) => ev.preventDefault();
    const wheel = (ev: WheelEvent) => {
      ev.preventDefault();
      this.desiredDistance = THREE.MathUtils.clamp(this.desiredDistance * (1 + ev.deltaY * 0.0012), 190, 1400);
    };
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('click', click);
    el.addEventListener('dblclick', dbl);
    el.addEventListener('pointerleave', leave);
    el.addEventListener('contextmenu', context);
    el.addEventListener('wheel', wheel, { passive: false });
    this.pointerHandlers = [
      ['pointerdown', down as EventListener],
      ['pointermove', move as EventListener],
      ['pointerup', up as EventListener],
      ['click', click as EventListener],
      ['dblclick', dbl as EventListener],
      ['pointerleave', leave as EventListener],
      ['contextmenu', context as EventListener],
      ['wheel', wheel as EventListener],
    ];
  }

  private pickRegion(ev: MouseEvent): { regionId: string; name: string; faction: FactionKey; center: THREE.Vector3 } | null {
    if (!this.terrain) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObject(this.terrain, false);
    if (hits.length === 0) return null;
    const point = hits[0].point;
    const id = this.nearestRegionAt(point.x, point.z);
    return this.cells.find((c) => c.regionId === id) ?? null;
  }

  private pickTerrain(ev: MouseEvent): { tile: { x: number; y: number }; data: MapTile } | null {
    if (!this.terrain || !this.tileMap) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObject(this.terrain, false);
    if (hits.length === 0) return null;
    const point = hits[0].point;
    const tile = mapCoordToTile(point.x / SCALE + ORIGIN_X, point.z / SCALE + ORIGIN_Y);
    const data = tileAt(this.tileMap, tile.x, tile.y);
    return data ? { tile, data } : null;
  }

  private pick(ev: MouseEvent): void {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const armyTargets = this.armyMarkers.map((m) => m.group);
    const armyHits = this.raycaster.intersectObjects(armyTargets, true);
    if (armyHits.length > 0) {
      let obj: THREE.Object3D | null = armyHits[0].object;
      while (obj && !obj.userData?.armyId) obj = obj.parent;
      if (obj) {
        this.callbacks.onSelectArmy(obj.userData.armyId);
        return;
      }
    }
    const nodeTargets = this.nodeGroups.map((n) => n.group);
    const nodeHits = this.raycaster.intersectObjects(nodeTargets, true);
    if (nodeHits.length > 0) {
      let obj: THREE.Object3D | null = nodeHits[0].object;
      while (obj && !obj.userData?.nodeId) obj = obj.parent;
      if (obj) {
        this.callbacks.onSelectNode(obj.userData.nodeId);
        return;
      }
    }
    const terrainHit = this.pickTerrain(ev);
    if (terrainHit) {
      this.callbacks.onSelectTile(terrainHit.tile, terrainHit.data.regionId);
      return;
    }
    const region = this.pickRegion(ev);
    if (region) this.callbacks.onSelectRegion(region.regionId);
  }

  private hover(ev: MouseEvent): void {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const terrainHit = this.pickTerrain(ev);
    this.updateTileCursor(terrainHit?.tile ?? null);
    const region = terrainHit
      ? this.cells.find((cell) => cell.regionId === terrainHit.data.regionId) ?? null
      : this.pickRegion(ev);
    this.hovered = region?.regionId ?? null;
    if (region) {
      this.hoverRing.position.copy(region.center).setY(region.center.y + 8);
      this.hoverRing.visible = true;
      const rv = this.view?.regions.find((r) => r.regionId === region.regionId);
      const tileHint = terrainHit
        ? ` · ${TILE_TERRAIN_INFO[terrainHit.data.terrain].label} (${terrainHit.tile.x},${terrainHit.tile.y})`
        : '';
      if (rv) {
        this.callbacks.onHover({
          title: rv.name,
          subtitle: `${rv.ownerShort}${tileHint}${rv.owned ? ` · 治安 ${rv.order} / 忠诚 ${rv.loyalty}` : rv.intel ? ' · 有斥候情报' : ' · 情报未详'}${rv.threat > 20 ? ` · 威胁 ${rv.threat}` : ''}`,
          x: ev.clientX - rect.left,
          y: ev.clientY - rect.top,
        });
      } else if (terrainHit) {
        this.callbacks.onHover({
          title: this.tileMap?.regionNames[terrainHit.data.regionId] ?? '未详之地',
          subtitle: `${TILE_TERRAIN_INFO[terrainHit.data.terrain].label} (${terrainHit.tile.x},${terrainHit.tile.y})`,
          x: ev.clientX - rect.left,
          y: ev.clientY - rect.top,
        });
      }
    } else {
      this.hoverRing.visible = false;
      this.callbacks.onHover(null);
    }
  }

  private inspectGeometry(): void {
    this.scene.traverse((obj) => {
      const geometry = (obj as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
      const attr = geometry?.attributes?.position as THREE.BufferAttribute | undefined;
      if (!attr) return;
      for (let i = 0; i < attr.count; i++) {
        if (!Number.isFinite(attr.getX(i)) || !Number.isFinite(attr.getY(i)) || !Number.isFinite(attr.getZ(i))) {
          console.warn(
            'NaN geometry',
            obj.type,
            geometry?.type,
            (obj.userData as any)?.regionId ?? '',
            'at',
            attr.getX(i),
            attr.getY(i),
            attr.getZ(i),
            'index',
            i,
          );
          break;
        }
      }
    });
  }

  private updateMarchAnimations(): void {
    if (this.marchAnimations.length === 0) return;
    this.marchAnimations = this.marchAnimations.filter((anim) => {
      anim.elapsed += 0.016;
      if (anim.elapsed < 0) return true;
      const t = Math.min(1, anim.elapsed / anim.duration);
      const eased = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      const point = pointAlong(anim.points, eased);
      anim.marker.group.position.copy(point);
      anim.marker.position.copy(point);
      if (t >= 1) {
        if (anim.marker.route) anim.marker.route.visible = true;
        return false;
      }
      return true;
    });
  }

  private animate = (): void => {
    if (this.disposed) return;
    this.frame = requestAnimationFrame(this.animate);
    this.animations.time += 0.016;
    this.target.lerp(this.desiredTarget, 0.075);
    this.distance += (this.desiredDistance - this.distance) * 0.08;
    const cosPitch = Math.cos(this.pitch);
    this.camera.position.set(
      this.target.x + Math.sin(this.yaw) * cosPitch * this.distance,
      this.target.y + Math.sin(this.pitch) * this.distance,
      this.target.z + Math.cos(this.yaw) * cosPitch * this.distance,
    );
    this.camera.lookAt(this.target);
    const ringMaterial = this.selectionRing.material as THREE.MeshBasicMaterial;
    ringMaterial.opacity = 0.55 + Math.sin(this.animations.time * 2.2) * 0.25;
    this.selectionRing.scale.setScalar(1 + Math.sin(this.animations.time * 1.5) * 0.04);

    if (this.roadGroup) this.roadGroup.visible = this.distance < 700;
    if (this.tileGrid) this.tileGrid.visible = this.distance < 1250;
    if (this.tileOverlay) this.tileOverlay.visible = this.distance < 1500;
    if (this.decorGroup) this.decorGroup.visible = this.distance < 640 && this.quality === 'high';
    this.updateMarchAnimations();

    for (const marker of this.armyMarkers) {
      if (marker.route) {
        const routeMaterial = marker.route.material as THREE.LineDashedMaterial;
        routeMaterial.opacity = 0.62 + Math.sin(this.animations.time * 2.4) * 0.16;
      }
      const dist = this.camera.position.distanceTo(marker.group.position);
      const detailed = dist < 750;
      marker.detailed.visible = detailed;
      if (marker.icon) marker.icon.visible = !detailed;
      const label = marker.label;
      if (this.labels && dist < 720) {
        const projected = marker.group.position.clone();
        projected.y += detailed ? 34 : 20;
        const screen = this.project(projected);
        label.style.display = screen.visible ? 'flex' : 'none';
        if (screen.visible) label.style.transform = `translate(-50%, -100%) translate(${screen.x}px, ${screen.y}px)`;
      } else {
        label.style.display = 'none';
      }
    }
    if (this.labels) {
      const placed: { x: number; y: number }[] = [];
      const ordered = [...this.regionLabels].sort((a, b) => Number(b.priority) - Number(a.priority));
      for (const label of ordered) {
        const screen = this.project(label.position);
        let show = screen.visible && this.distance < 1250;
        if (show) {
          const overlap = placed.some((p) => Math.abs(p.x - screen.x) < 80 && Math.abs(p.y - screen.y) < 26);
          show = !overlap;
        }
        if (show) {
          placed.push({ x: screen.x, y: screen.y });
          label.el.style.transform = `translate(-50%, -50%) translate(${screen.x}px, ${screen.y}px)`;
        }
        label.el.style.display = show ? 'flex' : 'none';
      }
      const showNodes = this.distance < 460 && this.quality === 'high';
      const placedNodes: { x: number; y: number }[] = [];
      for (const label of this.nodeLabels) {
        const screen = this.project(label.position);
        let show = screen.visible && showNodes;
        if (show) {
          const overlap = placedNodes.some((p) => Math.abs(p.x - screen.x) < 58 && Math.abs(p.y - screen.y) < 20);
          show = !overlap;
        }
        if (show) {
          placedNodes.push({ x: screen.x, y: screen.y });
          label.el.style.transform = `translate(-50%, -50%) translate(${screen.x}px, ${screen.y}px)`;
        }
        label.el.style.display = show ? 'block' : 'none';
      }
    } else {
      for (const label of this.regionLabels) label.el.style.display = 'none';
      for (const label of this.nodeLabels) label.el.style.display = 'none';
    }
    this.renderer.render(this.scene, this.camera);
  };

  private project(world: THREE.Vector3): { x: number; y: number; visible: boolean } {
    const v = world.clone().project(this.camera);
    return {
      x: ((v.x + 1) / 2) * this.container.clientWidth,
      y: ((1 - v.y) / 2) * this.container.clientHeight,
      visible: v.z < 1 && v.x > -1.2 && v.x < 1.2 && v.y > -1.2 && v.y < 1.2,
    };
  }
}


function defaultUnitFor(faction: FactionKey): string {
  return faction === 'HUN' ? 'HUN-U001' : faction === 'YONG' ? 'YONG-U001' : 'CHU-U001';
}

function formatTroops(n: number): string {
  if (n >= 10_000) return `${(n / 10_000).toFixed(n >= 100_000 ? 0 : 1)}万`;
  return n.toLocaleString();
}

function pointAlong(points: THREE.Vector3[], t: number): THREE.Vector3 {
  if (points.length === 1) return points[0].clone();
  const lengths: number[] = [];
  let total = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const len = points[i].distanceTo(points[i + 1]);
    lengths.push(len);
    total += len;
  }
  let remaining = THREE.MathUtils.clamp(t, 0, 1) * total;
  for (let i = 0; i < lengths.length; i++) {
    if (remaining <= lengths[i]) {
      return points[i].clone().lerp(points[i + 1], remaining / (lengths[i] || 1));
    }
    remaining -= lengths[i];
  }
  return points[points.length - 1].clone();
}

/** 22 个兵种的低多边形剪影：按兵种模板改变马匹、武器、甲胄与旗帜。 */
export function buildUnitFigure(unitId: string, faction: FactionKey, own: boolean): THREE.Group {
  const group = new THREE.Group();
  const primary = FACTION_VISUALS[faction].primary;
  const accent = FACTION_VISUALS[faction].mapBorder;
  const metal = new THREE.MeshStandardMaterial({ color: own ? '#8d8d92' : '#615f5d', roughness: 0.55, metalness: 0.5, flatShading: true });
  const cloth = new THREE.MeshStandardMaterial({ color: primary, roughness: 0.85, flatShading: true });
  const trim = new THREE.MeshStandardMaterial({ color: accent, roughness: 0.6, metalness: 0.2, flatShading: true });
  const dark = new THREE.MeshStandardMaterial({ color: '#2a2825', roughness: 0.9 });
  const unit = UNIT_VISUALS[unitId] ?? { kind: 'infantry_heavy', mount: false, bow: false, shield: true, weapon: 'spear', scale: 1 };
  const s = unit.scale * 1.15;

  const addSoldier = (x: number, z: number) => {
    const sol = new THREE.Group();
    const torso = new THREE.Mesh(new THREE.BoxGeometry(3.6, 6.4, 2.4), cloth);
    torso.position.y = 7.2;
    const head = new THREE.Mesh(new THREE.SphereGeometry(1.7, 8, 6), new THREE.MeshStandardMaterial({ color: '#d9b28a', roughness: 0.9 }));
    head.position.y = 11.4;
    const helmet = new THREE.Mesh(new THREE.ConeGeometry(2.2, 2.8, 6), metal);
    helmet.position.y = 12.8;
    helmet.userData.accent = true;
    sol.add(torso, head, helmet);
    if (unit.shield) {
      const shield = new THREE.Mesh(new THREE.BoxGeometry(0.7, 5.4, 3.6), metal);
      shield.position.set(-2.1, 7, 0.4);
      sol.add(shield);
    }
    if (unit.weapon === 'bow') {
      const bow = new THREE.Mesh(new THREE.TorusGeometry(2.4, 0.28, 4, 12, Math.PI), trim);
      bow.position.set(2, 7.4, 1);
      bow.rotation.x = Math.PI / 2;
      bow.rotation.z = Math.PI / 2;
      sol.add(bow);
    } else if (unit.weapon === 'crossbow') {
      const stock = new THREE.Mesh(new THREE.BoxGeometry(5, 0.7, 1), dark);
      stock.position.set(2.4, 7, 1.4);
      const bow = new THREE.Mesh(new THREE.BoxGeometry(5.4, 0.4, 1.6), metal);
      bow.position.set(2.4, 7, 1.4);
      bow.rotation.y = Math.PI / 2;
      sol.add(stock, bow);
    } else if (unit.weapon === 'axe' || unit.weapon === 'halberd') {
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 11, 5), dark);
      pole.position.set(2.2, 7, 0);
      pole.rotation.z = -0.18;
      const blade = new THREE.Mesh(new THREE.BoxGeometry(0.4, 3.4, 3), metal);
      blade.position.set(3.1, 12, 0);
      sol.add(pole, blade);
    } else {
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 12, 5), dark);
      pole.position.set(2.1, 7.6, 0);
      const tip = new THREE.Mesh(new THREE.ConeGeometry(0.8, 2.4, 5), metal);
      tip.position.set(2.1, 14.6, 0);
      sol.add(pole, tip);
    }
    if (unit.mount) {
      const horse = new THREE.Group();
      const body = new THREE.Mesh(new THREE.BoxGeometry(7.6, 2.8, 3.1), new THREE.MeshStandardMaterial({ color: '#4a3a2e', roughness: 0.9, flatShading: true }));
      body.position.y = 4.4;
      const neck = new THREE.Mesh(new THREE.BoxGeometry(2.4, 4.6, 2.2), new THREE.MeshStandardMaterial({ color: '#4a3a2e', roughness: 0.9 }));
      neck.position.set(3.6, 6.3, 0);
      neck.rotation.z = -0.5;
      const head = new THREE.Mesh(new THREE.BoxGeometry(3.2, 1.7, 1.5), new THREE.MeshStandardMaterial({ color: '#3f3127', roughness: 0.9 }));
      head.position.set(5.2, 7.3, 0);
      horse.add(body, neck, head);
      for (const [lx, lz] of [[-2.6, 1.2], [-2.6, -1.2], [2.4, 1.2], [2.4, -1.2]] as const) {
        const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.4, 4.2, 4), dark);
        leg.position.set(lx, 2, lz);
        horse.add(leg);
      }
      horse.position.set(0, 0, 0);
      sol.add(horse);
      sol.position.y = 2.4;
      sol.scale.setScalar(0.84);
      if (unit.kind === 'cavalry_guard' || unit.kind === 'cavalry_heavy') {
        const barding = new THREE.Mesh(new THREE.BoxGeometry(6.4, 2.4, 3.4), trim.clone());
        barding.position.set(0, 5.2, 0);
        (barding.material as THREE.MeshStandardMaterial).transparent = true;
        (barding.material as THREE.MeshStandardMaterial).opacity = 0.75;
        sol.add(barding);
      }
    }
    sol.position.set(x, 0, z);
    sol.scale.setScalar(s);
    group.add(sol);
    return sol;
  };

  if (unit.kind === 'naval') {
    const hull = new THREE.Mesh(new THREE.BoxGeometry(14, 2.6, 5), cloth);
    hull.position.y = 2;
    const bow = new THREE.Mesh(new THREE.ConeGeometry(2.4, 4, 4), cloth);
    bow.rotation.z = -Math.PI / 2;
    bow.position.set(8.5, 2, 0);
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 14, 5), dark);
    mast.position.set(0, 9, 0);
    const sail = new THREE.Mesh(new THREE.PlaneGeometry(9, 9), trim);
    sail.position.set(2, 11, 0);
    sail.material.side = THREE.DoubleSide;
    group.add(hull, bow, mast, sail);
    addSoldier(-3, 0);
    addSoldier(3, 0);
  } else if (unit.mount) {
    addSoldier(0, 0);
    if (unit.kind === 'cavalry_archer') addSoldier(9, 0);
  } else {
    addSoldier(-5, 0);
    addSoldier(4, 1.4);
    if (unit.kind === 'infantry_guard' || unit.kind === 'infantry_heavy') addSoldier(0, -5);
  }
  return group;
}

const UNIT_VISUALS: Record<string, { kind: string; mount: boolean; bow: boolean; shield: boolean; weapon: string; scale: number }> = {
  'HUN-U001': { kind: 'cavalry_heavy', mount: true, bow: false, shield: false, weapon: 'spear', scale: 1.1 },
  'HUN-U002': { kind: 'cavalry_heavy', mount: true, bow: false, shield: true, weapon: 'spear', scale: 1.05 },
  'HUN-U003': { kind: 'cavalry_guard', mount: true, bow: true, shield: false, weapon: 'bow', scale: 1 },
  'HUN-U004': { kind: 'cavalry_heavy', mount: true, bow: false, shield: true, weapon: 'spear', scale: 1 },
  'HUN-U005': { kind: 'infantry_light', mount: false, bow: true, shield: false, weapon: 'bow', scale: 0.9 },
  'CHU-U001': { kind: 'infantry_light', mount: false, bow: true, shield: false, weapon: 'bow', scale: 0.9 },
  'CHU-U002': { kind: 'naval', mount: false, bow: true, shield: false, weapon: 'bow', scale: 1 },
  'CHU-U003': { kind: 'cavalry_archer', mount: true, bow: true, shield: false, weapon: 'bow', scale: 1 },
  'CHU-U004': { kind: 'crossbow', mount: false, bow: true, shield: false, weapon: 'crossbow', scale: 0.95 },
  'CHU-U005': { kind: 'infantry_shock', mount: false, bow: false, shield: true, weapon: 'axe', scale: 0.95 },
  'CHU-U006': { kind: 'infantry_heavy', mount: false, bow: false, shield: true, weapon: 'spear', scale: 1 },
  'CHU-U007': { kind: 'infantry_shock', mount: false, bow: false, shield: true, weapon: 'halberd', scale: 1 },
  'CHU-U008': { kind: 'infantry_heavy', mount: false, bow: false, shield: true, weapon: 'spear', scale: 1 },
  'CHU-U009': { kind: 'cavalry_light', mount: true, bow: false, shield: false, weapon: 'spear', scale: 0.95 },
  'YONG-U001': { kind: 'infantry_heavy', mount: false, bow: false, shield: true, weapon: 'halberd', scale: 1 },
  'YONG-U002': { kind: 'cavalry_heavy', mount: true, bow: false, shield: false, weapon: 'spear', scale: 1.05 },
  'YONG-U003': { kind: 'infantry_guard', mount: false, bow: false, shield: true, weapon: 'spear', scale: 1 },
  'YONG-U004': { kind: 'cavalry_heavy', mount: true, bow: false, shield: true, weapon: 'halberd', scale: 1.1 },
  'YONG-U005': { kind: 'infantry_guard', mount: false, bow: false, shield: true, weapon: 'sword', scale: 1 },
  'YONG-U006': { kind: 'cavalry_heavy', mount: true, bow: false, shield: false, weapon: 'spear', scale: 1 },
  'YONG-U007': { kind: 'infantry_spear', mount: false, bow: false, shield: true, weapon: 'spear', scale: 1 },
  'YONG-U008': { kind: 'cavalry_guard', mount: true, bow: true, shield: false, weapon: 'bow', scale: 1 },
};

/** 半平面裁剪：保留更靠近自身中心的区域，形成 24 个州的 Voronoi 拼图。 */
function voronoiCell(
  x: number,
  z: number,
  centers: { x: number; z: number }[],
  half: number,
): THREE.Vector2[] {
  let poly = [
    new THREE.Vector2(x - half, z - half),
    new THREE.Vector2(x + half, z - half),
    new THREE.Vector2(x + half, z + half),
    new THREE.Vector2(x - half, z + half),
  ];
  for (const other of centers) {
    if (other.x === x && other.z === z) continue;
    const dx = other.x - x;
    const dz = other.z - z;
    const mx = (x + other.x) / 2;
    const mz = (z + other.z) / 2;
    const inside = (p: THREE.Vector2) => (p.x - mx) * dx + (p.y - mz) * dz <= 0;
    const clipped: THREE.Vector2[] = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      const ain = inside(a);
      const bin = inside(b);
      if (ain) clipped.push(a.clone());
      if (ain !== bin) {
        const ex = b.x - a.x;
        const ez = b.y - a.y;
        const denom = ex * dx + ez * dz;
        const t = Math.abs(denom) < 1e-9 ? 0 : ((mx - a.x) * dx + (mz - a.y) * dz) / denom;
        clipped.push(new THREE.Vector2(a.x + ex * t, a.y + ez * t));
      }
    }
    poly = clipped;
    if (poly.length === 0) break;
  }
  return poly;
}
