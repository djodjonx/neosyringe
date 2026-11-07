import { describe, expect, it } from 'vitest';
import * as ts from 'typescript';
import { Analyzer } from '../../src/analyzer/Analyzer';

const FORWARD = 'C:/virtual/win-extract/app.ts';
const BACKSLASH = 'C:\\virtual\\win-extract\\app.ts';

const SOURCE = `
  import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';
  function defineBuilderConfig(c: any) { return c; }
  function useInterface<T>(): any { return null; }
  export const container = defineBuilderConfig({
    injections: [
      { token: useInterface<number>(), useValue: 42 }
    ]
  });
`;

function program(): ts.Program {
  const options: ts.CompilerOptions = {
    strict: false,
    noLib: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
  };
  const host = ts.createCompilerHost(options);
  const read = host.getSourceFile.bind(host);
  host.getSourceFile = (name, languageVersion, onError, create) => {
    if (name === FORWARD) return ts.createSourceFile(name, SOURCE, languageVersion, true);
    return read(name, languageVersion, onError, create);
  };
  return ts.createProgram([FORWARD], options, host);
}

describe('extractForFile windows paths', () => {
  it('extractForFile accepts the backslash form of a TypeScript path', () => {
    const analyzer = new Analyzer(program());
    const forward = analyzer.extractForFile(FORWARD).errors.map((error) => error.message);
    const windows = analyzer.extractForFile(BACKSLASH).errors.map((error) => error.message);
    expect(forward.length).toBeGreaterThan(0);
    expect(windows).toEqual(forward);
  });
});
