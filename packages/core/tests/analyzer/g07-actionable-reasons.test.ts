import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as ts from 'typescript';
import { Analyzer } from '../../src/analyzer/Analyzer';
import { fixHintOf, toActionableDiagnostic } from '../../src/analyzer/errors';
import type { AnalysisError } from '../../src/analyzer/types';

/**
 * G07 the fix of an error that shares a code with other causes is told by a structured sub-reason on the error
 * context, set where the analyzer knows the cause: never read back from the message. A cause without a sub-reason
 * gets a hint that holds for every cause of its code.
 */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const IMPORTS = `import { defineBuilderConfig, definePartialConfig, useInterface } from '@djodjonx/neosyringe';`;

const SOURCE = `
  ${IMPORTS}
  interface ILog { n: number }
  interface IThing { id: string }
  class Impl implements IThing { id = 'impl'; }
  class Dup {}
  const log = useInterface<ILog>();
  const thing = useInterface<IThing>();
  const profile = 'full';

  export const owned = defineBuilderConfig({
    name: 'Owned',
    injections: [{ token: log, useValue: { n: 1 }, ownership: 'owned' }],
  });
  export const openRoots = defineBuilderConfig({
    name: 'OpenRoots',
    optimization: { mode: 'open', roots: [Impl] },
    injections: [{ token: Impl }],
  });
  export const badMode = defineBuilderConfig({
    name: 'BadMode',
    optimization: { mode: 'sealed' },
    injections: [{ token: Impl }],
  });
  export const eagerAlias = defineBuilderConfig({
    name: 'EagerAlias',
    optimization: { mode: 'closed', roots: [Impl], eager: [thing] },
    injections: [{ token: Impl }, { token: thing, useExisting: Impl }],
  });
  export const withInputs = definePartialConfig({ scopeInputs: [log], injections: [] });
  export const withInit = definePartialConfig({ initialization: { concurrency: 2 }, injections: [] });
  export const variable = defineBuilderConfig({
    name: 'Variable',
    runtime: { profile },
    injections: [{ token: Impl }],
  });

  export const parent = defineBuilderConfig({ name: 'Parent', injections: [{ token: Dup }] });
  export const child = defineBuilderConfig({ name: 'Child', useContainer: parent, injections: [{ token: Dup }] });
  export const twice = defineBuilderConfig({
    name: 'Twice',
    scopeInputs: [log, log],
    injections: [{ token: Impl }],
  });
  export const same = defineBuilderConfig({ name: 'Same', injections: [{ token: Dup }, { token: Dup }] });

  function getContainer(): typeof same { return same; }
  const list = [log];
  getContainer().resolveMany([log]);
  same.resolveMany(list);
`;

let root = '';
let file = '';
let errors: readonly AnalysisError[] = [];

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), 'g07-reasons-'));
  mkdirSync(root, { recursive: true });
  file = path.join(root, 'app.ts');
  writeFileSync(file, SOURCE);
  const program = ts.createProgram([file], {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    skipLibCheck: true,
    noEmit: true,
    baseUrl: REPO,
    paths: { '@djodjonx/neosyringe': ['packages/neosyringe/src/index.ts'] },
  });
  errors = new Analyzer(program).extractAllErrors();
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/**
 * The hint of the one error of `code` whose node starts at `target`, found inside the first `context` of the source
 * (the last occurrence of `target` in the context; it defaults to the whole context).
 */
function hintAt(code: string, context: string, target: string = context): string | undefined {
  const start = SOURCE.indexOf(context) + context.lastIndexOf(target);
  expect(SOURCE.indexOf(context), `missing ${context}`).toBeGreaterThanOrEqual(0);
  const matches = errors.filter(
    (error) => error.code === code && error.node.getStart(error.sourceFile) === start,
  );
  expect(
    matches.map((error) => error.message),
    `errors of ${code} at ${target}; every error: ${JSON.stringify(errors.map((error) => [error.code, error.node.getStart(error.sourceFile), error.node.getText().slice(0, 30)]))}`,
  ).toHaveLength(1);
  const [match] = matches;
  return match === undefined ? undefined : toActionableDiagnostic(match).hint;
}

