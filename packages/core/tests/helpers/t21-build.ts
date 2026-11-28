import { expect } from 'vitest';
import { Analyzer } from '../../src/analyzer/Analyzer';
import type { DependencyGraph } from '../../src/analyzer/types';
import { EMITTERS, HEAD, build, programFor, readKey, type Built, type Emitter } from './e17-build';
import { call } from './e18-build';

/**
 * T21 (topic 21, standard disposal protocols) build helper, on top of the E17 one. The analysed program has the real
 * disposable lib, so `Symbol.dispose` and `Symbol.asyncDispose` are symbols the checker knows. Every call goes through
 * `Reflect` on `unknown`: no test types the member it checks.
 */

export { EMITTERS, HEAD, build, readKey, call };
export type { Built, Emitter };

export type Mode = 'open' | 'closed';
export type Profile = 'full' | 'minimal';

export interface Cell {
  emitter: Emitter;
  profile: Profile;
  mode: Mode;
}

/** The lib of the analysed program: the language and the disposable symbols. */
export const DISPOSABLE_LIB = ['lib.es2022.d.ts', 'lib.esnext.disposable.d.ts'] as const;

const PROFILES: readonly Profile[] = ['full', 'minimal'];
const MODES: readonly Mode[] = ['open', 'closed'];

/** Both emitters x full and minimal x open and closed: 8 cells. */
export const MATRIX: readonly Cell[] = EMITTERS.flatMap((emitter) =>
  PROFILES.flatMap((profile) => MODES.map((mode) => ({ emitter, profile, mode }))),
);

/** The cells that have `override()`: the full profile. */
export const FULL_CELLS: readonly Cell[] = MATRIX.filter((cell) => cell.profile === 'full');

export function label(cell: Cell): string {
  return `${cell.emitter} ${cell.profile} ${cell.mode}`;
}

export interface Parts {
  /** The classes and values the container reads, written before it. */
  declarations?: string;
  /** The registrations of the container under test. */
  injections: string;
  /** The roots of a closed cell, as a list. Default: none are needed, nothing is resolved from a root. */
  roots?: string;
  /** Text written before the container under test (a parent container). */
  before?: string;
  /** Extra lines of the container's configuration (`useContainer`, `scopeInputs`). */
  options?: string;
  /** Text written after the container under test. */
  after?: string;
}

/** `log(entry)` appends to `probe.log`; `bump(key)` counts into `probe.counts`. */
export function sourceFor(cell: Cell, parts: Parts): string {
  const closed = cell.mode === 'closed' ? `optimization: { mode: 'closed', roots: ${parts.roots ?? '[]'} },` : '';
  return `${HEAD}
const log = (entry: string): void => { probe.log.push(entry); };
const bump = (key: string): void => { probe.counts[key] = (probe.counts[key] ?? 0) + 1; };
${parts.declarations ?? ''}
${parts.before ?? ''}
export const box = defineBuilderConfig({
  name: 'T21',
  runtime: { profile: '${cell.profile}' },
  ${parts.options ?? ''}
  ${closed}
  injections: [
    ${parts.injections}
  ],
});
${parts.after ?? ''}
`;
}

export interface Env {
  built: Built;
  box: object;
  /** The class the module exports under `name`, as a token. */
  token: (name: string) => unknown;
  /** The entries of `probe.log`, in order. */
  log: () => string[];
  count: (key: string) => number;
  /** `box.resolve(token)`. */
  read: (token: unknown, owner?: object) => unknown;
}

export interface CellOptions {
  testOverrides?: boolean;
  runtimeSymbol?: object;
  /** The lib of the analysed program. Default: {@link DISPOSABLE_LIB}. */
  lib?: readonly string[];
}

export function buildCell(cell: Cell, parts: Parts, options: CellOptions = {}): Built {
  return build(sourceFor(cell, parts), {
    emitter: cell.emitter,
    testOverrides: options.testOverrides ?? false,
    lib: options.lib ?? DISPOSABLE_LIB,
    runtimeSymbol: options.runtimeSymbol,
  });
}

