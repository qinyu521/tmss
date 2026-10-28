// 人物肖像生成器 · 天命史书
// 风格定位：中国古典工笔人物半身像（胸像、戏剧化侧光、冠盔甲胄、须发分型、
// 势力氛围山水背景）。全部由种子确定性程序化生成，不使用任何商业素材。
// 输出：apps/web/public/assets/portraits/{person_id}.svg（256x320）
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const seedPath = path.join(ROOT, 'data/source/tianming_world_roster_v0_3_1.json');
const outDir = path.join(ROOT, 'apps/web/public/assets/portraits');
const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'));

/* ------------------------------- 调色板 ------------------------------- */

const FACTION = {
  HUN: {
    primary: '#8f2b26', primaryDark: '#4a1713', deep: '#160c0b', deep2: '#2c1611',
    light: '#d8a35a', lightSoft: '#e8c896', steel: '#6e5640', steelDark: '#42342a',
    fur: '#8a6a45', furDark: '#5e462f', halo: '#b8452e', motif: 'steppe',
  },
  YONG: {
    primary: '#243b6b', primaryDark: '#141d33', deep: '#0b0e16', deep2: '#16202f',
    light: '#d9bb5c', lightSoft: '#ecdca0', steel: '#5d6470', steelDark: '#363b44',
    fur: '#7a6a52', furDark: '#4d4232', halo: '#46609a', motif: 'palace',
  },
  CHU: {
    primary: '#1c6560', primaryDark: '#0e342f', deep: '#091615', deep2: '#0f2623',
    light: '#d8d0b8', lightSoft: '#eee6d2', steel: '#506a63', steelDark: '#32453f',
    fur: '#7d6d54', furDark: '#4f4330', halo: '#2f847b', motif: 'river',
  },
};

const CLOTH = {
  HUN: ['#4a2420', '#33211b', '#5a3a26', '#2a201c', '#5e2f22'],
  YONG: ['#232c44', '#2e2b3a', '#4a3a22', '#1f2430', '#3d3320'],
  CHU: ['#1f3a38', '#2c4038', '#3a4a3a', '#26333a', '#3d3a2c'],
  common: ['#33302b', '#46402f', '#3c3530', '#4a3f33'],
};

const SKIN_M = ['#e8c39e', '#ddb28c', '#d2a074', '#c49060', '#e6bd92', '#caa07a', '#b98a64'];
const SKIN_F = ['#f2d2b0', '#ecc79f', '#e6bd92'];
const HAIR_DARK = ['#17150f', '#1f1c16', '#2a241c', '#332a20', '#12100c', '#3d2f22'];
const GREY = '#a9a293';
const LIP_M = '#8c4a3e';
const LIP_F = '#a8443c';

/* ------------------------------- 工具函数 ------------------------------- */

