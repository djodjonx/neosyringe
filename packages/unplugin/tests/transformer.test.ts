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

function makeSourceFile(text: string, fileName = '/test/container.ts'): ts.SourceFile {
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.ES2021, true, ts.ScriptKind.TS);
}

function makeProgram(sourceFiles: ts.SourceFile[] = []): ts.Program {
  return {
    getCompilerOptions: () => ({ target: ts.ScriptTarget.ES2021 }),
    getSourceFiles: () => sourceFiles,
    getTypeChecker: () => ({} as ts.TypeChecker),
    getRootFileNames: () => sourceFiles.map(sf => sf.fileName),
    emit: vi.fn(),
  } as unknown as ts.Program;
}

/**
 * Helper to call the program transformer with ts-patch-like extras
 */
async function callTransformer(program: ts.Program, host?: ts.CompilerHost) {
  const { default: neoSyringeTransformer } = await import('../src/transformer');
  return neoSyringeTransformer(
    program,
    host,
    {},
    { ts } as any,
  );
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

  it('returns the same program when no source files contain NeoSyringe APIs', async () => {
    const sf = makeSourceFile('const x = 1;');
    const program = makeProgram([sf]);

    const result = await callTransformer(program);

    // No transformation needed → same program returned
    expect(result).toBe(program);
  });

  it('returns the same program when defineBuilderConfig produces empty graph', async () => {
    vi.mocked(ts.createProgram).mockReturnValue(makeProgram());

    const code = 'export const container = defineBuilderConfig({ name: "C", injections: [] });';
    const sf = makeSourceFile(code);
    const program = makeProgram([sf]);

    const result = await callTransformer(program);

    // Empty graph → no transform → same program
    expect(result).toBe(program);
  });

  it('returns a new program when a container file is transformed', async () => {
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

    const sf = makeSourceFile(code);
    const originalProgram = makeProgram([sf]);

    // The final createProgram call (to create the new program with transformed sources)
    // should return a distinct program object
    const newProgram = makeProgram([]);
    let createProgramCallCount = 0;
    vi.mocked(ts.createProgram).mockImplementation(() => {
      createProgramCallCount++;
      return createProgramCallCount === 1 ? makeProgram() : newProgram;
    });

    const result = await callTransformer(originalProgram);

    expect(result).toBe(newProgram);
  });

  it('throws when graph validation fails', async () => {
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

    const sf = makeSourceFile(code);
    const program = makeProgram([sf]);

    await expect(callTransformer(program)).rejects.toThrow('[neosyringe-transformer]');
    await expect(callTransformer(program)).rejects.toThrow('Missing dep');
  });
});
