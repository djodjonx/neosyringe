#!/usr/bin/env node
// scripts/measure-chunk-split.mjs
// Initial and deferred chunk bytes of one code-split ESM bundle, built by the real plugin
// and esbuild (splitting, format esm, metafile). Four cells: open/closed x full/minimal,
// plus a static-import control. Raw bytes, minified bytes, gzip level 9 and Brotli quality 11
// of the minified text. Run from the repo root after a fresh `pnpm build`:
//   node scripts/measure-chunk-split.mjs [--json]
// --json prints one JSON object and nothing else (tests/e2e/chunk-split-measure.test.ts).
// esbuild only. Rollup is not used. scripts/ci/consumer-dist.mjs is a CI check, not this measure.
// The chunk bytes depend on the absolute build path: the file name is hashed into the container
// id and the generated class suffix (packages/core/src/analyzer/shared/HashUtils.ts:157-160,
// packages/core/src/generator/Generator.ts:150-154). Gzip bytes also depend on the Node zlib
// build. The build directory is stable per checkout.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { cpus, tmpdir, type as osType, release as osRelease, platform as osPlatform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const coreRequire = createRequire(resolve(root, 'packages/core/package.json'));
const unpluginRequire = createRequire(resolve(root, 'packages/unplugin/package.json'));
const ts = coreRequire('typescript');
const esbuild = unpluginRequire('esbuild');
const plugin = unpluginRequire('./dist/index.cjs');

const FIXTURE = resolve(root, 'tests/e2e/fixtures/chunk-split/app.ts');
const JSON_OUTPUT = process.argv.includes('--json');
const GZIP_LEVEL = 9;
const BROTLI_QUALITY = 11;
const HEAVY_METHODS = 500;
const SENTINEL = 'CHUNK_SPLIT_HEAVY';
const MARKER = 'CHUNK_SPLIT_CONTAINER';
const COMMAND = 'node scripts/measure-chunk-split.mjs --json';
// One directory per checkout: worktrees of the same user can run this script at the same time.
const BUILD_ROOT = join(tmpdir(), `chunk-split-${createHash('sha1').update(root).digest('hex').slice(0, 10)}`);

const SCENARIOS = [
  { id: 'open-full', mode: 'open', profile: 'full', staticImport: false },
  { id: 'open-minimal', mode: 'open', profile: 'minimal', staticImport: false },
  { id: 'closed-full', mode: 'closed', profile: 'full', staticImport: false },
  { id: 'closed-minimal', mode: 'closed', profile: 'minimal', staticImport: false },
  { id: 'control-static', mode: 'open', profile: 'full', staticImport: true },
];

const NAME_LINE = "  name: 'ChunkSplit',";
const DYNAMIC_FACTORY = [
  '      provider: async () => {',
  "        const { Heavy } = await import('./heavy');",
  '        return { tag: new Heavy().tag() };',
  '      },',
].join('\n');
const STATIC_FACTORY = '      provider: () => ({ tag: new Heavy().tag() }),';
const HEADER = "import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';";

