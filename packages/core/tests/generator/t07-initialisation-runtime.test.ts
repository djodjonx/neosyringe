import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as ts from 'typescript';
import { hasText, textAt } from '../helpers/tsPath';
import { Analyzer } from '../../src/analyzer/Analyzer';
import { Generator } from '../../src/generator/Generator';
import type { DependencyGraph } from '../../src/analyzer/types';

const ROOT = path.join(process.cwd(), 't07-runtime');
const READ_FILE = path.join(ROOT, 'read.ts');
const ONCE_FILE = path.join(ROOT, 'once.ts');
const ORDER_FILE = path.join(ROOT, 'order.ts');
const GUARD_FILE = path.join(ROOT, 'guard.ts');
const FAIL_FILE = path.join(ROOT, 'fail.ts');
const CLOSE_FILE = path.join(ROOT, 'close.ts');
const JOIN_FILE = path.join(ROOT, 'join.ts');
const PARENT_FILE = path.join(ROOT, 'parent.ts');
const LEAK_CALL_FILE = path.join(ROOT, 'leak-call.ts');
const LEAK_WARM_FILE = path.join(ROOT, 'leak-warm.ts');
const REJECT_CLOSE_FILE = path.join(ROOT, 'reject-close.ts');
const FAILED_PARENT_FILE = path.join(ROOT, 'failed-parent.ts');
const JOURNAL_FILE = path.join(ROOT, 'journal.ts');
const FAIL_CLOSE_FILE = path.join(ROOT, 'fail-close.ts');

const STUB = `
  import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';
  function defineBuilderConfig(config: any) { return config; }
  function useInterface<T>(): any { return null; }
`;

const BOX = `
  class Box {
    constructor() {
      const holder = globalThis as { __t07Created?: number };
      holder.__t07Created = (holder.__t07Created ?? 0) + 1;
    }
    dispose(): void {
      const holder = globalThis as { __t07Disposes?: number };
      holder.__t07Disposes = (holder.__t07Disposes ?? 0) + 1;
    }
  }
`;

const LATCH = `
  class Latch {
    async dispose(): Promise<void> {
      const holder = globalThis as { __t07Disposes?: number };
      holder.__t07Disposes = (holder.__t07Disposes ?? 0) + 1;
      await (globalThis as { __t07DisposeGate?: { ready: Promise<void> } }).__t07DisposeGate!.ready;
    }
  }
`;

