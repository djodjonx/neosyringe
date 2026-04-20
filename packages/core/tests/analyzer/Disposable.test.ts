import { describe, it, expect } from 'vitest';
import * as ts from 'typescript';
import { Analyzer } from '../../src/analyzer/Analyzer';

const createProgram = (fileName: string, content: string) => {
  const host = ts.createCompilerHost({});
  const orig = host.getSourceFile;
  host.getSourceFile = (n, l) =>
    n === fileName ? ts.createSourceFile(fileName, content, l) : orig(n, l);
  return ts.createProgram([fileName], {}, host);
};

describe('Analyzer - disposable detection', () => {
  it('should set isDisposable for class with dispose(): void', () => {
    const program = createProgram('test.ts', `
      function defineBuilderConfig(c: any) { return c; }
      class DbConnection {
        query(sql: string) { return []; }
        dispose(): void { /* close pool */ }
      }
      export const container = defineBuilderConfig({
        injections: [{ token: DbConnection }]
      });
    `);

    const graph = new Analyzer(program).extract();
    const node = [...graph.nodes.values()].find(n => n.service.tokenId.includes('DbConnection'));

    expect(node).toBeDefined();
    expect(node!.service.isDisposable).toBe(true);
    expect(node!.service.isAsyncDisposable).toBeUndefined();
  });

  it('should set isAsyncDisposable for class with dispose(): Promise<void>', () => {
    const program = createProgram('test.ts', `
      function defineBuilderConfig(c: any) { return c; }
      class RedisClient {
        async dispose(): Promise<void> { /* disconnect */ }
      }
      export const container = defineBuilderConfig({
        injections: [{ token: RedisClient }]
      });
    `);

    const graph = new Analyzer(program).extract();
    const node = [...graph.nodes.values()].find(n => n.service.tokenId.includes('RedisClient'));

    expect(node!.service.isDisposable).toBeUndefined();
    expect(node!.service.isAsyncDisposable).toBe(true);
  });

  it('should NOT set isDisposable for class without dispose()', () => {
    const program = createProgram('test.ts', `
      function defineBuilderConfig(c: any) { return c; }
      class SimpleService { doWork() {} }
      export const container = defineBuilderConfig({
        injections: [{ token: SimpleService }]
      });
    `);

    const graph = new Analyzer(program).extract();
    const node = [...graph.nodes.values()].find(n => n.service.tokenId.includes('SimpleService'));

    expect(node!.service.isDisposable).toBeUndefined();
    expect(node!.service.isAsyncDisposable).toBeUndefined();
  });

  it('should NOT set isDisposable for factory registrations', () => {
    const program = createProgram('test.ts', `
      function defineBuilderConfig(c: any) { return c; }
      function useInterface<T>(): any { return null; }
      interface IConnection { query(): any; }
      export const container = defineBuilderConfig({
        injections: [{
          token: useInterface<IConnection>(),
          provider: () => ({ query: () => [], dispose: () => {} }),
          useFactory: true
        }]
      });
    `);

    const graph = new Analyzer(program).extract();
    const node = [...graph.nodes.values()].find(n => n.service.tokenId.includes('IConnection'));

    // Factories are excluded — we cannot inspect their return type statically
    expect(node!.service.isDisposable).toBeUndefined();
    expect(node!.service.isAsyncDisposable).toBeUndefined();
  });
});
