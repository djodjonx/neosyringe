import { afterEach, describe, expect, it, vi } from 'vitest';
import * as ts from 'typescript';
import { runInNewContext } from 'node:vm';
import { Generator } from '../../src/generator/Generator';
import { DependencyGraph, DependencyNode, FactoryDependency } from '../../src/analyzer/types';

vi.mock('@djodjonx/neosyringe-core/generator', () => import('../../src/generator/index'));
vi.mock('@djodjonx/neosyringe-core/analyzer', () => import('../../src/analyzer/index'));
vi.mock('@djodjonx/neosyringe-core/context', () => import('../../src/TSContext'));

/**
 * Executes Generator output the same way as Override.test.ts.
 * testOverrides is the 5th constructor argument. Debug data stays off so the
 * emitted script does not need a process global.
 */

interface RuntimeContainer {
  initialize: () => Promise<void>;
  createScope: () => RuntimeContainer;
  override: (token: unknown, factory: () => unknown) => Promise<void>;
  clearOverrides: () => Promise<void>;
  destroy: () => Promise<void>;
  resolve: (token: unknown) => unknown;
  resolveAll: (token: unknown) => unknown[];
  on: (event: 'resolve', listener: (token: unknown, instance: unknown) => void) => () => void;
  _state?: string;
  _failure?: unknown;
  _reconfiguring?: boolean;
  _borrowed?: Set<unknown>;
  instances?: Map<unknown, unknown>;
  overrides?: Map<unknown, unknown>;
  resolveListeners?: Set<unknown>;
}

interface Failure {
  code: string;
  message: string;
}

const opened: RuntimeContainer[] = [];

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

function factoryNode(
  tokenId: string,
  factorySource: string,
  options: {
    dependencies?: string[];
    deps?: FactoryDependency[];
    disposable?: boolean;
    asyncDisposable?: boolean;
    async?: boolean;
  } = {},
): DependencyNode {
  const dependencies = options.dependencies ?? options.deps?.map((dep) => dep.tokenId) ?? [];
  return {
    service: {
      tokenId,
      type: 'factory',
      factorySource,
      lifecycle: 'singleton',
      isInterfaceToken: true,
      isDisposable: options.disposable,
      isAsyncDisposable: options.asyncDisposable,
      isAsync: options.async,
      ownership: 'owned',
      factoryDependencies: options.deps,
      registrationNode: registrationNode(),
    },
    dependencies,
  };
}

