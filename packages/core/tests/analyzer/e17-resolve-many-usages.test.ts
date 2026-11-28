import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as ts from 'typescript';
import { Analyzer } from '../../src/analyzer/Analyzer';
import { textCallsResolve } from '../../src/analyzer/collectors/resolutionUsages';
import type { AnalysisError } from '../../src/analyzer/types';

/**
 * E17 `resolveMany` in the analyzer: a literal list is read as one usage per element, at the position of that element;
 * a list the analyzer cannot read is reported under the `NEO_UNKNOWN_CONTAINER` rule of the validation mode; an object
 * that only has a method of that name is none of its business.
 */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const ROOT = path.join(process.cwd(), 'e17-virtual');

const TOKENS = path.join(ROOT, 'tokens.ts');
const ELEMENTS = path.join(ROOT, 'elements.ts');
const CLOSED = path.join(ROOT, 'closed.ts');
const MULTI = path.join(ROOT, 'multi.ts');
const DYNAMIC = path.join(ROOT, 'dynamic.ts');
const SPREAD = path.join(ROOT, 'spread.ts');
const UNKNOWN_RECEIVER = path.join(ROOT, 'unknown-receiver.ts');
const HOMONYM = path.join(ROOT, 'homonym.ts');
const EMPTY = path.join(ROOT, 'empty.ts');
const CAPTURE = path.join(ROOT, 'capture.ts');
const WRAPPED = path.join(ROOT, 'wrapped.ts');
const HOLE = path.join(ROOT, 'hole.ts');

const IMPORTS = `import { defineBuilderConfig, useInterface, type Container } from '@djodjonx/neosyringe';`;

const files = new Map<string, string>([
  [TOKENS, `
    export interface IFoo { id: number }
    export interface IBar { id: number }
    export interface IExt { id: number }
    export interface IMulti { id: number }
  `],
  [ELEMENTS, `
    ${IMPORTS}
    import { IFoo, IBar, IExt } from './tokens';
    class BarImpl implements IBar { id = 2 }
    export const containerB = defineBuilderConfig({
      injections: [{ token: useInterface<IBar>(), provider: BarImpl }],
    });
    containerB.resolveMany([useInterface<IBar>(), useInterface<IFoo>()]);
    containerB.resolveMany([
      useInterface<IFoo>(),
      useInterface<IBar>(),
      useInterface<IExt>(),
    ]);
    containerB.resolveMany([...[useInterface<IFoo>()], useInterface<IBar>()]);
  `],
  [CLOSED, `
    ${IMPORTS}
    class Priv {}
    class Pub { constructor(readonly priv: Priv) {} }
    export const closedBox = defineBuilderConfig({
      optimization: { mode: 'closed', roots: [Pub] },
      injections: [{ token: Priv }, { token: Pub }],
    });
    closedBox.resolveMany([Pub, Priv]);
  `],
  [MULTI, `
    ${IMPORTS}
    import { IMulti } from './tokens';
    class MultiA implements IMulti { id = 1 }
    class MultiB implements IMulti { id = 2 }
    export const multiBox = defineBuilderConfig({
      injections: [
        { token: useInterface<IMulti>(), provider: MultiA, multi: true },
        { token: useInterface<IMulti>(), provider: MultiB, multi: true },
      ],
    });
    multiBox.resolveMany([useInterface<IMulti>()]);
  `],
  [DYNAMIC, `
    ${IMPORTS}
    import { IFoo, IBar } from './tokens';
    class BarImpl implements IBar { id = 2 }
    export const containerB = defineBuilderConfig({
      injections: [{ token: useInterface<IBar>(), provider: BarImpl }],
    });
    const list = [useInterface<IFoo>()];
    containerB.resolveMany(list);
    function tokens() { return [useInterface<IFoo>()]; }
    containerB.resolveMany(tokens());
  `],
  [SPREAD, `
    ${IMPORTS}
    import { IFoo, IBar } from './tokens';
    class BarImpl implements IBar { id = 2 }
    export const containerB = defineBuilderConfig({
      injections: [{ token: useInterface<IBar>(), provider: BarImpl }],
    });
    const rest = [useInterface<IBar>()];
    containerB.resolveMany([useInterface<IFoo>(), ...rest]);
  `],
  [UNKNOWN_RECEIVER, `
    ${IMPORTS}
    import { IFoo, IBar } from './tokens';
    class BarImpl implements IBar { id = 2 }
    export const containerB = defineBuilderConfig({
      injections: [{ token: useInterface<IBar>(), provider: BarImpl }],
    });
    function getContainer(): Container { return containerB; }
    getContainer().resolveMany([useInterface<IFoo>()]);
  `],
  [HOMONYM, `
    ${IMPORTS}
    import { IFoo, IBar } from './tokens';
    class BarImpl implements IBar { id = 2 }
    export const containerB = defineBuilderConfig({
      injections: [{ token: useInterface<IBar>(), provider: BarImpl }],
    });
    const bag = { resolveMany(tokens: unknown[]): unknown[] { return tokens; } };
    bag.resolveMany([useInterface<IFoo>()]);
    containerB.resolveMany([useInterface<IFoo>()]);
  `],
  [EMPTY, `
    ${IMPORTS}
    import { IFoo, IBar } from './tokens';
    class BarImpl implements IBar { id = 2 }
    export const containerB = defineBuilderConfig({
      injections: [{ token: useInterface<IBar>(), provider: BarImpl }],
    });
    containerB.resolveMany([]);
    containerB.resolveMany([useInterface<IFoo>()]);
  `],
  [WRAPPED, `
    ${IMPORTS}
    import { IFoo, IBar, IExt } from './tokens';
    class BarImpl implements IBar { id = 2 }
    export const containerB = defineBuilderConfig({
      injections: [{ token: useInterface<IBar>(), provider: BarImpl }],
    });
    containerB.resolveMany([useInterface<IFoo>(), useInterface<IExt>()] as const);
    containerB.resolveMany(([useInterface<IFoo>()]));
    containerB.resolveMany([useInterface<IFoo>()] satisfies readonly unknown[]);
    containerB.resolveMany([...([useInterface<IExt>()] as const), useInterface<IBar>()]);
    containerB.resolveMany([useInterface<IExt>()]!);
  `],
  [HOLE, `
    ${IMPORTS}
    import { IFoo, IBar, IExt } from './tokens';
    class BarImpl implements IBar { id = 2 }
    export const containerB = defineBuilderConfig({
      injections: [{ token: useInterface<IBar>(), provider: BarImpl }],
    });
    containerB.resolveMany([useInterface<IFoo>(),, useInterface<IExt>()]);
  `],
  [CAPTURE, `
    ${IMPORTS}
    import { IFoo, IBar } from './tokens';
    class OtherSvc {}
    class Plain {}
    const other = defineBuilderConfig({ injections: [{ token: OtherSvc }] });
    export const capturing = defineBuilderConfig({
      name: 'Capturing',
      injections: [
        { token: Plain },
        {
          token: useInterface<IFoo>(),
          useFactory: true,
          dependencies: [Plain],
          provider: (ctx) => {
            other.resolveMany([OtherSvc]);
            return { id: ctx ? 1 : 0 };
          },
        },
        {
          token: useInterface<IBar>(),
          useFactory: true,
          dependencies: [Plain],
          provider: (ctx) => {
            ctx.resolveMany([Plain]);
            return { id: 2 };
          },
        },
      ],
    });
  `],
]);

