import { beforeAll, describe, expect, it } from 'vitest';
import * as ts from 'typescript';
import { Analyzer } from '../../src/analyzer/Analyzer';
import type { DependencyGraph } from '../../src/analyzer/types';
import { Generator } from '../../src/generator/Generator';
import { DISPATCH_LINEAR_MAX, emitLinearRead } from '../../src/generator/dispatchEmitter';
import { createFastProgram, warmLibCache } from '../fastProgram';
import { named } from '../helpers/t00-contract';

/**
 * T01 threshold. A table of at most `linearMax` rows is the linear `if (token === key)` cases of the container
 * before the shared tables; a table of more rows is read from its static `Map`. Each table is counted on its own rows:
 * `__neoDispatch`, `__neoRoots`, `__neoLists` and `__neoRootLists`. Both sides answer the same, and the
 * guards before the read and the fallbacks after it are the same in both modes.
 */

const HEAD = `
import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';
declare function defineBuilderConfig<T>(config: T): T;
declare function useInterface<T>(): T;
`;

const IMPORT_FROM_NEOSYRINGE = /import\s*\{[^}]*\}\s*from\s*'@djodjonx\/neosyringe';\s*/g;
const DESTROYED = 'NEO_CONTAINER_DESTROYED';
/** A dispatch table: its static field or its method. The policy of a declared factory is a static member too (packages/core/src/generator/FactoryEmitter.ts:316), and is not one. */
const TABLE_FIELD = /private static __neo(Dispatch|Roots|Lists|RootLists)\b/;
const TABLE_METHOD = /__neo(Dispatch|Roots|Lists|RootLists)Table\(/;
const GUARDS = ['NEO_MULTI_REQUIRES_RESOLVE_ALL', 'NEO_OVERRIDE_MULTI_UNSUPPORTED'];

interface Variant {
  label: string;
  /** Absent: the default of the Generator. */
  linearMax?: number;
  emitter?: 'reference';
}

const VARIANTS: readonly Variant[] = [
  { label: 'linearMax 0', linearMax: 0 },
  { label: 'linearMax Infinity', linearMax: Infinity },
  { label: 'default' },
  { label: 'reference', emitter: 'reference' },
];

const ALWAYS_TABLE: Variant = { label: 'linearMax 0', linearMax: 0 };
const ALWAYS_LINEAR: Variant = { label: 'linearMax Infinity', linearMax: Infinity };

let fileCounter = 0;

function programFor(files: ReadonlyMap<string, string>): ts.Program {
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    noImplicitAny: false,
  };
  const host = ts.createCompilerHost(options);
  const readSource = host.getSourceFile.bind(host);
  const exists = host.fileExists.bind(host);
  host.getSourceFile = (name, languageVersion, onError, shouldCreateNewSourceFile) => {
    const text = files.get(name);
    if (text !== undefined) return ts.createSourceFile(name, text, languageVersion, true);
    return readSource(name, languageVersion, onError, shouldCreateNewSourceFile);
  };
  host.fileExists = (name) => files.has(name) || exists(name);
  const directories = new Set([...files.keys()].map((name) => name.slice(0, name.lastIndexOf('/'))));
  const directoryExists = host.directoryExists?.bind(host);
  host.directoryExists = (name) => directories.has(name) || (directoryExists?.(name) ?? false);
  const readText = host.readFile.bind(host);
  host.readFile = (name) => files.get(name) ?? readText(name);
  return createFastProgram([...files.keys()], options, host);
}

interface AnalyzeOptions {
  modules?: ReadonlyMap<string, string>;
}

function analyze(source: string, options: AnalyzeOptions = {}): { fileName: string; graphs: DependencyGraph[] } {
  warmLibCache();
  fileCounter += 1;
  const fileName = `/virtual/t01t/case-${fileCounter}.ts`;
  const files = new Map([[fileName, source]]);
  for (const [path, text] of options.modules ?? []) files.set(`/virtual/t01t/${path}`, text);
  const graphs = new Analyzer(programFor(files)).extractAll().filter((graph) => graph.sourceFileName === fileName);
  return { fileName, graphs };
}

