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
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 16).map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(argv.length ? 0 : 1);
}
const flag = n => argv.includes(`--${n}`);
const opt = n => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const sheetArg = argv.find((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--') && !['--smooth', '--all-bg', '--fringe', '--no-loop', '--left'].includes(argv[i - 1])));
const specPath = opt('spec') && resolve(opt('spec'));
const spec = specPath ? JSON.parse(readFileSync(specPath, 'utf8')) : {};
const rel = p => resolve(specPath ? dirname(specPath) : process.cwd(), p);
const dataURL = (p, type = 'image/png') => `data:${type};base64,${readFileSync(rel(p)).toString('base64')}`;
const sheet = sheetArg ? resolve(sheetArg) : spec.image && !spec.image.startsWith('data:') ? rel(spec.image) : null;
const projectPath = spec.project && !spec.project.trim().startsWith('{') ? rel(spec.project) : null;
if (!sheet && !projectPath && !spec.project) { console.error('give a sheet, or --spec with "image" or "project"'); process.exit(1); }
if (sheet && !existsSync(sheet)) { console.error(`no such file: ${sheet}`); process.exit(1); }
const src0 = sheet || projectPath;
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
  console.log(JSON.stringify({ frames: r.frames, cell: r.cell, pivot: r.pivot, scale: r.scale, shrink: r.shrink, row: r.row, warnings: r.warnings, status: r.status, out, files: r.files.map(f => f.name), errors }, null, 2));
} finally {
  await browser.close();
}
