/**
 * T18 compile-cost bench. Not part of vitest and not part of `pnpm test`.
 *
 * The orchestrator forbids `pnpm build`, so this file bundles
 * `packages/unplugin/src` with esbuild (devDependency of
 * `@djodjonx/neosyringe-plugin`) into a module under `os.tmpdir()`.
 * The temp directory gets a `node_modules` of symlinks so Node resolves the
 * external packages there. The bundle is deleted at the end and on SIGINT/SIGTERM.
 *
 * Profile and mode are not plugin flags. They are literals in the generated
 * `defineBuilderConfig` source (`runtime.profile`, `optimization.mode`).
 * `noLib: true` keeps the TypeScript lib out of the timed program.
 *
 * `linear`: N containers, each injecting only `Shared`.
 * `diamond`: `Left` and `Right` inject `Shared`, and N leaves inject both.
 * A chain of N containers is not used: each program would include the whole
 * prefix, and size 1000 does not finish within 10 minutes.
 *
 * Env: NEOSYRINGE_BENCH_SIZES (default 10), NEOSYRINGE_BENCH_REPS (default 5),
 * NEOSYRINGE_BENCH_TOOLS (default unplugin,transformer). Optional:
 * NEOSYRINGE_BENCH_SHAPES, NEOSYRINGE_BENCH_PROFILES, NEOSYRINGE_BENCH_MODES.
 * There is no cache switch. The content graph map is gone, and the bench
 * runs one path. The host-program identity reuse stays on that path.
 */
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

const root = repoRoot();
const require = createRequire(path.join(root, 'packages/unplugin/package.json'));
const esbuild = require('esbuild');
const ts = require('typescript');
const neosyringeSrc = path.join(root, 'packages/neosyringe/src/index.ts');

const sizes = numbers('NEOSYRINGE_BENCH_SIZES', '10');
const reps = numberEnv('NEOSYRINGE_BENCH_REPS', 5);
const tools = listEnv('NEOSYRINGE_BENCH_TOOLS', 'unplugin,transformer');
const shapes = listEnv('NEOSYRINGE_BENCH_SHAPES', 'linear,diamond');
const profiles = listEnv('NEOSYRINGE_BENCH_PROFILES', 'full,minimal');
const modes = listEnv('NEOSYRINGE_BENCH_MODES', 'open,closed');

function repoRoot() {
  let dir = path.resolve(process.cwd());
  while (!exists(path.join(dir, 'pnpm-workspace.yaml'))) {
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('racine du dépôt introuvable');
    dir = parent;
  }
  return dir;
}

function exists(file) {
  try {
    readFileSync(file);
    return true;
  } catch {
    return false;
  }
}

function listEnv(name, fallback) {
  return (process.env[name] || fallback).split(',').map((part) => part.trim()).filter(Boolean);
}

function numbers(name, fallback) {
  return listEnv(name, fallback).map((part) => {
    const value = Number(part);
    if (!Number.isInteger(value) || value < 1) throw new Error(`${name} attend des entiers >= 1`);
    return value;
  });
}

function numberEnv(name, fallback) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} attend un entier >= 1`);
  return value;
}

function readVersion(pkgPath) {
  return JSON.parse(readFileSync(pkgPath, 'utf8')).version;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

function optimization(mode, rootName) {
  if (mode === 'closed') return `optimization: { mode: 'closed', roots: [${rootName}] },`;
  return `optimization: { mode: 'open' },`;
}

function container(fileImports, className, params, registrations, profile, mode) {
  const ctor = params.map((param) => `public ${param.name}: ${param.type}`).join(', ');
  const regs = registrations.map((token) => `{ token: ${token} }`).join(', ');
  return `${fileImports}