describe('G07 NEO_CONFIG_UNSUPPORTED: one fix per cause', () => {
  it('G07-I1 useValue declared owned: use a factory, the opposite of "write a literal"', () => {
    expect(hintAt('NEO_CONFIG_UNSUPPORTED', "{ token: log, useValue: { n: 1 }, ownership: 'owned' }")).toBe(
      "Register a factory with ownership: 'owned' instead of useValue, or remove ownership from the useValue registration.",
    );
  });

  it('G07-I1 open mode with roots or eager: drop them or close the container', () => {
    expect(hintAt('NEO_CONFIG_UNSUPPORTED', 'roots: [Impl] }', '[Impl]')).toBe(
      "Remove roots and eager, or set optimization.mode to 'closed'.",
    );
  });

  it('G07-I1 an unsupported mode literal: name the two modes', () => {
    expect(hintAt('NEO_CONFIG_UNSUPPORTED', "mode: 'sealed'", "'sealed'")).toBe("Set optimization.mode to 'open' or 'closed'.");
  });

  it('G07-I1 an eager root that is an alias: list the target', () => {
    expect(hintAt('NEO_CONFIG_UNSUPPORTED', 'eager: [thing]', 'thing')).toBe(
      'List the target of the alias in eager: an alias builds nothing.',
    );
  });

  it('G07-I1 scopeInputs and initialization in a partial: declare them on the builder', () => {
    expect(hintAt('NEO_CONFIG_UNSUPPORTED', 'scopeInputs: [log], injections: []', 'scopeInputs')).toBe(
      'Declare scopeInputs on the builder (defineBuilderConfig): a partial cannot declare it.',
    );
    expect(hintAt('NEO_CONFIG_UNSUPPORTED', 'initialization: { concurrency: 2 }', 'initialization')).toBe(
      'Declare initialization on the builder (defineBuilderConfig): a partial cannot declare it.',
    );
  });

  it('G07-I1 a cause with no sub-reason gets a hint that holds for every cause', () => {
    const hint = hintAt('NEO_CONFIG_UNSUPPORTED', 'runtime: { profile }', 'profile');

    expect(hint).toBe(
      'Rewrite this option in the form the message above accepts: the build reads only forms it can resolve without running your code.',
    );
  });
});

describe('G07 NEO_DUPLICATE_PROVIDER: scoped: true only where it applies', () => {
  it('G07-M3 a token that a parent already registers: scoped: true is a fix', () => {
    const hint = hintAt('NEO_DUPLICATE_PROVIDER', 'useContainer: parent, injections: [{ token: Dup', 'token: Dup');

    expect(hint).toBe("Remove the duplicate registration of 'Dup', or add scoped: true to override the token of the parent.");
  });

  it('G07-M3 a token registered twice in one container: no scoped: true', () => {
    const hint = hintAt('NEO_DUPLICATE_PROVIDER', '{ token: Dup }, { token: Dup }', 'token: Dup');

    expect(hint).toBe("Keep one declaration of 'Dup': remove the duplicate.");
  });

  it('G07-M3 a scope input listed twice: no scoped: true', () => {
    const hint = hintAt('NEO_DUPLICATE_PROVIDER', 'scopeInputs: [log, log]', 'log]');

    expect(hint).toBe('Keep one declaration of the token: remove the duplicate.');
  });
});

describe('G07 NEO_UNKNOWN_CONTAINER: one fix per kind', () => {
  it('G07-M4 an unknown receiver: resolve on a const from defineBuilderConfig', () => {
    expect(hintAt('NEO_UNKNOWN_CONTAINER', 'getContainer().resolveMany([log])', 'getContainer()')).toBe(
      'Call resolve on a const assigned from defineBuilderConfig: the build cannot tell which container this receiver is.',
    );
  });

  it('G07-M4 a resolveMany list that is not a literal: give a literal list of tokens', () => {
    expect(hintAt('NEO_UNKNOWN_CONTAINER', 'same.resolveMany(list)', 'list')).toBe(
      'Give resolveMany a literal list of tokens, without spread, so the build can read every token.',
    );
  });
});

describe('G07 fixHintOf reads the reason, not the message', () => {
  it('G07-I1 the same code gives a different hint for each reason', () => {
    const owned = fixHintOf({ code: 'NEO_CONFIG_UNSUPPORTED', reason: 'value-owned' });
    const open = fixHintOf({ code: 'NEO_CONFIG_UNSUPPORTED', reason: 'open-mode-roots' });
    const none = fixHintOf({ code: 'NEO_CONFIG_UNSUPPORTED' });

    expect(new Set([owned, open, none]).size).toBe(3);
  });

  it('G07-M4 a reason of another code is ignored', () => {
    expect(fixHintOf({ code: 'NEO_CYCLE', reason: 'unknown-receiver' })).toBe(fixHintOf({ code: 'NEO_CYCLE' }));
  });
});
