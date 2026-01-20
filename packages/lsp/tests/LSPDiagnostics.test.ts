import { describe, it, expect } from 'vitest';
import init from '../src/index';
import * as ts from 'typescript';
import * as path from 'path';

describe('LSP Diagnostics Integration', () => {
  const modules = { typescript: ts };
  const pluginFactory = init(modules);

  it('should report circular dependency diagnostics', () => {
    const fileName = path.resolve('/tmp/cycle-test.ts');
    const fileContent = `
      import { defineBuilderConfig } from '@djodjonx/neosyringe';
      class A { constructor(b: B) {} }
      class B { constructor(a: A) {} }
      export const container = defineBuilderConfig({
        injections: [
          { token: A },
          { token: B }
        ]
      });
    `;

    const program = ts.createProgram({
        rootNames: [fileName],
        options: { },
        host: {
            ...ts.createCompilerHost({}),
            getSourceFile: (name) => name === fileName ? ts.createSourceFile(fileName, fileContent, ts.ScriptTarget.Latest) : undefined,
            writeFile: () => {},
            getDefaultLibFileName: () => 'lib.d.ts',
            getCurrentDirectory: () => '/',
            getCanonicalFileName: (f) => f,
            useCaseSensitiveFileNames: () => true,
            getNewLine: () => '\n',
            fileExists: (f) => f === fileName,
            readFile: (f) => f === fileName ? fileContent : undefined,
        }
    });

    const languageServiceMock = {
      getSemanticDiagnostics: () => [],
      getProgram: () => program,
    };

    const proxy = pluginFactory.create({
        languageService: languageServiceMock,
        project: { projectService: { logger: { info: () => {} } } }
    } as any);

    const diagnostics = proxy.getSemanticDiagnostics(fileName);

    expect(diagnostics.length).toBeGreaterThan(0);
    expect(diagnostics[0].messageText).toContain('[NeoSyringe] Circular dependency detected');
  });

  it('should report missing binding diagnostics', () => {
    const fileName = path.resolve('/tmp/missing-test.ts');
    const fileContent = `
      import { defineBuilderConfig } from '@djodjonx/neosyringe';
      class A { constructor(b: B) {} }
      export const container = defineBuilderConfig({
        injections: [
          { token: A }
        ]
      });
    `;

    const program = ts.createProgram({
        rootNames: [fileName],
        options: { },
        host: {
            ...ts.createCompilerHost({}),
            getSourceFile: (name) => name === fileName ? ts.createSourceFile(fileName, fileContent, ts.ScriptTarget.Latest) : undefined,
            writeFile: () => {},
            getDefaultLibFileName: () => 'lib.d.ts',
            getCurrentDirectory: () => '/',
            getCanonicalFileName: (f) => f,
            useCaseSensitiveFileNames: () => true,
            getNewLine: () => '\n',
            fileExists: (f) => f === fileName,
            readFile: (f) => f === fileName ? fileContent : undefined,
        }
    });

    const languageServiceMock = {
      getSemanticDiagnostics: () => [],
      getProgram: () => program,
    };

    const proxy = pluginFactory.create({ languageService: languageServiceMock } as any);
    const diagnostics = proxy.getSemanticDiagnostics(fileName);

    expect(diagnostics.length).toBeGreaterThan(0);
    expect(diagnostics[0].messageText).toContain('[NeoSyringe] Missing binding');
  });

  it('should not report error when dependency is in legacy container', () => {
    const fileName = path.resolve('/tmp/legacy-valid.ts');
    const fileContent = `
      import { defineBuilderConfig, declareContainerTokens } from '@djodjonx/neosyringe';

      class AuthService {}
      class UserService { constructor(auth: AuthService) {} }

      const legacy = declareContainerTokens<{
        AuthService: AuthService;
      }>({});

      export const container = defineBuilderConfig({
        useContainer: legacy,
        injections: [
          { token: UserService }
        ]
      });
    `;

    const program = ts.createProgram({
        rootNames: [fileName],
        options: { },
        host: {
            ...ts.createCompilerHost({}),
            getSourceFile: (name) => name === fileName ? ts.createSourceFile(fileName, fileContent, ts.ScriptTarget.Latest) : undefined,
            writeFile: () => {},
            getDefaultLibFileName: () => 'lib.d.ts',
            getCurrentDirectory: () => '/',
            getCanonicalFileName: (f) => f,
            useCaseSensitiveFileNames: () => true,
            getNewLine: () => '\n',
            fileExists: (f) => f === fileName,
            readFile: (f) => f === fileName ? fileContent : undefined,
        }
    });

    const languageServiceMock = {
      getSemanticDiagnostics: () => [],
      getProgram: () => program,
    };

    const proxy = pluginFactory.create({ languageService: languageServiceMock } as any);
    const diagnostics = proxy.getSemanticDiagnostics(fileName);

    // Should have NO errors - AuthService is in legacy container
    const neoSyringeErrors = diagnostics.filter((d: any) =>
      typeof d.messageText === 'string' && d.messageText.includes('[NeoSyringe]')
    );
    expect(neoSyringeErrors.length).toBe(0);
  });

  it('should report duplicate error when overriding legacy token', () => {
    const fileName = path.resolve('/tmp/legacy-duplicate.ts');
    const fileContent = `
      import { defineBuilderConfig, declareContainerTokens } from '@djodjonx/neosyringe';

      class AuthService {}
      class MyAuthService {}

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

    const program = ts.createProgram({
        rootNames: [fileName],
        options: { },
        host: {
            ...ts.createCompilerHost({}),
            getSourceFile: (name) => name === fileName ? ts.createSourceFile(fileName, fileContent, ts.ScriptTarget.Latest) : undefined,
            writeFile: () => {},
            getDefaultLibFileName: () => 'lib.d.ts',
            getCurrentDirectory: () => '/',
            getCanonicalFileName: (f) => f,
            useCaseSensitiveFileNames: () => true,
            getNewLine: () => '\n',
            fileExists: (f) => f === fileName,
            readFile: (f) => f === fileName ? fileContent : undefined,
        }
    });

    const languageServiceMock = {
      getSemanticDiagnostics: () => [],
      getProgram: () => program,
    };

    const proxy = pluginFactory.create({ languageService: languageServiceMock } as any);
    const diagnostics = proxy.getSemanticDiagnostics(fileName);

    expect(diagnostics.length).toBeGreaterThan(0);
    expect(diagnostics[0].messageText).toContain('[NeoSyringe]');
    expect(diagnostics[0].messageText).toContain('Duplicate');
  });

  it('should report duplicate error at exact position of duplicate registration', () => {
    const fileName = path.resolve('/tmp/duplicate-position.ts');
    const fileContent = `
      import { defineBuilderConfig } from '@djodjonx/neosyringe';

      // This is a comment that should NOT be highlighted
      class AuthService {}

      export const container = defineBuilderConfig({
        injections: [
          { token: AuthService },  // First registration
          { token: AuthService }   // Duplicate - should be highlighted HERE
        ]
      });
    `;

    const program = ts.createProgram({
        rootNames: [fileName],
        options: { },
        host: {
            ...ts.createCompilerHost({}),
            getSourceFile: (name) => name === fileName ? ts.createSourceFile(fileName, fileContent, ts.ScriptTarget.Latest) : undefined,
            writeFile: () => {},
            getDefaultLibFileName: () => 'lib.d.ts',
            getCurrentDirectory: () => '/',
            getCanonicalFileName: (f) => f,
            useCaseSensitiveFileNames: () => true,
            getNewLine: () => '\n',
            fileExists: (f) => f === fileName,
            readFile: (f) => f === fileName ? fileContent : undefined,
        }
    });

    const languageServiceMock = {
      getSemanticDiagnostics: () => [],
      getProgram: () => program,
    };

    const proxy = pluginFactory.create({ languageService: languageServiceMock } as any);
    const diagnostics = proxy.getSemanticDiagnostics(fileName);

    expect(diagnostics.length).toBeGreaterThan(0);
    const dupeDiag = diagnostics.find((d: any) =>
      typeof d.messageText === 'string' && d.messageText.includes('Duplicate')
    );

    expect(dupeDiag).toBeDefined();
    expect(dupeDiag!.messageText).toContain('[NeoSyringe]');
    expect(dupeDiag!.messageText).toContain('Duplicate registration');

    // Verify the error is NOT at position 0 (which would be the comment)
    expect(dupeDiag!.start).toBeDefined();
    expect(dupeDiag!.start).toBeGreaterThan(0);

    // Verify the error is positioned at the second registration
    const sourceFile = program.getSourceFile(fileName)!;
    const start = dupeDiag!.start!;
    const length = dupeDiag!.length!;
    const highlightedText = sourceFile.text.substring(start, start + length);

    // The highlighted text should contain the duplicate token registration
    expect(highlightedText).toContain('token');
    expect(highlightedText).toContain('AuthService');

    // Should NOT be highlighting the comment
    expect(highlightedText).not.toContain('This is a comment');
  });

  it('should report type mismatch error when provider does not satisfy token type', () => {
    const fileName = path.resolve('/tmp/type-mismatch.ts');
    const fileContent = `
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
          { token: useInterface<ILogger>(), provider: ConsoleLogger },  // OK
          { token: useInterface<IRepository>(), provider: ConsoleLogger }  // Type mismatch!
        ]
      });
    `;

    const program = ts.createProgram({
        rootNames: [fileName],
        options: { },
        host: {
            ...ts.createCompilerHost({}),
            getSourceFile: (name) => name === fileName ? ts.createSourceFile(fileName, fileContent, ts.ScriptTarget.Latest) : undefined,
            writeFile: () => {},
            getDefaultLibFileName: () => 'lib.d.ts',
            getCurrentDirectory: () => '/',
            getCanonicalFileName: (f) => f,
            useCaseSensitiveFileNames: () => true,
            getNewLine: () => '\n',
            fileExists: (f) => f === fileName,
            readFile: (f) => f === fileName ? fileContent : undefined,
        }
    });

    const languageServiceMock = {
      getSemanticDiagnostics: () => [],
      getProgram: () => program,
    };

    const proxy = pluginFactory.create({ languageService: languageServiceMock } as any);
    const diagnostics = proxy.getSemanticDiagnostics(fileName);

    expect(diagnostics.length).toBeGreaterThan(0);
    const typeMismatchDiag = diagnostics.find((d: any) =>
      typeof d.messageText === 'string' && d.messageText.includes('Type mismatch')
    );

    expect(typeMismatchDiag).toBeDefined();
    expect(typeMismatchDiag!.messageText).toContain('[NeoSyringe]');
    expect(typeMismatchDiag!.messageText).toContain('not assignable');

    // Verify the error is positioned at the second registration
    expect(typeMismatchDiag!.start).toBeDefined();
    expect(typeMismatchDiag!.start).toBeGreaterThan(0);

    const sourceFile = program.getSourceFile(fileName)!;
    const start = typeMismatchDiag!.start!;
    const length = typeMismatchDiag!.length!;
    const highlightedText = sourceFile.text.substring(start, start + length);

    // Should highlight the registration with type mismatch
    expect(highlightedText).toContain('IRepository');
    expect(highlightedText).toContain('ConsoleLogger');
  });
});