/** gzip and Brotli byte counts of a text. Levels are fixed and reported. */
function compress(text) {
  const input = Buffer.from(text);
  return {
    gzip: gzipSync(input, { level: GZIP_LEVEL }).length,
    brotli: brotliCompressSync(input, { params: { [constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY } }).length,
  };
}

function compareText(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function readVersion(pkgPath) {
  return JSON.parse(readFileSync(pkgPath, 'utf8')).version;
}

function readEnv() {
  const cpu = cpus()[0]?.model ?? 'unknown';
  return {
    node: process.version,
    zlib: process.versions.zlib,
    os: `${osType()} ${osRelease()} ${osPlatform()}`,
    cpu: `${cpu} x${cpus().length}`,
    esbuild: esbuild.version,
    typescript: ts.version,
    neosyringe: readVersion(join(root, 'packages/neosyringe/package.json')),
  };
}

/** 500 methods, xorshift32 seed 0x2545f491, same shape as scripts/measure-t17-size.mjs:107-122. */
function heavySource() {
  let state = 0x2545f491;
  const next = () => {
    state = (state ^ (state << 13)) >>> 0;
    state = (state ^ (state >>> 17)) >>> 0;
    state = (state ^ (state << 5)) >>> 0;
    return state;
  };
  const word = () => next().toString(16).padStart(8, '0');
  const lines = [
    `export const HEAVY_SENTINEL = '${SENTINEL}';`,
    '',
    'export class Heavy {',
    '  tag(): string {',
    '    return HEAVY_SENTINEL;',
    '  }',
  ];
  for (let index = 0; index < HEAVY_METHODS; index += 1) {
    lines.push(`  method${index}(): string {`, `    return '${word()}${word()}${word()}';`, '  }');
  }
  lines.push('}');
  return `${lines.join('\n')}\n`;
}

function scenarioSource(template, scenario) {
  const extra = [];
  if (scenario.mode === 'closed') extra.push("  optimization: { mode: 'closed', roots: [port] },");
  if (scenario.profile === 'minimal') extra.push("  runtime: { profile: 'minimal' },");
  let text = template;
  if (extra.length > 0) {
    if (!text.includes(NAME_LINE)) throw new Error('fixture anchor missing');
    text = text.replace(NAME_LINE, `${NAME_LINE}\n${extra.join('\n')}`);
  }
  if (scenario.staticImport) {
    if (!text.includes(DYNAMIC_FACTORY)) throw new Error('fixture factory missing');
    text = text.replace(DYNAMIC_FACTORY, STATIC_FACTORY);
    text = text.replace(HEADER, `${HEADER}\nimport { Heavy } from './heavy';`);
  }
  return text;
}

function normalizedKind(kind) {
  if (kind === 'import-statement' || kind === 'dynamic-import') return kind;
  throw new Error('chunk role unresolved');
}

function keepsInitial(kind) {
  return normalizedKind(kind) === 'import-statement';
}

/**
 * Roles come from the metafile only.
 * esbuild also sets entryPoint on a chunk that is only reached by a dynamic import.
 * The initial root is the output that has entryPoint and that no other output imports.
 * Outputs reached from that root by import-statement edges only are initial.
 * An output reached only by a path that uses dynamic-import is deferred.
 */
function classify(metafile) {
  const outputs = metafile.outputs ?? {};
  const names = Object.keys(outputs);
  const imported = new Set();
  for (const output of Object.values(outputs)) {
    for (const edge of output.imports ?? []) {
      if (edge.external) continue;
      normalizedKind(edge.kind);
      if (!outputs[edge.path]) throw new Error('chunk role unresolved');
      imported.add(edge.path);
    }
  }
  const roots = names.filter((name) => outputs[name].entryPoint && !imported.has(name));
  if (roots.length !== 1) throw new Error('chunk role unresolved');
  const root = roots[0];
  const initial = new Set([root]);
  const queue = [root];
  while (queue.length > 0) {
    const name = queue.shift();
    for (const edge of outputs[name].imports ?? []) {
      if (edge.external) continue;
      if (keepsInitial(edge.kind) && !initial.has(edge.path)) {
        initial.add(edge.path);
        queue.push(edge.path);
      }
    }
  }
  const reachable = new Set([root]);
  const walk = [root];
  while (walk.length > 0) {
    const name = walk.shift();
    for (const edge of outputs[name].imports ?? []) {
      if (edge.external) continue;
      normalizedKind(edge.kind);
      if (!reachable.has(edge.path)) {
        reachable.add(edge.path);
        walk.push(edge.path);
      }
    }
  }
  const roles = new Map();
  for (const name of names) {
    if (!reachable.has(name)) throw new Error('chunk role unresolved');
    const role = initial.has(name) ? 'initial' : 'deferred';
    roles.set(name, role);
  }
  return { roles, root };
}

function indexOutputs(metafile) {
  const classified = classify(metafile);
  const byKey = new Map();
  for (const [name, output] of Object.entries(metafile.outputs ?? {})) {
    const key = Object.keys(output.inputs ?? {}).sort(compareText).join('\0');
    if (key.length === 0 || byKey.has(key)) throw new Error('chunk pairing is ambiguous');
    byKey.set(key, {
      key,
      name,
      role: classified.roles.get(name),
      entry: name === classified.root,
    });
  }
  return byKey;
}

function fileText(files, absWorkingDir, outputKey) {
  const abs = join(absWorkingDir, outputKey);
  const file = files.find((item) => item.path === abs) ?? files.find((item) => item.path.endsWith(`/${outputKey}`));
  if (!file) throw new Error('chunk pairing failed');
  if (typeof file.text === 'string') return file.text;
  if (file.contents) return Buffer.from(file.contents).toString('utf8');
  throw new Error('chunk pairing failed');
}

function chunkRecord(role, entry, rawText, minText) {
  const compressed = compress(minText);
  return {
    role,
    entry,
    raw: Buffer.byteLength(rawText),
    minified: Buffer.byteLength(minText),
    gzip: compressed.gzip,
    brotli: compressed.brotli,
    containsSentinel: rawText.includes(SENTINEL),
    containsMarker: rawText.includes(MARKER),
  };
}

function pairChunks(rawMeta, rawFiles, minMeta, minFiles, absWorkingDir) {
  const rawIndex = indexOutputs(rawMeta);
  const minIndex = indexOutputs(minMeta);
  if (rawIndex.size !== minIndex.size) throw new Error('chunk pairing failed');
  const chunks = [];
  for (const [key, raw] of rawIndex) {
    const min = minIndex.get(key);
    if (!min) throw new Error('chunk pairing failed');
    if (raw.role !== min.role || raw.entry !== min.entry) throw new Error('chunk role unresolved');
    chunks.push({
      key,
      record: chunkRecord(
        raw.role,
        raw.entry,
        fileText(rawFiles, absWorkingDir, raw.name),
        fileText(minFiles, absWorkingDir, min.name),
      ),
    });
  }
  for (const key of minIndex.keys()) {
    if (!rawIndex.has(key)) throw new Error('chunk pairing failed');
  }
  chunks.sort((left, right) => {
    if (left.record.role !== right.record.role) return left.record.role === 'initial' ? -1 : 1;
    if (left.record.entry !== right.record.entry) return left.record.entry ? -1 : 1;
    return compareText(left.key, right.key);
  });
  return chunks.map((chunk) => chunk.record);
}

function tsconfigText() {
  const syringe = join(root, 'packages/neosyringe').replace(/\\/g, '/');
  return JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'bundler',
      strict: true,
      baseUrl: '.',
      paths: { '@djodjonx/neosyringe': [syringe] },
    },
    include: ['**/*.ts'],
  });
}

