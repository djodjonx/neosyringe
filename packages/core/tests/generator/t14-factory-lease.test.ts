import { beforeAll, describe, expect, it } from 'vitest';
import * as ts from 'typescript';
import { Analyzer } from '../../src/analyzer/Analyzer';
import type { DependencyGraph } from '../../src/analyzer/types';
import { Generator } from '../../src/generator/Generator';
import { emitFactoryPolicy, factoryLeaseHelpers } from '../../src/generator/factoryLeaseEmitter';
import { createFastProgram, warmLibCache } from '../fastProgram';
import { named } from '../helpers/t00-contract';
import { capability, many } from '../helpers/e17-build';

/**
 * T14 factory policy and lease. A declared factory has one immutable permission policy per declaration, built once and
 * shared by every invocation and every scope. Each invocation has its own context (a lease) with its own expiry.
 * Every test builds the module the way the plugin writes it, runs it, and reads what a user can observe: values, error
 * codes and messages, creation order, resolve notifications, and the saved contexts of the factories.
 */

type Emitter = 'reference' | undefined;
type Profile = 'full' | 'minimal';
type Mode = 'open' | 'closed';

const HEAD = `
import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';
declare function defineBuilderConfig<T>(config: T): T;
declare function useInterface<T>(): T;
interface Probe { saved: unknown[]; order: string[]; run?: (ctx: unknown) => void; gate?: Promise<void>; }
declare const probe: Probe;
`;

const IMPORT_FROM_NEOSYRINGE = /import\s*\{[^}]*\}\s*from\s*'@djodjonx\/neosyringe';\s*/g;

interface Probe {
  /** The contexts the factories received, in call order. */
  saved: unknown[];
  order: string[];
  /** Called by a factory with its own live context. */
  run?: (ctx: unknown) => void;
  /** An async factory waits on it. */
  gate?: Promise<void>;
}

interface Box {
  resolve(token: unknown): unknown;
  resolveAll(token: unknown): unknown[];
  createScope(): Box;
  initialize(): Promise<void>;
  destroy(): Promise<void>;
  on?(event: 'resolve', listener: (token: unknown, instance: unknown) => void): () => void;
}

function isBox(value: unknown): value is Box {
  if (typeof value !== 'object' || value === null) return false;
  return ['resolve', 'resolveAll', 'createScope', 'initialize', 'destroy']
    .every((member) => typeof Reflect.get(value, member) === 'function');
}

function read(value: unknown, key: string): unknown {
  const readable = (typeof value === 'object' && value !== null) || typeof value === 'function';
  return readable ? Reflect.get(value, key) : undefined;
}

/** `ctx.resolve(token)` or `ctx.resolveAll(token)` on a context a factory handed out. */
function call(ctx: unknown, method: 'resolve' | 'resolveAll', token: unknown): unknown {
  const member = read(ctx, method);
  if (typeof member !== 'function') throw new Error(`context has no ${method}`);
  return Reflect.apply(member, ctx, [token]);
}

interface Failure {
  code: string;
  message: string;
}

/** What a call throws, or `undefined` when it answers. */
function failureOf(run: () => unknown): Failure | undefined {
  try {
    run();
  } catch (error) {
    const code = read(error, 'code');
    const message = read(error, 'message');
    return { code: typeof code === 'string' ? code : 'no-code', message: typeof message === 'string' ? message : String(error) };
  }
  return undefined;
}

async function rejectionOf(work: Promise<unknown>): Promise<Failure | undefined> {
  try {
    await work;
  } catch (error) {
    const code = read(error, 'code');
    const message = read(error, 'message');
    return { code: typeof code === 'string' ? code : 'no-code', message: typeof message === 'string' ? message : String(error) };
  }
  return undefined;
}

function nameOf(key: unknown): string {
  return typeof key === 'function' ? key.name : String(key);
}

