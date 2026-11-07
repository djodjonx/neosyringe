import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as ts from 'typescript';
import { hasText, textAt } from '../helpers/tsPath';
import { Analyzer } from '../../src/analyzer/Analyzer';
import { Generator } from '../../src/generator/Generator';
import type { DependencyGraph, ServiceDefinition } from '../../src/analyzer/types';

const ROOT = path.join(process.cwd(), 't09-runtime');
const ORDER_FILE = path.join(ROOT, 'order.ts');
const REJECT_FILE = path.join(ROOT, 'reject.ts');
const RACE_FILE = path.join(ROOT, 'race.ts');
const VALUE_FILE = path.join(ROOT, 'value.ts');
const BORROW_FILE = path.join(ROOT, 'borrow.ts');
const SCOPE_FILE = path.join(ROOT, 'scope.ts');
const GUARD_FILE = path.join(ROOT, 'guard.ts');
const PARENT_FILE = path.join(ROOT, 'parent.ts');
const CLOSED_FILE = path.join(ROOT, 'closed.ts');
const CLEAN_FILE = path.join(ROOT, 'clean.ts');
const AGAIN_FILE = path.join(ROOT, 'again.ts');
const FRESH_FILE = path.join(ROOT, 'fresh.ts');

const STUB = `
  import { defineBuilderConfig, definePartialConfig, useInterface } from '@djodjonx/neosyringe';
  function defineBuilderConfig(config: any) { return config; }
  function definePartialConfig(config: any) { return config; }
  function useInterface<T>(): any { return null; }
`;

const ORDER_CLASSES = `
  class ClassDep {
    dispose(): void {
      const holder = globalThis as { __t09Order?: string[] };
      const order = holder.__t09Order ?? [];
      order.push('classDep');
      holder.__t09Order = order;
    }
  }
  class ClassUse {
    constructor(_dep: ClassDep) {}
    dispose(): void {
      const holder = globalThis as { __t09Order?: string[] };
      const order = holder.__t09Order ?? [];
      order.push('classUse');
      holder.__t09Order = order;
    }
  }
  class AsyncDep {
    async dispose(): Promise<void> {
      const holder = globalThis as { __t09Order?: string[] };
      const order = holder.__t09Order ?? [];
      order.push('asyncDep:start');
      holder.__t09Order = order;
      await (globalThis as { __t09DisposeGate?: { ready: Promise<void> } }).__t09DisposeGate!.ready;
      order.push('asyncDep');
    }
  }
  class AsyncUse {
    constructor(_dep: AsyncDep) {}
    async dispose(): Promise<void> {
      const holder = globalThis as { __t09Order?: string[] };
      const order = holder.__t09Order ?? [];
      order.push('asyncUse:start');
      holder.__t09Order = order;
      await (globalThis as { __t09DisposeGate?: { ready: Promise<void> } }).__t09DisposeGate!.ready;
      order.push('asyncUse');
    }
  }
`;

const REJECT_CLASSES = `
  class RejectDep {
    dispose(): void {
      const holder = globalThis as { __t09Dep?: number };
      holder.__t09Dep = (holder.__t09Dep ?? 0) + 1;
    }
  }
  class RejectUse {
    constructor(_dep: RejectDep) {}
    dispose(): void {
      const holder = globalThis as { __t09Use?: number };
      holder.__t09Use = (holder.__t09Use ?? 0) + 1;
      throw (globalThis as { __t09DisposeError: Error }).__t09DisposeError;
    }
  }
`;

const RACE_CLASSES = `
  class RaceBox {
    async dispose(): Promise<void> {
      const holder = globalThis as { __t09Race?: number };
      holder.__t09Race = (holder.__t09Race ?? 0) + 1;
      await (globalThis as { __t09DisposeGate?: { ready: Promise<void> } }).__t09DisposeGate!.ready;
    }
  }
`;

const CLEAN_CLASSES = `
  class ParentRes {
    dispose(): void {
      const holder = globalThis as { __t09ParentDisposes?: number };
      holder.__t09ParentDisposes = (holder.__t09ParentDisposes ?? 0) + 1;
    }
  }
  class LocalRes {
    dispose(): void {
      const holder = globalThis as { __t09LocalDisposes?: number };
      holder.__t09LocalDisposes = (holder.__t09LocalDisposes ?? 0) + 1;
      throw (globalThis as { __t09CleanupError: Error }).__t09CleanupError;
    }
  }
`;

const FRESH_CLASSES = `
  class IdleBox {
    dispose(): void {
      const holder = globalThis as { __t09Idle?: number };
      holder.__t09Idle = (holder.__t09Idle ?? 0) + 1;
    }
  }
`;

