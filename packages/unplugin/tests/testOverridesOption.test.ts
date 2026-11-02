import { afterEach, describe, expect, it, vi } from 'vitest';
import * as ts from 'typescript';

vi.mock('typescript', async (importOriginal) => {
  const actual = await importOriginal<typeof import('typescript')>();
  return {
    ...actual,
    findConfigFile: vi.fn().mockReturnValue('/project/tsconfig.json'),
    readConfigFile: vi.fn().mockReturnValue({ config: {} }),
    parseJsonConfigFileContent: vi.fn().mockReturnValue({ options: {}, fileNames: [], errors: [] }),
  };
});

vi.mock('@djodjonx/neosyringe-core/generator', () => import('../../core/src/generator/index'));
vi.mock('@djodjonx/neosyringe-core/analyzer', () => import('../../core/src/analyzer/index'));
vi.mock('@djodjonx/neosyringe-core/context', () => import('../../core/src/TSContext'));

import { neoSyringePlugin } from '../src/index';
import neoSyringeTransformer from '../src/transformer';

const CONTAINER_FILE = '/project/src/container.ts';
const CONTAINER_CODE = `
  import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';
  interface ILogger { log(msg: string): void; }
  class ConsoleLogger implements ILogger { log(msg: string) {} }
  export const container = defineBuilderConfig({
    injections: [{ token: useInterface<ILogger>(), provider: ConsoleLogger }],
  });
`;

function pluginCode(options?: { testOverrides?: boolean }): string {
  const plugin = neoSyringePlugin.vite(options);
  // @ts-expect-error - testing the vite transform hook
  const transform = plugin.transform as (code: string, id: string) => unknown;
  const result = transform(CONTAINER_CODE, CONTAINER_FILE);
  if (typeof result === 'string') return result;
  if (result && typeof result === 'object' && 'code' in result && typeof (result as { code: unknown }).code === 'string') {
    return (result as { code: string }).code;
  }
  return CONTAINER_CODE;
}

function transformerCode(options?: { testOverrides?: boolean }): string {
  const source = ts.createSourceFile(CONTAINER_FILE, CONTAINER_CODE, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const options_ = { noLib: true, types: [] as string[], target: ts.ScriptTarget.ES2022 };
  const host = ts.createCompilerHost(options_);
  const readSource = host.getSourceFile.bind(host);
  host.fileExists = (fileName) => fileName === CONTAINER_FILE || ts.sys.fileExists(fileName);
  host.readFile = (fileName) => fileName === CONTAINER_FILE ? CONTAINER_CODE : ts.sys.readFile(fileName);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
    if (fileName === CONTAINER_FILE) return source;
    return readSource(fileName, languageVersion, onError, shouldCreateNewSourceFile);
  };
  const program = ts.createProgram([CONTAINER_FILE], options_, host);
  const result = neoSyringeTransformer(
    program,
    host,
    { transform: '@djodjonx/neosyringe-plugin/transformer', ...options },
    { ts },
  );
  return result.getSourceFile(CONTAINER_FILE)?.text ?? '';
}

interface OverrideContainer {
  override: (token: unknown, factory: () => unknown) => Promise<void>;
  resolve: (token: unknown) => unknown;
  destroy: () => Promise<void>;
}

function loadContainer(code: string): OverrideContainer {
  const js = ts.transpileModule(code, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const moduleRecord: { exports: { container?: OverrideContainer } } = { exports: {} };
  const run = new Function('module', 'exports', 'require', js) as (
    module: typeof moduleRecord,
    exports: typeof moduleRecord.exports,
    require: (id: string) => unknown,
  ) => void;
  run(moduleRecord, moduleRecord.exports, () => ({}));
  const container = moduleRecord.exports.container;
  if (!container) throw new Error('transformed module did not export container');
  return container;
}

async function overrideResult(code: string): Promise<{ code: string; message: string; value?: unknown }> {
  const container = loadContainer(code);
  try {
    await container.override('Logger', () => 'mock-value');
    return { code: '', message: '', value: container.resolve('Logger') };
  } catch (error) {
    const codeName = typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : '';
    const message = error instanceof Error ? error.message : String(error);
    return { code: codeName, message };
  } finally {
    try {
      await container.destroy();
    } catch {
      // The disabled gate rejects override. destroy still has to run.
    }
  }
}

describe('testOverrides option', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('T10-P14 plugin and transformer forward testOverrides', async () => {
    process.env.NODE_ENV = 'test';
    const omitted = await overrideResult(pluginCode());
    const disabled = await overrideResult(pluginCode({ testOverrides: false }));
    const enabled = await overrideResult(pluginCode({ testOverrides: true }));
    const transformerOmitted = await overrideResult(transformerCode());
    const transformerDisabled = await overrideResult(transformerCode({ testOverrides: false }));
    const transformerEnabled = await overrideResult(transformerCode({ testOverrides: true }));

    expect(omitted.code).toBe('NEO_TEST_API_DISABLED');
    expect(omitted.message).toContain('NEO_TEST_API_DISABLED: [NeoContainer] test overrides are disabled');
    expect(disabled.code).toBe('NEO_TEST_API_DISABLED');
    expect(disabled.message).toContain('NEO_TEST_API_DISABLED: [NeoContainer] test overrides are disabled');
    expect(enabled.value).toBe('mock-value');
    expect(transformerOmitted.code).toBe('NEO_TEST_API_DISABLED');
    expect(transformerDisabled.code).toBe('NEO_TEST_API_DISABLED');
    expect(transformerEnabled.value).toBe('mock-value');
  });

  it('T10-P7 plugin and transformer reject testOverrides in production', () => {
    process.env.NODE_ENV = 'production';
    expect(() => neoSyringePlugin.vite({ testOverrides: true })).toThrow(/NEO_TEST_API_DISABLED/);
    const program = ts.createProgram([], { noLib: true, noResolve: true, types: [] });
    expect(() => neoSyringeTransformer(program, undefined, { testOverrides: true }, { ts })).toThrow(/NEO_TEST_API_DISABLED/);
  });
});
