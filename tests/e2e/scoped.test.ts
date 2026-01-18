/**
 * E2E Tests for scoped: true functionality
 *
 * Tests the complete flow from configuration to generated code
 * for scoped token overrides.
 */
import { describe, it, expect } from 'vitest';
import * as ts from 'typescript';
import { Analyzer } from '@djodjonx/neosyringe-core/analyzer';
import { GraphValidator } from '@djodjonx/neosyringe-core/generator';
import { Generator } from '@djodjonx/neosyringe-core/generator';

describe('E2E - Scoped Injections', () => {
  const compileAndGenerate = (fileContent: string): string => {
    const fileName = 'scoped-e2e.ts';
    const compilerHost = ts.createCompilerHost({});
    const originalGetSourceFile = compilerHost.getSourceFile;

    compilerHost.getSourceFile = (name, languageVersion) => {
      if (name === fileName) {
        return ts.createSourceFile(fileName, fileContent, languageVersion);
      }
      return originalGetSourceFile(name, languageVersion);
    };

    const program = ts.createProgram([fileName], {}, compilerHost);
    const analyzer = new Analyzer(program);
    const graph = analyzer.extract();

    const validator = new GraphValidator();
    validator.validate(graph);

    const generator = new Generator(graph);
    return generator.generate();
  };

  describe('Basic scoped override', () => {
    it('should compile and generate code for scoped token', () => {
      const code = compileAndGenerate(`
        function defineBuilderConfig(config: any) { return config; }
        function useInterface<T>(): any { return null; }

        interface ILogger { log(msg: string): void; }
        class ConsoleLogger implements ILogger { log(msg: string) {} }
        class FileLogger implements ILogger { log(msg: string) {} }

        const sharedKernel = defineBuilderConfig({
          name: 'SharedKernel',
          injections: [
            { token: useInterface<ILogger>(), provider: ConsoleLogger }
          ]
        });

        class UserService {
          constructor(private logger: ILogger) {}
        }

        export const userModule = defineBuilderConfig({
          name: 'UserModule',
          useContainer: sharedKernel,
          injections: [
            { token: useInterface<ILogger>(), provider: FileLogger, scoped: true },
            { token: UserService }
          ]
        });
      `);

// Container should be generated
      expect(code).toContain('class NeoContainer');

      // FileLogger (scoped) should be used, not ConsoleLogger
      expect(code).toContain('FileLogger');

      // Should have factory for ILogger (may have filename prefix)
      expect(code).toMatch(/create_.*ILogger/);

      // UserService should depend on ILogger
      expect(code).toContain('UserService');
    });

    it('should fail without scoped: true when overriding parent', () => {
      expect(() => compileAndGenerate(`
        function defineBuilderConfig(config: any) { return config; }
        function useInterface<T>(): any { return null; }

        interface ILogger {}
        class ConsoleLogger implements ILogger {}
        class FileLogger implements ILogger {}

        const parent = defineBuilderConfig({
          injections: [{ token: useInterface<ILogger>(), provider: ConsoleLogger }]
        });

        export const child = defineBuilderConfig({
          useContainer: parent,
          injections: [
            { token: useInterface<ILogger>(), provider: FileLogger }  // Missing scoped: true
          ]
        });
      `)).toThrow(/Duplicate registration.*ILogger/);
    });
  });

  describe('Scoped with scopes (singleton/transient)', () => {
    it('should generate singleton for scoped singleton', () => {
      const code = compileAndGenerate(`
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
            { token: useInterface<ICache>(), provider: MemoryCache, lifecycle: 'singleton', scoped: true }
          ]
        });
      `);

      // Should use instances cache for singleton
      expect(code).toContain('this.instances.has');
      expect(code).toContain('this.instances.set');
      expect(code).toContain('MemoryCache');
    });

    it('should generate transient for scoped transient', () => {
      const code = compileAndGenerate(`
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
            { token: useInterface<IRequest>(), provider: RequestImpl, lifecycle: 'transient', scoped: true }
          ]
        });
      `);

      // Transient should return directly without caching
      expect(code).toMatch(/if \(token === ".*IRequest_.*"\) \{\s*return create_/);
    });
  });

  describe('Scoped with factory', () => {
    it('should work with factory provider + scoped', () => {
      const code = compileAndGenerate(`
        function defineBuilderConfig(config: any) { return config; }
        function useInterface<T>(): any { return null; }

        interface IConfig { apiUrl: string; }

        const parent = defineBuilderConfig({
          injections: [{
            token: useInterface<IConfig>(),
            provider: () => ({ apiUrl: 'https://prod.api.com' })
          }]
        });

        export const testModule = defineBuilderConfig({
          name: 'TestModule',
          useContainer: parent,
          injections: [
            {
              token: useInterface<IConfig>(),
              provider: () => ({ apiUrl: 'http://localhost:3000' }),
              scoped: true
            }
          ]
        });
      `);

      expect(code).toContain('localhost:3000');
      expect(code).toMatch(/create_.*IConfig/);
    });
  });

  describe('Multi-level hierarchy', () => {
    it('should work with 3-level container hierarchy', () => {
      const code = compileAndGenerate(`
        function defineBuilderConfig(config: any) { return config; }
        function useInterface<T>(): any { return null; }

        interface ILogger {}
        interface IDatabase {}

        class ConsoleLogger implements ILogger {}
        class FileLogger implements ILogger {}
        class PostgresDB implements IDatabase {}

        // Level 1: Infrastructure
        const infrastructure = defineBuilderConfig({
          name: 'Infrastructure',
          injections: [
            { token: useInterface<ILogger>(), provider: ConsoleLogger },
            { token: useInterface<IDatabase>(), provider: PostgresDB }
          ]
        });

        // Level 2: Domain (inherits all from infrastructure)
        const domain = defineBuilderConfig({
          name: 'Domain',
          useContainer: infrastructure,
          injections: []
        });

        // Level 3: TestModule (overrides ILogger only)
        class TestService {
          constructor(private logger: ILogger, private db: IDatabase) {}
        }

        export const testModule = defineBuilderConfig({
          name: 'TestModule',
          useContainer: domain,
          injections: [
            { token: useInterface<ILogger>(), provider: FileLogger, scoped: true },
            { token: TestService }
          ]
        });
      `);

      // Should have local ILogger (FileLogger)
      expect(code).toContain('FileLogger');

      // Should NOT have local IDatabase (comes from parent)
      expect(code).not.toContain('create_IDatabase');

      // TestService should exist
      expect(code).toContain('TestService');
    });
  });

  describe('Class token scoped', () => {
    it('should work with class token (not just interfaces)', () => {
      const code = compileAndGenerate(`
        function defineBuilderConfig(config: any) { return config; }

        class Logger {
          log(msg: string) { console.log(msg); }
        }

        class MockLogger extends Logger {
          log(msg: string) { /* noop */ }
        }

        const parent = defineBuilderConfig({
          injections: [{ token: Logger }]
        });

        export const testModule = defineBuilderConfig({
          name: 'TestModule',
          useContainer: parent,
          injections: [
            { token: Logger, provider: MockLogger, scoped: true }
          ]
        });
      `);

      expect(code).toContain('MockLogger');
      expect(code).toContain('create_Logger');
    });
  });

  describe('Multiple scoped tokens', () => {
    it('should handle multiple scoped overrides', () => {
      const code = compileAndGenerate(`
        function defineBuilderConfig(config: any) { return config; }
        function useInterface<T>(): any { return null; }

        interface ILogger {}
        interface ICache {}
        interface IConfig {}

        class ConsoleLogger implements ILogger {}
        class RedisCache implements ICache {}
        class ProdConfig implements IConfig {}

        class MockLogger implements ILogger {}
        class MemoryCache implements ICache {}
        class TestConfig implements IConfig {}

        const production = defineBuilderConfig({
          name: 'Production',
          injections: [
            { token: useInterface<ILogger>(), provider: ConsoleLogger },
            { token: useInterface<ICache>(), provider: RedisCache },
            { token: useInterface<IConfig>(), provider: ProdConfig }
          ]
        });

        export const testing = defineBuilderConfig({
          name: 'Testing',
          useContainer: production,
          injections: [
            { token: useInterface<ILogger>(), provider: MockLogger, scoped: true },
            { token: useInterface<ICache>(), provider: MemoryCache, scoped: true },
            { token: useInterface<IConfig>(), provider: TestConfig, scoped: true }
          ]
        });
      `);

// All 3 mock implementations should be present
      expect(code).toContain('MockLogger');
      expect(code).toContain('MemoryCache');
      expect(code).toContain('TestConfig');

      // Should have factories for all 3 (may have filename prefix)
      expect(code).toMatch(/create_.*ILogger/);
      expect(code).toMatch(/create_.*ICache/);
      expect(code).toMatch(/create_.*IConfig/);
    });
  });

  describe('Scoped with dependencies', () => {
    it('should resolve scoped dependencies correctly', () => {
      const code = compileAndGenerate(`
        function defineBuilderConfig(config: any) { return config; }
        function useInterface<T>(): any { return null; }

        interface ILogger {}
        class ConsoleLogger implements ILogger {}
        class FileLogger implements ILogger {}

        class UserRepository {
          constructor(private logger: ILogger) {}
        }

        class UserService {
          constructor(private repo: UserRepository, private logger: ILogger) {}
        }

        const parent = defineBuilderConfig({
          name: 'Parent',
          injections: [
            { token: useInterface<ILogger>(), provider: ConsoleLogger }
          ]
        });

        export const child = defineBuilderConfig({
          name: 'Child',
          useContainer: parent,
          injections: [
            { token: useInterface<ILogger>(), provider: FileLogger, scoped: true },
            { token: UserRepository },
            { token: UserService }
          ]
        });
      `);

      // Both UserRepository and UserService should use local ILogger
      expect(code).toContain('create_UserRepository');
      expect(code).toContain('create_UserService');
      expect(code).toContain('FileLogger');
    });
  });
});

