import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as ts from 'typescript';
import { hasText, textAt, virtualResolved } from '../helpers/tsPath';
import { Analyzer } from '../../src/analyzer/Analyzer';
import { Generator } from '../../src/generator/Generator';
import { GraphValidator } from '../../src/generator/GraphValidator';
import type { AnalysisError, DependencyGraph } from '../../src/analyzer/types';
import { createFastProgram, warmLibCache } from '../fastProgram';

const ROOT = '/virtual/t16-runtime';

const STUB = `
  import { defineBuilderConfig, definePartialConfig, useInterface } from '@djodjonx/neosyringe';
  function defineBuilderConfig(config: any) { return config; }
  function definePartialConfig(config: any) { return config; }
  function useInterface<T>(): any { return null; }
`;

function source(body: string): string {
  return `${STUB}\n${body}\n`;
}

const TRANSITIVE = path.join(ROOT, 'transitive.ts');
const PRIVATE = path.join(ROOT, 'private.ts');
const ALL = path.join(ROOT, 'all.ts');
const OPAQUE_CLOSED = path.join(ROOT, 'opaque-closed.ts');
const OPAQUE_OPEN = path.join(ROOT, 'opaque-open.ts');
const EAGER = path.join(ROOT, 'eager.ts');
const ASYNC = path.join(ROOT, 'async.ts');
const EFFECTS = path.join(ROOT, 'effects.ts');
const EFFECT_MOD = path.join(ROOT, 'effect-mod.ts');
const PARTIAL = path.join(ROOT, 'partial.ts');
const VALUE_PARTIAL = path.join(ROOT, 'value-partial.ts');
const INLINE_VALUES = path.join(ROOT, 'inline-values.ts');
const CYCLE = path.join(ROOT, 'cycle.ts');
const MISSING_DEP = path.join(ROOT, 'missing-dep.ts');
const DUP = path.join(ROOT, 'dup.ts');
const EMIT = path.join(ROOT, 'emit.ts');
const HEAVY = path.join(ROOT, 'heavy.ts');
const OPEN_ABSENT = path.join(ROOT, 'open-absent.ts');
const OPEN_EXPLICIT = path.join(ROOT, 'open-explicit.ts');
const CLOSED_SAME = path.join(ROOT, 'closed-same.ts');
const COMPAT_CLOSED = path.join(ROOT, 'compat-closed.ts');

