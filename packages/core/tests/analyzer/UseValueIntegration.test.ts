import { describe, it, expect } from 'vitest';
import * as ts from 'typescript';
import { Analyzer } from '../../src/analyzer/Analyzer';
import { Generator } from '../../src/generator/Generator';

const createProgram = (fileName: string, content: string) => {
  const host = ts.createCompilerHost({});
  const orig = host.getSourceFile;
  host.getSourceFile = (n, l) => n === fileName ? ts.createSourceFile(fileName, content, l) : orig(n, l);
  return ts.createProgram([fileName], {}, host);
};

describe('useValue — Analyzer to Generator integration', () => {
  it('should generate working container with useValue', () => {
    const program = createProgram('container.ts', `
      function defineBuilderConfig(c: any) { return c; }
      function useInterface<T>(): any { return null; }

      interface AppConfig { apiUrl: string; timeout: number; }
      class ApiService { constructor(private config: AppConfig) {} }

      export const container = defineBuilderConfig({
        injections: [
          { token: useInterface<AppConfig>(), useValue: { apiUrl: 'http://api.example.com', timeout: 5000 } },
          { token: ApiService }
        ]
      });
    `);

    const graph = new Analyzer(program).extract();
    expect(graph.errors ?? []).toHaveLength(0);

    const code = new Generator(graph, true).generate();

    // Value factory
    expect(code).toContain("return { apiUrl: 'http://api.example.com', timeout: 5000 };");
    // ApiService receives the config
    expect(code).toContain('new ApiService(');
    // No undefined references
    expect(code).not.toContain('new undefined');
  });

  it('should propagate primitive type error through graph.errors', () => {
    const program = createProgram('container.ts', `
      function defineBuilderConfig(c: any) { return c; }
      function useInterface<T>(): any { return null; }

      export const container = defineBuilderConfig({
        injections: [
          { token: useInterface<number>(), useValue: 42 }
        ]
      });
    `);

    const graph = new Analyzer(program).extract();
    expect(graph.errors!.length).toBeGreaterThan(0);
    expect(graph.errors![0].message).toContain('useProperty');
    expect(graph.errors![0].message).toContain('number');
  });
});
