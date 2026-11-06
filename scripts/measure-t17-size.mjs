#!/usr/bin/env node
// scripts/measure-t17-size.mjs
// Size of the generated container for one fixed graph, per emitter and profile, then of an open
// vs a closed production bundle. Raw and minified bytes, plus gzip (level 9) and Brotli (quality 11)
// of the minified text.
// Run from the repo root after a fresh `pnpm build`: node scripts/measure-t17-size.mjs [--json]
// Not a test: it reads the built packages/core and packages/unplugin dist (stale if not rebuilt) and
// prints a table. --json prints one JSON object and nothing else (tests/e2e/t17-size-measure.test.ts).
// full and minimal do not offer the same features (events, overrides): never read
// the minimal row as a free speed-up of the full rows. ADR007, "Comparaisons".
// The bundle byte counts depend on the absolute build path: the file name is hashed into the container id
// and the generated class suffix (packages/core/src/analyzer/shared/HashUtils.ts:158-160,
// packages/core/src/generator/Generator.ts:150-154). The build directory is stable per checkout (see
// BUNDLE_DIR), so one checkout prints the same bytes every run, but another checkout or CI can print other bytes.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const coreRequire = createRequire(resolve(root, 'packages/core/package.json'));
const unpluginRequire = createRequire(resolve(root, 'packages/unplugin/package.json'));
const ts = coreRequire('typescript');
const esbuild = unpluginRequire('esbuild');
const plugin = unpluginRequire('./dist/index.cjs');

const { Analyzer } = await import(pathToFileURL(resolve(root, 'packages/core/dist/analyzer/index.mjs')).href);
const { Generator } = await import(pathToFileURL(resolve(root, 'packages/core/dist/generator/index.mjs')).href);

const FIXTURE = resolve(root, 'virtual-t17-size/fixture.ts');
const PROVIDERS = 12;
const JSON_OUTPUT = process.argv.includes('--json');
const GZIP_LEVEL = 9;
const BROTLI_QUALITY = 11;
const HEAVY_METHODS = 500;
const SENTINEL = 'T21_SENTINEL_UNREACHABLE';
const CLOSED_OPTION = "optimization: { mode: 'closed', roots: [pipeline], eager: [worker] },";
const BUNDLE_FIXTURE = resolve(root, 'tests/e2e/fixtures/t21-closed/app.ts');
// One directory per checkout: worktrees of the same user can run this script at the same time.
const BUNDLE_DIR = join(tmpdir(), `t17-size-bundle-${createHash('sha1').update(root).digest('hex').slice(0, 10)}`);

/** gzip and Brotli byte counts of a text. Levels are fixed and reported, nothing else is tuned. */
function compress(text) {
  const input = Buffer.from(text);
  return {
    gzip: gzipSync(input, { level: GZIP_LEVEL }).length,
    brotli: brotliCompressSync(input, { params: { [constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY } }).length,
  };
}

/** Fixed graph: a chain of factories, three multi contributions, one async singleton. No clock, no random. */
function fixtureSource() {
  const lines = [
    "import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';",
    'function defineBuilderConfig(config: any) { return config; }',
    'function useInterface<T>(): any { return null; }',
  ];
  for (let index = 0; index < PROVIDERS; index += 1) {
    lines.push(`interface Port${index} { n: number }`, `const port${index} = useInterface<Port${index}>();`);
  }
  lines.push('interface Plugin { n: number }', 'const plugin = useInterface<Plugin>();');
  lines.push('interface Boot { ready: boolean }', 'const boot = useInterface<Boot>();');
  lines.push('export const sizeFixture = defineBuilderConfig({', "  name: 'SizeFixture',", '  injections: [');
  for (let index = 0; index < PROVIDERS; index += 1) {
    const dependency = index === 0 ? '[]' : `[port${index - 1}]`;
    const body = index === 0 ? `{ n: ${index} }` : `{ n: ctx.resolve(port${index - 1}).n + 1 }`;
    lines.push(`    { token: port${index}, useFactory: true, dependencies: ${dependency}, provider: (ctx) => (${body}) },`);
  }
  for (let index = 0; index < 3; index += 1) {
    lines.push(`    { token: plugin, multi: true, useFactory: true, dependencies: [], provider: () => ({ n: ${index} }) },`);
  }
  lines.push('    { token: boot, useFactory: true, dependencies: [], provider: async () => ({ ready: true }) },');
  lines.push('  ],', '});');
  return lines.join('\n');
}

function analyze() {
  const options = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, strict: true, noImplicitAny: false };
  const host = ts.createCompilerHost(options);
  const read = host.getSourceFile.bind(host);
  const exists = host.fileExists.bind(host);
  const text = fixtureSource();
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) => (
    fileName === FIXTURE ? ts.createSourceFile(fileName, text, languageVersion, true) : read(fileName, languageVersion, onError, shouldCreate)
  );
  host.fileExists = (fileName) => fileName === FIXTURE || exists(fileName);
  host.resolveModuleNames = (names, containing) => names.map((name) => ts.resolveModuleName(name, containing, options, host).resolvedModule);
  const program = ts.createProgram([FIXTURE], options, host);
  const graphs = new Analyzer(program).extractAll();
  if (graphs.length !== 1) throw new Error(`expected one container, got ${graphs.length}`);
  return graphs[0];
}

