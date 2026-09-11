import { describe, it, expect, vi } from 'vitest';
import { neoSyringePlugin } from '../src/index';

vi.mock('typescript', async (importOriginal) => {
  const actual = await importOriginal<typeof import('typescript')>();
  return {
    ...actual,
    findConfigFile: vi.fn().mockReturnValue('/project/tsconfig.json'),
    readConfigFile: vi.fn().mockReturnValue({ config: {} }),
    parseJsonConfigFileContent: vi.fn().mockReturnValue({ options: {}, fileNames: [], errors: [] }),
  };
});

/**
 * Regression test: `return defineBuilderConfig({...})` with no intermediate
 * variable used to be silently left untransformed — no build error, the raw
 * defineBuilderConfig() call shipped as-is. The plugin must now fail the
 * build instead.
 */
describe('Plugin — rejects unsupported defineBuilderConfig() shapes', () => {
  const FILE = '/project/src/bare-return-container.ts';

  const BARE_RETURN_CODE = `
    import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';

    interface ILogger { log(msg: string): void; }
    class ConsoleLogger implements ILogger { log(msg: string) {} }

    export function buildContainer() {
      return defineBuilderConfig({
        injections: [
          { token: useInterface<ILogger>(), provider: ConsoleLogger },
        ],
      });
    }
  `;

  it('throws instead of silently leaving defineBuilderConfig() untransformed', () => {
    const plugin = neoSyringePlugin.vite();
    // @ts-expect-error - testing specific method
    const transform = plugin.transform as (code: string, id: string) => string | undefined;

    expect(() => transform(BARE_RETURN_CODE, FILE)).toThrow(/must be assigned to a variable/);
  });
});
