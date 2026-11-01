// pxf.js — renderer for "pxf.graph@1" effect recipes (node graphs), fully in the browser.
//
// Model: every node output is an RGBA float buffer (N×N, straight colour, 0..1). Generators (Shape, Arc,
// Particles, Lightning…) write white "intensity" (alpha = strength); Palette / Tint turn intensity into colour.
// Everything is deterministic (seeded hashes / RNG) and pixel-crisp (no anti-aliased edges, nearest sampling).
// Params may be animated: {"k":[[frame, value, easing], …]} or {"a","b","e","t0","t1"} (normalized time).
// Nodes the contract defines but this renderer does not draw (AuraShell, Revolve) pass input 0 through and are
// reported in `warnings`.
'use strict';
const PXF = (() => {
  const clamp = (v, a = 0, b = 1) => v < a ? a : v > b ? b : v;
  const lerp = (a, b, t) => a + (b - a) * t;
  const EASE = {
    linear: t => t, in: t => t * t, out: t => 1 - (1 - t) ** 2, inout: t => t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) ** 2,
    in3: t => t ** 3, out3: t => 1 - (1 - t) ** 3,
    pulse: t => t + Math.sin(Math.PI * t) * 0.5,          // overshoots mid-way, lands on the next value
    wave: t => t + Math.sin(2 * Math.PI * t) * 0.15,      // wobbles on the way
    step: t => (t < 1 ? 0 : 1),
  };
  const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255);

  // deterministic randomness
  function rng(seed) {
    let s = (seed >>> 0) + 0x6d2b79f5;
    return () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  const hash = (a, b = 0, c = 0) => { let h = Math.imul(a, 374761393) + Math.imul(b, 668265263) + Math.imul(c, 2147483647); h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };

  // pixel-unit params, multiplied by the size slider so 1 recipe px stays 1 sprite px
  const PX = {
    Shape: ['size', 'stroke'], Gradient: ['radius'], Particles: ['aw', 'ah', 'speed', 'sizeA', 'sizeB', 'ground'],
    Arc: ['radius', 'thick'], Transform: ['tx', 'ty'], Repeat: ['dx', 'dy'], Blur: ['radius'], Glow: ['radius'],
    Displace: ['amount'], Polar: ['rIn', 'rOut'], Pixelate: ['block'], Spike: ['width'], Checker: ['size', 'ox', 'oy'],
    Grid: ['cellW', 'cellH', 'gap', 'ox', 'oy'], Stroke: ['width'], Lightning: ['thick'], Outline: ['width'],
  };

  /** Value of a (maybe animated) param at frame f. */
  function value(v, f, F, loop) {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return v;
    if (Array.isArray(v.k) && v.k.length) {
      const k = v.k;
      if (f <= k[0][0]) return k[0][1];
      for (let i = 0; i < k.length - 1; i++) if (f < k[i + 1][0]) {
        const t = (f - k[i][0]) / (k[i + 1][0] - k[i][0]);
        return lerp(k[i][1], k[i + 1][1], (EASE[k[i][2]] || EASE.linear)(t));
      }
      return k[k.length - 1][1];
    }
    if ('a' in v) {
      const T = loop ? f / F : F > 1 ? f / (F - 1) : 0, t0 = v.t0 ?? 0, t1 = v.t1 ?? 1;
      const t = t1 > t0 ? clamp((T - t0) / (t1 - t0)) : T >= t1 ? 1 : 0;
      return lerp(v.a, v.b, (EASE[v.e] || EASE.linear)(t));
    }
    return v;
  }

  // ---------- buffer helpers ----------
  const make = N => new Float32Array(N * N * 4);
  /** Write intensity v (white) keeping the max. */
  function put(b, N, x, y, v) {
    x = Math.floor(x); y = Math.floor(y);
    if (x < 0 || y < 0 || x >= N || y >= N || v <= 0) return;
    const i = (y * N + x) * 4;
    if (v > b[i + 3]) { b[i] = b[i + 1] = b[i + 2] = 1; b[i + 3] = Math.min(1, v); }
  }
  function disc(b, N, cx, cy, r, v) {
    if (r <= 0.5) return put(b, N, cx, cy, v);
    for (let y = Math.floor(cy - r); y <= cy + r; y++) for (let x = Math.floor(cx - r); x <= cx + r; x++)
      if ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= r * r) put(b, N, x, y, v);
  }
  function line(b, N, x0, y0, x1, y1, th, v) {
    const n = Math.max(1, Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))));
    for (let s = 0; s <= n; s++) {
      const x = lerp(x0, x1, s / n), y = lerp(y0, y1, s / n);
      if (th <= 1) put(b, N, x, y, v);
      else for (let dy = 0; dy < th; dy++) for (let dx = 0; dx < th; dx++) put(b, N, x + dx - (th - 1) / 2, y + dy - (th - 1) / 2, v);
    }
  }
  /** Nearest-neighbour sample of buffer at (x, y) → [r,g,b,a] index or -1. */
  const at = (N, x, y) => { x = Math.floor(x); y = Math.floor(y); return x < 0 || y < 0 || x >= N || y >= N ? -1 : (y * N + x) * 4; };

  /** Composite B over A with a mode (straight colour in/out, premultiplied maths). */
  function blendPx(o, A, i, Bf, j, mode, op) {
    const aA = A[i + 3], aB = j < 0 ? 0 : Bf[j + 3] * op;
    if (aB <= 0 && mode !== 'multiply') { o[i] = A[i]; o[i + 1] = A[i + 1]; o[i + 2] = A[i + 2]; o[i + 3] = aA; return; }
    let a, p = [0, 0, 0];
    const pa = c => A[i + c] * aA, pb = c => (j < 0 ? 0 : Bf[j + c]) * aB;
    switch (mode) {
      case 'add': a = Math.min(1, aA + aB); for (let c = 0; c < 3; c++) p[c] = Math.min(1, pa(c) + pb(c)); break;
      case 'screen': a = 1 - (1 - aA) * (1 - aB); for (let c = 0; c < 3; c++) p[c] = 1 - (1 - pa(c)) * (1 - pb(c)); break;
      case 'max': a = Math.max(aA, aB); for (let c = 0; c < 3; c++) p[c] = Math.max(pa(c), pb(c)); break;
      case 'multiply': {
        const m = j < 0 ? 0 : Bf[j + 3], k = 1 - op + op * m;
        a = aA * k; for (let c = 0; c < 3; c++) p[c] = pa(c) * k * (1 - op * m + op * m * (j < 0 ? 1 : Bf[j + c]));
        break;
      }
      case 'subtract': a = Math.max(0, aA - aB); for (let c = 0; c < 3; c++) p[c] = A[i + c] * a; break;
      default: a = aB + aA * (1 - aB); for (let c = 0; c < 3; c++) p[c] = pb(c) + pa(c) * (1 - aB);   // over
    }
    o[i + 3] = a;
    for (let c = 0; c < 3; c++) o[i + c] = a > 0 ? Math.min(1, p[c] / a) : 0;
  }

  function boxBlur(src, N, r, passes) {
    let b = src;
    for (let p = 0; p < passes; p++) for (const horiz of [true, false]) {
      const o = make(N);
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
        const acc = [0, 0, 0, 0];
        let n = 0;
        for (let d = -r; d <= r; d++) {
          const j = horiz ? at(N, x + d, y) : at(N, x, y + d);
          n++;
          if (j < 0) continue;
          const a = b[j + 3];
          acc[0] += b[j] * a; acc[1] += b[j + 1] * a; acc[2] += b[j + 2] * a; acc[3] += a;
        }
        const i = (y * N + x) * 4, a = acc[3] / n;
        o[i + 3] = a;
        for (let c = 0; c < 3; c++) o[i + c] = acc[3] > 0 ? acc[c] / acc[3] : 0;
      }
      b = o;
    }
    return b;
  }

  const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map(v => (v + 0.5) / 16);
  const BAYER2 = [0, 2, 3, 1].map(v => (v + 0.5) / 4);
  const bayer = (x, y, pat) => pat === 'bayer2' ? BAYER2[(y & 1) * 2 + (x & 1)] : BAYER4[(y & 3) * 4 + (x & 3)];

  // ---------- shapes ----------
  function insideShape(P, x, y, r) {
    const ax = Math.abs(x), ay = Math.abs(y), d = Math.hypot(x, y);
    switch (P.shape) {
      case 'ring': return d <= r && d >= r - Math.max(1, P.size2 * r);
      case 'square': return ax <= r && ay <= r;
      case 'diamond': return ax + ay <= r;
      case 'polygon': case 'star': {
        const n = Math.max(2, P.points), a = Math.atan2(y, x) + Math.PI / 2, seg = 2 * Math.PI / n;
        const t = ((a % seg) + seg) % seg;
        if (P.shape === 'polygon') return d * Math.cos(t - seg / 2) <= r * Math.cos(seg / 2);
        // star: straight edge from an outer tip (t=0) to an inner corner (t=seg/2)
        const ri = r * P.size2, u = t <= seg / 2 ? t : seg - t;
        const p0 = [r, 0], p1 = [ri * Math.cos(seg / 2), ri * Math.sin(seg / 2)], q = [d * Math.cos(u), d * Math.sin(u)];
        const cross = (p1[0] - p0[0]) * (q[1] - p0[1]) - (p1[1] - p0[1]) * (q[0] - p0[0]);
        return cross >= 0 || d <= ri;
      }
      case 'shard': return ax / Math.max(0.5, P.size2 * r) + ay / r <= 1;
      case 'crescent': return d <= r && Math.hypot(x - P.size2 * r, y + P.size2 * r * 0.25) > r * 0.92;
      case 'cross': { const w = Math.max(0.5, P.size2 * r * 0.5); return (ax <= w && ay <= r) || (ay <= w && ax <= r); }
      default: return d <= r;   // circle
    }
  }

  // ---------- node renderers: (P, inputs(port, frame), ctx) → buffer ----------
  const NODES = {
    Shape(P, _in, { N }) {
      const b = make(N), cx = P.x * N, cy = P.y * N, rot = P.rot * Math.PI / 180, c = Math.cos(-rot), s = Math.sin(-rot), r = P.size;
      if (r <= 0) return b;
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
        let dx = x + 0.5 - cx, dy = y + 0.5 - cy;
        [dx, dy] = [dx * c - dy * s, dx * s + dy * c];
        dy /= P.aspect || 1;
        if (!insideShape(P, dx, dy, r)) continue;
        if (P.stroke > 0 && insideShape(P, dx, dy, r - P.stroke)) continue;
        put(b, N, x, y, P.intensity * (1 - P.falloff * clamp(Math.hypot(dx, dy) / r)));
      }
      return b;
    },

    Noise(P, _in, { N, f, F }) {
      const b = make(N), sx = P.scaleX, sy = P.scaleY, t = f / F;
      const lat = (i, j, o) => hash(((i % (sx << o)) + (sx << o)) % (sx << o), ((j % (sy << o)) + (sy << o)) % (sy << o), P.seed * 7 + o);
      const vnoise = (u, v, o) => {   // tileable value noise
        const i = Math.floor(u), j = Math.floor(v), fu = u - i, fv = v - j, su = fu * fu * (3 - 2 * fu), sv = fv * fv * (3 - 2 * fv);
        return lerp(lerp(lat(i, j, o), lat(i + 1, j, o), su), lerp(lat(i, j + 1, o), lat(i + 1, j + 1, o), su), sv);
      };
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
        const u = (x + 0.5) / N * sx + P.scrollX * t * sx, v = (y + 0.5) / N * sy + P.scrollY * t * sy;
        let n = 0;
        if (P.type === 'cells') {
          let best = 9;
          const i = Math.floor(u), j = Math.floor(v);
          for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
            const ci = i + di, cj = j + dj, wi = ((ci % sx) + sx) % sx, wj = ((cj % sy) + sy) % sy;
            const px = ci + hash(wi, wj, P.seed), py = cj + hash(wi, wj, P.seed + 1);
            best = Math.min(best, Math.hypot(u - px, v - py));
          }
          n = clamp(best);
        } else {
          let amp = 0.5, tot = 0;
          for (let o = 0; o < P.octaves; o++) {
            let k = vnoise(u * (1 << o), v * (1 << o), o);
            if (P.type === 'ridged') k = 1 - Math.abs(2 * k - 1);
            n += k * amp; tot += amp; amp *= 0.5;
          }
          n /= tot;
        }
        put(b, N, x, y, clamp((n - 0.5) * P.contrast + 0.5 + P.bias));
      }
      return b;
    },

    Gradient(P, _in, { N }) {
      const b = make(N), cx = P.x * N, cy = P.y * N, a = P.angle * Math.PI / 180, dir = [Math.cos(a), Math.sin(a)];
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
        const dx = x + 0.5 - cx, dy = (y + 0.5 - cy) / (P.aspect || 1);
        let t;
        if (P.type === 'radial') t = Math.hypot(dx, dy) / P.radius;
        else if (P.type === 'diamond') t = (Math.abs(dx) + Math.abs(dy)) / P.radius;
        else if (P.type === 'angular') t = ((Math.atan2(dy, dx) - a) / (2 * Math.PI) % 1 + 1) % 1;
        else t = 0.5 - (dx * dir[0] + dy * dir[1]) / (2 * P.radius);
        t += P.offset;
        if (P.repeat) t = ((t % 1) + 1) % 1;
        let v = 1 - clamp(t);
        if (P.invert) v = 1 - v;
        put(b, N, x, y, v);
      }
      return b;
    },

    Particles(P, _in, { N, f, F }) {
      const b = make(N), R = rng(P.seed), cx = P.x * N, cy = P.y * N;
      for (let i = 0; i < P.count; i++) {
        const r = Array.from({ length: 10 }, R);
        const birth = (P.emit === 'stream' ? P.start + P.span * (i + r[0]) / P.count : P.start) * F;
        const life = Math.max(1, P.life * F * (1 + P.lifeVar * (r[1] * 2 - 1)));
        let age = f - birth;
        if (P.loop) age = ((age % F) + F) % F;
        if (age < 0 || age >= life) continue;
        // spawn point
        let sx = cx, sy = cy;
        const ang = r[2] * 2 * Math.PI;
        if (P.area === 'circle') { const rr = Math.sqrt(r[3]) * P.aw / 2; sx += Math.cos(ang) * rr; sy += Math.sin(ang) * rr * (P.ah / (P.aw || 1) || 1); }
        else if (P.area === 'ring') { sx += Math.cos(ang) * P.aw / 2; sy += Math.sin(ang) * P.ah / 2; }
        else if (P.area === 'box') { sx += (r[3] - 0.5) * P.aw; sy += (r[4] - 0.5) * P.ah; }
        else if (P.area === 'line') { sx += (r[3] - 0.5) * P.aw; }
        // direction
        let a = (P.angle + P.spread * (r[5] - 0.5)) * Math.PI / 180;
        if (P.dirMode === 'outward') a = sx === cx && sy === cy ? a : Math.atan2(sy - cy, sx - cx) + (P.spread / 360) * (r[5] - 0.5) * 0.5;
        const sp = P.speed * (1 + P.speedVar * (r[6] * 2 - 1));
        let x = sx, y = sy;
        if (P.dirMode === 'inward') {
          const k = clamp(sp * age / life);
          x = lerp(sx, cx, k); y = lerp(sy, cy, k);
        } else {
          let vx = Math.cos(a) * sp, vy = Math.sin(a) * sp;
          for (let s = 0; s < Math.floor(age); s++) {
            x += vx; y += vy;
            vx *= 1 - P.drag; vy *= 1 - P.drag; vy += P.gravity;
            if (P.turb) { x += (hash(i, s, P.seed) - 0.5) * P.turb * 0.5; y += (hash(i, s, P.seed + 9) - 0.5) * P.turb * 0.5; }
            if (P.ground > 0 && y >= P.ground) { y = P.ground; vy = -vy * P.bounce; }
          }
        }
        const t = age / life, size = lerp(P.sizeA, P.sizeB, t);
        let br = P.bright * (1 - P.brightVar * r[7]);
        if (P.fade === 'out') br *= 1 - t; else if (P.fade === 'inout') br *= Math.sin(Math.PI * t);
        else if (P.fade === 'flicker') br *= hash(i, f, P.seed) > 0.45 ? 1 : 0.35;
        if (br <= 0) continue;
        const hs = size / 2;
        switch (P.pshape) {
          case 'dot': put(b, N, x, y, br); break;
          case 'circle': disc(b, N, x, y, hs, br); break;
          case 'diamond': for (let dy = -hs; dy <= hs; dy++) for (let dx = -hs; dx <= hs; dx++) if (Math.abs(dx) + Math.abs(dy) <= hs) put(b, N, x + dx, y + dy, br); break;
          case 'plus': line(b, N, x - hs, y, x + hs, y, 1, br); line(b, N, x, y - hs, x, y + hs, 1, br); break;
          case 'streak': { const L = Math.max(1, size * P.stretch); line(b, N, x, y, x - Math.cos(a) * L, y - Math.sin(a) * L, 1, br); break; }
          default: for (let dy = 0; dy < Math.max(1, Math.round(size)); dy++) for (let dx = 0; dx < Math.max(1, Math.round(size)); dx++) put(b, N, x - hs + dx, y - hs + dy, br);
        }
      }
      return b;
    },

    Lightning(P, _in, { N, f }) {
      const b = make(N), R = rng(P.seed + (P.rate > 0 ? Math.floor(f / P.rate) * 7919 : 0));
      // midpoint displacement; branches split off at midpoints
      const bolt = (x0, y0, x1, y1, depth, jag) => {
        let pts = [[x0, y0], [x1, y1]];
        for (let d = 0; d < depth; d++) {
          const nx = [];
          for (let i = 0; i < pts.length - 1; i++) {
            const [ax, ay] = pts[i], [bx, by] = pts[i + 1], L = Math.hypot(bx - ax, by - ay);
            const off = (R() - 0.5) * L * jag;
            nx.push(pts[i], [(ax + bx) / 2 - (by - ay) / (L || 1) * off, (ay + by) / 2 + (bx - ax) / (L || 1) * off]);
          }
          nx.push(pts[pts.length - 1]);
          pts = nx;
        }
        return pts;
      };
      const main = bolt(P.x0 * N, P.y0 * N, P.x1 * N, P.y1 * N, P.detail, P.jag);
      const shown = Math.floor((main.length - 1) * clamp(P.grow));
      for (let i = 0; i < shown; i++) line(b, N, main[i][0], main[i][1], main[i + 1][0], main[i + 1][1], P.thick, P.intensity);
      const total = Math.hypot(P.x1 - P.x0, P.y1 - P.y0) * N;
      for (let i = 1; i < shown; i++) {
        if (R() >= P.branch / 3) continue;
        const [sx, sy] = main[i], [nx2, ny2] = main[Math.min(main.length - 1, i + 1)];
        const a = Math.atan2(ny2 - sy, nx2 - sx) + (R() < 0.5 ? -1 : 1) * (0.35 + R() * 0.5), L = total * P.branchLen * (0.4 + R() * 0.6);
        const br = bolt(sx, sy, sx + Math.cos(a) * L, sy + Math.sin(a) * L, Math.max(1, P.detail - 2), P.jag);
        for (let k = 0; k < br.length - 1; k++) line(b, N, br[k][0], br[k][1], br[k + 1][0], br[k + 1][1], Math.max(1, P.thick - 1), P.intensity * 0.65);
      }
      return b;
    },

    Arc(P, _in, { N }) {
      const b = make(N), cx = P.x * N, cy = P.y * N, rot = P.rot * Math.PI / 180, c = Math.cos(-rot), s = Math.sin(-rot);
      const sw = P.sweep, from = P.head - P.tail;
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
        let dx = x + 0.5 - cx, dy = y + 0.5 - cy;
        [dx, dy] = [dx * c - dy * s, dx * s + dy * c];
        dy /= P.aspect || 1;
        const d = Math.hypot(dx, dy);
        let ang = Math.atan2(dy, dx) * 180 / Math.PI - P.start;
        ang = sw >= 0 ? ((ang % 360) + 360) % 360 : -((((-ang) % 360) + 360) % 360);
        const u = sw ? ang / sw : 0;   // 0..1 along the sweep
        if (u < Math.max(0, from) || u > Math.min(1, P.head)) continue;
        const k = clamp((u - from) / P.tail);   // 0 at the tail end, 1 at the head
        const w = Math.max(1, P.thick * k ** P.taper);
        if (d > P.radius || d < P.radius - w) continue;
        put(b, N, x, y, P.intensity * (0.35 + 0.65 * k));
      }
      return b;
    },

    Transform(P, inp, { N }) {
      const src = inp(0), b = make(N), px = P.px * N, py = P.py * N, a = P.rot * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
      if (!src) return b;
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
        const dx = x + 0.5 - px - P.tx, dy = y + 0.5 - py - P.ty;
        const ux = (dx * c + dy * s) / (P.sx || 1e-6), uy = (-dx * s + dy * c) / (P.sy || 1e-6);
        const j = at(N, px + ux, py + uy);
        if (j >= 0) b.set(src.subarray(j, j + 4), (y * N + x) * 4);
      }
      return b;
    },

    Repeat(P, inp, { N, f }) {
      let b = make(N);
      const R = rng(P.seed), n = P.count, px = P.px * N, py = P.py * N;
      const bez = (t, k) => { const p = [P['b' + k + '0'], P['b' + k + '1'], P['b' + k + '2'], P['b' + k + '3']]; const m = 1 - t; return m * m * m * p[0] + 3 * m * m * t * p[1] + 3 * m * t * t * p[2] + t * t * t * p[3]; };
      for (let j = 0; j < n; j++) {
        const src = inp(0, f - Math.round(j * P.delay));
        const jr = R(), jr2 = R();
        if (!src) continue;
        const idx = P.centered ? j - (n - 1) / 2 : j, t = n > 1 ? (j / (n - 1)) ** P.dist : 0;
        let X, Y, sc;
        if (P.layout === 'bezier') {
          X = bez(t, 'x') * N; Y = bez(t, 'y') * N;
          sc = lerp(P.scale0, P.scale1, t ** P.scalePow);
        } else {
          X = (P.posX >= 0 ? P.posX * N : px) + idx * P.dx; Y = (P.posY >= 0 ? P.posY * N : py) + idx * P.dy;
          sc = P.scale0 * Math.max(0.05, 1 - P.scaleStep * j);
        }
        sc *= 1 + P.jitter * (jr * 2 - 1);
        const a = (P.angle0 + idx * P.angleStep + lerp(P.rotMin, P.rotMax, jr2)) * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
        const fade = Math.max(0, 1 - P.fadeStep * j), copy = make(N);
        for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
          const dx = x + 0.5 - X, dy = y + 0.5 - Y;
          const ux = (dx * c + dy * s) / (sc * P.sx), uy = (-dx * s + dy * c) / (sc * P.sy);
          const k = at(N, px + ux, py + uy);
          if (k < 0 || !src[k + 3]) continue;
          const i = (y * N + x) * 4;
          copy[i] = src[k]; copy[i + 1] = src[k + 1]; copy[i + 2] = src[k + 2]; copy[i + 3] = src[k + 3] * fade;
        }
        const o = make(N);
        for (let i = 0; i < N * N * 4; i += 4) blendPx(o, b, i, copy, i, P.mode === 'over' ? 'over' : P.mode, 1);
        b = o;
      }
      return b;
    },

    Echo(P, inp, { N, f }) {
      let b = make(N);
      for (let c = P.copies; c >= 0; c--) {
        const src = inp(0, f - c * P.step);
        if (!src) continue;
        const k = P.decay ** c, o = make(N);
        for (let i = 0; i < N * N * 4; i += 4) blendPx(o, b, i, src, i, 'max', k);
        b = o;
      }
      return b;
    },

    Blur(P, inp, { N }) { const s = inp(0); return s ? (P.radius > 0 ? boxBlur(s, N, P.radius, P.passes) : s) : make(N); },

    Glow(P, inp, { N }) {
      const s = inp(0);
      if (!s) return make(N);
      const g = boxBlur(s, N, P.radius, 2), o = make(N);
      for (let i = 0; i < N * N * 4; i += 4) { g[i + 3] = Math.min(1, g[i + 3] * P.strength); blendPx(o, g, i, s, i, 'over', 1); }
      return o;
    },

    Levels(P, inp, { N }) {
      const s = inp(0), o = make(N);
      if (!s) return o;
      const f = v => { v = clamp((v - P.lo) / Math.max(1e-6, P.hi - P.lo)) ** (1 / P.gamma); return P.steps > 1 ? Math.round(v * (P.steps - 1)) / (P.steps - 1) : v; };
      for (let i = 0; i < N * N * 4; i += 4) { o[i] = s[i]; o[i + 1] = s[i + 1]; o[i + 2] = s[i + 2]; o[i + 3] = s[i + 3] ? f(s[i + 3]) : 0; }
      return o;
    },

    Dither(P, inp, { N }) {
      const s = inp(0), o = make(N);
      if (!s) return o;
      const L = P.levels - 1;
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
        const i = (y * N + x) * 4, th = (bayer(x, y, P.pattern) - 0.5) * P.strength;
        o[i] = s[i]; o[i + 1] = s[i + 1]; o[i + 2] = s[i + 2];
        o[i + 3] = clamp(Math.floor(s[i + 3] * L + 0.5 + th) / L);
      }
      return o;
    },

    Displace(P, inp, { N }) {
      const s = inp(0), m = inp(1), o = make(N);
      if (!s) return o;
      const a = P.angle * Math.PI / 180, cx = P.cx * N, cy = P.cy * N;
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
        const i = (y * N + x) * 4, k = (m ? m[i + 3] : 0) - P.center;
        let dx, dy;
        if (P.mode === 'radial' || P.mode === 'swirl') {
          const ex = x + 0.5 - cx, ey = y + 0.5 - cy, L = Math.hypot(ex, ey) || 1;
          [dx, dy] = P.mode === 'radial' ? [ex / L, ey / L] : [-ey / L, ex / L];
        } else [dx, dy] = [Math.cos(a), Math.sin(a)];
        const j = at(N, x + 0.5 - dx * k * P.amount, y + 0.5 - dy * k * P.amount);
        if (j >= 0) o.set(s.subarray(j, j + 4), i);
      }
      return o;
    },

    Polar(P, inp, { N }) {
      const s = inp(0), o = make(N);
      if (!s) return o;
      const cx = P.cx * N, cy = P.cy * N;
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
        const dx = x + 0.5 - cx, dy = y + 0.5 - cy, r = Math.hypot(dx, dy);
        if (r < P.rIn || r > P.rOut) continue;
        const u = ((Math.atan2(dy, dx) * 180 / Math.PI - P.spin) / 360 % 1 + 1) % 1, v = (r - P.rIn) / (P.rOut - P.rIn);
        const j = at(N, u * N, (P.invert ? 1 - v : v) * N);
        if (j >= 0) o.set(s.subarray(j, j + 4), (y * N + x) * 4);
      }
      return o;
    },

    Pixelate(P, inp, { N }) {
      const s = inp(0), o = make(N), k = Math.max(1, Math.round(P.block));
      if (!s) return o;
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
        const j = at(N, Math.floor(x / k) * k + k / 2, Math.floor(y / k) * k + k / 2);
        if (j >= 0) o.set(s.subarray(j, j + 4), (y * N + x) * 4);
      }
      return o;
    },

    Blend(P, inp, { N }) {
      const A = inp(0) || make(N), Bf = inp(1), o = make(N);
      for (let i = 0; i < N * N * 4; i += 4) blendPx(o, A, i, Bf, Bf ? i : -1, P.mode, P.opacity);
      return o;
    },

    Mask(P, inp, { N }) {
      const s = inp(0), m = inp(1), o = make(N);
      if (!s) return o;
      for (let i = 0; i < N * N * 4; i += 4) {
        const k = m ? m[i + 3] * P.strength : 0;
        o[i] = s[i]; o[i + 1] = s[i + 1]; o[i + 2] = s[i + 2];
        o[i + 3] = s[i + 3] * (P.mode === 'cutout' ? 1 - k : 1 - P.strength + k);
      }
      return o;
    },

    Palette(P, inp, { N, hue }) {
      const s = inp(0), o = make(N), cols = (P.colors || []).map(c => shiftHue(hex(c), hue));
      if (!s || !cols.length) return o;
      for (let i = 0; i < N * N * 4; i += 4) {
        const v = P.key === 'luma' ? (s[i] * 0.3 + s[i + 1] * 0.59 + s[i + 2] * 0.11) * s[i + 3] : s[i + 3];
        if (v < P.cutoff || v <= 0) continue;
        const t = clamp((v - P.cutoff) / Math.max(1e-6, 1 - P.cutoff) + P.shift);
        let c;
        if (P.mode === 'smooth') { const x = t * (cols.length - 1), k = Math.min(cols.length - 2, Math.floor(x)); c = cols.length > 1 ? cols[k].map((v2, n) => lerp(v2, cols[k + 1][n], x - k)) : cols[0]; }
        else c = cols[Math.min(cols.length - 1, Math.floor(t * cols.length))];
        o[i] = c[0]; o[i + 1] = c[1]; o[i + 2] = c[2]; o[i + 3] = P.opacity;
      }
      return o;
    },

    Tint(P, inp, { N, hue }) {
      const s = inp(0), m = inp(1), o = make(N), col = shiftHue(hex(P.color), hue);
      if (!s) return o;
      for (let i = 0; i < N * N * 4; i += 4) {
        const k = P.amount * (m ? m[i + 3] : 1);
        for (let c = 0; c < 3; c++) o[i + c] = clamp(lerp(s[i + c], col[c], k) * P.bright);
        o[i + 3] = s[i + 3] * P.opacity;
      }
      return o;
    },

    Outline(P, inp, { N, hue }) {
      const s = inp(0), m = inp(1), o = make(N), col = shiftHue(hex(P.color), hue);
      if (!s) return o;
      o.set(s);
      const on = (x, y) => { const j = at(N, x, y); return j >= 0 && s[j + 3] >= P.threshold; };
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
        const i = (y * N + x) * 4;
        if (m && m[i + 3] < 0.5) continue;
        const me = on(x, y);
        if ((P.mode === 'inner') !== me) continue;
        let hit = false;
        for (let dy = -P.width; dy <= P.width && !hit; dy++) for (let dx = -P.width; dx <= P.width && !hit; dx++) {
          if (!dx && !dy) continue;
          if (!P.corners && Math.abs(dx) + Math.abs(dy) > P.width) continue;
          if (on(x + dx, y + dy) !== me) hit = true;
        }
        if (hit) { o[i] = col[0]; o[i + 1] = col[1]; o[i + 2] = col[2]; o[i + 3] = 1; }
      }
      return o;
    },

    Spike(P, _in, { N }) {
      const b = make(N), x0 = P.x0 * N, y0 = P.y0 * N, x1 = P.x1 * N, y1 = P.y1 * N, L = Math.hypot(x1 - x0, y1 - y0) || 1;
      const ux = (x1 - x0) / L, uy = (y1 - y0) / L, len = L * clamp(P.grow);
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
        const dx = x + 0.5 - x0, dy = y + 0.5 - y0, u = dx * ux + dy * uy, v = -dx * uy + dy * ux;
        if (u < 0 || u > len) continue;
        const hw = (P.width / 2) * (1 - P.taper * (u / L) ** P.taperPow);
        if (Math.abs(v) > Math.max(0.5, hw)) continue;
        let val = lerp(P.base, P.tip, u / L) + P.facet * Math.sign(v) * 0.5;
        if (Math.abs(v) < 0.75) val += P.ridge;
        if (P.shine >= 0 && Math.abs(u / L - P.shine) < P.shineW / 2) val += P.shineAmp;
        put(b, N, x, y, clamp(val) * P.intensity);
      }
      return b;
    },

    Checker(P, _in, { N }) {
      const b = make(N), sz = Math.max(1, P.size);
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
        let u = x + 0.5 - P.ox, v = y + 0.5 - P.oy;
        if (P.iso) [u, v] = [u / 2 + v, v - u / 2];
        const cu = Math.floor(u / sz), cv = Math.floor(v / sz);
        let on = (cu + cv) % 2 === 0;
        if (P.pattern === 'dots') on = Math.hypot(u / sz - cu - 0.5, v / sz - cv - 0.5) <= P.dot;
        put(b, N, x, y, on ? P.a : P.b);
      }
      return b;
    },

    Quantize(P, inp, { N, hue }) {
      const s = inp(0), o = make(N), cols = (P.colors || []).map(c => shiftHue(hex(c), hue));
      if (!s) return o;
      for (let i = 0; i < N * N * 4; i += 4) {
        let a = s[i + 3];
        if (P.alpha === 'hard') a = a >= P.threshold ? 1 : 0;
        if (!a) continue;
        let best = cols[0], bd = 9;
        for (const c of cols) { const d = (c[0] - s[i]) ** 2 + (c[1] - s[i + 1]) ** 2 + (c[2] - s[i + 2]) ** 2; if (d < bd) { bd = d; best = c; } }
        o[i] = best[0]; o[i + 1] = best[1]; o[i + 2] = best[2]; o[i + 3] = a;
      }
      return o;
    },

    Grid(P, _in, { N }) {
      const b = make(N);
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
        const u = x - P.ox, v = y - P.oy, cw = P.cellW + P.gap, ch = P.cellH + P.gap;
        const cu = Math.floor(u / cw), cv = Math.floor(v / ch), inGap = u - cu * cw >= P.cellW || v - cv * ch >= P.cellH;
        put(b, N, x, y, inGap ? P.gapV : lerp(P.lo, P.hi, hash(cu, cv, P.seed)));
      }
      return b;
    },

    Stroke(P, _in, { N }) {
      const b = make(N);
      const pt = t => { const m = 1 - t, k = [m * m * m, 3 * m * m * t, 3 * m * t * t, t * t * t]; return [0, 1].map(a => (k[0] * P[a ? 'y0' : 'x0'] + k[1] * P[a ? 'y1' : 'x1'] + k[2] * P[a ? 'y2' : 'x2'] + k[3] * P[a ? 'y3' : 'x3']) * N); };
      if (P.to <= P.from) return b;
      const steps = Math.ceil(N * 4 * (P.to - P.from)) + 1;
      for (let s = 0; s <= steps; s++) {
        const t = lerp(P.from, P.to, s / steps), q = P.span ? s / steps : t;
        const w = P.width * (1 - P.taper * Math.abs(2 * q - 1) ** 2);
        const v = q < 0.5 ? lerp(P.vA, P.vM, q * 2) : lerp(P.vM, P.vB, q * 2 - 1);
        const [x, y] = pt(t);
        if (w > 0) disc(b, N, x, y, w / 2, v * P.intensity);
      }
      return b;
    },

    Output(P, inp, { N }) { return inp(0) || make(N); },
  };

  function shiftHue([r, g, b], deg) {
    if (!deg) return [r, g, b];
    // rotate hue in YIQ space (keeps brightness)
    const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
    const y = 0.299 * r + 0.587 * g + 0.114 * b, i = 0.596 * r - 0.274 * g - 0.322 * b, q = 0.211 * r - 0.523 * g + 0.312 * b;
    const i2 = i * c - q * s, q2 = i * s + q * c;
    return [clamp(y + 0.956 * i2 + 0.621 * q2), clamp(y - 0.272 * i2 - 0.647 * q2), clamp(y - 1.106 * i2 + 1.703 * q2)];
  }

  /** Check the graph shape; returns a list of problems (empty = fine). */
  function validate(g) {
    const errs = [];
    if (!g || g.format !== 'pxf.graph@1') errs.push('format이 "pxf.graph@1"이 아닙니다');
    if (!g || !Array.isArray(g.nodes) || !Array.isArray(g.links)) { errs.push('nodes / links 배열이 필요합니다'); return errs; }
    const ids = new Set(g.nodes.map(n => n.id));
    if (ids.size !== g.nodes.length) errs.push('노드 id가 겹칩니다');
    const outs = g.nodes.filter(n => n.type === 'Output');
    if (outs.length !== 1) errs.push('Output 노드는 정확히 하나여야 합니다');
    for (const n of g.nodes) if (!PXF_DEFS[n.type]) errs.push(`알 수 없는 노드 종류: ${n.type}`);
    for (const l of g.links) if (!ids.has(l.f) || !ids.has(l.t)) errs.push(`연결 대상이 없습니다: ${l.f}→${l.t}`);
    return errs;
  }

  /**
   * Render a graph. opts: { scale (size multiplier), hue (degrees), speed (fps multiplier) }.
   * Returns { frames: [canvas], durations: [ms], N, fps, game, warnings }.
   */
  function render(g, opts = {}) {
    const errs = validate(g);
    if (errs.length) throw new Error(errs.join(' · '));
    const st = g.settings || {}, F = Math.max(1, Math.min(64, Math.round(st.frames || 16))), loop = !!st.loop;
    const k = opts.scale || 1, N = Math.max(8, Math.min(512, Math.round((st.size || 64) * k)));
    const fps = Math.max(1, (st.fps || 24) * (opts.speed || 1)), hue = opts.hue || 0;
    const byId = new Map(g.nodes.map(n => [n.id, n])), inputs = new Map();
    for (const l of g.links) inputs.set(`${l.t}|${l.p || 0}`, l.f);
    const warnings = new Set(), memo = new Map();

    const evalNode = (id, f) => {
      if (f < 0 || f >= F) { if (!loop) return null; f = ((f % F) + F) % F; }
      const key = id + '|' + f;
      if (memo.has(key)) return memo.get(key);
      memo.set(key, null);   // cycle guard
      const n = byId.get(id), def = PXF_DEFS[n.type], P = {};
      for (const [name, d] of Object.entries(def.d)) {
        let v = value(n.params && name in n.params ? n.params[name] : d, f, F, loop);
        if (def.ints.includes(name)) v = Math.round(v);
        if ((PX[n.type] || []).includes(name) && typeof v === 'number') v *= k;
        P[name] = v;
      }
      const inp = (port, frame = f) => { const src = inputs.get(`${id}|${port}`); return src ? evalNode(src, frame) : null; };
      let out;
      if (NODES[n.type]) out = NODES[n.type](P, inp, { N, f, F, hue });
      else { warnings.add(n.type); out = inp(0) || make(N); }
      memo.set(key, out);
      return out;
    };

    const outNode = g.nodes.find(n => n.type === 'Output'), outP = { ...PXF_DEFS.Output.d, ...(outNode.params || {}) };
    const frames = [];
    for (let f = 0; f < F; f++) {
      const buf = evalNode(outNode.id, f) || make(N);
      const c = document.createElement('canvas');
      c.width = c.height = N;
      const g2 = c.getContext('2d'), img = g2.createImageData(N, N);
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
        const i = (y * N + x) * 4;
        let a = buf[i + 3];
        // hard: threshold. soft: ordered dither so the fade stays pixel-crisp (no half-transparent pixels)
        a = outP.alpha === 'hard' ? (a >= value(outP.threshold, f, F, loop) ? 1 : 0) : (a > bayer(x, y, 'bayer4') ? 1 : 0);
        if (!a) continue;
        img.data[i] = Math.round(buf[i] * 255); img.data[i + 1] = Math.round(buf[i + 1] * 255); img.data[i + 2] = Math.round(buf[i + 2] * 255); img.data[i + 3] = 255;
      }
      g2.putImageData(img, 0, 0);
      frames.push(c);
    }
    const game = g.game || {};
    // game.durationMs (if given) sets the total play time; the speed slider still scales it
    const frameMs = game.durationMs > 0 ? game.durationMs / F / (opts.speed || 1) : 1000 / fps;
    return { frames, durations: frames.map(() => frameMs), N, fps: 1000 / frameMs, F, loop, game, warnings: [...warnings] };
  }

  return { render, validate, value };
})();