function createProgram(sources: Map<string, string>): ts.Program {
  mkdirSync(ROOT, { recursive: true });
  for (const [fileName, text] of sources) writeFileSync(fileName, text);
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    skipLibCheck: true,
    noEmit: true,
    baseUrl: REPO,
    paths: { '@djodjonx/neosyringe': ['packages/neosyringe/src/index.ts'] },
  };
  return ts.createProgram([...sources.keys()], options);
}

const USAGE_CODES = new Set(['NEO_UNKNOWN_CONTAINER', 'NEO_MULTI_REQUIRES_RESOLVE_ALL', 'NEO_ROOT_NOT_EXPORTED', 'NEO_MISSING_PROVIDER']);

function usageErrors(errors: readonly AnalysisError[]): AnalysisError[] {
  return errors.filter((error) => error.code !== undefined && USAGE_CODES.has(error.code));
}

/** `line:column` (1-based) of the node of an error, the way a diagnostic would show it. */
function where(error: AnalysisError): string {
  const position = error.sourceFile.getLineAndCharacterOfPosition(error.node.getStart(error.sourceFile));
  return `${position.line + 1}:${position.character + 1}`;
}

/** `line:column` of the first `needle` on line `line` (1-based). */
function at(file: string, line: number, needle: string, from = 0): string {
  const text = files.get(file) ?? '';
  const lineText = text.split('\n')[line - 1] ?? '';
  const column = lineText.indexOf(needle, from);
  if (column < 0) throw new Error(`no ${needle} on line ${line} of ${file}`);
  return `${line}:${column + 1}`;
}

function lineOf(file: string, marker: string, occurrence = 1): number {
  const lines = (files.get(file) ?? '').split('\n');
  let seen = 0;
  for (const [index, text] of lines.entries()) {
    if (text.includes(marker)) {
      seen += 1;
      if (seen === occurrence) return index + 1;
    }
  }
  throw new Error(`no line with ${marker} in ${file}`);
}

