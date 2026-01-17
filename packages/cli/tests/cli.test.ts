/**
 * CLI Tests
 *
 * Tests the CLI validation logic (not the entry point).
 */
import { describe, it, expect } from 'vitest';
import * as ts from 'typescript';
import { Analyzer } from '../../src/analyzer/Analyzer';
import { GraphValidator } from '../../src/generator/GraphValidator';

describe('CLI - Validation Logic', () => {
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

  describe('Validation Success', () => {
    it('should pass validation for valid configuration', () => {
      const program = createProgram('valid.ts', `
        function defineBuilderConfig(config: any) { return config; }
        class A {}
        class B { constructor(a: A) {} }
        export const c = defineBuilderConfig({
          injections: [{ token: A }, { token: B }]
        });
      `);

      const analyzer = new Analyzer(program);
      const graph = analyzer.extract();
      const validator = new GraphValidator();

      expect(() => validator.validate(graph)).not.toThrow();
      expect(graph.nodes.size).toBe(2);
    });

    it('should report correct service count', () => {
      const program = createProgram('count.ts', `
        function defineBuilderConfig(config: any) { return config; }
        class A {}
        class B {}
        class C {}
        class D {}
        class E {}
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

      const analyzer = new Analyzer(program);
      const graph = analyzer.extract();

      expect(graph.nodes.size).toBe(5);
    });
  });

  describe('Validation Errors', () => {
    it('should detect circular dependency', () => {
      const program = createProgram('circular.ts', `
        function defineBuilderConfig(config: any) { return config; }
        class A { constructor(b: B) {} }
        class B { constructor(a: A) {} }
        export const c = defineBuilderConfig({
          injections: [{ token: A }, { token: B }]
        });
      `);

      const analyzer = new Analyzer(program);
      const graph = analyzer.extract();
      const validator = new GraphValidator();

      expect(() => validator.validate(graph)).toThrow(/Circular dependency/);
    });

    it('should detect missing binding', () => {
      const program = createProgram('missing.ts', `
        function defineBuilderConfig(config: any) { return config; }
        class Missing {}
        class A { constructor(m: Missing) {} }
        export const c = defineBuilderConfig({
          injections: [{ token: A }]
        });
      `);

      const analyzer = new Analyzer(program);
      const graph = analyzer.extract();
      const validator = new GraphValidator();

      expect(() => validator.validate(graph)).toThrow(/Missing binding.*Missing/);
    });

    it('should detect duplicate registration', () => {
      const program = createProgram('duplicate.ts', `
        function defineBuilderConfig(config: any) { return config; }
        class A {}
        export const c = defineBuilderConfig({
          injections: [{ token: A }, { token: A }]
        });
      `);

      const analyzer = new Analyzer(program);

      expect(() => analyzer.extract()).toThrow(/Duplicate registration.*A/);
    });
  });

  describe('Error Message Quality', () => {
    it('should include service names in circular error', () => {
      const program = createProgram('circular-names.ts', `
        function defineBuilderConfig(config: any) { return config; }
        class UserService { constructor(o: OrderService) {} }
        class OrderService { constructor(u: UserService) {} }
        export const c = defineBuilderConfig({
          injections: [{ token: UserService }, { token: OrderService }]
        });
      `);

      const analyzer = new Analyzer(program);
      const graph = analyzer.extract();
      const validator = new GraphValidator();

      try {
        validator.validate(graph);
        expect.fail('Should have thrown');
      } catch (e: any) {
        expect(e.message).toContain('UserService');
        expect(e.message).toContain('OrderService');
      }
    });

    it('should include dependent service in missing error', () => {
      const program = createProgram('missing-names.ts', `
        function defineBuilderConfig(config: any) { return config; }
        class DatabaseConnection {}
        class UserRepository { constructor(db: DatabaseConnection) {} }
        export const c = defineBuilderConfig({
          injections: [{ token: UserRepository }]
        });
      `);

      const analyzer = new Analyzer(program);
      const graph = analyzer.extract();
      const validator = new GraphValidator();

      try {
        validator.validate(graph);
        expect.fail('Should have thrown');
      } catch (e: any) {
        expect(e.message).toContain('UserRepository');
        expect(e.message).toContain('DatabaseConnection');
      }
    });
  });

  describe('Complex Scenarios', () => {
    it('should handle valid complex graph', () => {
      const program = createProgram('complex.ts', `
        function defineBuilderConfig(config: any) { return config; }
        function useInterface<T>(): any { return null; }

        interface ILogger {}
        interface IDatabase {}

        class ConsoleLogger implements ILogger {}
        class PostgresDB implements IDatabase {}
        class UserRepo { constructor(db: IDatabase) {} }
        class AuthService { constructor(logger: ILogger) {} }
        class UserService { constructor(repo: UserRepo, auth: AuthService, logger: ILogger) {} }

        export const c = defineBuilderConfig({
          injections: [
            { token: useInterface<ILogger>(), provider: ConsoleLogger },
            { token: useInterface<IDatabase>(), provider: PostgresDB },
            { token: UserRepo },
            { token: AuthService },
            { token: UserService }
          ]
        });
      `);

      const analyzer = new Analyzer(program);
      const graph = analyzer.extract();
      const validator = new GraphValidator();

      expect(() => validator.validate(graph)).not.toThrow();
    });

    it('should detect circular in complex graph', () => {
      const program = createProgram('complex-circular.ts', `
        function defineBuilderConfig(config: any) { return config; }

        class A { constructor(d: D) {} }
        class B { constructor(a: A) {} }
        class C { constructor(b: B) {} }
        class D { constructor(c: C) {} }  // Creates cycle: A -> D -> C -> B -> A

        export const c = defineBuilderConfig({
          injections: [
            { token: A },
            { token: B },
            { token: C },
            { token: D }
          ]
        });
      `);

      const analyzer = new Analyzer(program);
      const graph = analyzer.extract();
      const validator = new GraphValidator();

      expect(() => validator.validate(graph)).toThrow(/Circular/);
    });
  });

  describe('Scoped Injections', () => {
    it('should pass validation with scoped: true override', () => {
      const program = createProgram('scoped-valid.ts', `
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

    it('should fail validation without scoped: true', () => {
      const program = createProgram('scoped-invalid.ts', `
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

      expect(() => validator.validate(graph)).toThrow(/Duplicate registration.*ILogger/);
    });

    it('should suggest scoped: true in error message', () => {
      const program = createProgram('scoped-suggest.ts', `
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
        expect(e.message).toContain("scoped: true");
      }
    });
  });
});

