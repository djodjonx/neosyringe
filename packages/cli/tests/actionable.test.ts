import { describe, it, expect } from 'vitest';
import * as ts from 'typescript';
import path from 'node:path';
import {
  Analyzer,
  formatDiagnostic,
  toActionableDiagnostic,
  type AnalysisError,
} from '@djodjonx/neosyringe-core/analyzer';
import init from '../../lsp/src/index';
import { renderTextReport } from '../src/diagnostics';
import { buildJsonReport, findDoctorUsageError, isDoctorCommand } from '../src/report';

const ROOT = path.resolve('/virtual/g07-cli');
const FILE = path.join(ROOT, 'src/app.ts');
const SOURCE = `
  import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';
  function defineBuilderConfig(config: any) { return config; }
  function useInterface<T>(): any { return null; }
  interface ILog { n: number }
  interface Absent { n: number }
  class Needy { constructor(dep: Absent) {} }
  class CycA { constructor(b: CycB) {} }
  class CycB { constructor(a: CycA) {} }
  export const needy = defineBuilderConfig({
    name: 'Needy',
    injections: [
      { token: Needy },
    ],
  });
  export const cyc = defineBuilderConfig({ name: 'Cyc', injections: [{ token: CycA }, { token: CycB }] });
  export const owned = defineBuilderConfig({
    name: 'Owned',
    injections: [{ token: useInterface<ILog>(), useValue: { n: 1 }, ownership: 'owned' }],
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

describe('G07 the same error in CLI text, CLI JSON and the language service', () => {
  const program = programFor(FILE, SOURCE);
  const sourceFile = program.getSourceFile(FILE);
  const errors = new Analyzer(program).extractAllErrors();

  function errorWith(code: string): AnalysisError {
    const found = errors.find((error) => error.code === code);
    if (!found) throw new Error(`no ${code} in ${JSON.stringify(errors.map((error) => error.code))}`);
    return found;
  }

  function languageServiceDiagnostics(): ts.Diagnostic[] {
    const service = init({ typescript: ts }).create({
      languageService: { getSemanticDiagnostics: () => [], getProgram: () => program },
      project: { projectService: { logger: { info: () => {}, loggingEnabled: () => false, startGroup: () => {}, endGroup: () => {} } } },
    } as never);
    return service.getSemanticDiagnostics(FILE);
  }

  it('G07-P3 text, JSON and LSP carry the same code, the same position and the same chain and fix', () => {
    const missing = errorWith('NEO_MISSING_PROVIDER');
    const actionable = toActionableDiagnostic(missing, { root: ROOT });
    const text = renderTextReport([missing], ROOT);
    const json = buildJsonReport([missing], ROOT).errors[0];
    const lsp = languageServiceDiagnostics().find((item) => messageOf(item).includes('NEO_MISSING_PROVIDER'));
    if (!sourceFile || !lsp || lsp.start === undefined || !json) throw new Error('an expected diagnostic is missing');
    const where = sourceFile.getLineAndCharacterOfPosition(lsp.start);
    const related = (lsp.relatedInformation ?? []).map(messageOf);

    expect(text).toBe(formatDiagnostic(actionable));
    expect(text.split('\n')[0]).toBe(`src/app.ts:${json.line}:${json.column} error NEO_MISSING_PROVIDER`);
    expect(json).toMatchObject({ code: 'NEO_MISSING_PROVIDER', file: 'src/app.ts', chain: ['Needy', 'Absent'] });
    expect({ line: where.line + 1, column: where.character + 1 }).toEqual({ line: json.line, column: json.column });
    expect(messageOf(lsp)).toContain('NEO_MISSING_PROVIDER');
    expect(json.hint).toBe(actionable.hint);
    expect(related).toEqual(['Dependency chain: Needy -> Absent', `Fix: ${json.hint}`]);
    expect(text).toContain(related.join('\n'));
  });

  it('G07-P3 the same holds for a cycle', () => {
    const cycle = errorWith('NEO_CYCLE');
    const json = buildJsonReport([cycle], ROOT).errors[0];
    const lsp = languageServiceDiagnostics().find((item) => messageOf(item).includes('NEO_CYCLE'));
    if (!sourceFile || !lsp || lsp.start === undefined || !json) throw new Error('an expected diagnostic is missing');
    const where = sourceFile.getLineAndCharacterOfPosition(lsp.start);

    expect({ line: where.line + 1, column: where.character + 1 }).toEqual({ line: json.line, column: json.column });
    expect(json.chain?.length).toBe(3);
    expect(renderTextReport([cycle], ROOT)).toContain(`Dependency chain: ${json.chain?.join(' -> ')}`);
    expect((lsp.relatedInformation ?? []).map(messageOf)).toContain(`Fix: ${json.hint}`);
  });

  it('G07-I1 an error that carries a sub-reason gives the same cause-specific fix in text, JSON and LSP', () => {
    const owned = errorWith('NEO_CONFIG_UNSUPPORTED');
    const json = buildJsonReport([owned], ROOT).errors[0];
    const lsp = languageServiceDiagnostics().find((item) => messageOf(item).includes('useValue cannot be declared owned'));
    const hint = "Register a factory with ownership: 'owned' instead of useValue, or remove ownership from the useValue registration.";
    if (!lsp || !json) throw new Error('an expected diagnostic is missing');

    expect(json.hint).toBe(hint);
    expect(renderTextReport([owned], ROOT)).toContain(`Fix: ${hint}`);
    expect((lsp.relatedInformation ?? []).map(messageOf)).toContain(`Fix: ${hint}`);
  });

  it('G07-P2 an error with no stable code has neither a code nor a hint in JSON, and no Fix line in the text', () => {
    const missing = errorWith('NEO_MISSING_PROVIDER');
    const bare: AnalysisError = { ...missing, code: undefined };
    const json = buildJsonReport([bare], ROOT).errors[0];

    expect(json).toBeDefined();
    expect(json && 'hint' in json).toBe(false);
    expect(json && 'code' in json).toBe(false);
    expect(renderTextReport([bare], ROOT)).not.toContain('Fix:');
    expect(renderTextReport([bare], ROOT).split('\n')[0]).toMatch(/error missing$/);
  });

  it('G07-P2 renderTextReport separates two errors with one blank line and is empty for none', () => {
    const blocks = renderTextReport([errorWith('NEO_MISSING_PROVIDER'), errorWith('NEO_CYCLE')], ROOT).split('\n\n');

    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toContain('error NEO_MISSING_PROVIDER');
    expect(blocks[1]).toContain('error NEO_CYCLE');
    expect(renderTextReport([], ROOT)).toBe('');
  });

  it('G07-P2 the container lookup does not change the text', () => {
    const missing = errorWith('NEO_MISSING_PROVIDER');

    expect(renderTextReport([missing], ROOT, () => ({ containerKey: 'k', containerName: 'Needy', sourceFile: FILE }))).toBe(renderTextReport([missing], ROOT));
  });
});

describe('G07 doctor usage', () => {
  it('G07-P8 only the first argument selects doctor', () => {
    expect(isDoctorCommand(['doctor'])).toBe(true);
    expect(isDoctorCommand(['doctor', '--json'])).toBe(true);
    expect(isDoctorCommand(['--json', 'doctor'])).toBe(false);
    expect(isDoctorCommand([])).toBe(false);
  });

  it('G07-P8 doctor takes --json, --help and --project <path> (or -p); any other argument is a usage error', () => {
    expect(findDoctorUsageError([])).toBeUndefined();
    expect(findDoctorUsageError(['--json', '--help'])).toBeUndefined();
    expect(findDoctorUsageError(['--project', 'a.json', '--json'])).toBeUndefined();
    expect(findDoctorUsageError(['-p', 'a.json'])).toBeUndefined();
    expect(findDoctorUsageError(['--graph'])).toContain('--graph');
    expect(findDoctorUsageError(['--json', 'extra'])).toContain('extra');
    expect(findDoctorUsageError(['--project'])).toContain('--project needs a tsconfig path');
    expect(findDoctorUsageError(['-p', '--json'])).toContain('-p needs a tsconfig path');
  });
});
