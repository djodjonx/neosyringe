import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as ts from 'typescript';
import { hasText, sameFile, textAt, virtualResolved } from '../helpers/tsPath';
import { Analyzer } from '../../src/analyzer/Analyzer';
import { Generator } from '../../src/generator/Generator';
import type { DependencyGraph, DependencyNode, FactoryDependency } from '../../src/analyzer/types';
import { createFastProgram, warmLibCache } from '../fastProgram';

/**
 * T17 differential tests. Each scenario runs the generated code of the reference
 * emitter and of the optimized emitter on the SAME graph, then compares the
 * semantic trace: ordered factory calls, resolve identities, events, destroy order.
 */

type Emitter = 'reference' | 'optimized';
const EMITTERS: readonly Emitter[] = ['reference', 'optimized'];

const ROOT = '/virtual/t17';

const STUB = `
  import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';
  function defineBuilderConfig(config: any) { return config; }
  function useInterface<T>(): any { return null; }
`;

function source(body: string): string {
  return `${STUB}\n${body}\n`;
}

const MINIMAL_LITERAL = path.join(ROOT, 'minimal-literal.ts');
const MINIMAL_AS = path.join(ROOT, 'minimal-as.ts');
const PROFILE_FULL = path.join(ROOT, 'profile-full.ts');
const PROFILE_UNDEFINED = path.join(ROOT, 'profile-undefined.ts');
const PROFILE_VARIABLE = path.join(ROOT, 'profile-variable.ts');
const PROFILE_UNKNOWN = path.join(ROOT, 'profile-unknown.ts');
const RUNTIME_UNDEFINED = path.join(ROOT, 'runtime-undefined.ts');
const RUNTIME_QUOTED_OUTER = path.join(ROOT, 'runtime-quoted-outer.ts');
const RUNTIME_QUOTED_INNER = path.join(ROOT, 'runtime-quoted-inner.ts');
const RUNTIME_SPREAD = path.join(ROOT, 'runtime-spread.ts');
const RUNTIME_COMPUTED = path.join(ROOT, 'runtime-computed.ts');
const EXCLUDED = path.join(ROOT, 'excluded.ts');
const SINGLE_ROOT = path.join(ROOT, 'single-root.ts');
const COMBINED = path.join(ROOT, 'combined.ts');
const CLOSED_PRIVATE = path.join(ROOT, 'closed-private.ts');

