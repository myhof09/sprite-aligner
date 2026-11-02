// effects.js — effect sprites: code-drawn pixel effects, sheet import and pixel-exact transforms. No app state here.
// An effect asset is { name, frames: [canvas…], durations: [ms…] | null }.
'use strict';
const FX = (() => {
  const hexToRgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
  const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));

  /** n frames of size×size canvases with a pixel setter. */
  function frames(n, size, draw) {
    return Array.from({ length: n }, (_, f) => {
      const c = document.createElement('canvas');
      c.width = c.height = size;
      const g = c.getContext('2d');
      const put = (x, y, col) => {
        x = Math.round(x); y = Math.round(y);
        if (x < 0 || y < 0 || x >= size || y >= size) return;
        g.fillStyle = `rgb(${col[0]},${col[1]},${col[2]})`; g.fillRect(x, y, 1, 1);
      };
      draw(f, put);
      return c;
    });
  }

  /**
   * Built-in effects, drawn pixel by pixel (no anti-aliasing). color = main colour, size = radius in pixels.
   * Each frame's centre is the effect's anchor.
   */
  const BUILTIN = {
    slash: { label: '베기 궤적', make(col, s) {
      const hi = mix(col, [255, 255, 255], 0.6), S = 2 * s + 5, c = S / 2;
      const sweep = [50, 100, 130, 130], thick = [2, 3, 2, 1];
      return frames(4, S, (f, put) => {
        const a0 = -70 * Math.PI / 180, a1 = a0 + sweep[f] * Math.PI / 180;
        for (let a = a0; a <= a1; a += 0.5 / s) {
          const t = (a - a0) / (a1 - a0 || 1);           // the arc thins and fades toward its tail
          const th = Math.max(1, Math.round(thick[f] * (0.4 + t)));
          for (let r = s - th + 1; r <= s; r++) {
            if (f === 3 && (Math.round(a * s) + r) % 2) continue;   // last frame dithered (fading)
            put(c + Math.cos(a) * r, c + Math.sin(a) * r, r === s ? hi : col);
          }
        }
      });
    } },
    spark: { label: '타격 불꽃', make(col, s) {
      const hi = mix(col, [255, 255, 255], 0.7), S = 2 * s + 3, c = Math.floor(S / 2);
      const len = [0.35, 0.75, 1, 0.9], inner = [0, 0.15, 0.45, 0.7];
      return frames(4, S, (f, put) => {
        for (let d = 0; d < 8; d++) {
          const a = d * Math.PI / 4, L = s * len[f] * (d % 2 ? 0.6 : 1);
          for (let r = s * inner[f]; r <= L; r += 0.5) put(c + Math.cos(a) * r, c + Math.sin(a) * r, r < L * 0.5 ? hi : col);
        }
        if (f < 2) for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) put(c + dx - (f ? 0 : 0.5), c + dy - (f ? 0 : 0.5), hi);
      });
    } },
    dust: { label: '발 먼지', make(col, s) {
      const lo = mix(col, [0, 0, 0], 0.25), S = 2 * s + 5, c = S / 2;
      const rad = [0.25, 0.4, 0.5, 0.55], spread = [0.3, 0.5, 0.7, 0.85], rise = [0, 0.1, 0.2, 0.3];
      return frames(4, S, (f, put) => {
        for (const side of [-1, 0, 1]) {
          const cx = c + side * s * spread[f], cy = c + s * 0.4 - s * rise[f] - (side ? 0 : s * 0.1), r = s * rad[f] * (side ? 0.8 : 1);
          for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) {
            if (x * x + y * y > r * r) continue;
            if (f === 3 && (Math.round(x) + Math.round(y)) % 2) continue;
            put(cx + x, cy + y, y > r * 0.3 ? lo : col);
          }
        }
      });
    } },
    glint: { label: '칼날 반짝임', make(col, s) {
      const hi = mix(col, [255, 255, 255], 0.8), S = 2 * s + 3, c = Math.floor(S / 2);
      const len = [0.35, 1, 0.5];
      return frames(3, S, (f, put) => {
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) for (let r = 1; r <= s * len[f]; r++) put(c + dx * r, c + dy * r, r <= 1 ? hi : col);
        put(c, c, hi);
        if (f === 1) for (const [dx, dy] of [[1, 1], [-1, -1], [1, -1], [-1, 1]]) put(c + dx, c + dy, col);
      });
    } },
  };

  function builtin(type, color, size) {
    const b = BUILTIN[type];
    return { name: b.label, frames: b.make(hexToRgb(color), Math.max(3, Math.round(size))), durations: null };
  }

  /**
   * Cut a sheet into frames. Understands (in this order): frames[] with {x,y,w,h} or {frame:{x,y,w,h}}
   * (this tool, Aseprite/TexturePacker arrays), frames{} maps (Aseprite hash), or
   * frameWidth/frameHeight (+frameCount). Without meta: `count` equal frames in a row (1 = single image).
   */
  function fromSheet(img, meta, name, count = 1) {
    let rects = [], durations = null;
    if (meta) {
      const list = Array.isArray(meta.frames) ? meta.frames : meta.frames && typeof meta.frames === 'object' ? Object.values(meta.frames) : null;
      if (list && list.length && (list[0].frame || list[0].w)) {
        rects = list.map(f => f.frame || f);
        if (list.some(f => f.duration)) durations = list.map(f => f.duration || 100);
      } else if (meta.frameWidth && meta.frameHeight) {
        const fw = meta.frameWidth, fh = meta.frameHeight, cols = Math.max(1, Math.floor(img.width / fw));
        const n = meta.frameCount || cols * Math.max(1, Math.floor(img.height / fh));
        for (let i = 0; i < n; i++) rects.push({ x: (i % cols) * fw, y: Math.floor(i / cols) * fh, w: fw, h: fh });
      }
      if (Array.isArray(meta.durations)) durations = meta.durations;
    }
    if (!rects.length) {
      const fw = Math.floor(img.width / count);
      for (let i = 0; i < count; i++) rects.push({ x: i * fw, y: 0, w: fw, h: img.height });
    }
    const frames = rects.map(r => {
      const c = document.createElement('canvas');
      c.width = r.w; c.height = r.h;
      c.getContext('2d').drawImage(img, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
      return c;
    });
    return { name, frames, durations };
  }

  /**
   * Pixel-exact transform: integer scale (nearest neighbour), flip, rotation (exact for 90° steps; free angles are
   * sampled nearest-neighbour), then alpha snapped to fully on/off so no soft pixels appear.
   */
  function transform(src, { scale = 1, rot = 0, flip = false }) {
    const w = src.width * scale, h = src.height * scale, a = ((rot % 360) + 360) % 360 * Math.PI / 180;
    const cos = Math.abs(Math.cos(a)), sin = Math.abs(Math.sin(a));
    const W = Math.max(1, Math.round(w * cos + h * sin)), H = Math.max(1, Math.round(w * sin + h * cos));
    const out = document.createElement('canvas');
    out.width = W; out.height = H;
    const g = out.getContext('2d');
    // inverse mapping: each output pixel takes the source pixel under its centre
    const sd = src.getContext('2d').getImageData(0, 0, src.width, src.height).data, od = g.createImageData(W, H);
    const ca = Math.cos(-a), sa = Math.sin(-a);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const dx = x + 0.5 - W / 2, dy = y + 0.5 - H / 2;
      let u = (dx * ca - dy * sa + w / 2) / scale, v = (dx * sa + dy * ca + h / 2) / scale;
      if (flip) u = src.width - u;
      const sx = Math.floor(u), sy = Math.floor(v);
      if (sx < 0 || sy < 0 || sx >= src.width || sy >= src.height) continue;
      const i = (sy * src.width + sx) * 4, o = (y * W + x) * 4;
      if (sd[i + 3] < 128) continue;
      od.data.set([sd[i], sd[i + 1], sd[i + 2], 255], o);
    }
    g.putImageData(od, 0, 0);
    return out;
  }

  /** Frames → one horizontal strip (for saving assets in a project file). */
  function strip(frames) {
    const c = document.createElement('canvas');
    c.width = frames.reduce((s, f) => s + f.width, 0) || 1; c.height = Math.max(1, ...frames.map(f => f.height));
    const g = c.getContext('2d');
    let x = 0;
    for (const f of frames) { g.drawImage(f, x, 0); x += f.width; }
    return c;
  }

  return { BUILTIN, builtin, fromSheet, transform, strip };
})();
