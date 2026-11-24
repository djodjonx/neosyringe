// Runtime bench. Build happens here, outside the worker clock.
// The worker does not load esbuild or the compiler. Dist is already built.
// Emitter stays undefined so optimized is chosen iff minimal or closed
// (packages/core/src/generator/Generator.ts:201-204).
// Open mode cannot list roots (packages/core/src/analyzer/parsers/ConfigParser.ts:604-616).
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { gzipSync } from 'node:zlib';
import { makeOrder, summarize } from './lib/measure.mjs';

const root = repoRoot();
const require = createRequire(path.join(root, 'packages/unplugin/package.json'));
const { Analyzer } = require('@djodjonx/neosyringe-core/analyzer');
const { Generator, GraphValidator } = require('@djodjonx/neosyringe-core/generator');
const esbuild = require('esbuild');
const ts = require('typescript');

const sizes = numbers('NEOSYRINGE_BENCH_SIZES', '10,100,1000,5000');
const shapes = listEnv('NEOSYRINGE_BENCH_SHAPES', 'flat,chain,diamond,multi,parent');
const profiles = listEnv('NEOSYRINGE_BENCH_PROFILES', 'full,minimal');
const modes = listEnv('NEOSYRINGE_BENCH_MODES', 'open,closed');
const processes = numberEnv('NEOSYRINGE_BENCH_PROCESSES', 5);
const samples = numberEnv('NEOSYRINGE_BENCH_SAMPLES', 7);
const resolveCount = numberEnv('NEOSYRINGE_BENCH_RESOLVE_COUNT', 100_000);
const resolveBatches = numberEnv('NEOSYRINGE_BENCH_RESOLVE_BATCHES', 7);
const worker = path.join(root, 'tests/bench/runtime-worker.mjs');
const knownShapes = new Set(['flat', 'chain', 'diamond', 'multi', 'parent']);
const knownProfiles = new Set(['full', 'minimal']);
const knownModes = new Set(['open', 'closed']);

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
    if (!Number.isInteger(value) || value < 1) throw new Error(`${name} requires integers >= 1`);
    return value;
  });
}

