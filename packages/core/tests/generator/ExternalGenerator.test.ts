import { describe, it, expect } from 'vitest';
import { Generator } from '../../src/generator/Generator';
import { DependencyGraph, DependencyNode, ServiceDefinition, TokenId } from '../../src/analyzer/types';
import * as ts from 'typescript';

// Helper to create a mock symbol
function createMockSymbol(name: string, filePath: string): ts.Symbol {
  return {
    getName: () => name,
    declarations: [
      {
        getSourceFile: () => ({ fileName: filePath }),
      },
    ],
  } as unknown as ts.Symbol;
}

// Helper to create a mock node
function createMockNode(
    id: TokenId, 
    dependencies: TokenId[], 
    implName: string, 
    filePath: string, 
    type: 'explicit' | 'autowire' | 'parent' = 'explicit'
): DependencyNode {
  return {
    service: {
      tokenId: id,
      implementationSymbol: createMockSymbol(implName, filePath),
      registrationNode: {} as ts.Node,
      type: type,
      lifecycle: 'singleton',
    } as ServiceDefinition,
    dependencies,
  };
}

describe('Generator - External Bindings', () => {
  it('should generate code that delegates external tokens to parent', () => {
    // Graph: FeatureService -> SharedKernel (External)
    const graph: DependencyGraph = {
      containerId: "TestContainer", nodes: new Map([
        ['SharedKernel', createMockNode('SharedKernel', [], 'SharedKernel', '/src/shared.ts', 'parent')],
        ['FeatureService', createMockNode('FeatureService', ['SharedKernel'], 'FeatureService', '/src/feature.ts', 'autowire')],
      ]),
      roots: ['FeatureService'],
    };

    const generator = new Generator(graph, false, '/src');
    const code = generator.generate();

    // 1. Verify Import — paths are relative to outputDir ('/src')
    // Aliases depend on traversal order. 
    // FeatureService is generated first (as factory), so it gets Import_0.
    // SharedKernel is resolved inside FeatureService, so it gets Import_1.
    expect(code).toContain(`import * as Import_0 from './feature.ts';`);
    expect(code).toContain(`import * as Import_1 from './shared.ts';`);

    // 2. Verify FeatureService Factory
    // Should resolve SharedKernel via this.resolve()
    expect(code).toContain('private create_FeatureService(): any {');
    // Import_0 is FeatureService, Import_1 is SharedKernel
    expect(code).toContain('return new Import_0.FeatureService(this.resolve(Import_1.SharedKernel));');

    // 3. Verify SharedKernel Factory DOES NOT EXIST
    expect(code).not.toContain('function create_SharedKernel');

    // 4. Verify resolveLocal skips SharedKernel
    // We check that "if (token === Import_0.SharedKernel)" is NOT present
    expect(code).not.toContain('if (token === Import_0.SharedKernel)');

    // 5. Verify Container Instantiation (no parent/legacy/name args)
    expect(code).toContain('export const container = new NeoContainer(undefined, undefined, undefined);');
  });
});
