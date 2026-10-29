import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { FACTION_VISUALS, type BattleReplay, type ReplayStageKey } from '@tianming/shared';

interface Battlefield3DProps {
  replay: BattleReplay;
  stageIndex: number;
  onError?: () => void;
}

interface Soldier {
  group: THREE.Group;
  target: THREE.Vector3;
  meshes: THREE.Mesh[];
  originalMaterials: THREE.Material[];
  fallen: boolean;
  side: 'attacker' | 'defender';
  index: number;
}

interface BattlefieldRuntime {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  attackers: Soldier[];
  defenders: Soldier[];
  fallenMaterial: THREE.Material;
  animationFrame: number;
  lastFrameTime: number;
  resizeObserver: ResizeObserver;
}

const FORMATION_SIZE = 18;
const TERRAIN_COLORS: Record<string, { ground: number; lane: number; accent: number }> = {
  plain: { ground: 0x526246, lane: 0x89714e, accent: 0xb7ad79 },
  hill: { ground: 0x62694b, lane: 0x89714e, accent: 0xa4a178 },
  mountain: { ground: 0x555c59, lane: 0x777264, accent: 0xb4b5aa },
  forest: { ground: 0x344a38, lane: 0x736346, accent: 0x54704b },
  river: { ground: 0x3f5b54, lane: 0x89714e, accent: 0x477f91 },
};

function stagePose(
  stage: ReplayStageKey,
  side: 'attacker' | 'defender',
  index: number,
  attackerWon: boolean,
): { x: number; z: number } {
  const rank = Math.floor(index / 6);
  const file = index % 6;
  let x = side === 'attacker' ? -13 + rank * 1.2 : 13 - rank * 1.2;
  let z = (file - 2.5) * 1.22;

  switch (stage) {
    case 'diversion':
      x += side === 'attacker' ? 0.6 : -0.5;
      z += side === 'attacker' && rank === 2 ? (file < 3 ? -1.2 : 1.2) : 0;
      break;
    case 'engage':
      x += side === 'attacker' ? 4.0 : -4.0;
      break;
    case 'ambush':
      x += side === 'defender' ? -2.6 : -0.2;
      z += file < 3 ? -1.25 : 1.25;
      break;
    case 'maneuver':
      if (side === 'attacker') {
        x += 7.5 + rank * 0.3;
        z += file < 3 ? -2.8 : 2.8;
      } else {
        x -= 2.0;
      }
      break;
    case 'grind':
      x = side === 'attacker' ? -2.5 + rank * 0.45 : 2.5 - rank * 0.45;
      break;
    case 'decisive':
      if (attackerWon) {
        x = side === 'attacker' ? 2.8 + rank * 0.6 : 11.0 + rank * 0.4;
      } else {
        x = side === 'attacker' ? -11.0 + rank * 0.35 : -2.4 + rank * 0.45;
      }
      z += side === (attackerWon ? 'attacker' : 'defender') ? 0 : (file < 3 ? -0.9 : 0.9);
      break;
  }
  return { x, z };
}

function addTerrain(scene: THREE.Scene, replay: BattleReplay): void {
  const palette = TERRAIN_COLORS[replay.terrain] ?? TERRAIN_COLORS.plain;
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(44, 27),
    new THREE.MeshStandardMaterial({ color: palette.ground, roughness: 1 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.04;
  scene.add(ground);

  const lane = new THREE.Mesh(
    new THREE.PlaneGeometry(5.2, 27),
    new THREE.MeshStandardMaterial({ color: palette.lane, roughness: 1 }),
  );
  lane.rotation.x = -Math.PI / 2;
  lane.position.set(0, 0.01, 0);
  scene.add(lane);

  const lineMaterial = new THREE.LineBasicMaterial({ color: palette.accent, transparent: true, opacity: 0.2 });
  for (let z = -10; z <= 10; z += 5) {
    const geometry = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-21, 0.015, z),
      new THREE.Vector3(21, 0.015, z),
    ]);
    scene.add(new THREE.Line(geometry, lineMaterial));
  }

  if (replay.terrain === 'river') {
    const water = new THREE.Mesh(
      new THREE.PlaneGeometry(44, 2.8),
      new THREE.MeshStandardMaterial({ color: 0x32687b, roughness: 0.35, metalness: 0.05 }),
    );
    water.rotation.x = -Math.PI / 2;
    water.position.set(0, 0.035, 0);
    scene.add(water);
    const bridge = new THREE.Mesh(
      new THREE.BoxGeometry(5.4, 0.18, 2.2),
      new THREE.MeshStandardMaterial({ color: 0x6f5840, roughness: 1 }),
    );
    bridge.position.set(0, 0.16, 0);
    scene.add(bridge);
  }

  if (replay.terrain === 'mountain' || replay.terrain === 'hill') {
    const peakMaterial = new THREE.MeshStandardMaterial({
      color: replay.terrain === 'mountain' ? 0x414a4c : 0x5e6949,
      roughness: 1,
    });
    for (let i = 0; i < 9; i++) {
      const peak = new THREE.Mesh(
        new THREE.ConeGeometry(replay.terrain === 'mountain' ? 2.6 : 3.2, replay.terrain === 'mountain' ? 5.5 : 2.4, 5),
        peakMaterial,
      );
      peak.position.set(-21 + i * 5.3, replay.terrain === 'mountain' ? 2.45 : 0.9, -12.2 + (i % 2) * 1.4);
      scene.add(peak);
    }
  } else if (replay.terrain === 'forest') {
    const treeMaterial = new THREE.MeshStandardMaterial({ color: 0x2a432e, roughness: 1 });
    const trunkMaterial = new THREE.MeshStandardMaterial({ color: 0x514633, roughness: 1 });
    for (let i = 0; i < 18; i++) {
      const side = i % 2 === 0 ? -1 : 1;
      const x = side * (16 + (i % 3) * 1.4);
      const z = -10 + Math.floor(i / 2) * 2.2;
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.23, 1.6, 5), trunkMaterial);
      trunk.position.set(x, 0.8, z);
      scene.add(trunk);
      const leaves = new THREE.Mesh(new THREE.ConeGeometry(1.0, 2.5, 5), treeMaterial);
      leaves.position.set(x, 2.55, z);
      scene.add(leaves);
    }
  }
}

