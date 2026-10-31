import { describe, it, expect } from 'vitest';
import init from '../src/index';
import * as ts from 'typescript';
import * as path from 'path';

describe('LSP unsupported constructor diagnostic', () => {
  const modules = { typescript: ts };
  const pluginFactory = init(modules);
  const fileName = path.resolve('/tmp/untyped-ctor.ts');
  const fileContent = `
    import { defineBuilderConfig } from '@djodjonx/neosyringe';
    class UserService { constructor(logger) {} }
    export const container = defineBuilderConfig({
      injections: [
        { token: UserService }
      ]
    });
  `;

  const program = ts.createProgram({
    rootNames: [fileName],
    options: {},
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
    },
  });

  const proxy = pluginFactory.create({
    languageService: {
      getSemanticDiagnostics: () => [],
      getProgram: () => program,
    },
    project: {
      projectService: {
        logger: {
          info: () => {},
          loggingEnabled: () => false,
          startGroup: () => {},
          endGroup: () => {},
        },
      },
    },
  } as any);

  it('reports code 9994 when a required constructor parameter has no type', () => {
    const diagnostics = proxy.getSemanticDiagnostics(fileName);
    const diagnostic = diagnostics.find((item) =>
      typeof item.messageText === 'string' && item.messageText.includes("parameter 'logger'"),
    );

    expect(diagnostic?.code).toBe(9994);
    expect(diagnostic?.messageText).toContain("Constructor 'UserService' parameter 'logger'");
  });
});
