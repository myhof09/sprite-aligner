#!/usr/bin/env node
// Sprite Aligner from the command line: sheet + options -> project file + exports, no manual browser work.
// It runs the same index.html headless (Playwright Chromium) through window.SpriteAligner.run, so the results are
// exactly what the web tool makes, and the project opens in the web tool for hand fine-tuning.
//
//   node tools/cli.mjs <sheet.png> [--out DIR] [--name NAME] [--smooth] [--shrink N] [--pixel N] [--key #rrggbb]
//        [--tol N] [--all-bg] [--fringe] [--despill 0..1] [--pad N] [--align auto|feet|torso|ground]
//        [--durations 160,80,...] [--impact N|none] [--no-loop] [--left] [--outputs project,all,frames,timing]
//        [--row N (1 = top row of a multi-row sheet)] [--frames N (expected count)]
//        [--target-height PX [--target-frame K (1 = first)]]   (smooth mode: one scale so frame K is PX tall)
//        [--edge-neutral (soft-edge pixels pushed to the anti-key colour, e.g. green, become grey)]
//        [--key-tint N (also key background-hued specks)] [--remap '#src>#dst[,tol[,x0,y0,x1,y1]]' (repeatable: shading-preserving colour shift)]
//        [--video clip.mp4 [--loop-pick N (default 8)] [--loop-steps 2] [--pick-frames 0,2,5,…] [--keep-frames DIR]]
//             video input: frames via ffmpeg (PATH or FFMPEG), else decoded in Edge / Chrome; a seamless walk cycle is
//             found from the silhouettes and N evenly spaced frames are processed like a sheet row
//        [--anchor-out name=PART --anchor-color #rrggbb [--anchor-box x,y,w,h (cell px)] [--anchor-tol N (40)]
//             [--anchor-point bbox|mean|extreme|lowest|blade (bbox)]]   (repeatable group: per-frame part anchor -> timing frames[].PART)
//        [--extract name=PIECE --extract-frame N (0-based) [--extract-at x,y | --extract-box x,y,w,h] [--extract-erase 2,3]
//             [--extract-file path/without/ext] [--extract-pivot ground|center] [--extract-discard (only erase it)]]
//             (repeatable: a piece -> its own PNG + pivot JSON, or just erased)
//        [--spec job.json]   (any SpriteAligner.run option as JSON; its "image"/"project" may be file paths, as may
//                             effects[].sheet.png / .json and effects[].recipe; command-line flags override it)
//
//   node tools/cli.mjs fx <recipe.safx.json>... [--out DIR] [--size PX] [--hue DEG] [--speed X] [--blend add|normal]
//        [--impact-hold MS]   sa-fx recipes -> sprite sheet + meta JSON (the "이펙트만" export, headless); a drawing that
//        touches the canvas edge is re-rendered on a bigger canvas at the same pixel size (never clipped)
//
//   node tools/cli.mjs measure <image.png> --ref <master.png> [--box x,y,w,h] [--ref-box x,y,w,h] [--colors 14]
//        [--min-share 2] [--min-diff 12]   colour clusters vs the master -> suggested --remap pairs (skin / browns / gold
//        are listed but never suggested; gold parts need a hand rule with a box)
//
// Playwright: `npm i -D playwright` here, or point PLAYWRIGHT_DIR at a folder whose node_modules has it.

