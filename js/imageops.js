// imageops.js — pure image functions, no DOM.
// An image is { w, h, data: Uint8ClampedArray RGBA }. Masks are Uint8Array (1 = foreground).
// Alpha is always hard: every output pixel is fully opaque or fully transparent.
'use strict';
const IO = (() => {
  const blank = () => ({ w: 0, h: 0, data: new Uint8ClampedArray(0) });

  /** Median colour of the image border: the usual chroma-key background. When the very edge is a frame line (its colour
   *  differs from a ring a few px inside), the inner ring's colour. */
  function guessKey(img) {
    const { w, h, data } = img;
    const ring = o => {
      const ch = [[], [], []];
      const add = (x, y) => { const i = (y * w + x) * 4; for (let c = 0; c < 3; c++) ch[c].push(data[i + c]); };
      for (let x = o; x < w - o; x += 2) { add(x, o); add(x, h - 1 - o); }
      for (let y = o; y < h - o; y += 2) { add(o, y); add(w - 1 - o, y); }
      return ch.map(a => a.sort((p, q) => p - q)[a.length >> 1]);
    };
    const m0 = ring(0), o = Math.min(6, Math.floor(Math.min(w, h) / 10));
    if (!o) return m0;
    const m1 = ring(o);
    return Math.hypot(m0[0] - m1[0], m0[1] - m1[1], m0[2] - m1[2]) > 30 ? m1 : m0;
  }

  /** 1 where any 4-neighbour within `r` steps is background. */
  function nearBackground(mask, w, h, r) {
    let near = new Uint8Array(mask.length);
    for (let p = 0; p < mask.length; p++) near[p] = mask[p] ? 0 : 1;
    for (let k = 0; k < r; k++) {
      const next = near.slice();
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const p = y * w + x;
        if (near[p]) continue;
        if ((x > 0 && near[p - 1]) || (x < w - 1 && near[p + 1]) || (y > 0 && near[p - w]) || (y < h - 1 && near[p + w])) next[p] = 1;
      }
      near = next;
    }
    return near;
  }

  const cdist = (d, i, k) => { const r = d[i] - k[0], g = d[i + 1] - k[1], b = d[i + 2] - k[2]; return Math.sqrt(r * r + g * g + b * b); };

  /**
   * The background colours on the border: two for a checker grid (two clusters of border colours, each 15% or more,
   * more than 18 apart), else null. k-means (k = 2) on a ring a few px inside the border.
   */
  function borderKeys(img) {
    const { w, h, data } = img, pts = [];
    const o = Math.min(6, Math.floor(Math.min(w, h) / 10));
    for (const r of [o]) {   // (the ring inside: a frame line drawn on the very edge is not a background colour)
      for (let x = r; x < w - r; x++) for (const y of [r, h - 1 - r]) { const i = (y * w + x) * 4; pts.push([data[i], data[i + 1], data[i + 2]]); }
      for (let y = r; y < h - r; y++) for (const x of [r, w - 1 - r]) { const i = (y * w + x) * 4; pts.push([data[i], data[i + 1], data[i + 2]]); }
    }
    const lum = p => p[0] + p[1] + p[2];
    pts.sort((p, q) => lum(p) - lum(q));
    let c = [pts[Math.floor(pts.length * 0.2)], pts[Math.floor(pts.length * 0.8)]].map(p => [...p]), n = [0, 0];
    for (let it = 0; it < 8; it++) {
      const sum = [[0, 0, 0], [0, 0, 0]];
      n = [0, 0];
      for (const p of pts) {
        const k = Math.hypot(p[0] - c[0][0], p[1] - c[0][1], p[2] - c[0][2]) <= Math.hypot(p[0] - c[1][0], p[1] - c[1][1], p[2] - c[1][2]) ? 0 : 1;
        n[k]++; for (let ch = 0; ch < 3; ch++) sum[k][ch] += p[ch];
      }
      c = c.map((old, k) => (n[k] ? sum[k].map(v => Math.round(v / n[k])) : old));
    }
    const apart = Math.hypot(c[0][0] - c[1][0], c[0][1] - c[1][1], c[0][2] - c[1][2]);
    return apart > 18 && Math.min(n[0], n[1]) >= pts.length * 0.15 ? c : null;
  }

  /**
   * A second background colour on the border (the other square of a checker grid, a JPG's light / dark tiles), or
   * null: the most common border colour farther than `tol` from `key`, when it covers 15% of the border or more.
   */
  function secondKey(img, key, tol) {
    const { w, h, data } = img, bins = new Map();
    let n = 0;
    const add = (x, y) => {
      const i = (y * w + x) * 4;
      n++;
      if (cdist(data, i, key) <= tol) return;
      const k = ((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4), b = bins.get(k) || { c: 0, r: 0, g: 0, b: 0 };
      b.c++; b.r += data[i]; b.g += data[i + 1]; b.b += data[i + 2];
      bins.set(k, b);
    };
    for (let x = 0; x < w; x++) { add(x, 0); add(x, h - 1); }
    for (let y = 1; y < h - 1; y++) { add(0, y); add(w - 1, y); }
    let best = null;
    for (const b of bins.values()) if (!best || b.c > best.c) best = b;
    return best && best.c >= n * 0.15 ? [best.r / best.c, best.g / best.c, best.b / best.c].map(Math.round) : null;
  }

  /**
   * Panel border lines: whole rows / columns (90% or more of their length) of one colour that is not the background,
   * at most 1% of the image thick. Returns a mask of their pixels (1 = line), or null when there are none.
   */
  function borderLines(img, keys, tol) {
    const { w, h, data } = img, out = new Uint8Array(w * h);
    let any = false;
    const scan = (len, count, at) => {   // at(line, i) -> pixel index
      const hit = [];
      for (let L = 0; L < count; L++) {
        const ch = [[], [], []];
        for (let i = 0; i < len; i += 3) { const q = at(L, i) * 4; for (let c = 0; c < 3; c++) ch[c].push(data[q + c]); }
        const med = ch.map(v => v.sort((x, y) => x - y)[v.length >> 1]);
        if (keys.some(k => Math.hypot(med[0] - k[0], med[1] - k[1], med[2] - k[2]) <= tol)) { hit.push(null); continue; }
        let same = 0;
        for (let i = 0; i < len; i++) if (cdist(data, at(L, i) * 4, med) <= tol * 0.6) same++;
        hit.push(same >= len * 0.9 ? med : null);
      }
      const maxT = Math.max(3, Math.round(count * 0.01));
      for (let L = 0; L < count;) {
        if (!hit[L]) { L++; continue; }
        let e = L;
        while (e + 1 < count && hit[e + 1]) e++;
        if (e - L + 1 <= maxT) for (let k = L; k <= e; k++) for (let i = 0; i < len; i++) { const q = at(k, i); if (cdist(data, q * 4, hit[k]) <= tol * 0.6) { out[q] = 1; any = true; } }
        L = e + 1;
      }
    };
    scan(w, h, (y, x) => y * w + x);
    scan(h, w, (x, y) => y * w + x);
    return any ? out : null;
  }

  /** Small pieces wholly inside a corner zone (15% of each side): watermarks / signatures. Removed from `mask`. */
  function dropCornerMarks(mask, w, h) {
    const seen = new Uint8Array(w * h), zx = w * 0.15, zy = h * 0.15, maxArea = Math.max(40, w * h * 0.015);
    for (let p0 = 0; p0 < w * h; p0++) {
      if (!mask[p0] || seen[p0]) continue;
      const stack = [p0], px = [];
      seen[p0] = 1;
      let x0 = w, y0 = h, x1 = -1, y1 = -1;
      let area = 0;
      while (stack.length) {
        const p = stack.pop(), x = p % w, y = (p / w) | 0;
        if (++area <= maxArea) px.push(p);   // (the whole piece is walked; only small ones are kept to remove)
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy, q = ny * w + nx;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h || !mask[q] || seen[q]) continue;
          seen[q] = 1; stack.push(q);
        }
      }
      if (area > maxArea) continue;
      const inX = x1 < zx || x0 > w - zx, inY = y1 < zy || y0 > h - zy;
      if (inX && inY) for (const p of px) mask[p] = 0;
    }
  }

  /**
   * Background key. Background = colour distance to `key` (or the grid's second colour) <= the fill tolerance. Then
   * two passes peel the blended rim: foreground pixels touching the background within the peel tolerance go too.
   * o.connected (default): only background reachable from the image edges goes (flood fill), so the same colour inside
   *   the character stays; on grey / black / white backgrounds the fill tolerance follows the background's own noise
   *   (JPG blocks) instead of `tol` (at most `tol`), so dark clothes next to a dark grey background survive.
   * o.borders: panel border lines count as background (the fill passes through them into every panel).
   * o.marks: small pieces in the corners (watermarks) go.
   */
  function keyMask(img, key, tol, edge, o = {}) {
    const { w, h, data } = img, n = w * h;
    const connected = o.connected !== false;
    // keys: the picked colour; edge mode: a checker grid's two colours instead (when the picked one is one of them or
    // between them), or a second colour far from the picked one
    let keys = [key];
    if (connected) {
      const bk = borderKeys(img), near = c => Math.hypot(c[0] - key[0], c[1] - key[1], c[2] - key[2]);
      if (bk && Math.min(near(bk[0]), near(bk[1])) <= Math.hypot(bk[0][0] - bk[1][0], bk[0][1] - bk[1][1], bk[0][2] - bk[1][2])) keys = bk;
      else { const k2 = secondKey(img, key, tol); if (k2) keys = [key, k2]; }
    }
    const dist = new Float32Array(n);
    for (let p = 0; p < n; p++) { let d = cdist(data, p * 4, keys[0]); if (keys[1]) d = Math.min(d, cdist(data, p * 4, keys[1])); dist[p] = d; }
    let fill = tol, peel = tol + edge;
    const grey = Math.max(...key) - Math.min(...key) < 60;
    if (connected && grey) {
      // the background's noise: the 95th percentile of the border's background-like pixels
      const b = [];
      for (let x = 0; x < w; x++) for (const y of [0, h - 1]) if (dist[y * w + x] <= tol) b.push(dist[y * w + x]);
      for (let y = 0; y < h; y++) for (const x of [0, w - 1]) if (dist[y * w + x] <= tol) b.push(dist[y * w + x]);
      b.sort((x, y) => x - y);
      const noise = b.length ? b[Math.floor(b.length * 0.95)] : 0;
      fill = Math.max(12, Math.min(tol, noise * 1.6 + 10));
      peel = fill + edge * fill / tol;
    }
    const lines = o.borders !== false ? borderLines(img, keys, tol) : null;
    const bgLike = p => dist[p] <= fill || (lines && lines[p]);
    const mask = new Uint8Array(n).fill(1);
    if (connected) {
      const q = new Int32Array(n);
      let head = 0, tail = 0;
      const seed = p => { if (mask[p] && bgLike(p)) { mask[p] = 0; q[tail++] = p; } };
      for (let x = 0; x < w; x++) { seed(x); seed((h - 1) * w + x); }
      for (let y = 0; y < h; y++) { seed(y * w); seed(y * w + w - 1); }
      if (lines) for (let p = 0; p < n; p++) if (lines[p]) seed(p);
      while (head < tail) {
        const p = q[head++], x = p % w;
        if (x > 0) seed(p - 1);
        if (x < w - 1) seed(p + 1);
        if (p >= w) seed(p - w);
        if (p < n - w) seed(p + w);
      }
    } else for (let p = 0; p < n; p++) mask[p] = bgLike(p) ? 0 : 1;
    for (let pass = 0; pass < 2; pass++) {
      const kill = [];
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const p = y * w + x;
        if (!mask[p] || dist[p] > peel) continue;
        if ((x > 0 && !mask[p - 1]) || (x < w - 1 && !mask[p + 1]) || (y > 0 && !mask[p - w]) || (y < h - 1 && !mask[p + w])) kill.push(p);
      }
      for (const p of kill) mask[p] = 0;
    }
    if (o.marks !== false) dropCornerMarks(mask, w, h);
    return mask;
  }

  /**
   * Despill: on foreground pixels within 3px of the background, pull the key's dominant channel
   * (green for a green screen) down toward the larger of the other two. strength 0..1. Returns a copy.
   */
  function despill(img, mask, key, strength) {
    const out = { w: img.w, h: img.h, data: new Uint8ClampedArray(img.data) };
    const lo = Math.min(...key), hot = [0, 1, 2].filter(k => key[k] - lo >= 100);
    const near = nearBackground(mask, img.w, img.h, 3), d = out.data;
    if (strength > 0 && hot.length === 2) {
      // two-channel key (magenta = red + blue, cyan, yellow): pull both down toward the third channel
      const o = [0, 1, 2].find(k => !hot.includes(k));
      for (let p = 0; p < mask.length; p++) {
        if (!mask[p] || !near[p]) continue;
        const i = p * 4, m = Math.min(d[i + hot[0]], d[i + hot[1]]), lim = d[i + o];
        if (m > lim) { const s = (m - lim) * strength; d[i + hot[0]] -= s; d[i + hot[1]] -= s; }
      }
      return out;
    }
    const c = key.indexOf(Math.max(...key)), o = [0, 1, 2].filter(k => k !== c);
    if (strength <= 0 || key[c] - Math.max(key[o[0]], key[o[1]]) < 40) return out; // grey/white key: nothing to pull
    for (let p = 0; p < mask.length; p++) {
      if (!mask[p] || !near[p]) continue;
      const i = p * 4, lim = Math.max(d[i + o[0]], d[i + o[1]]);
      if (d[i + c] > lim) d[i + c] -= (d[i + c] - lim) * strength;
    }
    return out;
  }

  /**
   * Smooth art: soft edge. Foreground pixels within 2px of the background get an alpha from their distance to the
   * key colour (tol * 0.6 → 0, tol * 2.2 → 1) and the key colour un-mixed from their colour, so a soft-painted
   * outline keeps its anti-aliasing without a coloured fringe. Everything else is opaque. Returns a copy.
   */
  // neutral: an un-mixed edge colour that ends up tinted AWAY from the key (magenta key -> green) is turned grey at its
  // own brightness: thin lines (bow strings, hair strands) otherwise come out bright green after un-mixing.
  function softKey(img, mask, key, tol, neutral = false) {
    const km = (key[0] + key[1] + key[2]) / 3, kv = [key[0] - km, key[1] - km, key[2] - km], kn = Math.hypot(...kv) || 1;
    const out = { w: img.w, h: img.h, data: new Uint8ClampedArray(img.data) }, d = out.data;
    const near = nearBackground(mask, img.w, img.h, 2), lo = tol * 0.6, hi = tol * 2.2;
    for (let p = 0; p < mask.length; p++) {
      const i = p * 4;
      if (!mask[p]) { d[i + 3] = 0; continue; }
      if (!near[p]) { d[i + 3] = 255; continue; }
      const a = Math.max(0.08, Math.min(1, (cdist(img.data, i, key) - lo) / (hi - lo)));
      for (let c = 0; c < 3; c++) d[i + c] = (img.data[i + c] - (1 - a) * key[c]) / a;
      if (neutral) {
        const m = (d[i] + d[i + 1] + d[i + 2]) / 3, v = [d[i] - m, d[i + 1] - m, d[i + 2] - m], n = Math.hypot(...v);
        if (n > 20 && (v[0] * kv[0] + v[1] * kv[1] + v[2] * kv[2]) / (n * kn) < -0.8) d[i] = d[i + 1] = d[i + 2] = Math.round(m * 0.8);
      }
      d[i + 3] = Math.round(a * 255);
    }
    return out;
  }

  /**
   * Smooth art: scale one frame by 1/p with the browser's high-quality resampling (premultiplied alpha, so no dark
   * or key-coloured fringe), no pixel grid, no palette. Same result shape as downscale().
   */
  function smoothScale(img, owns, box, p) {
    const { w, data } = img, { x: x0, y: y0, w: bw, h: bh } = box;
    const a = document.createElement('canvas');
    a.width = bw; a.height = bh;
    const g = a.getContext('2d'), id = g.createImageData(bw, bh);
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
      const s = (y0 + y) * w + x0 + x;
      if (!owns(s)) continue;
      id.data.set(data.subarray(s * 4, s * 4 + 4), (y * bw + x) * 4);
    }
    g.putImageData(id, 0, 0);
    let c = a, cw = bw, ch = bh;
    const W = Math.max(1, Math.round(bw / p)), H = Math.max(1, Math.round(bh / p));
    while (cw / 2 >= W && ch / 2 >= H) {   // halve first: one big drawImage step aliases thin lines
      const n = document.createElement('canvas');
      n.width = cw = Math.round(cw / 2); n.height = ch = Math.round(ch / 2);
      const ng = n.getContext('2d');
      ng.imageSmoothingQuality = 'high';
      ng.drawImage(c, 0, 0, cw, ch);
      c = n;
    }
    const o = document.createElement('canvas');
    o.width = W; o.height = H;
    const og = o.getContext('2d');
    og.imageSmoothingQuality = 'high';
    og.drawImage(c, 0, 0, W, H);
    const t = trim({ w: W, h: H, data: og.getImageData(0, 0, W, H).data });
    t.sx = x0 + (t.tx || 0) * (bw / W); t.sy = y0 + (t.ty || 0) * (bh / H); t.p = p;
    return t;
  }

  /** Connected regions (8-neighbour) of the mask. comps[k] has id k+1, area and bounding box. */
  function components(mask, w, h) {
    const labels = new Int32Array(w * h), stack = new Int32Array(w * h), comps = [];
    for (let s = 0; s < w * h; s++) {
      if (!mask[s] || labels[s]) continue;
      const id = comps.length + 1, c = { id, area: 0, x0: w, y0: h, x1: -1, y1: -1 };
      let sp = 0;
      stack[sp++] = s; labels[s] = id;
      while (sp) {
        const p = stack[--sp], x = p % w, y = (p / w) | 0;
        c.area++;
        if (x < c.x0) c.x0 = x; if (x > c.x1) c.x1 = x; if (y < c.y0) c.y0 = y; if (y > c.y1) c.y1 = y;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const q = ny * w + nx;
          if (mask[q] && !labels[q]) { labels[q] = id; stack[sp++] = q; }
        }
      }
      comps.push(c);
    }
    return { labels, comps };
  }

  /**
   * Frame boxes from connected regions: regions >= bodyFrac of the biggest are bodies (one frame each);
   * smaller pieces (effects, loose hair) join the body whose box is nearest; pieces < minPiece px are dropped.
   */
  function detectFrames(comps, { bodyFrac = 0.2, minPiece = 8 } = {}) {
    if (!comps.length) return [];
    const maxA = Math.max(...comps.map(c => c.area));
    const bodies = comps.filter(c => c.area >= maxA * bodyFrac).map(c => ({ x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1 }));
    const gap = (a, b) => Math.max(0, a.x0 - b.x1, b.x0 - a.x1) * 4 + Math.max(0, a.y0 - b.y1, b.y0 - a.y1);
    for (const c of comps) {
      if (c.area >= maxA * bodyFrac || c.area < minPiece) continue;
      let best = bodies[0];
      for (const b of bodies) if (gap(c, b) < gap(c, best)) best = b;
      best.x0 = Math.min(best.x0, c.x0); best.y0 = Math.min(best.y0, c.y0);
      best.x1 = Math.max(best.x1, c.x1); best.y1 = Math.max(best.y1, c.y1);
    }
    return bodies.sort((a, b) => a.x0 - b.x0).map(b => ({ x: b.x0, y: b.y0, w: b.x1 - b.x0 + 1, h: b.y1 - b.y0 + 1 }));
  }

  /**
   * Fake-pixel size. AI "pixel art" is a small sprite upscaled by a non-integer factor p, so the distance between
   * two neighbouring colour edges along a row or column is (about) a whole multiple of p.
   *  1. Along every row and column inside the frames, find edges: local maxima of the colour step (> thr),
   *     placed at sub-pixel precision; record the gap to the previous edge on the same line.
   *  2. score(p) = mean of cos(2π·gap/p): near 1 when every gap is a multiple of p.
   *  3. p/2, p/3 score as well as p (every multiple of p is also a multiple of p/2), so take the LARGEST p whose
   *     score is within 5% of the best.
   * Returns candidates [{p, score}], best first (the other local maxima are offered as alternatives).
   */
  function detectPixelSize(img, mask, boxes, lo = 2, hi = 10, step = 0.02, thr = 60) {
    const { w, data } = img, gaps = [];
    const diff = (a, b) => Math.abs(data[a * 4] - data[b * 4]) + Math.abs(data[a * 4 + 1] - data[b * 4 + 1]) + Math.abs(data[a * 4 + 2] - data[b * 4 + 2]);
    const scan = (start, stride, n) => {   // one line of n pixels
      const d = new Float32Array(n - 1);
      for (let i = 0; i < n - 1; i++) {
        const a = start + i * stride, b = a + stride;
        d[i] = mask[a] && mask[b] ? diff(a, b) : -1;
      }
      let last = null;
      for (let i = 0; i < n - 1; i++) {
        if (d[i] < 0) { last = null; continue; }
        const l = i > 0 ? Math.max(0, d[i - 1]) : 0, r = i < n - 2 ? Math.max(0, d[i + 1]) : 0;
        if (d[i] <= thr || d[i] < l || d[i] <= r) continue;
        const pos = i + 1 + (r - l) / (l + d[i] + r);   // centre of a blurred edge
        if (last !== null && pos - last <= hi * 4) gaps.push(pos - last);
        last = pos;
      }
    };
    for (const b of boxes) {
      for (let y = b.y; y < b.y + b.h; y++) scan(y * w + b.x, 1, b.w);
      for (let x = b.x; x < b.x + b.w; x++) scan(b.y * w + x, w, b.h);
    }
    if (gaps.length < 50) return [];
    const ps = [], score = [];
    for (let p = lo; p <= hi + 1e-9; p += step) {
      let s = 0;
      for (const g of gaps) s += Math.cos(2 * Math.PI * g / p);
      ps.push(+p.toFixed(2)); score.push(s / gaps.length);
    }
    const best = Math.max(...score);
    let pick = 0;
    score.forEach((s, k) => { if (s >= best * 0.95) pick = k; });
    const out = [{ p: ps[pick], score: score[pick] }];
    const peaks = [];
    for (let k = 1; k < ps.length - 1; k++) if (score[k] > 0 && score[k] >= score[k - 1] && score[k] >= score[k + 1]) peaks.push({ p: ps[k], score: score[k] });
    peaks.sort((a, b) => b.score - a.score);
    for (const pk of peaks) {
      if (out.length === 4) break;
      if (out.every(o => Math.abs(o.p - pk.p) / o.p > 0.08)) out.push(pk);
    }
    return out;
  }

  /** Grid phase (0..p) that lines grid lines up with the strongest edges of a profile. */
  function gridPhase(prof, p) {
    let best = 0, bestS = -Infinity;
    for (let ph = 0; ph < p; ph += 0.05) {
      let s = 0;
      for (let x = 0; x < prof.length; x++) if (prof[x]) s += prof[x] * Math.cos(2 * Math.PI * (x + 1 - ph) / p);
      if (s > bestS) { bestS = s; best = ph; }
    }
    return best;
  }

  /**
   * Downscale one frame to its true pixel grid. Each p×p block becomes one pixel:
   *  - opaque only if most of the block is owned foreground (hard alpha),
   *  - colour = the MOST COMMON colour of the block (mode over 16-level colour bins, then the median inside the
   *    winning bin), never an average, so blended in-between edge colours disappear.
   * `owns(p)` says whether source pixel index p belongs to this frame. Result is trimmed to its opaque box.
   */
  function downscale(img, owns, box, p) {
    const { w, data } = img, { x: x0, y: y0, w: bw, h: bh } = box;
    const own = new Uint8Array(bw * bh);
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) own[y * bw + x] = owns((y0 + y) * w + x0 + x) ? 1 : 0;
    const L = (x, y) => { const i = ((y0 + y) * w + x0 + x) * 4; return data[i] + data[i + 1] + data[i + 2]; };
    const profX = new Float32Array(bw), profY = new Float32Array(bh);
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
      if (!own[y * bw + x]) continue;
      if (x < bw - 1 && own[y * bw + x + 1]) profX[x] += Math.abs(L(x + 1, y) - L(x, y));
      if (y < bh - 1 && own[(y + 1) * bw + x]) profY[y] += Math.abs(L(x, y + 1) - L(x, y));
    }
    const lines = (ph, len) => { const g = []; for (let v = ph - p * Math.ceil(ph / p); v < len; v += p) g.push(v); g.push(g[g.length - 1] + p); return g; };
    const gx = lines(gridPhase(profX, p), bw), gy = lines(gridPhase(profY, p), bh);
    const W = gx.length - 1, H = gy.length - 1, out = new Uint8ClampedArray(W * H * 4);
    const bins = new Map();
    for (let j = 0; j < H; j++) {
      const ya = Math.max(0, Math.round(gy[j])), yb = Math.min(bh, Math.round(gy[j + 1]));
      for (let i = 0; i < W; i++) {
        const xa = Math.max(0, Math.round(gx[i])), xb = Math.min(bw, Math.round(gx[i + 1]));
        if (yb <= ya || xb <= xa) continue;
        let n = 0;
        for (let y = ya; y < yb; y++) for (let x = xa; x < xb; x++) n += own[y * bw + x];
        if (n * 2 < (yb - ya) * (xb - xa)) continue;
        bins.clear();
        for (let y = ya; y < yb; y++) for (let x = xa; x < xb; x++) {
          if (!own[y * bw + x]) continue;
          const s = ((y0 + y) * w + x0 + x) * 4, key = (data[s] >> 4) << 8 | (data[s + 1] >> 4) << 4 | (data[s + 2] >> 4);
          let b = bins.get(key);
          if (!b) bins.set(key, b = []);
          b.push(s);
        }
        let win = null;
        for (const b of bins.values()) if (!win || b.length > win.length) win = b;
        const o = (j * W + i) * 4;
        for (let c = 0; c < 3; c++) out[o + c] = win.map(s => data[s + c]).sort((a, b) => a - b)[win.length >> 1];
        out[o + 3] = 255;
      }
    }
    const t = trim({ w: W, h: H, data: out });
    // where local pixel (0,0) sits in the source, so source rects (head boxes) can be mapped onto the result
    t.sx = x0 + gx[t.tx || 0]; t.sy = y0 + gy[t.ty || 0]; t.p = p;
    return t;
  }

  /** Crop to the opaque bounding box (tx, ty = where the crop started). */
  function trim(img) {
    const { w, h, data } = img;
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (data[(y * w + x) * 4 + 3]) {
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    if (x1 < 0) return blank();
    const W = x1 - x0 + 1, H = y1 - y0 + 1, out = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) out.set(data.subarray(((y + y0) * w + x0) * 4, ((y + y0) * w + x1 + 1) * 4), y * W * 4);
    return { w: W, h: H, data: out, tx: x0, ty: y0 };
  }

  /** Remove isolated edge pixels: opaque pixels with at most one opaque 8-neighbour. In place. */
  function removeLonePixels(img) {
    const { w, h, data } = img, kill = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (!data[(y * w + x) * 4 + 3]) continue;
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if ((dx || dy) && nx >= 0 && ny >= 0 && nx < w && ny < h && data[(ny * w + nx) * 4 + 3]) n++;
      }
      if (n <= 1) kill.push((y * w + x) * 4);
    }
    for (const i of kill) data[i] = data[i + 1] = data[i + 2] = data[i + 3] = 0;
    return kill.length;
  }

  /**
   * Palette of the dominant colours. Colours are grouped greedily (most frequent first; a colour within `radius`
   * of a group joins it and adds its count), then the n biggest groups win. Each group is represented by its most
   * frequent real colour (never an average), so small but distinct areas such as skin keep their own entry while
   * blur tones collapse into the main outline/fill colours.
   */
  function dominantPalette(images, n, radius = 60) {
    const count = new Map();
    for (const im of images) for (let i = 0; i < im.data.length; i += 4) {
      if (!im.data[i + 3]) continue;
      const k = im.data[i] << 16 | im.data[i + 1] << 8 | im.data[i + 2];
      count.set(k, (count.get(k) || 0) + 1);
    }
    const groups = [];   // { c: [r,g,b], n }
    const r2 = radius * radius;
    for (const [k, cnt] of [...count.entries()].sort((a, b) => b[1] - a[1])) {
      const c = [k >> 16, k >> 8 & 255, k & 255];
      let g = null, best = r2;
      for (const q of groups) { const d = dist2(c, q.c); if (d <= best) { best = d; g = q; } }
      if (g) g.n += cnt; else groups.push({ c, n: cnt });
    }
    return groups.sort((a, b) => b.n - a.n).slice(0, n).map(g => g.c);
  }

  const dist2 = (a, b) => {
    // weighted RGB distance: closer to how the eye judges colour difference than plain RGB
    const dr = a[0] - b[0], dg = a[1] - b[1], db = a[2] - b[2];
    return 2 * dr * dr + 4 * dg * dg + 3 * db * db;
  };

  /** Snap every opaque pixel to the nearest palette colour. In place. */
  function snapToPalette(img, pal) {
    if (!pal.length) return;
    const d = img.data, cache = new Map();
    for (let i = 0; i < d.length; i += 4) {
      if (!d[i + 3]) continue;
      const k = d[i] << 16 | d[i + 1] << 8 | d[i + 2];
      let c = cache.get(k);
      if (!c) {
        const px = [d[i], d[i + 1], d[i + 2]];
        c = pal[0];
        for (const q of pal) if (dist2(px, q) < dist2(px, c)) c = q;
        cache.set(k, c);
      }
      d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2];
    }
  }

  /** Median cut (used for GIF palettes over 255 colours). colors: array of [r,g,b]. */
  function medianCut(colors, n) {
    let boxes = [colors];
    while (boxes.length < n) {
      let bi = -1, best = 0, bc = 0;
      boxes.forEach((b, i) => {
        if (b.length < 2) return;
        for (let c = 0; c < 3; c++) {
          let mn = 255, mx = 0;
          for (const px of b) { if (px[c] < mn) mn = px[c]; if (px[c] > mx) mx = px[c]; }
          if (mx - mn > best) { best = mx - mn; bi = i; bc = c; }
        }
      });
      if (bi < 0) break;
      const b = boxes[bi].sort((p, q) => p[bc] - q[bc]), m = b.length >> 1;
      boxes.splice(bi, 1, b.slice(0, m), b.slice(m));
    }
    return boxes.map(b => [0, 1, 2].map(c => Math.round(b.reduce((s, px) => s + px[c], 0) / b.length)));
  }

  // ---------- pixel maps ----------
  // Edited frames are kept as Map(key → [r,g,b,a]) in frame-local coordinates (may be negative or beyond the
  // processed image, so pencil strokes can grow the sprite). key = K(x, y); neighbours are k±1 and k±4096.
  const K = (x, y) => ((y + 2048) << 12) | (x + 2048);
  const KX = k => (k & 4095) - 2048, KY = k => (k >> 12) - 2048;

  /** Pixels of an image with alpha >= minA, offset by (x0, y0). Values keep their alpha (soft edges of smooth art). */
  function mapFromImg(img, x0 = 0, y0 = 0, minA = 1) {
    const m = new Map();
    for (let y = 0; y < img.h; y++) for (let x = 0; x < img.w; x++) {
      const i = (y * img.w + x) * 4;
      if (img.data[i + 3] >= minA) m.set(K(x + x0, y + y0), [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]]);
    }
    return m;
  }

  /** Map → trimmed image plus the local position of its top-left pixel. null if empty. */
  function imgFromMap(m) {
    if (!m.size) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const k of m.keys()) { const x = KX(k), y = KY(k); if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    const w = x1 - x0 + 1, h = y1 - y0 + 1, data = new Uint8ClampedArray(w * h * 4);
    for (const [k, c] of m) data.set([c[0], c[1], c[2], c[3] || 255], ((KY(k) - y0) * w + KX(k) - x0) * 4);
    return { img: { w, h, data }, x0, y0 };
  }

  /** Connected groups (8-neighbour) of the keys in a map, biggest first. Each group is an array of keys. */
  function groups(m) {
    const seen = new Set(), out = [];
    for (const s of m.keys()) {
      if (seen.has(s)) continue;
      const g = [s];
      seen.add(s);
      for (let i = 0; i < g.length; i++) {
        const k = g[i];
        for (const d of [-4097, -4096, -4095, -1, 1, 4095, 4096, 4097]) {
          const q = k + d;
          if (m.has(q) && !seen.has(q)) { seen.add(q); g.push(q); }
        }
      }
      out.push(g);
    }
    return out.sort((a, b) => b.length - a.length);
  }

  /** Recolour the outer ring (pixels with a transparent 4-neighbour) of the main body to one colour. In place. */
  function outlineRing(m, col) {
    const body = groups(m)[0];
    if (!body) return;
    const ring = body.filter(k => !m.has(k - 1) || !m.has(k + 1) || !m.has(k - 4096) || !m.has(k + 4096));
    for (const k of ring) m.set(k, [col[0], col[1], col[2], 255]);
  }

  /**
   * Alignment anchor of a sprite image: feet = bottom row of the main body (largest connected part, so slash
   * effects and loose bits are ignored); body centre = median x of the body pixels in its lowest 30% (legs / hips,
   * steadier than a sword-swinging torso or flying hair). Returns {bx, by} in image pixels (pixel boundaries).
   */
  function bodyAnchor(img) {
    const body = groups(mapFromImg(img, 0, 0, 128))[0];
    if (!body) return { bx: img.w / 2, by: img.h };
    let y0 = Infinity, y1 = -Infinity;
    for (const k of body) { const y = KY(k); if (y < y0) y0 = y; if (y > y1) y1 = y; }
    const cut = y1 - (y1 - y0) * 0.3;
    const xs = body.filter(k => KY(k) >= cut).map(KX).sort((a, b) => a - b);
    return { bx: xs[xs.length >> 1] + 0.5, by: y1 + 1 };
  }

  /**
   * Head / torso anchor of the main body, for run and walk cycles: legs, arms and weapons are left out. In the upper 55%
   * of the body only the thick columns count (at least half as many pixels as the thickest one: the head and torso,
   * not a fist or a scabbard sticking out); tx / ty = their centre. by = the feet (bottom of the body), as bodyAnchor.
   */
  function torsoAnchor(img) {
    const body = groups(mapFromImg(img, 0, 0, 128))[0];
    if (!body) return { tx: img.w / 2, ty: img.h / 2, by: img.h };
    let y0 = Infinity, y1 = -Infinity;
    for (const k of body) { const y = KY(k); if (y < y0) y0 = y; if (y > y1) y1 = y; }
    const cut = y0 + (y1 - y0 + 1) * 0.55, cols = new Map();
    for (const k of body) {
      const y = KY(k);
      if (y >= cut) continue;
      const x = KX(k);
      if (!cols.has(x)) cols.set(x, []);
      cols.get(x).push(y);
    }
    let max = 0;
    for (const ys of cols.values()) max = Math.max(max, ys.length);
    let sx = 0, sy = 0, n = 0;
    for (const [x, ys] of cols) if (ys.length >= max * 0.5) for (const y of ys) { sx += x; sy += y; n++; }
    return n ? { tx: sx / n + 0.5, ty: sy / n + 0.5, by: y1 + 1 } : { tx: img.w / 2, ty: img.h / 2, by: y1 + 1 };
  }

  /** Magic wand: keys connected (4-neighbour) to `start` whose colour is within tol (RGB distance) of it. */
  function wand(m, start, tol) {
    const c0 = m.get(start);
    if (!c0) return [];
    const near = c => Math.hypot(c[0] - c0[0], c[1] - c0[1], c[2] - c0[2]) <= tol;
    const seen = new Set([start]), out = [start];
    for (let i = 0; i < out.length; i++) for (const d of [-1, 1, -4096, 4096]) {
      const q = out[i] + d, c = m.get(q);
      if (c && !seen.has(q) && near(c)) { seen.add(q); out.push(q); }
    }
    return out;
  }

  /**
   * Find the reference head (rect `ref` in source pixels) inside `box` at scales 0.8–1.2: template matching on the
   * keyed source (colour difference where both are foreground, a fixed penalty where only one is). Coarse grid
   * first, then a fine search around the best hit. Returns {s, x, y, w, h, cost}: s > 1 = this head is drawn bigger.
   * Only the upper 60% of the box is searched (heads are on top; crouching frames are just shorter).
   */
  function matchHead(img, mask, ref, box, src = img, srcMask = mask, yFrac = 0.6, sMin = 0.8, sMax = 1.2) {
    const { w, h, data } = img, T = [];
    for (let y = 0; y < ref.h; y += 3) for (let x = 0; x < ref.w; x += 3) {   // template: ref box of src (default: same image)
      const p = (ref.y + y) * src.w + ref.x + x;
      T.push(x, y, srcMask[p] ? 1 : 0, src.data[p * 4], src.data[p * 4 + 1], src.data[p * 4 + 2]);
    }
    const cost = (s, ox, oy) => {
      let c = 0;
      for (let i = 0; i < T.length; i += 6) {
        const X = Math.round(ox + T[i] * s), Y = Math.round(oy + T[i + 1] * s);
        if (X < 0 || Y < 0 || X >= w || Y >= h) { c += 300; continue; }
        const q = Y * w + X, fg = mask[q];
        if (T[i + 2] && fg) c += Math.abs(data[q * 4] - T[i + 3]) + Math.abs(data[q * 4 + 1] - T[i + 4]) + Math.abs(data[q * 4 + 2] - T[i + 5]);
        else if (T[i + 2] !== fg) c += 300;
      }
      return c / (T.length / 6);
    };
    let best = { cost: Infinity };
    const search = (s0, s1, ss, x0, x1, y0, y1, step) => {
      for (let s = s0; s <= s1 + 1e-9; s += ss) {
        const xe = Math.min(x1, box.x + box.w - ref.w * s + 4), ye = Math.min(y1, box.y + box.h * yFrac - ref.h * s + 4);
        for (let oy = y0; oy <= ye; oy += step) for (let ox = x0; ox <= xe; ox += step) {
          const c = cost(s, ox, oy);
          if (c < best.cost) best = { s, x: ox, y: oy, cost: c };
        }
      }
    };
    search(sMin, sMax, 0.04, box.x - 4, box.x + box.w, box.y - 4, box.y + box.h, 4);
    const b = best;
    search(b.s - 0.04, b.s + 0.04, 0.01, b.x - 4, b.x + 4, b.y - 4, b.y + 4, 1);
    return { ...best, s: +best.s.toFixed(2), w: Math.round(ref.w * best.s), h: Math.round(ref.h * best.s) };
  }

  /**
   * Fringe -> outline: foreground pixels next to the removed background whose colour leans toward the key colour
   * (the AI's blend of outline and background) take the most common dark (outline) colour around them, so no new
   * colours appear. Pixels with no dark neighbour within 6 px stay as they are. Returns a new image.
   */
  function fringeToOutline(img, mask, key) {
    const { w, h } = img, d = img.data, out = new Uint8ClampedArray(d);
    const km = (key[0] + key[1] + key[2]) / 3, kd = [key[0] - km, key[1] - km, key[2] - km];
    const kn = Math.hypot(...kd) || 1;
    const tint = i => { const m = (d[i] + d[i + 1] + d[i + 2]) / 3; return ((d[i] - m) * kd[0] + (d[i + 1] - m) * kd[1] + (d[i + 2] - m) * kd[2]) / kn; };
    const dark = i => Math.max(d[i], d[i + 1], d[i + 2]) < 145 && (d[i] + d[i + 1] + d[i + 2]) / 3 < 105;
    let fixed = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (!mask[p]) continue;
      let edge = false;
      for (let dy = -1; dy <= 1 && !edge; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx >= 0 && yy >= 0 && xx < w && yy < h && !mask[yy * w + xx]) { edge = true; break; }
      }
      if (!edge || tint(p * 4) <= 18) continue;
      for (let r = 1; r <= 6; r++) {
        const count = new Map();
        for (let yy = Math.max(0, y - r); yy <= Math.min(h - 1, y + r); yy++) for (let xx = Math.max(0, x - r); xx <= Math.min(w - 1, x + r); xx++) {
          const q = yy * w + xx, i = q * 4;
          if (!mask[q] || !dark(i) || tint(i) > 18) continue;
          const k = d[i] << 16 | d[i + 1] << 8 | d[i + 2];
          count.set(k, (count.get(k) || 0) + 1);
        }
        if (!count.size) continue;
        let best = 0, bn = -1;
        for (const [k, n] of count) if (n > bn) { best = k; bn = n; }
        out[p * 4] = best >> 16; out[p * 4 + 1] = best >> 8 & 255; out[p * 4 + 2] = best & 255;
        fixed++; break;
      }
    }
    return { w, h, data: out, fixed };
  }

  /**
   * Colour remap: every foreground pixel near a source colour (RGB distance <= tol) whose colour leans the same way
   * (its offset from grey points the same direction as the source's, cosine >= 0.92) is moved by (dst - src), so
   * its shading is kept. rules: [{ src: [r,g,b], dst: [r,g,b], tol, box: [x0, y0, x1, y1] (optional, source px) }].
   * Returns a new image (alpha kept).
   */
  function remapColors(img, mask, rules) {
    const d = img.data, out = new Uint8ClampedArray(d);
    const w = img.w;
    const prep = rules.map(r => { const m = (r.src[0] + r.src[1] + r.src[2]) / 3, v = r.src.map(c => c - m); return { ...r, v, n: Math.hypot(...v) || 1 }; });
    for (let p = 0, i = 0; i < d.length; p++, i += 4) {
      if (!mask[p] && !d[i + 3]) continue;
      const px = p % w, py = (p - px) / w;
      for (const r of prep) {
        if (r.box && (px < r.box[0] || py < r.box[1] || px >= r.box[2] || py >= r.box[3])) continue;   // only inside box [x0, y0, x1, y1]
        if (Math.hypot(d[i] - r.src[0], d[i + 1] - r.src[1], d[i + 2] - r.src[2]) > (r.tol || 60)) continue;
        const m = (d[i] + d[i + 1] + d[i + 2]) / 3, w = [d[i] - m, d[i + 1] - m, d[i + 2] - m], wn = Math.hypot(...w);
        if (!wn || (w[0] * r.v[0] + w[1] * r.v[1] + w[2] * r.v[2]) / (wn * r.n) < 0.92) continue;
        for (let c = 0; c < 3; c++) out[i + c] = d[i + c] + r.dst[c] - r.src[c];
        break;
      }
    }
    return { w: img.w, h: img.h, data: out };
  }

  /**
   * Key by hue: a foreground pixel whose colour leans toward the key's hue (offset from grey, cosine >= 0.95) by at least
   * `min` (length of that offset) becomes background. Catches dark / light shades of the key colour that the RGB
   * distance misses (shadowed gaps), while pastel and greyish colours stay. In place on the mask.
   */
  function keyByTint(img, mask, key, min) {
    const d = img.data, km = (key[0] + key[1] + key[2]) / 3, kv = [key[0] - km, key[1] - km, key[2] - km], kn = Math.hypot(...kv) || 1;
    for (let p = 0, i = 0; i < d.length; p++, i += 4) {
      if (!mask[p]) continue;
      const m = (d[i] + d[i + 1] + d[i + 2]) / 3, v = [d[i] - m, d[i + 1] - m, d[i + 2] - m], n = Math.hypot(...v);
      if (n >= min && (v[0] * kv[0] + v[1] * kv[1] + v[2] * kv[2]) / (n * kn) >= 0.95) mask[p] = 0;
    }
  }

  /** Key hue of a colour: cosine of its offset from grey to the key's offset, and that offset's length (tint strength). */
  function keyHue(key) {
    const km = (key[0] + key[1] + key[2]) / 3, kv = [key[0] - km, key[1] - km, key[2] - km], kn = Math.hypot(...kv) || 1;
    return (r, g, b) => { const m = (r + g + b) / 3, v0 = r - m, v1 = g - m, v2 = b - m, n = Math.hypot(v0, v1, v2);
      return { cos: n ? (v0 * kv[0] + v1 * kv[1] + v2 * kv[2]) / (n * kn) : 0, n, m }; };
  }

  /**
   * Keep enclosed key-coloured pockets inside translucent bodies (jelly, glass, ghosts). With the background keyed
   * everywhere (not only from the edges), a pocket = pixels the edge-connected key keeps but the all-over key removes.
   * A pocket whose centre lies inside band [top, bottom] (fractions of its body's height, from the body's top) is put
   * back (it is the body, tinted by the background behind it); pockets above / below (gaps between grass blades or
   * hair, between feet / puddle drops) stay keyed. In place on the mask; returns { kept, keyed } pocket counts.
   */
  function keepPockets(img, mask, key, tol, edge, band, o = {}) {
    const { w, h } = img, n = w * h;
    const me = keyMask(img, key, tol, edge, { ...o, connected: true });
    const { labels, comps } = components(me, w, h);
    const pocket = new Uint8Array(n);
    for (let p = 0; p < n; p++) if (me[p] && !mask[p]) pocket[p] = 1;
    const pc = components(pocket, w, h);
    const sum = new Map();
    for (let p = 0; p < n; p++) { const id = pc.labels[p]; if (!id) continue;
      const e = sum.get(id) || { y: 0, c: 0, body: labels[p] }; e.y += (p / w) | 0; e.c++; sum.set(id, e); }
    const keep = new Set();
    let kept = 0, keyed = 0;
    for (const [id, e] of sum) {
      const b = comps[e.body - 1], f = (e.y / e.c - b.y0) / Math.max(1, b.y1 - b.y0);
      if (f >= band[0] && f <= band[1]) { keep.add(id); kept++; } else keyed++;
    }
    for (let p = 0; p < n; p++) if (keep.has(pc.labels[p])) mask[p] = 1;
    return { kept, keyed };
  }

  /**
   * Key enclosed background pockets on a dark / grey background (a video on black): after the edge-connected key, every
   * enclosed region whose pixels are all within `dist` (RGB) of the key and that has >= `minArea` pixels is keyed too
   * (background seen through a gap: between the bow and the string, under an arm); smaller dark regions (pupils, deep
   * folds) stay. In place on the mask; returns the number of pockets keyed.
   */
  function keyPockets(img, mask, key, dist, minArea) {
    const { w, h, data } = img, n = w * h, cand = new Uint8Array(n);
    for (let p = 0; p < n; p++) if (mask[p] && Math.hypot(data[p * 4] - key[0], data[p * 4 + 1] - key[1], data[p * 4 + 2] - key[2]) <= dist) cand[p] = 1;
    const { labels, comps } = components(cand, w, h);
    const big = new Set(comps.filter(c => c.area >= minArea).map(c => c.id));
    for (let p = 0; p < n; p++) if (big.has(labels[p])) mask[p] = 0;
    return big.size;
  }

  /**
   * Retint: inside the body (not within `inset` px of the background), pixels tinted toward the key's hue (a translucent
   * body showing the background through it) get the hue of `to` at their own lightness: new = grey level m + the
   * target's offset from grey scaled by m / (target's grey level), blended by how key-tinted the pixel is
   * (cosine minCos..fullCos, tint strength minTint..fullTint). Returns a copy.
   */
  function retint(img, mask, key, o) {
    const out = { w: img.w, h: img.h, data: new Uint8ClampedArray(img.data) }, d = out.data;
    const hue = keyHue(key), to = o.to, tm = (to[0] + to[1] + to[2]) / 3 || 1, tv = to.map(c => c - tm);
    const minCos = o.minCos ?? 0.5, fullCos = o.fullCos ?? 0.8, minTint = o.minTint ?? 8, fullTint = o.fullTint ?? 30;
    const near = nearBackground(mask, img.w, img.h, o.inset ?? 3);
    const ramp = (x, a, b) => Math.max(0, Math.min(1, (x - a) / (b - a)));
    let changed = 0;
    for (let p = 0; p < mask.length; p++) {
      if (!mask[p] || near[p]) continue;
      const i = p * 4, t = hue(d[i], d[i + 1], d[i + 2]);
      const wgt = ramp(t.cos, minCos, fullCos) * ramp(t.n, minTint, fullTint);
      if (!wgt) continue;
      for (let c = 0; c < 3; c++) d[i + c] = d[i + c] + (t.m + tv[c] * t.m / tm - d[i + c]) * wgt;
      changed++;
    }
    out.changed = changed;
    return out;
  }

  return { keyHue, keepPockets, keyPockets, retint, guessKey, keyMask, despill, fringeToOutline, remapColors, keyByTint, softKey, smoothScale, components, detectFrames, detectPixelSize, matchHead, downscale, trim,
           removeLonePixels, dominantPalette, snapToPalette, medianCut, dist2, blank,
           K, KX, KY, mapFromImg, imgFromMap, groups, outlineRing, bodyAnchor, torsoAnchor, wand };
})();
