import { describe, it, expect } from 'vitest';
import { GraphValidator } from '../../src/generator/GraphValidator';
import { DependencyGraph, DependencyNode, ServiceDefinition } from '../../src/analyzer/types';
import * as ts from 'typescript';

// Create a mock source file for testing
const mockSourceFile = ts.createSourceFile('test.ts', '', ts.ScriptTarget.Latest);

// Create a mock node with required methods
const mockNode = {
  getSourceFile: () => mockSourceFile,
  getStart: () => 0,
  getEnd: () => 10,
} as unknown as ts.Node;

describe('GraphValidator Safety', () => {
  it('should detect error for missing binding', () => {
    // A depends on B, but B is not in nodes
    const graph: DependencyGraph = {
      containerId: "TestContainer", nodes: new Map([
        ['A', {
            service: {
              tokenId: 'A',
              registrationNode: mockNode,
            } as ServiceDefinition,
            dependencies: ['B']
        } as DependencyNode]
      ]),
      roots: []
    };

    const validator = new GraphValidator();
    const result = validator.validateAll(graph);

    expect(result.valid).toBe(false);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0].type).toBe('missing');
    expect(result.errors[0].message).toContain("Service 'A' depends on 'B'");
  });

  it('should detect multiple missing bindings', () => {
    // A depends on B and C, neither are registered
    const graph: DependencyGraph = {
      containerId: "TestContainer", nodes: new Map([
        ['A', {
            service: {
              tokenId: 'A',
              registrationNode: mockNode,
            } as ServiceDefinition,
            dependencies: ['B', 'C']
        } as DependencyNode]
      ]),
      roots: []
    };

    const validator = new GraphValidator();
    const result = validator.validateAll(graph);

    expect(result.valid).toBe(false);
    expect(result.errors.length).toBe(2);
    expect(result.errors.every(e => e.type === 'missing')).toBe(true);
  });
});