import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname, basename, extname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
if (!argv.length || argv.includes('--help')) {
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1).filter((l, i, a) => a.slice(0, i + 1).every(x => x.startsWith('//'))).map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(argv.length ? 0 : 1);
}
const flag = n => argv.includes(`--${n}`);
const nums = v => v.split(',').map(Number);
const num = n => (opt(n) !== undefined ? +opt(n) : undefined);
const opt = n => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const videoArg = opt('video') && resolve(opt('video'));
const sheetArg = videoArg ? null : argv.find((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--') && !['--smooth', '--all-bg', '--fringe', '--no-loop', '--left', '--edge-neutral', '--extract-discard'].includes(argv[i - 1])));
if (argv[0] === 'measure') { await measure(); process.exit(0); }
if (argv[0] === 'fx') { await fxCmd(); process.exit(0); }
const specPath = opt('spec') && resolve(opt('spec'));
const spec = specPath ? JSON.parse(readFileSync(specPath, 'utf8')) : {};
const rel = p => resolve(specPath ? dirname(specPath) : process.cwd(), p);
const dataURL = (p, type = 'image/png') => `data:${type};base64,${readFileSync(rel(p)).toString('base64')}`;
const sheet = sheetArg ? resolve(sheetArg) : spec.image && !spec.image.startsWith('data:') ? rel(spec.image) : null;
const projectPath = spec.project && !spec.project.trim().startsWith('{') ? rel(spec.project) : null;
if (!sheet && !projectPath && !spec.project && !videoArg) { console.error('give a sheet, a --video, or --spec with "image" or "project"'); process.exit(1); }
if (sheet && !existsSync(sheet)) { console.error(`no such file: ${sheet}`); process.exit(1); }
const src0 = sheet || projectPath || videoArg;
const name = opt('name') || spec.name || basename(src0, extname(src0)).replace(/\.sprite-aligner$/, '');
const out = resolve(opt('out') || (spec.out ? rel(spec.out) : dirname(src0)));

for (const e of spec.effects || []) {
  if (typeof e.recipe === 'string') e.recipe = JSON.parse(readFileSync(rel(e.recipe), 'utf8'));
  if (e.sheet && e.sheet.png && !e.sheet.png.startsWith('data:')) e.sheet.png = dataURL(e.sheet.png);
  if (e.sheet && typeof e.sheet.json === 'string') e.sheet.json = JSON.parse(readFileSync(rel(e.sheet.json), 'utf8'));
}
const o = {
  ...spec,
  ...(sheet ? { image: `data:image/png;base64,${readFileSync(sheet).toString('base64')}` } : {}),
  ...(projectPath ? { project: readFileSync(projectPath, 'utf8') } : {}),
  name,
  smooth: flag('smooth') || undefined, shrink: num('shrink'), pixel: num('pixel'), key: opt('key'), tol: num('tol'),
  keyEdge: flag('all-bg') ? false : undefined, fringe: flag('fringe') || undefined, despill: num('despill'), pad: num('pad'),
  alignBy: opt('align'), loop: flag('no-loop') ? false : undefined, exportLeft: flag('left') || undefined,
  durations: opt('durations') ? opt('durations').split(',').map(Number) : undefined,
  impact: opt('impact') === undefined ? undefined : opt('impact') === 'none' ? -1 : +opt('impact'),
  outputs: opt('outputs') ? opt('outputs').split(',') : undefined,
  remap: argv.flatMap((a, i) => (a === '--remap' ? [argv[i + 1]] : [])).map(r => { const [m, tol, ...box] = r.split(','); const [src, dst] = m.split('>'); return { src, dst, tol: tol ? +tol : 60, ...(box.length === 4 ? { box: box.map(Number) } : {}) }; }),
  keyTint: num('key-tint'), edgeNeutral: flag('edge-neutral') || undefined,
  row: num('row'), frameCount: num('frames'), targetHeight: num('target-height'), targetFrame: num('target-frame'),
  anchors: anchorArgs(),
  extract: extractArgs(),
};
if (!o.remap.length) o.remap = spec.remap;
if (!o.anchors.length) o.anchors = spec.anchors;
if (!o.extract.length) o.extract = spec.extract;
for (const k of Object.keys(o)) if (o[k] === undefined && spec[k] !== undefined) o[k] = spec[k];
delete o.out;

/** --anchor-out name=PART starts an anchor; the --anchor-* flags after it belong to it. */
function anchorArgs() {
  const list = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = argv[i + 1], cur = list[list.length - 1];
    if (a === '--anchor-out') list.push({ name: v.replace(/^name=/, ''), point: 'bbox' });
    else if (a.startsWith('--anchor-') && !cur) { console.error(`${a} needs a --anchor-out before it`); process.exit(1); }
    else if (a === '--anchor-color') cur.color = v;
    else if (a === '--anchor-box') cur.box = nums(v);
    else if (a === '--anchor-tol') cur.tol = +v;
    else if (a === '--anchor-point') cur.point = v;
  }
  for (const a of list) if (!a.color && a.point !== 'blade') { console.error(`anchor ${a.name}: --anchor-color is missing`); process.exit(1); }
  return list;
}

/** --extract name=PIECE starts a piece; the --extract-* flags after it belong to it. */
function extractArgs() {
  const list = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = argv[i + 1], cur = list[list.length - 1];
    if (a === '--extract') list.push({ name: v.replace(/^name=/, '') });
    else if (a.startsWith('--extract-') && !cur) { console.error(`${a} needs a --extract before it`); process.exit(1); }
    else if (a === '--extract-frame') cur.frame = +v;
    else if (a === '--extract-at') cur.at = nums(v);
    else if (a === '--extract-box') cur.box = nums(v);
    else if (a === '--extract-erase') cur.erase = nums(v);
    else if (a === '--extract-file') cur.file = v;
    else if (a === '--extract-pivot') cur.pivot = v;
    else if (a === '--extract-discard') cur.discard = true;
  }
  return list;
}

