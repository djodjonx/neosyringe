import { describe, it, expect } from 'vitest';
import * as ts from 'typescript';
import { Generator } from '../../src/generator/Generator';
import { DependencyGraph, ServiceDefinition } from '../../src/analyzer/types';

/**
 * container.on('resolve', listener) — a per-instance hook for cross-cutting
 * concerns (logging, tracing, timing) fired on every successful resolve(),
 * whether served from cache, freshly created, an override, or a parent/legacy
 * container. These tests actually execute the generated code (transpiled to
 * plain JS), since notification/unsubscribe semantics are runtime behavior a
 * string assertion can't prove.
 */
describe('Generator — container.on(\'resolve\', ...) (executed, not just string-matched)', () => {
  function buildContainer(): any {
    const service: ServiceDefinition = {
      tokenId: 'ILogger_abc123',
      type: 'value',
      valueSource: '"real-logger"',
      lifecycle: 'singleton',
      isInterfaceToken: true,
      registrationNode: {} as ts.Node,
    };
    const graph: DependencyGraph = {
      containerId: 'Test',
      nodes: new Map([['ILogger_abc123', { service, dependencies: [] }]]),
      roots: ['ILogger_abc123'],
      exportedVariableName: 'container',
      variableExportModifier: 'export',
    };

    const tsCode = new Generator(graph, false).generate();
    const jsCode = ts.transpileModule(tsCode, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText;

    const module = { exports: {} as any };
    // eslint-disable-next-line no-new-func
    new Function('module', 'exports', 'require', jsCode)(module, module.exports, () => ({}));
    return module.exports.container;
  }

  it('fires the listener with (token, instance) on a fresh resolve', () => {
    const container = buildContainer();
    const calls: Array<[any, any]> = [];
    container.on('resolve', (token: any, instance: any) => calls.push([token, instance]));

    const result = container.resolve('ILogger_abc123');

    expect(calls).toEqual([['ILogger_abc123', 'real-logger']]);
    expect(result).toBe('real-logger');
  });

  it('fires again on a cache-hit resolve (same instance)', () => {
    const container = buildContainer();
    const calls: any[] = [];
    container.on('resolve', () => calls.push(1));

    container.resolve('ILogger_abc123');
    container.resolve('ILogger_abc123');

    expect(calls).toHaveLength(2);
  });

  it('fires for an overridden token too', () => {
    const container = buildContainer();
    const calls: Array<[any, any]> = [];
    container.on('resolve', (token: any, instance: any) => calls.push([token, instance]));

    container.override('ILogger_abc123', () => 'mock-logger');
    container.resolve('ILogger_abc123');

    expect(calls).toEqual([['ILogger_abc123', 'mock-logger']]);
  });

  it('supports multiple listeners', () => {
    const container = buildContainer();
    let a = 0;
    let b = 0;
    container.on('resolve', () => a++);
    container.on('resolve', () => b++);

    container.resolve('ILogger_abc123');

    expect(a).toBe(1);
    expect(b).toBe(1);
  });

  it('the returned unsubscribe function stops future notifications', () => {
    const container = buildContainer();
    const calls: any[] = [];
    const unsubscribe = container.on('resolve', () => calls.push(1));

    container.resolve('ILogger_abc123');
    unsubscribe();
    container.resolve('ILogger_abc123');

    expect(calls).toHaveLength(1);
  });

  it('a throwing listener does not break resolve() or stop other listeners', () => {
    const container = buildContainer();
    const calls: any[] = [];
    container.on('resolve', () => { throw new Error('boom'); });
    container.on('resolve', () => calls.push('ok'));

    const result = container.resolve('ILogger_abc123');

    expect(result).toBe('real-logger');
    expect(calls).toEqual(['ok']);
  });

  it('destroy() clears listeners', () => {
    const container = buildContainer();
    const calls: any[] = [];
    container.on('resolve', () => calls.push(1));

    container.destroy();
    container.resolve('ILogger_abc123');

    expect(calls).toHaveLength(0);
  });
});