function dep(tokenId: string): FactoryDependency {
  return { tokenId, all: false, source: JSON.stringify(tokenId), containerId: 'Test' };
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

function compile(graph: DependencyGraph, testOverrides: boolean, prelude = ''): string {
  const tsCode = `${prelude}\n${new Generator(graph, false, undefined, false, testOverrides).generate()}`;
  return ts.transpileModule(tsCode, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
}

function execute(
  graph: DependencyGraph,
  options: { testOverrides?: boolean; prelude?: string; parent?: unknown } = {},
): RuntimeContainer {
  const jsCode = compile(graph, options.testOverrides ?? true, options.prelude);
  const moduleRecord: { exports: { container?: RuntimeContainer } } = { exports: {} };
  const run = new Function('parent', 'module', 'exports', 'require', jsCode) as (
    parent: unknown,
    module: typeof moduleRecord,
    exports: typeof moduleRecord.exports,
    require: (id: string) => unknown,
  ) => void;
  run(options.parent, moduleRecord, moduleRecord.exports, () => ({}));
  const container = moduleRecord.exports.container;
  if (!container) throw new Error('generated module did not export container');
  opened.push(container);
  return container;
}

/** Realm with no `process` binding. Map/Set/Promise still exist, as in a browser. */
function executeWithoutProcess(graph: DependencyGraph, testOverrides: boolean): { container: RuntimeContainer; source: string } {
  const source = compile(graph, testOverrides);
  const exported: { container?: RuntimeContainer } = {};
  const sandbox = {
    exports: exported,
    module: { exports: exported },
    require: () => ({}),
    parent: undefined,
    Map,
    Set,
    Promise,
    Error,
    AggregateError,
    Object,
    Array,
    String,
    Function,
    Symbol,
  };
  runInNewContext(source, sandbox, { timeout: 1000 });
  const container = exported.container;
  if (!container) throw new Error('generated module did not export container');
  opened.push(container);
  return { container, source };
}

function readFailure(error: unknown): Failure {
  if (typeof error === 'object' && error !== null) {
    const code = 'code' in error ? String((error as { code: unknown }).code) : '';
    const message = error instanceof Error ? error.message : String(error);
    return { code, message };
  }
  return { code: '', message: String(error) };
}

function callFailure(run: () => unknown): Failure {
  try {
    run();
  } catch (error) {
    return readFailure(error);
  }
  return { code: '', message: '' };
}

function settledFailure(promise: Promise<unknown>): Promise<Failure> {
  return promise.then(
    () => ({ code: '', message: '' }),
    (error: unknown) => readFailure(error),
  );
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('T10 overrides runtime', () => {
  afterEach(async () => {
    vi.unstubAllGlobals();
    Reflect.deleteProperty(globalThis, '__t10Calls');
    Reflect.deleteProperty(globalThis, '__t10Gate');
    Reflect.deleteProperty(globalThis, '__t10Ran');
    Reflect.deleteProperty(globalThis, '__t10ParentDisposes');
    Reflect.deleteProperty(globalThis, '__t10Owned');
    Reflect.deleteProperty(globalThis, '__t10Mock');
    Reflect.deleteProperty(globalThis, '__t10Real');
    const pending = opened.splice(0);
    for (const container of pending) {
      try {
        await container.destroy();
      } catch {
        // A container already destroyed, or left failed, has nothing left to release.
      }
    }
  });

  it('T10-P1 clearOverrides drops the mock cache (class singleton and value)', async () => {
    const graph = graphOf([
      ['Logger_class', factoryNode('Logger_class', '() => new RealLogger()')],
      ['Logger_value', valueNode('Logger_value', '"value-real"')],
    ]);
    const container = execute(graph, { prelude: 'class RealLogger { constructor() { this.kind = "real"; } }' });
    const classMock = { kind: 'class-mock' };
    const valueMock = 'value-mock';
    await container.override('Logger_class', () => classMock);
    await container.override('Logger_value', () => valueMock);
    expect(container.resolve('Logger_class')).toBe(classMock);
    expect(container.resolve('Logger_value')).toBe(valueMock);

    await container.clearOverrides();
    const classNext = container.resolve('Logger_class') as { kind: string };
    const valueNext = container.resolve('Logger_value');
    expect(classNext).not.toBe(classMock);
    expect(classNext.kind).toBe('real');
    expect(valueNext).not.toBe(valueMock);
    expect(valueNext).toBe('value-real');
  });

  it('T10-P2 dependents rebuilt', async () => {
    const graph = graphOf([
      ['Dep_1', factoryNode('Dep_1', '() => ({ kind: "real" })')],
      ['Con_1', factoryNode('Con_1', '(ctx) => ({ dep: ctx.resolve("Dep_1") })', { deps: [dep('Dep_1')] })],
    ]);
    const container = execute(graph);
    const consumer1 = container.resolve('Con_1') as { dep: { kind: string } };
    expect(consumer1.dep.kind).toBe('real');
    const mock = { kind: 'mock' };
    await container.override('Dep_1', () => mock);
    const overridden = container.resolve('Con_1') as { dep: unknown };
    expect(overridden).not.toBe(consumer1);
    expect(overridden.dep).toBe(mock);

    await container.clearOverrides();
    const consumer2 = container.resolve('Con_1') as { dep: { kind: string } };
    expect(consumer2).not.toBe(consumer1);
    expect(consumer2).not.toBe(overridden);
    expect(consumer2.dep).not.toBe(mock);
    expect(consumer2.dep.kind).toBe('real');
  });

  it('T10-P3 owned disposed once, mock not', async () => {
    let owned = 0;
    let borrowed = 0;
    const graph = graphOf([
      ['Port_1', factoryNode('Port_1', '() => ({ n: 1, dispose() { globalThis.__t10Owned(); } })', { disposable: true })],
    ]);
    Reflect.set(globalThis, '__t10Owned', () => { owned += 1; });
    const container = execute(graph);
    container.resolve('Port_1');
    const mock = { n: 8, dispose() { borrowed += 1; } };
    await container.override('Port_1', () => mock);
    container.resolve('Port_1');
    await container.clearOverrides();
    await container.destroy();
    expect(owned).toBe(1);
    expect(borrowed).toBe(0);
    expect(container._borrowed?.has(mock)).toBe(false);
    Reflect.deleteProperty(globalThis, '__t10Owned');
  });

  it('T10-P4 one reconfigure wins', async () => {
    const gate = deferred();
    Reflect.set(globalThis, '__t10Gate', gate.promise);
    const graph = graphOf([
      ['Left_1', factoryNode('Left_1', '() => ({ kind: "real", dispose() { return globalThis.__t10Gate; } })', { asyncDisposable: true })],
      ['Right_1', factoryNode('Right_1', '() => ({ kind: "real" })')],
    ]);
    const container = execute(graph);
    container.resolve('Left_1');
    container.resolve('Right_1');
    const mock = { kind: 'mock' };
    const first = container.override('Left_1', () => mock);
    const second = container.override('Right_1', () => ({ kind: 'stolen' }));
    const duringResolve = callFailure(() => container.resolve('Right_1'));
    const duringScope = callFailure(() => container.createScope());
    let secondError: unknown;
    try {
      await second;
      secondError = undefined;
    } catch (error) {
      secondError = error;
    } finally {
      gate.resolve();
    }
    await first;
    const failure = readFailure(secondError);
    expect(failure.code).toBe('NEO_CONTAINER_BUSY');
    expect(failure.message).toBe('NEO_CONTAINER_BUSY: [NeoContainer] container is transitioning');
    expect(duringResolve.code).toBe('NEO_CONTAINER_BUSY');
    expect(duringScope.code).toBe('NEO_CONTAINER_BUSY');
    expect(container.resolve('Left_1')).toBe(mock);
    expect((container.resolve('Right_1') as { kind: string }).kind).toBe('real');
  });

  it('T10-P5 async reconfigure needs initialize', async () => {
    const gate = deferred();
    Reflect.set(globalThis, '__t10Gate', gate.promise);
    Reflect.set(globalThis, '__t10Calls', 0);
    const graph = graphOf([
      ['Async_1', factoryNode(
        'Async_1',
        'async () => { globalThis.__t10Calls += 1; return { id: "real", dispose() { return globalThis.__t10Gate; } }; }',
        { async: true, asyncDisposable: true },
      )],
    ]);
    const container = execute(graph);
    await container.initialize();
    expect(container.resolve('Async_1')).toMatchObject({ id: 'real' });
    const mock = { id: 'mock' };
    const pending = container.override('Async_1', () => mock);
    const during = callFailure(() => container.resolve('Async_1'));
    const duringScope = callFailure(() => container.createScope());
    gate.resolve();
    await pending;
    const after = callFailure(() => container.resolve('Async_1'));
    await container.initialize();
    expect(during.code).toBe('NEO_CONTAINER_BUSY');
    expect(during.message).toBe('NEO_CONTAINER_BUSY: [NeoContainer] container is transitioning');
    expect(duringScope.code).toBe('NEO_CONTAINER_BUSY');
    expect(after.code).toBe('NEO_NOT_INITIALIZED');
    expect(after.message).toBe('NEO_NOT_INITIALIZED: [NeoContainer] call await container.initialize() before resolve()');
    expect(container.resolve('Async_1')).toBe(mock);
    expect(Reflect.get(globalThis, '__t10Calls')).toBe(1);
  });

  it('T10-P6 resolve events', async () => {
    const parentGraph = graphOf([
      ['Parent_1', valueNode('Parent_1', '"from-parent"')],
    ]);
    const parent = execute(parentGraph);
    const childGraph = graphOf(
      [
        ['Local_1', valueNode('Local_1', '"local"')],
        ['Dep_1', factoryNode('Dep_1', '() => ({ kind: "dep" })')],
        ['Con_1', factoryNode('Con_1', '(ctx) => ({ dep: ctx.resolve("Dep_1") })', { deps: [dep('Dep_1')] })],
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
    const container = execute(childGraph, { parent });
    const noted: Array<[unknown, unknown]> = [];
    container.on('resolve', (token, instance) => noted.push([token, instance]));
    const items = container.resolveAll('Item_1');
    expect(noted).toEqual([['Item_1', items[0]], ['Item_1', items[1]]]);

    const beforeEmpty = noted.length;
    expect(container.resolveAll('missing')).toEqual([]);
    expect(noted).toHaveLength(beforeEmpty);

    const parentNoted: Array<[unknown, unknown]> = [];
    const childNoted: Array<[unknown, unknown]> = [];
    parent.on('resolve', (token, instance) => parentNoted.push([token, instance]));
    const stopChild = container.on('resolve', (token, instance) => childNoted.push([token, instance]));
    const delegated = container.resolve('Parent_1');
    expect(parentNoted).toEqual([['Parent_1', delegated]]);
    expect(childNoted).toEqual([['Parent_1', delegated]]);
    expect(delegated).toBe('from-parent');

    noted.length = 0;
    const first = container.resolve('Local_1');
    const second = container.resolve('Local_1');
    expect(first).toBe(second);
    expect(noted).toEqual([['Local_1', first], ['Local_1', second]]);

    noted.length = 0;
    const consumer = container.resolve('Con_1') as { dep: { kind: string } };
    const depEvents = noted.filter((entry) => entry[0] === 'Dep_1');
    const conEvents = noted.filter((entry) => entry[0] === 'Con_1');
    expect(depEvents.length).toBeGreaterThan(0);
    expect(depEvents[0]?.[1]).toBe(consumer.dep);
    expect(conEvents).toEqual([['Con_1', consumer]]);
    expect(consumer.dep.kind).toBe('dep');

    const heard: string[] = [];
    container.on('resolve', () => { throw new Error('listener-boom'); });
    container.on('resolve', () => heard.push('second'));
    expect(container.resolve('Local_1')).toBe(first);
    expect(heard).toEqual(['second']);

    stopChild();
    const afterStop = childNoted.length;
    container.resolve('Parent_1');
    expect(childNoted).toHaveLength(afterStop);

    const quiet: number[] = [];
    container.on('resolve', () => quiet.push(1));
    await container.destroy();
    expect(container.resolveListeners?.size).toBe(0);
    expect(callFailure(() => container.resolve('Local_1')).code).toBe('NEO_CONTAINER_DESTROYED');
    expect(quiet).toEqual([]);
  });

  it('T10-P7 disabled without process / unplugin production', async () => {
    const graph = graphOf([['Logger_value', valueNode('Logger_value', '"value-real"')]]);
    const disabled = executeWithoutProcess(graph, false);
    const overrideFailure = readFailure(await disabled.container.override('Logger_value', () => 'mock').then(() => undefined, (error: unknown) => error));
    const clearFailure = readFailure(await disabled.container.clearOverrides().then(() => undefined, (error: unknown) => error));
    expect(overrideFailure.code).toBe('NEO_TEST_API_DISABLED');
    expect(overrideFailure.message).toBe('NEO_TEST_API_DISABLED: [NeoContainer] test overrides are disabled');
    expect(clearFailure.code).toBe('NEO_TEST_API_DISABLED');
    expect(clearFailure.message).toBe('NEO_TEST_API_DISABLED: [NeoContainer] test overrides are disabled');
    expect(disabled.container.resolve('Logger_value')).toBe('value-real');
    expect(disabled.source.includes('process')).toBe(false);

    const enabled = executeWithoutProcess(graph, true);
    await enabled.container.override('Logger_value', () => 'mock-real');
    expect(enabled.container.resolve('Logger_value')).toBe('mock-real');
    expect(enabled.source.includes('process')).toBe(false);

    const originalNodeEnv = process.env.NODE_ENV;
    try {
      const flags = await import('../../src/generator/DebugConfig');
      expect(flags.resolveTestOverridesFlag(undefined)).toBe(false);
      expect(flags.resolveTestOverridesFlag(false)).toBe(false);
      process.env.NODE_ENV = 'test';
      expect(flags.resolveTestOverridesFlag(true)).toBe(true);
      process.env.NODE_ENV = 'production';
      expect(() => flags.resolveTestOverridesFlag(true)).toThrow(/NEO_TEST_API_DISABLED: testOverrides cannot be enabled when NODE_ENV is production/);
      expect(flags.resolveTestOverridesFlag(false)).toBe(false);
    } finally {
      if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = originalNodeEnv;
    }
  });

  it('T10-P8 isolation and destroyed', async () => {
    Reflect.set(globalThis, '__t10ParentDisposes', 0);
    const parentGraph = graphOf([
      ['Shared_1', factoryNode(
        'Shared_1',
        '() => ({ n: 1, dispose() { globalThis.__t10ParentDisposes += 1; } })',
        { disposable: true },
      )],
    ]);
    const parent = execute(parentGraph);
    const parentInstance = parent.resolve('Shared_1');
    const child = execute(graphOf(
      [['Local_1', valueNode('Local_1', '"child-real"')]],
      { legacyContainers: ['parent'] },
    ), { parent });
    child.resolve('Shared_1');
    const mock = { n: 99 };
    await child.override('Shared_1', () => mock);
    expect(child.resolve('Shared_1')).toBe(mock);
    expect(parent.resolve('Shared_1')).toBe(parentInstance);
    expect(Reflect.get(globalThis, '__t10ParentDisposes')).toBe(0);
    await child.clearOverrides();
    expect(parent.resolve('Shared_1')).toBe(parentInstance);
    expect(Reflect.get(globalThis, '__t10ParentDisposes')).toBe(0);

    const first = execute(graphOf([['Logger_value', valueNode('Logger_value', '"real"')]]));
    const second = execute(graphOf([['Logger_value', valueNode('Logger_value', '"real"')]]));
    const secondReal = second.resolve('Logger_value');
    await first.override('Logger_value', () => 'mock');
    expect(first.resolve('Logger_value')).toBe('mock');
    expect(second.resolve('Logger_value')).toBe(secondReal);

    const scoped = execute(graphOf([['Logger_value', valueNode('Logger_value', '"real"')]]));
    const scopeMock = { n: 1 };
    await scoped.override('Logger_value', () => scopeMock);
    const scope = scoped.createScope();
    opened.push(scope);
    expect(scope.resolve('Logger_value')).not.toBe(scopeMock);
    expect(scope.resolve('Logger_value')).toBe('real');
    expect(scoped.resolve('Logger_value')).toBe(scopeMock);

    await scoped.destroy();
    const destroyed = readFailure(await scoped.override('Logger_value', () => 'later').then(() => undefined, (error: unknown) => error));
    expect(destroyed.code).toBe('NEO_CONTAINER_DESTROYED');
    expect(destroyed.message).toBe('NEO_CONTAINER_DESTROYED: [NeoContainer] container is destroyed');
  });

  it('T10-P9 multi', async () => {
    const graph = graphOf([], {
      multiNodes: new Map([
        ['Item_1', [
          factoryNode('Item_1', '() => ({ n: 1 })'),
          factoryNode('Item_1', '() => ({ n: 2 })'),
        ]],
      ]),
    });
    const container = execute(graph);
    const first = container.resolveAll('Item_1');
    const failure = readFailure(await container.override('Item_1', () => ({ n: 9 })).then(() => undefined, (error: unknown) => error));
    const afterReject = container.resolveAll('Item_1');
    expect(failure.code).toBe('NEO_OVERRIDE_MULTI_UNSUPPORTED');
    expect(failure.message).toBe('NEO_OVERRIDE_MULTI_UNSUPPORTED: [NeoContainer] cannot override a multi token');
    expect(afterReject[0]).toBe(first[0]);
    expect(afterReject[1]).toBe(first[1]);

    await container.clearOverrides();
    const next = container.resolveAll('Item_1');
    expect(next[0]).not.toBe(first[0]);
    expect(next[1]).not.toBe(first[1]);
    expect(next.map((item) => (item as { n: number }).n)).toEqual([1, 2]);
  });

  it('T10-P10 cleanup failure', async () => {
    const gate = deferred();
    Reflect.set(globalThis, '__t10Gate', gate.promise);
    Reflect.set(globalThis, '__t10Ran', [] as string[]);
    const graph = graphOf([
      ['Boom_1', factoryNode(
        'Boom_1',
        'async () => ({ dispose() { globalThis.__t10Ran.push("a"); return globalThis.__t10Gate.then(() => { throw new Error("cleanup-a"); }); } })',
        { async: true, asyncDisposable: true },
      )],
      ['Boom_2', factoryNode(
        'Boom_2',
        'async () => ({ dispose() { globalThis.__t10Ran.push("b"); return globalThis.__t10Gate.then(() => { throw new Error("cleanup-b"); }); } })',
        { async: true, asyncDisposable: true },
      )],
    ]);
    const container = execute(graph);
    await container.initialize();
    const real = container.resolve('Boom_1');
    const pending = container.override('Boom_1', () => ({ id: 'mock' }));
    expect(container.instances?.get('Boom_1')).toBe(real);
    expect(container.overrides?.has('Boom_1')).toBe(false);
    gate.resolve();
    let failure: unknown;
    try {
      await pending;
      failure = undefined;
    } catch (error) {
      failure = error;
    }
    const ran = Reflect.get(globalThis, '__t10Ran') as string[];
    expect(ran.slice().sort()).toEqual(['a', 'b']);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toHaveLength(2);
    expect(container._state).toBe('failed');
    expect(container.overrides?.has('Boom_1')).toBe(false);
    expect(callFailure(() => container.resolve('Boom_1')).code).toBe('NEO_CONTAINER_FAILED');
    expect(callFailure(() => container.resolve('Boom_1')).message).toBe('NEO_CONTAINER_FAILED: [NeoContainer] container initialization failed');

    const syncGate = deferred();
    Reflect.set(globalThis, '__t10Gate', syncGate.promise);
    Reflect.set(globalThis, '__t10Ran', [] as string[]);
    const syncDispose = (label: string) =>
      `() => ({ dispose() { globalThis.__t10Ran.push(${JSON.stringify(label)}); return globalThis.__t10Gate.then(() => { throw new Error(${JSON.stringify('cleanup-' + label)}); }); } })`;
    const sync = execute(graphOf([
      ['Boom_1', factoryNode('Boom_1', syncDispose('a'), { asyncDisposable: true })],
      ['Boom_2', factoryNode('Boom_2', syncDispose('b'), { asyncDisposable: true })],
    ]));
    const syncReal = sync.resolve('Boom_1');
    sync.resolve('Boom_2');
    const syncPending = sync.override('Boom_1', () => ({ id: 'mock' }));
    expect(sync.instances?.get('Boom_1')).toBe(syncReal);
    expect(sync.overrides?.has('Boom_1')).toBe(false);
    syncGate.resolve();
    let syncFailure: unknown;
    try {
      await syncPending;
      syncFailure = undefined;
    } catch (error) {
      syncFailure = error;
    }
    const syncRan = Reflect.get(globalThis, '__t10Ran') as string[];
    expect(syncRan.slice().sort()).toEqual(['a', 'b']);
    expect(syncFailure).toBeInstanceOf(AggregateError);
    expect(sync._failure).toBeInstanceOf(AggregateError);
    expect(sync.overrides?.has('Boom_1')).toBe(false);
    expect(callFailure(() => sync.resolve('Boom_1')).code).toBe('NEO_CONTAINER_FAILED');
    expect(callFailure(() => sync.resolve('Boom_1')).message).toBe('NEO_CONTAINER_FAILED: [NeoContainer] container initialization failed');
  });

  it('T10-P12 initialize during reconfigure rejects busy', async () => {
    const gate = deferred();
    Reflect.set(globalThis, '__t10Gate', gate.promise);
    const graph = graphOf([
      ['Async_1', factoryNode(
        'Async_1',
        'async () => ({ id: "real", dispose() { return globalThis.__t10Gate; } })',
        { async: true, asyncDisposable: true },
      )],
    ]);
    const container = execute(graph);
    await container.initialize();
    container.resolve('Async_1');
    const mock = { id: 'mock' };
    const pending = container.override('Async_1', () => mock);
    try {
      const during = readFailure(await container.initialize().then(() => undefined, (error: unknown) => error));
      expect(during.code).toBe('NEO_CONTAINER_BUSY');
      expect(during.message).toBe('NEO_CONTAINER_BUSY: [NeoContainer] container is transitioning');
      expect(container._state).toBe('reconfiguring');
    } finally {
      gate.resolve();
    }
    await pending;
    const after = callFailure(() => container.resolve('Async_1'));
    expect(after.code).toBe('NEO_NOT_INITIALIZED');
    expect(after.message).toBe('NEO_NOT_INITIALIZED: [NeoContainer] call await container.initialize() before resolve()');
    await container.initialize();
    expect(container.resolve('Async_1')).toBe(mock);
  });

  it('T10-P13 destroy during reconfigure rejects busy', async () => {
    const gate = deferred();
    Reflect.set(globalThis, '__t10Gate', gate.promise);
    Reflect.set(globalThis, '__t10Owned', 0);
    Reflect.set(globalThis, '__t10Mock', 0);
    const asyncContainer = execute(graphOf([
      ['Async_1', factoryNode(
        'Async_1',
        'async () => ({ id: "real", dispose() { globalThis.__t10Owned += 1; return globalThis.__t10Gate; } })',
        { async: true, asyncDisposable: true },
      )],
    ]));
    await asyncContainer.initialize();
    asyncContainer.resolve('Async_1');
    const asyncMock = {
      id: 'mock',
      dispose() { Reflect.set(globalThis, '__t10Mock', Number(Reflect.get(globalThis, '__t10Mock')) + 1); },
    };
    const asyncPending = asyncContainer.override('Async_1', () => asyncMock);
    const asyncDestroy = asyncContainer.destroy();
    expect(asyncDestroy).toBeInstanceOf(Promise);
    gate.resolve();
    const asyncDestroyFailure = await settledFailure(asyncDestroy);
    await asyncPending;
    expect(asyncDestroyFailure.code).toBe('NEO_CONTAINER_BUSY');
    expect(asyncDestroyFailure.message).toBe('NEO_CONTAINER_BUSY: [NeoContainer] container is transitioning');
    expect(asyncContainer._state).toBe('created');
    const asyncNotReady = callFailure(() => asyncContainer.resolve('Async_1'));
    expect(asyncNotReady.code).toBe('NEO_NOT_INITIALIZED');
    await asyncContainer.initialize();
    expect(asyncContainer.resolve('Async_1')).toBe(asyncMock);
    expect(Reflect.get(globalThis, '__t10Owned')).toBe(1);
    await asyncContainer.destroy();
    expect(Reflect.get(globalThis, '__t10Owned')).toBe(1);
    expect(Reflect.get(globalThis, '__t10Mock')).toBe(0);
    const asyncDestroyed = callFailure(() => asyncContainer.resolve('Async_1'));
    expect(asyncDestroyed.code).toBe('NEO_CONTAINER_DESTROYED');
    expect(asyncDestroyed.message).toBe('NEO_CONTAINER_DESTROYED: [NeoContainer] container is destroyed');

    const syncGate = deferred();
    Reflect.set(globalThis, '__t10Gate', syncGate.promise);
    Reflect.set(globalThis, '__t10Owned', 0);
    Reflect.set(globalThis, '__t10Mock', 0);
    const syncContainer = execute(graphOf([
      ['Sync_1', factoryNode(
        'Sync_1',
        '() => ({ id: "real", dispose() { globalThis.__t10Owned += 1; return globalThis.__t10Gate; } })',
        { asyncDisposable: true },
      )],
    ]));
    syncContainer.resolve('Sync_1');
    const syncMock = {
      id: 'mock',
      dispose() { Reflect.set(globalThis, '__t10Mock', Number(Reflect.get(globalThis, '__t10Mock')) + 1); },
    };
    const syncPending = syncContainer.override('Sync_1', () => syncMock);
    const syncDestroy = syncContainer.destroy();
    expect(syncDestroy).toBeInstanceOf(Promise);
    syncGate.resolve();
    const syncDestroyFailure = await settledFailure(syncDestroy);
    await syncPending;
    expect(syncDestroyFailure.code).toBe('NEO_CONTAINER_BUSY');
    expect(syncDestroyFailure.message).toBe('NEO_CONTAINER_BUSY: [NeoContainer] container is transitioning');
    expect(syncContainer.resolve('Sync_1')).toBe(syncMock);
    expect(Reflect.get(globalThis, '__t10Owned')).toBe(1);
    await syncContainer.destroy();
    expect(Reflect.get(globalThis, '__t10Owned')).toBe(1);
    expect(Reflect.get(globalThis, '__t10Mock')).toBe(0);
    const syncDestroyed = callFailure(() => syncContainer.resolve('Sync_1'));
    expect(syncDestroyed.code).toBe('NEO_CONTAINER_DESTROYED');
    expect(syncDestroyed.message).toBe('NEO_CONTAINER_DESTROYED: [NeoContainer] container is destroyed');
  });

  it('T10-P15 sync initialize during reconfigure rejects busy', async () => {
    const gate = deferred();
    Reflect.set(globalThis, '__t10Gate', gate.promise);
    const sync = execute(graphOf([
      ['Sync_1', factoryNode(
        'Sync_1',
        '() => ({ id: "real", dispose() { return globalThis.__t10Gate; } })',
        { asyncDisposable: true },
      )],
    ]));
    const real = sync.resolve('Sync_1');
    const mock = { id: 'mock' };
    const pending = sync.override('Sync_1', () => mock);
    try {
      const initialize = sync.initialize();
      expect(initialize).toBeInstanceOf(Promise);
      const during = await settledFailure(initialize);
      expect(during.code).toBe('NEO_CONTAINER_BUSY');
      expect(during.message).toBe('NEO_CONTAINER_BUSY: [NeoContainer] container is transitioning');
      expect(sync._reconfiguring).toBe(true);
      expect(sync.instances?.get('Sync_1')).toBe(real);
      expect(sync.overrides?.has('Sync_1')).toBe(false);
    } finally {
      gate.resolve();
    }
    await pending;
    expect(sync.resolve('Sync_1')).toBe(mock);
  });

  it('T10-P16 sync initialize after failure rejects the kept cause', async () => {
    const sync = execute(graphOf([
      ['Boom_1', factoryNode(
        'Boom_1',
        '() => ({ id: "real", dispose() { throw new Error("cleanup-a"); } })',
        { asyncDisposable: true },
      )],
    ]));
    const real = sync.resolve('Boom_1');
    let cause: unknown;
    try {
      await sync.override('Boom_1', () => ({ id: 'mock' }));
      cause = undefined;
    } catch (error) {
      cause = error;
    }
    const initialize = sync.initialize();
    expect(initialize).toBeInstanceOf(Promise);
    const initResult = await initialize.then(() => undefined, (error: unknown) => error);
    expect(cause).toBeInstanceOf(AggregateError);
    expect(initResult).toBe(cause);
    expect(initResult).toBe(sync._failure);
    expect(sync.overrides?.has('Boom_1')).toBe(false);
    expect(real).toMatchObject({ id: 'real' });
    expect(callFailure(() => sync.resolve('Boom_1')).code).toBe('NEO_CONTAINER_FAILED');
  });

  it('T10-P17 override during initializing rejects busy', async () => {
    const gate = deferred();
    Reflect.set(globalThis, '__t10Gate', gate.promise);
    const real = { id: 'real' };
    Reflect.set(globalThis, '__t10Real', real);
    const container = execute(graphOf([
      ['Async_1', factoryNode(
        'Async_1',
        'async () => { await globalThis.__t10Gate; return globalThis.__t10Real; }',
        { async: true },
      )],
    ]));
    const pendingInit = container.initialize();
    try {
      const mock = { id: 'mock' };
      const overrideFailure = await settledFailure(container.override('Async_1', () => mock));
      const clearFailure = await settledFailure(container.clearOverrides());
      expect(overrideFailure.code).toBe('NEO_CONTAINER_BUSY');
      expect(overrideFailure.message).toBe('NEO_CONTAINER_BUSY: [NeoContainer] container is transitioning');
      expect(clearFailure.code).toBe('NEO_CONTAINER_BUSY');
      expect(clearFailure.message).toBe('NEO_CONTAINER_BUSY: [NeoContainer] container is transitioning');
      expect(container._state).toBe('initializing');
      expect(container.overrides?.has('Async_1')).toBe(false);
      gate.resolve();
      await pendingInit;
      expect(container.resolve('Async_1')).toBe(real);
    } finally {
      gate.resolve();
      await pendingInit.then(() => undefined, () => undefined);
    }
  });

  it('T10-P18 override during destroying rejects busy', async () => {
    const gate = deferred();
    Reflect.set(globalThis, '__t10Gate', gate.promise);
    const container = execute(graphOf([
      ['Async_1', factoryNode(
        'Async_1',
        'async () => ({ id: "real", dispose() { return globalThis.__t10Gate; } })',
        { async: true, asyncDisposable: true },
      )],
    ]));
    await container.initialize();
    const real = container.resolve('Async_1');
    const pendingDestroy = container.destroy();
    try {
      const mock = { id: 'mock' };
      const overrideFailure = await settledFailure(container.override('Async_1', () => mock));
      const clearFailure = await settledFailure(container.clearOverrides());
      expect(overrideFailure.code).toBe('NEO_CONTAINER_BUSY');
      expect(overrideFailure.message).toBe('NEO_CONTAINER_BUSY: [NeoContainer] container is transitioning');
      expect(clearFailure.code).toBe('NEO_CONTAINER_BUSY');
      expect(clearFailure.message).toBe('NEO_CONTAINER_BUSY: [NeoContainer] container is transitioning');
      expect(container._state).toBe('destroying');
      expect(container.overrides?.has('Async_1')).toBe(false);
      expect(container.instances?.get('Async_1')).toBe(real);
      expect(callFailure(() => container.resolve('Async_1')).code).toBe('NEO_CONTAINER_DESTROYED');
    } finally {
      gate.resolve();
      await pendingDestroy.then(() => undefined, () => undefined);
    }
  });

  it('T10-P19 sync override during destroy rejects busy', async () => {
    const gate = deferred();
    Reflect.set(globalThis, '__t10Gate', gate.promise);
    const sync = execute(graphOf([
      ['Sync_1', factoryNode(
        'Sync_1',
        '() => ({ id: "real", dispose() { return globalThis.__t10Gate; } })',
        { asyncDisposable: true },
      )],
    ]));
    const real = sync.resolve('Sync_1');
    const pendingDestroy = sync.destroy();
    try {
      const mock = { id: 'mock' };
      const overrideFailure = await settledFailure(sync.override('Sync_1', () => mock));
      const clearFailure = await settledFailure(sync.clearOverrides());
      expect(overrideFailure.code).toBe('NEO_CONTAINER_BUSY');
      expect(overrideFailure.message).toBe('NEO_CONTAINER_BUSY: [NeoContainer] container is transitioning');
      expect(clearFailure.code).toBe('NEO_CONTAINER_BUSY');
      expect(clearFailure.message).toBe('NEO_CONTAINER_BUSY: [NeoContainer] container is transitioning');
      expect(sync.overrides?.has('Sync_1')).toBe(false);
      expect(sync.instances?.get('Sync_1')).toBe(real);
      expect(callFailure(() => sync.resolve('Sync_1')).code).toBe('NEO_CONTAINER_DESTROYED');
    } finally {
      gate.resolve();
      await pendingDestroy.then(() => undefined, () => undefined);
    }
  });

  it('T10-P20 async override after failure rejects failed', async () => {
    const container = execute(graphOf([
      ['Boom_1', factoryNode(
        'Boom_1',
        'async () => ({ id: "real", dispose() { throw new Error("cleanup"); } })',
        { async: true, asyncDisposable: true },
      )],
    ]));
    await container.initialize();
    const real = container.resolve('Boom_1');
    await container.override('Boom_1', () => ({ id: 'first' })).then(() => undefined, () => undefined);
    expect(container._state).toBe('failed');
    const mock = { id: 'next' };
    const overrideFailure = await settledFailure(container.override('Boom_1', () => mock));
    const clearFailure = await settledFailure(container.clearOverrides());
    expect(overrideFailure.code).toBe('NEO_CONTAINER_FAILED');
    expect(overrideFailure.message).toBe('NEO_CONTAINER_FAILED: [NeoContainer] container initialization failed');
    expect(clearFailure.code).toBe('NEO_CONTAINER_FAILED');
    expect(clearFailure.message).toBe('NEO_CONTAINER_FAILED: [NeoContainer] container initialization failed');
    expect(container.overrides?.has('Boom_1')).toBe(false);
    expect(container._state).toBe('failed');
    const refused = callFailure(() => container.resolve('Boom_1'));
    expect(refused.code).toBe('NEO_CONTAINER_FAILED');
    expect(refused.message).toBe('NEO_CONTAINER_FAILED: [NeoContainer] container initialization failed');
    expect(real).toMatchObject({ id: 'real' });
  });

  it('T10-P21 sync override after failure rejects failed', async () => {
    const sync = execute(graphOf([
      ['Boom_1', factoryNode(
        'Boom_1',
        '() => ({ id: "real", dispose() { throw new Error("cleanup"); } })',
        { asyncDisposable: true },
      )],
    ]));
    const real = sync.resolve('Boom_1');
    await sync.override('Boom_1', () => ({ id: 'first' })).then(() => undefined, () => undefined);
    expect(sync._failure).toBeInstanceOf(AggregateError);
    const mock = { id: 'next' };
    const overrideFailure = await settledFailure(sync.override('Boom_1', () => mock));
    const clearFailure = await settledFailure(sync.clearOverrides());
    expect(overrideFailure.code).toBe('NEO_CONTAINER_FAILED');
    expect(overrideFailure.message).toBe('NEO_CONTAINER_FAILED: [NeoContainer] container initialization failed');
    expect(clearFailure.code).toBe('NEO_CONTAINER_FAILED');
    expect(clearFailure.message).toBe('NEO_CONTAINER_FAILED: [NeoContainer] container initialization failed');
    expect(sync.overrides?.has('Boom_1')).toBe(false);
    const refused = callFailure(() => sync.resolve('Boom_1'));
    expect(refused.code).toBe('NEO_CONTAINER_FAILED');
    expect(refused.message).toBe('NEO_CONTAINER_FAILED: [NeoContainer] container initialization failed');
    expect(real).toMatchObject({ id: 'real' });
  });

  it('T10-P22 sync createScope after failure rejects failed', async () => {
    const sync = execute(graphOf([
      ['Boom_1', factoryNode(
        'Boom_1',
        '() => ({ id: "real", dispose() { throw new Error("cleanup"); } })',
        { asyncDisposable: true },
      )],
    ]));
    const real = sync.resolve('Boom_1');
    await sync.override('Boom_1', () => ({ id: 'mock' })).then(() => undefined, () => undefined);
    expect(sync._failure).toBeInstanceOf(AggregateError);
    let scope: RuntimeContainer | undefined;
    let failure: Failure = { code: '', message: '' };
    try {
      scope = sync.createScope();
      opened.push(scope);
    } catch (error) {
      failure = readFailure(error);
    }
    expect(failure.code).toBe('NEO_CONTAINER_FAILED');
    expect(failure.message).toBe('NEO_CONTAINER_FAILED: [NeoContainer] container initialization failed');
    expect(sync.overrides?.has('Boom_1')).toBe(false);
    const refused = callFailure(() => sync.resolve('Boom_1'));
    expect(refused.code).toBe('NEO_CONTAINER_FAILED');
    expect(refused.message).toBe('NEO_CONTAINER_FAILED: [NeoContainer] container initialization failed');
    expect(real).toMatchObject({ id: 'real' });
    expect(scope).toBeUndefined();
  });
});