async function buildOnce(dir, minify) {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    return await esbuild.build({
      absWorkingDir: dir,
      entryPoints: ['app.ts'],
      bundle: true,
      splitting: true,
      format: 'esm',
      metafile: true,
      write: false,
      platform: 'node',
      outdir: minify ? 'min' : 'raw',
      outExtension: { '.js': '.mjs' },
      minify,
      logLevel: 'silent',
      define: { 'process.env.NODE_ENV': '"production"' },
      // Plugin validation stays strict: no validation option (packages/unplugin/src/index.ts:150).
      plugins: [plugin.neoSyringePlugin.esbuild({ project: join(dir, 'tsconfig.json') })],
    });
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
}

async function executeEntry(files, absWorkingDir, metafile) {
  const classified = classify(metafile);
  for (const file of files) {
    mkdirSync(dirname(file.path), { recursive: true });
    const text = typeof file.text === 'string' ? file.text : Buffer.from(file.contents).toString('utf8');
    writeFileSync(file.path, text);
  }
  const entry = fileText(files, absWorkingDir, classified.root);
  const entryFile = files.find((file) => file.path === join(absWorkingDir, classified.root))
    ?? files.find((file) => file.path.endsWith(`/${classified.root}`));
  if (!entryFile || entry.length === 0) throw new Error('chunk pairing failed');
  const loaded = await import(pathToFileURL(entryFile.path).href);
  return loaded.run();
}

