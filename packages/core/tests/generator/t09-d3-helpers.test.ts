import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as ts from 'typescript';
import { Analyzer } from '../../src/analyzer/Analyzer';
import type { DependencyGraph } from '../../src/analyzer/types';
import { Generator } from '../../src/generator/Generator';
import { createFastProgram, warmLibCache } from '../fastProgram';
import {
  checkStrict,
  emitCase,
  formatDiagnostic,
  type EmissionCase,
  type StrictDiagnostic,
} from '../helpers/t23-program';

/**
 * Topic 09, stage D3. A container carries only the helpers its graph needs, and no provider the closed
 * graph pruned. Each row of the plan is one named test: D3-1 .. D3-7 here, the plugin case (T23-G4) in
 * packages/unplugin/tests/t23-inline-bindings.test.ts, the size breakdown in tests/e2e/t17-size-measure.test.ts.
 */

type Emitter = 'reference' | 'optimized';
const EMITTERS: readonly Emitter[] = ['reference', 'optimized'];

interface Container {
  initialize: () => Promise<void>;
  resolve: (token: unknown) => unknown;
  resolveAll: (token: unknown) => unknown[];
  destroy: () => Promise<void>;
  override: (token: unknown, factory: () => unknown) => Promise<void>;
  clearOverrides: () => Promise<void>;
}

interface Trace {
  disposals: string[];
}

interface Opened {
  readonly container: Container;
  readonly source: string;
  readonly graph: DependencyGraph;
  readonly trace: Trace;
  /** What the user's file exports: its classes, the tokens of the container. */
  readonly user: Record<string, unknown>;
}

interface Options {
  readonly emitter: Emitter;
  readonly profile?: 'full' | 'minimal';
  readonly testOverrides?: boolean;
  /** The `_graph` and `_dependencyGraph` getters carry data (the plugin's `debug` option). */
  readonly debug?: boolean;
  /**
   * User-scope names a copied factory still reads (`ctx.resolve(base)`): name -> the token it stands for, by the prefix of
   * its id. The output is a separate file, so each is bound to its token id before the generated text.
   */
  readonly reads?: Readonly<Record<string, string>>;
  /** False: the user's file is not run, its exports are empty. Its registrations hold effects the test counts in the output alone. */
  readonly runUser?: boolean;
}

const STUB = `
  import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';
  declare function defineBuilderConfig<T>(config: T): T;
  declare function useInterface<T>(): T;
  export const trace: { disposals: string[] } = { disposals: [] };
`;

let fileSeq = 0;
const opened: Container[] = [];

beforeAll(() => warmLibCache());

afterEach(async () => {
  for (const container of opened.splice(0).reverse()) await container.destroy().catch(() => undefined);
});

function programOf(fileName: string, source: string): ts.Program {
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    strict: true,
    noImplicitAny: false,
  };
  const host = ts.createCompilerHost(options);
  const read = host.getSourceFile.bind(host);
  const exists = host.fileExists.bind(host);
  host.getSourceFile = (name, languageVersion, onError, shouldCreateNewSourceFile) => (
    name === fileName ? ts.createSourceFile(name, source, languageVersion, true) : read(name, languageVersion, onError, shouldCreateNewSourceFile)
  );
  host.fileExists = (name) => name === fileName || exists(name);
  return createFastProgram([fileName], options, host);
}

function transpile(code: string): string {
  return ts.transpileModule(code, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: false },
  }).outputText;
}

type Loader = (module: { exports: Record<string, unknown> }, exports: Record<string, unknown>, require: (id: string) => unknown) => void;

/**
 * The user's file is built and run (its classes are real), then the generated container is built and run with
 * that module standing behind every import the output asks for. The container is the one the output exports.
 */
