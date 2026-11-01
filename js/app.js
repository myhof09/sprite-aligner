// app.js — state and UI of Sprite Aligner. Everything runs in the browser; images are never uploaded.
//
// Pipeline: source PNG → chroma-key mask + despill (keyed) → connected regions → frame boxes →
// per frame: downscale to the true pixel grid (block mode colour) → lone-pixel cleanup → `pre`
// → palette snap (shared over all frames, or per frame) → `base`
// → + hand edits (pencil / eraser / effect removal) → optional 1px outline → `img` (what is shown and exported)
// placed in an equal-size cell at (ox, oy) → sheet / meta / GIF export (+ left-facing and FX sheets).
//
// Frame-local coordinates: (0,0) is the top-left of `base`. `img` may start elsewhere (x0, y0) when edits grow
// or shrink the sprite; on screen it is drawn at cell position (ox + x0, oy + y0).
'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const { K, KX, KY } = IO;

  // ---------- state (everything a project file saves) ----------
  const S = {
    name: 'sprite', srcURL: '',
    key: [40, 250, 34], tol: 90, edge: 70, despill: 1,
    bodyFrac: 0.2, minPiece: 8,
    pixel: 4, colors: 24, sharedPalette: true, lone: false, outline: false, outlineColor: '#1c1830',
    cellW: 64, cellH: 64, pad: 2,
    guides: { base: 60, top: 4, weapon: 30, cx: 32 },
    snap: true, onion: true, grid: true, zoom: 6, pzoom: 3, loop: true,
    impact: 0, impactPoint: null,
    flipView: false, gameView: false, tile: 62, gameScale: 1,
    scope: 'cur', toFx: false, wandTol: 40, islandMax: 2000,
    gifScale: 4, gifBg: '#3a3e46', gifTransparent: false, exportLeft: false, batchAutoPixel: true,
    paintColor: '#ffffff',
    frames: [],   // { box:{x,y,w,h}, raw, dur, ox, oy, edits:Map, fx:Map } + derived pre, base, img, x0, y0, canvas, anchor, fxImg…
  };
  let src = null, srcCanvas = null;          // original image + canvas
  let keyed = null, mask = null, keyedCanvas = null;
  let labels = null, comps = [];             // connected regions of the mask
  let cur = 0, mode = 'select', tool = 'move', boxSel = new Set(), pixelCands = [];
  let selection = new Map();                 // frame → Set of local keys (pixels picked by wand / rect / lasso)
  let bgImg = null;                          // game background (not saved)

  const GUIDES = [
    { k: 'base', label: '발', color: '#ff5a5a', v: false },
    { k: 'top', label: '머리', color: '#5ad1ff', v: false },
    { k: 'weapon', label: '무기', color: '#ffd45a', v: false },
    { k: 'cx', label: '중심', color: '#7dff7d', v: true },
  ];

  const status = msg => { $('status').textContent = msg; };
  const tick = () => new Promise(r => setTimeout(r, 20));   // let the status text paint before heavy work
  const hexToRgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
  const rgbToHex = c => '#' + c.slice(0, 3).map(v => v.toString(16).padStart(2, '0')).join('');

  function toCanvas(img) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, img.w); c.height = Math.max(1, img.h);
    if (img.w && img.h) c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(img.data), img.w, img.h), 0, 0);
    return c;
  }

  // ---------- loading ----------
  async function loadImage(url) {
    const im = new Image();
    await new Promise((ok, fail) => { im.onload = ok; im.onerror = () => fail(new Error('이미지를 읽을 수 없습니다')); im.src = url; });
    const c = document.createElement('canvas');
    c.width = im.width; c.height = im.height;
    const g = c.getContext('2d');
    g.drawImage(im, 0, 0);
    return { canvas: c, img: { w: c.width, h: c.height, data: g.getImageData(0, 0, c.width, c.height).data } };
  }

  const readURL = file => new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(file); });
  const baseName = file => file.name.replace(/\.[^.]+$/, '');

  /** Open a PNG and run the whole automatic cleanup. opts.keepKey / opts.autoPixel are used by batch mode. */
  async function openSource(url, name, opts = {}) {
    status('불러오는 중…'); await tick();
    ({ canvas: srcCanvas, img: src } = await loadImage(url));
    S.srcURL = url;
    if (name) S.name = name;
    if (!opts.keepKey) S.key = IO.guessKey(src);
    syncInputs();
    await autoClean(opts.autoPixel !== false);
    openStep(3);
  }

  /** ② 자동 정리: background removal + frame detection + pixel size + palette + alignment. */
  async function autoClean(autoPixel = true) {
    if (!src) { status('먼저 ① 그림을 여세요.'); return; }
    status('배경 제거 · 프레임 찾기 · 픽셀 맞추기…'); await tick();
    rekey();
    detect(autoPixel);
    status(`자동 정리 완료: 프레임 ${S.frames.length}개 · AI 픽셀 ${S.pixel}px · 프레임 크기 ${S.cellW}×${S.cellH}. ③에서 다듬으세요.`);
  }

  // ---------- pipeline ----------
  function rekey() {
    mask = IO.keyMask(src, S.key, S.tol, S.edge);
    keyed = IO.despill(src, mask, S.key, S.despill);
    ({ labels, comps } = IO.components(mask, src.w, src.h));
    const view = { w: src.w, h: src.h, data: new Uint8ClampedArray(keyed.data) };
    for (let p = 0; p < mask.length; p++) view.data[p * 4 + 3] = mask[p] ? 255 : 0;   // hard alpha
    keyedCanvas = toCanvas(view);
  }

  const newFrame = (box, raw, dur = 100) => ({ box, raw, dur, ox: 0, oy: 0, edits: new Map(), fx: new Map() });

  function detect(autoPixel = true) {
    const boxes = IO.detectFrames(comps, { bodyFrac: S.bodyFrac, minPiece: S.minPiece });
    const old = S.frames;
    S.frames = boxes.map((box, i) => newFrame(box, false, old[i] ? old[i].dur : 100));
    boxSel.clear(); selection.clear(); cur = 0;
    undoStack.length = redoStack.length = 0;
    if (autoPixel) detectPixel();
    S.frames.forEach(prepFrame);
    applyPalettes();
    autoCell();
    render();
  }

  function detectPixel() {
    pixelCands = IO.detectPixelSize(keyed, mask, S.frames.map(f => f.box));
    if (pixelCands.length) S.pixel = pixelCands[0].p;
    syncInputs();
  }

  /** Which source pixels belong to frame f: auto boxes own whole regions centred inside them (so a neighbour's
   *  sword tip poking into the box is left out); hand-made (raw) boxes take every foreground pixel inside. */
  function ownerTest(f) {
    if (f.raw) return p => mask[p] === 1;
    const b = f.box, ok = new Set();
    for (const c of comps) {
      const x = (c.x0 + c.x1) / 2, y = (c.y0 + c.y1) / 2;
      if (x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h && c.area >= S.minPiece) ok.add(c.id);
    }
    return p => ok.has(labels[p]);
  }

  /** Downscale + lone-pixel cleanup (no palette yet). */
  function prepFrame(f) {
    f.pre = IO.downscale(keyed, ownerTest(f), f.box, S.pixel);
    if (S.lone) IO.removeLonePixels(f.pre);
  }

  /**
   * Palette snap for every frame. Shared palette (default) = the dominant colours of ALL frames together, so the
   * same cloth keeps the same colour in every frame (no flicker). If a frame's size changed, its hand edits no
   * longer line up and are dropped.
   */
  function applyPalettes() {
    const shared = S.colors > 0 && S.sharedPalette ? IO.dominantPalette(S.frames.map(f => f.pre), S.colors) : null;
    let lost = 0;
    for (const f of S.frames) {
      const base = { w: f.pre.w, h: f.pre.h, data: new Uint8ClampedArray(f.pre.data) };
      if (S.colors > 0) IO.snapToPalette(base, shared || IO.dominantPalette([f.pre], S.colors));
      if (f.base && (f.base.w !== base.w || f.base.h !== base.h)) {
        if (f.edits.size || f.fx.size) lost++;
        f.edits.clear(); f.fx.clear(); f.placed = false;
      }
      f.base = base;
      compose(f);
    }
    if (lost) status(`크기가 바뀐 프레임 ${lost}개의 손 수정은 지워졌습니다.`);
  }

  /** base + edits (+ outline) → img/canvas; fx map → fxImg/fxCanvas; alignment anchor. */
  function compose(f) {
    const m = IO.mapFromImg(f.base);
    for (const [k, v] of f.edits) v[3] ? m.set(k, v) : m.delete(k);
    if (S.outline) IO.outlineRing(m, hexToRgb(S.outlineColor));
    const r = IO.imgFromMap(m) || { img: { w: 1, h: 1, data: new Uint8ClampedArray(4) }, x0: 0, y0: 0 };
    f.img = r.img; f.x0 = r.x0; f.y0 = r.y0;
    f.canvas = toCanvas(f.img);
    f.anchor = IO.bodyAnchor(f.img);
    const q = IO.imgFromMap(f.fx);
    f.fxImg = q && q.img; f.fx0 = q ? q.x0 : 0; f.fy0 = q ? q.y0 : 0;
    f.fxCanvas = q ? toCanvas(q.img) : null;
  }

  /** Re-run frame processing (after key / pixel changes); frames whose size changed are re-placed. */
  async function reprocess(rekeyToo) {
    if (!src) return;
    status('처리 중…'); await tick();
    if (rekeyToo) rekey();
    S.frames.forEach(prepFrame);
    repalette();
    status(`프레임 ${S.frames.length}개 · AI 픽셀 ${S.pixel}px`);
  }

  function repalette() {
    if (!S.frames.length) return;
    applyPalettes();
    fitCell();
    S.frames.forEach(f => { if (!f.placed) autoPlace(f); });
    render();
  }

  function recomposeAll() { S.frames.forEach(compose); render(); }

  // ---------- cell & placement ----------
  /** Cell big enough for every frame aligned on its anchor (+ padding); guides: feet line, centre line. */
  function autoCell() {
    if (!S.frames.length) return;
    const L = Math.ceil(Math.max(...S.frames.map(f => f.anchor.bx))), R = Math.ceil(Math.max(...S.frames.map(f => f.img.w - f.anchor.bx)));
    const U = Math.max(...S.frames.map(f => f.anchor.by)), D = Math.max(...S.frames.map(f => f.img.h - f.anchor.by));
    S.cellW = L + R + 2 * S.pad; S.cellH = U + D + 2 * S.pad;
    S.guides = { base: S.pad + U, top: S.pad, weapon: Math.round(S.cellH * 0.45), cx: S.pad + L };
    S.frames.forEach(autoPlace);
    // zooms that fit the editor / preview panels
    const fit = (el, lo, hi) => Math.max(lo, Math.min(hi, Math.floor(Math.min((el.clientWidth - 16) / S.cellW, (el.clientHeight - 16) / S.cellH))));
    S.zoom = fit($('editorWrap'), 1, 16);
    S.pzoom = fit($('preview').parentElement, 1, 10);
    syncInputs();
  }

  /** Grow the cell if a frame no longer fits (keeps guides and positions). */
  function fitCell() {
    const mw = Math.max(1, ...S.frames.map(f => f.img.w)), mh = Math.max(1, ...S.frames.map(f => f.img.h));
    if (mw + 2 * S.pad > S.cellW || mh + 2 * S.pad > S.cellH) {
      S.cellW = Math.max(S.cellW, mw + 2 * S.pad); S.cellH = Math.max(S.cellH, mh + 2 * S.pad);
      syncInputs();
    }
  }

  /** Auto-align suggestion: feet of the main body on the baseline, body centre (legs) on the centre line. */
  function autoPlace(f) {
    f.ox = Math.round(S.guides.cx - f.anchor.bx) - f.x0;
    f.oy = S.guides.base - f.anchor.by - f.y0;
    f.placed = true;
  }

  function snapFrame(f) {
    const g = S.guides, t = 3, left = f.ox + f.x0, top = f.oy + f.y0;
    if (Math.abs(top + f.anchor.by - g.base) <= t) f.oy = g.base - f.anchor.by - f.y0;
    else if (Math.abs(top - g.top) <= t) f.oy = g.top - f.y0;
    if (Math.abs(left + f.anchor.bx - g.cx) <= t) f.ox = Math.round(g.cx - f.anchor.bx) - f.x0;
  }

  // ---------- undo / redo (positions, edits, FX, frame list, impact) ----------
  const undoStack = [], redoStack = [];
  const snapshot = () => ({
    frames: S.frames.map(f => ({ f, ox: f.ox, oy: f.oy, edits: new Map(f.edits), fx: new Map(f.fx) })),
    impact: S.impact, impactPoint: S.impactPoint, cur,
  });
  function pushUndo() { undoStack.push(snapshot()); if (undoStack.length > 100) undoStack.shift(); redoStack.length = 0; }
  function restore(s) {
    S.frames = s.frames.map(e => { Object.assign(e.f, { ox: e.ox, oy: e.oy, edits: new Map(e.edits), fx: new Map(e.fx) }); compose(e.f); return e.f; });
    S.impact = s.impact; S.impactPoint = s.impactPoint; cur = s.cur;
    selection.clear(); render();
  }
  function undo() { if (undoStack.length) { redoStack.push(snapshot()); restore(undoStack.pop()); } }
  function redo() { if (redoStack.length) { undoStack.push(snapshot()); restore(redoStack.pop()); } }

  // ---------- drawing ----------
  function checker(g, w, h, q) {
    g.fillStyle = '#2b2f37'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#33373f';
    for (let y = 0; y < h; y += q) for (let x = (y / q) % 2 ? q : 0; x < w; x += 2 * q) g.fillRect(x, y, q, q);
  }

  function drawGrid(g, z, cw, ch) {
    if (z < 4) return;
    g.strokeStyle = 'rgba(255,255,255,0.07)'; g.lineWidth = 1;
    g.beginPath();
    for (let x = 0; x <= cw; x++) { g.moveTo(x * z + 0.5, 0); g.lineTo(x * z + 0.5, ch * z); }
    for (let y = 0; y <= ch; y++) { g.moveTo(0, y * z + 0.5); g.lineTo(cw * z, y * z + 0.5); }
    g.stroke();
  }

  function drawGuides(g, z, labels) {
    const W = S.cellW * z, H = S.cellH * z, t = z >= 4 ? 2 : 1;
    g.font = '10px system-ui';
    for (const gd of GUIDES) {
      const v = S.guides[gd.k] * z;
      g.fillStyle = gd.color;
      if (gd.v) g.fillRect(v - (t >> 1), 0, t, H); else g.fillRect(0, v - (t >> 1), W, t);
      if (labels) gd.v ? g.fillText(gd.label, v + 3, 10) : g.fillText(gd.label, 2, v - 3);
    }
  }

  function drawImpactPoint(g, z, strong) {
    const p = S.impactPoint;
    if (!p) return;
    const x = (p.x + 0.5) * z, y = (p.y + 0.5) * z, r = Math.max(4, z * 1.5);
    g.strokeStyle = strong ? '#ff3b6b' : 'rgba(255,59,107,0.4)'; g.lineWidth = 2;
    g.beginPath(); g.arc(x, y, r, 0, 7); g.moveTo(x - r * 1.6, y); g.lineTo(x + r * 1.6, y); g.moveTo(x, y - r * 1.6); g.lineTo(x, y + r * 1.6); g.stroke();
  }

  const blitFrame = (g, f, z, a = 1) => {
    if (!f) return;
    g.globalAlpha = a;
    g.drawImage(f.canvas, (f.ox + f.x0) * z, (f.oy + f.y0) * z, f.canvas.width * z, f.canvas.height * z);
    g.globalAlpha = 1;
  };

  /** Draw frame i in its cell at zoom z onto canvas cv. */
  function drawCell(cv, z, i, { onion = false, guides = true, grid = false, labels = false, fx = false, sel = false } = {}) {
    const W = S.cellW * z, H = S.cellH * z;
    if (cv.width !== W) cv.width = W;
    if (cv.height !== H) cv.height = H;
    const g = cv.getContext('2d');
    g.imageSmoothingEnabled = false;
    checker(g, W, H, Math.max(8, z * 4));
    const n = S.frames.length, f = S.frames[i];
    if (onion && n > 1) { blitFrame(g, S.frames[(i - 1 + n) % n], z, 0.25); if (n > 2) blitFrame(g, S.frames[(i + 1) % n], z, 0.25); }
    blitFrame(g, f, z);
    if (fx && f && f.fxCanvas) { g.globalAlpha = 0.45; g.drawImage(f.fxCanvas, (f.ox + f.fx0) * z, (f.oy + f.fy0) * z, f.fxCanvas.width * z, f.fxCanvas.height * z); g.globalAlpha = 1; }
    if (sel && f && selection.has(f)) {
      g.fillStyle = 'rgba(255,60,200,0.6)';
      for (const k of selection.get(f)) g.fillRect((f.ox + KX(k)) * z, (f.oy + KY(k)) * z, z, z);
    }
    if (grid) drawGrid(g, z, S.cellW, S.cellH);
    if (guides) drawGuides(g, z, labels);
    g.strokeStyle = '#555b68'; g.lineWidth = 1; g.strokeRect(0.5, 0.5, W - 1, H - 1);
    return g;
  }

  /** Frame i composited into one cell (with FX), optionally mirrored: used by preview and export. */
  function cellCanvas(i, { flip = false, fx = true, main = true } = {}) {
    const c = document.createElement('canvas');
    c.width = S.cellW; c.height = S.cellH;
    const g = c.getContext('2d'), f = S.frames[i];
    if (flip) { g.translate(S.cellW, 0); g.scale(-1, 1); }
    if (main) g.drawImage(f.canvas, f.ox + f.x0, f.oy + f.y0);
    if (fx && f.fxCanvas) g.drawImage(f.fxCanvas, f.ox + f.fx0, f.oy + f.fy0);
    return c;
  }

  let dispScale = 1;
  function drawSource() {
    const cv = $('src');
    if (!src) { cv.width = cv.height = 0; return; }
    dispScale = Math.min(1, ($('srcWrap').clientWidth - 14) / src.w);
    cv.width = Math.round(src.w * dispScale); cv.height = Math.round(src.h * dispScale);
    const g = cv.getContext('2d');
    if ($('showKeyed').checked) { checker(g, cv.width, cv.height, 8); g.drawImage(keyedCanvas, 0, 0, cv.width, cv.height); }
    else g.drawImage(srcCanvas, 0, 0, cv.width, cv.height);
    g.font = '12px system-ui';
    S.frames.forEach((f, i) => {
      const b = f.box, s = dispScale;
      g.strokeStyle = boxSel.has(i) ? '#ffd45a' : i === cur ? '#5aa9ff' : '#ff4fd8';
      g.lineWidth = boxSel.has(i) || i === cur ? 2 : 1;
      g.strokeRect(b.x * s + 0.5, b.y * s + 0.5, b.w * s, b.h * s);
      g.fillStyle = g.strokeStyle; g.fillText('#' + i + (f.raw ? '*' : ''), b.x * s + 2, b.y * s - 3);
    });
    if (drag) {
      g.strokeStyle = '#fff'; g.setLineDash([4, 3]);
      g.strokeRect(drag.x0 * dispScale, drag.y0 * dispScale, (drag.x1 - drag.x0) * dispScale, (drag.y1 - drag.y0) * dispScale);
      g.setLineDash([]);
    }
    $('srcInfo').textContent = `${src.w}×${src.h} · 배경 rgb(${S.key.join(',')})`;
  }

  function drawEditor() {
    if (!S.frames.length) { $('editor').width = 0; $('frameInfo').textContent = ''; return; }
    const g = drawCell($('editor'), S.zoom, cur, { onion: S.onion, grid: S.grid, labels: true, fx: true, sel: true });
    drawImpactPoint(g, S.zoom, cur === S.impact);
    if (ed && ed.shape) {   // rect / lasso in progress
      const z = S.zoom;
      g.strokeStyle = '#fff'; g.setLineDash([4, 3]); g.lineWidth = 1;
      g.beginPath();
      if (ed.shape === 'rect') g.rect(ed.x0 * z, ed.y0 * z, (ed.x1 - ed.x0) * z, (ed.y1 - ed.y0) * z);
      else ed.pts.forEach((p, j) => j ? g.lineTo(p[0] * z, p[1] * z) : g.moveTo(p[0] * z, p[1] * z));
      g.stroke(); g.setLineDash([]);
    }
    const f = S.frames[cur], ns = selection.has(f) ? selection.get(f).size : 0;
    $('frameInfo').textContent = `#${cur} · 위치 (${f.ox + f.x0}, ${f.oy + f.y0}) · 크기 ${f.img.w}×${f.img.h} · ${f.dur}ms`
      + (cur === S.impact ? ' · ★임팩트' : '') + (f.fx.size ? ` · FX ${f.fx.size}px` : '') + (ns ? ` · 선택 ${ns}px` : '');
  }

  let playing = false, pIdx = 0, pTimer = 0;
  function drawPreview() {
    if (!S.frames.length) return;
    const i = playing ? pIdx : cur, cv = $('preview');
    if (S.gameView) return drawGame(i);
    const z = S.pzoom, W = S.cellW * z, H = S.cellH * z;
    if (cv.width !== W) cv.width = W;
    if (cv.height !== H) cv.height = H;
    const g = cv.getContext('2d');
    g.imageSmoothingEnabled = false;
    checker(g, W, H, Math.max(8, z * 4));
    g.drawImage(cellCanvas(i, { flip: S.flipView }), 0, 0, W, H);
    if (S.grid) drawGrid(g, z, S.cellW, S.cellH);
    if (i === S.impact) {
      g.fillStyle = '#ffd45a'; g.font = '12px system-ui'; g.fillText('★', 4, 14);
      if (S.impactPoint && !S.flipView) drawImpactPoint(g, z, true);
    }
  }

  /** In-game size: the sprite at game scale over a tile grid (tile = S.tile px) and the chosen background. */
  function drawGame(i) {
    const T = S.tile, z = S.pzoom, cols = 5, rows = 3, W = cols * T, H = rows * T, cv = $('preview');
    cv.width = W * z; cv.height = H * z;
    const g = cv.getContext('2d');
    g.imageSmoothingEnabled = false;
    g.save(); g.scale(z, z);
    if (bgImg) { g.fillStyle = g.createPattern(bgImg, 'repeat'); g.fillRect(0, 0, W, H); }
    else for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) { g.fillStyle = (r + c) % 2 ? '#3d5a3a' : '#456842'; g.fillRect(c * T, r * T, T, T); }
    g.strokeStyle = 'rgba(0,0,0,0.3)'; g.lineWidth = 1 / z;
    for (let c = 0; c <= cols; c++) { g.beginPath(); g.moveTo(c * T, 0); g.lineTo(c * T, H); g.stroke(); }
    for (let r = 0; r <= rows; r++) { g.beginPath(); g.moveTo(0, r * T); g.lineTo(W, r * T); g.stroke(); }
    const s = S.gameScale, px = S.flipView ? S.cellW - S.guides.cx : S.guides.cx;
    // pivot (centre line, feet) on the bottom centre of the middle tile
    g.drawImage(cellCanvas(i, { flip: S.flipView }), 2.5 * T - px * s, 2 * T - S.guides.base * s, S.cellW * s, S.cellH * s);
    g.restore();
    g.fillStyle = '#fff'; g.font = '11px system-ui';
    g.fillText(`칸 ${T}px · 배율 ${s}`, 4, cv.height - 5);
  }

  /** Before (source crop, scaled so one AI pixel ≈ 8 screen px) next to after (true pixels at 8×). */
  function drawCompare() {
    const f = S.frames[cur], b4 = $('before'), af = $('after');
    if (!f || !srcCanvas) return;
    const s = 8 / S.pixel, b = f.box;
    b4.width = Math.round(b.w * s); b4.height = Math.round(b.h * s);
    const g = b4.getContext('2d');
    g.imageSmoothingEnabled = false;
    g.drawImage(srcCanvas, b.x, b.y, b.w, b.h, 0, 0, b4.width, b4.height);
    af.width = f.canvas.width * 8; af.height = f.canvas.height * 8;
    const h = af.getContext('2d');
    h.imageSmoothingEnabled = false;
    checker(h, af.width, af.height, 16);
    h.drawImage(f.canvas, 0, 0, af.width, af.height);
    if (S.grid) drawGrid(h, 8, f.canvas.width, f.canvas.height);
  }

  // ---------- film strip: thumbnails, durations, impact ★, duplicate / reorder / delete ----------
  let thumbs = [];
  function buildStrip() {
    const el = $('strip');
    el.innerHTML = '';
    const btn = (txt, title, fn) => { const b = document.createElement('button'); b.textContent = txt; b.title = title; b.onclick = e => { e.stopPropagation(); fn(); }; return b; };
    thumbs = S.frames.map((f, i) => {
      const d = document.createElement('div');
      d.className = 'thumb' + (i === cur ? ' cur' : '');
      const c = document.createElement('canvas');
      const lbl = document.createElement('div');
      lbl.className = 'lbl';
      const star = btn(i === S.impact ? '★' : '☆', '임팩트(타격) 프레임으로 지정', () => { pushUndo(); S.impact = i; render(); });
      star.className = 'star' + (i === S.impact ? ' on' : '');
      lbl.append(Object.assign(document.createElement('span'), { textContent: `#${i}` }), star);
      const inp = document.createElement('input');
      inp.type = 'number'; inp.min = 10; inp.step = 10; inp.value = f.dur; inp.title = '프레임 시간 (ms)';
      inp.onchange = () => { f.dur = Math.max(10, Math.round(+inp.value) || 100); inp.value = f.dur; drawEditor(); };
      inp.onclick = e => e.stopPropagation();
      const ops = document.createElement('div');
      ops.className = 'ops';
      ops.append(
        btn('⧉', '복제', () => duplicateFrame(i)),
        btn('◀', '앞으로', () => moveFrame(i, -1)),
        btn('▶', '뒤로', () => moveFrame(i, 1)),
        btn('✕', '삭제', () => deleteFrames([i])));
      d.append(c, lbl, inp, ops);
      d.onclick = () => select(i);
      el.append(d);
      return c;
    });
    thumbs.forEach((_, i) => drawThumb(i));
    $('impactInfo').textContent = S.frames.length ? `임팩트 프레임: #${S.impact}` + (S.impactPoint ? ` · 지점 (${S.impactPoint.x}, ${S.impactPoint.y})` : ' · 지점 없음') : '';
  }
  const thumbZoom = () => Math.max(1, Math.min(3, Math.floor(100 / S.cellH)));
  const drawThumb = i => thumbs[i] && drawCell(thumbs[i], thumbZoom(), i, { guides: true, sel: true });

  function render() {
    cur = Math.min(cur, Math.max(0, S.frames.length - 1));
    S.impact = Math.min(S.impact, Math.max(0, S.frames.length - 1));
    drawSource(); drawEditor(); drawPreview(); drawCompare(); buildStrip();
  }

  function select(i) {
    cur = i;
    render();
    $('editor').focus();
  }

  // the impact frame index follows its frame through reorder / delete / duplicate
  function remapImpact(oldFrames) {
    const f = oldFrames[S.impact], j = S.frames.indexOf(f);
    S.impact = j >= 0 ? j : Math.min(S.impact, S.frames.length - 1);
  }

  function duplicateFrame(i) {
    pushUndo();
    const f = S.frames[i], old = S.frames.slice();
    const c = { ...f, box: { ...f.box }, edits: new Map(f.edits), fx: new Map(f.fx) };
    S.frames.splice(i + 1, 0, c);
    remapImpact(old);
    cur = i + 1; render();
  }

  function moveFrame(i, d) {
    const j = i + d;
    if (j < 0 || j >= S.frames.length) return;
    pushUndo();
    const old = S.frames.slice();
    [S.frames[i], S.frames[j]] = [S.frames[j], S.frames[i]];
    remapImpact(old);
    cur = j; render();
  }

  function deleteFrames(list) {
    if (!list.length) return;
    pushUndo();
    const old = S.frames.slice(), drop = new Set(list.map(i => S.frames[i]));
    S.frames = S.frames.filter(f => !drop.has(f));
    for (const f of drop) selection.delete(f);
    remapImpact(old);
    boxSel.clear(); render();
  }

  // ---------- inputs ----------
  const NUM_INPUTS = ['tol', 'edge', 'despill', 'bodyFrac', 'pixel', 'colors', 'cellW', 'cellH', 'pad', 'zoom', 'pzoom',
    'gifScale', 'tile', 'gameScale', 'wandTol', 'islandMax'];
  const INTS = ['cellW', 'cellH', 'zoom', 'pzoom', 'gifScale', 'pad', 'colors', 'tile', 'wandTol', 'islandMax'];
  const CHECKS = ['snap', 'onion', 'grid', 'loop', 'lone', 'sharedPalette', 'outline', 'gifTransparent', 'flipView', 'gameView',
    'toFx', 'exportLeft', 'batchAutoPixel'];

  function syncInputs() {
    for (const k of NUM_INPUTS) $(k).value = S[k];
    for (const k of CHECKS) $(k).checked = S[k];
    $('name').value = S.name; $('keyColor').value = rgbToHex(S.key); $('gifBg').value = S.gifBg;
    $('outlineColor').value = S.outlineColor; $('paintColor').value = S.paintColor; $('scope').value = S.scope;
    document.querySelectorAll('output').forEach(o => { o.textContent = $(o.htmlFor.value).value; });
    $('pixelCands').innerHTML = '';
    pixelCands.forEach(c => {
      const b = document.createElement('button');
      b.className = Math.abs(c.p - S.pixel) < 1e-6 ? 'on' : '';
      b.textContent = c.p.toFixed(2); b.title = '이 크기로 바꿔 보기';
      b.onclick = () => { S.pixel = c.p; syncInputs(); reprocess(false); };
      $('pixelCands').append(b);
    });
  }

  /** Darkest colour in use: default for the outline. */
  function darkest() {
    let best = null, bl = 1e9;
    for (const f of S.frames) for (let i = 0; i < f.img.data.length; i += 4) {
      const d = f.img.data;
      if (d[i + 3] && d[i] + d[i + 1] + d[i + 2] < bl) { bl = d[i] + d[i + 1] + d[i + 2]; best = [d[i], d[i + 1], d[i + 2]]; }
    }
    return best ? rgbToHex(best) : S.outlineColor;
  }

  function bindInputs() {
    const after = {   // what each setting re-runs
      tol: () => reprocess(true), edge: () => reprocess(true), despill: () => reprocess(true),
      pixel: () => reprocess(false), lone: () => reprocess(false), colors: repalette, sharedPalette: repalette,
      outline: () => { if (S.outline) { S.outlineColor = darkest(); syncInputs(); } recomposeAll(); },
      cellW: render, cellH: render, zoom: drawEditor, pzoom: drawPreview, grid: render, onion: drawEditor,
      flipView: drawPreview, gameView: drawPreview, tile: drawPreview, gameScale: drawPreview,
    };
    for (const k of NUM_INPUTS) {
      const el = $(k), live = ['zoom', 'pzoom'].includes(k);
      el.addEventListener('input', () => { const o = document.querySelector(`output[for=${k}]`); if (o) o.textContent = el.value; });
      el.addEventListener(live ? 'input' : 'change', () => {
        const v = +el.value;
        if (!Number.isFinite(v)) return;
        S[k] = INTS.includes(k) ? Math.round(v) : v;
        (after[k] || (() => {}))();
      });
    }
    for (const k of CHECKS) $(k).addEventListener('change', () => { S[k] = $(k).checked; (after[k] || (() => {}))(); });
    $('name').onchange = () => { S.name = $('name').value.trim() || 'sprite'; };
    $('keyColor').onchange = () => { S.key = hexToRgb($('keyColor').value); reprocess(true); };
    $('gifBg').onchange = () => { S.gifBg = $('gifBg').value; };
    $('outlineColor').onchange = () => { S.outlineColor = $('outlineColor').value; if (S.outline) recomposeAll(); };
    $('paintColor').onchange = () => { S.paintColor = $('paintColor').value; };
    $('scope').onchange = () => { S.scope = $('scope').value; };
    $('showKeyed').onchange = drawSource;

    $('fileImg').onchange = async e => {
      const file = e.target.files[0];
      e.target.value = '';
      if (file) openSource(await readURL(file), baseName(file));
    };
    $('btnSample').onclick = () => openSource(Sample.make().toDataURL('image/png'), 'sample');
    $('fileProj').onchange = e => {
      const file = e.target.files[0];
      e.target.value = '';
      if (file) file.text().then(loadProject).catch(err => status('프로젝트 오류: ' + err.message));
    };
    $('btnSaveProj').onclick = saveProject;
    $('btnHelp').onclick = () => $('helpDlg').showModal();

    $('btnAuto').onclick = () => autoClean(true).then(() => S.frames.length && openStep(3));
    $('btnDetect').onclick = async () => { if (!src) return; status('프레임 찾는 중…'); await tick(); detect(false); status(`프레임 ${S.frames.length}개`); };
    $('btnPixel').onclick = async () => { if (!src) return; status('AI 픽셀 크기 찾는 중…'); await tick(); detectPixel(); reprocess(false); };
    $('btnAutoCell').onclick = () => { pushUndo(); autoCell(); render(); };
    $('btnAutoPlace').onclick = () => { pushUndo(); S.frames.forEach(autoPlace); render(); status('자동 정렬: 발은 발 선, 몸 중심은 중심선에 맞췄습니다.'); };
    $('btnMerge').onclick = mergeSelected;
    $('btnDelete').onclick = () => deleteFrames(boxSel.size ? [...boxSel] : [cur]);
    document.querySelectorAll('[data-mode]').forEach(b => b.onclick = () => setMode(b.dataset.mode));
    document.querySelectorAll('[data-tool]').forEach(b => b.onclick = () => setTool(b.dataset.tool));
    $('btnUndo').onclick = undo; $('btnRedo').onclick = redo;
    $('btnPlay').onclick = () => play(!playing);
    $('btnClearImpactPt').onclick = () => { pushUndo(); S.impactPoint = null; render(); };

    $('btnDelSel').onclick = deleteSelection;
    $('btnClearSel').onclick = () => { selection.clear(); render(); };
    $('btnIslandsPreview').onclick = () => { selectIslands(); render(); };
    $('btnIslands').onclick = () => { selectIslands(); deleteSelection(); };

    $('fileBg').onchange = async e => {
      const file = e.target.files[0];
      e.target.value = '';
      if (!file) return;
      bgImg = (await loadImage(await readURL(file))).canvas;
      S.gameView = true; syncInputs(); drawPreview();
    };
    $('btnClearBg').onclick = () => { bgImg = null; drawPreview(); };

    $('btnSheet').onclick = () => exportSheet();
    $('btnMeta').onclick = () => exportMeta();
    $('btnGif').onclick = () => exportGif();
    $('btnAll').onclick = () => exportAll();
    $('fileBatch').onchange = e => { const files = [...e.target.files]; e.target.value = ''; if (files.length) batch(files); };

    // drop a PNG or project file anywhere
    document.addEventListener('dragover', e => e.preventDefault());
    document.addEventListener('drop', async e => {
      e.preventDefault();
      const file = e.dataTransfer.files[0];
      if (!file) return;
      if (file.name.endsWith('.json')) file.text().then(loadProject).catch(err => status('프로젝트 오류: ' + err.message));
      else openSource(await readURL(file), baseName(file));
    });
    window.addEventListener('resize', drawSource);

    // step accordion: only one step open
    document.querySelectorAll('.stepHead').forEach(h => h.onclick = () => openStep(+h.parentElement.dataset.step));
  }

  function openStep(n) {
    document.querySelectorAll('.step').forEach(s => s.classList.toggle('open', +s.dataset.step === n));
  }

  function setMode(m) {
    mode = m;
    document.querySelectorAll('[data-mode]').forEach(b => b.classList.toggle('on', b.dataset.mode === m));
    $('src').style.cursor = m === 'select' ? 'default' : 'crosshair';
  }

  function setTool(t) {
    tool = t;
    document.querySelectorAll('[data-tool]').forEach(b => b.classList.toggle('on', b.dataset.tool === t));
    $('editor').style.cursor = t === 'move' ? 'move' : 'crosshair';
  }

  // ---------- frame boxes (source view) ----------
  let drag = null;

  /** Shrink a box to the foreground inside it. */
  function tighten(b) {
    let x0 = b.x + b.w, y0 = b.y + b.h, x1 = -1, y1 = -1;
    for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) if (mask[y * src.w + x]) {
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  }

  /** Process frames that were just added to S.frames, then place them. */
  function afterBoxChange(list) {
    list.forEach(prepFrame);
    applyPalettes();
    fitCell();
    S.frames.forEach(f => { if (!f.placed) autoPlace(f); });
    boxSel.clear();
    cur = Math.max(0, S.frames.indexOf(list[0]));
    render();
  }

  function mergeSelected() {
    const idx = [...boxSel].sort((a, b) => a - b);
    if (idx.length < 2) { status('병합: 원본 창에서 Shift+클릭으로 박스 2개 이상을 고르세요.'); return; }
    pushUndo();
    const fs = idx.map(i => S.frames[i]);
    const x0 = Math.min(...fs.map(f => f.box.x)), y0 = Math.min(...fs.map(f => f.box.y));
    const x1 = Math.max(...fs.map(f => f.box.x + f.box.w)), y1 = Math.max(...fs.map(f => f.box.y + f.box.h));
    const nf = newFrame({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, fs.some(f => f.raw), fs[0].dur);
    const old = S.frames.slice();
    S.frames = S.frames.filter((_, i) => !boxSel.has(i));
    S.frames.splice(idx[0], 0, nf);
    remapImpact(old);
    afterBoxChange([nf]);
  }

  function splitAt(i, sx) {
    const b = S.frames[i].box;
    if (sx <= b.x || sx >= b.x + b.w) return;
    pushUndo();
    const parts = [{ x: b.x, y: b.y, w: sx - b.x, h: b.h }, { x: sx, y: b.y, w: b.x + b.w - sx, h: b.h }].map(tighten).filter(Boolean);
    const nfs = parts.map(box => newFrame(box, true, S.frames[i].dur));
    S.frames.splice(i, 1, ...nfs);
    afterBoxChange(nfs);
  }

  const srcPos = e => ({ x: Math.floor(e.offsetX / dispScale), y: Math.floor(e.offsetY / dispScale) });
  const boxAt = (x, y) => S.frames.findIndex(f => x >= f.box.x && x < f.box.x + f.box.w && y >= f.box.y && y < f.box.y + f.box.h);

  function bindSource() {
    const cv = $('src');
    cv.addEventListener('pointerdown', e => {
      if (!src) return;
      const { x, y } = srcPos(e);
      if (mode === 'pick') {
        const i = (y * src.w + x) * 4;
        S.key = [src.data[i], src.data[i + 1], src.data[i + 2]];
        syncInputs(); setMode('select'); reprocess(true);
      } else if (mode === 'select') {
        const i = boxAt(x, y);
        if (i < 0) { boxSel.clear(); drawSource(); return; }
        if (e.shiftKey) boxSel.has(i) ? boxSel.delete(i) : boxSel.add(i);
        else { boxSel.clear(); boxSel.add(i); }
        cur = i; render();
      } else if (mode === 'split') {
        const i = boxAt(x, y);
        if (i >= 0) splitAt(i, x);
      } else if (mode === 'add') {
        drag = { x0: x, y0: y, x1: x, y1: y };
        cv.setPointerCapture(e.pointerId);
      }
    });
    cv.addEventListener('pointermove', e => {
      if (!drag) return;
      const p = srcPos(e);
      drag.x1 = Math.max(0, Math.min(src.w, p.x)); drag.y1 = Math.max(0, Math.min(src.h, p.y));
      drawSource();
    });
    cv.addEventListener('pointerup', () => {
      if (!drag) return;
      const b = { x: Math.min(drag.x0, drag.x1), y: Math.min(drag.y0, drag.y1), w: Math.abs(drag.x1 - drag.x0), h: Math.abs(drag.y1 - drag.y0) };
      drag = null;
      const t = b.w > 2 && b.h > 2 ? tighten(b) : null;
      if (!t) { drawSource(); return; }
      pushUndo();
      const nf = newFrame(t, true);
      const at = S.frames.findIndex(f => f.box.x > t.x);   // keep left-to-right order for the new box
      S.frames.splice(at < 0 ? S.frames.length : at, 0, nf);
      afterBoxChange([nf]);
    });
  }

  // ---------- pixel editing & selection ----------
  /** Current colour at a frame-local position, or null if transparent. */
  function pixelAt(f, lx, ly) {
    const x = lx - f.x0, y = ly - f.y0;
    if (x < 0 || y < 0 || x >= f.img.w || y >= f.img.h) return null;
    const i = (y * f.img.w + x) * 4, d = f.img.data;
    return d[i + 3] ? [d[i], d[i + 1], d[i + 2]] : null;
  }

  const frameMap = f => IO.mapFromImg(f.img, f.x0, f.y0);
  const scopeFrames = () => S.scope === 'all' ? S.frames : [S.frames[cur]];

  function paint(f, lx, ly, erase) {
    f.edits.set(K(lx, ly), erase ? [0, 0, 0, 0] : [...hexToRgb(S.paintColor), 255]);
  }

  function addSelection(f, keys, add) {
    const s = add && selection.has(f) ? selection.get(f) : new Set();
    keys.forEach(k => s.add(k));
    if (s.size) selection.set(f, s); else selection.delete(f);
  }

  /** Select pixels of every frame in scope whose cell position passes test(cx, cy). */
  function selectByCell(test, add) {
    if (!add) selection.clear();
    for (const f of scopeFrames()) {
      const keys = [];
      for (const k of frameMap(f).keys()) if (test(f.ox + KX(k) + 0.5, f.oy + KY(k) + 0.5)) keys.push(k);
      addSelection(f, keys, true);
    }
  }

  /** Magic wand. Current frame: connected similar colours. All frames: every pixel of a similar colour. */
  function wandAt(cx, cy, add) {
    const f = S.frames[cur], start = K(cx - f.ox, cy - f.oy), m = frameMap(f), c0 = m.get(start);
    if (!c0) return;
    if (!add) selection.clear();
    if (S.scope === 'cur') { addSelection(f, IO.wand(m, start, S.wandTol), true); return; }
    for (const g of S.frames) {
      const keys = [];
      for (const [k, c] of frameMap(g)) if (Math.hypot(c[0] - c0[0], c[1] - c0[1], c[2] - c0[2]) <= S.wandTol) keys.push(k);
      addSelection(g, keys, true);
    }
  }

  /** Detached islands: every connected piece except the biggest (the body) below the size limit. */
  function selectIslands() {
    selection.clear();
    let n = 0;
    for (const f of scopeFrames()) {
      const keys = [];
      IO.groups(frameMap(f)).slice(1).forEach(g => { if (S.islandMax >= 2000 || g.length < S.islandMax) { keys.push(...g); n++; } });
      addSelection(f, keys, true);
    }
    status(n ? `떨어진 조각 ${n}개를 분홍색으로 표시했습니다. 적용 또는 선택 지우기로 지웁니다.` : '떨어진 조각이 없습니다.');
  }

  /** Delete the selected pixels (or move them to the FX layer). */
  function deleteSelection() {
    if (!selection.size) { status('선택된 픽셀이 없습니다.'); return; }
    pushUndo();
    let n = 0;
    for (const [f, keys] of selection) {
      for (const k of keys) {
        const c = pixelAt(f, KX(k), KY(k));
        if (!c) continue;
        if (S.toFx) f.fx.set(k, [...c, 255]);
        f.edits.set(k, [0, 0, 0, 0]);
        n++;
      }
      compose(f);
    }
    selection.clear();
    render();
    status(`${n}px을 ${S.toFx ? 'FX 레이어로 옮겼' : '지웠'}습니다. (Ctrl+Z로 되돌리기)`);
  }

  function pointInPoly(x, y, pts) {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xi, yi] = pts[i], [xj, yj] = pts[j];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  // ---------- editor: tools, guides, keys ----------
  let ed = null;
  function bindEditor() {
    const cv = $('editor');
    const cellXY = e => ({ fx: e.offsetX / S.zoom, fy: e.offsetY / S.zoom, x: Math.floor(e.offsetX / S.zoom), y: Math.floor(e.offsetY / S.zoom) });
    const guideHit = e => GUIDES.find(g => Math.abs((g.v ? e.offsetX : e.offsetY) - S.guides[g.k] * S.zoom) <= 5);

    cv.addEventListener('pointerdown', e => {
      const f = S.frames[cur];
      if (!f) return;
      const p = cellXY(e);
      cv.setPointerCapture(e.pointerId);
      if (tool === 'move') {
        const hit = guideHit(e);
        if (!hit) pushUndo();
        ed = hit ? { guide: hit } : { mx: e.offsetX, my: e.offsetY, ox: f.ox, oy: f.oy };
      } else if (tool === 'pencil' || tool === 'eraser') {
        pushUndo();
        ed = { paint: true, lx: p.x - f.ox, ly: p.y - f.oy };
        paint(f, ed.lx, ed.ly, tool === 'eraser');
        compose(f); drawEditor();
      } else if (tool === 'picker') {
        const c = pixelAt(f, p.x - f.ox, p.y - f.oy);
        if (c) { S.paintColor = rgbToHex(c); syncInputs(); setTool('pencil'); }
      } else if (tool === 'wand') {
        wandAt(p.x, p.y, e.shiftKey); render();
      } else if (tool === 'rect') {
        ed = { shape: 'rect', x0: p.x, y0: p.y, x1: p.x + 1, y1: p.y + 1, add: e.shiftKey };
      } else if (tool === 'lasso') {
        ed = { shape: 'lasso', pts: [[p.fx, p.fy]], add: e.shiftKey };
      } else if (tool === 'impact') {
        pushUndo();
        S.impactPoint = { x: p.x, y: p.y };
        S.impact = cur;
        render();
      }
    });

    cv.addEventListener('pointermove', e => {
      const z = S.zoom;
      if (!ed) {
        if (tool === 'move') { const hit = guideHit(e); cv.style.cursor = hit ? (hit.v ? 'ew-resize' : 'ns-resize') : 'move'; }
        return;
      }
      const f = S.frames[cur], p = cellXY(e);
      if (ed.guide) {
        const lim = ed.guide.v ? S.cellW : S.cellH;
        S.guides[ed.guide.k] = Math.max(0, Math.min(lim, Math.round((ed.guide.v ? e.offsetX : e.offsetY) / z)));
        drawEditor(); thumbs.forEach((_, i) => drawThumb(i));
      } else if (ed.paint) {
        // fill the gap between pointer samples so fast strokes stay unbroken
        const lx = p.x - f.ox, ly = p.y - f.oy, n = Math.max(Math.abs(lx - ed.lx), Math.abs(ly - ed.ly));
        for (let s = 1; s <= n; s++) paint(f, Math.round(ed.lx + (lx - ed.lx) * s / n), Math.round(ed.ly + (ly - ed.ly) * s / n), tool === 'eraser');
        ed.lx = lx; ed.ly = ly;
        compose(f); drawEditor();
      } else if (ed.shape === 'rect') {
        ed.x1 = p.x + 1; ed.y1 = p.y + 1;
        drawEditor();
      } else if (ed.shape === 'lasso') {
        ed.pts.push([p.fx, p.fy]);
        drawEditor();
      } else {
        f.ox = ed.ox + Math.round((e.offsetX - ed.mx) / z);
        f.oy = ed.oy + Math.round((e.offsetY - ed.my) / z);
        if (S.snap) snapFrame(f);
        drawEditor(); drawThumb(cur); drawPreview();
      }
    });

    cv.addEventListener('pointerup', () => {
      if (!ed) return;
      const done = ed;
      ed = null;
      if (done.shape === 'rect') {
        const [x0, x1] = [Math.min(done.x0, done.x1), Math.max(done.x0, done.x1)], [y0, y1] = [Math.min(done.y0, done.y1), Math.max(done.y0, done.y1)];
        selectByCell((x, y) => x >= x0 && x < x1 && y >= y0 && y < y1, done.add);
      } else if (done.shape === 'lasso' && done.pts.length > 2) {
        selectByCell((x, y) => pointInPoly(x, y, done.pts), done.add);
      }
      render();
    });

    const TOOL_KEYS = { v: 'move', b: 'pencil', e: 'eraser', i: 'picker', w: 'wand', m: 'rect', l: 'lasso', p: 'impact' };
    document.addEventListener('keydown', e => {
      if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName) || $('helpDlg').open) return;
      const k = e.key.toLowerCase();
      if (e.ctrlKey || e.metaKey) {
        if (k === 'z' && !e.shiftKey) { undo(); e.preventDefault(); }
        else if (k === 'y' || (k === 'z' && e.shiftKey)) { redo(); e.preventDefault(); }
        return;
      }
      if (!S.frames.length) return;
      const f = S.frames[cur], d = e.shiftKey ? 5 : 1;
      const moves = { arrowleft: [-d, 0], arrowright: [d, 0], arrowup: [0, -d], arrowdown: [0, d] };
      if (moves[k]) {
        pushUndo();
        f.ox += moves[k][0]; f.oy += moves[k][1];
        drawEditor(); drawThumb(cur); drawPreview();
        e.preventDefault();
      } else if (k === ',' || k === '.') {
        select((cur + (k === '.' ? 1 : -1) + S.frames.length) % S.frames.length);
      } else if (k === ' ') {
        play(!playing); e.preventDefault();
      } else if (k === 'delete' || k === 'backspace') {
        deleteSelection(); e.preventDefault();
      } else if (k === 'escape') {
        selection.clear(); render();
      } else if (TOOL_KEYS[k]) {
        setTool(TOOL_KEYS[k]);
      }
    });
  }

  // ---------- playback ----------
  function play(on) {
    playing = on && S.frames.length > 0;
    clearTimeout(pTimer);
    $('btnPlay').textContent = playing ? '⏸ 정지' : '▶ 재생';
    if (playing) { pIdx = cur; step(); } else drawPreview();
  }
  function step() {
    drawPreview();
    pTimer = setTimeout(() => {
      pIdx++;
      if (pIdx >= S.frames.length) {
        if (!S.loop) { pIdx = S.frames.length - 1; play(false); return; }
        pIdx = 0;
      }
      step();
    }, S.frames[pIdx].dur);
  }

  // ---------- export ----------
  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  const hasFx = () => S.frames.some(f => f.fxCanvas);

  /** One row of equal cells. main/fx: which layers; flip: left-facing (each cell mirrored in place). */
  function sheetCanvas(opts) {
    const c = document.createElement('canvas');
    c.width = S.cellW * S.frames.length; c.height = S.cellH;
    const g = c.getContext('2d');
    S.frames.forEach((_, i) => g.drawImage(cellCanvas(i, opts), i * S.cellW, 0));
    return c;
  }

  const savePNG = (canvas, name) => new Promise(r => canvas.toBlob(b => { download(b, name); r(); }, 'image/png'));

  function exportSheet() {
    if (!S.frames.length) return;
    return savePNG(sheetCanvas({ fx: false }), `${S.name}.png`);
  }

  function meta() {
    const durations = S.frames.map(f => f.dur), g = S.guides;
    const colors = new Set();
    for (const f of S.frames) for (let i = 0; i < f.img.data.length; i += 4) if (f.img.data[i + 3]) colors.add(rgbToHex([f.img.data[i], f.img.data[i + 1], f.img.data[i + 2]]));
    const m = {
      image: `${S.name}.png`,
      frameWidth: S.cellW, frameHeight: S.cellH, frameCount: S.frames.length,
      frames: S.frames.map((f, i) => ({ index: i, x: i * S.cellW, y: 0, w: S.cellW, h: S.cellH, duration: f.dur })),
      durations,
      totalDuration: durations.reduce((a, b) => a + b, 0),
      loop: S.loop,
      pivot: { x: g.cx, y: g.base, note: 'centre line x, feet baseline y (pixel boundaries)' },
      impactFrame: S.impact,
      impactPoint: S.impactPoint,
      guides: { ...g },
      pixelSize: S.pixel,
      palette: [...colors],
    };
    if (S.exportLeft) m.left = { image: `${S.name}_left.png`, pivot: { x: S.cellW - g.cx, y: g.base },
      impactPoint: S.impactPoint && { x: S.cellW - 1 - S.impactPoint.x, y: S.impactPoint.y } };
    if (hasFx()) m.fx = { image: `${S.name}_fx.png`, note: 'removed effect pixels, same cells as the main sheet' };
    if (hasFx() && S.exportLeft) m.fx.left = `${S.name}_fx_left.png`;
    return m;
  }

  function exportMeta() {
    if (!S.frames.length) return;
    download(new Blob([JSON.stringify(meta(), null, 2)], { type: 'application/json' }), `${S.name}.json`);
  }

  function exportGif() {
    if (!S.frames.length) return;
    const k = Math.max(1, S.gifScale), W = S.cellW * k, H = S.cellH * k;
    const cells = S.frames.map((_, i) => cellCanvas(i).getContext('2d').getImageData(0, 0, S.cellW, S.cellH).data);
    // palette: index 0 = transparent or background, then every colour used (median cut if more than 255)
    const seen = new Set();
    for (const d of cells) for (let i = 0; i < d.length; i += 4) if (d[i + 3]) seen.add(d[i] << 16 | d[i + 1] << 8 | d[i + 2]);
    let colors = [...seen].map(v => [v >> 16, v >> 8 & 255, v & 255]);
    if (colors.length > 255) colors = IO.medianCut(colors, 255);
    const pal = [S.gifTransparent ? [0, 0, 0] : hexToRgb(S.gifBg), ...colors], index = new Map();
    const idxOf = (r, g, b) => {
      const key = r << 16 | g << 8 | b;
      let v = index.get(key);
      if (v === undefined) {
        v = 1;
        for (let j = 2; j < pal.length; j++) if (IO.dist2([r, g, b], pal[j]) < IO.dist2([r, g, b], pal[v])) v = j;
        index.set(key, v);
      }
      return v;
    };
    const frames = cells.map(d => {
      const out = new Uint8Array(W * H);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = ((y / k | 0) * S.cellW + (x / k | 0)) * 4;
        out[y * W + x] = d[i + 3] ? idxOf(d[i], d[i + 1], d[i + 2]) : 0;
      }
      return out;
    });
    const bytes = GIF.encode(W, H, frames, pal, S.frames.map(f => f.dur), S.gifTransparent ? 0 : -1);
    download(new Blob([bytes], { type: 'image/gif' }), `${S.name}_preview.gif`);
  }

  async function exportAll() {
    if (!S.frames.length) { status('내보낼 프레임이 없습니다.'); return; }
    await exportSheet();
    exportMeta();
    exportGif();
    if (S.exportLeft) await savePNG(sheetCanvas({ fx: false, flip: true }), `${S.name}_left.png`);
    if (hasFx()) {
      await savePNG(sheetCanvas({ main: false }), `${S.name}_fx.png`);
      if (S.exportLeft) await savePNG(sheetCanvas({ main: false, flip: true }), `${S.name}_fx_left.png`);
    }
    status(`내보냄: ${S.name}.png · .json · _preview.gif` + (S.exportLeft ? ' · _left.png' : '') + (hasFx() ? ' · _fx.png' : ''));
  }

  /** Batch: same settings for several PNGs, export each, then come back to the current work. */
  async function batch(files) {
    const back = src ? projectJSON() : null, durs = S.frames.map(f => f.dur), impact = S.impact;
    for (const [n, file] of files.entries()) {
      status(`일괄 처리 ${n + 1}/${files.length}: ${file.name}`);
      await openSource(await readURL(file), baseName(file), { keepKey: true, autoPixel: S.batchAutoPixel });
      if (S.frames.length === durs.length) { S.frames.forEach((f, i) => { f.dur = durs[i]; }); S.impact = impact; }
      await exportAll();
      await new Promise(r => setTimeout(r, 400));
    }
    if (back) await loadProject(back);
    status(`일괄 처리 완료: ${files.length}개 파일을 내보냈습니다.`);
  }

  // ---------- project file ----------
  function projectJSON() {
    const { frames, ...settings } = S;
    return JSON.stringify({ app: 'sprite-aligner', version: 2, ...settings,
      frames: frames.map(f => ({ box: f.box, raw: f.raw, dur: f.dur, ox: f.ox, oy: f.oy, edits: [...f.edits], fx: [...f.fx] })) });
  }

  function saveProject() {
    if (!src) return;
    download(new Blob([projectJSON()], { type: 'application/json' }), `${S.name}.sprite-aligner.json`);
  }

  async function loadProject(text) {
    const p = JSON.parse(text);
    if (p.app !== 'sprite-aligner') throw new Error('sprite-aligner 프로젝트 파일이 아닙니다');
    status('프로젝트 여는 중…'); await tick();
    ({ canvas: srcCanvas, img: src } = await loadImage(p.srcURL));
    const { frames, app, version, ...settings } = p;
    Object.assign(S, settings);
    pixelCands = [];
    rekey();
    S.frames = frames.map(f => ({ ...f, edits: new Map(f.edits || []), fx: new Map(f.fx || []) }));
    S.frames.forEach(prepFrame);
    applyPalettes();
    S.frames.forEach(f => { f.placed = true; });
    cur = 0; boxSel.clear(); selection.clear();
    undoStack.length = redoStack.length = 0;
    syncInputs(); render(); openStep(3);
    status(`프로젝트 열림: ${S.name} (프레임 ${S.frames.length}개)`);
  }

  // ---------- start ----------
  bindInputs(); bindSource(); bindEditor();
  setMode('select'); setTool('move'); syncInputs(); openStep(1);
})();