function measure(graph, label, emitter, profile) {
  const sized = { ...graph, runtimeProfile: profile };
  const source = new Generator(sized, false, undefined, false, false, emitter).generate();
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const minified = esbuild.transformSync(js, { minify: true, format: 'esm', target: 'es2022' }).code;
  return { label, raw: Buffer.byteLength(js), minified: Buffer.byteLength(minified), ...compress(minified) };
}

/** Deliberately heavy provider: many methods with seeded literals (xorshift32, integer math, no clock, no random). */
function heavySource() {
  let state = 0x2545f491;
  const next = () => {
    state = (state ^ (state << 13)) >>> 0;
    state = (state ^ (state >>> 17)) >>> 0;
    state = (state ^ (state << 5)) >>> 0;
    return state;
  };
  const word = () => next().toString(16).padStart(8, '0');
  const lines = [`export const HEAVY_SENTINEL = '${SENTINEL}';`, '', 'export class Heavy {', '  tag(): string {', '    return HEAVY_SENTINEL;', '  }'];
  for (let index = 0; index < HEAVY_METHODS; index += 1) {
    lines.push(`  method${index}(): string {`, `    return '${word()}${word()}${word()}';`, '  }');
  }
  lines.push('}');
  return lines.join('\n');
}

/**
 * Bundles app.ts + heavy.ts with the real built plugin, production mode, like tests/e2e/helpers/t21-bundle.ts.
 * The directory name is fixed per checkout: the file name is hashed into the container id and the class suffix,
 * so a random directory would change identifier names, and the minified and compressed sizes, from one run to
 * the next. Another checkout has another path, hence possibly other bytes. Do not run two instances in the
 * same checkout at once.
 */
async function bundle(files, minify) {
  const dir = BUNDLE_DIR;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const syringe = join(root, 'packages/neosyringe').replace(/\\/g, '/');
  const previous = process.env.NODE_ENV;
  try {
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
    writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'bundler',
        strict: true,
        baseUrl: '.',
        paths: { '@djodjonx/neosyringe': [syringe] },
      },
      include: ['**/*.ts'],
    }));
    process.env.NODE_ENV = 'production';
    const result = await esbuild.build({
      absWorkingDir: dir,
      entryPoints: ['app.ts'],
      bundle: true,
      write: false,
      minify,
      format: 'cjs',
      platform: 'node',
      define: { 'process.env.NODE_ENV': '"production"' },
      plugins: [plugin.neoSyringePlugin.esbuild({ project: join(dir, 'tsconfig.json') })],
    });
    return result.outputFiles[0].text;
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Executes a cjs bundle that exports `run`, like runBundle in tests/e2e/helpers/t21-bundle.ts. */
async function execute(code) {
  const record = { exports: {} };
  new Function('module', 'exports', 'require', code)(record, record.exports, (id) => {
    throw new Error(`unexpected require ${id}`);
  });
  return record.exports.run();
}

async function measureBundle(files) {
  const raw = await bundle(files, false);
  const minified = await bundle(files, true);
  return {
    sizes: { raw: Buffer.byteLength(raw), minified: Buffer.byteLength(minified), ...compress(minified) },
    containsSentinel: raw.includes(SENTINEL) || minified.includes(SENTINEL),
    result: await execute(minified),
  };
}

const graph = analyze();
const rows = [
  measure(graph, 'reference-full', 'reference', 'full'),
  measure(graph, 'optimized-full', 'optimized', 'full'),
  measure(graph, 'optimized-minimal', 'optimized', 'minimal'),
];

