import { describe, it, expect } from 'vitest';
import * as ts from 'typescript';
import { Analyzer } from '../../src/analyzer/Analyzer';
import { GraphValidator } from '../../src/generator/GraphValidator';

describe('Analyzer Safety', () => {
  it('should throw error on duplicate registration', () => {
    const fileName = 'duplicate-test.ts';
    const fileContent = `
      import { defineBuilderConfig } from '@djodjonx/neosyringe';
      class A {}
      export const container = defineBuilderConfig({
        injections: [
          { token: A },
          { token: A }  // Duplicate
        ]
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

    // Check that duplicate error was collected
    expect(graph.errors).toBeDefined();
    expect(graph.errors!.length).toBeGreaterThan(0);

    const duplicateError = graph.errors!.find(e => e.type === 'duplicate');
    expect(duplicateError).toBeDefined();
    // Should show the original code 'A' not the transformed tokenId
    expect(duplicateError!.message).toContain("Duplicate registration: 'A'");
  });

  it('should throw error on duplicate with parent container', () => {
    const fileName = 'duplicate-parent-test.ts';
    const fileContent = `
      import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';

      interface ILogger { log(): void; }
      class ConsoleLogger implements ILogger { log() {} }
      class FileLogger implements ILogger { log() {} }

      const parent = defineBuilderConfig({
        injections: [
          { token: useInterface<ILogger>(), provider: ConsoleLogger }
        ]
      });

      export const child = defineBuilderConfig({
        useContainer: parent,
        injections: [
          { token: useInterface<ILogger>(), provider: FileLogger }  // Duplicate!
        ]
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

// The duplicate with parent is detected by GraphValidator, not Analyzer
    const validator = new GraphValidator();

    expect(() => validator.validate(graph)).toThrowError(/Duplicate registration.*parent/);
  });
});

