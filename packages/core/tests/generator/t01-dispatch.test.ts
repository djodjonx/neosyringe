import { beforeAll, describe, expect, it } from 'vitest';
import * as ts from 'typescript';
import { Analyzer } from '../../src/analyzer/Analyzer';
import type { DependencyGraph } from '../../src/analyzer/types';
import { Generator } from '../../src/generator/Generator';
import { emitDispatchField, emitDispatchRead } from '../../src/generator/dispatchEmitter';
import { createFastProgram, warmLibCache } from '../fastProgram';
import { named } from '../helpers/t00-contract';

/**
 * T01 shared dispatch. The generated container reads one private static table per class to find the
 * accessor of a token, and every scope calls it with its own `this`. Every runtime test builds the same source
 * with the default emitter and with `emitter: 'reference'`, and the two must observe the same thing.
 * The default emitter must also be the one that reads the table: `expectTables` asserts it.
 */

type Emitter = 'reference' | 'optimized' | undefined;

const HEAD = `
import { defineBuilderConfig, useInterface, useProperty } from '@djodjonx/neosyringe';
declare function defineBuilderConfig<T>(config: T): T;
declare function useInterface<T>(): T;
declare function useProperty<T>(target: unknown, name: string): T;
`;

const DESTROYED = 'NEO_CONTAINER_DESTROYED';
const IMPORT_FROM_NEOSYRINGE = /import\s*\{[^}]*\}\s*from\s*'@djodjonx\/neosyringe';\s*/g;

interface Box {
  resolve(token: unknown): unknown;
  resolveAll(token: unknown): unknown[];
  createScope(): Box;
  destroy(): Promise<void>;
  override(token: unknown, factory: () => unknown): Promise<void>;
  clearOverrides(): Promise<void>;
}

function isBox(value: unknown): value is Box {
  if (typeof value !== 'object' || value === null) return false;
  return ['resolve', 'resolveAll', 'createScope', 'destroy', 'override', 'clearOverrides']
    .every((member) => typeof Reflect.get(value, member) === 'function');
}

function read(value: unknown, key: string): unknown {
  const readable = (typeof value === 'object' && value !== null) || typeof value === 'function';
  return readable ? Reflect.get(value, key) : undefined;
}

function errorCode(error: unknown): string {
  const code = read(error, 'code');
  if (typeof code === 'string') return code;
  const name = read(error, 'name');
  return typeof name === 'string' ? name : String(error);
}

/** The error code a call fails with, or `ok` when it answers. */
function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return errorCode(error);
  }
  return 'ok';
}

function nameOf(key: unknown): string {
  return typeof key === 'function' ? key.name : String(key);
}

