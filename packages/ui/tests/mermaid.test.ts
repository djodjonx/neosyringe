import { describe, it, expect } from 'vitest';
import { graphToMermaid } from '../src/mermaid';
import type { SerializableGraph } from '../src/types';

function graph(nodes: Array<{ tokenId: string; deps?: string[]; optDeps?: string[]; lifecycle?: 'singleton' | 'transient'; type?: 'explicit' | 'factory' | 'value' | 'autowire' | 'parent' }>): SerializableGraph {
  return {
    containerId: 'Test',
    nodes: nodes.map(n => ({
      tokenId: n.tokenId,
      lifecycle: n.lifecycle ?? 'singleton',
      type: n.type ?? 'explicit',
      dependencies: n.deps ?? [],
      optionalDependencies: n.optDeps ?? [],
    })),
    roots: [],
  };
}

describe('graphToMermaid', () => {
  it('generates valid flowchart header', () => {
    const result = graphToMermaid(graph([]));
    expect(result).toMatch(/^flowchart TD/);
  });

  it('generates a node per service', () => {
    const result = graphToMermaid(graph([{ tokenId: 'AuthService' }]));
    expect(result).toContain('AuthService');
  });

  it('generates arrows for dependencies', () => {
    const result = graphToMermaid(graph([
      { tokenId: 'A', deps: ['B'] },
      { tokenId: 'B' },
    ]));
    expect(result).toContain('-->');
  });

  it('uses dashed arrows for optional dependencies', () => {
    const result = graphToMermaid(graph([
      { tokenId: 'A', deps: ['Logger'], optDeps: ['Logger'] },
      { tokenId: 'Logger' },
    ]));
    expect(result).toContain('-.->' );
  });

  it('sanitizes token IDs with special characters', () => {
    const result = graphToMermaid(graph([{ tokenId: 'my-service/v2' }]));
    // Node ID (before `["..."`) must not contain raw dashes or slashes
    expect(result).not.toMatch(/^\s+my-service/m);
    // Sanitized node ID must appear
    expect(result).toContain('my_service_v2');
  });

  it('applies singleton class to singleton nodes', () => {
    const result = graphToMermaid(graph([{ tokenId: 'S', lifecycle: 'singleton' }]));
    expect(result).toContain(':::singleton');
  });

  it('applies transient class to transient nodes', () => {
    const result = graphToMermaid(graph([{ tokenId: 'T', lifecycle: 'transient' }]));
    expect(result).toContain(':::transient');
  });

  it('applies factory class to factory type nodes', () => {
    const result = graphToMermaid(graph([{ tokenId: 'F', type: 'factory' }]));
    expect(result).toContain(':::factory');
  });
});