const files = new Map<string, string>([
  [READ_FILE, `
    ${STUB}
    interface SyncConfig { url: string }
    interface AsyncHost { url: string }
    const configToken = useInterface<SyncConfig>();
    export const readContainer = defineBuilderConfig({
      name: 'T07Read',
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
            await (globalThis as { __t07Gate?: { ready: Promise<void> } }).__t07Gate!.ready;
            return { url: config.url };
          },
        },
      ],
    });
  `],
  [ONCE_FILE, `
    ${STUB}
    interface OncePort { n: number }
    export const onceContainer = defineBuilderConfig({
      name: 'T07Once',
      injections: [
        {
          token: useInterface<OncePort>(),
          useFactory: true,
          dependencies: [],
          provider: async () => {
            const holder = globalThis as { __t07Calls?: number };
            holder.__t07Calls = (holder.__t07Calls ?? 0) + 1;
            await (globalThis as { __t07Gate?: { ready: Promise<void> } }).__t07Gate!.ready;
            return { n: 1 };
          },
        },
      ],
    });
  `],
  [ORDER_FILE, `
    ${STUB}
    interface OrderA { n: number }
    interface OrderB { n: number }
    const tokenA = useInterface<OrderA>();
    const tokenB = useInterface<OrderB>();
    export const orderContainer = defineBuilderConfig({
      name: 'T07Order',
      injections: [
        {
          token: tokenB,
          useFactory: true,
          dependencies: [tokenA],
          provider: async (ctx) => {
            const ready = ctx.resolve(tokenA);
            const holder = globalThis as { __t07Order?: string[] };
            const order = holder.__t07Order ?? [];
            order.push('B:start');
            holder.__t07Order = order;
            order.push('B:end');
            return { n: ready.n + 1 };
          },
        },
        {
          token: tokenA,
          useFactory: true,
          dependencies: [],
          provider: async () => {
            const holder = globalThis as { __t07Order?: string[] };
            const order = holder.__t07Order ?? [];
            order.push('A:start');
            holder.__t07Order = order;
            await (globalThis as { __t07Gate?: { ready: Promise<void> } }).__t07Gate!.ready;
            order.push('A:end');
            return { n: 1 };
          },
        },
      ],
    });
  `],
  [GUARD_FILE, `
    ${STUB}
    interface GuardPort { n: number }
    export const guardContainer = defineBuilderConfig({
      name: 'T07Guard',
      injections: [
        {
          token: useInterface<GuardPort>(),
          useFactory: true,
          dependencies: [],
          provider: async () => {
            await (globalThis as { __t07Gate?: { ready: Promise<void> } }).__t07Gate!.ready;
            return { n: 1 };
          },
        },
      ],
    });
  `],
  [FAIL_FILE, `
    ${STUB}
    interface FailPort { n: number }
    export const failContainer = defineBuilderConfig({
      name: 'T07Fail',
      injections: [
        {
          token: useInterface<FailPort>(),
          useFactory: true,
          dependencies: [],
          provider: async () => {
            const holder = globalThis as { __t07Calls?: number; __t07Boom?: Error };
            holder.__t07Calls = (holder.__t07Calls ?? 0) + 1;
            throw holder.__t07Boom;
          },
        },
      ],
    });
  `],
  [CLOSE_FILE, `
    ${STUB}
    ${BOX}
    interface ClosePort { n: number }
    export const closeContainer = defineBuilderConfig({
      name: 'T07Close',
      injections: [
        { token: Box },
        {
          token: useInterface<ClosePort>(),
          useFactory: true,
          dependencies: [Box],
          provider: async (ctx) => {
            ctx.resolve(Box);
            const holder = globalThis as { __t07Calls?: number };
            holder.__t07Calls = (holder.__t07Calls ?? 0) + 1;
            await (globalThis as { __t07Gate?: { ready: Promise<void> } }).__t07Gate!.ready;
            return { n: 1 };
          },
        },
      ],
    });
  `],
  [JOIN_FILE, `
    ${STUB}
    ${LATCH}
    interface JoinPort { n: number }
    export const joinContainer = defineBuilderConfig({
      name: 'T07Join',
      injections: [
        { token: Latch },
        {
          token: useInterface<JoinPort>(),
          useFactory: true,
          dependencies: [Latch],
          provider: async (ctx) => {
            ctx.resolve(Latch);
            const holder = globalThis as { __t07Calls?: number };
            holder.__t07Calls = (holder.__t07Calls ?? 0) + 1;
            return { n: 1 };
          },
        },
      ],
    });
  `],
  [PARENT_FILE, `
    ${STUB}
    interface ParentPort { n: number }
    interface ChildMark { n: number }
    export const parent = defineBuilderConfig({
      name: 'T07Parent',
      injections: [
        {
          token: useInterface<ParentPort>(),
          useFactory: true,
          dependencies: [],
          provider: async () => {
            const holder = globalThis as { __t07ParentCalls?: number };
            holder.__t07ParentCalls = (holder.__t07ParentCalls ?? 0) + 1;
            await (globalThis as { __t07Gate?: { ready: Promise<void> } }).__t07Gate!.ready;
            return { n: 1 };
          },
        },
      ],
    });
    export const childA = defineBuilderConfig({
      name: 'T07ChildA',
      useContainer: parent,
      injections: [
        {
          token: useInterface<ChildMark>(),
          useFactory: true,
          dependencies: [],
          provider: () => ({ n: 1 }),
        },
      ],
    });
    export const childB = defineBuilderConfig({
      name: 'T07ChildB',
      useContainer: parent,
      injections: [
        {
          token: useInterface<ChildMark>(),
          useFactory: true,
          dependencies: [],
          provider: () => ({ n: 2 }),
        },
      ],
    });
  `],
  [LEAK_CALL_FILE, `
    ${STUB}
    interface CallDep { n: number }
    interface CallSync { n: number }
    interface CallHost { n: number }
    const callDep = useInterface<CallDep>();
    const callSync = useInterface<CallSync>();
    export const callContainer = defineBuilderConfig({
      name: 'T07LeakCall',
      injections: [
        {
          token: callDep,
          useFactory: true,
          dependencies: [],
          provider: () => ({ n: 4 }),
        },
        {
          token: callSync,
          useFactory: true,
          dependencies: [callDep],
          lifecycle: 'transient',
          provider: (ctx) => {
            (globalThis as { __t07Leaked?: { resolve: (token: unknown) => unknown } }).__t07Leaked = ctx;
            throw new Error('sync-leak');
          },
        },
        {
          token: useInterface<CallHost>(),
          useFactory: true,
          dependencies: [callSync],
          provider: async (ctx) => {
            ctx.resolve(callSync);
            return { n: 1 };
          },
        },
      ],
    });
  `],
  [LEAK_WARM_FILE, `
    ${STUB}
    interface WarmDep { n: number }
    interface WarmSync { n: number }
    interface WarmHost { n: number }
    const warmDep = useInterface<WarmDep>();
    const warmSync = useInterface<WarmSync>();
    export const warmContainer = defineBuilderConfig({
      name: 'T07LeakWarm',
      injections: [
        {
          token: warmDep,
          useFactory: true,
          dependencies: [],
          provider: () => ({ n: 4 }),
        },
        {
          token: warmSync,
          useFactory: true,
          dependencies: [warmDep],
          provider: (ctx) => {
            (globalThis as { __t07Leaked?: { resolve: (token: unknown) => unknown } }).__t07Leaked = ctx;
            throw new Error('warm-leak');
          },
        },
        {
          token: useInterface<WarmHost>(),
          useFactory: true,
          dependencies: [warmSync],
          provider: async () => ({ n: 1 }),
        },
      ],
    });
  `],
  [REJECT_CLOSE_FILE, `
    ${STUB}
    ${LATCH}
    interface RejectPort { n: number }
    export const rejectCloseContainer = defineBuilderConfig({
      name: 'T07RejectClose',
      injections: [
        { token: Latch },
        {
          token: useInterface<RejectPort>(),
          useFactory: true,
          dependencies: [Latch],
          provider: async (ctx) => {
            ctx.resolve(Latch);
            await (globalThis as { __t07Gate?: { ready: Promise<void> } }).__t07Gate!.ready;
            throw (globalThis as { __t07Boom?: Error }).__t07Boom;
          },
        },
      ],
    });
  `],
  [FAILED_PARENT_FILE, `
    ${STUB}
    interface ParentPort { n: number }
    interface ChildMark { n: number }
    export const parent = defineBuilderConfig({
      name: 'T07FailedParent',
      injections: [
        {
          token: useInterface<ParentPort>(),
          useFactory: true,
          dependencies: [],
          provider: async () => {
            throw (globalThis as { __t07Boom?: Error }).__t07Boom;
          },
        },
      ],
    });
    export const failedChild = defineBuilderConfig({
      name: 'T07FailedChild',
      useContainer: parent,
      injections: [
        {
          token: useInterface<ChildMark>(),
          useFactory: true,
          dependencies: [],
          provider: () => ({ n: 1 }),
        },
      ],
    });
  `],
  [FAIL_CLOSE_FILE, `
    ${STUB}
    ${BOX}
    interface FailClosePort { n: number }
    export const failCloseContainer = defineBuilderConfig({
      name: 'T07FailClose',
      injections: [
        { token: Box },
        {
          token: useInterface<FailClosePort>(),
          useFactory: true,
          dependencies: [Box],
          provider: async (ctx) => {
            ctx.resolve(Box);
            throw (globalThis as { __t07Boom?: Error }).__t07Boom;
          },
        },
      ],
    });
  `],
  [JOURNAL_FILE, `
    ${STUB}
    ${BOX}
    interface GatePort { n: number }
    interface LaterPort { n: number }
    const gateToken = useInterface<GatePort>();
    export const journalContainer = defineBuilderConfig({
      name: 'T07Journal',
      injections: [
        { token: Box },
        {
          token: gateToken,
          useFactory: true,
          dependencies: [],
          provider: async () => {
            await (globalThis as { __t07Gate?: { ready: Promise<void> } }).__t07Gate!.ready;
            return { n: 1 };
          },
        },
        {
          token: useInterface<LaterPort>(),
          useFactory: true,
          dependencies: [gateToken, Box],
          provider: async () => ({ n: 2 }),
        },
      ],
    });
  `],
]);

