import { describe, it, expect } from 'vitest';
import * as ts from 'typescript';
import { Analyzer } from '../../src/analyzer/Analyzer';

/**
 * Tests for missing dependency validation.
 */
describe('MissingDependencyValidator', () => {
  function createProgram(fileName: string, source: string): ts.Program {
    const compilerHost = ts.createCompilerHost({});
    const originalGetSourceFile = compilerHost.getSourceFile;

    compilerHost.getSourceFile = (name, languageVersion) => {
      if (name === fileName) {
        return ts.createSourceFile(name, source, languageVersion, true);
      }
      return originalGetSourceFile.call(compilerHost, name, languageVersion);
    };

    return ts.createProgram([fileName], {}, compilerHost);
  }

  describe('partialConfig', () => {
    it('should detect missing constructor dependency in partialConfig', () => {
      const source = `
        class Repository {}

        class UserService {
          constructor(private repo: Repository) {}
        }

        export const partial = definePartialConfig({
          injections: [
            { token: UserService }
          ]
        });
      `;

      const program = createProgram('test.ts', source);
      const analyzer = new Analyzer(program);
      const result = analyzer.extractForFile('test.ts');

      const missingErrors = result.errors.filter(e => e.type === 'missing');
      expect(missingErrors.length).toBeGreaterThan(0);
      expect(missingErrors[0].message).toContain('Repository');
      expect(missingErrors[0].message).toContain('UserService');
    });

    it('should not error when all dependencies are present', () => {
      const source = `
        class Repository {}

        class UserService {
          constructor(private repo: Repository) {}
        }

        export const partial = definePartialConfig({
          injections: [
            { token: Repository },
            { token: UserService }
          ]
        });
      `;

      const program = createProgram('test.ts', source);
      const analyzer = new Analyzer(program);
      const result = analyzer.extractForFile('test.ts');

      const missingErrors = result.errors.filter(e => e.type === 'missing');
      expect(missingErrors.length).toBe(0);
    });

    it('should handle multiple missing dependencies', () => {
      const source = `
        class Repository {}
        class Logger {}

        class UserService {
          constructor(
            private repo: Repository,
            private logger: Logger
          ) {}
        }

        export const partial = definePartialConfig({
          injections: [
            { token: UserService }
          ]
        });
      `;

      const program = createProgram('test.ts', source);
      const analyzer = new Analyzer(program);
      const result = analyzer.extractForFile('test.ts');

      const missingErrors = result.errors.filter(e => e.type === 'missing');
      expect(missingErrors.length).toBe(2);
    });
  });

  describe('defineBuilder', () => {
    it('should detect missing dependency not in parent', () => {
      const source = `
        class Repository {}
        class Logger {}

        class UserService {
          constructor(private repo: Repository) {}
        }

        const parent = defineBuilderConfig({
          injections: [
            { token: Logger }
          ]
        });

        export const builder = defineBuilderConfig({
          useContainer: parent,
          injections: [
            { token: UserService }
          ]
        });
      `;

      const program = createProgram('test.ts', source);
      const analyzer = new Analyzer(program);
      const result = analyzer.extractForFile('test.ts');

      const missingErrors = result.errors.filter(e => e.type === 'missing');
      expect(missingErrors.length).toBeGreaterThan(0);
      expect(missingErrors[0].message).toContain('Repository');
    });

    it('should resolve dependency from parent', () => {
      const source = `
        class Repository {}

        class UserService {
          constructor(private repo: Repository) {}
        }

        const parent = defineBuilderConfig({
          injections: [
            { token: Repository }
          ]
        });

        export const builder = defineBuilderConfig({
          useContainer: parent,
          injections: [
            { token: UserService }
          ]
        });
      `;

      const program = createProgram('test.ts', source);
      const analyzer = new Analyzer(program);
      const result = analyzer.extractForFile('test.ts');

      const missingErrors = result.errors.filter(e => e.type === 'missing');
      expect(missingErrors.length).toBe(0);
    });

    it('should resolve dependency from extends', () => {
      const source = `
        class Repository {}

        class UserService {
          constructor(private repo: Repository) {}
        }

        const partial = definePartialConfig({
          injections: [
            { token: Repository }
          ]
        });

        export const builder = defineBuilderConfig({
          extends: [partial],
          injections: [
            { token: UserService }
          ]
        });
      `;

      const program = createProgram('test.ts', source);
      const analyzer = new Analyzer(program);
      const result = analyzer.extractForFile('test.ts');

      const missingErrors = result.errors.filter(e => e.type === 'missing');
      expect(missingErrors.length).toBe(0);
    });

    it('should handle recursive extends', () => {
      const source = `
        class Repository {}
        class Logger {}

        class UserService {
          constructor(
            private repo: Repository,
            private logger: Logger
          ) {}
        }

        const partial1 = definePartialConfig({
          injections: [
            { token: Repository }
          ]
        });

        const partial2 = definePartialConfig({
          injections: [
            { token: Logger }
          ]
        });

        export const builder = defineBuilderConfig({
          extends: [partial1, partial2],
          injections: [
            { token: UserService }
          ]
        });
      `;

      const program = createProgram('test.ts', source);
      const analyzer = new Analyzer(program);
      const result = analyzer.extractForFile('test.ts');

      const missingErrors = result.errors.filter(e => e.type === 'missing');
      expect(missingErrors.length).toBe(0);
    });

    it('should combine parent and extends', () => {
      const source = `
        class Repository {}
        class Logger {}

        class UserService {
          constructor(
            private repo: Repository,
            private logger: Logger
          ) {}
        }

        const parent = defineBuilderConfig({
          injections: [
            { token: Repository }
          ]
        });

        const partial = definePartialConfig({
          injections: [
            { token: Logger }
          ]
        });

        export const builder = defineBuilderConfig({
          useContainer: parent,
          extends: [partial],
          injections: [
            { token: UserService }
          ]
        });
      `;

      const program = createProgram('test.ts', source);
      const analyzer = new Analyzer(program);
      const result = analyzer.extractForFile('test.ts');

      const missingErrors = result.errors.filter(e => e.type === 'missing');
      expect(missingErrors.length).toBe(0);
    });
  });

  describe('providers', () => {
    it('should check useClass provider', () => {
      const source = `
        interface IRepository {}
        class Repository {}

        class UserService {
          constructor(private repo: Repository) {}
        }

        export const builder = defineBuilderConfig({
          injections: [
            {
              token: useInterface<IRepository>(),
              provider: { useClass: Repository }
            },
            { token: UserService }
          ]
        });
      `;

      const program = createProgram('test.ts', source);
      const analyzer = new Analyzer(program);
      const result = analyzer.extractForFile('test.ts');

      const missingErrors = result.errors.filter(e => e.type === 'missing');
      // UserService needs Repository, but we only have IRepository
      expect(missingErrors.length).toBeGreaterThan(0);
    });

    it('should ignore useValue provider', () => {
      const source = `
        export const builder = defineBuilderConfig({
          injections: [
            {
              token: useProperty<string>(Config, 'apiKey'),
              provider: { useValue: 'test-key' }
            }
          ]
        });
      `;

      const program = createProgram('test.ts', source);
      const analyzer = new Analyzer(program);
      const result = analyzer.extractForFile('test.ts');

      const missingErrors = result.errors.filter(e => e.type === 'missing');
      expect(missingErrors.length).toBe(0);
    });

    it('should check useFactory provider dependencies', () => {
      const source = `
        class Repository {}

        export const builder = defineBuilderConfig({
          injections: [
            {
              token: useInterface<IUserService>(),
              provider: {
                useFactory: (repo: Repository) => new UserService(repo)
              }
            }
          ]
        });
      `;

      const program = createProgram('test.ts', source);
      const analyzer = new Analyzer(program);
      const result = analyzer.extractForFile('test.ts');

      // Factory dependencies are handled at runtime via container.resolve()
      // So we don't validate them statically
      const missingErrors = result.errors.filter(e => e.type === 'missing');
      expect(missingErrors.length).toBe(0);
    });
  });

  describe('edge cases', () => {
    it('should handle class with no constructor', () => {
      const source = `
        class SimpleService {}

        export const builder = defineBuilderConfig({
          injections: [
            { token: SimpleService }
          ]
        });
      `;

      const program = createProgram('test.ts', source);
      const analyzer = new Analyzer(program);
      const result = analyzer.extractForFile('test.ts');

      const missingErrors = result.errors.filter(e => e.type === 'missing');
      expect(missingErrors.length).toBe(0);
    });

    it('should handle constructor with no parameters', () => {
      const source = `
        class SimpleService {
          constructor() {}
        }

        export const builder = defineBuilderConfig({
          injections: [
            { token: SimpleService }
          ]
        });
      `;

      const program = createProgram('test.ts', source);
      const analyzer = new Analyzer(program);
      const result = analyzer.extractForFile('test.ts');

      const missingErrors = result.errors.filter(e => e.type === 'missing');
      expect(missingErrors.length).toBe(0);
    });

    it('should skip parameters without type annotation', () => {
      const source = `
        class UserService {
          constructor(param) {} // No type annotation
        }

        export const builder = defineBuilderConfig({
          injections: [
            { token: UserService }
          ]
        });
      `;

      const program = createProgram('test.ts', source);
      const analyzer = new Analyzer(program);
      const result = analyzer.extractForFile('test.ts');

      // No error because we can't determine the dependency type
      const missingErrors = result.errors.filter(e => e.type === 'missing');
      expect(missingErrors.length).toBe(0);
    });
  });
});
