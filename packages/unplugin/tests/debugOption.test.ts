import { describe, it, expect, vi, afterEach } from 'vitest';
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
 * Real (unmocked) end-to-end tests proving the `debug` option actually
 * reaches Generator and controls whether _graph/_dependencyGraph embed real
 * data — not just that resolveDebugFlag itself is correct in isolation
 * (see core's DebugConfig.test.ts for that).
 */
describe('Plugin — debug option', () => {
  const FILE = '/project/src/container.ts';
  const CODE = `
    import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';
    interface ILogger { log(msg: string): void; }
    class ConsoleLogger implements ILogger { log(msg: string) {} }
    export const container = defineBuilderConfig({
      injections: [{ token: useInterface<ILogger>(), provider: ConsoleLogger }],
    });
  `;

  const originalNodeEnv = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    vi.clearAllMocks();
  });

  function transformWith(options?: { debug?: boolean }) {
    const plugin = neoSyringePlugin.vite(options);
    // @ts-expect-error - testing specific method
    const transform = plugin.transform as (code: string, id: string) => string | undefined;
    return transform(CODE, FILE) ?? CODE;
  }

  it('strips the data by default outside production (opt-in, not opt-out)', () => {
    process.env.NODE_ENV = 'test';
    const result = transformWith();
    expect(result).toContain('public get _graph() { return []; }');
    expect(result).not.toContain('"dependencies"');
  });

  it('{ debug: false } strips the data outside production (same as the default)', () => {
    process.env.NODE_ENV = 'test';
    const result = transformWith({ debug: false });
    expect(result).toContain('public get _graph() { return []; }');
    expect(result).not.toContain('"dependencies"');
  });

  it('{ debug: true } embeds real debug data outside production', () => {
    process.env.NODE_ENV = 'test';
    const result = transformWith({ debug: true });
    expect(result).toContain('"dependencies"');
  });

  it('NODE_ENV=production forces stripping even with { debug: true }', () => {
    process.env.NODE_ENV = 'production';
    const result = transformWith({ debug: true });
    expect(result).toContain('public get _graph() { return []; }');
    expect(result).not.toContain('"dependencies"');
  });
});
