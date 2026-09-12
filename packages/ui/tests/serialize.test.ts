import { describe, it, expect } from 'vitest';
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
});
