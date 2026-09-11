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
    const containerClassMatches = (result.match(/class NeoContainer\w*/g) ?? []);
    expect(containerClassMatches.length).toBeGreaterThanOrEqual(2);
  });

  it('gives the two same-file container classes distinct names (regression: duplicate-declaration SyntaxError)', () => {
    // Two defineBuilderConfig() calls sharing a module scope used to each emit an
    // identically-named `class NeoContainer` / `class NeoServiceNotFoundError`,
    // which is a SyntaxError (duplicate lexical declaration) once bundled — the
    // exact failure from the reported doc example (two containers in one file).
    const transform = makeTransform();
    const result = transform(SAME_FILE_CODE, FILE) ?? SAME_FILE_CODE;

    const containerClassNames = [...result.matchAll(/class (NeoContainer\w*) \{/g)].map(m => m[1]);
    const errorClassNames = [...result.matchAll(/class (NeoServiceNotFoundError\w*) extends Error/g)].map(m => m[1]);

    expect(containerClassNames.length).toBe(2);
    expect(new Set(containerClassNames).size).toBe(2);
    expect(errorClassNames.length).toBe(2);
    expect(new Set(errorClassNames).size).toBe(2);

    // Decisive check: the emitted code must actually compile without a
    // duplicate-declaration error (the real-world failure mode was an esbuild
    // "already been declared" error at bundle time, not caught by string checks).
    const virtualFile = '/project/src/__generated_container.ts';
    const host = ts.createCompilerHost({});
    const originalGetSourceFile = host.getSourceFile;
    host.getSourceFile = (name, version) =>
      name === virtualFile ? ts.createSourceFile(name, result, version, true) : originalGetSourceFile(name, version);

    const program = ts.createProgram(
      [virtualFile],
      { noEmit: true, skipLibCheck: true, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
      host
    );
    const diagnostics = ts.getPreEmitDiagnostics(program).filter(d => d.file?.fileName === virtualFile);
    const redeclarations = diagnostics.filter(d =>
      ts.flattenDiagnosticMessageText(d.messageText, ' ').includes('Cannot redeclare')
    );
    expect(redeclarations).toHaveLength(0);
  });

  it('regression: the exact doc example (two defineBuilderConfig calls in one file) compiles and wires correctly', () => {
    // Copied from the JSDoc example on Injection.scoped (packages/neosyringe/src/types.ts) —
    // the one documented usage of a parent/child useContainer pair. It used to fail with
    // "The symbol NeoServiceNotFoundError has already been declared" at the esbuild step.
    const DOC_EXAMPLE_CODE = `
      import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';

      interface Logger { log(msg: string): string; }
      class ConsoleLogger implements Logger { log(msg: string) { return \`console:\${msg}\`; } }
      class ConsumerA {
        constructor(private readonly logger: Logger) {}
        run() { return this.logger.log('A'); }
      }

      export const parent = defineBuilderConfig({
        injections: [{ token: useInterface<Logger>(), provider: ConsoleLogger }],
      });

      export const child = defineBuilderConfig({
        useContainer: parent,
        injections: [{ token: ConsumerA }],
      });
    `;

    const transform = makeTransform();
    const result = transform(DOC_EXAMPLE_CODE, '/project/src/doc-example.ts') ?? DOC_EXAMPLE_CODE;

    // Bug 1: same-scope class name collision
    const containerClassNames = [...result.matchAll(/class (NeoContainer\w*) \{/g)].map(m => m[1]);
    expect(new Set(containerClassNames).size).toBe(2);

    // Bug 2: ConsumerA's Logger dependency must be wired to the parent, not undefined
    expect(result).not.toContain('new ConsumerA(undefined)');
    expect(result).toMatch(/new ConsumerA\(this\.resolve\("Logger_[a-f0-9]+"\)\)/);
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
