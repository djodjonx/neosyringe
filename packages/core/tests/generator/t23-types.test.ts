import { afterEach, describe, expect, it } from 'vitest';
import * as ts from 'typescript';
import {
  CASES,
  EMITTERS,
  checkStrict,
  emitCase,
  formatDiagnostic,
  unsafeTypesMessage,
  type EmissionCase,
} from '../helpers/t23-program';
import { warmLibCache } from '../fastProgram';

/**
 * T23 B5, slice S3a. Emitted code carries no unsafe explicit type and type-checks in a real strict Program
 * (strict, noImplicitAny, strictFunctionTypes, lib es2022) together with a consumer source.
 * One test per emitter file: a `: any` put back in a template of that file turns its test red.
 */

interface Issues {
  /** `assertNoUnsafeTypes` failures: `<emitter> | <case> | <file>: <message>`. */
  unsafe: string[];
  /** Strict Program diagnostics: `<emitter> | <case> | TS<code> <file>:<line>:<col> <message>`. */
  diagnostics: string[];
}

function issuesOf(cases: readonly EmissionCase[]): Issues {
  warmLibCache();
  const issues: Issues = { unsafe: [], diagnostics: [] };
  for (const emitter of EMITTERS) {
    for (const emission of cases) {
      const emitted = emitCase(emission, emitter);
      for (const output of emitted.outputs) {
        const message = unsafeTypesMessage(output.code, output.file);
        if (message !== '') issues.unsafe.push(`${emitter} | ${emission.name} | ${message}`);
      }
      for (const diagnostic of checkStrict(emitted.input)) {
        issues.diagnostics.push(`${emitter} | ${emission.name} | ${formatDiagnostic(diagnostic)}`);
      }
    }
  }
  return issues;
}

describe('T23-P7 no unsafe types in emitted output', () => {
  it.each(['Generator', 'DirectEmitter', 'FactoryEmitter', 'ResolveEmitter', 'LifecycleEmitter'])(
    'T23-P7 no unsafe types: %s',
    (_file) => {
      const issues = issuesOf(CASES);
      expect(issues.unsafe, 'explicit unsafe types, double assertions or suppressions in the rendered output').toEqual([]);
      expect(issues.diagnostics, 'strict Program diagnostics on output and consumer').toEqual([]);
    },
    240_000,
  );
});

const GOOD_MODULE = `
export class Box {
  private readonly items = new Map<unknown, unknown>();
  put(key: unknown, value: unknown): void { this.items.set(key, value); }
  fail(code: string): Error {
    const error = new Error(code) as Error & { code: string; cause?: unknown };
    error.code = code;
    error.cause = new AggregateError([new Error('inner')]);
    return error;
  }
}
`;

function strictOf(output: string, consumer = 'export {};\n') {
  return checkStrict({
    dir: '/virtual/t23/self',
    userSource: { file: 'user.ts', text: 'export {};\n' },
    outputs: [{ file: 'out.ts', code: output }],
    consumer: { file: 'consumer.ts', code: consumer },
  });
}

describe('T23-P7 the strict Program harness itself', () => {
  it('T23-W1 accepts a module that is strictly typed, with the es2022 lib (AggregateError, Error.cause)', () => {
    expect(strictOf(GOOD_MODULE).map(formatDiagnostic)).toEqual([]);
  });

  it('T23-W2 reports an implicit any parameter (noImplicitAny is on)', () => {
    const messages = strictOf('export const fail = (code) => code;\n').map(formatDiagnostic);
    expect(messages).toEqual(["TS7006 out.ts:1:22 Parameter 'code' implicitly has an 'any' type."]);
  });

  it('T23-W3 reports a callback passed with a narrower parameter (strictFunctionTypes is on)', () => {
    const output = 'export function on(listener: (token: unknown) => void): void { listener(1); }\n';
    const consumer = "import { on } from './out.ts';\non((token: string) => { void token; });\n";
    expect(strictOf(output, consumer).map((item) => item.code)).toEqual([2345]);
  });

  it('T23-W4 reports a module that does not resolve, so a clean result is not a missing program', () => {
    const consumer = "import { nothing } from './absent.ts';\nvoid nothing;\n";
    expect(strictOf('export {};\n', consumer).map((item) => item.code)).toEqual([2307]);
  });

  it('T23-W5 the unsafe-type check flags an explicit any and names the file', () => {
    const source = 'export const value: any = 1;\n';
    expect(unsafeTypesMessage(source, 'out.ts')).toBe(`out.ts: unsafe type at ${source.indexOf('any')}`);
  });
});

