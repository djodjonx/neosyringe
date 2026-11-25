// Factory cost bench (topic 14). One declared factory, resolved or initialized many times.
// Matrix: dependencies 0/1/8/10/64, transient and singleton, sync and async, full and minimal.
// A transient is measured by resolve. A singleton by createScope + resolve (sync) or createScope + initialize
// (async), because a cached singleton never calls its factory again.
// Per case: ns/op and heap bytes/op. Bytes/op is the heapUsed delta of a batch with no GC inside it: the worker
// runs with a large semi-space so a batch of at most BATCH_CAP operations is not collected. A PerformanceObserver
// on 'gc' entries is flushed (one setImmediate, then takeRecords) before the batch and right after the heap is read:
// a batch with any collection entry, or a negative delta, gives no bytes/op sample and is counted in `dropped`
// (the output column and the report). ns/op keeps the sample: it is a minimum-based timing, not a heap delta.
// The build happens here, outside the worker clock. The worker imports one built module and measures one case.
// The functional check runs before any sample: a wrong value stops the case.
// Core dist: NEOSYRINGE_BENCH_CORE_DIST (default packages/core/dist), so a baseline dist can be compared.
// Smoke run: NEOSYRINGE_BENCH_PROCESSES=1 NEOSYRINGE_BENCH_SAMPLES=1 node tests/bench/factory-cost.mjs
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import path from 'node:path';
import { PerformanceObserver, performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sampleMinimumNs, summarize, timerResolutionNs } from './lib/measure.mjs';

const BATCH_CAP = 20_000;
const self = fileURLToPath(import.meta.url);

function repoRoot() {
  let dir = path.resolve(path.dirname(self));
  for (;;) {
    try {
      readFileSync(path.join(dir, 'pnpm-workspace.yaml'));
      return dir;
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) throw new Error('racine du dépôt introuvable');
      dir = parent;
    }
  }
}

function listEnv(name, fallback) {
  return (process.env[name] || fallback).split(',').map((part) => part.trim()).filter(Boolean);
}

function numberEnv(name, fallback) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} requires integers >= 1`);
  return value;
}

function exit(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------------------------------------------
// Worker: one case, one process.
// ---------------------------------------------------------------------------------------------------------------

async function runWorker(file, spec) {
  const samples = numberEnv('NEOSYRINGE_BENCH_SAMPLES', 7);
  const loaded = await import(pathToFileURL(file).href);
  const box = loaded.createBox();
  const token = loaded.madeToken;
  const gc = () => { globalThis.gc?.(); };
  // A collection entry is queued to the main thread after the collection: one setImmediate lets it arrive.
  const collections = new PerformanceObserver(() => {});
  collections.observe({ entryTypes: ['gc'] });
  const settled = async () => {
    await new Promise((resolve) => setImmediate(resolve));
    return collections.takeRecords().length;
  };
  const scopes = [];
  const sync = spec.kind === 'sync';
  const transient = spec.lifecycle === 'transient';
  if (!sync) await box.initialize();
  else if (typeof box.initialize === 'function') await box.initialize();
  const check = (made) => {
    if (!made || made.value !== 0 || made.reads !== spec.deps) throw new Error('wrong factory result');
  };
  // One operation: the factory runs once.
  const one = () => {
    if (sync && transient) return box.resolve(token);
    const scope = box.createScope();
    scopes.push(scope);
    return scope.resolve(token);
  };
  const oneAsync = async () => {
    const scope = box.createScope();
    scopes.push(scope);
    await scope.initialize();
    return scope.resolve(token);
  };
  const release = async () => {
    for (const scope of scopes.splice(0)) await scope.destroy();
  };
  const batch = async (k) => {
    gc();
    // The explicit collection above, and any earlier one, are not part of this batch.
    await settled();
    const before = process.memoryUsage().heapUsed;
    const started = performance.now();
    let last;
    if (sync) for (let index = 0; index < k; index += 1) last = one();
    else for (let index = 0; index < k; index += 1) last = await oneAsync();
    const elapsedNs = (performance.now() - started) * 1e6;
    const delta = process.memoryUsage().heapUsed - before;
    const collected = await settled();
    check(last);
    await release();
    return { elapsedNs, bytes: collected === 0 && delta >= 0 ? delta / k : undefined };
  };
  // Functional check, before any sample.
  check(sync ? one() : await oneAsync());
  await release();
  const minimumNs = sampleMinimumNs(timerResolutionNs());
  let k = 1;
  for (;;) {
    const probe = await batch(k);
    if (probe.elapsedNs >= minimumNs * 2 || k >= BATCH_CAP) break;
    k = Math.min(BATCH_CAP, k * 10);
  }
  const ns = [];
  const bytes = [];
  let dropped = 0;
  for (let sample = -2; sample < samples; sample += 1) {
    const taken = await batch(k);
    if (sample < 0) continue;
    ns.push(taken.elapsedNs / k);
    if (taken.bytes === undefined) dropped += 1;
    else bytes.push(taken.bytes);
  }
  collections.disconnect();
  process.stdout.write(`${JSON.stringify({ k, ns, bytes, dropped })}\n`);
}

// ---------------------------------------------------------------------------------------------------------------
// Build: one module per case, outside any clock.
// ---------------------------------------------------------------------------------------------------------------

function fixtureSource(spec) {
  const names = Array.from({ length: spec.deps }, (_, index) => `D${index}`);
  const classes = names.map((name) => `export class ${name} { value = 0; }`);
  const reads = names.map((name) => `reads += 1; sum += ctx.resolve(${name}).value;`).join(' ');
  const body = `let sum = 0; let reads = 0; ${reads} return { value: sum, reads };`;
  const provider = spec.kind === 'async' ? `async (ctx) => { ${body} }` : `(ctx) => { ${body} }`;
  const lifecycle = spec.lifecycle === 'transient' ? "lifecycle: 'transient'," : '';
  return `import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';