function createSoldier(
  side: 'attacker' | 'defender',
  index: number,
  factionColor: string,
  scene: THREE.Scene,
): Soldier {
  const group = new THREE.Group();
  const armorMaterial = new THREE.MeshStandardMaterial({ color: factionColor, roughness: 0.82 });
  const skinMaterial = new THREE.MeshStandardMaterial({ color: 0xd1b48c, roughness: 0.95 });
  const weaponMaterial = new THREE.MeshStandardMaterial({ color: 0xc8c4b9, metalness: 0.18, roughness: 0.7 });
  const flagMaterial = new THREE.MeshStandardMaterial({ color: factionColor, roughness: 0.85 });
  const shadowMaterial = new THREE.MeshBasicMaterial({ color: 0x080a08, transparent: true, opacity: 0.22 });

  const shadow = new THREE.Mesh(new THREE.CircleGeometry(0.35, 8), shadowMaterial);
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.025;
  group.add(shadow);

  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.17, 0.55, 3, 5), armorMaterial);
  body.position.y = 0.55;
  group.add(body);

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.15, 7, 5), skinMaterial);
  head.position.y = 1.02;
  group.add(head);

  const spear = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.035, 0.035), weaponMaterial);
  spear.position.set(0.42, 0.72, 0.02);
  group.add(spear);

  const shield = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.38, 0.08), armorMaterial);
  shield.position.set(-0.15, 0.52, -0.18);
  group.add(shield);

  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 1.15, 5), weaponMaterial);
  pole.position.set(-0.27, 1.25, 0);
  group.add(pole);

  const banner = new THREE.Mesh(new THREE.BoxGeometry(0.48, 0.28, 0.035), flagMaterial);
  banner.position.set(-0.02, 1.55, 0);
  group.add(banner);

  const meshes: THREE.Mesh[] = [];
  group.traverse((object) => {
    if (object instanceof THREE.Mesh) meshes.push(object);
  });
  const originalMaterials = meshes.map((mesh) => mesh.material as THREE.Material);

  scene.add(group);
  return {
    group,
    target: new THREE.Vector3(),
    meshes,
    originalMaterials,
    fallen: false,
    side,
    index,
  };
}

function updateStage(runtime: BattlefieldRuntime, replay: BattleReplay, stageIndex: number): void {
  const index = Math.max(0, Math.min(stageIndex, replay.stages.length - 1));
  const stage = replay.stages[index];
  const attackerAlive = replay.initialAttackerTroops > 0
    ? Math.round((stage.attackerTroops / replay.initialAttackerTroops) * FORMATION_SIZE)
    : 0;
  const defenderAlive = replay.initialDefenderTroops > 0
    ? Math.round((stage.defenderTroops / replay.initialDefenderTroops) * FORMATION_SIZE)
    : 0;

  for (const soldier of [...runtime.attackers, ...runtime.defenders]) {
    const aliveCount = soldier.side === 'attacker' ? attackerAlive : defenderAlive;
    const shouldFall = soldier.index >= aliveCount;
    const pose = stagePose(stage.key, soldier.side, soldier.index, replay.attackerWon);
    soldier.target.set(pose.x, shouldFall ? 0.02 : 0, pose.z);

    if (shouldFall !== soldier.fallen) {
      soldier.fallen = shouldFall;
      soldier.group.rotation.z = shouldFall
        ? (soldier.side === 'attacker' ? -Math.PI / 2.25 : Math.PI / 2.25)
        : 0;
      soldier.group.scale.setScalar(shouldFall ? 0.78 : 1);
      soldier.meshes.forEach((mesh, i) => {
        mesh.material = shouldFall ? runtime.fallenMaterial : soldier.originalMaterials[i];
      });
    }
    if (!shouldFall) soldier.group.rotation.y = soldier.side === 'attacker' ? 0 : Math.PI;
  }
}