function open(body: string, options: Options): Opened {
  const fileName = `/virtual/t09-d3/${fileSeq}.ts`;
  fileSeq += 1;
  const source = `${STUB}\n${body}`;
  const graphs = new Analyzer(programOf(fileName, source)).extractAll();
  const found = graphs.find((item) => item.exportedVariableName === 'box');
  if (!found) throw new Error('missing container box');
  const graph: DependencyGraph = options.profile === undefined ? found : { ...found, runtimeProfile: options.profile };
  const problems = (graph.errors ?? []).filter((error) => error.severity !== 'warning').map((error) => error.message);
  if (problems.length > 0) throw new Error(problems.join('\n'));

  const userRecord: { exports: Record<string, unknown> } = { exports: {} };
  // The `declare function` lines stand for the imports in the analysed program; run, the imports are the real bindings.
  const runUser = new Function('module', 'exports', 'require', transpile(source.replace(/^\s*declare function .*$/gm, ''))) as Loader;
  const neo = { defineBuilderConfig: (config: unknown) => config, useInterface: () => ({}) };
  if (options.runUser !== false) runUser(userRecord, userRecord.exports, () => neo);

  const generated = new Generator(graph, false, undefined, options.debug === true, options.testOverrides === true, options.emitter).generate();
  const keys = [...graph.nodes.keys(), ...(graph.multiNodes?.keys() ?? [])];
  const prelude = Object.entries(options.reads ?? {}).map(([name, prefix]) => {
    const id = keys.find((key) => key.startsWith(`${prefix}_`));
    if (id === undefined) throw new Error(`missing token ${prefix}`);
    return `const ${name} = ${JSON.stringify(id)};`;
  });
  const record: { exports: Record<string, unknown> } = { exports: {} };
  const run = new Function('module', 'exports', 'require', transpile(`${prelude.join('\n')}\n${generated}`)) as Loader;
  run(record, record.exports, () => userRecord.exports);
  const container = record.exports.box as Container | undefined;
  if (!container) throw new Error('generated module did not export box');
  opened.push(container);
  const trace = options.runUser === false ? { disposals: [] } : (userRecord.exports.trace as Trace);
  return { container, source: generated, graph, trace, user: userRecord.exports };
}

/** One cell of the class-only matrix. */
interface Cell {
  readonly name: string;
  readonly profile: 'full' | 'minimal';
  readonly testOverrides: boolean;
  readonly async: boolean;
}

const CELLS: Cell[] = [];
for (const async of [false, true]) {
  const timing = async ? 'async' : 'sync';
  CELLS.push({ name: `full, overrides on, ${timing}`, profile: 'full', testOverrides: true, async });
  CELLS.push({ name: `full, overrides off, ${timing}`, profile: 'full', testOverrides: false, async });
  CELLS.push({ name: `minimal, ${timing}`, profile: 'minimal', testOverrides: false, async });
}

/** What a rejected promise rejects with. A promise that resolves is a failure of the test. */
async function rejection(run: () => Promise<void>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection, the promise resolved');
}

function codeOf(error: unknown): unknown {
  return error instanceof Error ? Reflect.get(error, 'code') : undefined;
}

/** A borrowed async factory makes the container async without giving it a disposal slot (the container never disposes a borrowed value). */
const LATER = `
  interface Later { n: number }
  const later = useInterface<Later>();
`;
const LATER_INJECTION = "{ token: later, useFactory: true, ownership: 'borrowed', dependencies: [], provider: async () => ({ n: 2 }) },";

function classOnly(async: boolean): string {
  return `
  export class Leaf { readonly n = 1; }
  export class Branch { constructor(readonly leaf: Leaf) {} }
  ${async ? LATER : ''}
  export const box = defineBuilderConfig({
    name: 'D3ClassOnly',
    injections: [{ token: Leaf }, { token: Branch }, ${async ? LATER_INJECTION : ''}],
  });`;
}

