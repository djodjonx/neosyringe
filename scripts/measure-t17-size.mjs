#!/usr/bin/env node
// scripts/measure-t17-size.mjs
// Size of the generated container for one fixed graph, per emitter and profile, then of an open
// vs a closed production bundle. Raw and minified bytes, plus gzip (level 9) and Brotli (quality 11)
// of the minified text.
// Run from the repo root after a fresh `pnpm build`: node scripts/measure-t17-size.mjs [--json | --breakdown [--json]]
// Not a test: it reads the built packages/core and packages/unplugin dist (stale if not rebuilt) and
// prints a table. --json prints one JSON object and nothing else (tests/e2e/t17-size-measure.test.ts).
// --breakdown does not bundle: it cuts the minifier-free JavaScript of the optimized full container into emission
// categories (the members of the generated class, by name) and prints the raw bytes of each, for three graph sizes and
// for several small containers summed, open and closed, debug on and off. The categories partition the text: they sum
// to its size. `user-code` is the fixture's own text: the factory the generator copies into each creator
// (`const userFactory = ...`, packages/core/src/generator/FactoryEmitter.ts:345,384) is not NeoSyringe code, so it is
// not counted in `creators`. The several small containers are generated one by one (one file, distinct container and
// token names, the way the plugin inlines several containers of a file), each output is categorized on its own, the row
// sums those measured parts and lists them in `parts`. --breakdown --json prints that report as one JSON object.
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
const BREAKDOWN = process.argv.includes('--breakdown');
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

/**
 * Fixed graph: a chain of factories, three multi contributions, one async singleton. No clock, no random.
 * `providers` is the length of the chain, `option` a line of the container's config (`''` is open mode), `containers`
 * the number of containers of the file (each with its own names, see tagOf).
 */
function fixtureSource(providers = PROVIDERS, option = '', containers = 1) {
  const lines = [
    "import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';",
    'function defineBuilderConfig(config: any) { return config; }',
    'function useInterface<T>(): any { return null; }',
  ];
  for (let container = 0; container < containers; container += 1) lines.push(...containerSource(providers, option, tagOf(container, containers)));
  return lines.join('\n');
}

/**
 * One container of a file with `containers` of them gets its own container and token names: `` for the only one,
 * `C0`, `C1x`, `C2xx`... otherwise. The names grow, so no two containers have the same text or the same size.
 */
function tagOf(container, containers) {
  return containers === 1 ? '' : `C${container}${'x'.repeat(container)}`;
}

function containerSource(providers, option, tag) {
  const optionLine = typeof option === 'function' ? option(tag) : option;
  const lines = [];
  for (let index = 0; index < providers; index += 1) {
    lines.push(`interface Port${index}${tag} { n: number }`, `const port${index}${tag} = useInterface<Port${index}${tag}>();`);
  }
  lines.push(`interface Plugin${tag} { n: number }`, `const plugin${tag} = useInterface<Plugin${tag}>();`);
  lines.push(`interface Boot${tag} { ready: boolean }`, `const boot${tag} = useInterface<Boot${tag}>();`);
  lines.push(`export const sizeFixture${tag} = defineBuilderConfig({`, `  name: 'SizeFixture${tag}',`, ...(optionLine === '' ? [] : [`  ${optionLine}`]), '  injections: [');
  for (let index = 0; index < providers; index += 1) {
    const dependency = index === 0 ? '[]' : `[port${index - 1}${tag}]`;
    const body = index === 0 ? `{ n: ${index} }` : `{ n: ctx.resolve(port${index - 1}${tag}).n + 1 }`;
    lines.push(`    { token: port${index}${tag}, useFactory: true, dependencies: ${dependency}, provider: (ctx) => (${body}) },`);
  }
  for (let index = 0; index < 3; index += 1) {
    lines.push(`    { token: plugin${tag}, multi: true, useFactory: true, dependencies: [], provider: () => ({ n: ${index} }) },`);
  }
  lines.push(`    { token: boot${tag}, useFactory: true, dependencies: [], provider: async () => ({ ready: true }) },`);
  lines.push('  ],', '});');
  return lines;
}

