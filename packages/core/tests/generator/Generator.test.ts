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
    // TypeScript produces for: export default class AuthService {}
    // (the 'default' export symbol has name "default", not the class name).
    function createDefaultExportSymbol(className: string, fileName = '/src/auth.ts'): ts.Symbol {
      const classDecl = {
        kind: ts.SyntaxKind.ClassDeclaration,
        name: { text: className },
        getSourceFile: () => ({ fileName }),
      };
      return {
        getName: () => 'default',
        declarations: [classDecl],
      } as unknown as ts.Symbol;
    }

    function makeDefaultExportGraph(
      depName: string,
      depSymbolName: string,
      implLocalName?: string
    ): DependencyGraph {
      const implSymbol = createDefaultExportSymbol('AuthService');
      return {
        containerId: 'Test',
        nodes: new Map([
          ['IAuth', {
            service: {
              tokenId: 'IAuth',
              implementationSymbol: implSymbol,
              registrationNode: {} as ts.Node,
              type: 'explicit',
              lifecycle: 'singleton',
              implementationLocalName: implLocalName,
            } as ServiceDefinition,
            dependencies: [depName],
          }],
          [depName, createMockNode(depName, [], depSymbolName, '/src/dep.ts')],
        ]),
        roots: ['IAuth'],
      };
    }

    it('useDirectSymbolNames=true: uses Import_N.default for default exports', () => {
      // Scenario: export default class AuthService {} imported as `import Auth from './AuthService'`
      // A namespace import `import * as Import_0 from './...'` + `Import_0.default` is generated.
      // This is bundler-safe: rolldown tracks explicit import declarations correctly, whereas
      // local alias references (like `Login`) can be missed when the bundler renames/inlines modules.
      const graph = makeDefaultExportGraph('IRepo', 'Repo', 'Auth');
      const code = new Generator(graph, true).generate();

      expect(code).not.toContain('new default(');
      expect(code).not.toContain('new AuthService(');
      expect(code).not.toContain('new Auth('); // raw local alias not used
      expect(code).not.toContain('__neo_');    // no capture variable pattern
      // Uses namespace import accessor — self-contained reference
      expect(code).toContain('import * as Import_');
      expect(code).toContain('.default');
    });

    it('useDirectSymbolNames=true: falls back to class declaration name when no local name', () => {
      // When implementationLocalName is absent (e.g. class name === import alias),
      // fall back to the class declaration name from the symbol.
      const graph = makeDefaultExportGraph('IRepo', 'Repo', undefined);
      const code = new Generator(graph, true).generate();

      expect(code).not.toContain('new default(');
      // Falls back to decl.name.text = "AuthService"
      expect(code).toContain('new AuthService(');
    });

    it('useDirectSymbolNames=false: generates valid Import_N.default accessor', () => {
      const graph = makeDefaultExportGraph('IRepo', 'Repo', 'Auth');
      const code = new Generator(graph, false, '/src').generate();

      // namespace import path: new Import_N.default() is valid JS (property access, not identifier)
      expect(code).toContain('Import_');
      expect(code).not.toContain('new default(');
    });

    it('anonymous default export: falls back gracefully', () => {
      // export default class {} — no class name
      const anonymousSymbol = {
        getName: () => 'default',
        declarations: [{
          kind: ts.SyntaxKind.ClassDeclaration,
          name: undefined,
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

    it('tokenLocalName: used for this.resolve() when token is a default export', () => {
      // Scenario: { token: Auth } autowire where Auth is `import Auth from './AuthService'`
      // The token key in this.resolve() must use "Auth", not "AuthService" or "default".
      const authSymbol = createDefaultExportSymbol('AuthService');
      const graph: DependencyGraph = {
        containerId: 'Test',
        nodes: new Map([
          ['AuthService', {
            service: {
              tokenId: 'AuthService',
              implementationSymbol: authSymbol,
              tokenSymbol: authSymbol,
              registrationNode: {} as ts.Node,
              type: 'autowire',
              lifecycle: 'singleton',
              implementationLocalName: 'Auth',
              tokenLocalName: 'Auth',
            } as ServiceDefinition,
            dependencies: [],
          }],
        ]),
        roots: ['AuthService'],
      };

      const code = new Generator(graph, true).generate();

      expect(code).not.toContain('new default(');
      expect(code).not.toContain('__neo_');
      // Namespace import used consistently for new expression and token comparison
      expect(code).toContain('import * as Import_');
      expect(code).toContain('.default');
    });
  });
});
