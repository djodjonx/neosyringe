import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setImmediate as tick } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@djodjonx/neosyringe-core/generator', () => import('../../core/src/generator/index'));
vi.mock('@djodjonx/neosyringe-core/analyzer', () => import('../../core/src/analyzer/index'));
vi.mock('@djodjonx/neosyringe-core/context', () => import('../../core/src/TSContext'));

import * as ts from 'typescript';
import { TSContext } from '@djodjonx/neosyringe-core/context';
import { neoSyringePlugin } from '../src/index';
import { unsafeTypesMessage } from '../../core/tests/helpers/t23-program';

/**
 * G-module-helpers: the helpers every container of a file calls (the controller factory, the lease, the context class, the
 * policy builder, `formatToken`) are written once in the module, through the real plugin. Every test reads the text the
 * plugin wrote, or runs it: a file with two async containers that read their `signal` and a dependency through a declared
 * factory context. The runtime has `AbortController`, or the test removes it, so the stand-in the module carries is the code
 * under test.
 */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const dirs: string[] = [];
let cwdToRestore: string | undefined;

afterEach(() => {
  if (cwdToRestore !== undefined) {
    process.chdir(cwdToRestore);
    cwdToRestore = undefined;
  }
  TSContext.reset();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Profile = 'full' | 'minimal';
type Mode = 'open' | 'closed';
interface Cell { profile: Profile; mode: Mode }

const CELLS: readonly Cell[] = (['full', 'minimal'] as const).flatMap((profile) =>
  (['open', 'closed'] as const).map((mode): Cell => ({ profile, mode })),
);

const label = (cell: Cell): string => `${cell.profile} ${cell.mode}`;

type Hooks = { transform: (code: string, id: string) => unknown };

function hasTransform(plugin: object): plugin is Hooks {
  return 'transform' in plugin && typeof plugin.transform === 'function';
}

/** A strict project on disk with one file. The directory is a real path, so the program and the plugin spell it alike. */
function transformed(source: string, siblings: Readonly<Record<string, string>> = {}): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'g-module-helpers-')));
  dirs.push(dir);
  if (cwdToRestore === undefined) cwdToRestore = process.cwd();
  process.chdir(dir);
  const project = path.join(dir, 'tsconfig.json');
  writeFileSync(project, JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'bundler',
      strict: true,
      skipLibCheck: true,
      lib: ['ES2022'],
      types: [],
      baseUrl: REPO,
      paths: { '@djodjonx/neosyringe': ['packages/neosyringe/src/index.ts'] },
    },
  }));
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'app.ts');
  writeFileSync(file, source);
  for (const [name, text] of Object.entries(siblings)) writeFileSync(path.join(dir, name), text);
  const plugin = neoSyringePlugin.vite({ project, debug: false });
  if (Array.isArray(plugin) || !hasTransform(plugin)) throw new Error('hook transform attendu');
  const result = plugin.transform(source, file);
  if (typeof result !== 'object' || result === null || !('code' in result) || typeof result.code !== 'string') {
    throw new Error("le plugin n'a rien transformé");
  }
  return result.code;
}