function programFor(files: ReadonlyMap<string, string>): ts.Program {
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    noImplicitAny: false,
  };
  const host = ts.createCompilerHost(options);
  const readFile = host.getSourceFile.bind(host);
  const exists = host.fileExists.bind(host);
  host.getSourceFile = (name, languageVersion, onError, shouldCreateNewSourceFile) => {
    const text = files.get(name);
    if (text !== undefined) return ts.createSourceFile(name, text, languageVersion, true);
    return readFile(name, languageVersion, onError, shouldCreateNewSourceFile);
  };
  host.fileExists = (name) => files.has(name) || exists(name);
  const directories = new Set([...files.keys()].map((name) => name.slice(0, name.lastIndexOf('/'))));
  const directoryExists = host.directoryExists?.bind(host);
  host.directoryExists = (name) => directories.has(name) || (directoryExists?.(name) ?? false);
  const readText = host.readFile.bind(host);
  host.readFile = (name) => files.get(name) ?? readText(name);
  return createFastProgram([...files.keys()], options, host);
}

/**
 * A `Map` that notes every instance that holds a permission entry (`'simple'` or `'all'`). The generated module takes
 * it as its `Map`, so the number of notes is the number of policies the module built, whatever the policy's shape.
 */
function countingMap(policies: Set<object>): typeof Map {
  class CountingMap<K, V> extends Map<K, V> {
    override set(key: K, value: V): this {
      if (value === 'simple' || value === 'all') policies.add(this);
      return super.set(key, value);
    }
  }
  return CountingMap;
}

interface BuildOptions {
  emitter?: Emitter;
  validation?: 'compatible';
  /** Modules the container file imports: path from the container file, then the module record `require` answers. */
  modules?: ReadonlyMap<string, string>;
  require?: (id: string) => unknown;
}

interface Built {
  code: string;
  exports: Readonly<Record<string, unknown>>;
  probe: Probe;
  /** The `Map` instances that held a permission entry. */
  policies: Set<object>;
  graphs: readonly DependencyGraph[];
  id(name: string): string;
  box(name?: string): Box;
  /** Puts a new gate in `probe.gate` and answers its release. `close` releases every gate it has not seen released. */
  gate(): () => void;
  close(): Promise<void>;
}

let fileCounter = 0;
const opened: Box[] = [];

function tokenIdOf(graphs: readonly DependencyGraph[], name: string): string {
  for (const graph of graphs) {
    for (const key of [...graph.nodes.keys(), ...(graph.multiNodes?.keys() ?? [])]) {
      if (key.startsWith(`${name}_`)) return key;
    }
  }
  throw new Error(`missing token ${name}`);
}