interface RenderOptions {
  testOverrides?: boolean;
  modules?: ReadonlyMap<string, string>;
}

function generatorFor(graph: DependencyGraph, variant: Variant, inline: boolean, testOverrides: boolean): Generator {
  const dispatch = variant.linearMax === undefined ? undefined : { linearMax: variant.linearMax };
  return new Generator(graph, inline, undefined, false, testOverrides, variant.emitter, undefined, undefined, dispatch);
}

/** The output of the container `box`, written to a file of its own. */
function render(source: string, variant: Variant, options: RenderOptions = {}): string {
  const { graphs } = analyze(source, options);
  return generatorFor(named(graphs, 'box'), variant, false, options.testOverrides ?? false).generate();
}

/** The output of the container `box` with the default Generator, no option. */
function renderDefault(source: string): string {
  const { graphs } = analyze(source);
  return new Generator(named(graphs, 'box')).generate();
}

/** One member of the generated class: from its signature to the closing brace at member depth. */
function memberText(code: string, signature: string): string {
  const start = code.indexOf(signature);
  if (start < 0) throw new Error(`generated source has no ${signature}`);
  const end = code.indexOf('\n  }', start);
  return code.slice(start, end < 0 ? undefined : end + 4);
}

const RESOLVE_INTERNAL = 'private _resolveInternal(token: unknown): unknown {';
const RESOLVE_ALL_INTERNAL = 'private _resolveAllInternal(token: unknown): unknown[] {';
const PUBLIC_RESOLVE = 'public resolve(token: unknown): unknown {';
const PUBLIC_RESOLVE_ALL = 'public resolveAll(token: unknown): unknown[] {';

/** The `if (token === key)` lines of a member that are rows, not the guards of a multi token. */
function rowCases(member: string): string[] {
  return member
    .split('\n')
    .filter((line) => line.includes('if (token ==='))
    .filter((line) => !GUARDS.some((guard) => line.includes(guard)));
}

function hasTable(code: string, field: string): boolean {
  return new RegExp(`private static ${field}\\b`).test(code);
}

