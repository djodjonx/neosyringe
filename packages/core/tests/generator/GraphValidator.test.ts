import { describe, it, expect } from 'vitest';
import { GraphValidator } from '../../src/generator/GraphValidator';
import { DependencyGraph, DependencyNode, ServiceDefinition, TokenId } from '../../src/analyzer/types';
import * as ts from 'typescript';

// Create a mock source file for testing
const mockSourceFile = ts.createSourceFile('test.ts', '', ts.ScriptTarget.Latest);

// Helper to create a mock node without needing real TS symbols
function createMockNode(id: TokenId, dependencies: TokenId[]): DependencyNode {
  // Create a mock node with getSourceFile method
  const mockNode = {
    getSourceFile: () => mockSourceFile,
    getStart: () => 0,
    getEnd: () => 10,
  } as unknown as ts.Node;

  return {
    service: {
      tokenId: id,
      implementationSymbol: {} as ts.Symbol, // Mock
      registrationNode: mockNode,
      type: 'autowire',
      lifecycle: 'singleton',
    } as ServiceDefinition,
    dependencies,
  };
}

describe('GraphValidator', () => {
  const validator = new GraphValidator();

  it('should pass for a simple linear graph (A -> B)', () => {
    const graph: DependencyGraph = {
      nodes: new Map([
        ['A', createMockNode('A', ['B'])],
        ['B', createMockNode('B', [])],
      ]),
      roots: ['A'],
    };

    expect(() => validator.validate(graph)).not.toThrow();
  });

  it('should pass for a diamond dependency (A -> B, A -> C, B -> D, C -> D)', () => {
    // Valid graph:
    //   A
    //  / \
    // B   C
    //  \ /
    //   D
    const graph: DependencyGraph = {
      nodes: new Map([
        ['A', createMockNode('A', ['B', 'C'])],
        ['B', createMockNode('B', ['D'])],
        ['C', createMockNode('C', ['D'])],
        ['D', createMockNode('D', [])],
      ]),
      roots: ['A'],
    };

    expect(() => validator.validate(graph)).not.toThrow();
  });

  it('should detect a direct self-cycle (A -> A)', () => {
    const graph: DependencyGraph = {
      nodes: new Map([
        ['A', createMockNode('A', ['A'])],
      ]),
      roots: ['A'],
    };

    const result = validator.validateAll(graph);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.type === 'cycle' && e.message.includes('A -> A'))).toBe(true);
  });

  it('should detect a simple cycle (A -> B -> A)', () => {
    const graph: DependencyGraph = {
      nodes: new Map([
        ['A', createMockNode('A', ['B'])],
        ['B', createMockNode('B', ['A'])],
      ]),
      roots: ['A'],
    };

    const result = validator.validateAll(graph);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.type === 'cycle' && e.message.includes('A -> B -> A'))).toBe(true);
  });

  it('should detect a long cycle (A -> B -> C -> A)', () => {
    const graph: DependencyGraph = {
      nodes: new Map([
        ['A', createMockNode('A', ['B'])],
        ['B', createMockNode('B', ['C'])],
        ['C', createMockNode('C', ['A'])],
      ]),
      roots: ['A'],
    };

    const result = validator.validateAll(graph);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.type === 'cycle' && e.message.includes('A -> B -> C -> A'))).toBe(true);
  });

  it('should pass for disconnected components', () => {
    const graph: DependencyGraph = {
      nodes: new Map([
        ['A', createMockNode('A', [])],
        ['B', createMockNode('B', [])],
      ]),
      roots: ['A', 'B'],
    };

    expect(() => validator.validate(graph)).not.toThrow();
  });
});
