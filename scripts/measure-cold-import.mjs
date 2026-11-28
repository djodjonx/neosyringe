#!/usr/bin/env node
// scripts/measure-cold-import.mjs
// Cold import of the published plugin in a fresh node process, and the weight of the published UI and plugin files.
// Measures one checkout that is already built:
//   node scripts/measure-cold-import.mjs [--root <checkout>] [--runs 15] [--json] [--allow-stale]
// Scenario A: `await import('<root>/packages/unplugin/dist/index.mjs')` alone (devtools never asked for).
// Scenario B: A, then `configureServer` of a plugin made with `devtools: true` on a fake server, awaited
//   (the first access to the devtools; for a build where the hook is synchronous this costs the plugin creation only).
// Each run is one new process: `performance.now()` around the import, RSS after it, medians over `--runs` runs.
// A separate, untimed run records which files of packages/ the process loaded and whether one of them holds the
// HTML renderer (`buildStandaloneHtml`). The size table lists every dist file of the UI and the plugin, raw and
// gzip level 9, and says `absent` for a file group the checkout does not have (a base without the light entry).
// It does not build. A dist older than its sources is refused (exit 2), unless `--allow-stale` is passed.
// It does not measure an application: the audit sheet limits it to the import of the tools.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { cpus, loadavg, tmpdir, type as osType, release as osRelease, platform as osPlatform } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

const args = process.argv.slice(2);
const flag = (name) => args.indexOf(name);
const valueOf = (name, fallback) => (flag(name) >= 0 ? args[flag(name) + 1] : fallback);
const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(valueOf('--root', here));
const runs = Number(valueOf('--runs', '15'));
const asJson = flag('--json') >= 0;
const allowStale = flag('--allow-stale') >= 0;
const GZIP_LEVEL = 9;

if (!Number.isInteger(runs) || runs < 1) {
  console.error(`--runs must be a positive integer, got ${valueOf('--runs', '15')}`);
  process.exit(1);
}

const uiDist = path.join(root, 'packages/ui/dist');
const pluginDist = path.join(root, 'packages/unplugin/dist');
const pluginEntry = path.join(pluginDist, 'index.mjs');
if (!existsSync(pluginEntry)) {
  console.error(`missing ${pluginEntry}: build ${root} first`);
  process.exit(1);
}

function newestMtime(dir) {
  let newest = 0;
  const pending = [dir];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || !existsSync(current)) continue;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(full);
      else if (entry.isFile()) newest = Math.max(newest, statSync(full).mtimeMs);
    }
  }
  return newest;
}

/** A dist older than the sources next to it measures a build that is not the checkout. */
function staleDists() {
  const stale = [];
  for (const name of ['ui', 'unplugin']) {
    const entry = path.join(root, 'packages', name, 'dist/index.mjs');
    const source = newestMtime(path.join(root, 'packages', name, 'src'));
    if (!existsSync(entry) || statSync(entry).mtimeMs < source) stale.push(path.relative(root, entry));
  }
  return stale;
}

const stale = staleDists();
if (stale.length > 0 && !allowStale) {
  console.error(`stale dist, nothing measured: ${stale.join(', ')} older than its src. Run pnpm build in ${root}.`);
  process.exit(2);
}

function timedChild(scenario) {
  const code = scenario === 'A'
    ? `
const t0 = performance.now();
await import(process.env.M_ENTRY);
const importMs = performance.now() - t0;
console.log(JSON.stringify({ importMs, configureMs: 0, installed: 0, rssMb: process.memoryUsage().rss / 1048576 }));
`
    : `
const t0 = performance.now();
const { neoSyringePlugin } = await import(process.env.M_ENTRY);
const t1 = performance.now();
const plugin = neoSyringePlugin.vite({ devtools: true });
const hook = plugin.configureServer ?? plugin.vite?.configureServer;
const used = [];
const log = console.log;
console.log = () => {};
await hook.call(plugin, { middlewares: { use: (fn) => used.push(fn) } });
console.log = log;
const t2 = performance.now();
console.log(JSON.stringify({ importMs: t1 - t0, configureMs: t2 - t1, installed: used.length, rssMb: process.memoryUsage().rss / 1048576 }));
`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'development', M_ENTRY: pathToFileURL(pluginEntry).href },
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`scenario ${scenario} child failed\n${result.stdout}\n${result.stderr}`);
  const lines = result.stdout.trim().split('\n');
  return JSON.parse(lines[lines.length - 1] ?? '{}');
}

function stats(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const at = (fraction) => sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))] ?? Number.NaN;
  return { median: at(0.5), min: sorted[0] ?? Number.NaN, p90: at(0.9) };
}

function measureScenario(scenario) {
  const samples = [];
  // One run that is not counted: the first process after a build reads the files from a cold disk cache.
  timedChild(scenario);
  for (let index = 0; index < runs; index += 1) samples.push(timedChild(scenario));
  return {
    runs,
    importMs: stats(samples.map((sample) => sample.importMs)),
    configureMs: stats(samples.map((sample) => sample.configureMs)),
    rssMb: stats(samples.map((sample) => sample.rssMb)),
    installed: samples.every((sample) => sample.installed === samples[0]?.installed) ? samples[0]?.installed : 'mixed',
  };
}

const HOOKS = `
import { appendFileSync } from 'node:fs';
let logFile;
export function initialize(data) { logFile = data.logFile; }
export async function load(url, context, nextLoad) {
  if (url.startsWith('file:')) appendFileSync(logFile, url + '\\n');
  return nextLoad(url, context);
}
`;

