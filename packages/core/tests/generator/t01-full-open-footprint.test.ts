import { afterEach, describe, expect, it } from 'vitest';
import * as ts from 'typescript';
import { Analyzer } from '../../src/analyzer/Analyzer';
import type { DependencyGraph } from '../../src/analyzer/types';
import { Generator } from '../../src/generator/Generator';
import { named, programOf } from '../helpers/t00-contract';
import { warmLibCache } from '../fastProgram';

/**
 * T01 footprint of the full profile in open mode. One class provider is one `_get_` accessor: it reads, builds
 * and fires the resolve event, with no `create_` and no `_direct_` beside it. A box that has no listener and no
 * test overrides holds no table of its own for them. The same registrations in closed mode and in the minimal
 * profile keep their creators and their `_direct_` accessors.
 */

type Profile = 'full' | 'minimal';
type Mode = 'open' | 'closed';
type ResolveListener = (token: unknown, instance: unknown) => void;

interface Box {
  initialize: () => Promise<void>;
  resolve: (token: unknown) => unknown;
  destroy: () => Promise<void>;
  on: (event: 'resolve', listener: ResolveListener) => () => void;
  override: (token: unknown, factory: () => unknown) => Promise<void>;
  clearOverrides: () => Promise<void>;
}

interface Chain {
  readonly T01Leaf: new () => { n: number };
  readonly T01Mid: new (leaf: unknown) => { leaf: unknown };
  readonly T01Top: new (mid: unknown) => { mid: unknown };
  readonly built: { top: number };
}

interface Emitted {
  readonly code: string;
  readonly graph: DependencyGraph;
  readonly instantiation: string;
}

interface Options {
  readonly profile: Profile;
  readonly mode: Mode;
  readonly testOverrides: boolean;
}

const STUB = `
  import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';
  declare function defineBuilderConfig<T>(config: T): T;
  declare function useInterface<T>(): T;
`;

const CHAIN_CLASSES = `
  export class T01Leaf { n = 1; }
  export class T01Mid { leaf: T01Leaf; constructor(leaf: T01Leaf) { this.leaf = leaf; } }
  export class T01Top { mid: T01Mid; constructor(mid: T01Mid) { this.mid = mid; } }
`;

const CHAIN_INJECTIONS = '{ token: T01Leaf }, { token: T01Mid }, { token: T01Top },';

let fileSeq = 0;

function chainModules(): Chain {
  const built = { top: 0 };
  class T01Leaf {
    n = 1;
  }
  class T01Mid {
    leaf: unknown;
    constructor(leaf: unknown) {
      this.leaf = leaf;
    }
  }
  class T01Top {
    mid: unknown;
    constructor(mid: unknown) {
      this.mid = mid;
      built.top += 1;
    }
  }
  return { T01Leaf, T01Mid, T01Top, built };
}

function configSource(options: Options, classes: string, injections: string, optimization = ''): string {
  const mode = options.mode === 'closed' ? '' : "optimization: { mode: 'open' },";
  return `${STUB}
    ${classes}
    export const box = defineBuilderConfig({
      name: 'T01Footprint',
      runtime: { profile: '${options.profile}' },
      ${optimization === '' ? mode : optimization}
      injections: [${injections}],
    });
  `;
}

function emit(source: string, options: Options): Emitted {
  warmLibCache();
  fileSeq += 1;
  const graphs = new Analyzer(programOf(`/virtual/t01-footprint/${fileSeq}.ts`, source)).extractAll();
  const graph = named(graphs, 'box');
  const generator = new Generator(graph, false, undefined, false, options.testOverrides);
  return { code: generator.generate(), graph, instantiation: generator.generateInstantiation() };
}

/** Every call of `make` is a new container of the same generated class. */
function load(emitted: Emitted, modules: object): () => Box {
  const js = ts.transpileModule(`${emitted.code}\nexport const __t01Make = () => ${emitted.instantiation};\n`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: false },
  }).outputText;
  const record: { exports: Record<string, (() => Box) | undefined> } = { exports: {} };
  const run = new Function('module', 'exports', 'require', js) as (
    module: typeof record,
    exports: typeof record.exports,
    require: (id: string) => object,
  ) => void;
  run(record, record.exports, () => modules);
  const make = record.exports.__t01Make;
  if (!make) throw new Error('generated module did not export the factory of the container');
  return make;
}

function methods(code: string, prefix: string): string[] {
  return [...code.matchAll(new RegExp(`private ${prefix}\\w*\\(`, 'g'))].map((match) => match[0]);
}

function tokenOf(graph: DependencyGraph, name: string): string {
  const found = [...graph.nodes.keys()].find((id) => id.includes(name));
  if (found === undefined) throw new Error(`missing token ${name}`);
  return found;
}

