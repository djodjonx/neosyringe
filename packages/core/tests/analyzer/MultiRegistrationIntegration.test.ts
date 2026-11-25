import { describe, it, expect } from 'vitest';
import * as ts from 'typescript';
import { Analyzer } from '../../src/analyzer/Analyzer';
import { Generator } from '../../src/generator/Generator';

const createProgram = (fileName: string, content: string) => {
  const host = ts.createCompilerHost({});
  const orig = host.getSourceFile.bind(host);
  host.getSourceFile = (n, l) => n === fileName ? ts.createSourceFile(fileName, content, l) : orig(n, l);
  return ts.createProgram([fileName], {}, host);
};

describe('resolveAll — Analyzer to Generator integration', () => {
  it('should generate resolveAll with all multi-providers', () => {
    const program = createProgram('container.ts', `
      import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';
      function defineBuilderConfig(c: any) { return c; }
      function useInterface<T>(): any { return null; }

      interface IMiddleware { handle(req: any): void; }
      class AuthMiddleware { handle(req: any) {} }
      class LogMiddleware { handle(req: any) {} }
      class RateLimiter { handle(req: any) {} }

      export const container = defineBuilderConfig({
        injections: [
          { token: useInterface<IMiddleware>(), provider: AuthMiddleware, multi: true },
          { token: useInterface<IMiddleware>(), provider: LogMiddleware, multi: true },
          { token: useInterface<IMiddleware>(), provider: RateLimiter, multi: true },
        ]
      });
    `);

    const graph = new Analyzer(program).extract();
    expect(graph.errors ?? []).toHaveLength(0);

    // Three multi-nodes for IMiddleware
    const multiEntry = [...(graph.multiNodes ?? new Map()).entries()]
      .find(([k]) => k.includes('IMiddleware'));
    expect(multiEntry).toBeDefined();
    expect(multiEntry![1]).toHaveLength(3);

    const code = new Generator(graph, true).generate();

    expect(code).toContain('public resolveAll<T>(token: unknown): T[]');
    expect(code).toContain('new AuthMiddleware()');
    expect(code).toContain('new LogMiddleware()');
    expect(code).toContain('new RateLimiter()');
    expect(code).not.toContain('new undefined');
  });

  it('should not include multi-tokens in regular resolve()', () => {
    const program = createProgram('container.ts', `
      import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';
      function defineBuilderConfig(c: any) { return c; }
      function useInterface<T>(): any { return null; }

      interface IPlugin { run(): void; }
      class PluginA { run() {} }
      class PluginB { run() {} }

      export const container = defineBuilderConfig({
        injections: [
          { token: useInterface<IPlugin>(), provider: PluginA, multi: true },
          { token: useInterface<IPlugin>(), provider: PluginB, multi: true },
        ]
      });
    `);

    const graph = new Analyzer(program).extract();
    const code = new Generator(graph, true, undefined, true, false, 'reference').generate();

    // resolveAll exists
    expect(code).toContain('public resolveAll<T>');

    // IPlugin should NOT appear in resolveLocal's own body (bounded by the next
    // member — the debug getters — not by end-of-file, which would also catch
    // the unrelated _dependencyGraph/_graph debug data that legitimately
    // mentions IPlugin). The section must exist: an empty one would pass for any token.
    const resolveLocalSection = code.split('private resolveLocal')[1]?.split('public get _graph')[0] ?? '';
    expect(resolveLocalSection).toContain('return undefined;');
    expect(resolveLocalSection).not.toContain('IPlugin');

    // The default emitter has no resolveLocal: a multi token has no row in the dispatch table, only in the list table.
    const dispatched = new Generator(graph, true).generate();
    expect(dispatched).not.toContain('private resolveLocal');
    expect(dispatched).toContain('private static __neoListsTable()');
    expect(dispatched).not.toMatch(/private static __neoDispatch\b/);
    const listsTable = dispatched.split('private static __neoListsTable()')[1]?.split('\n  }')[0] ?? '';
    expect(listsTable).toContain('IPlugin');
  });
});