/** `export const boxA` and `boxB`: two async containers, each with a declared sync dependency, both read `ctx.signal` and `ctx.resolve`. */
function source(cell: Cell, options: { nested?: boolean; only?: 'A' } = {}): string {
  const nested = options.nested === true;
  const roots = (): string => (cell.mode === 'closed' ? "optimization: { mode: 'closed', roots: [tX, tT] }," : '');
  const container = (name: string, indent: string): string => `${indent}defineBuilderConfig({
${indent}  name: '${name}',
${indent}  runtime: { profile: '${cell.profile}' },
${indent}  ${roots()}
${indent}  injections: [
${indent}    { token: tC, useFactory: true, dependencies: [], provider: () => ({ name: '-c' }) },
${indent}    { token: tX, useFactory: true, dependencies: [tC], provider: async (ctx) => {
${indent}      probe.seen('${name}', ctx.signal);
${indent}      probe.seen('${name}2', ctx.signal);
${indent}      await probe.gate('${name}');
${indent}      return { name: '${name}' + ctx.resolve<IC>(tC).name };
${indent}    } },
${indent}    { token: tT, useFactory: true, lifecycle: 'transient', dependencies: [], provider: (ctx) => {
${indent}      probe.seen('${name}-idle', ctx.signal);
${indent}      return { name: 't' };
${indent}    } },
${indent}  ],
${indent}})`;
  const head = `import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';
declare const probe: { seen(name: string, signal: unknown): void; gate(name: string): Promise<void> };
interface IC { name: string }
interface IX { name: string }
interface IT { name: string }
export const tC = useInterface<IC>();
export const tX = useInterface<IX>();
export const tT = useInterface<IT>();
`;
  if (nested) {
    return `${head}export function makeA() {
  const boxA = ${container('A', '  ').trimStart()};
  return boxA;
}
export const boxB = ${container('B', '').trimStart()};
`;
  }
  if (options.only === 'A') return `${head}export const boxA = ${container('A', '').trimStart()};\n`;
  return `${head}export const boxA = ${container('A', '').trimStart()};
export const boxB = ${container('B', '').trimStart()};
`;
}

interface Gates {
  open(name: string): void;
  openAll(): void;
}

interface Loaded {
  exports: Record<string, unknown>;
  seen: Map<string, unknown>;
  gates: Gates;
}

/** Runs the transformed module with a probe the test owns: the factories report their signal and wait on gates the test opens. */
function load(code: string): Loaded {
  const js = ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const seen = new Map<string, unknown>();
  const pending = new Map<string, { promise: Promise<void>; open: () => void }>();
  let everythingOpen = false;
  const gateOf = (name: string): { promise: Promise<void>; open: () => void } => {
    const existing = pending.get(name);
    if (existing !== undefined) return existing;
    let open: () => void = () => {};
    const promise = new Promise<void>((resolve) => {
      open = resolve;
    });
    const made = { promise, open };
    // A gate asked for after `openAll()` is open at once: a test opens before a factory reaches its gate.
    if (everythingOpen) open();
    pending.set(name, made);
    return made;
  };
  const probe = {
    seen(name: string, signal: unknown): void {
      if (name.endsWith('2')) {
        // the second read of the same factory: the signal is the same object
        expect(signal).toBe(seen.get(name.slice(0, -1)));
        return;
      }
      seen.set(name, signal);
    },
    gate(name: string): Promise<void> {
      return gateOf(name).promise;
    },
  };
  const record: { exports: Record<string, unknown> } = { exports: {} };
  const run = new Function('exports', 'require', 'probe', js);
  run(record.exports, () => ({}), probe);
  return {
    exports: record.exports,
    seen,
    gates: {
      open: (name) => gateOf(name).open(),
      openAll: () => {
        everythingOpen = true;
        for (const gate of pending.values()) gate.open();
      },
    },
  };
}

function boxOf(loaded: Loaded, name: string): object {
  const value = loaded.exports[name];
  if (typeof value !== 'object' || value === null) throw new Error(`export ${name} is not a container`);
  return value;
}

function call(owner: object, name: string, ...args: unknown[]): unknown {
  const method: unknown = Reflect.get(owner, name);
  if (typeof method !== 'function') throw new Error(`${name} is not a function`);
  return Reflect.apply(method, owner, args);
}

function isSignal(value: unknown): value is { aborted: boolean; reason?: unknown; addEventListener(type: 'abort', listener: () => void): void } {
  return typeof value === 'object' && value !== null && typeof Reflect.get(value, 'addEventListener') === 'function';
}

function signalOf(loaded: Loaded, name: string): { aborted: boolean; reason?: unknown; addEventListener(type: 'abort', listener: () => void): void } {
  const value = loaded.seen.get(name);
  if (!isSignal(value)) throw new Error(`no signal read by ${name}`);
  return value;
}

function count(code: string, pattern: RegExp): number {
  return code.match(pattern)?.length ?? 0;
}