interface RuntimeContainer {
  initialize: () => Promise<void>;
  resolve: (token: unknown) => unknown;
  resolveAll: (token: unknown) => unknown[];
  destroy: () => Promise<void>;
}

const opened: RuntimeContainer[] = [];

interface Gate {
  ready: Promise<void>;
  open: () => void;
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
    const text = textAt(sources, fileName);
    if (text !== undefined) return ts.createSourceFile(fileName, text, languageVersion, true);
    return originalGetSourceFile(fileName, languageVersion);
  };
  host.fileExists = (fileName) => hasText(sources, fileName) || originalFileExists(fileName);
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

function execute(
  graph: DependencyGraph,
  bindings: Record<string, string> = {},
  options: { prelude?: string; direct?: boolean } = {},
): RuntimeContainer {
  const generator = new Generator(graph, options.direct === true);
  const name = graph.exportedVariableName ?? 'container';
  const prelude = [
    options.prelude ?? '',
    ...Object.entries(bindings).map(([binding, value]) => `const ${binding} = ${JSON.stringify(value)};`),
  ].join('\n');
  const exported = options.direct === true
    ? `\nexport const ${name} = ${generator.generateInstantiation()};`
    : '';
  const tsCode = `${prelude}\n${generator.generate()}${exported}`;
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
  const container = moduleRecord.exports[name];
  if (!container) throw new Error(`generated module did not export ${name}`);
  opened.push(container);
  return container;
}

