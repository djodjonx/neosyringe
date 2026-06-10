import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as ts from 'typescript';
import { neoSyringePlugin } from '../src/index';

// Minimal tsconfig mock (same pattern as unplugin.test.ts)
vi.mock('typescript', async (importOriginal) => {
  const actual = await importOriginal<typeof import('typescript')>();
  return {
    ...actual,
    findConfigFile: vi.fn().mockReturnValue('/project/tsconfig.json'),
    readConfigFile: vi.fn().mockReturnValue({ config: {} }),
    parseJsonConfigFileContent: vi.fn().mockReturnValue({ options: {}, fileNames: [], errors: [] }),
  };
});

const FILE = '/project/src/container.ts';

function makeTransform() {
  // Fresh plugin instance per test to reset registeredTokens / usedTokens
  const plugin = neoSyringePlugin.vite();
  // @ts-expect-error - testing specific method
  return plugin.transform as (code: string, id: string) => string | undefined;
}

function makeBuildEnd() {
  const plugin = neoSyringePlugin.vite();
  return {
    // @ts-expect-error - testing specific method
    transform: plugin.transform as (code: string, id: string) => string | undefined,
    buildEnd: (plugin as any).buildEnd as () => void,
  };
}

const SAME_FILE_CODE = `
  import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';

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

describe('Plugin — multi-container per file', () => {
  beforeEach(() => vi.clearAllMocks());

  it('does NOT leave any raw defineBuilderConfig() call in the emitted output', () => {
    const transform = makeTransform();
    const result = transform(SAME_FILE_CODE, FILE) ?? SAME_FILE_CODE;
    expect(result).not.toContain('defineBuilderConfig(');
  });

  it('emits a NeoContainer class for the parent (sharedKernel)', () => {
    const transform = makeTransform();
    const result = transform(SAME_FILE_CODE, FILE) ?? SAME_FILE_CODE;
    // Generator produces class NeoContainer that is instantiated for the parent
    expect(result).toContain('class NeoContainer');
    expect(result).toContain('const sharedKernel = new NeoContainer');
  });

  it('emits a NeoContainer class for the child (container)', () => {
    const transform = makeTransform();
    const result = transform(SAME_FILE_CODE, FILE) ?? SAME_FILE_CODE;
    // Both containers must be present with NeoContainer classes
    const containerClassMatches = (result.match(/class NeoContainer/g) ?? []);
    expect(containerClassMatches.length).toBeGreaterThanOrEqual(2);
    expect(result).toContain('const container = new NeoContainer');
  });

  it('buildEnd does not throw when a parent token is used at an injection site', () => {
    const GRAPHQL_FILE = '/project/src/plugins/graphql.ts';
    const GRAPHQL_CODE = `
      import { useInterface } from '@djodjonx/neosyringe';
      import { IToken } from './interfaces';
      const token = useInterface<IToken>();
    `;

    const { transform, buildEnd } = makeBuildEnd();
    transform(SAME_FILE_CODE, FILE);
    transform(GRAPHQL_CODE, GRAPHQL_FILE);
    expect(() => buildEnd()).not.toThrow();
  });

  it('buildEnd DOES throw for a genuinely unregistered token', () => {
    const GRAPHQL_FILE = '/project/src/plugins/graphql.ts';
    const GRAPHQL_CODE = `
      import { useInterface } from '@djodjonx/neosyringe';
      interface IUnknown { x(): void; }
      const token = useInterface<IUnknown>();
    `;

    const { transform, buildEnd } = makeBuildEnd();
    transform(SAME_FILE_CODE, FILE);
    transform(GRAPHQL_CODE, GRAPHQL_FILE);
    expect(() => buildEnd()).toThrow(/Unregistered token.*IUnknown/);
  });
});