function numberEnv(name, fallback) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} requires integers >= 1`);
  return value;
}

function git(args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function checksumOf(size, count) {
  const order = makeOrder(size, count);
  let sum = 0;
  for (const index of order) sum += index;
  return sum;
}

// Multi calls resolveAll, which builds n contributions. Scale the batch down and divide by n.
function resolveCountFor(shape, size) {
  if (shape !== 'multi') return resolveCount;
  return Math.max(256, Math.floor(50_000 / size));
}

function readyClassOf(className) {
  return `export class ${className} { value = -1; disposed = 0; ready = false; dispose(): void { this.disposed += 1; } }`;
}

function readyInjection(className) {
  return `{ token: ${className}, useFactory: true, dependencies: [], provider: async () => { const instance = new ${className}(); instance.ready = true; await Promise.resolve(); return instance; } }`;
}

const harnessChecks = `
function assertReady(container, token) {
  const ready = container.resolve(token);
  if (!ready || ready.ready !== true) throw new Error('async service not ready');
}
function assertDisposed(instances) {
  if (!Array.isArray(instances) || instances.length === 0 || instances.some((instance) => instance.disposed !== 1)) {
    throw new Error('destroy did not dispose instance');
  }
}`;

function injectionList(entries, tokenName) {
  const rows = [...entries, readyInjection(tokenName)];
  if (process.env.NEOSYRINGE_BENCH_BROKEN === '1') rows.push(`{ token: ${tokenName} }`);
  return rows;
}

function classText(name, index, deps) {
  const ctor = deps.length === 0
    ? ''
    : `constructor(${deps.map((dep, slot) => `public d${slot}: ${dep}`).join(', ')}) {}`;
  return `export class ${name} { value = ${index}; disposed = 0; ${ctor} dispose(): void { this.disposed += 1; } }`;
}

function configText(exportName, containerName, injections, profile, mode, roots, legacy) {
  const optimization = mode === 'closed'
    ? `optimization: { mode: 'closed', roots: [${roots}] },`
    : `optimization: { mode: 'open' },`;
  const parentLine = legacy ? `useContainer: ${legacy},` : '';
  return `export const ${exportName} = defineBuilderConfig({
  name: '${containerName}',
  ${parentLine}
  ${optimization}
  runtime: { profile: '${profile}' },
  injections: [${injections.join(', ')}],
});`;
}

function nodesFor(shape, size) {
  if (!knownShapes.has(shape)) throw new Error(`unknown shape: ${shape}`);
  if (shape === 'flat') {
    return { kind: 'single', nodes: Array.from({ length: size }, (_, index) => ({ name: `S${index}`, index, deps: [] })) };
  }
  if (shape === 'chain') {
    return {
      kind: 'single',
      nodes: Array.from({ length: size }, (_, index) => ({
        name: `S${index}`,
        index,
        deps: index === 0 ? [] : [`S${index - 1}`],
      })),
    };
  }
  if (shape === 'diamond') {
    const nodes = [{ name: 'S0', index: 0, deps: [] }];
    let index = 1;
    const triples = Math.floor((size - 1) / 3);
    const leaves = (size - 1) % 3;
    for (let group = 0; group < triples; group += 1) {
      const left = `L${group}`;
      const right = `R${group}`;
      nodes.push({ name: left, index, deps: ['S0'] });
      index += 1;
      nodes.push({ name: right, index, deps: ['S0'] });
      index += 1;
      nodes.push({ name: `F${group}`, index, deps: [left, right] });
      index += 1;
    }
    for (let group = 0; group < leaves; group += 1) {
      nodes.push({ name: `D${group}`, index, deps: ['S0'] });
      index += 1;
    }
    return { kind: 'single', nodes };
  }
  if (shape === 'multi') {
    return {
      kind: 'multi',
      nodes: Array.from({ length: size }, (_, index) => ({ name: `M${index}`, index, deps: [] })),
    };
  }
  const childCount = Math.floor(size / 2);
  if (childCount < 1 || size - childCount < 1) throw new Error('parent shape needs at least 2 services');
  const parent = [];
  const child = [];
  for (let index = childCount; index < size; index += 1) parent.push({ name: `P${index}`, index, deps: [] });
  for (let index = 0; index < childCount; index += 1) {
    child.push({ name: `C${index}`, index, deps: index === 0 ? [parent[0].name] : [] });
  }
  return { kind: 'parent', parent, child };
}

function fixtureSource(spec) {
  const plan = nodesFor(spec.shape, spec.size);
  const lines = [`import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';`];
  if (plan.kind === 'parent') {
    lines.push(readyClassOf('BenchReadyParent'), readyClassOf('BenchReadyChild'));
  } else {
    lines.push(readyClassOf('BenchReady'));
  }
  const writeNodes = (nodes) => {
    for (const node of nodes) lines.push(classText(node.name, node.index, node.deps));
  };
  if (plan.kind === 'multi') {
    lines.push('interface Item { value: number; disposed: number; dispose(): void }');
    lines.push('/* bench-strip:start */');
    lines.push('const item = useInterface<Item>();');
    lines.push('/* bench-strip:end */');
    writeNodes(plan.nodes);
    lines.push(configText(
      'box',
      'box',
      injectionList(plan.nodes.map((node) => `{ token: item, provider: ${node.name}, multi: true }`), 'BenchReady'),
      spec.profile,
      spec.mode,
      '{ all: item }, BenchReady',
      '',
    ));
  } else if (plan.kind === 'parent') {
    writeNodes(plan.parent);
    writeNodes(plan.child);
    lines.push(configText(
      'parentBox',
      'parent',
      injectionList(plan.parent.map((node) => `{ token: ${node.name} }`), 'BenchReadyParent'),
      spec.profile,
      spec.mode,
      `${plan.parent.map((node) => node.name).join(', ')}, BenchReadyParent`,
      '',
    ));
    lines.push(configText(
      'childBox',
      'child',
      injectionList(plan.child.map((node) => `{ token: ${node.name} }`), 'BenchReadyChild'),
      spec.profile,
      spec.mode,
      `${plan.child.map((node) => node.name).join(', ')}, BenchReadyChild`,
      'parentBox',
    ));
  } else {
    writeNodes(plan.nodes);
    lines.push(configText(
      'box',
      'box',
      injectionList(plan.nodes.map((node) => `{ token: ${node.name} }`), 'BenchReady'),
      spec.profile,
      spec.mode,
      `${plan.nodes.map((node) => node.name).join(', ')}, BenchReady`,
      '',
    ));
  }
  return { text: `${lines.join('\n')}\n`, plan };
}

