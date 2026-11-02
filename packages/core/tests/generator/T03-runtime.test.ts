import { afterEach, describe, expect, it } from 'vitest';
import ts from 'typescript';
import { Generator } from '../../src/generator/Generator';
import { DependencyGraph, ServiceDefinition } from '../../src/analyzer/types';

// Executes the code returned by Generator.generate(), same path as
// packages/core/tests/generator/Override.test.ts:35-43.
// Asserts values and call order, not substrings of the emitted source.

const TOKEN = 'ILogger_abc123';

interface SyncContainer {
  initialize: () => Promise<void>;
  createScope: () => SyncContainer;
  override: (token: string, factory: () => unknown) => Promise<void>;
  clearOverrides: () => Promise<void>;
  destroy: () => Promise<void>;
  resolve: (token: string) => unknown;
}

interface CommonJsModule {
  exports: { container?: SyncContainer };
}

function registrationNode(): ts.Node {
  return { getSourceFile: () => ({ fileName: '' }) } as unknown as ts.Node;
}

function valueService(tokenId: string, valueSource: string, isDisposable = false): ServiceDefinition {
  return {
    tokenId,
    type: 'value',
    valueSource,
    lifecycle: 'singleton',
    isInterfaceToken: true,
    isDisposable,
    registrationNode: registrationNode(),
  };
}

function load(graph: DependencyGraph, testOverrides = false): SyncContainer {
  const tsCode = new Generator(graph, false, undefined, true, testOverrides).generate();
  const jsCode = ts.transpileModule(tsCode, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const moduleRecord: CommonJsModule = { exports: {} };
  const run = new Function('module', 'exports', 'require', jsCode) as (
    module: CommonJsModule,
    exports: CommonJsModule['exports'],
    require: (id: string) => unknown,
  ) => void;
  run(moduleRecord, moduleRecord.exports, () => ({}));
  const container = moduleRecord.exports.container;
  if (container === undefined) {
    throw new Error('generated module did not export container');
  }
  return container;
}

function singleValue(valueSource: string): DependencyGraph {
  return {
    containerId: 'Test',
    nodes: new Map([[TOKEN, { service: valueService(TOKEN, valueSource), dependencies: [] }]]),
    roots: [TOKEN],
    exportedVariableName: 'container',
    variableExportModifier: 'export',
  };
}

function thenOf(value: unknown): unknown {
  if (typeof value === 'object' && value !== null && 'then' in value) {
    return value.then;
  }
  return undefined;
}

describe('T03 runtime', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
    Reflect.deleteProperty(globalThis, '__t03DisposeLog');
  });

  it('T03 sync container initialize resolves and keeps the singleton', async () => {
    const container = load(singleValue('({ id: 1 })'));
    const pending = typeof container.initialize === 'function' ? container.initialize() : undefined;
    expect(typeof thenOf(pending)).toBe('function');
    expect(await pending).toBe(undefined);
    const first = container.resolve(TOKEN);
    const second = container.resolve(TOKEN);
    expect(first).toBe(second);
  });

  it('T03 createScope returns a distinct container', async () => {
    const container = load(singleValue('({ id: 1 })'));
    const scope = container.createScope();
    expect(scope).not.toBe(container);
    expect(scope.resolve(TOKEN)).toEqual({ id: 1 });
    expect(container.resolve(TOKEN)).toEqual({ id: 1 });
    await scope.destroy();
    await container.destroy();
  });

  it('T03 override clearOverrides destroy return thenables', async () => {
    const container = load(singleValue('({ id: "real" })'), true);

    const overridden = container.override(TOKEN, () => ({ id: 'mock' }));
    expect(typeof thenOf(overridden)).toBe('function');
    await overridden;
    expect(container.resolve(TOKEN)).toEqual({ id: 'mock' });

    const cleared = container.clearOverrides();
    expect(typeof thenOf(cleared)).toBe('function');
    await cleared;

    const destroyed = container.destroy();
    expect(typeof thenOf(destroyed)).toBe('function');
    await destroyed;
    expect(() => container.resolve(TOKEN)).toThrow(/NEO_CONTAINER_DESTROYED/);

    await expect(container.override(TOKEN, () => ({ id: 'nope' }))).rejects.toThrow(/NEO_CONTAINER_DESTROYED/);
    expect(() => container.resolve(TOKEN)).toThrow(/NEO_CONTAINER_DESTROYED/);
  });

  it('T03 sync destroy disposes in reverse order before await', async () => {
    const log: string[] = [];
    Object.assign(globalThis, { __t03DisposeLog: log });
    // Owned factory singletons: a value registration is never disposed.
    const ownedFactory = (tokenId: string, label: string): ServiceDefinition => ({
      tokenId,
      type: 'factory',
      factorySource: `() => ({ dispose() { globalThis.__t03DisposeLog.push(${JSON.stringify(label)}); } })`,
      lifecycle: 'singleton',
      isInterfaceToken: true,
      isDisposable: true,
      ownership: 'owned',
      registrationNode: registrationNode(),
    });
    const graph: DependencyGraph = {
      containerId: 'Test',
      nodes: new Map([
        ['ServiceA', {
          service: ownedFactory('ServiceA', 'dependency'),
          dependencies: [],
        }],
        ['ServiceB', {
          service: ownedFactory('ServiceB', 'dependent'),
          dependencies: ['ServiceA'],
        }],
      ]),
      roots: ['ServiceA', 'ServiceB'],
      exportedVariableName: 'container',
      variableExportModifier: 'export',
    };

    const container = load(graph);
    container.resolve('ServiceB');
    container.resolve('ServiceA');
    const pending = container.destroy();
    expect(log).toEqual(['dependent', 'dependency']);
    expect(typeof thenOf(pending)).toBe('function');
    await pending;
  });
});