function executeChild(graph: DependencyGraph, parent: RuntimeContainer): RuntimeContainer {
  const tsCode = new Generator(graph, false).generate();
  const jsCode = ts.transpileModule(tsCode, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const moduleRecord: { exports: Record<string, RuntimeContainer | undefined> } = { exports: {} };
  const run = new Function('parent', 'module', 'exports', 'require', jsCode) as (
    parent: RuntimeContainer,
    module: typeof moduleRecord,
    exports: typeof moduleRecord.exports,
    require: (id: string) => unknown,
  ) => void;
  run(parent, moduleRecord, moduleRecord.exports, () => ({}));
  const name = graph.exportedVariableName ?? 'container';
  const container = moduleRecord.exports[name];
  if (!container) throw new Error(`generated module did not export ${name}`);
  opened.push(container);
  return container;
}

function shutGate(): Gate {
  let openGate: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    openGate = resolve;
  });
  const gate: Gate = { ready, open: () => { openGate(); } };
  Reflect.set(globalThis, '__t07Gate', gate);
  return gate;
}

function shutDisposeGate(): Gate {
  let openGate: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    openGate = resolve;
  });
  const gate: Gate = { ready, open: () => { openGate(); } };
  Reflect.set(globalThis, '__t07DisposeGate', gate);
  return gate;
}

function readFailure(value: unknown): { code: string | undefined; message: string; cause: unknown } {
  if (!(value instanceof Error)) return { code: undefined, message: '', cause: undefined };
  const coded = value as Error & { code?: unknown; cause?: unknown };
  const code = typeof coded.code === 'string' ? coded.code : undefined;
  return { code, message: value.message, cause: coded.cause };
}

function count(key: '__t07Calls' | '__t07Created' | '__t07Disposes' | '__t07ParentCalls'): number {
  const value = Reflect.get(globalThis, key);
  return typeof value === 'number' ? value : 0;
}

