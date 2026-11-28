// Alias bench (topic 20). What a read of `useExisting` costs next to a relay factory and next to a read of the target.
// The containers are produced by the Analyzer and the Generator of the built packages. Build first: the bench refuses
// a dist that is older than the sources it reads. Every case is its own worker process (alias-worker.mjs), the way
// runtime-cost.mjs runs its cases: no case shares a `resolve` call site or a JIT state with another, and nothing is
// timed before the functional check of the case passed.
//
// Cases: a target `Engine` read directly; an alias of it (`{ token, useExisting }`), alone and as a chain of
// NEOSYRINGE_BENCH_DEPTH links (class tokens, so a copied factory reads the same token); a relay factory of it (`{ token, useFactory, dependencies, provider: ctx => ctx.resolve(...) }`),
// alone and as a chain. Each in the full/open and the minimal/closed container, singleton and transient.
// A sample is one batch of NEOSYRINGE_BENCH_COUNT `resolve` calls of the last token, in ns per call. The run is
// NEOSYRINGE_BENCH_ROUNDS rounds; in a round every case runs once in a fresh process (NEOSYRINGE_BENCH_SAMPLES samples
// after 2 warm-up batches), and the order of the cases is rotated every round so a drift of the machine does not belong
// to one case. The report carries the git SHA and the dirty flag, the load average before and after, and the machine.
// This is a measure, not a promise: the numbers are those of one machine and one run (docs/benchmarks/topic-20-alias.md).
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = repoRoot();
const require = createRequire(path.join(root, 'packages/unplugin/package.json'));
assertFresh();
const { Analyzer } = require('@djodjonx/neosyringe-core/analyzer');
const { Generator } = require('@djodjonx/neosyringe-core/generator');
const ts = require('typescript');

const depth = numberEnv('NEOSYRINGE_BENCH_DEPTH', 10);
const samples = numberEnv('NEOSYRINGE_BENCH_SAMPLES', 5);
const rounds = numberEnv('NEOSYRINGE_BENCH_ROUNDS', 3);
const count = numberEnv('NEOSYRINGE_BENCH_COUNT', 1_000_000);
const worker = path.join(path.dirname(fileURLToPath(import.meta.url)), 'alias-worker.mjs');

function repoRoot() {
  let dir = path.resolve(process.cwd());
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

/** The newest mtime of a source file under `dir`. */
function newestSource(dir) {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestSource(entryPath) : statSync(entryPath).mtimeMs);
  }
  return newest;
}

/** The bench reads the built core: a dist older than the source it was built from measures another tree. */
function assertFresh() {
  const sources = newestSource(path.join(root, 'packages/core/src'));
  for (const entry of ['@djodjonx/neosyringe-core/analyzer', '@djodjonx/neosyringe-core/generator']) {
    const built = require.resolve(entry);
    if (statSync(built).mtimeMs < sources) throw new Error(`${built} is older than packages/core/src: run pnpm build first`);
  }
}

function numberEnv(name, fallback) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} requires integers >= 1`);
  return value;
}

const HEAD = `
import { defineBuilderConfig } from '@djodjonx/neosyringe';
declare function defineBuilderConfig<T>(config: T): T;
`;

/** `links` class tokens in a chain over `Engine`, as aliases or as relay factories. */
function sourceOf({ kind, links, profile, mode, lifecycle }) {
  const tokens = Array.from({ length: links }, (_, index) => index);
  const classes = tokens.map((index) => `export class P${index} { readonly id: string = 'engine'; }`).join('\n');
  const target = lifecycle === 'transient' ? "{ token: Engine, lifecycle: 'transient' }," : '{ token: Engine },';
  const registrations = tokens.map((index) => {
    const previous = index === 0 ? 'Engine' : `P${index - 1}`;
    if (kind === 'alias') return `{ token: P${index}, useExisting: ${previous} },`;
    const life = lifecycle === 'transient' ? " lifecycle: 'transient'," : '';
    return `{ token: P${index}, useFactory: true, dependencies: [${previous}], ownership: 'borrowed',${life} provider: (ctx) => ctx.resolve(${previous}) },`;
  });
  const last = links === 0 ? 'Engine' : `P${links - 1}`;
  const roots = mode === 'closed' ? `optimization: { mode: 'closed', roots: [${last}, Engine] },` : '';
  return `${HEAD}
