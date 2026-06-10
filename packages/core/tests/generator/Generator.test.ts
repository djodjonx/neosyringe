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
      containerId: "TestContainer", nodes: new Map([
        ['ILogger', createMockNode('ILogger', [], 'ConsoleLogger', '/src/logger.ts')],
        ['UserService', createMockNode('UserService', ['ILogger'], 'UserService', '/src/user.ts')],
      ]),
      roots: ['UserService'],
    };

    const generator = new Generator(graph, false, '/src');
    const code = generator.generate();

    // Verify Imports — paths are relative to outputDir ('/src')
    expect(code).toContain(`import * as Import_0 from './logger.ts';`);
    expect(code).toContain(`import * as Import_1 from './user.ts';`);

    // Verify Factory Functions
    // C depends on nothing -> new Import_0.ConsoleLogger()
    expect(code).toContain('private create_ILogger(): any {');
    expect(code).toContain('return new Import_0.ConsoleLogger();');

    // B depends on C -> new Import_1.UserService(this.resolve(Import_0.ConsoleLogger))
    expect(code).toContain('private create_UserService(): any {');
    expect(code).toContain('return new Import_1.UserService(this.resolve(Import_0.ConsoleLogger));');

    // Verify Container Class
    expect(code).toContain('class NeoContainer {');
    expect(code).not.toContain('export class NeoContainer {');
    expect(code).toContain('constructor(');
    expect(code).toContain('private name: string = \'NeoContainer\'');
    expect(code).toContain('throw new NeoServiceNotFoundError(`[${this.name}] Service not found');
  });

  it('should handle scopes correctly', () => {
    const graph: DependencyGraph = {
      containerId: "TestContainer", nodes: new Map([
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
    // if (token === Import_1.T) { return this.create_Transient(); }
    expect(code).toContain('return this.create_Transient();');
    expect(code).not.toContain('!this.instances.has(Import_1.T)');
  });

  it('should sanitize variable names for factories', () => {
      const graph: DependencyGraph = {
          containerId: "TestContainer", nodes: new Map([
              ['@scope/Package', createMockNode('@scope/Package', [], 'Pkg', '/src/pkg.ts')]
          ]),
          roots: []
      };

      const generator = new Generator(graph);
      const code = generator.generate();

      expect(code).toContain('private create__scope_Package(): any');
  });

  it('should respect export modifiers for container variable', () => {
    // Test 'export' modifier
    const graphExport: DependencyGraph = {
      containerId: "TestContainer", nodes: new Map([
        ['Service', createMockNode('Service', [], 'S', '/src/s.ts')]
      ]),
      roots: [],
      exportedVariableName: 'myContainer',
      variableExportModifier: 'export'
    };
    const codeExport = new Generator(graphExport).generate();
    expect(codeExport).toContain('export const myContainer = new NeoContainer');
    expect(codeExport).not.toContain('export default');

    // Test 'export default' modifier
    const graphDefault: DependencyGraph = {
      containerId: "TestContainer", nodes: new Map([
        ['Service', createMockNode('Service', [], 'S', '/src/s.ts')]
      ]),
      roots: [],
      exportedVariableName: 'container',
      variableExportModifier: 'export default'
    };
    const codeDefault = new Generator(graphDefault).generate();
    expect(codeDefault).toContain('const container = new NeoContainer');
    expect(codeDefault).toContain('export default container;');

    // Test 'none' modifier (no export)
    const graphNone: DependencyGraph = {
      containerId: "TestContainer", nodes: new Map([
        ['Service', createMockNode('Service', [], 'S', '/src/s.ts')]
      ]),
      roots: [],
      exportedVariableName: 'privateContainer',
      variableExportModifier: 'none'
    };
    const codeNone = new Generator(graphNone).generate();
    expect(codeNone).toContain('const privateContainer = new NeoContainer');
    expect(codeNone).not.toContain('export');

    // Test undefined (defaults to export for backward compatibility)
    const graphUndefined: DependencyGraph = {
      containerId: "TestContainer", nodes: new Map([
        ['Service', createMockNode('Service', [], 'S', '/src/s.ts')]
      ]),
      roots: [],
      exportedVariableName: 'legacyContainer'
    };
    const codeUndefined = new Generator(graphUndefined).generate();
    expect(codeUndefined).toContain('export const legacyContainer = new NeoContainer');
  });

  it('should handle export default without variable name', () => {
    // When user writes: export default defineBuilderConfig({ ... })
    // We should generate: export default new NeoContainer(...)
    const graph: DependencyGraph = {
      containerId: "TestContainer", nodes: new Map([
        ['Service', createMockNode('Service', [], 'S', '/src/s.ts')]
      ]),
      roots: [],
      variableExportModifier: 'export default'
      // Note: no exportedVariableName
    };
    const code = new Generator(graph).generate();
    expect(code).toContain('export default new NeoContainer');
    expect(code).not.toContain('const container =');
  });

  describe('default export class', () => {
    // Creates a symbol whose getName() returns 'default' but whose declaration
    // is a ClassDeclaration with name.text = className. This matches what
    // TypeScript produces for: export default class Login {}
    function createDefaultExportSymbol(className: string): ts.Symbol {
      const classDecl = {
        kind: ts.SyntaxKind.ClassDeclaration,
        name: { text: className },
        getSourceFile: () => ({ fileName: '/src/login.ts' }),
      };
      return {
        getName: () => 'default',
        declarations: [classDecl],
      } as unknown as ts.Symbol;
    }

    function makeDefaultExportGraph(depName: string, depSymbolName: string): DependencyGraph {
      return {
        containerId: 'Test',
        nodes: new Map([
          ['ILogin', {
            service: {
              tokenId: 'ILogin',
              implementationSymbol: createDefaultExportSymbol('Login'),
              registrationNode: {} as ts.Node,
              type: 'explicit',
              lifecycle: 'singleton',
            } as ServiceDefinition,
            dependencies: [depName],
          }],
          [depName, createMockNode(depName, [], depSymbolName, '/src/dep.ts')],
        ]),
        roots: ['ILogin'],
      };
    }

    it('useDirectSymbolNames=true: uses class name instead of "default" in new expression', () => {
      const graph = makeDefaultExportGraph('IRepo', 'Repo');
      const code = new Generator(graph, true).generate();

      // Must NOT generate invalid `new default(...)`
      expect(code).not.toContain('new default(');
      // Must use the class name from the declaration
      expect(code).toContain('new Login(');
    });

    it('useDirectSymbolNames=false: generates valid Import_N.default accessor', () => {
      const graph = makeDefaultExportGraph('IRepo', 'Repo');
      const code = new Generator(graph, false, '/src').generate();

      // namespace import path: Import_N.default is valid JS (property, not identifier)
      expect(code).toContain('Import_');
      expect(code).not.toContain('new default(');
    });

    it('anonymous default export: falls back gracefully', () => {
      // export default class {} — no class name
      const anonymousSymbol = {
        getName: () => 'default',
        declarations: [{
          kind: ts.SyntaxKind.ClassDeclaration,
          name: undefined,  // anonymous
          getSourceFile: () => ({ fileName: '/src/anon.ts' }),
        }],
      } as unknown as ts.Symbol;

      const graph: DependencyGraph = {
        containerId: 'Test',
        nodes: new Map([
          ['IAnon', {
            service: {
              tokenId: 'IAnon',
              implementationSymbol: anonymousSymbol,
              registrationNode: {} as ts.Node,
              type: 'explicit',
              lifecycle: 'singleton',
            } as ServiceDefinition,
            dependencies: [],
          }],
        ]),
        roots: ['IAnon'],
      };

      // Should not throw — anonymous default exports are an edge case
      expect(() => new Generator(graph, true).generate()).not.toThrow();
    });
  });
});
