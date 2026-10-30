/**
 * Runtime proof for the generated container, before any stale text or snapshot
 * is updated. Each test executes the container and asserts a value.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as ts from 'typescript';
import { Generator } from '../../packages/core/src/generator/Generator';
import type { DependencyGraph, ServiceDefinition } from '../../packages/core/src/analyzer/types';
import { executeFixture } from './helpers/execute-fixture';

const PARENT_ONLY = `
import { defineBuilderConfig } from '@djodjonx/neosyringe';

class ParentOnly {
  readonly value = 7;
}

export const parent = defineBuilderConfig({
  injections: [{ token: ParentOnly }],
});

class ChildOnly {}

export const child = defineBuilderConfig({
  name: 'ChildApp',
  useContainer: parent,
  injections: [{ token: ChildOnly }],
});

export function run() {
  return child.resolve(ParentOnly).value;
}
`;

const MISSING_DEPENDENCY = `
import { defineBuilderConfig } from '@djodjonx/neosyringe';

class MissingDependency {}
class ServiceA {
  constructor(public dep: MissingDependency) {}
}

export const c = defineBuilderConfig({
  injections: [{ token: ServiceA }],
});

export function run() {
  return 0;
}
`;

const MISSING_SERVICE = `
import { defineBuilderConfig, declareContainerTokens } from '@djodjonx/neosyringe';

class AuthService {}
class MissingService {}

const legacy = declareContainerTokens<{ AuthService: AuthService }>({
  resolve() {
    return new AuthService();
  },
});

class UserService {
  constructor(public auth: AuthService, public missing: MissingService) {}
}

export const container = defineBuilderConfig({
  name: 'AppWithTsyringe',
  useContainer: legacy,
  injections: [{ token: UserService }],
});

export function run() {
  return 0;
}
`;

function namedSource(name: string, withParent: boolean): string {
  const parent = withParent
    ? `
class Present {}
export const parent = defineBuilderConfig({
  injections: [{ token: Present }],
});
`
    : `
class Present {}
`;
  const useContainer = withParent ? 'useContainer: parent,' : '';
  const childToken = withParent ? 'ChildLocal' : 'Present';
  const childClass = withParent ? 'class ChildLocal {}' : '';
  return `
import { defineBuilderConfig } from '@djodjonx/neosyringe';
${parent}
${childClass}
class MissingToken {
  marker() { return 'SHOULD_NOT_APPEAR_IN_ERROR'; }
}
export const c = defineBuilderConfig({
  name: '${name}',
  ${useContainer}
  injections: [{ token: ${childToken} }],
});
export function run() {
  return c.resolve(MissingToken);
}
`;
}

const RESOLVE_ALL_EMPTY = `
import { defineBuilderConfig } from '@djodjonx/neosyringe';

class Present {}

export const c = defineBuilderConfig({
  injections: [{ token: Present }],
});

export function run() {
  return c.resolveAll(Present);
}
`;

const RESOLVE_ALL_MULTI = `
import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';

interface IPlugin { id: number }
class AuthPlugin implements IPlugin { id = 1; }
class LogPlugin implements IPlugin { id = 2; }

export const c = defineBuilderConfig({
  injections: [
    { token: useInterface<IPlugin>(), provider: AuthPlugin, multi: true },
    { token: useInterface<IPlugin>(), provider: LogPlugin, multi: true },
  ],
});

export function run() {
  return c.resolveAll(useInterface<IPlugin>()).map((plugin: IPlugin) => plugin.id);
}
`;

const LEGACY_RETHROW = `
import { defineBuilderConfig, declareContainerTokens } from '@djodjonx/neosyringe';

class Local {}
class MissingToken {}

const legacy = declareContainerTokens<Record<string, never>>({
  resolve() {
    throw new Error('legacy-boom');
  },
});

export const c = defineBuilderConfig({
  name: 'ChildApp',
  useContainer: legacy,
  injections: [{ token: Local }],
});

export function run() {
  return c.resolve(MissingToken);
}
`;

const LEGACY_CONSTRUCTOR = `
import { defineBuilderConfig, declareContainerTokens } from '@djodjonx/neosyringe';

class LegacyService {}

const marker = { tag: 'legacy-marker' };
globalThis.__neoLegacyMarker = marker;

const legacy = declareContainerTokens<{ LegacyService: LegacyService }>({
  resolve: () => marker,
});

class NewService {
  constructor(public l: LegacyService) {}
}

export const c = defineBuilderConfig({
  useContainer: legacy,
  injections: [{ token: NewService }],
});

export function run() {
  return c.resolve(NewService).l;
}
`;

const LEGACY_SWALLOW = `
import { defineBuilderConfig, declareContainerTokens } from '@djodjonx/neosyringe';

class Local {}
class MissingToken {}

const legacy = declareContainerTokens<Record<string, never>>({
  resolve() {
    const error = new Error('from-legacy-not-found');
    error.name = 'NeoServiceNotFoundError';
    throw error;
  },
});

export const c = defineBuilderConfig({
  name: 'ChildApp',
  useContainer: legacy,
  injections: [{ token: Local }],
});

export function run() {
  return c.resolve(MissingToken);
}
`;

function diagnosticOf(outcome: Awaited<ReturnType<typeof executeFixture>>): string {
  return outcome.phase === 'build' ? outcome.diagnostic : '';
}

function runtimeErrorOf(outcome: Awaited<ReturnType<typeof executeFixture>>): string {
  return outcome.phase === 'runtime' ? outcome.error : '';
}

describe('T13 runtime proof', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  afterEach(() => {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  });

  it('T13-A02 parent-only class resolves through the child', async () => {
    const outcome = await executeFixture(PARENT_ONLY);
    expect(outcome.phase).toBe('ok');
    expect(outcome.phase === 'ok' ? outcome.value : undefined).toBe(7);
  });

  it("T13-A02 build diagnostic contains Missing injection: 'MissingDependency'", async () => {
    const outcome = await executeFixture(MISSING_DEPENDENCY);
    expect(diagnosticOf(outcome)).toContain("Missing injection: 'MissingDependency'");
  });

  it("T13-A02 build diagnostic contains Missing injection: 'MissingService'", async () => {
    const outcome = await executeFixture(MISSING_SERVICE);
    expect(diagnosticOf(outcome)).toContain("Missing injection: 'MissingService'");
  });

  it('T13-A02 name Application reaches the runtime', async () => {
    const outcome = await executeFixture(namedSource('Application', false));
    expect(runtimeErrorOf(outcome)).toContain('[Application]');
  });

  it('T13-A02 name ReportingApp reaches the runtime', async () => {
    const outcome = await executeFixture(namedSource('ReportingApp', false));
    expect(runtimeErrorOf(outcome)).toContain('[ReportingApp]');
  });

  it('T13-A02 name AppContainer standalone reaches the runtime', async () => {
    const outcome = await executeFixture(namedSource('AppContainer', false));
    expect(runtimeErrorOf(outcome)).toContain('[AppContainer]');
  });

  it('T13-A02 name AppContainer parent reaches the runtime', async () => {
    const outcome = await executeFixture(namedSource('AppContainer', true));
    expect(runtimeErrorOf(outcome)).toContain('[AppContainer]');
  });

  it('T13-A02 name AppWithTsyringe reaches the runtime', async () => {
    const outcome = await executeFixture(namedSource('AppWithTsyringe', false));
    expect(runtimeErrorOf(outcome)).toContain('[AppWithTsyringe]');
  });

  it('T13-A02 formatToken keeps the class name and drops its source', async () => {
    const outcome = await executeFixture(namedSource('SimpleApp', false));
    const error = runtimeErrorOf(outcome);
    expect(error).toContain('Service not found or token not registered: MissingToken');
    expect(error).not.toContain('SHOULD_NOT_APPEAR_IN_ERROR');
  });

  it('T13-A02 resolveAll returns no instances when the token is not multi', async () => {
    const outcome = await executeFixture(RESOLVE_ALL_EMPTY);
    expect(outcome.phase).toBe('ok');
    expect(outcome.phase === 'ok' ? outcome.value : undefined).toEqual([]);
  });

  it('T13-A02 resolveAll returns each multi provider', async () => {
    const outcome = await executeFixture(RESOLVE_ALL_MULTI);
    expect(outcome.phase).toBe('ok');
    expect(outcome.phase === 'ok' ? outcome.value : undefined).toEqual([1, 2]);
  });

  it('T13-A02 legacy error that is not NeoServiceNotFoundError is rethrown', async () => {
    const outcome = await executeFixture(LEGACY_RETHROW);
    expect(runtimeErrorOf(outcome)).toContain('legacy-boom');
  });

  it('T13-A02 legacy constructor receives the marked instance', async () => {
    try {
      const outcome = await executeFixture(LEGACY_CONSTRUCTOR);
      expect(outcome.phase).toBe('ok');
      const marker = (globalThis as { __neoLegacyMarker?: unknown }).__neoLegacyMarker;
      expect(outcome.phase === 'ok' ? outcome.value : undefined).toBe(marker);
    } finally {
      delete (globalThis as { __neoLegacyMarker?: unknown }).__neoLegacyMarker;
    }
  });

  it('T13-A02 legacy NeoServiceNotFoundError is swallowed and the child reports its own name', async () => {
    const error = runtimeErrorOf(await executeFixture(LEGACY_SWALLOW));
    expect(error).toContain('[ChildApp]');
    expect(error).not.toContain('from-legacy-not-found');
  });

  it('T13-A02 production guard empties _graph and _dependencyGraph', () => {
    const service: ServiceDefinition = {
      tokenId: 'ILogger_abc123',
      type: 'value',
      valueSource: '"real-logger"',
      lifecycle: 'singleton',
      isInterfaceToken: true,
      registrationNode: {} as ts.Node,
    };
    const graph: DependencyGraph = {
      containerId: 'Test',
      containerName: 'SimpleApp',
      nodes: new Map([['ILogger_abc123', { service, dependencies: [] }]]),
      roots: ['ILogger_abc123'],
      exportedVariableName: 'container',
      variableExportModifier: 'export',
    };
    const tsCode = new Generator(graph, false).generate();
    const jsCode = ts.transpileModule(tsCode, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText;
    const module = { exports: {} as { container?: {
      resolve: (token: unknown) => unknown;
      _graph: unknown;
      _dependencyGraph: unknown;
    } } };
    // eslint-disable-next-line no-new-func
    new Function('module', 'exports', 'require', jsCode)(module, module.exports, () => ({}));
    const container = module.exports.container;
    if (container === undefined) throw new Error('generated container was not exported');

    const openGraph = container._graph;
    const openEdges = container._dependencyGraph;
    process.env.NODE_ENV = 'production';
    const closedGraph = container._graph;
    const closedEdges = container._dependencyGraph;
    process.env.NODE_ENV = originalNodeEnv;

    expect(openGraph).toEqual(['ILogger_abc123']);
    expect(openEdges).toEqual([{ token: 'ILogger_abc123', dependencies: [] }]);
    expect(closedGraph).toEqual([]);
    expect(closedEdges).toEqual([]);

    let caught: unknown;
    try {
      container.resolve('MissingService_abc123');
    } catch (error) {
      caught = error;
    }
    if (!(caught instanceof Error)) throw new Error('resolve did not throw');
    expect(caught.name).toBe('NeoServiceNotFoundError');
    expect(caught.message).toBe(
      '[SimpleApp] Service not found or token not registered: MissingService',
    );
  });
});