const files = new Map<string, string>([
  [HEAVY, `
    export class HeavyLeaf {
      readonly payload = 'HEAVY_LEAF_IMPORT';
    }
  `],
  [EFFECT_MOD, `
    (globalThis as { __t16Import?: number }).__t16Import =
      ((globalThis as { __t16Import?: number }).__t16Import ?? 0) + 1;
    export class EffectMark { readonly id = 1; }
  `],
  [PARTIAL, source(`
    export interface PartPort { n: number }
    export const part = definePartialConfig({
      injections: [
        {
          token: useInterface<PartPort>(),
          useValue: ((globalThis as { __t16Partial?: number }).__t16Partial =
            ((globalThis as { __t16Partial?: number }).__t16Partial ?? 0) + 1),
        },
      ],
    });
  `)],
  [TRANSITIVE, source(`
    interface TransDep { kind: string }
    interface TransRoot { d: TransDep }
    interface TransHeavy { n: number }
    class D { readonly kind = 'd'; }
    const dep = useInterface<TransDep>();
    const root = useInterface<TransRoot>();
    const heavy = useInterface<TransHeavy>();
    export const transitive = defineBuilderConfig({
      name: 'Transitive',
      optimization: { mode: 'closed', roots: [root] },
      injections: [
        { token: dep, useFactory: true, dependencies: [], provider: () => new D() },
        { token: root, useFactory: true, dependencies: [dep], provider: (ctx) => ({ d: ctx.resolve(dep) }) },
        { token: heavy, useFactory: true, dependencies: [], provider: () => { throw new Error('HEAVY_TRANSITIVE'); } },
      ],
    });
  `)],
  [PRIVATE, source(`
    interface PrivDep { n: number }
    interface PrivRoot { n: number }
    const dep = useInterface<PrivDep>();
    const root = useInterface<PrivRoot>();
    export const priv = defineBuilderConfig({
      name: 'Private',
      optimization: { mode: 'closed', roots: [root] },
      injections: [
        { token: dep, useFactory: true, dependencies: [], provider: () => ({ n: 4 }) },
        { token: root, useFactory: true, dependencies: [dep], provider: (ctx) => ctx.resolve(dep) },
      ],
    });
    export function readPrivate() {
      return priv.resolve(dep);
    }
  `)],
  [ALL, source(`
    interface AllMid { n: number; from: string }
    interface AllHeavy { n: number }
    const mid = useInterface<AllMid>();
    const heavy = useInterface<AllHeavy>();
    export const allRoot = defineBuilderConfig({
      name: 'AllRoot',
      optimization: { mode: 'closed', roots: [{ all: mid }] },
      injections: [
        { token: mid, multi: true, useFactory: true, dependencies: [], provider: async () => ({ n: 1, from: 'a' }) },
        { token: mid, multi: true, useFactory: true, dependencies: [], provider: async () => ({ n: 2, from: 'b' }) },
        { token: mid, multi: true, useFactory: true, dependencies: [], provider: async () => ({ n: 3, from: 'c' }) },
        { token: heavy, useFactory: true, dependencies: [], provider: () => { throw new Error('HEAVY_ALL'); } },
      ],
    });
  `)],
  [OPAQUE_CLOSED, source(`
    interface OpaqueClosedPort { n: number }
    const token = useInterface<OpaqueClosedPort>();
    export const opaqueClosed = defineBuilderConfig({
      name: 'OpaqueClosed',
      optimization: { mode: 'closed', roots: [token] },
      injections: [
        { token: token, useFactory: true, provider: () => ({ n: 1 }) },
      ],
    });
  `)],
  [OPAQUE_OPEN, source(`
    interface OpaqueOpenCfg { u: string }
    interface OpaqueOpenHost { u: string }
    const cfg = useInterface<OpaqueOpenCfg>();
    const host = useInterface<OpaqueOpenHost>();
    export const opaqueOpen = defineBuilderConfig({
      name: 'OpaqueOpen',
      optimization: { mode: 'open' },
      injections: [
        { token: cfg, useValue: { u: 'ok' } },
        { token: host, useFactory: true, provider: (ctx) => ctx.resolve(cfg) },
      ],
    });
  `)],
  [EAGER, source(`
    interface EagerPort { on: boolean }
    interface EagerRoot { ok: number }
    const eager = useInterface<EagerPort>();
    const root = useInterface<EagerRoot>();
    export const eagerOnce = defineBuilderConfig({
      name: 'EagerOnce',
      optimization: { mode: 'closed', roots: [root], eager: [eager] },
      injections: [
        {
          token: eager,
          useFactory: true,
          dependencies: [],
          provider: () => {
            const holder = globalThis as { __t16Eager?: number };
            holder.__t16Eager = (holder.__t16Eager ?? 0) + 1;
            return { on: true };
          },
        },
        { token: root, useFactory: true, dependencies: [], provider: () => ({ ok: 1 }) },
      ],
    });
  `)],
  [ASYNC, source(`
    interface AsyncOut { n: number }
    interface AsyncIn { n: number }
    interface AsyncRoot { n: number }
    const outside = useInterface<AsyncOut>();
    const inside = useInterface<AsyncIn>();
    const root = useInterface<AsyncRoot>();
    export const asyncOut = defineBuilderConfig({
      name: 'AsyncOut',
      optimization: { mode: 'closed', roots: [root] },
      injections: [
        {
          token: outside,
          multi: true,
          useFactory: true,
          dependencies: [],
          provider: async () => {
            const holder = globalThis as { __t16Out?: number };
            holder.__t16Out = (holder.__t16Out ?? 0) + 1;
            return { n: 1 };
          },
        },
        {
          token: inside,
          useFactory: true,
          dependencies: [],
          provider: async () => {
            const holder = globalThis as { __t16In?: number };
            holder.__t16In = (holder.__t16In ?? 0) + 1;
            return { n: 2 };
          },
        },
        { token: root, useFactory: true, dependencies: [inside], provider: async (ctx) => ctx.resolve(inside) },
      ],
    });
  `)],
  [VALUE_PARTIAL, source(`
    export interface GonePort { n: number }
    export interface KeptPort { n: number }
    export const gonePart = definePartialConfig({
      injections: [
        { token: useInterface<GonePort>(), useValue: { n: 0 } },
      ],
    });
    export const keptPart = definePartialConfig({
      injections: [
        { token: useInterface<KeptPort>(), useValue: { n: 1 } },
      ],
    });
  `)],
  [INLINE_VALUES, source(`
    import { gonePart, keptPart } from './value-partial';
    import type { KeptPort } from './value-partial';
    interface RootPort { n: number }
    interface GoneInline { n: number }
    interface KeptInline { n: number }
    const kept = useInterface<KeptPort>();
    const root = useInterface<RootPort>();
    const goneInline = useInterface<GoneInline>();
    const keptInline = useInterface<KeptInline>();
    export const inlineValues = defineBuilderConfig({
      name: 'InlineValues',
      optimization: { mode: 'closed', roots: [root] },
      extends: [gonePart, keptPart],
      injections: [
        {
          token: root,
          useFactory: true,
          dependencies: [kept, keptInline],
          provider: (ctx) => ({ kept: ctx.resolve(kept), inline: ctx.resolve(keptInline) }),
        },
        {
          token: goneInline,
          useValue: ((globalThis as { __t16GoneInline?: number }).__t16GoneInline =
            ((globalThis as { __t16GoneInline?: number }).__t16GoneInline ?? 0) + 1),
        },
        {
          token: keptInline,
          useValue: ((globalThis as { __t16KeptInline?: number }).__t16KeptInline =
            ((globalThis as { __t16KeptInline?: number }).__t16KeptInline ?? 0) + 1),
        },
      ],
    });
  `)],
  [EFFECTS, source(`
    import { part } from './partial';
    import { EffectMark } from './effect-mod';
    interface EffectRoot { ok: number }
    interface EffectValue { n: number }
    interface EffectPart { n: number }
    const root = useInterface<EffectRoot>();
    const pruned = useInterface<EffectValue>();
    const marked = useInterface<EffectMark>();
    export const effects = defineBuilderConfig({
      name: 'Effects',
      optimization: { mode: 'closed', roots: [root] },
      extends: [part],
      injections: [
        { token: root, useFactory: true, dependencies: [], provider: () => ({ ok: 1 }) },
        {
          token: pruned,
          useValue: ((globalThis as { __t16Value?: number }).__t16Value =
            ((globalThis as { __t16Value?: number }).__t16Value ?? 0) + 1),
        },
        { token: marked, provider: EffectMark },
      ],
    });
  `)],
  [CYCLE, source(`
    interface CycleA { n: number }
    interface CycleB { n: number }
    interface CycleRoot { ok: number }
    const a = useInterface<CycleA>();
    const b = useInterface<CycleB>();
    const root = useInterface<CycleRoot>();
    export const cycle = defineBuilderConfig({
      name: 'CycleKeep',
      optimization: { mode: 'closed', roots: [root] },
      injections: [
        { token: root, useFactory: true, dependencies: [], provider: () => ({ ok: 1 }) },
        { token: a, useFactory: true, dependencies: [b], provider: () => ({ n: 1 }) },
        { token: b, useFactory: true, dependencies: [a], provider: () => ({ n: 2 }) },
      ],
    });
  `)],
  [MISSING_DEP, source(`
    interface MissHost { n: number }
    interface MissGone { n: number }
    interface MissRoot { ok: number }
    const host = useInterface<MissHost>();
    const gone = useInterface<MissGone>();
    const root = useInterface<MissRoot>();
    export const missingDep = defineBuilderConfig({
      name: 'MissingDep',
      optimization: { mode: 'closed', roots: [root] },
      injections: [
        { token: root, useFactory: true, dependencies: [], provider: () => ({ ok: 1 }) },
        { token: host, useFactory: true, dependencies: [gone], provider: () => { throw new Error('UNREACHABLE_BROKEN'); } },
      ],
    });
  `)],
  [DUP, source(`
    interface DupPort { id: number }
    interface DupRoot { ok: number }
    const dup = useInterface<DupPort>();
    const root = useInterface<DupRoot>();
    export const dupParent = defineBuilderConfig({
      name: 'DupParent',
      injections: [
        { token: dup, useFactory: true, dependencies: [], provider: () => ({ id: 1 }) },
      ],
    });
    export const dupChild = defineBuilderConfig({
      name: 'DupChild',
      optimization: { mode: 'closed', roots: [root] },
      useContainer: dupParent,
      injections: [
        { token: root, useFactory: true, dependencies: [], provider: () => ({ ok: 1 }) },
        { token: dup, useFactory: true, dependencies: [], provider: () => ({ id: 2 }) },
      ],
    });
  `)],
  [EMIT, source(`
    import { HeavyLeaf } from './heavy';
    interface EmitRoot { ok: number }
    interface EmitHeavy { payload: string }
    const root = useInterface<EmitRoot>();
    const heavy = useInterface<EmitHeavy>();
    export const emitted = defineBuilderConfig({
      name: 'Emitted',
      optimization: { mode: 'closed', roots: [root] },
      injections: [
        { token: root, useFactory: true, dependencies: [], provider: () => ({ ok: 1 }) },
        { token: heavy, provider: HeavyLeaf },
      ],
    });
  `)],
  [OPEN_ABSENT, source(`
    interface SameRoot { ok: number }
    interface SameHeavy { n: number }
    const root = useInterface<SameRoot>();
    const heavy = useInterface<SameHeavy>();
    export const openAbsent = defineBuilderConfig({
      name: 'SameShape',
      injections: [
        { token: root, useFactory: true, dependencies: [], provider: () => ({ ok: 1 }) },
        { token: heavy, useFactory: true, dependencies: [], provider: () => { throw new Error('HEAVY_SAME'); } },
      ],
    });
  `)],
  [OPEN_EXPLICIT, source(`
    interface SameRoot { ok: number }
    interface SameHeavy { n: number }
    const root = useInterface<SameRoot>();
    const heavy = useInterface<SameHeavy>();
    export const openExplicit = defineBuilderConfig({
      name: 'SameShape',
      optimization: { mode: 'open' },
      injections: [
        { token: root, useFactory: true, dependencies: [], provider: () => ({ ok: 1 }) },
        { token: heavy, useFactory: true, dependencies: [], provider: () => { throw new Error('HEAVY_SAME'); } },
      ],
    });
  `)],
  [CLOSED_SAME, source(`
    interface SameRoot { ok: number }
    interface SameHeavy { n: number }
    const root = useInterface<SameRoot>();
    const heavy = useInterface<SameHeavy>();
    export const closedSame = defineBuilderConfig({
      name: 'SameShape',
      optimization: { mode: 'closed', roots: [root] },
      injections: [
        { token: root, useFactory: true, dependencies: [], provider: () => ({ ok: 1 }) },
        { token: heavy, useFactory: true, dependencies: [], provider: () => { throw new Error('HEAVY_SAME'); } },
      ],
    });
  `)],
  [COMPAT_CLOSED, source(`
    interface CompatRoot { ok: number }
    const token = useInterface<CompatRoot>();
    export const compatClosed = defineBuilderConfig({
      name: 'CompatClosed',
      optimization: { mode: 'closed', roots: [token] },
      injections: [
        { token, useFactory: true, dependencies: [], provider: () => ({ ok: 1 }) },
      ],
    });
  `)],
]);