/** The files of packages/ the plugin import loads, by the ESM loader, and whether one holds the HTML renderer. */
function loadedFiles() {
  const dir = mkdtempSync(path.join(tmpdir(), 'neosyringe-cold-import-'));
  try {
    const logFile = path.join(dir, 'loaded.log');
    writeFileSync(logFile, '');
    writeFileSync(path.join(dir, 'hooks.mjs'), HOOKS);
    writeFileSync(path.join(dir, 'preload.mjs'), `
import { register } from 'node:module';
register(${JSON.stringify(pathToFileURL(path.join(dir, 'hooks.mjs')).href)}, { parentURL: import.meta.url, data: { logFile: ${JSON.stringify(logFile)} } });
`);
    const result = spawnSync(process.execPath, [
      '--import', pathToFileURL(path.join(dir, 'preload.mjs')).href,
      '--input-type=module', '-e', 'await import(process.env.M_ENTRY);',
    ], {
      encoding: 'utf8',
      env: { ...process.env, NODE_ENV: 'development', M_ENTRY: pathToFileURL(pluginEntry).href },
    });
    if (result.status !== 0) throw new Error(`loaded-files child failed\n${result.stdout}\n${result.stderr}`);
    const packages = path.join(root, 'packages') + path.sep;
    const files = [...new Set(readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((url) => fileURLToPath(url)))]
      .filter((file) => file.startsWith(packages) && !file.includes(`${path.sep}node_modules${path.sep}`));
    const rendererHolders = files.filter((file) => readFileSync(file, 'utf8').includes('buildStandaloneHtml'));
    return {
      count: files.length,
      bytes: files.reduce((sum, file) => sum + statSync(file).size, 0),
      files: files.map((file) => path.relative(root, file)).sort(),
      rendererHolders: rendererHolders.map((file) => path.relative(root, file)).sort(),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const GROUPS = [
  { label: 'ui index', dir: uiDist, match: /^index\.(mjs|cjs)$/ },
  { label: 'ui serialize', dir: uiDist, match: /^serialize\.(mjs|cjs)$/ },
  { label: 'ui declarations', dir: uiDist, match: /\.d\.(mts|cts)$/ },
  { label: 'plugin index', dir: pluginDist, match: /^index\.(mjs|cjs)$/ },
  { label: 'plugin devtools chunk', dir: pluginDist, match: /^devtools-.*\.(mjs|cjs)$/ },
  { label: 'plugin shared chunks', dir: pluginDist, match: /^buildEndUsages-.*\.(mjs|cjs)$/ },
  { label: 'plugin transformer', dir: pluginDist, match: /^transformer\.(mjs|cjs)$/ },
];

function sizes() {
  const rows = [];
  for (const group of GROUPS) {
    const names = existsSync(group.dir) ? readdirSync(group.dir).filter((name) => group.match.test(name)).sort() : [];
    if (names.length === 0) {
      rows.push({ group: group.label, file: 'absent', raw: null, gzip: null });
      continue;
    }
    for (const name of names) {
      const bytes = readFileSync(path.join(group.dir, name));
      rows.push({ group: group.label, file: path.relative(root, path.join(group.dir, name)), raw: bytes.length, gzip: gzipSync(bytes, { level: GZIP_LEVEL }).length });
    }
  }
  return rows;
}

const env = {
  node: process.version,
  os: `${osType()} ${osRelease()} ${osPlatform()}`,
  cpu: `${cpus()[0]?.model ?? 'unknown'} x${cpus().length}`,
  loadavgBefore: loadavg().map((value) => Number(value.toFixed(2))),
};

const report = {
  root,
  command: `node scripts/measure-cold-import.mjs --root ${root} --runs ${runs}`,
  env,
  staleDist: stale,
  loaded: loadedFiles(),
  scenarios: { A: measureScenario('A'), B: measureScenario('B') },
  sizes: sizes(),
};
report.env.loadavgAfter = loadavg().map((value) => Number(value.toFixed(2)));

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const ms = (value) => (Number.isFinite(value) ? value.toFixed(1) : 'n/a');
  console.log(`root ${report.root}`);
  console.log(`node ${env.node} | ${env.os} | ${env.cpu} | loadavg before ${env.loadavgBefore.join(' ')} after ${report.env.loadavgAfter.join(' ')}`);
  if (stale.length > 0) console.log(`WARNING stale dist (--allow-stale): ${stale.join(', ')}`);
  console.log(`loaded by the import: ${report.loaded.count} files, ${report.loaded.bytes} bytes; renderer in: ${report.loaded.rendererHolders.join(', ') || 'none'}`);
  for (const [name, scenario] of Object.entries(report.scenarios)) {
    console.log(`scenario ${name} (${scenario.runs} runs): import ms median ${ms(scenario.importMs.median)} min ${ms(scenario.importMs.min)} p90 ${ms(scenario.importMs.p90)} | configureServer ms median ${ms(scenario.configureMs.median)} | rss MB median ${ms(scenario.rssMb.median)} | middlewares installed ${scenario.installed}`);
  }
  for (const row of report.sizes) console.log(`${row.group.padEnd(24)} ${row.file.padEnd(52)} ${row.raw === null ? '' : `raw ${row.raw} gzip ${row.gzip}`}`);
}