describe('D3-1 no AggregateError without a disposal slot', () => {
  for (const emitter of EMITTERS) {
    for (const cell of CELLS) {
      it(`D3-1 ${emitter}, ${cell.name}: the source never names AggregateError, destroy() completes and the instances are cleared`, async () => {
        const { container, source, user } = open(classOnly(cell.async), { emitter, profile: cell.profile, testOverrides: cell.testOverrides });
        expect(source).not.toContain('AggregateError');
        // No collector either: a local nothing reads is an error for a project that turns noUnusedLocals on.
        expect(source).not.toContain('__neoErrors');
        await container.initialize();
        const branch = container.resolve(user.Branch);
        expect(branch).toBeInstanceOf(user.Branch);
        const cache: unknown = Reflect.get(container, 'instances');
        expect(cache).toBeInstanceOf(Map);
        expect(cache instanceof Map ? cache.size : -1).toBeGreaterThan(0);
        await expect(container.destroy()).resolves.toBeUndefined();
        expect(cache instanceof Map ? cache.size : -1).toBe(0);
      });
    }
  }
});

function disposables(async: boolean): string {
  return `
  export class Alpha { dispose(): void { trace.disposals.push('Alpha'); throw new Error('alpha failed'); } }
  export class Beta { dispose(): void { trace.disposals.push('Beta'); throw new Error('beta failed'); } }
  ${async ? LATER : ''}
  export const box = defineBuilderConfig({
    name: 'D3Disposable',
    injections: [{ token: Alpha }, { token: Beta }, ${async ? LATER_INJECTION : ''}],
  });`;
}

describe('D3-2 a disposable that throws keeps AggregateError', () => {
  for (const emitter of EMITTERS) {
    for (const cell of CELLS.filter((item) => !item.testOverrides || item.profile === 'full')) {
      it(`D3-2 ${emitter}, ${cell.name}: destroy rejects with one AggregateError of the two failures`, async () => {
        const { container, source, user, trace } = open(disposables(cell.async), { emitter, profile: cell.profile, testOverrides: cell.testOverrides });
        expect(source).toContain('AggregateError');
        await container.initialize();
        container.resolve(user.Alpha);
        container.resolve(user.Beta);
        const failure = await rejection(() => container.destroy());
        expect(failure).toBeInstanceOf(AggregateError);
        const errors = failure instanceof AggregateError ? failure.errors : [];
        expect(errors).toHaveLength(2);
        expect(errors.map((error) => (error instanceof Error ? error.message : '')).sort()).toEqual(['alpha failed', 'beta failed']);
        expect([...trace.disposals].sort()).toEqual(['Alpha', 'Beta']);
      });
    }
  }
});

describe('D3-3 testOverrides=false has no _reconfigure and refuses with NEO_TEST_API_DISABLED', () => {
  for (const emitter of EMITTERS) {
    for (const async of [false, true]) {
      it(`D3-3 ${emitter}, ${async ? 'async' : 'sync'}: override() and clearOverrides() reject, nothing is replaced`, async () => {
        const { container, source, user } = open(classOnly(async), { emitter, profile: 'full', testOverrides: false });
        expect(source).not.toContain('_reconfigure');
        await container.initialize();
        const real = container.resolve(user.Leaf);
        const overridden = await rejection(() => container.override(user.Leaf, () => ({ n: 99 })));
        expect(codeOf(overridden)).toBe('NEO_TEST_API_DISABLED');
        expect(overridden instanceof Error ? overridden.message : '').toBe('NEO_TEST_API_DISABLED: [D3ClassOnly] test overrides are disabled');
        const cleared = await rejection(() => container.clearOverrides());
        expect(codeOf(cleared)).toBe('NEO_TEST_API_DISABLED');
        expect(container.resolve(user.Leaf)).toBe(real);
        await expect(container.destroy()).resolves.toBeUndefined();
      });
    }
  }
});

