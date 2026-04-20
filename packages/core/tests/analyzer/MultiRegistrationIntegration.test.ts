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

describe('resolveAll — Analyzer to Generator integration', () => {
  it('should generate resolveAll with all multi-providers', () => {
    const program = createProgram('container.ts', `
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

    expect(code).toContain('public resolveAll<T>(token: any): T[]');
    expect(code).toContain('new AuthMiddleware()');
    expect(code).toContain('new LogMiddleware()');
    expect(code).toContain('new RateLimiter()');
    expect(code).not.toContain('new undefined');
  });

  it('should not include multi-tokens in regular resolve()', () => {
    const program = createProgram('container.ts', `
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
    const code = new Generator(graph, true).generate();

    // resolveAll exists
    expect(code).toContain('public resolveAll<T>');

    // IPlugin should NOT appear in resolveLocal
    const resolveLocalSection = code.split('private resolveLocal')[1]?.split('public destroy')[0] ?? '';
    expect(resolveLocalSection).not.toContain('IPlugin');
  });
});
