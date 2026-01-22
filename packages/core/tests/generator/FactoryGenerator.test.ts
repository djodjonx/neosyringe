import { describe, it, expect } from 'vitest';
import { Generator } from '../../src/generator/Generator';
import { DependencyGraph, DependencyNode } from '../../src/analyzer/types';

describe('Generator - Factory Support', () => {
  const createMockSymbol = (name: string) => ({
    getName: () => name,
    declarations: [{
      getSourceFile: () => ({ fileName: '/mock/path.ts' })
    }]
  }) as any;

  it('should generate code for factory provider', () => {
    const graph: DependencyGraph = {
      containerId: "TestContainer", nodes: new Map<string, DependencyNode>([
        ['IConfig', {
          service: {
            tokenId: 'IConfig',
            registrationNode: {} as any,
            type: 'factory',
            lifecycle: 'singleton',
            isInterfaceToken: true,
            isFactory: true,
            factorySource: '(container) => ({ apiUrl: "http://example.com" })'
          },
          dependencies: []
        }]
      ]),
      roots: ['IConfig']
    };

    const generator = new Generator(graph);
    const code = generator.generate();

    // Should contain the factory wrapper
    expect(code).toContain('private create_IConfig(): any');
    expect(code).toContain('const userFactory =');
    expect(code).toContain('apiUrl');
    expect(code).toContain('return userFactory(this)');

    // Should resolve with string token for interface
    expect(code).toContain('token === "IConfig"');
  });

  it('should generate singleton logic for factory', () => {
    const graph: DependencyGraph = {
      containerId: "TestContainer", nodes: new Map<string, DependencyNode>([
        ['IDatabase', {
          service: {
            tokenId: 'IDatabase',
            registrationNode: {} as any,
            type: 'factory',
            lifecycle: 'singleton',
            isInterfaceToken: true,
            isFactory: true,
            factorySource: '() => ({ query: () => [] })'
          },
          dependencies: []
        }]
      ]),
      roots: ['IDatabase']
    };

    const generator = new Generator(graph);
    const code = generator.generate();

    // Should have singleton check
    expect(code).toContain('this.instances.has("IDatabase")');
    expect(code).toContain('this.instances.set("IDatabase"');
    expect(code).toContain('this.instances.get("IDatabase")');
  });

  it('should generate transient logic for factory', () => {
    const graph: DependencyGraph = {
      containerId: "TestContainer", nodes: new Map<string, DependencyNode>([
        ['IRequest', {
          service: {
            tokenId: 'IRequest',
            registrationNode: {} as any,
            type: 'factory',
            lifecycle: 'transient',
            isInterfaceToken: true,
            isFactory: true,
            factorySource: '() => ({ id: Math.random() })'
          },
          dependencies: []
        }]
      ]),
      roots: ['IRequest']
    };

    const generator = new Generator(graph);
    const code = generator.generate();

    // Transient should not use instances Map
    expect(code).toContain('return this.create_IRequest()');
    expect(code).not.toContain('this.instances.has("IRequest")');
  });

  it('should generate correct code for class (not factory)', () => {
    const graph: DependencyGraph = {
      containerId: "TestContainer", nodes: new Map<string, DependencyNode>([
        ['UserService', {
          service: {
            tokenId: 'UserService',
            implementationSymbol: createMockSymbol('UserService'),
            tokenSymbol: createMockSymbol('UserService'),
            registrationNode: {} as any,
            type: 'autowire',
            lifecycle: 'singleton',
            isFactory: false
          },
          dependencies: []
        }]
      ]),
      roots: ['UserService']
    };

    const generator = new Generator(graph);
    const code = generator.generate();

    // Should use new keyword for class
    expect(code).toContain('new Import_0.UserService()');
  });

  it('should mix factories and classes in same container', () => {
    const graph: DependencyGraph = {
      containerId: "TestContainer", nodes: new Map<string, DependencyNode>([
        ['IConfig', {
          service: {
            tokenId: 'IConfig',
            registrationNode: {} as any,
            type: 'factory',
            lifecycle: 'singleton',
            isInterfaceToken: true,
            isFactory: true,
            factorySource: '() => ({ env: "prod" })'
          },
          dependencies: []
        }],
        ['AppService', {
          service: {
            tokenId: 'AppService',
            implementationSymbol: createMockSymbol('AppService'),
            tokenSymbol: createMockSymbol('AppService'),
            registrationNode: {} as any,
            type: 'autowire',
            lifecycle: 'singleton',
            isFactory: false
          },
          dependencies: ['IConfig']
        }]
      ]),
      roots: ['AppService']
    };

const generator = new Generator(graph);
    const code = generator.generate();

    // Should have factory for IConfig
    expect(code).toContain('private create_IConfig');
    expect(code).toContain('const userFactory =');

    // Should have class instantiation for AppService
    expect(code).toContain('private create_AppService');
    expect(code).toContain('new Import_0.AppService');

    // AppService should resolve IConfig dependency
    expect(code).toContain('this.resolve("IConfig")');
  });
});