export class ${className} { constructor(${ctor}) {} id = 1; }
export const c = defineBuilderConfig({
  injections: [${regs}],
  ${optimization(mode, className)}
  runtime: { profile: '${profile}' },
});
`;
}

function writeFixture(dir, size, shape, profile, mode) {
  mkdirSync(dir, { recursive: true });
  const files = [];
  writeFileSync(path.join(dir, 'contract.ts'), 'export class Shared { tag = 1; }\n');
  const mark = "import { defineBuilderConfig } from '@djodjonx/neosyringe';\n";
  if (shape === 'linear') {
    for (let i = 0; i < size; i += 1) {
      const name = `N${i}`;
      const text = container(
        `${mark}import { Shared } from './contract';`,
        name,
        [{ name: 'dep', type: 'Shared' }],
        ['Shared', name],
        profile,
        mode,
      );
      const file = path.join(dir, `n${i}.ts`);
      writeFileSync(file, text);
      files.push(file);
    }
  } else if (shape === 'diamond') {
    const left = container(`${mark}import { Shared } from './contract';`, 'Left', [{ name: 'dep', type: 'Shared' }], ['Shared', 'Left'], profile, mode);
    const right = container(`${mark}import { Shared } from './contract';`, 'Right', [{ name: 'dep', type: 'Shared' }], ['Shared', 'Right'], profile, mode);
    writeFileSync(path.join(dir, 'left.ts'), left);
    writeFileSync(path.join(dir, 'right.ts'), right);
    files.push(path.join(dir, 'left.ts'), path.join(dir, 'right.ts'));
    for (let i = 0; i < size; i += 1) {
      const name = `L${i}`;
      const text = container(
        `${mark}import { Shared } from './contract';\nimport { Left } from './left';\nimport { Right } from './right';`,
        name,
        [{ name: 'left', type: 'Left' }, { name: 'right', type: 'Right' }],
        ['Shared', 'Left', 'Right', name],
        profile,
        mode,
      );
      const file = path.join(dir, `leaf${i}.ts`);
      writeFileSync(file, text);
      files.push(file);
    }
  } else {
    throw new Error(`forme inconnue: ${shape}`);
  }
  writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'Bundler',
      strict: true,
      noLib: true,
      types: [],
      skipLibCheck: true,
      baseUrl: '.',
      paths: { '@djodjonx/neosyringe': [neosyringeSrc] },
    },
    include: ['**/*.ts'],
  }));
  return {
    files,
    leaf: files[files.length - 1],
    leafClass: shape === 'linear' ? `N${size - 1}` : `L${size - 1}`,
    contract: path.join(dir, 'contract.ts'),
    config: path.join(dir, 'tsconfig.json'),
  };
}

function bump(file, from, to) {
  const text = readFileSync(file, 'utf8');
  if (!text.includes(from)) throw new Error(`motif absent dans ${file}`);
  writeFileSync(file, text.replace(from, to));
}

const externalNames = [
  'typescript',
  'unplugin',
  '@jridgewell/trace-mapping',
  '@djodjonx/neosyringe-core',
  '@djodjonx/neosyringe-ui',
];

function packageRoot(name) {
  const candidates = [
    path.join(root, 'packages/unplugin/node_modules', name),
    path.join(root, 'node_modules', name),
  ];
  for (const candidate of candidates) {
    if (exists(path.join(candidate, 'package.json'))) return candidate;
  }
  throw new Error(`paquet introuvable: ${name}`);
}

function linkExternal(outdir, name) {
  const link = path.join(outdir, 'node_modules', name);
  mkdirSync(path.dirname(link), { recursive: true });
  symlinkSync(packageRoot(name), link);
}

async function loadTools() {
  const outdir = mkdtempSync(path.join(tmpdir(), 't18-bench-bundle-'));
  for (const name of externalNames) linkExternal(outdir, name);
  const outfile = path.join(outdir, 't18-bench.mjs');
  await esbuild.build({
    stdin: {
      contents: [
        `export { neoSyringePlugin } from ${JSON.stringify(path.join(root, 'packages/unplugin/src/index.ts'))};`,
        `export { default as neoSyringeTransformer } from ${JSON.stringify(path.join(root, 'packages/unplugin/src/transformer.ts'))};`,
      ].join('\n'),
      resolveDir: path.join(root, 'packages/unplugin'),
      sourcefile: 't18-bench-entry.ts',
      loader: 'ts',
    },
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile,
    external: externalNames,
    logLevel: 'silent',
  });
  const loaded = await import(pathToFileURL(outfile).href);
  return { outfile, outdir, ...loaded };
}

function compilerOptions() {
  return {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    noLib: true,
    types: [],
    skipLibCheck: true,
    baseUrl: '.',
    paths: { '@djodjonx/neosyringe': [neosyringeSrc] },
  };
}

function timed(run) {
  let peak = process.memoryUsage().rss;
  const sample = () => {
    peak = Math.max(peak, process.memoryUsage().rss);
  };
  const start = performance.now();
  run(sample);
  sample();
  return { ms: performance.now() - start, rss: peak };
}

function generatedText(result, source) {
  if (!result) return source;
  if (typeof result === 'string') return result;
  if (typeof result.code === 'string') return result.code;
  return source;
}

function codeSize(texts) {
  let raw = 0;
  let gzip = 0;
  for (const text of texts) {
    const bytes = Buffer.from(text);
    raw += bytes.length;
    gzip += gzipSync(bytes).length;
  }
  return { raw, gzip };
}

function timeResolve(code, className) {
  const runtime = require(path.join(root, 'packages/neosyringe/dist/index.cjs'));
  const js = ts.transpileModule(code, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exportsObject = {};
  const run = new Function('exports', 'require', js);
  const modules = new Map();
  const localModule = (id) => {
    const cached = modules.get(id);
    if (cached) return cached;
    const values = Object.create(null);
    const mod = new Proxy(values, {
      get(target, prop) {
        if (prop === '__esModule') return true;
        if (typeof prop !== 'string' || prop === 'then') return undefined;
        if (!Object.prototype.hasOwnProperty.call(target, prop)) {
          target[prop] = ({ [prop]: class {} })[prop];
        }
        return target[prop];
      },
    });
    modules.set(id, mod);
    return mod;
  };
  run(exportsObject, (id) => {
    if (id === '@djodjonx/neosyringe') return runtime;
    if (id.startsWith('.')) return localModule(id);
    throw new Error(`module inattendu: ${id}`);
  });
  const token = exportsObject[className];
  const container = exportsObject.c;
  if (!token || !container || typeof container.resolve !== 'function') {
    throw new Error(`conteneur illisible pour ${className}`);
  }
  const firstStart = performance.now();
  const firstValue = container.resolve(token);
  const first = performance.now() - firstStart;
  const later = [];
  for (let i = 0; i < 20; i += 1) {
    const start = performance.now();
    container.resolve(token);
    later.push(performance.now() - start);
  }
  if (!firstValue) throw new Error(`résolution vide pour ${className}`);
  return { first, later: median(later) };
}

function runTransformer(api, fixture, sample) {
  const options = compilerOptions();
  const host = ts.createCompilerHost(options);
  const names = [fixture.contract, ...fixture.files];
  const program = ts.createProgram(names, options, host);
  const created = api.neoSyringeTransformer(program, host, {}, { ts });
  sample();
  return fixture.files.map((file) => {
    const source = created.getSourceFile(file);
    return source ? source.text : readFileSync(file, 'utf8');
  });
}

/** One plugin instance for the three passes. The transformer builds a new session each pass. */
function measureRound(api, spec, dir) {
  const fixture = writeFixture(dir, spec.size, spec.shape, spec.profile, spec.mode);
  let firstTexts = [];
  if (spec.tool === 'unplugin') {
    const cwd = process.cwd();
    process.chdir(path.dirname(fixture.config));
    try {
      const plugin = api.neoSyringePlugin.vite({ project: fixture.config });
      const run = (sample, capture) => {
        const texts = [];
        for (const file of fixture.files) {
          const source = readFileSync(file, 'utf8');
          texts.push(generatedText(plugin.transform.call(undefined, source, file), source));
          sample();
        }
        if (capture) firstTexts = texts;
      };
      const built = timed((sample) => run(sample, true));
      bump(fixture.leaf, 'id = 1', 'id = 2');
      const leafBuilt = timed((sample) => run(sample, false));
      bump(fixture.contract, 'tag = 1', 'tag = 2');
      const sharedBuilt = timed((sample) => run(sample, false));
      const size = codeSize(firstTexts);
      const resolved = timeResolve(firstTexts[firstTexts.length - 1], fixture.leafClass);
      return { built, leafBuilt, sharedBuilt, size, resolved };
    } finally {
      process.chdir(cwd);
    }
  }
  if (spec.tool === 'transformer') {
    const built = timed((sample) => { firstTexts = runTransformer(api, fixture, sample); });
    bump(fixture.leaf, 'id = 1', 'id = 2');
    const leafBuilt = timed((sample) => { runTransformer(api, fixture, sample); });
    bump(fixture.contract, 'tag = 1', 'tag = 2');
    const sharedBuilt = timed((sample) => { runTransformer(api, fixture, sample); });
    const size = codeSize(firstTexts);
    const resolved = timeResolve(firstTexts[firstTexts.length - 1], fixture.leafClass);
    return { built, leafBuilt, sharedBuilt, size, resolved };
  }
  throw new Error(`outil inconnu: ${spec.tool}`);
}

function measureCell(api, spec) {
  const first = [];
  const leaf = [];
  const shared = [];
  const rss = [];
  const codeBytes = [];
  const gzipBytes = [];
  const resolveFirst = [];
  const resolveLater = [];
  const rounds = reps + 1;
  for (let round = 0; round < rounds; round += 1) {
    const dir = mkdtempSync(path.join(tmpdir(), 't18-bench-'));
    try {
      const measured = measureRound(api, spec, dir);
      if (round === 0) continue;
      first.push(measured.built.ms);
      leaf.push(measured.leafBuilt.ms);
      shared.push(measured.sharedBuilt.ms);
      rss.push(Math.max(measured.built.rss, measured.leafBuilt.rss, measured.sharedBuilt.rss));
      codeBytes.push(measured.size.raw);
      gzipBytes.push(measured.size.gzip);
      resolveFirst.push(measured.resolved.first);
      resolveLater.push(measured.resolved.later);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  return { first, leaf, shared, rss, codeBytes, gzipBytes, resolveFirst, resolveLater };
}

function row(spec, metric, values) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const mid = median(values);
  const fmt = (value) => {
    if (metric.startsWith('resolve_')) return value.toFixed(3);
    if (metric.endsWith('_ms')) return value.toFixed(1);
    return String(Math.round(value));
  };
  return [spec.size, spec.shape, spec.profile, spec.mode, spec.tool, metric, fmt(mid), fmt(min), fmt(max)].join('\t');
}

const cpu = os.cpus()[0]?.model ?? 'unknown';
console.log(`# node ${process.version}`);
console.log(`# typescript ${ts.version}`);
console.log(`# @djodjonx/neosyringe ${readVersion(path.join(root, 'packages/neosyringe/package.json'))}`);
console.log(`# @djodjonx/neosyringe-plugin ${readVersion(path.join(root, 'packages/unplugin/package.json'))}`);
console.log(`# @djodjonx/neosyringe-core ${readVersion(path.join(root, 'packages/core/package.json'))}`);
console.log(`# cpu ${cpu} x${os.cpus().length}`);
console.log(`# ram_bytes ${os.totalmem()}`);
console.log(`# os ${os.type()} ${os.release()} ${os.platform()}`);
console.log(`# reps ${reps} warmup 1`);
console.log('# size\tshape\tprofile\tmode\ttool\tmetric\tmedian\tmin\tmax');

let loaded;
const stop = () => {
  if (loaded?.outdir) rmSync(loaded.outdir, { recursive: true, force: true });
};
process.on('SIGINT', () => { stop(); process.exit(130); });
process.on('SIGTERM', () => { stop(); process.exit(143); });
try {
  loaded = await loadTools();
  for (const size of sizes) {
    for (const shape of shapes) {
      for (const profile of profiles) {
        for (const mode of modes) {
          for (const tool of tools) {
            const spec = { size, shape, profile, mode, tool };
            const measured = measureCell(loaded, spec);
            console.log(row(spec, 'first_ms', measured.first));
            console.log(row(spec, 'leaf_ms', measured.leaf));
            console.log(row(spec, 'shared_ms', measured.shared));
            console.log(row(spec, 'rss_bytes', measured.rss));
            console.log(row(spec, 'code_bytes', measured.codeBytes));
            console.log(row(spec, 'code_gzip_bytes', measured.gzipBytes));
            console.log(row(spec, 'resolve_first_ms', measured.resolveFirst));
            console.log(row(spec, 'resolve_later_ms', measured.resolveLater));
          }
        }
      }
    }
  }
} finally {
  stop();
}
