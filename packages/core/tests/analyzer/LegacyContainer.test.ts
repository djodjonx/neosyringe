import { describe, it, expect } from 'vitest';
import * as ts from 'typescript';
import { Analyzer } from '../../src/analyzer/Analyzer';
import { GraphValidator } from '../../src/generator/GraphValidator';
import { Generator } from '../../src/generator/Generator';

describe('Legacy Container Integration', () => {
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

  describe('declareContainerTokens', () => {
    it('should extract tokens from declareContainerTokens type argument', () => {
      const fileName = 'legacy-tokens.ts';
      const fileContent = `
        function defineBuilderConfig(config: any) { return config; }
        function declareContainerTokens<T>(container: any): T { return container; }

        class AuthService { validate() {} }
        class UserRepository { find() {} }
        class CacheService { get() {} }

        const tsyringeContainer = {}; // Simulated tsyringe

        const legacy = declareContainerTokens<{
          AuthService: AuthService;
          UserRepository: UserRepository;
          CacheService: CacheService;
        }>(tsyringeContainer);

        class NewService {
          constructor(
            private auth: AuthService,
            private repo: UserRepository
          ) {}
        }

        export const container = defineBuilderConfig({
          useContainer: legacy,
          injections: [
            { token: NewService }
          ]
        });
      `;

      const program = createProgram(fileName, fileContent);
      const analyzer = new Analyzer(program);
      const graph = analyzer.extract();

      // Verify all legacy tokens are detected
      expect(graph.parentProvidedTokens).toBeDefined();
      const hasParentToken = (name: string) => Array.from(graph.parentProvidedTokens!).some((t: any) => t.includes(name));
      
      expect(hasParentToken('AuthService')).toBe(true);
      expect(hasParentToken('UserRepository')).toBe(true);
      expect(hasParentToken('CacheService')).toBe(true);

      // Verify legacy container reference is stored
      expect(graph.legacyContainers).toBeDefined();
      expect(graph.legacyContainers!.includes('legacy')).toBe(true);

      // Validation should pass
      const validator = new GraphValidator();
      expect(() => validator.validate(graph)).not.toThrow();
    });

    it('should fail validation if legacy token is not declared', () => {
      const fileName = 'missing-legacy.ts';
      const fileContent = `
        function defineBuilderConfig(config: any) { return config; }
        function declareContainerTokens<T>(container: any): T { return container; }

        class AuthService { validate() {} }
        class MissingService { doSomething() {} }  // Not declared in legacy!

        const legacy = declareContainerTokens<{
          AuthService: AuthService;
          // MissingService NOT declared!
        }>({});

        class NewService {
          constructor(
            private auth: AuthService,
            private missing: MissingService  // This will fail!
          ) {}
        }

        export const container = defineBuilderConfig({
          useContainer: legacy,
          injections: [
            { token: NewService }
          ]
        });
      `;

      const program = createProgram(fileName, fileContent);
      const analyzer = new Analyzer(program);
      const graph = analyzer.extract();

      const validator = new GraphValidator();
      expect(() => validator.validate(graph)).toThrow(/Missing binding.*MissingService/);
    });

    it('should prevent duplicate registration of legacy tokens', () => {
      const fileName = 'duplicate-legacy.ts';
      const fileContent = `
        function defineBuilderConfig(config: any) { return config; }
        function declareContainerTokens<T>(container: any): T { return container; }

        class AuthService { validate() {} }
        class MyAuthService { validate() {} }

        const legacy = declareContainerTokens<{
          AuthService: AuthService;
        }>({});

        export const container = defineBuilderConfig({
          useContainer: legacy,
          injections: [
            { token: AuthService, provider: MyAuthService }  // Duplicate!
          ]
        });
      `;

      const program = createProgram(fileName, fileContent);
      const analyzer = new Analyzer(program);
      const graph = analyzer.extract();

      const validator = new GraphValidator();
      expect(() => validator.validate(graph)).toThrow(/Duplicate registration.*AuthService.*parent/);
    });
  });

  describe('Generator with Legacy Containers', () => {
    it('should generate code with legacy container delegation', () => {
      const fileName = 'generate-legacy.ts';
      const fileContent = `
        function defineBuilderConfig(config: any) { return config; }
        function declareContainerTokens<T>(container: any): T { return container; }

        class AuthService { validate() {} }

        const tsyringeContainer = {};

        const legacy = declareContainerTokens<{
          AuthService: AuthService;
        }>(tsyringeContainer);

        class NewService {
          constructor(private auth: AuthService) {}
        }

        export const container = defineBuilderConfig({
          name: 'MyApp',
          useContainer: legacy,
          injections: [
            { token: NewService }
          ]
        });
      `;

      const program = createProgram(fileName, fileContent);
      const analyzer = new Analyzer(program);
      const graph = analyzer.extract();

      const generator = new Generator(graph);
      const code = generator.generate();

      // Should include legacy container in constructor
      expect(code).toContain('[legacy]');
      expect(code).toContain("'MyApp'");

      // Should have resolve logic for legacy delegation
      expect(code).toContain('this.legacy');
      expect(code).toContain('legacyContainer.resolve');
    });
  });

  describe('Mixed Neo-Syringe and Legacy', () => {
    it('should allow mixing Neo-Syringe and legacy dependencies', () => {
      const fileName = 'mixed.ts';
      const fileContent = `
        function defineBuilderConfig(config: any) { return config; }
        function declareContainerTokens<T>(container: any): T { return container; }
        function useInterface<T>(): any { return null; }

        // Legacy types
        class AuthService { validate() {} }

        // New types
        interface ILogger { log(msg: string): void; }
        class ConsoleLogger implements ILogger { log(msg: string) {} }

        const legacy = declareContainerTokens<{
          AuthService: AuthService;
        }>({});

        class UserService {
          constructor(
            private auth: AuthService,  // From legacy!
            private logger: ILogger     // From neo-syringe!
          ) {}
        }

        export const container = defineBuilderConfig({
          useContainer: legacy,
          injections: [
            { token: useInterface<ILogger>(), provider: ConsoleLogger },
            { token: UserService }
          ]
        });
      `;

      const program = createProgram(fileName, fileContent);
      const analyzer = new Analyzer(program);
      const graph = analyzer.extract();

      // Should have ILogger as local node
      const hasLogger = Array.from(graph.nodes.keys()).some(k => k.includes('ILogger'));
      expect(hasLogger).toBe(true);

      // Should have AuthService in parent tokens
      const hasParentToken = (name: string) => Array.from(graph.parentProvidedTokens!).some((t: any) => t.includes(name));
      expect(hasParentToken('AuthService')).toBe(true);

      // Validation should pass
      const validator = new GraphValidator();
      expect(() => validator.validate(graph)).not.toThrow();
    });

    it('should handle multiple legacy containers', () => {
      const fileName = 'multi-legacy.ts';
      const fileContent = `
        function defineBuilderConfig(config: any) { return config; }
        function declareContainerTokens<T>(container: any): T { return container; }

        class AuthService {}
        class CacheService {}

        // First legacy (e.g., tsyringe)
        const authLegacy = declareContainerTokens<{
          AuthService: AuthService;
        }>({});

        // We can only use ONE useContainer at a time
        // But we can nest containers

        const parentContainer = defineBuilderConfig({
          useContainer: authLegacy,
          injections: []
        });

        class NewService {
          constructor(private auth: AuthService) {}
        }

        export const container = defineBuilderConfig({
          useContainer: parentContainer,  // Inherits authLegacy transitively
          injections: [
            { token: NewService }
          ]
        });
      `;

      const program = createProgram(fileName, fileContent);
      const analyzer = new Analyzer(program);
      const graph = analyzer.extract();

      // AuthService should be available (transitively)
      const hasParentToken = (name: string) => Array.from(graph.parentProvidedTokens!).some((t: any) => t.includes(name));
      expect(hasParentToken('AuthService')).toBe(true);

      // Validation should pass
      const validator = new GraphValidator();
      expect(() => validator.validate(graph)).not.toThrow();
    });
  });
});

