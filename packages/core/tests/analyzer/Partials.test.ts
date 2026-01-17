import { describe, it, expect } from 'vitest';
import * as ts from 'typescript';
import { Analyzer } from '../../src/analyzer/Analyzer';

describe('Analyzer V2 - Partials', () => {
  it('should extract injections from imported partials', () => {
    const mainFile = 'main.ts';
    const partialFile = 'partial.ts';

    const partialContent = `
      import { definePartialConfig } from '@djodjonx/neosyringe';
      class Logger {}
      export const partial = definePartialConfig({
        injections: [
          { token: Logger }
        ]
      });
    `;

    const mainContent = `
      import { defineBuilderConfig } from '@djodjonx/neosyringe';
      import { partial } from './partial';
      class UserService {}

      export const config = defineBuilderConfig({
        extends: [partial],
        injections: [
          { token: UserService }
        ]
      });
    `;

    const compilerHost = ts.createCompilerHost({});
    const originalGetSourceFile = compilerHost.getSourceFile;
    const originalFileExists = compilerHost.fileExists;

    const files = new Map([
        [mainFile, mainContent],
        [partialFile, partialContent]
    ]);

    compilerHost.getSourceFile = (name, languageVersion) => {
        if (files.has(name)) {
            return ts.createSourceFile(name, files.get(name)!, languageVersion);
        }
        return originalGetSourceFile(name, languageVersion);
    };

    compilerHost.fileExists = (name) => files.has(name) || originalFileExists(name);

    compilerHost.resolveModuleNames = (moduleNames, _containingFile) => {
        return moduleNames.map(moduleName => {
            if (moduleName.startsWith('./')) {
                // simple resolution for test
                const resolvedFileName = moduleName.replace('./', '') + '.ts';
                if (files.has(resolvedFileName)) {
                    return {
                        resolvedFileName: resolvedFileName,
                        isExternalLibraryImport: false,
                        extension: ts.Extension.Ts
                    };
                }
            }
            return undefined;
        });
    };

    // Create program with both files
    const program = ts.createProgram([mainFile, partialFile], {
        moduleResolution: ts.ModuleResolutionKind.NodeJs
    }, compilerHost);

    const analyzer = new Analyzer(program);
    const graph = analyzer.extract();

    const hasNode = (name: string) => Array.from(graph.nodes.keys()).some((k: any) => k.includes(name));

    // Verify nodes from MAIN
    expect(hasNode('UserService')).toBe(true);

    // Verify nodes from PARTIAL
    expect(hasNode('Logger')).toBe(true);
  });
});
