// fxmode.js — "이펙트만" mode: make skill effects with no character. A blank square canvas (32–128 px), the recipe
// gallery, live JSON editing and sliders, a preview on a game background with the game's 62 px cell, and export of a
// sprite sheet + meta JSON (fps, durations, impactFrame, blend) — one effect, or many at once as a .zip.
'use strict';
const FXMODE = (() => {
  const $ = id => document.getElementById(id);
  const SIZES = [32, 48, 64, 96, 128];
  const BLENDS = { normal: 'source-over', add: 'lighter', screen: 'screen' };
  const LS_KEY = 'sprite-aligner.fxmode.list';
  const clone = o => JSON.parse(JSON.stringify(o));
  const safeName = s => (s || 'effect').trim().replace(/[\\/:*?"<>|\s]+/g, '_') || 'effect';

  // the effect being edited
  const E = {
    name: '베기 궤적', recipe: clone(PXF_STARTERS.slash), size: 64, hue: 0, speed: 1,
    blend: 'add', impactFrame: -1, impactHold: 0, loop: null, slash: {},
  };
  let out = null;            // last render: { frames, durations, N, fps, F, loop, game, warnings }
  let list = [];             // 내 이펙트 (batch)
  let bgImg = null, playing = true, cur = 0, timer = 0, galTimer = 0, renderTimer = 0;

  // ---------- render ----------
  /** The recipe as rendered: slash controls applied (recipes that draw with Arc), loop override. */
  function graphOf(e) {
    let g = e.slash && Object.keys(e.slash).length && PXF_SLASH.hasArc(e.recipe) ? PXF_SLASH.apply(e.recipe, e.slash) : clone(e.recipe);
    if (e.loop !== null) g.settings = { ...g.settings, loop: e.loop };
    return g;
  }

  /** Render an effect at its canvas size; durations with the impact hold; impactFrame resolved. */
  function renderFx(e) {
    const g = graphOf(e), base = g.settings?.size || 64;
    const r = PXF.render(g, { scale: e.size / base, hue: e.hue, speed: e.speed });
    // exact canvas size (render rounds size x scale): crop / pad centred
    const frames = r.frames.map(c => {
      if (c.width === e.size) return c;
      const d = document.createElement('canvas');
      d.width = d.height = e.size;
      d.getContext('2d').drawImage(c, Math.round((e.size - c.width) / 2), Math.round((e.size - c.height) / 2));
      return d;
    });
    const impact = impactOf(e, r, frames);
    const durations = r.durations.map((d, i) => Math.round(d + (i === impact ? e.impactHold : 0)));
    return { ...r, frames, durations, impact, N: e.size };
  }

  /** The impact frame: set by hand, else the recipe's game.impactFrame, else the frame with the most pixels. */
  function impactOf(e, r, frames) {
    if (e.impactFrame >= 0) return Math.min(e.impactFrame, frames.length - 1);
    if (Number.isInteger(r.game?.impactFrame)) return Math.min(r.game.impactFrame, frames.length - 1);
    let best = 0, most = -1;
    frames.forEach((c, i) => {
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let k = 3; k < d.length; k += 4) if (d[k]) n++;
      if (n > most) { most = n; best = i; }
    });
    return best;
  }

  function rerender() {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(() => {
      try {
        out = renderFx(E);
        $('fxmErr').textContent = out.warnings.length ? `아직 그리지 않는 노드: ${out.warnings.join(', ')}` : '';
      } catch (err) {
        $('fxmErr').textContent = String(err.message || err);
        return;
      }
      if (cur >= out.frames.length) cur = 0;
      showInfo(); buildStrip(); draw(); play();
    }, 60);
  }

  // ---------- drawing ----------
  function checker(g, w, h, s = 8) {
    for (let y = 0; y < h; y += s) for (let x = 0; x < w; x += s) {
      g.fillStyle = ((x + y) / s) % 2 ? '#2a2d35' : '#22252c';
      g.fillRect(x, y, s, s);
    }
  }

  /** A plain field (no background picture): grass-ish tiles. */
  function defaultBg(g, W, H, T) {
    for (let y = 0; y < H; y += T) for (let x = 0; x < W; x += T) {
      g.fillStyle = ((x + y) / T) % 2 ? '#3d5a34' : '#41603a';
      g.fillRect(x, y, T, T);
    }
  }

  function draw() {
    if (!out) return;
    const fr = out.frames[cur], N = out.N;
    // zoomed view (on a checker, the blend shown as on a dark ground)
    const z = Math.max(1, Math.floor(256 / N)), big = $('fxmBig');
    big.width = big.height = N * z;
    const g = big.getContext('2d');
    g.imageSmoothingEnabled = false;
    checker(g, big.width, big.height, Math.max(4, z * 4));
    g.globalCompositeOperation = BLENDS[E.blend];
    g.drawImage(fr, 0, 0, N * z, N * z);
    g.globalCompositeOperation = 'source-over';
    if (cur === out.impact) { g.strokeStyle = '#ffd45a'; g.lineWidth = 2; g.strokeRect(1, 1, big.width - 2, big.height - 2); }

    // game view: cells of the game's tile size over the background, the effect centred on the middle cell
    const T = Math.max(8, +$('fxmTile').value || 62), gs = Math.max(0.25, +$('fxmScale').value || 1), pz = Math.max(1, +$('fxmZoom').value || 2);
    const cols = 5, rows = 3, W = cols * T, H = rows * T, gv = $('fxmGame');
    gv.width = W * pz; gv.height = H * pz;
    const h = gv.getContext('2d');
    h.imageSmoothingEnabled = false;
    h.save(); h.scale(pz, pz);
    if (bgImg) { h.fillStyle = h.createPattern(bgImg, 'repeat'); h.fillRect(0, 0, W, H); } else defaultBg(h, W, H, T);
    h.strokeStyle = 'rgba(255,255,255,0.18)'; h.lineWidth = 1 / pz;
    for (let x = 0; x <= W; x += T) { h.beginPath(); h.moveTo(x, 0); h.lineTo(x, H); h.stroke(); }
    for (let y = 0; y <= H; y += T) { h.beginPath(); h.moveTo(0, y); h.lineTo(W, y); h.stroke(); }
    h.strokeStyle = 'rgba(255,212,90,0.7)'; h.strokeRect(2 * T, T, T, T);
    const s = N * gs;
    h.globalCompositeOperation = BLENDS[E.blend];
    h.drawImage(fr, Math.round(2.5 * T - s / 2), Math.round(1.5 * T - s / 2), s, s);
    h.restore();

    for (const [i, el] of [...$('fxmStrip').children].entries()) el.classList.toggle('cur', i === cur);
    $('fxmFrame').textContent = `${cur + 1} / ${out.frames.length}${cur === out.impact ? ' ★' : ''}`;
  }

  function play() {
    clearTimeout(timer);
    if (!playing || !out) return;
    timer = setTimeout(() => {
      const last = cur === out.frames.length - 1;
      cur = last ? 0 : cur + 1;
      draw();
      // one-shot effects: a short pause before the next loop, so the start reads
      if (last && !out.loop) { clearTimeout(timer); timer = setTimeout(play, 400); } else play();
    }, out.durations[cur]);
  }

  function buildStrip() {
    const st = $('fxmStrip');
    st.innerHTML = '';
    out.frames.forEach((fr, i) => {
      const d = document.createElement('div'), c = document.createElement('canvas'), l = document.createElement('div');
      d.className = 'thumb' + (i === out.impact ? ' impact' : '');
      c.width = c.height = 48;
      const g = c.getContext('2d');
      g.imageSmoothingEnabled = false;
      checker(g, 48, 48, 6);
      g.drawImage(fr, 0, 0, 48, 48);
      l.className = 'lbl';
      l.innerHTML = `<span>${i}${i === out.impact ? ' ★' : ''}</span><span>${out.durations[i]}ms</span>`;
      d.title = '클릭: 이 프레임 보기 · 더블클릭: 임팩트 프레임으로';
      d.onclick = () => { cur = i; playing = false; syncPlay(); draw(); };
      d.ondblclick = () => { E.impactFrame = i; $('fxmImpact').value = i; rerender(); };
      d.append(c, l);
      st.append(d);
    });
  }

  function showInfo() {
    const ms = out.durations.reduce((a, b) => a + b, 0);
    $('fxmInfo').textContent = `${out.N}×${out.N} · ${out.frames.length}프레임 · ${Math.round(out.fps * 10) / 10}fps · ${ms}ms · ${out.loop ? '반복' : '한 번'} · 임팩트 ${out.impact}`;
  }

  // ---------- editor ↔ state ----------
  function loadRecipe(recipe, name) {
    E.recipe = clone(recipe);
    E.name = name || recipe.name || '이펙트';
    E.impactFrame = -1; E.loop = null; E.slash = {};
    if (recipe.game?.blend && BLENDS[recipe.game.blend]) E.blend = recipe.game.blend;
    syncInputs();
    rerender();
  }

  function syncInputs() {
    $('fxmName').value = E.name;
    $('fxmJson').value = JSON.stringify(E.recipe, null, 1);
    for (const b of $('fxmSizes').children) b.classList.toggle('on', +b.dataset.size === E.size);
    $('fxmHue').value = E.hue; $('fxmHueV').value = E.hue;
    $('fxmSpeed').value = E.speed; $('fxmSpeedV').value = E.speed;
    $('fxmBlend').value = E.blend;
    $('fxmImpact').value = E.impactFrame;
    $('fxmHold').value = E.impactHold;
    $('fxmLoop').value = E.loop === null ? '' : String(E.loop);
    const arc = PXF_SLASH.hasArc(E.recipe);
    $('fxmSlash').hidden = !arc;
    if (arc) {
      const s = E.slash;
      $('fxmShape').value = s.shape || 'original';
      $('fxmTheme').value = s.theme || '';
      for (const [k, d] of Object.entries(SLASH_DEF)) { $('fxmS_' + k).value = s[k] ?? d; $('fxmS_' + k + 'V').value = s[k] ?? d; }
    }
  }

  const SLASH_DEF = { angle: 0, curve: 1, radius: 1, thick: 1, fade: 1 };

  // ---------- gallery ----------
  function gallerySources() {
    const src = [];
    for (const k of PXF_SLASH.RECIPE_ORDER) src.push({ label: PXF_SLASH.RECIPE_LABELS[k], get: () => PXF_SLASH.recipe(k) });
    for (const g of Object.values(PXF_STARTERS)) src.push({ label: g.name, get: () => clone(g) });
    return src;
  }

  function buildGallery() {
    const grid = $('fxmGallery'), thumbs = [];
    grid.innerHTML = '';
    for (const s of gallerySources()) {
      const d = document.createElement('div'), c = document.createElement('canvas'), t = document.createElement('div');
      d.className = 'galcard'; t.textContent = s.label; c.width = c.height = 48;
      try { thumbs.push({ c, frames: PXF.render(s.get(), { scale: 0.75 }).frames }); } catch { t.textContent += ' (오류)'; }
      d.onclick = () => loadRecipe(s.get(), s.label);
      d.append(c, t);
      grid.append(d);
    }
    let f = 0;
    clearInterval(galTimer);
    galTimer = setInterval(() => {
      if ($('fxMode').hidden) return;
      f++;
      for (const t of thumbs) {
        const g = t.c.getContext('2d'), fr = t.frames[f % (t.frames.length + 4)];
        g.imageSmoothingEnabled = false;
        g.fillStyle = '#23262e'; g.fillRect(0, 0, 48, 48);
        if (fr) g.drawImage(fr, 0, 0, 48, 48);
      }
    }, 70);
  }

  // ---------- export ----------
  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  /** One row of N×N cells. */
  function sheetOf(r) {
    const c = document.createElement('canvas');
    c.width = r.N * r.frames.length; c.height = r.N;
    const g = c.getContext('2d');
    r.frames.forEach((fr, i) => g.drawImage(fr, i * r.N, 0));
    return c;
  }

  /** Meta JSON for a game's VFX system (Phaser: load.spritesheet(key, image, { frameWidth, frameHeight })). */
  function metaOf(e, r, file) {
    const ms = r.durations.reduce((a, b) => a + b, 0);
    return {
      name: e.name, image: `${file}.png`,
      frameWidth: r.N, frameHeight: r.N, frameCount: r.frames.length, columns: r.frames.length, rows: 1,
      fps: Math.round(r.fps * 100) / 100, durations: r.durations, durationMs: ms,
      loop: !!r.loop, impactFrame: r.impact, impactMs: r.durations.slice(0, r.impact).reduce((a, b) => a + b, 0),
      blend: e.blend, pivot: { x: r.N / 2, y: r.N / 2 },
      frames: r.frames.map((_, i) => ({ index: i, x: i * r.N, y: 0, w: r.N, h: r.N, duration: r.durations[i] })),
      source: { format: 'pxf.graph@1', recipe: graphOf(e), size: e.size, hue: e.hue, speed: e.speed, impactHold: e.impactHold },
    };
  }

  const pngBytes = c => new Promise(res => c.toBlob(async b => res(new Uint8Array(await b.arrayBuffer())), 'image/png'));
  const utf8 = s => new TextEncoder().encode(s);

  async function exportOne() {
    if (!out) return;
    const file = safeName(E.name);
    const sheet = sheetOf(out);
    download(new Blob([await pngBytes(sheet)], { type: 'image/png' }), `${file}.png`);
    download(new Blob([JSON.stringify(metaOf(E, out, file), null, 2)], { type: 'application/json' }), `${file}.json`);
    status(`내보냈어요: ${file}.png + ${file}.json`);
  }

  /** Every checked effect of the list (all if none checked): <name>.png + <name>.json each, and effects.json. */
  async function exportBatch() {
    const pick = list.filter(x => x.on);
    const items = pick.length ? pick : list;
    if (!items.length) return status('목록이 비어 있어요. "목록에 추가"로 이펙트를 담으세요.');
    const files = [], index = [], used = new Set();
    for (const e of items) {
      let r;
      try { r = renderFx(e); } catch (err) { status(`${e.name}: ${err.message || err}`); return; }
      let file = safeName(e.name), n = 2;
      while (used.has(file)) file = `${safeName(e.name)}_${n++}`;
      used.add(file);
      const meta = metaOf(e, r, file);
      files.push({ name: `${file}.png`, data: await pngBytes(sheetOf(r)) }, { name: `${file}.json`, data: utf8(JSON.stringify(meta, null, 2)) });
      const { source, frames, ...short } = meta;
      index.push({ key: file, ...short, meta: `${file}.json` });
    }
    files.push({ name: 'effects.json', data: utf8(JSON.stringify({ effects: index }, null, 2)) });
    const zipName = `${safeName($('name')?.value || 'effects')}_effects.zip`;
    download(new Blob([zip(files)], { type: 'application/zip' }), zipName);
    status(`${items.length}개 이펙트를 ${zipName}로 내보냈어요 (시트 PNG + 메타 JSON + effects.json)`);
  }

  // minimal .zip writer (stored, no compression)
  const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc32 = d => { let c = 0xffffffff; for (let i = 0; i < d.length; i++) c = CRC[(c ^ d[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  function zip(files) {
    const parts = [], central = [];
    let off = 0;
    const le = (n, b) => { const a = []; for (let i = 0; i < b; i++) a.push((n >>> (8 * i)) & 255); return a; };
    for (const f of files) {
      const name = utf8(f.name), crc = crc32(f.data), sz = f.data.length;
      const head = [...le(0x04034b50, 4), ...le(20, 2), ...le(0x0800, 2), ...le(0, 2), ...le(0, 2), ...le(0x21, 2), ...le(crc, 4), ...le(sz, 4), ...le(sz, 4), ...le(name.length, 2), ...le(0, 2)];
      parts.push(new Uint8Array(head), name, f.data);
      central.push(new Uint8Array([...le(0x02014b50, 4), ...le(20, 2), ...le(20, 2), ...le(0x0800, 2), ...le(0, 2), ...le(0, 2), ...le(0x21, 2), ...le(crc, 4), ...le(sz, 4), ...le(sz, 4),
        ...le(name.length, 2), ...le(0, 2), ...le(0, 2), ...le(0, 2), ...le(0, 2), ...le(0, 4), ...le(off, 4)]), name);
      off += head.length + name.length + sz;
    }
    const cdSize = central.reduce((a, p) => a + p.length, 0);
    const end = new Uint8Array([...le(0x06054b50, 4), ...le(0, 2), ...le(0, 2), ...le(files.length, 2), ...le(files.length, 2), ...le(cdSize, 4), ...le(off, 4), ...le(0, 2)]);
    return new Blob([...parts, ...central, end]);
  }

  // ---------- 내 이펙트 (batch list) ----------
  const snapshot = () => ({ name: E.name, recipe: clone(E.recipe), size: E.size, hue: E.hue, speed: E.speed, blend: E.blend,
    impactFrame: E.impactFrame, impactHold: E.impactHold, loop: E.loop, slash: { ...E.slash }, on: true });

  function saveList() { try { localStorage.setItem(LS_KEY, JSON.stringify(list)); } catch { /* storage off: the list lives for this visit */ } }
  function loadList() { try { list = JSON.parse(localStorage.getItem(LS_KEY) || '[]') || []; } catch { list = []; } }

  function buildList() {
    const el = $('fxmList');
    el.innerHTML = '';
    if (!list.length) { el.innerHTML = '<p class="hint">아직 없어요. 만든 이펙트를 "목록에 추가"로 담아 두면 한꺼번에 내보낼 수 있어요.</p>'; return; }
    list.forEach((x, i) => {
      const r = document.createElement('div');
      r.className = 'fxrow';
      r.innerHTML = `<label class="chk"><input type="checkbox" ${x.on ? 'checked' : ''}> ${x.name} <span class="dim">${x.size}px · ${x.blend}</span></label><span><button class="sm" title="불러와서 고치기">열기</button> <button class="sm" title="목록에서 빼기">✕</button></span>`;
      const [chk] = r.getElementsByTagName('input'), [open, del] = r.getElementsByTagName('button');
      chk.onchange = () => { x.on = chk.checked; saveList(); };
      open.onclick = () => { Object.assign(E, clone(x)); delete E.on; syncInputs(); rerender(); status(`"${x.name}"을(를) 불러왔어요. 고친 뒤 다시 "목록에 추가"하면 같은 이름이 바뀝니다.`); };
      del.onclick = () => { list.splice(i, 1); saveList(); buildList(); };
      el.append(r);
    });
  }

  function addToList() {
    const s = snapshot(), i = list.findIndex(x => x.name === s.name);
    if (i >= 0) list[i] = s; else list.push(s);
    saveList(); buildList();
    status(i >= 0 ? `"${s.name}"을(를) 바꿨어요` : `"${s.name}"을(를) 목록에 담았어요 (${list.length}개)`);
  }

  const status = msg => { const s = $('status'); if (s) s.textContent = msg; };

  // ---------- mode switch ----------
  function setMode(on) {
    $('fxMode').hidden = !on;
    $('body').hidden = on;
    $('btnFxMode').classList.toggle('on', on);
    try { localStorage.setItem('sprite-aligner.mode', on ? 'fx' : 'char'); } catch { /* ignore */ }
    if (on) { if (!galTimer) buildGallery(); if (!out) rerender(); else play(); status('이펙트만: 캐릭터 없이 이펙트를 만들고 시트 + 메타 JSON으로 내보냅니다.'); }
    else clearTimeout(timer);
  }

  const syncPlay = () => { $('fxmPlay').textContent = playing ? '⏸ 정지' : '▶ 재생'; };

  function init() {
    const sizes = $('fxmSizes');
    for (const n of SIZES) {
      const b = document.createElement('button');
      b.className = 'sm'; b.textContent = n; b.dataset.size = n; b.title = `${n}×${n} 캔버스 (레시피는 비율을 지켜 이 크기로 그림)`;
      b.onclick = () => { E.size = n; syncInputs(); rerender(); };
      sizes.append(b);
    }
    for (const [k, label] of Object.entries(PXF_SLASH.SHAPES)) $('fxmShape').append(new Option(label, k));
    $('fxmTheme').append(new Option('레시피 그대로', ''));
    for (const [k, t] of Object.entries(PXF_SLASH.THEMES)) $('fxmTheme').append(new Option(t.label, k));

    const num = (id, key, after) => {
      const r = $(id), v = $(id + 'V');
      const set = x => { E[key] = +x; r.value = x; if (v) v.value = x; after && after(); rerender(); };
      r.oninput = () => set(r.value);
      if (v) v.onchange = () => set(v.value);
    };
    num('fxmHue', 'hue'); num('fxmSpeed', 'speed');
    $('fxmImpact').onchange = () => { E.impactFrame = Math.round(+$('fxmImpact').value); rerender(); };
    $('fxmHold').onchange = () => { E.impactHold = Math.max(0, Math.round(+$('fxmHold').value)); rerender(); };
    $('fxmBlend').onchange = () => { E.blend = $('fxmBlend').value; draw(); };
    $('fxmLoop').onchange = () => { const v = $('fxmLoop').value; E.loop = v === '' ? null : v === 'true'; rerender(); };
    $('fxmName').oninput = () => { E.name = $('fxmName').value; };
    $('fxmShape').onchange = () => { E.slash = { ...E.slash, shape: $('fxmShape').value }; rerender(); };
    $('fxmTheme').onchange = () => { const t = $('fxmTheme').value; E.slash = { ...E.slash }; if (t) E.slash.theme = t; else delete E.slash.theme; rerender(); };
    for (const k of Object.keys(SLASH_DEF)) {
      const r = $('fxmS_' + k), v = $('fxmS_' + k + 'V');
      const set = x => { E.slash = { ...E.slash, [k]: +x }; r.value = x; v.value = x; rerender(); };
      r.oninput = () => set(r.value); v.onchange = () => set(v.value);
    }
    $('fxmSlashReset').onclick = () => { E.slash = {}; syncInputs(); rerender(); };
    $('fxmJson').oninput = () => {
      try { E.recipe = JSON.parse($('fxmJson').value); $('fxmErr').textContent = ''; $('fxmSlash').hidden = !PXF_SLASH.hasArc(E.recipe); rerender(); }
      catch (err) { $('fxmErr').textContent = 'JSON 오류: ' + err.message; }
    };
    $('fxmFile').onchange = async ev => {
      const f = ev.target.files[0];
      ev.target.value = '';
      if (!f) return;
      try { const g = JSON.parse(await f.text()); loadRecipe(g, g.name || f.name.replace(/\.(pxf\.)?json$/i, '')); }
      catch (err) { $('fxmErr').textContent = '레시피를 읽지 못했어요: ' + err.message; }
    };
    $('fxmSaveRecipe').onclick = () => download(new Blob([JSON.stringify(graphOf(E), null, 2)], { type: 'application/json' }), `${safeName(E.name)}.pxf.json`);
    $('fxmPlay').onclick = () => { playing = !playing; syncPlay(); play(); };
    $('fxmPrev').onclick = () => { if (!out) return; playing = false; syncPlay(); cur = (cur + out.frames.length - 1) % out.frames.length; draw(); };
    $('fxmNext').onclick = () => { if (!out) return; playing = false; syncPlay(); cur = (cur + 1) % out.frames.length; draw(); };
    for (const id of ['fxmTile', 'fxmScale', 'fxmZoom']) $(id).oninput = draw;
    $('fxmBgFile').onchange = ev => {
      const f = ev.target.files[0];
      ev.target.value = '';
      if (!f) return;
      const img = new Image();
      img.onload = () => { bgImg = img; draw(); };
      img.src = URL.createObjectURL(f);
    };
    $('fxmBgClear').onclick = () => { bgImg = null; draw(); };
    $('fxmExport').onclick = exportOne;
    $('fxmAdd').onclick = addToList;
    $('fxmBatch').onclick = exportBatch;
    $('fxmAll').onclick = () => { const on = !list.every(x => x.on); list.forEach(x => (x.on = on)); saveList(); buildList(); };
    $('btnFxMode').onclick = () => setMode($('fxMode').hidden);

    loadList(); buildList(); syncInputs(); syncPlay();
    let mode = 'char';
    try { mode = localStorage.getItem('sprite-aligner.mode') || 'char'; } catch { /* ignore */ }
    if (mode === 'fx' || location.hash === '#fx') setMode(true);
  }

  // test hooks (no UI): render / meta / zip of the current effect
  return { init, renderFx, metaOf, zip, crc32, state: E, setMode, exportBatch, addToList, list: () => list };
})();
FXMODE.init();
