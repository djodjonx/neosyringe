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

interface Options {
  observation?: boolean;
  testOverrides?: boolean;
  debug?: boolean;
}

function pluginCode(options?: Options): string {
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

function transformerCode(options?: Options): string {
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

/** What the emitted container has of the observation: the two members, and the helper the members use. */
function hasObservation(code: string): boolean {
  return /stateSnapshot\(/.test(code) && /\bobserve\(/.test(code);
}

describe('observation option', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('O12 the plugin and the transformer emit the observation only when the option is true', () => {
    process.env.NODE_ENV = 'test';
    expect(hasObservation(pluginCode({ observation: true })), 'plugin, observation: true').toBe(true);
    expect(hasObservation(transformerCode({ observation: true })), 'transformer, observation: true').toBe(true);
    for (const options of [undefined, {}, { observation: false }]) {
      expect(hasObservation(pluginCode(options)), `plugin, ${JSON.stringify(options)}`).toBe(false);
      expect(hasObservation(transformerCode(options)), `transformer, ${JSON.stringify(options)}`).toBe(false);
    }
  });

  it('O12 the option is its own: it does not turn on test overrides or the debug data, and they do not turn it on', () => {
    process.env.NODE_ENV = 'test';
    const observed = pluginCode({ observation: true });
    expect(hasObservation(observed)).toBe(true);
    expect(observed).toContain('test overrides are disabled');
    expect(observed).toContain('Debug data stripped at build time');
    const others = pluginCode({ testOverrides: true, debug: true });
    expect(hasObservation(others)).toBe(false);
  });

  it('O12 production does not refuse it: observation is meant for production builds', () => {
    process.env.NODE_ENV = 'production';
    expect(hasObservation(pluginCode({ observation: true }))).toBe(true);
    expect(hasObservation(transformerCode({ observation: true }))).toBe(true);
    expect(hasObservation(pluginCode())).toBe(false);
  });
});