interface RuntimeContainer {
  initialize: () => Promise<void>;
  resolve: (token: string) => unknown;
  resolveAll: (token: string) => unknown[];
  destroy: () => Promise<void>;
}

const opened: RuntimeContainer[] = [];

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

function tokenId(graph: DependencyGraph, name: string): string {
  const keys = [
    ...graph.nodes.keys(),
    ...(graph.multiNodes ? [...graph.multiNodes.keys()] : []),
  ];
  const found = keys.find((id) => id.includes(name));
  if (!found) throw new Error(`missing token ${name}`);
  return found;
}

function readFailure(value: unknown): { code: string | undefined; message: string } {
  if (!(value instanceof Error)) return { code: undefined, message: '' };
  const coded = value as Error & { code?: unknown };
  return { code: typeof coded.code === 'string' ? coded.code : undefined, message: value.message };
}

let importLoads = 0;

function execute(
  graph: DependencyGraph,
  bindings: Record<string, string> = {},
  prelude = '',
): { container: RuntimeContainer; code: string } {
  const header = Object.entries(bindings)
    .map(([name, value]) => `const ${name} = ${JSON.stringify(value)};`)
    .join('\n');
  const tsCode = `${header}\n${prelude}\n${new Generator(graph, false).generate()}`;
  const jsCode = ts.transpileModule(tsCode, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const moduleRecord: { exports: Record<string, RuntimeContainer | undefined> } = { exports: {} };
  const run = new Function('module', 'exports', 'require', jsCode) as (
    module: typeof moduleRecord,
    exports: typeof moduleRecord.exports,
    require: (id: string) => unknown,
  ) => void;
  run(moduleRecord, moduleRecord.exports, (id: string) => {
    if (id.includes('effect-mod')) importLoads += 1;
    return {};
  });
  const name = graph.exportedVariableName ?? 'container';
  const container = moduleRecord.exports[name];
  if (!container) throw new Error(`generated module did not export ${name}`);
  opened.push(container);
  return { container, code: tsCode };
}

function hardErrors(errors: readonly AnalysisError[]): AnalysisError[] {
  return errors.filter((error) => error.severity !== 'warning');
}

describe('T16 closed runtime', () => {
  let graphs: Map<string, DependencyGraph>;
  let compatible: Map<string, DependencyGraph>;
  let analyzer: Analyzer;

  beforeAll(() => {
    warmLibCache();
    const program = programFrom(files);
    analyzer = new Analyzer(program);
    graphs = new Map();
    for (const graph of analyzer.extractAll()) graphs.set(graph.sourceFileName ?? graph.containerId, graph);
    compatible = new Map();
    for (const graph of new Analyzer(program, { validation: 'compatible' }).extractAll()) {
      compatible.set(graph.sourceFileName ?? graph.containerId, graph);
    }
  });

  function named(map: Map<string, DependencyGraph>, name: string): DependencyGraph | undefined {
    for (const graph of map.values()) {
      if (graph.containerId === name) return graph;
    }
    return undefined;
  }

  afterEach(async () => {
    const pending = opened.splice(0);
    for (const container of pending) {
      await container.destroy();
    }
    importLoads = 0;
    Reflect.deleteProperty(globalThis, '__t16Eager');
    Reflect.deleteProperty(globalThis, '__t16Out');
    Reflect.deleteProperty(globalThis, '__t16In');
    Reflect.deleteProperty(globalThis, '__t16Value');
    Reflect.deleteProperty(globalThis, '__t16Partial');
    Reflect.deleteProperty(globalThis, '__t16Part');
    Reflect.deleteProperty(globalThis, '__t16Import');
    Reflect.deleteProperty(globalThis, '__t16GoneInline');
    Reflect.deleteProperty(globalThis, '__t16KeptInline');
    Reflect.deleteProperty(globalThis, '__t16GoneRead');
    Reflect.deleteProperty(globalThis, '__t16KeptRead');
  });

  it('T16-A03 transitive', () => {
    const graph = named(graphs, 'Transitive');
    if (!graph) throw new Error('missing Transitive');
    const dep = tokenId(graph, 'TransDep');
    const root = tokenId(graph, 'TransRoot');
    const { container, code } = execute(graph, { dep, root }, 'class D { readonly kind = "d"; }');
    const value = container.resolve(root) as { d: { kind: string } };
    expect(value.d).toBeInstanceOf(Object);
    expect(value.d.kind).toBe('d');
    expect(code).not.toContain('HEAVY_TRANSITIVE');
  });

  it('T16-A04 private dep', () => {
    const graph = named(graphs, 'Private');
    if (!graph) throw new Error('missing Private');
    const dep = tokenId(graph, 'PrivDep');
    const root = tokenId(graph, 'PrivRoot');
    const fileErrors = analyzer.extractForFile(PRIVATE).errors.filter((error) => error.code === 'NEO_ROOT_NOT_EXPORTED');
    expect(fileErrors.length).toBeGreaterThan(0);
    expect(fileErrors[0]?.message).toContain('NEO_ROOT_NOT_EXPORTED');
    const { container } = execute(graph, { dep, root });
    const reached = container.resolve(root) as { n: number };
    expect(reached.n).toBe(4);
    let caught: unknown;
    try {
      container.resolve(dep);
    } catch (error) {
      caught = error;
    }
    const failure = readFailure(caught);
    expect(failure.code).toBe('NEO_ROOT_NOT_EXPORTED');
    expect(failure.message).toContain('NEO_ROOT_NOT_EXPORTED');
  });

  it('T16-A05 root all', async () => {
    const graph = named(graphs, 'AllRoot');
    if (!graph) throw new Error('missing AllRoot');
    const mid = tokenId(graph, 'AllMid');
    const { container, code } = execute(graph, { mid });
    await container.initialize();
    const values = container.resolveAll(mid) as { n: number; from: string }[];
    expect(values.map((item) => item.n)).toEqual([1, 2, 3]);
    expect(values.map((item) => item.from)).toEqual(['a', 'b', 'c']);
    expect(code).not.toContain('HEAVY_ALL');
  });

  it('T16-A06 opaque factory', () => {
    const open = named(compatible, 'OpaqueOpen');
    if (!open) throw new Error('missing OpaqueOpen');
    const cfg = tokenId(open, 'OpaqueOpenCfg');
    const host = tokenId(open, 'OpaqueOpenHost');
    const openedValue = execute(open, { cfg, host }).container.resolve(host);
    expect(openedValue).toEqual({ u: 'ok' });
    const closed = named(compatible, 'OpaqueClosed');
    if (!closed) throw new Error('missing OpaqueClosed');
    const closedCodes = hardErrors(closed.errors ?? []).map((error) => error.code);
    expect(closedCodes).toContain('NEO_FACTORY_DEPENDENCIES_REQUIRED');
  });

  it('T16-A06 eager once', async () => {
    const graph = named(graphs, 'EagerOnce');
    if (!graph) throw new Error('missing EagerOnce');
    const eager = tokenId(graph, 'EagerPort');
    const root = tokenId(graph, 'EagerRoot');
    const { container } = execute(graph, { eager, root });
    await container.initialize();
    await container.initialize();
    expect(Reflect.get(globalThis, '__t16Eager')).toBe(1);
    let caught: unknown;
    try {
      container.resolve(eager);
    } catch (error) {
      caught = error;
    }
    expect(readFailure(caught).code).toBe('NEO_ROOT_NOT_EXPORTED');
    expect(container.resolve(root)).toEqual({ ok: 1 });
  });

  it('T16-A07 async outside', async () => {
    const graph = named(graphs, 'AsyncOut');
    if (!graph) throw new Error('missing AsyncOut');
    const outside = tokenId(graph, 'AsyncOut');
    const inside = tokenId(graph, 'AsyncIn');
    const root = tokenId(graph, 'AsyncRoot');
    const pruned = graph.multiNodes?.get(outside)?.[0];
    if (!pruned) throw new Error('missing pruned async');
    const prunedKey = pruned.service.registrationId ?? outside;
    expect(graph.retention?.get(prunedKey)?.kind).toBe('unreachable');
    const { container } = execute(graph, { inside, root });
    await container.initialize();
    expect(Reflect.get(globalThis, '__t16Out') ?? 0).toBe(0);
    expect(Reflect.get(globalThis, '__t16In')).toBe(1);
    expect(container.resolve(root)).toEqual({ n: 2 });
  });

  it('T16-A08 effects', () => {
    const graph = named(graphs, 'Effects');
    if (!graph) throw new Error('missing Effects');
    const root = tokenId(graph, 'EffectRoot');
    const partialJs = ts.transpileModule(files.get(PARTIAL) ?? '', {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const partialModule: { exports: { part?: { injections: Array<{ useValue: number }> } } } = { exports: {} };
    const loadPartial = new Function('module', 'exports', partialJs) as (
      module: typeof partialModule,
      exports: typeof partialModule.exports,
    ) => void;
    loadPartial(partialModule, partialModule.exports);
    const part = partialModule.exports.part;
    if (!part) throw new Error('partial module did not export part');
    const prelude = 'const part = (globalThis as { __t16Part?: { injections: Array<{ useValue: number }> } }).__t16Part;';
    (globalThis as { __t16Part?: typeof part }).__t16Part = part;
    const { container } = execute(graph, { root }, prelude);
    container.resolve(root);
    container.resolve(root);
    expect(Reflect.get(globalThis, '__t16Value')).toBe(1);
    expect(Reflect.get(globalThis, '__t16Partial')).toBe(1);
    expect(importLoads).toBe(1);
    expect(container.resolve(root)).toEqual({ ok: 1 });
  });

  it('T16-A08 inline values', () => {
    const graph = named(graphs, 'InlineValues');
    if (!graph) throw new Error('missing InlineValues');
    const root = tokenId(graph, 'RootPort');
    const kept = tokenId(graph, 'KeptPort');
    const keptInline = tokenId(graph, 'KeptInline');
    const prelude = `
      function __t16Count(key) {
        return {
          injections: [{
            get useValue() {
              const holder = globalThis;
              const next = (holder[key] ?? 0) + 1;
              holder[key] = next;
              return { n: next };
            },
          }],
        };
      }
      const gonePart = __t16Count('__t16GoneRead');
      const keptPart = __t16Count('__t16KeptRead');
    `;
    const { container } = execute(graph, { root, kept, keptInline }, prelude);
    const first = container.resolve(root) as { kept: { n: number }; inline: number };
    const second = container.resolve(root);
    expect(first.inline).toBe(1);
    expect(second).toBe(first);
    expect(Reflect.get(globalThis, '__t16GoneInline')).toBe(1);
    expect(Reflect.get(globalThis, '__t16KeptInline')).toBe(1);
    expect(Reflect.get(globalThis, '__t16GoneRead')).toBe(1);
    expect(Reflect.get(globalThis, '__t16KeptRead')).toBe(2);
    expect(first.kept.n).toBe(2);
  });

  it('T16 validation before pruning', () => {
    const cycle = named(graphs, 'CycleKeep');
    const missing = named(graphs, 'MissingDep');
    const duplicate = named(graphs, 'DupChild');
    if (!cycle || !missing || !duplicate) throw new Error('missing validation graph');
    const validator = new GraphValidator();
    expect(validator.validateAll(cycle).errors.some((error) => error.code === 'NEO_CYCLE')).toBe(true);
    expect(validator.validateAll(missing).errors.some((error) => error.code === 'NEO_MISSING_PROVIDER')).toBe(true);
    expect(validator.validateAll(duplicate).errors.some((error) => error.type === 'duplicate')).toBe(true);
    const unreachable = [...(missing.retention?.values() ?? [])].filter((reason) => reason.kind === 'unreachable');
    expect(unreachable.length).toBeGreaterThan(0);
  });

  it('T16 retained emission', () => {
    const graph = named(graphs, 'Emitted');
    if (!graph) throw new Error('missing Emitted');
    const code = new Generator(graph, false).generate();
    const heavy = tokenId(graph, 'EmitHeavy');
    expect(code).not.toContain(heavy);
    expect(code).not.toContain('HEAVY_LEAF_IMPORT');
    expect(code).not.toContain('heavy');
    expect(code).toContain('Emitted');
  });

  it('T16 open default unchanged', () => {
    const absent = graphs.get(OPEN_ABSENT);
    const explicit = graphs.get(OPEN_EXPLICIT);
    const closedGraph = graphs.get(CLOSED_SAME);
    if (!absent || !explicit || !closedGraph) throw new Error('missing open comparison');
    const normalize = (value: string) => value.replace(/_[0-9a-f]{8}/g, '_HASH').replace(/export const \w+ =/, 'export const container =');
    const withoutKey = normalize(new Generator(absent, false).generate());
    const withOpen = normalize(new Generator(explicit, false).generate());
    const closedCode = normalize(new Generator(closedGraph, false).generate());
    expect(withoutKey).toBe(withOpen);
    expect(closedCode).not.toBe(withoutKey);
  });

  it('T16 compatible closed is strict', () => {
    const graph = named(compatible, 'CompatClosed');
    if (!graph) throw new Error('missing CompatClosed');
    expect(hardErrors(graph.errors ?? []).map((error) => error.code)).toContain('NEO_CLOSED_REQUIRES_STRICT');
  });
});