const files = new Map<string, string>([
  [ORDER_FILE, `
    ${STUB}
    ${ORDER_CLASSES}
    interface FactoryDep { n: number }
    interface FactoryUse { n: number }
    interface AsyncFactoryDep { n: number }
    interface AsyncFactoryUse { n: number }
    const factoryDep = useInterface<FactoryDep>();
    const factoryUse = useInterface<FactoryUse>();
    const asyncFactoryDep = useInterface<AsyncFactoryDep>();
    const asyncFactoryUse = useInterface<AsyncFactoryUse>();
    export const orderContainer = defineBuilderConfig({
      name: 'T09Order',
      injections: [
        { token: ClassDep },
        { token: ClassUse },
        { token: AsyncDep },
        { token: AsyncUse },
        {
          token: factoryDep,
          useFactory: true,
          dependencies: [],
          provider: () => ({
            n: 1,
            dispose() {
              const holder = globalThis as { __t09Order?: string[] };
              const order = holder.__t09Order ?? [];
              order.push('factoryDep');
              holder.__t09Order = order;
            },
          }),
        },
        {
          token: factoryUse,
          useFactory: true,
          dependencies: [factoryDep],
          provider: (ctx) => {
            ctx.resolve(factoryDep);
            return {
              n: 2,
              dispose() {
                const holder = globalThis as { __t09Order?: string[] };
                const order = holder.__t09Order ?? [];
                order.push('factoryUse');
                holder.__t09Order = order;
              },
            };
          },
        },
        {
          token: asyncFactoryDep,
          useFactory: true,
          dependencies: [],
          provider: () => ({
            n: 3,
            dispose() {
              const holder = globalThis as { __t09Order?: string[] };
              const order = holder.__t09Order ?? [];
              order.push('asyncFactoryDep:start');
              holder.__t09Order = order;
              return (globalThis as { __t09DisposeGate?: { ready: Promise<void> } }).__t09DisposeGate!.ready.then(() => {
                order.push('asyncFactoryDep');
              });
            },
          }),
        },
        {
          token: asyncFactoryUse,
          useFactory: true,
          dependencies: [asyncFactoryDep],
          provider: (ctx) => {
            ctx.resolve(asyncFactoryDep);
            return {
              n: 4,
              dispose() {
                const holder = globalThis as { __t09Order?: string[] };
                const order = holder.__t09Order ?? [];
                order.push('asyncFactoryUse:start');
                holder.__t09Order = order;
                return (globalThis as { __t09DisposeGate?: { ready: Promise<void> } }).__t09DisposeGate!.ready.then(() => {
                  order.push('asyncFactoryUse');
                });
              },
            };
          },
        },
      ],
    });
  `],
  [REJECT_FILE, `
    ${STUB}
    ${REJECT_CLASSES}
    export const rejectContainer = defineBuilderConfig({
      name: 'T09Reject',
      injections: [
        { token: RejectDep },
        { token: RejectUse },
      ],
    });
  `],
  [RACE_FILE, `
    ${STUB}
    ${RACE_CLASSES}
    export const raceContainer = defineBuilderConfig({
      name: 'T09Race',
      injections: [{ token: RaceBox }],
    });
  `],
  [VALUE_FILE, `
    ${STUB}
    interface DirectPort { label: string }
    interface PartialPort { label: string }
    const directPort = useInterface<DirectPort>();
    const partialPort = useInterface<PartialPort>();
    export const valuePartial = definePartialConfig({
      injections: [
        { token: partialPort, useValue: globalThis.__t09Next('partial') },
      ],
    });
    export const directContainer = defineBuilderConfig({
      name: 'T09Direct',
      injections: [
        { token: directPort, useValue: globalThis.__t09Next('direct') },
      ],
    });
    export const hostA = defineBuilderConfig({
      name: 'T09HostA',
      extends: [valuePartial],
      injections: [],
    });
    export const hostB = defineBuilderConfig({
      name: 'T09HostB',
      extends: [valuePartial],
      injections: [],
    });
  `],
  [BORROW_FILE, `
    ${STUB}
    interface ParentPort { n: number }
    interface BorrowedPort { n: number }
    interface AliasPort { n: number }
    interface OwnedA { n: number }
    interface OwnedB { n: number }
    const parentPort = useInterface<ParentPort>();
    export const parent = defineBuilderConfig({
      name: 'T09Owner',
      injections: [
        {
          token: parentPort,
          useFactory: true,
          dependencies: [],
          provider: () => {
            const value = {
              n: 1,
              dispose() {
                const holder = globalThis as { __t09ParentDisposes?: number };
                holder.__t09ParentDisposes = (holder.__t09ParentDisposes ?? 0) + 1;
              },
            };
            (globalThis as { __t09ParentValue?: typeof value }).__t09ParentValue = value;
            return value;
          },
        },
      ],
    });
    export const child = defineBuilderConfig({
      name: 'T09Borrower',
      useContainer: parent,
      injections: [
        {
          token: useInterface<BorrowedPort>(),
          useFactory: true,
          dependencies: [],
          ownership: 'borrowed',
          provider: () => (globalThis as { __t09Borrowed: { n: number } }).__t09Borrowed,
        },
        {
          token: useInterface<AliasPort>(),
          useFactory: true,
          dependencies: [],
          provider: () => (globalThis as { __t09Borrowed: { n: number } }).__t09Borrowed,
        },
        {
          token: useInterface<OwnedA>(),
          useFactory: true,
          dependencies: [],
          provider: () => (globalThis as { __t09Owned: { n: number } }).__t09Owned,
        },
        {
          token: useInterface<OwnedB>(),
          useFactory: true,
          dependencies: [],
          provider: () => (globalThis as { __t09Owned: { n: number } }).__t09Owned,
        },
      ],
    });
  `],
  [SCOPE_FILE, `
    ${STUB}
    interface ParentPort { n: number }
    interface LocalPort { n: number }
    const parentPort = useInterface<ParentPort>();
    const localPort = useInterface<LocalPort>();
    export const parent = defineBuilderConfig({
      name: 'T09ScopeParent',
      injections: [
        {
          token: parentPort,
          useFactory: true,
          dependencies: [],
          provider: () => ({ n: 1 }),
        },
      ],
    });
    export const child = defineBuilderConfig({
      name: 'T09ScopeChild',
      useContainer: parent,
      injections: [
        {
          token: localPort,
          useFactory: true,
          dependencies: [],
          provider: () => {
            const holder = globalThis as { __t09LocalSeq?: number };
            holder.__t09LocalSeq = (holder.__t09LocalSeq ?? 0) + 1;
            return { n: holder.__t09LocalSeq };
          },
        },
      ],
    });
  `],
  [GUARD_FILE, `
    ${STUB}
    ${RACE_CLASSES}
    interface GuardPort { n: number }
    export const guardContainer = defineBuilderConfig({
      name: 'T09Guard',
      injections: [
        {
          token: useInterface<GuardPort>(),
          useFactory: true,
          dependencies: [],
          provider: async () => ({ n: 1 }),
        },
      ],
    });
    export const failContainer = defineBuilderConfig({
      name: 'T09GuardFail',
      injections: [
        {
          token: useInterface<GuardPort>(),
          useFactory: true,
          dependencies: [],
          provider: async () => {
            throw (globalThis as { __t09Boom?: Error }).__t09Boom;
          },
        },
      ],
    });
    export const busyContainer = defineBuilderConfig({
      name: 'T09GuardBusy',
      injections: [
        { token: RaceBox },
        {
          token: useInterface<GuardPort>(),
          useFactory: true,
          dependencies: [RaceBox],
          provider: async (ctx) => {
            ctx.resolve(RaceBox);
            await (globalThis as { __t09Gate?: { ready: Promise<void> } }).__t09Gate!.ready;
            return { n: 2 };
          },
        },
      ],
    });
  `],
  [PARENT_FILE, `
    ${STUB}
    interface LoggerPort { name: string }
    interface ServicePort { logger: LoggerPort }
    interface LocalPort { logger: LoggerPort }
    const logger = useInterface<LoggerPort>();
    const service = useInterface<ServicePort>();
    const local = useInterface<LocalPort>();
    export const parent = defineBuilderConfig({
      name: 'T09ParentApp',
      injections: [
        {
          token: logger,
          useFactory: true,
          dependencies: [],
          provider: () => ({ name: 'parent' }),
        },
        {
          token: service,
          useFactory: true,
          dependencies: [logger],
          provider: (ctx) => ({ logger: ctx.resolve(logger) }),
        },
      ],
    });
    export const child = defineBuilderConfig({
      name: 'T09ChildApp',
      useContainer: parent,
      injections: [
        {
          token: logger,
          useFactory: true,
          dependencies: [],
          scoped: true,
          provider: () => ({ name: 'child' }),
        },
        {
          token: local,
          useFactory: true,
          dependencies: [logger],
          provider: (ctx) => ({ logger: ctx.resolve(logger) }),
        },
      ],
    });
  `],
  [CLOSED_FILE, `
    ${STUB}
    interface BookPort { n: number }
    interface ReaderPort { book: BookPort }
    const book = useInterface<BookPort>();
    const reader = useInterface<ReaderPort>();
    export const parent = defineBuilderConfig({
      name: 'T09ClosedParent',
      injections: [
        {
          token: book,
          useFactory: true,
          dependencies: [],
          provider: () => ({ n: 1 }),
        },
      ],
    });
    export const child = defineBuilderConfig({
      name: 'T09ClosedChild',
      useContainer: parent,
      injections: [
        {
          token: reader,
          useFactory: true,
          dependencies: [book],
          provider: (ctx) => ({ book: ctx.resolve(book) }),
        },
      ],
    });
  `],
  [CLEAN_FILE, `
    ${STUB}
    ${CLEAN_CLASSES}
    interface BoomPort { n: number }
    export const parent = defineBuilderConfig({
      name: 'T09CleanParent',
      injections: [{ token: ParentRes }],
    });
    export const child = defineBuilderConfig({
      name: 'T09CleanChild',
      useContainer: parent,
      injections: [
        { token: LocalRes },
        {
          token: useInterface<BoomPort>(),
          useFactory: true,
          dependencies: [LocalRes],
          provider: async (ctx) => {
            ctx.resolve(LocalRes);
            throw (globalThis as { __t09Boom?: Error }).__t09Boom;
          },
        },
      ],
    });
  `],
  [AGAIN_FILE, `
    ${STUB}
    interface AgainPort { n: number }
    export const againContainer = defineBuilderConfig({
      name: 'T09Again',
      injections: [
        {
          token: useInterface<AgainPort>(),
          useFactory: true,
          dependencies: [],
          provider: () => ({ n: 7 }),
        },
      ],
    });
  `],
  [FRESH_FILE, `
    ${STUB}
    ${FRESH_CLASSES}
    interface LaterPort { n: number }
    export const freshContainer = defineBuilderConfig({
      name: 'T09Fresh',
      injections: [{ token: IdleBox }],
    });
    export const freshAsync = defineBuilderConfig({
      name: 'T09FreshAsync',
      injections: [
        { token: IdleBox },
        {
          token: useInterface<LaterPort>(),
          useFactory: true,
          dependencies: [IdleBox],
          provider: async (ctx) => {
            ctx.resolve(IdleBox);
            return { n: 1 };
          },
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
  createScope: () => RuntimeContainer;
  override: (token: unknown, factory: () => unknown) => Promise<void>;
  on: (event: 'resolve', listener: (token: unknown, instance: unknown) => void) => () => void;
}

interface Gate {
  ready: Promise<void>;
  open: () => void;
}

const opened: RuntimeContainer[] = [];

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
  options: { prelude?: string; parent?: RuntimeContainer; bindings?: Record<string, string> } = {},
): RuntimeContainer {
  const generator = new Generator(graph, true, undefined, true, true);
  const name = graph.exportedVariableName ?? 'container';
  const bindingLines = Object.entries(options.bindings ?? {}).map(([key, value]) => `const ${key} = ${JSON.stringify(value)};`);
  const tsCode = `${bindingLines.join('\n')}\n${options.prelude ?? ''}\n${generator.generate()}\nexport const ${name} = ${generator.generateInstantiation()};`;
  const jsCode = ts.transpileModule(tsCode, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const moduleRecord: { exports: Record<string, RuntimeContainer | undefined> } = { exports: {} };
  const run = new Function('parent', 'module', 'exports', 'require', jsCode) as (
    parent: RuntimeContainer | undefined,
    module: typeof moduleRecord,
    exports: typeof moduleRecord.exports,
    require: (id: string) => unknown,
  ) => void;
  run(options.parent, moduleRecord, moduleRecord.exports, () => ({}));
  const container = moduleRecord.exports[name];
  if (!container) throw new Error(`generated module did not export ${name}`);
  opened.push(container);
  return container;
}

function loadNamed(
  source: string,
  validation: 'strict' | 'compatible' = 'strict',
): Map<string, DependencyGraph> {
  const fileName = path.join(ROOT, `case-${validation}.ts`);
  const named = new Map<string, DependencyGraph>();
  for (const graph of new Analyzer(createProgram(new Map([[fileName, source]])), { validation }).extractAll()) {
    named.set(graph.containerId, graph);
  }
  return named;
}

function flaggedValueGraph(): DependencyGraph {
  const service: ServiceDefinition = {
    tokenId: 'FlaggedPort',
    type: 'value',
    lifecycle: 'singleton',
    isInterfaceToken: true,
    isDisposable: true,
    ownership: 'owned',
    valueSource: '(globalThis).__t09Flagged',
    valueCapture: '__neoCapture_flagged',
    registrationNode: {} as ts.Node,
  };
  return {
    containerId: 'T09Flagged',
    containerName: 'T09Flagged',
    nodes: new Map([['FlaggedPort', { service, dependencies: [] }]]),
    roots: ['FlaggedPort'],
    exportedVariableName: 'container',
    variableExportModifier: 'export',
  };
}

function graphByName(graphs: Map<string, DependencyGraph>, name: string): DependencyGraph {
  const graph = graphs.get(name);
  if (!graph) throw new Error(`missing ${name}`);
  const errors = (graph.errors ?? []).filter((error) => error.severity !== 'warning');
  if (errors.length > 0) throw new Error(errors.map((error) => error.message).join('\n'));
  return graph;
}

function shutGate(key: string): Gate {
  let openGate: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    openGate = resolve;
  });
  const gate: Gate = { ready, open: () => { openGate(); } };
  Reflect.set(globalThis, key, gate);
  return gate;
}

function readFailure(value: unknown): {
  code: string | undefined;
  message: string;
  cause: unknown;
  cleanupErrors: unknown[] | undefined;
} {
  if (!(value instanceof Error)) {
    return { code: undefined, message: '', cause: undefined, cleanupErrors: undefined };
  }
  const coded = value as Error & { code?: unknown; cause?: unknown; cleanupErrors?: unknown };
  const code = typeof coded.code === 'string' ? coded.code : undefined;
  const cleanupErrors = Array.isArray(coded.cleanupErrors) ? coded.cleanupErrors : undefined;
  return { code, message: value.message, cause: coded.cause, cleanupErrors };
}

function count(key: string): number {
  const value = Reflect.get(globalThis, key);
  return typeof value === 'number' ? value : 0;
}

function order(): string[] {
  const value = Reflect.get(globalThis, '__t09Order');
  return Array.isArray(value) ? value.map((item) => String(item)) : [];
}

function evals(label: string): number {
  const table = Reflect.get(globalThis, '__t09Evals') as Record<string, number> | undefined;
  return table?.[label] ?? 0;
}

function at(label: string): number {
  return order().indexOf(label);
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

const PARTIAL_PRELUDE = `const valuePartial = (globalThis as { __t09Partial: { injections: { useValue: unknown }[] } }).__t09Partial;`;

function stash(classes: string, names: string[]): string {
  const lines = names.map((name) => `(globalThis as { ${name}?: typeof ${name} }).${name} = ${name};`);
  return `${classes}\n${lines.join('\n')}\n`;
}

function ctor<T>(name: string): T {
  const value = Reflect.get(globalThis, name) as T | undefined;
  if (!value) throw new Error(`missing runtime class ${name}`);
  return value;
}

describe('T09 scope runtime', () => {
  let graphs: Map<string, DependencyGraph>;

  beforeAll(() => {
    graphs = new Map();
    for (const graph of new Analyzer(createProgram(files)).extractAll()) {
      graphs.set(graph.containerId, graph);
    }
  });

  afterEach(async () => {
    const gate = Reflect.get(globalThis, '__t09Gate') as Gate | undefined;
    gate?.open();
    const disposeGate = Reflect.get(globalThis, '__t09DisposeGate') as Gate | undefined;
    disposeGate?.open();
    const pending = opened.splice(0);
    await Promise.allSettled(pending.map((container) => container.destroy()));
    for (const key of [
      '__t09Order',
      '__t09Gate',
      '__t09DisposeGate',
      '__t09Dep',
      '__t09Use',
      '__t09DisposeError',
      '__t09Race',
      '__t09Evals',
      '__t09Values',
      '__t09Next',
      '__t09Partial',
      '__t09ValueDisposes',
      '__t09Borrowed',
      '__t09Owned',
      '__t09ParentValue',
      '__t09ParentDisposes',
      '__t09LocalDisposes',
      '__t09LocalSeq',
      '__t09Boom',
      '__t09CleanupError',
      '__t09Idle',
      '__t09Ctor',
    ]) {
      Reflect.deleteProperty(globalThis, key);
    }
  });

  it('T09-P1 destroy order', async () => {
    const graph = graphByName(graphs, 'T09Order');
    shutGate('__t09DisposeGate');
    const container = execute(graph, {
      prelude: stash(ORDER_CLASSES, ['ClassDep', 'ClassUse', 'AsyncDep', 'AsyncUse']),
      bindings: {
        factoryDep: tokenId(graph, 'FactoryDep'),
        asyncFactoryDep: tokenId(graph, 'AsyncFactoryDep'),
      },
    });
    await container.initialize();
    container.resolve(ctor<new () => unknown>('ClassDep'));
    container.resolve(ctor<new (_dep: unknown) => unknown>('ClassUse'));
    container.resolve(ctor<new () => unknown>('AsyncDep'));
    container.resolve(ctor<new (_dep: unknown) => unknown>('AsyncUse'));
    container.resolve(tokenId(graph, 'FactoryDep'));
    container.resolve(tokenId(graph, 'FactoryUse'));
    container.resolve(tokenId(graph, 'AsyncFactoryDep'));
    container.resolve(tokenId(graph, 'AsyncFactoryUse'));
    const pending = container.destroy();
    await flush();
    expect(at('factoryUse')).toBeGreaterThanOrEqual(0);
    expect(at('factoryUse')).toBeLessThan(at('factoryDep'));
    expect(at('classUse')).toBeLessThan(at('classDep'));
    expect(order().filter((item) => item === 'classUse')).toEqual(['classUse']);
    expect(order().filter((item) => item === 'classDep')).toEqual(['classDep']);
    expect(order().filter((item) => item === 'factoryUse')).toEqual(['factoryUse']);
    expect(order().filter((item) => item === 'factoryDep')).toEqual(['factoryDep']);
    expect(at('asyncFactoryUse')).toBe(-1);
    const disposeGate = Reflect.get(globalThis, '__t09DisposeGate') as Gate;
    disposeGate.open();
    await pending;
    expect(at('asyncFactoryUse')).toBeGreaterThanOrEqual(0);
    expect(at('asyncFactoryUse')).toBeLessThan(at('asyncFactoryDep'));
    expect(at('asyncUse')).toBeLessThan(at('asyncDep'));
    expect(order().filter((item) => item === 'asyncFactoryUse')).toEqual(['asyncFactoryUse']);
    expect(order().filter((item) => item === 'asyncUse')).toEqual(['asyncUse']);
  });

  it('T09-P2 dispose rejects', async () => {
    const graph = graphByName(graphs, 'T09Reject');
    const disposeError = new Error('dispose-boom') as Error & { code: string };
    disposeError.code = 'E_DISPOSE';
    Reflect.set(globalThis, '__t09DisposeError', disposeError);
    const container = execute(graph, { prelude: stash(REJECT_CLASSES, ['RejectDep', 'RejectUse']) });
    container.resolve(ctor<new () => unknown>('RejectDep'));
    container.resolve(ctor<new (_dep: unknown) => unknown>('RejectUse'));
    let caught: unknown;
    try {
      await container.destroy();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AggregateError);
    const errors = caught instanceof AggregateError ? [...caught.errors] : [];
    expect(errors.map((item) => (item instanceof Error ? item.message : ''))).toContain('dispose-boom');
    expect(errors.map((item) => (item instanceof Error ? (item as Error & { code?: string }).code : ''))).toContain('E_DISPOSE');
    expect(count('__t09Use')).toBe(1);
    expect(count('__t09Dep')).toBe(1);
    await container.destroy();
    expect(count('__t09Use')).toBe(1);
    expect(count('__t09Dep')).toBe(1);
  });

  it('T09-P3 concurrent destroy', async () => {
    const graph = graphByName(graphs, 'T09Race');
    const gate = shutGate('__t09DisposeGate');
    const container = execute(graph, { prelude: stash(RACE_CLASSES, ['RaceBox']) });
    container.resolve(ctor<new () => unknown>('RaceBox'));
    const first = container.destroy();
    const second = container.destroy();
    await flush();
    expect(count('__t09Race')).toBe(1);
    let firstSettled = false;
    let secondSettled = false;
    void first.then(() => { firstSettled = true; }, () => { firstSettled = true; });
    void second.then(() => { secondSettled = true; }, () => { secondSettled = true; });
    await flush();
    expect(firstSettled).toBe(false);
    expect(secondSettled).toBe(false);
    gate.open();
    await first;
    await second;
    expect(count('__t09Race')).toBe(1);
    await container.destroy();
    expect(count('__t09Race')).toBe(1);
  });

  it('T09-P4 useValue', async () => {
    const direct = graphByName(graphs, 'T09Direct');
    const hostAGraph = graphByName(graphs, 'T09HostA');
    const hostBGraph = graphByName(graphs, 'T09HostB');
    Reflect.set(globalThis, '__t09Next', (label: string) => {
      const holder = globalThis as {
        __t09Evals?: Record<string, number>;
        __t09ValueDisposes?: number;
      };
      const evals = holder.__t09Evals ?? {};
      evals[label] = (evals[label] ?? 0) + 1;
      holder.__t09Evals = evals;
      return {
        label,
        dispose(): void {
          const gone = globalThis as { __t09ValueDisposes?: number };
          gone.__t09ValueDisposes = (gone.__t09ValueDisposes ?? 0) + 1;
        },
      };
    });
    const next = Reflect.get(globalThis, '__t09Next') as (label: string) => { label: string };
    const partialValue = next('partial');
    Reflect.set(globalThis, '__t09Partial', { injections: [{ useValue: partialValue }] });
    const container = execute(direct);
    expect(evals('direct')).toBe(1);
    const resolved = container.resolve(tokenId(direct, 'DirectPort')) as { label: string };
    const scope = container.createScope();
    opened.push(scope);
    expect(scope.resolve(tokenId(direct, 'DirectPort'))).toBe(resolved);
    expect(evals('direct')).toBe(1);
    const hostA = execute(hostAGraph, { prelude: PARTIAL_PRELUDE });
    const hostB = execute(hostBGraph, { prelude: PARTIAL_PRELUDE });
    const hostScope = hostA.createScope();
    opened.push(hostScope);
    expect(hostA.resolve(tokenId(hostAGraph, 'PartialPort'))).toBe(partialValue);
    expect(hostB.resolve(tokenId(hostBGraph, 'PartialPort'))).toBe(partialValue);
    expect(hostScope.resolve(tokenId(hostAGraph, 'PartialPort'))).toBe(partialValue);
    expect(evals('partial')).toBe(1);
    await container.destroy();
    await scope.destroy();
    await hostA.destroy();
    await hostB.destroy();
    await hostScope.destroy();
    expect(count('__t09ValueDisposes')).toBe(0);
  });

  it('T09-P5 borrowed', async () => {
    const parentGraph = graphByName(graphs, 'T09Owner');
    const childGraph = graphByName(graphs, 'T09Borrower');
    const borrowed = {
      n: 1,
      dispose(): void {
        const holder = globalThis as { __t09BorrowedDisposes?: number };
        holder.__t09BorrowedDisposes = (holder.__t09BorrowedDisposes ?? 0) + 1;
      },
    };
    const owned = {
      n: 2,
      dispose(): void {
        const holder = globalThis as { __t09OwnedDisposes?: number };
        holder.__t09OwnedDisposes = (holder.__t09OwnedDisposes ?? 0) + 1;
      },
    };
    Reflect.set(globalThis, '__t09Borrowed', borrowed);
    Reflect.set(globalThis, '__t09Owned', owned);
    const parent = execute(parentGraph);
    const child = execute(childGraph, { parent });
    const parentValue = parent.resolve(tokenId(parentGraph, 'ParentPort'));
    child.resolve(tokenId(parentGraph, 'ParentPort'));
    child.resolve(tokenId(childGraph, 'BorrowedPort'));
    child.resolve(tokenId(childGraph, 'AliasPort'));
    child.resolve(tokenId(childGraph, 'OwnedA'));
    child.resolve(tokenId(childGraph, 'OwnedB'));
    await child.destroy();
    expect(count('__t09BorrowedDisposes')).toBe(0);
    expect(count('__t09OwnedDisposes')).toBe(1);
    expect(count('__t09ParentDisposes')).toBe(0);
    expect(parent.resolve(tokenId(parentGraph, 'ParentPort'))).toBe(parentValue);
    await parent.destroy();
    expect(count('__t09ParentDisposes')).toBe(1);
  });

  it('T09-P6 scopes', async () => {
    const parentGraph = graphByName(graphs, 'T09ScopeParent');
    const childGraph = graphByName(graphs, 'T09ScopeChild');
    const parent = execute(parentGraph);
    const child = execute(childGraph, { parent });
    const parentToken = tokenId(parentGraph, 'ParentPort');
    const localToken = tokenId(childGraph, 'LocalPort');
    let scopeA: RuntimeContainer | undefined;
    let scopeB: RuntimeContainer | undefined;
    try {
      scopeA = child.createScope();
      scopeB = child.createScope();
    } catch {
      scopeA = undefined;
      scopeB = undefined;
    }
    expect(scopeA).toBeDefined();
    expect(scopeB).toBeDefined();
    if (!scopeA || !scopeB) return;
    opened.push(scopeA, scopeB);
    expect(scopeA).not.toBe(child);
    expect(scopeA.resolve(localToken)).not.toBe(scopeB.resolve(localToken));
    expect(scopeA.resolve(parentToken)).toBe(parent.resolve(parentToken));
    expect(scopeB.resolve(parentToken)).toBe(parent.resolve(parentToken));
    const childLocal = child.resolve(localToken);
    await scopeA.destroy();
    expect(child.resolve(localToken)).toBe(childLocal);
    expect(parent.resolve(parentToken)).toBe(scopeB.resolve(parentToken));
    let heard = 0;
    child.on('resolve', () => { heard += 1; });
    const scopeC = child.createScope();
    opened.push(scopeC);
    scopeC.resolve(localToken);
    expect(heard).toBe(0);
    await child.override(localToken, () => ({ n: 99 }));
    const scopeD = child.createScope();
    opened.push(scopeD);
    expect((scopeD.resolve(localToken) as { n: number }).n).not.toBe(99);
    expect((child.resolve(localToken) as { n: number }).n).toBe(99);
  });

  it('T09-P7 scope guards', async () => {
    const readyGraph = graphByName(graphs, 'T09Guard');
    const failGraph = graphByName(graphs, 'T09GuardFail');
    const busyGraph = graphByName(graphs, 'T09GuardBusy');
    const ready = execute(readyGraph);
    await ready.initialize();
    let readyScope: RuntimeContainer | undefined;
    try {
      readyScope = ready.createScope();
    } catch {
      readyScope = undefined;
    }
    expect(readyScope).toBeDefined();
    if (!readyScope) return;
    opened.push(readyScope);
    expect(readyScope).not.toBe(ready);
    const guardToken = tokenId(readyGraph, 'GuardPort');
    let readyBefore: unknown;
    try {
      readyScope.resolve(guardToken);
    } catch (error) {
      readyBefore = error;
    }
    expect(readFailure(readyBefore).code).toBe('NEO_NOT_INITIALIZED');
    await readyScope.initialize();
    expect(readyScope.resolve(guardToken)).toEqual({ n: 1 });
    const created = execute(readyGraph);
    let createdScope: RuntimeContainer | undefined;
    try {
      createdScope = created.createScope();
    } catch {
      createdScope = undefined;
    }
    expect(createdScope).toBeDefined();
    if (!createdScope) return;
    opened.push(createdScope);
    let createdBefore: unknown;
    try {
      createdScope.resolve(guardToken);
    } catch (error) {
      createdBefore = error;
    }
    expect(readFailure(createdBefore).code).toBe('NEO_NOT_INITIALIZED');
    await createdScope.initialize();
    expect(createdScope.resolve(guardToken)).toEqual({ n: 1 });
    const boom = new Error('guard-boom');
    Reflect.set(globalThis, '__t09Boom', boom);
    const failed = execute(failGraph);
    let initError: unknown;
    try {
      await failed.initialize();
    } catch (error) {
      initError = error;
    }
    expect(initError).toBe(boom);
    let failedScope: unknown;
    try {
      failedScope = failed.createScope();
    } catch (error) {
      failedScope = error;
    }
    const failedRead = readFailure(failedScope);
    expect(failedRead.code).toBe('NEO_CONTAINER_FAILED');
    expect(failedRead.message).toBe('NEO_CONTAINER_FAILED: [T09GuardFail] container initialization failed');
    const gate = shutGate('__t09Gate');
    const busy = execute(busyGraph, { prelude: stash(RACE_CLASSES, ['RaceBox']) });
    const pending = busy.initialize();
    await flush();
    let busyScope: unknown;
    try {
      busyScope = busy.createScope();
    } catch (error) {
      busyScope = error;
    }
    const busyRead = readFailure(busyScope);
    expect(busyRead.code).toBe('NEO_CONTAINER_BUSY');
    expect(busyRead.message).toBe('NEO_CONTAINER_BUSY: [T09GuardBusy] container is transitioning');
    gate.open();
    await pending;
    const disposeGate = shutGate('__t09DisposeGate');
    const closing = busy.destroy();
    await flush();
    let destroyingScope: unknown;
    try {
      destroyingScope = busy.createScope();
    } catch (error) {
      destroyingScope = error;
    }
    const destroyingRead = readFailure(destroyingScope);
    expect(destroyingRead.code).toBe('NEO_CONTAINER_DESTROYED');
    expect(destroyingRead.message).toBe('NEO_CONTAINER_DESTROYED: [T09GuardBusy] container is destroyed');
    disposeGate.open();
    await closing;
    let destroyedScope: unknown;
    try {
      destroyedScope = busy.createScope();
    } catch (error) {
      destroyedScope = error;
    }
    const destroyedRead = readFailure(destroyedScope);
    expect(destroyedRead.code).toBe('NEO_CONTAINER_DESTROYED');
    expect(destroyedRead.message).toBe('NEO_CONTAINER_DESTROYED: [T09GuardBusy] container is destroyed');
  });

  it('T09-P8 parent semantics', () => {
    const parentGraph = graphByName(graphs, 'T09ParentApp');
    const childGraph = graphByName(graphs, 'T09ChildApp');
    const logger = tokenId(parentGraph, 'LoggerPort');
    const parent = execute(parentGraph, { bindings: { logger } });
    const child = execute(childGraph, { parent, bindings: { logger } });
    const service = tokenId(parentGraph, 'ServicePort');
    const local = tokenId(childGraph, 'LocalPort');
    const parentLogger = parent.resolve(logger);
    const parentService = parent.resolve(service) as { logger: unknown };
    const childLogger = child.resolve(logger);
    const localService = child.resolve(local) as { logger: unknown };
    const viaChild = child.resolve(service) as { logger: unknown };
    expect(parentService.logger).toBe(parentLogger);
    expect(viaChild).toBe(parentService);
    expect(viaChild.logger).toBe(parentLogger);
    expect(localService.logger).toBe(childLogger);
    expect(childLogger).not.toBe(parentLogger);
  });

  it('T09-P9 parent destroyed', async () => {
    const parentGraph = graphByName(graphs, 'T09ClosedParent');
    const childGraph = graphByName(graphs, 'T09ClosedChild');
    const book = tokenId(parentGraph, 'BookPort');
    const parent = execute(parentGraph);
    const child = execute(childGraph, { parent, bindings: { book } });
    const reader = tokenId(childGraph, 'ReaderPort');
    child.resolve(reader);
    await parent.destroy();
    let cached: unknown;
    try {
      child.resolve(reader);
    } catch (error) {
      cached = error;
    }
    const cachedRead = readFailure(cached);
    expect(cachedRead.code).toBe('NEO_SCOPE_PARENT_DESTROYED');
    expect(cachedRead.message).toBe('NEO_SCOPE_PARENT_DESTROYED: [T09ClosedChild] parent is destroyed: T09ClosedParent');
    let fresh: unknown;
    try {
      child.resolve(book);
    } catch (error) {
      fresh = error;
    }
    const freshRead = readFailure(fresh);
    expect(freshRead.code).toBe('NEO_SCOPE_PARENT_DESTROYED');
    expect(freshRead.message).toContain('T09ClosedParent');
  });

  it('T09-P10 init cleanup', async () => {
    const parentGraph = graphByName(graphs, 'T09CleanParent');
    const childGraph = graphByName(graphs, 'T09CleanChild');
    const boom = new Error('init-boom');
    const cleanupError = new Error('cleanup-boom') as Error & { code: string };
    cleanupError.code = 'E_CLEAN';
    Reflect.set(globalThis, '__t09Boom', boom);
    Reflect.set(globalThis, '__t09CleanupError', cleanupError);
    const parent = execute(parentGraph, { prelude: stash(CLEAN_CLASSES, ['ParentRes', 'LocalRes']) });
    const parentRes = ctor<new () => unknown>('ParentRes');
    const parentValue = parent.resolve(parentRes);
    const child = execute(childGraph, { prelude: stash(CLEAN_CLASSES, ['ParentRes', 'LocalRes']), parent });
    let first: unknown;
    try {
      await child.initialize();
    } catch (error) {
      first = error;
    }
    expect(count('__t09LocalDisposes')).toBe(1);
    expect(count('__t09ParentDisposes')).toBe(0);
    const failure = readFailure(first);
    expect(failure.cause).toBe(boom);
    expect(failure.cleanupErrors?.map((item) => (item instanceof Error ? item.message : ''))).toContain('cleanup-boom');
    expect(Reflect.get(child, '_state')).toBe('failed');
    let second: unknown;
    try {
      await child.initialize();
    } catch (error) {
      second = error;
    }
    expect(second).toBe(first);
    expect(parent.resolve(parentRes)).toBe(parentValue);
    expect(count('__t09ParentDisposes')).toBe(0);
  });

  it('T09-P11 after destroy', async () => {
    const graph = graphByName(graphs, 'T09Again');
    const first = execute(graph);
    const token = tokenId(graph, 'AgainPort');
    let second: RuntimeContainer | undefined;
    try {
      second = first.createScope();
    } catch {
      second = undefined;
    }
    expect(second).toBeDefined();
    if (!second) return;
    opened.push(second);
    const kept = second.resolve(token);
    await first.destroy();
    let caught: unknown;
    try {
      first.resolve(token);
    } catch (error) {
      caught = error;
    }
    expect(readFailure(caught).code).toBe('NEO_CONTAINER_DESTROYED');
    expect(readFailure(caught).message).toBe('NEO_CONTAINER_DESTROYED: [T09Again] container is destroyed');
    expect(second.resolve(token)).toBe(kept);
  });

  it('T09-P15 never built', async () => {
    const freshGraph = graphByName(graphs, 'T09Fresh');
    const asyncGraph = graphByName(graphs, 'T09FreshAsync');
    const fresh = execute(freshGraph, { prelude: FRESH_CLASSES });
    await fresh.destroy();
    expect(count('__t09Idle')).toBe(0);
    const asyncContainer = execute(asyncGraph, { prelude: FRESH_CLASSES });
    const pending = asyncContainer.destroy();
    expect(typeof pending.then).toBe('function');
    await pending;
    expect(count('__t09Idle')).toBe(0);
  });

  it('T09-P18 borrowed via as const', async () => {
    const named = loadNamed(`
      ${STUB}
      interface AsPort { n: number }
      interface IdentPort { n: number }
      interface BadPort { n: number }
      const BORROWED = 'borrowed' as const;
      function someNonLiteral() { return 'borrowed'; }
      export const asConstContainer = defineBuilderConfig({
        name: 'T09AsConst',
        injections: [{
          token: useInterface<AsPort>(),
          useFactory: true,
          dependencies: [],
          ownership: 'borrowed' as const,
          provider: () => (globalThis as { __t09AsConst: { n: number } }).__t09AsConst,
        }],
      });
      export const identContainer = defineBuilderConfig({
        name: 'T09Ident',
        injections: [{
          token: useInterface<IdentPort>(),
          useFactory: true,
          dependencies: [],
          ownership: BORROWED,
          provider: () => (globalThis as { __t09Ident: { n: number } }).__t09Ident,
        }],
      });
      export const badContainer = defineBuilderConfig({
        name: 'T09BadOwn',
        injections: [{
          token: useInterface<BadPort>(),
          useFactory: true,
          dependencies: [],
          ownership: someNonLiteral(),
          provider: () => ({ n: 0 }),
        }],
      });
    `);
    const bump = (key: '__t09AsConstDisposes' | '__t09IdentDisposes') => ({
      n: 1,
      dispose(): void {
        const holder = globalThis as {
          __t09AsConstDisposes?: number;
          __t09IdentDisposes?: number;
        };
        holder[key] = (holder[key] ?? 0) + 1;
      },
    });
    Reflect.set(globalThis, '__t09AsConst', bump('__t09AsConstDisposes'));
    Reflect.set(globalThis, '__t09Ident', bump('__t09IdentDisposes'));
    const asGraph = graphByName(named, 'T09AsConst');
    const identGraph = graphByName(named, 'T09Ident');
    const asContainer = execute(asGraph);
    const identContainer = execute(identGraph);
    asContainer.resolve(tokenId(asGraph, 'AsPort'));
    identContainer.resolve(tokenId(identGraph, 'IdentPort'));
    await asContainer.destroy();
    await identContainer.destroy();
    expect(count('__t09AsConstDisposes')).toBe(0);
    expect(count('__t09IdentDisposes')).toBe(0);
    const diagnostic = (named.get('T09BadOwn')?.errors ?? []).find((error) => error.code === 'NEO_CONFIG_UNSUPPORTED');
    expect(diagnostic?.code).toBe('NEO_CONFIG_UNSUPPORTED');
  });

  it('T09-P19 caught failed delegation', async () => {
    const named = loadNamed(`
      ${STUB}
      interface MissingPort { n: number }
      interface OwnedPort { n: number }
      const missingPort = useInterface<MissingPort>();
      export const parent = defineBuilderConfig({
        name: 'T09CatchParent',
        injections: [],
      });
      export const child = defineBuilderConfig({
        name: 'T09CatchChild',
        useContainer: parent,
        injections: [{
          token: useInterface<OwnedPort>(),
          useFactory: true,
          provider: (ctx) => {
            try { ctx.resolve(missingPort); } catch { /* parent has no such token */ }
            return {
              n: 1,
              dispose() {
                const holder = globalThis as { __t09CatchDisposes?: number };
                holder.__t09CatchDisposes = (holder.__t09CatchDisposes ?? 0) + 1;
              },
            };
          },
        }],
      });
    `, 'compatible');
    const parentGraph = graphByName(named, 'T09CatchParent');
    const childGraph = graphByName(named, 'T09CatchChild');
    const parent = execute(parentGraph);
    const child = execute(childGraph, {
      parent,
      bindings: { missingPort: 'MissingPort_absent' },
    });
    child.resolve(tokenId(childGraph, 'OwnedPort'));
    await child.destroy();
    expect(count('__t09CatchDisposes')).toBe(1);
  });

  it('T09-P20 delegated reference stays with the parent', async () => {
    const named = loadNamed(`
      ${STUB}
      interface ParentPort { n: number }
      interface ItemPort { n: number }
      interface HeldPort { n: number }
      interface AliasItem { n: number }
      const parentPort = useInterface<ParentPort>();
      const itemPort = useInterface<ItemPort>();
      export const parent = defineBuilderConfig({
        name: 'T09DelegateParent',
        injections: [
          {
            token: parentPort,
            useFactory: true,
            dependencies: [],
            provider: () => ({
              n: 1,
              dispose() {
                const holder = globalThis as { __t09HeldDisposes?: number };
                holder.__t09HeldDisposes = (holder.__t09HeldDisposes ?? 0) + 1;
              },
            }),
          },
          {
            token: itemPort,
            multi: true,
            useFactory: true,
            dependencies: [],
            provider: () => ({
              n: 2,
              dispose() {
                const holder = globalThis as { __t09ItemDisposes?: number };
                holder.__t09ItemDisposes = (holder.__t09ItemDisposes ?? 0) + 1;
              },
            }),
          },
        ],
      });
      export const child = defineBuilderConfig({
        name: 'T09DelegateChild',
        useContainer: parent,
        injections: [
          {
            token: useInterface<HeldPort>(),
            useFactory: true,
            dependencies: [parentPort],
            provider: (ctx) => ctx.resolve(parentPort),
          },
          {
            token: useInterface<AliasItem>(),
            multi: true,
            useFactory: true,
            dependencies: [{ all: itemPort }],
            provider: (ctx) => ctx.resolveAll(itemPort)[0],
          },
        ],
      });
    `);
    const parentGraph = graphByName(named, 'T09DelegateParent');
    const childGraph = graphByName(named, 'T09DelegateChild');
    const parentToken = tokenId(parentGraph, 'ParentPort');
    const itemToken = tokenId(parentGraph, 'ItemPort');
    const parent = execute(parentGraph);
    const child = execute(childGraph, {
      parent,
      bindings: { parentPort: parentToken, itemPort: itemToken },
    });
    const held = parent.resolve(parentToken);
    const listed = parent.resolveAll(itemToken);
    child.resolve(tokenId(childGraph, 'HeldPort'));
    child.resolveAll(tokenId(childGraph, 'AliasItem'));
    await child.destroy();
    expect(count('__t09HeldDisposes')).toBe(0);
    expect(count('__t09ItemDisposes')).toBe(0);
    expect(parent.resolve(parentToken)).toBe(held);
    expect(parent.resolveAll(itemToken)[0]).toBe(listed[0]);
  });

  it('T09-P21 override mock never disposed', async () => {
    const named = loadNamed(`
      ${STUB}
      interface LeftPort { n: number }
      interface RightPort { n: number }
      export const mocks = defineBuilderConfig({
        name: 'T09Mocks',
        injections: [
          {
            token: useInterface<LeftPort>(),
            useFactory: true,
            dependencies: [],
            provider: () => ({ n: 1, dispose() {} }),
          },
          {
            token: useInterface<RightPort>(),
            useFactory: true,
            dependencies: [],
            provider: () => ({ n: 2, dispose() {} }),
          },
        ],
      });
    `);
    const graph = graphByName(named, 'T09Mocks');
    const container = execute(graph);
    const left = tokenId(graph, 'LeftPort');
    const right = tokenId(graph, 'RightPort');
    const mockDispose = (): void => {
      const holder = globalThis as { __t09MockDisposes?: number };
      holder.__t09MockDisposes = (holder.__t09MockDisposes ?? 0) + 1;
    };
    await container.override(left, () => ({ n: 8, dispose: mockDispose }));
    await container.override(right, () => ({ n: 9, dispose: mockDispose }));
    container.resolve(left);
    container.resolve(right);
    await container.destroy();
    expect(count('__t09MockDisposes')).toBe(0);
  });

  it('T09-P22 async destroy final state', async () => {
    const named = loadNamed(`
      ${STUB}
      interface BoomPort { n: number }
      interface SlowPort { n: number }
      export const closing = defineBuilderConfig({
        name: 'T09Closing',
        injections: [
          {
            token: useInterface<BoomPort>(),
            useFactory: true,
            dependencies: [],
            provider: () => ({
              n: 1,
              dispose() {
                const holder = globalThis as { __t09BoomDisposes?: number };
                holder.__t09BoomDisposes = (holder.__t09BoomDisposes ?? 0) + 1;
                throw new Error('boom-dispose');
              },
            }),
          },
          {
            token: useInterface<SlowPort>(),
            useFactory: true,
            dependencies: [],
            provider: async () => ({ n: 2 }),
          },
        ],
      });
    `);
    const graph = graphByName(named, 'T09Closing');
    const container = execute(graph);
    await container.initialize();
    container.resolve(tokenId(graph, 'BoomPort'));
    let first: unknown;
    try {
      await container.destroy();
    } catch (error) {
      first = error;
    }
    expect(first).toBeInstanceOf(AggregateError);
    expect(Reflect.get(container, '_state')).toBe('destroyed');
    await container.destroy();
    expect(count('__t09BoomDisposes')).toBe(1);
  });

  it('T09-P23 sync initialize after destroy', async () => {
    const graph = graphByName(graphs, 'T09Again');
    const container = execute(graph);
    await container.destroy();
    let caught: unknown;
    try {
      await container.initialize();
    } catch (error) {
      caught = error;
    }
    expect(readFailure(caught).code).toBe('NEO_CONTAINER_DESTROYED');
  });

  it('T09-P24 value never disposed even if flagged', async () => {
    let disposes = 0;
    const resource = { n: 1, dispose(): void { disposes += 1; } };
    Reflect.set(globalThis, '__t09Flagged', resource);
    const container = execute(flaggedValueGraph());
    expect(container.resolve('FlaggedPort')).toBe(resource);
    await container.destroy();
    expect(disposes).toBe(0);
  });
});
