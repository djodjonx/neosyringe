import { describe, it, expect } from 'vitest';
import { GraphValidator } from '../../src/generator/GraphValidator';
import { DependencyGraph, DependencyNode, ServiceDefinition } from '../../src/analyzer/types';

describe('GraphValidator Safety', () => {
  it('should throw error for missing binding', () => {
    // A depends on B, but B is not in nodes
    const graph: DependencyGraph = {
      nodes: new Map([
        ['A', { 
            service: { tokenId: 'A' } as ServiceDefinition, 
            dependencies: ['B'] 
        } as DependencyNode]
      ]),
      roots: []
    };

    const validator = new GraphValidator();
    expect(() => validator.validate(graph)).toThrowError(/Missing binding: Service 'A' depends on 'B'/);
  });
});
