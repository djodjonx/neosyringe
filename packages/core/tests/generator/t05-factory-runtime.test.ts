import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as ts from 'typescript';
import { Analyzer } from '../../src/analyzer/Analyzer';
import { Generator } from '../../src/generator/Generator';
import type { DependencyGraph } from '../../src/analyzer/types';

const ROOT = path.join(process.cwd(), 't05-runtime');
const EMPTY_FILE = path.join(ROOT, 'empty.ts');
const HELPER_FILE = path.join(ROOT, 'helper.ts');
const SIMPLE_FILE = path.join(ROOT, 'simple.ts');
const EXPIRED_FILE = path.join(ROOT, 'expired.ts');
const ALL_FILE = path.join(ROOT, 'all.ts');
const ORDER_FILE = path.join(ROOT, 'order.ts');
const ASYNC_CONFIG_FILE = path.join(ROOT, 'async-config.ts');
const BOOM_FILE = path.join(ROOT, 'boom.ts');
const OPAQUE_FILE = path.join(ROOT, 'opaque.ts');
const REJECT_FILE = path.join(ROOT, 'reject.ts');
const ONCE_FILE = path.join(ROOT, 'once.ts');

const STUB = `
  import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';
  function defineBuilderConfig(config: any) { return config; }
  function useInterface<T>(): any { return null; }
`;

