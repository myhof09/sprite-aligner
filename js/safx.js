// safx.js — renderer for "sa-fx@1" effect recipes (docs/fx-format.md), fully in the browser.
//
// A recipe is a list of layers on a square canvas. Each layer draws a brightness map (0..1) for a frame; the brightness
// picks a colour band of the layer's palette (dark → bright) and the layer is drawn over the layers before it. No
// half-transparent pixels: values below `cutoff` are not drawn and opacity < 1 is an ordered dither. Every number may be
// a keyframe list [[frame, value, easing?], …]. Everything is deterministic (seeded).
'use strict';
const SAFX = (() => {
  const clamp = (v, a = 0, b = 1) => v < a ? a : v > b ? b : v;
  const EASE = {
    linear: t => t, in: t => t * t, out: t => 1 - (1 - t) ** 2, inout: t => t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) ** 2,
    step: t => (t < 1 ? 0 : 1),
  };
  const RAD = Math.PI / 180;

  // layer defaults (docs/fx-format.md); COMMON applies to every layer
  const COMMON = { x: 0.5, y: 0.5, opacity: 1, cutoff: 0.12, seed: 0 };
  const DEF = {
    slash: { radius: 24, aspect: 0.5, start: -160, sweep: 160, rot: 0, head: 1, tail: 0.7, thick: 8, taper: 1, shape: 'crescent' },
    line: { x0: 0.1, y0: 0.5, x1: 0.9, y1: 0.5, head: 1, tail: 1, thick: 2, taper: 1, count: 1, spacing: 4, jitter: 0 },
    ring: { radius: 12, thick: 2, aspect: 1, gaps: 0, spin: 0 },
    sparks: { count: 10, w: 0, h: 0, start: 0, stream: 0, life: 6, lifeVar: 0.3, angle: -90, spread: 360, outward: false, speed: 1.5,
      speedVar: 0.4, gravity: 0, drag: 0.05, size: 1, shape: 'dot', stretch: 3, fade: true },
    lightning: { x0: 0.5, y0: 0, x1: 0.5, y1: 0.9, jag: 0.4, detail: 5, branches: 2, branchLen: 0.35, thick: 1, grow: 1, flicker: 2 },
    glow: { radius: 12, aspect: 1, power: 1.5, strength: 1 },
    flash: { shape: 'star', size: 8, points: 4, inner: 0.35, rot: 0, aspect: 1, falloff: 0.5, outline: 0 },
    smoke: { count: 8, w: 16, start: 0, life: 10, rise: 0.5, spread: 1, sizeFrom: 3, sizeTo: 8, bright: 0.8 },
    image: { src: '', frameWidth: 0, scale: 1 },
  };
  // pixel-unit fields, multiplied by the size option so a recipe pixel stays a sprite pixel
  const PX = {
    slash: ['radius', 'thick'], line: ['thick', 'spacing', 'jitter'], ring: ['radius', 'thick'],
    sparks: ['w', 'h', 'speed', 'gravity', 'size'], lightning: ['thick'], glow: ['radius'], flash: ['size', 'outline'],
    smoke: ['w', 'rise', 'spread', 'sizeFrom', 'sizeTo'], image: [],
  };
  const DEFAULT_PALETTE = ['#1b2a6b', '#3f7fd1', '#a9dcff', '#f4fbff'];

  const isKeys = v => Array.isArray(v) && v.length > 0 && Array.isArray(v[0]);
  /** Value of a (maybe keyframed) field at frame f. */
  function value(v, f) {
    if (!isKeys(v)) return v;
    const ks = v.filter(k => Array.isArray(k) && k.length >= 2).slice().sort((a, b) => a[0] - b[0]);
    if (!ks.length) return 0;
    if (f <= ks[0][0]) return ks[0][1];
    for (let i = 1; i < ks.length; i++) {
      const [f1, v1, e] = ks[i];
      if (f <= f1) {
        const [f0, v0] = ks[i - 1];
        if (typeof v0 !== 'number' || typeof v1 !== 'number') return f < f1 ? v0 : v1;
        const t = f1 === f0 ? 1 : (f - f0) / (f1 - f0);
        return v0 + (v1 - v0) * (EASE[e] || EASE.linear)(t);
      }
    }
    return ks[ks.length - 1][1];
  }

  function rng(seed) {
    let s = (seed >>> 0) + 0x6d2b79f5;
    return () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map(v => (v + 0.5) / 16);
  const bayer = (x, y) => BAYER[(y & 3) * 4 + (x & 3)];

  const hexRgb = h => { const s = String(h).replace('#', ''); const f = s.length === 3 ? s.split('').map(c => c + c).join('') : s.padEnd(6, '0'); return [0, 2, 4].map(i => parseInt(f.slice(i, i + 2), 16) || 0); };
  /** Hue turn (YIQ), brightness kept. */
  function hueTurn([r, g, b], deg) {
    if (!deg) return [r, g, b];
    const y = 0.299 * r + 0.587 * g + 0.114 * b, i = 0.596 * r - 0.274 * g - 0.322 * b, q = 0.211 * r - 0.523 * g + 0.312 * b;
    const c = Math.cos(deg * RAD), s = Math.sin(deg * RAD), i2 = i * c - q * s, q2 = i * s + q * c;
    return [y + 0.956 * i2 + 0.621 * q2, y - 0.272 * i2 - 0.647 * q2, y - 1.106 * i2 + 1.703 * q2].map(v => Math.round(clamp(v, 0, 255)));
  }

  // ---------- brightness-map drawing ----------
  function brush(N) {
    const b = new Float32Array(N * N);
    const put = (x, y, v) => { if (x < 0 || y < 0 || x >= N || y >= N) return; const i = y * N + x; if (v > b[i]) b[i] = v; };
    /** Filled disc, brighter in the middle (core = how much the edge darkens). */
    const disc = (cx, cy, r, v, core = 0.5) => {
      if (r < 0.75) return put(Math.floor(cx), Math.floor(cy), v);
      for (let y = Math.floor(cy - r); y <= cy + r; y++) for (let x = Math.floor(cx - r); x <= cx + r; x++) {
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
        if (d <= r) put(x, y, v * (1 - core * d / r));
      }
    };
    /** Line from a to b with radius / value going r0 → r1, v0 → v1. */
    const seg = (x0, y0, x1, y1, r0, r1, v0, v1 = v0, core = 0.5) => {
      const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 2));
      for (let i = 0; i <= n; i++) { const t = i / n; disc(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, r0 + (r1 - r0) * t, v0 + (v1 - v0) * t, core); }
    };
    return { b, put, disc, seg };
  }

  /** Trail profile of a slash shape: thickness factor, sideways offset (× thick), skip. u = 0 tail … 1 head. */
  function profile(shape, u, taper) {
    const moon = Math.sin(Math.PI * clamp(u)) ** taper;
    switch (shape) {
      case 'halfmoon': return { w: 0.55 + 0.45 * moon };
      case 'tapered': return { w: u ** taper };
      case 'comet': return { w: u ** (2 * taper) };
      case 'ribbon': return { w: 0.5 * (0.4 + 0.6 * u), off: Math.sin(u * Math.PI * 4) * 0.5 };
      case 'segmented': return { w: moon, skip: Math.floor(u * 7) % 2 === 1 };
      case 'jagged': return { w: moon, off: (Math.floor(u * 24) % 2 ? 1 : -1) * 0.25 };
      case 'zigzag': { const t = (u * 8) % 2; return { w: 0.3, off: (t < 1 ? t : 2 - t) - 0.5 }; }
      default: return { w: moon };   // crescent, ring, spiral, double (double draws two)
    }
  }

  const LAYERS = {
    slash(P, B, N) {
      const cx = P.x * N, cy = P.y * N, shape = P.shape, ring = shape === 'ring';
      const sweep = ring ? 360 * Math.sign(P.sweep || 1) : P.sweep, tail = Math.max(0.01, P.tail), h = P.head;
      const t0 = Math.max(0, h - tail), t1 = Math.min(1, h);
      if (t1 <= t0) return;
      const len = Math.abs(sweep * RAD) * P.radius * (t1 - t0), n = Math.max(8, Math.ceil(len * 2));
      const rc = Math.cos(P.rot * RAD), rs = Math.sin(P.rot * RAD);
      for (let i = 0; i <= n; i++) {
        const t = t0 + (t1 - t0) * i / n, u = (t - (h - tail)) / tail, pr = profile(shape, u, P.taper);
        if (pr.skip) continue;
        const a = (P.start + sweep * t) * RAD, R = P.radius * (shape === 'spiral' ? 0.55 + 0.45 * t : 1);
        let dx = Math.cos(a), dy = Math.sin(a) * P.aspect;
        const nl = Math.hypot(dx, dy) || 1, nx = dx / nl, ny = dy / nl;   // outward normal (approx.)
        const w = Math.max(1, P.thick * pr.w), v = 0.35 + 0.65 * clamp(u);
        const at = off => { const px = dx * R + nx * off, py = dy * R + ny * off; return [cx + px * rc - py * rs, cy + px * rs + py * rc]; };
        if (shape === 'double') {
          for (const s of [-1, 1]) { const [x, y] = at(s * P.thick * 0.35); B.disc(x, y, Math.max(0.5, P.thick * 0.15 * pr.w), v); }
        } else {
          const [x, y] = at((pr.off || 0) * P.thick);
          B.disc(x, y, w / 2, v);
        }
      }
      if (shape === 'comet' && h <= 1.05) {
        const a = (P.start + sweep * Math.min(1, h)) * RAD, dx = Math.cos(a) * P.radius, dy = Math.sin(a) * P.radius * P.aspect;
        B.disc(cx + dx * rc - dy * rs, cy + dx * rs + dy * rc, Math.max(1, P.thick * 0.5), 1);
      }
    },

    line(P, B, N, f, _R, seed) {
      const R = rng(seed * 53 + 1), x0 = P.x0 * N, y0 = P.y0 * N, x1 = P.x1 * N, y1 = P.y1 * N, L = Math.hypot(x1 - x0, y1 - y0) || 1;
      const nx = -(y1 - y0) / L, ny = (x1 - x0) / L, tail = Math.max(0.01, P.tail), h = P.head;
      for (let k = 0; k < Math.max(1, Math.round(P.count)); k++) {
        const j = P.jitter ? (R() - 0.5) * 2 * P.jitter : 0, off = (k - (P.count - 1) / 2) * P.spacing + j * 0.5;
        const hk = h - (P.jitter ? R() * P.jitter / L : 0), t0 = Math.max(0, hk - tail), t1 = Math.min(1, hk);
        if (t1 <= t0) continue;
        const n = Math.max(2, Math.ceil(L * (t1 - t0) * 2));
        for (let i = 0; i <= n; i++) {
          const t = t0 + (t1 - t0) * i / n, u = clamp((t - (hk - tail)) / tail);
          B.disc(x0 + (x1 - x0) * t + nx * off, y0 + (y1 - y0) * t + ny * off, Math.max(0.5, P.thick * u ** P.taper / 2), 0.35 + 0.65 * u);
        }
      }
    },

    ring(P, B, N) {
      const cx = P.x * N, cy = P.y * N, n = Math.max(24, Math.ceil(P.radius * 2 * Math.PI * 2)), g = Math.round(P.gaps);
      for (let i = 0; i < n; i++) {
        const deg = i / n * 360;
        if (g > 0 && Math.floor((((deg + P.spin) % 360 + 360) % 360) / (360 / g) * 2) % 2) continue;
        B.disc(cx + Math.cos(deg * RAD) * P.radius, cy + Math.sin(deg * RAD) * P.radius * P.aspect, Math.max(0.5, P.thick / 2), 1, 0.3);
      }
    },

    sparks(P, B, N, f, R, seed) {
      const cx = P.x * N, cy = P.y * N;
      for (let i = 0; i < Math.round(P.count); i++) {
        const r = rng(seed * 977 + i * 131 + 7);
        const birth = P.start + (P.stream ? r() * P.stream : 0), life = Math.max(1, P.life * (1 + (r() * 2 - 1) * P.lifeVar));
        let x = cx + (r() - 0.5) * P.w, y = cy + (r() - 0.5) * P.h;
        const base = P.outward && (x !== cx || y !== cy) ? Math.atan2(y - cy, x - cx) / RAD : P.outward ? r() * 360 : P.angle;
        const ang = (base + (r() - 0.5) * P.spread) * RAD, sp = P.speed * (1 + (r() * 2 - 1) * P.speedVar);
        let vx = Math.cos(ang) * sp, vy = Math.sin(ang) * sp;
        const age = f - birth;
        if (age < 0 || age > life) continue;
        for (let s = 0; s < Math.floor(age); s++) { x += vx; y += vy; vy += P.gravity; vx *= 1 - P.drag; vy *= 1 - P.drag; }
        const v = P.fade ? 1 - 0.8 * age / life : 1, sz = P.size;
        switch (P.shape) {
          case 'streak': B.seg(x - vx * P.stretch, y - vy * P.stretch, x, y, Math.max(0.5, sz * 0.3), Math.max(0.5, sz / 2), v * 0.45, v); break;
          case 'square': for (let yy = 0; yy < Math.max(1, Math.round(sz)); yy++) for (let xx = 0; xx < Math.max(1, Math.round(sz)); xx++) B.put(Math.floor(x - sz / 2) + xx, Math.floor(y - sz / 2) + yy, v); break;
          case 'plus': B.put(Math.floor(x), Math.floor(y), v); for (let k = 1; k <= Math.max(1, Math.round(sz)); k++) for (const [ddx, ddy] of [[k, 0], [-k, 0], [0, k], [0, -k]]) B.put(Math.floor(x) + ddx, Math.floor(y) + ddy, v * 0.75); break;
          case 'diamond': { const s2 = Math.max(1, Math.round(sz)); for (let yy = -s2; yy <= s2; yy++) for (let xx = -s2; xx <= s2; xx++) if (Math.abs(xx) + Math.abs(yy) <= s2) B.put(Math.floor(x) + xx, Math.floor(y) + yy, v * (1 - 0.4 * (Math.abs(xx) + Math.abs(yy)) / s2)); break; }
          default: B.disc(x, y, sz / 2, v);
        }
      }
    },

    lightning(P, B, N, f, _R, seed) {
      const r = rng(seed * 31 + (P.flicker > 0 ? Math.floor(f / P.flicker) : 0) * 7919 + 3);
      const bolt = (ax, ay, bx, by, levels, jag) => {
        let pts = [[ax, ay], [bx, by]];
        for (let l = 0; l < levels; l++) {
          const nx = [];
          for (let i = 0; i < pts.length - 1; i++) {
            const [x0, y0] = pts[i], [x1, y1] = pts[i + 1], L = Math.hypot(x1 - x0, y1 - y0) || 1, d = (r() - 0.5) * jag * L;
            nx.push(pts[i], [(x0 + x1) / 2 - (y1 - y0) / L * d, (y0 + y1) / 2 + (x1 - x0) / L * d]);
          }
          nx.push(pts[pts.length - 1]);
          pts = nx;
        }
        return pts;
      };
      const draw = (pts, grow, rad, v) => {
        const lens = [0];
        for (let i = 1; i < pts.length; i++) lens.push(lens[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
        const stop = lens[lens.length - 1] * clamp(grow);
        for (let i = 1; i < pts.length && lens[i - 1] < stop; i++) {
          const [x0, y0] = pts[i - 1], [x1, y1] = pts[i], t = Math.min(1, (stop - lens[i - 1]) / Math.max(1e-6, lens[i] - lens[i - 1]));
          B.seg(x0, y0, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, rad, rad, v, v, 0.2);
        }
        return { lens, stop };
      };
      const main = bolt(P.x0 * N, P.y0 * N, P.x1 * N, P.y1 * N, Math.round(P.detail), P.jag);
      const { lens, stop } = draw(main, P.grow, Math.max(0.5, P.thick / 2), 1);
      const total = lens[lens.length - 1];
      for (let k = 0; k < Math.round(P.branches); k++) {
        const i = 1 + Math.floor(r() * (main.length - 2)), side = r() < 0.5 ? -1 : 1, turn = (20 + r() * 30) * side * RAD;
        if (i >= main.length - 1) continue;
        const [x0, y0] = main[i], [x1, y1] = main[i + 1], a = Math.atan2(y1 - y0, x1 - x0) + turn, bl = total * P.branchLen * (0.6 + 0.4 * r());
        if (lens[i] > stop) continue;
        draw(bolt(x0, y0, x0 + Math.cos(a) * bl, y0 + Math.sin(a) * bl, Math.max(1, Math.round(P.detail) - 2), P.jag), clamp((stop - lens[i]) / Math.max(1, bl)), Math.max(0.5, P.thick / 2 - 0.5), 0.75);
      }
    },

    glow(P, B, N) {
      const cx = P.x * N, cy = P.y * N, r = Math.max(0.5, P.radius);
      for (let y = Math.floor(cy - r * P.aspect - 1); y <= cy + r * P.aspect + 1; y++) for (let x = Math.floor(cx - r - 1); x <= cx + r + 1; x++) {
        const d = Math.hypot(x + 0.5 - cx, (y + 0.5 - cy) / (P.aspect || 1)) / r;
        if (d < 1) B.put(x, y, P.strength * (1 - d) ** P.power);
      }
    },

    flash(P, B, N) {
      const cx = P.x * N, cy = P.y * N, s = Math.max(0.5, P.size), rc = Math.cos(-P.rot * RAD), rs = Math.sin(-P.rot * RAD);
      const reach = s * Math.max(1, 1 / (P.aspect || 1)) + 1, pts = Math.max(2, Math.round(P.points));
      for (let y = Math.floor(cy - reach); y <= cy + reach; y++) for (let x = Math.floor(cx - reach); x <= cx + reach; x++) {
        const ox = x + 0.5 - cx, oy = y + 0.5 - cy, dx = ox * rc - oy * rs, dy = (ox * rs + oy * rc) / (P.aspect || 1);
        let d;
        switch (P.shape) {
          case 'circle': d = Math.hypot(dx, dy) / s; break;
          case 'square': d = Math.max(Math.abs(dx), Math.abs(dy)) / s; break;
          case 'diamond': d = (Math.abs(dx) + Math.abs(dy)) / s; break;
          case 'cross': d = Math.min(Math.abs(dx) <= s * 0.25 ? Math.abs(dy) / s : 9, Math.abs(dy) <= s * 0.25 ? Math.abs(dx) / s : 9); break;
          default: {   // star: the edge goes from the tip (s) to the notch (s × inner) between points
            const seg = 2 * Math.PI / pts, loc = (((Math.atan2(dy, dx) + Math.PI * 2.5) % seg) / seg);
            d = Math.hypot(dx, dy) / (s * (P.inner + (1 - P.inner) * Math.abs(2 * loc - 1)));
          }
        }
        if (d > 1 || (P.outline > 0 && d < 1 - P.outline / s)) continue;
        B.put(x, y, 1 - P.falloff * d);
      }
    },

    smoke(P, B, N, f, _R, seed) {
      const cx = P.x * N, cy = P.y * N;
      for (let i = 0; i < Math.round(P.count); i++) {
        const r = rng(seed * 613 + i * 97 + 11);
        const birth = P.start + r() * P.life * 0.3, life = Math.max(1, P.life * (0.8 + 0.4 * r())), age = f - birth;
        const ox = (r() - 0.5) * P.w, dir = ox === 0 ? (r() < 0.5 ? -1 : 1) : Math.sign(ox), rise = P.rise * (0.7 + 0.6 * r()), sp = P.spread * (0.5 + r());
        if (age < 0 || age > life) continue;
        const t = age / life, e = 1 - (1 - t) ** 2;
        B.disc(cx + ox + dir * sp * age, cy - rise * age, P.sizeFrom + (P.sizeTo - P.sizeFrom) * e, P.bright * (1 - 0.85 * t), 0.6);
      }
    },
  };

  // ---------- images (async load, then drawn from the cache) ----------
  const IMG = new Map();
  function preload(recipe) {
    const srcs = (recipe?.layers || []).filter(l => l && l.type === 'image' && l.src).map(l => l.src);
    return Promise.all(srcs.map(src => {
      if (IMG.has(src)) return IMG.get(src).ready;
      const img = new Image(), rec = { img, ok: false };
      rec.ready = new Promise(res => { img.onload = () => { rec.ok = true; res(); }; img.onerror = () => res(); });
      img.src = src;
      IMG.set(src, rec);
      return rec.ready;
    }));
  }

  /** Check a recipe; returns a list of problems (empty = fine). */
  function validate(r) {
    if (r && r.format === 'pxf.graph@1') return ['pxf.graph@1 레시피는 더 이상 지원하지 않습니다. sa-fx@1 형식으로 다시 만들어 주세요 (docs/fx-format.md)'];
    const errs = [];
    if (!r || r.format !== 'sa-fx@1') errs.push('format이 "sa-fx@1"이 아닙니다');
    if (!r || !Array.isArray(r.layers)) errs.push('layers 배열이 필요합니다');
    return errs;
  }
  const unsupported = r => !!r && r.format === 'pxf.graph@1';

  /**
   * Render a recipe. opts: { scale (size multiplier), hue (degrees), speed (playback multiplier) }.
   * Returns { frames: [canvas], durations: [ms], N, fps, F, loop, game: { blend, impactFrame }, warnings }.
   */
  function render(r, opts = {}) {
    const errs = validate(r);
    if (errs.length) throw new Error(errs.join(' · '));
    const k = opts.scale || 1, speed = opts.speed || 1, hue = opts.hue || 0;
    const N = Math.max(8, Math.min(512, Math.round((r.size || 64) * k))), F = Math.max(1, Math.min(64, Math.round(r.frames || 12)));
    const seed0 = Math.round(r.seed ?? 1), warnings = new Set();
    const basePal = Array.isArray(r.palette) && r.palette.length ? r.palette : DEFAULT_PALETTE;

    /** The layer's fields at frame f (defaults filled in, keyframes resolved, pixel fields scaled). */
    const fields = (L, f) => {
      const D = DEF[L.type], P = {};
      for (const key of new Set([...Object.keys(COMMON), ...Object.keys(D)])) {
        let v = value(key in L ? L[key] : key in D ? D[key] : COMMON[key], f);
        if (typeof v === 'number' && PX[L.type].includes(key)) v *= k;
        P[key] = v;
      }
      return P;
    };

    const layerFrame = (L, li, f) => {
      const B = brush(N), seed = seed0 * 101 + (L.seed || 0) * 17 + li * 7 + 1;
      const once = (ff, mul) => {
        if (ff < 0) { if (!r.loop) return; ff = ((ff % F) + F) % F; }
        const P = fields(L, ff), B2 = brush(N);
        LAYERS[L.type](P, B2, N, ff, rng(seed + ff * 1009), seed);
        for (let i = 0; i < B.b.length; i++) if (B2.b[i] * mul > B.b[i]) B.b[i] = B2.b[i] * mul;
      };
      once(f, 1);
      const E = L.echo;
      if (E && E.copies > 0) for (let c = 1; c <= Math.round(E.copies); c++) once(f - c * Math.max(1, Math.round(E.step || 1)), (E.decay ?? 0.5) ** c);
      return B.b;
    };

    const frames = [];
    for (let f = 0; f < F; f++) {
      const c = document.createElement('canvas');
      c.width = c.height = N;
      const g = c.getContext('2d'), img = g.createImageData(N, N), D = img.data;
      (r.layers || []).forEach((L, li) => {
        if (!L || typeof L !== 'object') return;
        if (!DEF[L.type]) { warnings.add(`알 수 없는 레이어: ${L.type}`); return; }
        if (f < (L.from ?? 0) || f > (L.to ?? F - 1)) return;
        const op = clamp(value(L.opacity ?? 1, f));
        if (op <= 0) return;
        if (L.type === 'image') return drawImage(L, f, op, D);
        const cut = value(L.cutoff ?? COMMON.cutoff, f);
        const pal = (L.color ? [L.color] : Array.isArray(L.palette) && L.palette.length ? L.palette : basePal).map(h => hueTurn(hexRgb(h), hue));
        const b = layerFrame(L, li, f);
        for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
          const v = b[y * N + x];
          if (v < cut || (op < 1 && bayer(x, y) >= op)) continue;
          const col = pal[Math.min(pal.length - 1, Math.floor((Math.min(v, 1) - cut) / Math.max(1e-6, 1 - cut) * pal.length))], i = (y * N + x) * 4;
          D[i] = col[0]; D[i + 1] = col[1]; D[i + 2] = col[2]; D[i + 3] = 255;
        }
      });
      g.putImageData(img, 0, 0);
      frames.push(r.rot ? turn(c, r.rot) : c);
    }

    function drawImage(L, f, op, D) {
      const rec = IMG.get(L.src);
      if (!rec || !rec.ok) { warnings.add(rec ? '그림을 읽지 못했습니다' : '그림 불러오는 중'); if (!rec) preload({ layers: [L] }); return; }
      const im = rec.img, fw = Math.round(value(L.frameWidth || 0, f)) || im.width, cells = Math.max(1, Math.floor(im.width / fw));
      const sc = Math.max(1, Math.round(value(L.scale ?? 1, f) * k)), w = fw * sc, h = im.height * sc;
      const t = document.createElement('canvas');
      t.width = N; t.height = N;
      const tg = t.getContext('2d');
      tg.imageSmoothingEnabled = false;
      tg.drawImage(im, (f % cells) * fw, 0, fw, im.height, Math.round(value(L.x ?? 0.5, f) * N - w / 2), Math.round(value(L.y ?? 0.5, f) * N - h / 2), w, h);
      const s = tg.getImageData(0, 0, N, N).data;
      for (let p = 0; p < N * N; p++) {
        if (s[p * 4 + 3] < 128 || (op < 1 && bayer(p % N, Math.floor(p / N)) >= op)) continue;
        D[p * 4] = s[p * 4]; D[p * 4 + 1] = s[p * 4 + 1]; D[p * 4 + 2] = s[p * 4 + 2]; D[p * 4 + 3] = 255;
      }
    }

    const durations = Array.isArray(r.durations) && r.durations.length
      ? frames.map((_, i) => Math.max(1, (r.durations[i] ?? r.durations[r.durations.length - 1]) / speed))
      : frames.map(() => 1000 / ((r.fps || 24) * speed));
    const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
    return { frames, durations, N, fps: 1000 / avg, F, loop: !!r.loop,
      game: { blend: ['add', 'screen', 'normal'].includes(r.blend) ? r.blend : 'add', impactFrame: Math.max(0, Math.min(F - 1, Math.round(r.impactFrame ?? 0))) },
      warnings: [...warnings] };
  }

  /** Whole-frame turn about the centre, nearest neighbour (pixels stay pixels). */
  function turn(c, deg) {
    const N = c.width, s = c.getContext('2d').getImageData(0, 0, N, N).data, o = document.createElement('canvas');
    o.width = o.height = N;
    const g = o.getContext('2d'), img = g.createImageData(N, N), cs = Math.cos(-deg * RAD), sn = Math.sin(-deg * RAD), h = N / 2;
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const dx = x + 0.5 - h, dy = y + 0.5 - h, sx = Math.floor(dx * cs - dy * sn + h), sy = Math.floor(dx * sn + dy * cs + h);
      if (sx < 0 || sy < 0 || sx >= N || sy >= N) continue;
      img.data.set(s.subarray((sy * N + sx) * 4, (sy * N + sx) * 4 + 4), (y * N + x) * 4);
    }
    g.putImageData(img, 0, 0);
    return o;
  }

  return { render, validate, value, preload, unsupported, DEF, COMMON };
})();
