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
    perFramePixel: false, head: null,   // head: { x, y, w, h (source px), frame } reference for size matching
    compareMode: 'before',
    effects: [],  // effect instances, see addEffect()
    showEffects: true, effectsMode: 'separate',
    frames: [],   // { box:{x,y,w,h}, raw, dur, ox, oy, edits:Map, fx:Map, pixel } + derived pre, base, img, x0, y0, canvas, anchor, fxImg, autoPixel, head…
  };
  const assets = new Map();   // effect assets: id → { name, frames:[canvas], durations, spec?, url? }
  let fxSel = null;           // selected effect instance id
  let nextId = 1;
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
    if (S.perFramePixel) detectFramePixels();
    S.frames.forEach(prepFrame);
    applyPalettes();
    autoCell();
    if (S.head) compareHeads();
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

  /** Per-frame AI pixel size, searched only within ±20% of the global one (so it cannot jump to a harmonic). */
  function detectFramePixels() {
    for (const f of S.frames) {
      const c = IO.detectPixelSize(keyed, mask, [f.box], S.pixel * 0.8, S.pixel * 1.2);
      f.autoPixel = c.length ? c[0].p : null;
    }
  }

  /** AI pixel size used for a frame: manual override → per-frame auto (if on) → global. */
  const pixelOf = f => f.pixel || (S.perFramePixel && f.autoPixel) || S.pixel;

  /** Downscale + lone-pixel cleanup (no palette yet). */
  function prepFrame(f) {
    f.pre = IO.downscale(keyed, ownerTest(f), f.box, pixelOf(f));
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
      const base = { ...f.pre, data: new Uint8ClampedArray(f.pre.data) };
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
      addEffect(addAsset({ ...a, url, meta, count }));
    }
    status(`이펙트 ${pngs.length}개를 가져왔습니다.`);
  }

  const fxInst = id => S.effects.find(e => e.id === id);

  /** Which asset frame instance e shows on character frame i (-1 = not visible). */
  function fxFrameAt(e, i) {
    if (i < e.start || i >= e.start + e.len) return -1;
    const n = assets.get(e.asset).frames.length;
    return Math.min(n - 1, Math.floor((i - e.start) * n / e.len));
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
    const c = fxCanvas(e, k), p = fxPos(e, i);
    return { c, k, x: Math.round(p.x - c.width / 2), y: Math.round(p.y - c.height / 2) };
  }

  /** Draw every effect visible on frame i onto g (already in cell coordinates × z). */
  function drawEffects(g, i, z) {
    for (const e of S.effects) {
      const pl = fxPlaced(e, i);
      if (!pl) continue;
      g.save();
      g.globalCompositeOperation = e.blend; g.globalAlpha = e.opacity;
      g.imageSmoothingEnabled = false;
      g.drawImage(pl.c, pl.x * z, pl.y * z, pl.c.width * z, pl.c.height * z);
      g.restore();
    }
  }

  /** Blade tip per frame: the bright, grey (steel) pixel farthest from the body centre. */
  function findBladeTips(e) {
    let n = 0;
    for (let i = e.start; i < e.start + e.len && i < S.frames.length; i++) {
      const f = S.frames[i], d = f.img.data, cx = f.anchor.bx, cy = f.anchor.by * 0.55;
      let best = null, bd = -1;
      for (let y = 0; y < f.img.h; y++) for (let x = 0; x < f.img.w; x++) {
        const j = (y * f.img.w + x) * 4;
        if (!d[j + 3]) continue;
        const mx = Math.max(d[j], d[j + 1], d[j + 2]), mn = Math.min(d[j], d[j + 1], d[j + 2]);
        if ((d[j] + d[j + 1] + d[j + 2]) / 3 < 150 || mx - mn > 45) continue;
        const dist = (x - cx) ** 2 + (y - cy) ** 2;
        if (dist > bd) { bd = dist; best = [x, y]; }
      }
      if (best) { e.keys[i] = { x: f.ox + f.x0 + best[0], y: f.oy + f.y0 + best[1] }; n++; }
    }
    e.follow = true;
    return n;
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
    const p = fxPos(e, cur);
    $('fxInfo').textContent = `프레임 ${a.frames.length}장 · 위치 (${p.x}, ${p.y})` + (e.follow ? ` · 키프레임 ${Object.keys(e.keys).length}개` : '');
  }

  function bindEffects() {
    const edit = fn => () => { const e = fxInst(fxSel); if (!e) return; pushUndo(); fn(e); render(); };
    $('btnFxAdd').onclick = addBuiltin;
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
      e.start = Math.min(e.start, S.impact);
    });
    $('btnFxTip').onclick = edit(e => { status(`칼끝을 ${findBladeTips(e)}개 프레임에서 찾았습니다. 틀린 곳은 ✦ 도구로 끌어 고치세요.`); });
    $('btnFxKeysClear').onclick = edit(e => { e.keys = {}; });
  }

  // ---------- undo / redo (positions, edits, FX, frame list, impact, effects) ----------
  const undoStack = [], redoStack = [];
  const snapshot = () => ({
    frames: S.frames.map(f => ({ f, ox: f.ox, oy: f.oy, edits: new Map(f.edits), fx: new Map(f.fx) })),
    impact: S.impact, impactPoint: S.impactPoint, cur, effects: JSON.parse(JSON.stringify(S.effects)),
  });
  function pushUndo() { undoStack.push(snapshot()); if (undoStack.length > 100) undoStack.shift(); redoStack.length = 0; }
  function restore(s) {
    S.frames = s.frames.map(e => { Object.assign(e.f, { ox: e.ox, oy: e.oy, edits: new Map(e.edits), fx: new Map(e.fx) }); compose(e.f); return e.f; });
    S.impact = s.impact; S.impactPoint = s.impactPoint; cur = s.cur; S.effects = s.effects;
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
    if (main) g.drawImage(f.canvas, f.ox + f.x0, f.oy + f.y0);
    if (fx && f.fxCanvas) g.drawImage(f.fxCanvas, f.ox + f.fx0, f.oy + f.fy0);
    if (effects) drawEffects(g, i, 1);
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
    if (S.head) {   // the reference frame is whichever box holds the head box (frames may be reordered)
      S.head.frame = boxAt(S.head.x + S.head.w / 2, S.head.y + S.head.h / 2);
      if (S.head.frame < 0) S.head = null;
    }
    S.impact = Math.min(S.impact, Math.max(0, S.frames.length - 1));
    drawSource(); drawEditor(); drawPreview(); drawCompare(); buildStrip(); buildHeadList(); buildFxList();
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
    'toFx', 'exportLeft', 'batchAutoPixel', 'perFramePixel', 'showEffects'];

  function syncInputs() {
    for (const k of NUM_INPUTS) $(k).value = S[k];
    for (const k of CHECKS) $(k).checked = S[k];
    $('name').value = S.name; $('keyColor').value = rgbToHex(S.key); $('gifBg').value = S.gifBg;
    $('outlineColor').value = S.outlineColor; $('paintColor').value = S.paintColor; $('scope').value = S.scope;
    $('compareMode').value = S.compareMode; $('effectsMode').value = S.effectsMode;
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
      perFramePixel: () => { if (S.perFramePixel && keyed) detectFramePixels(); reprocess(false); },
      showEffects: drawEditor,
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
      } else if (ed.fx) {
        const pos = { x: ed.x + Math.round((e.offsetX - ed.mx) / z), y: ed.y + Math.round((e.offsetY - ed.my) / z) };
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
      } else if (done.fx || done.paint) {
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
      const sheet = document.createElement('canvas');
      sheet.width = w * n; sheet.height = h;
      cs.forEach((c, k) => sheet.getContext('2d').drawImage(c, k * w + (w - c.width) / 2, (h - c.height) / 2));
      return { e, sheet, w, h, n, image: `${S.name}_effect${j + 1}.png` };
    });
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
    if (S.effects.length && merged()) m.effectsMerged = true;
    if (S.effects.length && !merged()) {
      const BLEND = { 'source-over': 'normal', lighter: 'add', screen: 'screen' };
      m.effects = effectSheets().map(({ e, w, h, n, image }) => {
        const frames = [];
        for (let i = e.start; i < Math.min(S.frames.length, e.start + e.len); i++) {
          const k = fxFrameAt(e, i), p = fxPos(e, i), x = Math.round(p.x - w / 2), y = Math.round(p.y - h / 2);
          frames.push({ charFrame: i, effectFrame: k, x, y, leftX: S.cellW - x - w });
        }
        return { name: e.name, image, frameWidth: w, frameHeight: h, frameCount: n, blend: BLEND[e.blend], opacity: e.opacity,
          startFrame: e.start, length: e.len, flip: e.flip, rotation: e.rot, scale: e.scale, frames,
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
    const bytes = GIF.encode(W, H, frames, pal, S.frames.map(f => f.dur), S.gifTransparent ? 0 : -1);
    download(new Blob([bytes], { type: 'image/gif' }), `${S.name}_preview.gif`);
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
    const fxAssets = [...assets].filter(([id]) => used.has(id)).map(([id, a]) => a.spec
      ? { id, name: a.name, spec: a.spec }
      : { id, name: a.name, strip: FX.strip(a.frames).toDataURL('image/png'), widths: a.frames.map(c => c.width), durations: a.durations });
    return JSON.stringify({ app: 'sprite-aligner', version: 3, ...settings, fxAssets,
      frames: frames.map(f => ({ box: f.box, raw: f.raw, dur: f.dur, ox: f.ox, oy: f.oy, pixel: f.pixel || null, edits: [...f.edits], fx: [...f.fx] })) });
  }

  async function loadAssets(list = []) {
    assets.clear(); fxCache.clear();
    for (const a of list) {
      if (a.spec) { assets.set(a.id, { ...FX.builtin(a.spec.type, a.spec.color, a.spec.size), name: a.name, spec: a.spec, version: 1 }); continue; }
      const { canvas } = await loadImage(a.strip);
      let x = 0;
      const frames = a.widths.map(w => { const c = document.createElement('canvas'); c.width = w; c.height = canvas.height; c.getContext('2d').drawImage(canvas, -x, 0); x += w; return c; });
      assets.set(a.id, { name: a.name, frames, durations: a.durations, version: 1 });
    }
    const ids = [...assets.keys()].map(id => +id.slice(1)), eids = S.effects.map(e => +e.id.slice(1));
    nextId = Math.max(nextId, ...ids, ...eids) + 1;
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
    Object.assign(S, { effects: [], head: null, perFramePixel: false }, settings);
    pixelCands = []; fxSel = null;
    await loadAssets(fxAssets);
    rekey();
    S.frames = frames.map(f => ({ ...f, edits: new Map(f.edits || []), fx: new Map(f.fx || []) }));
    if (S.perFramePixel) detectFramePixels();
    S.frames.forEach(prepFrame);
    applyPalettes();
    if (S.head) compareHeads();
    S.frames.forEach(f => { f.placed = true; });
    cur = 0; boxSel.clear(); selection.clear();
    undoStack.length = redoStack.length = 0;
    syncInputs(); render(); openStep(3);
    status(`프로젝트 열림: ${S.name} (프레임 ${S.frames.length}개)`);
  }

  // ---------- start ----------
  bindInputs(); bindSource(); bindEditor(); bindEffects();
  setMode('select'); setTool('move'); syncInputs(); openStep(1);
})();
