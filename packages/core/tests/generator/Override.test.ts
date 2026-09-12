import { describe, it, expect, afterEach } from 'vitest';
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

  describe('disabled in production', () => {
    // A container is commonly a long-lived, process-wide singleton — an
    // override left in by mistake (or reachable from somewhere it shouldn't
    // be) would silently change what every caller gets for as long as the
    // process runs. override() must fail loudly instead in production.
    const originalNodeEnv = process.env.NODE_ENV;
    afterEach(() => {
      process.env.NODE_ENV = originalNodeEnv;
    });

    it('throws when NODE_ENV=production', () => {
      const container = buildContainer();
      process.env.NODE_ENV = 'production';
      expect(() => container.override('ILogger_abc123', () => 'mock-logger')).toThrow(
        /override\(\) is a testing utility and is disabled when NODE_ENV=production/
      );
    });

    it('does not affect the real registration when the throw is caught', () => {
      const container = buildContainer();
      process.env.NODE_ENV = 'production';
      expect(() => container.override('ILogger_abc123', () => 'mock-logger')).toThrow();
      process.env.NODE_ENV = originalNodeEnv;
      expect(container.resolve('ILogger_abc123')).toBe('real-logger');
    });

    it('works normally outside production (e.g. NODE_ENV=test)', () => {
      const container = buildContainer();
      process.env.NODE_ENV = 'test';
      expect(() => container.override('ILogger_abc123', () => 'mock-logger')).not.toThrow();
      expect(container.resolve('ILogger_abc123')).toBe('mock-logger');
    });
  });
});
