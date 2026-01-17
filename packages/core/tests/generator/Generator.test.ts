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
function createMockNode(id: TokenId, dependencies: TokenId[], implName: string, filePath: string, lifecycle: 'singleton' | 'transient' = 'singleton'): DependencyNode {
  return {
    service: {
      tokenId: id,
      implementationSymbol: createMockSymbol(implName, filePath),
      registrationNode: {} as ts.Node,
      type: 'explicit',
      lifecycle: lifecycle,
    } as ServiceDefinition,
    dependencies,
  };
}

describe('Generator', () => {
  it('should generate factories and container class', () => {
    // Graph: Service -> Logger
    const graph: DependencyGraph = {
      nodes: new Map([
        ['ILogger', createMockNode('ILogger', [], 'ConsoleLogger', '/src/logger.ts')],
        ['UserService', createMockNode('UserService', ['ILogger'], 'UserService', '/src/user.ts')],
      ]),
      roots: ['UserService'],
    };

    const generator = new Generator(graph);
    const code = generator.generate();

    // Verify Imports
    expect(code).toContain(`import * as Import_0 from '/src/logger.ts';`);
    expect(code).toContain(`import * as Import_1 from '/src/user.ts';`);

    // Verify Factory Functions
    // C depends on nothing -> new Import_0.ConsoleLogger()
    expect(code).toContain('function create_ILogger(container: NeoContainer) {');
    expect(code).toContain('return new Import_0.ConsoleLogger();');

    // B depends on C -> new Import_1.UserService(container.resolve(Import_0.ConsoleLogger))
    expect(code).toContain('function create_UserService(container: NeoContainer) {');
    expect(code).toContain('return new Import_1.UserService(container.resolve(Import_0.ConsoleLogger));');

    // Verify Container Class
    expect(code).toContain('export class NeoContainer {');
    expect(code).toContain('constructor(');
    expect(code).toContain('private name: string = \'NeoContainer\'');
    expect(code).toContain('throw new Error(`[${this.name}] Service not found');
  });

  it('should handle scopes correctly', () => {
    const graph: DependencyGraph = {
      nodes: new Map([
        ['Singleton', createMockNode('Singleton', [], 'S', '/src/s.ts', 'singleton')],
        ['Transient', createMockNode('Transient', [], 'T', '/src/t.ts', 'transient')],
      ]),
      roots: [],
    };

    const generator = new Generator(graph);
    const code = generator.generate();

    // Singleton Logic: Check cache
    // if (token === Import_0.S) { if (!this.instances.has(Import_0.S)) ... }
    expect(code).toContain('if (!this.instances.has(Import_0.S))');
    
    // Transient Logic: Always call factory
    // if (token === Import_1.T) { return create_Transient(this); }
    expect(code).toContain('return create_Transient(this);');
    expect(code).not.toContain('!this.instances.has(Import_1.T)');
  });
  
  it('should sanitize variable names for factories', () => {
      const graph: DependencyGraph = {
          nodes: new Map([
              ['@scope/Package', createMockNode('@scope/Package', [], 'Pkg', '/src/pkg.ts')]
          ]),
          roots: []
      };
      
      const generator = new Generator(graph);
      const code = generator.generate();
      
      expect(code).toContain('function create__scope_Package(container: NeoContainer)');
  });
});