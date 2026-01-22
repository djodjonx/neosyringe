import { describe, it, expect } from 'vitest';
import { Generator } from '../../src/generator/Generator';
import { DependencyGraph, DependencyNode, ServiceDefinition } from '../../src/analyzer/types';
import * as ts from 'typescript';

// Mock helpers
function createMockSymbol(name: string, filePath: string): ts.Symbol {
  return {
    getName: () => name,
    declarations: [
      { getSourceFile: () => ({ fileName: filePath }) }
    ]
  } as any;
}

function createNode(
    id: string,
    implName: string,
    deps: string[] = [],
    isInterface = false
): DependencyNode {
  return {
    service: {
      tokenId: id,
      implementationSymbol: createMockSymbol(implName, '/src/file.ts'),
      type: 'explicit',
      lifecycle: 'singleton',
      isInterfaceToken: isInterface
    } as ServiceDefinition,
    dependencies: deps
  };
}

describe('Generator - Declarative Config', () => {
  it('should generate container handling both Class and Interface tokens', () => {
    const graph: DependencyGraph = {
      containerId: "TestContainer", nodes: new Map([
        // Interface Token: "ILogger" (String ID) -> ConsoleLogger (Class)
        ['ILogger', createNode('ILogger', 'ConsoleLogger', [], true)],
        // Class Token: "UserService" (Class ID) -> UserService (Class) depends on "ILogger"
        ['UserService', createNode('UserService', 'UserService', ['ILogger'], false)]
      ]),
      roots: [],
      containerName: 'TestContainer'
    };

    const generator = new Generator(graph);
    const code = generator.generate();

    // 1. Check Imports
    expect(code).toContain(`import * as Import_0 from '/src/file.ts';`);

    // 2. Check Factories
    // create_ILogger -> new ConsoleLogger()
    expect(code).toContain('private create_ILogger(): any {');
    expect(code).toContain('return new Import_0.ConsoleLogger();');

    // create_UserService -> new UserService(resolve("ILogger"))
    expect(code).toContain('private create_UserService(): any {');
    // For interface token, we expect the STRING literal "ILogger" to be passed
    expect(code).toContain('this.resolve("ILogger")');

    // 3. Check Resolve Switch
    // If token === "full_tokenId" || token === "ILogger"
    expect(code).toContain('token === "ILogger"');

    // If token === UserService
    expect(code).toContain('if (token === Import_0.UserService)');
  });
});
