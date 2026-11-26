import * as ts from 'typescript';
import { expect } from 'vitest';
import { Analyzer } from '../../src/analyzer/Analyzer';
import type { DependencyGraph } from '../../src/analyzer/types';
import { Generator } from '../../src/generator/Generator';
import { cacheLibHost, createFastProgram, warmLibCache } from '../fastProgram';
import { named } from './t00-contract';

/**
 * E17 (topic 17, `resolveMany`) build helper. It writes the generated container in place of the
 * `defineBuilderConfig` statement the way the plugin does, runs the module, and hands back the containers as
 * plain objects: every call goes through `Reflect` on `unknown`, so no test types the method it checks.
 */

export type Emitter = 'reference' | 'optimized';
export const EMITTERS: readonly Emitter[] = ['reference', 'optimized'];

const IMPORT_FROM_NEOSYRINGE = /import\s*\{[^}]*\}\s*from\s*'@djodjonx\/neosyringe';\s*/g;

/** Declarations the test sources start with: the public functions as ambient stubs, and the shared probe. */
export const HEAD = `
import { defineBuilderConfig, useInterface, useProperty } from '@djodjonx/neosyringe';
declare function defineBuilderConfig<T>(config: T): T;
declare function useInterface<T>(): T;
declare function useProperty<T>(target: unknown, name: string): T;
interface Probe { log: string[]; saved: unknown[]; counts: Record<string, number>; fail?: Error }
declare const probe: Probe;
`;

export interface Probe {
  /** Names the factories of a test append, in call order. */
  log: string[];
  /** The contexts the factories received, in call order. */
  saved: unknown[];
  counts: Record<string, number>;
  /** A factory named `Boom` throws it. */
  fail?: Error;
}

export interface BuildOptions {
  emitter?: Emitter;
  /** Inline output (the plugin's mode, suffixed names) or a file of its own. Default: inline. */
  inline?: boolean;
  validation?: 'compatible';
  testOverrides?: boolean;
  /** Modules the container file imports: path from the container file, then the module record `require` answers. */
  modules?: ReadonlyMap<string, string>;
  require?: (id: string) => unknown;
  /**
   * Lib files of the analysed program (`lib.es2022.d.ts`). Absent: the fast program, whose lib is es5 and which has
   * no global `Symbol`. A list builds a real program with the lib parsed once and cached.
   */
  lib?: readonly string[];
  /**
   * What the module reads as `Symbol`: the module runs as the body of a function whose parameter `Symbol` is this
   * object, so a test hides the well-known symbols without touching the realm (they are not configurable on the global).
   */
  runtimeSymbol?: object;
}

export interface Built {
  /** The whole transformed module. */
  code: string;
  /** What the generator wrote for each container, in file order. */
  generated: readonly string[];
  exports: Readonly<Record<string, unknown>>;
  probe: Probe;
  graphs: readonly DependencyGraph[];
  /** The runtime key of the token whose id starts with `name_` (an interface token) or contains `name`. */
  id(name: string): string;
  box(name?: string): object;
  close(): Promise<void>;
}

let fileCounter = 0;

function read(value: unknown, key: string): unknown {
  const readable = (typeof value === 'object' && value !== null) || typeof value === 'function';
  return readable ? Reflect.get(value, key) : undefined;
}

function isBox(value: unknown): value is object {
  if (typeof value !== 'object' || value === null) return false;
  return ['resolve', 'resolveAll', 'createScope', 'initialize', 'destroy']
    .every((member) => typeof Reflect.get(value, member) === 'function');
}

export function programFor(files: ReadonlyMap<string, string>, lib?: readonly string[]): ts.Program {
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
  if (lib !== undefined) return ts.createProgram([...files.keys()], { ...options, lib: [...lib], types: [], skipLibCheck: true }, cacheLibHost(host));
  return createFastProgram([...files.keys()], options, host);
}

function tokenKey(graphs: readonly DependencyGraph[], name: string): string {
  for (const graph of graphs) {
    for (const key of [...graph.nodes.keys(), ...(graph.multiNodes?.keys() ?? [])]) {
      if (key.startsWith(`${name}_`)) return key;
    }
  }
  for (const graph of graphs) {
    for (const key of [...graph.nodes.keys(), ...(graph.multiNodes?.keys() ?? [])]) {
      if (key.includes(name)) return key;
    }
  }
  throw new Error(`missing token ${name}`);
}

