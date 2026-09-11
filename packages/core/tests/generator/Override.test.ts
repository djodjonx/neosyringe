import { describe, it, expect } from 'vitest';
import * as ts from 'typescript';
import { Generator } from '../../src/generator/Generator';
import { DependencyGraph, ServiceDefinition } from '../../src/analyzer/types';

/**
 * container.override(token, factory) — lets tests swap a registration without
 * rebuilding a whole separate defineBuilderConfig(). These tests actually
 * execute the generated code (transpiled to plain JS) rather than just
 * string-matching, since override/caching is genuinely runtime behavior that
 * a string assertion can't prove.
 */
describe('Generator — container.override() (executed, not just string-matched)', () => {
  /** Builds and runs a minimal container with one interface-token value registration. */
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

    // useDirectSymbolNames=false: emits `export const container = new NeoContainer(...)`
    // at the end (inline mode leaves that to the caller replacing the original
    // defineBuilderConfig() call, so it wouldn't produce anything to instantiate here).
    const tsCode = new Generator(graph, false).generate();
    const jsCode = ts.transpileModule(tsCode, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText;

    const module = { exports: {} as any };
    // eslint-disable-next-line no-new-func
    new Function('module', 'exports', 'require', jsCode)(module, module.exports, () => ({}));
    return module.exports.container;
  }

  it('resolves the real registration when not overridden', () => {
    const container = buildContainer();
    expect(container.resolve('ILogger_abc123')).toBe('real-logger');
  });

  it('override() replaces the resolved value', () => {
    const container = buildContainer();
    container.override('ILogger_abc123', () => 'mock-logger');
    expect(container.resolve('ILogger_abc123')).toBe('mock-logger');
  });

  it('override() caches the factory result — same instance across resolves', () => {
    const container = buildContainer();
    let calls = 0;
    container.override('ILogger_abc123', () => ({ id: ++calls }));
    const first = container.resolve('ILogger_abc123');
    const second = container.resolve('ILogger_abc123');
    expect(first).toBe(second);
    expect(calls).toBe(1);
  });

  it('override() invalidates a previously cached real instance', () => {
    const container = buildContainer();
    expect(container.resolve('ILogger_abc123')).toBe('real-logger'); // cache the real one first
    container.override('ILogger_abc123', () => 'mock-logger');
    expect(container.resolve('ILogger_abc123')).toBe('mock-logger'); // not the stale cached real value
  });

  it('clearOverrides() reverts to the real registration', () => {
    const container = buildContainer();
    container.override('ILogger_abc123', () => 'mock-logger');
    container.clearOverrides();
    expect(container.resolve('ILogger_abc123')).toBe('real-logger');
  });

  it('destroy() also clears overrides', () => {
    const container = buildContainer();
    container.override('ILogger_abc123', () => 'mock-logger');
    container.destroy();
    expect(container.resolve('ILogger_abc123')).toBe('real-logger');
  });
});