const files = new Map<string, string>([
  [EMPTY_FILE, `
    ${STUB}
    interface EmptyBox { answer: number }
    export const emptyContainer = defineBuilderConfig({
      name: 'EmptyBox',
      injections: [
        {
          token: useInterface<EmptyBox>(),
          useFactory: true,
          dependencies: [],
          provider: () => ({ answer: 5 }),
        },
      ],
    });
  `],
  [HELPER_FILE, `
    ${STUB}
    interface UndeclaredHost { id: number }
    export const helperContainer = defineBuilderConfig({
      name: 'UndeclaredHost',
      injections: [
        {
          token: useInterface<UndeclaredHost>(),
          useFactory: true,
          dependencies: [],
          provider: (ctx): UndeclaredHost => {
            const helper = (context: { resolve: (token: string) => unknown }) => context.resolve('NOT_DECLARED');
            helper(ctx);
            return { id: 1 };
          },
        },
      ],
    });
  `],
  [SIMPLE_FILE, `
    ${STUB}
    interface SimpleValue { n: number }
    interface SeenAll { n: number }
    const simpleToken = useInterface<SimpleValue>();
    export const simpleContainer = defineBuilderConfig({
      name: 'SimpleAll',
      injections: [
        {
          token: simpleToken,
          useFactory: true,
          dependencies: [],
          provider: () => ({ n: 1 }),
        },
        {
          token: useInterface<SeenAll>(),
          useFactory: true,
          dependencies: [simpleToken],
          provider: (ctx): SeenAll => ctx.resolveAll(simpleToken),
        },
      ],
    });
  `],
  [EXPIRED_FILE, `
    ${STUB}
    interface SyncPort { kind: string }
    interface AsyncPort { kind: string }
    export const syncContainer = defineBuilderConfig({
      name: 'SyncExpired',
      injections: [
        {
          token: useInterface<SyncPort>(),
          useFactory: true,
          dependencies: [],
          provider: (ctx) => {
            (globalThis as { __t05Sync?: unknown }).__t05Sync = ctx;
            return { kind: 'sync' };
          },
        },
      ],
    });
    export const asyncContainer = defineBuilderConfig({
      name: 'AsyncExpired',
      injections: [
        {
          token: useInterface<AsyncPort>(),
          useFactory: true,
          dependencies: [],
          provider: async (ctx) => {
            (globalThis as { __t05Async?: unknown }).__t05Async = ctx;
            await (globalThis as { __t05Gate?: Promise<void> }).__t05Gate;
            return { kind: 'async' };
          },
        },
      ],
    });
  `],
  [ALL_FILE, `
    ${STUB}
    interface AllMid { n: number }
    interface AllPipe { items: AllMid[] }
    const mid = useInterface<AllMid>();
    export const allContainer = defineBuilderConfig({
      name: 'AllContributions',
      injections: [
        {
          token: mid,
          useFactory: true,
          dependencies: [],
          multi: true,
          provider: () => ({ n: 1 }),
        },
        {
          token: mid,
          useFactory: true,
          dependencies: [],
          multi: true,
          provider: () => ({ n: 2 }),
        },
        {
          token: useInterface<AllPipe>(),
          useFactory: true,
          dependencies: [{ all: mid }],
          provider: (ctx) => ({ items: ctx.resolveAll(mid) }),
        },
      ],
    });
  `],
  [ORDER_FILE, `
    ${STUB}
    interface OrderDep { n: number }
    interface OrderHost { n: number }
    const dep = useInterface<OrderDep>();
    export const orderContainer = defineBuilderConfig({
      name: 'OrderBuild',
      injections: [
        {
          token: dep,
          useFactory: true,
          dependencies: [],
          provider: () => {
            const order = (globalThis as { __t05Order?: string[] }).__t05Order ?? [];
            order.push('dep');
            (globalThis as { __t05Order?: string[] }).__t05Order = order;
            return { n: 1 };
          },
        },
        {
          token: useInterface<OrderHost>(),
          useFactory: true,
          dependencies: [dep],
          provider: () => {
            const order = (globalThis as { __t05Order?: string[] }).__t05Order ?? [];
            order.push('host');
            (globalThis as { __t05Order?: string[] }).__t05Order = order;
            return { n: 2 };
          },
        },
      ],
    });
  `],
  [ASYNC_CONFIG_FILE, `
    ${STUB}
    interface SyncConfig { url: string }
    interface AsyncHost { url: string }
    const configToken = useInterface<SyncConfig>();
    export const asyncConfigContainer = defineBuilderConfig({
      name: 'AsyncReadsSync',
      injections: [
        {
          token: configToken,
          useFactory: true,
          dependencies: [],
          provider: () => ({ url: 'https://example.test' }),
        },
        {
          token: useInterface<AsyncHost>(),
          useFactory: true,
          dependencies: [configToken],
          provider: async (ctx) => {
            const config = ctx.resolve(configToken);
            return { url: config.url };
          },
        },
      ],
    });
  `],
  [BOOM_FILE, `
    ${STUB}
    interface BoomDep { n: number }
    interface BoomHost { n: number }
    const depToken = useInterface<BoomDep>();
    export const boomContainer = defineBuilderConfig({
      name: 'BoomHold',
      injections: [
        {
          token: depToken,
          useFactory: true,
          dependencies: [],
          provider: () => {
            throw new Error('boom');
          },
        },
        {
          token: useInterface<BoomHost>(),
          useFactory: true,
          dependencies: [depToken],
          provider: async () => ({ n: 1 }),
        },
      ],
    });
  `],
  [OPAQUE_FILE, `
    ${STUB}
    interface LegacyCfg { u: string }
    interface LegacyHost { u: string }
    const cfgToken = useInterface<LegacyCfg>();
    export const legacyContainer = defineBuilderConfig({
      name: 'OpaqueLegacy',
      injections: [
        {
          token: cfgToken,
          useFactory: true,
          dependencies: [],
          provider: () => ({ u: 'ok' }),
        },
        {
          token: useInterface<LegacyHost>(),
          useFactory: true,
          provider: (c) => ({ u: c.resolve(cfgToken).u }),
        },
      ],
    });
  `],
  [REJECT_FILE, `
    ${STUB}
    interface RejectPort { kind: string }
    export const rejectContainer = defineBuilderConfig({
      name: 'RejectExpired',
      injections: [
        {
          token: useInterface<RejectPort>(),
          useFactory: true,
          dependencies: [],
          provider: async (ctx) => {
            (globalThis as { __t05Reject?: unknown }).__t05Reject = ctx;
            throw new Error('nope');
          },
        },
      ],
    });
  `],
  [ONCE_FILE, `
    ${STUB}
    interface OnceDep { n: number }
    interface OnceHost { n: number }
    const onceDep = useInterface<OnceDep>();
    export const onceContainer = defineBuilderConfig({
      name: 'TransientOnce',
      injections: [
        {
          token: onceDep,
          useFactory: true,
          dependencies: [],
          lifecycle: 'transient',
          provider: () => {
            const count = ((globalThis as { __t05Transient?: number }).__t05Transient ?? 0) + 1;
            (globalThis as { __t05Transient?: number }).__t05Transient = count;
            return { n: count };
          },
        },
        {
          token: useInterface<OnceHost>(),
          useFactory: true,
          dependencies: [onceDep],
          provider: (ctx) => ({ n: ctx.resolve(onceDep).n }),
        },
      ],
    });
  `],
]);

