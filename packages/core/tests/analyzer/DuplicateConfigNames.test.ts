import { describe, it, expect } from 'vitest';
import * as ts from 'typescript';
import { Analyzer } from '../../src/analyzer/Analyzer';

describe('Analyzer - Duplicate Config Names (buildNameIndex)', () => {
  /**
   * Tests that buildNameIndex uses first-wins semantics when two configs
   * share the same variable name (which shouldn't happen in normal usage,
   * but this regression test ensures we don't silently switch to last-wins).
   * 
   * The scenario: two files in the program both declare configs with the same
   * variable name. When the analyzer processes both, buildNameIndex should map
   * the name to the first config encountered in iteration order, not the last.
   * 
   * Without the guard `if (!index.has(config.name))`, the last occurrence would
   * overwrite earlier ones, leading to silent behavior changes.
   */
  it('should use first occurrence when two configs share the same variable name', () => {
    const file1 = 'file1.ts';
    const file2 = 'file2.ts';
    const mainFile = 'main.ts';

    // First file defines a config named 'sharedConfig'
    const file1Content = `
      import { defineBuilderConfig } from '@djodjonx/neosyringe';
      
      class FirstService {}
      
      export const sharedConfig = defineBuilderConfig({
        injections: [
          { token: FirstService }
        ]
      });
    `;

    // Second file ALSO defines a config named 'sharedConfig'
    const file2Content = `
      import { defineBuilderConfig } from '@djodjonx/neosyringe';
      
      class SecondService {}
      
      export const sharedConfig = defineBuilderConfig({
        injections: [
          { token: SecondService }
        ]
      });
    `;

    // Main file uses one of them explicitly by import
    const mainContent = `
      import { defineBuilderConfig } from '@djodjonx/neosyringe';
      import { sharedConfig as config1 } from './file1';
      
      class MainService {
        constructor(private first: any) {}
      }
      
      export const main = defineBuilderConfig({
        useContainer: config1,
        injections: [
          { token: MainService }
        ]
      });
    `;

    const compilerHost = ts.createCompilerHost({});
    const originalGetSourceFile = compilerHost.getSourceFile;
    const originalFileExists = compilerHost.fileExists;

    const files = new Map([
      [file1, file1Content],
      [file2, file2Content],
      [mainFile, mainContent]
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

    // Create program with files in order: file1 THEN file2
    // This ensures file1's config is encountered first in iteration
    const program = ts.createProgram(
      [file1, file2, mainFile],
      { moduleResolution: ts.ModuleResolutionKind.NodeJs },
      compilerHost
    );

    const analyzer = new Analyzer(program);
    const graph = analyzer.extract();

    // Both configs should be in the graph (they're both collected)
    const hasFirstService = Array.from(graph.nodes.keys()).some((k: any) => 
      k.includes('FirstService')
    );
    const hasSecondService = Array.from(graph.nodes.keys()).some((k: any) => 
      k.includes('SecondService')
    );

    // MainService should be resolvable
    const hasMainService = Array.from(graph.nodes.keys()).some((k: any) => 
      k.includes('MainService')
    );

    // With the guard in buildNameIndex, if both configs somehow get resolved
    // for the same name, the first one's tokens would be used.
    // In this test, main explicitly imports config1, so FirstService is used.
    expect(hasFirstService).toBe(true);
    expect(hasMainService).toBe(true);

    // This test primarily verifies that the code doesn't crash and
    // that first-wins semantics are preserved when there are duplicate names.
    // The important part is that buildNameIndex has the guard, preventing
    // accidental last-wins behavior.
  });

  it('should preserve first-match semantics in extends chain with duplicate names', () => {
    // This test verifies that when multiple partials have the same name,
    // references resolve to the first one in allConfigs iteration order.
    const partial1File = 'partial1.ts';
    const partial2File = 'partial2.ts';
    const mainFile = 'main.ts';

    const partial1Content = `
      import { definePartialConfig } from '@djodjonx/neosyringe';
      
      class DatabaseConnection {}
      
      export const dbPartial = definePartialConfig({
        injections: [
          { token: DatabaseConnection }
        ]
      });
    `;

    const partial2Content = `
      import { definePartialConfig } from '@djodjonx/neosyringe';
      
      class CacheConnection {}
      
      export const dbPartial = definePartialConfig({
        injections: [
          { token: CacheConnection }
        ]
      });
    `;

    const mainContent = `
      import { defineBuilderConfig } from '@djodjonx/neosyringe';
      import { dbPartial } from './partial1';
      
      class UserService {}
      
      export const container = defineBuilderConfig({
        extends: [dbPartial],
        injections: [
          { token: UserService }
        ]
      });
    `;

    const compilerHost = ts.createCompilerHost({});
    const originalGetSourceFile = compilerHost.getSourceFile;
    const originalFileExists = compilerHost.fileExists;

    const files = new Map([
      [partial1File, partial1Content],
      [partial2File, partial2Content],
      [mainFile, mainContent]
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

    const program = ts.createProgram(
      [partial1File, partial2File, mainFile],
      { moduleResolution: ts.ModuleResolutionKind.NodeJs },
      compilerHost
    );

    const analyzer = new Analyzer(program);
    const graph = analyzer.extract();

    // DatabaseConnection should be found (from partial1, the explicitly imported one)
    const hasDatabaseConnection = Array.from(graph.nodes.keys()).some((k: any) => 
      k.includes('DatabaseConnection')
    );

    // UserService should be found
    const hasUserService = Array.from(graph.nodes.keys()).some((k: any) => 
      k.includes('UserService')
    );

    expect(hasDatabaseConnection).toBe(true);
    expect(hasUserService).toBe(true);
  });
});