interface Runtime {
  resolve: (token: unknown) => unknown;
  resolveAll: (token: unknown) => unknown[];
  destroy: () => Promise<void>;
  initialize: () => Promise<void>;
}

const opened: Runtime[] = [];

afterEach(async () => {
  for (const container of opened.splice(0).reverse()) await container.destroy().catch(() => undefined);
});

/** Transpiles an emitted module, runs it and returns the exported container `box`. */
function load(code: string, modules: Record<string, unknown>, bound: Record<string, unknown> = {}): Runtime {
  const js = ts.transpileModule(code, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const record: { exports: Record<string, Runtime | undefined> } = { exports: {} };
  const run = new Function('module', 'exports', 'require', ...Object.keys(bound), js) as (
    module: typeof record,
    exports: typeof record.exports,
    require: (id: string) => unknown,
    ...values: unknown[]
  ) => void;
  run(record, record.exports, () => modules, ...Object.values(bound));
  const box = record.exports.box;
  if (!box) throw new Error('generated module did not export box');
  opened.push(box);
  return box;
}

function outputOf(name: string, emitter: 'reference' | 'optimized'): string {
  const emission = CASES.find((item) => item.name === name);
  if (!emission) throw new Error(`unknown case ${name}`);
  const output = emitCase(emission, emitter).outputs.find((item) => item.file === 'box.out.ts');
  if (!output) throw new Error('no box output');
  return output.code;
}

/** Keys of the `T23*` tokens of a container, read from its own `_graph`. */
function tokenOf(box: Runtime, name: string): string {
  const graph = Reflect.get(box, '_graph');
  if (!Array.isArray(graph)) throw new Error('no _graph');
  const found = graph.find((item) => typeof item === 'string' && item.startsWith(`${name}_`));
  if (typeof found !== 'string') throw new Error(`missing token ${name}`);
  return found;
}

describe('T23-P7 the single local assertions hold their invariant at runtime', () => {
  it.each(['reference', 'optimized'] as const)(
    'T23-W6 a factory result that is truthy but not thenable is returned as is, a thenable is awaited (%s)',
    async (emitter) => {
      const source = `
        import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';
        declare function defineBuilderConfig<T>(config: T): T;
        declare function useInterface<T>(): T;
        interface T23Text { readonly value: string }
        interface T23Later { readonly value: number }
        const text = useInterface<T23Text>();
        const later = useInterface<T23Later>();
        export const box = defineBuilderConfig({
          name: 'T23Thenable',
          injections: [
            { token: text, useFactory: true, dependencies: [], provider: () => 'plain text' },
            { token: later, useFactory: true, dependencies: [], provider: () => ({ then(done: (value: number) => void) { done(7); } }) },
          ],
        });
      `;
      const emission: EmissionCase = { name: 'thenable', profile: 'full', source, testOverrides: false, parent: false };
      const code = emitCase(emission, emitter).outputs[0]?.code ?? '';
      const box = load(code, {});
      await box.initialize();
      expect(box.resolve(tokenOf(box, 'T23Text'))).toBe('plain text');
      const value = box.resolve(tokenOf(box, 'T23Later'));
      expect(await value).toBe(7);
    },
  );

  it.each(['reference', 'optimized'] as const)(
    'T23-W7 destroy disposes sync and async singletons once, consumer before dependency (%s)',
    async (emitter) => {
      const calls: string[] = [];
      class T23Db { dispose(): void { calls.push('db'); } }
      class T23Queue { async dispose(): Promise<void> { calls.push('queue'); } }
      class T23Repo {
        constructor(readonly db: T23Db, readonly queue: T23Queue) {}
        dispose(): void { calls.push('repo'); }
      }
      const box = load(outputOf('full lifecycle sync', emitter), { T23Db, T23Queue, T23Repo });
      expect(box.resolve(T23Repo)).toBeInstanceOf(T23Repo);
      await box.destroy();
      expect(calls).toEqual(['repo', 'db', 'queue']);
    },
  );

  it.each(['reference', 'optimized'] as const)(
    'T23-W8 a legacy parent without resolve is skipped, one that resolves answers, a closed one blocks (%s)',
    async (emitter) => {
      const code = outputOf('full open sync parent', emitter);
      const answers = { resolve: (token: unknown) => (token === 'T00ParentPort_x' ? 'from-parent' : undefined) };
      const quiet = {};
      const box = load(code, {}, { parent: answers });
      expect(box.resolve('missing')).toBeUndefined();
      expect(box.resolve('T00ParentPort_x')).toBe('from-parent');
      const skipped = load(code, {}, { parent: quiet });
      expect(() => skipped.resolve('anything')).toThrow(/Service not found/);
      const closed = load(code, {}, { parent: { resolve: answers.resolve, _closed: true, name: 'Gone' } });
      expect(() => closed.resolve('T00ParentPort_x')).toThrow(/NEO_SCOPE_PARENT_DESTROYED: .*parent is destroyed: Gone/);
    },
  );

  it.each(['reference', 'optimized'] as const)(
    'T23-W9 a destroy that lands while a failed initialization cleans up keeps the container destroyed (%s)',
    async (emitter) => {
      const source = `
        import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';
        declare function defineBuilderConfig<T>(config: T): T;
        declare function useInterface<T>(): T;
        export class T23Slow { async dispose(): Promise<void> {} }
        interface T23Late { readonly n: number }
        const late = useInterface<T23Late>();
        export const box = defineBuilderConfig({
          name: 'T23Interleave',
          injections: [
            { token: T23Slow },
            { token: late, useFactory: true, dependencies: [T23Slow], provider: async () => { throw new Error('init failed'); } },
          ],
        });
      `;
      const emission: EmissionCase = { name: 'interleave', profile: 'full', source, testOverrides: false, parent: false };
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let started = 0;
      class T23Slow {
        async dispose(): Promise<void> {
          started += 1;
          await gate;
        }
      }
      const box = load(emitCase(emission, emitter).outputs[0]?.code ?? '', { T23Slow });
      const initializing = box.initialize().then(() => 'ready', (error: unknown) => error);
      for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
      expect(started).toBe(1);
      const closing = box.destroy();
      release();
      const failure = await initializing;
      await closing;
      expect(failure).toBeInstanceOf(Error);
      expect(codeOf(() => box.resolve('anything'))).toBe('NEO_CONTAINER_DESTROYED');
    },
  );

  it.each(['reference', 'optimized'] as const)(
    'T23-W10 a factory with no declared resolveAll dependency cannot list a token (%s)',
    (emitter) => {
      const source = `
        import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';
        declare function defineBuilderConfig<T>(config: T): T;
        declare function useInterface<T>(): T;
        interface T23Greedy { readonly n: number }
        const greedy = useInterface<T23Greedy>();
        export const box = defineBuilderConfig({
          name: 'T23Greedy',
          injections: [
            { token: greedy, useFactory: true, dependencies: [], provider: (ctx) => ({ n: ctx.resolveAll('anything').length }) },
          ],
        });
      `;
      const emission: EmissionCase = { name: 'greedy', profile: 'full', source, testOverrides: false, parent: false };
      const box = load(emitCase(emission, emitter).outputs[0]?.code ?? '', {});
      expect(codeOf(() => box.resolve(tokenOf(box, 'T23Greedy')))).toBe('NEO_UNDECLARED_FACTORY_DEP');
    },
  );
});

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? String(Reflect.get(error, 'code') ?? error.message) : '';
  }
  return '';
}