function nameOf(token: unknown): string {
  return typeof token === 'function' ? token.name : String(token);
}

function codeOf(error: unknown): string {
  if (typeof error !== 'object' || error === null) return '';
  const code: unknown = Reflect.get(error, 'code');
  return typeof code === 'string' ? code : '';
}

const opened: Box[] = [];

function open(make: () => Box): Box {
  const box = make();
  opened.push(box);
  return box;
}

afterEach(async () => {
  const errors: unknown[] = [];
  for (const box of opened.splice(0).reverse()) {
    try {
      await box.destroy();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) throw errors[0];
});

describe('t01 full profile, open mode: one accessor per class provider', () => {
  it('P1a a chain of three classes has three _get_ accessors, no creator, no _direct_', async () => {
    const emitted = emit(configSource({ profile: 'full', mode: 'open', testOverrides: false }, CHAIN_CLASSES, CHAIN_INJECTIONS), {
      profile: 'full', mode: 'open', testOverrides: false,
    });
    expect(methods(emitted.code, '_get_').length).toBe(3);
    expect(methods(emitted.code, 'create_')).toEqual([]);
    expect(methods(emitted.code, '_direct_')).toEqual([]);

    const modules = chainModules();
    const box = open(load(emitted, modules));
    const events: string[] = [];
    box.on('resolve', (token) => events.push(nameOf(token)));
    const top = box.resolve(modules.T01Top);
    expect(top).toBeInstanceOf(modules.T01Top);
    let hops = 0;
    let cursor: unknown = top;
    for (let step = 0; step < 2; step += 1) {
      if (cursor instanceof modules.T01Top) cursor = cursor.mid;
      else if (cursor instanceof modules.T01Mid) cursor = cursor.leaf;
      else break;
      hops += 1;
    }
    expect(hops).toBe(2);
    expect(cursor).toBeInstanceOf(modules.T01Leaf);
    expect(box.resolve(modules.T01Leaf)).toBe(cursor);
    // The dependencies are read first, each through its own accessor, so each one fires its event.
    expect(events).toEqual(['T01Leaf', 'T01Mid', 'T01Top', 'T01Leaf']);
    box.resolve(modules.T01Top);
    expect(events.slice(4)).toEqual(['T01Top']);
  });

  it('P5 a chain of six classes emits exactly six _get_ and no other per-service method', () => {
    const count = 6;
    const classes = Array.from({ length: count }, (_, index) => {
      const next = index + 1 < count ? `d: T01C${index + 1}` : '';
      return `export class T01C${index} { constructor(${next}) {} }`;
    }).join('\n');
    const injections = Array.from({ length: count }, (_, index) => `{ token: T01C${index} },`).join(' ');
    const emitted = emit(configSource({ profile: 'full', mode: 'open', testOverrides: false }, classes, injections), {
      profile: 'full', mode: 'open', testOverrides: false,
    });
    const perService = emitted.code.match(/private (?:create_|_direct_|_get_)\w*\(/g) ?? [];
    expect(perService.length).toBe(count);
    expect(perService.every((name) => name.startsWith('private _get_'))).toBe(true);
  });

  it('P1b without test overrides a box holds no table of its own for overrides and listeners', () => {
    const options: Options = { profile: 'full', mode: 'open', testOverrides: false };
    const { code } = emit(configSource(options, CHAIN_CLASSES, CHAIN_INJECTIONS), options);
    expect(code).not.toMatch(/private overrides\b[^;\n]*new Map/);
    expect(code).not.toMatch(/private resolveListeners\b[^;\n]*new Set/);
    expect(code).toMatch(/private overrides\b[^;\n]*__neoNoOverrides/);
    expect(code).toMatch(/private resolveListeners\b[^;\n]*__neoNoListeners/);
  });

  it('P1b with test overrides a box keeps its own override table', () => {
    const options: Options = { profile: 'full', mode: 'open', testOverrides: true };
    const { code } = emit(configSource(options, CHAIN_CLASSES, CHAIN_INJECTIONS), options);
    expect(code).toMatch(/private overrides\b[^;\n]*new Map/);
    expect(code).not.toMatch(/__neoNoOverrides/);
  });
});

describe('t01 containers of one module do not share listeners or overrides', () => {
  it('P1c listeners are per container and an unsubscribed listener is not called', () => {
    const options: Options = { profile: 'full', mode: 'open', testOverrides: false };
    const emitted = emit(configSource(options, CHAIN_CLASSES, CHAIN_INJECTIONS), options);
    const modules = chainModules();
    const make = load(emitted, modules);
    const first = open(make);
    const second = open(make);
    const onFirst: string[] = [];
    const onSecond: string[] = [];
    const unsubscribe = first.on('resolve', (token) => onFirst.push(nameOf(token)));
    second.resolve(modules.T01Leaf);
    expect(onFirst).toEqual([]);
    first.resolve(modules.T01Leaf);
    expect(onFirst).toEqual(['T01Leaf']);
    second.on('resolve', (token) => onSecond.push(nameOf(token)));
    first.resolve(modules.T01Mid);
    expect(onFirst).toEqual(['T01Leaf', 'T01Leaf', 'T01Mid']);
    expect(onSecond).toEqual([]);
    unsubscribe();
    first.resolve(modules.T01Top);
    expect(onFirst).toEqual(['T01Leaf', 'T01Leaf', 'T01Mid']);
    second.resolve(modules.T01Leaf);
    expect(onSecond).toEqual(['T01Leaf']);
    // A third container of the class has no listener, whatever the others subscribed.
    const third = open(make);
    third.resolve(modules.T01Leaf);
    expect(onFirst.length).toBe(3);
    expect(onSecond.length).toBe(1);
  });

  it('P1c test overrides disabled: override() refuses with NEO_TEST_API_DISABLED and resolution is real', async () => {
    const options: Options = { profile: 'full', mode: 'open', testOverrides: false };
    const modules = chainModules();
    const box = open(load(emit(configSource(options, CHAIN_CLASSES, CHAIN_INJECTIONS), options), modules));
    const refused = await box.override(modules.T01Leaf, () => ({ n: 9 })).then(() => 'resolved', (error: unknown) => codeOf(error));
    expect(refused).toBe('NEO_TEST_API_DISABLED');
    const cleared = await box.clearOverrides().then(() => 'resolved', (error: unknown) => codeOf(error));
    expect(cleared).toBe('NEO_TEST_API_DISABLED');
    expect(box.resolve(modules.T01Leaf)).toBeInstanceOf(modules.T01Leaf);
  });

  it('P1c test overrides enabled: an override on one container leaves the other one real', async () => {
    const options: Options = { profile: 'full', mode: 'open', testOverrides: true };
    const modules = chainModules();
    const make = load(emit(configSource(options, CHAIN_CLASSES, CHAIN_INJECTIONS), options), modules);
    const first = open(make);
    const second = open(make);
    const fake = { n: 9 };
    await first.override(modules.T01Leaf, () => fake);
    expect(first.resolve(modules.T01Leaf)).toBe(fake);
    const top = second.resolve(modules.T01Top);
    expect(top).toBeInstanceOf(modules.T01Top);
    expect(second.resolve(modules.T01Leaf)).toBeInstanceOf(modules.T01Leaf);
    // An internal read of the overridden container sees the double too.
    const inner = first.resolve(modules.T01Mid);
    expect(inner).toBeInstanceOf(modules.T01Mid);
    expect(inner instanceof modules.T01Mid ? inner.leaf : undefined).toBe(fake);
    await first.clearOverrides();
    expect(first.resolve(modules.T01Leaf)).toBeInstanceOf(modules.T01Leaf);
  });

  it('P7 an internal read of an overridden dependency fires the resolve event with the double', async () => {
    const options: Options = { profile: 'full', mode: 'open', testOverrides: true };
    const modules = chainModules();
    const box = open(load(emit(configSource(options, CHAIN_CLASSES, CHAIN_INJECTIONS), options), modules));
    const fake = { n: 9 };
    await box.override(modules.T01Leaf, () => fake);
    const events: Array<[unknown, unknown]> = [];
    box.on('resolve', (token, instance) => events.push([token, instance]));
    const mid = box.resolve(modules.T01Mid);
    expect(mid).toBeInstanceOf(modules.T01Mid);
    // The dependency is read first, through its own accessor: the double is the instance of its event.
    expect(events).toEqual([
      [modules.T01Leaf, fake],
      [modules.T01Mid, mid],
    ]);
  });
});

describe('t01 both sides of the condition that inlines a creator', () => {
  it('P2 full closed keeps create_ and _direct_ for every class, and its eager root is built once', async () => {
    const options: Options = { profile: 'full', mode: 'closed', testOverrides: false };
    const source = configSource(options, CHAIN_CLASSES, CHAIN_INJECTIONS, "optimization: { mode: 'closed', roots: [T01Top], eager: [T01Top] },");
    const emitted = emit(source, options);
    expect(methods(emitted.code, 'create_').length).toBe(3);
    expect(methods(emitted.code, '_direct_').length).toBe(3);
    expect(methods(emitted.code, '_get_').length).toBe(3);
    // The shared empty tables belong to open mode: a closed box keeps the tables of its own.
    expect(emitted.code).not.toContain('__neoNo');
    expect(emitted.code).toMatch(/private overrides\b[^;\n]*new Map/);
    expect(emitted.code).toMatch(/private resolveListeners\b[^;\n]*new Set/);
    const modules = chainModules();
    const box = open(load(emitted, modules));
    await box.initialize();
    expect(modules.built.top).toBe(1);
    const top = box.resolve(modules.T01Top);
    expect(top).toBeInstanceOf(modules.T01Top);
    expect(modules.built.top).toBe(1);
    expect(box.resolve(modules.T01Top)).toBe(top);
  });

  it('P2 minimal open keeps create_ and _direct_, and has no _get_', () => {
    const options: Options = { profile: 'minimal', mode: 'open', testOverrides: false };
    const emitted = emit(configSource(options, CHAIN_CLASSES, CHAIN_INJECTIONS), options);
    expect(methods(emitted.code, 'create_').length).toBe(3);
    expect(methods(emitted.code, '_direct_').length).toBe(3);
    expect(methods(emitted.code, '_get_')).toEqual([]);
    const modules = chainModules();
    const box = open(load(emitted, modules));
    const top = box.resolve(modules.T01Top);
    expect(top).toBeInstanceOf(modules.T01Top);
    expect(box.resolve(modules.T01Top)).toBe(top);
  });

  it('P2 minimal closed keeps create_ and _direct_, and has no _get_', () => {
    const options: Options = { profile: 'minimal', mode: 'closed', testOverrides: false };
    const source = configSource(options, CHAIN_CLASSES, CHAIN_INJECTIONS, "optimization: { mode: 'closed', roots: [T01Top] },");
    const emitted = emit(source, options);
    expect(methods(emitted.code, 'create_').length).toBe(3);
    expect(methods(emitted.code, '_direct_').length).toBe(3);
    expect(methods(emitted.code, '_get_')).toEqual([]);
  });

  it('P2 full open keeps the creator of a factory provider, an async one and a value', async () => {
    const options: Options = { profile: 'full', mode: 'open', testOverrides: false };
    const classes = `
      export class T01Leaf { n = 1; }
      interface T01Made { n: number }
      interface T01Late { n: number }
      interface T01Stamp { n: number }
      const made = useInterface<T01Made>();
      const late = useInterface<T01Late>();
      const stamp = useInterface<T01Stamp>();
    `;
    const injections = `
      { token: T01Leaf },
      { token: made, useFactory: true, dependencies: [], provider: () => ({ n: 2 }) },
      { token: late, useFactory: true, dependencies: [], provider: async () => ({ n: 7 }) },
      { token: stamp, useValue: { n: 3 } },
    `;
    const emitted = emit(configSource(options, classes, injections), options);
    expect(methods(emitted.code, 'create_').length).toBe(3);
    expect(methods(emitted.code, 'create_').some((name) => name.includes('T01Made'))).toBe(true);
    expect(methods(emitted.code, 'create_').some((name) => name.includes('T01Stamp'))).toBe(true);
    expect(methods(emitted.code, 'create_').some((name) => name.includes('T01Late'))).toBe(true);
    expect(methods(emitted.code, 'create_').some((name) => name.includes('T01Leaf'))).toBe(false);
    expect(methods(emitted.code, '_get_').length).toBe(4);
    const modules = chainModules();
    const box = open(load(emitted, modules));
    await box.initialize();
    expect(box.resolve(tokenOf(emitted.graph, 'T01Made'))).toEqual({ n: 2 });
    expect(box.resolve(tokenOf(emitted.graph, 'T01Late'))).toEqual({ n: 7 });
    expect(box.resolve(tokenOf(emitted.graph, 'T01Stamp'))).toEqual({ n: 3 });
    expect(box.resolve(modules.T01Leaf)).toBeInstanceOf(modules.T01Leaf);
  });

  it('P8 an async singleton read before initialize() is refused by the public guard, then resolves', async () => {
    const options: Options = { profile: 'full', mode: 'open', testOverrides: false };
    const classes = `
      interface T01Late { n: number }
      const late = useInterface<T01Late>();
    `;
    const injections = `{ token: late, useFactory: true, dependencies: [], provider: async () => ({ n: 7 }) },`;
    const emitted = emit(configSource(options, classes, injections), options);
    const token = tokenOf(emitted.graph, 'T01Late');
    const box = open(load(emitted, chainModules()));
    // The guard of the public `resolve` answers first: the `not prepared` throw of `_get_` is behind it (see the report).
    let refused = '';
    try {
      box.resolve(token);
    } catch (error) {
      refused = codeOf(error);
    }
    expect(refused).toBe('NEO_NOT_INITIALIZED');
    await box.initialize();
    expect(box.resolve(token)).toEqual({ n: 7 });
  });
});
