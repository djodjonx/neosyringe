import { describe, it, expect } from 'vitest';
import * as ts from 'typescript';
import { Analyzer } from '../../src/analyzer/Analyzer';

const createProgram = (fileName: string, fileContent: string) => {
  const host = ts.createCompilerHost({});
  const orig = host.getSourceFile;
  host.getSourceFile = (name, lang) =>
    name === fileName ? ts.createSourceFile(fileName, fileContent, lang) : orig(name, lang);
  return ts.createProgram([fileName], {}, host);
};

describe('Analyzer - useValue', () => {
  it('should detect useValue and set type to value', () => {
    const program = createProgram('test.ts', `
      function defineBuilderConfig(c: any) { return c; }
      function useInterface<T>(): any { return null; }

      interface DatabaseConfig { url: string; port: number; }

      export const container = defineBuilderConfig({
        injections: [
          { token: useInterface<DatabaseConfig>(), useValue: { url: 'localhost', port: 5432 } }
        ]
      });
    `);

    const graph = new Analyzer(program).extract();
    const node = [...graph.nodes.values()].find(n => n.service.tokenId.includes('DatabaseConfig'));

    expect(node).toBeDefined();
    expect(node!.service.type).toBe('value');
    expect(node!.service.valueSource).toBe("{ url: 'localhost', port: 5432 }");
  });

  it('should reject useValue with useInterface<string>() and suggest useProperty', () => {
    const program = createProgram('test.ts', `
      function defineBuilderConfig(c: any) { return c; }
      function useInterface<T>(): any { return null; }

      export const container = defineBuilderConfig({
        injections: [
          { token: useInterface<string>(), useValue: process.env.API_URL }
        ]
      });
    `);

    const graph = new Analyzer(program).extract();
    expect(graph.errors).toBeDefined();
    expect(graph.errors!.length).toBeGreaterThan(0);
    expect(graph.errors![0].message).toContain('useProperty');
  });

  it('should reject useValue with useInterface<number>()', () => {
    const program = createProgram('test.ts', `
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
  });

  it('should ignore lifecycle for useValue (always singleton)', () => {
    const program = createProgram('test.ts', `
      function defineBuilderConfig(c: any) { return c; }
      function useInterface<T>(): any { return null; }

      interface Config { timeout: number; }

      export const container = defineBuilderConfig({
        injections: [
          { token: useInterface<Config>(), useValue: { timeout: 3000 }, lifecycle: 'transient' }
        ]
      });
    `);

    const graph = new Analyzer(program).extract();
    const node = [...graph.nodes.values()].find(n => n.service.tokenId.includes('Config'));
    expect(node!.service.lifecycle).toBe('singleton');
  });
});