function hash(input) {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function rng(seedValue) {
  let a = seedValue >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function shade(hex, factor) {
  const v = hex.replace('#', '');
  const parts = [0, 2, 4].map((i) => clamp(Math.round(parseInt(v.slice(i, i + 2), 16) * factor), 0, 255));
  return `#${parts.map((n) => n.toString(16).padStart(2, '0')).join('')}`;
}

function mix(a, b, t) {
  const pa = a.replace('#', '');
  const pb = b.replace('#', '');
  const out = [0, 2, 4].map((i) => {
    const va = parseInt(pa.slice(i, i + 2), 16);
    const vb = parseInt(pb.slice(i, i + 2), 16);
    return Math.round(va + (vb - va) * t);
  });
  return `#${out.map((n) => clamp(n, 0, 255).toString(16).padStart(2, '0')).join('')}`;
}

function categoryOf(c) {
  const t = `${c.identity_type} ${c.current_position_standard}`;
  if (c.identity_type === '君主') return 'ruler';
  if (/储君|皇子|宗王|公主|王女|宗室|皇后|王后|正宫|外戚|宗谱/.test(t)) return 'royal';
  if (/军阀|藩镇|割据/.test(t)) return 'warlord';
  if (/世家|家主|继承人|掌柜|谋士|宗族/.test(t)) return 'house';
  if (/军区统帅|副帅|军务参赞|守将|禁军|卫尉|执金吾|羽林|都尉|将军|武举|新锐|教头|边将/.test(t)) return 'general';
  if (/商|账房|少东家|盐商|海贸|驼市/.test(t)) return 'merchant';
  if (/在野|策士|名士|医师|工匠|匠师|水利|师爷|遗臣|寒门|流寓|游学|落第|医士|史官/.test(t)) return 'scholar';
  if (/尚书|侍郎|丞相|御史|太常|光禄|太仆|廷尉|大鸿胪|少府|刺史|州府|主官|副官|枢密|中书|令|卿|监|首辅|监察|总长|辅政|文书|军令|情报|情报机构/.test(t))
    return 'official';
  return 'common';
}

function escapeXml(s) {
  return String(s).replace(/[<>&"']/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[ch]));
}

const MARTIAL = ['ruler', 'general', 'warlord'];
const CIVIL = ['official', 'royal', 'house', 'scholar', 'merchant', 'common'];

/* ------------------------------- 主体 ------------------------------- */

function portrait(c) {
  const r = rng(hash(`${c.person_id}:${c.name}:${c.identity_type}`));
  const F = FACTION[c.faction_key] ?? FACTION.HUN;
  const cat = categoryOf(c);
  const female = c.gender === '女';
  const age = c.age_band; // 青年 壮年 中年 老成
  const old = age === '老成';
  const mid = age === '中年';
  const young = age === '青年';
  const pick = (arr) => arr[Math.floor(r() * arr.length)];
  const ri = (lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
  const chance = (p) => r() < p;

  const greyP = old ? 0.8 : mid ? 0.22 : 0.03;
  const grey = chance(greyP);
  const skin = female ? pick(SKIN_F) : pick(SKIN_M);
  const skinLight = mix(skin, '#fff2dc', 0.28);
  const skinShade = shade(skin, 0.74);
  const skinShade2 = shade(skin, 0.58);
  const hair = grey ? GREY : pick(HAIR_DARK);
  const hairSoft = grey ? mix(GREY, '#ffffff', 0.25) : shade(hair, 1.5);
  const cloth = cat === 'common' ? pick(CLOTH.common) : pick(CLOTH[c.faction_key] ?? CLOTH.HUN);
  const clothDark = shade(cloth, 0.62);
  const clothLight = mix(cloth, F.lightSoft, 0.18);

  // 性格化面相（依据人物数值，仍然只是同一种子的确定性产物）
  const fierce = MARTIAL.includes(cat) && (c.command >= 70 || chance(0.28));
  const cunning = (c.intrigue ?? 0) >= 70 && chance(0.7);
  const wise = (c.strategy ?? 0) >= 68 || (old && (cat === 'scholar' || cat === 'official'));

  const cx = 128;
  const cy = 134;
  const rx = 29 + ri(0, 5);
  const jawShape = pick([0, 0, 1, 1, 2, 3]); // 0圆 1棱 2尖 3阔
  const jawW = jawShape === 3 ? 20 : jawShape === 1 ? 15 : jawShape === 2 ? 10 : 13;
  const cheekX = rx * (jawShape === 3 ? 1.02 : 0.88);
  const eyeY = cy - 4 + ri(-2, 2);
  const eyeJitter = ri(-1, 1);

  // 眼型
  let eyeType;
  if (female) eyeType = pick(['phoenix', 'bright', 'phoenix', 'bright']);
  else if (fierce) eyeType = chance(0.5) ? 'round' : 'narrow';
  else if (cunning) eyeType = 'phoenix';
  else if (young) eyeType = pick(['bright', 'phoenix', 'bright']);
  else if (wise) eyeType = 'phoenix';
  else eyeType = pick(['phoenix', 'phoenix', 'round', 'narrow']);

  // 眉型
  let browType;
  if (female) browType = 'slender';
  else if (old && chance(0.45)) browType = 'droop';
  else if (fierce) browType = pick(['slant', 'bushy', 'sword']);
  else if (cunning) browType = pick(['slender', 'sword']);
  else if (wise) browType = pick(['thick', 'sword', 'droop']);
  else browType = pick(['sword', 'thick', 'bushy', 'sword', 'slender']);

  // 嘴型
  let mouthType;
  if (female) mouthType = pick(['soft', 'calm']);
  else if (fierce) mouthType = 'stern';
  else if (wise) mouthType = 'calm';
  else mouthType = pick(['calm', 'firm', 'firm', 'soft']);

  // 须发
  let beard = -1;
  if (!female) {
    if (young) beard = pick([0, 0, 0, 1, 2]);
    else if (MARTIAL.includes(cat)) beard = fierce ? pick([3, 4, 4, 5, 6]) : pick([2, 3, 4, 5, 6, 0]);
    else if (cat === 'scholar') beard = pick([0, 2, 3, 4, 3]);
    else if (cat === 'official' || cat === 'royal' || cat === 'house') beard = pick([0, 0, 2, 3, 3]);
    else if (cat === 'merchant') beard = pick([0, 1, 2]);
    else beard = pick([0, 1, 3, 0]);
  }
  const hairVar = ri(0, 3);
  const scar = !female && MARTIAL.includes(cat) && chance(0.12) ? pick(['brow', 'cheek', 'cheek']) : null;
  const plumeColor = pick(['#9e3026', '#1c1a18', '#d8d2c4', F.primary]);

  const t = {
    id: c.person_id,
    r, F, cat, female, age, old, mid, young, grey, chance, ri, pick,
    skin, skinLight, skinShade, skinShade2, hair, hairSoft, cloth, clothDark, clothLight,
    fierce, cunning, wise, cx, cy, rx, jawShape, jawW, cheekX, eyeY, eyeJitter,
    eyeType, browType, mouthType, beard, hairVar, scar, plumeColor,
  };

  const defs = `
  <defs>
    <linearGradient id="bg${c.person_id}" x1="0" y1="0" x2="0.25" y2="1">
      <stop offset="0" stop-color="${F.deep2}"/>
      <stop offset="0.55" stop-color="${F.deep}"/>
      <stop offset="1" stop-color="#070605"/>
    </linearGradient>
    <radialGradient id="halo${c.person_id}" cx="0.5" cy="0.42" r="0.52">
      <stop offset="0" stop-color="${F.halo}" stop-opacity="0.34"/>
      <stop offset="0.6" stop-color="${F.halo}" stop-opacity="0.1"/>
      <stop offset="1" stop-color="${F.halo}" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="skin${c.person_id}" x1="0.15" y1="0" x2="0.85" y2="1">
      <stop offset="0" stop-color="${skinLight}"/>
      <stop offset="0.5" stop-color="${skin}"/>
      <stop offset="1" stop-color="${skinShade}"/>
    </linearGradient>
    <linearGradient id="steel${c.person_id}" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${mix(F.steel, '#ffffff', 0.22)}"/>
      <stop offset="0.5" stop-color="${F.steel}"/>
      <stop offset="1" stop-color="${F.steelDark}"/>
    </linearGradient>
    <radialGradient id="vig${c.person_id}" cx="0.5" cy="0.46" r="0.75">
      <stop offset="0.55" stop-color="#000000" stop-opacity="0"/>
      <stop offset="1" stop-color="#000000" stop-opacity="0.62"/>
    </radialGradient>
    <linearGradient id="key${c.person_id}" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#ffe9c4" stop-opacity="0.14"/>
      <stop offset="0.45" stop-color="#ffe9c4" stop-opacity="0"/>
    </linearGradient>
    <filter id="soft${c.person_id}" x="-30%" y="-30%" width="160%" height="160%">
      <feGaussianBlur stdDeviation="5"/>
    </filter>
  </defs>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="320" viewBox="0 0 256 320" role="img" aria-label="${escapeXml(c.name)}">
  ${defs}
  ${background(t)}
  <ellipse cx="128" cy="262" rx="104" ry="66" fill="#000000" opacity="0.4" filter="url(#soft${c.person_id})"/>
  ${backGarment(t)}
  ${backHair(t)}
  ${neck(t)}
  ${ears(t)}
  ${face(t)}
  ${features(t)}
  ${headwear(t)}
  ${garmentFront(t)}
  ${beardLayer(t)}
  <rect width="256" height="320" fill="url(#key${c.person_id})"/>
  ${speckles(t)}
  <rect width="256" height="320" fill="url(#vig${c.person_id})"/>
  ${seal(t)}
</svg>`;
}

/* ------------------------------- 背景 ------------------------------- */

function background(t) {
  const { F } = t;
  let motif = '';
  if (F.motif === 'steppe') {
    motif = `
    <circle cx="194" cy="60" r="25" fill="#e8c896" opacity="0.16"/>
    <circle cx="194" cy="60" r="31" fill="none" stroke="#e8c896" stroke-width="1" opacity="0.22"/>
    <path d="M0 252 Q50 236 100 250 T200 244 T256 250 L256 320 L0 320 Z" fill="${F.deep2}" opacity="0.9"/>
    <path d="M0 272 Q64 256 128 270 T256 264 L256 320 L0 320 Z" fill="${F.primaryDark}" opacity="0.75"/>
    <path d="M14 262 Q30 255 46 262 M64 258 Q82 250 100 258 M176 254 Q196 246 216 254" fill="none" stroke="${F.light}" stroke-width="1" opacity="0.18"/>
    <path d="M26 120 Q48 112 70 120 M36 134 Q54 128 72 134" fill="none" stroke="${F.light}" stroke-width="1" opacity="0.1"/>`;
  } else if (F.motif === 'palace') {
    motif = `
    <rect x="15" y="15" width="226" height="290" fill="none" stroke="${F.light}" stroke-width="1" opacity="0.2"/>
    <rect x="22" y="22" width="212" height="276" fill="none" stroke="${F.light}" stroke-width="0.6" opacity="0.12"/>
    <path d="M15 250 H42 V214 H58 V250 M241 250 H214 V214 H198 V250" fill="none" stroke="${F.light}" stroke-width="1.4" opacity="0.14"/>
    ${cloudRow(64, 196, F.light, 0.13)}
    ${cloudRow(84, 150, F.light, 0.09)}
    <path d="M128 44 L142 62 L128 80 L114 62 Z" fill="none" stroke="${F.light}" stroke-width="1.2" opacity="0.16"/>
    <path d="M0 262 H256 V320 H0 Z" fill="${F.deep2}" opacity="0.65"/>`;
  } else {
    motif = `
    <path d="M0 236 L30 206 L52 228 L78 198 L108 230 L138 204 L168 226 L198 202 L228 226 L256 210 L256 258 L0 258 Z" fill="${F.deep2}" opacity="0.85"/>
    <path d="M0 254 L36 232 L72 250 L110 228 L150 248 L190 230 L226 248 L256 236 L256 280 L0 280 Z" fill="${F.primaryDark}" opacity="0.7"/>
    <path d="M0 278 H256 V320 H0 Z" fill="${F.deep}" opacity="0.8"/>
    <path d="M10 284 Q64 276 120 284 T246 282 M0 296 Q58 288 118 296 T256 294 M20 308 Q74 300 130 308 T250 306" fill="none" stroke="${F.lightSoft}" stroke-width="1" opacity="0.16"/>`;
  }
  return `
  <rect width="256" height="320" fill="url(#bg${t.id})"/>
  <rect width="256" height="320" fill="url(#halo${t.id})"/>
  ${motif}`;
}

function cloudRow(y, width, color, opacity) {
  const curls = [];
  for (let x = -10; x < 280; x += 52) {
    curls.push(`<path d="M${x} ${y} q10 -10 20 0 q10 -8 20 0 q6 -6 12 0" fill="none" stroke="${color}" stroke-width="1.2" opacity="${opacity}"/>`);
  }
  return curls.join('');
}

/* ------------------------------- 后层发式与身形 ------------------------------- */

function backGarment(t) {
  const { F, female, cat } = t;
  const top = female ? 110 : 104;
  const base = `
  <path d="M34 320 C40 258 68 228 ${top} 214 L${256 - top} 214 C188 228 216 258 222 320 Z" fill="${t.cloth}"/>
  <path d="M34 320 C40 258 68 228 ${top} 214 L${128 - (128 - top)} 214 C96 232 80 272 78 320 Z" fill="${t.clothDark}" opacity="0.55"/>`;
  // 披风（武职）或毛领（匈奴）
  let outer = '';
  if (MARTIAL.includes(cat)) {
    outer = `
    <path d="M30 320 C38 250 62 218 96 204 C78 238 70 278 70 320 Z" fill="${F.primaryDark}" opacity="0.92"/>
    <path d="M226 320 C218 250 194 218 160 204 C178 238 186 278 186 320 Z" fill="${F.primaryDark}" opacity="0.92"/>
    <path d="M60 226 Q74 246 76 286" fill="none" stroke="${F.light}" stroke-width="1.6" opacity="0.3"/>
    <path d="M196 226 Q182 246 180 286" fill="none" stroke="${F.light}" stroke-width="1.6" opacity="0.3"/>`;
    if (t.cat === 'ruler') {
      outer += `<path d="M96 204 C78 220 62 250 58 286" fill="none" stroke="${F.light}" stroke-width="3" opacity="0.5"/>
      <path d="M160 204 C178 220 194 250 198 286" fill="none" stroke="${F.light}" stroke-width="3" opacity="0.5"/>`;
    }
  }
  return outer + base;
}

function backHair(t) {
  const { cx, cy, rx, hair, female, cat } = t;
  if (female) {
    // 高髻与披发
    return `
    <path d="M${cx - rx - 6} ${cy - 16} Q${cx - 18} ${cy - 78} ${cx} ${cy - 80} Q${cx + 18} ${cy - 78} ${cx + rx + 6} ${cy - 16} Q${cx + rx + 14} ${cy + 40} ${cx + 10} ${cy + 58} L${cx - 10} ${cy + 58} Q${cx - rx - 14} ${cy + 40} ${cx - rx - 6} ${cy - 16} Z" fill="${hair}"/>
    <ellipse cx="${cx}" cy="${cy - 66}" rx="17" ry="20" fill="${hair}"/>
    <ellipse cx="${cx - 27}" cy="${cy - 50}" rx="11" ry="13" fill="${hair}"/>
    <ellipse cx="${cx + 27}" cy="${cy - 50}" rx="11" ry="13" fill="${hair}"/>
    <path d="M${cx - 14} ${cy - 72} Q${cx} ${cy - 84} ${cx + 14} ${cy - 72}" fill="none" stroke="${t.hairSoft}" stroke-width="1.2" opacity="0.35"/>`;
  }
  const bun = t.hairVar === 0 && !MARTIAL.includes(cat) && cat !== 'official';
  return `
  <path d="M${cx - rx - 4} ${cy - 20} Q${cx - rx - 10} ${cy + 34} ${cx - rx + 5} ${cy + 50} Q${cx - rx - 2} ${cy + 20} ${cx - rx - 2} ${cy - 12} Z" fill="${hair}"/>
  <path d="M${cx + rx + 4} ${cy - 20} Q${cx + rx + 10} ${cy + 34} ${cx + rx - 5} ${cy + 50} Q${cx + rx + 2} ${cy + 20} ${cx + rx + 2} ${cy - 12} Z" fill="${hair}"/>
  <path d="M${cx - rx - 2} ${cy - 22} Q${cx} ${cy - 66} ${cx + rx + 2} ${cy - 22} Q${cx} ${cy - 40} ${cx - rx - 2} ${cy - 22} Z" fill="${hair}"/>
  ${bun ? `<ellipse cx="${cx}" cy="${cy - 62}" rx="11" ry="13" fill="${hair}"/>` : ''}`;
}

function neck(t) {
  const { cx, cy, female, skin, skinShade } = t;
  const nw = female ? 10.5 : 13;
  const nb = female ? 12.5 : 15.5;
  return `
  <path d="M${cx - nw} ${cy + 36} L${cx - nb} 216 Q${cx} 226 ${cx + nb} 216 L${cx + nw} ${cy + 36} Z" fill="url(#skin${t.id})"/>
  <path d="M${cx - nb} ${cy + 48} Q${cx} ${cy + 60} ${cx + nb} ${cy + 48} Q${cx} ${cy + 52} ${cx - nb} ${cy + 48} Z" fill="${skinShade}" opacity="0.5"/>
  <ellipse cx="${cx - nb + 2}" cy="${cy + 52}" rx="3" ry="6" fill="${skinShade}" opacity="0.28"/>
  <ellipse cx="${cx + nb - 2}" cy="${cy + 52}" rx="3" ry="6" fill="${skinShade}" opacity="0.34"/>
  <path d="M${cx - 7} 208 Q${cx} 213 ${cx + 7} 208" fill="none" stroke="${shade(skin, 0.62)}" stroke-width="1.5" opacity="0.55"/>`;
}

function ears(t) {
  const { cx, cy, rx, skin, skinShade } = t;
  const ear = (x, flip) => `
  <ellipse cx="${x}" cy="${cy + 4}" rx="6.4" ry="11.5" fill="${skin}"/>
  <path d="M${x + flip * 1.5} ${cy - 3} Q${x - flip * 4} ${cy + 4} ${x + flip * 1.5} ${cy + 12}" fill="none" stroke="${skinShade}" stroke-width="1.6" opacity="0.7"/>
  <ellipse cx="${x}" cy="${cy + 8}" rx="2.6" ry="4" fill="${skinShade}" opacity="0.4"/>`;
  return ear(cx - rx + 3, 1) + ear(cx + rx - 3, -1);
}

/* ------------------------------- 面部 ------------------------------- */

function face(t) {
  const { cx, cy, rx, jawW, cheekX, skinShade, skinShade2, skinLight } = t;
  const d = `M${cx - rx} ${cy - 26}
    C${cx - rx - 3} ${cy - 45} ${cx + rx + 3} ${cy - 45} ${cx + rx} ${cy - 26}
    C${cx + rx + 4} ${cy + 2} ${cx + cheekX} ${cy + 24} ${cx + jawW} ${cy + 44}
    Q${cx + 5} ${cy + 52} ${cx} ${cy + 52}
    Q${cx - 5} ${cy + 52} ${cx - jawW} ${cy + 44}
    C${cx - cheekX} ${cy + 24} ${cx - rx - 4} ${cy + 2} ${cx - rx} ${cy - 26} Z`;
  return `
  <path d="${d}" fill="url(#skin${t.id})"/>
  <ellipse cx="${cx - 7}" cy="${cy - 30}" rx="13" ry="10" fill="${skinLight}" opacity="0.13"/>
  <ellipse cx="${cx - 15}" cy="${cy + 8}" rx="8.5" ry="12" fill="${skinLight}" opacity="0.09"/>
  <ellipse cx="${cx + 15}" cy="${cy + 10}" rx="8" ry="13" fill="${skinShade2}" opacity="0.13"/>
  <ellipse cx="${cx - rx * 0.82}" cy="${cy + 4}" rx="6" ry="14" fill="${skinShade}" opacity="0.28"/>
  <ellipse cx="${cx + rx * 0.8}" cy="${cy + 4}" rx="6.5" ry="15" fill="${skinShade2}" opacity="0.3"/>
  <ellipse cx="${cx - rx * 0.62}" cy="${cy - 22}" rx="9" ry="12" fill="${skinShade2}" opacity="0.16"/>
  <ellipse cx="${cx + rx * 0.62}" cy="${cy - 22}" rx="9" ry="12" fill="${skinShade2}" opacity="0.22"/>
  <ellipse cx="${cx}" cy="${cy + 47}" rx="20" ry="8" fill="${skinShade2}" opacity="0.3"/>
  <ellipse cx="${cx - 9}" cy="${cy + 42}" rx="7" ry="4" fill="${skinShade}" opacity="0.16"/>
  <ellipse cx="${cx + 9}" cy="${cy + 42}" rx="7" ry="4" fill="${skinShade2}" opacity="0.2"/>
  <path d="M${cx - rx + 2} ${cy - 24} C${cx - rx} ${cy} ${cx - rx * 0.8} ${cy + 26} ${cx - jawW + 2} ${cy + 42}" fill="none" stroke="${skinLight}" stroke-width="2.2" opacity="0.4"/>
  <path d="M${cx + rx - 3} ${cy - 22} C${cx + rx + 1} ${cy + 2} ${cx + rx * 0.82} ${cy + 26} ${cx + jawW} ${cy + 42}" fill="none" stroke="${shade(t.skin, 0.58)}" stroke-width="2.6" opacity="0.42"/>`;
}

/* ------------------------------- 五官 ------------------------------- */

function features(t) {
  const out = [brows(t), eyes(t), nose(t), mouth(t)];
  if (t.old) out.push(ageLines(t, 0.85));
  else if (t.mid) out.push(ageLines(t, 0.45));
  if (t.scar) out.push(scar(t));
  return out.join('');
}

function eyeShape(x, y, type, flip, female) {
  // flip 仅用于轻微左右不对称
  const w = type === 'round' ? 7.2 : 8;
  const rise = type === 'phoenix' ? 5 : type === 'narrow' ? 3.4 : 4.4;
  const drop = type === 'round' ? 3.8 : 2.6;
  const outer = flip; // 外眼角上扬幅度
  return {
    d: `M${x - w} ${y + 0.8} Q${x} ${y - rise} ${x + w} ${y - outer} Q${x} ${y + drop} ${x - w} ${y + 0.8} Z`,
    irisR: type === 'round' ? 3.5 : female ? 3.2 : 3,
    irisRy: type === 'round' ? 3.9 : 3.3,
  };
}

function eyes(t) {
  const { cx, eyeY: y, eyeJitter, hair, skinShade } = t;
  let s = '';
  const draw = (xc, side /* -1 left, 1 right */) => {
    const x = xc + eyeJitter * side;
    const { d, irisR, irisRy } = eyeShape(x, y, t.eyeType, t.eyeType === 'phoenix' ? 1.8 : 0.7, t.female);
    const irisX = x + side * 0.5;
    return `
    <path d="${d}" fill="#f0e7d3"/>
    <ellipse cx="${irisX}" cy="${y - 0.6}" rx="${irisR}" ry="${irisRy}" fill="#33210f"/>
    <ellipse cx="${irisX}" cy="${y - 0.6}" rx="${irisR * 0.55}" ry="${irisRy * 0.62}" fill="#0f0a06"/>
    <circle cx="${irisX + 1}" cy="${y - 1.8}" r="0.95" fill="#fff6e6" opacity="0.95"/>
    <path d="M${x - 8.2} ${y + 0.9} Q${x} ${y - (t.eyeType === 'phoenix' ? 5.8 : 4.8)} ${x + 8.2} ${y - 2}" fill="none" stroke="${hair}" stroke-width="${t.female ? 3 : 3.1}" stroke-linecap="round"/>
    <path d="M${x - 7} ${y + 3.8} Q${x} ${y + 5} ${x + 6.8} ${y + 3}" fill="none" stroke="${skinShade}" stroke-width="1.1" opacity="0.75"/>
    <path d="M${x - 6.6} ${y - 5.2} Q${x} ${y - 8} ${x + 6.6} ${y - 5.4}" fill="none" stroke="${skinShade}" stroke-width="1.1" opacity="0.6"/>
    <path d="M${x + 6.2} ${y - 0.8} q2.6 -0.5 3.8 -2.8" fill="none" stroke="#7a4a38" stroke-width="1.2" opacity="0.65"/>
    <circle cx="${x - 7.4}" cy="${y + 0.4}" r="0.9" fill="#8a4a38" opacity="0.5"/>`;
  };
  s += draw(cx - 15.5, -1);
  s += draw(cx + 15.5, 1);
  if (t.fierce) {
    s += `<path d="M${cx - 23} ${y - 6} Q${cx - 15} ${y - 10} ${cx - 8} ${y - 7}" fill="none" stroke="${hair}" stroke-width="1.6" opacity="0.8"/>
      <path d="M${cx + 8} ${y - 7} Q${cx + 15} ${y - 10} ${cx + 23} ${y - 6}" fill="none" stroke="${hair}" stroke-width="1.6" opacity="0.8"/>`;
  }
  return s;
}

function brows(t) {
  const { cx, eyeY: y, hair, hairSoft } = t;
  const by = y - 12;
  const draw = (x, side) => {
    const x0 = x - 9;
    const x1 = x + 9;
    switch (t.browType) {
      case 'sword':
        return `<path d="M${x0} ${by + 2.4} L${x1} ${by - 2.6}" stroke="${hair}" stroke-width="4" stroke-linecap="round"/>
          <path d="M${x0 + 1} ${by + 1.2} L${x1 - 1} ${by - 3}" stroke="${hairSoft}" stroke-width="1" opacity="0.4"/>`;
      case 'thick':
        return `<path d="M${x0} ${by + 1} Q${x} ${by - 5.4} ${x1} ${by - 1.4}" fill="none" stroke="${hair}" stroke-width="4.6" stroke-linecap="round"/>
          <path d="M${x0 + 2} ${by} Q${x} ${by - 3.4} ${x1 - 2} ${by - 1.4}" fill="none" stroke="${hairSoft}" stroke-width="1.1" opacity="0.35"/>`;
      case 'bushy':
        return `<path d="M${x0} ${by + 1.4} Q${x} ${by - 4.6} ${x1} ${by - 1.8}" fill="none" stroke="${hair}" stroke-width="5.2" stroke-linecap="round"/>
          <path d="M${x - 6} ${by - 3} l-2 -3 M${x} ${by - 4} l0 -3 M${x + 5} ${by - 3.4} l2 -2.6" stroke="${hair}" stroke-width="1.3"/>`;
      case 'slender':
        return `<path d="M${x0} ${by + 0.4} Q${x} ${by - 3} ${x1} ${by - 1.4}" fill="none" stroke="${hair}" stroke-width="2.2" stroke-linecap="round"/>`;
      case 'slant':
        return `<path d="M${x0} ${by + 4} L${x1} ${by - 4.4}" stroke="${hair}" stroke-width="3.8" stroke-linecap="round"/>
          <path d="M${x0 + 1} ${by + 2.8} L${x1 - 1} ${by - 3.6}" stroke="${hairSoft}" stroke-width="0.9" opacity="0.35"/>`;
      case 'droop':
        return `<path d="M${x0} ${by - 2} Q${x} ${by - 3.6} ${x1} ${by + 2}" fill="none" stroke="${hair}" stroke-width="3.6" stroke-linecap="round"/>`;
      default:
        return '';
    }
  };
  return draw(cx - 15, -1) + draw(cx + 15, 1);
}

function nose(t) {
  const { cx, eyeY } = t;
  const ny = eyeY + 24;
  return `
  <path d="M${cx - 1} ${eyeY - 8} Q${cx - 2.4} ${eyeY + 8} ${cx + 0.4} ${ny - 4}" fill="none" stroke="${t.skinLight}" stroke-width="2.4" opacity="0.4"/>
  <path d="M${cx - 4} ${eyeY - 4} Q${cx - 5.4} ${eyeY + 8} ${cx - 3.4} ${ny - 5}" fill="none" stroke="${t.skinShade}" stroke-width="1.8" opacity="0.42"/>
  <ellipse cx="${cx}" cy="${ny}" rx="6.6" ry="4" fill="${t.skinShade}" opacity="0.34"/>
  <ellipse cx="${cx - 4.2}" cy="${ny + 0.4}" rx="2" ry="1.5" fill="${t.skinShade2}" opacity="0.6"/>
  <ellipse cx="${cx + 4.2}" cy="${ny + 0.4}" rx="2" ry="1.5" fill="${t.skinShade2}" opacity="0.6"/>
  <path d="M${cx - 2} ${ny - 2.4} Q${cx} ${ny - 4.4} ${cx + 2} ${ny - 2.4}" fill="none" stroke="${shade(t.skin, 0.55)}" stroke-width="1.2" opacity="0.6"/>`;
}

function mouth(t) {
  const { cx, eyeY } = t;
  const my = eyeY + 36;
  const lip = t.female ? LIP_F : LIP_M;
  let line;
  if (t.mouthType === 'stern') line = `M${cx - 8} ${my} Q${cx} ${my + 3.4} ${cx + 8} ${my - 0.8}`;
  else if (t.mouthType === 'soft') line = `M${cx - 8} ${my + 0.4} Q${cx} ${my - 2.4} ${cx + 8} ${my + 0.2}`;
  else if (t.mouthType === 'firm') line = `M${cx - 8} ${my + 0.2} L${cx + 8} ${my - 0.2}`;
  else line = `M${cx - 8} ${my + 0.2} Q${cx} ${my + 1.8} ${cx + 8} ${my}`;
  return `
  <path d="M${cx - 8} ${my} Q${cx - 3} ${my - 3.4} ${cx} ${my - 1.4} Q${cx + 3} ${my - 3.4} ${cx + 8} ${my} Q${cx + 3} ${my + 1.6} ${cx} ${my + 1.2} Q${cx - 3} ${my + 1.6} ${cx - 8} ${my} Z" fill="${lip}" opacity="0.92"/>
  <ellipse cx="${cx}" cy="${my + 3.8}" rx="${t.female ? 6.6 : 5.8}" ry="2.3" fill="${lip}" opacity="0.5"/>
  <path d="${line}" fill="none" stroke="#5e2c26" stroke-width="1.3" opacity="0.8"/>
  <path d="M${cx - 8} ${my} q-2.4 0 -3 -1.6 M${cx + 8} ${my} q2.4 -0.2 3 -1.8" fill="none" stroke="${shade(t.skin, 0.62)}" stroke-width="1.1" opacity="0.6"/>`;
}

function ageLines(t, a) {
  const { cx, cy, eyeY, skinShade2 } = t;
  const col = shade(t.skin, 0.6);
  return `
  <path d="M${cx - 13} ${cy - 28} Q${cx} ${cy - 32} ${cx + 13} ${cy - 28} M${cx - 12} ${cy - 21} Q${cx} ${cy - 24} ${cx + 12} ${cy - 21} M${cx - 9} ${cy - 15} Q${cx} ${cy - 17} ${cx + 9} ${cy - 15}" fill="none" stroke="${col}" stroke-width="1.1" opacity="${0.5 * a}"/>
  <path d="M${cx - 21} ${eyeY + 5} Q${cx - 15} ${eyeY + 8.5} ${cx - 9} ${eyeY + 5.4} M${cx + 9} ${eyeY + 5.4} Q${cx + 15} ${eyeY + 8.5} ${cx + 21} ${eyeY + 5}" fill="none" stroke="${col}" stroke-width="1.1" opacity="${0.55 * a}"/>
  <path d="M${cx - 9} ${eyeY + 14} Q${cx - 13} ${eyeY + 24} ${cx - 11} ${eyeY + 30} M${cx + 9} ${eyeY + 14} Q${cx + 13} ${eyeY + 24} ${cx + 11} ${eyeY + 30}" fill="none" stroke="${col}" stroke-width="1.1" opacity="${0.42 * a}"/>
  <path d="M${cx - 2} ${eyeY - 6} L${cx - 2.6} ${eyeY - 1} M${cx + 2} ${eyeY - 6} L${cx + 2.6} ${eyeY - 1}" stroke="${skinShade2}" stroke-width="1.1" opacity="${0.5 * a}"/>
  <path d="M${cx - 6} ${cy + 40} Q${cx} ${cy + 44} ${cx + 6} ${cy + 40}" fill="none" stroke="${col}" stroke-width="1" opacity="${0.4 * a}"/>`;
}

function scar(t) {
  const { cx, eyeY } = t;
  if (t.scar === 'brow') {
    return `<path d="M${cx - 24} ${eyeY - 14} L${cx - 17} ${eyeY - 4}" stroke="#c9b496" stroke-width="1.8" opacity="0.85"/>
      <path d="M${cx - 24} ${eyeY - 14} L${cx - 17} ${eyeY - 4}" stroke="#7a3a30" stroke-width="0.7" opacity="0.8"/>`;
  }
  return `<path d="M${cx + 14} ${eyeY + 8} L${cx + 21} ${eyeY + 26}" stroke="#c9b496" stroke-width="1.7" opacity="0.8"/>
    <path d="M${cx + 14} ${eyeY + 8} L${cx + 21} ${eyeY + 26}" stroke="#7a3a30" stroke-width="0.6" opacity="0.7"/>`;
}

/* ------------------------------- 冠帽头饰 ------------------------------- */

function headwear(t) {
  const { cat, female, F } = t;
  if (female) return femaleCrown(t);
  if (cat === 'ruler') {
    if (F.motif === 'steppe') return hunRulerCrown(t);
    if (F.motif === 'palace') return mianGuan(t);
    return tongtianCrown(t);
  }
  if (cat === 'royal') return royalCrown(t);
  if (cat === 'general' || cat === 'warlord') return helmet(t);
  if (cat === 'official') return futou(t);
  if (cat === 'house') return xiaoGuan(t);
  if (cat === 'scholar') return fuJin(t);
  if (cat === 'merchant') return clothCap(t);
  return headBand(t);
}

function plume(t, x, y, color, spread) {
  const n = 3;
  let s = '';
  for (let i = 0; i < n; i++) {
    const dx = (i - 1) * 9;
    const tipY = y - 26 - (i === 1 ? 8 : 0);
    s += `<path d="M${x} ${y} Q${x + dx * 0.5 + spread * 6} ${y - 16} ${x + dx + spread * 10} ${tipY} Q${x + dx * 0.4 + spread * 4} ${y - 10} ${x} ${y} Z" fill="${i === 1 ? shade(color, 1.25) : color}" opacity="${0.92 - i * 0.08}"/>`;
  }
  s += `<circle cx="${x}" cy="${y}" r="3.4" fill="${t.F.light}"/>`;
  return s;
}

function helmet(t) {
  const { cx, cy, rx, F } = t;
  const hun = F.motif === 'steppe';
  const domeFill = hun ? '#4a3528' : `url(#steel${t.id})`;
  const bandFill = hun ? '#33241a' : '#2f3238';
  const trim = hun ? F.light : '#d8d2c4';
  let s = `
  <path d="M${cx - rx - 7} ${cy - 16} Q${cx} ${cy - 80} ${cx + rx + 7} ${cy - 16} L${cx + rx + 3} ${cy - 8} Q${cx} ${cy - 26} ${cx - rx - 3} ${cy - 8} Z" fill="${domeFill}" stroke="#15161a" stroke-width="1.4"/>
  <path d="M${cx - rx - 7} ${cy - 18} Q${cx} ${cy - 27} ${cx + rx + 7} ${cy - 18} L${cx + rx + 7} ${cy - 9} Q${cx} ${cy - 18} ${cx - rx - 7} ${cy - 9} Z" fill="${bandFill}"/>
  <path d="M${cx - rx + 2} ${cy - 16} Q${cx} ${cy - 22} ${cx + rx - 2} ${cy - 16}" fill="none" stroke="${trim}" stroke-width="1.2" opacity="0.6"/>
  <rect x="${cx - rx - 14}" y="${cy - 18}" width="11" height="26" rx="4.5" fill="${hun ? '#3a2a1e' : '#3a3d44'}" stroke="#15161a" stroke-width="1"/>
  <rect x="${cx + rx + 3}" y="${cy - 18}" width="11" height="26" rx="4.5" fill="${hun ? '#3a2a1e' : '#3a3d44'}" stroke="#15161a" stroke-width="1"/>`;
  if (!hun) {
    s += `<path d="M${cx - 3} ${cy - 20} L${cx + 3} ${cy - 20} L${cx + 3.6} ${cy - 2} L${cx - 3.6} ${cy - 2} Z" fill="${bandFill}" stroke="${trim}" stroke-width="0.8" opacity="0.95"/>`;
  } else {
    // 护额金饰
    s += `<path d="M${cx - 10} ${cy - 21} L${cx} ${cy - 27} L${cx + 10} ${cy - 21} L${cx + 6} ${cy - 17} L${cx - 6} ${cy - 17} Z" fill="${F.light}" opacity="0.9"/>
      <circle cx="${cx}" cy="${cy - 20.5}" r="2" fill="#8e2b22"/>`;
  }
  // 铆钉
  for (const xx of [cx - rx - 8, cx - rx + 6, cx + rx - 6, cx + rx + 8]) {
    s += `<circle cx="${xx}" cy="${cy - 13}" r="1.5" fill="${trim}" opacity="0.75"/>`;
  }
  // 盔脊
  s += `<path d="M${cx} ${cy - 78} Q${cx + 2} ${cy - 50} ${cx + 1} ${cy - 24}" fill="none" stroke="${hun ? '#241812' : '#1f2126'}" stroke-width="3" opacity="0.8"/>`;
  // 盔缨/貂尾
  if (hun) {
    s += `<path d="M${cx - 2} ${cy - 74} Q${cx - 16} ${cy - 60} ${cx - 22} ${cy - 40} Q${cx - 10} ${cy - 52} ${cx + 2} ${cy - 62} Z" fill="${t.plumeColor}" opacity="0.92"/>
      <path d="M${cx + 2} ${cy - 74} Q${cx + 14} ${cy - 62} ${cx + 16} ${cy - 46}" fill="none" stroke="${t.plumeColor}" stroke-width="3.4" opacity="0.8"/>`;
  } else {
    s += plume(t, cx, cy - 76, t.plumeColor, t.hairVar % 2 === 0 ? 1 : -1);
  }
  // 毛皮镶边（匈奴）
  if (hun) {
    let fur = '';
    for (let i = 0; i <= 9; i++) {
      const x = cx - rx - 8 + i * ((2 * rx + 16) / 9);
      fur += `<circle cx="${x.toFixed(1)}" cy="${cy - 8}" r="3.4" fill="${F.fur}" opacity="0.92"/>`;
    }
    s += fur;
  }
  return s;
}

function mianGuan(t) {
  // 大雍君主：冕冠（前旒十二珠）
  const { cx, cy, rx, F } = t;
  let beadsL = '';
  let beadsR = '';
  for (let i = 0; i < 7; i++) {
    const y = cy - 58 + i * 5.2;
    const col = i % 2 === 0 ? F.light : '#e8e0ce';
    beadsL += `<circle cx="${cx - 17}" cy="${y}" r="2.1" fill="${col}"/>`;
    beadsR += `<circle cx="${cx + 17}" cy="${y}" r="2.1" fill="${col}"/>`;
  }
  return `
  <path d="M${cx - rx - 2} ${cy - 20} Q${cx} ${cy - 58} ${cx + rx + 2} ${cy - 20} Z" fill="#17181f"/>
  <path d="M${cx - rx - 2} ${cy - 22} Q${cx} ${cy - 30} ${cx + rx + 2} ${cy - 22} L${cx + rx + 2} ${cy - 15} Q${cx} ${cy - 23} ${cx - rx - 2} ${cy - 15} Z" fill="#23262f"/>
  <rect x="${cx - 36}" y="${cy - 66}" width="72" height="9" rx="2" fill="#14151b" stroke="${F.light}" stroke-width="1.4"/>
  <rect x="${cx - 30}" y="${cy - 63}" width="60" height="3" fill="${F.light}" opacity="0.55"/>
  <circle cx="${cx}" cy="${cy - 72}" r="3.4" fill="${F.light}"/>
  <path d="M${cx} ${cy - 69} L${cx} ${cy - 66}" stroke="${F.light}" stroke-width="2"/>
  <line x1="${cx - 17}" y1="${cy - 57}" x2="${cx - 17}" y2="${cy - 26}" stroke="${F.light}" stroke-width="0.7" opacity="0.6"/>
  <line x1="${cx + 17}" y1="${cy - 57}" x2="${cx + 17}" y2="${cy - 26}" stroke="${F.light}" stroke-width="0.7" opacity="0.6"/>
  ${beadsL}${beadsR}
  <path d="M${cx - rx + 2} ${cy - 15} Q${cx} ${cy - 20} ${cx + rx - 2} ${cy - 15}" fill="none" stroke="${F.light}" stroke-width="1.6" opacity="0.7"/>`;
}

function tongtianCrown(t) {
  // 大楚君主：通天冠（博山高耸，玉簪）
  const { cx, cy, rx, F } = t;
  return `
  <path d="M${cx - rx - 2} ${cy - 20} Q${cx} ${cy - 56} ${cx + rx + 2} ${cy - 20} Z" fill="#12231f"/>
  <path d="M${cx - 16} ${cy - 34} L${cx - 10} ${cy - 70} L${cx} ${cy - 78} L${cx + 10} ${cy - 70} L${cx + 16} ${cy - 34} Q${cx} ${cy - 42} ${cx - 16} ${cy - 34} Z" fill="#17302b" stroke="${F.light}" stroke-width="1.3"/>
  <path d="M${cx - 8} ${cy - 64} L${cx} ${cy - 72} L${cx + 8} ${cy - 64} M${cx - 10} ${cy - 52} L${cx + 10} ${cy - 52} M${cx - 12} ${cy - 42} L${cx + 12} ${cy - 42}" fill="none" stroke="${F.light}" stroke-width="1.1" opacity="0.75"/>
  <line x1="${cx - 26}" y1="${cy - 30}" x2="${cx + 26}" y2="${cy - 30}" stroke="${F.lightSoft}" stroke-width="2" opacity="0.85"/>
  <circle cx="${cx - 27}" cy="${cy - 30}" r="2.4" fill="${F.lightSoft}"/>
  <circle cx="${cx + 27}" cy="${cy - 30}" r="2.4" fill="${F.lightSoft}"/>
  <path d="M${cx - rx + 2} ${cy - 16} Q${cx} ${cy - 24} ${cx + rx - 2} ${cy - 16}" fill="none" stroke="${F.light}" stroke-width="1.6" opacity="0.65"/>`;
}

function hunRulerCrown(t) {
  // 匈奴单于：皮冠 + 金狼牙饰 + 鹰羽
  const { cx, cy, rx, F } = t;
  return `
  <path d="M${cx - rx - 4} ${cy - 18} Q${cx} ${cy - 66} ${cx + rx + 4} ${cy - 18} L${cx + rx} ${cy - 8} Q${cx} ${cy - 24} ${cx - rx} ${cy - 8} Z" fill="#3a2a1e" stroke="#1f150e" stroke-width="1.4"/>
  ${Array.from({ length: 10 }, (_, i) => {
    const x = cx - rx - 5 + i * ((2 * rx + 10) / 9);
    return `<circle cx="${x.toFixed(1)}" cy="${cy - 9}" r="3.6" fill="${F.fur}"/>`;
  }).join('')}
  <path d="M${cx - 18} ${cy - 26} L${cx - 11} ${cy - 38} L${cx - 5} ${cy - 28} L${cx} ${cy - 41} L${cx + 5} ${cy - 28} L${cx + 11} ${cy - 38} L${cx + 18} ${cy - 26} Q${cx} ${cy - 34} ${cx - 18} ${cy - 26} Z" fill="${F.light}" opacity="0.92"/>
  <circle cx="${cx}" cy="${cy - 27}" r="3" fill="#8e2b22"/>
  <path d="M${cx - 4} ${cy - 62} Q${cx - 26} ${cy - 78} ${cx - 34} ${cy - 104} Q${cx - 16} ${cy - 78} ${cx + 2} ${cy - 58} Z" fill="#2a2018" opacity="0.95"/>
  <path d="M${cx + 2} ${cy - 60} Q${cx + 18} ${cy - 84} ${cx + 14} ${cy - 106} Q${cx + 10} ${cy - 80} ${cx + 6} ${cy - 56} Z" fill="${F.light}" opacity="0.8"/>`;
}

function royalCrown(t) {
  const { cx, cy, rx, F } = t;
  return `
  <path d="M${cx - rx - 2} ${cy - 20} Q${cx} ${cy - 56} ${cx + rx + 2} ${cy - 20} Z" fill="#1a1c24"/>
  <path d="M${cx - 14} ${cy - 32} Q${cx - 10} ${cy - 58} ${cx} ${cy - 62} Q${cx + 10} ${cy - 58} ${cx + 14} ${cy - 32} Q${cx} ${cy - 40} ${cx - 14} ${cy - 32} Z" fill="#22262f" stroke="${F.light}" stroke-width="1.1"/>
  <path d="M${cx - 10} ${cy - 48} L${cx + 10} ${cy - 48} M${cx - 12} ${cy - 38} L${cx + 12} ${cy - 38}" stroke="${F.light}" stroke-width="1" opacity="0.7"/>
  <rect x="${cx - 3}" y="${cy - 64}" width="6" height="8" rx="1.5" fill="${F.light}"/>
  <path d="M${cx - rx + 1} ${cy - 18} Q${cx} ${cy - 25} ${cx + rx - 1} ${cy - 18}" fill="none" stroke="${F.light}" stroke-width="1.4" opacity="0.6"/>`;
}

function femaleCrown(t) {
  const { cx, cy, rx, F, cat } = t;
  const queen = cat === 'royal';
  if (!queen) {
    // 公主/王女：双鬟 + 金步摇
    return `
    <circle cx="${cx - 27}" cy="${cy - 50}" r="11.5" fill="none" stroke="${F.light}" stroke-width="1.6"/>
    <circle cx="${cx + 27}" cy="${cy - 50}" r="11.5" fill="none" stroke="${F.light}" stroke-width="1.6"/>
    <path d="M${cx - 18} ${cy - 52} Q${cx} ${cy - 60} ${cx + 18} ${cy - 52}" fill="none" stroke="${F.light}" stroke-width="1.4" opacity="0.8"/>
    <circle cx="${cx - 15}" cy="${cy - 56}" r="2.4" fill="${F.light}"/>
    <circle cx="${cx + 15}" cy="${cy - 56}" r="2.4" fill="${F.light}"/>
    ${hairpin(t, -1)}${hairpin(t, 1)}
    <path d="M${cx - rx + 2} ${cy - 12} Q${cx} ${cy - 20} ${cx + rx - 2} ${cy - 12}" fill="none" stroke="${F.light}" stroke-width="1.2" opacity="0.55"/>`;
  }
  // 王后：凤冠简化
  let drops = '';
  for (const side of [-1, 1]) {
    for (let i = 0; i < 4; i++) {
      drops += `<circle cx="${cx + side * 24}" cy="${cy - 30 + i * 6}" r="1.8" fill="${i % 2 ? F.light : '#c9d6c8'}"/>`;
    }
  }
  return `
  <path d="M${cx - 22} ${cy - 46} Q${cx - 14} ${cy - 64} ${cx} ${cy - 66} Q${cx + 14} ${cy - 64} ${cx + 22} ${cy - 46} Q${cx} ${cy - 54} ${cx - 22} ${cy - 46} Z" fill="${F.light}" opacity="0.92"/>
  <path d="M${cx - 14} ${cy - 52} Q${cx - 6} ${cy - 66} ${cx} ${cy - 68} Q${cx + 6} ${cy - 66} ${cx + 14} ${cy - 52}" fill="none" stroke="${shade(F.light, 0.7)}" stroke-width="1.2"/>
  <circle cx="${cx}" cy="${cy - 55}" r="3.4" fill="#9e3026"/>
  <circle cx="${cx - 13}" cy="${cy - 50}" r="2.2" fill="#dfe8dc"/>
  <circle cx="${cx + 13}" cy="${cy - 50}" r="2.2" fill="#dfe8dc"/>
  <path d="M${cx - rx - 1} ${cy - 20} Q${cx} ${cy - 30} ${cx + rx + 1} ${cy - 20} L${cx + rx - 1} ${cy - 12} Q${cx} ${cy - 21} ${cx - rx + 1} ${cy - 12} Z" fill="#191a20"/>
  <path d="M${cx - 22} ${cy - 44} Q${cx - 26} ${cy - 32} ${cx - 23} ${cy - 24} M${cx + 22} ${cy - 44} Q${cx + 26} ${cy - 32} ${cx + 23} ${cy - 24}" stroke="${F.light}" stroke-width="0.8" opacity="0.7"/>
  ${drops}`;
}

function hairpin(t, side) {
  const { cx, cy, F } = t;
  return `<path d="M${cx + side * 20} ${cy - 52} Q${cx + side * 34} ${cy - 58} ${cx + side * 40} ${cy - 50}" fill="none" stroke="${F.light}" stroke-width="1.5"/>
  <circle cx="${cx + side * 40}" cy="${cy - 50}" r="2.2" fill="${F.light}"/>`;
}

function futou(t) {
  const { cx, cy, rx, F } = t;
  const longWing = t.chance(0.55);
  const len = longWing ? 36 : 24;
  return `
  <path d="M${cx - rx - 2} ${cy - 18} Q${cx} ${cy - 58} ${cx + rx + 2} ${cy - 18} Z" fill="#14141a"/>
  <ellipse cx="${cx}" cy="${cy - 52}" rx="7" ry="9" fill="#14141a"/>
  <path d="M${cx - rx - 1} ${cy - 22} Q${cx} ${cy - 29} ${cx + rx + 1} ${cy - 22} L${cx + rx + 1} ${cy - 15} Q${cx} ${cy - 22} ${cx - rx - 1} ${cy - 15} Z" fill="#1d1d24"/>
  <path d="M${cx - rx - 1} ${cy - 21} Q${cx - rx - 16} ${cy - 26} ${cx - rx - len} ${cy - 23} Q${cx - rx - 16} ${cy - 18} ${cx - rx - 1} ${cy - 16} Z" fill="#14141a"/>
  <path d="M${cx + rx + 1} ${cy - 21} Q${cx + rx + 16} ${cy - 26} ${cx + rx + len} ${cy - 23} Q${cx + rx + 16} ${cy - 18} ${cx + rx + 1} ${cy - 16} Z" fill="#14141a"/>
  <path d="M${cx - 8} ${cy - 30} Q${cx} ${cy - 35} ${cx + 8} ${cy - 30}" fill="none" stroke="${F.light}" stroke-width="0.9" opacity="0.3"/>`;
}

function xiaoGuan(t) {
  const { cx, cy, rx, F } = t;
  return `
  <path d="M${cx - rx - 2} ${cy - 18} Q${cx} ${cy - 52} ${cx + rx + 2} ${cy - 18} Z" fill="#1b1917"/>
  <rect x="${cx - 9}" y="${cy - 56}" width="18" height="12" rx="2" fill="#26221c" stroke="${F.light}" stroke-width="1.1" opacity="0.95"/>
  <line x1="${cx - 24}" y1="${cy - 42}" x2="${cx + 24}" y2="${cy - 42}" stroke="${F.light}" stroke-width="1.8"/>
  <circle cx="${cx - 25}" cy="${cy - 42}" r="2" fill="${F.light}"/>
  <circle cx="${cx + 25}" cy="${cy - 42}" r="2" fill="${F.light}"/>
  <path d="M${cx - rx + 1} ${cy - 18} Q${cx} ${cy - 25} ${cx + rx - 1} ${cy - 18}" fill="none" stroke="${F.light}" stroke-width="1" opacity="0.35"/>`;
}

function fuJin(t) {
  const { cx, cy, rx, F } = t;
  const white = t.chance(0.4);
  const col = white ? '#cbc4b0' : '#20201d';
  const edge = white ? '#9c957f' : '#141410';
  return `
  <path d="M${cx - rx - 2} ${cy - 18} Q${cx} ${cy - 58} ${cx + rx + 2} ${cy - 18} Z" fill="${col}"/>
  <path d="M${cx - rx - 1} ${cy - 22} Q${cx} ${cy - 29} ${cx + rx + 1} ${cy - 22} L${cx + rx + 1} ${cy - 15} Q${cx} ${cy - 22} ${cx - rx - 1} ${cy - 15} Z" fill="${edge}"/>
  <path d="M${cx - 12} ${cy - 30} Q${cx} ${cy - 38} ${cx + 12} ${cy - 30}" fill="none" stroke="${white ? '#837c68' : '#3c3c34'}" stroke-width="1.4"/>
  <path d="M${cx - rx + 2} ${cy - 18} Q${cx - rx - 8} ${cy + 30} ${cx - rx + 6} ${cy + 64} Q${cx - rx + 2} ${cy + 20} ${cx - rx + 4} ${cy - 12} Z" fill="${col}" opacity="0.95"/>
  <path d="M${cx + rx - 2} ${cy - 18} Q${cx + rx + 8} ${cy + 30} ${cx + rx - 6} ${cy + 64} Q${cx + rx - 2} ${cy + 20} ${cx + rx - 4} ${cy - 12} Z" fill="${col}" opacity="0.95"/>
  <path d="M${cx - rx + 2} ${cy + 40} L${cx - rx + 8} ${cy + 50} M${cx + rx - 2} ${cy + 40} L${cx + rx - 8} ${cy + 50}" stroke="${F.light}" stroke-width="1" opacity="0.4"/>`;
}

function clothCap(t) {
  const { cx, cy, rx, F } = t;
  return `
  <path d="M${cx - rx - 2} ${cy - 16} Q${cx - 4} ${cy - 54} ${cx} ${cy - 56} Q${cx + 4} ${cy - 54} ${cx + rx + 2} ${cy - 16} Z" fill="#33291e"/>
  <path d="M${cx - rx - 1} ${cy - 22} Q${cx} ${cy - 28} ${cx + rx + 1} ${cy - 22} L${cx + rx + 1} ${cy - 14} Q${cx} ${cy - 20} ${cx - rx - 1} ${cy - 14} Z" fill="#463727"/>
  <circle cx="${cx}" cy="${cy - 55}" r="2.6" fill="${F.light}" opacity="0.7"/>
  <path d="M${cx - 10} ${cy - 40} Q${cx} ${cy - 46} ${cx + 10} ${cy - 40}" fill="none" stroke="${F.light}" stroke-width="0.9" opacity="0.3"/>`;
}

function headBand(t) {
  const { cx, cy, rx, F } = t;
  return `
  <path d="M${cx - rx} ${cy - 24} Q${cx} ${cy - 30} ${cx + rx} ${cy - 24} L${cx + rx} ${cy - 14} Q${cx} ${cy - 21} ${cx - rx} ${cy - 14} Z" fill="#2d2a24"/>
  <path d="M${cx - rx} ${cy - 24} Q${cx} ${cy - 30} ${cx + rx} ${cy - 24}" fill="none" stroke="${F.light}" stroke-width="1" opacity="0.35"/>
  <circle cx="${cx - rx - 2}" cy="${cy - 19}" r="3" fill="#3b372f"/>
  <circle cx="${cx + rx + 2}" cy="${cy - 19}" r="3" fill="#3b372f"/>`;
}

/* ------------------------------- 服饰前层 ------------------------------- */

function garmentFront(t) {
  const { cat, female, F } = t;
  if (MARTIAL.includes(cat)) return armor(t);
  return robe(t, female);
}

function shoulderGuard(t, side /* -1 / 1 */, hun) {
  const { cy: _cy, F } = t;
  void _cy;
  const x = 128 + side * 38;
  const y = 226;
  if (hun) {
    let scallops = '';
    for (let i = 0; i < 6; i++) {
      const a = -0.6 + i * 0.24;
      scallops += `<circle cx="${(x + Math.cos(a) * 24 * side).toFixed(1)}" cy="${(y + Math.sin(a) * 22 + 12).toFixed(1)}" r="6.4" fill="${F.fur}"/>`;
    }
    return `
    <path d="M${x - 26} ${y + 30} Q${x - 30} ${y - 14} ${x - side * 4} ${y - 16} Q${x + side * 2} ${y + 6} ${x + 18 * side} ${y + 34} Z" fill="#3a2a1e" stroke="#241812" stroke-width="1.2"/>
    ${scallops}
    <path d="M${x - side * 6} ${y - 6} Q${x + side * 4} ${y + 8} ${x + side * 8} ${y + 24}" fill="none" stroke="${F.light}" stroke-width="1.4" opacity="0.55"/>`;
  }
  const fierce = t.fierce;
  return `
  <path d="M${x - 28} ${y + 32} Q${x - 32} ${y - 16} ${x - side * 4} ${y - 18} Q${x + side * 4} ${y + 8} ${x + 20 * side} ${y + 36} Z" fill="url(#steel${t.id})" stroke="#1c1d21" stroke-width="1.3"/>
  <path d="M${x - 20} ${y + 2} Q${x - side * 8} ${y - 8} ${x + side * 8} ${y + 2}" fill="none" stroke="#d8d2c4" stroke-width="1.3" opacity="0.45"/>
  ${[0, 1, 2].map((i) => `<circle cx="${x - 14 * side + i * 8 * side}" cy="${y + 14 + i * 6}" r="1.8" fill="${F.light}" opacity="0.8"/>`).join('')}
  ${fierce ? `<path d="M${x - 8} ${y + 4} L${x} ${y - 4} L${x + 8} ${y + 4} M${x - 6} ${y + 12} Q${x} ${y + 8} ${x + 6} ${y + 12}" fill="none" stroke="${F.light}" stroke-width="1.6" opacity="0.75"/>
    <circle cx="${x - 4}" cy="${y + 16}" r="1.3" fill="${F.light}"/><circle cx="${x + 4}" cy="${y + 16}" r="1.3" fill="${F.light}"/>` : ''}`;
}

function armor(t) {
  const { cx, F } = t;
  const hun = F.motif === 'steppe';
  let slats = '';
  for (let y = 246; y <= 298; y += 9) {
    slats += `<path d="M92 ${y} L164 ${y}" stroke="#202227" stroke-width="2.2"/>`;
    for (let x = 100; x <= 156; x += 14) {
      slats += `<circle cx="${x}" cy="${y - 4}" r="1.4" fill="${F.light}" opacity="0.55"/>`;
    }
  }
  const furCollar = hun
    ? `${Array.from({ length: 9 }, (_, i) => `<circle cx="${105 + i * 23 / 4}" cy="${228 + Math.abs(4 - i) * 2.4}" r="5" fill="${F.furDark}"/>`).join('')}
       ${Array.from({ length: 9 }, (_, i) => `<circle cx="${151 - i * 23 / 4}" cy="${228 + Math.abs(4 - i) * 2.4}" r="5" fill="${F.fur}"/>`).join('')}`
    : '';
  return `
  ${shoulderGuard(t, -1, hun)}${shoulderGuard(t, 1, hun)}
  <path d="M104 228 L152 228 L168 320 L88 320 Z" fill="#3d4148"/>
  <path d="M104 228 L128 240 L152 228 L146 320 L110 320 Z" fill="url(#steel${t.id})" opacity="0.85"/>
  ${slats}
  <path d="M128 240 L128 320" stroke="#1a1c20" stroke-width="2.4"/>
  <path d="M110 232 L128 250 L146 232 L140 256 L128 263 L116 256 Z" fill="${F.primary}" stroke="${F.light}" stroke-width="1.1" opacity="0.95"/>
  <circle cx="128" cy="282" r="11" fill="${F.primaryDark}" stroke="${F.light}" stroke-width="1.8"/>
  <path d="M123 282 L128 276 L133 282 L128 288 Z" fill="${F.light}" opacity="0.9"/>
  <rect x="86" y="300" width="84" height="13" fill="#241b12"/>
  <rect x="118" y="299" width="20" height="15" rx="2" fill="${F.light}"/>
  <path d="M92 306 H116 M140 306 H164" stroke="${F.light}" stroke-width="1.2" opacity="0.5"/>
  ${furCollar}`;
}

function robe(t, female) {
  const { cx, F, cat, cloth, clothDark, clothLight } = t;
  const inner = cat === 'scholar' ? '#e6e0cd' : '#e2d8c0';
  let s = `
  <path d="M${female ? 108 : 102} 216 L${female ? 148 : 154} 216 L172 320 L84 320 Z" fill="${cloth}"/>
  <path d="M${cx - 16} 216 L${cx + 16} 216 L${cx} 272 Z" fill="${inner}"/>
  <path d="M${female ? 102 : 98} 214 L${cx - 12} 216 L${cx + 2} 286 L${cx - 20} 286 Z" fill="${clothDark}"/>
  <path d="M${female ? 154 : 158} 214 L${cx + 12} 216 L${cx - 2} 286 L${cx + 20} 286 Z" fill="${clothLight}" opacity="0.8"/>
  <path d="M${cx - 14} 218 L${cx} 270" stroke="${F.light}" stroke-width="1.3" opacity="0.55"/>
  <path d="M${cx + 14} 218 L${cx} 270" stroke="${F.light}" stroke-width="1.3" opacity="0.55"/>
  <path d="M92 298 H164" stroke="${F.light}" stroke-width="1.1" opacity="0.3"/>
  <rect x="86" y="298" width="84" height="12" fill="#241b12"/>
  <rect x="119" y="297" width="18" height="14" rx="2" fill="${F.light}" opacity="0.92"/>`;
  // 身份装饰
  if (cat === 'official') {
    s += `<rect x="104" y="240" width="48" height="38" rx="2" fill="${F.primaryDark}" stroke="${F.light}" stroke-width="1.2" opacity="0.95"/>
      <path d="M112 266 L120 254 L128 262 L136 252 L144 266" fill="none" stroke="${F.light}" stroke-width="1.3" opacity="0.8"/>
      <path d="M112 270 H144" stroke="${F.light}" stroke-width="0.9" opacity="0.5"/>`;
  } else if (cat === 'royal') {
    s += `<circle cx="128" cy="262" r="12" fill="none" stroke="${F.light}" stroke-width="1.5" opacity="0.85"/>
      <path d="M121 264 Q128 252 135 264 M123 267 H133" fill="none" stroke="${F.light}" stroke-width="1.1" opacity="0.8"/>`;
  } else if (cat === 'house') {
    s += `<path d="M100 250 H156 M98 286 H158" stroke="${F.light}" stroke-width="0.9" opacity="0.32"/>
      ${[104, 118, 138, 152].map((x) => `<path d="M${x} 250 l4 4 l-4 4 l-4 -4 Z" fill="none" stroke="${F.light}" stroke-width="0.8" opacity="0.4"/>`).join('')}`;
  } else if (cat === 'scholar') {
    s += `<path d="M104 246 L150 306" stroke="${F.light}" stroke-width="1.2" opacity="0.28"/>`;
  } else if (cat === 'merchant') {
    s += `<circle cx="149" cy="282" r="5" fill="none" stroke="${F.light}" stroke-width="1.6" opacity="0.8"/>
      <rect x="146.5" y="279.5" width="5" height="5" fill="none" stroke="${F.light}" stroke-width="1"/>`;
  } else if (cat === 'common') {
    s = s.replace('<path d="M92 298 H164" stroke="' + F.light + '" stroke-width="1.1" opacity="0.3"/>', '');
    s += `<path d="M96 312 Q128 306 160 312" fill="none" stroke="${clothDark}" stroke-width="1.6" opacity="0.8"/>`;
  }
  if (F.motif === 'steppe' && cat !== 'common') {
    let fur = '';
    for (let i = 0; i < 8; i++) {
      fur += `<circle cx="${102 + i * 34 / 7}" cy="${219 + Math.abs(3.5 - i) * 2.2}" r="4.6" fill="${i % 2 ? F.fur : F.furDark}"/>`;
    }
    s += fur;
  }
  return s;
}

/* ------------------------------- 须发 ------------------------------- */

function beardLayer(t) {
  const b = t.beard;
  if (b < 0) return '';
  const { cx, eyeY, hair, hairSoft, F } = t;
  const my = eyeY + 36;
  const grey = t.grey;
  const strand = (d) => `<path d="${d}" fill="none" stroke="${grey ? mix(hair, '#ffffff', 0.35) : hairSoft}" stroke-width="0.9" opacity="0.4"/>`;
  // 髭（上唇胡），b>=2
  let mustache = '';
  if (b >= 2) {
    mustache = `
    <path d="M${cx - 8} ${my - 2} Q${cx - 4} ${my - 7} ${cx - 0.5} ${my - 2.6} Q${cx - 4} ${my + 1} ${cx - 10} ${my + 1.6} Q${cx - 14} ${my - 1} ${cx - 8} ${my - 2} Z" fill="${hair}"/>
    <path d="M${cx + 8} ${my - 2} Q${cx + 4} ${my - 7} ${cx + 0.5} ${my - 2.6} Q${cx + 4} ${my + 1} ${cx + 10} ${my + 1.6} Q${cx + 14} ${my - 1} ${cx + 8} ${my - 2} Z" fill="${hair}"/>
    <path d="M${cx - 9} ${my - 1} Q${cx - 15} ${my - 3} ${cx - 17} ${my + 1}" fill="none" stroke="${hair}" stroke-width="2" stroke-linecap="round"/>
    <path d="M${cx + 9} ${my - 1} Q${cx + 15} ${my - 3} ${cx + 17} ${my + 1}" fill="none" stroke="${hair}" stroke-width="2" stroke-linecap="round"/>`;
  }
  if (b === 0) return mustache;
  if (b === 1) {
    // 短髥青影
    return `<path d="M${cx - 15} ${my + 6} Q${cx} ${my + 16} ${cx + 15} ${my + 6} Q${cx + 12} ${my + 22} ${cx} ${my + 24} Q${cx - 12} ${my + 22} ${cx - 15} ${my + 6} Z" fill="${hair}" opacity="0.28"/>`;
  }
  if (b === 2) {
    // 山羊胡
    return mustache + `
    <path d="M${cx - 6} ${my + 5} Q${cx - 8} ${my + 24} ${cx - 2} ${my + 34} Q${cx} ${my + 37} ${cx + 2} ${my + 34} Q${cx + 8} ${my + 24} ${cx + 6} ${my + 5} Q${cx} ${my + 10} ${cx - 6} ${my + 5} Z" fill="${hair}"/>
    ${strand(`M${cx - 2} ${my + 9} Q${cx - 3} ${my + 22} ${cx - 1} ${my + 33}`)}
    ${strand(`M${cx + 2} ${my + 9} Q${cx + 3} ${my + 22} ${cx + 1} ${my + 33}`)}`;
  }
  if (b === 3) {
    // 短髯连腮
    return mustache + `
    <path d="M${cx - 20} ${my + 2} Q${cx - 26} ${t.cy + 30} ${cx - 8} ${t.cy + 46} Q${cx} ${t.cy + 50} ${cx + 8} ${t.cy + 46} Q${cx + 26} ${t.cy + 30} ${cx + 20} ${my + 2} Q${cx + 12} ${my + 10} ${cx} ${my + 9} Q${cx - 12} ${my + 10} ${cx - 20} ${my + 2} Z" fill="${hair}" opacity="0.96"/>
    ${strand(`M${cx - 12} ${my + 12} Q${cx - 14} ${t.cy + 30} ${cx - 8} ${t.cy + 44}`)}
    ${strand(`M${cx + 12} ${my + 12} Q${cx + 14} ${t.cy + 30} ${cx + 8} ${t.cy + 44}`)}
    ${strand(`M${cx} ${my + 12} L${cx} ${t.cy + 47}`)}`;
  }
  if (b === 4) {
    // 长髯（过胸，两缕）
    return mustache + `
    <path d="M${cx - 21} ${my + 2} Q${cx - 34} ${t.cy + 70} ${cx - 20} 286 Q${cx - 8} 296 ${cx - 4} 262 Q${cx - 8} ${t.cy + 40} ${cx - 14} ${my + 8} Z" fill="${hair}" opacity="0.95"/>
    <path d="M${cx + 21} ${my + 2} Q${cx + 34} ${t.cy + 70} ${cx + 20} 286 Q${cx + 8} 296 ${cx + 4} 262 Q${cx + 8} ${t.cy + 40} ${cx + 14} ${my + 8} Z" fill="${hair}" opacity="0.95"/>
    <path d="M${cx - 9} ${my + 4} Q${cx} ${my + 14} ${cx + 9} ${my + 4} Q${cx + 6} ${t.cy + 40} ${cx} 250 Q${cx - 6} ${t.cy + 40} ${cx - 9} ${my + 4} Z" fill="${hair}" opacity="0.97"/>
    ${strand(`M${cx - 16} ${my + 16} Q${cx - 22} ${t.cy + 60} ${cx - 15} 280`)}
    ${strand(`M${cx + 16} ${my + 16} Q${cx + 22} ${t.cy + 60} ${cx + 15} 280`)}
    ${strand(`M${cx - 4} ${my + 14} Q${cx - 6} ${t.cy + 50} ${cx - 3} 246`)}
    ${strand(`M${cx + 4} ${my + 14} Q${cx + 6} ${t.cy + 50} ${cx + 3} 246`)}`;
  }
  if (b === 5) {
    // 络腮胡
    return mustache + `
    <path d="M${cx - 24} ${my - 2} Q${cx - 30} ${t.cy + 26} ${cx - 18} ${t.cy + 46} Q${cx} ${t.cy + 56} ${cx + 18} ${t.cy + 46} Q${cx + 30} ${t.cy + 26} ${cx + 24} ${my - 2} Q${cx + 18} ${my + 12} ${cx} ${my + 11} Q${cx - 18} ${my + 12} ${cx - 24} ${my - 2} Z" fill="${hair}" opacity="0.95"/>
    ${strand(`M${cx - 18} ${my + 10} Q${cx - 22} ${t.cy + 30} ${cx - 15} ${t.cy + 44}`)}
    ${strand(`M${cx + 18} ${my + 10} Q${cx + 22} ${t.cy + 30} ${cx + 15} ${t.cy + 44}`)}
    ${strand(`M${cx} ${my + 14} Q${cx} ${t.cy + 40} ${cx} ${t.cy + 50}`)}`;
  }
  // b === 6 虬髯
  return mustache + `
  <path d="M${cx - 20} ${my} Q${cx - 28} ${t.cy + 24} ${cx - 16} ${t.cy + 40} Q${cx - 8} ${t.cy + 46} ${cx - 6} ${t.cy + 30} Z" fill="${hair}" opacity="0.95"/>
  <path d="M${cx + 20} ${my} Q${cx + 28} ${t.cy + 24} ${cx + 16} ${t.cy + 40} Q${cx + 8} ${t.cy + 46} ${cx + 6} ${t.cy + 30} Z" fill="${hair}" opacity="0.95"/>
  <path d="M${cx - 12} ${my + 6} Q${cx} ${my + 18} ${cx + 12} ${my + 6} Q${cx + 8} ${my + 26} ${cx} ${my + 28} Q${cx - 8} ${my + 26} ${cx - 12} ${my + 6} Z" fill="${hair}" opacity="0.95"/>
  <path d="M${cx - 24} ${t.cy + 6} q5 6 0 10 M${cx + 24} ${t.cy + 6} q-5 6 0 10" fill="none" stroke="${hair}" stroke-width="2.4"/>
  ${strand(`M${cx} ${my + 12} Q${cx} ${t.cy + 30} ${cx} ${t.cy + 40}`)}`;
}

/* ------------------------------- 质感与钤印 ------------------------------- */

function speckles(t) {
  // 确定性纸绢颗粒（替代噪声滤镜，长列表渲染更省）
  const r = t.r;
  const dots = [];
  for (let i = 0; i < 26; i++) {
    const x = Math.floor(r() * 256);
    const y = Math.floor(r() * 320);
    const rad = (r() * 0.7 + 0.3).toFixed(2);
    const op = (r() * 0.05 + 0.02).toFixed(3);
    dots.push(`<circle cx="${x}" cy="${y}" r="${rad}" fill="#e8ddc4" opacity="${op}"/>`);
  }
  return dots.join('');
}

function seal(t) {
  const { F, cat } = t;
  let glyph;
  switch (cat) {
    case 'ruler':
      glyph = 'M7 19 L11 10 L16 16 L21 9 L25 19 Z';
      break;
    case 'general':
    case 'warlord':
      glyph = 'M16 7 L16 21 M11 12 L16 7 L21 12 M12 21 H20';
      break;
    case 'official':
    case 'scholar':
      glyph = 'M9 10 H23 M11 10 V22 M21 10 V22 M9 22 H23 M14 14 H18 M14 18 H18';
      break;
    case 'royal':
      glyph = 'M12 9 a4 4 0 1 0 0.1 0 M10 19 H22';
      break;
    case 'merchant':
      glyph = 'M16 9 a7 7 0 1 0 0.1 0 M13 16 H19 M16 13 V19';
      break;
    case 'house':
      glyph = 'M8 20 L8 12 L16 8 L24 12 L24 20 Z M12 20 V15 H20 V20';
      break;
    default:
      glyph = 'M10 20 Q16 10 22 20';
  }
  return `
  <g opacity="0.82">
    <rect x="220" y="282" width="26" height="26" rx="3" fill="${F.primaryDark}" stroke="${F.light}" stroke-width="1.1" opacity="0.9"/>
    <path d="${glyph}" fill="none" stroke="${F.light}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" opacity="0.85"/>
  </g>`;
}

/* ------------------------------- 生成入口 ------------------------------- */

// 将 id 注入每个角色的绘制上下文
const originalPortrait = portrait;
function build(c) {
  return originalPortrait(c);
}

fs.mkdirSync(outDir, { recursive: true });
let count = 0;
const categories = {};
for (const c of seed.characters) {
  const svg = build(c);
  fs.writeFileSync(path.join(outDir, `${c.person_id}.svg`), svg, 'utf8');
  categories[categoryOf(c)] = (categories[categoryOf(c)] ?? 0) + 1;
  count++;
}

const favicon = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
<rect width="64" height="64" rx="12" fill="#1b1a17"/>
<path d="M32 8 L38 24 L56 24 L42 35 L47 52 L32 41 L17 52 L22 35 L8 24 L26 24 Z" fill="#c9a227" opacity="0.9"/>
<path d="M32 24 L32 41" stroke="#1b1a17" stroke-width="3"/>
</svg>`;
fs.mkdirSync(path.join(ROOT, 'apps/web/public/assets/units'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'apps/web/public/assets/units/favicon.svg'), favicon, 'utf8');

console.log(`portraits: ${count} → ${path.relative(ROOT, outDir)}`);
console.log('categories:', categories);
