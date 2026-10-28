import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const seed = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/source/tianming_world_roster_v0_3_1.json'), 'utf8'));
const outDir = path.join(ROOT, 'apps/web/public/assets/units');
fs.mkdirSync(outDir, { recursive: true });

const FACTION = {
  HUN: { main: '#a8322c', accent: '#d9a55c', deep: '#2b1210' },
  YONG: { main: '#2f4a82', accent: '#d4b24c', deep: '#121826' },
  CHU: { main: '#2c8a80', accent: '#e6ddc6', deep: '#102b28' },
};

const KIND = {
  铁浮屠: 'cavalry_heavy',
  西夏铁鹞子: 'cavalry_heavy',
  蒙古怯薛军: 'cavalry_guard',
  辽国铁林军: 'cavalry_heavy',
  清朝索伦兵: 'infantry_light',
  无当飞军: 'infantry_light',
  锦帆贼: 'naval',
  白马义从: 'cavalry_archer',
  神臂弓手: 'crossbow',
  先登死士: 'infantry_shock',
  魏武卒: 'infantry_heavy',
  陷阵营: 'infantry_shock',
  北府兵: 'infantry_heavy',
  白袍军: 'cavalry_light',
  背嵬军: 'infantry_heavy',
  虎豹骑: 'cavalry_heavy',
  白毦兵: 'infantry_guard',
  玄甲军: 'cavalry_heavy',
  虎贲军: 'infantry_guard',
  西凉铁骑: 'cavalry_heavy',
  戚家军: 'infantry_spear',
  羽林骑: 'cavalry_guard',
};

