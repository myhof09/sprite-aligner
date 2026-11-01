// app.js — state and UI of Sprite Aligner. Everything runs in the browser; images are never uploaded.
//
// Pipeline: source PNG → chroma-key mask + despill (keyed) → connected regions → frame boxes →
// per frame: downscale to the true pixel grid (block mode colour) → optional lone-pixel cleanup → palette snap →
// placed in an equal-size cell at (ox, oy) → sheet / meta / GIF export.
'use strict';
(() => {
  const $ = id => document.getElementById(id);

  // ---------- state (everything a project file saves) ----------
  const S = {
    name: 'sprite', srcURL: '',
    key: [40, 250, 34], tol: 90, edge: 70, despill: 1,
    bodyFrac: 0.2, minPiece: 8,
    pixel: 4, colors: 24, lone: false,
    cellW: 64, cellH: 64, pad: 2,
    guides: { base: 60, top: 4, weapon: 30, cx: 32 },
    snap: true, onion: true, grid: true, zoom: 6, pzoom: 3, loop: true,
    impact: 0, gifScale: 4, gifBg: '#3a3e46', gifTransparent: false,
    frames: [],   // { box:{x,y,w,h}, raw, dur, ox, oy } + derived img, canvas, placed
  };
  let src = null, srcCanvas = null;          // original image + canvas
  let keyed = null, mask = null, keyedCanvas = null;
  let labels = null, comps = [];             // connected regions of the mask
  let cur = 0, mode = 'select', sel = new Set(), pixelCands = [];

  const GUIDES = [
    { k: 'base', label: '발', color: '#ff5a5a', v: false },
    { k: 'top', label: '머리', color: '#5ad1ff', v: false },
    { k: 'weapon', label: '무기', color: '#ffd45a', v: false },
    { k: 'cx', label: '중심', color: '#7dff7d', v: true },
  ];

  const status = msg => { $('status').textContent = msg; };
  const tick = () => new Promise(r => setTimeout(r, 20));   // let the status text paint before heavy work

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

  async function openSource(url, name) {
    status('불러오는 중…'); await tick();
    ({ canvas: srcCanvas, img: src } = await loadImage(url));
    S.srcURL = url;
    if (name) S.name = name;
    S.key = IO.guessKey(src);
    syncInputs();
    status('배경 제거 · 프레임 감지 중…'); await tick();
    rekey();
    detect();
    status(`프레임 ${S.frames.length}개 · 가짜 픽셀 ${S.pixel}px · 셀 ${S.cellW}×${S.cellH}`);
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

  function detect() {
    const boxes = IO.detectFrames(comps, { bodyFrac: S.bodyFrac, minPiece: S.minPiece });
    const old = S.frames;
    S.frames = boxes.map((box, i) => ({ box, raw: false, dur: old[i] ? old[i].dur : 100 }));
    sel.clear(); cur = 0;
    detectPixel();
    S.frames.forEach(processFrame);
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

  function processFrame(f) {
    const prev = f.img;
    const img = IO.downscale(keyed, ownerTest(f), f.box, S.pixel);
    if (S.lone) IO.removeLonePixels(img);
    if (S.colors > 0) IO.snapToPalette(img, IO.dominantPalette([img], S.colors));
    f.img = img;
    f.canvas = toCanvas(img);
    if (!prev || prev.w !== img.w || prev.h !== img.h) f.placed = false;
  }

  /** Re-run frame processing (after key / pixel / palette changes); frames whose size changed are re-placed. */
  async function reprocess(rekeyToo) {
    if (!src) return;
    status('처리 중…'); await tick();
    if (rekeyToo) rekey();
    S.frames.forEach(processFrame);
    fitCell();
    S.frames.forEach(f => { if (!f.placed) autoPlace(f); });
    render();
    status(`프레임 ${S.frames.length}개 · 가짜 픽셀 ${S.pixel}px`);
  }

  // ---------- cell & placement ----------
  /** Cell = biggest frame + padding; guides reset to feet line at the bottom, centre line in the middle. */
  function autoCell() {
    const mw = Math.max(1, ...S.frames.map(f => f.img.w)), mh = Math.max(1, ...S.frames.map(f => f.img.h));
    S.cellW = mw + 2 * S.pad; S.cellH = mh + 2 * S.pad;
    S.guides = { base: S.cellH - S.pad, top: S.pad, weapon: Math.round(S.cellH * 0.45), cx: Math.round(S.cellW / 2) };
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

  /** Feet (bottom of the trimmed frame) on the baseline, box centre on the centre line. */
  function autoPlace(f) {
    f.ox = Math.round(S.guides.cx - f.img.w / 2);
    f.oy = S.guides.base - f.img.h;
    f.placed = true;
  }

  function snapFrame(f) {
    const g = S.guides, t = 3, bottom = f.oy + f.img.h, mid = f.ox + f.img.w / 2;
    if (Math.abs(bottom - g.base) <= t) f.oy = g.base - f.img.h;
    else if (Math.abs(f.oy - g.top) <= t) f.oy = g.top;
    if (Math.abs(mid - g.cx) <= t) f.ox = Math.round(g.cx - f.img.w / 2);
  }

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
    const W = S.cellW * z, H = S.cellH * z;
    g.font = '10px system-ui';
    for (const gd of GUIDES) {
      const v = S.guides[gd.k] * z;
      g.fillStyle = gd.color;
      if (gd.v) g.fillRect(v - (z >= 4 ? 1 : 0), 0, z >= 4 ? 2 : 1, H);
      else g.fillRect(0, v - (z >= 4 ? 1 : 0), W, z >= 4 ? 2 : 1);
      if (labels) gd.v ? g.fillText(gd.label, v + 3, 10) : g.fillText(gd.label, 2, v - 3);
    }
  }

  /** Draw frame i in its cell at zoom z onto canvas cv. */
  function drawCell(cv, z, i, { onion = false, guides = true, grid = false, labels = false } = {}) {
    const W = S.cellW * z, H = S.cellH * z;
    if (cv.width !== W) cv.width = W;
    if (cv.height !== H) cv.height = H;
    const g = cv.getContext('2d');
    g.imageSmoothingEnabled = false;
    checker(g, W, H, Math.max(8, z * 4));
    const blit = (f, a) => { if (!f) return; g.globalAlpha = a; g.drawImage(f.canvas, f.ox * z, f.oy * z, f.canvas.width * z, f.canvas.height * z); g.globalAlpha = 1; };
    const n = S.frames.length;
    if (onion && n > 1) { blit(S.frames[(i - 1 + n) % n], 0.25); if (n > 2) blit(S.frames[(i + 1) % n], 0.25); }
    blit(S.frames[i], 1);
    if (grid) drawGrid(g, z, S.cellW, S.cellH);
    if (guides) drawGuides(g, z, labels);
    g.strokeStyle = '#555b68'; g.strokeRect(0.5, 0.5, W - 1, H - 1);
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
      g.strokeStyle = sel.has(i) ? '#ffd45a' : i === cur ? '#5aa9ff' : '#ff4fd8';
      g.lineWidth = sel.has(i) || i === cur ? 2 : 1;
      g.strokeRect(b.x * s + 0.5, b.y * s + 0.5, b.w * s, b.h * s);
      g.fillStyle = g.strokeStyle; g.fillText('#' + i + (f.raw ? '*' : ''), b.x * s + 2, b.y * s - 3);
    });
    if (drag && drag.kind === 'box') {
      g.strokeStyle = '#fff'; g.setLineDash([4, 3]);
      g.strokeRect(drag.x0 * dispScale, drag.y0 * dispScale, (drag.x1 - drag.x0) * dispScale, (drag.y1 - drag.y0) * dispScale);
      g.setLineDash([]);
    }
    $('srcInfo').textContent = `${src.w}×${src.h} · 키 rgb(${S.key.join(',')})`;
  }

  function drawEditor() {
    if (!S.frames.length) { $('editor').width = 0; return; }
    drawCell($('editor'), S.zoom, cur, { onion: S.onion, grid: S.grid, labels: true });
    const f = S.frames[cur];
    $('frameInfo').textContent = `#${cur} · 위치 (${f.ox}, ${f.oy}) · 크기 ${f.img.w}×${f.img.h} · ${f.dur}ms` + (cur === S.impact ? ' · ★임팩트' : '');
  }

  let playing = false, pIdx = 0, pTimer = 0;
  function drawPreview() {
    if (!S.frames.length) return;
    const i = playing ? pIdx : cur;
    drawCell($('preview'), S.pzoom, i, { guides: false, grid: S.grid });
    if (i === S.impact) { const g = $('preview').getContext('2d'); g.fillStyle = '#ffd45a'; g.font = '12px system-ui'; g.fillText('★', 4, 14); }
  }

  /** Before (source crop, scaled so one fake pixel ≈ 8 screen px) next to after (true pixels at 8×). */
  function drawCompare() {
    const f = S.frames[cur], b4 = $('before'), af = $('after');
    if (!f) return;
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

  let thumbs = [];
  function buildStrip() {
    const el = $('strip');
    el.innerHTML = '';
    thumbs = S.frames.map((f, i) => {
      const d = document.createElement('div');
      d.className = 'thumb' + (i === cur ? ' cur' : '');
      const c = document.createElement('canvas');
      const lbl = document.createElement('div');
      lbl.className = 'lbl';
      lbl.textContent = `#${i}` + (i === S.impact ? ' ★' : '');
      const inp = document.createElement('input');
      inp.type = 'number'; inp.min = 10; inp.step = 10; inp.value = f.dur; inp.title = '프레임 시간 (ms)';
      inp.onchange = () => { f.dur = Math.max(10, Math.round(+inp.value) || 100); inp.value = f.dur; drawEditor(); };
      d.append(c, lbl, inp);
      d.onclick = e => { if (e.target !== inp) select(i); };
      el.append(d);
      return c;
    });
    thumbs.forEach((_, i) => drawThumb(i));
  }
  const thumbZoom = () => Math.max(1, Math.min(3, Math.floor(110 / S.cellH)));
  const drawThumb = i => thumbs[i] && drawCell(thumbs[i], thumbZoom(), i, { guides: true });

  function render() {
    cur = Math.min(cur, Math.max(0, S.frames.length - 1));
    drawSource(); drawEditor(); drawPreview(); drawCompare(); buildStrip();
  }

  function select(i) {
    cur = i;
    render();
    $('editor').focus();
  }

  // ---------- inputs ----------
  const NUM_INPUTS = { tol: 'tol', edge: 'edge', despill: 'despill', bodyFrac: 'bodyFrac', pixel: 'pixel', colors: 'colors',
    cellW: 'cellW', cellH: 'cellH', pad: 'pad', zoom: 'zoom', pzoom: 'pzoom', impact: 'impact', gifScale: 'gifScale' };
  const CHECKS = { snap: 'snap', onion: 'onion', grid: 'grid', loop: 'loop', lone: 'lone', gifTransparent: 'gifTransparent' };
  const hex = c => '#' + c.map(v => v.toString(16).padStart(2, '0')).join('');

  function syncInputs() {
    for (const [id, k] of Object.entries(NUM_INPUTS)) $(id).value = S[k];
    for (const [id, k] of Object.entries(CHECKS)) $(id).checked = S[k];
    $('name').value = S.name; $('keyColor').value = hex(S.key); $('gifBg').value = S.gifBg;
    document.querySelectorAll('output').forEach(o => { o.textContent = $(o.htmlFor.value).value; });
    $('pixelCands').innerHTML = '';
    pixelCands.forEach(c => {
      const b = document.createElement('button');
      b.className = 'chip' + (Math.abs(c.p - S.pixel) < 1e-6 ? ' on' : '');
      b.textContent = c.p.toFixed(2); b.title = '감지 점수 ' + c.score.toFixed(1);
      b.onclick = () => { S.pixel = c.p; syncInputs(); reprocess(false); };
      $('pixelCands').append(b);
    });
  }

  function bindInputs() {
    const after = {   // what each setting re-runs
      tol: () => reprocess(true), edge: () => reprocess(true), despill: () => reprocess(true),
      bodyFrac: () => {}, pixel: () => reprocess(false), colors: () => reprocess(false), lone: () => reprocess(false),
      cellW: render, cellH: render, pad: () => {}, zoom: render, pzoom: drawPreview, impact: render,
      snap: () => {}, onion: drawEditor, grid: render, loop: () => {}, gifScale: () => {}, gifTransparent: () => {},
    };
    for (const [id, k] of Object.entries(NUM_INPUTS)) {
      const el = $(id), live = el.type === 'range';
      el.addEventListener('input', () => { const o = document.querySelector(`output[for=${id}]`); if (o) o.textContent = el.value; });
      el.addEventListener(live && ['zoom', 'pzoom'].includes(id) ? 'input' : 'change', () => {
        const v = +el.value;
        if (!Number.isFinite(v)) return;
        S[k] = ['cellW', 'cellH', 'zoom', 'pzoom', 'impact', 'gifScale', 'pad', 'colors'].includes(k) ? Math.round(v) : v;
        after[k]();
      });
    }
    for (const [id, k] of Object.entries(CHECKS)) $(id).addEventListener('change', () => { S[k] = $(id).checked; after[k](); });
    $('name').onchange = () => { S.name = $('name').value.trim() || 'sprite'; };
    $('keyColor').onchange = () => { const v = $('keyColor').value; S.key = [1, 3, 5].map(i => parseInt(v.slice(i, i + 2), 16)); reprocess(true); };
    $('gifBg').onchange = () => { S.gifBg = $('gifBg').value; };
    $('showKeyed').onchange = drawSource;

    $('fileImg').onchange = e => {
      const file = e.target.files[0];
      if (!file) return;
      const r = new FileReader();
      r.onload = () => openSource(r.result, file.name.replace(/\.[^.]+$/, ''));
      r.readAsDataURL(file);
      e.target.value = '';
    };
    $('btnSample').onclick = () => openSource(Sample.make().toDataURL('image/png'), 'sample');
    $('fileProj').onchange = e => {
      const file = e.target.files[0];
      if (!file) return;
      file.text().then(loadProject).catch(err => status('프로젝트 오류: ' + err.message));
      e.target.value = '';
    };
    $('btnSaveProj').onclick = saveProject;

    $('btnDetect').onclick = async () => { if (!src) return; status('감지 중…'); await tick(); detect(); status(`프레임 ${S.frames.length}개`); };
    $('btnPixel').onclick = async () => { if (!src) return; status('픽셀 크기 감지 중…'); await tick(); detectPixel(); reprocess(false); };
    $('btnAutoCell').onclick = () => { autoCell(); render(); };
    $('btnAutoPlace').onclick = () => { S.frames.forEach(autoPlace); render(); };
    $('btnMerge').onclick = mergeSelected;
    $('btnDelete').onclick = deleteSelected;
    document.querySelectorAll('[data-mode]').forEach(b => b.onclick = () => setMode(b.dataset.mode));
    $('btnPlay').onclick = () => play(!playing);

    $('btnSheet').onclick = exportSheet;
    $('btnMeta').onclick = exportMeta;
    $('btnGif').onclick = exportGif;
    $('btnAll').onclick = () => { exportSheet(); exportMeta(); exportGif(); };

    // drop a PNG or project file anywhere
    document.addEventListener('dragover', e => e.preventDefault());
    document.addEventListener('drop', e => {
      e.preventDefault();
      const file = e.dataTransfer.files[0];
      if (!file) return;
      if (file.name.endsWith('.json')) file.text().then(loadProject);
      else { const r = new FileReader(); r.onload = () => openSource(r.result, file.name.replace(/\.[^.]+$/, '')); r.readAsDataURL(file); }
    });
    window.addEventListener('resize', drawSource);
  }

  function setMode(m) {
    mode = m;
    document.querySelectorAll('[data-mode]').forEach(b => b.classList.toggle('on', b.dataset.mode === m));
    $('src').style.cursor = m === 'select' ? 'default' : 'crosshair';
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

  function addFrames(list) {
    list.forEach(processFrame);
    S.frames.sort((a, b) => a.box.x - b.box.x);
    fitCell();
    S.frames.forEach(f => { if (!f.placed) autoPlace(f); });
    sel.clear();
    render();
  }

  function mergeSelected() {
    const idx = [...sel].sort((a, b) => a - b);
    if (idx.length < 2) { status('병합: Shift+클릭으로 박스 2개 이상 선택'); return; }
    const fs = idx.map(i => S.frames[i]);
    const x0 = Math.min(...fs.map(f => f.box.x)), y0 = Math.min(...fs.map(f => f.box.y));
    const x1 = Math.max(...fs.map(f => f.box.x + f.box.w)), y1 = Math.max(...fs.map(f => f.box.y + f.box.h));
    const nf = { box: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, raw: fs.some(f => f.raw), dur: fs[0].dur };
    S.frames = S.frames.filter((_, i) => !sel.has(i));
    S.frames.push(nf);
    addFrames([nf]);
    cur = S.frames.indexOf(nf); render();
  }

  function deleteSelected() {
    if (!sel.size) sel.add(cur);
    S.frames = S.frames.filter((_, i) => !sel.has(i));
    sel.clear(); render();
  }

  function splitAt(i, sx) {
    const b = S.frames[i].box;
    if (sx <= b.x || sx >= b.x + b.w) return;
    const parts = [{ x: b.x, y: b.y, w: sx - b.x, h: b.h }, { x: sx, y: b.y, w: b.x + b.w - sx, h: b.h }].map(tighten).filter(Boolean);
    const nfs = parts.map(box => ({ box, raw: true, dur: S.frames[i].dur }));
    S.frames.splice(i, 1, ...nfs);
    addFrames(nfs);
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
        if (i < 0) { sel.clear(); drawSource(); return; }
        if (e.shiftKey) sel.has(i) ? sel.delete(i) : sel.add(i);
        else { sel.clear(); sel.add(i); }
        cur = i; render();
      } else if (mode === 'split') {
        const i = boxAt(x, y);
        if (i >= 0) splitAt(i, x);
      } else if (mode === 'add') {
        drag = { kind: 'box', x0: x, y0: y, x1: x, y1: y };
        cv.setPointerCapture(e.pointerId);
      }
    });
    cv.addEventListener('pointermove', e => {
      if (!drag || drag.kind !== 'box') return;
      const p = srcPos(e);
      drag.x1 = Math.max(0, Math.min(src.w, p.x)); drag.y1 = Math.max(0, Math.min(src.h, p.y));
      drawSource();
    });
    cv.addEventListener('pointerup', () => {
      if (!drag || drag.kind !== 'box') return;
      const b = { x: Math.min(drag.x0, drag.x1), y: Math.min(drag.y0, drag.y1), w: Math.abs(drag.x1 - drag.x0), h: Math.abs(drag.y1 - drag.y0) };
      drag = null;
      const t = b.w > 2 && b.h > 2 ? tighten(b) : null;
      if (!t) { drawSource(); return; }
      const nf = { box: t, raw: true, dur: 100 };
      S.frames.push(nf);
      addFrames([nf]);
      cur = S.frames.indexOf(nf); render();
    });
  }

  // ---------- editor: move frame, move guides, keys ----------
  function bindEditor() {
    const cv = $('editor');
    let ed = null;
    cv.addEventListener('pointerdown', e => {
      const f = S.frames[cur];
      if (!f) return;
      const z = S.zoom, hit = GUIDES.find(g => Math.abs((g.v ? e.offsetX : e.offsetY) - S.guides[g.k] * z) <= 5);
      ed = hit ? { guide: hit } : { mx: e.offsetX, my: e.offsetY, ox: f.ox, oy: f.oy };
      cv.setPointerCapture(e.pointerId);
    });
    cv.addEventListener('pointermove', e => {
      const z = S.zoom;
      if (!ed) {   // cursor hint over guides
        const hit = GUIDES.find(g => Math.abs((g.v ? e.offsetX : e.offsetY) - S.guides[g.k] * z) <= 5);
        cv.style.cursor = hit ? (hit.v ? 'ew-resize' : 'ns-resize') : 'move';
        return;
      }
      if (ed.guide) {
        const lim = ed.guide.v ? S.cellW : S.cellH;
        S.guides[ed.guide.k] = Math.max(0, Math.min(lim, Math.round((ed.guide.v ? e.offsetX : e.offsetY) / z)));
        drawEditor(); thumbs.forEach((_, i) => drawThumb(i));
      } else {
        const f = S.frames[cur];
        f.ox = ed.ox + Math.round((e.offsetX - ed.mx) / z);
        f.oy = ed.oy + Math.round((e.offsetY - ed.my) / z);
        if (S.snap) snapFrame(f);
        drawEditor(); drawThumb(cur); drawPreview();
      }
    });
    cv.addEventListener('pointerup', () => { ed = null; });

    document.addEventListener('keydown', e => {
      if (e.target.tagName === 'INPUT' || !S.frames.length) return;
      const f = S.frames[cur], d = e.shiftKey ? 5 : 1;
      const moves = { ArrowLeft: [-d, 0], ArrowRight: [d, 0], ArrowUp: [0, -d], ArrowDown: [0, d] };
      if (moves[e.key]) {
        f.ox += moves[e.key][0]; f.oy += moves[e.key][1];
        drawEditor(); drawThumb(cur); drawPreview();
        e.preventDefault();
      } else if (e.key === ',' || e.key === '.') {
        select((cur + (e.key === '.' ? 1 : -1) + S.frames.length) % S.frames.length);
      } else if (e.key === ' ') {
        play(!playing); e.preventDefault();
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

  /** Frame i composited into its cell (RGBA, cellW×cellH). */
  function cellPixels(i) {
    const c = document.createElement('canvas');
    c.width = S.cellW; c.height = S.cellH;
    const f = S.frames[i], g = c.getContext('2d');
    g.drawImage(f.canvas, f.ox, f.oy);
    return g.getImageData(0, 0, S.cellW, S.cellH).data;
  }

  function sheetCanvas() {
    const c = document.createElement('canvas');
    c.width = S.cellW * S.frames.length; c.height = S.cellH;
    const g = c.getContext('2d');
    S.frames.forEach((f, i) => {
      g.save(); g.beginPath(); g.rect(i * S.cellW, 0, S.cellW, S.cellH); g.clip();   // nothing bleeds into the next cell
      g.drawImage(f.canvas, i * S.cellW + f.ox, f.oy);
      g.restore();
    });
    return c;
  }

  function exportSheet() {
    if (!S.frames.length) return;
    sheetCanvas().toBlob(b => download(b, `${S.name}.png`), 'image/png');
  }

  function meta() {
    const durations = S.frames.map(f => f.dur);
    return {
      image: `${S.name}.png`,
      frameWidth: S.cellW, frameHeight: S.cellH, frameCount: S.frames.length,
      frames: S.frames.map((f, i) => ({ index: i, x: i * S.cellW, y: 0, w: S.cellW, h: S.cellH, duration: f.dur })),
      durations,
      totalDuration: durations.reduce((a, b) => a + b, 0),
      loop: S.loop,
      pivot: { x: S.guides.cx, y: S.guides.base, note: 'centre line x, feet baseline y (pixel boundaries)' },
      impactFrame: S.impact,
      guides: { ...S.guides },
      pixelSize: S.pixel,
    };
  }

  function exportMeta() {
    if (!S.frames.length) return;
    download(new Blob([JSON.stringify(meta(), null, 2)], { type: 'application/json' }), `${S.name}.json`);
  }

  function exportGif() {
    if (!S.frames.length) return;
    const k = Math.max(1, S.gifScale), W = S.cellW * k, H = S.cellH * k;
    const cells = S.frames.map((_, i) => cellPixels(i));
    const bg = [1, 3, 5].map(i => parseInt(S.gifBg.slice(i, i + 2), 16));
    // palette: index 0 = transparent or background, then every colour used (median cut if more than 255)
    const seen = new Map();
    for (const d of cells) for (let i = 0; i < d.length; i += 4) if (d[i + 3]) seen.set(d[i] << 16 | d[i + 1] << 8 | d[i + 2], 0);
    let colors = [...seen.keys()].map(v => [v >> 16, v >> 8 & 255, v & 255]);
    if (colors.length > 255) colors = IO.medianCut(colors, 255);
    const pal = [S.gifTransparent ? [0, 0, 0] : bg, ...colors], index = new Map();
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

  // ---------- project file ----------
  function saveProject() {
    if (!src) return;
    const { frames, ...settings } = S;
    const proj = { app: 'sprite-aligner', version: 1, ...settings, frames: frames.map(f => ({ box: f.box, raw: f.raw, dur: f.dur, ox: f.ox, oy: f.oy })) };
    download(new Blob([JSON.stringify(proj)], { type: 'application/json' }), `${S.name}.sprite-aligner.json`);
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
    S.frames = frames.map(f => ({ ...f }));
    S.frames.forEach(f => { processFrame(f); f.placed = true; });
    cur = 0; sel.clear();
    syncInputs(); render();
    status(`프로젝트 열림: ${S.name} (프레임 ${S.frames.length}개)`);
  }

  // ---------- start ----------
  bindInputs(); bindSource(); bindEditor();
  setMode('select'); syncInputs();
})();
