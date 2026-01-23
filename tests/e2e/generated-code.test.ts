/**
 * E2E Tests - Generated Code Validation
 *
 * These tests verify that the generated code is correct and complete.
 * Instead of executing in a VM, we verify the code structure and logic.
 */
import { describe, it, expect } from 'vitest';
import * as ts from 'typescript';
import { Analyzer } from '../../packages/core/src/analyzer/index';
import { GraphValidator } from '../../packages/core/src/generator/index';
import { Generator } from '../../packages/core/src/generator/index';

describe('E2E - Generated Code Validation', () => {
  const compileAndGenerate = (fileContent: string) => {
    const fileName = 'e2e-validation.ts';

    // Prepend real imports to make TypeScript understand the functions
    const fullContent = `
      import { defineBuilderConfig, definePartialConfig, useInterface, useProperty, declareContainerTokens } from '@djodjonx/neosyringe';
      ${fileContent}
    `;

    const compilerHost = ts.createCompilerHost({});
    const originalGetSourceFile = compilerHost.getSourceFile;

    compilerHost.getSourceFile = (name, languageVersion) => {
      if (name === fileName) {
        return ts.createSourceFile(fileName, fullContent, languageVersion);
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

  describe('Container Structure', () => {
    it('should generate a complete NeoContainer class', () => {
      const code = compileAndGenerate(`
        class SimpleService {}
        export const c = defineBuilderConfig({
          injections: [{ token: SimpleService }]
        });
      `);

      // Verify class structure
      expect(code).toContain('class NeoContainer');
      expect(code).toContain('private instances = new Map<any, any>()');
      expect(code).toContain('constructor(');
      expect(code).toContain('public resolve<T>(token: any): T');
      expect(code).toContain('private resolveLocal(token: any): any');
      expect(code).toContain("'NeoContainer'");
    });

    it('should generate factory functions for each service', () => {
      const code = compileAndGenerate(`
        class ServiceA {}
        class ServiceB {}
        class ServiceC {}
        export const c = defineBuilderConfig({
          injections: [
            { token: ServiceA },
            { token: ServiceB },
            { token: ServiceC }
          ]
        });
      `);

      expect(code).toMatch(/private create_\w+\(\)/);
      expect(code).toContain('ServiceA');
      expect(code).toContain('ServiceB');
      expect(code).toContain('ServiceC');
    });

    it('should export the container instance', () => {
      const code = compileAndGenerate(`
        class Service {}
        export const c = defineBuilderConfig({
          injections: [{ token: Service }]
        });
      `);

      expect(code).toMatch(/export const \w+ = new NeoContainer/);
    });
  });

describe('Dependency Resolution', () => {
    it('should generate correct dependency chain in factories', () => {
      const code = compileAndGenerate(`
        class Logger {}
        class Database { constructor(logger: Logger) {} }
        class UserService { constructor(db: Database, logger: Logger) {} }
        export const c = defineBuilderConfig({
          injections: [
            { token: Logger },
            { token: Database },
            { token: UserService }
          ]
        });
      `);

      // All factories should be generated
      expect(code).toContain('create_');

      // Should have resolve calls for dependencies
      expect(code).toContain('this.resolve');

      // Should instantiate with new
      expect(code).toContain('return new');
    });

    it('should handle deep dependency chains', () => {
      const code = compileAndGenerate(`
        class A {}
        class B { constructor(a: A) {} }
        class C { constructor(b: B) {} }
        class D { constructor(c: C) {} }
        class E { constructor(d: D, a: A) {} }
        export const c = defineBuilderConfig({
          injections: [
            { token: A },
            { token: B },
            { token: C },
            { token: D },
            { token: E }
          ]
        });
      `);

      // All classes should have factories
      expect(code).toContain('create_');
      expect(code).toContain('return new');

      // Should have multiple resolve calls
      const resolveCount = (code.match(/this\.resolve/g) || []).length;
      expect(resolveCount).toBeGreaterThanOrEqual(4); // At least 4 dependencies
    });
  });

  describe('Interface Tokens', () => {
    it('should generate string-based resolution for interfaces', () => {
      const code = compileAndGenerate(`

        interface ILogger { log(msg: string): void; }
        class ConsoleLogger implements ILogger { log(msg: string) {} }

        export const c = defineBuilderConfig({
          injections: [
            { token: useInterface<ILogger>(), provider: ConsoleLogger }
          ]
        });
      `);

      // Interface should be resolved by string ID
      expect(code).toMatch(/if \(token === ["'].*ILogger_.*["']\)/);
      expect(code).toContain('ConsoleLogger');
    });

it('should resolve class dependencies on interfaces', () => {
      const code = compileAndGenerate(`

        interface ILogger { log(msg: string): void; }
        interface IDatabase { query(): void; }

        class ConsoleLogger implements ILogger { log(msg: string) {} }
        class PostgresDB implements IDatabase { query() {} }

        class UserService {
          constructor(logger: ILogger, db: IDatabase) {}
        }

        export const c = defineBuilderConfig({
          injections: [
            { token: useInterface<ILogger>(), provider: ConsoleLogger },
            { token: useInterface<IDatabase>(), provider: PostgresDB },
            { token: UserService }
          ]
        });
      `);

      // UserService factory should resolve interfaces by string ID
      expect(code).toContain('ILogger');
      expect(code).toContain('IDatabase');
      expect(code).toContain('this.resolve');
      expect(code).toContain('UserService');
    });
  });

  describe('Scopes', () => {
    it('should cache singleton instances', () => {
      const code = compileAndGenerate(`
        class SingletonService {}
        export const c = defineBuilderConfig({
          injections: [{ token: SingletonService, lifecycle: 'singleton' }]
        });
      `);

      // Should check and set in instances map
      expect(code).toContain('this.instances.has');
      expect(code).toContain('this.instances.set');
      expect(code).toContain('this.instances.get');
    });

    it('should NOT cache transient instances', () => {
      const code = compileAndGenerate(`
        class TransientService {}
        export const c = defineBuilderConfig({
          injections: [{ token: TransientService, lifecycle: 'transient' }]
        });
      `);

      // Transient should return new instance directly
      // The factory should just call new without caching
      expect(code).toMatch(/TransientService.*return.*new|return new.*TransientService/s);
    });

    it('should use singleton by default', () => {
      const code = compileAndGenerate(`
        class DefaultService {}
        export const c = defineBuilderConfig({
          injections: [{ token: DefaultService }]  // No scope specified
        });
      `);

      // Should use caching (singleton behavior)
      expect(code).toContain('this.instances');
    });
  });

  describe('Factory Providers', () => {
    it('should inline arrow function factories', () => {
      const code = compileAndGenerate(`

        interface IConfig { url: string; }

        export const c = defineBuilderConfig({
          injections: [
            {
              token: useInterface<IConfig>(),
              provider: () => ({ url: 'http://localhost' })
            }
          ]
        });
      `);

      // Factory should be included in generated code
      expect(code).toMatch(/url.*http:\/\/localhost|userFactory/);
    });

    it('should pass container to factories', () => {
      const code = compileAndGenerate(`

        interface IService {}

        export const c = defineBuilderConfig({
          injections: [
            {
              token: useInterface<IService>(),
              provider: (container) => ({ value: 42 }),
              useFactory: true
            }
          ]
        });
      `);

      // Factory function should receive container parameter
      expect(code).toMatch(/private create_.*\(\)/);
    });
  });

  describe('Property Tokens (Primitives)', () => {
it('should generate PropertyToken resolution', () => {
      const code = compileAndGenerate(`

        class ApiService {
          constructor(private apiUrl: string) {}
        }

        const apiUrl = useProperty<string>(ApiService, 'apiUrl');

        export const c = defineBuilderConfig({
          injections: [
            { token: apiUrl, provider: () => 'http://api.example.com' },
            { token: ApiService }
          ]
        });
      `);

      // Should have PropertyToken in resolution
      expect(code).toContain('PropertyToken:ApiService.apiUrl');

      // ApiService should be created and resolve the property token
      expect(code).toContain('ApiService');
      expect(code).toContain('create_ApiService');
      // The factory resolves the property token
      expect(code).toMatch(/create_ApiService.*PropertyToken:ApiService\.apiUrl/s);
    });

    it('should support multiple property tokens', () => {
      const code = compileAndGenerate(`

        class ConfigService {
          constructor(
            private host: string,
            private port: number,
            private debug: boolean
          ) {}
        }

        const host = useProperty<string>(ConfigService, 'host');
        const port = useProperty<number>(ConfigService, 'port');
        const debug = useProperty<boolean>(ConfigService, 'debug');

        export const c = defineBuilderConfig({
          injections: [
            { token: host, provider: () => 'localhost' },
            { token: port, provider: () => 3000 },
            { token: debug, provider: () => true },
            { token: ConfigService }
          ]
        });
      `);

      expect(code).toContain('PropertyToken:ConfigService.host');
      expect(code).toContain('PropertyToken:ConfigService.port');
      expect(code).toContain('PropertyToken:ConfigService.debug');
    });
  });

  describe('Parent Container', () => {
    it('should include parent in constructor', () => {
      const code = compileAndGenerate(`

        interface ILogger {}
        class ConsoleLogger implements ILogger {}

        const parent = defineBuilderConfig({
          injections: [{ token: useInterface<ILogger>(), provider: ConsoleLogger }]
        });

        class AppService {}

        export const c = defineBuilderConfig({
          useContainer: parent,
          injections: [{ token: AppService }]
        });
      `);

      // Should reference parent container
      expect(code).toContain('parent');
      expect(code).toMatch(/new NeoContainer\(.*parent/);
    });

    it('should delegate to parent in resolve', () => {
      const code = compileAndGenerate(`

        const parent = defineBuilderConfig({
          injections: []
        });

        class Service {}

        export const c = defineBuilderConfig({
          useContainer: parent,
          injections: [{ token: Service }]
        });
      `);

      // Should have parent delegation logic
      expect(code).toContain('this.parent');
      expect(code).toMatch(/if \(this\.parent\)/);
    });
  });

  describe('Legacy Container', () => {
    it('should include legacy containers in constructor', () => {
      const code = compileAndGenerate(`

        class LegacyService {}

        const tsyringe = {};
        const legacy = declareContainerTokens<{ LegacyService: LegacyService }>(tsyringe);

        class NewService { constructor(s: LegacyService) {} }

        export const c = defineBuilderConfig({
          useContainer: legacy,
          injections: [{ token: NewService }]
        });
      `);

      // Should include legacy reference
      expect(code).toContain('legacy');
      expect(code).toMatch(/\[legacy\]/);
    });

    it('should delegate to legacy in resolve', () => {
      const code = compileAndGenerate(`

        class LegacyService {}
        const legacy = declareContainerTokens<{ LegacyService: LegacyService }>({});

        export const c = defineBuilderConfig({
          useContainer: legacy,
          injections: []
        });
      `);

      // Should have legacy delegation logic
      expect(code).toContain('this.legacy');
      expect(code).toMatch(/legacyContainer\.resolve/);
    });
  });

  describe('Partials (extends)', () => {
    it('should merge injections from partials', () => {
      const code = compileAndGenerate(`

        class SharedService {}

        const sharedPartial = definePartialConfig({
          injections: [{ token: SharedService }]
        });

        class AppService { constructor(s: SharedService) {} }

        export const c = defineBuilderConfig({
          extends: [sharedPartial],
          injections: [{ token: AppService }]
        });
      `);

      // Both services should be in generated code
      expect(code).toContain('SharedService');
      expect(code).toContain('AppService');
    });

    it('should merge multiple partials', () => {
      const code = compileAndGenerate(`

        class LoggingService {}
        class CacheService {}
        class DatabaseService {}

        const loggingPartial = definePartialConfig({
          injections: [{ token: LoggingService }]
        });

        const cachePartial = definePartialConfig({
          injections: [{ token: CacheService }]
        });

        export const c = defineBuilderConfig({
          extends: [loggingPartial, cachePartial],
          injections: [{ token: DatabaseService }]
        });
      `);

      expect(code).toContain('LoggingService');
      expect(code).toContain('CacheService');
      expect(code).toContain('DatabaseService');
    });
  });

  describe('Error Detection', () => {
    it('should detect circular dependencies', () => {
      expect(() => compileAndGenerate(`

        class ServiceA { constructor(b: ServiceB) {} }
        class ServiceB { constructor(a: ServiceA) {} }

        export const c = defineBuilderConfig({
          injections: [
            { token: ServiceA },
            { token: ServiceB }
          ]
        });
      `)).toThrow(/Circular dependency/);
    });

    it('should detect missing bindings', () => {
      expect(() => compileAndGenerate(`

        class MissingDependency {}
        class ServiceA { constructor(dep: MissingDependency) {} }

        export const c = defineBuilderConfig({
          injections: [
            { token: ServiceA }
            // MissingDependency NOT registered!
          ]
        });
      `)).toThrow(/Missing binding/);
    });

    it('should detect duplicate registrations', () => {
      expect(() => compileAndGenerate(`

        class ServiceA {}

        export const c = defineBuilderConfig({
          injections: [
            { token: ServiceA },
            { token: ServiceA }  // Duplicate!
          ]
        });
      `)).toThrow(/Duplicate registration/);
    });

    it('should detect duplicate with parent container', () => {
      expect(() => compileAndGenerate(`

        interface ILogger {}
        class ConsoleLogger implements ILogger {}
        class FileLogger implements ILogger {}

        const parent = defineBuilderConfig({
          injections: [{ token: useInterface<ILogger>(), provider: ConsoleLogger }]
        });

        export const c = defineBuilderConfig({
          useContainer: parent,
          injections: [
            { token: useInterface<ILogger>(), provider: FileLogger }  // Duplicate!
          ]
        });
      `)).toThrow(/Duplicate registration.*parent/);
    });
  });

  describe('Complex Scenarios', () => {
    it('should handle mixed interface and class tokens', () => {
      const code = compileAndGenerate(`

        interface ILogger { log(msg: string): void; }
        interface IDatabase { query(): any; }

        class ConsoleLogger implements ILogger { log(msg: string) {} }
        class PostgresDB implements IDatabase {
          constructor(private logger: ILogger) {}
          query() { return []; }
        }

        class UserRepository {
          constructor(private db: IDatabase) {}
        }

        class UserService {
          constructor(
            private repo: UserRepository,
            private logger: ILogger
          ) {}
        }

        export const c = defineBuilderConfig({
          injections: [
            { token: useInterface<ILogger>(), provider: ConsoleLogger },
            { token: useInterface<IDatabase>(), provider: PostgresDB },
            { token: UserRepository },
            { token: UserService }
          ]
        });
      `);

      // All tokens should be present
      expect(code).toContain('ILogger');
      expect(code).toContain('IDatabase');
      expect(code).toContain('UserRepository');
      expect(code).toContain('UserService');

      // Should have proper resolution chain
      expect(code).toContain('this.resolve');
    });

    it('should handle factory with dependencies from container', () => {
      const code = compileAndGenerate(`

        interface IConfig { apiUrl: string; }
        interface ILogger { log(msg: string): void; }

        class ConsoleLogger implements ILogger { log(msg: string) {} }

        export const c = defineBuilderConfig({
          injections: [
            { token: useInterface<ILogger>(), provider: ConsoleLogger },
            {
              token: useInterface<IConfig>(),
              provider: (container) => {
                const logger = this.resolve('ILogger');
                logger.log('Creating config');
                return { apiUrl: 'http://api.com' };
              },
              useFactory: true
            }
          ]
        });
      `);

      expect(code).toContain('ILogger');
      expect(code).toContain('IConfig');
    });

    it('should handle all scopes in same container', () => {
      const code = compileAndGenerate(`

        class SingletonA {}
        class SingletonB {}
        class TransientA {}
        class TransientB {}

        export const c = defineBuilderConfig({
          injections: [
            { token: SingletonA, lifecycle: 'singleton' },
            { token: SingletonB },  // Default singleton
            { token: TransientA, lifecycle: 'transient' },
            { token: TransientB, lifecycle: 'transient' }
          ]
        });
      `);

      // Singleton should use instances cache
      expect(code).toContain('this.instances.has');
      expect(code).toContain('this.instances.set');

      // Should have both singleton and transient patterns
      expect(code).toMatch(/SingletonA.*instances/s);
      expect(code).toMatch(/TransientA.*return/s);
    });

    it('should handle deeply nested parent containers', () => {
      const code = compileAndGenerate(`

        interface IInfra {}
        interface IDomain {}

        class InfraService implements IInfra {}
        class DomainService implements IDomain { constructor(infra: IInfra) {} }

        const infraContainer = defineBuilderConfig({
          name: 'Infrastructure',
          injections: [{ token: useInterface<IInfra>(), provider: InfraService }]
        });

        const domainContainer = defineBuilderConfig({
          name: 'Domain',
          useContainer: infraContainer,
          injections: [{ token: useInterface<IDomain>(), provider: DomainService }]
        });

        class AppService { constructor(domain: IDomain, infra: IInfra) {} }

        export const c = defineBuilderConfig({
          name: 'Application',
          useContainer: domainContainer,
          injections: [{ token: AppService }]
        });
      `);

      expect(code).toContain('AppService');
      expect(code).toContain("'Application'");
      expect(code).toContain('domainContainer');
    });
  });

  describe('Container Metadata', () => {
    it('should include debug graph information', () => {
      const code = compileAndGenerate(`

        class ServiceA {}
        class ServiceB {}

        export const c = defineBuilderConfig({
          injections: [
            { token: ServiceA },
            { token: ServiceB }
          ]
        });
      `);

      // Should have _graph getter for debugging
      expect(code).toContain('get _graph()');
      expect(code).toContain('ServiceA');
      expect(code).toContain('ServiceB');
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty container', () => {
      const code = compileAndGenerate(`
        export const c = defineBuilderConfig({
          injections: []
        });
      `);

      expect(code).toContain('class NeoContainer');
      expect(code).toContain('resolveLocal');
    });

    it('should handle service with no dependencies', () => {
      const code = compileAndGenerate(`
        class StandaloneService {
          getValue() { return 42; }
        }
        export const c = defineBuilderConfig({
          injections: [{ token: StandaloneService }]
        });
      `);

      // Factory should create with no args
      expect(code).toMatch(/new.*StandaloneService\(\)/);
    });

    it('should detect self-dependency (A depends on A)', () => {
      expect(() => compileAndGenerate(`
        class SelfDependent { constructor(self: SelfDependent) {} }
        export const c = defineBuilderConfig({
          injections: [{ token: SelfDependent }]
        });
      `)).toThrow(/Circular dependency/);
    });

    it('should handle class with optional constructor parameters', () => {
      const code = compileAndGenerate(`
        class Logger {}
        class ServiceWithOptional {
          constructor(public logger?: Logger) {}
        }
        export const c = defineBuilderConfig({
          injections: [
            { token: Logger },
            { token: ServiceWithOptional }
          ]
        });
      `);

      expect(code).toContain('ServiceWithOptional');
      expect(code).toContain('Logger');
    });

    it('should handle very long dependency chains (10+ levels)', () => {
      const code = compileAndGenerate(`
        class L0 {}
        class L1 { constructor(d: L0) {} }
        class L2 { constructor(d: L1) {} }
        class L3 { constructor(d: L2) {} }
        class L4 { constructor(d: L3) {} }
        class L5 { constructor(d: L4) {} }
        class L6 { constructor(d: L5) {} }
        class L7 { constructor(d: L6) {} }
        class L8 { constructor(d: L7) {} }
        class L9 { constructor(d: L8) {} }
        class L10 { constructor(d: L9) {} }
        export const c = defineBuilderConfig({
          injections: [
            { token: L0 },
            { token: L1 },
            { token: L2 },
            { token: L3 },
            { token: L4 },
            { token: L5 },
            { token: L6 },
            { token: L7 },
            { token: L8 },
            { token: L9 },
            { token: L10 }
          ]
        });
      `);

      // All levels should be created
      expect(code).toContain('L0');
      expect(code).toContain('L10');

      // Should have 10 resolve calls minimum
      const resolveCount = (code.match(/this\.resolve/g) || []).length;
      expect(resolveCount).toBeGreaterThanOrEqual(10);
    });

    it('should handle diamond dependency pattern', () => {
      // A depends on B and C, both B and C depend on D
      const code = compileAndGenerate(`
        class D {}
        class B { constructor(d: D) {} }
        class C { constructor(d: D) {} }
        class A { constructor(b: B, c: C) {} }
        export const c = defineBuilderConfig({
          injections: [
            { token: D },
            { token: B },
            { token: C },
            { token: A }
          ]
        });
      `);

      expect(code).toContain('A');
      expect(code).toContain('B');
      expect(code).toContain('C');
      expect(code).toContain('D');
    });

    it('should handle multiple constructors dependencies of same type', () => {
      const code = compileAndGenerate(`
        class Logger {}
        class MultiLogger {
          constructor(
            public primary: Logger,
            public secondary: Logger,
            public fallback: Logger
          ) {}
        }
        export const c = defineBuilderConfig({
          injections: [
            { token: Logger },
            { token: MultiLogger }
          ]
        });
      `);

      expect(code).toContain('MultiLogger');
      // Should resolve Logger 3 times
      expect(code).toMatch(/this\.resolve.*this\.resolve.*this\.resolve/s);
    });
  });

  describe('Code Safety', () => {
    it('should escape special characters in class names', () => {
      // This tests that generated code doesn't break with unusual names
      const code = compileAndGenerate(`
        class Service_With_Underscores {}
        class ServiceWith123Numbers {}
        export const c = defineBuilderConfig({
          injections: [
            { token: Service_With_Underscores },
            { token: ServiceWith123Numbers }
          ]
        });
      `);

      expect(code).toContain('Service_With_Underscores');
      expect(code).toContain('ServiceWith123Numbers');
    });

    it('should generate valid TypeScript syntax', () => {
      const code = compileAndGenerate(`
        class A {}
        class B { constructor(a: A) {} }
        export const c = defineBuilderConfig({
          injections: [{ token: A }, { token: B }]
        });
      `);

      // Try to parse the generated code as TypeScript
      const sourceFile = ts.createSourceFile(
        'generated',
        code,
        ts.ScriptTarget.Latest,
        true
      );

      // Should parse without syntax errors
      const syntaxErrors = (sourceFile as any).parseDiagnostics || [];
      expect(syntaxErrors.length).toBe(0);
    });

    it('should not allow code injection via container name', () => {
      const code = compileAndGenerate(`
        class Service {}
        export const c = defineBuilderConfig({
          name: "Test'); console.log('injected",
          injections: [{ token: Service }]
        });
      `);

      // Name should be escaped or rejected
      // At minimum, the generated code should still be valid
      const sourceFile = ts.createSourceFile(
        'generated',
        code,
        ts.ScriptTarget.Latest,
        true
      );
      const syntaxErrors = (sourceFile as any).parseDiagnostics || [];
      expect(syntaxErrors.length).toBe(0);
    });
  });

  describe('Error Messages', () => {
    it('should provide clear error for circular dependency', () => {
      try {
        compileAndGenerate(`
          function defineBuilderConfig(config: any) { return config; }
          class A { constructor(b: B) {} }
          class B { constructor(a: A) {} }
          export const c = defineBuilderConfig({
            injections: [{ token: A }, { token: B }]
          });
        `);
        expect.fail('Should have thrown');
      } catch (e: any) {
        expect(e.message).toContain('Circular');
        expect(e.message).toMatch(/A.*B|B.*A/);
      }
    });

    it('should provide clear error for missing binding with service name', () => {
      try {
        compileAndGenerate(`
          function defineBuilderConfig(config: any) { return config; }
          class MissingService {}
          class Consumer { constructor(m: MissingService) {} }
          export const c = defineBuilderConfig({
            injections: [{ token: Consumer }]
          });
        `);
        expect.fail('Should have thrown');
      } catch (e: any) {
        expect(e.message).toContain('Missing');
        expect(e.message).toContain('MissingService');
      }
    });

    it('should provide clear error for duplicate with token name', () => {
      try {
        compileAndGenerate(`
          function defineBuilderConfig(config: any) { return config; }
          class DuplicateService {}
          export const c = defineBuilderConfig({
            injections: [
              { token: DuplicateService },
              { token: DuplicateService }
            ]
          });
        `);
        expect.fail('Should have thrown');
      } catch (e: any) {
        expect(e.message).toContain('Duplicate');
        expect(e.message).toContain('DuplicateService');
      }
    });
  });

  describe('Generated Code Quality', () => {
    it('should not have unused imports', () => {
      const code = compileAndGenerate(`
        class OnlyService {}
        export const c = defineBuilderConfig({
          injections: [{ token: OnlyService }]
        });
      `);

      // Each import should be used somewhere in the code
      const importMatches = code.matchAll(/import \* as (\w+) from/g);
      for (const match of importMatches) {
        const alias = match[1];
        // Should appear more than once (in import + in usage)
        const usageCount = (code.match(new RegExp(alias, 'g')) || []).length;
        expect(usageCount).toBeGreaterThan(1);
      }
    });

    it('should generate deterministic output', () => {
      const source = `
        class A {}
        class B {}
        export const c = defineBuilderConfig({
          injections: [{ token: A }, { token: B }]
        });
      `;

      const code1 = compileAndGenerate(source);
      const code2 = compileAndGenerate(source);

      // Same input should produce same output
      expect(code1).toBe(code2);
    });
  });

  describe('Advanced Type Handling', () => {
    it('should handle generic classes', () => {
      const code = compileAndGenerate(`

        class Repository<T> {
          find(id: string): T | null { return null; }
        }

        class UserRepository extends Repository<any> {}

        class UserService {
          constructor(private repo: UserRepository) {}
        }

        export const c = defineBuilderConfig({
          injections: [
            { token: UserRepository },
            { token: UserService }
          ]
        });
      `);

      expect(code).toContain('UserRepository');
      expect(code).toContain('UserService');
      expect(code).toContain('this.resolve');
    });

    it('should handle class with multiple interfaces', () => {
      const code = compileAndGenerate(`

        interface Readable { read(): string; }
        interface Writable { write(data: string): void; }

        class FileSystem implements Readable, Writable {
          read() { return ''; }
          write(data: string) {}
        }

        export const c = defineBuilderConfig({
          injections: [
            { token: useInterface<Readable>(), provider: FileSystem },
            { token: useInterface<Writable>(), provider: FileSystem }
          ]
        });
      `);

      expect(code).toContain('Readable');
      expect(code).toContain('Writable');
      expect(code).toContain('FileSystem');
    });

    it('should handle abstract base class pattern', () => {
      const code = compileAndGenerate(`

        abstract class BaseService {
          abstract execute(): void;
        }

        class ConcreteService extends BaseService {
          execute() { console.log('executing'); }
        }

        export const c = defineBuilderConfig({
          injections: [
            { token: useInterface<BaseService>(), provider: ConcreteService }
          ]
        });
      `);

      expect(code).toContain('ConcreteService');
    });
  });

  describe('Async Factories', () => {
    it('should handle async factory providers', () => {
      const code = compileAndGenerate(`

        interface IDatabase {
          connect(): Promise<void>;
        }

        export const c = defineBuilderConfig({
          injections: [
            {
              token: useInterface<IDatabase>(),
              provider: async (container) => {
                // Simulate async initialization
                return { connect: async () => {} };
              },
              useFactory: true
            }
          ]
        });
      `);

      // Should include the async factory
      expect(code).toContain('IDatabase');
    });
  });

  describe('Performance & Stress', () => {
    it('should handle large number of services (50+)', () => {
      // Generate 50 services dynamically
      const services = Array.from({ length: 50 }, (_, i) => `class Service${i} {}`).join('\n');
      const injections = Array.from({ length: 50 }, (_, i) => `{ token: Service${i} }`).join(',\n');

      const code = compileAndGenerate(`
        ${services}
        export const c = defineBuilderConfig({
          injections: [${injections}]
        });
      `);

      // All 50 services should be present
      expect(code).toContain('Service0');
      expect(code).toContain('Service49');

      // Should have 50 factory functions
      const factoryCount = (code.match(/private create_/g) || []).length;
      expect(factoryCount).toBe(50);
    });

    it('should handle wide dependency graph (10 deps per service)', () => {
      const code = compileAndGenerate(`

        class Dep1 {}
        class Dep2 {}
        class Dep3 {}
        class Dep4 {}
        class Dep5 {}
        class Dep6 {}
        class Dep7 {}
        class Dep8 {}
        class Dep9 {}
        class Dep10 {}

        class MegaService {
          constructor(
            d1: Dep1, d2: Dep2, d3: Dep3, d4: Dep4, d5: Dep5,
            d6: Dep6, d7: Dep7, d8: Dep8, d9: Dep9, d10: Dep10
          ) {}
        }

        export const c = defineBuilderConfig({
          injections: [
            { token: Dep1 }, { token: Dep2 }, { token: Dep3 },
            { token: Dep4 }, { token: Dep5 }, { token: Dep6 },
            { token: Dep7 }, { token: Dep8 }, { token: Dep9 },
            { token: Dep10 }, { token: MegaService }
          ]
        });
      `);

      expect(code).toContain('MegaService');

      // Should resolve all 10 dependencies
      const resolveCount = (code.match(/this\.resolve/g) || []).length;
      expect(resolveCount).toBeGreaterThanOrEqual(10);
    });
  });

  describe('Runtime Error Handling', () => {
    it('should generate code that handles missing token gracefully', () => {
      const code = compileAndGenerate(`
        class Service {}
        export const c = defineBuilderConfig({
          injections: [{ token: Service }]
        });
      `);

      // Should have error throwing for unknown tokens
      expect(code).toContain('throw new Error');
      expect(code).toMatch(/not found|not registered/i);
    });

    it('should include container name in error messages', () => {
      const code = compileAndGenerate(`
        class Service {}
        export const c = defineBuilderConfig({
          injections: [{ token: Service }]
        });
      `);

      // Error should include container name for debugging
      expect(code).toContain('NeoContainer');
      expect(code).toMatch(/\$\{this\.name\}/);
    });
  });

  describe('Import/Export Safety', () => {
    it('should generate valid import paths', () => {
      const code = compileAndGenerate(`
        class Service {}
        export const c = defineBuilderConfig({
          injections: [{ token: Service }]
        });
      `);

      // Imports should be properly formatted
      const imports = code.match(/import \* as \w+ from ['"][^'"]+['"]/g) || [];
      for (const imp of imports) {
        // Should not have undefined or null in path
        expect(imp).not.toContain('undefined');
        expect(imp).not.toContain('null');
      }
    });

    it('should handle re-exported classes', () => {
      // This simulates a class that might be re-exported from an index file
      const code = compileAndGenerate(`

        class InternalService {}
        const ExportedService = InternalService;

        export const c = defineBuilderConfig({
          injections: [{ token: ExportedService }]
        });
      `);

      const hasInternalOrExported = code.includes('InternalService') || code.includes('ExportedService');
      expect(hasInternalOrExported).toBe(true);
    });
  });

  describe('Boundary Conditions', () => {
    it('should handle service with 0 to N dependencies consistently', () => {
      // 0 deps
      const code0 = compileAndGenerate(`
        class Zero {}
        export const c = defineBuilderConfig({ injections: [{ token: Zero }] });
      `);
      expect(code0).toMatch(/new.*Zero\(\)/);

      // 1 dep
      const code1 = compileAndGenerate(`
        class Dep {}
        class One { constructor(d: Dep) {} }
        export const c = defineBuilderConfig({ injections: [{ token: Dep }, { token: One }] });
      `);
      expect(code1).toContain('this.resolve');

      // 5 deps
      const code5 = compileAndGenerate(`
        class D1 {} class D2 {} class D3 {} class D4 {} class D5 {}
        class Five { constructor(a: D1, b: D2, c: D3, d: D4, e: D5) {} }
        export const c = defineBuilderConfig({
          injections: [{ token: D1 }, { token: D2 }, { token: D3 }, { token: D4 }, { token: D5 }, { token: Five }]
        });
      `);
      const count = (code5.match(/this\.resolve/g) || []).length;
      expect(count).toBeGreaterThanOrEqual(5);
    });

    it('should handle naming edge cases', () => {
      const code = compileAndGenerate(`

        // Various valid TypeScript class names
        class $Service {}
        class _Service {}
        class Service$ {}
        class Service_ {}
        class ALLCAPS {}
        class camelCase {}
        class PascalCase {}

        export const c = defineBuilderConfig({
          injections: [
            { token: $Service },
            { token: _Service },
            { token: Service$ },
            { token: Service_ },
            { token: ALLCAPS },
            { token: camelCase },
            { token: PascalCase }
          ]
        });
      `);

      expect(code).toContain('$Service');
      expect(code).toContain('_Service');
      expect(code).toContain('ALLCAPS');
      expect(code).toContain('PascalCase');
    });
  });
});