interface RuntimeContainer {
  initialize: () => Promise<void>;
  resolve: (token: string) => unknown;
  resolveAll: (token: string) => unknown[];
}

function createProgram(sources: Map<string, string>): ts.Program {
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext,
    strict: true,
    noImplicitAny: false,
  };
  const host = ts.createCompilerHost(options);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  const originalFileExists = host.fileExists.bind(host);
  host.getSourceFile = (fileName, languageVersion) => {
    const text = sources.get(fileName);
    if (text !== undefined) return ts.createSourceFile(fileName, text, languageVersion, true);
    return originalGetSourceFile(fileName, languageVersion);
  };
  host.fileExists = (fileName) => sources.has(fileName) || originalFileExists(fileName);
  return ts.createProgram([...sources.keys()], options, host);
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

function execute(graph: DependencyGraph, bindings: Record<string, string> = {}): RuntimeContainer {
  const prelude = Object.entries(bindings)
    .map(([name, value]) => `const ${name} = ${JSON.stringify(value)};`)
    .join('\n');
  const tsCode = `${prelude}\n${new Generator(graph, false).generate()}`;
  const jsCode = ts.transpileModule(tsCode, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const moduleRecord: { exports: Record<string, RuntimeContainer | undefined> } = { exports: {} };
  const run = new Function('module', 'exports', 'require', jsCode) as (
    module: typeof moduleRecord,
    exports: typeof moduleRecord.exports,
    require: (id: string) => unknown,
  ) => void;
  run(moduleRecord, moduleRecord.exports, () => ({}));
  const name = graph.exportedVariableName ?? 'container';
  const container = moduleRecord.exports[name];
  if (!container) throw new Error(`generated module did not export ${name}`);
  return container;
}

function readFailure(value: unknown): { code: string | undefined; message: string } {
  if (!(value instanceof Error)) return { code: undefined, message: '' };
  const code = 'code' in value && typeof value.code === 'string' ? value.code : undefined;
  return { code, message: value.message };
}

function callResolve(captured: unknown, token: string): unknown {
  if (typeof captured !== 'object' || captured === null || !('resolve' in captured)) {
    return undefined;
  }
  const resolve = captured.resolve;
  if (typeof resolve !== 'function') return undefined;
  return resolve.call(captured, token);
}

describe('T05 factory runtime', () => {
  let analyzer: Analyzer;
  let graphs: Map<string, DependencyGraph>;
  let compatibleGraphs: Map<string, DependencyGraph>;

  beforeAll(() => {
    const program = createProgram(files);
    analyzer = new Analyzer(program);
    graphs = new Map();
    for (const graph of analyzer.extractAll()) graphs.set(graph.containerId, graph);
    compatibleGraphs = new Map();
    for (const graph of new Analyzer(program, { validation: 'compatible' }).extractAll()) {
      compatibleGraphs.set(graph.containerId, graph);
    }
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, '__t05Sync');
    Reflect.deleteProperty(globalThis, '__t05Async');
    Reflect.deleteProperty(globalThis, '__t05Gate');
    Reflect.deleteProperty(globalThis, '__t05Order');
    Reflect.deleteProperty(globalThis, '__t05Reject');
    Reflect.deleteProperty(globalThis, '__t05Transient');
  });

  it('empty dependencies resolves the value', () => {
    const fileErrors = analyzer.extractForFile(EMPTY_FILE).errors.filter((error) => error.code !== undefined);
    expect(fileErrors).toEqual([]);
    const graph = graphs.get('EmptyBox');
    if (!graph) throw new Error('missing EmptyBox');
    const value = execute(graph).resolve(tokenId(graph, 'EmptyBox'));
    expect(value).toEqual({ answer: 5 });
  });

  it('helper undeclared resolve throws', () => {
    const graph = graphs.get('UndeclaredHost');
    if (!graph) throw new Error('missing UndeclaredHost');
    let caught: unknown;
    try {
      execute(graph).resolve(tokenId(graph, 'UndeclaredHost'));
    } catch (error) {
      caught = error;
    }
    const failure = readFailure(caught);
    expect(failure.code).toBe('NEO_UNDECLARED_FACTORY_DEP');
    expect(failure.message).toContain('NEO_UNDECLARED_FACTORY_DEP');
    expect(failure.message).toContain('UndeclaredHost');
  });

  it('resolveAll on a simple entry throws', () => {
    const graph = graphs.get('SimpleAll');
    if (!graph) throw new Error('missing SimpleAll');
    const simple = tokenId(graph, 'SimpleValue');
    let caught: unknown;
    try {
      execute(graph, { simpleToken: simple }).resolve(tokenId(graph, 'SeenAll'));
    } catch (error) {
      caught = error;
    }
    const failure = readFailure(caught);
    expect(failure.code).toBe('NEO_UNDECLARED_FACTORY_DEP');
    expect(failure.message).toContain('NEO_UNDECLARED_FACTORY_DEP');
  });

  it('context after return throws sync and after async settle', async () => {
    const syncGraph = graphs.get('SyncExpired');
    if (!syncGraph) throw new Error('missing SyncExpired');
    execute(syncGraph).resolve(tokenId(syncGraph, 'SyncPort'));
    let syncCaught: unknown;
    try {
      callResolve(Reflect.get(globalThis, '__t05Sync'), 'later');
    } catch (error) {
      syncCaught = error;
    }
    const syncFailure = readFailure(syncCaught);
    expect(syncFailure.code).toBe('NEO_FACTORY_CONTEXT_EXPIRED');
    expect(syncFailure.message).toContain('NEO_FACTORY_CONTEXT_EXPIRED');
    expect(syncFailure.message).toContain('SyncPort');

    const asyncGraph = graphs.get('AsyncExpired');
    if (!asyncGraph) throw new Error('missing AsyncExpired');
    let release: (() => void) | undefined;
    Reflect.set(globalThis, '__t05Gate', new Promise<void>((resolve) => {
      release = resolve;
    }));
    try {
      const pending = execute(asyncGraph).initialize();
      release?.();
      await pending;
      let asyncCaught: unknown;
      try {
        callResolve(Reflect.get(globalThis, '__t05Async'), 'later');
      } catch (error) {
        asyncCaught = error;
      }
      const asyncFailure = readFailure(asyncCaught);
      expect(asyncFailure.code).toBe('NEO_FACTORY_CONTEXT_EXPIRED');
      expect(asyncFailure.message).toContain('NEO_FACTORY_CONTEXT_EXPIRED');
      expect(asyncFailure.message).toContain('AsyncPort');
    } finally {
      release?.();
    }
  });

  it('resolveAll of all-descriptor returns both', () => {
    const graph = graphs.get('AllContributions');
    if (!graph) throw new Error('missing AllContributions');
    const mid = tokenId(graph, 'AllMid');
    const value = execute(graph, { mid }).resolve(tokenId(graph, 'AllPipe')) as { items: unknown[] };
    expect(value.items).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it('unused declared dep stays an edge and is built first', () => {
    const graph = graphs.get('OrderBuild');
    if (!graph) throw new Error('missing OrderBuild');
    const dep = tokenId(graph, 'OrderDep');
    const host = [...graph.nodes.values()].find((node) => node.service.tokenId.includes('OrderHost'));
    expect(host?.dependencies).toContain(dep);
    Reflect.set(globalThis, '__t05Order', []);
    execute(graph).resolve(tokenId(graph, 'OrderHost'));
    expect(Reflect.get(globalThis, '__t05Order')).toEqual(['dep', 'host']);
  });

  it('async factory reads sync config during initialize', async () => {
    const graph = graphs.get('AsyncReadsSync');
    if (!graph) throw new Error('missing AsyncReadsSync');
    const config = tokenId(graph, 'SyncConfig');
    let value: unknown;
    try {
      const container = execute(graph, { configToken: config });
      await container.initialize();
      value = container.resolve(tokenId(graph, 'AsyncHost'));
    } catch {
      value = undefined;
    }
    expect(value).toEqual({ url: 'https://example.test' });
  });

  it('sync throw during initialize keeps initialized false', async () => {
    const graph = graphs.get('BoomHold');
    if (!graph) throw new Error('missing BoomHold');
    const container = execute(graph) as RuntimeContainer & { _initialized: boolean };
    let first = '';
    try {
      await container.initialize();
    } catch (error) {
      first = error instanceof Error ? error.message : '';
    }
    expect(first).toContain('boom');
    expect(container._initialized).toBe(false);
    let second = '';
    try {
      await container.initialize();
    } catch (error) {
      second = error instanceof Error ? error.message : '';
    }
    expect(second).toContain('boom');
  });

  it('compatible opaque factory resolves a dependency', () => {
    const graph = compatibleGraphs.get('OpaqueLegacy');
    if (!graph) throw new Error('missing OpaqueLegacy');
    const cfg = tokenId(graph, 'LegacyCfg');
    let value: unknown;
    let code: string | undefined;
    try {
      value = execute(graph, { cfgToken: cfg }).resolve(tokenId(graph, 'LegacyHost'));
    } catch (error) {
      code = readFailure(error).code;
    }
    expect(code).toBeUndefined();
    expect(value).toEqual({ u: 'ok' });
  });

  it('rejected async factory expires the context', async () => {
    const graph = graphs.get('RejectExpired');
    if (!graph) throw new Error('missing RejectExpired');
    const container = execute(graph) as RuntimeContainer & { _initialized: boolean };
    let rejected = '';
    try {
      await container.initialize();
    } catch (error) {
      rejected = error instanceof Error ? error.message : '';
    }
    expect(rejected).toContain('nope');
    expect(container._initialized).toBe(false);
    let later: unknown;
    try {
      callResolve(Reflect.get(globalThis, '__t05Reject'), 'later');
    } catch (error) {
      later = error;
    }
    const failure = readFailure(later);
    expect(failure.code).toBe('NEO_FACTORY_CONTEXT_EXPIRED');
    expect(failure.message).toContain('RejectPort');
  });

  it('transient dependency is built once', () => {
    const graph = graphs.get('TransientOnce');
    if (!graph) throw new Error('missing TransientOnce');
    const dep = tokenId(graph, 'OnceDep');
    Reflect.set(globalThis, '__t05Transient', 0);
    const value = execute(graph, { onceDep: dep }).resolve(tokenId(graph, 'OnceHost')) as { n: number };
    expect(value.n).toBe(1);
    expect(Reflect.get(globalThis, '__t05Transient')).toBe(1);
  });
});
