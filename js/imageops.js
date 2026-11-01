// imageops.js — pure image functions, no DOM.
// An image is { w, h, data: Uint8ClampedArray RGBA }. Masks are Uint8Array (1 = foreground).
// Alpha is always hard: every output pixel is fully opaque or fully transparent.
'use strict';
const IO = (() => {
  const blank = () => ({ w: 0, h: 0, data: new Uint8ClampedArray(0) });

  /** Median colour of the image border: the usual chroma-key background. */
  function guessKey(img) {
    const { w, h, data } = img, ch = [[], [], []];
    const add = (x, y) => { const i = (y * w + x) * 4; for (let c = 0; c < 3; c++) ch[c].push(data[i + c]); };
    for (let x = 0; x < w; x += 2) { add(x, 0); add(x, h - 1); }
    for (let y = 0; y < h; y += 2) { add(0, y); add(w - 1, y); }
    return ch.map(a => a.sort((p, q) => p - q)[a.length >> 1]);
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

  /**
   * Chroma key. Background = colour distance to `key` <= tol. Then two passes peel the blended rim:
   * foreground pixels touching the background with distance <= tol + edge are removed too.
   */
  function keyMask(img, key, tol, edge) {
    const { w, h, data } = img, n = w * h;
    const dist = new Float32Array(n), mask = new Uint8Array(n);
    for (let p = 0; p < n; p++) {
      const i = p * 4, dr = data[i] - key[0], dg = data[i + 1] - key[1], db = data[i + 2] - key[2];
      dist[p] = Math.sqrt(dr * dr + dg * dg + db * db);
      mask[p] = dist[p] > tol ? 1 : 0;
    }
    for (let pass = 0; pass < 2; pass++) {
      const kill = [];
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const p = y * w + x;
        if (!mask[p] || dist[p] > tol + edge) continue;
        if ((x > 0 && !mask[p - 1]) || (x < w - 1 && !mask[p + 1]) || (y > 0 && !mask[p - w]) || (y < h - 1 && !mask[p + w])) kill.push(p);
      }
      for (const p of kill) mask[p] = 0;
    }
    return mask;
  }

  /**
   * Despill: on foreground pixels within 3px of the background, pull the key's dominant channel
   * (green for a green screen) down toward the larger of the other two. strength 0..1. Returns a copy.
   */
  function despill(img, mask, key, strength) {
    const out = { w: img.w, h: img.h, data: new Uint8ClampedArray(img.data) };
    const c = key.indexOf(Math.max(...key)), o = [0, 1, 2].filter(k => k !== c);
    if (strength <= 0 || key[c] - Math.max(key[o[0]], key[o[1]]) < 40) return out; // grey/white key: nothing to pull
    const near = nearBackground(mask, img.w, img.h, 3), d = out.data;
    for (let p = 0; p < mask.length; p++) {
      if (!mask[p] || !near[p]) continue;
      const i = p * 4, lim = Math.max(d[i + o[0]], d[i + o[1]]);
      if (d[i + c] > lim) d[i + c] -= (d[i + c] - lim) * strength;
    }
    return out;
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
    return trim({ w: W, h: H, data: out });
  }

  /** Crop to the opaque bounding box. */
  function trim(img) {
    const { w, h, data } = img;
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (data[(y * w + x) * 4 + 3]) {
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    if (x1 < 0) return blank();
    const W = x1 - x0 + 1, H = y1 - y0 + 1, out = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) out.set(data.subarray(((y + y0) * w + x0) * 4, ((y + y0) * w + x1 + 1) * 4), y * W * 4);
    return { w: W, h: H, data: out };
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

  /** Opaque pixels of an image, offset by (x0, y0). */
  function mapFromImg(img, x0 = 0, y0 = 0) {
    const m = new Map();
    for (let y = 0; y < img.h; y++) for (let x = 0; x < img.w; x++) {
      const i = (y * img.w + x) * 4;
      if (img.data[i + 3]) m.set(K(x + x0, y + y0), [img.data[i], img.data[i + 1], img.data[i + 2], 255]);
    }
    return m;
  }

  /** Map → trimmed image plus the local position of its top-left pixel. null if empty. */
  function imgFromMap(m) {
    if (!m.size) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const k of m.keys()) { const x = KX(k), y = KY(k); if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    const w = x1 - x0 + 1, h = y1 - y0 + 1, data = new Uint8ClampedArray(w * h * 4);
    for (const [k, c] of m) data.set([c[0], c[1], c[2], 255], ((KY(k) - y0) * w + KX(k) - x0) * 4);
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
    const body = groups(mapFromImg(img))[0];
    if (!body) return { bx: img.w / 2, by: img.h };
    let y0 = Infinity, y1 = -Infinity;
    for (const k of body) { const y = KY(k); if (y < y0) y0 = y; if (y > y1) y1 = y; }
    const cut = y1 - (y1 - y0) * 0.3;
    const xs = body.filter(k => KY(k) >= cut).map(KX).sort((a, b) => a - b);
    return { bx: xs[xs.length >> 1] + 0.5, by: y1 + 1 };
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

  return { guessKey, keyMask, despill, components, detectFrames, detectPixelSize, downscale, trim,
           removeLonePixels, dominantPalette, snapToPalette, medianCut, dist2, blank,
           K, KX, KY, mapFromImg, imgFromMap, groups, outlineRing, bodyAnchor, wand };
})();
