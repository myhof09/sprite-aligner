// pxf-slash.js — slash-trail recipes (pxf.graph@1), trail-shape options and common slash controls.
//
// Recipes are ordinary pxf graphs. Shapes and controls do not touch the recipe JSON the user edits: apply() makes a
// changed copy for rendering by rewriting Arc nodes (the trail) and adding a rotation in front of Output, so they
// work on any recipe that draws its trail with Arc — including imported ones.
'use strict';
const PXF_SLASH = (() => {
  const node = (id, type, params) => ({ id, type, x: 0, y: 0, params });
  /** Keyframes with unique, increasing frame numbers (later entries win on duplicates). */
  const ks = (...keys) => {
    const m = new Map();
    for (const k of keys) m.set(Math.round(k[0]), k);
    return { k: [...m.values()].sort((a, b) => a[0] - b[0]).map(k => [Math.round(k[0]), ...k.slice(1)]) };
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
  const C = { fire: THEMES.fire.colors, wind: ['#1f4d3a', '#4fbf8f', '#c9ffe6', '#f6fffb'], volt: THEMES.volt.colors };
  const RECIPE_LABELS = { horizontal: '가로 베기', rising: '올려 베기 (대각선)', chop: '내려찍기', cross: '십자 베기', iai: '발도 섬광', afterimage: '잔상 초승달',
    flurry: '연속 베기', wind: '바람 칼날', ink: '먹 붓 베기', fire: '불꽃 베기', ice: '얼음 베기', lightning: '번개 베기', spin: '회전 베기', launcher: '올려치기' };

  /** A sweeping slash arc: the head runs along the arc by frame `hit`, then the tail thins out. */
  function arc(id, F, o = {}) {
    const d = o.delay || 0, A = Math.min(F - 2, d + (o.hit || 3)), E = F - 1, t = o.thick ?? 11;
    return node(id, 'Arc', {
      x: o.x ?? 0.5, y: o.y ?? 0.55, radius: o.radius ?? 27, start: o.start ?? -170, sweep: o.sweep ?? 160,
      aspect: o.aspect ?? 0.5, rot: o.rot ?? 0, taper: o.taper ?? 1.1, intensity: o.intensity ?? 1,
      head: ks([0, 0], [d, 0, 'out3'], [A, 1.05], [E, o.headEnd ?? 1.35]),
      tail: ks([0, 0.3], [A, o.tail ?? 0.8], [E, 0.35]),
      thick: ks([0, 1], [d, Math.max(1, t * 0.4)], [A, t, 'out'], [E, 1]),
    });
  }

  function sparkles(id, o = {}) {
    return node(id, 'Particles', {
      count: o.count ?? 8, seed: o.seed ?? 31, emit: 'burst', start: o.start ?? 0.2, life: o.life ?? 0.4, lifeVar: 0.3,
      area: o.area ?? 'ring', x: o.x ?? 0.5, y: o.y ?? 0.55, aw: o.aw ?? 40, ah: o.ah ?? 14, dirMode: o.dirMode ?? 'outward',
      angle: o.angle ?? -90, spread: o.spread ?? 360, speed: o.speed ?? 1, speedVar: 0.4, gravity: o.gravity ?? 0, drag: o.drag ?? 0.1,
      sizeA: o.sizeA ?? 1, sizeB: o.sizeB ?? 1, pshape: o.pshape ?? 'streak', stretch: o.stretch ?? 3, fade: 'out', bright: o.bright ?? 0.85,
    });
  }

  /**
   * Assemble a recipe: each layer (a node, or {nodes, links, out}) is merged with Blend max, coloured by a Palette,
   * faded to nothing by the last frame with a Tint, then Output.
   */
  function build(name, F, layers, colors, { size = 64, impact = 3, blend = 'add', fadeFrom, alpha = 'soft' } = {}) {
    const nodes = [], links = [];
    let last = null;
    layers.forEach((L, i) => {
      const part = L.nodes ? L : { nodes: [L], links: [], out: L.id };
      nodes.push(...part.nodes); links.push(...part.links);
      if (!last) { last = part.out; return; }
      const m = 'merge' + i;
      nodes.push(node(m, 'Blend', { mode: 'max' }));
      links.push({ f: last, t: m, p: 0 }, { f: part.out, t: m, p: 1 });
      last = m;
    });
    const ff = fadeFrom ?? Math.round(F * 0.45);
    nodes.push(node('color', 'Palette', { colors, cutoff: 0.12 }),
      node('fade', 'Tint', { amount: 0, opacity: ks([0, 1], [ff, 1, 'in'], [F - 1, 0]) }),
      node('out', 'Output', { alpha, threshold: alpha === 'hard' ? 0.4 : 0.1 }));
    links.push({ f: last, t: 'color', p: 0 }, { f: 'color', t: 'fade', p: 0 }, { f: 'fade', t: 'out', p: 0 });
    return { format: 'pxf.graph@1', name, settings: { size, frames: F, fps: 24, loop: false }, nodes, links,
      game: { pivot: [0.5, 0.5], logicalSize: size, blend, impactFrame: impact } };
  }

  /** Chain helper: nodes linked one after another (port 0); extra = additional links. */
  const chain = (list, extra = []) => ({ nodes: list, links: [...list.slice(1).map((n, i) => ({ f: list[i].id, t: n.id, p: 0 })), ...extra], out: list[list.length - 1].id });

  /** An arc pushed around by a noise map (rough ink edge, licking flames). */
  const roughArc = (a, displace, noise) => ({
    nodes: [a, node(a.id + '_d', 'Displace', displace), node(a.id + '_n', 'Noise', noise)],
    links: [{ f: a.id, t: a.id + '_d', p: 0 }, { f: a.id + '_n', t: a.id + '_d', p: 1 }],
    out: a.id + '_d',
  });

  /** End points of an arc (at frame 0) in normalized canvas coordinates. */
  function arcEnds(p) {
    const v = k => PXF.value(p[k], 0, 1, false);
    const cx = v('x') * 64, cy = v('y') * 64, r = v('radius'), asp = v('aspect'), rot = v('rot') * Math.PI / 180;
    return [v('start'), v('start') + v('sweep')].map(deg => {
      const a = deg * Math.PI / 180, dx = r * Math.cos(a), dy = r * Math.sin(a) * asp;
      return [(cx + dx * Math.cos(rot) - dy * Math.sin(rot)) / 64, (cy + dx * Math.sin(rot) + dy * Math.cos(rot)) / 64];
    });
  }

  const W = THEMES.whiteblue.colors;
  const RECIPES = {
    horizontal: () => build('가로 베기', 12, [arc('a', 12, { aspect: 0.42 }), sparkles('sp')], W),
    rising: () => build('올려 베기 (대각선)', 12, [arc('a', 12, { rot: -32 }), sparkles('sp')], W),
    chop: () => build('내려찍기', 12, [arc('a', 12, { rot: 90, y: 0.5, aspect: 0.42 }), sparkles('sp', { y: 0.5, aw: 14, ah: 40 })], W),
    cross: () => build('십자 베기', 14, [arc('a', 14, { rot: -35 }), arc('b', 14, { rot: 35, start: -10, sweep: -160, delay: 3 }), sparkles('sp', { start: 0.3 })],
      THEMES.red.colors, { impact: 5 }),
    iai: () => build('발도 섬광', 12, [
      chain([node('line', 'Stroke', { x0: 0.06, y0: 0.58, x1: 0.35, y1: 0.54, x2: 0.65, y2: 0.5, x3: 0.94, y3: 0.46, taper: 0.6, from: 0,
        to: ks([0, 0, 'out3'], [1, 1]), width: ks([0, 3], [2, 2], [6, 1], [11, 0]), vA: 0.7, vM: 1, vB: 0.7, intensity: ks([0, 1], [3, 1], [11, 0.2]) }),
        node('lglow', 'Glow', { radius: 1, strength: 1.2 })]),
      node('flash', 'Shape', { shape: 'star', points: 4, size2: 0.2, x: 0.5, y: 0.52, size: ks([0, 0], [1, 7, 'out'], [3, 2], [5, 0]) }),
    ], W, { impact: 1, fadeFrom: 4 }),
    afterimage: () => build('잔상 초승달', 12, [chain([arc('a', 12, { thick: 10, taper: 1.6, aspect: 0.5, rot: ks([0, -30], [11, 30]) }),
      node('echo', 'Echo', { copies: 3, step: 1, decay: 0.55 })])], THEMES.whiteblue.colors),
    flurry: () => build('연속 베기', 14, [chain([arc('a', 14, { radius: 12, thick: 4, hit: 2, aspect: 0.45, headEnd: 1.5 }),
      node('rep', 'Repeat', { count: 4, delay: 2, dx: 7, dy: -4, centered: true, angleStep: 75, rotMin: -20, rotMax: 20, seed: 7, mode: 'max' })]),
      sparkles('sp', { count: 8, start: 0.15, life: 0.5 })], W, { impact: 4 }),
    wind: () => build('바람 칼날', 14, [chain([arc('a', 14, { rot: 90, y: 0.5, aspect: 0.6, thick: 7, radius: 20, headEnd: 1.05 }),
      node('fly', 'Transform', { tx: ks([0, -16], [13, 22, 'in']) }), node('streak', 'Echo', { copies: 2, step: 2, decay: 0.5 })]),
      sparkles('sp', { dirMode: 'fixed', angle: 180, spread: 20, area: 'box', aw: 10, ah: 24, y: 0.5, speed: 1.4, count: 8, start: 0.25, life: 0.5 })],
      C.wind, { impact: 4 }),
    ink: () => build('먹 붓 베기', 14, [
      roughArc(arc('a', 14, { thick: 11, taper: 0.8, aspect: 0.45 }), { mode: 'radial', amount: 2, cx: 0.5, cy: 0.55 }, { type: 'ridged', scaleX: 10, scaleY: 10, octaves: 2, seed: 3 }),
      sparkles('splat', { count: 14, start: 0.15, life: 0.55, aw: 50, ah: 20, speed: 1.2, drag: 0.08, gravity: 0.06, sizeA: 2.5, sizeB: 1, pshape: 'circle', bright: 1 }),
    ], THEMES.ink.colors, { blend: 'normal', alpha: 'hard' }),
    fire: () => build('불꽃 베기', 14, [
      roughArc(arc('a', 14, { thick: 9 }), { mode: 'dir', angle: -90, amount: 3 }, { type: 'fbm', scaleX: 5, scaleY: 5, scrollY: -3, seed: 21 }),
      sparkles('embers', { count: 12, aw: 50, ah: 18, dirMode: 'fixed', angle: -90, spread: 70, speed: 0.8, gravity: -0.03, sizeA: 2, sizeB: 0, life: 0.5, start: 0.15, pshape: 'square' }),
    ], C.fire),
    ice: () => build('얼음 베기', 12, [arc('a', 12, { thick: 6, taper: 2 }),
      sparkles('shards', { count: 10, pshape: 'diamond', sizeA: 3, sizeB: 1, aw: 50, ah: 18, speed: 1, drag: 0.06, life: 0.5, start: 0.2, bright: 0.9 })], THEMES.ice.colors),
    lightning: () => {
      const a = arc('a', 12, { thick: 4, intensity: 0.45 }), [[x0, y0], [x1, y1]] = arcEnds(a.params);
      return build('번개 베기', 12, [a, chain([node('bolt', 'Lightning', { x0, y0: y0 - 0.12, x1, y1: y1 - 0.12, detail: 4, jag: 0.55, branch: 0.2, rate: 1, seed: 19,
        grow: ks([0, 0, 'out3'], [3, 1]), intensity: ks([0, 1], [7, 1], [11, 0]) }), node('bglow', 'Glow', { radius: 1, strength: 1.3 })])], C.volt);
    },
    spin: () => build('회전 베기', 14, [arc('a', 14, { start: -90, sweep: 360, aspect: 0.45, radius: 24, thick: 7, tail: 0.85, hit: 5, headEnd: 1.4 }),
      sparkles('sp', { count: 10, aw: 48, ah: 22, start: 0.3 })], W, { impact: 5 }),
    launcher: () => build('올려치기', 12, [chain([arc('a', 12, { rot: -90, y: 0.5, aspect: 0.4 }), node('rise', 'Transform', { ty: ks([0, 8], [11, -8, 'out']) })]),
      sparkles('sp', { dirMode: 'fixed', angle: -90, spread: 30, speed: 1.4, area: 'line', aw: 16, ah: 0, y: 0.8, count: 8, start: 0.15 })], THEMES.gold.colors),
  };
  const RECIPE_ORDER = ['horizontal', 'rising', 'chop', 'cross', 'iai', 'afterimage', 'flurry', 'wind', 'ink', 'fire', 'ice', 'lightning', 'spin', 'launcher'];

  // ---------- trail shapes: rewrite every Arc node ----------
  const SHAPES = {
    original: '원래 모양', crescent: '가는 초승달', halfmoon: '두꺼운 반달', tapered: '점점 가늘게', comet: '혜성 (밝은 머리)',
    ribbon: '물결 띠', segmented: '끊어진 호', jagged: '톱니 가장자리', double: '두 줄', spiral: '나선', zigzag: '지그재그', ring: '완전한 원',
  };

  /** Multiply a (maybe animated) number param. */
  function scaleParam(v, f, lo = -Infinity, hi = Infinity) {
    const c = x => Math.max(lo, Math.min(hi, f(x)));
    if (typeof v === 'number') return c(v);
    if (v && Array.isArray(v.k)) return { k: v.k.map(k => [k[0], c(k[1]), ...k.slice(2)]) };
    if (v && 'a' in v) return { ...v, a: c(v.a), b: c(v.b) };
    return v;
  }

  /** Replace Arc node `a` (in g) by a sub-graph for `shape`; returns the id that now feeds a's old targets. */
  function reshape(g, a, shape, F) {
    const p = a.params, id = a.id, add = (n, ...ls) => { g.nodes.push(n); g.links.push(...ls); return n.id; };
    const get = k => p[k] ?? PXF_DEFS.Arc.d[k];
    switch (shape) {
      case 'crescent': p.thick = scaleParam(get('thick'), x => x * 0.5, 1, 48); p.taper = 1.8; return id;
      case 'halfmoon': p.thick = scaleParam(get('thick'), x => x * 1.8, 1, 48); p.taper = 0.3; p.tail = scaleParam(get('tail'), x => x * 1.25, 0.01, 1); return id;
      case 'tapered': p.thick = scaleParam(get('thick'), x => x * 1.3, 1, 48); p.taper = 3.5; return id;
      case 'ring': p.sweep = Math.sign(PXF.value(get('sweep'), 0, F, false) || 1) * 360; p.tail = 1; return id;
      case 'comet': {
        p.taper = 2.6; p.tail = scaleParam(get('tail'), x => x * 1.2, 0.01, 1);
        // a bright disc riding on the arc head, frame by frame
        const keysX = [], keysY = [], keysS = [];
        for (let f = 0; f < F; f++) {
          const v = k => PXF.value(get(k), f, F, false), h = v('head');
          const deg = (v('start') + v('sweep') * Math.min(1, h)) * Math.PI / 180, rot = v('rot') * Math.PI / 180;
          const dx = v('radius') * Math.cos(deg), dy = v('radius') * Math.sin(deg) * v('aspect');
          keysX.push([f, Math.max(0, Math.min(1, v('x') + (dx * Math.cos(rot) - dy * Math.sin(rot)) / 64))]);
          keysY.push([f, Math.max(0, Math.min(1, v('y') + (dx * Math.sin(rot) + dy * Math.cos(rot)) / 64))]);
          keysS.push([f, h > 0.02 && h < 1.2 ? Math.max(1, v('thick') * 0.45) : 0]);
        }
        const head = add(node(id + '_head', 'Shape', { shape: 'circle', x: { k: keysX }, y: { k: keysY }, size: { k: keysS } }));
        return add(node(id + '_comet', 'Blend', { mode: 'max' }), { f: id, t: id + '_comet', p: 0 }, { f: head, t: id + '_comet', p: 1 });
      }
      case 'ribbon': {
        add(node(id + '_wave', 'Noise', { type: 'fbm', scaleX: 8, scaleY: 2, octaves: 1, seed: 4, scrollX: 2 }));
        return add(node(id + '_rib', 'Displace', { mode: 'radial', amount: 3, cx: PXF.value(get('x'), 0, F, false), cy: PXF.value(get('y'), 0, F, false) }),
          { f: id, t: id + '_rib', p: 0 }, { f: id + '_wave', t: id + '_rib', p: 1 });
      }
      case 'jagged': {
        add(node(id + '_teeth', 'Noise', { type: 'cells', scaleX: 12, scaleY: 12, octaves: 1, seed: 9, contrast: 2.5 }));
        return add(node(id + '_jag', 'Displace', { mode: 'radial', amount: 5, cx: PXF.value(get('x'), 0, F, false), cy: PXF.value(get('y'), 0, F, false) }),
          { f: id, t: id + '_jag', p: 0 }, { f: id + '_teeth', t: id + '_jag', p: 1 });
      }
      case 'segmented': {
        // cut gaps with 10 spokes around the arc centre
        const cx = PXF.value(get('x'), 0, F, false), cy = PXF.value(get('y'), 0, F, false), r = PXF.value(get('radius'), 0, F, false) / 64;
        add(node(id + '_spoke', 'Stroke', { x0: cx, y0: cy, x1: cx + r * 0.5, y1: cy, x2: cx + r, y2: cy, x3: cx + r * 1.5, y3: cy, width: 3, taper: 0, vA: 1, vM: 1, vB: 1 }));
        add(node(id + '_spokes', 'Repeat', { count: 10, angleStep: 36, px: cx, py: cy, mode: 'max' }), { f: id + '_spoke', t: id + '_spokes', p: 0 });
        return add(node(id + '_cut', 'Mask', { mode: 'cutout' }), { f: id, t: id + '_cut', p: 0 }, { f: id + '_spokes', t: id + '_cut', p: 1 });
      }
      case 'double': {
        p.thick = scaleParam(get('thick'), x => x * 0.3, 1, 48);
        const twin = node(id + '_twin', 'Arc', { ...JSON.parse(JSON.stringify(p)), radius: Math.max(1, PXF.value(get('radius'), 0, F, false) - 7) });
        add(twin);
        return add(node(id + '_dbl', 'Blend', { mode: 'max' }), { f: id, t: id + '_dbl', p: 0 }, { f: twin.id, t: id + '_dbl', p: 1 });
      }
      case 'spiral': {
        const cx = PXF.value(get('x'), 0, F, false), cy = PXF.value(get('y'), 0, F, false);
        return add(node(id + '_spiral', 'Repeat', { count: 3, angleStep: 100, scaleStep: 0.25, fadeStep: 0.3, delay: 1, px: cx, py: cy, mode: 'max' }), { f: id, t: id + '_spiral', p: 0 });
      }
      case 'zigzag': {
        const [[x0, y0], [x1, y1]] = arcEnds(Object.fromEntries(Object.keys(PXF_DEFS.Arc.d).map(k => [k, get(k)])));
        a.type = 'Lightning';
        a.params = { x0: Math.max(0, Math.min(1, x0)), y0: Math.max(0, Math.min(1, y0)), x1: Math.max(0, Math.min(1, x1)), y1: Math.max(0, Math.min(1, y1)),
          detail: 3, jag: 0.9, branch: 0, rate: 0, seed: 5, thick: Math.max(1, Math.round(PXF.value(get('thick'), 3, F, false) / 3)),
          grow: scaleParam(get('head'), x => x, 0, 1), intensity: get('intensity') };
        return id;
      }
      default: return id;
    }
  }

  /**
   * Changed copy of a recipe for rendering. s = { shape, angle, curve, radius, thick, fade, sparkle, theme };
   * every field is optional (missing = leave the recipe as it is).
   */
  function apply(recipe, s = {}) {
    const g = JSON.parse(JSON.stringify(recipe)), F = Math.round(g.settings?.frames || 16);
    const arcs = g.nodes.filter(n => n.type === 'Arc');
    for (const a of arcs) {
      const p = a.params = a.params || {}, get = k => p[k] ?? PXF_DEFS.Arc.d[k];
      if (s.curve && s.curve !== 1) p.aspect = scaleParam(get('aspect'), x => x * s.curve, 0.1, 2);
      if (s.radius && s.radius !== 1) p.radius = scaleParam(get('radius'), x => x * s.radius, 1, 96);
      if (s.thick && s.thick !== 1) p.thick = scaleParam(get('thick'), x => x * s.thick, 1, 48);
      if (s.fade && s.fade !== 1) p.tail = scaleParam(get('tail'), x => x / s.fade, 0.01, 1);
    }
    if (s.thick && s.thick !== 1) for (const n of g.nodes) if (n.type === 'Stroke') n.params.width = scaleParam(n.params.width ?? 2, x => x * s.thick, 0, 16);
    if (s.fade && s.fade !== 1) for (const n of g.nodes) if (n.type === 'Echo') n.params.decay = Math.max(0, Math.min(1, (n.params.decay ?? 0.6) ** s.fade));
    if (s.shape && s.shape !== 'original') {
      for (const a of arcs) {
        const outs = g.links.filter(l => l.f === a.id);
        const newOut = reshape(g, a, s.shape, F);
        for (const l of outs) l.f = newOut;
      }
    }
    // sparkle count: scale every Particles node to the wanted total, or add a sparkle layer if there is none
    if (s.sparkle !== undefined && s.sparkle !== null) {
      const parts = g.nodes.filter(n => n.type === 'Particles'), total = parts.reduce((t, n) => t + (n.params.count ?? 30), 0);
      if (parts.length) parts.forEach(n => { n.params.count = Math.max(1, Math.round((n.params.count ?? 30) * s.sparkle / Math.max(1, total))); if (!s.sparkle) n.params.bright = 0; });
      else if (s.sparkle > 0) {
        const pal = g.nodes.find(n => n.type === 'Palette'), into = pal && g.links.find(l => l.t === pal.id && (l.p || 0) === 0);
        if (into) {
          g.nodes.push(sparkles('slash_sparkle', { count: s.sparkle }), node('slash_sparkle_mix', 'Blend', { mode: 'max' }));
          g.links.push({ f: into.f, t: 'slash_sparkle_mix', p: 0 }, { f: 'slash_sparkle', t: 'slash_sparkle_mix', p: 1 });
          into.f = 'slash_sparkle_mix';
        }
      }
    }
    if (s.theme && THEMES[s.theme]) for (const n of g.nodes) if (n.type === 'Palette') n.params.colors = [...THEMES[s.theme].colors];
    // angle: rotate the finished image in front of Output
    if (s.angle) {
      const out = g.nodes.find(n => n.type === 'Output'), into = out && g.links.find(l => l.t === out.id);
      if (into) { g.nodes.push(node('slash_turn', 'Transform', { rot: s.angle })); g.links.push({ f: into.f, t: 'slash_turn', p: 0 }); into.f = 'slash_turn'; }
    }
    return g;
  }

  const sparkleTotal = recipe => recipe.nodes.filter(n => n.type === 'Particles').reduce((t, n) => t + (n.params?.count ?? 30), 0);
  const hasArc = recipe => recipe.nodes.some(n => n.type === 'Arc');

  return { THEMES, SHAPES, RECIPES, RECIPE_ORDER, RECIPE_LABELS, apply, sparkleTotal, hasArc, recipe: k => RECIPES[k]() };
})();
