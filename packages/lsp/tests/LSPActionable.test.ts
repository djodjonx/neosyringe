import { describe, it, expect } from 'vitest';
import * as ts from 'typescript';
import * as path from 'path';
import { Analyzer, type AnalysisError } from '@djodjonx/neosyringe-core/analyzer';
import { toTsDiagnostic } from '../src/diagnostic';

const FILE = path.resolve('/tmp/g07-lsp-actionable.ts');
const SOURCE = `
  import { defineBuilderConfig } from '@djodjonx/neosyringe';
  function defineBuilderConfig(config: any) { return config; }
  interface Absent { n: number }
  class Needy { constructor(dep: Absent) {} }
  class Dup {}
  class CycA { constructor(b: CycB) {} }
  class CycB { constructor(a: CycA) {} }
  export const needy = defineBuilderConfig({
    name: 'Needy',
    injections: [{ token: Needy }, { token: Dup }, { token: Dup }, { token: CycA }, { token: CycB }],
  });
`;

function programFor(fileName: string, text: string): ts.Program {
  return ts.createProgram({
    rootNames: [fileName],
    options: {},
    host: {
      ...ts.createCompilerHost({}),
      getSourceFile: (name) => name === fileName ? ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true) : undefined,
      writeFile: () => {},
      getDefaultLibFileName: () => 'lib.d.ts',
      getCurrentDirectory: () => '/',
      getCanonicalFileName: (f) => f,
      useCaseSensitiveFileNames: () => true,
      getNewLine: () => '\n',
      fileExists: (f) => f === fileName,
      readFile: (f) => f === fileName ? text : undefined,
    },
  });
}

function messageOf(diagnostic: ts.Diagnostic | ts.DiagnosticRelatedInformation): string {
  return typeof diagnostic.messageText === 'string' ? diagnostic.messageText : diagnostic.messageText.messageText;
}

describe('G07 LSP related information', () => {
  const program = programFor(FILE, SOURCE);
  const sourceFile = program.getSourceFile(FILE);
  const errors = new Analyzer(program).extractAllErrors();

  function convert(predicate: (error: AnalysisError) => boolean, patch: Partial<AnalysisError> = {}): ts.Diagnostic {
    const found = errors.find(predicate);
    if (!sourceFile || !found) throw new Error('expected analysis error was not produced');
    return toTsDiagnostic(ts, { ...found, ...patch }, sourceFile);
  }

  it('G07-P3 a missing provider carries its dependency chain and its fix, on the span of the diagnostic', () => {
    const diagnostic = convert((error) => error.code === 'NEO_MISSING_PROVIDER');
    const related = diagnostic.relatedInformation ?? [];

    expect(related.map(messageOf)).toEqual([
      'Dependency chain: Needy -> Absent',
      expect.stringMatching(/^Fix: Register 'Absent' in the same container as 'Needy'/),
    ]);
    for (const item of related) {
      expect(item).toMatchObject({
        category: ts.DiagnosticCategory.Message,
        code: diagnostic.code,
        file: diagnostic.file,
        start: diagnostic.start,
        length: diagnostic.length,
      });
    }
  });

  it('G07-P3 a cycle carries the whole cycle', () => {
    const diagnostic = convert((error) => error.code === 'NEO_CYCLE');

    expect((diagnostic.relatedInformation ?? []).map(messageOf)[0]).toMatch(/^Dependency chain: Cyc[AB] -> Cyc[AB] -> Cyc[AB]$/);
  });

  it('G07-P3 an error with a code and no chain carries the fix only', () => {
    const diagnostic = convert((error) => error.type === 'duplicate');

    expect((diagnostic.relatedInformation ?? []).map(messageOf)).toEqual([
      "Fix: Keep one declaration of 'Dup': remove the duplicate.",
    ]);
  });

  it('G07-P3 an error with neither a stable code nor a chain has no related information', () => {
    const diagnostic = convert((error) => error.code === 'NEO_MISSING_PROVIDER', { code: undefined, context: undefined });

    expect(diagnostic.relatedInformation).toBeUndefined();
    expect('relatedInformation' in diagnostic).toBe(false);
  });

  it('G07-P3 the message of the diagnostic is still the plain string with the NEO code', () => {
    const diagnostic = convert((error) => error.code === 'NEO_MISSING_PROVIDER');

    expect(typeof diagnostic.messageText).toBe('string');
    expect(messageOf(diagnostic).startsWith('[NeoSyringe] NEO_MISSING_PROVIDER: ')).toBe(true);
    expect(messageOf(diagnostic)).not.toContain('Dependency chain');
  });
});