function order(): string[] {
  const value = Reflect.get(globalThis, '__t07Order');
  return Array.isArray(value) ? value.map((item) => String(item)) : [];
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('T07 initialisation runtime', () => {
  let graphs: Map<string, DependencyGraph>;

  beforeAll(() => {
    const program = createProgram(files);
    graphs = new Map();
    for (const graph of new Analyzer(program).extractAll()) graphs.set(graph.containerId, graph);
  });

  afterEach(async () => {
    const gate = Reflect.get(globalThis, '__t07Gate') as Gate | undefined;
    gate?.open();
    const disposeGate = Reflect.get(globalThis, '__t07DisposeGate') as Gate | undefined;
    disposeGate?.open();
    const pending = opened.splice(0);
    for (const container of pending) await container.destroy();
    Reflect.deleteProperty(globalThis, '__t07Gate');
    Reflect.deleteProperty(globalThis, '__t07DisposeGate');
    Reflect.deleteProperty(globalThis, '__t07Order');
    Reflect.deleteProperty(globalThis, '__t07Calls');
    Reflect.deleteProperty(globalThis, '__t07Created');
    Reflect.deleteProperty(globalThis, '__t07Disposes');
    Reflect.deleteProperty(globalThis, '__t07Boom');
    Reflect.deleteProperty(globalThis, '__t07ParentCalls');
    Reflect.deleteProperty(globalThis, '__t07Leaked');
  });

  it('T07-A01 initialize then resolve returns the config value', async () => {
    const graph = graphs.get('T07Read');
    if (!graph) throw new Error('missing T07Read');
    const gate = shutGate();
    const config = tokenId(graph, 'SyncConfig');
    const container = execute(graph, { configToken: config });
    const pending = container.initialize();
    await flush();
    let during: unknown;
    try {
      container.resolve(config);
    } catch (error) {
      during = error;
    }
    const blocked = readFailure(during);
    expect(blocked.code).toBe('NEO_NOT_INITIALIZED');
    gate.open();
    await pending;
    expect(container.resolve(tokenId(graph, 'AsyncHost'))).toEqual({ url: 'https://example.test' });
  });

  it('T07-A02 concurrent initialize calls the factory once', async () => {
    const graph = graphs.get('T07Once');
    if (!graph) throw new Error('missing T07Once');
    const gate = shutGate();
    const container = execute(graph);
    const first = container.initialize();
    const second = container.initialize();
    const ten = Array.from({ length: 10 }, () => container.initialize());
    expect(count('__t07Calls')).toBe(1);
    let during: unknown;
    try {
      container.resolve(tokenId(graph, 'OncePort'));
    } catch (error) {
      during = error;
    }
    expect(readFailure(during).code).toBe('NEO_NOT_INITIALIZED');
    let settled = false;
    void Promise.all([first, second, ...ten]).then(() => { settled = true; });
    await flush();
    expect(settled).toBe(false);
    gate.open();
    await first;
    await second;
    await Promise.all(ten);
    expect(count('__t07Calls')).toBe(1);
  });

  it('T07-A03 dependent factory waits for its dependency', async () => {
    const graph = graphs.get('T07Order');
    if (!graph) throw new Error('missing T07Order');
    const gate = shutGate();
    Reflect.set(globalThis, '__t07Order', []);
    const container = execute(graph, { tokenA: tokenId(graph, 'OrderA') });
    const pending = container.initialize();
    await flush();
    let during: unknown;
    try {
      container.resolve(tokenId(graph, 'OrderA'));
    } catch (error) {
      during = error;
    }
    expect(readFailure(during).code).toBe('NEO_NOT_INITIALIZED');
    expect(order()).toEqual(['A:start']);
    gate.open();
    await pending;
    expect(order()).toEqual(['A:start', 'A:end', 'B:start', 'B:end']);
    expect(container.resolve(tokenId(graph, 'OrderB'))).toEqual({ n: 2 });
  });

  it('T07-A04 public resolve during initialize throws NEO_NOT_INITIALIZED', async () => {
    const graph = graphs.get('T07Guard');
    if (!graph) throw new Error('missing T07Guard');
    const gate = shutGate();
    const token = tokenId(graph, 'GuardPort');
    const container = execute(graph);
    const pending = container.initialize();
    await flush();
    let resolved: unknown;
    let resolvedAll: unknown;
    try {
      container.resolve(token);
    } catch (error) {
      resolved = error;
    }
    try {
      container.resolveAll(token);
    } catch (error) {
      resolvedAll = error;
    }
    const one = readFailure(resolved);
    const all = readFailure(resolvedAll);
    expect(one.code).toBe('NEO_NOT_INITIALIZED');
    expect(one.message.startsWith('NEO_NOT_INITIALIZED')).toBe(true);
    expect(one.message).toContain('[T07Guard]');
    expect(all.code).toBe('NEO_NOT_INITIALIZED');
    expect(all.message.startsWith('NEO_NOT_INITIALIZED')).toBe(true);
    expect(all.message).toContain('[T07Guard]');
    expect(all.message).toContain('resolveAll()');
    gate.open();
    await pending;
  });

  it('T07-A05 factory failure is kept', async () => {
    const graph = graphs.get('T07Fail');
    if (!graph) throw new Error('missing T07Fail');
    const boom = new Error('kept');
    Reflect.set(globalThis, '__t07Boom', boom);
    const container = execute(graph);
    const token = tokenId(graph, 'FailPort');
    let first: unknown;
    try {
      await container.initialize();
    } catch (error) {
      first = error;
    }
    let second: unknown;
    try {
      await container.initialize();
    } catch (error) {
      second = error;
    }
    expect(first).toBe(boom);
    expect(second).toBe(boom);
    expect(count('__t07Calls')).toBe(1);
    let resolved: unknown;
    try {
      container.resolve(token);
    } catch (error) {
      resolved = error;
    }
    const failure = readFailure(resolved);
    expect(failure.code).toBe('NEO_CONTAINER_FAILED');
    expect(failure.cause).toBe(boom);
  });

  it('T07-A06 destroy during initialize waits then closes', async () => {
    const graph = graphs.get('T07Close');
    if (!graph) throw new Error('missing T07Close');
    const gate = shutGate();
    const container = execute(graph, {}, { prelude: BOX, direct: true });
    const pending = container.initialize();
    await flush();
    let destroySettled = false;
    const closing = container.destroy().then(() => { destroySettled = true; }, () => { destroySettled = true; });
    await flush();
    let resolved: unknown;
    try {
      container.resolve(tokenId(graph, 'ClosePort'));
    } catch (error) {
      resolved = error;
    }
    expect(readFailure(resolved).code).toBe('NEO_CONTAINER_DESTROYED');
    let resolvedAll: unknown;
    try {
      container.resolveAll(tokenId(graph, 'ClosePort'));
    } catch (error) {
      resolvedAll = error;
    }
    expect(readFailure(resolvedAll).code).toBe('NEO_CONTAINER_DESTROYED');
    expect(destroySettled).toBe(false);
    gate.open();
    await pending;
    await closing;
    expect(count('__t07Calls')).toBe(1);
    expect(count('__t07Disposes')).toBe(1);
    let later: unknown;
    try {
      await container.initialize();
    } catch (error) {
      later = error;
    }
    expect(readFailure(later).code).toBe('NEO_CONTAINER_DESTROYED');
    expect(count('__t07Calls')).toBe(1);
    let after: unknown;
    try {
      container.resolve(tokenId(graph, 'ClosePort'));
    } catch (error) {
      after = error;
    }
    expect(readFailure(after).code).toBe('NEO_CONTAINER_DESTROYED');
  });

  it('T07-A07 two children share one parent initialization', async () => {
    const parentGraph = graphs.get('T07Parent');
    const childAGraph = graphs.get('T07ChildA');
    const childBGraph = graphs.get('T07ChildB');
    if (!parentGraph || !childAGraph || !childBGraph) throw new Error('missing T07 parent graphs');
    const gate = shutGate();
    const parent = execute(parentGraph);
    const childA = executeChild(childAGraph, parent);
    const childB = executeChild(childBGraph, parent);
    let aSettled = false;
    let bSettled = false;
    const pendingA = childA.initialize().then(() => { aSettled = true; }, () => { aSettled = true; });
    const pendingB = childB.initialize().then(() => { bSettled = true; }, () => { bSettled = true; });
    await flush();
    expect(aSettled).toBe(false);
    expect(bSettled).toBe(false);
    expect(count('__t07ParentCalls')).toBe(1);
    gate.open();
    await pendingA;
    await pendingB;
    expect(count('__t07ParentCalls')).toBe(1);
  });

  it('T07-B01 concurrent destroy joins the same close', async () => {
    const joinGraph = graphs.get('T07Join');
    if (!joinGraph) throw new Error('missing T07Join');
    const disposeGate = shutDisposeGate();
    const joining = execute(joinGraph, {}, { prelude: LATCH, direct: true });
    await joining.initialize();
    expect(count('__t07Disposes')).toBe(0);
    let firstSettled = false;
    let secondSettled = false;
    const first = joining.destroy().then(() => { firstSettled = true; }, () => { firstSettled = true; });
    const second = joining.destroy().then(() => { secondSettled = true; }, () => { secondSettled = true; });
    await flush();
    expect(count('__t07Disposes')).toBe(1);
    expect(firstSettled).toBe(false);
    expect(secondSettled).toBe(false);
    disposeGate.open();
    await first;
    await second;
    expect(count('__t07Disposes')).toBe(1);
    await joining.destroy();
    expect(count('__t07Disposes')).toBe(1);
  });

  it('T07-B01 second initialize does not run the factory again', async () => {
    const graph = graphs.get('T07Close');
    if (!graph) throw new Error('missing T07Close');
    const gate = shutGate();
    const container = execute(graph, {}, { prelude: BOX, direct: true });
    const pending = container.initialize();
    gate.open();
    await pending;
    await container.initialize();
    expect(count('__t07Calls')).toBe(1);
    await container.destroy();
    let later: unknown;
    try {
      await container.initialize();
    } catch (error) {
      later = error;
    }
    expect(readFailure(later).code).toBe('NEO_CONTAINER_DESTROYED');
    expect(count('__t07Calls')).toBe(1);
  });

  it('T07-B01 destroy from created builds nothing', async () => {
    const graph = graphs.get('T07Close');
    if (!graph) throw new Error('missing T07Close');
    const fresh = execute(graph, {}, { prelude: BOX, direct: true });
    await fresh.destroy();
    expect(count('__t07Calls')).toBe(0);
    expect(count('__t07Created')).toBe(0);
  });

  it('T07-B02 destroy during a rejecting factory keeps the failure', async () => {
    const graph = graphs.get('T07RejectClose');
    if (!graph) throw new Error('missing T07RejectClose');
    const boom = new Error('reject-close');
    Reflect.set(globalThis, '__t07Boom', boom);
    const gate = shutGate();
    const disposeGate = shutDisposeGate();
    const container = execute(graph, {}, { prelude: LATCH, direct: true });
    let initError: unknown;
    const pending = container.initialize().then(() => {}, (error: unknown) => { initError = error; });
    await flush();
    let destroySettled = false;
    const closing = container.destroy().then(() => { destroySettled = true; }, () => { destroySettled = true; });
    await flush();
    expect(destroySettled).toBe(false);
    gate.open();
    await pending;
    await flush();
    expect(initError).toBe(boom);
    expect(Reflect.get(container, '_failure')).toBe(boom);
    expect(destroySettled).toBe(false);
    let during: unknown;
    try {
      await container.initialize();
    } catch (error) {
      during = error;
    }
    expect(readFailure(during).code).toBe('NEO_CONTAINER_DESTROYED');
    expect(count('__t07Disposes')).toBe(1);
    disposeGate.open();
    await closing;
    expect(destroySettled).toBe(true);
    expect(count('__t07Disposes')).toBe(1);
    await container.destroy();
    expect(count('__t07Disposes')).toBe(1);
  });

  it('T07-B03 failed container destroy disposes created instances', async () => {
    const graph = graphs.get('T07FailClose');
    if (!graph) throw new Error('missing T07FailClose');
    const boom = new Error('fail-then-destroy');
    Reflect.set(globalThis, '__t07Boom', boom);
    const failed = execute(graph, {}, { prelude: BOX, direct: true });
    let initError: unknown;
    try {
      await failed.initialize();
    } catch (error) {
      initError = error;
    }
    expect(initError).toBe(boom);
    expect(count('__t07Created')).toBe(1);
    await failed.destroy();
    expect(count('__t07Disposes')).toBe(1);
    await failed.destroy();
    expect(count('__t07Disposes')).toBe(1);
  });

  it('T07-B04 child of a ready parent does not initialize it again', async () => {
    const parentGraph = graphs.get('T07Parent');
    const childGraph = graphs.get('T07ChildA');
    if (!parentGraph || !childGraph) throw new Error('missing T07 ready parent graphs');
    const gate = shutGate();
    const parent = execute(parentGraph);
    const pending = parent.initialize();
    gate.open();
    await pending;
    expect(count('__t07ParentCalls')).toBe(1);
    const child = executeChild(childGraph, parent);
    await child.initialize();
    expect(count('__t07ParentCalls')).toBe(1);
    expect(child.resolve(tokenId(childGraph, 'ChildMark'))).toEqual({ n: 1 });
  });

  it('T07-B05 child of a failed parent rejects with that cause', async () => {
    const parentGraph = graphs.get('T07FailedParent');
    const childGraph = graphs.get('T07FailedChild');
    if (!parentGraph || !childGraph) throw new Error('missing T07 failed parent graphs');
    const boom = new Error('parent-boom');
    Reflect.set(globalThis, '__t07Boom', boom);
    const parent = execute(parentGraph);
    let parentError: unknown;
    try {
      await parent.initialize();
    } catch (error) {
      parentError = error;
    }
    expect(parentError).toBe(boom);
    const child = executeChild(childGraph, parent);
    let childError: unknown;
    try {
      await child.initialize();
    } catch (error) {
      childError = error;
    }
    expect(childError).toBe(boom);
    let resolved: unknown;
    try {
      child.resolve(tokenId(childGraph, 'ChildMark'));
    } catch (error) {
      resolved = error;
    }
    const failure = readFailure(resolved);
    expect(failure.code).toBe('NEO_CONTAINER_FAILED');
    expect(failure.cause).toBe(boom);
  });

  it('T07-B06 sync factory throw expires the context', async () => {
    const graph = graphs.get('T07LeakCall');
    if (!graph) throw new Error('missing T07LeakCall');
    const dep = tokenId(graph, 'CallDep');
    const container = execute(graph, { callSync: tokenId(graph, 'CallSync') });
    let initError: unknown;
    try {
      await container.initialize();
    } catch (error) {
      initError = error;
    }
    expect(initError instanceof Error ? initError.message : '').toContain('sync-leak');
    const leaked = Reflect.get(globalThis, '__t07Leaked') as { resolve: (token: unknown) => unknown };
    let later: unknown;
    try {
      leaked.resolve(dep);
    } catch (error) {
      later = error;
    }
    expect(readFailure(later).code).toBe('NEO_FACTORY_CONTEXT_EXPIRED');
  });

  it('T07-B06 warmup resolve throw expires the context', async () => {
    const graph = graphs.get('T07LeakWarm');
    if (!graph) throw new Error('missing T07LeakWarm');
    const dep = tokenId(graph, 'WarmDep');
    const container = execute(graph);
    let initError: unknown;
    try {
      await container.initialize();
    } catch (error) {
      initError = error;
    }
    expect(initError instanceof Error ? initError.message : '').toContain('warm-leak');
    const leaked = Reflect.get(globalThis, '__t07Leaked') as { resolve: (token: unknown) => unknown };
    let later: unknown;
    try {
      leaked.resolve(dep);
    } catch (error) {
      later = error;
    }
    expect(readFailure(later).code).toBe('NEO_FACTORY_CONTEXT_EXPIRED');
  });

  it('T07-B07 sync singleton built after destroy was requested is journaled', async () => {
    const graph = graphs.get('T07Journal');
    if (!graph) throw new Error('missing T07Journal');
    const gate = shutGate();
    const container = execute(graph, {}, { prelude: BOX, direct: true });
    const pending = container.initialize();
    await flush();
    expect(count('__t07Created')).toBe(0);
    const closing = container.destroy();
    gate.open();
    await pending;
    await closing;
    expect(count('__t07Created')).toBe(1);
    const journal = Reflect.get(container, '_initJournal');
    expect(Array.isArray(journal)).toBe(true);
    const entries = journal as unknown[];
    expect(entries.filter((entry) => typeof entry === 'string')).toHaveLength(2);
    expect(entries.some((entry) => typeof entry === 'function' && (entry as { name?: string }).name === 'Box')).toBe(true);
  });
});