function programOf(source) {
  const fileName = '/virtual/neosyringe-bench-case.ts';
  const stubName = '/virtual/neosyringe-marker-stub.ts';
  const options = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    strict: true,
    noImplicitAny: false,
  };
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

function graphMessages(graph) {
  const messages = [];
  for (const error of graph.errors ?? []) {
    if (error.severity === 'warning') continue;
    messages.push(error.message);
  }
  const validation = new GraphValidator().validateAll(graph);
  if (!validation.valid) {
    for (const error of validation.errors) messages.push(error.message);
  }
  return messages;
}

function withoutConfigs(source, graphs) {
  const ranges = graphs.map((graph) => {
    if (graph.variableStatementStart === undefined || graph.defineBuilderConfigEnd === undefined) {
      throw new Error('missing container position');
    }
    return { start: graph.variableStatementStart, end: graph.defineBuilderConfigEnd };
  }).sort((left, right) => right.start - left.start);
  let text = source;
  for (const range of ranges) text = `${text.slice(0, range.start)}${text.slice(range.end)}`;
  return text
    .replace(/import\s*\{[^}]*\}\s*from\s*'@djodjonx\/neosyringe';\s*/g, '')
    .replace(/\/\* bench-strip:start \*\/[\s\S]*?\/\* bench-strip:end \*\//g, '');
}

function inlineSameFileImports(code) {
  return code
    .replace(/import \* as __neo_Import_\d+ from '\.\/neosyringe-bench-case';\s*/g, '')
    .replace(/__neo_Import_\d+\./g, '');
}

function builtFactories(graphs) {
  return graphs.map((graph) => {
    const generator = new Generator(graph, true, undefined, false, false);
    const code = inlineSameFileImports(generator.generate());
    const instantiation = generator.generateInstantiation();
    const found = /class (NeoContainer\w*)/.exec(code);
    if (!found) throw new Error('missing container class');
    const multiToken = graph.multiNodes ? [...graph.multiNodes.keys()][0] : undefined;
    return {
      code,
      exportName: graph.exportedVariableName,
      className: found[1],
      instantiation,
      legacy: graph.legacyContainers?.[0],
      multiToken,
    };
  });
}

function heapFn() {
  return `heapAfterGc() {
      const gc = globalThis.gc;
      if (typeof gc === 'function') gc();
      return process.memoryUsage().heapUsed;
    }`;
}

