import { describe, it, expect } from 'vitest';
import * as ts from 'typescript';
import { Generator } from '../../src/generator/Generator';
import { DependencyGraph, DependencyNode, ServiceDefinition } from '../../src/analyzer/types';

function mockNode(): ts.Node {
  return { getSourceFile: () => ({ fileName: '' }) } as unknown as ts.Node;
}

function valueNode(tokenId: string, valueSource: string): DependencyNode {
  return {
    service: {
      tokenId,
      registrationNode: mockNode(),
      type: 'value',
      lifecycle: 'singleton',
      isInterfaceToken: true,
      valueSource,
    } as ServiceDefinition,
    dependencies: [],
  };
}

describe('Generator - useValue', () => {
  it('should emit return <valueSource> for value registrations', () => {
    const graph: DependencyGraph = {
      containerId: 'Test',
      nodes: new Map([
        ['DatabaseConfig_abc', valueNode('DatabaseConfig_abc', "{ url: 'localhost', port: 5432 }")],
      ]),
      roots: [],
    };

    const code = new Generator(graph).generate();

    expect(code).toContain("private create_DatabaseConfig_abc(): any {");
    expect(code).toContain("return { url: 'localhost', port: 5432 };");
    expect(code).not.toContain('new undefined');
    expect(code).not.toContain('userFactory');
  });

  it('should cache value as singleton', () => {
    const graph: DependencyGraph = {
      containerId: 'Test',
      nodes: new Map([
        ['AppConfig_abc', valueNode('AppConfig_abc', '{ timeout: 3000 }')],
      ]),
      roots: [],
    };

    const code = new Generator(graph).generate();

    expect(code).toContain('this.instances.has("AppConfig_abc")');
    expect(code).toContain('this.instances.set("AppConfig_abc"');
  });

  it('should allow a service to depend on a useValue token', () => {
    const implSymbol = {
      getName: () => 'UserService',
      declarations: [{ getSourceFile: () => ({ fileName: '/src/user.ts' }) }],
    } as unknown as ts.Symbol;

    const graph: DependencyGraph = {
      containerId: 'Test',
      nodes: new Map([
        ['AppConfig_abc', valueNode('AppConfig_abc', '{ timeout: 3000 }')],
        ['UserService_def', {
          service: {
            tokenId: 'UserService_def',
            implementationSymbol: implSymbol,
            registrationNode: mockNode(),
            type: 'explicit',
            lifecycle: 'singleton',
            isInterfaceToken: false,
          } as ServiceDefinition,
          dependencies: ['AppConfig_abc'],
        }],
      ]),
      roots: [],
    };

    const code = new Generator(graph).generate();

    expect(code).toContain('return new Import_0.UserService(this.resolve("AppConfig_abc"))');
  });
});
