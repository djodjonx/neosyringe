import path from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect } from 'vitest';
import * as ts from 'typescript';
import { Analyzer } from '@djodjonx/neosyringe-core/analyzer';
import { serializeGraph, serializeGraphWithErrors } from '../src/serialize';
import type { DependencyGraph, DependencyNode } from '@djodjonx/neosyringe-core/analyzer';

function makeGraph(overrides: Partial<DependencyGraph> = {}): DependencyGraph {
  return {
    containerId: 'TestContainer',
    nodes: new Map(),
    roots: [],
    ...overrides,
  };
}

function makeNode(tokenId: string, deps: string[] = [], optDeps: string[] = []): DependencyNode {
  return {
    service: {
      tokenId,
      lifecycle: 'singleton',
      type: 'explicit',
      registrationNode: {} as never,
    },
    dependencies: deps,
    optionalDependencies: optDeps.length > 0 ? new Set(optDeps) : undefined,
  };
}

describe('serializeGraph', () => {
  it('serializes an empty graph', () => {
    const graph = makeGraph({ containerId: 'App', roots: [] });
    const result = serializeGraph(graph);
    expect(result.containerId).toBe('App');
    expect(result.nodes).toEqual([]);
    expect(result.roots).toEqual([]);
  });

  it('serializes nodes with dependencies', () => {
    const nodes = new Map([
      ['AuthService', makeNode('AuthService', ['DatabaseService'])],
      ['DatabaseService', makeNode('DatabaseService')],
    ]);
    const graph = makeGraph({ nodes, roots: ['AuthService'] });
    const result = serializeGraph(graph);

    expect(result.nodes).toHaveLength(2);
    const auth = result.nodes.find(n => n.tokenId === 'AuthService')!;
    expect(auth.dependencies).toEqual(['DatabaseService']);
    expect(auth.optionalDependencies).toEqual([]);
  });

  it('serializes optional dependencies', () => {
    const nodes = new Map([
      ['UserService', makeNode('UserService', ['Logger', 'DB'], ['Logger'])],
    ]);
    const result = serializeGraph(makeGraph({ nodes }));
    const user = result.nodes[0];
    expect(user.optionalDependencies).toEqual(['Logger']);
    expect(user.dependencies).toEqual(['Logger', 'DB']);
  });

  it('preserves containerName when present', () => {
    const graph = makeGraph({ containerName: 'MyApp' });
    expect(serializeGraph(graph).containerName).toBe('MyApp');
  });

  it('copies a multi registration without an id and with an optional dependency', () => {
    const withOptional = makeNode('Port', ['Logger'], ['Logger']);
    withOptional.service.registrationId = 'reg-1';
    const withoutId = makeNode('Port');
    const graph = makeGraph({
      containerKey: 'Container_abc',
      multiNodes: new Map([['Port', [withOptional, withoutId]]]),
      borrowedRegistrations: [],
    });
    const result = serializeGraph(graph);
    expect(result.containerKey).toBe('Container_abc');
    expect(result.borrowedRegistrations).toEqual([]);
    expect(result.multiNodes).toEqual([
      {
        registrationId: 'reg-1',
        tokenId: 'Port',
        lifecycle: 'singleton',
        type: 'explicit',
        dependencies: ['Logger'],
        optionalDependencies: ['Logger'],
      },
      {
        tokenId: 'Port',
        lifecycle: 'singleton',
        type: 'explicit',
        dependencies: [],
        optionalDependencies: [],
      },
    ]);
  });

  it('copies node registrationId and ownership only when they are set', () => {
    const owned = makeNode('Owned');
    owned.service.registrationId = 'reg-owned';
    owned.service.ownership = 'owned';
    const plain = makeNode('Plain');
    const result = serializeGraph(makeGraph({
      nodes: new Map([
        ['Owned', owned],
        ['Plain', plain],
      ]),
    }));
    expect(result.nodes.find((node) => node.tokenId === 'Owned')).toEqual({
      tokenId: 'Owned',
      registrationId: 'reg-owned',
      ownership: 'owned',
      lifecycle: 'singleton',
      type: 'explicit',
      dependencies: [],
      optionalDependencies: [],
    });
    expect(result.nodes.find((node) => node.tokenId === 'Plain')).toEqual({
      tokenId: 'Plain',
      lifecycle: 'singleton',
      type: 'explicit',
      dependencies: [],
      optionalDependencies: [],
    });
  });

  it('T12-serialize keeps containerKey, multiNodes and borrowedRegistrations', () => {
    const fileName = path.join(tmpdir(), 't12-serialize-graph.ts');
    const source = `
      import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';
      function defineBuilderConfig(config: any) { return config; }
      function useInterface<T>(): any { return null; }
      class ParentSvc {}
      export const parentC = defineBuilderConfig({
        name: 'ParentApp',
        injections: [{ token: ParentSvc }],
      });
      interface Port { id: number }
      class MultiOne implements Port { id = 1; }
      class MultiTwo implements Port { id = 2; }
      class ChildSvc {}
      export const childC = defineBuilderConfig({
        name: 'ChildApp',
        useContainer: parentC,
        injections: [
          { token: ChildSvc },
          { token: useInterface<Port>(), provider: MultiOne, multi: true },
          { token: useInterface<Port>(), provider: MultiTwo, multi: true },
        ],
      });
    `;
    const program = createProgram(fileName, source);
    const graphs = new Analyzer(program).extractAll();
    const parent = graphs.find((graph) => graph.exportedVariableName === 'parentC');
    const child = graphs.find((graph) => graph.exportedVariableName === 'childC');
    expect(parent?.containerKey).toEqual(expect.any(String));
    expect(child?.multiNodes).toBeDefined();
    expect(child?.borrowedRegistrations?.length ?? 0).toBeGreaterThan(0);
    const serialized = serializeGraph(child!);
    expect(serialized.containerKey).toBe(child!.containerKey);
    expect(serialized.containerKey).not.toBe(child!.containerId);
    expect(serialized.containerKey).not.toBe(parent!.containerKey);
    expect(serialized.nodes.map((node) => node.tokenId)).toEqual([...child!.nodes.keys()]);
    expect(serialized.multiNodes).toEqual([...child!.multiNodes!.values()].flatMap((nodes) => nodes.map((node) => ({
      ...(node.service.registrationId !== undefined ? { registrationId: node.service.registrationId } : {}),
      tokenId: node.service.tokenId,
      lifecycle: node.service.lifecycle,
      type: node.service.type,
      dependencies: node.dependencies,
      optionalDependencies: [...(node.optionalDependencies ?? [])],
    }))));
    expect(serialized.borrowedRegistrations).toEqual(child!.borrowedRegistrations!.map((registration) => ({
      registrationId: registration.registrationId,
      tokenId: registration.tokenId,
      containerId: registration.containerId,
    })));
    expect(serialized.borrowedRegistrations?.[0]?.containerId).toBe(parent!.containerKey);
    const parentSerialized = serializeGraph(parent!);
    const borrowedId = serialized.borrowedRegistrations?.[0]?.registrationId;
    expect(parentSerialized.nodes.some((node) => node.registrationId === borrowedId)).toBe(true);
    expect(parentSerialized.nodes.find((node) => node.registrationId === borrowedId)?.ownership).toBe('owned');
  });
});