export class Engine { readonly id = 'engine'; }
${classes}
export const box = defineBuilderConfig({
  name: 'AliasBench',
  runtime: { profile: '${profile}' },
  ${roots}
  injections: [
    ${target}
    ${registrations.join('\n    ')}
  ],
});
`;
}

let fileCounter = 0;
const workDir = mkdtempSync(path.join(os.tmpdir(), 'neosyringe-alias-bench-'));

function compile(source) {
  fileCounter += 1;
  const fileName = `/virtual/alias-bench/case-${fileCounter}.ts`;
  const options = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, strict: true, noImplicitAny: false };
  const host = ts.createCompilerHost(options);
  const read = host.getSourceFile.bind(host);
  host.getSourceFile = (name, languageVersion, onError, shouldCreate) =>
    name === fileName ? ts.createSourceFile(name, source, languageVersion, true) : read(name, languageVersion, onError, shouldCreate);
  const fileExists = host.fileExists.bind(host);
  host.fileExists = (name) => name === fileName || fileExists(name);
  const program = ts.createProgram([fileName], options, host);
  const graphs = new Analyzer(program).extractAll().filter((graph) => graph.sourceFileName === fileName);
  const graph = graphs[0];
  if (!graph) throw new Error('missing graph');
  const generator = new Generator(graph, true, undefined, false, false);
  const generated = generator.generate();
  const start = graph.variableStatementStart;
  const end = graph.defineBuilderConfigEnd;
  const code = `${source.slice(0, start)}${generated}\nexport const box = ${generator.generateInstantiation()};${source.slice(end)}`;
  const js = ts.transpileModule(code.replace(/import\s*\{[^}]*\}\s*from\s*'@djodjonx\/neosyringe';\s*/g, ''), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const file = path.join(workDir, `case-${fileCounter}.cjs`);
  writeFileSync(file, js);
  return { file, bytes: Buffer.byteLength(generated) };
}

/** The export a case reads: the last link of the chain, or the target itself. */
function tokenNameOf(links) {
  return links === 0 ? 'Engine' : `P${links - 1}`;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

const cases = [];
for (const [profile, mode] of [['full', 'open'], ['minimal', 'closed']]) {
  for (const lifecycle of ['singleton', 'transient']) {
    const variants = [
      { label: 'target', kind: 'alias', links: 0 },
      { label: 'alias x1', kind: 'alias', links: 1 },
      { label: `alias x${depth}`, kind: 'alias', links: depth },
      { label: 'relay x1', kind: 'relay', links: 1 },
      { label: `relay x${depth}`, kind: 'relay', links: depth },
    ];
    for (const variant of variants) {
      const spec = { ...variant, profile, mode, lifecycle };
      const name = `${profile}/${mode} ${lifecycle} ${variant.label}`;
      cases.push({ ...spec, name, ...compile(sourceOf(spec)), samples: [] });
    }
  }
}

function git(args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

/** One case in a process of its own: the worker checks the container, warms up, takes the samples. */
function runWorker(item) {
  const run = spawnSync(process.execPath, [worker, item.file, tokenNameOf(item.links), item.lifecycle, item.name], {
    encoding: 'utf8',
    env: { ...process.env, NEOSYRINGE_BENCH_SAMPLES: String(samples), NEOSYRINGE_BENCH_COUNT: String(count) },
  });
  if (run.status !== 0) throw new Error(`${item.name}: ${(run.stderr || run.stdout || 'worker failed').trim()}`);
  const line = run.stdout.trim().split('\n').pop();
  const report = JSON.parse(line ?? '');
  if (report.name !== item.name || !Array.isArray(report.samples)) throw new Error(`${item.name}: unexpected worker report`);
  return report.samples;
}

const loadBefore = os.loadavg().map((value) => value.toFixed(2)).join(' ');
try {
  for (let round = 0; round < rounds; round += 1) {
    for (let offset = 0; offset < cases.length; offset += 1) {
      const item = cases[(offset + round) % cases.length];
      item.samples.push(...runWorker(item));
    }
  }
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
const loadAfter = os.loadavg().map((value) => value.toFixed(2)).join(' ');

const header = `| config | lifecycle | case | ns per read (median) | min | x target | generated bytes |
| --- | --- | --- | --- | --- | --- | --- |`;
const rows = cases.map((item) => {
  const base = cases.find((other) => other.profile === item.profile && other.lifecycle === item.lifecycle && other.label === 'target');
  const middle = median(item.samples);
  return `| ${item.profile}/${item.mode} | ${item.lifecycle} | ${item.label} | ${middle.toFixed(1)} | ${Math.min(...item.samples).toFixed(1)} | ${(middle / median(base.samples)).toFixed(2)} | ${item.bytes} |`;
});
process.stdout.write([
  `alias-cost: depth=${depth} rounds=${rounds} samples=${samples} count=${count} (one process per case and round)`,
  `source: git ${git(['rev-parse', 'HEAD'])} dirty=${git(['status', '--porcelain']).length > 0}`,
  `machine: ${os.cpus()[0]?.model ?? 'unknown'} x${os.cpus().length}, ${os.platform()} ${os.arch()}, node ${process.version}, typescript ${ts.version}`,
  `load average (1 5 15 min) before: ${loadBefore}; after: ${loadAfter}`,
  '',
  header,
  ...rows,
  '',
].join('\n'));
