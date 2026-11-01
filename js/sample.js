// sample.js — draws a generic test strip that looks like AI "fake pixel" art: a little slime knight drawn at
// 48×30 true pixels, upscaled ×3.4 (uneven blocks), slightly blurred, with noise, on a green screen with uneven spacing,
// plus one detached slash arc. No game art is used.
'use strict';
const Sample = (() => {
  const C = { out: '#1c1830', body: '#4a7bd1', hi: '#9cc0f2', eye: '#f4f1e8', hilt: '#8a5a2b', blade: '#d6d9e2', fx: '#ffffff' };

  function frameArt({ sx, sy, ang, arc }) {
    const cv = document.createElement('canvas');
    cv.width = 48; cv.height = 30;
    const g = cv.getContext('2d');
    const put = (x, y, col) => { g.fillStyle = col; g.fillRect(x, y, 1, 1); };
    const a = 8 * sx, b = 8 * sy, cx = 13, cy = 28 - b;
    const inside = (x, y) => ((x + 0.5 - cx) / a) ** 2 + ((y + 0.5 - cy) / b) ** 2 <= 1;
    for (let y = 0; y < 30; y++) for (let x = 0; x < 30; x++) {
      if (!inside(x, y)) continue;
      const rim = !inside(x - 1, y) || !inside(x + 1, y) || !inside(x, y - 1) || !inside(x, y + 1);
      const shade = (x * 7 + y * 3) % 11 === 0 ? C.hi : C.body;   // sparse texture dots
      put(x, y, rim ? C.out : (x < cx - 1 && y < cy - 2 ? C.hi : shade));
    }
    for (const ex of [cx + 1, cx + 4]) { put(ex, Math.round(cy) - 2, C.out); put(ex, Math.round(cy) - 1, C.out); put(ex, Math.round(cy) - 3, C.eye); }
    // sword held at the right side
    const x0 = cx + a - 2, y0 = Math.round(cy + 1);
    for (let s = 0; s < 13; s++) {
      const x = Math.round(x0 + Math.cos(ang) * s), y = Math.round(y0 - Math.sin(ang) * s);
      put(x, y, s < 3 ? C.hilt : C.blade);
    }
    if (arc) for (let t = -1.1; t <= 1.1; t += 0.05) {  // detached slash arc in front of the blade
      const x = Math.round(x0 + 17 + Math.cos(t) * 4), y = Math.round(y0 - 3 + Math.sin(t) * 9);
      put(x, y, C.fx); put(x + 1, y, C.fx);
    }
    return cv;
  }

  function make() {
    const poses = [
      { sx: 1, sy: 1, ang: 0.5 }, { sx: 1.15, sy: 0.85, ang: 0.9 }, { sx: 0.9, sy: 1.12, ang: 0.2 },
      { sx: 1.08, sy: 0.94, ang: 0, arc: true }, { sx: 1, sy: 1, ang: -0.5 }, { sx: 1, sy: 1, ang: 0.5 },
    ];
    const S = 3.4, xs = [24, 190, 330, 500, 700, 850];   // uneven spacing on purpose
    const out = document.createElement('canvas');
    out.width = 1000; out.height = 200;
    const g = out.getContext('2d');
    g.fillStyle = '#28fa22'; g.fillRect(0, 0, out.width, out.height);
    // nearest-neighbour at a non-integer scale (uneven 3/4 px blocks) plus a slight blur: the typical AI look
    g.imageSmoothingEnabled = false;
    g.filter = 'blur(0.7px)';
    poses.forEach((p, i) => g.drawImage(frameArt(p), xs[i], 60 + (i % 2) * 6, 48 * S, 30 * S));
    g.filter = 'none';
    const id = g.getImageData(0, 0, out.width, out.height);
    for (let i = 0; i < id.data.length; i += 4) for (let c = 0; c < 3; c++) id.data[i + c] += (Math.random() - 0.5) * 14;
    g.putImageData(id, 0, 0);
    return out;
  }

  return { make };
})();