/** fx <recipe>...: render sa-fx recipes to sheet PNG + meta JSON. */
async function fxCmd() {
  const recipes = [];
  for (let i = 1; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { i++; continue; }
    recipes.push(resolve(argv[i]));
  }
  if (!recipes.length) { console.error('fx <recipe.safx.json>... [--out DIR]'); process.exit(1); }
  const outDir = resolve(opt('out') || '.');
  mkdirSync(outDir, { recursive: true });
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(pathToFileURL(join(ROOT, 'index.html')).href);
    await page.waitForFunction(() => window.SpriteAligner && typeof FXMODE !== 'undefined');
    for (const file of recipes) {
      const recipe = JSON.parse(readFileSync(file, 'utf8'));
      const name = basename(file).replace(/\.safx\.json$|\.json$/, '');
      const o = { name, recipe, size: num('size'), hue: num('hue') || 0, speed: num('speed') || 1, blend: opt('blend'),
        hold: num('impact-hold') || 0 };
      const r = await page.evaluate(async o => {
        const touches = c => {
          const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data, w = c.width, h = c.height;
          for (let x = 0; x < w; x++) if (d[(x) * 4 + 3] || d[((h - 1) * w + x) * 4 + 3]) return true;
          for (let y = 0; y < h; y++) if (d[(y * w) * 4 + 3] || d[(y * w + w - 1) * 4 + 3]) return true;
          return false;
        };
        let recipe = o.recipe, grew = 0, out, e;
        for (;;) {
          const size = o.size ? Math.round(o.size * (recipe.size || 64) / (o.recipe.size || 64)) : (recipe.size || 64);
          e = { name: o.name, recipe, size, hue: o.hue, speed: o.speed, blend: o.blend || recipe.blend || 'add',
            impactFrame: -1, impactHold: o.hold, loop: null, slash: {} };
          out = FXMODE.renderFx(e);
          if (!out.frames.some(touches) || grew >= 4) break;
          recipe = { ...recipe, size: Math.round((recipe.size || 64) * 1.5) };   // same pixel sizes, bigger canvas
          grew++;
        }
        const c = document.createElement('canvas');
        c.width = out.N * out.frames.length; c.height = out.N;
        out.frames.forEach((fr, i) => c.getContext('2d').drawImage(fr, i * out.N, 0));
        const meta = FXMODE.metaOf(e, out, o.name);
        return { png: c.toDataURL('image/png').split(',')[1], meta, grew, clipped: out.frames.some(touches) };
      }, o);
      writeFileSync(join(outDir, `${name}.png`), Buffer.from(r.png, 'base64'));
      writeFileSync(join(outDir, `${name}.json`), JSON.stringify(r.meta, null, 1));
      console.log(`${name}: ${r.meta.frameCount} frames ${r.meta.frameWidth}px, impact ${r.meta.impactFrame}, ${r.meta.blend}` +
        (r.grew ? `, canvas grown x${r.grew}` : '') + (r.clipped ? ' (STILL CLIPPED)' : ''));
    }
  } finally { await browser.close(); }
}

/** measure <image> --ref <master>: colour clusters vs the master, suggested --remap pairs. */
async function measure() {
  const img = argv[1], ref = opt('ref');
  if (!img || !ref) { console.error('measure <image.png> --ref <master.png> [--box x,y,w,h] [--ref-box x,y,w,h]'); process.exit(1); }
  const url = p => `data:image/png;base64,${readFileSync(resolve(p)).toString('base64')}`;
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(pathToFileURL(join(ROOT, 'index.html')).href);
    await page.waitForFunction(() => window.SpriteAligner);
    const r = await page.evaluate(o => window.SpriteAligner.measure(o), {
      image: url(img), ref: url(ref), box: opt('box') && nums(opt('box')), refBox: opt('ref-box') && nums(opt('ref-box')),
      colors: num('colors'), minShare: num('min-share'), minDiff: num('min-diff') });
    console.log('image     share  master   share  diff  tol  verdict');
    for (const c of r.clusters) console.log(`${c.src}  ${String(c.share).padStart(5)}%  ${c.ref}  ${String(c.refShare).padStart(5)}%  ${String(c.diff).padStart(4)}  ${String(c.tol).padStart(3)}  ${c.verdict}`);
    console.log(r.remap.length ? `\nsuggested:\n${r.remap.join('\n')}` : '\nno remap needed');
  } finally { await browser.close(); }
}