const files = new Map<string, string>([
  [MINIMAL_LITERAL, source(`
    interface LitPort { n: number }
    const port = useInterface<LitPort>();
    export const minimalLiteral = defineBuilderConfig({
      name: 'MinimalLiteral',
      runtime: { profile: 'minimal' },
      injections: [
        { token: port, useFactory: true, dependencies: [], provider: () => ({ n: 1 }) },
      ],
    });
  `)],
  [MINIMAL_AS, source(`
    interface AsPort { n: number }
    const port = useInterface<AsPort>();
    export const minimalAs = defineBuilderConfig({
      name: 'MinimalAs',
      runtime: { profile: 'minimal' as 'minimal' },
      injections: [
        { token: port, useFactory: true, dependencies: [], provider: () => ({ n: 1 }) },
      ],
    });
  `)],
  [PROFILE_FULL, source(`
    interface FullPort { n: number }
    const port = useInterface<FullPort>();
    export const profileFull = defineBuilderConfig({
      name: 'ProfileFull',
      runtime: { profile: 'full' },
      injections: [
        { token: port, useFactory: true, dependencies: [], provider: () => ({ n: 1 }) },
      ],
    });
  `)],
  [PROFILE_UNDEFINED, source(`
    interface UndefPort { n: number }
    const port = useInterface<UndefPort>();
    export const profileUndefined = defineBuilderConfig({
      name: 'ProfileUndefined',
      runtime: { profile: undefined },
      injections: [
        { token: port, useFactory: true, dependencies: [], provider: () => ({ n: 1 }) },
      ],
    });
  `)],
  [PROFILE_VARIABLE, source(`
    interface VarPort { n: number }
    const port = useInterface<VarPort>();
    const chosen = 'minimal';
    export const profileVariable = defineBuilderConfig({
      name: 'ProfileVariable',
      runtime: { profile: chosen },
      injections: [
        { token: port, useFactory: true, dependencies: [], provider: () => ({ n: 1 }) },
      ],
    });
  `)],
  [PROFILE_UNKNOWN, source(`
    interface UnkPort { n: number }
    const port = useInterface<UnkPort>();
    export const profileUnknown = defineBuilderConfig({
      name: 'ProfileUnknown',
      runtime: { profile: 'turbo' },
      injections: [
        { token: port, useFactory: true, dependencies: [], provider: () => ({ n: 1 }) },
      ],
    });
  `)],
  [RUNTIME_UNDEFINED, source(`
    interface RtUndefPort { n: number }
    const port = useInterface<RtUndefPort>();
    export const runtimeUndefined = defineBuilderConfig({
      name: 'RuntimeUndefined',
      runtime: undefined,
      injections: [
        { token: port, useFactory: true, dependencies: [], provider: () => ({ n: 1 }) },
      ],
    });
  `)],
  [RUNTIME_QUOTED_OUTER, source(`
    interface RtQuotedOuterPort { n: number }
    const port = useInterface<RtQuotedOuterPort>();
    export const runtimeQuotedOuter = defineBuilderConfig({
      name: 'RuntimeQuotedOuter',
      'runtime': { profile: 'minimal' },
      injections: [
        { token: port, useFactory: true, dependencies: [], provider: () => ({ n: 1 }) },
      ],
    });
  `)],
  [RUNTIME_QUOTED_INNER, source(`
    interface RtQuotedInnerPort { n: number }
    const port = useInterface<RtQuotedInnerPort>();
    export const runtimeQuotedInner = defineBuilderConfig({
      name: 'RuntimeQuotedInner',
      runtime: { 'profile': 'minimal' },
      injections: [
        { token: port, useFactory: true, dependencies: [], provider: () => ({ n: 1 }) },
      ],
    });
  `)],
  [RUNTIME_SPREAD, source(`
    interface RtSpreadPort { n: number }
    const port = useInterface<RtSpreadPort>();
    export const runtimeSpread = defineBuilderConfig({
      name: 'RuntimeSpread',
      runtime: { ...{ profile: 'minimal' as const } },
      injections: [
        { token: port, useFactory: true, dependencies: [], provider: () => ({ n: 1 }) },
      ],
    });
  `)],
  [RUNTIME_COMPUTED, source(`
    interface RtComputedPort { n: number }
    const port = useInterface<RtComputedPort>();
    export const runtimeComputed = defineBuilderConfig({
      name: 'RuntimeComputed',
      runtime: { ['profile']: 'minimal' },
      injections: [
        { token: port, useFactory: true, dependencies: [], provider: () => ({ n: 1 }) },
      ],
    });
  `)],
  [EXCLUDED, source(`
    interface ExRoot { n: number }
    interface ExDead { n: number; dispose(): void }
    const root = useInterface<ExRoot>();
    const dead = useInterface<ExDead>();
    export const excluded = defineBuilderConfig({
      name: 'Excluded',
      optimization: { mode: 'closed', roots: [root] },
      injections: [
        { token: root, useFactory: true, dependencies: [], provider: () => { log('create root'); return { n: 1 }; } },
        { token: dead, useFactory: true, dependencies: [], provider: () => { log('create dead'); return { n: 2, dispose() { log('dispose dead'); } }; } },
      ],
    });
  `)],
  [SINGLE_ROOT, source(`
    interface OnlyPort { n: number }
    interface ForeignPort { n: number }
    const only = useInterface<OnlyPort>();
    const foreign = useInterface<ForeignPort>();
    export const singleRoot = defineBuilderConfig({
      name: 'SingleRoot',
      optimization: { mode: 'closed', roots: [only] },
      injections: [
        { token: only, useFactory: true, dependencies: [], provider: () => ({ n: 7 }) },
        { token: foreign, useFactory: true, dependencies: [], provider: () => ({ n: 8 }) },
      ],
    });
  `)],
  [CLOSED_PRIVATE, source(`
    interface PrivDep { n: number }
    interface PrivRoot { n: number }
    const dep = useInterface<PrivDep>();
    const root = useInterface<PrivRoot>();
    export const closedPrivate = defineBuilderConfig({
      name: 'ClosedPrivate',
      optimization: { mode: 'closed', roots: [root] },
      injections: [
        { token: dep, useFactory: true, dependencies: [], provider: () => ({ n: 4 }) },
        { token: root, useFactory: true, dependencies: [dep], provider: (ctx) => ({ n: ctx.resolve(dep).n + 1 }) },
      ],
    });
  `)],
  [COMBINED, source(`
    export class Db { dispose(): void {} }
    export class Repo {
      constructor(readonly db: Db) {}
      dispose(): void {}
    }
    interface CachePort { name: string; dispose(): void }
    interface PluginPort { name: string }
    interface BootPort { name: string }
    interface Settings { name: string }
    const cache = useInterface<CachePort>();
    const plugin = useInterface<PluginPort>();
    const boot = useInterface<BootPort>();
    const settings = useInterface<Settings>();
    export const combined = defineBuilderConfig({
      name: 'Combined',
      injections: [
        { token: settings, useValue: { name: 'settings' } },
        { token: Db, provider: Db },
        { token: Repo, provider: Repo },
        { token: cache, useFactory: true, dependencies: [Repo], provider: (ctx) => { log('create cache'); const repo = ctx.resolve(Repo); return { name: 'cache', repo, dispose() { log('dispose cache'); } }; } },
        { token: plugin, multi: true, useFactory: true, dependencies: [], provider: () => { log('create plugin a'); return { name: 'plugin-a' }; } },
        { token: plugin, multi: true, useFactory: true, dependencies: [], provider: () => { log('create plugin b'); return { name: 'plugin-b' }; } },
        { token: boot, useFactory: true, dependencies: [], provider: async () => { log('create boot'); return { name: 'boot' }; } },
      ],
    });
  `)],
]);

interface RuntimeContainer {
  initialize: () => Promise<void>;
  createScope: () => RuntimeContainer;
  destroy: () => Promise<void>;
  resolve: (token: unknown) => unknown;
  resolveAll: (token: unknown) => unknown[];
  on?: (event: 'resolve', listener: (token: unknown, instance: unknown) => void) => () => void;
  override?: (token: unknown, factory: () => unknown) => Promise<void>;
  clearOverrides?: () => Promise<void>;
  _graph?: unknown[];
  _dependencyGraph?: Array<{ token: string }>;
  _singleRoots?: Set<unknown>;
}

interface FullContainer extends RuntimeContainer {
  on: NonNullable<RuntimeContainer['on']>;
  override: NonNullable<RuntimeContainer['override']>;
  clearOverrides: NonNullable<RuntimeContainer['clearOverrides']>;
}

function assertFull(container: RuntimeContainer): asserts container is FullContainer {
  if (
    typeof container.on !== 'function'
    || typeof container.override !== 'function'
    || typeof container.clearOverrides !== 'function'
  ) {
    throw new Error('container does not expose the full profile API');
  }
}

interface Opened {
  container: RuntimeContainer;
  exports: Record<string, RuntimeContainer | undefined>;
  trace: string[];
  source: string;
}

interface OpenOptions {
  testOverrides?: boolean;
  debug?: boolean;
  parent?: RuntimeContainer;
  modules?: (log: (message: string) => void) => Record<string, unknown>;
  /** Extra TypeScript appended after the generated module, e.g. a second `new` of the class. */
  suffix?: string;
  /** Trace shared with another container of the same run (a parent logs into its child's trace). */
  sink?: string[];
}

const closers: Array<() => Promise<void>> = [];

