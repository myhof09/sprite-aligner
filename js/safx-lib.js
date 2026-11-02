// safx-lib.js — built-in sa-fx@1 recipes (our own designs), colour themes, slash trail shapes and the slash controls.
//
// Controls never touch the recipe the user edits: apply() returns a changed copy for rendering (slash layers get the
// shape / curve / radius / thickness / tail, sparks layers the count, every palette the theme, the whole effect a turn).
'use strict';
const SAFX_LIB = (() => {
  const clone = o => JSON.parse(JSON.stringify(o));
  /** Keyframes with unique, increasing frames (later entries win on duplicates). */
  const ks = (...keys) => {
    const m = new Map();
    for (const k of keys) m.set(Math.round(k[0]), [Math.round(k[0]), ...k.slice(1)]);
    return [...m.values()].sort((a, b) => a[0] - b[0]);
  };

  const THEMES = {
    whiteblue: { label: '흰 · 파랑', colors: ['#1b2a6b', '#3f7fd1', '#a9dcff', '#f4fbff'] },
    gold: { label: '금색', colors: ['#5a2d05', '#b8720f', '#f2c14e', '#fff3c4'] },
    red: { label: '빨강', colors: ['#3d0610', '#9e1426', '#ef4b4b', '#ffd0c8'] },
    ink: { label: '먹 (검정)', colors: ['#0a0a0e', '#23232b', '#4a4a55'] },
    ice: { label: '얼음 (청록)', colors: ['#0d3a4f', '#2a9bc0', '#8ff0ff', '#effdff'] },
    fire: { label: '화염', colors: ['#3d0a0a', '#a3231b', '#e8591c', '#ffb030', '#fff1b8'] },
    volt: { label: '번개', colors: ['#1a1f5c', '#5b5ff0', '#b6d4ff', '#ffffff'] },
  };
  const C = {
    wind: ['#1f4d3a', '#4fbf8f', '#c9ffe6', '#f6fffb'], ember: ['#7a2b0c', '#e0661c', '#ffc14a', '#fff6d6'],
    dust: ['#5b4a3a', '#9c8466', '#d8c7a5'], heal: ['#0f4a2a', '#2fae5c', '#9dff9a', '#f0fff0'], smoke: ['#2b2b33', '#55555f', '#8a8a96', '#c4c4cc'],
    aura: ['#3a1466', '#7b3fe0', '#c39bff', '#f4ecff'],
  };

  const SHAPES = {
    original: '원래 모양', crescent: '가는 초승달', halfmoon: '두꺼운 반달', tapered: '점점 가늘게', comet: '혜성 (밝은 머리)',
    ribbon: '물결 띠', segmented: '끊어진 호', jagged: '톱니 가장자리', double: '두 줄', spiral: '나선', zigzag: '지그재그', ring: '완전한 원',
  };

  /** A sweeping slash: the head reaches the end by frame `hit` after `delay`, then runs on and the trail thins out. */
  function slash(F, o = {}) {
    const d = o.delay || 0, A = Math.min(F - 2, d + (o.hit || 3)), E = F - 1, t = o.thick ?? 11;
    const L = {
      type: 'slash', x: o.x ?? 0.5, y: o.y ?? 0.55, radius: o.radius ?? 27, start: o.start ?? -170, sweep: o.sweep ?? 160,
      aspect: o.aspect ?? 0.5, rot: o.rot ?? 0, taper: o.taper ?? 1.1, shape: o.shape ?? 'crescent',
      head: ks([0, 0], [d, 0], [A, 1.05, 'out'], [E, o.headEnd ?? 1.35]),
      tail: ks([0, 0.3], [A, o.tail ?? 0.8], [E, 0.35]),
      thick: ks([0, 1], [d, Math.max(1, t * 0.4)], [A, t, 'out'], [E, 1]),
    };
    if (o.echo) L.echo = o.echo;
    return L;
  }

  /** A few glints thrown off the swing. */
  const sparkles = (F, o = {}) => ({
    type: 'sparks', x: o.x ?? 0.5, y: o.y ?? 0.55, w: o.w ?? 40, h: o.h ?? 14, count: o.count ?? 8, seed: o.seed ?? 3,
    start: o.start ?? Math.round(F * 0.2), life: o.life ?? Math.round(F * 0.4), outward: o.outward ?? true, angle: o.angle ?? -90,
    spread: o.spread ?? 50, speed: o.speed ?? 1, drag: o.drag ?? 0.1, gravity: o.gravity ?? 0, size: o.size ?? 1,
    shape: o.shape ?? 'streak', stretch: o.stretch ?? 3,
  });

  /** A whole recipe; layers without their own opacity fade out over the last part. */
  function recipe(name, F, layers, palette, { size = 64, impact = 3, blend = 'add', fadeFrom, loop = false } = {}) {
    const ff = fadeFrom ?? Math.round(F * 0.45);
    return {
      format: 'sa-fx@1', name, size, frames: F, fps: 24, loop, blend, impactFrame: impact, seed: 1, palette: [...palette],
      layers: layers.map(L => (L.opacity !== undefined || loop ? L : { ...L, opacity: ks([ff, 1], [F - 1, 0, 'in']) })),
    };
  }

  const W = THEMES.whiteblue.colors;
  const SLASHES = {
    horizontal: ['가로 베기', () => recipe('가로 베기', 12, [slash(12, { aspect: 0.42 }), sparkles(12)], W)],
    rising: ['올려 베기 (대각선)', () => recipe('올려 베기 (대각선)', 12, [slash(12, { rot: -32 }), sparkles(12)], W)],
    chop: ['내려찍기', () => recipe('내려찍기', 12, [slash(12, { rot: 90, y: 0.5, aspect: 0.42 }), sparkles(12, { y: 0.5, w: 14, h: 40 })], W)],
    cross: ['십자 베기', () => recipe('십자 베기', 14, [slash(14, { rot: -35 }), slash(14, { rot: 35, start: -10, sweep: -160, delay: 3 }),
      sparkles(14, { start: 4 })], THEMES.red.colors, { impact: 5 })],
    iai: ['발도 섬광', () => recipe('발도 섬광', 12, [
      { type: 'line', x0: 0.06, y0: 0.58, x1: 0.94, y1: 0.46, head: ks([0, 0], [1, 1, 'out']), tail: 1, taper: 0.6, thick: ks([0, 3], [2, 2], [6, 1], [11, 1]) },
      { type: 'flash', shape: 'star', points: 4, inner: 0.2, y: 0.52, size: ks([0, 0], [1, 7, 'out'], [3, 2], [5, 0]), falloff: 0.4 },
    ], W, { impact: 1, fadeFrom: 4 })],
    afterimage: ['잔상 초승달', () => recipe('잔상 초승달', 12, [slash(12, { thick: 10, taper: 1.6, aspect: 0.5, rot: ks([0, -30], [11, 30]),
      echo: { copies: 3, step: 1, decay: 0.55 } })], W)],
    flurry: ['연속 베기', () => recipe('연속 베기', 14, [
      slash(14, { radius: 12, thick: 4, hit: 2, aspect: 0.45, headEnd: 1.5, x: 0.38, y: 0.6, rot: -15 }),
      slash(14, { radius: 12, thick: 4, hit: 2, aspect: 0.45, headEnd: 1.5, x: 0.6, y: 0.5, rot: 20, delay: 2 }),
      slash(14, { radius: 12, thick: 4, hit: 2, aspect: 0.45, headEnd: 1.5, x: 0.45, y: 0.42, rot: -40, delay: 4 }),
      slash(14, { radius: 13, thick: 5, hit: 2, aspect: 0.45, headEnd: 1.5, x: 0.55, y: 0.58, rot: 10, delay: 6 }),
      sparkles(14, { count: 8, start: 2, life: 7 })], W, { impact: 4, fadeFrom: 9 })],
    wind: ['바람 칼날', () => recipe('바람 칼날', 14, [
      slash(14, { rot: 90, y: 0.5, aspect: 0.6, thick: 7, radius: 20, headEnd: 1.05, echo: { copies: 2, step: 2, decay: 0.5 } }),
      sparkles(14, { outward: false, angle: 180, spread: 20, w: 10, h: 24, y: 0.5, x: 0.6, speed: 1.6, count: 8, start: 3, life: 7 }),
    ].map((L, i) => i === 0 ? { ...L, x: ks([0, 0.25], [13, 0.85, 'in']) } : L), C.wind, { impact: 4 })],
    ink: ['먹 붓 베기', () => recipe('먹 붓 베기', 14, [slash(14, { thick: 11, taper: 0.8, aspect: 0.45, shape: 'jagged' }),
      sparkles(14, { count: 14, start: 2, life: 8, w: 50, h: 20, speed: 1.2, drag: 0.08, gravity: 0.06, size: 2.5, shape: 'dot' })],
    THEMES.ink.colors, { blend: 'normal' })],
    fire: ['불꽃 베기', () => recipe('불꽃 베기', 14, [slash(14, { thick: 9, shape: 'halfmoon' }),
      sparkles(14, { count: 12, w: 50, h: 18, outward: false, angle: -90, spread: 70, speed: 0.8, gravity: -0.03, size: 2, life: 7, start: 2, shape: 'square' }),
      { type: 'smoke', y: 0.5, w: 40, count: 6, start: 4, life: 9, rise: 0.6, spread: 0.3, sizeFrom: 2, sizeTo: 4, bright: 0.5, seed: 5 }],
    THEMES.fire.colors)],
    ice: ['얼음 베기', () => recipe('얼음 베기', 12, [slash(12, { thick: 6, taper: 2, shape: 'tapered' }),
      sparkles(12, { count: 10, shape: 'diamond', size: 2, w: 50, h: 18, speed: 1, drag: 0.06, life: 6, start: 2 })], THEMES.ice.colors)],
    lightning: ['번개 베기', () => recipe('번개 베기', 12, [
      { ...slash(12, { thick: 4 }), cutoff: 0.3 },
      { type: 'lightning', x0: 0.12, y0: 0.5, x1: 0.88, y1: 0.55, detail: 4, jag: 0.55, branches: 1, flicker: 1, thick: 1, grow: ks([0, 0], [3, 1, 'out']) },
      { type: 'glow', y: 0.52, radius: 10, aspect: 0.5, power: 2, strength: ks([2, 0], [3, 0.8], [7, 0]) },
    ], THEMES.volt.colors)],
    spin: ['회전 베기', () => recipe('회전 베기', 14, [slash(14, { start: -90, sweep: 360, aspect: 0.45, radius: 24, thick: 7, tail: 0.85, hit: 5, headEnd: 1.4 }),
      sparkles(14, { count: 10, w: 48, h: 22, start: 4 })], W, { impact: 5 })],
    launcher: ['올려치기', () => recipe('올려치기', 12, [
      { ...slash(12, { rot: -90, aspect: 0.4 }), y: ks([0, 0.62], [11, 0.38, 'out']) },
      sparkles(12, { outward: false, angle: -90, spread: 30, speed: 1.4, w: 16, h: 0, y: 0.8, count: 8, start: 2 })], THEMES.gold.colors)],
  };
  const SLASH_ORDER = Object.keys(SLASHES);

  const OTHERS = {
    slash: ['기본 베기 궤적', () => recipe('베기 궤적', 12, [slash(12, { radius: 25, y: 0.55, aspect: 0.75, rot: -15, start: -160, sweep: 200, thick: 13, echo: { copies: 2, step: 1, decay: 0.5 } })],
      ['#1b3a6b', '#3f7fd1', '#9fd3ff', '#f2fbff'], { fadeFrom: 6 })],
    spark: ['타격 불꽃', () => recipe('타격 불꽃', 12, [
      { type: 'ring', radius: ks([0, 2], [6, 16, 'out'], [11, 20]), thick: 1, opacity: ks([0, 1], [5, 0.6], [9, 0]), cutoff: 0.5 },
      { type: 'sparks', count: 10, seed: 41, start: 0, life: 7, lifeVar: 0.3, speed: 2.2, speedVar: 0.4, drag: 0.12, shape: 'streak', stretch: 3 },
      { type: 'flash', shape: 'star', points: 4, inner: 0.25, rot: 45, size: ks([0, 0], [2, 10, 'out'], [5, 5, 'in'], [8, 0]), falloff: 0.6 },
    ], C.ember, { size: 48, impact: 2, fadeFrom: 7 })],
    bolt: ['번개 내려치기', () => recipe('번개 내려치기', 16, [
      { type: 'glow', y: 0.88, radius: ks([2, 0], [4, 14, 'out'], [12, 4]), aspect: 0.4, power: 1.5, strength: ks([2, 0], [4, 1], [12, 0]) },
      { type: 'lightning', x0: 0.45, y0: 0, x1: 0.52, y1: 0.88, detail: 5, jag: 0.45, branches: 3, branchLen: 0.35, seed: 7, flicker: 2,
        thick: ks([0, 1], [3, 2], [8, 2], [12, 1]), grow: ks([0, 0], [3, 1, 'out']) },
      { type: 'flash', shape: 'circle', y: 0.88, aspect: 0.45, falloff: 0.7, size: ks([2, 0], [4, 9, 'out'], [9, 4, 'in'], [13, 0]) },
    ], THEMES.volt.colors, { fadeFrom: 9 })],
    blast: ['불꽃 폭발', () => recipe('불꽃 폭발', 20, [
      { type: 'smoke', y: 0.6, w: 20, count: 9, start: 3, life: 15, rise: 0.7, spread: 0.5, sizeFrom: 4, sizeTo: 9, bright: 0.45, palette: C.smoke, seed: 2 },
      { type: 'glow', y: 0.62, radius: ks([0, 2], [4, 18, 'out'], [12, 14], [19, 0, 'in']), power: 1.2 },
      { type: 'flash', shape: 'star', points: 7, inner: 0.6, y: 0.62, size: ks([0, 2], [3, 13, 'out'], [10, 9], [16, 0, 'in']), falloff: 0.8, rot: ks([0, 0], [19, 40]) },
      { type: 'sparks', y: 0.62, count: 16, seed: 9, start: 1, life: 10, outward: true, w: 10, h: 10, speed: 1.4, gravity: 0.05, drag: 0.04, size: 2, shape: 'square' },
    ], THEMES.fire.colors, { impact: 4, blend: 'normal', fadeFrom: 12 })],
    dust: ['먼지 퍼짐', () => recipe('먼지 퍼짐', 16, [
      { type: 'smoke', y: 0.78, w: 22, count: 10, start: 0, life: 13, rise: 0.25, spread: 0.6, sizeFrom: 2, sizeTo: 6, bright: 0.85, seed: 5 },
    ], C.dust, { size: 48, impact: 0, blend: 'normal', fadeFrom: 10 })],
    heal: ['치유 빛', () => recipe('치유 빛', 20, [
      { type: 'glow', y: 0.6, radius: ks([0, 4], [6, 16, 'out'], [19, 10]), aspect: 0.6, power: 2, strength: 0.8 },
      { type: 'ring', y: 0.78, aspect: 0.35, radius: ks([0, 4], [10, 20, 'out']), thick: 1, gaps: 8, spin: ks([0, 0], [19, 90]) },
      { type: 'sparks', y: 0.75, w: 30, h: 6, count: 12, stream: 12, life: 8, outward: false, angle: -90, spread: 10, speed: 1, shape: 'plus', size: 1, seed: 4 },
    ], C.heal, { size: 48, impact: 6, fadeFrom: 13 })],
    shockwave: ['충격파', () => recipe('충격파', 14, [
      { type: 'ring', y: 0.7, aspect: 0.38, radius: ks([0, 3], [8, 28, 'out'], [13, 31]), thick: ks([0, 4], [13, 1]) },
      { type: 'ring', y: 0.7, aspect: 0.38, radius: ks([2, 2], [10, 20, 'out'], [13, 22]), thick: 1, gaps: 10, opacity: ks([2, 0], [3, 1], [12, 0]) },
      { type: 'smoke', y: 0.72, w: 34, count: 8, start: 1, life: 11, rise: 0.2, spread: 0.9, sizeFrom: 2, sizeTo: 5, bright: 0.6, palette: C.dust, seed: 8 },
    ], W, { impact: 2, fadeFrom: 7 })],
    aura: ['기운 (반복)', () => recipe('기운 (반복)', 24, [
      { type: 'ring', y: 0.8, aspect: 0.3, radius: 16, thick: 1, gaps: 6, spin: ks([0, 0], [24, 60]) },
      { type: 'sparks', y: 0.8, w: 32, h: 6, count: 16, stream: 24, life: 12, outward: false, angle: -90, spread: 8, speed: 1.1, drag: 0, shape: 'streak', stretch: 2, seed: 6 },
      { type: 'ring', y: 0.8, aspect: 0.3, radius: ks([0, 6], [23, 22]), thick: 1, opacity: ks([0, 1], [23, 0]), cutoff: 0.5 },
    ], C.aura, { impact: 0, loop: true })],
    smoke: ['연기', () => recipe('연기', 20, [
      { type: 'smoke', y: 0.75, w: 14, count: 10, start: 0, life: 18, rise: 0.9, spread: 0.35, sizeFrom: 3, sizeTo: 9, bright: 0.9, seed: 12 },
    ], C.smoke, { size: 48, impact: 0, blend: 'normal', fadeFrom: 12 })],
  };
  const OTHER_ORDER = Object.keys(OTHERS);

  /** Gallery categories (sa-fx@1 "category"), in display order. */
  const CATEGORIES = ['베기', '찌르기', '타격·둔기', '투사체', '폭발', '화염', '전기', '얼음', '독·산', '물', '바람', '땅·바위', '빛·치유',
    '어둠', '먹·책략', '상태이상', '버프·디버프', '소환·순간이동', '연기·먼지', '기타'];
  /** Category and tags of each built-in recipe (written into the recipe JSON). */
  const META = {
    'slash:horizontal': ['베기', ['검', '궤적']], 'slash:rising': ['베기', ['검', '대각선']], 'slash:chop': ['베기', ['검', '세로']],
    'slash:cross': ['베기', ['검', '십자', '연타']], 'slash:iai': ['베기', ['검', '섬광', '직선']], 'slash:afterimage': ['베기', ['잔상']],
    'slash:flurry': ['베기', ['연타']], 'slash:wind': ['베기', ['바람', '투사체']], 'slash:ink': ['베기', ['먹', '어둠']],
    'slash:fire': ['베기', ['화염']], 'slash:ice': ['베기', ['얼음']], 'slash:lightning': ['베기', ['전기']], 'slash:spin': ['베기', ['회전', '광역']],
    'slash:launcher': ['베기', ['올려치기']], slash: ['베기', ['검', '궤적']], spark: ['타격·둔기', ['타격', '불꽃']], bolt: ['전기', ['낙뢰', '하늘']],
    blast: ['폭발', ['화염', '광역']], dust: ['연기·먼지', ['먼지', '발']], heal: ['빛·치유', ['회복', '버프']], shockwave: ['땅·바위', ['충격파', '광역']],
    aura: ['버프·디버프', ['기운', '반복']], smoke: ['연기·먼지', ['연기']],
  };
  const withMeta = (key, r) => { const m = META[key]; return m ? { ...r, category: m[0], tags: [...m[1]] } : r; };
  /** Every built-in recipe: [{ key, label, get, category, tags }]; slash keys are "slash:<name>". */
  const all = () => [...SLASH_ORDER.map(k => ['slash:' + k, SLASHES[k]]), ...OTHER_ORDER.map(k => [k, OTHERS[k]])]
    .map(([key, [label, make]]) => ({ key, label, get: () => withMeta(key, make()), category: META[key]?.[0] ?? '기타', tags: META[key]?.[1] ?? [] }));
  /** Recipe by key ("slash:<name>" or another built-in), a fresh copy. */
  function byKey(key) {
    const make = key.startsWith('slash:') ? SLASHES[key.slice(6)]?.[1] : OTHERS[key]?.[1];
    return make && withMeta(key, make());
  }

  // ---------- slash controls ----------
  /** Multiply a (maybe keyframed) number. */
  function scaleNum(v, fn, lo = -Infinity, hi = Infinity) {
    const c = x => Math.max(lo, Math.min(hi, fn(x)));
    if (Array.isArray(v) && Array.isArray(v[0])) return v.map(k => [k[0], typeof k[1] === 'number' ? c(k[1]) : k[1], ...k.slice(2)]);
    return typeof v === 'number' ? c(v) : v;
  }

  /**
   * Changed copy of a recipe for rendering. s = { shape, theme, angle, curve, radius, thick, fade, sparkle };
   * every field is optional (missing = leave the recipe as it is).
   */
  function apply(r, s = {}) {
    const g = clone(r), D = SAFX.DEF.slash, F = Math.round(g.frames || 12);
    for (const L of g.layers || []) {
      if (L.type !== 'slash') continue;
      const get = k => L[k] ?? D[k];
      if (s.shape && s.shape !== 'original') L.shape = s.shape;
      if (s.curve && s.curve !== 1) L.aspect = scaleNum(get('aspect'), x => x * s.curve, 0.1, 2);
      if (s.radius && s.radius !== 1) L.radius = scaleNum(get('radius'), x => x * s.radius, 1, 120);
      if (s.thick && s.thick !== 1) L.thick = scaleNum(get('thick'), x => x * s.thick, 1, 48);
      if (s.fade && s.fade !== 1) L.tail = scaleNum(get('tail'), x => x / s.fade, 0.02, 1);
    }
    if (s.sparkle !== undefined && s.sparkle !== null) {
      const parts = (g.layers || []).filter(L => L.type === 'sparks'), total = parts.reduce((t, L) => t + (L.count ?? 10), 0);
      if (parts.length) parts.forEach(L => { L.count = Math.max(0, Math.round((L.count ?? 10) * s.sparkle / Math.max(1, total))); });
      else if (s.sparkle > 0) g.layers.push(sparkles(F, { count: s.sparkle }));
    }
    if (s.theme && THEMES[s.theme]) {
      g.palette = [...THEMES[s.theme].colors];
      for (const L of g.layers || []) if (L.palette) L.palette = [...THEMES[s.theme].colors];
    }
    if (s.angle) g.rot = (g.rot || 0) + s.angle;
    return g;
  }

  const sparkleTotal = r => (r.layers || []).filter(L => L.type === 'sparks').reduce((t, L) => t + (L.count ?? 10), 0);
  const hasSlash = r => !!r && Array.isArray(r.layers) && r.layers.some(L => L.type === 'slash');

  return { CATEGORIES, THEMES, SHAPES, SLASH_ORDER, SLASH_LABELS: Object.fromEntries(SLASH_ORDER.map(k => [k, SLASHES[k][0]])), OTHER_ORDER,
    OTHER_LABELS: Object.fromEntries(OTHER_ORDER.map(k => [k, OTHERS[k][0]])), all, byKey, apply, sparkleTotal, hasSlash };
})();