function cached(async: boolean): string {
  return `
  export class Svc { dispose(): void { trace.disposals.push('Svc'); } }
  ${async ? LATER : ''}
  export const box = defineBuilderConfig({
    name: 'D3Cached',
    injections: [{ token: Svc }, ${async ? LATER_INJECTION : ''}],
  });`;
}

describe('D3-4 testOverrides=true still disposes the cached singleton once and invalidates', () => {
  for (const emitter of EMITTERS) {
    for (const async of [false, true]) {
      it(`D3-4 ${emitter}, ${async ? 'async' : 'sync'}: override replaces it, clearOverrides brings back a new real one`, async () => {
        const { container, source, user, trace } = open(cached(async), { emitter, profile: 'full', testOverrides: true });
        expect(source).toContain('_reconfigure');
        await container.initialize();
        const first = container.resolve(user.Svc);
        expect(first).toBeInstanceOf(user.Svc);
        const mock = { mock: true };
        await container.override(user.Svc, () => mock);
        expect(trace.disposals).toEqual(['Svc']);
        // An async container is back to `created` after a reconfiguration.
        if (async) await container.initialize();
        expect(container.resolve(user.Svc)).toBe(mock);
        await container.clearOverrides();
        // The mock is borrowed: it is dropped, never disposed.
        expect(trace.disposals).toEqual(['Svc']);
        if (async) await container.initialize();
        const second = container.resolve(user.Svc);
        expect(second).toBeInstanceOf(user.Svc);
        expect(second).not.toBe(first);
        expect(second).not.toBe(mock);
        await container.destroy();
        expect(trace.disposals).toEqual(['Svc', 'Svc']);
      });
    }
  }
});

/** A sync factory that reads its context: the creator that bumps the re-entry counter in an async container. */
function counted(async: boolean): string {
  return `
  export class Leaf { readonly n = 1; }
  interface Made { n: number }
  const made = useInterface<Made>();
  ${async ? LATER : ''}
  export const box = defineBuilderConfig({
    name: 'D3Counter',
    injections: [{ token: Leaf }, { token: made, useFactory: true, dependencies: [Leaf], provider: (ctx) => ({ n: ctx.resolve<Leaf>(Leaf).n }) }, ${async ? LATER_INJECTION : ''}],
  });`;
}

describe('D3-5 a sync container has no _syncInit, an async one keeps it', () => {
  for (const emitter of EMITTERS) {
    for (const profile of ['full', 'minimal'] as const) {
      it(`D3-5 ${emitter}, ${profile}: sync has no _syncInit`, () => {
        const { source } = open(counted(false), { emitter, profile });
        expect(source).not.toContain('_syncInit');
      });

      it(`D3-5 ${emitter}, ${profile}: async declares, raises and lowers it`, () => {
        const { source } = open(counted(true), { emitter, profile });
        expect(source).toContain('private _syncInit = 0;');
        expect(source).toContain('this._syncInit += 1');
        expect(source).toContain('this._syncInit -= 1');
        expect(source).toContain('this._syncInit > 0');
      });
    }
  }
});

/**
 * Closed, one root. `live` reads every contribution of `item` with `{ all }`; one contribution reads `base`.
 * `dead` (a factory with a dependency), the two contributions of `ghost` (one with a dependency) and `DeadClass`
 * are reached by no root.
 */
