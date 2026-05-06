import { describe, it, expect } from 'vitest';
import { topologicalSort } from '../../src/generator/TopologicalSorter';
import type { DependencyNode } from '../../src/analyzer/types';
import type { TokenId } from '../../src/analyzer/types';

function makeNode(deps: TokenId[]): DependencyNode {
  return {
    service: {
      tokenId: 'dummy',
      type: 'autowire',
      lifecycle: 'singleton',
      registrationNode: null as any,
    },
    dependencies: deps,
  };
}

describe('topologicalSort', () => {
  it('returns empty array for empty graph', () => {
    expect(topologicalSort(new Map())).toEqual([]);
  });

  it('returns single node for graph with one node and no deps', () => {
    const nodes = new Map<TokenId, DependencyNode>([
      ['A', makeNode([])],
    ]);
    expect(topologicalSort(nodes)).toEqual(['A']);
  });

  it('returns dependencies before dependents (A depends on B depends on C)', () => {
    const nodes = new Map<TokenId, DependencyNode>([
      ['A', makeNode(['B'])],
      ['B', makeNode(['C'])],
      ['C', makeNode([])],
    ]);
    const sorted = topologicalSort(nodes);
    expect(sorted.indexOf('C')).toBeLessThan(sorted.indexOf('B'));
    expect(sorted.indexOf('B')).toBeLessThan(sorted.indexOf('A'));
  });

  it('handles diamond dependency (A depends on B and C, both depend on D)', () => {
    const nodes = new Map<TokenId, DependencyNode>([
      ['A', makeNode(['B', 'C'])],
      ['B', makeNode(['D'])],
      ['C', makeNode(['D'])],
      ['D', makeNode([])],
    ]);
    const sorted = topologicalSort(nodes);
    expect(sorted.indexOf('D')).toBeLessThan(sorted.indexOf('B'));
    expect(sorted.indexOf('D')).toBeLessThan(sorted.indexOf('C'));
    expect(sorted.indexOf('B')).toBeLessThan(sorted.indexOf('A'));
    expect(sorted.indexOf('C')).toBeLessThan(sorted.indexOf('A'));
  });

  it('throws with [Generator] message on cycle detection', () => {
    const nodes = new Map<TokenId, DependencyNode>([
      ['A', makeNode(['B'])],
      ['B', makeNode(['A'])],
    ]);
    expect(() => topologicalSort(nodes)).toThrow('[Generator] Cycle detected');
  });
});
