import { describe, it, expect } from 'vitest';
import * as ts from 'typescript';
import { Analyzer, TypeMismatchError } from '../../src/analyzer';

describe('Type Validation', () => {
  it('should throw TypeMismatchError when provider does not implement token interface', () => {
    const code = `
      import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';

      interface ILogger {
        log(message: string): void;
      }

      interface IRepository {
        save(data: any): void;
      }

      class ConsoleLogger implements ILogger {
        log(message: string): void {
          console.log(message);
        }
      }

      export const container = defineBuilderConfig({
        injections: [
          { token: useInterface<IRepository>(), provider: ConsoleLogger }
        ]
      });
    `;

    const sourceFile = ts.createSourceFile('test.ts', code, ts.ScriptTarget.Latest, true);
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
        readFile: (f) => f === 'test.ts' ? code : undefined,
      },
    });

    const analyzer = new Analyzer(program);

    const graph = analyzer.extract();

    // Check that errors were collected
    expect(graph.errors).toBeDefined();
    expect(graph.errors!.length).toBeGreaterThan(0);

    const typeError = graph.errors!.find(e => e.type === 'type-mismatch');
    expect(typeError).toBeDefined();
    expect(typeError!.message).toContain('Type mismatch');
    expect(typeError!.message).toContain('ConsoleLogger');
    expect(typeError!.message).toContain('IRepository');
    expect(typeError!.node).toBeDefined();
    expect(typeError!.sourceFile).toBeDefined();
  });

  it('should not throw when provider correctly implements token interface', () => {
    const code = `
      import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';

      interface ILogger {
        log(message: string): void;
      }

      class ConsoleLogger implements ILogger {
        log(message: string): void {
          console.log(message);
        }
      }

      export const container = defineBuilderConfig({
        injections: [
          { token: useInterface<ILogger>(), provider: ConsoleLogger }
        ]
      });
    `;

    const sourceFile = ts.createSourceFile('test.ts', code, ts.ScriptTarget.Latest, true);
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
        readFile: (f) => f === 'test.ts' ? code : undefined,
      },
    });

    const analyzer = new Analyzer(program);

    const graph = analyzer.extract();

    // Should not have type errors
    const typeErrors = graph.errors?.filter(e => e.type === 'type-mismatch') || [];
    expect(typeErrors.length).toBe(0);
  });

  it('should throw TypeMismatchError when provider has incompatible methods', () => {
    const code = `
      import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';

      interface IUserRepository {
        findById(id: string): Promise<User>;
        save(user: User): Promise<void>;
      }

      interface User {
        id: string;
        name: string;
      }

      class ProductRepository {
        findById(id: number): Promise<any> {
          return Promise.resolve({});
        }
      }

      export const container = defineBuilderConfig({
        injections: [
          { token: useInterface<IUserRepository>(), provider: ProductRepository }
        ]
      });
    `;

    const sourceFile = ts.createSourceFile('test.ts', code, ts.ScriptTarget.Latest, true);
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
        readFile: (f) => f === 'test.ts' ? code : undefined,
      },
    });

    const analyzer = new Analyzer(program);

    const graph = analyzer.extract();

    // Check that errors were collected
    expect(graph.errors).toBeDefined();
    expect(graph.errors!.length).toBeGreaterThan(0);

    const typeError = graph.errors!.find(e => e.type === 'type-mismatch');
    expect(typeError).toBeDefined();
    expect(typeError!.message).toContain('Type mismatch');
  });
});
