import { describe, it, expect } from 'vitest';
import * as ts from 'typescript';
import { Generator } from '../../src/generator/Generator';
import { DependencyGraph, DependencyNode, ServiceDefinition } from '../../src/analyzer/types';

function mockNode(): ts.Node {
  return { getSourceFile: () => ({ fileName: '' }) } as unknown as ts.Node;
}

function asyncFactoryNode(tokenId: string, factorySource: string): DependencyNode {
  return {
    service: {
      tokenId,
      registrationNode: mockNode(),
      type: 'factory',
      lifecycle: 'singleton',
      isInterfaceToken: true,
      factorySource,
      isAsync: true,
    } as ServiceDefinition,
    dependencies: [],
  };
}

function syncFactoryNode(tokenId: string, factorySource: string): DependencyNode {
  return {
    service: {
      tokenId,
      registrationNode: mockNode(),
      type: 'factory',
      lifecycle: 'singleton',
      isInterfaceToken: true,
      factorySource,
      isAsync: undefined,
    } as ServiceDefinition,
    dependencies: [],
  };
}

describe('Generator - async factories', () => {
  it('should generate initialize() when any factory is async', () => {
    const graph: DependencyGraph = {
      containerId: 'Test',
      nodes: new Map([
        ['IDatabase_abc', asyncFactoryNode('IDatabase_abc', 'async () => createPool()')],
      ]),
      roots: [],
    };

    const code = new Generator(graph).generate();

    expect(code).toContain('public async initialize(): Promise<void>');
    expect(code).toContain('await this.create_IDatabase_abc()');
    expect(code).toContain('this.instances.set("IDatabase_abc"');
    expect(code).toContain('this._initialized = true');
  });

  it('should add _initialized guard to resolve()', () => {
    const graph: DependencyGraph = {
      containerId: 'Test',
      nodes: new Map([
        ['IDatabase_abc', asyncFactoryNode('IDatabase_abc', 'async () => createPool()')],
      ]),
      roots: [],
    };

    const code = new Generator(graph).generate();

    expect(code).toContain('private _initialized = false');
    expect(code).toContain('if (!this._initialized)');
    expect(code).toContain('initialize()');
  });

  it('should NOT generate initialize() when all factories are sync', () => {
    const graph: DependencyGraph = {
      containerId: 'Test',
      nodes: new Map([
        ['ILogger_abc', syncFactoryNode('ILogger_abc', '() => ({ log: () => {} })')],
      ]),
      roots: [],
    };

    const code = new Generator(graph).generate();

    expect(code).not.toContain('async initialize()');
    expect(code).not.toContain('_initialized');
  });

  it('should pre-initialize async singletons in topological order in initialize()', () => {
    const graph: DependencyGraph = {
      containerId: 'Test',
      nodes: new Map([
        ['IDatabase_abc', asyncFactoryNode('IDatabase_abc', 'async () => createPool()')],
        ['ICache_def', asyncFactoryNode('ICache_def', 'async (c) => createRedis()')],
      ]),
      roots: [],
    };

    const code = new Generator(graph).generate();

    expect(code).toContain('await this.create_IDatabase_abc()');
    expect(code).toContain('await this.create_ICache_def()');
  });

  it('should not pre-initialize sync services in initialize()', () => {
    const implSymbol = {
      getName: () => 'LoggerService',
      declarations: [{ getSourceFile: () => ({ fileName: '/src/logger.ts' }) }],
    } as unknown as ts.Symbol;

    const graph: DependencyGraph = {
      containerId: 'Test',
      nodes: new Map([
        ['IDatabase_abc', asyncFactoryNode('IDatabase_abc', 'async () => createPool()')],
        ['ILogger_def', {
          service: {
            tokenId: 'ILogger_def',
            implementationSymbol: implSymbol,
            registrationNode: mockNode(),
            type: 'explicit',
            lifecycle: 'singleton',
            isInterfaceToken: true,
          } as ServiceDefinition,
          dependencies: [],
        }],
      ]),
      roots: [],
    };

    const code = new Generator(graph, true).generate();

    const initMethod = code.split('async initialize()')[1]?.split('public resolve')[0] ?? '';
    expect(initMethod).toContain('IDatabase_abc');
    expect(initMethod).not.toContain('ILogger_def');
  });
});