function disposeRuntime(runtime: BattlefieldRuntime): void {
  runtime.resizeObserver.disconnect();
  window.cancelAnimationFrame(runtime.animationFrame);
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  // Fallen soldiers switch to a shared material; their original materials are no longer attached to meshes.
  // Keep explicit references here so repeated replay opens do not leak GPU materials.
  materials.add(runtime.fallenMaterial);
  for (const soldier of [...runtime.attackers, ...runtime.defenders]) {
    soldier.originalMaterials.forEach((material) => materials.add(material));
  }
  runtime.scene.traverse((object) => {
    if (object instanceof THREE.Mesh || object instanceof THREE.Line) {
      geometries.add(object.geometry as THREE.BufferGeometry);
      const material = object.material;
      if (Array.isArray(material)) material.forEach((entry) => materials.add(entry));
      else materials.add(material);
    }
  });
  geometries.forEach((geometry) => geometry.dispose());
  materials.forEach((material) => material.dispose());
  runtime.renderer.dispose();
  runtime.renderer.domElement.remove();
}

export default function Battlefield3D({ replay, stageIndex, onError }: Battlefield3DProps) {
  const mountRef = useRef<HTMLDivElement>(null);
  const runtimeRef = useRef<BattlefieldRuntime | null>(null);
  const onErrorRef = useRef(onError);

  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    let runtime: BattlefieldRuntime | null = null;
    let renderer: THREE.WebGLRenderer | null = null;

    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'low-power' });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.6));
      renderer.setSize(Math.max(1, mount.clientWidth), Math.max(1, mount.clientHeight), false);
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.domElement.setAttribute('aria-label', '三维战阵示意；仅播放已结算战斗，不参与战果计算');
      renderer.domElement.setAttribute('role', 'img');
      mount.prepend(renderer.domElement);

      const scene = new THREE.Scene();
      scene.background = new THREE.Color(0x18242b);
      scene.fog = new THREE.Fog(0x18242b, 34, 66);
      const camera = new THREE.PerspectiveCamera(38, Math.max(1, mount.clientWidth) / Math.max(1, mount.clientHeight), 0.1, 100);
      camera.position.set(0, 25, 37);
      camera.lookAt(0, 0.4, 0);

      scene.add(new THREE.HemisphereLight(0xe7e2ca, 0x273326, 2.1));
      const sun = new THREE.DirectionalLight(0xffe6bf, 2.4);
      sun.position.set(-10, 22, 10);
      scene.add(sun);
      addTerrain(scene, replay);

      const attackerColor = FACTION_VISUALS[replay.attackerFaction]?.primary ?? '#d46b56';
      const defenderColor = FACTION_VISUALS[replay.defenderFaction]?.primary ?? '#62b9b0';
      const attackers = Array.from({ length: FORMATION_SIZE }, (_, i) => createSoldier('attacker', i, attackerColor, scene));
      const defenders = Array.from({ length: FORMATION_SIZE }, (_, i) => createSoldier('defender', i, defenderColor, scene));
      const fallenMaterial = new THREE.MeshStandardMaterial({ color: 0x545653, roughness: 1, transparent: true, opacity: 0.8 });
      const resizeObserver = new ResizeObserver(() => {
        if (!runtime) return;
        const width = Math.max(1, mount.clientWidth);
        const height = Math.max(1, mount.clientHeight);
        renderer?.setSize(width, height, false);
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
      });

      runtime = {
        renderer,
        scene,
        camera,
        attackers,
        defenders,
        fallenMaterial,
        animationFrame: 0,
        lastFrameTime: 0,
        resizeObserver,
      };
      runtimeRef.current = runtime;
      resizeObserver.observe(mount);
      updateStage(runtime, replay, stageIndex);

      const animate = (timestamp: number): void => {
        if (!runtime) return;
        const delta = runtime.lastFrameTime > 0
          ? Math.min(0.05, Math.max(0, (timestamp - runtime.lastFrameTime) / 1000))
          : 1 / 60;
        runtime.lastFrameTime = timestamp;
        const reducedMotion = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        const alpha = reducedMotion ? 1 : 1 - Math.exp(-4.2 * delta);
        for (const soldier of [...runtime.attackers, ...runtime.defenders]) {
          soldier.group.position.lerp(soldier.target, alpha);
        }
        runtime.renderer.render(scene, camera);
        runtime.animationFrame = window.requestAnimationFrame(animate);
      };
      runtime.animationFrame = window.requestAnimationFrame(animate);
    } catch {
      if (runtime) disposeRuntime(runtime);
      else renderer?.dispose();
      mount.replaceChildren();
      onErrorRef.current?.();
    }

    return () => {
      if (runtime) disposeRuntime(runtime);
      if (runtimeRef.current === runtime) runtimeRef.current = null;
      mount.replaceChildren();
    };
  }, [replay]);

  useEffect(() => {
    if (runtimeRef.current) updateStage(runtimeRef.current, replay, stageIndex);
  }, [replay, stageIndex]);

  return (
    <div className="battlefield-3d" ref={mountRef}>
      <div className="battlefield-3d-caption">三维战阵演出 · 小队按剩余兵力比例示意 · 不重新计算胜负</div>
    </div>
  );
}