describe('E17 resolveMany usages', () => {
  let program: ts.Program;
  let analyzer: Analyzer;

  beforeAll(() => {
    program = createProgram(files);
    analyzer = new Analyzer(program);
  });

  afterAll(() => {
    rmSync(ROOT, { recursive: true, force: true });
  });

  it('E17-P8 a literal list is one usage per element, reported at the element', () => {
    const errors = usageErrors(analyzer.extractForFile(ELEMENTS).errors);
    const first = lineOf(ELEMENTS, 'containerB.resolveMany([useInterface<IBar>()');
    const multiLine = lineOf(ELEMENTS, 'containerB.resolveMany([', 2);
    const spread = lineOf(ELEMENTS, '[...[useInterface<IFoo>()]');
    expect(errors.map((error) => `${error.code} ${where(error)} ${error.node.getText()}`)).toEqual([
      `NEO_MISSING_PROVIDER ${at(ELEMENTS, first, 'useInterface<IFoo>()')} useInterface<IFoo>()`,
      `NEO_MISSING_PROVIDER ${at(ELEMENTS, multiLine + 1, 'useInterface<IFoo>()')} useInterface<IFoo>()`,
      `NEO_MISSING_PROVIDER ${at(ELEMENTS, multiLine + 3, 'useInterface<IExt>()')} useInterface<IExt>()`,
      `NEO_MISSING_PROVIDER ${at(ELEMENTS, spread, 'useInterface<IFoo>()')} useInterface<IFoo>()`,
    ]);
    expect(errors.every((error) => error.message.startsWith("NEO_MISSING_PROVIDER: '"))).toBe(true);
    expect(errors.every((error) => error.containerId !== undefined && error.containerId === errors[0]?.containerId)).toBe(true);
  });

  it('E17-P8 a closed container refuses its private token at the element', () => {
    const errors = usageErrors(analyzer.extractForFile(CLOSED).errors);
    const line = lineOf(CLOSED, 'closedBox.resolveMany');
    expect(errors.map((error) => `${error.code} ${where(error)} ${error.node.getText()}`)).toEqual([
      `NEO_ROOT_NOT_EXPORTED ${at(CLOSED, line, 'Priv')} Priv`,
    ]);
    expect(errors[0]?.message).toBe("NEO_ROOT_NOT_EXPORTED: 'Priv' is not an exported root of this closed container.");
  });

  it('E17-P8 a multi token in a batch asks for resolveAll, at the element', () => {
    const errors = usageErrors(analyzer.extractForFile(MULTI).errors);
    const line = lineOf(MULTI, 'multiBox.resolveMany');
    expect(errors.map((error) => `${error.code} ${where(error)}`)).toEqual([
      `NEO_MULTI_REQUIRES_RESOLVE_ALL ${at(MULTI, line, 'useInterface<IMulti>()')}`,
    ]);
  });

  it('E17-P8 an empty list makes no usage: only the call after it is reported', () => {
    const errors = usageErrors(analyzer.extractForFile(EMPTY).errors);
    const line = lineOf(EMPTY, 'containerB.resolveMany([useInterface<IFoo>()]);');
    expect(errors.map((error) => `${error.code} ${where(error)}`)).toEqual([
      `NEO_MISSING_PROVIDER ${at(EMPTY, line, 'useInterface<IFoo>()')}`,
    ]);
  });

  it('E17-P9 a list that is not literal is reported once, under the strict rule, and never as a missing provider', () => {
    const errors = usageErrors(analyzer.extractForFile(DYNAMIC).errors);
    const first = lineOf(DYNAMIC, 'containerB.resolveMany(list)');
    const second = lineOf(DYNAMIC, 'containerB.resolveMany(tokens())');
    expect(errors.map((error) => `${error.code} ${error.severity} ${where(error)} ${error.node.getText()}`)).toEqual([
      `NEO_UNKNOWN_CONTAINER error ${at(DYNAMIC, first, 'list)', 'containerB.resolveMany('.length)} list`,
      `NEO_UNKNOWN_CONTAINER error ${at(DYNAMIC, second, 'tokens())', 'containerB.resolveMany('.length)} tokens()`,
    ]);
    expect(errors.every((error) => error.message === 'NEO_UNKNOWN_CONTAINER: resolveMany tokens are not a literal list')).toBe(true);
  });

  it('E17-P9 the same list is a warning in the compatible mode', () => {
    const compatible = new Analyzer(program, { validation: 'compatible' });
    const errors = usageErrors(compatible.extractForFile(DYNAMIC).errors);
    expect(errors.map((error) => `${error.code} ${error.severity}`)).toEqual([
      'NEO_UNKNOWN_CONTAINER warning',
      'NEO_UNKNOWN_CONTAINER warning',
    ]);
  });

  it('E17-P9 a list with one spread that is not literal is not expanded', () => {
    const errors = usageErrors(analyzer.extractForFile(SPREAD).errors);
    const line = lineOf(SPREAD, 'containerB.resolveMany');
    expect(errors.map((error) => `${error.code} ${where(error)} ${error.node.getText()}`)).toEqual([
      `NEO_UNKNOWN_CONTAINER ${at(SPREAD, line, 'rest]')} rest`,
    ]);
  });

  it('E17-P9 a receiver the analyzer cannot follow keeps the receiver message', () => {
    const errors = usageErrors(analyzer.extractForFile(UNKNOWN_RECEIVER).errors);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe('NEO_UNKNOWN_CONTAINER');
    expect(errors[0]?.message).toBe('NEO_UNKNOWN_CONTAINER: resolve receiver is not a known container');
    expect(errors[0]?.node.getText().startsWith('getContainer().resolveMany(')).toBe(true);
  });

  it('E17-P18 a list wrapped in as const, satisfies, parentheses or ! is still read element by element', () => {
    const errors = usageErrors(analyzer.extractForFile(WRAPPED).errors);
    const asConst = lineOf(WRAPPED, '] as const);');
    const parenthesised = lineOf(WRAPPED, 'resolveMany(([');
    const satisfied = lineOf(WRAPPED, 'satisfies readonly');
    const spread = lineOf(WRAPPED, '...([useInterface<IExt>()]');
    const bang = lineOf(WRAPPED, ']!);');
    expect(errors.map((error) => `${error.code} ${where(error)} ${error.node.getText()}`)).toEqual([
      `NEO_MISSING_PROVIDER ${at(WRAPPED, asConst, 'useInterface<IFoo>()')} useInterface<IFoo>()`,
      `NEO_MISSING_PROVIDER ${at(WRAPPED, asConst, 'useInterface<IExt>()')} useInterface<IExt>()`,
      `NEO_MISSING_PROVIDER ${at(WRAPPED, parenthesised, 'useInterface<IFoo>()')} useInterface<IFoo>()`,
      `NEO_MISSING_PROVIDER ${at(WRAPPED, satisfied, 'useInterface<IFoo>()')} useInterface<IFoo>()`,
      `NEO_MISSING_PROVIDER ${at(WRAPPED, spread, 'useInterface<IExt>()')} useInterface<IExt>()`,
      `NEO_MISSING_PROVIDER ${at(WRAPPED, bang, 'useInterface<IExt>()')} useInterface<IExt>()`,
    ]);
  });

  it('E17-P19 a list with a hole is not literal: one report at the hole, no element is read', () => {
    const errors = usageErrors(analyzer.extractForFile(HOLE).errors);
    const line = lineOf(HOLE, 'containerB.resolveMany');
    expect(errors.map((error) => `${error.code} ${where(error)}`)).toEqual([
      `NEO_UNKNOWN_CONTAINER ${at(HOLE, line, ', useInterface<IExt>()')}`,
    ]);
    expect(errors[0]?.message).toBe('NEO_UNKNOWN_CONTAINER: resolveMany tokens are not a literal list');
  });

  it('E17-P10 an object that only has a resolveMany method is ignored, a real call next to it is not', () => {
    const errors = usageErrors(analyzer.extractForFile(HOMONYM).errors);
    const line = lineOf(HOMONYM, 'containerB.resolveMany');
    expect(errors.map((error) => `${error.code} ${where(error)}`)).toEqual([
      `NEO_MISSING_PROVIDER ${at(HOMONYM, line, 'useInterface<IFoo>()')}`,
    ]);
  });

  it('E17-P15cap a captured container is refused in a factory, the factory context is not', () => {
    const escapes = analyzer.extractForFile(CAPTURE).errors.filter((error) => error.code === 'NEO_UNDECLARED_FACTORY_DEP');
    expect(escapes).toHaveLength(1);
    expect(escapes[0]?.message).toContain("factory 'useInterface<IFoo>()' resolves a captured container instead of its context");
    expect(escapes[0]?.message).not.toContain('IBar');
  });

  it('E17-P15cap the text filter of the frontends sees resolveMany', () => {
    expect(textCallsResolve('box.resolveMany([A])')).toBe(true);
    expect(textCallsResolve('box.resolveMany<[A]>([A])')).toBe(true);
    expect(textCallsResolve('box.resolveMany ([A])')).toBe(true);
    expect(textCallsResolve('box.resolveManyThings([A])')).toBe(false);
    expect(textCallsResolve('const resolveMany = 1;')).toBe(false);
  });
});