${classes.join('\n')}
/* bench-strip:start */
export interface Made { value: number; reads: number }
const made = useInterface<Made>();
/* bench-strip:end */
export const box = defineBuilderConfig({
  name: 'FactoryBench',
  runtime: { profile: '${spec.profile}' },
  injections: [
    ${names.map((name) => `{ token: ${name} },`).join('\n    ')}
    { token: made, ${lifecycle} useFactory: true, dependencies: [${names.join(', ')}], provider: ${provider} },
  ],
});
`;
}

async function loadCore(root, distDir) {
  const require = createRequire(path.join(root, 'packages/unplugin/package.json'));
  const ts = require('typescript');
  const analyzer = await import(pathToFileURL(path.join(distDir, 'analyzer/index.mjs')).href);
  const generator = await import(pathToFileURL(path.join(distDir, 'generator/index.mjs')).href);
  return { ts, Analyzer: analyzer.Analyzer, Generator: generator.Generator, GraphValidator: generator.GraphValidator };
}

function programOf(ts, source) {
  const fileName = '/virtual/neosyringe-factory-bench.ts';
  const stubName = '/virtual/neosyringe-marker-stub.ts';
  const options = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, strict: true, noImplicitAny: false };
  const sources = new Map([
    [fileName, source],
    [stubName, [
      'export function defineBuilderConfig<T>(config: T): T { return config; }',
      'export function useInterface<T>(): T { return undefined as T; }',
    ].join('\n')],
  ]);
  const host = ts.createCompilerHost(options);
  const read = host.getSourceFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  host.getSourceFile = (name, languageVersion, onError, shouldCreateNewSourceFile) => {
    const text = sources.get(name);
    if (text !== undefined) return ts.createSourceFile(name, text, languageVersion, true);
    return read(name, languageVersion, onError, shouldCreateNewSourceFile);
  };
  host.fileExists = (name) => sources.has(name) || fileExists(name);
  host.resolveModuleNames = (moduleNames, containingFile) => moduleNames.map((moduleName) => {
    if (moduleName === '@djodjonx/neosyringe') {
      return { resolvedFileName: stubName, extension: ts.Extension.Ts, isExternalLibraryImport: false };
    }
    return ts.resolveModuleName(moduleName, containingFile, options, host).resolvedModule;
  });
  return ts.createProgram([fileName], options, host);
}

function buildModule(core, spec) {
  const text = fixtureSource(spec);
  const graphs = new core.Analyzer(programOf(core.ts, text)).extractAll();
  const graph = graphs[0];
  if (!graph) throw new Error('no container');
  const messages = [...(graph.errors ?? [])].filter((error) => error.severity !== 'warning').map((error) => error.message);
  const validation = new core.GraphValidator().validateAll(graph);
  if (!validation.valid) messages.push(...validation.errors.map((error) => error.message));
  if (messages.length > 0) throw new Error(messages.join('\n'));
  const generator = new core.Generator(graph, true, undefined, false, false);
  const start = graph.variableStatementStart;
  const end = graph.defineBuilderConfigEnd;
  if (start === undefined || end === undefined) throw new Error('missing container position');
  const body = `${text.slice(0, start)}${text.slice(end)}`
    .replace(/import\s*\{[^}]*\}\s*from\s*'@djodjonx\/neosyringe';\s*/g, '')
    .replace(/\/\* bench-strip:start \*\/[\s\S]*?\/\* bench-strip:end \*\//g, '');
  const tokenId = [...graph.nodes.keys()].find((key) => key.startsWith('Made_'));
  if (!tokenId) throw new Error('missing token');
  const code = `${body}\n${generator.generate()}\n`
    .replace(/import \* as __neo_Import_\d+ from '[^']*';\s*/g, '')
    .replace(/__neo_Import_\d+\./g, '');
  const js = core.ts.transpileModule(code, {
    compilerOptions: { module: core.ts.ModuleKind.ESNext, target: core.ts.ScriptTarget.ES2022 },
  }).outputText;
  return `${js}\nexport function createBox() { return ${generator.generateInstantiation()}; }\nexport const madeToken = ${JSON.stringify(tokenId)};\n`;
}

// ---------------------------------------------------------------------------------------------------------------
// Orchestrator.
// ---------------------------------------------------------------------------------------------------------------

function runCase(file, spec) {
  const run = spawnSync(
    process.execPath,
    ['--expose-gc', '--min-semi-space-size=256', '--max-semi-space-size=256', self, '--worker', file, JSON.stringify(spec)],
    { encoding: 'utf8', env: { ...process.env } },
  );
  if (run.status !== 0) throw new Error((run.stderr || run.stdout || 'worker failed').trim());
  const line = run.stdout.trim().split('\n').findLast((item) => item.startsWith('{'));
  if (!line) throw new Error('worker returned no report');
  return JSON.parse(line);
}

function median(values) {
  return values.length === 0 ? Number.NaN : summarize(values).median;
}

async function main() {
  const root = repoRoot();
  const distDir = path.resolve(root, process.env.NEOSYRINGE_BENCH_CORE_DIST || 'packages/core/dist');
  const depsList = listEnv('NEOSYRINGE_BENCH_DEPS', '0,1,8,10,64').map(Number);
  const kinds = listEnv('NEOSYRINGE_BENCH_KINDS', 'sync,async');
  const lifecycles = listEnv('NEOSYRINGE_BENCH_LIFECYCLES', 'transient,singleton');
  const profiles = listEnv('NEOSYRINGE_BENCH_PROFILES', 'full,minimal');
  const processes = numberEnv('NEOSYRINGE_BENCH_PROCESSES', 5);
  for (const deps of depsList) if (!Number.isInteger(deps) || deps < 0) exit('NEOSYRINGE_BENCH_DEPS requires integers >= 0');
  const core = await loadCore(root, distDir);
  const dir = mkdtempSync(path.join(os.tmpdir(), 'neosyringe-factory-bench-'));
  const rows = [];
  try {
    for (const kind of kinds) {
      for (const lifecycle of lifecycles) {
        // An async factory is pre-initialized once per container or scope: it is always a singleton.
        if (kind === 'async' && lifecycle === 'transient') continue;
        for (const profile of profiles) {
          for (const deps of depsList) {
            const spec = { kind, lifecycle, profile, deps };
            const file = path.join(dir, `case-${kind}-${lifecycle}-${profile}-${deps}.mjs`);
            writeFileSync(file, buildModule(core, spec));
            const ns = [];
            const bytes = [];
            let dropped = 0;
            let k = 0;
            for (let index = 0; index < processes; index += 1) {
              const report = runCase(file, spec);
              k = report.k;
              ns.push(...report.ns);
              bytes.push(...report.bytes);
              dropped += report.dropped;
            }
            rows.push({ ...spec, k, nsPerOp: median(ns), bytesPerOp: median(bytes), samples: ns.length, dropped });
          }
        }
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const header = ['kind', 'lifecycle', 'profile', 'deps', 'k', 'ns/op', 'bytes/op', 'samples', 'dropped'];
  const lines = rows.map((row) => [
    row.kind, row.lifecycle, row.profile, row.deps, row.k, row.nsPerOp.toFixed(1),
    // Every sample of the case saw a collection: there is no bytes/op to give.
    Number.isNaN(row.bytesPerOp) ? 'n/a' : row.bytesPerOp.toFixed(1), row.samples, row.dropped,
  ].join('\t'));
  process.stdout.write(`${header.join('\t')}\n${lines.join('\n')}\n`);
  const reportPath = process.env.NEOSYRINGE_BENCH_FACTORY_REPORT;
  if (reportPath) writeFileSync(path.resolve(reportPath), `${JSON.stringify({ distDir, processes, rows }, null, 2)}\n`);
}

const workerFlag = process.argv.indexOf('--worker');
if (workerFlag >= 0) {
  await runWorker(process.argv[workerFlag + 1], JSON.parse(process.argv[workerFlag + 2]));
} else {
  await main();
}