function loadPlaywright() {
  const bases = [process.env.PLAYWRIGHT_DIR, ROOT, process.cwd()].filter(Boolean);
  for (const b of bases) {
    try { return createRequire(join(resolve(b), 'package.json'))('playwright'); } catch { /* next */ }
  }
  console.error('Playwright not found: run `npm i -D playwright` in the sprite-aligner folder, or set PLAYWRIGHT_DIR.');
  process.exit(1);
}

const { chromium } = loadPlaywright();

/** Video -> PNG data URLs, one per frame, at the video's own size. ffmpeg first, else a browser that plays H.264. */
async function videoFrames(file) {
  const { spawnSync } = await import('node:child_process');
  const { mkdtempSync, readdirSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const ff = process.env.FFMPEG || 'ffmpeg';
  const dir = mkdtempSync(join(tmpdir(), 'sa-video-'));
  const r = spawnSync(ff, ['-v', 'error', '-i', file, '-vsync', '0', join(dir, 'f_%05d.png')], { encoding: 'utf8' });
  if (!r.error && r.status === 0) {
    const files = readdirSync(dir).filter(f => f.endsWith('.png')).sort();
    const urls = files.map(f => `data:image/png;base64,${readFileSync(join(dir, f)).toString('base64')}`);
    rmSync(dir, { recursive: true, force: true });
    return { urls, via: 'ffmpeg' };
  }
  rmSync(dir, { recursive: true, force: true });
  for (const channel of ['msedge', 'chrome']) {
    let b;
    try { b = await chromium.launch({ channel }); } catch { continue; }
    try {
      const p = await b.newPage();
      await p.goto('about:blank');
      const urls = await p.evaluate(async b64 => {
        const bytes = Uint8Array.from(atob(b64), ch => ch.charCodeAt(0));
        const v = document.createElement('video');
        v.muted = true; v.src = URL.createObjectURL(new Blob([bytes], { type: 'video/mp4' })); v.playbackRate = 0.25;
        await new Promise((ok, no) => { v.onloadeddata = ok; v.onerror = () => no(new Error('cannot decode the video')); });
        const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight;
        const g = c.getContext('2d'), out = [], seen = new Set();
        await new Promise(done => {
          const grab = (now, meta) => {
            if (!seen.has(meta.mediaTime)) { seen.add(meta.mediaTime); g.drawImage(v, 0, 0); out.push(c.toDataURL('image/png')); }
            if (!v.ended) v.requestVideoFrameCallback(grab);
          };
          v.requestVideoFrameCallback(grab);
          v.onended = () => setTimeout(done, 200);
          v.play();
        });
        return out;
      }, readFileSync(file).toString('base64'));
      return { urls, via: channel };
    } catch (e) { console.error(`${channel}: ${e.message}`); } finally { await b.close(); }
  }
  console.error('cannot read the video: install ffmpeg (or set FFMPEG), or Microsoft Edge / Google Chrome');
  process.exit(1);
}
let videoVia = null;
if (videoArg) {
  const v = await videoFrames(videoArg);
  videoVia = v.via;
  o.videoFrames = v.urls;
  if (opt('pick-frames')) o.pickFrames = opt('pick-frames').split(',').map(Number);
  else o.loopPick = { pick: num('loop-pick') || 8, steps: num('loop-steps') || 2 };
  if (opt('keep-frames')) {
    const kd = resolve(opt('keep-frames')); mkdirSync(kd, { recursive: true });
    v.urls.forEach((u, i) => writeFileSync(join(kd, `f_${String(i).padStart(3, '0')}.png`), Buffer.from(u.split(',')[1], 'base64')));
  }
}
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(pathToFileURL(join(ROOT, 'index.html')).href);
  await page.waitForFunction(() => window.SpriteAligner);
  const r = await page.evaluate(opts => window.SpriteAligner.run(opts), o);
  mkdirSync(out, { recursive: true });
  for (const f of r.files) { mkdirSync(dirname(join(out, f.name)), { recursive: true }); writeFileSync(join(out, f.name), Buffer.from(f.base64, 'base64')); }
  console.log(JSON.stringify({ frames: r.frames, cell: r.cell, pivot: r.pivot, scale: r.scale, shrink: r.shrink, row: r.row, video: videoVia && { via: videoVia, frames: o.videoFrames.length }, loop: r.loop, warnings: r.warnings, status: r.status, out, files: r.files.map(f => f.name), errors }, null, 2));
} finally {
  await browser.close();
}