const CLOSED_SOURCE = `
  export class DeadClass { readonly n = 3; }
  interface Base { n: number }
  interface Item { k: number }
  interface Live { total: number }
  interface Dead { d: number }
  interface Ghost { g: number }
  const base = useInterface<Base>();
  const item = useInterface<Item>();
  const live = useInterface<Live>();
  const dead = useInterface<Dead>();
  const ghost = useInterface<Ghost>();
  export const box = defineBuilderConfig({
    name: 'D3Closed',
    optimization: { mode: 'closed', roots: [live] },
    injections: [
      { token: base, useFactory: true, dependencies: [], provider: () => ({ n: 10 }) },
      { token: item, multi: true, useFactory: true, dependencies: [], provider: () => ({ k: 1 }) },
      { token: item, multi: true, useFactory: true, dependencies: [base], provider: (ctx) => ({ k: ctx.resolve<Base>(base).n }) },
      { token: live, useFactory: true, dependencies: [{ all: item }], provider: (ctx) => ({ total: ctx.resolveAll<Item>(item).reduce((sum, entry) => sum + entry.k, 0) }) },
      { token: dead, useFactory: true, dependencies: [base], provider: (ctx) => ({ d: ctx.resolve<Base>(base).n + 1 }) },
      { token: ghost, multi: true, useFactory: true, dependencies: [base], provider: (ctx) => ({ g: ctx.resolve<Base>(base).n }) },
      { token: ghost, multi: true, useFactory: true, dependencies: [], provider: () => ({ g: 2 }) },
      { token: DeadClass },
    ],
  });`;

describe('D3-6 closed: no pruned provider appears, a multi read by {all} keeps every contribution', () => {
  for (const emitter of EMITTERS) {
    for (const profile of ['full', 'minimal'] as const) {
      it(`D3-6 ${emitter}, ${profile}: the dead factory, the dead contributions and the dead class are in no table, policy, name or metadata`, async () => {
        const { container, source, graph } = open(CLOSED_SOURCE, { emitter, profile, debug: true, reads: { base: 'Base', item: 'Item' } });
        const idOf = (name: string): string => {
          const found = [...graph.nodes.keys(), ...(graph.multiNodes?.keys() ?? [])].find((id) => id.startsWith(`${name}_`));
          if (found === undefined) throw new Error(`missing token ${name}`);
          return found;
        };
        // What the plan prunes, by the id the analysis gave it: that id is in every name and every key derived from it.
        for (const pruned of ['Dead', 'Ghost']) expect(source, pruned).not.toContain(idOf(pruned));
        expect(source).not.toContain('DeadClass');
        // The control: what the root reaches is kept, whole.
        for (const kept of ['Live', 'Item', 'Base']) expect(source, kept).toContain(idOf(kept));
        await container.initialize();
        expect(container.resolve(idOf('Live'))).toEqual({ total: 11 });
        await container.destroy();
      });
    }
  }
});

/** An async container that owns a disposable: the output that asks the most of its lib. */
function floorSource(profile: 'full' | 'minimal', roots: string | undefined): string {
  const optimization = roots === undefined ? '' : `optimization: { mode: 'closed', roots: [${roots}] },`;
  return `
  ${STUB}
  export class D3Db { dispose(): void {} }
  interface D3Made { n: number }
  const made = useInterface<D3Made>();
  export const box = defineBuilderConfig({
    name: 'D3Floor',
    runtime: { profile: '${profile}' },
    ${optimization}
    injections: [
      { token: D3Db },
      { token: made, useFactory: true, dependencies: [D3Db], provider: async () => ({ n: 4 }) },
    ],
  });
`;
}

/** The class-only container of D3-1 as a case of the strict program: nothing in it asks for AggregateError. */
function floorClassOnly(profile: 'full' | 'minimal'): string {
  return `
  ${STUB}
  export class D3Leaf { readonly n = 1; }
  export const box = defineBuilderConfig({
    name: 'D3FloorClassOnly',
    runtime: { profile: '${profile}' },
    injections: [{ token: D3Leaf }],
  });
`;
}

function floorCase(name: string, profile: 'full' | 'minimal', source: string, testOverrides: boolean): EmissionCase {
  return { name, profile, source, testOverrides, parent: false };
}

/**
 * A pruned useValue is evaluated once, for its effect (ADR006), and it is typed by nothing: the interface its token
 * is declared with is not named in the output, so no `import type` of it is written either.
 */
