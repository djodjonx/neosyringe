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

describe('Async factories — Analyzer to Generator integration', () => {
  it('should generate initialize() for async factory', () => {
    const program = createProgram('container.ts', `
      function defineBuilderConfig(c: any) { return c; }
      function useInterface<T>(): any { return null; }

      interface IDatabase { query(sql: string): any; }
      class UserService { constructor(private db: IDatabase) {} }

      export const container = defineBuilderConfig({
        injections: [
          {
            token: useInterface<IDatabase>(),
            provider: async () => {
              const pool = { query: (sql: string) => [] };
              return pool;
            },
            useFactory: true
          },
          { token: UserService }
        ]
      });
    `);

    const graph = new Analyzer(program).extract();
    expect(graph.errors ?? []).toHaveLength(0);

    const dbNode = [...graph.nodes.values()].find(n => n.service.tokenId.includes('IDatabase'));
    expect(dbNode!.service.isAsync).toBe(true);

    const userNode = [...graph.nodes.values()].find(n => n.service.tokenId.includes('UserService'));
    expect(userNode!.service.isAsync).toBeFalsy();

    const code = new Generator(graph, true).generate();

    expect(code).toContain('public async initialize(): Promise<void>');
    expect(code).toContain('await this.create_');
    expect(code).toContain('IDatabase');
    expect(code).toContain('if (!this._initialized)');

    // UserService is NOT pre-created in initialize()
    const initSection = code.split('async initialize()')[1]?.split('public resolve')[0] ?? '';
    expect(initSection).not.toContain('UserService');
  });

  it('should NOT generate initialize() for all-sync container', () => {
    const program = createProgram('container.ts', `
      function defineBuilderConfig(c: any) { return c; }
      function useInterface<T>(): any { return null; }

      interface ILogger { log(msg: string): void; }
      class ConsoleLogger { log(msg: string) { console.log(msg); } }

      export const container = defineBuilderConfig({
        injections: [
          { token: useInterface<ILogger>(), provider: ConsoleLogger }
        ]
      });
    `);

    const graph = new Analyzer(program).extract();
    const code = new Generator(graph, true).generate();

    expect(code).not.toContain('async initialize()');
    expect(code).not.toContain('_initialized');
  });

  it('should emit error for async factory with transient lifecycle', () => {
    const program = createProgram('container.ts', `
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
    expect(graph.errors!.length).toBeGreaterThan(0);
    expect(graph.errors![0].message).toContain('transient');
    expect(graph.errors![0].message).toContain('Async');
  });

  it('should reset _initialized in destroy() to allow re-initialization in tests', () => {
    const program = createProgram('container.ts', `
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
    const code = new Generator(graph, true).generate();

    expect(code).toContain('destroy()');
    const destroySection = code.split('public destroy()')[1]?.split('}')[0] ?? '';
    expect(destroySection).toContain('_initialized = false');
  });
});