function hash(input) {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function emblem(kind, unitName) {
  const h = hash(unitName);
  const variant = h % 3;
  if (kind.startsWith('cavalry')) {
    return `<path d="M66 22 L74 34 L66 46 L58 34 Z" fill="none" stroke="currentColor" stroke-width="2.2"/>
      ${variant === 0 ? '<path d="M66 26 V42" stroke="currentColor" stroke-width="2"/>' : ''}
      ${variant === 1 ? '<circle cx="66" cy="34" r="4" fill="currentColor"/>' : ''}
      ${variant === 2 ? '<path d="M61 30 H71" stroke="currentColor" stroke-width="2"/>' : ''}`;
  }
  if (kind === 'naval') {
    return `<path d="M50 66 Q66 56 82 66 L78 74 H54 Z" fill="currentColor" opacity="0.85"/><path d="M66 30 V58 M56 38 L66 48 L76 38" stroke="currentColor" stroke-width="2" fill="none"/>`;
  }
  if (kind === 'crossbow') {
    return `<path d="M46 44 Q66 28 86 44" fill="none" stroke="currentColor" stroke-width="3"/><path d="M46 44 L86 44 M66 34 V62" stroke="currentColor" stroke-width="2.2"/>`;
  }
  if (kind === 'infantry_shock') {
    return `<path d="M52 30 L66 52 L80 30 M66 32 V66" stroke="currentColor" stroke-width="3" fill="none"/>`;
  }
  if (kind === 'infantry_guard') {
    return `<path d="M56 26 Q66 18 76 26 V58 Q66 68 56 58 Z" fill="none" stroke="currentColor" stroke-width="2.4"/>`;
  }
  if (kind === 'infantry_spear') {
    return `<path d="M48 26 V72 M60 22 V72 M72 26 V72" stroke="currentColor" stroke-width="2.2"/><path d="M48 26 L44 34 L52 34 Z M60 22 L56 30 L64 30 Z" fill="currentColor"/>`;
  }
  return `<path d="M50 34 L66 22 L82 34 M66 22 V70" stroke="currentColor" stroke-width="2.4" fill="none"/>`;
}

function icon(unit) {
  const f = FACTION[unit.faction_key];
  const kind = KIND[unit.unit_name] ?? 'infantry_heavy';
  const h = hash(unit.unit_id);
  const stripes = h % 4;
  let silhouette = '';
  if (kind.startsWith('cavalry')) {
    const armored = kind === 'cavalry_heavy';
    const archer = kind === 'cavalry_archer';
    silhouette = `
      <path d="M22 66 Q26 50 42 48 L62 48 Q76 48 80 60 L84 74 H74 L70 62 H34 L30 74 H22 Z" fill="${f.silhouette ?? '#e8e0cf'}"/>
      <path d="M80 56 L90 46 L92 52 L86 62 Z" fill="#e8e0cf"/>
      <path d="M38 72 L38 82 M70 72 L70 82 M28 82 H74" stroke="#e8e0cf" stroke-width="3"/>
      <circle cx="54" cy="38" r="8" fill="#e8e0cf"/>
      <path d="M48 46 Q54 44 60 46 L64 58 Q54 62 44 58 Z" fill="${armored ? f.main : '#cfc6b2'}" stroke="${f.deep}" stroke-width="1.5"/>
      ${archer ? '<path d="M38 44 Q26 48 32 62" fill="none" stroke="#e8e0cf" stroke-width="2.4"/><path d="M32 62 L26 64" stroke="#e8e0cf" stroke-width="2"/>' : '<path d="M36 34 L18 56" stroke="#e8e0cf" stroke-width="3"/>'}
      ${armored ? '<path d="M52 44 H70" stroke="' + f.accent + '" stroke-width="2" opacity="0.8"/>' : ''}
      <path d="M58 34 L62 22 L66 34 Z" fill="${f.accent}" opacity="0.9"/>`;
  } else if (kind === 'naval') {
    silhouette = `
      <path d="M14 66 Q34 52 54 66 T94 66 L88 80 H20 Z" fill="#e8e0cf" opacity="0.9"/>
      <path d="M46 34 V64" stroke="#e8e0cf" stroke-width="3"/>
      <path d="M46 36 L76 44 L46 54 Z" fill="${f.accent}" opacity="0.85"/>
      <path d="M14 74 Q34 62 54 74 T94 74" fill="none" stroke="${f.main}" stroke-width="2.4" opacity="0.7"/>
      <circle cx="30" cy="70" r="3" fill="#e8e0cf"/><circle cx="66" cy="70" r="3" fill="#e8e0cf"/>`;
  } else if (kind === 'crossbow') {
    silhouette = `
      <circle cx="66" cy="36" r="8" fill="#e8e0cf"/>
      <path d="M58 46 Q66 44 74 46 L78 72 H54 Z" fill="${f.main}" opacity="0.9"/>
      <path d="M30 58 H96" stroke="#e8e0cf" stroke-width="3"/>
      <path d="M32 44 Q64 30 96 44" fill="none" stroke="#e8e0cf" stroke-width="3"/>
      <path d="M64 48 V76 M64 48 L84 60" stroke="#e8e0cf" stroke-width="2"/>`;
  } else if (kind === 'infantry_shock') {
    silhouette = `
      <circle cx="60" cy="34" r="9" fill="#e8e0cf"/>
      <path d="M48 44 Q60 40 72 44 L80 78 H40 Z" fill="${f.main}"/>
      <path d="M76 34 L56 18" stroke="#e8e0cf" stroke-width="4"/>
      <path d="M52 18 Q56 12 62 16 Q58 20 56 24 Z" fill="#e8e0cf"/>
      <path d="M44 56 Q60 50 76 56" fill="none" stroke="${f.accent}" stroke-width="2"/>`;
  } else if (kind === 'infantry_guard') {
    silhouette = `
      <circle cx="60" cy="34" r="9" fill="#e8e0cf"/>
      <path d="M48 44 Q60 40 72 44 L80 80 H40 Z" fill="${f.main}"/>
      <path d="M22 40 Q36 26 52 40 V76 Q36 88 22 76 Z" fill="none" stroke="${f.accent}" stroke-width="3"/>
      <path d="M30 46 H44 V68 H30 Z" fill="${f.accent}" opacity="0.5"/>
      <path d="M76 28 V84 M76 28 L84 22" stroke="#e8e0cf" stroke-width="3"/>`;
  } else if (kind === 'infantry_spear') {
    silhouette = `
      <circle cx="56" cy="34" r="9" fill="#e8e0cf"/>
      <path d="M44 44 Q56 40 68 44 L74 80 H38 Z" fill="${f.main}"/>
      <path d="M20 26 V86 M40 22 V86 M80 26 V86" stroke="#e8e0cf" stroke-width="2.4"/>
      <path d="M20 26 L16 34 L24 34 Z M40 22 L36 30 L44 30 Z M80 26 L76 34 L84 34 Z" fill="#e8e0cf"/>
      <path d="M24 56 Q34 48 44 56 V72 Q34 80 24 72 Z" fill="${f.accent}" opacity="0.8"/>`;
  } else if (kind === 'infantry_light') {
    silhouette = `
      <circle cx="60" cy="34" r="9" fill="#e8e0cf"/>
      <path d="M48 44 Q60 40 72 44 L78 80 H42 Z" fill="${f.main}" opacity="0.9"/>
      <path d="M34 44 Q20 50 28 66" fill="none" stroke="#e8e0cf" stroke-width="3"/>
      <path d="M28 66 L22 70" stroke="#e8e0cf" stroke-width="2.4"/>
      <path d="M10 84 L34 54 L52 84 Z M58 84 L74 62 L90 84 Z" fill="${f.accent}" opacity="0.16"/>
      <path d="M70 28 L82 40" stroke="${f.accent}" stroke-width="3"/>`;
  } else {
    silhouette = `
      <circle cx="62" cy="34" r="9" fill="#e8e0cf"/>
      <path d="M50 44 Q62 40 74 44 L82 80 H42 Z" fill="${f.main}"/>
      <path d="M30 40 Q44 26 60 40 V78 Q44 90 30 78 Z" fill="none" stroke="${f.accent}" stroke-width="3"/>
      <path d="M78 24 V84 M78 24 L86 18" stroke="#e8e0cf" stroke-width="3"/>`;
  }

  const marks = Array.from({ length: stripes + 1 }, (_, i) =>
    `<circle cx="${16 + i * 7}" cy="86" r="2" fill="${f.accent}" opacity="0.7"/>`,
  ).join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96" role="img" aria-label="${unit.unit_name}">
  <defs><linearGradient id="g${unit.unit_id}" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="${f.deep}"/><stop offset="1" stop-color="${f.main}" stop-opacity="0.55"/>
  </linearGradient></defs>
  <rect width="96" height="96" rx="18" fill="url(#g${unit.unit_id})" stroke="${f.accent}" stroke-opacity="0.45" stroke-width="1.5"/>
  ${silhouette}
  <g color="${f.accent}" transform="translate(-10,-8) scale(0.32)" opacity="0.35">${emblem(kind, unit.unit_name)}</g>
  ${marks}
</svg>`;
}

let n = 0;
for (const unit of seed.military_units) {
  fs.writeFileSync(path.join(outDir, `${unit.unit_id}.svg`), icon(unit), 'utf8');
  n++;
}
console.log(`unit icons: ${n} → ${path.relative(ROOT, outDir)}`);
