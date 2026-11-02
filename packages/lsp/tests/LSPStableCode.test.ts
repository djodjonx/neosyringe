import { describe, it, expect } from 'vitest';
import * as ts from 'typescript';
import * as path from 'path';
import { Analyzer, type AnalysisError } from '@djodjonx/neosyringe-core/analyzer';
import { toTsDiagnostic } from '../src/diagnostic';
import init from '../src/index';

const FILE = path.resolve('/tmp/t19-stable-code.ts');
const SOURCE = `
  import { defineBuilderConfig } from '@djodjonx/neosyringe';
  function defineBuilderConfig(config: any) { return config; }
  interface Port { n: number }
  class Opaque {}
  class Dup {}
  class Missing { constructor(port: Port) {} }
  export const opaque = defineBuilderConfig({
    name: 'Opaque',
    injections: [
      { token: Opaque, useFactory: true, provider: () => new Opaque() },
      { token: Dup },
      { token: Dup },
      { token: Missing },
    ],
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

function messageOf(diagnostic: ts.Diagnostic): string {
  return typeof diagnostic.messageText === 'string' ? diagnostic.messageText : diagnostic.messageText.messageText;
}

describe('T19 LSP stable code and severity', () => {
  const program = programFor(FILE, SOURCE);
  const sourceFile = program.getSourceFile(FILE);
  const compatible = new Analyzer(program, { validation: 'compatible' }).extractAllErrors();
  const strict = new Analyzer(program).extractAllErrors();

  function errorWith(errors: AnalysisError[], predicate: (error: AnalysisError) => boolean): AnalysisError {
    const found = errors.find(predicate);
    if (!found) throw new Error('expected analysis error was not produced');
    return found;
  }

  it('T19 warning stays a warning', () => {
    if (!sourceFile) throw new Error('missing source file');
    const warning = errorWith(compatible, (error) => error.code === 'NEO_FACTORY_DEPENDENCIES_REQUIRED');
    const converted = toTsDiagnostic(ts, warning, sourceFile);

    expect(warning.severity).toBe('warning');
    expect(converted.category).toBe(ts.DiagnosticCategory.Warning);
    expect(converted.code).toBe(9994);
    expect(messageOf(converted).startsWith('[NeoSyringe] NEO_FACTORY_DEPENDENCIES_REQUIRED: ')).toBe(true);
    expect(messageOf(converted).split('NEO_FACTORY_DEPENDENCIES_REQUIRED').length - 1).toBe(1);

    const asError = toTsDiagnostic(ts, { ...warning, severity: 'error' }, sourceFile);
    const absent = toTsDiagnostic(ts, { ...warning, severity: undefined }, sourceFile);
    expect(asError.category).toBe(ts.DiagnosticCategory.Error);
    expect(absent.category).toBe(ts.DiagnosticCategory.Error);
  });

  it('T19 stable code is carried in the message', () => {
    if (!sourceFile) throw new Error('missing source file');
    const missing = errorWith(strict, (error) => error.code === 'NEO_MISSING_PROVIDER' && error.type === 'missing');
    const duplicate = errorWith(strict, (error) => error.type === 'duplicate');
    const reworded = toTsDiagnostic(ts, { ...missing, message: 'Another sentence' }, sourceFile);

    expect(messageOf(toTsDiagnostic(ts, missing, sourceFile)).startsWith('[NeoSyringe] NEO_MISSING_PROVIDER: ')).toBe(true);
    expect(toTsDiagnostic(ts, missing, sourceFile).code).toBe(9995);
    expect(messageOf(toTsDiagnostic(ts, duplicate, sourceFile)).startsWith('[NeoSyringe] NEO_DUPLICATE_PROVIDER: ')).toBe(true);
    expect(toTsDiagnostic(ts, duplicate, sourceFile).code).toBe(9998);
    expect(messageOf(reworded)).toBe('[NeoSyringe] NEO_MISSING_PROVIDER: Another sentence');
    expect(toTsDiagnostic(ts, { ...missing, code: undefined }, sourceFile).messageText).toBe(`[NeoSyringe] ${missing.message}`);
  });

  it('T19 lsp publishes the NEO code', () => {
    const proxy = init({ typescript: ts }).create({
      languageService: { getSemanticDiagnostics: () => [], getProgram: () => program },
      project: { projectService: { logger: { info: () => {}, loggingEnabled: () => false, startGroup: () => {}, endGroup: () => {} } } },
    } as never);
    const published = proxy.getSemanticDiagnostics(FILE);
    const missing = published.find((item) => messageOf(item).includes('NEO_MISSING_PROVIDER'));

    expect(missing?.code).toBe(9995);
    expect(missing?.category).toBe(ts.DiagnosticCategory.Error);
    expect(published.some((item) => messageOf(item).startsWith('[NeoSyringe] NEO_DUPLICATE_PROVIDER: '))).toBe(true);
  });
});
