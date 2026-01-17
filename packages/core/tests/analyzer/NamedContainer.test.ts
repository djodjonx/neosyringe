import { describe, it, expect } from 'vitest';
import * as ts from 'typescript';
import { Analyzer } from '../../src/analyzer/Analyzer';

describe('Analyzer - Named Containers', () => {
  it('should extract the container name from defineBuilderConfig', () => {
      const fileName = 'named-test.ts';
      const fileContent = `
        import { defineBuilderConfig } from '@djodjonx/neosyringe';
        export const container = defineBuilderConfig({
          name: 'AuthContainer',
          injections: []
        });
      `;

      const compilerHost = ts.createCompilerHost({});
      const originalGetSourceFile = compilerHost.getSourceFile;

      compilerHost.getSourceFile = (name, languageVersion) => {
          if (name === fileName) {
              return ts.createSourceFile(fileName, fileContent, languageVersion);
          }
          return originalGetSourceFile(name, languageVersion);
      };

      const program = ts.createProgram([fileName], {}, compilerHost);
      const analyzer = new Analyzer(program);
      const graph = analyzer.extract();

      expect(graph.containerName).toBe('AuthContainer');
  });

  it('should have undefined name if not provided', () => {
    const fileName = 'unnamed-test.ts';
    const fileContent = `
      import { defineBuilderConfig } from '@djodjonx/neosyringe';
      export const container = defineBuilderConfig({
        injections: []
      });
    `;

    const compilerHost = ts.createCompilerHost({});
    const originalGetSourceFile = compilerHost.getSourceFile;

    compilerHost.getSourceFile = (name, languageVersion) => {
        if (name === fileName) {
            return ts.createSourceFile(fileName, fileContent, languageVersion);
        }
        return originalGetSourceFile(name, languageVersion);
    };

    const program = ts.createProgram([fileName], {}, compilerHost);
    const analyzer = new Analyzer(program);
    const graph = analyzer.extract();

    expect(graph.containerName).toBeUndefined();
  });
});