function tokenIdOf(graphs: readonly DependencyGraph[], name: string): string {
  for (const graph of graphs) {
    for (const key of [...graph.nodes.keys(), ...(graph.multiNodes?.keys() ?? [])]) {
      if (key.startsWith(`${name}_`)) return key;
    }
  }
  throw new Error(`missing token ${name}`);
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

interface BuildOptions {
  testOverrides?: boolean;
  /** Modules the container file imports (path from the container's directory, then text) and the `require` that serves them. */
  modules?: ReadonlyMap<string, string>;
  require?: (id: string) => unknown;
  /** Rows up to which a table is the linear cases. These tests read the shared tables, so it is 0 unless a test says otherwise. */
  linearMax?: number;
}

interface Built {
  /** The module the container was written into, TypeScript. */
  code: string;
  exports: Readonly<Record<string, unknown>>;
  graphs: readonly DependencyGraph[];
  id(name: string): string;
  box(name?: string): Box;
  track(box: Box): Box;
  close(): Promise<void>;
}

let fileCounter = 0;

function execute(code: string, require: (id: string) => unknown): Record<string, unknown> {
  const js = ts.transpileModule(code.replace(IMPORT_FROM_NEOSYRINGE, ''), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const record: { exports: Record<string, unknown> } = { exports: {} };
  // `useInterface` and `useProperty` stay in the user's own file, where they only name a token.
  const run = new Function('module', 'exports', 'require', 'useInterface', 'useProperty', js) as (
    module: typeof record,
    exports: typeof record.exports,
    require: (id: string) => unknown,
    useInterface: () => null,
    useProperty: () => null,
  ) => void;
  run(record, record.exports, require, () => null, () => null);
  return record.exports;
}

function wrap(code: string, exports: Record<string, unknown>, graphs: readonly DependencyGraph[]): Built {
  const opened: Box[] = [];
  const track = (box: Box): Box => {
    opened.push(box);
    return box;
  };
  return {
    code,
    exports,
    graphs,
    id: (name) => tokenIdOf(graphs, name),
    box: (name = 'box') => {
      const value = exports[name];
      if (!isBox(value)) throw new Error(`export ${name} is not a container`);
      return value;
    },
    track,
    close: async () => {
      const failures: unknown[] = [];
      const everyBox = [...opened, ...Object.values(exports).filter(isBox)];
      for (const box of everyBox.reverse()) {
        try {
          await box.destroy();
        } catch (error) {
          if (errorCode(error) !== DESTROYED) failures.push(error);
        }
      }
      if (failures.length > 0) throw failures[0];
    },
  };
}

/**
 * The way the build plugin writes a container: the generated class takes the place of the
 * `defineBuilderConfig` statement, inside the user's own file, so a class declared further down is a real
 * binding of the same module. Several containers of one file are written from the last to the first.
 */
function build(source: string, emitter: Emitter, options: BuildOptions = {}): Built {
  warmLibCache();
  fileCounter += 1;
  const fileName = `/virtual/t01/inline-${fileCounter}.ts`;
  const files = new Map([[fileName, source]]);
  for (const [path, text] of options.modules ?? []) files.set(`/virtual/t01/${path}`, text);
  const graphs = new Analyzer(programFor(files)).extractAll().filter((graph) => graph.sourceFileName === fileName);
  const ordered = [...graphs].sort((left, right) => (right.variableStatementStart ?? 0) - (left.variableStatementStart ?? 0));
  let code = source;
  for (const graph of ordered) {
    const name = graph.exportedVariableName;
    const start = graph.variableStatementStart;
    const end = graph.defineBuilderConfigEnd;
    if (name === undefined || start === undefined || end === undefined) throw new Error('missing container position');
    named(graphs, name);
    const generator = new Generator(graph, true, undefined, false, options.testOverrides ?? false, emitter, undefined, undefined, {
      linearMax: options.linearMax ?? 0,
    });
    code = `${code.slice(0, start)}${generator.generate()}\nexport const ${name} = ${generator.generateInstantiation()};${code.slice(end)}`;
  }
  const exports = execute(code, options.require ?? ((id) => {
    throw new Error(`unexpected import ${id}`);
  }));
  return wrap(code, exports, graphs);
}

async function withBuilt<T>(
  source: string,
  emitter: Emitter,
  options: BuildOptions,
  scenario: (built: Built) => Promise<T> | T,
): Promise<T> {
  const built = build(source, emitter, options);
  try {
    return await scenario(built);
  } finally {
    await built.close();
  }
}

/** The default emitter reads the shared tables: a build that still emits the reference resolver fails here. */
function expectTables(code: string, tables: readonly string[]): void {
  for (const table of tables) {
    expect(code, `the default emitter declares ${table}`).toMatch(new RegExp(`private static ${table}\\b`));
  }
}

const DISPATCH = ['__neoDispatch'];

/** Same scenario on the default emitter and on `emitter: 'reference'`. */
async function observe<T>(
  source: string,
  options: BuildOptions,
  scenario: (built: Built) => Promise<T> | T,
  tables: readonly string[] = DISPATCH,
): Promise<{ byDefault: T; reference: T }> {
  const byDefault = await withBuilt(source, undefined, options, (built) => {
    expectTables(built.code, tables);
    return scenario(built);
  });
  const reference = await withBuilt(source, 'reference', options, scenario);
  return { byDefault, reference };
}

function tableOf(box: object, field: string): unknown {
  const ctor: unknown = Reflect.get(Object.getPrototypeOf(box), 'constructor');
  if (typeof ctor !== 'function') throw new Error('container has no class');
  return Reflect.get(ctor, field);
}

/** One member of the generated class: from its signature to the closing brace at member depth. */
function memberText(code: string, signature: string): string {
  const start = code.indexOf(signature);
  if (start < 0) throw new Error(`generated source has no ${signature}`);
  const end = code.indexOf('\n  }', start);
  return code.slice(start, end < 0 ? undefined : end + 4);
}

describe('T01 shared dispatch', () => {
  beforeAll(() => {
    warmLibCache();
  });

  it('P1 two scopes share one static table, own caches', async () => {
    const source = `${HEAD}
export class Counter { static made = 0; readonly id = ++Counter.made; }
export const box = defineBuilderConfig({ name: 'Box', injections: [{ token: Counter }] });
`;
    await withBuilt(source, undefined, {}, (built) => {
      expect(built.code.match(/private static __neoDispatch\b/g)?.length).toBe(1);
      // A container without a multi token has no list table to build.
      expect(built.code).not.toMatch(/__neoLists|__neoRootLists/);
      const box = built.box();
      const left = built.track(box.createScope());
      const right = built.track(box.createScope());
      const rootCounter = box.resolve(built.exports.Counter);
      const leftCounter = left.resolve(built.exports.Counter);
      const rightCounter = right.resolve(built.exports.Counter);
      expect([read(rootCounter, 'id'), read(leftCounter, 'id'), read(rightCounter, 'id')]).toEqual([1, 2, 3]);
      expect(left.resolve(built.exports.Counter)).toBe(leftCounter);
      expect(right.resolve(built.exports.Counter)).toBe(rightCounter);
      const table = tableOf(box, '__neoDispatch');
      expect(table).toBeInstanceOf(Map);
      expect(tableOf(left, '__neoDispatch')).toBe(table);
      expect(tableOf(right, '__neoDispatch')).toBe(table);
      expect(Object.keys(left)).not.toContain('__neoDispatch');
      return undefined;
    });
  });

  it('P2 homonym classes resolve their own implementation', async () => {
    const files = new Map<string, string>([
      ['/virtual/t01h/left.ts', "export class Service { readonly side = 'left'; }\n"],
      ['/virtual/t01h/right.ts', "export class Service { readonly side = 'right'; }\n"],
      ['/virtual/t01h/app.ts', `${HEAD}
import { Service as Left } from './left';
import { Service as Right } from './right';
export const box = defineBuilderConfig({ name: 'Box', injections: [{ token: Left }, { token: Right }] });
`],
    ]);
    class LeftService { readonly side = 'left'; }
    class RightService { readonly side = 'right'; }
    const graphs = new Analyzer(programFor(files)).extractAll();
    const graph = named(graphs, 'box');
    const run = async (emitter: Emitter): Promise<{ code: string; seen: unknown }> => {
      const code = new Generator(graph, false, '/virtual/t01h', false, false, emitter, undefined, undefined, { linearMax: 0 }).generate();
      const modules: Record<string, unknown> = {
        './left.ts': { Service: LeftService },
        './right.ts': { Service: RightService },
      };
      const exports = execute(code, (id) => {
        const hit = modules[id];
        if (hit === undefined) throw new Error(`missing module ${id}`);
        return hit;
      });
      const built = wrap(code, exports, graphs);
      try {
        const box = built.box();
        const left = box.resolve(LeftService);
        const right = box.resolve(RightService);
        return {
          code,
          seen: {
            sides: [read(left, 'side'), read(right, 'side')],
            distinct: left !== right,
            cached: box.resolve(LeftService) === left && box.resolve(RightService) === right,
          },
        };
      } finally {
        await built.close();
      }
    };
    const byDefault = await run(undefined);
    expectTables(byDefault.code, DISPATCH);
    const reference = await run('reference');
    const expected = { sides: ['left', 'right'], distinct: true, cached: true };
    expect(byDefault.seen).toEqual(expected);
    expect(reference.seen).toEqual(expected);
  });

  it('P3 undefined, 0, false and null values are values', async () => {
    const source = `${HEAD}
export const calls: string[] = [];
interface Undef { v: number }
interface Zero { v: number }
interface No { v: number }
interface Nil { v: number }
interface Once { v: number }
const undef = useInterface<Undef>();
const zero = useInterface<Zero>();
const no = useInterface<No>();
const nil = useInterface<Nil>();
const once = useInterface<Once>();
export const box = defineBuilderConfig({
  name: 'Box',
  injections: [
    { token: undef, useValue: undefined },
    { token: zero, useValue: 0 },
    { token: no, useValue: false },
    { token: nil, useValue: null },
    { token: once, useFactory: true, dependencies: [], provider: () => { calls.push('once'); return undefined; } },
  ],
});
`;
    const seen = await observe(source, {}, (built) => {
      const box = built.box();
      const answer = (name: string): string => {
        const id = built.id(name);
        try {
          return `value:${String(box.resolve(id))}`;
        } catch (error) {
          return `error:${errorCode(error)}`;
        }
      };
      const values = ['Undef', 'Zero', 'No', 'Nil', 'Once'].map(answer);
      const again = answer('Once');
      return { values, again, calls: read(built.exports.calls, 'length') };
    });
    const expected = {
      values: ['value:undefined', 'value:0', 'value:false', 'value:null', 'value:undefined'],
      again: 'value:undefined',
      calls: 1,
    };
    expect(seen.byDefault).toEqual(expected);
    expect(seen.reference).toEqual(expected);
  });

  it('P4 multi is refused by resolve and listed by resolveAll', async () => {
    const source = `${HEAD}
export class Plain {}
interface Plugin { name: string }
const plugin = useInterface<Plugin>();
export const box = defineBuilderConfig({
  name: 'Box',
  injections: [
    { token: Plain },
    { token: plugin, multi: true, useFactory: true, dependencies: [], provider: () => ({ name: 'auth' }) },
    { token: plugin, multi: true, useFactory: true, dependencies: [], provider: () => ({ name: 'log' }) },
  ],
});
`;
    const seen = await observe(source, {}, (built) => {
      const box = built.box();
      const id = built.id('Plugin');
      const first = box.resolveAll(id);
      const second = box.resolveAll(id);
      return {
        refused: codeOf(() => box.resolve(id)),
        names: first.map((item) => read(item, 'name')),
        sameInstances: first.length === second.length && first.every((item, index) => item === second[index]),
        freshArray: first !== second,
        unknown: box.resolveAll('nothing registered'),
      };
    }, [...DISPATCH, '__neoLists']);
    const expected = {
      refused: 'NEO_MULTI_REQUIRES_RESOLVE_ALL',
      names: ['auth', 'log'],
      sameInstances: true,
      freshArray: true,
      unknown: [],
    };
    expect(seen.byDefault).toEqual(expected);
    expect(seen.reference).toEqual(expected);
  });

  it('P5a the closed public resolve reads only the roots table', async () => {
    const source = `${HEAD}
export class Inner {}
export class Pub { constructor(readonly inner: Inner) {} }
export const box = defineBuilderConfig({
  name: 'Box',
  optimization: { mode: 'closed', roots: [Pub] },
  injections: [{ token: Inner }, { token: Pub }],
});
`;
    await withBuilt(source, undefined, {}, (built) => {
      expectTables(built.code, ['__neoRoots']);
      const publicResolve = memberText(built.code, 'public resolve(token: unknown): unknown {');
      expect(publicResolve).toContain('__neoRoots');
      expect(publicResolve).not.toContain('__neoDispatch');
      const box = built.box();
      expect(read(box.resolve(built.exports.Pub), 'inner')).toBeInstanceOf(built.exports.Inner as new () => object);
      const roots = tableOf(box, '__neoRoots');
      expect(roots).toBeInstanceOf(Map);
      if (!(roots instanceof Map)) throw new Error('roots table is not a Map');
      expect([...roots.keys()].map(nameOf)).toEqual(['Pub']);
      return undefined;
    });
  });

  it('P5b a retained internal token is never a public root', async () => {
    const source = `${HEAD}
export class Inner {}
export class Pub { constructor(readonly inner: Inner) {} }
export const box = defineBuilderConfig({
  name: 'Box',
  optimization: { mode: 'closed', roots: [Pub] },
  injections: [{ token: Inner }, { token: Pub }],
});
`;
    const seen = await observe(source, {}, (built) => {
      const box = built.box();
      return {
        root: codeOf(() => box.resolve(built.exports.Pub)),
        internal: codeOf(() => box.resolve(built.exports.Inner)),
        unknown: codeOf(() => box.resolve('nothing registered')),
      };
    }, ['__neoRoots']);
    const expected = { root: 'ok', internal: 'NEO_ROOT_NOT_EXPORTED', unknown: 'NEO_ROOT_NOT_EXPORTED' };
    expect(seen.byDefault).toEqual(expected);
    expect(seen.reference).toEqual(expected);
  });

  it('P6 a child resolves a parent token, a closed parent keeps its private token', async () => {
    const source = `${HEAD}
export class Shared { readonly kind = 'shared'; }
export class Own { readonly kind = 'own'; }
export class Hidden {}
export class Pub { constructor(readonly hidden: Hidden) {} }
export const parent = defineBuilderConfig({ name: 'Parent', injections: [{ token: Shared }] });
export const closedParent = defineBuilderConfig({
  name: 'ClosedParent',
  optimization: { mode: 'closed', roots: [Pub] },
  injections: [{ token: Hidden }, { token: Pub }],
});
export const box = defineBuilderConfig({ name: 'Child', useContainer: parent, injections: [{ token: Own }] });
export const closedChild = defineBuilderConfig({ name: 'ClosedChild', useContainer: closedParent, injections: [{ token: Own }] });
`;
    const seen = await observe(source, {}, (built) => {
      const parent = built.box('parent');
      const closedParent = built.box('closedParent');
      const child = built.box();
      const closedChild = built.box('closedChild');
      const shared = child.resolve(built.exports.Shared);
      return {
        own: read(child.resolve(built.exports.Own), 'kind'),
        shared: read(shared, 'kind'),
        sharedIsParents: shared === parent.resolve(built.exports.Shared),
        publicRoot: read(closedChild.resolve(built.exports.Pub), 'hidden') === undefined,
        privateToken: codeOf(() => closedChild.resolve(built.exports.Hidden)),
        parentPrivate: codeOf(() => closedParent.resolve(built.exports.Hidden)),
        missing: codeOf(() => child.resolve('nothing registered')),
      };
    });
    const expected = {
      own: 'own',
      shared: 'shared',
      sharedIsParents: true,
      publicRoot: false,
      privateToken: 'NEO_ROOT_NOT_EXPORTED',
      parentPrivate: 'NEO_ROOT_NOT_EXPORTED',
      missing: 'NeoServiceNotFoundError',
    };
    expect(seen.byDefault).toEqual(expected);
    expect(seen.reference).toEqual(expected);
  });

  it('P7 a transient is built on every resolve', async () => {
    const source = `${HEAD}
export class Fresh { static made = 0; constructor() { Fresh.made += 1; } }
export const box = defineBuilderConfig({ name: 'Box', injections: [{ token: Fresh, lifecycle: 'transient' }] });
`;
    const seen = await observe(source, {}, (built) => {
      const box = built.box();
      const first = box.resolve(built.exports.Fresh);
      const second = box.resolve(built.exports.Fresh);
      return { distinct: first !== second, made: read(built.exports.Fresh, 'made') };
    });
    expect(seen.byDefault).toEqual({ distinct: true, made: 2 });
    expect(seen.reference).toEqual({ distinct: true, made: 2 });
  });

  it('P8 an override wins, clearOverrides restores, dependents are invalidated', async () => {
    const source = `${HEAD}
export class Shared { readonly kind = 'real-shared'; }
export class Svc { readonly kind = 'real'; }
export class Dep { constructor(readonly svc: Svc) {} }
export const parent = defineBuilderConfig({ name: 'Parent', injections: [{ token: Shared }] });
export const box = defineBuilderConfig({
  name: 'Box',
  useContainer: parent,
  injections: [{ token: Svc }, { token: Dep }],
});
`;
    const seen = await observe(source, { testOverrides: true }, async (built) => {
      const box = built.box();
      const parent = built.box('parent');
      const kindOfDep = (): unknown => read(read(box.resolve(built.exports.Dep), 'svc'), 'kind');
      const before = { svc: read(box.resolve(built.exports.Svc), 'kind'), dep: kindOfDep() };
      await box.override(built.exports.Svc, () => ({ kind: 'mock' }));
      await box.override(built.exports.Shared, () => ({ kind: 'mock-shared' }));
      const during = {
        svc: read(box.resolve(built.exports.Svc), 'kind'),
        dep: kindOfDep(),
        shared: read(box.resolve(built.exports.Shared), 'kind'),
        parentShared: read(parent.resolve(built.exports.Shared), 'kind'),
      };
      await box.clearOverrides();
      const after = {
        svc: read(box.resolve(built.exports.Svc), 'kind'),
        dep: kindOfDep(),
        shared: read(box.resolve(built.exports.Shared), 'kind'),
      };
      return { before, during, after };
    });
    const expected = {
      before: { svc: 'real', dep: 'real' },
      during: { svc: 'mock', dep: 'mock', shared: 'mock-shared', parentShared: 'real-shared' },
      after: { svc: 'real', dep: 'real', shared: 'real-shared' },
    };
    expect(seen.byDefault).toEqual(expected);
    expect(seen.reference).toEqual(expected);
  });

  it('P9 resolve after destroy is refused', async () => {
    const source = `${HEAD}
export class Svc {}
export const box = defineBuilderConfig({ name: 'Box', injections: [{ token: Svc }] });
`;
    const seen = await observe(source, {}, async (built) => {
      const box = built.box();
      const scope = built.track(box.createScope());
      scope.resolve(built.exports.Svc);
      await scope.destroy();
      const scoped = codeOf(() => scope.resolve(built.exports.Svc));
      box.resolve(built.exports.Svc);
      await box.destroy();
      return { scoped, root: codeOf(() => box.resolve(built.exports.Svc)) };
    });
    expect(seen.byDefault).toEqual({ scoped: DESTROYED, root: DESTROYED });
    expect(seen.reference).toEqual({ scoped: DESTROYED, root: DESTROYED });
  });

  it('P10 a construction error registers no instance', async () => {
    const source = `${HEAD}
export const attempts: string[] = [];
export class Flaky {
  constructor() {
    attempts.push('built');
    if (attempts.length === 1) throw new Error('boom');
  }
}
export const box = defineBuilderConfig({ name: 'Box', injections: [{ token: Flaky }] });
`;
    const seen = await observe(source, {}, (built) => {
      const box = built.box();
      const first = codeOf(() => box.resolve(built.exports.Flaky));
      const second = box.resolve(built.exports.Flaky);
      return {
        first,
        secondIsFlaky: second instanceof (built.exports.Flaky as new () => object),
        cached: box.resolve(built.exports.Flaky) === second,
        attempts: read(built.exports.attempts, 'length'),
      };
    });
    const expected = { first: 'Error', secondIsFlaky: true, cached: true, attempts: 2 };
    expect(seen.byDefault).toEqual(expected);
    expect(seen.reference).toEqual(expected);
  });

  it('P11 slot 0, the middle and the last token of 5000 registrations resolve', () => {
    const count = 5000;
    const classes = Array.from({ length: count }, (_, index) => `export class K${index} { readonly slot = ${index}; }`);
    const injections = Array.from({ length: count }, (_, index) => `{ token: K${index} }`);
    const source = `${HEAD}
${classes.join('\n')}
export const box = defineBuilderConfig({ name: 'Wide', injections: [${injections.join(', ')}] });
`;
    return withBuilt(source, undefined, {}, (built) => {
      expectTables(built.code, DISPATCH);
      const box = built.box();
      const seen = [0, count / 2, count - 1].map((index) => {
        const token = built.exports[`K${index}`];
        const instance = box.resolve(token);
        return {
          slot: read(instance, 'slot'),
          ownClass: typeof token === 'function' && instance instanceof token,
          cached: box.resolve(token) === instance,
        };
      });
      expect(seen).toEqual([
        { slot: 0, ownClass: true, cached: true },
        { slot: 2500, ownClass: true, cached: true },
        { slot: 4999, ownClass: true, cached: true },
      ]);
    });
  }, 180_000);

  it('P12 the default emitter of a full open container reads the table', () => {
    warmLibCache();
    const source = `${HEAD}
export class Svc {}
export const box = defineBuilderConfig({ name: 'Box', injections: [{ token: Svc }] });
`;
    fileCounter += 1;
    const graphs = new Analyzer(programFor(new Map([[`/virtual/t01/default-${fileCounter}.ts`, source]]))).extractAll();
    const graph = named(graphs, 'box');
    const byDefault = new Generator(graph, false, undefined, true, false, undefined, undefined, undefined, { linearMax: 0 }).generate();
    expect(byDefault).toMatch(/private static __neoDispatch\b/);
    expect(byDefault).not.toContain('resolveLocal');
    const reference = new Generator(graph, false, undefined, true, false, 'reference').generate();
    expect(reference).toContain('resolveLocal');
    expect(reference).not.toMatch(/__neoDispatch\b/);
  });

  /** Four containers of 40 registrations and two multi tokens, written with the given threshold. The `if (token ===` rows of each, guards left out. */
  const rowsOf = (linearMax: number): string[][] => {
    warmLibCache();
    const size = 40;
    const classes = Array.from({ length: size }, (_, index) => `export class P${index} { readonly slot = ${index}; }`);
    const injections = Array.from({ length: size }, (_, index) => `{ token: P${index} }`);
    const multi = ['One', 'Two'].flatMap((name) => [0, 1, 2].map((index) =>
      `{ token: ${name.toLowerCase()}, multi: true, useFactory: true, dependencies: [], provider: () => ({ name: '${name}${index}' }) }`));
    const body = (options: string): string => `${HEAD}
interface One { name: string }
interface Two { name: string }
const one = useInterface<One>();
const two = useInterface<Two>();
${classes.join('\n')}
export const box = defineBuilderConfig({
  name: 'Box',
  ${options}
  injections: [${[...injections, ...multi].join(', ')}],
});
`;
    const variants = [
      body(''),
      body("runtime: { profile: 'minimal' },"),
      body("optimization: { mode: 'closed', roots: [P0, P1, { all: one }] },"),
      body("runtime: { profile: 'minimal' }, optimization: { mode: 'closed', roots: [P0, P1, { all: one }] },"),
    ];
    const guards = ['NEO_MULTI_REQUIRES_RESOLVE_ALL', 'NEO_OVERRIDE_MULTI_UNSUPPORTED'];
    return variants.map((variant) => {
      fileCounter += 1;
      const graphs = new Analyzer(programFor(new Map([[`/virtual/t01/linear-${fileCounter}.ts`, variant]]))).extractAll();
      const code = new Generator(named(graphs, 'box'), false, undefined, false, false, undefined, undefined, undefined, { linearMax }).generate();
      const comparisons = code.split('\n').filter((line) => line.includes('if (token ==='));
      return comparisons.filter((line) => !guards.some((guard) => line.includes(guard)));
    });
  };

  it('P14 no per-registration comparison is left in a dynamic resolve', () => {
    for (const rows of rowsOf(0)) expect(rows).toEqual([]);
  }, 120_000);

  it('P14 twin: with the table off, every registration keeps its own comparison', () => {
    // Open: 40 providers and 2 multi tokens. Closed: the 2 exported roots and the exported multi root.
    expect(rowsOf(Infinity).map((rows) => rows.length)).toEqual([42, 42, 3, 3]);
  }, 120_000);

  it('P15 emitDispatchField refuses an invalid identifier', () => {
    const entries = [{ keyExpression: 'Token', accessor: '_get_Token' }];
    expect(emitDispatchField('Container', '__neoDispatch', entries)).toContain('Container.prototype._get_Token');
    expect(() => emitDispatchField('Bad Name', '__neoDispatch', entries)).toThrow('invalid generated identifier');
    expect(() => emitDispatchField('Container', 'bad field', entries)).toThrow('invalid generated identifier');
    expect(() => emitDispatchField('Container', '__neoDispatch', [{ keyExpression: 'Token', accessor: 'x(); evil()' }]))
      .toThrow('invalid generated accessor');
    expect(() => emitDispatchField('Container', '__neoLists', [{ keyExpression: 'Token', accessor: '_list_Token()' }], 'list'))
      .toThrow('invalid generated accessor');
    expect(() => emitDispatchRead('Bad Name', '__neoDispatch')).toThrow('invalid generated identifier');
    expect(() => emitDispatchRead('Container', 'bad field')).toThrow('invalid generated identifier');
    expect(emitDispatchRead('Container', '__neoDispatch')).toContain('Container.__neoDispatch');
  });

  it('P18 property token through the table', async () => {
    const source = `${HEAD}
export class Api { constructor(readonly url: string) {} }
export class Plain {}
const apiUrl = useProperty<string>(Api, 'url');
const retries = useProperty<number>(Api, 'retries');
export const box = defineBuilderConfig({
  name: 'Box',
  injections: [
    { token: Plain },
    { token: apiUrl, useFactory: true, dependencies: [], provider: () => 'https://example.test' },
    { token: retries, useFactory: true, dependencies: [], provider: () => 0 },
  ],
});
`;
    const seen = await observe(source, {}, (built) => {
      const box = built.box();
      const url = box.resolve(built.id('PropertyToken:Api.url'));
      return {
        url,
        retries: box.resolve(built.id('PropertyToken:Api.retries')),
        cached: box.resolve(built.id('PropertyToken:Api.url')) === url,
        unknown: codeOf(() => box.resolve('PropertyToken:Api.nothing')),
      };
    });
    const expected = { url: 'https://example.test', retries: 0, cached: true, unknown: 'NeoServiceNotFoundError' };
    expect(seen.byDefault).toEqual(expected);
    expect(seen.reference).toEqual(expected);
  });

  it('P19 a multi root also read by a factory', async () => {
    const source = `${HEAD}
interface Item { n: number }
const item = useInterface<Item>();
export class Report { constructor(readonly total: number) {} }
export const box = defineBuilderConfig({
  name: 'Box',
  optimization: { mode: 'closed', roots: [Report, { all: item }] },
  injections: [
    { token: item, multi: true, useFactory: true, dependencies: [], provider: () => ({ n: 1 }) },
    { token: item, multi: true, useValue: { n: 3 } },
    {
      token: Report,
      useFactory: true,
      dependencies: [{ all: item }],
      provider: () => new Report(2),
    },
  ],
});
`;
    const seen = await observe(source, {}, (built) => {
      const box = built.box();
      const id = built.id('Item');
      const contributions = box.resolveAll(id).map((entry) => read(entry, 'n'));
      return { contributions, total: read(box.resolve(built.exports.Report), 'total') };
    }, ['__neoRoots', '__neoRootLists', '__neoLists']);
    // The factory declares `{ all: item }`, so `item` is an internal list as well as an exported root.
    const expected = { contributions: [1, 3], total: 2 };
    expect(seen.byDefault).toEqual(expected);
    expect(seen.reference).toEqual(expected);

    await withBuilt(source, undefined, {}, (built) => {
      const reader = `_list_${built.id('Item').replace(/[^A-Za-z0-9_$]/g, '_')}`;
      // One reader serves both tables: a second `_list_` member would be dead code.
      expect(built.code.match(/private _list_\w+\(/g)).toEqual([`private ${reader}(`]);
      for (const field of ['__neoRootLists', '__neoLists']) {
        expect(memberText(built.code, `private static ${field}Table(`), `${field} has the row`).toContain(`.prototype.${reader}`);
      }
    });
  });

  it('P20 a key undefined at the first read is read again', async () => {
    // The import cycle of CommonJS output: at the first dynamic read the namespace holds no `Late` yet.
    class LateClass { readonly n = 9; }
    const namespace: { Late: unknown } = { Late: undefined };
    const source = `${HEAD}
import { Late } from './late';
export const box = defineBuilderConfig({ name: 'Box', injections: [{ token: Late }] });
`;
    const modules = new Map([['late.ts', 'export class Late { n = 9; }\n']]);
    const require = (id: string): unknown => {
      if (id === './late') return namespace;
      throw new Error(`unexpected import ${id}`);
    };
    await withBuilt(source, undefined, { modules, require }, (built) => {
      expectTables(built.code, DISPATCH);
      const box = built.box();
      // Whatever this call does, it must not fix the table over a key that was not there yet.
      codeOf(() => box.resolve(undefined));
      namespace.Late = LateClass;
      const late = box.resolve(LateClass);
      expect(late).toBeInstanceOf(LateClass);
      expect(box.resolve(LateClass)).toBe(late);
      const table = tableOf(box, '__neoDispatch');
      expect(table).toBeInstanceOf(Map);
      expect(table instanceof Map && table.has(LateClass)).toBe(true);
      expect(table instanceof Map && table.has(undefined)).toBe(false);
      return undefined;
    });
  });

  it('P17 a class declared after the container still resolves', async () => {
    const source = `${HEAD}
interface Port { n: number }
const port = useInterface<Port>();
export const box = defineBuilderConfig({
  name: 'Box',
  injections: [{ token: Later }, { token: port, useValue: { n: 1 } }],
});
export class Later { readonly n = 2; }
`;
    let built: Built | undefined;
    let failure = '';
    try {
      built = build(source, undefined);
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    expect(failure).toBe('');
    if (!built) throw new Error('the module did not load');
    try {
      expectTables(built.code, DISPATCH);
      const box = built.box();
      const later = box.resolve(built.exports.Later);
      expect(later).toBeInstanceOf(built.exports.Later as new () => object);
      expect(box.resolve(built.exports.Later)).toBe(later);
    } finally {
      await built.close();
    }
  });
});
