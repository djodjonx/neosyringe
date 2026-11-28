import { describe, it, expect } from 'vitest';
import * as ts from 'typescript';
import { Analyzer } from '../../src/analyzer/Analyzer';
import {
  chainLineOf,
  fixHintOf,
  fixLineOf,
  formatDiagnostic,
  toActionableDiagnostic,
  type ActionableDiagnostic,
} from '../../src/analyzer/errors';
import type { AnalysisError, DiagnosticCode } from '../../src/analyzer/types';

const ROOT = '/virtual/g07';
const FILE = `${ROOT}/app.ts`;
const SOURCE = `
  import { defineBuilderConfig } from '@djodjonx/neosyringe';
  function defineBuilderConfig(config: any) { return config; }
  interface Absent { n: number }
  class Needy { constructor(dep: Absent) {} }
  class Dup {}
  export const first = defineBuilderConfig({
    name: 'First',
    injections: [{ token: Needy }, { token: Dup }, { token: Dup }],
  });
  class CycA { constructor(b: CycB) {} }
  class CycB { constructor(a: CycA) {} }
  export const second = defineBuilderConfig({ name: 'Second', injections: [{ token: CycA }, { token: CycB }] });
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

/** 1-based line and column of the first `needle` in `text`. */
function positionOf(text: string, needle: string): { line: number; column: number } {
  const offset = text.indexOf(needle);
  expect(offset, `missing ${needle}`).toBeGreaterThanOrEqual(0);
  const before = text.slice(0, offset).split('\n');
  return { line: before.length, column: (before[before.length - 1] ?? '').length + 1 };
}

const errors = new Analyzer(programFor(FILE, SOURCE)).extractAllErrors();

function errorWith(predicate: (error: AnalysisError) => boolean): AnalysisError {
  const found = errors.find(predicate);
  if (!found) throw new Error(`expected analysis error was not produced: ${JSON.stringify(errors.map((error) => error.type))}`);
  return found;
}

// A record, so that a new DiagnosticCode is a compile error here until the test lists it.
const EVERY_CODE: Record<DiagnosticCode, true> = {
  NEO_CONFIG_UNSUPPORTED: true,
  NEO_FACTORY_DEPENDENCIES_REQUIRED: true,
  NEO_DUPLICATE_PROVIDER: true,
  NEO_MISSING_PROVIDER: true,
  NEO_UNKNOWN_CONTAINER: true,
  NEO_MULTI_REQUIRES_RESOLVE_ALL: true,
  NEO_CYCLE: true,
  NEO_UNDECLARED_FACTORY_DEP: true,
  NEO_FACTORY_CONTEXT_EXPIRED: true,
  NEO_ASYNC_TRANSIENT: true,
  NEO_TOKEN_BOUNDARY_UNSUPPORTED: true,
  NEO_ROOT_NOT_EXPORTED: true,
  NEO_CLOSED_REQUIRES_STRICT: true,
  NEO_DISPOSABLE_TRANSIENT_CAPTURED: true,
};

describe('G07 formatDiagnostic', () => {
  const base: ActionableDiagnostic = {
    code: 'NEO_MISSING_PROVIDER',
    severity: 'error',
    file: 'src/app.ts',
    line: 12,
    column: 9,
    message: 'Missing injection',
    chain: [],
  };

  it('G07 prints the position, the severity and the code, then the message', () => {
    expect(formatDiagnostic(base)).toBe('src/app.ts:12:9 error NEO_MISSING_PROVIDER\nMissing injection');
  });

  it('G07 adds the dependency chain and the fix, in that order, when there are any', () => {
    expect(formatDiagnostic({ ...base, chain: ['A', 'B', 'C'], hint: 'Do this.' })).toBe(
      'src/app.ts:12:9 error NEO_MISSING_PROVIDER\nMissing injection\nDependency chain: A -> B -> C\nFix: Do this.',
    );
    expect(formatDiagnostic({ ...base, chain: ['A', 'B'] })).toBe(
      'src/app.ts:12:9 error NEO_MISSING_PROVIDER\nMissing injection\nDependency chain: A -> B',
    );
    expect(formatDiagnostic({ ...base, hint: 'Do this.' })).toBe(
      'src/app.ts:12:9 error NEO_MISSING_PROVIDER\nMissing injection\nFix: Do this.',
    );
  });

  it('G07 an empty chain and an empty hint have no line', () => {
    expect(chainLineOf({ chain: [] })).toBeUndefined();
    expect(chainLineOf({ chain: ['A'] })).toBe('Dependency chain: A');
    expect(fixLineOf({})).toBeUndefined();
    expect(fixLineOf({ hint: '' })).toBeUndefined();
    expect(fixLineOf({ hint: 'Do this.' })).toBe('Fix: Do this.');
  });

  it('G07 a warning prints as a warning', () => {
    expect(formatDiagnostic({ ...base, severity: 'warning' }).split('\n')[0]).toBe('src/app.ts:12:9 warning NEO_MISSING_PROVIDER');
  });
});

describe('G07 toActionableDiagnostic', () => {
  it('G07 keeps the stable code, the position of the registration and the chain of a missing provider', () => {
    const missing = errorWith((error) => error.code === 'NEO_MISSING_PROVIDER');
    const converted = toActionableDiagnostic(missing);

    expect(converted).toMatchObject({
      code: 'NEO_MISSING_PROVIDER',
      severity: 'error',
      file: FILE,
      ...positionOf(SOURCE, 'token: Needy'),
      message: missing.message,
      chain: ['Needy', 'Absent'],
    });
    expect(converted.hint).toContain("'Absent'");
    expect(converted.hint).toContain("'Needy'");
  });

  it('G07 keeps the whole cycle as the chain and gives a cycle fix', () => {
    const cycle = errorWith((error) => error.code === 'NEO_CYCLE');
    const converted = toActionableDiagnostic(cycle);

    expect(converted.code).toBe('NEO_CYCLE');
    expect(converted.chain.length).toBeGreaterThan(2);
    expect(converted.chain[0]).toBe(converted.chain[converted.chain.length - 1]);
    expect(converted.hint).toMatch(/cycle/i);
  });

  it('G07 a duplicate that carries no code is NEO_DUPLICATE_PROVIDER, with no chain', () => {
    const duplicate = errorWith((error) => error.type === 'duplicate');
    const converted = toActionableDiagnostic(duplicate);

    // The analyzer sets the code on this one: the fallback of stableCodeOf is for the errors that do not.
    expect(toActionableDiagnostic({ ...duplicate, code: undefined }).code).toBe('NEO_DUPLICATE_PROVIDER');
    expect(converted.code).toBe('NEO_DUPLICATE_PROVIDER');
    expect(converted.chain).toEqual([]);
    expect(converted.hint).toBe("Keep one declaration of 'Dup': remove the duplicate.");
  });

  it('G07 an error with no stable code keeps its type as the code and has no fix', () => {
    const missing = errorWith((error) => error.code === 'NEO_MISSING_PROVIDER');
    const converted = toActionableDiagnostic({ ...missing, code: undefined });

    expect(converted.code).toBe('missing');
    expect(converted.hint).toBeUndefined();
    expect(formatDiagnostic(converted)).not.toContain('Fix:');
  });

  it('G07 severity is the error severity, an absent one is an error', () => {
    const missing = errorWith((error) => error.code === 'NEO_MISSING_PROVIDER');

    expect(toActionableDiagnostic({ ...missing, severity: 'warning' }).severity).toBe('warning');
    expect(toActionableDiagnostic({ ...missing, severity: undefined }).severity).toBe('error');
  });

  it('G07 root makes the file relative to it; without root the file is as the analyzer saw it', () => {
    const missing = errorWith((error) => error.code === 'NEO_MISSING_PROVIDER');

    expect(toActionableDiagnostic(missing, { root: ROOT }).file).toBe('app.ts');
    expect(toActionableDiagnostic(missing).file).toBe(FILE);
  });
});

function isCode(value: string): value is DiagnosticCode {
  return Object.hasOwn(EVERY_CODE, value);
}

describe('G07 fixHintOf', () => {
  it.each(Object.keys(EVERY_CODE).filter(isCode))('G07 %s has a fix, with or without a token', (code) => {
    expect(fixHintOf({ code })).toBeTruthy();
    expect(fixHintOf({ code, token: 'Thing', chain: ['Consumer', 'Thing'] })).toBeTruthy();
  });

  it('G07 the hints that target a token name it, and a missing provider names its consumer', () => {
    const named = { token: 'Thing', chain: ['Consumer', 'Thing'] };

    expect(fixHintOf({ code: 'NEO_MISSING_PROVIDER', ...named })).toContain("'Thing' in the same container as 'Consumer'");
    expect(fixHintOf({ code: 'NEO_MISSING_PROVIDER', token: 'Thing' })).toContain("'Thing' in this container");
    expect(fixHintOf({ code: 'NEO_MISSING_PROVIDER' })).toContain('the missing token');
    expect(fixHintOf({ code: 'NEO_DUPLICATE_PROVIDER', ...named })).toContain("'Thing'");
    expect(fixHintOf({ code: 'NEO_MULTI_REQUIRES_RESOLVE_ALL', ...named })).toContain("resolveAll('Thing')");
    expect(fixHintOf({ code: 'NEO_ROOT_NOT_EXPORTED', ...named })).toContain("'Thing'");
  });

  it('G07 an error without a code has no fix', () => {
    expect(fixHintOf({})).toBeUndefined();
  });
});
