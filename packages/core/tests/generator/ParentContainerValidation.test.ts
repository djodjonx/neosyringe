import { describe, it, expect } from 'vitest';
import * as ts from 'typescript';
import { Analyzer } from '../../src/analyzer/Analyzer';
import { GraphValidator } from '../../src/generator/GraphValidator';

describe('GraphValidator - Parent Container Support', () => {
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

  it('should not throw missing binding error when dependency is in parent container', () => {
    const fileName = 'parent-container.ts';
    const fileContent = `
      function defineBuilderConfig(config: any) { return config; }
      function useInterface<T>(): any { return null; }

      interface ILogger { log(msg: string): void; }
      class ConsoleLogger implements ILogger { log(msg: string) { console.log(msg); } }

      // Parent container provides ILogger
      const sharedKernel = defineBuilderConfig({
        injections: [
          { token: useInterface<ILogger>(), provider: ConsoleLogger }
        ]
      });

      // Child uses ILogger from parent
      class UserService {
        constructor(private logger: ILogger) {}
      }

      export const childContainer = defineBuilderConfig({
        useContainer: sharedKernel,
        injections: [
          { token: UserService }  // Depends on ILogger from parent
        ]
      });
    `;

    const program = createProgram(fileName, fileContent);
    const analyzer = new Analyzer(program);
    const graph = analyzer.extract();

    // Should have parentProvidedTokens
    expect(graph.parentProvidedTokens).toBeDefined();
    expect(graph.parentProvidedTokens!.size).toBeGreaterThan(0);

    // Validator should NOT throw because ILogger is in parent
    const validator = new GraphValidator();
    expect(() => validator.validate(graph)).not.toThrow();
  });

  it('should throw missing binding error when dependency is not in parent or local', () => {
    const fileName = 'missing-binding.ts';
    const fileContent = `
      function defineBuilderConfig(config: any) { return config; }
      function useInterface<T>(): any { return null; }

      interface ILogger { log(msg: string): void; }
      interface IDatabase { query(): void; }  // Not registered anywhere!

      class ConsoleLogger implements ILogger { log(msg: string) { console.log(msg); } }

      const sharedKernel = defineBuilderConfig({
        injections: [
          { token: useInterface<ILogger>(), provider: ConsoleLogger }
        ]
      });

      class UserService {
        constructor(
          private logger: ILogger,
          private db: IDatabase  // Missing!
        ) {}
      }

      export const childContainer = defineBuilderConfig({
        useContainer: sharedKernel,
        injections: [
          { token: UserService }
        ]
      });
    `;

    const program = createProgram(fileName, fileContent);
    const analyzer = new Analyzer(program);
    const graph = analyzer.extract();

    const validator = new GraphValidator();
    expect(() => validator.validate(graph)).toThrow(/Missing binding.*IDatabase/);
  });

  it('should extract tokens from declareContainerTokens', () => {
    const fileName = 'legacy-container.ts';
    const fileContent = `
      function defineBuilderConfig(config: any) { return config; }
      function declareContainerTokens<T>(container: any): T { return container; }

      class AuthService { validate() { return true; } }
      class LegacyRepo { find() { return null; } }

      const legacyContainer = {}; // Simulated legacy container

      const legacy = declareContainerTokens<{
        AuthService: AuthService;
        LegacyRepo: LegacyRepo;
      }>(legacyContainer);

      class UserService {
        constructor(
          private auth: AuthService,
          private repo: LegacyRepo
        ) {}
      }

      export const app = defineBuilderConfig({
        useContainer: legacy,
        injections: [
          { token: UserService }
        ]
      });
    `;

    const program = createProgram(fileName, fileContent);
    const analyzer = new Analyzer(program);
    const graph = analyzer.extract();

    // Should have the declared tokens
    expect(graph.parentProvidedTokens).toBeDefined();
    expect(Array.from(graph.parentProvidedTokens!).some(t => t.includes('AuthService'))).toBe(true);
    expect(Array.from(graph.parentProvidedTokens!).some(t => t.includes('LegacyRepo'))).toBe(true);

    // Validator should pass
    const validator = new GraphValidator();
    expect(() => validator.validate(graph)).not.toThrow();
  });

  it('should handle multi-level parent hierarchy', () => {
    const fileName = 'multi-level.ts';
    const fileContent = `
      function defineBuilderConfig(config: any) { return config; }
      function useInterface<T>(): any { return null; }

      interface ILogger { log(msg: string): void; }
      interface IDatabase { query(): void; }

      class ConsoleLogger implements ILogger { log(msg: string) {} }
      class PostgresDB implements IDatabase { query() {} }

      // Level 1: Infrastructure
      const infrastructure = defineBuilderConfig({
        injections: [
          { token: useInterface<ILogger>(), provider: ConsoleLogger }
        ]
      });

      // Level 2: Domain (inherits Infrastructure)
      const domain = defineBuilderConfig({
        useContainer: infrastructure,
        injections: [
          { token: useInterface<IDatabase>(), provider: PostgresDB }
        ]
      });

      // Level 3: Application (inherits Domain + Infrastructure transitively)
      class AppService {
        constructor(
          private logger: ILogger,   // From infrastructure (2 levels up)
          private db: IDatabase      // From domain (1 level up)
        ) {}
      }

      export const app = defineBuilderConfig({
        useContainer: domain,
        injections: [
          { token: AppService }
        ]
      });
    `;

    const program = createProgram(fileName, fileContent);
    const analyzer = new Analyzer(program);
    const graph = analyzer.extract();

    // Should have tokens from both levels
    expect(graph.parentProvidedTokens).toBeDefined();

    // Validator should pass - all dependencies are available
    const validator = new GraphValidator();
    expect(() => validator.validate(graph)).not.toThrow();
  });

  it('should not detect false cycle with parent dependencies', () => {
    const fileName = 'no-false-cycle.ts';
    const fileContent = `
      function defineBuilderConfig(config: any) { return config; }
      function useInterface<T>(): any { return null; }

      interface ILogger { log(msg: string): void; }
      class ConsoleLogger implements ILogger { log(msg: string) {} }

      const parent = defineBuilderConfig({
        injections: [
          { token: useInterface<ILogger>(), provider: ConsoleLogger }
        ]
      });

      class ServiceA {
        constructor(private logger: ILogger, private b: ServiceB) {}
      }

      class ServiceB {
        constructor(private logger: ILogger) {}  // Also uses ILogger from parent
      }

      export const child = defineBuilderConfig({
        useContainer: parent,
        injections: [
          { token: ServiceB },
          { token: ServiceA }
        ]
      });
    `;

    const program = createProgram(fileName, fileContent);
    const analyzer = new Analyzer(program);
    const graph = analyzer.extract();

    // Should NOT throw cycle error (ILogger is from parent, not a cycle)
    const validator = new GraphValidator();
    expect(() => validator.validate(graph)).not.toThrow();
  });

  it('should throw duplicate error when local token is already in parent', () => {
    const fileName = 'duplicate-parent.ts';
    const fileContent = `
      function defineBuilderConfig(config: any) { return config; }
      function useInterface<T>(): any { return null; }

      interface ILogger { log(msg: string): void; }
      class ConsoleLogger implements ILogger { log(msg: string) {} }
      class FileLogger implements ILogger { log(msg: string) {} }

      // Parent provides ILogger
      const parent = defineBuilderConfig({
        injections: [
          { token: useInterface<ILogger>(), provider: ConsoleLogger }
        ]
      });

      // Child tries to re-register ILogger - should be an error!
      export const child = defineBuilderConfig({
        useContainer: parent,
        injections: [
          { token: useInterface<ILogger>(), provider: FileLogger }  // Duplicate!
        ]
      });
    `;

    const program = createProgram(fileName, fileContent);
    const analyzer = new Analyzer(program);
    const graph = analyzer.extract();

    const validator = new GraphValidator();
    expect(() => validator.validate(graph)).toThrow(/Duplicate registration.*ILogger.*parent/);
  });
});