/** Every container of the fixture file, in source order. `option` is a line, or a function of the container's tag. */
function analyzeAll(providers = PROVIDERS, option = '', containers = 1) {
  const options = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, strict: true, noImplicitAny: false };
  const host = ts.createCompilerHost(options);
  const read = host.getSourceFile.bind(host);
  const exists = host.fileExists.bind(host);
  const text = fixtureSource(providers, option, containers);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) => (
    fileName === FIXTURE ? ts.createSourceFile(fileName, text, languageVersion, true) : read(fileName, languageVersion, onError, shouldCreate)
  );
  host.fileExists = (fileName) => fileName === FIXTURE || exists(fileName);
  host.resolveModuleNames = (names, containing) => names.map((name) => ts.resolveModuleName(name, containing, options, host).resolvedModule);
  const program = ts.createProgram([FIXTURE], options, host);
  const graphs = new Analyzer(program).extractAll();
  if (graphs.length !== containers) throw new Error(`expected ${containers} container${containers === 1 ? '' : 's'}, got ${graphs.length}`);
  return graphs;
}

function analyze(providers = PROVIDERS, option = '') {
  return analyzeAll(providers, option)[0];
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

/**
 * Emission categories of the members of the generated class, first match wins. A property that no pattern names is
 * container state; any other member is `other-members`: it shows in the report, it is never folded into a neighbour.
 */
const MEMBER_CATEGORIES = [
  ['creators', /^(create_|_neoRaw_create_)/],
  ['factory-policy', /^__neoPolicy|^__neoRead_|^__neoLease$/],
  ['accessors', /^_direct_|^_get_|^_list_/],
  ['dispatch-tables', /^__neo(Dispatch|Roots|Lists|RootLists)/],
  ['resolve', /^(resolve|resolveAll|resolveMany|_resolveInternal|_resolveAllInternal)$/],
  ['lifecycle', /^(initialize|_startInitialize|_runInitialize|createScope|destroy|_runDestroy|_close|override|overrideMany|clearOverrides|_reconfigure)$/],
  ['events', /^(on|notifyResolve)$/],
  ['runtime-helpers', /^(_touchClosed|_assertParents|_neoFail|_assertRoot|_guardPublic|formatToken|_mock|_neoDisposer|__neoController|__neoIdle|__neoIdleSignal|_neoSignal|_neoCheck)$/],
  ['observation', /^(observe|stateSnapshot|_neoObs|_neoAdopt|_neoSettle|_neoRegistration|_obs|_scopeId|_scoped)$/],
  ['debug-metadata', /^(_graph|_dependencyGraph)$/],
];
const CATEGORY_IDS = [...MEMBER_CATEGORIES.map(([id]) => id), 'user-code', 'state', 'other-members', 'class-shell', 'imports', 'glue'];
const BREAKDOWN_GRAPHS = [
  { label: 'small', providers: 3, containers: 1 },
  { label: 'medium', providers: PROVIDERS, containers: 1 },
  { label: 'large', providers: 48, containers: 1 },
  { label: 'many-small', providers: 3, containers: 6 },
  // More rows than DISPATCH_LINEAR_MAX (packages/core/src/generator/dispatchEmitter.ts): the open output has its shared table here.
  { label: 'above-threshold', providers: 200, containers: 1 },
];
const BREAKDOWN_CONFIGS = [
  { key: 'open-debug-off', closed: false, debug: false },
  { key: 'open-debug-on', closed: false, debug: true },
  { key: 'closed-debug-off', closed: true, debug: false },
  { key: 'closed-debug-on', closed: true, debug: true },
];

function memberCategory(member) {
  if (ts.isConstructorDeclaration(member)) return 'state';
  const name = member.name !== undefined && (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)) ? member.name.text : '';
  // The `[Symbol.asyncDispose]` delegate of the container (packages/core/src/generator/LifecycleEmitter.ts, asyncDisposalMember): the one computed key that is named.
  if (member.name !== undefined && ts.isComputedPropertyName(member.name) && /^\(*Symbol\)*\.asyncDispose$/.test(member.name.expression.getText())) return 'lifecycle';
  for (const [id, pattern] of MEMBER_CATEGORIES) {
    if (pattern.test(name)) return id;
  }
  return ts.isPropertyDeclaration(member) ? 'state' : 'other-members';
}

/**
 * Raw bytes of each emission category of one generated module. Every character of the text gets one label (the
 * members of the container class by name, the class around them, the imports, the rest), so the categories sum to the size of the text.
 */