async function measureScenario(template, scenario) {
  const dir = join(BUILD_ROOT, scenario.id);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'app.ts'), scenarioSource(template, scenario));
  writeFileSync(join(dir, 'heavy.ts'), heavySource());
  writeFileSync(join(dir, 'tsconfig.json'), tsconfigText());
  const raw = await buildOnce(dir, false);
  const minified = await buildOnce(dir, true);
  if (!raw.metafile || !minified.metafile || !raw.outputFiles || !minified.outputFiles) {
    throw new Error('chunk pairing failed');
  }
  const chunks = pairChunks(raw.metafile, raw.outputFiles, minified.metafile, minified.outputFiles, dir);
  const result = await executeEntry(minified.outputFiles, dir, minified.metafile);
  const rawResult = await executeEntry(raw.outputFiles, dir, raw.metafile);
  if (rawResult.tag !== result.tag || rawResult.marker !== result.marker) {
    throw new Error('raw and minified results differ');
  }
  return { mode: scenario.mode, profile: scenario.profile, result, rawResult, chunks };
}

async function collectReport() {
  const template = readFileSync(FIXTURE, 'utf8');
  rmSync(BUILD_ROOT, { recursive: true, force: true });
  const scenarios = {};
  try {
    for (const scenario of SCENARIOS) {
      scenarios[scenario.id] = await measureScenario(template, scenario);
    }
  } finally {
    rmSync(BUILD_ROOT, { recursive: true, force: true });
  }
  return {
    command: COMMAND,
    bundler: 'esbuild',
    env: readEnv(),
    compression: { input: 'minified', gzipLevel: GZIP_LEVEL, brotliQuality: BROTLI_QUALITY },
    scenarios,
  };
}

export async function measure() {
  return collectReport();
}

function printTable(report) {
  const pad = (value, width) => String(value).padStart(width);
  console.log('esbuild only. Rollup is not used. scripts/ci/consumer-dist.mjs is a CI check, not this measure.');
  console.log(`node: ${report.env.node}`);
  console.log(`zlib: ${report.env.zlib}`);
  console.log(`os: ${report.env.os}`);
  console.log(`cpu: ${report.env.cpu}`);
  console.log(`esbuild: ${report.env.esbuild}`);
  console.log(`typescript: ${report.env.typescript}`);
  console.log(`neosyringe: ${report.env.neosyringe}`);
  console.log(`command: node scripts/measure-chunk-split.mjs`);
  console.log(`gzip: level ${report.compression.gzipLevel}, Brotli: quality ${report.compression.brotliQuality}, both on the minified text`);
  console.log(`${'scenario'.padEnd(18)}${'role'.padEnd(10)}${pad('entry', 6)}${pad('raw', 10)}${pad('minified', 12)}${pad('gzip', 10)}${pad('brotli', 10)}  sentinel  marker`);
  for (const [id, scenario] of Object.entries(report.scenarios)) {
    console.log(`${id}  mode=${scenario.mode} profile=${scenario.profile} result=${JSON.stringify(scenario.result)}`);
    for (const chunk of scenario.chunks) {
      console.log(`${''.padEnd(18)}${chunk.role.padEnd(10)}${pad(chunk.entry, 6)}${pad(chunk.raw, 10)}${pad(chunk.minified, 12)}${pad(chunk.gzip, 10)}${pad(chunk.brotli, 10)}  ${pad(chunk.containsSentinel, 8)}  ${pad(chunk.containsMarker, 6)}`);
    }
  }
}

function isDirectRun() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  const report = await measure();
  if (JSON_OUTPUT) console.log(JSON.stringify(report, null, 2));
  else printTable(report);
}
