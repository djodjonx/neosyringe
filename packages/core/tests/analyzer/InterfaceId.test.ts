import { describe, it, expect } from 'vitest';
import * as ts from 'typescript';
import { Analyzer } from '../../src/analyzer/Analyzer';

describe('Analyzer V2 - Interface ID Stability', () => {
  it('should generate different IDs for same-named interfaces in different files', () => {
    const fileA = 'src/feature-a/types.ts';
    const contentA = `
      import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';
      interface ILogger { a: string; }
      class LoggerA implements ILogger { a: string; }
      export const configA = defineBuilderConfig({
        injections: [{ token: useInterface<ILogger>(), provider: LoggerA }]
      });
    `;
    
    const fileB = 'src/feature-b/types.ts';
    const contentB = `
      import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';
      interface ILogger { b: number; }
      class LoggerB implements ILogger { b: number; }
      export const configB = defineBuilderConfig({
        injections: [{ token: useInterface<ILogger>(), provider: LoggerB }]
      });
    `;
    
    const compilerHost = ts.createCompilerHost({});
    const originalGetSourceFile = compilerHost.getSourceFile;
    const originalFileExists = compilerHost.fileExists;
    const files = new Map([[fileA, contentA], [fileB, contentB]]);
    
    compilerHost.getSourceFile = (name, languageVersion) => {
        if (files.has(name)) return ts.createSourceFile(name, files.get(name)!, languageVersion);
        return originalGetSourceFile(name, languageVersion);
    };
    compilerHost.fileExists = (name) => files.has(name) || originalFileExists(name);

    const program = ts.createProgram([fileA, fileB], {}, compilerHost);
    const analyzer = new Analyzer(program);
    const graph = analyzer.extract();
    
    // We expect 2 nodes in the graph because the IDs should be different.
    // If they collide (both "ILogger"), map size will be 1.
    expect(graph.nodes.size).toBe(2);
    
    // Check IDs
    const keys = Array.from(graph.nodes.keys());
    expect(keys[0]).not.toBe(keys[1]);
    expect(keys[0]).toContain('ILogger');
    expect(keys[1]).toContain('ILogger');
  });
});
