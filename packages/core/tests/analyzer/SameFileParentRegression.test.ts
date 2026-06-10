/**
 * Regression test for: same-file parent container tokens flagged as
 * "unregistered" by the build plugin.
 *
 * Scenario: sharedKernel and container are in the same file.
 * useInterface<TokenService>() is used in a third file.
 * Expected: TokenService token is reachable from allGraphs.nodes.
 */
import { describe, it, expect } from 'vitest';
import * as ts from 'typescript';
import { Analyzer } from '../../src/analyzer/Analyzer';

const FILE = 'container.ts';

const CODE = `
  function defineBuilderConfig(c: any): any { return c; }
  function useInterface<T>(): any { return null; }

  interface CacheClient { get(k: string): any; }
  interface TokenService { verify(token: string): boolean; }

  class RedisCacheClient implements CacheClient { get(k: string) { return null; } }
  class JwtTokenService implements TokenService { verify(t: string) { return true; } }

  export const sharedKernel = defineBuilderConfig({
    name: 'SharedKernel',
    injections: [
      { token: useInterface<CacheClient>(), provider: RedisCacheClient },
      { token: useInterface<TokenService>(), provider: JwtTokenService },
    ],
  });

  export const container = defineBuilderConfig({
    useContainer: sharedKernel,
  });
`;

describe('Regression — same-file parent token registration', () => {
  function host(code: string) {
    const h = ts.createCompilerHost({});
    const orig = h.getSourceFile;
    h.getSourceFile = (name, v) => name === FILE ? ts.createSourceFile(FILE, code, v) : orig(name, v);
    return h;
  }

  it('extractAll(): TokenService token appears in some graph.nodes (not only parentProvidedTokens)', () => {
    const program = ts.createProgram([FILE], {}, host(CODE));
    const graphs = new Analyzer(program).extractAll();

    // The token ID for TokenService must exist in at least one graph's nodes
    const allRegisteredTokenIds = new Set<string>();
    for (const g of graphs) {
      for (const id of g.nodes.keys()) allRegisteredTokenIds.add(id);
    }

    // Find the token id that starts with 'TokenService'
    const tokenServiceId = [...allRegisteredTokenIds].find(id => id.startsWith('TokenService'));
    expect(tokenServiceId).toBeDefined();
  });

  it('extract() legacy path: TokenService token is in parentProvidedTokens of child graph (existing behaviour unchanged)', () => {
    const program = ts.createProgram([FILE], {}, host(CODE));
    const graph = new Analyzer(program).extract();

    // Legacy path: child graph's parentProvidedTokens has the token (no change expected)
    const tokenServiceId = [...(graph.parentProvidedTokens ?? [])].find(id =>
      id.startsWith('TokenService')
    );
    expect(tokenServiceId).toBeDefined();
  });
});