const T19_SECRET = 'SECRET_SENTINEL_t19_ui_41c8';
const T19_SOURCE = `
  import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';
  function defineBuilderConfig(config: any) { return config; }
  function useInterface<T>(): any { return null; }
  interface UiCfg { key: string }
  interface UiRoot { n: number }
  interface UiIdle { n: number }
  interface UiHost { n: number }
  const cfg = useInterface<UiCfg>();
  const root = useInterface<UiRoot>();
  const idle = useInterface<UiIdle>();
  const host = useInterface<UiHost>();
  interface UiAbsent { n: number }
  const absent = useInterface<UiAbsent>();
  export const closed = defineBuilderConfig({
    name: 'UiClosed',
    optimization: { mode: 'closed', roots: [root] },
    injections: [
      { token: cfg, useValue: { key: '${T19_SECRET}' } },
      { token: root, useFactory: true, dependencies: [cfg], provider: (ctx) => { const text = '${T19_SECRET}_FACTORY'; return { n: text.length + ctx.resolve(cfg).key.length }; } },
      { token: idle, useFactory: true, dependencies: [], provider: () => ({ n: 1 }) },
    ],
  });
  export const opaque = defineBuilderConfig({
    name: 'UiOpaque',
    injections: [{ token: host, useFactory: true, provider: () => ({ n: 1 }) }],
  });
  interface UiNeeded { n: number }
  class UiNeedy { constructor(dep: UiNeeded) {} }
  export const needy = defineBuilderConfig({ name: 'UiNeedy', injections: [{ token: UiNeedy }] });
  export const supplier = defineBuilderConfig({
    name: 'UiSupplier',
    injections: [{ token: useInterface<UiNeeded>(), useFactory: true, dependencies: [], provider: () => ({ n: 1 }) }],
  });
  export const broken = defineBuilderConfig({
    name: 'UiBroken',
    optimization: { mode: 'closed', roots: [absent] },
    injections: [{ token: idle, useFactory: true, dependencies: [], provider: () => ({ n: 1 }) }],
  });
`;

