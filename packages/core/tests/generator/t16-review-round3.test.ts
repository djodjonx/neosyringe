import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as ts from 'typescript';
import { Analyzer } from '../../src/analyzer/Analyzer';
import type { AnalysisError, DependencyGraph } from '../../src/analyzer/types';
import { Generator } from '../../src/generator/Generator';
import { createFastProgram, warmLibCache } from '../fastProgram';

const ROOT = '/virtual/t16-review';

const STUB = `
  import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';
  function defineBuilderConfig(config: any) { return config; }
  function useInterface<T>(): any { return null; }
`;

function source(body: string): string {
  return `${STUB}\n${body}\n`;
}

function count(holder: string): string {
  return `(globalThis as { ${holder}?: number }).${holder} = ((globalThis as { ${holder}?: number }).${holder} ?? 0) + 1`;
}

const PAIR = path.join(ROOT, 'pair.ts');
const PAIR_ASYNC = path.join(ROOT, 'pair-async.ts');
const CACHED = path.join(ROOT, 'cached.ts');
const TRANSIENT = path.join(ROOT, 'transient.ts');
const CHILD = path.join(ROOT, 'child.ts');
const SCOPE = path.join(ROOT, 'scope.ts');
const DISPOSE = path.join(ROOT, 'dispose.ts');
const MULTI = path.join(ROOT, 'multi.ts');
const PARENT_ASYNC = path.join(ROOT, 'parent-async.ts');
const FIELD = path.join(ROOT, 'field.ts');

