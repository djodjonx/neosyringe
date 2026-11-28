import { describe, expect, it } from 'vitest';
import { Analyzer } from '../../src/analyzer/Analyzer';
import { stableCodeOf } from '../../src/analyzer/errors/stableDiagnostic';
import type { AnalysisError } from '../../src/analyzer/types';
import { programOf } from '../helpers/t00-contract';

/**
 * F11 (topic 11) `initialization: { concurrency: N }` in the analyzer. A positive integer literal is read into the graph;
 * everything else is reported with `NEO_CONFIG_UNSUPPORTED` at the position of what is wrong: zero, a negative number
 * (a prefix expression), a number with a fraction, a variable, a string, a spread or a computed member, an object that is
 * not a literal. Absent is the default (1). A partial that declares it is refused: the option belongs to the builder.
 */

const PREFIX = 'NEO_CONFIG_UNSUPPORTED: initialization.concurrency must be a positive integer literal';

const HEAD = `
  import { defineBuilderConfig, definePartialConfig, useInterface } from '@djodjonx/neosyringe';
  declare function defineBuilderConfig<T>(config: T): T;
  declare function definePartialConfig<T>(config: T): T;
  declare function useInterface<T>(): T;
  interface Db { n: number }
  const db = useInterface<Db>();
  const n = 3;
  const rest = { concurrency: 3 };
  const opts = { concurrency: 3 };
`;

let fileSeq = 0;

interface Analysis {
  readonly file: string;
  readonly source: string;
  readonly errors: readonly AnalysisError[];
  readonly concurrency: unknown;
}

/** Analyses a builder whose `initialization` member is `member` (a whole `name: value` text, or nothing). */
function analyse(member: string): Analysis {
  fileSeq += 1;
  const file = `/virtual/f11-parser/${fileSeq}.ts`;
  const source = `${HEAD}
  export const box = defineBuilderConfig({
    name: 'F11Parser',
    ${member}
    injections: [{ token: db, useFactory: true, dependencies: [], provider: async () => ({ n: 1 }) }],
  });
`;
  const analyzer = new Analyzer(programOf(file, source));
  const graph = analyzer.extractAll().find((candidate) => candidate.exportedVariableName === 'box');
  if (!graph) throw new Error('missing container box');
  return { file, source, errors: analyzer.extractForFile(file).errors, concurrency: Reflect.get(graph, 'initializationConcurrency') };
}

/** `code line:column` of the errors of the option, in the order the analyzer lists them. */
function refusals(analysis: Analysis): string[] {
  return analysis.errors
    .filter((error) => stableCodeOf(error) === 'NEO_CONFIG_UNSUPPORTED')
    .map((error) => {
      const position = error.sourceFile.getLineAndCharacterOfPosition(error.node.getStart(error.sourceFile));
      return `${stableCodeOf(error)} ${position.line + 1}:${position.character + 1} ${error.node.getText().replace(/\s+/g, ' ')}`;
    });
}

/** `line:column` of `node` inside the `member` text of the container, as the analyzer counts them. */
function at(analysis: Analysis, member: string, node: string): string {
  const memberIndex = analysis.source.indexOf(member, analysis.source.indexOf('export const box'));
  if (memberIndex < 0) throw new Error(`missing member ${member}`);
  const index = memberIndex + member.lastIndexOf(node);
  const before = analysis.source.slice(0, index).split('\n');
  return `${before.length}:${(before[before.length - 1] ?? '').length + 1}`;
}

function messages(analysis: Analysis): string[] {
  return analysis.errors.filter((error) => stableCodeOf(error) === 'NEO_CONFIG_UNSUPPORTED').map((error) => error.message);
}

describe('F11 initialization.concurrency in the analyzer', () => {
  it('P7 3 is accepted: the graph carries it and nothing is reported', () => {
    const analysis = analyse('initialization: { concurrency: 3 },');
    expect(refusals(analysis)).toEqual([]);
    expect(analysis.concurrency).toBe(3);
  });

  it('P7 a literal under a type assertion or parentheses is read as the number it is, like the other literal options', () => {
    expect(analyse('initialization: { concurrency: 4 as number },').concurrency).toBe(4);
    expect(analyse('initialization: { concurrency: (2) },').concurrency).toBe(2);
  });

  it('P7 absent, undefined or empty is the default: nothing is reported and the graph carries no concurrency', () => {
    for (const member of ['', 'initialization: undefined,', 'initialization: {},', 'initialization: { concurrency: undefined },']) {
      const analysis = analyse(member);
      expect(refusals(analysis), member).toEqual([]);
      expect(analysis.concurrency, member).toBeUndefined();
    }
    // The assertion that fails without the option: a literal value reaches the graph.
    expect(analyse('initialization: { concurrency: 1 },').concurrency).toBe(1);
  });

  const REFUSED: ReadonlyArray<{ title: string; member: string; node: string }> = [
    { title: '0', member: 'initialization: { concurrency: 0 },', node: '0' },
    { title: '-1 (a prefix expression)', member: 'initialization: { concurrency: -1 },', node: '-1' },
    { title: '1.5', member: 'initialization: { concurrency: 1.5 },', node: '1.5' },
    { title: 'a variable', member: 'initialization: { concurrency: n },', node: 'n' },
    { title: 'a string', member: "initialization: { concurrency: '3' },", node: "'3'" },
    { title: 'Infinity', member: 'initialization: { concurrency: Infinity },', node: 'Infinity' },
    { title: 'a number too large to be an integer', member: 'initialization: { concurrency: 1e400 },', node: '1e400' },
    { title: 'a spread member', member: 'initialization: { ...rest },', node: '...rest' },
    { title: 'a computed member', member: "initialization: { ['concurrency']: 3 },", node: "['concurrency']: 3" },
    { title: 'an object that is not a literal', member: 'initialization: opts,', node: 'opts' },
  ];

  for (const item of REFUSED) {
    it(`P7 ${item.title} is refused with the code and the position of what is wrong`, () => {
      const analysis = analyse(item.member);
      expect(refusals(analysis)).toEqual([`NEO_CONFIG_UNSUPPORTED ${at(analysis, item.member, item.node)} ${item.node}`]);
      expect(messages(analysis)[0]?.startsWith(PREFIX)).toBe(true);
      expect(analysis.concurrency).toBeUndefined();
    });
  }

  it('P7 a partial that declares initialization is refused at the member, and the builder keeps the default', () => {
    fileSeq += 1;
    const file = `/virtual/f11-parser/${fileSeq}.ts`;
    const source = `${HEAD}
  const shared = definePartialConfig({
    initialization: { concurrency: 3 },
    injections: [],
  });
  export const box = defineBuilderConfig({ name: 'F11Partial', extends: [shared], injections: [{ token: db, useFactory: true, dependencies: [], provider: async () => ({ n: 1 }) }] });
`;
    const analyzer = new Analyzer(programOf(file, source));
    const errors = analyzer.extractForFile(file).errors.filter((error) => stableCodeOf(error) === 'NEO_CONFIG_UNSUPPORTED');
    expect(errors.map((error) => error.node.getText().replace(/\s+/g, ' '))).toEqual(['initialization: { concurrency: 3 }']);
    expect(errors[0]?.message.startsWith('NEO_CONFIG_UNSUPPORTED: initialization')).toBe(true);
    const graph = analyzer.extractAll().find((candidate) => candidate.exportedVariableName === 'box');
    expect(Reflect.get(graph ?? {}, 'initializationConcurrency')).toBeUndefined();
  });
});