const DEAD_VALUE = `
  export interface DeadShape { secret: string }
  interface LiveShape { n: number }
  const dead = useInterface<DeadShape>();
  const live = useInterface<LiveShape>();
  export const box = defineBuilderConfig({
    name: 'D3DeadValue',
    optimization: { mode: 'closed', roots: [live] },
    injections: [
      { token: live, useFactory: true, dependencies: [], provider: () => ({ n: 1 }) },
      { token: dead, useValue: { secret: String((globalThis as { __d3Dead?: number }).__d3Dead = ((globalThis as { __d3Dead?: number }).__d3Dead ?? 0) + 1) } },
    ],
  });`;

describe('D3-8 a pruned useValue keeps its single evaluation and drops the name of its type', () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, '__d3Dead');
  });

  for (const emitter of EMITTERS) {
    it(`D3-8 ${emitter}: the value is evaluated once, no output text names its interface`, async () => {
      Reflect.deleteProperty(globalThis, '__d3Dead');
      const { container, source, graph } = open(DEAD_VALUE, { emitter, profile: 'full', debug: true, runUser: false });
      expect(source).not.toContain('DeadShape');
      expect(source).not.toContain('import type');
      expect(Reflect.get(globalThis, '__d3Dead')).toBe(1);
      const live = [...graph.nodes.keys()].find((id) => id.startsWith('LiveShape_'));
      expect(live).toBeDefined();
      await container.initialize();
      expect(container.resolve(live)).toEqual({ n: 1 });
      expect(Reflect.get(globalThis, '__d3Dead')).toBe(1);
    });
  }
});

const ES2021 = ['lib.es2021.d.ts'] as const;
const ES2020 = ['lib.es2020.d.ts'] as const;

function diagnosticsAt(emission: EmissionCase, emitter: Emitter, lib: readonly string[]): StrictDiagnostic[] {
  const emitted = emitCase(emission, emitter);
  return checkStrict({ ...emitted.input, lib });
}

const FLOOR_CELLS: readonly EmissionCase[] = [
  floorCase('floor full open', 'full', floorSource('full', undefined), false),
  floorCase('floor full closed', 'full', floorSource('full', 'D3Db, made'), false),
  floorCase('floor full open overrides', 'full', floorSource('full', undefined), true),
  floorCase('floor minimal open', 'minimal', floorSource('minimal', undefined), false),
  floorCase('floor minimal closed', 'minimal', floorSource('minimal', 'D3Db, made'), false),
];

describe('D3-7 the emitted code type-checks at lib es2021, AggregateError is the only name above es2020', () => {
  for (const emitter of EMITTERS) {
    for (const cell of FLOOR_CELLS) {
      it(`D3-7 ${emitter}, ${cell.name}: no diagnostic at lib es2021, the output names AggregateError`, () => {
        expect(emitCase(cell, emitter).outputs[0]?.code).toContain('AggregateError');
        expect(diagnosticsAt(cell, emitter, ES2021).map(formatDiagnostic)).toEqual([]);
      });
    }

    it(`D3-7 ${emitter}: at lib es2020 the same output reports TS2304 for AggregateError and nothing else`, () => {
      const cell = FLOOR_CELLS[0];
      if (!cell) throw new Error('no floor cell');
      const found = diagnosticsAt(cell, emitter, ES2020);
      expect(found.length).toBeGreaterThan(0);
      expect([...new Set(found.map((item) => `TS${item.code} ${item.message}`))]).toEqual(["TS2304 Cannot find name 'AggregateError'."]);
    });

    for (const profile of ['full', 'minimal'] as const) {
      it(`D3-7 ${emitter}, ${profile}: a container with no disposal slot needs nothing above lib es2020`, () => {
        const cell = floorCase(`floor ${profile} class only`, profile, floorClassOnly(profile), false);
        expect(emitCase(cell, emitter).outputs[0]?.code).not.toContain('AggregateError');
        expect(diagnosticsAt(cell, emitter, ES2020).map(formatDiagnostic)).toEqual([]);
      });
    }
  }
});
