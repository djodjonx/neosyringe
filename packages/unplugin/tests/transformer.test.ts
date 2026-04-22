import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as ts from 'typescript';
import { Analyzer } from '@djodjonx/neosyringe-core/analyzer';
import { Generator, GraphValidator } from '@djodjonx/neosyringe-core/generator';

vi.mock('@djodjonx/neosyringe-core/analyzer', () => ({
  Analyzer: vi.fn().mockImplementation(() => ({
    extract: vi.fn().mockReturnValue({ nodes: new Map(), errors: [] }),
  })),
  HashUtils: {
    generateTokenId: vi.fn().mockReturnValue('IService_abc123'),
  },
}));

vi.mock('@djodjonx/neosyringe-core/generator', () => ({
  Generator: vi.fn().mockImplementation(() => ({
    generate: vi.fn().mockReturnValue('class __CatsContainer__ {}'),
    generateInstantiation: vi.fn().mockReturnValue('new __CatsContainer__()'),
  })),
  GraphValidator: vi.fn().mockImplementation(() => ({
    validateAll: vi.fn().mockReturnValue({ valid: true, errors: [] }),
  })),
}));

vi.mock('typescript', async (importOriginal) => {
  const actual = await importOriginal<typeof import('typescript')>();
  return {
    ...actual,
    createProgram: vi.fn(),
  };
});

function makeProgram(): ts.Program {
  return {
    getCompilerOptions: () => ({ target: ts.ScriptTarget.ES2021 }),
    getSourceFiles: () => [],
    getTypeChecker: () => ({} as ts.TypeChecker),
  } as unknown as ts.Program;
}

function makeSourceFile(text: string, fileName = '/test/container.ts'): ts.SourceFile {
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.ES2021, true, ts.ScriptKind.TS);
}

describe('neoSyringeTransformer', () => {
  beforeEach(async () => {
    vi.resetAllMocks();

    // Default: Analyzer returns empty graph (no container found)
    vi.mocked(Analyzer).mockImplementation(function () {
      return { extract: vi.fn().mockReturnValue({ nodes: new Map(), errors: [] }) };
    } as any);

    vi.mocked(GraphValidator).mockImplementation(function () {
      return { validateAll: vi.fn().mockReturnValue({ valid: true, errors: [] }) };
    } as any);

    vi.mocked(Generator).mockImplementation(function () {
      return {
        generate: vi.fn().mockReturnValue('class __CatsContainer__ {}'),
        generateInstantiation: vi.fn().mockReturnValue('new __CatsContainer__()'),
      };
    } as any);
  });

  it('returns source file unchanged for files with no NeoSyringe APIs', async () => {
    const { default: neoSyringeTransformer } = await import('../src/transformer');

    const program = makeProgram();
    const factory = neoSyringeTransformer(program);
    const transform = factory({} as ts.TransformationContext);
    const sourceFile = makeSourceFile('const x = 1;');

    const result = transform(sourceFile);

    expect(result).toBe(sourceFile);
  });

  it('returns source file unchanged when defineBuilderConfig produces empty graph', async () => {
    const { default: neoSyringeTransformer } = await import('../src/transformer');

    vi.mocked(ts.createProgram).mockReturnValue(makeProgram());

    const program = makeProgram();
    const factory = neoSyringeTransformer(program);
    const transform = factory({} as ts.TransformationContext);

    const code = 'export const container = defineBuilderConfig({ name: "C", injections: [] });';
    const sourceFile = makeSourceFile(code);
    const result = transform(sourceFile);

    expect(result).toBe(sourceFile);
  });

  it('transforms a container file when graph is non-empty', async () => {
    const { default: neoSyringeTransformer } = await import('../src/transformer');

    const code = 'export const container = defineBuilderConfig({ name: "C", injections: [] });';

    vi.mocked(Analyzer).mockImplementation(function () {
      return {
        extract: vi.fn().mockReturnValue({
          nodes: new Map([['MyService_abc', {}]]),
          errors: [],
          defineBuilderConfigStart: code.indexOf('defineBuilderConfig'),
          defineBuilderConfigEnd: code.length - 1,
          variableStatementStart: 0,
        }),
      };
    } as any);

    vi.mocked(ts.createProgram).mockReturnValue(makeProgram());

    const program = makeProgram();
    const factory = neoSyringeTransformer(program);
    const transform = factory({} as ts.TransformationContext);

    const sourceFile = makeSourceFile(code);
    const result = transform(sourceFile);

    expect(result).not.toBe(sourceFile);
    expect(result.text).toContain('__CatsContainer__');
  });

  it('throws when graph validation fails', async () => {
    const { default: neoSyringeTransformer } = await import('../src/transformer');

    const code = 'export const container = defineBuilderConfig({ name: "C", injections: [] });';

    vi.mocked(Analyzer).mockImplementation(function () {
      return {
        extract: vi.fn().mockReturnValue({
          nodes: new Map([['MyService_abc', {}]]),
          errors: [],
          defineBuilderConfigStart: code.indexOf('defineBuilderConfig'),
          defineBuilderConfigEnd: code.length - 1,
          variableStatementStart: 0,
        }),
      };
    } as any);

    vi.mocked(GraphValidator).mockImplementation(function () {
      return {
        validateAll: vi.fn().mockReturnValue({ valid: false, errors: [{ message: 'Missing dep' }] }),
      };
    } as any);

    vi.mocked(ts.createProgram).mockReturnValue(makeProgram());

    const program = makeProgram();
    const factory = neoSyringeTransformer(program);
    const transform = factory({} as ts.TransformationContext);
    const sourceFile = makeSourceFile(code);

    expect(() => transform(sourceFile)).toThrow('[neosyringe-transformer]');
    expect(() => transform(sourceFile)).toThrow('Missing dep');
  });
});