/** Runs `scenario` without `AbortController`: the module's stand-in is what makes the controllers. Callers' controllers are made first. */
async function withoutNativeController(scenario: () => Promise<void>): Promise<void> {
  const native: unknown = Reflect.get(globalThis, 'AbortController');
  Reflect.deleteProperty(globalThis, 'AbortController');
  try {
    await scenario();
  } finally {
    Reflect.set(globalThis, 'AbortController', native);
  }
}

/** Every unhandled rejection `scenario` caused. The runner's own listeners are set aside while it runs. */
async function reportedToHost(scenario: () => Promise<void>): Promise<unknown[]> {
  const seen: unknown[] = [];
  const saved = process.listeners('unhandledRejection');
  process.removeAllListeners('unhandledRejection');
  const onUnhandled = (reason: unknown): void => {
    seen.push(reason);
  };
  process.on('unhandledRejection', onUnhandled);
  try {
    await scenario();
    await tick();
    await tick();
  } finally {
    process.off('unhandledRejection', onUnhandled);
    for (const listener of saved) process.on('unhandledRejection', listener);
  }
  return seen;
}

const REASON = new Error('stop initializing');

/** Bytes of the transpiled controller factory (global controller or stand-in). Measured: 786 (8f35328: 1215). */
const CONTROLLER_LIMIT = 800;
/** Bytes the second container of a file does not pay again (measured: 3658): lease, context class, policy builder, formatToken and controller factory. */
const SHARED_SAVING = 3500;