export function envOf(built: Built): Env {
  const box = built.box();
  return {
    built,
    box,
    token: (name) => built.exports[name],
    log: () => built.probe.log,
    count: (key) => built.probe.counts[key] ?? 0,
    read: (token, owner = box) => {
      const member: unknown = readKey(owner, 'resolve');
      if (typeof member !== 'function') throw new Error('resolve is not a function');
      return Reflect.apply(member, owner, [token]);
    },
  };
}

/** Builds one cell, runs `scenario`, and always releases the containers the module made. */
export async function withCell<T>(cell: Cell, parts: Parts, scenario: (env: Env) => Promise<T> | T, options: CellOptions = {}): Promise<T> {
  const built = buildCell(cell, parts, options);
  try {
    return await scenario(envOf(built));
  } finally {
    await built.close();
  }
}

/** The graph of the container named `T21`, or of the container `name`. */
export function graphOf(built: Built, name = 'T21'): DependencyGraph {
  const graph = built.graphs.find((candidate) => candidate.containerName === name);
  if (!graph) throw new Error(`missing graph ${name}`);
  return graph;
}

/** The analysis of the service registered for the class `name`, read through `unknown`. */
export function serviceOf(built: Built, name: string, container = 'T21'): unknown {
  return graphOf(built, container).nodes.get(built.id(name))?.service;
}

/**
 * Every test of the topic starts here: the analysis knows the class releases itself through a symbol-keyed method
 * (`symbolDisposer`). Today the parser looks for the member named `dispose` only, so the flag is absent.
 */
export function capabilitySymbol(built: Built, name: string, container = 'T21'): void {
  expect(readKey(serviceOf(built, name, container), 'symbolDisposer'), `${name} is a symbol disposer`).toBe(true);
}

/** What `destroy()` rejects with, `undefined` when it resolves. */
export async function destroyFailure(owner: unknown): Promise<unknown> {
  try {
    await call(owner, 'destroy');
  } catch (error) {
    return error;
  }
  return undefined;
}

/** The messages of the errors an `AggregateError` carries; the value itself when it is something else. */
export function errorsOf(failure: unknown): readonly unknown[] {
  const errors: unknown = readKey(failure, 'errors');
  return Array.isArray(errors) ? errors : [failure];
}

export function messages(errors: readonly unknown[]): string[] {
  return errors.map((error) => {
    const message: unknown = readKey(error, 'message');
    return typeof message === 'string' ? message : String(error);
  });
}

const ANALYSIS_FILE = '/virtual/t21/analysis/inline.ts';

/**
 * The graphs of `source` in a program whose lib is `lib`, and nothing else: no emission, no module run. `modules` are
 * the other files of the program, by path from the source's folder (`ext.d.ts`).
 */
export function analyse(source: string, modules: ReadonlyMap<string, string> = new Map(), lib: readonly string[] = DISPOSABLE_LIB): readonly DependencyGraph[] {
  const files = new Map<string, string>([[ANALYSIS_FILE, `${HEAD}\n${source}`]]);
  for (const [path, text] of modules) files.set(`/virtual/t21/analysis/${path}`, text);
  const analyzer = new Analyzer(programFor(files, lib));
  return analyzer.extractAll().filter((graph) => graph.sourceFileName === ANALYSIS_FILE);
}

/** The service registered under the token whose id starts with `name_` (or contains `name`), in the container `container`. */
export function serviceIn(graphs: readonly DependencyGraph[], container: string, name: string): unknown {
  const graph = graphs.find((candidate) => candidate.containerName === container);
  if (!graph) throw new Error(`missing graph ${container}`);
  for (const [id, node] of graph.nodes) {
    if (id.startsWith(`${name}_`) || id === name) return node.service;
  }
  for (const [id, node] of graph.nodes) {
    if (id.includes(name)) return node.service;
  }
  throw new Error(`missing token ${name} in ${container}`);
}
