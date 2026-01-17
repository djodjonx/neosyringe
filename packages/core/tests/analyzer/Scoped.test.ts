/**
 * Tests for scoped: true functionality
 *
 * Allows overriding a token from a parent container
 * without causing a duplicate registration error.
 */
import { describe, it, expect } from 'vitest';
import * as ts from 'typescript';
import { Analyzer } from '../../src/analyzer/Analyzer';
import { GraphValidator } from '../../src/generator/GraphValidator';
import { Generator } from '../../src/generator/Generator';

describe('Scoped Injection', () => {
  const createProgram = (fileName: string, fileContent: string) => {
    const compilerHost = ts.createCompilerHost({});
    const originalGetSourceFile = compilerHost.getSourceFile;

    compilerHost.getSourceFile = (name, languageVersion) => {
      if (name === fileName) {
        return ts.createSourceFile(fileName, fileContent, languageVersion);
      }
      return originalGetSourceFile(name, languageVersion);
    };

    return ts.createProgram([fileName], {}, compilerHost);
  };

  describe('Analyzer - scoped detection', () => {
    it('should detect scoped: true in injection', () => {
      const program = createProgram('scoped.ts', `
        function defineBuilderConfig(config: any) { return config; }
        function useInterface<T>(): any { return null; }

        interface ILogger {}
        class FileLogger implements ILogger {}

        export const c = defineBuilderConfig({
          injections: [
            { token: useInterface<ILogger>(), provider: FileLogger, scoped: true }
          ]
        });
      `);

      const analyzer = new Analyzer(program);
      const graph = analyzer.extract();

      // Find node containing ILogger (may have filename prefix)
      const node = Array.from(graph.nodes.values()).find(n =>
        n.service.tokenId.includes('ILogger')
      );
      expect(node).toBeDefined();
      expect(node!.service.isScoped).toBe(true);
    });

    it('should detect scoped: false (default) when not specified', () => {
      const program = createProgram('not-scoped.ts', `
        function defineBuilderConfig(config: any) { return config; }
        function useInterface<T>(): any { return null; }

        interface ILogger {}
        class ConsoleLogger implements ILogger {}

        export const c = defineBuilderConfig({
          injections: [
            { token: useInterface<ILogger>(), provider: ConsoleLogger }
          ]
        });
      `);

      const analyzer = new Analyzer(program);
      const graph = analyzer.extract();

      // Find node containing ILogger (may have filename prefix)
      const node = Array.from(graph.nodes.values()).find(n =>
        n.service.tokenId.includes('ILogger')
      );
      expect(node).toBeDefined();
      expect(node!.service.isScoped).toBeFalsy();
    });

    it('should allow duplicate registration when scoped: true in same container', () => {
      const program = createProgram('scoped-same.ts', `
        function defineBuilderConfig(config: any) { return config; }
        function useInterface<T>(): any { return null; }

        interface ILogger {}
        class FileLogger implements ILogger {}

        export const c = defineBuilderConfig({
          injections: [
            { token: useInterface<ILogger>(), provider: FileLogger, scoped: true },
            { token: useInterface<ILogger>(), provider: FileLogger, scoped: true }
          ]
        });
      `);

      const analyzer = new Analyzer(program);
      // Should not throw - second scoped: true overrides the first
      expect(() => analyzer.extract()).not.toThrow();
    });
  });

  describe('GraphValidator - scoped with parent', () => {
    it('should throw duplicate error without scoped: true', () => {
      const program = createProgram('duplicate.ts', `
        function defineBuilderConfig(config: any) { return config; }
        function useInterface<T>(): any { return null; }

        interface ILogger {}
        class ConsoleLogger implements ILogger {}
        class FileLogger implements ILogger {}

        const parent = defineBuilderConfig({
          injections: [{ token: useInterface<ILogger>(), provider: ConsoleLogger }]
        });

        export const c = defineBuilderConfig({
          useContainer: parent,
          injections: [
            { token: useInterface<ILogger>(), provider: FileLogger }
          ]
        });
      `);

      const analyzer = new Analyzer(program);
      const graph = analyzer.extract();
      const validator = new GraphValidator();

      expect(() => validator.validate(graph)).toThrow(/Duplicate registration.*ILogger.*parent/);
    });

    it('should NOT throw duplicate error with scoped: true', () => {
      const program = createProgram('scoped-override.ts', `
        function defineBuilderConfig(config: any) { return config; }
        function useInterface<T>(): any { return null; }

        interface ILogger {}
        class ConsoleLogger implements ILogger {}
        class FileLogger implements ILogger {}

        const parent = defineBuilderConfig({
          injections: [{ token: useInterface<ILogger>(), provider: ConsoleLogger }]
        });

        export const c = defineBuilderConfig({
          useContainer: parent,
          injections: [
            { token: useInterface<ILogger>(), provider: FileLogger, scoped: true }
          ]
        });
      `);

      const analyzer = new Analyzer(program);
      const graph = analyzer.extract();
      const validator = new GraphValidator();

      expect(() => validator.validate(graph)).not.toThrow();
    });

    it('should suggest scoped: true in error message', () => {
      const program = createProgram('suggest-scoped.ts', `
        function defineBuilderConfig(config: any) { return config; }
        function useInterface<T>(): any { return null; }

        interface ICache {}
        class RedisCache implements ICache {}
        class MemoryCache implements ICache {}

        const parent = defineBuilderConfig({
          injections: [{ token: useInterface<ICache>(), provider: RedisCache }]
        });

        export const c = defineBuilderConfig({
          useContainer: parent,
          injections: [
            { token: useInterface<ICache>(), provider: MemoryCache }
          ]
        });
      `);

      const analyzer = new Analyzer(program);
      const graph = analyzer.extract();
      const validator = new GraphValidator();

      try {
        validator.validate(graph);
        expect.fail('Should have thrown');
      } catch (e: any) {
        expect(e.message).toContain('scoped: true');
      }
    });
  });

  describe('Generator - scoped code generation', () => {
    it('should generate local factory for scoped token', () => {
      const program = createProgram('gen-scoped.ts', `
        function defineBuilderConfig(config: any) { return config; }
        function useInterface<T>(): any { return null; }

        interface ILogger {}
        class ConsoleLogger implements ILogger {}
        class FileLogger implements ILogger {}

        const parent = defineBuilderConfig({
          injections: [{ token: useInterface<ILogger>(), provider: ConsoleLogger }]
        });

        export const c = defineBuilderConfig({
          name: 'ChildContainer',
          useContainer: parent,
          injections: [
            { token: useInterface<ILogger>(), provider: FileLogger, scoped: true }
          ]
        });
      `);

      const analyzer = new Analyzer(program);
      const graph = analyzer.extract();

      // Skip validation for this test (it would throw duplicate without scoped handling in validator)
      // The generator should include the scoped token factory
      const generator = new Generator(graph);
      const code = generator.generate();

      // Should have a factory for ILogger (locally) - may have filename prefix
      expect(code).toMatch(/create_.*ILogger/);
      expect(code).toContain('FileLogger');
    });

    it('should resolve scoped token locally before parent', () => {
      const program = createProgram('resolve-local.ts', `
        function defineBuilderConfig(config: any) { return config; }
        function useInterface<T>(): any { return null; }

        interface ILogger {}
        class ConsoleLogger implements ILogger {}
        class FileLogger implements ILogger {}

        const parent = defineBuilderConfig({
          injections: [{ token: useInterface<ILogger>(), provider: ConsoleLogger }]
        });

        class UserService {
          constructor(logger: ILogger) {}
        }

        export const c = defineBuilderConfig({
          name: 'ChildContainer',
          useContainer: parent,
          injections: [
            { token: useInterface<ILogger>(), provider: FileLogger, scoped: true },
            { token: UserService }
          ]
        });
      `);

      const analyzer = new Analyzer(program);
      const graph = analyzer.extract();
      const generator = new Generator(graph);
      const code = generator.generate();

      // UserService should resolve ILogger from local container
      expect(code).toContain('create_UserService');
      expect(code).toContain('container.resolve');
    });
  });

  describe('Scoped with different scopes (singleton/transient)', () => {
    it('should allow scoped + transient', () => {
      const program = createProgram('scoped-transient.ts', `
        function defineBuilderConfig(config: any) { return config; }
        function useInterface<T>(): any { return null; }

        interface ILogger {}
        class ConsoleLogger implements ILogger {}
        class FileLogger implements ILogger {}

        const parent = defineBuilderConfig({
          injections: [{ token: useInterface<ILogger>(), provider: ConsoleLogger, lifecycle: 'singleton' }]
        });

        export const c = defineBuilderConfig({
          useContainer: parent,
          injections: [
            {
              token: useInterface<ILogger>(),
              provider: FileLogger,
              lifecycle: 'transient',  // Different scope than parent!
              scoped: true
            }
          ]
        });
      `);

      const analyzer = new Analyzer(program);
      const graph = analyzer.extract();

      // Find node containing ILogger (may have filename prefix)
      const node = Array.from(graph.nodes.values()).find(n =>
        n.service.tokenId.includes('ILogger')
      );
      expect(node).toBeDefined();
      expect(node!.service.lifecycle).toBe('transient');
      expect(node!.service.isScoped).toBe(true);
    });

    it('should generate transient code for scoped transient token', () => {
      const program = createProgram('gen-scoped-transient.ts', `
        function defineBuilderConfig(config: any) { return config; }
        function useInterface<T>(): any { return null; }

        interface IRequest {}
        class RequestImpl implements IRequest {}

        const parent = defineBuilderConfig({
          injections: [{ token: useInterface<IRequest>(), provider: RequestImpl, lifecycle: 'singleton' }]
        });

        export const c = defineBuilderConfig({
          name: 'RequestScope',
          useContainer: parent,
          injections: [
            {
              token: useInterface<IRequest>(),
              provider: RequestImpl,
              lifecycle: 'transient',
              scoped: true
            }
          ]
        });
      `);

      const analyzer = new Analyzer(program);
      const graph = analyzer.extract();
      const generator = new Generator(graph);
      const code = generator.generate();

      // Transient should NOT use instances cache
      expect(code).toMatch(/create_.*IRequest/);
      // The transient resolution should return directly without caching
      expect(code).toMatch(/if \(token === ".*IRequest_.*"\) \{\s*return create_/);
    });
  });

  describe('Complex scenarios', () => {
    it('should work with multi-level hierarchy', () => {
      const program = createProgram('multi-level.ts', `
        function defineBuilderConfig(config: any) { return config; }
        function useInterface<T>(): any { return null; }

        interface ILogger {}
        class ConsoleLogger implements ILogger {}
        class FileLogger implements ILogger {}
        class MockLogger implements ILogger {}

        // Level 1: Infrastructure
        const infrastructure = defineBuilderConfig({
          name: 'Infrastructure',
          injections: [{ token: useInterface<ILogger>(), provider: ConsoleLogger }]
        });

        // Level 2: Domain (uses parent's logger)
        const domain = defineBuilderConfig({
          name: 'Domain',
          useContainer: infrastructure,
          injections: []
        });

        // Level 3: Test (overrides logger)
        export const testModule = defineBuilderConfig({
          name: 'TestModule',
          useContainer: domain,
          injections: [
            { token: useInterface<ILogger>(), provider: MockLogger, scoped: true }
          ]
        });
      `);

      const analyzer = new Analyzer(program);
      const graph = analyzer.extract();
      const validator = new GraphValidator();

      expect(() => validator.validate(graph)).not.toThrow();

      // Find the ILogger node (may have filename prefix)
      const loggerNode = Array.from(graph.nodes.values()).find(n =>
        n.service.tokenId.includes('ILogger')
      );
      expect(loggerNode?.service.isScoped).toBe(true);
    });

    it('should work with factory + scoped', () => {
      const program = createProgram('factory-scoped.ts', `
        function defineBuilderConfig(config: any) { return config; }
        function useInterface<T>(): any { return null; }

        interface IConfig { env: string; }

        const parent = defineBuilderConfig({
          injections: [{
            token: useInterface<IConfig>(),
            provider: () => ({ env: 'production' })
          }]
        });

        export const c = defineBuilderConfig({
          useContainer: parent,
          injections: [
            {
              token: useInterface<IConfig>(),
              provider: () => ({ env: 'test' }),
              scoped: true
            }
          ]
        });
      `);

const analyzer = new Analyzer(program);
      const graph = analyzer.extract();
      const validator = new GraphValidator();

      expect(() => validator.validate(graph)).not.toThrow();

      // Find the node by checking all nodes for IConfig
      const configNode = Array.from(graph.nodes.values()).find(n =>
        n.service.tokenId.includes('IConfig')
      );
      expect(configNode).toBeDefined();
      expect(configNode!.service.isScoped).toBe(true);
      expect(configNode!.service.isFactory).toBe(true);
    });
  });
});