function describeValue(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value !== null && typeof value === 'object') {
    const record = value as { name?: unknown; n?: unknown };
    if (typeof record.name === 'string') return record.name;
    if (typeof record.n === 'number') return `n${record.n}`;
    return 'object';
  }
  return String(value);
}

function readFailure(error: unknown): { code: string; name: string; message: string } {
  if (!(error instanceof Error)) return { code: '', name: '', message: String(error) };
  const code = 'code' in error ? String((error as { code: unknown }).code) : '';
  return { code, name: error.name, message: error.message };
}

function failureOf(run: () => unknown): { code: string; name: string; message: string } {
  try {
    run();
  } catch (error) {
    return readFailure(error);
  }
  return { code: '', name: '', message: '' };
}

/** Keeps an `undefined` result and a not-found error apart: they are different outcomes (see T17-A01). */
function outcome(run: () => unknown): string {
  try {
    return describeValue(run());
  } catch (error) {
    if (readFailure(error).name === 'NeoServiceNotFoundError') return 'not-found';
    throw error;
  }
}

/** Body of one generated class member, from its signature to the closing brace at member depth. */
function methodText(code: string, signature: string): string {
  const start = code.indexOf(signature);
  if (start < 0) throw new Error(`generated source has no ${signature}`);
  const end = code.indexOf('\n  }', start);
  return code.slice(start, end < 0 ? undefined : end + 4);
}

function open(graph: DependencyGraph, emitter: Emitter | undefined, options: OpenOptions = {}): Opened {
  const trace: string[] = options.sink ?? [];
  let sequence = 0;
  const log = (message: string): void => { trace.push(message); };
  const seq = (): number => { sequence += 1; return sequence; };
  const generated = new Generator(
    graph,
    false,
    undefined,
    options.debug ?? false,
    options.testOverrides ?? false,
    emitter,
  ).generate();
  const code = `${generated}\n${options.suffix ?? ''}`;
  const js = ts.transpileModule(code, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const record: { exports: Record<string, RuntimeContainer | undefined> } = { exports: {} };
  const modules = options.modules ? options.modules(log) : {};
  // Factory sources name the runtime classes directly, so they are bound as parameters.
  const run = new Function('log', 'seq', 'parent', 'module', 'exports', 'require', ...Object.keys(modules), js) as (
    log: (message: string) => void,
    seq: () => number,
    parent: unknown,
    module: typeof record,
    exports: typeof record.exports,
    require: (id: string) => unknown,
    ...bound: unknown[]
  ) => void;
  run(log, seq, options.parent, record, record.exports, () => modules, ...Object.values(modules));
  const name = graph.exportedVariableName ?? 'container';
  const container = record.exports[name];
  if (!container) throw new Error(`generated module did not export ${name}`);
  closers.push(() => container.destroy().catch(() => undefined));
  return { container, exports: record.exports, trace, source: code };
}

function count(trace: readonly string[], line: string): number {
  return trace.filter((entry) => entry === line).length;
}

function registrationNode(): ts.Node {
  return {} as ts.Node;
}

function valueNode(tokenId: string, valueSource: string): DependencyNode {
  return {
    service: {
      tokenId,
      type: 'value',
      valueSource,
      registrationNode: registrationNode(),
      lifecycle: 'singleton',
      isInterfaceToken: true,
    },
    dependencies: [],
  };
}

function dep(tokenId: string): FactoryDependency {
  return { tokenId, all: false, source: JSON.stringify(tokenId), containerId: 'Test' };
}

interface FactoryOptions {
  deps?: FactoryDependency[];
  disposable?: boolean;
  async?: boolean;
  transient?: boolean;
}

function factoryNode(tokenId: string, factorySource: string, options: FactoryOptions = {}): DependencyNode {
  return {
    service: {
      tokenId,
      type: 'factory',
      factorySource,
      lifecycle: options.transient ? 'transient' : 'singleton',
      isInterfaceToken: true,
      isDisposable: options.disposable,
      isAsync: options.async,
      ownership: 'owned',
      factoryDependencies: options.deps,
      registrationNode: registrationNode(),
    },
    dependencies: options.deps?.map((item) => item.tokenId) ?? [],
  };
}

function graphOf(
  nodes: Array<[string, DependencyNode]>,
  extra: Partial<DependencyGraph> = {},
): DependencyGraph {
  return {
    containerId: 'Test',
    nodes: new Map(nodes),
    roots: nodes.map(([id]) => id),
    exportedVariableName: 'container',
    variableExportModifier: 'export',
    ...extra,
  };
}

interface Context {
  container: RuntimeContainer;
  log: (message: string) => void;
  parent?: RuntimeContainer;
}

type Scenario = (context: Context) => Promise<void>;

interface Differential {
  reference: Opened;
  optimized: Opened;
}

/**
 * Runs `scenario` once per emitter on the same graph. A parent container, when
 * requested, is generated by the reference emitter in both runs.
 */
async function differential(
  graph: DependencyGraph,
  scenario: Scenario,
  options: OpenOptions & { parentGraph?: DependencyGraph } = {},
): Promise<Differential> {
  const opened: Partial<Record<Emitter, Opened>> = {};
  for (const emitter of EMITTERS) {
    const sink: string[] = [];
    const parent = options.parentGraph
      ? open(options.parentGraph, 'reference', { testOverrides: options.testOverrides, sink })
      : undefined;
    const run = open(graph, emitter, { ...options, parent: parent?.container, sink });
    await scenario({ container: run.container, log: (message) => run.trace.push(message), parent: parent?.container });
    opened[emitter] = run;
  }
  const { reference, optimized } = opened;
  if (!reference || !optimized) throw new Error('scenario did not run on both emitters');
  return { reference, optimized };
}

function projectGraph(graphs: Map<string, DependencyGraph>, file: string): DependencyGraph {
  const graph = graphs.get(file) ?? [...graphs.entries()].find(([key]) => sameFile(key, file))?.[1];
  if (!graph) throw new Error(`missing graph for ${file}`);
  return graph;
}

function tokenId(graph: DependencyGraph, name: string): string {
  const keys = [...graph.nodes.keys(), ...(graph.multiNodes ? [...graph.multiNodes.keys()] : [])];
  const found = keys.find((id) => id.includes(name));
  if (!found) throw new Error(`missing token ${name}`);
  return found;
}

function programFrom(sources: Map<string, string>): ts.Program {
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    strict: true,
    noImplicitAny: false,
  };
  const host = ts.createCompilerHost(options);
  const read = host.getSourceFile.bind(host);
  const exists = host.fileExists.bind(host);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
    const text = textAt(sources, fileName);
    if (text !== undefined) return ts.createSourceFile(fileName, text, languageVersion, true);
    return read(fileName, languageVersion, onError, shouldCreateNewSourceFile);
  };
  host.fileExists = (fileName) => hasText(sources, fileName) || exists(fileName);
  host.resolveModuleNames = (moduleNames, containingFile) => moduleNames.map((moduleName) => {
    const candidate = virtualResolved(sources, containingFile, moduleName);
    if (candidate !== undefined) {
      return { resolvedFileName: candidate, extension: ts.Extension.Ts, isExternalLibraryImport: false };
    }
    return ts.resolveModuleName(moduleName, containingFile, options, host).resolvedModule;
  });
  return createFastProgram([...sources.keys()], options, host);
}

