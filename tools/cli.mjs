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
//        [--key-tint N (also key background-hued specks)] [--remap '#src>#dst[,tol]' (repeatable: shading-preserving colour shift)]
//        [--video clip.mp4 [--loop-pick N (default 8)] [--loop-steps 2] [--pick-frames 0,2,5,…] [--keep-frames DIR]]
//             video input: frames via ffmpeg (PATH or FFMPEG), else decoded in Edge / Chrome; a seamless walk cycle is
//             found from the silhouettes and N evenly spaced frames are processed like a sheet row
//        [--spec job.json]   (any SpriteAligner.run option as JSON; its "image"/"project" may be file paths, as may
//                             effects[].sheet.png / .json and effects[].recipe; command-line flags override it)
//
// Playwright: `npm i -D playwright` here, or point PLAYWRIGHT_DIR at a folder whose node_modules has it.

import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname, basename, extname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
if (!argv.length || argv.includes('--help')) {
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 19).map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(argv.length ? 0 : 1);
}
const flag = n => argv.includes(`--${n}`);
const opt = n => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const videoArg = opt('video') && resolve(opt('video'));
const sheetArg = videoArg ? null : argv.find((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--') && !['--smooth', '--all-bg', '--fringe', '--no-loop', '--left'].includes(argv[i - 1])));
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
const num = n => (opt(n) !== undefined ? +opt(n) : undefined);

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
  remap: argv.flatMap((a, i) => (a === '--remap' ? [argv[i + 1]] : [])).map(r => { const [m, tol] = r.split(','); const [src, dst] = m.split('>'); return { src, dst, tol: tol ? +tol : 60 }; }),
  keyTint: num('key-tint'),
  row: num('row'), frameCount: num('frames'), targetHeight: num('target-height'), targetFrame: num('target-frame'),
};
if (!o.remap.length) o.remap = spec.remap;
for (const k of Object.keys(o)) if (o[k] === undefined && spec[k] !== undefined) o[k] = spec[k];
delete o.out;

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
  for (const f of r.files) writeFileSync(join(out, f.name), Buffer.from(f.base64, 'base64'));
  console.log(JSON.stringify({ frames: r.frames, cell: r.cell, pivot: r.pivot, scale: r.scale, shrink: r.shrink, row: r.row, video: videoVia && { via: videoVia, frames: o.videoFrames.length }, loop: r.loop, warnings: r.warnings, status: r.status, out, files: r.files.map(f => f.name), errors }, null, 2));
} finally {
  await browser.close();
}