function harnessSource(spec, plan, made) {
  const byName = new Map(made.map((item) => [item.exportName, item]));
  if (plan.kind === 'parent') {
    const parent = byName.get('parentBox');
    const child = byName.get('childBox');
    if (!parent || !child || !child.legacy) throw new Error('missing parent harness');
    if (!child.instantiation.includes(`[${child.legacy}]`)) {
      throw new Error('child instantiation does not receive the parent');
    }
    const childNew = child.instantiation.replace(`[${child.legacy}]`, '[parent]');
    const childTokens = plan.child.map((node) => node.name).join(', ');
    const parentTokens = plan.parent.map((node) => node.name).join(', ');
    return `
export const benchResolveCount = ${resolveCountFor(spec.shape, spec.size)};
const childTokens = [${childTokens}];
const parentTokens = [${parentTokens}];
const childCount = ${plan.child.length};
function createParent() { return ${parent.instantiation}; }
function createChild(parent) { return ${childNew}; }
${harnessChecks}
function assertUntouched(instances) {
  if (!Array.isArray(instances) || instances.length === 0 || instances.some((instance) => instance.disposed !== 0)) {
    throw new Error('parent instance disposed by child destroy');
  }
}
async function openPair() {
  const parent = createParent();
  const child = createChild(parent);
  await parent.initialize();
  await child.initialize();
  assertReady(parent, BenchReadyParent);
  assertReady(child, BenchReadyChild);
  return { parent, child };
}
async function closePair(pair) {
  await pair.child.destroy();
  await pair.parent.destroy();
}
export async function createHarness() {
  let current = await openPair();
  let settled = false;
  return {
    shape: 'parent',
    size: ${spec.size},
    coldIndex: 0,
    resolve(index) {
      if (index < childCount) return current.child.resolve(childTokens[index]);
      return current.parent.resolve(parentTokens[index - childCount]);
    },
    async recreate() {
      if (!settled) await closePair(current);
      current = await openPair();
      settled = false;
    },
    async settle() {
      settled = true;
      await closePair(current);
    },
    async scopeDisposeCounts() {
      const pair = await openPair();
      const scope = pair.child.createScope();
      await scope.initialize();
      const seen = new Set();
      const owned = [];
      for (const token of childTokens) {
        const instance = scope.resolve(token);
        if (seen.has(instance)) continue;
        seen.add(instance);
        owned.push(instance);
      }
      const before = owned.map((instance) => instance.disposed);
      await scope.destroy();
      const counts = owned.map((instance, index) => instance.disposed - before[index]);
      await closePair(pair);
      return counts;
    },
    async parentDisposeCounts() {
      const pair = await openPair();
      const parentInstances = parentTokens.map((token) => pair.parent.resolve(token));
      for (const token of childTokens) pair.child.resolve(token);
      const before = parentInstances.map((instance) => instance.disposed);
      await pair.child.destroy();
      const counts = parentInstances.map((instance, index) => instance.disposed - before[index]);
      await pair.parent.destroy();
      return counts;
    },
    async timeCreate() {
      const started = performance.now();
      const pair = { parent: createParent(), child: null };
      pair.child = createChild(pair.parent);
      const elapsed = performance.now() - started;
      await closePair(pair);
      return elapsed * 1e6;
    },
    async timeCreateScope() {
      const pair = await openPair();
      const started = performance.now();
      const scope = pair.child.createScope();
      const elapsed = performance.now() - started;
      await scope.destroy();
      await closePair(pair);
      return elapsed * 1e6;
    },
    async timeInitialize() {
      const parent = createParent();
      const child = createChild(parent);
      const started = performance.now();
      await child.initialize();
      const elapsed = performance.now() - started;
      assertReady(child, BenchReadyChild);
      assertReady(parent, BenchReadyParent);
      await child.destroy();
      await parent.destroy();
      return elapsed * 1e6;
    },
    // destroy metric times child.destroy() only.
    async timeDestroy() {
      const pair = await openPair();
      const childInstances = childTokens.map((token) => pair.child.resolve(token));
      const parentInstances = parentTokens.map((token) => pair.parent.resolve(token));
      const started = performance.now();
      await pair.child.destroy();
      const elapsed = performance.now() - started;
      assertDisposed(childInstances);
      assertUntouched(parentInstances);
      await pair.parent.destroy();
      return elapsed * 1e6;
    },
    ${heapFn()}
  };
}
`;
  }
  const box = byName.get('box');
  if (!box) throw new Error('missing harness');
  const tokens = plan.nodes.map((node) => node.name).join(', ');
  const multi = plan.kind === 'multi';
  if (multi && !box.multiToken) throw new Error('missing multi token');
  const tokenLiteral = JSON.stringify(box.multiToken);
  // multi cold-resolve is the first resolveAll (ns/call). warm-resolve divides that call by size.
  const resolveBody = multi
    ? 'return current.resolveAll(multiToken)[index];'
    : 'return current.resolve(tokens[index]);';
  const destroyInstances = multi
    ? 'const instances = box.resolveAll(multiToken);'
    : 'const instances = tokens.map((token) => box.resolve(token));';
  const scopeCollect = multi
    ? 'const instances = scope.resolveAll(multiToken);'
    : `const seen = new Set();
      const instances = [];
      for (const token of tokens) {
        const instance = scope.resolve(token);
        if (seen.has(instance)) continue;
        seen.add(instance);
        instances.push(instance);
      }`;
  const tokenPrelude = multi
    ? `const multiToken = ${tokenLiteral};`
    : `const tokens = [${tokens}];`;
  return `
export const benchResolveCount = ${resolveCountFor(spec.shape, spec.size)};
${tokenPrelude}
function createBox() { return ${box.instantiation}; }
${harnessChecks}
async function openBox() {
  const box = createBox();
  await box.initialize();
  assertReady(box, BenchReady);
  return box;
}
export async function createHarness() {
  let current = await openBox();
  let settled = false;
  return {
    shape: ${JSON.stringify(spec.shape)},
    size: ${spec.size},
    coldIndex: ${spec.size - 1},
    resolvePerCall: ${multi ? spec.size : 1},
    resolve(index) { ${resolveBody} },
    async recreate() {
      if (!settled) await current.destroy();
      current = await openBox();
      settled = false;
    },
    async settle() {
      settled = true;
      await current.destroy();
    },
    async scopeDisposeCounts() {
      const box = await openBox();
      const scope = box.createScope();
      await scope.initialize();
      ${scopeCollect}
      const before = instances.map((instance) => instance.disposed);
      await scope.destroy();
      await box.destroy();
      return instances.map((instance, index) => instance.disposed - before[index]);
    },
    async timeCreate() {
      const started = performance.now();
      const box = createBox();
      const elapsed = performance.now() - started;
      await box.destroy();
      return elapsed * 1e6;
    },
    async timeCreateScope() {
      const box = createBox();
      const started = performance.now();
      const scope = box.createScope();
      const elapsed = performance.now() - started;
      await scope.destroy();
      await box.destroy();
      return elapsed * 1e6;
    },
    async timeInitialize() {
      const box = createBox();
      const started = performance.now();
      await box.initialize();
      const elapsed = performance.now() - started;
      assertReady(box, BenchReady);
      await box.destroy();
      return elapsed * 1e6;
    },
    async timeDestroy() {
      const box = await openBox();
      ${destroyInstances}
      const started = performance.now();
      await box.destroy();
      const elapsed = performance.now() - started;
      assertDisposed(instances);
      return elapsed * 1e6;
    },
    ${heapFn()}
  };
}
`;
}