describe('T17 direct accessors and runtime profiles', () => {
  let graphs: Map<string, DependencyGraph>;

  beforeAll(() => {
    warmLibCache();
    graphs = new Map();
    for (const graph of new Analyzer(programFrom(files)).extractAll()) {
      graphs.set(graph.sourceFileName ?? graph.containerId, graph);
    }
  });

  afterEach(async () => {
    for (const close of closers.splice(0).reverse()) await close();
  });

  it('T17-A01 singleton, transient and undefined factory keep identities and call counts', async () => {
    const graph = graphOf([
      ['single', factoryNode('single', '() => { log("create single"); return { name: "single" }; }')],
      ['transient', factoryNode('transient', '() => { log("create transient"); return { name: "transient" }; }', { transient: true })],
      ['undef', factoryNode('undef', '() => { log("create undef"); return undefined; }')],
      ['consumer', factoryNode(
        'consumer',
        '(ctx) => { log("create consumer"); return { name: "consumer", s: ctx.resolve("single"), t: ctx.resolve("transient") }; }',
        { deps: [dep('single'), dep('transient')] },
      )],
    ]);
    const { reference, optimized } = await differential(graph, async ({ container, log }) => {
      const first = container.resolve('single');
      const second = container.resolve('single');
      log(`single identical ${first === second}`);
      const t1 = container.resolve('transient');
      const t2 = container.resolve('transient');
      log(`transient distinct ${t1 !== t2}`);
      const consumer = container.resolve('consumer') as { s: unknown; t: unknown };
      log(`consumer identical ${container.resolve('consumer') === consumer}`);
      log(`consumer holds single ${consumer.s === first}`);
      log(`consumer transient fresh ${consumer.t !== t1 && consumer.t !== t2}`);
      log(`undef first ${outcome(() => container.resolve('undef'))}`);
      log(`undef second ${outcome(() => container.resolve('undef'))}`);
    });
    expect(optimized.source).not.toBe(reference.source);
    for (const run of [reference, optimized]) {
      expect(count(run.trace, 'create single')).toBe(1);
      expect(count(run.trace, 'create undef')).toBe(1);
      expect(count(run.trace, 'create consumer')).toBe(1);
      expect(count(run.trace, 'create transient')).toBe(3);
      expect(run.trace).toContain('single identical true');
      expect(run.trace).toContain('transient distinct true');
      expect(run.trace).toContain('consumer holds single true');
    }
    // Known reference divergence: the reference reads a cached `undefined` as "absent" and
    // falls through to not-found. The optimized emitter keeps the value (spec: "valeur undefined conservée").
    expect(optimized.trace).toContain('undef first undefined');
    expect(optimized.trace).toContain('undef second undefined');
    expect(reference.trace).toContain('undef first not-found');
    expect(reference.trace).toContain('undef second not-found');
    const comparable = (trace: readonly string[]): string[] => trace.filter((line) => !line.startsWith('undef '));
    expect(comparable(optimized.trace)).toEqual(comparable(reference.trace));
  });

  it('T17-A01 closed mode: a local undefined shadows a parent token instead of falling through to it', async () => {
    const parentGraph = graphOf([['X', valueNode('X', '"from-parent"')]]);
    const graph = graphOf(
      [
        ['X', factoryNode('X', '() => { log("create X"); return undefined; }')],
        ['Consumer', factoryNode(
          'Consumer',
          '(ctx) => ({ name: "consumer", x: ctx.resolve("X") })',
          { deps: [dep('X')] },
        )],
      ],
      { optimizationMode: 'closed', publicRoots: ['X', 'Consumer'], legacyContainers: ['parent'] },
    );
    const sink: string[] = [];
    const parent = open(parentGraph, 'reference', { sink });
    const byDefault = open(graph, undefined, { parent: parent.container, sink });
    const optimized = open(graph, 'optimized', { parent: parent.container, sink: [] });
    const reference = open(graph, 'reference', { parent: parent.container, sink: [] });
    expect(byDefault.source).toBe(optimized.source);

    expect(byDefault.container.resolve('X')).toBeUndefined();
    expect(byDefault.container.resolve('X')).toBeUndefined();
    expect((byDefault.container.resolve('Consumer') as { x: unknown }).x).toBeUndefined();
    expect(count(sink, 'create X')).toBe(1);

    // Recorded reference divergence (Generator.ts `result !== undefined`): the parent value wins.
    expect(reference.container.resolve('X')).toBe('from-parent');
    expect((reference.container.resolve('Consumer') as { x: unknown }).x).toBe('from-parent');
  });

  it('T17-A02 two scopes and a shared parent behave the same after optimization', async () => {
    const parentGraph = graphOf([
      ['P', factoryNode('P', '() => { log("create P"); return { name: "P" }; }')],
    ]);
    const graph = graphOf(
      [
        ['S', factoryNode(
          'S',
          '(ctx) => { log("create S"); return { name: "S", p: ctx.resolve("P") }; }',
          { deps: [dep('P')] },
        )],
        ['Local', factoryNode('Local', '() => { log("create Local"); return { name: "Local" }; }')],
      ],
      { legacyContainers: ['parent'] },
    );
    const { reference, optimized } = await differential(graph, async ({ container, log, parent }) => {
      if (!parent) throw new Error('parent missing');
      const a = container.createScope();
      const b = container.createScope();
      const sa = a.resolve('S') as { p: unknown };
      const sb = b.resolve('S') as { p: unknown };
      const sc = container.resolve('S') as { p: unknown };
      log(`own singletons distinct ${sa !== sb && sa !== sc && sb !== sc}`);
      log(`scope a cached ${a.resolve('S') === sa}`);
      log(`parent singleton shared ${sa.p === sb.p && sb.p === sc.p && sc.p === parent.resolve('P')}`);
      log(`local distinct ${a.resolve('Local') !== b.resolve('Local')}`);
      await a.destroy();
      log(`scope b survives ${b.resolve('S') === sb}`);
      log(`parent survives ${parent.resolve('P') === sa.p}`);
      await b.destroy();
    }, { parentGraph });
    expect(optimized.source).not.toBe(reference.source);
    for (const run of [reference, optimized]) {
      expect(count(run.trace, 'create S')).toBe(3);
      expect(count(run.trace, 'create P')).toBe(1);
      expect(run.trace).toContain('own singletons distinct true');
      expect(run.trace).toContain('parent singleton shared true');
      expect(run.trace).toContain('scope b survives true');
    }
    expect(optimized.trace).toEqual(reference.trace);
  });

  it('T17-A03 full profile event trace is identical on resolve, cache, parent and multi', async () => {
    const parentGraph = graphOf([['Parent_1', valueNode('Parent_1', '"from-parent"')]]);
    const graph = graphOf(
      [
        ['Local_1', valueNode('Local_1', '"local"')],
        ['Dep_1', factoryNode('Dep_1', '() => ({ name: "dep" })')],
        ['Con_1', factoryNode('Con_1', '(ctx) => ({ name: "con", dep: ctx.resolve("Dep_1") })', { deps: [dep('Dep_1')] })],
      ],
      {
        legacyContainers: ['parent'],
        multiNodes: new Map([
          ['Item_1', [
            factoryNode('Item_1', '() => ({ n: 1 })'),
            factoryNode('Item_1', '() => ({ n: 2 })'),
          ]],
        ]),
      },
    );
    const { reference, optimized } = await differential(graph, async ({ container, log, parent }) => {
      if (!parent) throw new Error('parent missing');
      assertFull(container);
      assertFull(parent);
      const stopChild = container.on('resolve', (token, instance) => log(`child ${String(token)} ${describeValue(instance)}`));
      parent.on('resolve', (token, instance) => log(`parent ${String(token)} ${describeValue(instance)}`));
      container.on('resolve', () => { throw new Error('listener bug'); });
      log('-- create');
      container.resolve('Con_1');
      log('-- cache hit');
      container.resolve('Con_1');
      container.resolve('Dep_1');
      log('-- multi');
      container.resolveAll('Item_1');
      container.resolveAll('missing');
      log('-- parent');
      container.resolve('Parent_1');
      container.resolve('Local_1');
      stopChild();
      log('-- unsubscribed');
      container.resolve('Local_1');
    }, { parentGraph });
    expect(optimized.source).not.toBe(reference.source);
    expect(reference.trace).toEqual([
      '-- create',
      'child Dep_1 dep',
      'child Dep_1 dep',
      'child Con_1 con',
      '-- cache hit',
      'child Con_1 con',
      'child Dep_1 dep',
      '-- multi',
      'child Item_1 n1',
      'child Item_1 n2',
      '-- parent',
      'parent Parent_1 from-parent',
      'child Parent_1 from-parent',
      'child Local_1 local',
      '-- unsubscribed',
    ]);
    expect(optimized.trace).toEqual(reference.trace);
  });

  it('T17-A04 override then clearOverrides then async initialize stays correct', async () => {
    const graph = graphOf([
      ['Db', factoryNode(
        'Db',
        'async () => { const n = seq(); log("create db " + n); return { name: "db" + n, dispose() { log("dispose db " + n); } }; }',
        { async: true, disposable: true },
      )],
      ['Consumer', factoryNode(
        'Consumer',
        '(ctx) => { log("create consumer"); return { name: "consumer", db: ctx.resolve("Db") }; }',
        { deps: [dep('Db')] },
      )],
    ]);
    const { reference, optimized } = await differential(graph, async ({ container, log }) => {
      assertFull(container);
      await container.initialize();
      const first = container.resolve('Consumer') as { db: { name: string } };
      log(`first db ${first.db.name}`);
      const mock = { name: 'mock', dispose() { log('dispose mock'); } };
      await container.override('Db', () => mock);
      await container.initialize();
      const second = container.resolve('Consumer') as { db: unknown };
      log(`consumer recreated ${second !== first}`);
      log(`consumer holds mock ${second.db === mock}`);
      log(`public resolve returns mock ${container.resolve('Db') === mock}`);
      await container.clearOverrides();
      await container.initialize();
      const third = container.resolve('Consumer') as { db: { name: string } };
      log(`consumer recreated again ${third !== second}`);
      log(`third db ${third.db.name}`);
      await container.destroy();
    }, { testOverrides: true });
    expect(optimized.source).not.toBe(reference.source);
    for (const run of [reference, optimized]) {
      expect(count(run.trace, 'dispose db 1')).toBe(1);
      expect(count(run.trace, 'dispose db 2')).toBe(1);
      expect(count(run.trace, 'dispose mock')).toBe(0);
      expect(run.trace).toContain('consumer holds mock true');
      expect(run.trace).toContain('public resolve returns mock true');
      expect(run.trace).toContain('third db db2');
    }
    expect(optimized.trace).toEqual(reference.trace);
  });

  it('T17-A05 minimal profile does not export on/override and carries neither maps nor branches', async () => {
    const asyncGraph = graphOf(
      [
        ['Db', factoryNode(
          'Db',
          'async () => { log("create db"); return { name: "db", dispose() { log("dispose db"); } }; }',
          { async: true, disposable: true },
        )],
        ['Owned', factoryNode(
          'Owned',
          '() => { log("create owned"); return { name: "owned", dispose() { log("dispose owned"); } }; }',
          { disposable: true },
        )],
        ['Consumer', factoryNode(
          'Consumer',
          '(ctx) => { log("create consumer"); return { name: "consumer", owned: ctx.resolve("Owned") }; }',
          { deps: [dep('Owned')] },
        )],
      ],
      { runtimeProfile: 'minimal' },
    );
    const run = open(asyncGraph, undefined, { testOverrides: true });
    const { container } = run;
    expect(typeof container.on).toBe('undefined');
    expect(typeof container.override).toBe('undefined');
    expect(typeof container.clearOverrides).toBe('undefined');
    expect(Object.keys(container)).not.toContain('overrides');
    expect(Object.keys(container)).not.toContain('resolveListeners');
    expect(run.source).not.toContain('notifyResolve');
    expect(run.source).not.toContain('resolveListeners');
    expect(run.source).not.toContain('overrides');
    expect(run.source).not.toContain('reconfiguring');
    expect(run.source).not.toContain('_reconfigure');

    await container.initialize();
    expect((container.resolve('Db') as { name: string }).name).toBe('db');
    const scope = container.createScope();
    expect(typeof scope.on).toBe('undefined');
    expect(typeof scope.override).toBe('undefined');
    const owned = container.resolve('Owned');
    expect(container.resolve('Owned')).toBe(owned);
    expect((container.resolve('Consumer') as { owned: unknown }).owned).toBe(owned);
    await container.destroy();
    expect(run.trace).toEqual(['create db', 'create owned', 'create consumer', 'dispose owned', 'dispose db']);

    const parentGraph = graphOf(
      [['Parent_1', valueNode('Parent_1', '"from-parent"')]],
      {
        multiNodes: new Map([
          ['Item_1', [factoryNode('Item_1', '() => ({ n: 1 })'), factoryNode('Item_1', '() => ({ n: 2 })')]],
        ]),
      },
    );
    const childGraph = graphOf(
      [['Local_1', valueNode('Local_1', '"local"')]],
      {
        runtimeProfile: 'minimal',
        legacyContainers: ['parent'],
        multiNodes: new Map([
          ['Item_2', [factoryNode('Item_2', '() => ({ n: 3 })'), factoryNode('Item_2', '() => ({ n: 4 })')]],
        ]),
      },
    );
    const parent = open(parentGraph, 'reference');
    const childRun = open(childGraph, undefined, { parent: parent.container });
    const child = childRun.container;
    expect(childRun.source).not.toContain('reconfiguring');
    expect(childRun.source).not.toContain('_reconfigure');
    expect(typeof child.on).toBe('undefined');
    expect(child.resolve('Local_1')).toBe('local');
    expect(child.resolve('Parent_1')).toBe('from-parent');
    expect(child.resolveAll('Item_1').map(describeValue)).toEqual(['n1', 'n2']);
    expect(child.resolveAll('Item_2').map(describeValue)).toEqual(['n3', 'n4']);
    expect(child.resolveAll('missing')).toEqual([]);
  });

  it('T17-A06 excluded providers do not come back via cleanup, debug or the export table', async () => {
    const graph = projectGraph(graphs, EXCLUDED);
    const deadKey = tokenId(graph, 'ExDead');
    const rootKey = tokenId(graph, 'ExRoot');
    const reference = open(graph, 'reference', { debug: true });
    const optimized = open(graph, 'optimized', { debug: true });
    for (const run of [reference, optimized]) {
      const { container } = run;
      expect(container.resolve(rootKey)).toEqual({ n: 1 });
      expect(container._graph).toEqual([rootKey]);
      expect(container._dependencyGraph?.map((edge) => edge.token)).toEqual([rootKey]);
      expect(container._singleRoots).toEqual(new Set([rootKey]));
      expect(failureOf(() => container.resolve(deadKey)).code).toBe('NEO_ROOT_NOT_EXPORTED');
      await container.destroy();
      expect(run.trace).toEqual(['create root']);
    }
    expect(optimized.source).not.toBe(reference.source);
    for (const run of [reference, optimized]) {
      expect(run.source).toContain(rootKey);
      expect(run.source).not.toContain(deadKey);
      expect(run.source).not.toContain('create dead');
      expect(run.source).not.toContain('dispose dead');
    }
  });

  it('T17-A07 effects and destructions are identical between generators on a combined fixture', async () => {
    const graph = projectGraph(graphs, COMBINED);
    const modules = (log: (message: string) => void): Record<string, unknown> => {
      class Db {
        constructor() { log('new Db'); }
        dispose(): void { log('dispose Db'); }
      }
      class Repo {
        constructor(readonly db: Db) { log('new Repo'); }
        dispose(): void { log('dispose Repo'); }
      }
      return { Db, Repo };
    };
    const cacheKey = tokenId(graph, 'CachePort');
    const pluginKey = tokenId(graph, 'PluginPort');
    const bootKey = tokenId(graph, 'BootPort');
    const settingsKey = tokenId(graph, 'Settings');
    const { reference, optimized } = await differential(graph, async ({ container, log }) => {
      await container.initialize();
      const cache = container.resolve(cacheKey) as { repo: { db: unknown } };
      log(`cache identical ${container.resolve(cacheKey) === cache}`);
      log(`boot ${describeValue(container.resolve(bootKey))}`);
      log(`settings ${describeValue(container.resolve(settingsKey))}`);
      const plugins = container.resolveAll(pluginKey);
      log(`plugins ${plugins.map(describeValue).join(',')}`);
      log(`plugins cached ${container.resolveAll(pluginKey)[0] === plugins[0]}`);
      const scope = container.createScope();
      await scope.initialize();
      const scoped = scope.resolve(cacheKey);
      log(`scope own cache ${scoped !== cache}`);
      await scope.destroy();
      await container.destroy();
    }, { modules });
    expect(optimized.source).not.toBe(reference.source);
    for (const run of [reference, optimized]) {
      expect(run.trace.indexOf('dispose cache')).toBeGreaterThanOrEqual(0);
      expect(run.trace.indexOf('dispose Repo')).toBeGreaterThan(run.trace.indexOf('dispose cache'));
      expect(run.trace.indexOf('dispose Db')).toBeGreaterThan(run.trace.indexOf('dispose Repo'));
      expect(count(run.trace, 'create plugin a')).toBe(1);
      expect(count(run.trace, 'create boot')).toBe(2);
    }
    expect(optimized.trace).toEqual(reference.trace);
  });

  it('T17-W2 a closed root reaches its private dependency while resolve stays root-only', () => {
    const graph = projectGraph(graphs, CLOSED_PRIVATE);
    const depKey = tokenId(graph, 'PrivDep');
    const rootKey = tokenId(graph, 'PrivRoot');
    for (const emitter of EMITTERS) {
      // The factory names the `dep` token variable, which the generated module does not declare.
      const { container } = open(graph, emitter, { modules: () => ({ dep: depKey }) });
      expect(container.resolve(rootKey)).toEqual({ n: 5 });
      expect(failureOf(() => container.resolve(depKey)).code).toBe('NEO_ROOT_NOT_EXPORTED');
    }
  });

  it('T17-W13 a closed public resolve and a dependency-free factory never reach the generic resolver', () => {
    const graph = projectGraph(graphs, CLOSED_PRIVATE);
    const depKey = tokenId(graph, 'PrivDep');
    const rootKey = tokenId(graph, 'PrivRoot');
    const { container, source: code } = open(graph, undefined, { modules: () => ({ dep: depKey }) });
    expect(methodText(code, 'public resolve<T>(token: any): T {')).not.toContain('_resolveInternal(');
    expect(code).not.toContain('_resolveInternal');
    expect(code).not.toContain('_resolveAllInternal');
    expect(container.resolve(rootKey)).toEqual({ n: 5 });
  });

  it('T17-W14 closed generic resolvers serve only parent tokens, declared multi tokens and opaque factories', async () => {
    const parentGraph = graphOf([['Parent_1', valueNode('Parent_1', '"from-parent"')]]);
    const consumer = (opaque: boolean): DependencyNode => {
      const node = factoryNode(
        'Consumer',
        '(ctx) => ({ name: "consumer", p: ctx.resolve("Parent_1"), l: ctx.resolve("Local"), items: ctx.resolveAll("Item_1") })',
        {
          deps: [dep('Parent_1'), dep('Local'), { tokenId: 'Item_1', all: true, source: '"Item_1"', containerId: 'Test' }],
        },
      );
      node.service.opaque = opaque;
      return node;
    };
    const closedGraph = (opaque: boolean): DependencyGraph => graphOf(
      [
        ['Consumer', consumer(opaque)],
        ['Local', factoryNode('Local', '() => ({ name: "local" })')],
      ],
      {
        optimizationMode: 'closed',
        publicRoots: ['Consumer'],
        publicMultiRoots: ['Other_1'],
        legacyContainers: ['parent'],
        multiNodes: new Map([
          ['Item_1', [factoryNode('Item_1', '() => ({ n: 1 })'), factoryNode('Item_1', '() => ({ n: 2 })')]],
          ['Other_1', [factoryNode('Other_1', '() => ({ n: 3 })')]],
        ]),
      },
    );
    const { reference, optimized } = await differential(closedGraph(false), async ({ container, log }) => {
      const value = container.resolve('Consumer') as { p: unknown; l: unknown; items: unknown[] };
      log(`parent ${String(value.p)} local ${describeValue(value.l)} items ${value.items.map(describeValue).join(',')}`);
    }, { parentGraph });
    expect(optimized.trace).toEqual(reference.trace);
    expect(optimized.trace).toEqual(['parent from-parent local local items n1,n2']);

    const internal = methodText(optimized.source, 'private _resolveInternal<T>(token: any): T {');
    expect(internal).not.toContain('_get_');
    expect(internal).not.toContain('_direct_');
    expect(internal).not.toContain('token === "Local"');
    const internalAll = methodText(optimized.source, 'private _resolveAllInternal<T>(token: any): T[] {');
    expect(internalAll).toContain('token === "Item_1"');
    expect(internalAll).not.toContain('token === "Other_1"');
    expect(methodText(optimized.source, 'public resolveAll<T>(token: any): T[] {')).not.toContain('_resolveAllInternal(');

    // An opaque factory may ask for any token, so the dispatcher lists every local provider again.
    const opaqueRun = await differential(closedGraph(true), async ({ container, log }) => {
      const value = container.resolve('Consumer') as { l: unknown };
      log(`local ${describeValue(value.l)}`);
    }, { parentGraph });
    expect(opaqueRun.optimized.trace).toEqual(opaqueRun.reference.trace);
    expect(opaqueRun.optimized.trace).toEqual(['local local']);
    expect(methodText(opaqueRun.optimized.source, 'private _resolveInternal<T>(token: any): T {')).toContain('token === "Local"');
  });

  it('T17-W12 an override on a token nobody registered wins on resolve and notifies', async () => {
    const graph = graphOf([['Known', factoryNode('Known', '() => ({ name: "known" })')]]);
    const { reference, optimized } = await differential(graph, async ({ container, log }) => {
      assertFull(container);
      container.on('resolve', (token, instance) => log(`event ${String(token)} ${describeValue(instance)}`));
      await container.override('Ghost', () => ({ name: 'ghost' }));
      const first = container.resolve('Ghost');
      log(`ghost ${describeValue(first)} cached ${container.resolve('Ghost') === first}`);
      log(`known ${describeValue(container.resolve('Known'))}`);
    }, { testOverrides: true });
    expect(optimized.trace).toEqual(reference.trace);
    expect(optimized.trace).toEqual([
      'event Ghost ghost',
      'event Ghost ghost',
      'ghost ghost cached true',
      'event Known known',
      'known known',
    ]);
  });

  it('T17-P8 analyzer reads a literal profile and refuses a non-literal one', () => {
    expect(projectGraph(graphs, MINIMAL_LITERAL).runtimeProfile).toBe('minimal');
    expect(projectGraph(graphs, MINIMAL_AS).runtimeProfile).toBe('minimal');
    expect(projectGraph(graphs, PROFILE_FULL).runtimeProfile).toBe('full');
    expect(projectGraph(graphs, PROFILE_UNDEFINED).runtimeProfile).toBeUndefined();
    expect(projectGraph(graphs, PROFILE_UNDEFINED).errors ?? []).toEqual([]);
    // `runtime: undefined` is accepted by the public types as the full profile.
    expect(projectGraph(graphs, RUNTIME_UNDEFINED).runtimeProfile).toBeUndefined();
    expect(projectGraph(graphs, RUNTIME_UNDEFINED).errors ?? []).toEqual([]);
    // Quoted property names are the same property for the types, so they are the same for the analyzer.
    expect(projectGraph(graphs, RUNTIME_QUOTED_OUTER).runtimeProfile).toBe('minimal');
    expect(projectGraph(graphs, RUNTIME_QUOTED_INNER).runtimeProfile).toBe('minimal');
    for (const file of [RUNTIME_SPREAD, RUNTIME_COMPUTED]) {
      const errors = projectGraph(graphs, file).errors ?? [];
      expect(errors.map((error) => error.code)).toEqual(['NEO_CONFIG_UNSUPPORTED']);
      expect(errors[0].message).toBe(
        'NEO_CONFIG_UNSUPPORTED: runtime must be an object literal without spread or computed members.',
      );
      expect(projectGraph(graphs, file).runtimeProfile).toBeUndefined();
    }

    for (const file of [PROFILE_VARIABLE, PROFILE_UNKNOWN]) {
      const errors = projectGraph(graphs, file).errors ?? [];
      expect(errors.map((error) => error.code)).toEqual(['NEO_CONFIG_UNSUPPORTED']);
      expect(errors[0].message).toBe(
        "NEO_CONFIG_UNSUPPORTED: runtime.profile must be the string literal 'full' or 'minimal'.",
      );
      expect(projectGraph(graphs, file).runtimeProfile).toBeUndefined();
    }

    const literal = open(projectGraph(graphs, MINIMAL_LITERAL), undefined);
    expect(typeof literal.container.on).toBe('undefined');
    expect(typeof literal.container.createScope().on).toBe('undefined');
    const asCast = open(projectGraph(graphs, MINIMAL_AS), undefined);
    expect(typeof asCast.container.override).toBe('undefined');
    const full = open(projectGraph(graphs, PROFILE_FULL), undefined);
    expect(typeof full.container.on).toBe('function');
  });

  it('T17-P9 the default full profile keeps the reference emission', async () => {
    const graph = graphOf([
      ['Local', factoryNode('Local', '() => ({ name: "local" })')],
    ]);
    const byDefault = open(graph, undefined, { testOverrides: true });
    const reference = open(graph, 'reference', { testOverrides: true });
    expect(byDefault.source).toBe(reference.source);
    const { container } = byDefault;
    assertFull(container);
    const seen: string[] = [];
    container.on('resolve', (token, instance) => seen.push(`${String(token)} ${describeValue(instance)}`));
    container.resolve('Local');
    container.resolve('Local');
    expect(seen).toEqual(['Local local', 'Local local']);
    await container.override('Local', () => ({ name: 'mock' }));
    expect(describeValue(container.resolve('Local'))).toBe('mock');
  });

  it('T17-P10 two instances created from one module do not share singletons', () => {
    const graph = graphOf([
      ['Shared', factoryNode('Shared', '() => { log("create shared"); return { name: "shared" }; }')],
    ]);
    for (const emitter of EMITTERS) {
      const run = open(graph, emitter, { suffix: 'export const second = new NeoContainer();' });
      const second = run.exports.second;
      if (!second) throw new Error('second instance missing');
      closers.push(() => second.destroy().catch(() => undefined));
      const first = run.container.resolve('Shared');
      expect(run.container.resolve('Shared')).toBe(first);
      expect(second.resolve('Shared')).not.toBe(first);
      expect(count(run.trace, 'create shared')).toBe(2);
    }
  });

  it('T17-P12 boundaries: zero providers, one root, closed rejects a foreign token', () => {
    const empty = graphOf([]);
    for (const emitter of EMITTERS) {
      const { container } = open(empty, emitter);
      const failure = failureOf(() => container.resolve('anything'));
      expect(failure.name).toBe('NeoServiceNotFoundError');
      expect(failure.message).toContain('Service not found or token not registered');
      expect(container.resolveAll('anything')).toEqual([]);
    }

    const graph = projectGraph(graphs, SINGLE_ROOT);
    const onlyKey = tokenId(graph, 'OnlyPort');
    const foreignKey = tokenId(graph, 'ForeignPort');
    for (const emitter of EMITTERS) {
      const { container } = open(graph, emitter);
      expect(container.resolve(onlyKey)).toEqual({ n: 7 });
      expect(failureOf(() => container.resolve(foreignKey)).code).toBe('NEO_ROOT_NOT_EXPORTED');
      expect(failureOf(() => container.resolve('unknown')).code).toBe('NEO_ROOT_NOT_EXPORTED');
    }
  });
});