describe('T19 serializeGraph retention and diagnostics', () => {
  const fileName = path.join(tmpdir(), 't19-serialize-graph.ts');
  const program = createProgram(fileName, T19_SOURCE);
  const graphs = new Analyzer(program).extractAll();
  const compatible = new Analyzer(program, { validation: 'compatible' });
  const compatibleGraphs = compatible.extractAll();
  const compatibleErrors = compatible.extractAllErrors();
  const strictErrors = new Analyzer(program).extractAllErrors();

  function graphNamed(list: DependencyGraph[], name: string): DependencyGraph {
    const found = list.find((graph) => graph.containerName === name);
    if (!found) throw new Error(`missing graph ${name}`);
    return found;
  }

  it('T19 retention causes and paths are serialized', () => {
    const serialized = serializeGraph(graphNamed(graphs, 'UiClosed'));
    const brief = (serialized.retention ?? []).map(({ token, cause, path: through }) => ({ token, cause, path: through }));

    expect(brief).toEqual([
      { token: 'UiCfg', cause: 'dependency-of', path: ['UiRoot', 'UiCfg'] },
      { token: 'UiRoot', cause: 'root', path: ['UiRoot'] },
      { token: 'UiIdle', cause: 'unreachable', path: [] },
    ]);
    expect(serialized.retention?.every((entry) => typeof entry.registrationId === 'string')).toBe(true);
    const open = serializeGraph(graphNamed(compatibleGraphs, 'UiOpaque'));
    expect(open.retention?.map((entry) => entry.cause)).toEqual(['opaque-boundary']);
    expect(serializeGraph(makeGraph()).retention).toBeUndefined();
  });

  it('T19 secret stays out', () => {
    const serialized = JSON.stringify(serializeGraph(graphNamed(graphs, 'UiClosed')));

    expect(serialized).toContain('UiCfg');
    expect(serialized).not.toContain(T19_SECRET);
  });

  it('T19 warning stays a warning', () => {
    const warning = compatibleErrors.find((error) => error.code === 'NEO_FACTORY_DEPENDENCIES_REQUIRED');
    if (!warning) throw new Error('opaque warning not produced');
    const diagnostic = serializeGraphWithErrors(graphNamed(compatibleGraphs, 'UiOpaque'), compatibleErrors).diagnostics
      ?.find((item) => item.code === 'NEO_FACTORY_DEPENDENCIES_REQUIRED');

    expect(warning.severity).toBe('warning');
    expect(diagnostic).toMatchObject({ code: 'NEO_FACTORY_DEPENDENCIES_REQUIRED', severity: 'warning' });
  });

  it('T19 analyzer errors replace the graph errors when given', () => {
    const graph = graphNamed(graphs, 'UiBroken');
    const missing = strictErrors.find((error) => error.type === 'missing');
    if (!missing) throw new Error('missing provider error not produced');

    expect((graph.errors ?? []).length).toBeGreaterThan(0);
    expect(serializeGraph(graph).diagnostics?.length).toBe(graph.errors?.length);
    expect(serializeGraphWithErrors(graph, []).diagnostics).toEqual([]);
    expect(serializeGraphWithErrors(graph, [missing]).diagnostics?.map((item) => item.code)).toEqual(['NEO_MISSING_PROVIDER']);
  });

  it('T19 serializeGraph stays safe as a map callback', () => {
    const viaMap = graphs.map(serializeGraph);

    expect(viaMap.map((item) => item.diagnostics)).toEqual(graphs.map((graph) => serializeGraph(graph).diagnostics));
    expect(viaMap.length).toBe(graphs.length);
  });

  it('T19-A04 missing provider diagnostic names its container and source', () => {
    const needy = graphNamed(graphs, 'UiNeedy');
    const supplier = graphNamed(graphs, 'UiSupplier');
    const missing = strictErrors.find((error) => error.type === 'missing' && error.context?.tokenText?.includes('UiNeeded'));
    if (!missing) throw new Error('missing provider error not produced');

    const diagnostic = serializeGraphWithErrors(needy, [missing]).diagnostics?.[0];
    expect(diagnostic).toMatchObject({
      code: 'NEO_MISSING_PROVIDER',
      severity: 'error',
      containerId: needy.containerKey,
      containerName: 'UiNeedy',
      containerFile: fileName,
      file: fileName,
      token: 'UiNeeded',
    });
    expect(diagnostic?.containerId).not.toBe(supplier.containerKey);
    expect(serializeGraphWithErrors(supplier, []).diagnostics).toEqual([]);
  });

  it('T19 diagnostics carry code, severity and position', () => {
    const diagnostics = serializeGraph(graphNamed(graphs, 'UiBroken')).diagnostics ?? [];
    const missing = diagnostics.find((item) => item.code === 'NEO_MISSING_PROVIDER');

    expect(missing).toMatchObject({ severity: 'error', type: 'missing', file: fileName });
    expect(missing?.line).toBeGreaterThan(0);
    expect(missing?.column).toBeGreaterThan(0);
    expect(serializeGraph(graphNamed(graphs, 'UiClosed')).diagnostics).toEqual([]);
    expect(serializeGraph(makeGraph()).diagnostics).toBeUndefined();
  });
});

function createProgram(fileName: string, source: string): ts.Program {
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext,
    strict: true,
    noImplicitAny: false,
  };
  const host = ts.createCompilerHost(options);
  const readSource = host.getSourceFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  host.getSourceFile = (name, version) => {
    if (name === fileName) return ts.createSourceFile(name, source, version, true);
    return readSource(name, version);
  };
  host.fileExists = (name) => name === fileName || fileExists(name);
  return ts.createProgram([fileName], options, host);
}
