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
    edgeNeutral: false,   // soft edge: un-mixed colours tinted away from the key (green from magenta) become grey
    keyTint: 0,      // > 0: also key pixels tinted like the background (same hue direction, tint strength >= keyTint): dark specks of key colour
    remap: [],       // colour remap rules [{ src: [r,g,b], dst: [r,g,b], tol }] (e.g. match a part's colour to another sheet)
    fringe: false,   // recolour key-tinted edge pixels to the neighbouring outline colour (off: despill only)
    keyEdge: true, keyBorders: true, keyMarks: true,   // background: only what touches the image edge; panel lines; corner watermarks
    bodyFrac: 0.2, minPiece: 8,
    smooth: false,   // 부드러운 그림: soft-painted art, no pixel processing (soft key edge, smooth scaling, no palette)
    pixel: 4, colors: 24, sharedPalette: true, lone: false, outline: false, outlineColor: '#1c1830',
    cellW: 64, cellH: 64, pad: 2,
    guides: { base: 60, top: 4, weapon: 30, cx: 32 },
    snap: true, onion: true, grid: true, zoom: 6, pzoom: 3, loop: true,
    impact: 0, impactPoint: null,
    flipView: false, gameView: false, tile: 62, gameScale: 1,
    scope: 'cur', toFx: false, wandTol: 40, islandMax: 2000,
    alignBy: 'auto',   // auto-align: 'auto' (torso for run / walk cycles by name, else feet), 'torso', 'feet'
    gifScale: 4, gifBg: '#3a3e46', gifTransparent: false, exportLeft: false, batchAutoPixel: true,
    paintColor: '#ffffff',
    perFramePixel: false, head: null,   // head: { x, y, w, h (source px), frame } reference for size matching
    compareMode: 'before',
    effects: [],  // effect instances, see addEffect()
    showEffects: true, effectsMode: 'separate',
    // automatic effects: tracked blade tip per frame (cell px) + chosen look
    autoFx: { tips: [], style: 'whiteblue', shape: 'tapered', trail: true, spark: true, dust: true },
    frames: [],   // { box:{x,y,w,h}, raw, dur, ox, oy, edits:Map, fx:Map, pixel } + derived pre, base, img, x0, y0, canvas, anchor, fxImg, autoPixel, head…
  };
  const assets = new Map();   // effect assets: id → { name, frames:[canvas], durations, spec?, url? }
  let fxSel = null;           // selected effect instance id
  let nextId = 1;
  let src = null, srcCanvas = null;          // original image + canvas
  let keyed = null, mask = null, keyedCanvas = null;
  // background settings changed: what the new settings would remove, shown red on the source until 적용 / 되돌리기
  let keyPreview = null, keyBefore = null;
  const keyOpts = () => ({ connected: S.keyEdge, borders: S.keyBorders, marks: S.keyMarks });
  const KEY_FIELDS = ['key', 'tol', 'edge', 'keyEdge', 'keyBorders', 'keyMarks'];

  /** Recompute the removal with the current background settings and show it red (nothing is applied yet). */
  function previewKey() {
    if (!src) return;
    const m = IO.keyMask(src, S.key, S.tol, S.edge, keyOpts());
    const c = document.createElement('canvas');
    c.width = src.w; c.height = src.h;
    const g = c.getContext('2d'), img = g.createImageData(src.w, src.h), d = img.data, sd = src.data;
    let gone = 0;
    for (let p = 0; p < m.length; p++) {
      const i = p * 4;
      if (m[p]) { d[i] = sd[i]; d[i + 1] = sd[i + 1]; d[i + 2] = sd[i + 2]; d[i + 3] = 255; continue; }
      gone++;
      d[i] = Math.round(sd[i] * 0.35 + 255 * 0.65); d[i + 1] = Math.round(sd[i + 1] * 0.35); d[i + 2] = Math.round(sd[i + 2] * 0.35); d[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    keyPreview = { mask: m, canvas: c, gone };
    showKeyPending();
    drawSource();
  }
  function showKeyPending() {
    $('keyPending').hidden = !keyPreview;
    if (keyPreview) $('keyPendingInfo').textContent = `빨간 부분이 지워집니다 (${Math.round(keyPreview.gone / keyPreview.mask.length * 100)}%)`;
  }
  /** A background setting is about to change: remember the applied ones (for 되돌리기), then preview. */
  function keyChanged(apply) {
    if (!keyBefore) keyBefore = Object.fromEntries(KEY_FIELDS.map(k => [k, JSON.parse(JSON.stringify(S[k]))]));
    apply();
    previewKey();
  }
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
    status(`자동 정리 완료: 프레임 ${S.frames.length}개 · ${S.smooth ? `부드러운 그림 (축소 ÷${S.pixel})` : `AI 픽셀 ${S.pixel}px`} · 프레임 크기 ${S.cellW}×${S.cellH}. ③에서 다듬으세요.`);
  }

  // ---------- pipeline ----------
  function rekey() {
    if (S.noKey) {   // --key none: no background removal; the image's own alpha is the mask, colours untouched
      mask = new Uint8Array(src.w * src.h);
      for (let p = 0; p < mask.length; p++) mask[p] = src.data[p * 4 + 3] ? 1 : 0;
      keyed = { w: src.w, h: src.h, data: new Uint8ClampedArray(src.data) };
      if (S.remap && S.remap.length) keyed = IO.remapColors(keyed, mask, S.remap);
      ({ labels, comps } = IO.components(mask, src.w, src.h));
      keyPreview = null;
      keyedCanvas = toCanvas(keyed);
      return;
    }
    mask = IO.keyMask(src, S.key, S.tol, S.edge, keyOpts());
    if (S.keyTint > 0) IO.keyByTint(src, mask, S.key, S.keyTint);
    keyPreview = null;
    showKeyPending();
    const pre = S.fringe ? IO.fringeToOutline(src, mask, S.key) : src;
    keyed = IO.despill(pre, mask, S.key, S.despill);
    if (S.smooth) keyed = IO.softKey(keyed, mask, S.key, S.tol, S.edgeNeutral);   // soft, un-mixed edge (alpha in keyed)
    if (S.remap && S.remap.length) keyed = IO.remapColors(keyed, mask, S.remap);   // after the soft edge, so its un-mixed colours can be remapped too
    ({ labels, comps } = IO.components(mask, src.w, src.h));
    const view = { w: src.w, h: src.h, data: new Uint8ClampedArray(keyed.data) };
    if (!S.smooth) for (let p = 0; p < mask.length; p++) view.data[p * 4 + 3] = mask[p] ? 255 : 0;   // hard alpha
    keyedCanvas = toCanvas(view);
  }

  const newFrame = (box, raw, dur = 100) => ({ box, raw, dur, ox: 0, oy: 0, edits: new Map(), fx: new Map() });

  /** Fixed grid (--grid cols x rows or --frame-size w,h): one frame per cell, left to right, top to bottom. For sheets
   *  whose frames are sparse or overlap, where blob detection would split or merge them. */
  function gridBoxes() {
    const g = S.grid;
    const fw = g.fw || Math.floor(src.w / g.cols), fh = g.fh || Math.floor(src.h / g.rows);
    const cols = Math.floor(src.w / fw), rows = Math.floor(src.h / fh), boxes = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) boxes.push({ x: c * fw, y: r * fh, w: fw, h: fh });
    return g.count ? boxes.slice(0, g.count) : boxes;
  }

  function detect(autoPixel = true) {
    const boxes = S.grid ? gridBoxes() : IO.detectFrames(comps, { bodyFrac: S.bodyFrac, minPiece: S.minPiece });
    const old = S.frames;
    S.frames = boxes.map((box, i) => newFrame(box, !!S.grid, old[i] ? old[i].dur : 100));
    if (S.grid) autoPixel = false;   // the grid gives the frames; the scale is as set (--shrink / --pixel)
    boxSel.clear(); selection.clear(); cur = 0;
    undoStack.length = redoStack.length = 0;
    if (autoPixel && !S.smooth) detectPixel();   // smooth art: no fake-pixel grid to find, the scale stays as set
    if (S.perFramePixel && !S.smooth) detectFramePixels();
    S.frames.forEach(prepFrame);
    applyPalettes();
    if (S.grid) gridCell(); else autoCell();
    if (S.head) compareHeads();
    render();
  }

  /** Grid mode: the cell = the source cell (scaled); every frame stays where it was drawn inside its cell. */
  function gridCell() {
    const b = S.frames[0].box, p = S.pixel;
    S.cellW = Math.round(b.w / p); S.cellH = Math.round(b.h / p);
    S.guides = { base: S.cellH, top: 0, weapon: Math.round(S.cellH * 0.45), cx: S.cellW / 2 };
    for (const f of S.frames) {
      const pp = pixelOf(f);
      f.ox = Math.round(((f.pre.sx ?? f.box.x) - f.box.x) / pp);
      f.oy = Math.round(((f.pre.sy ?? f.box.y) - f.box.y) / pp);
      f.placed = true;
    }
    syncInputs();
  }

  /** Grid mode, after placement: drop empty tail frames, trim every frame to the union box of lit pixels (+pad), set the
   *  pivot (source-cell px), the impact frame (brightest), the blend. lum = PIL "L" (ITU-R 601), so a frame counts as
   *  lit where a pixel is opaque and brighter than `trimLum` (-1: any opaque pixel). */
  function gridFinish(o) {
    const L = (d, i) => (d[i] * 19595 + d[i + 1] * 38470 + d[i + 2] * 7471 + 0x8000) >> 16;
    const lit = (f, th) => {   // cell-space box of the frame's lit pixels, or null
      let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
      const d = f.img.data, w = f.img.w;
      for (let y = 0; y < f.img.h; y++) for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        if (!d[i + 3] || (th >= 0 && L(d, i) <= th)) continue;
        const cx = f.ox + f.x0 + x, cy = f.oy + f.y0 + y;
        if (cx < x0) x0 = cx; if (cy < y0) y0 = cy; if (cx > x1) x1 = cx; if (cy > y1) y1 = cy;
      }
      return x1 < 0 ? null : { x0, y0, x1: x1 + 1, y1: y1 + 1 };
    };
    const th = o.trimLum ?? -1;
    if (o.dropEmpty) { while (S.frames.length > 1 && !lit(S.frames[S.frames.length - 1], th)) S.frames.pop(); }
    let off = [0, 0];
    if (o.trim) {
      const bs = S.frames.map(f => lit(f, th)).filter(Boolean), pad = o.trimPad ?? 2;
      if (bs.length) {
        const x0 = Math.max(0, Math.min(...bs.map(b => b.x0)) - pad), y0 = Math.max(0, Math.min(...bs.map(b => b.y0)) - pad);
        const x1 = Math.min(S.cellW, Math.max(...bs.map(b => b.x1)) + pad), y1 = Math.min(S.cellH, Math.max(...bs.map(b => b.y1)) + pad);
        for (const f of S.frames) { f.ox -= x0; f.oy -= y0; }
        S.cellW = x1 - x0; S.cellH = y1 - y0; off = [x0, y0];
      }
    }
    const r1 = v => Math.round(v * 10) / 10;
    if (o.pivot) S.guides = { ...S.guides, cx: r1(o.pivot[0] / S.pixel - off[0]), base: r1(o.pivot[1] / S.pixel - off[1]) };
    if (o.impactBright) {
      const e = S.frames.map(f => { let s = 0; for (let i = 0; i < f.img.data.length; i += 4) if (f.img.data[i + 3]) s += L(f.img.data, i); return s; });
      S.impact = e.indexOf(Math.max(...e));
    }
    S.trimOffset = off;
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

  /** Per-frame AI pixel size, searched only within ±20% of the global one (so it cannot jump to a harmonic). */
  function detectFramePixels() {
    for (const f of S.frames) {
      const c = IO.detectPixelSize(keyed, mask, [f.box], S.pixel * 0.8, S.pixel * 1.2);
      f.autoPixel = c.length ? c[0].p : null;
    }
  }

  /** AI pixel size used for a frame: manual override → per-frame auto (if on) → global. */
  const pixelOf = f => f.pixel || (S.perFramePixel && f.autoPixel) || S.pixel;

  /** Downscale + lone-pixel cleanup (no palette yet). Smooth art: plain high-quality scaling by 1/pixel. */
  function prepFrame(f) {
    if (S.smooth) { f.pre = IO.smoothScale(keyed, ownerTest(f), f.box, pixelOf(f)); return; }
    f.pre = IO.downscale(keyed, ownerTest(f), f.box, pixelOf(f));
    if (S.lone) IO.removeLonePixels(f.pre);
  }

  /**
   * Palette snap for every frame. Shared palette (default) = the dominant colours of ALL frames together, so the
   * same cloth keeps the same colour in every frame (no flicker). If a frame's size changed, its hand edits no
   * longer line up and are dropped.
   */
  function applyPalettes() {
    const pal = S.colors > 0 && !S.smooth;   // smooth art keeps its colours
    const shared = pal && S.sharedPalette ? IO.dominantPalette(S.frames.map(f => f.pre), S.colors) : null;
    let lost = 0;
    for (const f of S.frames) {
      const base = { ...f.pre, data: new Uint8ClampedArray(f.pre.data) };
      if (pal) IO.snapToPalette(base, shared || IO.dominantPalette([f.pre], S.colors));
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
    f.torso = IO.torsoAnchor(f.img);
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
    status(`프레임 ${S.frames.length}개 · ${S.smooth ? `부드러운 그림 (축소 ÷${S.pixel})` : `AI 픽셀 ${S.pixel}px`}`);
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
  // ---------- auto-align modes ----------
  // feet: feet on the baseline, the legs' centre on the centre line (attacks, idles: the feet stay planted).
  // torso (몸통 기준): the head / torso centre on the centre line, legs / arms / weapons ignored, so a run or walk cycle
  // does not slide sideways with the stride; feet on the baseline, plus the jump height the source was drawn with
  // (frames drawn higher than the others on the source's ground keep that height: jumps are not flattened).
  const CYCLE = /run|walk|jog|dash|sprint|달리|걷|뛰/i;
  const alignMode = () => (S.alignBy === 'auto' ? (CYCLE.test(S.name) ? 'torso' : 'feet') : S.alignBy);
  // ground (바닥선 기준, falls / deaths): the lowest visible pixel of the whole sprite (weapons included) on the
  // baseline, and the sprite keeps where it was drawn inside its equal-width cell of the source row, so a body that
  // falls sideways is not pulled back to the centre.
  const lowestRow = f => { for (let y = f.img.h - 1; y >= 0; y--) for (let x = 0; x < f.img.w; x++) if (f.img.data[(y * f.img.w + x) * 4 + 3]) return y + 1; return f.img.h; };
  function groundX(f) {
    const i = S.frames.indexOf(f), cell = src ? src.w / Math.max(1, S.frames.length) : 0;
    const left = f.pre && f.pre.sx !== undefined ? f.pre.sx : f.box ? f.box.x : 0;
    return ((i + 0.5) * cell - left) / pixelOf(f) - f.x0;
  }
  const anchorX = f => (alignMode() === 'ground' && f.box ? groundX(f) : alignMode() === 'torso' && f.torso ? f.torso.tx : f.anchor.bx);
  const anchorY = f => (alignMode() === 'ground' ? lowestRow(f) : f.anchor.by);

  /** Torso mode: each frame's feet above the source's ground line (art px; 0 = on the ground). */
  function sourceLift(f) {
    if (alignMode() !== 'torso' || !f.box) return 0;
    const feet = g => g.box.y + (g.y0 + g.anchor.by) * pixelOf(g);
    const ground = Math.max(...S.frames.filter(g => g.box && g.anchor).map(feet));
    const tall = Math.max(...S.frames.map(g => g.anchor ? g.anchor.by : 0));
    const lift = (ground - feet(f)) / pixelOf(f);
    return lift >= 2 ? Math.min(Math.round(lift), Math.round(tall * 0.35)) : 0;   // (under 2 px: noise; capped)
  }

  /** Cell big enough for every frame aligned on its anchor (+ padding); guides: feet line, centre line. */
  function autoCell() {
    if (!S.frames.length) return;
    const L = Math.ceil(Math.max(...S.frames.map(anchorX))), R = Math.ceil(Math.max(...S.frames.map(f => f.img.w - anchorX(f))));
    const U = Math.max(...S.frames.map(f => anchorY(f) + sourceLift(f))), D = Math.max(...S.frames.map(f => f.img.h - anchorY(f)));
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

  /** Auto-align suggestion: feet on the baseline; the legs' centre (feet mode) or the head / torso centre (torso mode) on the centre line. */
  function autoPlace(f) {
    f.ox = Math.round(S.guides.cx - anchorX(f)) - f.x0;
    f.oy = S.guides.base - anchorY(f) - sourceLift(f) - f.y0;
    f.placed = true;
  }

  function snapFrame(f) {
    const g = S.guides, t = 3, left = f.ox + f.x0, top = f.oy + f.y0;
    if (Math.abs(top + f.anchor.by - g.base) <= t) f.oy = g.base - f.anchor.by - f.y0;
    else if (Math.abs(top - g.top) <= t) f.oy = g.top - f.y0;
    if (Math.abs(left + f.anchor.bx - g.cx) <= t) f.ox = Math.round(g.cx - f.anchor.bx) - f.x0;
  }

  // ---------- size matching by head (A) ----------
  // The user boxes one head in the source. Every frame is searched for that head at 0.8–1.2× (template match on
  // the keyed source). head.s > 1 means the AI drew that frame bigger, so its AI pixel must be s× bigger too.

  function compareHeads() {
    const h = S.head;
    if (h) h.frame = boxAt(h.x + h.w / 2, h.y + h.h / 2);
    if (!h || !S.frames[h.frame]) return;
    status('머리 찾는 중…');
    S.frames.forEach((f, i) => {
      f.head = i === h.frame ? { s: 1, x: h.x, y: h.y, w: h.w, h: h.h } : IO.matchHead(keyed, mask, h, f.box);
    });
    status('머리 비교 완료. 5% 넘게 다른 프레임은 ⚠ 표시.');
  }

  /** Head height in true pixels after downscaling, relative to the reference frame (1 = same). */
  function headRatio(f) {
    const ref = S.frames[S.head.frame];
    return (f.head.h / pixelOf(f)) / (S.head.h / pixelOf(ref));
  }

  function fitHeads() {
    if (!S.head || !S.frames.some(f => f.head)) { status('먼저 원본에서 머리 상자를 그리세요.'); return; }
    const refP = pixelOf(S.frames[S.head.frame]);
    S.frames.forEach((f, i) => { if (f.head && i !== S.head.frame) f.pixel = +(refP * f.head.s).toFixed(2); });
    reprocess(false);
  }

  function buildHeadList() {
    const el = $('headList');
    el.innerHTML = '';
    if (!S.head || !S.frames.some(f => f.head)) { el.textContent = '머리 상자가 없습니다.'; return; }
    S.frames.forEach((f, i) => {
      if (!f.head) return;
      const r = headRatio(f), bad = Math.abs(r - 1) > 0.05;
      const row = document.createElement('div');
      row.className = 'headrow' + (bad ? ' bad' : '') + (i === cur ? ' cur' : '');
      row.textContent = `#${i}${i === S.head.frame ? ' (기준)' : ''}  원본 ${Math.round(f.head.s * 100)}% → 결과 ${Math.round(r * 100)}%${bad ? ' ⚠' : ''}  · ${pixelOf(f)}px`;
      row.onclick = () => select(i);
      el.append(row);
    });
  }

  // ---------- effects (B) ----------
  // An instance places one asset on the character: frames start…start+len-1 show asset frames stretched over that
  // range; position (x, y) is the asset frame's centre in cell pixels, or per-frame keyframes when `follow` is on.

  function addAsset(a) { const id = 'a' + nextId++; assets.set(id, { ...a, version: 1 }); return id; }

  function addEffect(assetId, extra = {}) {
    const a = assets.get(assetId), n = S.frames.length;
    const start = Math.min(cur, Math.max(0, n - 1));
    const p = S.impactPoint || { x: S.guides.cx, y: Math.round(S.cellH / 2) };
    const inst = { id: 'e' + nextId++, asset: assetId, name: a.name, start, len: Math.max(1, Math.min(a.frames.length, n - start)),
      x: p.x, y: p.y, scale: 1, rot: 0, flip: false, blend: 'source-over', opacity: 1, follow: false, keys: {}, ...extra };
    pushUndo();
    S.effects.push(inst);
    fxSel = inst.id;
    render();
    return inst;
  }

  function addBuiltin() {
    const type = $('fxType').value, color = $('fxColor').value, size = +$('fxSize').value || 10;
    const id = addAsset({ ...FX.builtin(type, color, size), spec: { type, color, size } });
    const extra = type === 'dust' ? { x: S.guides.cx, y: S.guides.base - Math.round(size * 0.5) } : {};
    if (type === 'slash' || type === 'spark') extra.blend = 'lighter';
    addEffect(id, extra);
  }

  /** The FX layer (removed effect pixels) of every frame becomes one effect, so it can be re-placed / re-blended. */
  function fxLayerAsEffect() {
    if (!S.frames.some(f => f.fxCanvas)) { status('FX 레이어가 비어 있습니다. ③ 이펙트 지우기에서 FX로 옮기세요.'); return; }
    const frames = S.frames.map((_, i) => cellCanvas(i, { main: false, effects: false }));
    const id = addAsset({ name: 'FX 레이어', frames, durations: null });
    addEffect(id, { start: 0, len: S.frames.length, x: S.cellW / 2, y: S.cellH / 2 });
  }

  async function importEffects(files) {
    const pngs = files.filter(f => !f.name.endsWith('.json')), jsons = files.filter(f => f.name.endsWith('.json'));
    for (const file of pngs) {
      const stem = baseName(file).replace(/_preview$/, '');
      const mf = jsons.find(j => baseName(j) === stem) || (jsons.length === 1 && pngs.length === 1 ? jsons[0] : null);
      let meta = null;
      try { meta = mf ? JSON.parse(await mf.text()) : null; } catch { status(`${mf.name}: JSON을 읽을 수 없어 한 장짜리로 엽니다.`); }
      const url = await readURL(file), { canvas } = await loadImage(url);
      // no meta: a row of square frames if the width is a multiple of the height, else one image
      const count = !meta && canvas.width % canvas.height === 0 ? canvas.width / canvas.height : 1;
      const a = FX.fromSheet(canvas, meta, stem, count);
      const id = addAsset({ ...a, url, meta, count });
      // pixelfx sheets: blend and impact like a recipe (its impact frame lands on ours), its pivot at the impact point
      addEffect(id, a.game ? { ...(a.durations && S.frames.length ? impactTiming(a) : {}), blend: BLEND_FROM_GAME[a.game.blend] || 'source-over' } : {});
    }
    status(`이펙트 ${pngs.length}개를 가져왔습니다.`);
  }

  const fxInst = id => S.effects.find(e => e.id === id);

  /**
   * Which asset frame instance e shows on character frame i (-1 = not visible). Assets with their own timing
   * (recipes, sheets with durations) follow real time: the time since the effect started (plus e.offset ms) picks
   * the frame. Assets without timing are stretched over the `len` character frames.
   */
  function fxFrameAt(e, i) {
    if (i < e.start || i >= e.start + e.len) return -1;
    const a = assets.get(e.asset), n = a.frames.length;
    if (!a.durations) return Math.min(n - 1, Math.floor((i - e.start) * n / e.len));
    let t = e.offset || 0;
    for (let j = e.start; j < i; j++) t += S.frames[j].dur;
    const total = a.durations.reduce((s, d) => s + d, 0);
    if (a.loop) t = ((t % total) + total) % total;
    if (t < 0 || t >= total) return -1;
    for (let k = 0, acc = 0; k < n; k++) { acc += a.durations[k]; if (t < acc) return k; }
    return -1;
  }

  // ---------- sa-fx@1 recipes (docs/fx-format.md) ----------
  const BLEND_FROM_GAME = { add: 'lighter', normal: 'source-over', screen: 'screen' };

  /** Render a recipe into asset fields (frames, durations, …). `slash` = trail shape / slash controls (optional). */
  function renderRecipe(recipe, ropts, slash = null) {
    let r = SAFX.render(slash ? SAFX_LIB.apply(recipe, slash) : recipe, ropts), used = recipe;
    // never clip: a recipe whose drawing reaches the canvas edge is re-rendered on a bigger canvas (same pixel sizes)
    for (let k = 0; k < 4 && r.frames.some(touchesEdge); k++) {
      const grown = growRecipe(used, 1.5);
      if (!grown) { r.warnings = [...(r.warnings || []), '캔버스 끝에서 잘림 (최대 크기)']; break; }
      used = grown;
      r = SAFX.render(slash ? SAFX_LIB.apply(used, slash) : used, ropts);
    }
    if (used !== recipe && !r.frames.some(touchesEdge)) r.warnings = [...(r.warnings || []), `캔버스를 ${used.size}px로 키움 (잘림 방지)`];
    return { name: recipe.name || '레시피', frames: r.frames, durations: r.durations, loop: r.loop, game: r.game, warnings: r.warnings, recipe: used, ropts, slash };
  }

  const visCache = new WeakMap();
  /** Bounding box { x0, y0, x1, y1 } (x1 / y1 exclusive) of the drawn pixels of a canvas, or null when empty. */
  function visibleBox(c) {
    if (visCache.has(c)) return visCache.get(c);
    let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
    if (c.width && c.height) {
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) if (d[(y * c.width + x) * 4 + 3]) {
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
    const v = x1 < 0 ? null : { x0, y0, x1: x1 + 1, y1: y1 + 1 };
    visCache.set(c, v);
    return v;
  }

  /** Any visible pixel on the outermost row / column of a frame canvas. */
  function touchesEdge(c) {
    if (!c || !c.width || !c.height) return false;
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data, w = c.width, h = c.height;
    for (let x = 0; x < w; x++) if (d[x * 4 + 3] || d[((h - 1) * w + x) * 4 + 3]) return true;
    for (let y = 0; y < h; y++) if (d[y * w * 4 + 3] || d[(y * w + w - 1) * 4 + 3]) return true;
    return false;
  }

  /** Copy of a recipe on an m× bigger canvas: lengths stay in pixels, positions (canvas fractions) keep their place. */
  function growRecipe(recipe, m) {
    const size = recipe.size || 64, to = Math.min(512, Math.round(size * m));
    if (to <= size) return null;
    const k = to / size, r = JSON.parse(JSON.stringify(recipe));
    r.size = to;
    const remap = v => (Array.isArray(v) ? v.map(key => [key[0], 0.5 + (key[1] - 0.5) / k, ...key.slice(2)]) : 0.5 + (v - 0.5) / k);
    for (const L of r.layers || []) {
      const def = (SAFX.DEF && SAFX.DEF[L.type]) || {};
      for (const f of ['x', 'y', 'x0', 'y0', 'x1', 'y1']) {
        const v = L[f] !== undefined ? L[f] : def[f] !== undefined ? def[f] : (f === 'x' || f === 'y') ? 0.5 : undefined;
        if (v !== undefined) L[f] = remap(v);
      }
    }
    return r;
  }

  /** Built-in recipe by key: "slash:<name>" for slash recipes, else the other built-ins (spark, dust, …). */
  const starterRecipe = key => SAFX_LIB.byKey(key);

  const SLASH_IDS = ['slAngle', 'slCurve', 'slRadius', 'slThick', 'slFade', 'slSparkle'];
  /** Slash controls → settings object (stored on the asset, saved in the project). */
  const readSlash = () => ({ shape: $('slShape').value, theme: $('slTheme').value, angle: +$('slAngle').value, curve: +$('slCurve').value,
    radius: +$('slRadius').value, thick: +$('slThick').value, fade: +$('slFade').value, sparkle: +$('slSparkle').value });
  function showSlash(a) {
    const s = a.slash || {};
    $('slShape').value = s.shape || 'original'; $('slTheme').value = s.theme || '';
    $('slAngle').value = s.angle || 0; $('slCurve').value = s.curve || 1; $('slRadius').value = s.radius || 1; $('slThick').value = s.thick || 1; $('slFade').value = s.fade || 1;
    $('slSparkle').value = s.sparkle ?? SAFX_LIB.sparkleTotal(a.recipe);
    $('slShape').disabled = !SAFX_LIB.hasSlash(a.recipe);
    SLASH_IDS.forEach(id => { document.querySelector(`output[for=${id}]`).textContent = $(id).value; });
  }

  // ---------- gallery: animated thumbnails of recipes and trail shapes ----------
  let galTimer = 0;
  function openGallery() {
    const thumbs = [];
    const card = (label, graph, onPick) => {
      const d = document.createElement('div'), c = document.createElement('canvas'), t = document.createElement('div');
      d.className = 'galcard'; t.textContent = label; c.width = c.height = 64;
      try { thumbs.push({ c, frames: SAFX.render(graph).frames }); } catch { t.textContent += ' (오류)'; }
      d.append(c, t); d.onclick = () => { $('gallery').close(); onPick(); };
      return d;
    };
    const rec = $('galRecipes'), shp = $('galShapes');
    rec.innerHTML = ''; shp.innerHTML = '';
    for (const b of SAFX_LIB.all()) rec.append(card(b.label, b.get(), () => addRecipe(b.get())));
    // shapes are shown on the selected slash recipe (or a plain horizontal slash)
    const e = fxInst(fxSel), a = e && assets.get(e.asset), base = a && a.recipe && SAFX_LIB.hasSlash(a.recipe) ? a.recipe : starterRecipe('slash:horizontal');
    for (const [k, label] of Object.entries(SAFX_LIB.SHAPES)) shp.append(card(label, SAFX_LIB.apply(base, { ...(a && a.slash), shape: k }), () => {
      if (a && a.recipe && SAFX_LIB.hasSlash(a.recipe)) { a.slash = { ...(a.slash || readSlash()), shape: k }; showSlash(a); rerenderRecipe(0); }
      else addRecipe(starterRecipe('slash:horizontal')).then(() => { const n = assets.get(fxInst(fxSel).asset); n.slash = { shape: k }; $('fxRecipe').dataset.asset = ''; buildFxList(); rerenderRecipe(0); });
    }));
    let f = 0;
    clearInterval(galTimer);
    galTimer = setInterval(() => {
      f++;
      for (const t of thumbs) {
        const g = t.c.getContext('2d'), fr = t.frames[f % (t.frames.length + 4)];   // short pause between loops
        g.imageSmoothingEnabled = false;
        g.fillStyle = '#23262e'; g.fillRect(0, 0, 64, 64);
        if (fr) g.drawImage(fr, 0, 0, 64, 64);
      }
    }, 70);
    $('gallery').showModal();
  }

  /** Timing that makes the recipe's impactFrame play exactly when our impact frame starts: {start, offset, len}. */
  function impactTiming(a) {
    const impMs = a.durations.slice(0, a.game.impactFrame || 0).reduce((s, d) => s + d, 0);
    // start a few character frames before our impact frame; offset = how far into the recipe we already are then
    let start = Math.min(Math.max(0, S.impact), S.frames.length - 1), acc = 0;
    while (start > 0 && acc + S.frames[start - 1].dur <= impMs) { start--; acc += S.frames[start].dur; }
    const offset = impMs - acc, total = a.durations.reduce((s, d) => s + d, 0);
    let len = 0;
    for (let t = offset, i = start; i < S.frames.length && t < total; i++) { t += S.frames[i].dur; len++; }
    return { start, offset, len: Math.max(1, len) };
  }

  /** Add a recipe as an effect: blend and timing from its "game" block; its impactFrame lands on ours. */
  async function addRecipe(recipe) {
    let a;
    await SAFX.preload(recipe);
    try { a = renderRecipe(recipe, { scale: 1, hue: 0, speed: 1 }); } catch (err) { status('레시피 오류: ' + err.message); return; }
    const id = addAsset(a);
    addEffect(id, { ...impactTiming(a), blend: BLEND_FROM_GAME[a.game.blend] || 'source-over' });
    const total = a.durations.reduce((s, d) => s + d, 0);
    status(`레시피 "${a.name}": ${a.frames.length}프레임 · ${Math.round(total)}ms` + (a.warnings.length ? ` · ${a.warnings.join(', ')}` : ''));
  }

  async function importRecipes(files) {
    for (const file of files) {
      try { await addRecipe(JSON.parse(await file.text())); }
      catch (err) { status(`${file.name}: ${err.message}`); }
    }
  }

  let recipeTimer = 0;
  /** Re-render the selected recipe from the text box + sliders (debounced while typing). */
  function rerenderRecipe(delay = 300) {
    clearTimeout(recipeTimer);
    recipeTimer = setTimeout(async () => {
      const e = fxInst(fxSel), a = e && assets.get(e.asset);
      if (!a || !a.recipe) return;
      let recipe;
      try { recipe = JSON.parse($('fxJson').value); } catch (err) { $('fxJsonMsg').textContent = 'JSON 오류: ' + err.message; $('fxJsonMsg').className = 'bad'; return; }
      await SAFX.preload(recipe);
      const ropts = { scale: +$('rScale').value, hue: +$('rHue').value, speed: +$('rSpeed').value };
      const slash = readSlash();
      if (!slash.theme) delete slash.theme;
      if (slash.sparkle === SAFX_LIB.sparkleTotal(recipe)) delete slash.sparkle;   // untouched: keep the recipe's own counts
      try {
        Object.assign(a, renderRecipe(recipe, ropts, slash), { version: a.version + 1 });
        if (slash.theme === 'ink' && e.blend === 'lighter') e.blend = 'source-over';   // black ink is invisible when added
        e.name = a.name;
        Object.assign(e, impactTiming(a));   // speed / impactFrame may have changed: keep the impact lined up
        $('fxJsonMsg').textContent = `${a.frames.length}프레임 · ${a.frames[0].width}px` + (a.warnings.length ? ` · ${a.warnings.join(', ')}` : ' · 렌더 완료');
        $('fxJsonMsg').className = 'dim';
        render();
      } catch (err) { $('fxJsonMsg').textContent = '레시피 오류: ' + err.message; $('fxJsonMsg').className = 'bad'; }
    }, delay);
  }

  /** Position on frame i: keyframes (linear between them, held outside) when following, else the fixed spot. */
  function fxPos(e, i) {
    const ks = Object.keys(e.keys).map(Number).sort((a, b) => a - b);
    if (!e.follow || !ks.length) return { x: e.x, y: e.y };
    if (e.keys[i]) return e.keys[i];
    const prev = ks.filter(k => k < i).pop(), next = ks.find(k => k > i);
    if (prev === undefined) return e.keys[next];
    if (next === undefined) return e.keys[prev];
    const t = (i - prev) / (next - prev), a = e.keys[prev], b = e.keys[next];
    return { x: Math.round(a.x + (b.x - a.x) * t), y: Math.round(a.y + (b.y - a.y) * t) };
  }

  const fxCache = new Map();
  /** Transformed (scaled / rotated / flipped, pixel-exact) asset frame k of instance e. */
  function fxCanvas(e, k) {
    const a = assets.get(e.asset), key = `${e.asset}|${a.version}|${k}|${e.scale}|${e.rot}|${e.flip}`;
    if (!fxCache.has(key)) fxCache.set(key, FX.transform(a.frames[k], e));
    return fxCache.get(key);
  }

  /** Top-left (cell px) and canvas of instance e on frame i, or null. */
  function fxPlaced(e, i) {
    const k = fxFrameAt(e, i);
    if (k < 0) return null;
    const c = fxCanvas(e, k), p = fxPos(e, i), o = e.anchorOfs || [0, 0];   // anchorOfs: visible centre / bottom vs canvas centre
    return { c, k, x: Math.round(p.x - c.width / 2 - o[0]), y: Math.round(p.y - c.height / 2 - o[1]) };
  }

  /** Draw every effect visible on frame i onto g (already in cell coordinates × z). */
  /** layer: 'over' (default) draws normal effects, 'under' the ones with e.under (afterimages behind the body). */
  // e.split (ground effects): the half behind the anchor line (above it on screen) is drawn under the body, the front
  // half over it, so a ring on the floor reads as lying around the feet.
  function drawEffects(g, i, z, layer = 'over') {
    for (const e of S.effects) {
      if (!e.split && !!e.under !== (layer === 'under')) continue;
      const pl = fxPlaced(e, i);
      if (!pl) continue;
      g.save();
      if (e.split) {
        const cut = fxPos(e, i).y * z, big = 1e5;
        g.beginPath();
        if (layer === 'under') g.rect(-big, -big, 2 * big, big + cut); else g.rect(-big, cut, 2 * big, big);
        g.clip();
      }
      g.globalCompositeOperation = e.blend; g.globalAlpha = e.opacity;
      g.imageSmoothingEnabled = false;
      g.drawImage(pl.c, pl.x * z, pl.y * z, pl.c.width * z, pl.c.height * z);
      g.restore();
    }
  }

  /**
   * Blade tip of a frame (cell px), or null when no blade is out. Steel = bright, grey pixels; they are grouped
   * (8-neighbour) and the blade is the long, thin group (score length² / area, length ≥ 20% of the sprite height),
   * so white socks, belts and highlights (short blobs) are ignored. The tip is the end farthest from the body.
   */
  function bladeTip(f, box = null) {
    const d = f.img.data, w = f.img.w, steel = new Map(), bx = f.ox + f.x0, by = f.oy + f.y0;
    for (let y = 0; y < f.img.h; y++) for (let x = 0; x < w; x++) {
      const j = (y * w + x) * 4;
      if (!d[j + 3]) continue;
      if (box && (bx + x < box[0] || by + y < box[1] || bx + x >= box[0] + box[2] || by + y >= box[1] + box[3])) continue;
      const mx = Math.max(d[j], d[j + 1], d[j + 2]), mn = Math.min(d[j], d[j + 1], d[j + 2]);
      if ((d[j] + d[j + 1] + d[j + 2]) / 3 >= 170 && mx - mn <= 40) steel.set(K(x, y), 1);
    }
    const minLen = Math.max(12, f.img.h * 0.2);
    let blade = null, bestScore = 0;
    for (const g of IO.groups(steel)) {
      const xs = g.map(KX), ys = g.map(KY), len = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
      const score = len * len / g.length;
      if (len >= minLen && score > bestScore) { bestScore = score; blade = g; }
    }
    if (!blade) return null;
    const cx = f.anchor.bx, cy = f.anchor.by * 0.55;
    let tip = blade[0], bd = -1;
    for (const k of blade) { const dd = (KX(k) - cx) ** 2 + (KY(k) - cy) ** 2; if (dd > bd) { bd = dd; tip = k; } }
    return { x: f.ox + f.x0 + KX(tip), y: f.oy + f.y0 + KY(tip) };
  }

  /** Tips of the n longest blades of a frame (twin daggers, dual swords), cell px; [] when none. Same steel test as bladeTip. */
  function bladeTipsN(f, n) {
    const d = f.img.data, w = f.img.w, steel = new Map();
    for (let y = 0; y < f.img.h; y++) for (let x = 0; x < w; x++) {
      const j = (y * w + x) * 4;
      if (!d[j + 3]) continue;
      const mx = Math.max(d[j], d[j + 1], d[j + 2]), mn = Math.min(d[j], d[j + 1], d[j + 2]);
      if ((d[j] + d[j + 1] + d[j + 2]) / 3 >= 170 && mx - mn <= 40) steel.set(K(x, y), 1);
    }
    const minLen = Math.max(10, f.img.h * 0.1), cx = f.anchor.bx, cy = f.anchor.by * 0.55, blades = [];
    for (const g of IO.groups(steel)) {
      const xs = g.map(KX), ys = g.map(KY), len = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
      if (len < minLen) continue;
      let tip = g[0], bd = -1;
      for (const k of g) { const dd = (KX(k) - cx) ** 2 + (KY(k) - cy) ** 2; if (dd > bd) { bd = dd; tip = k; } }
      blades.push({ score: len * len / g.length, x: f.ox + f.x0 + KX(tip), y: f.oy + f.y0 + KY(tip) });
    }
    return blades.sort((a, b) => b.score - a.score).slice(0, n).map(({ x, y }) => ({ x, y })).sort((a, b) => a.x - b.x);
  }

  function findBladeTips(e) {
    let n = 0;
    for (let i = e.start; i < e.start + e.len && i < S.frames.length; i++) {
      const t = bladeTip(S.frames[i]);
      if (t) { e.keys[i] = t; n++; }
    }
    e.follow = true;
    return n;
  }

  // ---------- automatic effects: trail along the tracked tip, hit spark, dust at the feet ----------
  const FADE_FRAMES = 2;   // frames a trail takes to vanish after the swing

  /** Tip in every frame; frames where none was found get the in-between of their neighbours. */
  function trackTips() {
    const t = S.frames.map(bladeTip), known = t.map((p, i) => p ? i : -1).filter(i => i >= 0);
    if (!known.length) return t.map(() => ({ x: Math.round(S.cellW / 2), y: Math.round(S.cellH / 3) }));
    return t.map((p, i) => {
      if (p) return p;
      const a = known.filter(k => k < i).pop(), b = known.find(k => k > i);
      if (a === undefined) return { ...t[b] };
      if (b === undefined) return { ...t[a] };
      const u = (i - a) / (b - a);
      return { x: Math.round(t[a].x + (t[b].x - t[a].x) * u), y: Math.round(t[a].y + (t[b].y - t[a].y) * u) };
    });
  }

  /** Tip movement (px) into each frame, and the swings: runs of frames where it is fast. */
  function swingInfo(tips) {
    const sp = tips.map((p, i) => i ? Math.hypot(p.x - tips[i - 1].x, p.y - tips[i - 1].y) : 0);
    const thr = Math.max(4, Math.max(...sp) * 0.35), swings = [];
    sp.forEach((v, i) => {
      if (v < thr) return;
      const last = swings[swings.length - 1];
      if (last && last.b === i - 1) last.b = i; else swings.push({ a: i, b: i });
    });
    swings.forEach(s => { s.peak = Math.max(...sp.slice(s.a, s.b + 1)); });
    return { sp, thr, swings };
  }

  /** Smooth curve through points (Catmull-Rom), about one sample per pixel so the stamped trail has no gaps. */
  function smoothPath(pts) {
    if (pts.length < 2) return pts.slice();
    const out = [], P = i => pts[Math.max(0, Math.min(pts.length - 1, i))];
    for (let i = 0; i < pts.length - 1; i++) for (let s = 0, k = Math.max(4, Math.ceil(Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y))); s < k; s++) {
      const t = s / k, p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2), t2 = t * t, t3 = t2 * t;
      const c = (a, b, c2, d) => 0.5 * (2 * b + (-a + c2) * t + (2 * a - 5 * b + 4 * c2 - d) * t2 + (-a + 3 * b - 3 * c2 + d) * t3);
      out.push({ x: c(p0.x, p1.x, p2.x, p3.x), y: c(p0.y, p1.y, p2.y, p3.y) });
    }
    out.push(pts[pts.length - 1]);
    return out;
  }

  /**
   * One cell-sized canvas per character frame with the trail: the smoothed tip path of the current swing up to
   * this frame, thick and bright at the head, thin and dark at the tail (palette bands of the chosen style).
   * After the swing the tail is eaten away over FADE_FRAMES frames. The shape option changes the thickness profile
   * or adds a pattern.
   */
  function trailFrames() {
    const A = S.autoFx, tips = A.tips, { swings } = swingInfo(tips), shape = A.shape;
    const cols = SAFX_LIB.THEMES[A.style].colors.map(hexToRgb), W = S.cellW, H = S.cellH;
    return S.frames.map((_, i) => {
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      const s = swings.find(w => i >= w.a && i <= w.b + FADE_FRAMES);
      if (!s) return c;
      const path = smoothPath(tips.slice(Math.max(0, s.a - 1), Math.min(i, s.b) + 1));
      const fade = i > s.b ? (i - s.b) / (FADE_FRAMES + 1) : 0, maxW = Math.max(2, Math.min(9, 2 + s.peak * 0.18));
      const buf = new Float32Array(W * H), stamp = (x, y, r, v) => {
        for (let yy = Math.floor(y - r); yy <= y + r; yy++) for (let xx = Math.floor(x - r); xx <= x + r; xx++) {
          if (xx < 0 || yy < 0 || xx >= W || yy >= H || (xx + 0.5 - x) ** 2 + (yy + 0.5 - y) ** 2 > r * r) continue;
          buf[yy * W + xx] = Math.max(buf[yy * W + xx], v);
        }
      };
      const n = path.length;
      for (let j = 0; j < n; j++) {
        const u = n > 1 ? j / (n - 1) : 1;
        if (u < fade) continue;
        const p = path[j], q = path[Math.max(0, j - 1)], len = Math.hypot(p.x - q.x, p.y - q.y) || 1;
        const nx = -(p.y - q.y) / len, ny = (p.x - q.x) / len;   // normal to the path
        const v = (0.3 + 0.7 * u) * (1 - fade * 0.6);
        let w = maxW * u ** 1.5, off = 0;
        switch (shape) {
          case 'crescent': w = maxW * 0.5 * u ** 1.8; break;
          case 'halfmoon': w = maxW * (0.6 + 0.4 * u); break;
          case 'comet': w = maxW * u ** 2.2; break;
          case 'ribbon': off = Math.sin(j * 0.25) * maxW * 0.4; w = maxW * 0.6 * u ** 1.2; break;
          case 'segmented': if (Math.floor(j / 5) % 2) continue; break;
          case 'jagged': off = (Math.floor(j / 2) % 2 ? 1 : -1) * Math.min(2, maxW * 0.3) * u; break;
          case 'zigzag': off = ((j % 8) < 4 ? (j % 4) - 2 : 2 - (j % 4)) * maxW * 0.25; w = Math.max(1, maxW * 0.25); break;
          case 'double': stamp(p.x + nx * maxW * 0.45, p.y + ny * maxW * 0.45, Math.max(0.5, maxW * 0.15 * u), v); off = -maxW * 0.45; w = maxW * 0.3 * u; break;
        }
        stamp(p.x + nx * off, p.y + ny * off, Math.max(0.5, w / 2), v);
      }
      if (shape === 'comet' && fade === 0 && n) stamp(path[n - 1].x, path[n - 1].y, maxW * 0.45, 1);
      const g = c.getContext('2d'), img = g.createImageData(W, H);
      for (let p = 0; p < W * H; p++) {
        if (buf[p] < 0.12) continue;
        const col = cols[Math.min(cols.length - 1, Math.floor((buf[p] - 0.12) / 0.88 * cols.length))];
        img.data.set([col[0], col[1], col[2], 255], p * 4);
      }
      g.putImageData(img, 0, 0);
      return c;
    });
  }

  /** Feet of a frame (cell px): left / right ends of the lowest body rows. */
  function feet(f) {
    const d = f.img.data, w = f.img.w, by = Math.max(0, Math.round(f.anchor.by) - 2);
    let l = Infinity, r = -Infinity;
    for (let y = by; y < f.img.h; y++) for (let x = 0; x < w; x++) if (d[(y * w + x) * 4 + 3]) { l = Math.min(l, x); r = Math.max(r, x); }
    const ox = f.ox + f.x0;
    return l > r ? null : { l: ox + l, r: ox + r, top: f.oy + f.y0 };
  }

  /** Frames where the feet / body move a lot (lunge, stomp): at most two, not next to each other. */
  function strongSteps() {
    const ft = S.frames.map(feet), m = ft.map((p, i) => i && p && ft[i - 1] ? Math.abs(p.l - ft[i - 1].l) + Math.abs(p.r - ft[i - 1].r) + Math.abs(p.top - ft[i - 1].top) * 0.5 : 0);
    const thr = Math.max(4, Math.max(...m) * 0.6);
    const picks = m.map((v, i) => ({ v, i })).filter(o => o.v >= thr).sort((a, b) => b.v - a.v);
    const out = [];
    for (const o of picks) if (out.length < 2 && out.every(p => Math.abs(p - o.i) > 1)) out.push(o.i);
    return out.sort((a, b) => a - b).map(i => ({ i, x: Math.round((ft[i].l + ft[i].r) / 2) }));
  }

  const makeInst = (assetId, extra) => {
    const a = assets.get(assetId);
    return { id: 'e' + nextId++, asset: assetId, name: a.name, start: 0, len: S.frames.length, x: 0, y: 0, scale: 1, rot: 0, flip: false,
      blend: 'source-over', opacity: 1, follow: false, keys: {}, ...extra };
  };

  /** ✨ 자동 이펙트: (re)build the trail, spark and dust; retrack = find the tips again. */
  function runAutoFx(retrack = true) {
    if (!S.frames.length) { status('먼저 그림을 여세요.'); return; }
    pushUndo();
    const A = S.autoFx;
    if (retrack || A.tips.length !== S.frames.length) A.tips = trackTips();
    S.effects = S.effects.filter(e => !e.auto);
    const glow = A.style === 'ink' ? 'source-over' : 'lighter', made = [];
    if (A.trail && swingInfo(A.tips).swings.length) {
      const id = addAsset({ name: '자동 궤적', frames: trailFrames(), durations: null, kind: 'autoTrail' });
      S.effects.push(makeInst(id, { auto: 'trail', x: S.cellW / 2, y: S.cellH / 2, blend: glow }));
      made.push('궤적');
    }
    if (A.spark) {
      const a = renderRecipe(starterRecipe('spark'), { scale: 1, hue: 0, speed: 1 }, { theme: A.style });
      const id = addAsset(a), tip = A.tips[S.impact];
      S.effects.push(makeInst(id, { ...impactTiming(a), auto: 'spark', x: tip.x, y: tip.y, blend: glow }));
      made.push('타격 불꽃');
    }
    if (A.dust) for (const st of strongSteps()) {
      const a = renderRecipe(starterRecipe('dust'), { scale: 1, hue: 0, speed: 1 });
      const id = addAsset(a);
      // the dust recipe puffs ~13 px below its centre: put that on the feet line
      S.effects.push(makeInst(id, { auto: 'dust', start: st.i, len: Math.min(4, S.frames.length - st.i), x: st.x, y: S.guides.base - 13 }));
      made.push(`먼지 #${st.i}`);
    }
    fxSel = null;
    render();
    const { swings } = swingInfo(A.tips);
    status(`자동 이펙트: ${made.join(', ') || '없음'} · 휘두름 ${swings.map(s => `#${s.a}–#${s.b}`).join(', ') || '없음'}. 편집 창의 노란 ◆(칼끝)를 끌어 고치세요.`);
  }

  /** After a tip is dragged or the style changes: redraw the trail and move the spark, keep everything else. */
  function refreshAutoFx() {
    const A = S.autoFx;
    for (const e of S.effects) {
      const a = assets.get(e.asset);
      if (e.auto === 'trail' && a) { a.frames = trailFrames(); a.version++; }
      if (e.auto === 'spark' && A.tips[S.impact]) { e.x = A.tips[S.impact].x; e.y = A.tips[S.impact].y; }
    }
  }

  function buildAutoInfo() {
    const A = S.autoFx, el = $('autoInfo');
    if (!A.tips.length || A.tips.length !== S.frames.length) { el.textContent = ''; return; }
    const { sp, thr } = swingInfo(A.tips);
    el.innerHTML = '칼끝 속도 (px/프레임): ' + sp.map((v, i) => `<span class="${v >= thr ? 'fast' : ''}">#${i} ${Math.round(v)}</span>`).join(' ');
  }

  /** Effect editor in step ④ for the selected instance. */
  function buildFxList() {
    const list = $('fxList');
    list.innerHTML = '';
    S.effects.forEach(e => {
      const row = document.createElement('div');
      row.className = 'fxrow' + (e.id === fxSel ? ' on' : '');
      const name = document.createElement('span');
      name.textContent = `${e.name} · #${e.start}–#${e.start + e.len - 1}`;
      const del = document.createElement('button');
      del.textContent = '✕'; del.className = 'sm'; del.title = '이 이펙트 삭제';
      del.onclick = ev => { ev.stopPropagation(); pushUndo(); S.effects = S.effects.filter(x => x !== e); if (fxSel === e.id) fxSel = null; render(); };
      row.append(name, del);
      row.onclick = () => { fxSel = e.id; render(); };
      list.append(row);
    });
    const e = fxInst(fxSel);
    $('fxEdit').hidden = !e;
    if (!e) return;
    const a = assets.get(e.asset);
    $('fxStart').value = e.start; $('fxLen').value = e.len; $('fxScale').value = e.scale;
    $('fxRot').value = [0, 90, 180, 270].includes(e.rot) && !e.freeRot ? String(e.rot) : 'free';
    $('fxAngle').value = e.rot; $('fxAngleRow').hidden = $('fxRot').value !== 'free';
    document.querySelector('output[for=fxAngle]').textContent = e.rot + '°';
    $('fxFlip').checked = e.flip; $('fxBlend').value = e.blend; $('fxOpacity').value = e.opacity;
    document.querySelector('output[for=fxOpacity]').textContent = Math.round(e.opacity * 100) + '%';
    $('fxFollow').checked = e.follow;
    $('fxBuiltinRow').hidden = !a.spec;
    if (a.spec) { $('fxBColor').value = a.spec.color; $('fxBSize').value = a.spec.size; }
    $('fxRecipe').hidden = !a.recipe;
    if (a.recipe && $('fxRecipe').dataset.asset !== e.asset) {   // fill the editor only when another recipe is selected
      $('fxRecipe').dataset.asset = e.asset;
      $('fxJson').value = JSON.stringify(a.recipe, null, 1);
      $('rScale').value = a.ropts.scale; $('rHue').value = a.ropts.hue; $('rSpeed').value = a.ropts.speed;
      ['rScale', 'rHue', 'rSpeed'].forEach(id => { document.querySelector(`output[for=${id}]`).textContent = $(id).value; });
      showSlash(a);
      $('fxJsonMsg').textContent = '';
    }
    const p = fxPos(e, cur);
    $('fxInfo').textContent = `프레임 ${a.frames.length}장 · 위치 (${p.x}, ${p.y})` + (e.follow ? ` · 키프레임 ${Object.keys(e.keys).length}개` : '');
  }

  function bindEffects() {
    const edit = fn => () => { const e = fxInst(fxSel); if (!e) return; pushUndo(); fn(e); render(); };
    $('btnFxAdd').onclick = addBuiltin;
    $('fileRecipe').onchange = e => { const files = [...e.target.files]; e.target.value = ''; if (files.length) importRecipes(files); };
    $('btnStarter').onclick = () => addRecipe(starterRecipe($('starter').value));
    for (const k of SAFX_LIB.SLASH_ORDER) $('starterSlash').append(new Option(SAFX_LIB.SLASH_LABELS[k], 'slash:' + k));
    for (const k of SAFX_LIB.OTHER_ORDER) $('starterOther').append(new Option(SAFX_LIB.OTHER_LABELS[k], k));
    for (const [k, label] of Object.entries(SAFX_LIB.SHAPES)) $('slShape').append(new Option(label, k));
    for (const [k, t] of Object.entries(SAFX_LIB.THEMES)) $('slTheme').append(new Option(t.label, k));
    $('slShape').onchange = $('slTheme').onchange = () => rerenderRecipe(0);
    for (const id of SLASH_IDS) {
      $(id).oninput = () => { document.querySelector(`output[for=${id}]`).textContent = $(id).value; };
      $(id).onchange = () => rerenderRecipe(0);
    }
    $('btnGallery').onclick = openGallery;
    // automatic effects
    for (const [k, label] of Object.entries({ whiteblue: '기본 (흰·파랑)', gold: '금빛', fire: '화염', ice: '얼음', ink: '먹 (잉크)', volt: '번개' })) $('autoStyle').append(new Option(label, k));
    for (const k of ['tapered', 'crescent', 'halfmoon', 'comet', 'ribbon', 'segmented', 'jagged', 'double', 'zigzag']) $('autoShape').append(new Option(SAFX_LIB.SHAPES[k], k));
    const autoSync = () => { $('autoStyle').value = S.autoFx.style; $('autoShape').value = S.autoFx.shape; ['trail', 'spark', 'dust'].forEach(k => { $('auto_' + k).checked = S.autoFx[k]; }); };
    autoSync();
    const autoChanged = () => {
      Object.assign(S.autoFx, { style: $('autoStyle').value, shape: $('autoShape').value, trail: $('auto_trail').checked, spark: $('auto_spark').checked, dust: $('auto_dust').checked });
      if (S.effects.some(e => e.auto)) runAutoFx(false);   // live: rebuild with the same tips
    };
    ['autoStyle', 'autoShape', 'auto_trail', 'auto_spark', 'auto_dust'].forEach(id => { $(id).onchange = autoChanged; });
    $('btnAutoFx').onclick = () => runAutoFx(true);
    window.addEventListener('sa-project-loaded', autoSync);
    $('gallery').addEventListener('close', () => clearInterval(galTimer));
    $('fxJson').oninput = () => rerenderRecipe(400);
    for (const id of ['rScale', 'rHue', 'rSpeed']) {
      $(id).oninput = () => { document.querySelector(`output[for=${id}]`).textContent = $(id).value; };
      $(id).onchange = () => rerenderRecipe(0);
    }
    $('btnRecipeSave').onclick = () => {
      const e = fxInst(fxSel), a = e && assets.get(e.asset);
      if (a && a.recipe) download(new Blob([JSON.stringify(a.recipe, null, 2)], { type: 'application/json' }), `${(a.name || 'recipe').replace(/[\\/:*?"<>|\s]+/g, '_')}.safx.json`);
    };
    $('btnFxLayer').onclick = fxLayerAsEffect;
    $('fileFx').onchange = e => { const files = [...e.target.files]; e.target.value = ''; if (files.length) importEffects(files); };
    $('fxStart').onchange = edit(e => { e.start = Math.max(0, Math.min(S.frames.length - 1, Math.round(+$('fxStart').value))); });
    $('fxLen').onchange = edit(e => { e.len = Math.max(1, Math.round(+$('fxLen').value)); });
    $('fxScale').onchange = edit(e => { e.scale = Math.max(1, Math.min(8, Math.round(+$('fxScale').value))); });
    $('fxRot').onchange = edit(e => { e.freeRot = $('fxRot').value === 'free'; if (!e.freeRot) e.rot = +$('fxRot').value; });
    $('fxAngle').oninput = () => { document.querySelector('output[for=fxAngle]').textContent = $('fxAngle').value + '°'; };
    $('fxAngle').onchange = edit(e => { e.rot = +$('fxAngle').value; e.freeRot = true; });
    $('fxFlip').onchange = edit(e => { e.flip = $('fxFlip').checked; });
    $('fxBlend').onchange = edit(e => { e.blend = $('fxBlend').value; });
    $('fxOpacity').oninput = () => { document.querySelector('output[for=fxOpacity]').textContent = Math.round($('fxOpacity').value * 100) + '%'; };
    $('fxOpacity').onchange = edit(e => { e.opacity = +$('fxOpacity').value; });
    $('fxFollow').onchange = edit(e => { e.follow = $('fxFollow').checked; });
    const rebuild = edit(e => {
      const a = assets.get(e.asset);
      a.spec = { ...a.spec, color: $('fxBColor').value, size: +$('fxBSize').value || a.spec.size };
      Object.assign(a, FX.builtin(a.spec.type, a.spec.color, a.spec.size), { version: a.version + 1 });
    });
    $('fxBColor').onchange = rebuild; $('fxBSize').onchange = rebuild;
    $('btnFxImpact').onclick = edit(e => {
      if (!S.impactPoint) { status('먼저 ◎ 도구로 임팩트 지점을 찍으세요.'); return; }
      if (e.follow) e.keys[S.impact] = { ...S.impactPoint }; else { e.x = S.impactPoint.x; e.y = S.impactPoint.y; }
      e.start = Math.min(e.start, Math.max(0, S.impact));
    });
    $('btnFxTip').onclick = edit(e => { status(`칼끝을 ${findBladeTips(e)}개 프레임에서 찾았습니다. 틀린 곳은 ✦ 도구로 끌어 고치세요.`); });
    $('btnFxKeysClear').onclick = edit(e => { e.keys = {}; });
  }

  // ---------- undo / redo (positions, edits, FX, frame list, impact, effects) ----------
  const undoStack = [], redoStack = [];
  const snapshot = () => ({
    frames: S.frames.map(f => ({ f, ox: f.ox, oy: f.oy, edits: new Map(f.edits), fx: new Map(f.fx) })),
    impact: S.impact, impactPoint: S.impactPoint, cur, effects: JSON.parse(JSON.stringify(S.effects)),
    tips: JSON.parse(JSON.stringify(S.autoFx.tips)),
  });
  function pushUndo() { undoStack.push(snapshot()); if (undoStack.length > 100) undoStack.shift(); redoStack.length = 0; }
  function restore(s) {
    S.frames = s.frames.map(e => { Object.assign(e.f, { ox: e.ox, oy: e.oy, edits: new Map(e.edits), fx: new Map(e.fx) }); compose(e.f); return e.f; });
    S.impact = s.impact; S.impactPoint = s.impactPoint; cur = s.cur; S.effects = s.effects;
    S.autoFx.tips = s.tips || [];
    refreshAutoFx();
    if (!fxInst(fxSel)) fxSel = null;
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

  /** Tracked blade tips: faint path of all frames, the current frame's tip as a draggable yellow diamond. */
  function drawTips(g, z, i, small = false) {
    const t = S.autoFx.tips;
    if (t.length !== S.frames.length || !t[i]) return;
    if (!small) {
      g.strokeStyle = 'rgba(255,212,90,0.45)'; g.lineWidth = 1;
      g.beginPath(); t.forEach((p, j) => j ? g.lineTo((p.x + 0.5) * z, (p.y + 0.5) * z) : g.moveTo((p.x + 0.5) * z, (p.y + 0.5) * z)); g.stroke();
    }
    const x = (t[i].x + 0.5) * z, y = (t[i].y + 0.5) * z, r = small ? 2 : Math.max(4, z);
    g.fillStyle = '#ffd45a'; g.strokeStyle = '#000';
    g.beginPath(); g.moveTo(x, y - r); g.lineTo(x + r, y); g.lineTo(x, y + r); g.lineTo(x - r, y); g.closePath(); g.fill(); if (!small) g.stroke();
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
    if (fx && S.showEffects && f) drawEffects(g, i, z, 'under');
    blitFrame(g, f, z);
    if (fx && S.showEffects && f) drawEffects(g, i, z);
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

  /** Frame i composited into one cell: character (main), FX layer, placed effects (with their blend modes);
   *  optionally mirrored for the left-facing version. Used by preview and export. */
  function cellCanvas(i, { flip = false, fx = true, main = true, effects = true } = {}) {
    const c = document.createElement('canvas');
    c.width = S.cellW; c.height = S.cellH;
    const g = c.getContext('2d'), f = S.frames[i];
    // effects: true = both layers, 'under' / 'over' = only the part behind / in front of the body
    if (effects === true || effects === 'under') drawEffects(g, i, 1, 'under');
    if (main) g.drawImage(f.canvas, f.ox + f.x0, f.oy + f.y0);
    if (fx && f.fxCanvas) g.drawImage(f.fxCanvas, f.ox + f.fx0, f.oy + f.fy0);
    if (effects === true || effects === 'over') drawEffects(g, i, 1);
    if (!flip) return c;
    const m = document.createElement('canvas');
    m.width = S.cellW; m.height = S.cellH;
    const h = m.getContext('2d');
    h.translate(S.cellW, 0); h.scale(-1, 1); h.drawImage(c, 0, 0);
    return m;
  }

  let dispScale = 1;
  function drawSource() {
    const cv = $('src');
    if (!src) { cv.width = cv.height = 0; return; }
    dispScale = Math.min(1, ($('srcWrap').clientWidth - 14) / src.w);
    cv.width = Math.round(src.w * dispScale); cv.height = Math.round(src.h * dispScale);
    const g = cv.getContext('2d');
    if (keyPreview) g.drawImage(keyPreview.canvas, 0, 0, cv.width, cv.height);   // what the new background settings would remove: red
    else if ($('showKeyed').checked) { checker(g, cv.width, cv.height, 8); g.drawImage(keyedCanvas, 0, 0, cv.width, cv.height); }
    else g.drawImage(srcCanvas, 0, 0, cv.width, cv.height);
    g.font = '12px system-ui';
    S.frames.forEach((f, i) => {
      const b = f.box, s = dispScale;
      g.strokeStyle = boxSel.has(i) ? '#ffd45a' : i === cur ? '#5aa9ff' : '#ff4fd8';
      g.lineWidth = boxSel.has(i) || i === cur ? 2 : 1;
      g.strokeRect(b.x * s + 0.5, b.y * s + 0.5, b.w * s, b.h * s);
      g.fillStyle = g.strokeStyle; g.fillText('#' + i + (f.raw ? '*' : ''), b.x * s + 2, b.y * s - 3);
    });
    if (S.head) S.frames.forEach((f, i) => {   // head boxes: reference solid, matches dashed with their scale
      const h = i === S.head.frame ? S.head : f.head, s = dispScale;
      if (!h) return;
      g.strokeStyle = '#ffd45a'; g.lineWidth = 1;
      if (i !== S.head.frame) g.setLineDash([3, 3]);
      g.strokeRect(h.x * s + 0.5, h.y * s + 0.5, h.w * s, h.h * s); g.setLineDash([]);
      g.fillStyle = '#ffd45a'; g.fillText(i === S.head.frame ? '머리 기준' : Math.round(h.s * 100) + '%', h.x * s + 2, (h.y + h.h) * s + 12);
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
    drawTips(g, S.zoom, cur);
    const se = fxInst(fxSel), pl = se && S.showEffects && fxPlaced(se, cur);
    if (pl) {   // selected effect: dashed box
      const z = S.zoom;
      g.strokeStyle = '#7dffef'; g.setLineDash([3, 3]); g.lineWidth = 1;
      g.strokeRect(pl.x * z + 0.5, pl.y * z + 0.5, pl.c.width * z, pl.c.height * z); g.setLineDash([]);
    }
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
    g.imageSmoothingEnabled = S.smooth;   // smooth art previews smoothly scaled
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
    g.imageSmoothingEnabled = S.smooth;
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

  /** Reference frame and current frame side by side at the same zoom, head boxes drawn: sizes must match. */
  function drawRefCompare() {
    const f = S.frames[cur], ref = S.head ? S.frames[S.head.frame] : S.frames[0], b4 = $('before'), af = $('after');
    const z = 4;
    for (const [cv, fr, label] of [[b4, ref, '기준'], [af, f, '현재']]) {
      cv.width = fr.canvas.width * z; cv.height = fr.canvas.height * z + 14;
      const g = cv.getContext('2d');
      g.imageSmoothingEnabled = false;
      checker(g, cv.width, cv.height, 16);
      g.drawImage(fr.canvas, 0, 14, cv.width, cv.height - 14);
      g.fillStyle = '#fff'; g.font = '11px system-ui';
      g.fillText(`${label} #${S.frames.indexOf(fr)} · ${pixelOf(fr)}px` + (fr.head && S.head ? ` · 머리 ${Math.round(headRatio(fr) * 100)}%` : ''), 2, 11);
      if (fr.head && fr.base.sx !== undefined) {   // head box mapped from source to true pixels
        const p = pixelOf(fr), x = (fr.head.x - fr.base.sx) / p - fr.x0, y = (fr.head.y - fr.base.sy) / p - fr.y0;
        g.strokeStyle = '#ffd45a'; g.setLineDash([4, 3]);
        g.strokeRect(x * z, 14 + y * z, fr.head.w / p * z, fr.head.h / p * z); g.setLineDash([]);
      }
    }
  }

  /** Before (source crop, scaled so one AI pixel ≈ 8 screen px) next to after (true pixels at 8×). */
  function drawCompare() {
    const f = S.frames[cur], b4 = $('before'), af = $('after');
    if (!f || !srcCanvas) return;
    if (S.compareMode === 'ref') return drawRefCompare();
    const s = 8 / pixelOf(f), b = f.box;
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
      const star = btn(i === S.impact ? '★' : '☆', i === S.impact ? '임팩트 끄기 (임팩트 프레임 없음: 달리기·걷기 같은 반복 동작)' : '임팩트(타격) 프레임으로 지정', () => { pushUndo(); S.impact = i === S.impact ? -1 : i; render(); });
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
    $('impactInfo').textContent = !S.frames.length ? '' : S.impact < 0 ? '임팩트 프레임: 없음 (★를 눌러 지정)' : `임팩트 프레임: #${S.impact}` + (S.impactPoint ? ` · 지점 (${S.impactPoint.x}, ${S.impactPoint.y})` : ' · 지점 없음');
  }
  const thumbZoom = () => Math.max(1, Math.min(3, Math.floor(100 / S.cellH)));
  const drawThumb = i => { if (thumbs[i]) drawTips(drawCell(thumbs[i], thumbZoom(), i, { guides: true, sel: true }), thumbZoom(), i, true); };

  function render() {
    cur = Math.min(cur, Math.max(0, S.frames.length - 1));
    if (S.head) {   // the reference frame is whichever box holds the head box (frames may be reordered)
      S.head.frame = boxAt(S.head.x + S.head.w / 2, S.head.y + S.head.h / 2);
      if (S.head.frame < 0) S.head = null;
    }
    if (S.impact >= 0) S.impact = Math.min(S.impact, Math.max(0, S.frames.length - 1));   // (-1: no impact frame)
    drawSource(); drawEditor(); drawPreview(); drawCompare(); buildStrip(); buildHeadList(); buildFxList(); buildAutoInfo();
    const f = S.frames[cur];
    $('framePixel').value = f && f.pixel ? f.pixel : '';
    $('framePixel').placeholder = f ? String(pixelOf(f)) : '';
  }

  function select(i) {
    cur = i;
    render();
    $('editor').focus();
  }

  // the impact frame index follows its frame through reorder / delete / duplicate
  function remapImpact(oldFrames) {
    if (S.impact < 0) return;
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
    'toFx', 'exportLeft', 'batchAutoPixel', 'perFramePixel', 'showEffects', 'keyEdge', 'keyBorders', 'keyMarks', 'smooth', 'fringe'];

  function syncInputs() {
    for (const k of NUM_INPUTS) $(k).value = S[k];
    for (const k of CHECKS) $(k).checked = S[k];
    $('alignBy').value = S.alignBy;
    $('name').value = S.name; $('keyColor').value = rgbToHex(S.key); $('gifBg').value = S.gifBg;
    $('outlineColor').value = S.outlineColor; $('paintColor').value = S.paintColor; $('scope').value = S.scope;
    $('compareMode').value = S.compareMode; $('effectsMode').value = S.effectsMode;
    document.querySelectorAll('output').forEach(o => { o.textContent = $(o.htmlFor.value).value; });
    // smooth art: the pixel size is just a scale; the pixel-art-only settings are hidden
    $('pixelLabel').textContent = S.smooth ? '축소 (원본 px ÷)' : 'AI 픽셀 크기';
    $('pixelHead').textContent = S.smooth ? '크기' : '픽셀';
    document.querySelectorAll('.pixelOnly').forEach(el => { el.hidden = S.smooth; });
    $('pixelCands').innerHTML = '';
    if (S.smooth) return;
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
      tol: previewKey, edge: previewKey, despill: () => reprocess(true), keyEdge: previewKey, keyBorders: previewKey, keyMarks: previewKey,
      pixel: () => reprocess(false), lone: () => reprocess(false), colors: repalette, sharedPalette: repalette,
      // switching modes rescales every frame: recompute the cell and guides so nothing ends up outside the cell
      smooth: async () => { if (S.smooth) S.pixel = 1; else if (keyed && S.frames.length) detectPixel(); syncInputs(); await reprocess(true); if (S.frames.length) { autoCell(); render(); } },
      fringe: () => reprocess(true),
      outline: () => { if (S.outline) { S.outlineColor = darkest(); syncInputs(); } recomposeAll(); },
      cellW: render, cellH: render, zoom: drawEditor, pzoom: drawPreview, grid: render, onion: drawEditor,
      flipView: drawPreview, gameView: drawPreview, tile: drawPreview, gameScale: drawPreview,
      perFramePixel: () => { if (S.perFramePixel && keyed) detectFramePixels(); reprocess(false); },
      showEffects: drawEditor,
    };
    for (const k of NUM_INPUTS) {
      const el = $(k), live = ['zoom', 'pzoom'].includes(k);
      el.addEventListener('input', () => { const o = document.querySelector(`output[for=${k}]`); if (o) o.textContent = el.value; });
      el.addEventListener(live ? 'input' : 'change', () => {
        if (KEY_FIELDS.includes(k) && !keyBefore) keyBefore = Object.fromEntries(KEY_FIELDS.map(f => [f, JSON.parse(JSON.stringify(S[f]))]));
        const v = +el.value;
        if (!Number.isFinite(v)) return;
        S[k] = INTS.includes(k) ? Math.round(v) : v;
        (after[k] || (() => {}))();
      });
    }
    for (const k of CHECKS) $(k).addEventListener('change', () => {
      if (KEY_FIELDS.includes(k) && !keyBefore) keyBefore = Object.fromEntries(KEY_FIELDS.map(f => [f, JSON.parse(JSON.stringify(S[f]))]));
      S[k] = $(k).checked; (after[k] || (() => {}))();
    });
    $('name').onchange = () => { S.name = $('name').value.trim() || 'sprite'; };
    $('keyColor').onchange = () => keyChanged(() => { S.key = hexToRgb($('keyColor').value); });
    $('btnKeyApply').onclick = () => { keyBefore = null; reprocess(true); };
    $('btnKeyUndo').onclick = () => { if (keyBefore) Object.assign(S, keyBefore); keyBefore = null; keyPreview = null; syncInputs(); showKeyPending(); drawSource(); };
    $('gifBg').onchange = () => { S.gifBg = $('gifBg').value; };
    $('outlineColor').onchange = () => { S.outlineColor = $('outlineColor').value; if (S.outline) recomposeAll(); };
    $('paintColor').onchange = () => { S.paintColor = $('paintColor').value; };
    $('scope').onchange = () => { S.scope = $('scope').value; };
    $('compareMode').onchange = () => { S.compareMode = $('compareMode').value; drawCompare(); };
    $('effectsMode').onchange = () => { S.effectsMode = $('effectsMode').value; };
    $('framePixel').onchange = () => {
      const f = S.frames[cur], v = +$('framePixel').value;
      if (!f) return;
      f.pixel = v > 0 ? v : null;
      reprocess(false);
    };
    $('btnFramePixelReset').onclick = () => { const f = S.frames[cur]; if (f) { f.pixel = null; reprocess(false); } };
    $('btnHeadBox').onclick = () => { if (!src) return; setMode('head'); status('원본 창에서 한 프레임의 머리를 드래그로 감싸세요.'); };
    $('btnHeadCompare').onclick = () => { compareHeads(); render(); };
    $('btnHeadFit').onclick = fitHeads;
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
    $('btnAutoPlace').onclick = () => {
      pushUndo();
      const torso = alignMode() === 'torso';
      if (torso) autoCell(); else S.frames.forEach(autoPlace);   // (torso: the cell may need to grow sideways / up)
      render();
      status(torso ? '자동 정렬 (몸통 기준): 머리·몸통 중심은 중심선, 발은 발 선에 맞췄습니다. 원본에서 떠 있던 프레임은 그 높이를 지킵니다.'
        : '자동 정렬 (발 기준): 발은 발 선, 몸 중심은 중심선에 맞췄습니다.');
    };
    $('alignBy').onchange = () => { S.alignBy = $('alignBy').value; };
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
    $('btnFrames').onclick = () => exportFrames();
    $('btnTiming').onclick = () => exportTiming();
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
        keyChanged(() => { S.key = [src.data[i], src.data[i + 1], src.data[i + 2]]; });
        syncInputs(); setMode('select');
      } else if (mode === 'select') {
        const i = boxAt(x, y);
        if (i < 0) { boxSel.clear(); drawSource(); return; }
        if (e.shiftKey) boxSel.has(i) ? boxSel.delete(i) : boxSel.add(i);
        else { boxSel.clear(); boxSel.add(i); }
        cur = i; render();
      } else if (mode === 'split') {
        const i = boxAt(x, y);
        if (i >= 0) splitAt(i, x);
      } else if (mode === 'add' || mode === 'head') {
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
      if (mode === 'head') {   // reference head box → match it in every frame
        const fi = boxAt(b.x + b.w / 2, b.y + b.h / 2);
        setMode('select');
        if (fi < 0 || b.w < 6 || b.h < 6) { status('머리 상자는 한 프레임의 머리를 감싸게 그리세요.'); drawSource(); return; }
        S.head = { ...b, frame: fi };
        compareHeads(); S.compareMode = 'ref'; syncInputs(); render();
        return;
      }
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
      const tip = S.autoFx.tips.length === S.frames.length && S.autoFx.tips[cur];
      if (tool === 'move' && tip && Math.hypot(e.offsetX - (tip.x + 0.5) * S.zoom, e.offsetY - (tip.y + 0.5) * S.zoom) <= Math.max(6, S.zoom)) {
        pushUndo();
        ed = { tip: true };   // drag the tracked blade tip of this frame
      } else if (tool === 'move') {
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
      } else if (tool === 'fx') {
        // click an effect to select it (topmost first), then drag the selected one
        const hit = [...S.effects].reverse().find(x => { const pl = fxPlaced(x, cur); return pl && p.x >= pl.x && p.x < pl.x + pl.c.width && p.y >= pl.y && p.y < pl.y + pl.c.height; });
        if (hit) fxSel = hit.id;
        const fe = fxInst(fxSel);
        if (!fe) { status('먼저 ④ 이펙트에서 이펙트를 추가하거나 고르세요.'); return; }
        pushUndo();
        const q = fxPos(fe, cur);
        ed = { fx: fe, mx: e.offsetX, my: e.offsetY, x: q.x, y: q.y };
        render();
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
      } else if (ed.tip) {
        S.autoFx.tips[cur] = { x: Math.max(0, Math.min(S.cellW - 1, p.x)), y: Math.max(0, Math.min(S.cellH - 1, p.y)) };
        refreshAutoFx();
        drawEditor(); drawThumb(cur); drawPreview();
      } else if (ed.fx) {
        const pos ={ x: ed.x + Math.round((e.offsetX - ed.mx) / z), y: ed.y + Math.round((e.offsetY - ed.my) / z) };
        if (ed.fx.follow) ed.fx.keys[cur] = pos; else Object.assign(ed.fx, pos);
        drawEditor(); drawPreview();
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
      } else if (done.fx || done.paint || done.tip) {
        render(); return;
      } else if (!done.shape) {
        if (!done.guide) { drawThumb(cur); buildFxList(); }
        return;   // move / guide drags already redrew what changed
      }
      render();
    });

    const TOOL_KEYS = { v: 'move', b: 'pencil', e: 'eraser', i: 'picker', w: 'wand', m: 'rect', l: 'lasso', p: 'impact', x: 'fx' };
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
  let collect = null;   // CLI / API: exports are collected here instead of downloaded
  function download(blob, name) {
    if (collect) { collect.push({ name, blob }); return; }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  const hasFx = () => S.frames.some(f => f.fxCanvas);

  /** One row of equal cells. main/fx: which layers; flip: left-facing (each cell mirrored in place). */
  // Browsers cannot save canvases wider than ~16k px: a sheet that would be wider wraps into rows (one row otherwise,
  // so existing sheets are unchanged). The meta JSON gives every frame's x / y and the column count.
  const MAX_SHEET = 16384;
  const gridCols = (w, n) => Math.max(1, Math.min(n, Math.floor(MAX_SHEET / Math.max(1, w))));
  function sheetCanvas(opts) {
    const c = document.createElement('canvas'), n = S.frames.length, cols = gridCols(S.cellW, n);
    c.width = S.cellW * cols; c.height = S.cellH * Math.ceil(n / cols);
    const g = c.getContext('2d');
    S.frames.forEach((_, i) => g.drawImage(cellCanvas(i, opts), (i % cols) * S.cellW, Math.floor(i / cols) * S.cellH));
    return c;
  }

  const savePNG = (canvas, name) => new Promise(r => canvas.toBlob(b => { download(b, name); r(); }, 'image/png'));

  const merged = () => S.effectsMode === 'merged';

  function exportSheet() {
    if (!S.frames.length) return;
    return savePNG(sheetCanvas({ fx: false, effects: merged() }), `${S.name}.png`);
  }

  /** Separate mode: one sheet per placed effect, holding its transformed frames. */
  function effectSheets() {
    return S.effects.map((e, j) => {
      const n = assets.get(e.asset).frames.length, cs = Array.from({ length: n }, (_, k) => fxCanvas(e, k));
      const w = Math.max(...cs.map(c => c.width)), h = Math.max(...cs.map(c => c.height));
      const sheet = document.createElement('canvas'), cols = gridCols(w, n);
      sheet.width = w * cols; sheet.height = h * Math.ceil(n / cols);
      cs.forEach((c, k) => sheet.getContext('2d').drawImage(c, (k % cols) * w + (w - c.width) / 2, Math.floor(k / cols) * h + (h - c.height) / 2));
      return { e, sheet, w, h, n, cols, image: `${S.name}_effect${j + 1}.png` };
    });
  }

  function meta() {
    const durations = S.frames.map(f => f.dur), g = S.guides;
    const colors = new Set();
    for (const f of S.frames) for (let i = 0; i < f.img.data.length; i += 4) if (f.img.data[i + 3]) colors.add(rgbToHex([f.img.data[i], f.img.data[i + 1], f.img.data[i + 2]]));
    const m = {
      image: `${S.name}.png`,
      frameWidth: S.cellW, frameHeight: S.cellH, frameCount: S.frames.length,
      frames: S.frames.map((f, i) => { const cols = gridCols(S.cellW, S.frames.length); return { index: i, x: (i % cols) * S.cellW, y: Math.floor(i / cols) * S.cellH, w: S.cellW, h: S.cellH, duration: f.dur }; }),
      ...(gridCols(S.cellW, S.frames.length) < S.frames.length ? { columns: gridCols(S.cellW, S.frames.length) } : {}),
      durations,
      totalDuration: durations.reduce((a, b) => a + b, 0),
      loop: S.loop,
      pivot: { x: g.cx, y: g.base, note: 'centre line x, feet baseline y (pixel boundaries)' },
      impactFrame: S.impact >= 0 ? S.impact : null,   // (null: no impact frame, e.g. a run cycle)
      impactPoint: S.impact >= 0 ? S.impactPoint : null,
      ...(S.blendOut ? { blend: S.blendOut } : {}),
      ...(S.grid ? { grid: { trimOffset: S.trimOffset || [0, 0] } } : {}),
      guides: { ...g },
      pixelSize: S.pixel,
      palette: [...colors],
    };
    if (S.exportLeft) m.left = { image: `${S.name}_left.png`, pivot: { x: S.cellW - g.cx, y: g.base },
      impactPoint: S.impactPoint && { x: S.cellW - 1 - S.impactPoint.x, y: S.impactPoint.y } };
    if (hasFx()) m.fx = { image: `${S.name}_fx.png`, note: 'removed effect pixels, same cells as the main sheet' };
    if (hasFx() && S.exportLeft) m.fx.left = `${S.name}_fx_left.png`;
    if (S.effects.length && merged()) m.effectsMerged = true;
    if (S.effects.length && !merged()) {
      const BLEND = { 'source-over': 'normal', lighter: 'add', screen: 'screen' };
      m.effects = effectSheets().map(({ e, w, h, n, cols, image }) => {
        const frames = [];
        for (let i = e.start; i < Math.min(S.frames.length, e.start + e.len); i++) {
          const k = fxFrameAt(e, i), p = fxPos(e, i), o = e.anchorOfs || [0, 0], x = Math.round(p.x - w / 2 - o[0]), y = Math.round(p.y - h / 2 - o[1]);
          frames.push({ charFrame: i, effectFrame: k, x, y, leftX: S.cellW - x - w });
        }
        const a = assets.get(e.asset);
        return { name: e.name, image, frameWidth: w, frameHeight: h, frameCount: n, ...(cols < n ? { columns: cols } : {}), blend: BLEND[e.blend], opacity: e.opacity,
          startFrame: e.start, length: e.len, flip: e.flip, rotation: e.rot, scale: e.scale, frames,
          ...(a.durations ? { durations: a.durations.map(d => Math.round(d)), offsetMs: Math.round(e.offset || 0), loop: !!a.loop } : {}),
          ...(a.recipe ? { recipe: a.recipe.name, impactFrame: a.game.impactFrame ?? null } : {}),
          note: 'draw effectFrame at (x, y) in the character cell while charFrame is shown; left-facing: flip it and use leftX' };
      });
    }
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
    const bytes = GIF.encode(W, H, frames, pal, S.frames.map(f => f.dur), S.gifTransparent ? 0 : -1, S.loop);   // 반복 off: plays once, holds the last frame
    download(new Blob([bytes], { type: 'image/gif' }), `${S.name}_preview.gif`);
  }

  /** One PNG per frame (same cell size and alignment as the sheet): <name>_frame_01.png ... */
  async function exportFrames() {
    if (!S.frames.length) return;
    for (let i = 0; i < S.frames.length; i++) await savePNG(cellCanvas(i, { fx: false, effects: merged() }), `${S.name}_frame_${String(i + 1).padStart(2, '0')}.png`);
  }

  /** Effects only, one PNG per character frame, same cell: <name>_fx_01.png ... (empty frames are empty PNGs). */
  // With effects behind the body (under / split ground halves): <name>_fxback_01.png (draw before the character) and
  // <name>_fx_01.png (after it); otherwise only <name>_fx_01.png with everything.
  const hasBack = () => S.effects.some(e => e.under || e.split);
  async function exportFxFrames() {
    if (!S.frames.length) return;
    const back = hasBack();
    for (let i = 0; i < S.frames.length; i++) {
      const n = String(i + 1).padStart(2, '0');
      if (back) await savePNG(cellCanvas(i, { main: false, fx: false, effects: 'under' }), `${S.name}_fxback_${n}.png`);
      await savePNG(cellCanvas(i, { main: false, fx: false, effects: back ? 'over' : true }), `${S.name}_fx_${n}.png`);
    }
  }

  let apiTiming = null;   // API: extra fields for the timing JSON ({ top, frames: [ {...} per frame ] })
  /** Timing JSON for the per-frame PNGs: file, duration, impact, pivot. */
  function timingJSON() {
    const t = timingCore();
    if (apiTiming && apiTiming.top) Object.assign(t, apiTiming.top);
    if (apiTiming && apiTiming.frames) t.frames.forEach((f, i) => Object.assign(f, apiTiming.frames[i] || {}));
    return t;
  }
  function timingCore() {
    return {
      name: S.name, loop: S.loop, frameWidth: S.cellW, frameHeight: S.cellH,
      pivot: { x: S.guides.cx, y: S.guides.base }, impactFrame: S.impact >= 0 ? S.impact : null,
      totalDuration: S.frames.reduce((a, f) => a + f.dur, 0),
      frames: S.frames.map((f, i) => ({ index: i, file: `${S.name}_frame_${String(i + 1).padStart(2, '0')}.png`, duration_ms: f.dur,
        ...(S.effects.length ? { fx: `${S.name}_fx_${String(i + 1).padStart(2, '0')}.png` } : {}),
        ...(hasBack() ? { fxBack: `${S.name}_fxback_${String(i + 1).padStart(2, '0')}.png` } : {}),
        ...(S.autoFx.tips.length === S.frames.length && S.autoFx.tips[i] ? { tip: { ...S.autoFx.tips[i] } } : {}),
        ...(S.multiTips && S.multiTips.length === S.frames.length ? { tips: S.multiTips[i] } : {}) })),
      ...(S.effects.length ? { fxBlend: [...new Set(S.effects.map(e => ({ 'source-over': 'normal', lighter: 'add', screen: 'screen' })[e.blend]))] } : {}),
    };
  }
  function exportTiming() {
    if (!S.frames.length) return;
    download(new Blob([JSON.stringify(timingJSON(), null, 2)], { type: 'application/json' }), `${S.name}_timing.json`);
  }

  async function exportAll() {
    if (!S.frames.length) { status('내보낼 프레임이 없습니다.'); return; }
    await exportSheet();
    exportMeta();
    exportGif();
    if (S.exportLeft) await savePNG(sheetCanvas({ fx: false, flip: true, effects: merged() }), `${S.name}_left.png`);
    if (hasFx()) {
      await savePNG(sheetCanvas({ main: false, effects: false }), `${S.name}_fx.png`);
      if (S.exportLeft) await savePNG(sheetCanvas({ main: false, flip: true, effects: false }), `${S.name}_fx_left.png`);
    }
    const sep = S.effects.length && !merged() ? effectSheets() : [];
    for (const s of sep) await savePNG(s.sheet, s.image);
    // merged sheets cut effects at the cell edge: say so
    const clipped = merged() && S.effects.some(e => S.frames.some((_, i) => {
      const pl = fxPlaced(e, i);
      return pl && (pl.x < 0 || pl.y < 0 || pl.x + pl.c.width > S.cellW || pl.y + pl.c.height > S.cellH);
    }));
    status(`내보냄: ${S.name}.png · .json · _preview.gif` + (S.exportLeft ? ' · _left.png' : '') + (hasFx() ? ' · _fx.png' : '')
      + (sep.length ? ` · 이펙트 시트 ${sep.length}개` : '') + (S.effects.length && merged() ? ' (이펙트 합침)' : '')
      + (clipped ? ' ⚠ 이펙트 일부가 칸 밖이라 잘렸습니다: 프레임 크기를 키우거나 따로 시트로 내보내세요.' : ''));
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
    // effect assets: built-ins as their recipe, imported ones as a strip image + frame widths
    const used = new Set(S.effects.map(e => e.asset));
    const fxAssets = [...assets].filter(([id]) => used.has(id)).map(([id, a]) => a.spec ? { id, name: a.name, spec: a.spec }
      : a.recipe ? { id, name: a.name, recipe: a.recipe, ropts: a.ropts, slash: a.slash || null }
      : a.kind === 'autoTrail' ? { id, name: a.name, kind: 'autoTrail' }
      : { id, name: a.name, strip: FX.strip(a.frames).toDataURL('image/png'), widths: a.frames.map(c => c.width), durations: a.durations, ...(a.loop ? { loop: true } : {}) });
    return JSON.stringify({ app: 'sprite-aligner', version: 3, ...settings, fxAssets,
      frames: frames.map(f => ({ box: f.box, raw: f.raw, dur: f.dur, ox: f.ox, oy: f.oy, pixel: f.pixel || null, edits: [...f.edits], fx: [...f.fx] })) });
  }

  async function loadAssets(list = []) {
    assets.clear(); fxCache.clear();
    const old = [];   // pxf.graph@1 recipes of older projects: kept as empty placeholders
    for (const a of list) {
      if (a.spec) { assets.set(a.id, { ...FX.builtin(a.spec.type, a.spec.color, a.spec.size), name: a.name, spec: a.spec, version: 1 }); continue; }
      if (a.kind === 'autoTrail') { assets.set(a.id, { name: a.name, frames: [document.createElement('canvas')], durations: null, kind: 'autoTrail', version: 1 }); continue; }
      if (a.recipe) {
        const blank = name => assets.set(a.id, { name, frames: [document.createElement('canvas')], durations: null, version: 1 });
        if (SAFX.unsupported(a.recipe)) { blank(`${a.name} (지원 안 함)`); old.push(a.name); continue; }
        await SAFX.preload(a.recipe);
        try { assets.set(a.id, { ...renderRecipe(a.recipe, a.ropts, a.slash), version: 1 }); }
        catch (err) { status(`레시피 "${a.name}" 오류: ${err.message}`); blank(a.name); }
        continue;
      }
      const { canvas } = await loadImage(a.strip);
      let x = 0;
      const frames = a.widths.map(w => { const c = document.createElement('canvas'); c.width = w; c.height = canvas.height; c.getContext('2d').drawImage(canvas, -x, 0); x += w; return c; });
      assets.set(a.id, { name: a.name, frames, durations: a.durations, ...(a.loop ? { loop: true } : {}), version: 1 });
    }
    const ids = [...assets.keys()].map(id => +id.slice(1)), eids = S.effects.map(e => +e.id.slice(1));
    nextId = Math.max(nextId, ...ids, ...eids) + 1;
    if (old.length) {
      const msg = `지원하지 않는 예전 레시피(pxf.graph@1) ${old.length}개: ${old.join(', ')}. 빈 이펙트로 남겨 두었습니다. ④에서 지우고 갤러리의 레시피나 sa-fx@1 형식으로 다시 만들어 주세요.`;
      status(msg);
      alert(msg);
    }
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
    const { frames, app, version, fxAssets, ...settings } = p;
    // (projects from before the edge-connected background removal keep the old one: the same pixels as when saved)
    Object.assign(S, { effects: [], head: null, perFramePixel: false, keyEdge: false, keyBorders: false, keyMarks: false, smooth: false, fringe: false, remap: [], keyTint: 0, edgeNeutral: false }, settings);
    pixelCands = []; fxSel = null;
    await loadAssets(fxAssets);
    rekey();
    S.frames = frames.map(f => ({ ...f, edits: new Map(f.edits || []), fx: new Map(f.fx || []) }));
    if (S.perFramePixel) detectFramePixels();
    S.frames.forEach(prepFrame);
    applyPalettes();
    if (S.head) compareHeads();
    S.frames.forEach(f => { f.placed = true; });
    S.autoFx = { tips: [], style: 'whiteblue', shape: 'tapered', trail: true, spark: true, dust: true, ...(p.autoFx || {}) };
    refreshAutoFx();   // the auto trail is redrawn from the saved tips
    window.dispatchEvent(new Event('sa-project-loaded'));
    cur = 0; boxSel.clear(); selection.clear();
    undoStack.length = redoStack.length = 0;
    syncInputs(); render(); openStep(3);
    status(`프로젝트 열림: ${S.name} (프레임 ${S.frames.length}개)`);
  }

  // ---------- API (used by tools/cli.mjs; also callable from the console) ----------
  /**
   * SpriteAligner.run(o): open o.image (data URL) with the given settings, run the automatic cleanup and return the
   * exports as files [{ name, base64 }] instead of downloading them. Options (all optional except image):
   *   name, smooth (bool), shrink (smooth-mode divisor, default 1), pixel (AI pixel size; omit = detect),
   *   key ('#rrggbb'; omit = guess), tol, keyEdge (bool), fringe (bool), despill (0-1), pad,
   *   alignBy ('auto' | 'feet' | 'torso' | 'ground'), durations [ms...], impact (frame index, -1 = none), loop (bool), exportLeft (bool),
   *   outputs: any of 'project', 'all' (sheet + meta + GIF ...), 'frames', 'timing' (default: all four).
   *   row: process only this row (1 = top) of a multi-row sheet; rows are found from the empty horizontal gaps.
   *   frameCount: expected number of frames (a warning is returned when the detection finds a different count).
   *   project (saved project text, instead of image) + pick [frame indices, repeats allowed]; expand [l, t, r, b];
   *   videoFrames [data URLs] + loopPick { pick, steps } (find a seamless walk / run cycle, pick evenly) or pickFrames;
   *   keyTint N (also key pixels with the background's hue, tint >= N);
   *   erase [{ frame, poly: [[x, y], …], minLight }] (minLight: only light pixels, e.g. a pale glow inside the polygon)
   *     and removeIslands { max } (hand edits, kept in the project);
   *   remap [{ src: '#rrggbb', dst: '#rrggbb', tol }] (shading-preserving colour shift, before scaling);
   *   tipsCount N (+ tipsN overrides): N blade tips per frame -> timing frames[].tips;
   *   tips { frame: {x, y} | at } (blade tip per frame: detected, these override); autoTrail (true | { style, shape, under });
   *   effects [see apiEffect]; timingExtra {...}; frameExtra [{...} per frame]; outputs also 'fxframes'.
   *   targetHeight (+ targetFrame, 1 = first): smooth mode only; one scale for the whole row so that frame's sprite
   *     is exactly targetHeight px tall.
   *   extract [{ name, frame (0-based, default 0), at [x, y] (cell px: the piece there) | box [x, y, w, h] (cell px: the
   *     biggest detached piece inside), erase [frames] (erase the piece's pixels there), minAlpha (40), pivot 'ground' | 'center',
   *     file (output path without .png, relative to out; default name), showFrame (0-based, default frame),
   *     offsetKey / frameKey (also write the offset / show frame under these top-level timing keys), discard (only erase it:
   *     no files, no timing entry; e.g. a glow smudge) }]: a separate prop
   *     (the web tool's "move to FX layer", as a file): <file>.png + <file>.json (pivot, offset from the character pivot);
   *     timing props.<name> = { file, frame, offset }. The piece = its solid pixels (alpha > minAlpha) + the faint rim within
   *     2 px of it that does not touch the body (the frame's biggest piece).
   *   anchors [{ name, color '#rrggbb', tol (40), box [x, y, w, h] cell px, point 'bbox' | 'mean' | 'extreme' | 'lowest' |
   *     'blade' (blade tip detection like slash trails: the long thin steel group's far end; no colour needed; box limits
   *     the search, e.g. to keep a shield rim out),
   *     side, frames [indices] (default all) }]: per-frame part anchors -> timing frames[].<name> = { x, y } (cell px),
   *     found on the finished frames (after erase / islands); a frame without the colour gets no entry (warning).
   */
  /** Crop one row (1 = top) of a multi-row sheet: rows are the bands between empty horizontal gaps. */
  async function cropRow(url, row, keyHex) {
    const { canvas, img } = await loadImage(url);
    const key = keyHex ? hexToRgb(keyHex) : IO.guessKey(img);
    const m = IO.keyMask(img, key, S.tol, S.edge, { connected: false, borders: true, marks: true });
    const rowFg = new Array(img.h).fill(0);
    for (let y = 0; y < img.h; y++) for (let x = 0; x < img.w; x++) rowFg[y] += m[y * img.w + x];
    let bands = [], start = -1;
    for (let y = 0; y <= img.h; y++) {
      const on = y < img.h && rowFg[y] >= 3;
      if (on && start < 0) start = y;
      if (!on && start >= 0) { bands.push([start, y]); start = -1; }
    }
    // merge bands split by tiny gaps (a sword tip, a hair lock), then drop specks
    bands = bands.reduce((acc, b) => { const l = acc[acc.length - 1]; if (l && b[0] - l[1] < 4) l[1] = b[1]; else acc.push([...b]); return acc; }, []);
    const tall = Math.max(...bands.map(b => b[1] - b[0]));
    bands = bands.filter(b => b[1] - b[0] >= tall * 0.25);
    if (row < 1 || row > bands.length) throw new Error(`row ${row}: the sheet has ${bands.length} rows`);
    const [y0, y1] = bands[row - 1], prev = bands[row - 2], next = bands[row];
    const top = prev ? Math.round((prev[1] + y0) / 2) : 0, bottom = next ? Math.round((y1 + next[0]) / 2) : img.h;
    const c = document.createElement('canvas');
    c.width = img.w; c.height = bottom - top;
    c.getContext('2d').drawImage(canvas, 0, -top);
    return { url: c.toDataURL('image/png'), rows: bands.length, top, bottom };
  }

  /** Rows with any visible pixel in a frame's sprite. */
  const spriteHeight = f => { let t = -1, b = -1; for (let y = 0; y < f.img.h; y++) for (let x = 0; x < f.img.w; x++) if (f.img.data[(y * f.img.w + x) * 4 + 3]) { if (t < 0) t = y; b = y; break; } return t < 0 ? 0 : b - t + 1; };

  /**
   * Centre (cell px) of the biggest patch of a colour in frame f: at.color '#rrggbb', at.tol (default 40),
   * at.side 'left' | 'right' (only that half of the sprite), at.box [x, y, w, h] (cell px: only inside it).
   * Point: at.point 'mean' (default: centre of mass) | 'bbox' (centre of the patch's bounding box) | 'extreme'
   * (farthest from the body centre, e.g. a staff crystal tip; also at.extreme) | 'lowest' (bottom pixel, e.g. ground contact).
   * Used to attach an effect to a body part (e.g. a shield face) and for timing anchors (o.anchors).
   */
  function colorAnchor(f, at) {
    const c = hexToRgb(at.color), tol = at.tol || 40, { w, h, data } = f.img, m = new Map();
    const bx = f.ox + f.x0, by = f.oy + f.y0, bb = at.box;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (at.side === 'right' && x < w / 2) continue;
      if (at.side === 'left' && x >= w / 2) continue;
      if (bb && (bx + x < bb[0] || by + y < bb[1] || bx + x >= bb[0] + bb[2] || by + y >= bb[1] + bb[3])) continue;
      const i = (y * w + x) * 4;
      if (data[i + 3] > 128 && Math.hypot(data[i] - c[0], data[i + 1] - c[1], data[i + 2] - c[2]) <= tol) m.set(K(x, y), 1);
    }
    const g = IO.groups(m).sort((a, b) => b.length - a.length)[0];
    if (!g) return null;
    let sx = 0, sy = 0, y0 = Infinity, y1 = -Infinity;
    for (const k of g) { sx += KX(k); sy += KY(k); y0 = Math.min(y0, KY(k)); y1 = Math.max(y1, KY(k)); }
    if (at.point === 'bbox') {
      let x0 = Infinity, x1 = -Infinity;
      for (const k of g) { x0 = Math.min(x0, KX(k)); x1 = Math.max(x1, KX(k)); }
      return { x: f.ox + f.x0 + (x0 + x1) / 2, y: f.oy + f.y0 + (y0 + y1) / 2, h: y1 - y0 + 1 };
    }
    if (at.point === 'lowest') {   // bottom pixel of the patch (middle of the bottom row), e.g. a staff touching the ground
      const xs = g.filter(k => KY(k) === y1).map(KX);
      return { x: f.ox + f.x0 + (Math.min(...xs) + Math.max(...xs)) / 2 + 0.5, y: f.oy + f.y0 + y1 + 0.5, h: y1 - y0 + 1 };
    }
    if (at.extreme || at.point === 'extreme') {   // the patch's point farthest from the body centre (e.g. the tip of a staff crystal)
      const cx = f.anchor ? f.anchor.bx : f.img.w / 2, cy = f.img.h * 0.45;
      let best = g[0], bd = -1;
      for (const k of g) { const d = (KX(k) - cx) ** 2 + (KY(k) - cy) ** 2; if (d > bd) { bd = d; best = k; } }
      return { x: f.ox + f.x0 + KX(best) + 0.5, y: f.oy + f.y0 + KY(best) + 0.5, h: y1 - y0 + 1 };
    }
    return { x: f.ox + f.x0 + sx / g.length, y: f.oy + f.y0 + sy / g.length, h: y1 - y0 + 1 };
  }

  /**
   * Ground contact of frame f (cell px): the middle between the outermost boot pixels on the sole line (the lowest
   * 4% of the sprite), y = the sole line itself. spread = boot-to-boot width (for sizing ground effects).
   */
  function soles(f) {
    const { w, h, data } = f.img;
    let bottom = -1;
    for (let y = h - 1; y >= 0 && bottom < 0; y--) for (let x = 0; x < w; x++) if (data[(y * w + x) * 4 + 3] > 128) { bottom = y; break; }
    if (bottom < 0) return { x: S.guides.cx, y: S.guides.base, spread: 0 };
    const band = Math.max(2, Math.round(h * 0.04));
    let x0 = Infinity, x1 = -1;
    for (let y = bottom - band; y <= bottom; y++) for (let x = 0; x < w; x++) if (y >= 0 && data[(y * w + x) * 4 + 3] > 128) { if (x < x0) x0 = x; if (x > x1) x1 = x; }
    return { x: f.ox + f.x0 + (x0 + x1 + 1) / 2, y: f.oy + f.y0 + bottom + 1, spread: x1 - x0 + 1 };
  }

  /** Blade tip of frame k: the tracked / hand-set tip (S.autoFx.tips) when there is one, else detected now. */
  const tipOf = k => (S.autoFx.tips.length === S.frames.length && S.autoFx.tips[k]) || bladeTip(S.frames[k]);

  /** Where an API effect goes: at = { from: 'feet' | 'center' | 'head' | 'tip' | 'color' | 'point', frame, x, y, dx, dy } (color: + color, tol, side, extreme = farthest point; soles: ground contact between the boots). */
  function apiPos(at = {}) {
    const k = Math.min(S.frames.length - 1, Math.max(0, at.frame || 0)), f = S.frames[k];
    const box = { x: f.ox + f.x0, y: f.oy + f.y0, w: f.img.w, h: f.img.h };
    let p;
    if (at.from === 'point') p = { x: at.x, y: at.y };
    else if (at.from === 'center') p = { x: box.x + box.w / 2, y: box.y + box.h / 2 };
    else if (at.from === 'head') p = { x: box.x + box.w / 2, y: box.y + box.h * 0.2 };
    else if (at.from === 'tip') p = tipOf(k) || { x: box.x + box.w / 2, y: box.y + box.h / 2 };
    else if (at.from === 'color') p = colorAnchor(f, at) || { x: box.x + box.w / 2, y: box.y + box.h / 2 };
    else if (at.from === 'soles') p = soles(f);
    else if (at.from === 'tipGround') { const t = tipOf(k); p = { x: t.x, y: soles(f).y }; }   // blade tip dropped onto the sole line
    else p = { x: S.guides.cx, y: S.guides.base };
    return { x: Math.round(p.x + (at.dx || 0)), y: Math.round(p.y + (at.dy || 0)) };
  }

  /**
   * One effect from the API: spec.recipe (sa-fx@1 object) or spec.sheet ({ png: data URL, json, name }: pixelfx or
   * Sprite Aligner sheet). start / len (character frames), at (see apiPos), follow: 'tip' (blade-tip keyframes),
   * scale, rot, flip, blend ('add' | 'screen' | 'normal'), opacity, offsetMs, speed (recipe), under (draw behind the body),
   * split: ground effect, back half under the body and front half over it (cut at the anchor line);
   * anchor: 'core' (brightest pixels on the point) | 'content' (visible centre on the point) | 'bottom' (visible bottom centre on the point, ground effects);
   * default = canvas centre (pixelfx: its pivot); follow: 'tip' | 'color' (re-anchor every frame).
   */
  async function apiEffect(spec, warnings) {
    let a;
    if (spec.recipe) {
      await SAFX.preload(spec.recipe);
      a = renderRecipe(spec.recipe, { scale: 1, hue: 0, speed: spec.speed || 1 });
      if (a.warnings && a.warnings.length) warnings.push(`${a.name}: ${a.warnings.join(', ')}`);
    } else if (spec.sheet) {
      const { canvas } = await loadImage(spec.sheet.png);
      a = { ...FX.fromSheet(canvas, spec.sheet.json || null, spec.sheet.name || 'sheet', 1), url: spec.sheet.png, meta: spec.sheet.json || null, count: 1 };
    } else throw new Error('effect needs recipe or sheet');
    const id = addAsset(a), p = apiPos(spec.at);
    const e = addEffect(id, {
      start: Math.max(0, spec.start || 0), len: Math.max(1, spec.len || 1), x: p.x, y: p.y, offset: spec.offsetMs || 0,
      scale: spec.scale || 1, flip: !!spec.flip, opacity: spec.opacity ?? 1, ...(spec.under ? { under: true } : {}), ...(spec.split ? { split: true } : {}),
      blend: BLEND_FROM_GAME[spec.blend] || (a.game ? BLEND_FROM_GAME[a.game.blend] : null) || 'source-over',
      ...(spec.rot ? { rot: spec.rot, freeRot: spec.rot % 90 !== 0 } : {}),
    });
    if (spec.anchor === 'core') {
      // place the effect by its brightest pixels (the core of an orb / flash), all frames together
      let sx = 0, sy = 0, n = 0, cw = 0, ch = 0;
      const lum = [];
      for (let k = 0; k < a.frames.length; k++) {
        const c = fxCanvas(e, k), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        cw = c.width; ch = c.height;
        for (let q = 0; q < d.length; q += 4) if (d[q + 3]) lum.push(d[q] + d[q + 1] + d[q + 2]);
      }
      lum.sort((x, y) => x - y);
      const thr = lum.length ? lum[Math.floor(lum.length * 0.9)] : 765;
      for (let k = 0; k < a.frames.length; k++) {
        const c = fxCanvas(e, k), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) { const q = (y * c.width + x) * 4; if (d[q + 3] && d[q] + d[q + 1] + d[q + 2] >= thr) { sx += x; sy += y; n++; } }
      }
      if (n) e.anchorOfs = [Math.round(sx / n + 0.5 - cw / 2), Math.round(sy / n + 0.5 - ch / 2)];
    }
    if (spec.anchor === 'content' || spec.anchor === 'bottom') {
      // place the effect by what is drawn (all frames together), not by its canvas centre / pixelfx stand-in pivot
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, cw = 0, ch = 0;
      for (let k = 0; k < a.frames.length; k++) {
        const c = fxCanvas(e, k), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        cw = c.width; ch = c.height;
        for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) if (d[(y * c.width + x) * 4 + 3]) {
          if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
      }
      if (x1 >= 0) e.anchorOfs = [Math.round((x0 + x1 + 1) / 2 - cw / 2), Math.round((spec.anchor === 'bottom' ? y1 + 1 : (y0 + y1 + 1) / 2) - ch / 2)];
    }
    if (spec.follow === 'color' && spec.at) {   // re-find the colour patch on every frame of the effect
      for (let i = e.start; i < Math.min(S.frames.length, e.start + e.len); i++) e.keys[i] = apiPos({ ...spec.at, frame: i });
      e.follow = true;
    }
    if (spec.follow === 'tip') {
      for (let i = e.start; i < Math.min(S.frames.length, e.start + e.len); i++) { const t = tipOf(i); if (t) e.keys[i] = { ...t }; }
      e.follow = true;
      const at = spec.at || {};
      for (const k of Object.keys(e.keys)) e.keys[k] = { x: e.keys[k].x + (at.dx || 0), y: e.keys[k].y + (at.dy || 0) };
    }
    return e;
  }

  /**
   * Walk / run loop from video frames: silhouettes (background keyed, centred on their x centroid, the legs = lowest
   * 45 % of the sprite) are compared; the cycle length is the lag with the lowest average difference near steps × the
   * first step's lag (one step = one leg; legs look alike in silhouette, so a full cycle is two steps). The start is the
   * frame whose cycle end flows back into it best. Returns { period, start, picked: [indices], scores }.
   */
  async function findLoop(urls, { pick = 8, steps = 2, key = null } = {}) {
    const sil = [];
    let k0 = null;
    for (const url of urls) {
      const { img } = await loadImage(url);
      if (!k0) k0 = key ? hexToRgb(key) : IO.guessKey(img);
      const m = IO.keyMask(img, k0, S.tol, S.edge, { connected: true, borders: false, marks: false });
      const q = 4, w = Math.ceil(img.w / q), h = Math.ceil(img.h / q), s = new Uint8Array(w * h);
      let sx = 0, n = 0, y0 = h, y1 = -1;
      for (let y = 0; y < img.h; y += q) for (let x = 0; x < img.w; x += q) if (m[y * img.w + x]) { s[(y / q) * w + x / q] = 1; sx += x / q; n++; y0 = Math.min(y0, y / q); y1 = Math.max(y1, y / q); }
      sil.push({ s, w, h, cx: n ? Math.round(sx / n) : w / 2, y0, y1 });
    }
    const N = sil.length, band = Math.max(4, Math.round(Math.max(...sil.map(t => t.y1 - t.y0)) * 0.45));
    const diff = (a, b) => {   // legs of a vs b, aligned on x centroid and on the lowest row
      let d = 0, c = 0;
      for (let r = 0; r < band; r++) {
        const ya = a.y1 - r, yb = b.y1 - r;
        if (ya < 0 || yb < 0) continue;
        for (let x = -a.w / 2; x < a.w / 2; x++) {
          const xa = a.cx + x, xb = b.cx + x;
          const va = xa >= 0 && xa < a.w ? a.s[ya * a.w + xa] : 0, vb = xb >= 0 && xb < b.w ? b.s[yb * b.w + xb] : 0;
          d += va !== vb; c++;
        }
      }
      return c ? d / c : 1;
    };
    const D = Array.from({ length: N }, () => new Float32Array(N));
    for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) D[i][j] = D[j][i] = diff(sil[i], sil[j]);
    const avg = [];
    for (let P = 0; P < Math.floor(N / 2) + 1; P++) { let t = 0; for (let i = 0; i + P < N; i++) t += D[i][i + P]; avg.push(P ? t / (N - P) : 1); }
    const mins = [];
    for (let P = 3; P < avg.length - 1; P++) if (avg[P] <= avg[P - 1] && avg[P] <= avg[P + 1]) mins.push(P);
    if (!mins.length) throw new Error('no repeating walk cycle found in the video');
    const target = mins[0] * steps;
    const period = steps === 1 ? mins[0] : (mins.filter(P => P > mins[0]).sort((a, b) => Math.abs(a - target) - Math.abs(b - target))[0] || target);
    if (period >= N) throw new Error(`the video is too short for a ${steps}-step cycle (${period} frames)`);
    let best = null;
    for (let s = 1; s + period < N; s++) {
      const score = D[s][s + period] + 0.5 * D[s + period - 1][s - 1];
      if (!best || score < best.score) best = { s, score };
    }
    const start = best ? best.s : 0;
    const picked = Array.from({ length: pick }, (_, k) => start + Math.round(k * period / pick));
    return { period, start, picked, seam: best ? +best.score.toFixed(4) : null, stepLag: mins[0], frames: N };
  }

  /** Frames (data URLs) side by side on the background colour of the first frame: one strip for the normal pipeline. */
  async function stripFrom(urls, idx) {
    const ims = [];
    for (const i of idx) ims.push((await loadImage(urls[i])).canvas);
    const w = Math.max(...ims.map(c => c.width)), h = Math.max(...ims.map(c => c.height)), c = document.createElement('canvas');
    c.width = w * ims.length; c.height = h;
    const g = c.getContext('2d'), d0 = ims[0].getContext('2d').getImageData(0, 0, 1, 1).data;
    g.fillStyle = `rgb(${d0[0]},${d0[1]},${d0[2]})`; g.fillRect(0, 0, c.width, c.height);
    ims.forEach((im, k) => g.drawImage(im, k * w, 0));
    return c.toDataURL('image/png');
  }

  async function apiRun(o) {
    const set = (k, v) => { if (v !== undefined) S[k] = v; };
    set('smooth', o.smooth); set('keyEdge', o.keyEdge); set('fringe', o.fringe); set('despill', o.despill); set('tol', o.tol);
    set('keyTint', o.keyTint); set('edgeNeutral', o.edgeNeutral); set('pad', o.pad); set('alignBy', o.alignBy); set('loop', o.loop); set('exportLeft', o.exportLeft);
    if (S.smooth) S.pixel = o.shrink || 1; else if (o.pixel) S.pixel = o.pixel;
    S.noKey = o.key === 'none';
    if (o.key && !S.noKey) S.key = hexToRgb(o.key);
    S.grid = o.grid ? { cols: o.grid[0], rows: o.grid[1], count: o.frameCount } : o.frameSize ? { fw: o.frameSize[0], fh: o.frameSize[1], count: o.frameCount } : null;
    S.blendOut = o.blend || null;
    if (o.remap) S.remap = o.remap.map(r => ({ src: typeof r.src === 'string' ? hexToRgb(r.src) : r.src, dst: typeof r.dst === 'string' ? hexToRgb(r.dst) : r.dst, tol: r.tol || 60, ...(r.box ? { box: r.box } : {}) }));
    const warnings = [];
    let image = o.image, rowInfo = null, loopInfo = null;
    if (o.videoFrames) {   // video: o.videoFrames = [data URL per frame]; o.loopPick { pick, steps } or o.pickFrames [indices]
      const idx = o.pickFrames || (loopInfo = await findLoop(o.videoFrames, { ...(o.loopPick || {}), key: o.key })).picked;
      image = await stripFrom(o.videoFrames, idx);
      if (!o.frameCount) o.frameCount = idx.length;
      loopInfo = { ...(loopInfo || {}), picked: idx };
    }
    if (o.project) {
      // reuse a saved project (its keying, scale and alignment); pick = frame indices to use, repeats allowed
      const p = JSON.parse(o.project);
      if (o.pick) p.frames = o.pick.map(i => { if (!p.frames[i]) throw new Error(`pick: no frame ${i}`); return JSON.parse(JSON.stringify(p.frames[i])); });
      p.name = o.name || p.name; p.effects = []; p.fxAssets = [];
      if (o.loop !== undefined) p.loop = o.loop;
      await loadProject(JSON.stringify(p));
    } else {
    if (o.row) { rowInfo = await cropRow(o.image, o.row, o.key); image = rowInfo.url; }
    await openSource(image, o.name || 'sprite', { keepKey: !!o.key, autoPixel: S.smooth ? false : !o.pixel });
    }
    if (S.grid) gridFinish(o);
    if (o.frameCount && S.frames.length !== o.frameCount) warnings.push(`expected ${o.frameCount} frames, found ${S.frames.length}`);
    if (o.targetHeight && !o.project) {
      if (!S.smooth) throw new Error('targetHeight needs smooth mode');
      const k = Math.min(S.frames.length - 1, Math.max(0, (o.targetFrame || 1) - 1));
      for (let it = 0; it < 6; it++) {   // one scale for every frame; repeat because soft edges round by a pixel
        const h = spriteHeight(S.frames[k]);
        if (!h || h === o.targetHeight) break;
        S.pixel *= h / o.targetHeight;
        S.frames.forEach(prepFrame); applyPalettes(); autoCell();
      }
      const h = spriteHeight(S.frames[k]);
      if (h !== o.targetHeight) warnings.push(`target frame is ${h}px, asked ${o.targetHeight}px`);
    }
    if (o.durations) S.frames.forEach((f, i) => { if (o.durations[i] != null) f.dur = Math.max(10, Math.round(o.durations[i])); });
    if (o.impact !== undefined) S.impact = o.impact;
    if (o.expand) {   // [left, top, right, bottom] px of room for effects; frames and guides keep their places
      const [l = 0, t = 0, r = 0, b = 0] = o.expand;
      S.cellW += l + r; S.cellH += t + b;
      S.guides = { ...S.guides, cx: S.guides.cx + l, base: S.guides.base + t, top: S.guides.top + t, weapon: S.guides.weapon + t };
      S.frames.forEach(f => { f.ox += l; f.oy += t; });
    }
    // hand edits through the API (stored as edits, so the project keeps them and they can be undone in the web tool):
    // erase [{ frame (default all), poly: [[x, y], ...] cell px, minLight (only pixels whose brightest channel >= it) }], then removeIslands { max (px, default any size) }
    for (const er of o.erase || []) {
      const list = er.frame === undefined ? S.frames : [S.frames[er.frame]];
      for (const f of list) {
        if (!f) continue;
        for (const [k, c] of frameMap(f)) {
          if (er.minLight && Math.max(c[0], c[1], c[2]) < er.minLight) continue;   // only light pixels (a pale glow, not the outlines around it)
          if (pointInPoly(f.ox + KX(k) + 0.5, f.oy + KY(k) + 0.5, er.poly)) f.edits.set(k, [0, 0, 0, 0]);
        }
        compose(f);
      }
    }
    if (o.removeIslands) {   // keep the biggest piece, drop the detached ones (floating crystals, wisps, …)
      const max = o.removeIslands.max || Infinity;
      let gone = 0;
      for (const f of S.frames) {
        IO.groups(frameMap(f)).slice(1).forEach(g => { if (g.length < max) { g.forEach(k => f.edits.set(k, [0, 0, 0, 0])); gone++; } });
        compose(f);
      }
      warnings.push(`removed ${gone} detached piece(s)`);
    }
    if (o.tipsCount > 1) {   // several blades: frames[].tips in the timing JSON (left to right), o.tipsN overrides { frame: [{x, y}, …] }
      S.multiTips = S.frames.map((f, i) => (o.tipsN && o.tipsN[i]) || bladeTipsN(f, o.tipsCount));
      S.frames.forEach((f, i) => { if (S.multiTips[i].length < o.tipsCount) warnings.push(`frame ${i + 1}: ${S.multiTips[i].length} of ${o.tipsCount} blades found`); });
    }
    if (o.tips || o.autoTrail) {
      // blade tip per frame: detected (gaps filled in between), then hand-set ones from o.tips { frame: {x, y} | {from, ...} }
      S.autoFx.tips = trackTips();
      for (const [k, v] of Object.entries(o.tips || {})) if (S.autoFx.tips[+k]) S.autoFx.tips[+k] = v.from ? apiPos({ ...v, frame: +k }) : { x: v.x, y: v.y };
      S.autoFx.tips = S.autoFx.tips.map(t => ({ x: Math.round(t.x), y: Math.round(t.y) }));
    }
    if (o.autoTrail) {   // Sprite Aligner's automatic trail along the (tracked / hand-set) tip path of the swing frames
      Object.assign(S.autoFx, { trail: true, spark: false, dust: false }, typeof o.autoTrail === 'object' ? o.autoTrail : {});
      const keep = S.effects; runAutoFx(false); S.effects = [...keep.filter(e => !e.auto), ...S.effects.filter(e => e.auto)];
      if (o.autoTrail.under) S.effects.forEach(e => { if (e.auto) e.under = true; });   // e.g. back view: the trail is on the far side of the body
    }
    for (const spec of o.effects || []) await apiEffect(spec, warnings);
    if (S.effects.length && o.autoExpand !== false) {   // grow the cell so no placed effect is cut at its edge
      let l = 0, t = 0, r = 0, b = 0;
      for (const e of S.effects) for (let i = 0; i < S.frames.length; i++) {
        const pl = fxPlaced(e, i), v = pl && visibleBox(pl.c);
        if (!v) continue;   // (only drawn pixels count, not the empty padding of the effect canvas)
        l = Math.max(l, -(pl.x + v.x0)); t = Math.max(t, -(pl.y + v.y0)); r = Math.max(r, pl.x + v.x1 - S.cellW); b = Math.max(b, pl.y + v.y1 - S.cellH);
      }
      if (l || t || r || b) {
        S.cellW += l + r; S.cellH += t + b;
        S.guides = { ...S.guides, cx: S.guides.cx + l, base: S.guides.base + t, top: S.guides.top + t, weapon: S.guides.weapon + t };
        S.frames.forEach(f => { f.ox += l; f.oy += t; });
        for (const e of S.effects) { e.x += l; e.y += t; for (const k of Object.keys(e.keys)) e.keys[k] = { x: e.keys[k].x + l, y: e.keys[k].y + t }; }
        S.autoFx.tips = S.autoFx.tips.map(p => ({ x: p.x + l, y: p.y + t }));
        for (const e of S.effects) if (e.auto === 'trail') { e.x = S.cellW / 2; e.y = S.cellH / 2; }   // cell-sized trail frames: redrawn for the new cell
        refreshAutoFx();
        warnings.push(`cell grown by [${l}, ${t}, ${r}, ${b}] so effects are not cut`);
      }
    }
    const props = [];   // extracted pieces, saved with the other outputs below
    let timingTop = o.timingExtra ? { ...o.timingExtra } : null;
    for (const ex of o.extract || []) {
      const fi = ex.frame || 0, f = S.frames[fi];
      if (!f) { warnings.push(`extract ${ex.name}: no frame ${fi}`); continue; }
      const thr = ex.minAlpha ?? 40, m = frameMap(f), cellOf = k => [f.ox + KX(k), f.oy + KY(k)];
      const solid = new Map([...m].filter(([, c]) => c[3] > thr));
      const groups = IO.groups(solid).sort((a, b) => b.length - a.length);
      const inBox = k => { const [x, y] = cellOf(k), b = ex.box; return x >= b[0] && y >= b[1] && x < b[0] + b[2] && y < b[1] + b[3]; };
      const core = ex.at ? groups.find(g => g.some(k => { const [x, y] = cellOf(k); return Math.abs(x - ex.at[0]) <= 1 && Math.abs(y - ex.at[1]) <= 1; }))
        : ex.box ? groups.slice(1).find(g => g.every(inBox)) : groups[1];
      if (!core) { warnings.push(`extract ${ex.name}: no piece found`); continue; }
      if (core === groups[0]) warnings.push(`extract ${ex.name}: the piece is the frame's biggest one (the body?)`);
      const coreSet = new Set(core), body = new Set(groups[0] === core ? [] : groups[0]);
      const near = (set, k, r) => { for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (set.has(K(KX(k) + dx, KY(k) + dy))) return true; return false; };
      const piece = new Set(core);
      for (const k of m.keys()) if (!solid.has(k) && near(coreSet, k, 2) && !near(body, k, 1)) piece.add(k);
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, cx0 = Infinity, cx1 = -Infinity, cy0 = Infinity, cy1 = -Infinity;
      for (const k of piece) { const [x, y] = cellOf(k); x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
      for (const k of core) { const [x, y] = cellOf(k); cx0 = Math.min(cx0, x); cy0 = Math.min(cy0, y); cx1 = Math.max(cx1, x); cy1 = Math.max(cy1, y); }
      const w = x1 - x0 + 1, h = y1 - y0 + 1, data = new Uint8ClampedArray(w * h * 4);
      for (const k of piece) { const [x, y] = cellOf(k), c = m.get(k), i = ((y - y0) * w + (x - x0)) * 4; data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; data[i + 3] = c[3]; }
      const gx = (cx0 + cx1 + 1) / 2, gy = ex.pivot === 'center' ? (cy0 + cy1 + 1) / 2 : cy1 + 1;   // from the solid core
      const offset = { x: Math.round(gx - S.guides.cx), y: Math.round(gy - S.guides.base) };
      const file = ex.file || ex.name, showFrame = ex.showFrame ?? fi;
      if (!ex.discard) props.push({ file, canvas: toCanvas({ w, h, data }), json: { name: ex.name, file: `${file.split('/').pop()}.png`, width: w, height: h,
        pivot: { x: Math.round(gx - x0), y: Math.round(gy - y0) }, pivotType: ex.pivot || 'ground', cellBox: [x0, y0, w, h], offset,
        source: { animation: S.name, frame: fi } } });
      for (const ei of ex.erase || []) {
        const g = S.frames[ei]; if (!g) continue;
        for (const k of piece) { const [x, y] = cellOf(k); g.edits.set(K(x - g.ox, y - g.oy), [0, 0, 0, 0]); }
        compose(g);
      }
      if (ex.discard) { warnings.push(`extract ${ex.name}: ${piece.size} px discarded from ${(ex.erase || []).join(', ')}`); continue; }
      timingTop = timingTop || {};
      timingTop.props = { ...(timingTop.props || {}), [ex.name]: { file: `${file}.png`, frame: showFrame, offset } };
      if (ex.offsetKey) timingTop[ex.offsetKey] = offset;
      if (ex.frameKey) timingTop[ex.frameKey] = showFrame;
      warnings.push(`extract ${ex.name}: ${piece.size} px from frame ${fi}${(ex.erase || []).length ? `, erased from ${ex.erase.join(', ')}` : ''}`);
    }
    let frameExtra = o.frameExtra || null;
    if (o.anchors && o.anchors.length) {   // part anchors (shield face, crystal tip, ...) -> timing frames[].<name>
      frameExtra = S.frames.map((f, i) => ({ ...((o.frameExtra || [])[i] || {}) }));
      for (const a of o.anchors) {
        S.frames.forEach((f, i) => {
          if (a.frames && !a.frames.includes(i)) return;
          const p = a.point === 'blade' ? bladeTip(f, a.box) : colorAnchor(f, a);
          if (!p) { warnings.push(`anchor ${a.name}: frame ${i + 1} has no ${a.point === 'blade' ? 'blade' : a.color}`); return; }
          frameExtra[i][a.name] = { x: Math.round(p.x), y: Math.round(p.y) };
        });
      }
    }
    apiTiming = { top: timingTop, frames: frameExtra };
    render();
    const want = new Set(o.outputs || ['project', 'all', 'frames', 'timing']);
    const got = collect = [];
    try {
      if (want.has('project')) saveProject();
      if (want.has('all')) await exportAll();
      if (want.has('frames')) await exportFrames();
      if (want.has('fxframes')) await exportFxFrames();
      if (want.has('timing')) exportTiming();
      for (const pr of props) {   // extracted props: always written (they are what was asked for)
        await savePNG(pr.canvas, `${pr.file}.png`);
        download(new Blob([JSON.stringify(pr.json, null, 1)], { type: 'application/json' }), `${pr.file}.json`);
      }
    } finally { collect = null; apiTiming = null; }
    const b64 = blob => new Promise(r => { const fr = new FileReader(); fr.onload = () => r(String(fr.result).split(',')[1]); fr.readAsDataURL(blob); });
    return { frames: S.frames.length, cell: [S.cellW, S.cellH], pivot: { x: S.guides.cx, y: S.guides.base }, status: $('status').textContent,
      scale: S.smooth ? +(1 / S.pixel).toFixed(5) : null, shrink: S.smooth ? S.pixel : null, loop: loopInfo, row: rowInfo && { index: o.row, of: rowInfo.rows, y: [rowInfo.top, rowInfo.bottom] }, warnings,
      files: await Promise.all(got.map(async f => ({ name: f.name, base64: await b64(f.blob) }))) };
  }
  /**
   * SpriteAligner.measure(o): compare an image's colours with a reference master and suggest --remap pairs.
   *   image, ref (data URLs); box / refBox [x, y, w, h] (only that region); colors (joint clusters, default 14);
   *   minShare (% of the image's opaque pixels a cluster needs, default 2); minDiff (RGB distance worth a remap, default 12).
   * Joint clustering: k-means on an equal sample of both images' opaque pixels (deterministic start: luminance quantiles),
   * so one colour family present in both lands in one cluster; inside it, the image's median vs the master's median is
   * the systematic shift -> src > dst. A cluster (almost) only one side has, or whose two medians are different colour families (hue > 30 deg apart,
   * or one near-neutral), = no counterpart (reported, not suggested).
   * Warm clusters (skin, browns, gold: hue 0-50 deg, saturation > 0.25) are listed but never suggested (standing rule:
   * skin / eyes / browns are not remapped; gold parts need a hand rule with a box).
   * tol = 90th-percentile spread of the image's pixels around src, capped below half the distance to the next cluster.
   */
  async function apiMeasure(o) {
    const pixels = async (url, box) => {
      const { img } = await loadImage(url), out = [];
      const [x0, y0, bw, bh] = box || [0, 0, img.w, img.h];
      for (let y = Math.max(0, y0); y < Math.min(img.h, y0 + bh); y++) for (let x = Math.max(0, x0); x < Math.min(img.w, x0 + bw); x++) {
        const i = (y * img.w + x) * 4;
        if (img.data[i + 3] > 200) out.push([img.data[i], img.data[i + 1], img.data[i + 2]]);
      }
      return out;
    };
    const sample = (px, n) => { const step = Math.max(1, Math.floor(px.length / n)); return px.filter((_, i) => i % step === 0); };
    const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    const median = v => { const q = [...v].sort((x, y) => x - y); return q[Math.floor(q.length / 2)]; };
    const med3 = ps => [0, 1, 2].map(c => median(ps.map(p => p[c])));
    const hex = c => '#' + c.map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
    const warm = c => { const [h, s] = rgbHsl(c); return h <= 50 && s > 0.25; };
    const k = o.colors || 14, minShare = o.minShare ?? 2, minDiff = o.minDiff ?? 12;
    const family = (x, y) => {   // same colour family: both coloured (chroma >= 30) with hue within 30 deg, or both greyish (< 40)
      const cx = Math.max(...x) - Math.min(...x), cy = Math.max(...y) - Math.min(...y);
      if (cx >= 30 && cy >= 30) { const hx = rgbHsl(x)[0], hy = rgbHsl(y)[0]; if (Math.min(Math.abs(hx - hy), 360 - Math.abs(hx - hy)) <= 30) return true; }
      return cx < 40 && cy < 40;
    };
    const A = sample(await pixels(o.image, o.box), 30000), B = sample(await pixels(o.ref, o.refBox), 30000);
    const pts = [...A.map(p => [p, 0]), ...B.map(p => [p, 1])];
    const lum = c => c[0] * 0.299 + c[1] * 0.587 + c[2] * 0.114;
    const sorted = pts.map(p => p[0]).sort((x, y) => lum(x) - lum(y));
    let cs = Array.from({ length: k }, (_, j) => [...sorted[Math.floor((j + 0.5) * sorted.length / k)]]);
    const lab = new Int32Array(pts.length);
    for (let it = 0; it < 15; it++) {
      const sum = cs.map(() => [0, 0, 0, 0]);
      pts.forEach(([p], i) => { let b = 0, bd = Infinity; cs.forEach((c, j) => { const d = dist(p, c); if (d < bd) { bd = d; b = j; } }); lab[i] = b; const q = sum[b]; q[0] += p[0]; q[1] += p[1]; q[2] += p[2]; q[3]++; });
      cs = cs.map((c, j) => (sum[j][3] ? [sum[j][0] / sum[j][3], sum[j][1] / sum[j][3], sum[j][2] / sum[j][3]] : c));
    }
    const rows = cs.map((c, j) => {
      const mine = pts.filter((p, i) => lab[i] === j && p[1] === 0).map(p => p[0]), ref = pts.filter((p, i) => lab[i] === j && p[1] === 1).map(p => p[0]);
      return { j, mine, ref, share: 100 * mine.length / A.length, refShare: 100 * ref.length / B.length };
    }).filter(r => r.share >= minShare).sort((x, y) => y.share - x.share).map(r => {
      const src = med3(r.mine), dst = r.ref.length ? med3(r.ref) : null;
      const ds = r.mine.map(p => dist(p, src)).sort((x, y) => x - y), spread = ds[Math.floor(ds.length * 0.9)] || 0;
      const next = Math.min(...cs.filter((_, j) => j !== r.j).map(c => dist(c, cs[r.j])));
      const tol = Math.max(15, Math.min(60, Math.round(spread), Math.floor(next / 2)));
      const d = dst && r.refShare >= 0.5 && family(src, dst) ? dist(src, dst) : Infinity;
      const verdict = warm(src) ? 'warm (skin / brown / gold): not suggested' : !Number.isFinite(d) ? 'no counterpart in the master: check by hand'
        : d < minDiff ? 'matches' : 'remap';
      return { src: hex(src), share: +r.share.toFixed(1), ref: dst ? hex(dst) : '-------', refShare: +r.refShare.toFixed(1), diff: Number.isFinite(d) ? Math.round(d) : '-', tol, verdict };
    });
    return { clusters: rows, remap: rows.filter(r => r.verdict === 'remap').map(r => `--remap '${r.src}>${r.ref},${r.tol}'`) };
  }
  /** [hue deg, saturation 0-1, lightness 0-1] of an [r, g, b]. */
  function rgbHsl([r, g, b]) {
    r /= 255; g /= 255; b /= 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
    if (!d) return [0, 0, l];
    const s = d / (1 - Math.abs(2 * l - 1));
    const h = mx === r ? ((g - b) / d + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [h * 60, s, l];
  }
  window.SpriteAligner = { run: apiRun, measure: apiMeasure, projectJSON, timingJSON };

  // ---------- start ----------
  bindInputs(); bindSource(); bindEditor(); bindEffects();
  setMode('select'); setTool('move'); syncInputs(); openStep(1);
})();
