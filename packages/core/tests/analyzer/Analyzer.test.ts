import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import * as ts from 'typescript';
import { Analyzer } from '../../src/analyzer/Analyzer';

describe('Analyzer', () => {
  const findNodeByName = (graph: any, name: string) => {
    for (const [key, value] of graph.nodes) {
      if (key.includes(name)) return { key, value };
    }
    return undefined;
  };

  it('should extract dependency graph from fixture', () => {
    const fixturePath = path.resolve(__dirname, '../fixtures/simple-container.ts');

    const program = ts.createProgram([fixturePath], {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.CommonJS,
    });

    const analyzer = new Analyzer(program);
    const graph = analyzer.extract();

    // Verify nodes exist (using partial match since interface IDs include file path)
    const loggerNode = findNodeByName(graph, 'ILogger');
    const userNode = findNodeByName(graph, 'UserService');

    expect(loggerNode).toBeDefined();
    expect(userNode).toBeDefined();

    // Verify bindings
    expect(loggerNode?.value.service.type).toBe('explicit');
    expect(loggerNode?.value.service.implementationSymbol.getName()).toBe('ConsoleLogger');

    expect(userNode?.value.service.type).toBe('autowire');

    // Verify dependencies
    // UserService depends on ILogger
    expect(userNode?.value.dependencies.some((d: string) => d.includes('ILogger'))).toBe(true);
  });

  it('should extract scope from binding options', () => {
      // Create a virtual file for this test
      const fileName = 'scope-test.ts';
      const fileContent = `
        import { defineBuilderConfig } from '@djodjonx/neosyringe';
        class A {}
        class B {}
        export const container = defineBuilderConfig({
          injections: [
            { token: A, lifecycle: 'transient' },
            { token: B, lifecycle: 'singleton' }
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

      const nodeA = findNodeByName(graph, 'A');
      const nodeB = findNodeByName(graph, 'B');
      expect(nodeA?.value.service.lifecycle).toBe('transient');
      expect(nodeB?.value.service.lifecycle).toBe('singleton');
  });
});