/** Builds `source`, writes the generated containers into it, and runs the module. */
export function build(source: string, options: BuildOptions = {}): Built {
  warmLibCache();
  fileCounter += 1;
  const directory = `/virtual/e17/case-${fileCounter}`;
  const fileName = `${directory}/inline.ts`;
  const files = new Map<string, string>([[fileName, source]]);
  for (const [path, text] of options.modules ?? []) files.set(`${directory}/${path}`, text);
  const program = programFor(files, options.lib);
  const analyzer = options.validation ? new Analyzer(program, { validation: options.validation }) : new Analyzer(program);
  const graphs = analyzer.extractAll().filter((graph) => graph.sourceFileName === fileName);
  const ordered = [...graphs].sort((left, right) => (right.variableStatementStart ?? 0) - (left.variableStatementStart ?? 0));
  let code = source;
  const generated: string[] = [];
  for (const graph of ordered) {
    const name = graph.exportedVariableName;
    const start = graph.variableStatementStart;
    const end = graph.defineBuilderConfigEnd;
    if (name === undefined || start === undefined || end === undefined) throw new Error('missing container position');
    named(graphs, name);
    const generator = new Generator(graph, options.inline !== false, undefined, false, options.testOverrides === true, options.emitter);
    const text = generator.generate();
    generated.push(text);
    code = `${code.slice(0, start)}${text}\nexport const ${name} = ${generator.generateInstantiation()};${code.slice(end)}`;
  }
  const js = ts.transpileModule(code.replace(IMPORT_FROM_NEOSYRINGE, ''), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const record: { exports: Record<string, unknown> } = { exports: {} };
  const probe: Probe = { log: [], saved: [], counts: {} };
  const run = new Function('module', 'exports', 'require', 'useInterface', 'useProperty', 'probe', 'Symbol', js) as (
    module: typeof record,
    exports: typeof record.exports,
    require: (id: string) => unknown,
    useInterface: () => null,
    useProperty: () => null,
    probe: Probe,
    symbol: object,
  ) => void;
  run(record, record.exports, options.require ?? ((id) => {
    throw new Error(`unexpected import ${id}`);
  }), () => null, () => null, probe, options.runtimeSymbol ?? Symbol);
  const exports = record.exports;
  return {
    code,
    generated,
    exports,
    probe,
    graphs,
    id: (name) => tokenKey(graphs, name),
    box: (name = 'box') => {
      const value = exports[name];
      if (!isBox(value)) throw new Error(`export ${name} is not a container`);
      return value;
    },
    close: async () => {
      const failures: unknown[] = [];
      for (const box of Object.values(exports).filter(isBox).reverse()) {
        try {
          await Reflect.apply(Reflect.get(box, 'destroy'), box, []);
        } catch (error) {
          if (read(error, 'code') !== 'NEO_CONTAINER_DESTROYED') failures.push(error);
        }
      }
      if (failures.length > 0) throw failures[0];
    },
  };
}

/** Builds `source`, runs `scenario`, and always releases the containers. */
export async function withBuilt<T>(source: string, options: BuildOptions, scenario: (built: Built) => Promise<T> | T): Promise<T> {
  const built = build(source, options);
  try {
    return await scenario(built);
  } finally {
    await built.close();
  }
}

/** Every test of the topic starts here: the method is a function on the container, whatever it then does. */
export function capability(box: unknown): void {
  expect(typeof read(box, 'resolveMany'), 'resolveMany exposed').toBe('function');
}

/** `box.resolveMany(tokens)`, called through `Reflect` on `unknown`. */
export function many(box: unknown, tokens: unknown): unknown {
  capability(box);
  const member: unknown = read(box, 'resolveMany');
  if (typeof member !== 'function') throw new Error('resolveMany is not a function');
  return Reflect.apply(member, box, [tokens]);
}

/** `box.resolve(token)`, called through `Reflect` on `unknown`. */
export function one(box: object, token: unknown): unknown {
  const member: unknown = Reflect.get(box, 'resolve');
  if (typeof member !== 'function') throw new Error('resolve is not a function');
  return Reflect.apply(member, box, [token]);
}

export function method(box: object, name: string, args: readonly unknown[] = []): unknown {
  const member: unknown = Reflect.get(box, name);
  if (typeof member !== 'function') throw new Error(`${name} is not a function`);
  return Reflect.apply(member, box, args);
}

export interface Failure {
  code: string;
  message: string;
}

function failureFrom(error: unknown): Failure {
  const code = read(error, 'code');
  const message = read(error, 'message');
  return { code: typeof code === 'string' ? code : 'no-code', message: typeof message === 'string' ? message : String(error) };
}

/** What a call throws, or `undefined` when it answers. */
export function failureOf(run: () => unknown): Failure | undefined {
  try {
    run();
  } catch (error) {
    return failureFrom(error);
  }
  return undefined;
}

/** The error code of a throw, `''` when the call answers. */
export function codeOf(run: () => unknown): string {
  return failureOf(run)?.code ?? '';
}

export async function rejectionOf(work: Promise<unknown>): Promise<Failure | undefined> {
  try {
    await work;
  } catch (error) {
    return failureFrom(error);
  }
  return undefined;
}

/** The thrown value itself, for identity checks. */
export function thrownBy(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

export function readKey(value: unknown, key: string): unknown {
  return read(value, key);
}
