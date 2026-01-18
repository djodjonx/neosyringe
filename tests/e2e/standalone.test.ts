/**
 * E2E Tests - NeoSyringe Standalone
 *
 * Tests the complete flow from configuration to code generation
 * without any legacy container integration.
 */
import { describe, it, expect } from 'vitest';
import * as ts from 'typescript';
import { Analyzer } from '../../packages/core/src/analyzer/index';
import { GraphValidator } from '../../packages/core/src/generator/index';
import { Generator } from '../../packages/core/src/generator/index';

describe('E2E - NeoSyringe Standalone', () => {
  const compileAndGenerate = (fileContent: string) => {
    const fileName = 'e2e-test';
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

  it('should compile a complete application with interfaces and classes', () => {
    const code = compileAndGenerate(`
      function defineBuilderConfig(config: any) { return config; }
      function useInterface<T>(): any { return null; }

      // Interfaces
      interface ILogger { log(msg: string): void; }
      interface IDatabase { query(sql: string): any[]; }
      interface IConfig { apiUrl: string; }

      // Implementations
      class ConsoleLogger implements ILogger {
        log(msg: string) { console.log(msg); }
      }

      class PostgresDatabase implements IDatabase {
        constructor(private config: IConfig, private logger: ILogger) {}
        query(sql: string) { return []; }
      }

      class AppConfig implements IConfig {
        apiUrl = 'http://localhost:3000';
      }

      class UserService {
        constructor(
          private db: IDatabase,
          private logger: ILogger
        ) {}
      }

      class OrderService {
        constructor(
          private db: IDatabase,
          private logger: ILogger,
          private userService: UserService
        ) {}
      }

      export const container = defineBuilderConfig({
        name: 'AppContainer',
        injections: [
          { token: useInterface<IConfig>(), provider: AppConfig },
          { token: useInterface<ILogger>(), provider: ConsoleLogger },
          { token: useInterface<IDatabase>(), provider: PostgresDatabase },
          { token: UserService },
          { token: OrderService }
        ]
      });
    `);

    // Verify generated code structure
    expect(code).toContain('class NeoContainer');
    expect(code).toContain("'AppContainer'");
    expect(code).toContain('create_');
    expect(code).toContain('resolve');
    expect(code).toContain('this.instances');
  });

  it('should compile with factory providers', () => {
    const code = compileAndGenerate(`
      function defineBuilderConfig(config: any) { return config; }
      function useInterface<T>(): any { return null; }

      interface IConfig {
        apiUrl: string;
        timeout: number;
      }

      export const container = defineBuilderConfig({
        injections: [
          {
            token: useInterface<IConfig>(),
            provider: () => ({
              apiUrl: process.env.API_URL || 'http://localhost',
              timeout: 5000
            })
          }
        ]
      });
    `);

    expect(code).toContain('create_');
    // Factory should be inlined or called
    expect(code).toMatch(/process\.env\.API_URL|userFactory/);
  });

  it('should compile with scopes (singleton and transient)', () => {
    const code = compileAndGenerate(`
      function defineBuilderConfig(config: any) { return config; }

      class SingletonService {}
      class TransientService {}

      export const container = defineBuilderConfig({
        injections: [
          { token: SingletonService, lifecycle: 'singleton' },
          { token: TransientService, lifecycle: 'transient' }
        ]
      });
    `);

    expect(code).toContain('SingletonService');
    expect(code).toContain('TransientService');
    // Transient should NOT use instances cache
    expect(code).toMatch(/TransientService.*return new/s);
  });

  it('should compile with useProperty for primitives', () => {
    const code = compileAndGenerate(`
      function defineBuilderConfig(config: any) { return config; }
      function useProperty<T>(cls: any, name: string): any { return null; }

      class ApiService {
        constructor(
          private apiUrl: string,
          private maxRetries: number
        ) {}
      }

      const apiUrl = useProperty<string>(ApiService, 'apiUrl');
      const maxRetries = useProperty<number>(ApiService, 'maxRetries');

      export const container = defineBuilderConfig({
        injections: [
          { token: apiUrl, provider: () => 'http://localhost:3000' },
          { token: maxRetries, provider: () => 3 },
          { token: ApiService }
        ]
      });
    `);

    expect(code).toContain('PropertyToken:ApiService.apiUrl');
    expect(code).toContain('PropertyToken:ApiService.maxRetries');
    expect(code).toContain('ApiService');
  });

  it('should compile with partials (extends)', () => {
    const code = compileAndGenerate(`
      function defineBuilderConfig(config: any) { return config; }
      function definePartialConfig(config: any) { return config; }
      function useInterface<T>(): any { return null; }

      interface ILogger { log(msg: string): void; }
      class ConsoleLogger implements ILogger { log(msg: string) {} }

      const loggingPartial = definePartialConfig({
        injections: [
          { token: useInterface<ILogger>(), provider: ConsoleLogger }
        ]
      });

      class AppService {
        constructor(private logger: ILogger) {}
      }

      export const container = defineBuilderConfig({
        extends: [loggingPartial],
        injections: [
          { token: AppService }
        ]
      });
    `);

    expect(code).toContain('ILogger');
    expect(code).toContain('AppService');
  });

  it('should compile with parent NeoSyringe container', () => {
    const code = compileAndGenerate(`
      function defineBuilderConfig(config: any) { return config; }
      function useInterface<T>(): any { return null; }

      interface ILogger { log(msg: string): void; }
      class ConsoleLogger implements ILogger { log(msg: string) {} }

      const sharedKernel = defineBuilderConfig({
        name: 'SharedKernel',
        injections: [
          { token: useInterface<ILogger>(), provider: ConsoleLogger }
        ]
      });

      class AppService {
        constructor(private logger: ILogger) {}
      }

      export const appContainer = defineBuilderConfig({
        name: 'AppContainer',
        useContainer: sharedKernel,
        injections: [
          { token: AppService }
        ]
      });
    `);

    expect(code).toContain('AppService');
    expect(code).toContain("'AppContainer'");
    // Should reference parent container
    expect(code).toContain('sharedKernel');
  });
});

