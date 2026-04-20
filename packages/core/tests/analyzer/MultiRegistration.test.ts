import { describe, it, expect } from 'vitest';
import * as ts from 'typescript';
import { Analyzer } from '../../src/analyzer/Analyzer';

const createProgram = (fileName: string, content: string) => {
  const host = ts.createCompilerHost({});
  const orig = host.getSourceFile;
  host.getSourceFile = (n, l) => n === fileName ? ts.createSourceFile(fileName, content, l) : orig(n, l);
  return ts.createProgram([fileName], {}, host);
};

describe('Analyzer - multi registrations', () => {
  it('should collect multi-registrations in multiNodes', () => {
    const program = createProgram('test.ts', `
      function defineBuilderConfig(c: any) { return c; }
      function useInterface<T>(): any { return null; }

      interface IMiddleware { handle(req: any): void; }
      class AuthMiddleware implements IMiddleware { handle(req: any) {} }
      class LogMiddleware implements IMiddleware { handle(req: any) {} }

      export const container = defineBuilderConfig({
        injections: [
          { token: useInterface<IMiddleware>(), provider: AuthMiddleware, multi: true },
          { token: useInterface<IMiddleware>(), provider: LogMiddleware, multi: true },
        ]
      });
    `);

    const graph = new Analyzer(program).extract();

    // Should not be in regular nodes (single-resolve)
    const inNodes = [...graph.nodes.keys()].some(k => k.includes('IMiddleware'));
    expect(inNodes).toBe(false);

    // Should be in multiNodes
    expect(graph.multiNodes).toBeDefined();
    const multiEntry = [...graph.multiNodes!.entries()].find(([k]) => k.includes('IMiddleware'));
    expect(multiEntry).toBeDefined();
    expect(multiEntry![1]).toHaveLength(2);
  });

  it('should emit a duplicate error when one has multi and one does not', () => {
    const program = createProgram('test.ts', `
      function defineBuilderConfig(c: any) { return c; }
      function useInterface<T>(): any { return null; }

      interface IMiddleware { handle(req: any): void; }
      class AuthMiddleware implements IMiddleware { handle(req: any) {} }
      class LogMiddleware implements IMiddleware { handle(req: any) {} }

      export const container = defineBuilderConfig({
        injections: [
          { token: useInterface<IMiddleware>(), provider: AuthMiddleware },
          { token: useInterface<IMiddleware>(), provider: LogMiddleware, multi: true },
        ]
      });
    `);

    const graph = new Analyzer(program).extract();
    expect(graph.errors).toBeDefined();
    expect(graph.errors!.length).toBeGreaterThan(0);
    expect(graph.errors![0].message).toContain('multi');
  });

  it('should route useValue multi-registrations to multiNodes', () => {
    const program = createProgram('test.ts', `
      function defineBuilderConfig(c: any) { return c; }
      function useInterface<T>(): any { return null; }

      interface IConfig { url: string; }

      export const container = defineBuilderConfig({
        injections: [
          { token: useInterface<IConfig>(), useValue: { url: 'a' }, multi: true },
          { token: useInterface<IConfig>(), useValue: { url: 'b' }, multi: true },
        ]
      });
    `);

    const graph = new Analyzer(program).extract();
    expect(graph.errors ?? []).toHaveLength(0);

    // Should NOT be in regular nodes
    const inNodes = [...graph.nodes.keys()].some(k => k.includes('IConfig'));
    expect(inNodes).toBe(false);

    // Should be in multiNodes with 2 entries
    const multiEntry = [...(graph.multiNodes ?? new Map()).entries()].find(([k]) => k.includes('IConfig'));
    expect(multiEntry).toBeDefined();
    expect(multiEntry![1]).toHaveLength(2);
  });

  it('should not treat multi-registrations as duplicates', () => {
    const program = createProgram('test.ts', `
      function defineBuilderConfig(c: any) { return c; }
      function useInterface<T>(): any { return null; }

      interface IPlugin { execute(): void; }
      class PluginA implements IPlugin { execute() {} }
      class PluginB implements IPlugin { execute() {} }
      class PluginC implements IPlugin { execute() {} }

      export const container = defineBuilderConfig({
        injections: [
          { token: useInterface<IPlugin>(), provider: PluginA, multi: true },
          { token: useInterface<IPlugin>(), provider: PluginB, multi: true },
          { token: useInterface<IPlugin>(), provider: PluginC, multi: true },
        ]
      });
    `);

    const graph = new Analyzer(program).extract();
    expect(graph.errors ?? []).toHaveLength(0);

    const multiEntry = [...graph.multiNodes!.entries()].find(([k]) => k.includes('IPlugin'));
    expect(multiEntry![1]).toHaveLength(3);
  });
});
