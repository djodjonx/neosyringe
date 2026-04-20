import { describe, it, expect } from 'vitest';
import * as ts from 'typescript';
import { Analyzer } from '../../src/analyzer/Analyzer';

const createProgram = (fileName: string, content: string) => {
  const host = ts.createCompilerHost({});
  const orig = host.getSourceFile;
  host.getSourceFile = (n, l) => n === fileName ? ts.createSourceFile(fileName, content, l) : orig(n, l);
  return ts.createProgram([fileName], {}, host);
};

describe('Analyzer - async factories', () => {
  it('should detect async arrow function factory and set isAsync', () => {
    const program = createProgram('test.ts', `
      function defineBuilderConfig(c: any) { return c; }
      function useInterface<T>(): any { return null; }

      interface IDatabase { query(sql: string): any; }

      export const container = defineBuilderConfig({
        injections: [
          {
            token: useInterface<IDatabase>(),
            provider: async () => ({ query: (sql: string) => [] }),
            useFactory: true
          }
        ]
      });
    `);

    const graph = new Analyzer(program).extract();
    const node = [...graph.nodes.values()].find(n => n.service.tokenId.includes('IDatabase'));

    expect(node).toBeDefined();
    expect(node!.service.isAsync).toBe(true);
    expect(node!.service.type).toBe('factory');
  });

  it('should set isAsync for async function expression', () => {
    const program = createProgram('test.ts', `
      function defineBuilderConfig(c: any) { return c; }
      function useInterface<T>(): any { return null; }

      interface ICache { get(key: string): any; }

      export const container = defineBuilderConfig({
        injections: [
          {
            token: useInterface<ICache>(),
            provider: async function() { return { get: (k: string) => null }; },
            useFactory: true
          }
        ]
      });
    `);

    const graph = new Analyzer(program).extract();
    const node = [...graph.nodes.values()].find(n => n.service.tokenId.includes('ICache'));

    expect(node!.service.isAsync).toBe(true);
  });

  it('should NOT set isAsync for sync factory', () => {
    const program = createProgram('test.ts', `
      function defineBuilderConfig(c: any) { return c; }
      function useInterface<T>(): any { return null; }

      interface ILogger { log(msg: string): void; }

      export const container = defineBuilderConfig({
        injections: [
          {
            token: useInterface<ILogger>(),
            provider: () => ({ log: (msg: string) => console.log(msg) }),
            useFactory: true
          }
        ]
      });
    `);

    const graph = new Analyzer(program).extract();
    const node = [...graph.nodes.values()].find(n => n.service.tokenId.includes('ILogger'));

    expect(node!.service.isAsync).toBeUndefined();
  });

  it('should emit an error for async factory with lifecycle: transient', () => {
    const program = createProgram('test.ts', `
      function defineBuilderConfig(c: any) { return c; }
      function useInterface<T>(): any { return null; }

      interface IDatabase { query(sql: string): any; }

      export const container = defineBuilderConfig({
        injections: [
          {
            token: useInterface<IDatabase>(),
            provider: async () => ({ query: (sql: string) => [] }),
            useFactory: true,
            lifecycle: 'transient'
          }
        ]
      });
    `);

    const graph = new Analyzer(program).extract();
    expect(graph.errors).toBeDefined();
    expect(graph.errors!.length).toBeGreaterThan(0);
    expect(graph.errors![0].message).toContain('transient');
    expect(graph.errors![0].message).toContain('Async');
  });
});
