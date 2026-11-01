import path from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect } from 'vitest';
import * as ts from 'typescript';
import { Analyzer } from '@djodjonx/neosyringe-core/analyzer';
import { serializeGraph } from '../src/serialize';
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