function categorize(js) {
  const file = ts.createSourceFile('container.js', js, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
  const labels = Array.from({ length: js.length }, () => 'glue');
  const paint = (node, label) => {
    for (let at = node.getFullStart(); at < node.getEnd(); at += 1) labels[at] = label;
  };
  // The copied user factory, `const userFactory = <the user's text>`, wherever a member holds it: painted after its member.
  const paintUserFactories = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'userFactory' && node.initializer !== undefined) {
      paint(node.initializer, 'user-code');
    }
    ts.forEachChild(node, paintUserFactories);
  };
  for (const statement of file.statements) {
    if (ts.isImportDeclaration(statement)) {
      paint(statement, 'imports');
    } else if (ts.isClassDeclaration(statement) && statement.name?.text.startsWith('NeoContainer')) {
      paint(statement, 'class-shell');
      for (const member of statement.members) {
        paint(member, memberCategory(member));
        paintUserFactories(member);
      }
    }
  }
  const bytes = Object.fromEntries(CATEGORY_IDS.map((id) => [id, 0]));
  let start = 0;
  for (let at = 1; at <= labels.length; at += 1) {
    if (at < labels.length && labels[at] === labels[start]) continue;
    bytes[labels[start]] += Buffer.byteLength(js.slice(start, at));
    start = at;
  }
  return bytes;
}

function closedOption(providers) {
  return (tag) => `optimization: { mode: 'closed', roots: [port${providers - 1}${tag}, plugin${tag}, boot${tag}] },`;
}

/** One container: generated, transpiled and categorized on its own. */
function measureContainer(graph, debug) {
  const source = new Generator({ ...graph, runtimeProfile: 'full' }, false, undefined, debug, false, 'optimized').generate();
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  return { container: graph.containerId, total: Buffer.byteLength(js), categories: categorize(js) };
}

function breakdownReport() {
  const analyses = new Map();
  const graphsOf = (providers, closed, containers) => {
    const key = `${providers}:${closed}:${containers}`;
    if (!analyses.has(key)) analyses.set(key, analyzeAll(providers, closed ? closedOption(providers) : '', containers));
    return analyses.get(key);
  };
  const graphs = BREAKDOWN_GRAPHS.map(({ label, providers, containers }) => {
    const configs = {};
    for (const { key, closed, debug } of BREAKDOWN_CONFIGS) {
      const row = graphsOf(providers, closed, containers);
      const parts = row.map((graph) => measureContainer(graph, debug));
      configs[key] = {
        total: parts.reduce((sum, part) => sum + part.total, 0),
        categories: Object.fromEntries(CATEGORY_IDS.map((id) => [id, parts.reduce((sum, part) => sum + part.categories[id], 0)])),
        parts,
      };
    }
    return { label, providers, containers, configs };
  });
  return {
    node: process.version,
    emitter: 'optimized',
    profile: 'full',
    unit: 'raw bytes of the generated JavaScript, before minification',
    categories: CATEGORY_IDS,
    graphs,
  };
}

function printBreakdown() {
  const report = breakdownReport();
  if (JSON_OUTPUT) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  const pad = (value, width) => String(value).padStart(width);
  console.log('reads packages/core/dist: it must come from a fresh `pnpm build`, a stale dist measures old code.');
  console.log(`emitter optimized, profile full, test overrides off. ${report.unit}. Each column sums to its total.`);
  for (const graph of report.graphs) {
    console.log('');
    console.log(`graph ${graph.label}: ${graph.providers} chained factories, 3 multi contributions, 1 async singleton, ${graph.containers} container${graph.containers === 1 ? '' : 's'} summed`);
    console.log(`${'category'.padEnd(18)}${BREAKDOWN_CONFIGS.map(({ key }) => pad(key, 18)).join('')}`);
    for (const id of report.categories) {
      console.log(`${id.padEnd(18)}${BREAKDOWN_CONFIGS.map(({ key }) => pad(graph.configs[key].categories[id], 18)).join('')}`);
    }
    console.log(`${'total'.padEnd(18)}${BREAKDOWN_CONFIGS.map(({ key }) => pad(graph.configs[key].total, 18)).join('')}`);
  }
}

async function printMeasurements() {
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
}

if (BREAKDOWN) printBreakdown();
else await printMeasurements();