const files = new Map<string, string>([
  [PAIR, source(`
    interface PairOne { on: boolean }
    interface PairTwo { on: boolean }
    interface PairRoot { ok: number }
    const one = useInterface<PairOne>();
    const two = useInterface<PairTwo>();
    const root = useInterface<PairRoot>();
    export const eagerPair = defineBuilderConfig({
      name: 'EagerPair',
      optimization: { mode: 'closed', roots: [root], eager: [one, two] },
      injections: [
        { token: one, useFactory: true, dependencies: [], provider: () => { ${count('__t16E1')}; return { on: true }; } },
        { token: two, useFactory: true, dependencies: [], provider: () => { ${count('__t16E2')}; return { on: true }; } },
        { token: root, useFactory: true, dependencies: [], provider: () => ({ ok: 1 }) },
      ],
    });
  `)],
  [PAIR_ASYNC, source(`
    interface AsyncOne { on: boolean }
    interface AsyncTwo { on: boolean }
    interface AsyncRoot { ok: number }
    const one = useInterface<AsyncOne>();
    const two = useInterface<AsyncTwo>();
    const root = useInterface<AsyncRoot>();
    export const eagerAsync = defineBuilderConfig({
      name: 'EagerAsync',
      optimization: { mode: 'closed', roots: [root], eager: [one, two] },
      injections: [
        { token: one, useFactory: true, dependencies: [], provider: () => { ${count('__t16A1')}; return { on: true }; } },
        { token: two, useFactory: true, dependencies: [], provider: () => { ${count('__t16A2')}; return { on: true }; } },
        { token: root, useFactory: true, dependencies: [], provider: async () => ({ ok: 1 }) },
      ],
    });
  `)],
  [CACHED, source(`
    interface CachedEager { n: number }
    interface CachedRoot { n: number }
    const eager = useInterface<CachedEager>();
    const root = useInterface<CachedRoot>();
    export const eagerCached = defineBuilderConfig({
      name: 'EagerCached',
      optimization: { mode: 'closed', roots: [root], eager: [eager] },
      injections: [
        { token: eager, useFactory: true, dependencies: [], provider: () => { ${count('__t16Pre')}; return { n: 1 }; } },
        { token: root, useFactory: true, dependencies: [eager], provider: (ctx) => ctx.resolve(eager) },
      ],
    });
  `)],
  [TRANSIENT, source(`
    interface TransientEager { n: number }
    const eager = useInterface<TransientEager>();
    export const eagerTransient = defineBuilderConfig({
      name: 'EagerTransient',
      optimization: { mode: 'closed', roots: [eager], eager: [eager] },
      injections: [
        {
          token: eager,
          lifecycle: 'transient',
          useFactory: true,
          dependencies: [],
          provider: () => { ${count('__t16Transient')}; return { n: 1 }; },
        },
      ],
    });
  `)],
  [CHILD, source(`
    interface ParentPrivate { n: number }
    interface ParentExport { n: number }
    interface ChildMark { n: number }
    const hidden = useInterface<ParentPrivate>();
    const shown = useInterface<ParentExport>();
    const mark = useInterface<ChildMark>();
    export const parentC = defineBuilderConfig({
      name: 'ParentC',
      optimization: { mode: 'closed', roots: [shown] },
      injections: [
        { token: hidden, useFactory: true, dependencies: [], provider: () => ({ n: 1 }) },
        { token: shown, useFactory: true, dependencies: [hidden], provider: (ctx) => ctx.resolve(hidden) },
      ],
    });
    export const childC = defineBuilderConfig({
      name: 'ChildC',
      useContainer: parentC,
      injections: [
        { token: mark, useFactory: true, dependencies: [], provider: () => ({ n: 2 }) },
      ],
    });
    export function readHidden() { return childC.resolve(hidden); }
    export function readShown() { return childC.resolve(shown); }
  `)],
  [SCOPE, source(`
    interface ScopeDep { n: number }
    interface ScopeRoot { n: number }
    const dep = useInterface<ScopeDep>();
    const root = useInterface<ScopeRoot>();
    export const scopeRoot = defineBuilderConfig({
      name: 'ScopeRoot',
      optimization: { mode: 'closed', roots: [root] },
      injections: [
        { token: dep, useFactory: true, dependencies: [], provider: () => ({ n: 4 }) },
        { token: root, useFactory: true, dependencies: [dep], provider: (ctx) => ctx.resolve(dep) },
      ],
    });
  `)],
  [DISPOSE, source(`
    interface DisposeRoot { ok: number }
    const root = useInterface<DisposeRoot>();
    class PrunedBox {
      dispose(): void { ${count('__t16Gone')}; }
    }
    export const disposeRoot = defineBuilderConfig({
      name: 'DisposeRoot',
      optimization: { mode: 'closed', roots: [root] },
      injections: [
        { token: root, useFactory: true, dependencies: [], provider: () => ({ ok: 1 }) },
        { token: PrunedBox, provider: PrunedBox },
      ],
    });
  `)],
  [MULTI, source(`
    interface MultiShown { n: number }
    interface MultiHidden { n: number }
    const shown = useInterface<MultiShown>();
    const hidden = useInterface<MultiHidden>();
    export const multiGuard = defineBuilderConfig({
      name: 'MultiGuard',
      optimization: { mode: 'closed', roots: [{ all: shown }] },
      injections: [
        { token: shown, multi: true, useFactory: true, dependencies: [], provider: () => ({ n: 1 }) },
        { token: hidden, multi: true, useFactory: true, dependencies: [], provider: () => ({ n: 2 }) },
      ],
    });
    export function readShown() { return multiGuard.resolveAll(shown); }
    export function readHidden() { return multiGuard.resolveAll(hidden); }
  `)],
  [PARENT_ASYNC, source(`
    interface HiddenAsync { n: number }
    interface ShownSync { n: number }
    interface ShownAsync { n: number }
    interface ChildUse { n: number }
    interface ChildAsyncUse { n: number }
    const hidden = useInterface<HiddenAsync>();
    const shown = useInterface<ShownSync>();
    const shownAsync = useInterface<ShownAsync>();
    const used = useInterface<ChildUse>();
    const usedAsync = useInterface<ChildAsyncUse>();
    export const asyncParent = defineBuilderConfig({
      name: 'AsyncParent',
      optimization: { mode: 'closed', roots: [shown] },
      injections: [
        { token: hidden, useFactory: true, dependencies: [], provider: async () => ({ n: 1 }) },
        { token: shown, useFactory: true, dependencies: [], provider: () => ({ n: 2 }) },
      ],
    });
    export const asyncChild = defineBuilderConfig({
      name: 'AsyncChild',
      useContainer: asyncParent,
      injections: [
        { token: used, useFactory: true, dependencies: [shown], provider: (ctx) => ctx.resolve(shown) },
      ],
    });
    export const asyncRootParent = defineBuilderConfig({
      name: 'AsyncRootParent',
      optimization: { mode: 'closed', roots: [shownAsync] },
      injections: [
        { token: shownAsync, useFactory: true, dependencies: [], provider: async () => ({ n: 3 }) },
      ],
    });
    export const asyncRootChild = defineBuilderConfig({
      name: 'AsyncRootChild',
      useContainer: asyncRootParent,
      injections: [
        { token: usedAsync, useFactory: true, dependencies: [shownAsync], provider: async (ctx) => ctx.resolve(shownAsync) },
      ],
    });
  `)],
  [FIELD, source(`
    interface FieldEager { on: boolean }
    interface FieldRoot { ok: number }
    const eager = useInterface<FieldEager>();
    const root = useInterface<FieldRoot>();
    export const eagerField = defineBuilderConfig({
      name: 'EagerField',
      optimization: { mode: 'closed', roots: [root], eager: [eager] },
      injections: [
        { token: eager, useFactory: true, dependencies: [], provider: () => ({ on: true }) },
        { token: root, useFactory: true, dependencies: [], provider: () => ({ ok: 1 }) },
      ],
    });
  `)],
]);

