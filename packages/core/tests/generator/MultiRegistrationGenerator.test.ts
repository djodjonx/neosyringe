import { describe, it, expect } from 'vitest';
import * as ts from 'typescript';
import { Generator } from '../../src/generator/Generator';
import { DependencyGraph, DependencyNode, ServiceDefinition } from '../../src/analyzer/types';

function mockNode(): ts.Node {
  return { getSourceFile: () => ({ fileName: '' }) } as unknown as ts.Node;
}

function classNode(tokenId: string, implName: string, filePath: string): DependencyNode {
  return {
    service: {
      tokenId,
      implementationSymbol: {
        getName: () => implName,
        declarations: [{ getSourceFile: () => ({ fileName: filePath }) }],
      } as unknown as ts.Symbol,
      registrationNode: mockNode(),
      type: 'explicit',
      lifecycle: 'singleton',
      isInterfaceToken: true,
    } as ServiceDefinition,
    dependencies: [],
  };
}

describe('Generator - resolveAll', () => {
  it('should generate indexed factories for multi-nodes', () => {
    const tokenId = 'IMiddleware_abc';
    const graph: DependencyGraph = {
      containerId: 'Test',
      nodes: new Map(),
      roots: [],
      multiNodes: new Map([
        [tokenId, [
          classNode(tokenId, 'AuthMiddleware', '/src/auth.ts'),
          classNode(tokenId, 'LogMiddleware', '/src/log.ts'),
        ]],
      ]),
    };

    const code = new Generator(graph).generate();

    expect(code).toContain('create_IMiddleware_abc_0');
    expect(code).toContain('create_IMiddleware_abc_1');
    expect(code).toContain('new Import_0.AuthMiddleware()');
    expect(code).toContain('new Import_1.LogMiddleware()');
  });

  it('should generate resolveAll() method', () => {
    const tokenId = 'IPlugin_def';
    const graph: DependencyGraph = {
      containerId: 'Test',
      nodes: new Map(),
      roots: [],
      multiNodes: new Map([
        [tokenId, [
          classNode(tokenId, 'PluginA', '/src/a.ts'),
          classNode(tokenId, 'PluginB', '/src/b.ts'),
        ]],
      ]),
    };

    const code = new Generator(graph).generate();

    expect(code).toContain('public resolveAll<T>(token: any): T[]');
    expect(code).toContain('"IPlugin_def"');
    expect(code).toContain('this.create_IPlugin_def_0()');
    expect(code).toContain('this.create_IPlugin_def_1()');
  });

  it('should cache singleton multi-node instances across resolveAll calls', () => {
    const tokenId = 'IService_ghi';
    const graph: DependencyGraph = {
      containerId: 'Test',
      nodes: new Map(),
      roots: [],
      multiNodes: new Map([
        [tokenId, [
          classNode(tokenId, 'ServiceA', '/src/a.ts'),
          classNode(tokenId, 'ServiceB', '/src/b.ts'),
        ]],
      ]),
    };

    const code = new Generator(graph).generate();

    // Singleton: should use instance cache with composite key
    expect(code).toContain('"IService_ghi:0"');
    expect(code).toContain('"IService_ghi:1"');
    expect(code).toContain('this.instances.has(k)');
  });

  it('should return empty array for unknown token in resolveAll', () => {
    const graph: DependencyGraph = {
      containerId: 'Test',
      nodes: new Map(),
      roots: [],
      multiNodes: new Map([
        ['IPlugin_def', [classNode('IPlugin_def', 'PluginA', '/src/a.ts')]],
      ]),
    };

    const code = new Generator(graph).generate();

    expect(code).toContain('return [];');
  });

  it('should use per-node lifecycle for mixed-lifecycle multi-registrations', () => {
    const tokenId = 'IPlugin_mix';
    const singletonNode = classNode(tokenId, 'PluginSingleton', '/src/singleton.ts');
    const transientNode = {
      ...classNode(tokenId, 'PluginTransient', '/src/transient.ts'),
      service: {
        ...classNode(tokenId, 'PluginTransient', '/src/transient.ts').service,
        lifecycle: 'transient' as const,
      },
    };

    const graph: DependencyGraph = {
      containerId: 'Test',
      nodes: new Map(),
      roots: [],
      multiNodes: new Map([[tokenId, [singletonNode, transientNode]]]),
    };

    const code = new Generator(graph).generate();

    // Node 0 (singleton): should use instance cache
    expect(code).toContain('"IPlugin_mix:0"');
    expect(code).toContain('this.instances.has(k)');

    // Node 1 (transient): should call factory directly without caching
    expect(code).toContain('this.create_IPlugin_mix_1()');
    // Verify the transient call is NOT inside instance-cache logic
    // (the cache key for index 1 should NOT appear)
    expect(code).not.toContain('"IPlugin_mix:1"');
  });
});
