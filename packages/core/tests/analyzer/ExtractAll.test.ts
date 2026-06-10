import { describe, it, expect } from 'vitest';
import * as ts from 'typescript';
import { Analyzer } from '../../src/analyzer/Analyzer';

const FILE = 'test-multi.ts';

function makeProgram(code: string) {
  const host = ts.createCompilerHost({});
  const orig = host.getSourceFile;
  host.getSourceFile = (name, version) => {
    if (name === FILE) return ts.createSourceFile(FILE, code, version);
    return orig(name, version);
  };
  return ts.createProgram([FILE], {}, host);
}

const SAME_FILE_CODE = `
  function defineBuilderConfig(c: any): any { return c; }
  function useInterface<T>(): any { return null; }

  interface ICache { get(k: string): any; }
  interface IToken { verify(t: string): boolean; }
  class RedisCache implements ICache { get(k: string) { return null; } }
  class JwtToken implements IToken { verify(t: string) { return true; } }

  export const sharedKernel = defineBuilderConfig({
    name: 'SharedKernel',
    injections: [
      { token: useInterface<ICache>(), provider: RedisCache },
      { token: useInterface<IToken>(), provider: JwtToken },
    ],
  });

  export const container = defineBuilderConfig({
    useContainer: sharedKernel,
  });
`;

describe('Analyzer.extractAll()', () => {
  it('returns one graph per defineBuilderConfig (parents included)', () => {
    const analyzer = new Analyzer(makeProgram(SAME_FILE_CODE));
    const graphs = analyzer.extractAll();
    // Must return 2 graphs — one for sharedKernel, one for container
    expect(graphs).toHaveLength(2);
  });

  it('each graph carries its source file name', () => {
    const analyzer = new Analyzer(makeProgram(SAME_FILE_CODE));
    const graphs = analyzer.extractAll();
    expect(graphs.every(g => g.sourceFileName === FILE)).toBe(true);
  });

  it('parent graph has its own tokens in nodes (not only parentProvidedTokens)', () => {
    const analyzer = new Analyzer(makeProgram(SAME_FILE_CODE));
    const graphs = analyzer.extractAll();
    const parent = graphs.find(g => g.exportedVariableName === 'sharedKernel');
    expect(parent).toBeDefined();
    // ICache and IToken must be in parent's nodes
    expect(parent!.nodes.size).toBe(2);
  });

  it('child graph has parentProvidedTokens populated from the parent', () => {
    const analyzer = new Analyzer(makeProgram(SAME_FILE_CODE));
    const graphs = analyzer.extractAll();
    const child = graphs.find(g => g.exportedVariableName === 'container');
    expect(child).toBeDefined();
    expect(child!.parentProvidedTokens?.size).toBe(2);
  });

  it('each graph has independent source positions', () => {
    const analyzer = new Analyzer(makeProgram(SAME_FILE_CODE));
    const graphs = analyzer.extractAll();
    const starts = graphs.map(g => g.defineBuilderConfigStart!);
    // Each graph points to a different call site
    expect(new Set(starts).size).toBe(2);
  });

  it('single-container file still returns one graph (non-regression)', () => {
    const code = `
      function defineBuilderConfig(c: any): any { return c; }
      function useInterface<T>(): any { return null; }
      interface IFoo { foo(): void; }
      class FooImpl implements IFoo { foo() {} }
      export const app = defineBuilderConfig({
        injections: [{ token: useInterface<IFoo>(), provider: FooImpl }],
      });
    `;
    const analyzer = new Analyzer(makeProgram(code));
    const graphs = analyzer.extractAll();
    expect(graphs).toHaveLength(1);
    expect(graphs[0].exportedVariableName).toBe('app');
    expect(graphs[0].nodes.size).toBe(1);
  });
});