/** Writes the generated container in place of the `defineBuilderConfig` statement and runs the module. */
function build(source: string, options: BuildOptions = {}): Built {
  warmLibCache();
  fileCounter += 1;
  const directory = `/virtual/t14/case-${fileCounter}`;
  const fileName = `${directory}/inline.ts`;
  const files = new Map<string, string>([[fileName, source]]);
  for (const [path, text] of options.modules ?? []) files.set(`${directory}/${path}`, text);
  const program = programFor(files);
  const analyzer = options.validation ? new Analyzer(program, { validation: options.validation }) : new Analyzer(program);
  const graphs = analyzer.extractAll().filter((graph) => graph.sourceFileName === fileName);
  const ordered = [...graphs].sort((left, right) => (right.variableStatementStart ?? 0) - (left.variableStatementStart ?? 0));
  let code = source;
  for (const graph of ordered) {
    const name = graph.exportedVariableName;
    const start = graph.variableStatementStart;
    const end = graph.defineBuilderConfigEnd;
    if (name === undefined || start === undefined || end === undefined) throw new Error('missing container position');
    named(graphs, name);
    const generator = new Generator(graph, true, undefined, false, false, options.emitter);
    code = `${code.slice(0, start)}${generator.generate()}\nexport const ${name} = ${generator.generateInstantiation()};${code.slice(end)}`;
  }
  const js = ts.transpileModule(code.replace(IMPORT_FROM_NEOSYRINGE, ''), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const record: { exports: Record<string, unknown> } = { exports: {} };
  const probe: Probe = { saved: [], order: [] };
  const policies = new Set<object>();
  const run = new Function('module', 'exports', 'require', 'useInterface', 'probe', 'Map', js) as (
    module: typeof record,
    exports: typeof record.exports,
    require: (id: string) => unknown,
    useInterface: () => null,
    probe: Probe,
    MapClass: typeof Map,
  ) => void;
  run(record, record.exports, options.require ?? ((id) => {
    throw new Error(`unexpected import ${id}`);
  }), () => null, probe, countingMap(policies));
  const exports = record.exports;
  const releases: Array<() => void> = [];
  return {
    code,
    exports,
    probe,
    policies,
    graphs,
    id: (name) => tokenIdOf(graphs, name),
    box: (name = 'box') => {
      const value = exports[name];
      if (!isBox(value)) throw new Error(`export ${name} is not a container`);
      return value;
    },
    gate: () => {
      let release: () => void = () => undefined;
      probe.gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      releases.push(release);
      return release;
    },
    close: async () => {
      // A failed assertion must not leave an initialization waiting on its gate: destroy would wait for it.
      for (const release of releases) release();
      const failures: unknown[] = [];
      for (const box of [...opened.splice(0), ...Object.values(exports).filter(isBox)].reverse()) {
        try {
          await box.destroy();
        } catch (error) {
          if (read(error, 'code') !== 'NEO_CONTAINER_DESTROYED') failures.push(error);
        }
      }
      if (failures.length > 0) throw failures[0];
    },
  };
}

/** Builds `source`, runs `scenario`, and always releases the containers. */
async function withBuilt<T>(source: string, options: BuildOptions, scenario: (built: Built) => Promise<T> | T): Promise<T> {
  const built = build(source, options);
  try {
    return await scenario(built);
  } finally {
    await built.close();
  }
}

const EMITTERS: readonly Emitter[] = [undefined, 'reference'];

function label(emitter: Emitter): string {
  return emitter ?? 'default';
}

const TRANSIENT = `${HEAD}
export class Dep { n = 1; }
interface Made { dep: Dep }
const made = useInterface<Made>();
export const box = defineBuilderConfig({
  name: 'Box',
  injections: [
    { token: Dep },
    { token: made, lifecycle: 'transient', useFactory: true, dependencies: [Dep],
      provider: (ctx) => { probe.saved.push(ctx); return { dep: ctx.resolve(Dep) }; } },
  ],
});
`;

const EXPIRED = 'NEO_FACTORY_CONTEXT_EXPIRED';
const UNDECLARED = 'NEO_UNDECLARED_FACTORY_DEP';

describe('T14 factory policy and lease', () => {
  beforeAll(() => {
    warmLibCache();
  });

  it('P1 builds the policy once for 1000 transient resolves', async () => {
    for (const emitter of EMITTERS) {
      await withBuilt(TRANSIENT, { emitter }, (built) => {
        const box = built.box();
        const made = built.id('Made');
        for (let index = 0; index < 1000; index += 1) box.resolve(made);
        expect(built.policies.size, `${label(emitter)}: policies built`).toBe(1);
        expect(new Set(built.probe.saved).size, `${label(emitter)}: distinct contexts`).toBe(1000);
        for (const ctx of built.probe.saved) {
          expect(failureOf(() => call(ctx, 'resolve', built.exports.Dep))?.code).toBe(EXPIRED);
        }
      });
    }
  });

  it('P2 overlapping async invocations expire only their own context', async () => {
    const source = `${HEAD}
export class Dep { n = 1; }
interface Made { dep: Dep }
const made = useInterface<Made>();
export const box = defineBuilderConfig({
  name: 'Box',
  injections: [
    { token: Dep },
    { token: made, useFactory: true, dependencies: [Dep],
      provider: async (ctx) => { probe.saved.push(ctx); await probe.gate; return { dep: ctx.resolve(Dep) }; } },
  ],
});
`;
    for (const emitter of EMITTERS) {
      await withBuilt(source, { emitter }, async (built) => {
        const box = built.box();
        const scope = box.createScope();
        const releaseFirst = built.gate();
        const first = box.initialize();
        const [firstContext] = built.probe.saved;
        expect(built.probe.saved).toHaveLength(1);
        // The second invocation starts while the first is pending, and settles before it.
        const releaseSecond = built.gate();
        const second = scope.initialize();
        expect(built.probe.saved).toHaveLength(2);
        releaseSecond();
        await second;
        // The settled invocation is over, the pending one is not.
        expect(built.policies.size, `${label(emitter)}: one policy for both invocations`).toBe(1);
        expect(failureOf(() => call(built.probe.saved[1], 'resolve', built.exports.Dep))?.code).toBe(EXPIRED);
        expect(read(call(firstContext, 'resolve', built.exports.Dep), 'n')).toBe(1);
        releaseFirst();
        await first;
        const failure = failureOf(() => call(firstContext, 'resolve', built.exports.Dep));
        expect(failure?.code).toBe(EXPIRED);
        await scope.destroy();
      });
    }
  });

  it('P3 expires after a sync return, a sync throw, an async success and an async rejection', async () => {
    const body = (kind: string): string => `${HEAD}
export class Dep { n = 1; }
interface Made { kind: string }
const made = useInterface<Made>();
export const box = defineBuilderConfig({
  name: 'Box',
  injections: [
    { token: Dep },
    { token: made, useFactory: true, dependencies: [Dep], provider: ${kind} },
  ],
});
`;
    const syncReturn = body("(ctx) => { probe.saved.push(ctx); return { kind: 'sync' }; }");
    const syncThrow = body("(ctx) => { probe.saved.push(ctx); throw new Error('sync boom'); }");
    const asyncReturn = body("async (ctx) => { probe.saved.push(ctx); await probe.gate; return { kind: 'async' }; }");
    const asyncThrow = body("async (ctx) => { probe.saved.push(ctx); await probe.gate; throw new Error('async boom'); }");
    for (const emitter of EMITTERS) {
      await withBuilt(syncReturn, { emitter }, (built) => {
        built.box().resolve(built.id('Made'));
        expect(failureOf(() => call(built.probe.saved[0], 'resolve', built.exports.Dep))?.code, `${label(emitter)} sync return`).toBe(EXPIRED);
      });
      await withBuilt(syncThrow, { emitter }, (built) => {
        expect(failureOf(() => built.box().resolve(built.id('Made')))?.message).toContain('sync boom');
        expect(failureOf(() => call(built.probe.saved[0], 'resolve', built.exports.Dep))?.code, `${label(emitter)} sync throw`).toBe(EXPIRED);
      });
      for (const [name, source, reject] of [['async success', asyncReturn, false], ['async rejection', asyncThrow, true]] as const) {
        await withBuilt(source, { emitter }, async (built) => {
          const release = built.gate();
          const work = built.box().initialize();
          const [ctx] = built.probe.saved;
          // The factory is running: its Promise is not settled, its context is usable.
          expect(read(call(ctx, 'resolve', built.exports.Dep), 'n'), `${label(emitter)} ${name} before settle`).toBe(1);
          release();
          const failure = await rejectionOf(work);
          expect(failure === undefined, `${label(emitter)} ${name} settles as expected`).toBe(!reject);
          expect(failureOf(() => call(ctx, 'resolve', built.exports.Dep))?.code, `${label(emitter)} ${name} after settle`).toBe(EXPIRED);
        });
      }
    }
  });

  it('P13 resolveAll on a saved context after the factory returned throws NEO_FACTORY_CONTEXT_EXPIRED', async () => {
    const source = `${HEAD}
interface Item { n: number }
const item = useInterface<Item>();
interface Made { total: number }
const made = useInterface<Made>();
export const box = defineBuilderConfig({
  name: 'Box',
  injections: [
    { token: item, multi: true, useFactory: true, dependencies: [], provider: () => ({ n: 1 }) },
    { token: item, multi: true, useFactory: true, dependencies: [], provider: () => ({ n: 2 }) },
    { token: made, lifecycle: 'transient', useFactory: true, dependencies: [{ all: item }],
      provider: (ctx) => { probe.saved.push(ctx); return { total: 0 }; } },
  ],
});
`;
    const expired = `${EXPIRED}: factory Made context used after the factory returned`;
    for (const emitter of EMITTERS) {
      await withBuilt(source, { emitter }, (built) => {
        built.box().resolve(built.id('Made'));
        const [ctx] = built.probe.saved;
        // The token is declared `{ all: item }`: only the expiry can refuse this call.
        const failure = failureOf(() => call(ctx, 'resolveAll', built.id('Item')));
        expect(failure, `${label(emitter)} resolveAll after expiry`).toEqual({ code: EXPIRED, message: expired });
      });
    }
  });

  it('P4 refuses an undeclared token and resolveAll on a simple dependency', async () => {
    const source = `${HEAD}
export class Dep { n = 1; }
export class Other { n = 2; }
interface Made { ok: boolean }
const made = useInterface<Made>();
export const box = defineBuilderConfig({
  name: 'Box',
  injections: [
    { token: Dep },
    { token: Other },
    { token: made, lifecycle: 'transient', useFactory: true, dependencies: [Dep],
      provider: (ctx) => { probe.run?.(ctx); return { ok: true }; } },
  ],
});
`;
    for (const emitter of EMITTERS) {
      await withBuilt(source, { emitter }, (built) => {
        const seen: Array<Failure | undefined> = [];
        built.probe.run = (ctx) => {
          seen.push(failureOf(() => call(ctx, 'resolve', built.exports.Other)));
          seen.push(failureOf(() => call(ctx, 'resolve', 'NOT_DECLARED')));
          seen.push(failureOf(() => call(ctx, 'resolveAll', built.exports.Dep)));
          seen.push(failureOf(() => call(ctx, 'resolveAll', built.exports.Other)));
          seen.push(failureOf(() => call(ctx, 'resolve', built.exports.Dep)));
        };
        built.box().resolve(built.id('Made'));
        const undeclared = `${UNDECLARED}: factory Made cannot resolve an undeclared dependency`;
        const refusedAll = `${UNDECLARED}: factory Made cannot resolveAll an undeclared dependency`;
        expect(seen, label(emitter)).toEqual([
          { code: UNDECLARED, message: undeclared },
          { code: UNDECLARED, message: undeclared },
          { code: UNDECLARED, message: refusedAll },
          { code: UNDECLARED, message: refusedAll },
          undefined,
        ]);
      });
    }
  });

  it('P5 merges simple and all on one token to all', async () => {
    const source = (dependencies: string): string => `${HEAD}
interface Item { n: number }
const item = useInterface<Item>();
interface Report { total: number }
const report = useInterface<Report>();
export const box = defineBuilderConfig({
  name: 'Box',
  injections: [
    { token: item, multi: true, useFactory: true, dependencies: [], provider: () => ({ n: 1 }) },
    { token: item, multi: true, useFactory: true, dependencies: [], provider: () => ({ n: 2 }) },
    { token: report, lifecycle: 'transient', useFactory: true, dependencies: [${dependencies}],
      provider: (ctx) => { probe.run?.(ctx); return { total: 0 }; } },
  ],
});
`;
    for (const emitter of EMITTERS) {
      for (const dependencies of ['{ all: item }, item', 'item, { all: item }', '{ all: item }']) {
        await withBuilt(source(dependencies), { emitter }, (built) => {
          const lists: unknown[] = [];
          built.probe.run = (ctx) => {
            lists.push(call(ctx, 'resolveAll', built.id('Item')));
          };
          built.box().resolve(built.id('Report'));
          expect(lists, `${label(emitter)}: ${dependencies}`).toEqual([[{ n: 1 }, { n: 2 }]]);
        });
      }
    }
  });

  it('P6 two scopes share one policy and read their own instances', async () => {
    const source = `${HEAD}
export class Counter { static made = 0; readonly id = ++Counter.made; }
interface Made { id: number }
const made = useInterface<Made>();
export const box = defineBuilderConfig({
  name: 'Box',
  injections: [
    { token: Counter },
    { token: made, lifecycle: 'transient', useFactory: true, dependencies: [Counter],
      provider: (ctx) => { probe.saved.push(ctx); return { id: ctx.resolve(Counter).id }; } },
  ],
});
`;
    for (const emitter of EMITTERS) {
      await withBuilt(source, { emitter }, async (built) => {
        const box = built.box();
        const left = box.createScope();
        const right = box.createScope();
        const made = built.id('Made');
        const ids = [box, left, right, left, box].map((container) => read(container.resolve(made), 'id'));
        // Each scope builds its own Counter once, and reads it again on its next call.
        expect(ids, label(emitter)).toEqual([1, 2, 3, 2, 1]);
        expect(built.policies.size, `${label(emitter)}: one policy for three scopes`).toBe(1);
        expect(new Set(built.probe.saved).size).toBe(5);
        await left.destroy();
        await right.destroy();
      });
    }
  });

  it('P7 same observable results on full and minimal, open and closed, default and reference', async () => {
    const source = (profile: Profile, mode: Mode): string => `${HEAD}
export class DepA { n = 1; constructor() { probe.order.push('A'); } }
export class DepB { n = 2; constructor() { probe.order.push('B'); } }
export class DepC { n = 3; }
interface Made { sum: number }
const made = useInterface<Made>();
export const box = defineBuilderConfig({
  name: 'Box',
  runtime: { profile: '${profile}' },
  ${mode === 'closed' ? 'optimization: { mode: \'closed\', roots: [made] },' : ''}
  injections: [
    { token: DepA },
    { token: DepB },
    { token: DepC },
    { token: made, lifecycle: 'transient', useFactory: true, dependencies: [DepA, DepB],
      provider: (ctx) => {
        probe.order.push('factory');
        const b = ctx.resolve(DepB);
        const a = ctx.resolve(DepA);
        probe.saved.push(ctx);
        probe.run?.(ctx);
        return { sum: a.n + b.n };
      } },
  ],
});
`;
    for (const profile of ['full', 'minimal'] as const) {
      for (const mode of ['open', 'closed'] as const) {
        for (const emitter of EMITTERS) {
          await withBuilt(source(profile, mode), { emitter }, (built) => {
            const where = `${profile} ${mode} ${label(emitter)}`;
            const box = built.box();
            const events: string[] = [];
            const unsubscribe = box.on?.('resolve', (token) => {
              events.push(nameOf(token));
            });
            const codes: Array<string | undefined> = [];
            built.probe.run = (ctx) => {
              codes.push(failureOf(() => call(ctx, 'resolve', built.exports.DepC))?.code);
              codes.push(failureOf(() => call(ctx, 'resolveAll', built.exports.DepA))?.code);
            };
            const made = built.id('Made');
            expect(box.resolve(made), where).toEqual({ sum: 3 });
            // The declared dependencies are read before the factory runs, in declaration order.
            expect(built.probe.order, where).toEqual(['A', 'B', 'factory']);
            expect(codes, where).toEqual([UNDECLARED, UNDECLARED]);
            expect(failureOf(() => call(built.probe.saved[0], 'resolve', built.exports.DepA))?.code, where).toBe(EXPIRED);
            // The full profile and the reference emitter notify, once per read, the warmup reads included.
            const notifies = profile === 'full' || emitter === 'reference';
            expect(typeof box.on === 'function', where).toBe(notifies);
            expect(events, where).toEqual(notifies ? ['DepA', 'DepB', 'DepB', 'DepA', made] : []);
            unsubscribe?.();
          });
        }
      }
    }
  });

  it('P9 an opaque factory keeps its contract: any token, expired after return, no policy', async () => {
    const source = `${HEAD}
export class Dep { n = 1; }
export class Other { n = 2; }
interface Made { sum: number }
const made = useInterface<Made>();
export const box = defineBuilderConfig({
  name: 'Box',
  injections: [
    { token: Dep },
    { token: Other },
    { token: made, lifecycle: 'transient', useFactory: true,
      provider: (ctx) => { probe.saved.push(ctx); return { sum: ctx.resolve(Dep).n + ctx.resolve(Other).n }; } },
  ],
});
`;
    for (const emitter of EMITTERS) {
      await withBuilt(source, { emitter, validation: 'compatible' }, (built) => {
        const where = label(emitter);
        expect(built.box().resolve(built.id('Made')), where).toEqual({ sum: 3 });
        expect(failureOf(() => call(built.probe.saved[0], 'resolve', built.exports.Dep))?.code, where).toBe(EXPIRED);
        expect(built.policies.size, `${where}: no policy`).toBe(0);
        expect(built.code, `${where}: no policy member`).not.toMatch(/__neoPolicy|__neoLease/);
      });
    }
  });

  it('P12 a key that reads undefined at the first call is read again at the next call', async () => {
    const source = `${HEAD}
import { Late } from './late';
interface Made { late: Late }
const made = useInterface<Made>();
export const box = defineBuilderConfig({
  name: 'Box',
  injections: [
    { token: Late },
    { token: made, lifecycle: 'transient', useFactory: true, dependencies: [Late],
      provider: (ctx) => { probe.saved.push(ctx); return { late: ctx.resolve(Late) }; } },
  ],
});
`;
    const late = "export class Late { n = 9; }\n";
    for (const emitter of EMITTERS) {
      // The import cycle of CommonJS output: the namespace the module reads has no `Late` yet at the first call.
      class LateClass { n = 9; }
      const namespace: { Late: unknown } = { Late: undefined };
      const modules = new Map([['late.ts', late]]);
      const require = (id: string): unknown => {
        if (id === './late') return namespace;
        throw new Error(`unexpected import ${id}`);
      };
      await withBuilt(source, { emitter, modules, require }, (built) => {
        const where = label(emitter);
        const box = built.box();
        const made = built.id('Made');
        // `Late` is undefined, so is the key. Whatever the first call does, it must not fix that key.
        failureOf(() => box.resolve(made));
        namespace.Late = LateClass;
        expect(read(box.resolve(made), 'late'), `${where}: second call`).toBeInstanceOf(LateClass);
        // The policy of the first call was built over an undefined key and thrown away; this one has the right key.
        expect(built.policies.size, `${where}: two policies after two calls`).toBe(2);
        box.resolve(made);
        expect(built.policies.size, `${where}: the third call reads the stored policy`).toBe(2);
      });
    }
  });

  it('W2 the policy helper merges simple and all to all, whatever the order, and keeps its Map private', () => {
    const helper = factoryLeaseHelpers('Holder').find((item) => item.id === 'factoryPolicy');
    const member = (helper?.parts ?? []).map((part) => (part.kind === 'generated' ? part.text : '')).join('');
    const js = ts.transpileModule(`function make() { class Holder { ${member} } return Holder; }`, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const holder: unknown = new Function(`${js}\nreturn make();`)();
    const policyOf = read(holder, '__neoPolicyOf');
    if (typeof policyOf !== 'function') throw new Error('the helper declares no __neoPolicyOf');
    const first = {};
    const second = {};
    const build = (entries: unknown): unknown => Reflect.apply(policyOf, holder, [entries]);
    for (const entries of [
      [[first, 'simple'], [first, 'all'], [second, 'simple']],
      [[first, 'all'], [first, 'simple'], [second, 'simple']],
    ]) {
      const policy = build(entries);
      const modeOf = read(policy, 'mode');
      if (typeof modeOf !== 'function') throw new Error('the policy has no mode');
      const mode = (token: unknown): unknown => Reflect.apply(modeOf, policy, [token]);
      expect(mode(first)).toBe('all');
      expect(mode(second)).toBe('simple');
      expect(mode({})).toBeUndefined();
      // The policy is frozen and exposes `mode` only: no Map to call `set` on.
      expect(Object.isFrozen(policy)).toBe(true);
      expect(Object.keys(policy as object)).toEqual(['mode']);
    }
  });

  it('W1 the policy refuses an invalid generated identifier', () => {
    const entries = [{ keyExpression: 'Token', mode: 'simple' as const }];
    expect(emitFactoryPolicy('Container', 'create_X', entries)).toContain('Container.__neoPolicy_create_X');
    expect(() => emitFactoryPolicy('Bad Name', 'create_X', entries)).toThrow('invalid generated identifier');
    expect(() => emitFactoryPolicy('Container', 'create X', entries)).toThrow('invalid generated identifier');
    expect(factoryLeaseHelpers('Container').map((helper) => helper.id)).toEqual(['factoryPolicy', 'factoryLease']);
  });
});

describe('E17-P7 factory context resolveMany', () => {
  beforeAll(() => {
    warmLibCache();
  });

  const declared = (profile: Profile, mode: Mode, useMany = true): string => `${HEAD}
export class DepA { n = 1; constructor() { probe.order.push('A'); } }
export class DepB { n = 2; constructor() { probe.order.push('B'); } }
export class DepC { n = 3; }
interface Made { sum: number }
const made = useInterface<Made>();
export const box = defineBuilderConfig({
  name: 'Box',
  runtime: { profile: '${profile}' },
  ${mode === 'closed' ? 'optimization: { mode: \'closed\', roots: [made] },' : ''}
  injections: [
    { token: DepA },
    { token: DepB },
    { token: DepC },
    { token: made, lifecycle: 'transient', useFactory: true, dependencies: [DepA, DepB],
      provider: (ctx) => {
        probe.saved.push(ctx);
        probe.run?.(ctx);
        ${useMany ? 'const [b, a] = ctx.resolveMany([DepB, DepA]);' : 'const b = ctx.resolve(DepB); const a = ctx.resolve(DepA);'}
        return { sum: a.n + b.n };
      } },
  ],
});
`;

  it('E17-P7 a declared factory resolves a tuple through its context, on every profile, mode and emitter', async () => {
    for (const profile of ['full', 'minimal'] as const) {
      for (const mode of ['open', 'closed'] as const) {
        for (const emitter of EMITTERS) {
          await withBuilt(declared(profile, mode), { emitter }, (built) => {
            const where = `${profile} ${mode} ${label(emitter)}`;
            const box = built.box();
            const events: string[] = [];
            const unsubscribe = box.on?.('resolve', (token) => {
              events.push(nameOf(token));
            });
            const seen: unknown[] = [];
            built.probe.run = (ctx) => {
              capability(ctx);
              const both = many(ctx, [built.exports.DepA, built.exports.DepB]);
              seen.push(both);
              seen.push(many(ctx, []));
              seen.push(failureOf(() => many(ctx, [built.exports.DepA, built.exports.DepC])));
              seen.push(failureOf(() => many(ctx, [built.exports.DepC, built.exports.DepA])));
              seen.push(call(ctx, 'resolve', built.exports.DepA) === (Array.isArray(both) ? both[0] : undefined));
            };
            expect(box.resolve(built.id('Made')), where).toEqual({ sum: 3 });
            const undeclared = { code: UNDECLARED, message: `${UNDECLARED}: factory Made cannot resolve an undeclared dependency` };
            expect(seen.slice(1), where).toEqual([[], undeclared, undeclared, true]);
            expect(Array.isArray(seen[0]) ? seen[0].map((value) => read(value, 'n')) : seen[0], `${where}: left to right`).toEqual([1, 2]);
            // Every element is a read of the context, and the full profile and the reference emitter notify each read:
            // the two warmup reads, [A, B], then A of [A, C] (C is refused before it is read), [] and [C, A] read
            // nothing, one single resolve, and the [B, A] of the factory itself.
            const notifies = profile === 'full' || emitter === 'reference';
            const reads = events.filter((name) => name === 'DepA' || name === 'DepB');
            expect(reads, `${where}: notified reads`).toEqual(notifies ? ['DepA', 'DepB', 'DepA', 'DepB', 'DepA', 'DepA', 'DepB', 'DepA'] : []);
            unsubscribe?.();
          });
        }
      }
    }
  });

  it('E17-P7 a saved context refuses a batch, empty or not, once the factory returned', async () => {
    const expired = { code: EXPIRED, message: `${EXPIRED}: factory Made context used after the factory returned` };
    for (const emitter of EMITTERS) {
      await withBuilt(declared('full', 'open', false), { emitter }, (built) => {
        built.box().resolve(built.id('Made'));
        const [ctx] = built.probe.saved;
        capability(ctx);
        expect(failureOf(() => many(ctx, [])), `${label(emitter)}: empty batch`).toEqual(expired);
        expect(failureOf(() => many(ctx, [built.exports.DepA])), `${label(emitter)}: batch`).toEqual(expired);
        // An undeclared token still reports the expiry first: the lease is read before the policy.
        expect(failureOf(() => many(ctx, [built.exports.DepC])), `${label(emitter)}: undeclared`).toEqual(expired);
      });
    }
  });

  it('E17-P7 an opaque factory may ask for any tuple and its saved context expires', async () => {
    const source = `${HEAD}
export class Dep { n = 1; }
export class Other { n = 2; }
interface Made { sum: number }
const made = useInterface<Made>();
export const box = defineBuilderConfig({
  name: 'Box',
  injections: [
    { token: Dep },
    { token: Other },
    { token: made, lifecycle: 'transient', useFactory: true,
      provider: (ctx) => { probe.saved.push(ctx); const [dep, other] = ctx.resolveMany([Dep, Other]); return { sum: dep.n * 10 + other.n }; } },
  ],
});
`;
    const expired = { code: EXPIRED, message: `${EXPIRED}: factory Made context used after the factory returned` };
    for (const emitter of EMITTERS) {
      await withBuilt(source, { emitter, validation: 'compatible' }, (built) => {
        const where = label(emitter);
        // The factory itself asked for [Dep, Other] while it ran: the values come back in token order (1 * 10 + 2).
        expect(built.box().resolve(built.id('Made')), where).toEqual({ sum: 12 });
        const [ctx] = built.probe.saved;
        capability(ctx);
        expect(failureOf(() => many(ctx, [])), `${where}: empty batch`).toEqual(expired);
        expect(failureOf(() => many(ctx, [built.exports.Dep])), `${where}: batch`).toEqual(expired);
        expect(built.policies.size, `${where}: no policy`).toBe(0);
      });
    }
  });
});