interface RuntimeContainer {
  initialize: () => Promise<void>;
  resolve: (token: string) => unknown;
  resolveAll: (token: string) => unknown[];
  destroy: () => Promise<void>;
  createScope: () => RuntimeContainer;
  instances: Map<unknown, unknown>;
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
    const text = sources.get(fileName);
    if (text !== undefined) return ts.createSourceFile(fileName, text, languageVersion, true);
    return read(fileName, languageVersion, onError, shouldCreateNewSourceFile);
  };
  host.fileExists = (fileName) => sources.has(fileName) || exists(fileName);
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

function readCode(value: unknown): string | undefined {
  if (!(value instanceof Error)) return undefined;
  const coded = value as Error & { code?: unknown };
  return typeof coded.code === 'string' ? coded.code : undefined;
}

function execute(graph: DependencyGraph, bindings: Record<string, string> = {}): RuntimeContainer {
  const header = Object.entries(bindings)
    .map(([name, value]) => `const ${name} = ${JSON.stringify(value)};`)
    .join('\n');
  const tsCode = `${header}\n${new Generator(graph, false).generate()}`;
  const jsCode = ts.transpileModule(tsCode, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const moduleRecord: { exports: Record<string, RuntimeContainer | undefined> } = { exports: {} };
  const run = new Function('module', 'exports', jsCode) as (
    module: typeof moduleRecord,
    exports: typeof moduleRecord.exports,
  ) => void;
  run(moduleRecord, moduleRecord.exports);
  const name = graph.exportedVariableName ?? 'container';
  const container = moduleRecord.exports[name];
  if (!container) throw new Error(`generated module did not export ${name}`);
  opened.push(container);
  return container;
}

function holder(name: string): number {
  const value = Reflect.get(globalThis, name);
  return typeof value === 'number' ? value : 0;
}

function hasName(ids: Iterable<string> | undefined, name: string): boolean {
  if (!ids) return false;
  for (const id of ids) {
    if (id.includes(name)) return true;
  }
  return false;
}

describe('T16 review round 3', () => {
  let graphs: Map<string, DependencyGraph>;
  let analyzer: Analyzer;

  beforeAll(() => {
    warmLibCache();
    const program = programFrom(files);
    analyzer = new Analyzer(program);
    graphs = new Map();
    for (const graph of analyzer.extractAll()) graphs.set(graph.containerId, graph);
  });

  function named(name: string): DependencyGraph {
    const graph = graphs.get(name);
    if (!graph) throw new Error(`missing ${name}`);
    return graph;
  }

  afterEach(async () => {
    const pending = opened.splice(0);
    for (const container of pending) {
      await container.destroy();
    }
    for (const name of ['__t16E1', '__t16E2', '__t16A1', '__t16A2', '__t16Pre', '__t16Transient', '__t16Gone']) {
      Reflect.deleteProperty(globalThis, name);
    }
  });

  it('T16 eager pair sync', async () => {
    const graph = named('EagerPair');
    const one = tokenId(graph, 'PairOne');
    const two = tokenId(graph, 'PairTwo');
    const root = tokenId(graph, 'PairRoot');
    let ran = 0;
    try {
      const container = execute(graph, { one, two, root });
      await container.initialize();
      ran = holder('__t16E1') + holder('__t16E2');
    } catch {
      ran = -1;
    }
    expect(ran).toBe(2);
  });

  it('T16 eager pair async', async () => {
    const graph = named('EagerAsync');
    const one = tokenId(graph, 'AsyncOne');
    const two = tokenId(graph, 'AsyncTwo');
    const root = tokenId(graph, 'AsyncRoot');
    let ran = 0;
    try {
      const container = execute(graph, { one, two, root });
      await container.initialize();
      ran = holder('__t16A1') + holder('__t16A2');
    } catch {
      ran = -1;
    }
    expect(ran).toBe(2);
  });

  it('T16 eager already cached', async () => {
    const graph = named('EagerCached');
    const eager = tokenId(graph, 'CachedEager');
    const root = tokenId(graph, 'CachedRoot');
    const container = execute(graph, { eager, root });
    container.resolve(root);
    await container.initialize();
    expect(holder('__t16Pre')).toBe(1);
  });

  it('T16 eager transient not cached', async () => {
    const graph = named('EagerTransient');
    const eager = tokenId(graph, 'TransientEager');
    const container = execute(graph, { eager });
    await container.initialize();
    const first = container.resolve(eager);
    const second = container.resolve(eager);
    expect(holder('__t16Transient')).toBe(3);
    expect(first).not.toBe(second);
    expect(container.instances.has(eager)).toBe(false);
  });

  it('T16 eager transient initialize twice', async () => {
    const graph = named('EagerTransient');
    const eager = tokenId(graph, 'TransientEager');
    const container = execute(graph, { eager });
    await container.initialize();
    await container.initialize();
    expect(holder('__t16Transient')).toBe(1);
  });

  it('T16 child private root', () => {
    const errors = analyzer.extractForFile(CHILD).errors.filter((error) => error.code === 'NEO_ROOT_NOT_EXPORTED');
    expect(errors.map((error) => error.message)).toEqual([
      expect.stringContaining('ParentPrivate'),
    ]);
  });

  it('T16 scope keeps the root guard', () => {
    const graph = named('ScopeRoot');
    const dep = tokenId(graph, 'ScopeDep');
    const root = tokenId(graph, 'ScopeRoot');
    const parent = execute(graph, { dep, root });
    const scope = parent.createScope();
    opened.push(scope);
    expect((scope.resolve(root) as { n: number }).n).toBe(4);
    let code: string | undefined;
    try {
      scope.resolve(dep);
    } catch (error) {
      code = readCode(error);
    }
    expect(code).toBe('NEO_ROOT_NOT_EXPORTED');
  });

  it('T16 pruned disposable stays out of destroy', async () => {
    const graph = named('DisposeRoot');
    const root = tokenId(graph, 'DisposeRoot');
    const pruned = tokenId(graph, 'PrunedBox');
    const code = new Generator(graph, false).generate();
    const container = execute(graph, { root });
    container.resolve(root);
    await container.destroy();
    expect(holder('__t16Gone')).toBe(0);
    expect(code).not.toContain(pruned);
  });

  it('T16 debug graph omits pruned tokens', () => {
    const graph = named('DisposeRoot');
    const pruned = tokenId(graph, 'PrunedBox');
    const root = tokenId(graph, 'DisposeRoot');
    const code = new Generator(graph, false, undefined, true).generate();
    expect(code).toContain(root);
    expect(code).not.toContain(pruned);
  });

  it('T16 resolveAll non-root is rejected', () => {
    const errors = analyzer.extractForFile(MULTI).errors.filter((error: AnalysisError) => error.code === 'NEO_ROOT_NOT_EXPORTED');
    expect(errors.map((error) => error.message)).toEqual([
      expect.stringContaining('MultiHidden'),
    ]);
  });

  it('T16 closed parent exposes roots only', () => {
    const child = named('AsyncChild');
    const asyncChild = named('AsyncRootChild');
    expect(hasName(child.parentProvidedTokens, 'HiddenAsync')).toBe(false);
    expect(hasName(child.parentProvidedTokens, 'ShownSync')).toBe(true);
    expect(child.parentHasAsyncInitialize ?? false).toBe(false);
    expect(asyncChild.parentHasAsyncInitialize).toBe(true);
  });

  it('T16 eager field declared', () => {
    const code = new Generator(named('EagerField'), false).generate();
    expect(code).toContain('private _eagerOnce = false;');
  });
});
