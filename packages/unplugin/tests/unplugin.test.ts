import { describe, it, expect, vi, beforeEach } from 'vitest';
import { neoSyringePlugin } from '../src/index';
import * as ts from 'typescript';

// Mock dependencies
vi.mock('typescript', async (importOriginal) => {
  const actual = await importOriginal<typeof import('typescript')>();
  return {
    ...actual,
    findConfigFile: vi.fn(),
    readConfigFile: vi.fn(),
    parseJsonConfigFileContent: vi.fn(),
    createProgram: vi.fn(),
    sys: {
      ...actual.sys,
      readFile: vi.fn(),
      fileExists: vi.fn(),
    },
  };
});

describe('neoSyringePlugin', () => {
  const plugin = neoSyringePlugin.vite(); // Using vite flavor for testing

  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('should ignore files that do not contain defineBuilderConfig', () => {
    // @ts-expect-error - testing specific method
    const transform = plugin.transform as (code: string, id: string) => string | undefined;

    const result = transform('const x = 1;', 'file.ts');
    expect(result).toBeUndefined();
  });

  it('should ignore files if tsconfig is not found', () => {
    vi.mocked(ts.findConfigFile).mockReturnValue(undefined);

    // @ts-expect-error - testing specific method
    const transform = plugin.transform as (code: string, id: string) => string | undefined;

    const result = transform('defineBuilderConfig({})', 'file.ts');
    expect(result).toBeUndefined();
  });

  it('should process files with defineBuilderConfig and valid tsconfig', () => {
    vi.mocked(ts.findConfigFile).mockReturnValue('tsconfig.json');
    vi.mocked(ts.readConfigFile).mockReturnValue({ config: {} });
    vi.mocked(ts.parseJsonConfigFileContent).mockReturnValue({ options: {}, fileNames: [], errors: [] });

    const mockProgram = {
      getSourceFiles: () => [],
      getTypeChecker: () => ({
        getTypeAtLocation: () => ({}),
      }),
    };
    // @ts-expect-error - partial mock
    vi.mocked(ts.createProgram).mockReturnValue(mockProgram);

    // @ts-expect-error - testing specific method
    const transform = plugin.transform as (code: string, id: string) => string | undefined;

    transform('defineBuilderConfig({})', 'file.ts');

    expect(ts.createProgram).toHaveBeenCalled();
  });

  it('should include .ts and .tsx files', () => {
      // @ts-expect-error - testing specific method
      const include = plugin.transformInclude as (id: string) => boolean;

      expect(include('test.ts')).toBe(true);
      expect(include('test.tsx')).toBe(true);
      expect(include('test.js')).toBe(false);
  });
});

