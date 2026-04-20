import { describe, it, expect } from 'vitest';
import * as ts from 'typescript';
import { Generator } from '../../src/generator/Generator';
import { DependencyGraph, DependencyNode, ServiceDefinition } from '../../src/analyzer/types';

function mockNode(): ts.Node {
  return { getSourceFile: () => ({ fileName: '' }) } as unknown as ts.Node;
}

function classNode(tokenId: string, opts: { isDisposable?: boolean; isAsyncDisposable?: boolean; lifecycle?: 'singleton' | 'transient' } = {}): DependencyNode {
  const implSymbol = {
    getName: () => tokenId,
    declarations: [{ getSourceFile: () => ({ fileName: '/src/test.ts' }) }],
  } as unknown as ts.Symbol;
  return {
    service: {
      tokenId,
      implementationSymbol: implSymbol,
      registrationNode: mockNode(),
      type: 'explicit',
      lifecycle: opts.lifecycle ?? 'singleton',
      isInterfaceToken: false,
      isDisposable: opts.isDisposable,
      isAsyncDisposable: opts.isAsyncDisposable,
    } as ServiceDefinition,
    dependencies: [],
  };
}

describe('Generator - disposable', () => {
  it('should call dispose() in destroy() for sync disposable singletons', () => {
    const graph: DependencyGraph = {
      containerId: 'Test',
      nodes: new Map([
        ['DbConnection', classNode('DbConnection', { isDisposable: true })],
      ]),
      roots: [],
    };

    const code = new Generator(graph, true).generate();

    expect(code).toContain('destroy()');
    expect(code).toContain('.dispose()');
    expect(code).toContain('instances.has(');
    // Should NOT be async
    expect(code).not.toContain('async destroy()');
  });

  it('should emit async destroy() when any singleton has isAsyncDisposable', () => {
    const graph: DependencyGraph = {
      containerId: 'Test',
      nodes: new Map([
        ['RedisClient', classNode('RedisClient', { isAsyncDisposable: true })],
      ]),
      roots: [],
    };

    const code = new Generator(graph, true).generate();

    expect(code).toContain('async destroy()');
    expect(code).toContain('await');
    expect(code).toContain('.dispose()');
  });

  it('should NOT call dispose() on transient disposable services', () => {
    const graph: DependencyGraph = {
      containerId: 'Test',
      nodes: new Map([
        ['RequestScope', classNode('RequestScope', { isDisposable: true, lifecycle: 'transient' })],
      ]),
      roots: [],
    };

    const code = new Generator(graph, true).generate();

    // destroy() should not mention dispose for transients
    const destroySection = code.split('destroy()')[1]?.split('this.instances.clear()')[0] ?? '';
    expect(destroySection).not.toContain('.dispose()');
  });

  it('should call dispose() in reverse dependency order', () => {
    // B depends on A, so A is created first → dispose order: B then A
    const implA = {
      getName: () => 'ServiceA',
      declarations: [{ getSourceFile: () => ({ fileName: '/src/a.ts' }) }],
    } as unknown as ts.Symbol;
    const implB = {
      getName: () => 'ServiceB',
      declarations: [{ getSourceFile: () => ({ fileName: '/src/b.ts' }) }],
    } as unknown as ts.Symbol;

    const graph: DependencyGraph = {
      containerId: 'Test',
      nodes: new Map([
        ['ServiceA', {
          service: {
            tokenId: 'ServiceA', implementationSymbol: implA,
            registrationNode: mockNode(), type: 'explicit',
            lifecycle: 'singleton', isDisposable: true,
          } as ServiceDefinition,
          dependencies: [],
        }],
        ['ServiceB', {
          service: {
            tokenId: 'ServiceB', implementationSymbol: implB,
            registrationNode: mockNode(), type: 'explicit',
            lifecycle: 'singleton', isDisposable: true,
          } as ServiceDefinition,
          dependencies: ['ServiceA'],
        }],
      ]),
      roots: [],
    };

    const code = new Generator(graph, true).generate();

    const destroySection = code.split('destroy()')[1]?.split('this.instances.clear()')[0] ?? '';
    const posA = destroySection.indexOf('ServiceA');
    const posB = destroySection.indexOf('ServiceB');
    // B should be disposed before A
    expect(posB).toBeLessThan(posA);
  });

  it('should NOT emit dispose calls for non-disposable services', () => {
    const graph: DependencyGraph = {
      containerId: 'Test',
      nodes: new Map([
        ['SimpleService', classNode('SimpleService')],
      ]),
      roots: [],
    };

    const code = new Generator(graph, true).generate();

    expect(code).not.toContain('.dispose()');
    expect(code).not.toContain('async destroy()');
  });
});