describe('G the helpers a module needs are written once in that module (P1)', () => {
  for (const cell of CELLS) {
    it(`P1 two async containers of one file share one controller factory, one lease, one context class, one policy builder and one formatToken (${label(cell)})`, async () => {
      const code = transformed(source(cell));
      expect(code.match(/class NeoContainer_\w+ \{/g)).toHaveLength(2);
      expect(count(code, /(?:private static |function )__neo(?:Shared)?Controller\b/g)).toBe(1);
      expect(count(code, /(?:private static |function )__neo(?:Shared)?Lease\b/g)).toBe(1);
      expect(count(code, /(?:private static readonly __neoContext = class|class __neoSharedContext)\b/g)).toBe(1);
      expect(count(code, /(?:private static |function )__neo(?:Shared)?PolicyOf\b/g)).toBe(1);
      expect(count(code, /(?:private static |function )(?:formatToken|__neoSharedFormatToken)\b/g)).toBe(1);
      const loaded = load(code);
      for (const name of ['boxA', 'boxB']) {
        const box = boxOf(loaded, name);
        try {
          loaded.gates.openAll();
          await call(box, 'initialize');
          expect(call(box, 'resolve', loaded.exports.tX)).toEqual({ name: `${name.slice(3)}-c` });
        } finally {
          await call(box, 'destroy');
        }
      }
    });
  }
});

describe('G two containers of one file share text and no state (P2, P3)', () => {
  for (const cell of CELLS) {
    for (const native of [true, false]) {
      it(`P2 aborting the initialization of A leaves the signal and the listeners of B alone (${native ? 'AbortController' : 'stand-in'}, ${label(cell)})`, async () => {
        const callerA = new AbortController();
        const callerB = new AbortController();
        const loaded = load(transformed(source(cell)));
        const boxA = boxOf(loaded, 'boxA');
        const boxB = boxOf(loaded, 'boxB');
        const run = async (): Promise<void> => {
          try {
            const initializedA = call(boxA, 'initialize', { signal: callerA.signal });
            const initializedB = call(boxB, 'initialize', { signal: callerB.signal });
            const settledA = Promise.resolve(initializedA).then(() => undefined, (error: unknown) => error);
            const settledB = Promise.resolve(initializedB).then(() => undefined, (error: unknown) => error);
            await tick();
            await tick();
            const signalA = signalOf(loaded, 'A');
            const signalB = signalOf(loaded, 'B');
            const calls: string[] = [];
            signalA.addEventListener('abort', () => calls.push('A'));
            signalB.addEventListener('abort', () => calls.push('B'));
            callerA.abort(REASON);
            await tick();
            expect(signalA.aborted).toBe(true);
            expect(signalB.aborted).toBe(false);
            expect(calls).toEqual(['A']);
            loaded.gates.openAll();
            expect(await settledA).toBe(REASON);
            expect(await settledB).toBeUndefined();
            expect(calls).toEqual(['A']);
            expect(call(boxB, 'resolve', loaded.exports.tX)).toEqual({ name: 'B-c' });
          } finally {
            loaded.gates.openAll();
            await call(boxA, 'destroy');
            await call(boxB, 'destroy');
          }
        };
        if (native) await run();
        else await withoutNativeController(run);
      });
    }

    it(`P3 the idle signal belongs to its class: a factory called outside an initialization gets the signal of its own container (${label(cell)})`, async () => {
      const loaded = load(transformed(source(cell)));
      const boxA = boxOf(loaded, 'boxA');
      const boxB = boxOf(loaded, 'boxB');
      try {
        loaded.gates.openAll();
        await call(boxA, 'initialize');
        await call(boxB, 'initialize');
        call(boxA, 'resolve', loaded.exports.tT);
        call(boxB, 'resolve', loaded.exports.tT);
        const idleA = signalOf(loaded, 'A-idle');
        const idleB = signalOf(loaded, 'B-idle');
        expect(idleA).not.toBe(idleB);
        const calls: string[] = [];
        idleA.addEventListener('abort', () => calls.push('A'));
        idleB.addEventListener('abort', () => calls.push('B'));
        await call(boxA, 'destroy');
        expect(idleA.aborted).toBe(false);
        expect(idleB.aborted).toBe(false);
        expect(calls).toEqual([]);
      } finally {
        await call(boxA, 'destroy');
        await call(boxB, 'destroy');
      }
    });
  }
});

describe('G the stand-in of a runtime without AbortController is one function of the module (P4)', () => {
  for (const cell of CELLS) {
    it(`P4 listeners run once and in order, a throwing listener reaches the host, two controllers are independent, a signal read twice is one object (${label(cell)})`, async () => {
      const loaded = load(transformed(source(cell)));
      const boxA = boxOf(loaded, 'boxA');
      const boxB = boxOf(loaded, 'boxB');
      const callerA = new AbortController();
      const callerB = new AbortController();
      const reported = await reportedToHost(async () => {
        await withoutNativeController(async () => {
          try {
            const settledA = Promise.resolve(call(boxA, 'initialize', { signal: callerA.signal })).then(() => undefined, (error: unknown) => error);
            const settledB = Promise.resolve(call(boxB, 'initialize', { signal: callerB.signal })).then(() => undefined, (error: unknown) => error);
            await tick();
            await tick();
            const signalA = signalOf(loaded, 'A');
            const signalB = signalOf(loaded, 'B');
            expect(signalA).not.toBe(signalB);
            const calls: string[] = [];
            signalA.addEventListener('abort', () => calls.push('A1'));
            signalA.addEventListener('abort', () => {
              calls.push('A2');
              throw new Error('listener of A');
            });
            signalA.addEventListener('abort', () => calls.push('A3'));
            signalB.addEventListener('abort', () => calls.push('B1'));
            callerA.abort(REASON);
            await tick();
            expect(calls).toEqual(['A1', 'A2', 'A3']);
            expect(signalA.aborted).toBe(true);
            expect(signalA.reason).toBe(REASON);
            expect(signalB.aborted).toBe(false);
            const closingA = call(boxA, 'destroy');
            callerB.abort(REASON);
            await tick();
            expect(calls).toEqual(['A1', 'A2', 'A3', 'B1']);
            expect(signalB.reason).toBe(REASON);
            loaded.gates.openAll();
            expect(await settledA).toBe(REASON);
            expect(await settledB).toBe(REASON);
            await closingA;
            expect(calls).toEqual(['A1', 'A2', 'A3', 'B1']);
          } finally {
            loaded.gates.openAll();
            await call(boxA, 'destroy');
            await call(boxB, 'destroy');
          }
        });
      });
      expect(reported).toHaveLength(1);
      expect(reported[0]).toBeInstanceOf(Error);
      expect(reported[0] instanceof Error ? reported[0].message : '').toBe('listener of A');
    });
  }
});

describe('G where the block is written, and what a container with no module of its own does (P5)', () => {
  it('P5 a container in a nested scope and a top-level one run: the block sits before the first top-level statement that holds a container', async () => {
    const cell: Cell = { profile: 'full', mode: 'open' };
    const code = transformed(source(cell, { nested: true }));
    const block = code.indexOf('// -- Shared helpers --');
    const nested = code.indexOf('export function makeA');
    expect(block).toBeGreaterThanOrEqual(0);
    expect(block).toBeLessThan(nested);
    expect(count(code, /(?:private static |function )__neo(?:Shared)?Lease\b/g)).toBe(1);
    const loaded = load(code);
    const makeA: unknown = loaded.exports.makeA;
    if (typeof makeA !== 'function') throw new Error('makeA is not a function');
    const boxA: unknown = Reflect.apply(makeA, undefined, []);
    if (typeof boxA !== 'object' || boxA === null) throw new Error('makeA made no container');
    const boxB = boxOf(loaded, 'boxB');
    try {
      loaded.gates.openAll();
      await call(boxA, 'initialize');
      await call(boxB, 'initialize');
      expect(call(boxA, 'resolve', loaded.exports.tX)).toEqual({ name: 'A-c' });
      expect(call(boxB, 'resolve', loaded.exports.tX)).toEqual({ name: 'B-c' });
    } finally {
      await call(boxA, 'destroy');
      await call(boxB, 'destroy');
    }
  });
});

/** What loading `code` throws, as `Name: message`, or `undefined` when the module loads. */
function loadFailure(code: string): { loaded?: Loaded; failure?: string } {
  try {
    return { loaded: load(code) };
  } catch (error) {
    return { failure: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
  }
}

/**
 * `makeA` holds a container and is a hoisted function declaration; `early` calls it before the text reaches the declaration. A
 * factory runs at that call, so everything it needs (the lease, the context class) must be bound by then.
 */
function hoistedSource(profile: Profile, options: { prologue?: boolean; locals?: string; doc?: boolean } = {}): string {
  return `${options.prologue === true ? "'use strict';\n" : ''}import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';
${options.doc === true ? '/** The doc of IC. */\n' : ''}interface IC { name: string }
interface IX { name: string }
export const tC = useInterface<IC>();
export const tX = useInterface<IX>();
export const early = makeA();
export function makeA(): string {
${options.locals ?? ''}  const boxA = defineBuilderConfig({
    name: 'A',
    runtime: { profile: '${profile}' },
    injections: [
      { token: tC, useFactory: true, dependencies: [], provider: () => ({ name: '-c' }) },
      { token: tX, useFactory: true, dependencies: [tC], provider: (ctx) => ({ name: 'x' + ctx.resolve<IC>(tC).name }) },
    ],
  });
  return boxA.resolve<IX>(tX).name;
}
`;
}

describe('G a container in a hoisted function that runs before its declaration finds the block bound (I1)', () => {
  for (const profile of ['full', 'minimal'] as const) {
    it(`I1 \`early = makeA()\` runs a declared sync factory before the text reaches \`makeA\` (${profile})`, () => {
      const code = transformed(hoistedSource(profile));
      const { loaded, failure } = loadFailure(code);
      expect(failure).toBeUndefined();
      expect(loaded?.exports.early).toBe('x-c');
    });
  }

  it('I1 the block comes before the first statement that is not an import and not a prologue directive, and holds nothing but types, functions and one class', () => {
    const code = transformed(hoistedSource('full', { prologue: true }));
    const marker = code.indexOf('// -- Shared helpers --');
    expect(marker).toBeGreaterThanOrEqual(0);
    const file = ts.createSourceFile('out.ts', code, ts.ScriptTarget.ES2022, true);
    const isPrologue = (statement: ts.Statement): boolean => ts.isExpressionStatement(statement) && ts.isStringLiteral(statement.expression);
    const before = file.statements.filter((statement) => statement.getStart(file) < marker);
    expect(before.length).toBeGreaterThan(0);
    for (const statement of before) expect(ts.isImportDeclaration(statement) || isPrologue(statement), statement.getText(file)).toBe(true);
    expect(isPrologue(file.statements[0])).toBe(true);
    // The block is its own statements, up to the first statement of the file (`interface IC`): none of them is a binding read
    // before it is initialized, but the class, which comes first.
    const end = code.indexOf('interface IC');
    expect(end).toBeGreaterThan(marker);
    const kinds = file.statements.filter((statement) => statement.getStart(file) >= marker && statement.getStart(file) < end).map((statement) => ts.SyntaxKind[statement.kind]);
    expect(kinds.length).toBeGreaterThan(0);
    expect(kinds.filter((kind) => !['TypeAliasDeclaration', 'FunctionDeclaration', 'ClassDeclaration'].includes(kind))).toEqual([]);
    expect(kinds.filter((kind) => kind === 'ClassDeclaration')).toHaveLength(1);
    expect(loadFailure(code).failure).toBeUndefined();
  });
});

describe('G the block does not come between a doc comment and its statement (I1)', () => {
  it('I1 the doc comment of the first statement of the file stays in front of that statement', () => {
    const code = transformed(hoistedSource('full', { doc: true }));
    expect(code.indexOf('// -- Shared helpers --')).toBeGreaterThanOrEqual(0);
    expect(code).toContain('/** The doc of IC. */\ninterface IC');
    expect(code.indexOf('// -- Shared helpers --')).toBeLessThan(code.indexOf('/** The doc of IC. */'));
  });
});

/**
 * The container is the first statement of the file that is not an import: its edit and the block of the module start at the same
 * offset. The tokens and the probe come from other files, so no statement of the file stands in front of the container.
 */
const FIRST_TOKENS = `import { useInterface } from '@djodjonx/neosyringe';
export interface IC { name: string }
export interface IX { name: string }
export const tC = useInterface<IC>();
export const tX = useInterface<IX>();
export const probe = { seen(_name: string, _signal: unknown): void {} };
`;

function firstStatementSource(head: string, tail: string): string {
  return `import { defineBuilderConfig } from '@djodjonx/neosyringe';
import { tC, tX, probe } from './tokens';
${head}defineBuilderConfig({
  name: 'A',
  runtime: { profile: 'full' },
  injections: [
    { token: tC, useFactory: true, dependencies: [], provider: () => ({ name: '-c' }) },
    { token: tX, useFactory: true, dependencies: [], provider: async (ctx) => {
      probe.seen('A', ctx.signal);
      return { name: 'x' };
    } },
  ],
})${tail}`;
}

describe('G a container that is the first statement of the file gets the block in front of it (G1)', () => {
  const heads = [
    ['export const', 'export const boxA = '],
    ['plain const', 'const boxA = '],
    ['export default', 'export default '],
  ] as const;
  for (const [kind, head] of heads) {
    it(`G1 ${kind}: the block is written, in front of the container, and the module loads`, async () => {
      const tail = kind === 'export default' ? ';\n' : ';\nexport { boxA };\n';
      const code = transformed(firstStatementSource(head, tail), { 'tokens.ts': FIRST_TOKENS });
      const block = code.indexOf('// -- Shared helpers --');
      const container = code.search(/class NeoContainer_\w+ \{/);
      expect(block).toBeGreaterThanOrEqual(0);
      expect(block).toBeLessThan(container);
      expect(count(code, /class __neoSharedContext\b/g)).toBe(1);
      const js = ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
      const record: { exports: Record<string, unknown> } = { exports: {} };
      const tokens = { probe: { seen(): void {} } };
      new Function('exports', 'require', js)(record.exports, (name: string) => (name === './tokens' ? tokens : {}));
      const box = record.exports[kind === 'export default' ? 'default' : 'boxA'];
      if (typeof box !== 'object' || box === null) throw new Error('no container exported');
      try {
        await call(box, 'initialize');
      } finally {
        await call(box, 'destroy');
      }
    });
  }
});

describe('G a name of the block is not shadowed by a local of the scope a container sits in (M3)', () => {
  it('M3 locals named like the helpers of the block do not capture the calls of a container nested in their function', () => {
    const names = ['__neoSharedController', '__neoSharedLease', '__neoSharedContext', '__neoSharedPolicyOf', '__neoSharedFormatToken'];
    const locals = `${names.map((name) => `  const ${name} = 'mine';\n`).join('')}`;
    const code = transformed(hoistedSource('full', { locals }).replace('return boxA.resolve<IX>(tX).name;', `return boxA.resolve<IX>(tX).name + [${names.join(', ')}].join('');`));
    const { loaded, failure } = loadFailure(code);
    expect(failure).toBeUndefined();
    expect(loaded?.exports.early).toBe(`x-c${names.map(() => 'mine').join('')}`);
  });
});

/** The size of the module as it runs: the transpiled text, with no type. */
function runtimeBytes(code: string): number {
  return ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText.length;
}

/** The text of the controller factory in the transpiled module: a member of the class, or a function of the module. */
function controllerText(code: string): string {
  const js = ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  return /(?:static __neoController|function __neoSharedController)\(\) \{[\s\S]*?\n(?: {4})?\}/.exec(js)?.[0] ?? '';
}

describe('G the text of the helpers is small and paid once per module (P7)', () => {
  for (const cell of CELLS) {
    it(`P7 the controller factory with its stand-in is at most ${CONTROLLER_LIMIT} bytes (${label(cell)})`, () => {
      const text = controllerText(transformed(source(cell, { only: 'A' })));
      expect(text.length).toBeGreaterThan(0);
      expect(text.length).toBeLessThanOrEqual(CONTROLLER_LIMIT);
    });

    it(`P7 a second container in the file costs at least ${SHARED_SAVING} bytes less than the first one (${label(cell)})`, () => {
      const one = runtimeBytes(transformed(source(cell, { only: 'A' })));
      const two = runtimeBytes(transformed(source(cell)));
      expect(two).toBeLessThanOrEqual(2 * one - SHARED_SAVING);
    });
  }
});

/** A diagnostic of the transformed text: its code, where it starts and what it says. */
interface Found { code: number; start: number; text: string }

/** Every diagnostic of the transformed text, checked as a strict program at `lib.es2021` that also refuses an unused local. */
function diagnosticsOfOutput(code: string): Found[] {
  const dir = dirs[dirs.length - 1];
  const out = path.join(dir, 'out.ts');
  writeFileSync(out, code);
  const config = ts.readConfigFile(path.join(dir, 'tsconfig.json'), ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dir, undefined, path.join(dir, 'tsconfig.json'));
  // The floor of the output is `lib.es2021`: it has no AbortController, which the block reads from `globalThis`.
  const program = ts.createProgram([out], { ...parsed.options, lib: ['lib.es2021.d.ts'], noUnusedLocals: true, noUnusedParameters: true });
  const found: Found[] = [];
  for (const diagnostic of ts.getPreEmitDiagnostics(program)) {
    const file = diagnostic.file;
    if (!file || !file.fileName.startsWith(dir)) continue;
    found.push({ code: diagnostic.code, start: diagnostic.start ?? 0, text: ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ') });
  }
  return found;
}

describe('G the block of the module is typed and holds no unsafe type (W3)', () => {
  for (const cell of CELLS) {
    it(`W3 the transformed file has no strict diagnostic inside the block, and the block holds no any and no cast through unknown (${label(cell)})`, () => {
      const code = transformed(source(cell));
      const from = code.indexOf('// -- Shared helpers --');
      const to = code.indexOf('// -- Container --');
      expect(from).toBeGreaterThanOrEqual(0);
      expect(to).toBeGreaterThan(from);
      const block = code.slice(from, to);
      // By place, not by message: a diagnostic that names no identifier (TS7006, TS2322 on a structural type) is in the list too.
      const inBlock = diagnosticsOfOutput(code).filter((found) => found.start >= from && found.start < to);
      expect(inBlock.map((found) => `TS${found.code} ${found.text}`)).toEqual([]);
      expect(unsafeTypesMessage(block, 'block.ts')).toBe('');
    });
  }
});