function listMethods(code: string): string[] {
  return code.match(/private _list_\w+\(/g) ?? [];
}

function classes(count: number): string {
  return Array.from({ length: count }, (_, index) => `export class K${index} { readonly slot = ${index}; }`).join('\n');
}

/** An open container of `count` single registrations. */
function openSource(count: number): string {
  const injections = Array.from({ length: count }, (_, index) => `{ token: K${index} }`).join(', ');
  return `${HEAD}
${classes(count)}
export const box = defineBuilderConfig({ name: 'Box', injections: [${injections}] });
`;
}

/** `count` multi tokens `m0..`, two contributions each, and the interface that types each. */
function multiTokens(count: number): { declarations: string; injections: string[] } {
  const declarations = Array.from({ length: count }, (_, index) =>
    `interface I${index} { name: string }\nconst m${index} = useInterface<I${index}>();`).join('\n');
  const injections = Array.from({ length: count }, (_, index) => [
    `{ token: m${index}, multi: true, useFactory: true, dependencies: [], provider: () => ({ name: 'm${index}a' }) }`,
    `{ token: m${index}, multi: true, useFactory: true, dependencies: [], provider: () => ({ name: 'm${index}b' }) }`,
  ]).flat();
  return { declarations, injections };
}

function openMultiSource(count: number): string {
  const multi = multiTokens(count);
  return `${HEAD}
${multi.declarations}
export const box = defineBuilderConfig({ name: 'Box', injections: [${multi.injections.join(', ')}] });
`;
}

/**
 * A closed container whose exported multi roots are `rootLists` tokens, and whose factory `Report` reads the
 * `readLists` tokens that come after them (an internal list). The two counts are chosen apart.
 */
function closedListsSource(rootLists: number, readLists: number): string {
  const multi = multiTokens(Math.max(rootLists, readLists) + (rootLists > readLists ? 1 : 0));
  const rootAll = Array.from({ length: rootLists }, (_, index) => `{ all: m${index} }`);
  const reads = rootLists > readLists
    ? [`{ all: m${rootLists} }`]
    : Array.from({ length: readLists }, (_, index) => `{ all: m${index} }`);
  return `${HEAD}
${multi.declarations}
export class Report { constructor(readonly total: number) {} }
export const box = defineBuilderConfig({
  name: 'Box',
  optimization: { mode: 'closed', roots: [Report, ${rootAll.join(', ')}] },
  injections: [
    ${multi.injections.join(',\n    ')},
    { token: Report, useFactory: true, dependencies: [${reads.join(', ')}], provider: () => new Report(2) },
  ],
});
`;
}

interface Box {
  resolve(token: unknown): unknown;
  resolveAll(token: unknown): unknown[];
  createScope(): Box;
  destroy(): Promise<void>;
  /** The full profile only. */
  override(token: unknown, factory: () => unknown): Promise<void>;
}

function isBox(value: unknown): value is Box {
  if (typeof value !== 'object' || value === null) return false;
  return ['resolve', 'resolveAll', 'createScope', 'destroy'].every((member) => typeof Reflect.get(value, member) === 'function');
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

/** What a call answers (shown by `show`), or the code it fails with. */
function outcome(run: () => unknown, show: (value: unknown) => unknown = (value) => value): unknown {
  try {
    return { ok: show(run()) };
  } catch (error) {
    return { failed: errorCode(error) };
  }
}

function tokenIdOf(graphs: readonly DependencyGraph[], name: string): string {
  for (const graph of graphs) {
    for (const key of [...graph.nodes.keys(), ...(graph.multiNodes?.keys() ?? [])]) {
      if (key.startsWith(`${name}_`)) return key;
    }
  }
  throw new Error(`missing token ${name}`);
}

function execute(code: string, require: (id: string) => unknown): Record<string, unknown> {
  const js = ts.transpileModule(code.replace(IMPORT_FROM_NEOSYRINGE, ''), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const record: { exports: Record<string, unknown> } = { exports: {} };
  // `useInterface` stays in the user's own file, where it only names a token.
  const run = new Function('module', 'exports', 'require', 'useInterface', js) as (
    module: typeof record,
    exports: typeof record.exports,
    require: (id: string) => unknown,
    useInterface: () => null,
  ) => void;
  run(record, record.exports, require, () => null);
  return record.exports;
}

interface BuildOptions extends RenderOptions {
  require?: (id: string) => unknown;
}

interface Built {
  code: string;
  exports: Readonly<Record<string, unknown>>;
  graphs: readonly DependencyGraph[];
  id(name: string): string;
  box(name?: string): Box;
  close(): Promise<void>;
}

/** The way the build plugin writes a container: the generated class takes the place of the `defineBuilderConfig` statement. */
function build(source: string, variant: Variant, options: BuildOptions = {}): Built {
  const { graphs } = analyze(source, options);
  const ordered = [...graphs].sort((left, right) => (right.variableStatementStart ?? 0) - (left.variableStatementStart ?? 0));
  let code = source;
  for (const graph of ordered) {
    const name = graph.exportedVariableName;
    const start = graph.variableStatementStart;
    const end = graph.defineBuilderConfigEnd;
    if (name === undefined || start === undefined || end === undefined) throw new Error('missing container position');
    named(graphs, name);
    const generator = generatorFor(graph, variant, true, options.testOverrides ?? false);
    code = `${code.slice(0, start)}${generator.generate()}\nexport const ${name} = ${generator.generateInstantiation()};${code.slice(end)}`;
  }
  const exports = execute(code, options.require ?? ((id) => {
    throw new Error(`unexpected import ${id}`);
  }));
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
    close: async () => {
      const failures: unknown[] = [];
      for (const value of Object.values(exports).filter(isBox).reverse()) {
        try {
          await value.destroy();
        } catch (error) {
          if (errorCode(error) !== DESTROYED) failures.push(error);
        }
      }
      if (failures.length > 0) throw failures[0];
    },
  };
}

async function withBuilt<T>(
  source: string,
  variant: Variant,
  options: BuildOptions,
  scenario: (built: Built) => Promise<T> | T,
): Promise<T> {
  const built = build(source, variant, options);
  try {
    return await scenario(built);
  } finally {
    await built.close();
  }
}

function classOf(box: object): object {
  const ctor: unknown = Reflect.get(Object.getPrototypeOf(box), 'constructor');
  if (typeof ctor !== 'function') throw new Error('container has no class');
  return ctor;
}

describe('T01 dispatch threshold', () => {
  beforeAll(() => {
    warmLibCache();
  });

  it('P21 a table of linearMax rows is linear, one more row is the table', () => {
    const linear = render(openSource(3), { label: 'T=3', linearMax: 3 });
    const linearCases = rowCases(memberText(linear, RESOLVE_INTERNAL));
    expect(linearCases).toHaveLength(3);
    for (const line of linearCases) expect(line).toMatch(/^\s*if \(token === [^\n]+\) return this\._get_\w+\(\);$/);
    expect(hasTable(linear, '__neoDispatch')).toBe(false);
    expect(linear).not.toContain('__neoDispatchTable');

    const table = render(openSource(4), { label: 'T=3', linearMax: 3 });
    expect(hasTable(table, '__neoDispatch')).toBe(true);
    expect(table).toContain('__neoDispatchTable()');
    expect(rowCases(memberText(table, RESOLVE_INTERNAL))).toEqual([]);
  });

  it('P22 the roots table and the dispatcher are counted on their own rows', () => {
    const roots = (count: number): string => {
      const inner = Array.from({ length: count }, (_, index) => `export class In${index} {}`).join('\n');
      const outer = Array.from({ length: count }, (_, index) => `export class Pub${index} { constructor(readonly inner: In${index}) {} }`).join('\n');
      const list = Array.from({ length: count }, (_, index) => `Pub${index}`).join(', ');
      const injections = Array.from({ length: count }, (_, index) => `{ token: In${index} }, { token: Pub${index} }`).join(', ');
      return `${HEAD}
${inner}
${outer}
export const box = defineBuilderConfig({ name: 'Box', optimization: { mode: 'closed', roots: [${list}] }, injections: [${injections}] });
`;
    };
    // Three roots over six retained providers: the roots table is counted on three rows, not on six.
    const three = render(roots(3), { label: 'T=3', linearMax: 3 });
    expect(hasTable(three, '__neoRoots')).toBe(false);
    expect(rowCases(memberText(three, PUBLIC_RESOLVE))).toHaveLength(3);
    const four = render(roots(4), { label: 'T=3', linearMax: 3 });
    expect(hasTable(four, '__neoRoots')).toBe(true);
    expect(rowCases(memberText(four, PUBLIC_RESOLVE))).toEqual([]);

    // An opaque factory makes the dispatcher list every retained provider: four rows, on its own count.
    // Closed mode refuses an opaque factory in source, so the factory of a strict graph is marked opaque, as
    // packages/core/tests/generator/t17-direct-profiles.test.ts:934 does.
    const opaque = `${HEAD}
export class D1 {}
export class D2 {}
export class A { constructor(readonly d1: D1, readonly d2: D2) {} }
interface Made { sum: number }
const made = useInterface<Made>();
export const box = defineBuilderConfig({
  name: 'Box',
  optimization: { mode: 'closed', roots: [A, made] },
  injections: [
    { token: D1 }, { token: D2 }, { token: A },
    { token: made, useFactory: true, dependencies: [], provider: () => ({ sum: 1 }) },
  ],
});
`;
    const opaqueOutput = (variant: Variant): string => {
      const { graphs } = analyze(opaque);
      const graph = named(graphs, 'box');
      for (const [id, node] of graph.nodes) if (id.startsWith('Made_')) node.service.opaque = true;
      return generatorFor(graph, variant, false, false).generate();
    };
    const table = opaqueOutput({ label: 'T=3', linearMax: 3 });
    expect(hasTable(table, '__neoDispatch')).toBe(true);
    expect(hasTable(table, '__neoRoots')).toBe(false);
    const inline = opaqueOutput({ label: 'T=4', linearMax: 4 });
    expect(hasTable(inline, '__neoDispatch')).toBe(false);
    expect(rowCases(memberText(inline, RESOLVE_INTERNAL))).toHaveLength(4);
  });

  it('P23 the list tables are counted apart, and only a table has list readers', () => {
    const three = render(openMultiSource(3), { label: 'T=3', linearMax: 3 });
    const inline = rowCases(memberText(three, RESOLVE_ALL_INTERNAL));
    expect(inline).toHaveLength(3);
    for (const line of inline) expect(line).toContain('this._direct_');
    expect(listMethods(three)).toEqual([]);
    expect(hasTable(three, '__neoLists')).toBe(false);

    const four = render(openMultiSource(4), { label: 'T=3', linearMax: 3 });
    expect(hasTable(four, '__neoLists')).toBe(true);
    expect(listMethods(four)).toHaveLength(4);
    expect(rowCases(memberText(four, RESOLVE_ALL_INTERNAL))).toEqual([]);

    // Four exported multi roots (a table) and one internal list (linear): the two tables are decided apart.
    const rootsTable = render(closedListsSource(4, 1), { label: 'T=3', linearMax: 3 });
    expect(hasTable(rootsTable, '__neoRootLists')).toBe(true);
    expect(hasTable(rootsTable, '__neoLists')).toBe(false);
    expect(rowCases(memberText(rootsTable, RESOLVE_ALL_INTERNAL))).toHaveLength(1);
    expect(rowCases(memberText(rootsTable, PUBLIC_RESOLVE_ALL))).toEqual([]);
    // The reader of the internal list is read inline: it has no member, the four roots have one each.
    expect(listMethods(rootsTable)).toHaveLength(4);

    // One exported multi root (linear) and four internal lists (a table).
    const internalTable = render(closedListsSource(1, 4), { label: 'T=3', linearMax: 3 });
    expect(hasTable(internalTable, '__neoLists')).toBe(true);
    expect(hasTable(internalTable, '__neoRootLists')).toBe(false);
    expect(rowCases(memberText(internalTable, PUBLIC_RESOLVE_ALL))).toHaveLength(1);
    expect(rowCases(memberText(internalTable, RESOLVE_ALL_INTERNAL))).toEqual([]);
    expect(listMethods(internalTable)).toHaveLength(4);
  });

  it('P24 linear, table, default and reference give the same answers', async () => {
    const container = (options: string): string => `${HEAD}
interface Plugin { name: string }
interface Inherited { name: string }
const plugin = useInterface<Plugin>();
const inherited = useInterface<Inherited>();
export class Shared { readonly kind = 'shared'; }
export class Dep { readonly kind = 'dep'; }
export class Svc { constructor(readonly dep: Dep) {} }
export const parent = defineBuilderConfig({
  name: 'Parent',
  injections: [
    { token: Shared },
    { token: inherited, multi: true, useFactory: true, dependencies: [], provider: () => ({ name: 'p1' }) },
    { token: inherited, multi: true, useFactory: true, dependencies: [], provider: () => ({ name: 'p2' }) },
  ],
});
export const box = defineBuilderConfig({
  name: 'Box',
  useContainer: parent,
  ${options}
  injections: [
    { token: Dep },
    { token: Svc },
    { token: plugin, multi: true, useFactory: true, dependencies: [], provider: () => ({ name: 'a' }) },
    { token: plugin, multi: true, useFactory: true, dependencies: [], provider: () => ({ name: 'b' }) },
  ],
});
`;
    const modes: ReadonlyArray<{ name: string; options: string }> = [
      { name: 'full open', options: '' },
      { name: 'minimal open', options: "runtime: { profile: 'minimal' }," },
      { name: 'full closed', options: "optimization: { mode: 'closed', roots: [Svc, { all: plugin }] }," },
      { name: 'minimal closed', options: "runtime: { profile: 'minimal' }, optimization: { mode: 'closed', roots: [Svc, { all: plugin }] }," },
    ];
    const names = (value: unknown): unknown => (Array.isArray(value) ? value.map((item) => read(item, 'name')) : value);
    const shapeOf = (code: string): string => {
      if (code.includes('resolveLocal')) return 'reference';
      return TABLE_FIELD.test(code) ? 'table' : 'linear';
    };
    for (const mode of modes) {
      const answers = new Map<string, unknown>();
      const shapes: Record<string, string> = {};
      for (const variant of VARIANTS) {
        answers.set(variant.label, await withBuilt(container(mode.options), variant, {}, async (built) => {
          shapes[variant.label] = shapeOf(built.code);
          const box = built.box();
          const svc = box.resolve(built.exports.Svc);
          const scope = box.createScope();
          let seen: Record<string, unknown>;
          try {
            seen = {
              cached: box.resolve(built.exports.Svc) === svc,
              dep: outcome(() => box.resolve(built.exports.Dep), (value) => read(value, 'kind')),
              shared: outcome(() => box.resolve(built.exports.Shared), (value) => read(value, 'kind')),
              multiRefused: outcome(() => box.resolve(built.id('Plugin'))),
              names: outcome(() => box.resolveAll(built.id('Plugin')), names),
              inherited: outcome(() => box.resolveAll(built.id('Inherited')), names),
              unknown: outcome(() => box.resolve('nothing registered')),
              unknownAll: outcome(() => box.resolveAll('nothing registered')),
              scopeOwn: read(scope.resolve(built.exports.Svc), 'dep') !== undefined,
            };
          } finally {
            await scope.destroy();
          }
          await box.destroy();
          return { ...seen, destroyed: outcome(() => box.resolve(built.exports.Svc)) };
        }));
      }
      // The answers are compared across modes that really differ: the table, the linear cases, the default of a small graph, the witness.
      expect(shapes, mode.name).toEqual({ 'linearMax 0': 'table', 'linearMax Infinity': 'linear', default: 'linear', reference: 'reference' });
      const reference = answers.get('reference');
      expect(reference, mode.name).toMatchObject({ cached: true, names: { ok: ['a', 'b'] } });
      for (const variant of VARIANTS) {
        expect(answers.get(variant.label), `${mode.name} ${variant.label}`).toEqual(reference);
      }
    }
  }, 120_000);

  it('P25 the guards come before the read and the fallbacks after it, in both modes', async () => {
    const source = `${HEAD}
interface Plugin { name: string }
const plugin = useInterface<Plugin>();
export class Shared { readonly kind = 'shared'; }
export class Svc { readonly kind = 'real'; }
export const parent = defineBuilderConfig({ name: 'Parent', injections: [{ token: Shared }] });
export const box = defineBuilderConfig({
  name: 'Box',
  useContainer: parent,
  injections: [
    { token: Svc },
    { token: plugin, multi: true, useFactory: true, dependencies: [], provider: () => ({ name: 'a' }) },
  ],
});
`;
    for (const variant of [ALWAYS_TABLE, ALWAYS_LINEAR]) {
      const code = render(source, variant, { testOverrides: true });
      const internal = memberText(code, RESOLVE_INTERNAL);
      const at = (needle: string | RegExp): number => {
        const found = typeof needle === 'string' ? internal.indexOf(needle) : internal.search(needle);
        expect(found, `${variant.label}: ${String(needle)}`).toBeGreaterThanOrEqual(0);
        return found;
      };
      const readAt = variant.linearMax === 0 ? /\.get\(token\)/ : /if \(token === [^\n]*\) return this\._get_\w+\(\);/;
      const order = [
        at('_touchClosed(false)'),
        at('this._assertParents()'),
        at('NEO_MULTI_REQUIRES_RESOLVE_ALL'),
        at('this.overrides.has(token)'),
        at(readAt),
        at('if (this.legacy)'),
        at('Service not found'),
      ];
      expect(order, variant.label).toEqual([...order].sort((left, right) => left - right));
    }

    for (const variant of [ALWAYS_TABLE, ALWAYS_LINEAR]) {
      const seen = await withBuilt(source, variant, { testOverrides: true }, async (built) => {
        const box = built.box();
        const real = read(box.resolve(built.exports.Svc), 'kind');
        await box.override(built.exports.Svc, () => ({ kind: 'mock' }));
        const overridden = read(box.resolve(built.exports.Svc), 'kind');
        const answers = {
          real,
          overridden,
          multiRefused: outcome(() => box.resolve(built.id('Plugin'))),
          parentToken: outcome(() => box.resolve(built.exports.Shared), (value) => read(value, 'kind')),
          notFound: outcome(() => box.resolve('nothing registered')),
        };
        await box.destroy();
        return { ...answers, destroyed: outcome(() => box.resolve(built.exports.Svc)) };
      });
      expect(seen, variant.label).toEqual({
        real: 'real',
        overridden: 'mock',
        multiRefused: { failed: 'NEO_MULTI_REQUIRES_RESOLVE_ALL' },
        parentToken: { ok: 'shared' },
        notFound: { failed: 'NeoServiceNotFoundError' },
        destroyed: { failed: 'NEO_CONTAINER_DESTROYED' },
      });
    }
  }, 120_000);

  it('P26 the linear container stores nothing and has no temporal dead zone', async () => {
    const lists = closedListsSource(2, 1);
    const outputs = { open: render(openSource(5), ALWAYS_LINEAR), multi: render(openMultiSource(3), ALWAYS_LINEAR), lists: render(lists, ALWAYS_LINEAR) };
    for (const [label, code] of Object.entries(outputs)) {
      expect(TABLE_FIELD.test(code), `${label}: a stored table`).toBe(false);
      expect(TABLE_METHOD.test(code), `${label}: a table method`).toBe(false);
    }

    // A class declared after the container is read when the token is asked, not when the class is defined.
    const later = `${HEAD}
export const box = defineBuilderConfig({ name: 'Box', injections: [{ token: Later }] });
export class Later { readonly n = 2; }
`;
    await withBuilt(later, ALWAYS_LINEAR, {}, (built) => {
      const value = built.box().resolve(built.exports.Later);
      expect(value).toBeInstanceOf(built.exports.Later as new () => object);
      expect(built.box().resolve(built.exports.Later)).toBe(value);
    });

    // The key reads `undefined` at the first call (import cycle of CommonJS output), then it is bound.
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
    await withBuilt(source, ALWAYS_LINEAR, { modules, require }, (built) => {
      const box = built.box();
      expect(outcome(() => box.resolve('nothing registered'))).toEqual({ failed: 'NeoServiceNotFoundError' });
      namespace.Late = LateClass;
      const late = box.resolve(LateClass);
      expect(late).toBeInstanceOf(LateClass);
      expect(box.resolve(LateClass)).toBe(late);
    });
  });

  it('P27 the default is DISPATCH_LINEAR_MAX rows', () => {
    expect(Number.isInteger(DISPATCH_LINEAR_MAX)).toBe(true);
    expect(DISPATCH_LINEAR_MAX).toBeGreaterThanOrEqual(1);
    const atMax = renderDefault(openSource(DISPATCH_LINEAR_MAX));
    expect(hasTable(atMax, '__neoDispatch')).toBe(false);
    expect(rowCases(memberText(atMax, RESOLVE_INTERNAL))).toHaveLength(DISPATCH_LINEAR_MAX);
    const over = renderDefault(openSource(DISPATCH_LINEAR_MAX + 1));
    expect(hasTable(over, '__neoDispatch')).toBe(true);
    expect(rowCases(memberText(over, RESOLVE_INTERNAL))).toEqual([]);
  }, 120_000);

  it('P31 the default threshold is the measured crossover, 128 rows', () => {
    // Measured by tests/bench/runtime-cost.mjs, `warm-resolve`, shape flat (docs/benchmarks/topic-01-09-14.md): the table is slower than the
    // linear cases up to 64 rows, level at 128, faster from 256. A table of 128 rows stays linear, 129 rows use the table (P27 pins that boundary).
    expect(DISPATCH_LINEAR_MAX).toBe(128);
  });

  it('P28 the table is read through the stored field, the method builds it once', async () => {
    const closedLists = render(closedListsSource(2, 1), ALWAYS_TABLE);
    const outputs = { open: render(openSource(3), ALWAYS_TABLE), multi: render(openMultiSource(2), ALWAYS_TABLE), lists: closedLists };
    for (const [label, code] of Object.entries(outputs)) {
      expect(/\((\w+)\.(__neo\w+) \?\? \1\.\2Table\(\)\)\.get\(token\)/.test(code), `${label}: the read of the stored field`).toBe(true);
      expect(/Table\(\)\.get\(/.test(code), `${label}: a read that builds the table every time`).toBe(false);
    }

    await withBuilt(openSource(3), ALWAYS_TABLE, {}, async (built) => {
      const box = built.box();
      const ctor = classOf(box);
      const original = Reflect.get(ctor, '__neoDispatchTable');
      if (typeof original !== 'function') throw new Error('container has no table method');
      let calls = 0;
      Reflect.set(ctor, '__neoDispatchTable', function (this: unknown): unknown {
        calls += 1;
        return Reflect.apply(original, this, []);
      });
      const scope = box.createScope();
      try {
        box.resolve(built.exports.K0);
        box.resolve(built.exports.K1);
        scope.resolve(built.exports.K2);
        box.resolve(built.exports.K0);
        expect(calls).toBe(1);
        const table = Reflect.get(ctor, '__neoDispatch');
        expect(table).toBeInstanceOf(Map);
        expect(Reflect.get(classOf(scope), '__neoDispatch')).toBe(table);
      } finally {
        await scope.destroy();
      }
    });

    // A key that reads `undefined` is not stored: the next read builds the table again.
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
    await withBuilt(source, ALWAYS_TABLE, { modules, require }, (built) => {
      const box = built.box();
      outcome(() => box.resolve('nothing registered'));
      expect(Reflect.get(classOf(box), '__neoDispatch')).toBeUndefined();
      namespace.Late = LateClass;
      expect(box.resolve(LateClass)).toBeInstanceOf(LateClass);
      const table = Reflect.get(classOf(box), '__neoDispatch');
      expect(table).toBeInstanceOf(Map);
      expect(table instanceof Map && table.has(undefined)).toBe(false);
    });
  });

  it('W1 emitLinearRead refuses an invalid accessor', () => {
    expect(() => emitLinearRead([{ keyExpression: 'Token', accessor: 'x(); evil()' }], 'single'))
      .toThrow('invalid generated accessor');
    expect(() => emitLinearRead([{ keyExpression: 'Token', accessor: '_list_Token()', inline: 'return [];' }], 'list'))
      .toThrow('invalid generated accessor');
  });

  it('W2 emitLinearRead refuses a list row without a body', () => {
    expect(() => emitLinearRead([{ keyExpression: 'Token', accessor: '_list_Token' }], 'list'))
      .toThrow('missing inline body');
  });
});