function buildModule(spec) {
  const { text, plan } = fixtureSource(spec);
  const program = programOf(text);
  const graphs = new Analyzer(program).extractAll();
  if (graphs.length === 0) throw new Error('no container');
  const messages = graphs.flatMap((graph) => graphMessages(graph));
  if (messages.length > 0) throw new Error(messages.join('\n'));
  const made = builtFactories(graphs);
  const body = withoutConfigs(text, graphs);
  const tsCode = `${body}\n${made.map((item) => item.code).join('\n')}\n`;
  const js = ts.transpileModule(tsCode, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return `${js}\n${harnessSource(spec, plan, made)}`;
}

function messageOf(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

function runWorker(file) {
  const run = spawnSync(process.execPath, ['--expose-gc', worker, file], {
    encoding: 'utf8',
    cwd: root,
    env: process.env,
  });
  if (run.status !== 0) {
    throw new Error((run.stderr || run.stdout || 'worker failed').trim());
  }
  const line = run.stdout.trim().split('\n').findLast((item) => item.startsWith('{'));
  if (!line) throw new Error('worker returned no report');
  return JSON.parse(line);
}

function aggregate(perProcess) {
  const processMedians = perProcess.map((row) => summarize(row).median);
  const center = summarize(processMedians).median;
  return {
    processes: perProcess,
    processMedians,
    median: center,
    mad: summarize(processMedians.map((value) => Math.abs(value - center))).median,
  };
}

function buildRepeated(spec) {
  // Sizes 1000 and 5000: one group of 7. A 5×7 rebuild of those graphs is too slow.
  const groups = spec.size >= 1000 ? 1 : processes;
  const rows = [];
  let source = '';
  for (let group = 0; group < groups; group += 1) {
    const row = [];
    for (let index = 0; index < samples; index += 1) {
      const started = performance.now();
      source = buildModule(spec);
      row.push(performance.now() - started);
    }
    rows.push(row);
  }
  return { source, rows };
}

function assemble(spec, checksum, resolveCountUsed, buildRows, source, runs) {
  if (runs.length !== processes) throw new Error('missing process sample');
  if (runs.some((run) => run.count !== resolveCountUsed)) throw new Error('resolve count mismatch');
  const min = esbuild.transformSync(source, { minify: true, format: 'esm', target: 'es2022' }).code;
  const metrics = {};
  const names = Object.keys(runs[0].metrics);
  for (const name of names) {
    const unit = runs[0].metrics[name].unit;
    const rows = runs.map((run) => {
      const metric = run.metrics[name];
      if (!metric || metric.unit !== unit) throw new Error(`missing metric ${name}`);
      return metric.samples;
    });
    metrics[name] = { unit, ...aggregate(rows) };
  }
  const build = aggregate(buildRows);
  metrics.build = { unit: 'ms', ...build };
  const buildMs = build.median;
  return {
    shape: spec.shape,
    profile: spec.profile,
    mode: spec.mode,
    size: spec.size,
    checksum,
    resolveCount: resolveCountUsed,
    buildMs,
    module: {
      raw: Buffer.byteLength(source),
      min: Buffer.byteLength(min),
      gzip: gzipSync(Buffer.from(min)).length,
    },
    metrics,
    flags: JSON.stringify(runs[0].flags),
  };
}

for (const shape of shapes) if (!knownShapes.has(shape)) throw new Error(`unknown shape: ${shape}`);
for (const profile of profiles) if (!knownProfiles.has(profile)) throw new Error(`unknown profile: ${profile}`);
for (const mode of modes) if (!knownModes.has(mode)) throw new Error(`unknown mode: ${mode}`);

const work = mkdtempSync(path.join(os.tmpdir(), 'neosyringe-runtime-'));
const built = [];
const schedule = [];
try {
  for (const size of sizes) {
    for (const shape of shapes) {
      for (const profile of profiles) {
        for (const mode of modes) {
          const spec = { size, shape, profile, mode };
          const caseCount = resolveCountFor(shape, size);
          const checksum = checksumOf(size, caseCount);
          try {
            const compiled = buildRepeated(spec);
            const file = path.join(work, `case-${shape}-${profile}-${mode}-${size}.mjs`);
            writeFileSync(file, compiled.source);
            built.push({
              spec, checksum, caseCount, file, source: compiled.source, buildRows: compiled.rows, runs: [],
            });
          } catch (error) {
            built.push({ spec, checksum, caseCount, error: messageOf(error), runs: [] });
            console.error(`${shape} ${profile} ${mode} ${size}: ${messageOf(error)}`);
          }
        }
      }
    }
  }
  for (let processIndex = 0; processIndex < processes; processIndex += 1) {
    const order = built.map((_, index) => index);
    if (processIndex % 2 === 1) order.reverse();
    for (const index of order) {
      const item = built[index];
      if (item.error) continue;
      try {
        item.runs.push(runWorker(item.file));
        schedule.push({
          process: processIndex,
          shape: item.spec.shape,
          profile: item.spec.profile,
          mode: item.spec.mode,
          size: item.spec.size,
        });
      } catch (error) {
        item.error = messageOf(error);
        item.runs = [];
        console.error(`${item.spec.shape} ${item.spec.profile} ${item.spec.mode} ${item.spec.size}: ${item.error}`);
      }
    }
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

const cases = built.map((item) => {
  if (item.error) {
    return {
      shape: item.spec.shape,
      profile: item.spec.profile,
      mode: item.spec.mode,
      size: item.spec.size,
      checksum: item.checksum,
      resolveCount: item.caseCount,
      error: item.error,
    };
  }
  try {
    return assemble(item.spec, item.checksum, item.caseCount, item.buildRows, item.source, item.runs);
  } catch (error) {
    console.error(`${item.spec.shape} ${item.spec.profile} ${item.spec.mode} ${item.spec.size}: ${messageOf(error)}`);
    return {
      shape: item.spec.shape,
      profile: item.spec.profile,
      mode: item.spec.mode,
      size: item.spec.size,
      checksum: item.checksum,
      resolveCount: item.caseCount,
      error: messageOf(error),
    };
  }
});

const flags = cases.find((item) => item.flags)?.flags ?? JSON.stringify(['--expose-gc']);
const cpu = os.cpus()[0]?.model ?? 'unknown';
const report = {
  environment: {
    node: process.version,
    typescript: ts.version,
    sha: git(['rev-parse', 'HEAD']),
    dirty: git(['status', '--porcelain']).length > 0,
    cpu,
    cores: os.cpus().length,
    memory: os.totalmem(),
    os: `${os.type()} ${os.release()} ${os.platform()}`,
    flags,
  },
  params: {
    sizes,
    shapes,
    profiles,
    modes,
    processes,
    samples,
    resolveCount,
    resolveBatches,
    multiResolveCount: 'max(256, floor(50000 / size))',
    buildGroups: '5x7; size>=1000 is 1x7',
    caseOrder: 'process-outer, reverse-odd',
  },
  schedule,
  cases: cases.map((item) => ({
    shape: item.shape,
    profile: item.profile,
    mode: item.mode,
    size: item.size,
    checksum: item.checksum,
    resolveCount: item.resolveCount,
    ...(item.error
      ? { error: item.error }
      : { buildMs: item.buildMs, module: item.module, metrics: item.metrics }),
  })),
};
const reportPath = process.env.NEOSYRINGE_BENCH_REPORT
  ? path.resolve(process.env.NEOSYRINGE_BENCH_REPORT)
  : path.join(os.tmpdir(), 'neosyringe-runtime-report.json');
mkdirSync(path.dirname(reportPath), { recursive: true });
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`report ${reportPath}\n`);
process.stdout.write(`cases ${cases.length}\n`);
if (cases.some((item) => item.error)) process.exit(1);
