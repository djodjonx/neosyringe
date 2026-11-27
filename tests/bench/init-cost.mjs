// Bench of the bounded concurrent initialization (topic 11): the shape `init`, 10000 async steps.
// A bench suite, never a unit suite: it reads the clock and the heap. Build happens here; the worker only runs the
// emitted container. Dist is already built (`pnpm build`), like tests/bench/runtime-cost.mjs.
//
//   node tests/bench/init-cost.mjs
//   NEOSYRINGE_BENCH_INIT_SIZE=10000 NEOSYRINGE_BENCH_INIT_CONCURRENCY=1,4,16 node tests/bench/init-cost.mjs
//
// Every step resolves at once, so the time is the cost of scheduling the steps and the heap is what the scheduler keeps
// while it runs. Metrics, per concurrency:
// - `init-schedule-ms`: wall time of `await box.initialize()`, in ms.
// - `init-heap-mb`: heap still held after the initialization and a GC, minus the heap before it, in MB.
// The report is a JSON line: the median of the per-process medians, and every sample.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import path from 'node:path';

const root = repoRoot();
const require = createRequire(path.join(root, 'packages/unplugin/package.json'));
const { Analyzer } = require('@djodjonx/neosyringe-core/analyzer');
const { Generator } = require('@djodjonx/neosyringe-core/generator');
const ts = require('typescript');

const size = numberEnv('NEOSYRINGE_BENCH_INIT_SIZE', 10000);
const concurrencies = (process.env.NEOSYRINGE_BENCH_INIT_CONCURRENCY || '1,4,16').split(',').map((part) => Number(part.trim()));
const processes = numberEnv('NEOSYRINGE_BENCH_PROCESSES', 5);
const samples = numberEnv('NEOSYRINGE_BENCH_SAMPLES', 7);

for (const value of concurrencies) {
  if (!Number.isInteger(value) || value < 1) throw new Error('NEOSYRINGE_BENCH_INIT_CONCURRENCY requires integers >= 1');
}

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

function numberEnv(name, fallback) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} requires integers >= 1`);
  return value;
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** `size` independent async steps, each one a class token with an async factory, and the container that bounds them. */
function sourceOf(concurrency) {
  const classes = Array.from({ length: size }, (_, index) => `export class S${index} { value = ${index}; }`);
  const injections = Array.from({ length: size }, (_, index) =>
    `{ token: S${index}, useFactory: true, dependencies: [], provider: async () => new S${index}() }`);
  return `import { defineBuilderConfig } from '@djodjonx/neosyringe';
${classes.join('\n')}
export const box = defineBuilderConfig({
  name: 'init',
  optimization: { mode: 'open' },
  runtime: { profile: 'full' },
  initialization: { concurrency: ${concurrency} },
  injections: [${injections.join(', ')}],
});
`;
}

function programOf(source) {
  const fileName = '/virtual/neosyringe-init-bench.ts';
  const stubName = '/virtual/neosyringe-marker-stub.ts';
  const options = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, strict: true, noImplicitAny: false };
  const sources = new Map([
    [fileName, source],
    [stubName, 'export function defineBuilderConfig<T>(config: T): T { return config; }'],
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

/** The module of one case: the user classes, the container class, and `create()`. */
function moduleOf(concurrency) {
  const source = sourceOf(concurrency);
  const graphs = new Analyzer(programOf(source)).extractAll();
  const graph = graphs.find((item) => item.exportedVariableName === 'box');
  if (!graph) throw new Error('no container');
  const messages = (graph.errors ?? []).filter((error) => error.severity !== 'warning').map((error) => error.message);
  if (messages.length > 0) throw new Error(messages.join('\n'));
  if (graph.initializationConcurrency !== undefined && graph.initializationConcurrency !== concurrency) {
    throw new Error(`the analyzer read concurrency ${graph.initializationConcurrency}, not ${concurrency}`);
  }
  const generator = new Generator(graph, true, undefined, false, false);
  const code = generator.generate().replace(/import \* as __neo_Import_\d+ from '\.\/neosyringe-init-bench';\s*/g, '').replace(/__neo_Import_\d+\./g, '');
  const body = source
    .slice(0, graph.variableStatementStart).concat(source.slice(graph.defineBuilderConfigEnd))
    .replace(/import\s*\{[^}]*\}\s*from\s*'@djodjonx\/neosyringe';\s*/g, '');
  const js = ts.transpileModule(`${body}\n${code}\n`, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return `${js}\nexport function create() { return ${generator.generateInstantiation()}; }\nexport const steps = ${size};\n`;
}

const WORKER = `
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
const loaded = await import(pathToFileURL(process.argv[2]).href);
const samples = Number(process.argv[3]);
const gc = globalThis.gc;
if (typeof gc !== 'function') throw new Error('run with --expose-gc');
const times = [];
const heaps = [];
for (let index = 0; index < samples; index += 1) {
  const box = loaded.create();
  gc();
  const before = process.memoryUsage().heapUsed;
  const started = performance.now();
  await box.initialize();
  times.push(performance.now() - started);
  gc();
  heaps.push((process.memoryUsage().heapUsed - before) / 1048576);
  if (box.resolve(loaded.S0) === undefined) throw new Error('the first step is not ready');
  await box.destroy();
}
process.stdout.write(JSON.stringify({ times, heaps }) + '\\n');
`;

const work = mkdtempSync(path.join(os.tmpdir(), 'neosyringe-init-'));
const cases = [];
try {
  const worker = path.join(work, 'worker.mjs');
  writeFileSync(worker, WORKER);
  for (const concurrency of concurrencies) {
    const file = path.join(work, `init-${concurrency}.mjs`);
    writeFileSync(file, moduleOf(concurrency));
    const runs = [];
    for (let index = 0; index < processes; index += 1) {
      const run = spawnSync(process.execPath, ['--expose-gc', worker, file, String(samples)], { encoding: 'utf8', cwd: root });
      if (run.status !== 0) throw new Error((run.stderr || run.stdout || 'worker failed').trim());
      const line = run.stdout.trim().split('\n').findLast((item) => item.startsWith('{'));
      if (!line) throw new Error('worker returned no report');
      runs.push(JSON.parse(line));
    }
    const metric = (unit, pick) => ({ unit, median: median(runs.map((run) => median(pick(run)))), processes: runs.map(pick) });
    cases.push({
      shape: 'init',
      size,
      concurrency,
      metrics: {
        'init-schedule-ms': metric('ms', (run) => run.times),
        'init-heap-mb': metric('MB', (run) => run.heaps),
      },
    });
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log(JSON.stringify({
  environment: { node: process.version, typescript: ts.version, cpu: os.cpus()[0]?.model ?? 'unknown', cores: os.cpus().length },
  params: { shape: 'init', size, concurrencies, processes, samples },
  cases,
}));