const app = readFileSync(BUNDLE_FIXTURE, 'utf8');
if (!app.includes(CLOSED_OPTION)) throw new Error(`${BUNDLE_FIXTURE} no longer holds the closed option`);
const heavy = heavySource();
const closed = await measureBundle({ 'app.ts': app, 'heavy.ts': heavy });
// Control: the same sources, open by default, must carry the sentinel, or the closed result proves nothing.
const open = await measureBundle({ 'app.ts': app.replace(CLOSED_OPTION, ''), 'heavy.ts': heavy });
if (!open.containsSentinel) throw new Error('control failed: the open bundle does not carry the heavy sentinel');
const equal = JSON.stringify(open.result) === JSON.stringify(closed.result);
if (!equal) throw new Error(`open and closed bundles run differently: ${JSON.stringify(open.result)} vs ${JSON.stringify(closed.result)}`);

const METRICS = ['raw', 'minified', 'gzip', 'brotli'];
const delta = Object.fromEntries(METRICS.map((metric) => [metric, open.sizes[metric] - closed.sizes[metric]]));

if (JSON_OUTPUT) {
  const sizes = ({ raw, minified, gzip, brotli }) => ({ raw, minified, gzip, brotli });
  console.log(JSON.stringify({
    node: process.version,
    compression: { input: 'minified', gzipLevel: GZIP_LEVEL, brotliQuality: BROTLI_QUALITY },
    graph: { providers: PROVIDERS, multiContributions: 3, asyncSingletons: 1 },
    variants: Object.fromEntries(rows.map((row) => [row.label, sizes(row)])),
    sentinel: SENTINEL,
    bundle: {
      open: { ...open.sizes, containsSentinel: open.containsSentinel },
      closed: { ...closed.sizes, containsSentinel: closed.containsSentinel },
      delta,
    },
    run: { open: open.result, closed: closed.result, equal },
  }, null, 2));
} else {
  const pad = (value, width) => String(value).padStart(width);
  const signed = (value) => (value > 0 ? `+${value}` : String(value));
  const base = rows[0];
  console.log('reads packages/core/dist: it must come from a fresh `pnpm build`, a stale dist measures old code.');
  console.log(`graph: ${PROVIDERS} chained factories, 3 multi contributions, 1 async singleton (open mode, debug off, testOverrides off)`);
  console.log(`gzip: level ${GZIP_LEVEL}, Brotli: quality ${BROTLI_QUALITY}, both on the minified text (esbuild minify)`);
  console.log(`${'variant'.padEnd(20)}${pad('raw bytes', 12)}${pad('minified bytes', 16)}${pad('gzip bytes', 12)}${pad('brotli bytes', 14)}${pad('raw vs ref', 12)}${pad('min vs ref', 12)}`);
  for (const row of rows) {
    const diff = row === base ? ['-', '-'] : [signed(row.raw - base.raw), signed(row.minified - base.minified)];
    console.log(`${row.label.padEnd(20)}${pad(row.raw, 12)}${pad(row.minified, 16)}${pad(row.gzip, 12)}${pad(row.brotli, 14)}${pad(diff[0], 12)}${pad(diff[1], 12)}`);
  }
  console.log('minimal drops on/override/clearOverrides: compare it with the full rows as a different feature set.');
  console.log('');
  console.log(`bundle: tests/e2e/fixtures/t21-closed/app.ts + a generated heavy provider (${HEAVY_METHODS} methods, synthetic), esbuild, production`);
  console.log('open = no optimization option, closed = optimization.mode closed (heavy provider unreachable from the roots)');
  console.log(`${'bundle'.padEnd(20)}${pad('raw bytes', 12)}${pad('minified bytes', 16)}${pad('gzip bytes', 12)}${pad('brotli bytes', 14)}${pad('has sentinel', 14)}`);
  for (const [label, entry] of [['open', open], ['closed', closed]]) {
    console.log(`${label.padEnd(20)}${pad(entry.sizes.raw, 12)}${pad(entry.sizes.minified, 16)}${pad(entry.sizes.gzip, 12)}${pad(entry.sizes.brotli, 14)}${pad(entry.containsSentinel, 14)}`);
  }
  console.log(`${'open - closed'.padEnd(20)}${pad(delta.raw, 12)}${pad(delta.minified, 16)}${pad(delta.gzip, 12)}${pad(delta.brotli, 14)}`);
  console.log(`run: open and closed bundles return ${JSON.stringify(closed.result)}`);
}
