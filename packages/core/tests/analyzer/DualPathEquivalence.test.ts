import { describe, it, expect } from 'vitest';
import * as ts from 'typescript';
import { Analyzer } from '../../src/analyzer/Analyzer';
import { Generator } from '../../src/generator/Generator';

/**
 * Tests that verify both analysis paths (legacy extract() and modular extractForFile())
 * produce equivalent error detection on the same source code.
 * 
 * This test suite ensures architectural consistency between:
 * - Legacy path: extract() → Generator (CLI/build)
 * - Modular path: extractForFile() → CompositeValidator (LSP)
 */
describe('DualPathEquivalence', () => {
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

  describe('Missing dependency detection', () => {
    it('modular path should detect missing dependencies, legacy defers to Generator', () => {
      const source = `
        class Repository {}
        class Logger {}

        class UserService {
          constructor(
            private repo: Repository,
            private logger: Logger
          ) {}
        }

        export const container = defineBuilderConfig({
          injections: [
            { token: UserService }
          ]
        });
      `;

      const program = createProgram('test.ts', source);
      const analyzer = new Analyzer(program);

      // Modular path: extractForFile → detects missing dependencies
      const modularResult = analyzer.extractForFile('test.ts');
      const modularMissingErrors = modularResult.errors.filter(e => e.type === 'missing');

      // Legacy path: extract → does NOT populate graph.errors for missing deps
      // (those are deferred to Generator/runtime)
      const graph = analyzer.extract();
      const legacyErrors = graph.errors || [];
      const legacyMissingErrors = legacyErrors.filter(e => e.type === 'missing');

      // Only modular path detects missing dependencies at analysis time
      expect(modularMissingErrors.length).toBe(2);
      expect(legacyMissingErrors.length).toBe(0); // Legacy doesn't check

      // Verify error messages mention the missing tokens
      const modularMessages = modularMissingErrors.map(e => e.message).join(' ');
      expect(modularMessages).toContain('Repository');
      expect(modularMessages).toContain('Logger');
    });
  });

  describe('Duplicate registration detection', () => {
    it('should detect duplicates in both paths', () => {
      const source = `
        class Logger {}

        export const container = defineBuilderConfig({
          injections: [
            { token: Logger },
            { token: Logger }
          ]
        });
      `;

      const program = createProgram('test.ts', source);
      const analyzer = new Analyzer(program);

      // Modular path
      const modularResult = analyzer.extractForFile('test.ts');
      const modularDuplicates = modularResult.errors.filter(e => e.type === 'duplicate');

      // Legacy path
      const graph = analyzer.extract();
      const legacyErrors = graph.errors || [];
      const legacyDuplicates = legacyErrors.filter(e => e.type === 'duplicate');

      // Both paths should detect the duplicate
      expect(modularDuplicates.length).toBeGreaterThan(0);
      expect(legacyDuplicates.length).toBeGreaterThan(0);

      // Should be the same count
      expect(modularDuplicates.length).toBe(legacyDuplicates.length);
    });
  });

  describe('Type mismatch detection', () => {
    it('should detect type mismatches in both paths', () => {
      const source = `
        import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';

        interface ILogger {
          log(msg: string): void;
        }

        interface IRepository {
          save(data: any): void;
        }

        class UserService {
          save(_data: any): void {}
        }

        export const container = defineBuilderConfig({
          injections: [
            { token: useInterface<ILogger>(), provider: UserService }
          ]
        });
      `;

      const sourceFile = ts.createSourceFile('test.ts', source, ts.ScriptTarget.Latest, true);
      const program = ts.createProgram({
        rootNames: ['test.ts'],
        options: {},
        host: {
          ...ts.createCompilerHost({}),
          getSourceFile: (name) => name === 'test.ts' ? sourceFile : undefined,
          writeFile: () => {},
          getDefaultLibFileName: () => 'lib.d.ts',
          getCurrentDirectory: () => '/',
          getCanonicalFileName: (f) => f,
          useCaseSensitiveFileNames: () => true,
          getNewLine: () => '\n',
          fileExists: (f) => f === 'test.ts',
          readFile: (f) => f === 'test.ts' ? source : undefined,
        },
      });

      const analyzer = new Analyzer(program);

      // Modular path
      const modularResult = analyzer.extractForFile('test.ts');
      const modularTypeMismatches = modularResult.errors.filter(e => e.type === 'type-mismatch');

      // Legacy path
      const graph = analyzer.extract();
      const legacyErrors = graph.errors || [];
      const legacyTypeMismatches = legacyErrors.filter(e => e.type === 'type-mismatch');

      // Both paths should detect the type mismatch (ConfigParser checks this)
      expect(modularTypeMismatches.length).toBeGreaterThan(0);
      expect(legacyTypeMismatches.length).toBeGreaterThan(0);

      // Verify they find the same count
      expect(modularTypeMismatches.length).toBe(legacyTypeMismatches.length);
    });
  });

  describe('Valid configuration', () => {
    it('should produce no errors in both paths for valid config', () => {
      const source = `
        class Repository {}
        class Logger {}

        class UserService {
          constructor(
            private repo: Repository,
            private logger: Logger
          ) {}
        }

        export const container = defineBuilderConfig({
          injections: [
            { token: Repository },
            { token: Logger },
            { token: UserService }
          ]
        });
      `;

      const program = createProgram('test.ts', source);
      const analyzer = new Analyzer(program);

      // Modular path
      const modularResult = analyzer.extractForFile('test.ts');

      // Legacy path
      const graph = analyzer.extract();
      const legacyErrors = graph.errors || [];

      // Both paths should find no errors
      expect(modularResult.errors.length).toBe(0);
      expect(legacyErrors.length).toBe(0);

      // Generator should not throw
      expect(() => new Generator(graph)).not.toThrow();
    });
  });

  describe('Cycle detection', () => {
    it('modular path detects cycles at analysis, legacy at generation', () => {
      const source = `
        class ServiceA {
          constructor(private b: ServiceB) {}
        }

        class ServiceB {
          constructor(private a: ServiceA) {}
        }

        export const container = defineBuilderConfig({
          injections: [
            { token: ServiceA },
            { token: ServiceB }
          ]
        });
      `;

      const program = createProgram('test.ts', source);
      const analyzer = new Analyzer(program);

      // Modular path: detects cycles during analysis
      const modularResult = analyzer.extractForFile('test.ts');
      const modularCycles = modularResult.errors.filter(e => e.type === 'cycle');

      // Legacy path: extract() succeeds, but Generator throws during topologicalSort
      const graph = analyzer.extract();
      const legacyErrors = graph.errors || [];
      const legacyCycleErrors = legacyErrors.filter(e => e.type === 'cycle');

      // Modular path should detect cycle
      expect(modularCycles.length).toBeGreaterThan(0);

      // Legacy path doesn't populate cycle errors (deferred to Generator)
      expect(legacyCycleErrors.length).toBe(0);

      // But Generator should throw when trying to generate code
      expect(() => new Generator(graph).generate()).toThrow();
    });
  });
});
