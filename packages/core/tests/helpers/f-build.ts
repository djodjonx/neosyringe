import { setImmediate as tick } from 'node:timers/promises';
import type { DependencyGraph } from '../../src/analyzer/types';
import { EMITTERS, loadSource, type Emitter } from './t06-run';

/**
 * F11 (topic 11, bounded concurrent initialization) build helper, on top of the E17 one. A graph is written as a list of
 * `Spec` rows: async or sync factories, aliases and multi contributions. Every factory reports to a controller the test
 * owns (`probe.start`, `probe.end`, `probe.gate`, `probe.fail`, `probe.built`, `probe.disposed`), so a test reads what a
 * user can observe: which factories started, how many ran at once, in which order they ended. A factory waits on a gate
 * the test opens itself (a promise, never a clock). The container is reached through `Reflect` on `unknown`.
 */

export { EMITTERS };
export type { Emitter };

export type Profile = 'full' | 'minimal';
export type Mode = 'open' | 'closed';

export interface Cell {
  emitter: Emitter;
  profile: Profile;
  mode: Mode;
}

const PROFILES: readonly Profile[] = ['full', 'minimal'];
const MODES: readonly Mode[] = ['open', 'closed'];

/** Both emitters x full and minimal x open and closed. */
export const MATRIX: readonly Cell[] = EMITTERS.flatMap((emitter) =>
  PROFILES.flatMap((profile) => MODES.map((mode) => ({ emitter, profile, mode }))),
);

export function label(cell: Cell): string {
  return `${cell.emitter} ${cell.profile} ${cell.mode}`;
}

/**
 * One registration.
 * - `name`: the token (`t<name>` in the source) and the label the factory reports under.
 * - `kind`: `async` (default) or `sync`.
 * - `deps`: `'X'` is a single dependency, `'*X'` a `{ all: tX }` one. The factory reads each of them.
 * - `part`: this row is a multi contribution to the token `name`; the factory reports under `part`.
 * - `alias`: this row is `{ token: t<name>, useExisting: t<alias> }`.
 * - `dispose`: the value has a `dispose()` that reports `probe.disposed(name)`.
 * - `opaque`: the registration declares no `dependencies` list (the container is analysed in `compatible` mode); its
 *   factory still reads every name of `deps`, so what it resolves is invisible to the graph.
 * - `cooperative`: an async factory that stops waiting when the signal of its context aborts, and rejects: with the
 *   signal's reason, or with the error `ctl.cooperateWith(name, error)` set (topic 19, a factory that honours `signal`).
 */
export interface Spec {
  name: string;
  kind?: 'async' | 'sync';
  deps?: readonly string[];
  part?: string;
  alias?: string;
  dispose?: boolean;
  /** `dispose()` reports itself, then answers the gate `<name>:dispose` of the controller: an async disposer a test holds. */
  disposeGate?: boolean;
  /**
   * `dispose()` reports itself, then answers an object whose `then` is `undefined` the first time it is read and throws on
   * every later read (`probe.twoFaced()`): a runtime that reads `then` twice sees a plain value, then a failure.
   */
  disposeTwoFaced?: boolean;
  opaque?: boolean;
  cooperative?: boolean;
}

const HEAD = `
import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';
declare function defineBuilderConfig<T>(config: T): T;
declare function useInterface<T>(): T;
interface Probe {
  start(name: string): void;
  end(name: string): void;
  gate(name: string): Promise<void>;
  fail(name: string): void;
  built(name: string): void;
  disposed(name: string): void;
  twoFaced(): unknown;
  context(name: string, context: unknown): void;
  stopping(name: string, signal: { reason?: unknown }): unknown;
}
declare const probe: Probe;
`;

function reads(deps: readonly string[]): string {
  return deps.map((dep) => (dep.startsWith('*') ? `ctx.resolveAll(t${dep.slice(1)});` : `ctx.resolve(t${dep});`)).join('\n      ');
}

function dependencyList(deps: readonly string[]): string {
  return deps.map((dep) => (dep.startsWith('*') ? `{ all: t${dep.slice(1)} }` : `t${dep}`)).join(', ');
}

function injection(spec: Spec): string {
  if (spec.alias !== undefined) return `{ token: t${spec.name}, useExisting: t${spec.alias} },`;
  const label = spec.part ?? spec.name;
  const deps = spec.deps ?? [];
  const multi = spec.part === undefined ? '' : 'multi: true,';
  const declared = spec.opaque === true ? '' : ` dependencies: [${dependencyList(deps)}],`;
  const value = spec.disposeTwoFaced === true
    ? `{ name: ${JSON.stringify(label)}, dispose() { probe.disposed(${JSON.stringify(label)}); return probe.twoFaced(); } }`
    : spec.disposeGate === true
    ? `{ name: ${JSON.stringify(label)}, dispose() { probe.disposed(${JSON.stringify(label)}); return probe.gate(${JSON.stringify(`${label}:dispose`)}); } }`
    : spec.dispose === true
      ? `{ name: ${JSON.stringify(label)}, dispose() { probe.disposed(${JSON.stringify(label)}); } }`
      : `{ name: ${JSON.stringify(label)} }`;
  const wait = spec.cooperative === true
    ? `const signal = ctx.signal;
        await Promise.race([probe.gate(${JSON.stringify(label)}), new Promise((_, reject) => {
          const stop = () => reject(probe.stopping(${JSON.stringify(label)}, signal));
          if (signal.aborted) stop();
          else signal.addEventListener('abort', stop, { once: true });
        })]);`
    : `await probe.gate(${JSON.stringify(label)});`;
  if (spec.kind === 'sync') {
    return `{ token: t${spec.name}, useFactory: true, ${multi}${declared} provider: (ctx) => {
      probe.start(${JSON.stringify(label)});
      probe.context(${JSON.stringify(label)}, ctx);
      try {
        ${reads(deps)}
        probe.fail(${JSON.stringify(label)});
        probe.built(${JSON.stringify(label)});
        return ${value};
      } finally { probe.end(${JSON.stringify(label)}); }
    } },`;
  }
  return `{ token: t${spec.name}, useFactory: true, ${multi}${declared} provider: async (ctx) => {
      probe.start(${JSON.stringify(label)});
      probe.context(${JSON.stringify(label)}, ctx);
      try {
        ${wait}
        ${reads(deps)}
        probe.fail(${JSON.stringify(label)});
        probe.built(${JSON.stringify(label)});
        return ${value};
      } finally { probe.end(${JSON.stringify(label)}); }
    } },`;
}

export interface SourceOptions {
  /** The text after `concurrency:`. Absent: no `initialization` member. */
  concurrency?: number | string;
  /** The whole `initialization` member, when the test needs a shape `concurrency` cannot express. */
  initialization?: string;
  /** The `name` of the container. */
  name?: string;
  /** Closed cells only: the names of the `eager` roots. */
  eager?: readonly string[];
  /** Generate the test overrides (`override`, `overrideMany`, `clearOverrides` do real work instead of refusing). */
  testOverrides?: boolean;
  /** Generate the optional production observation (topic 22): `observe()` and `stateSnapshot()` on the container. */
  observation?: boolean;
  /** A `useContainer` parent of the container, an open full container named `parent` that holds these registrations. */
  parent?: readonly Spec[];
}

/** The source of one cell: the specs as injections of `box`. Closed cells export every token. */
export function sourceOf(cell: Pick<Cell, 'profile' | 'mode'>, specs: readonly Spec[], options: SourceOptions = {}): string {
  const parentSpecs = options.parent ?? [];
  const names = namesOf([...parentSpecs, ...specs]);
  const declarations = names.map((name) => `interface I${name} { name: string }\nconst t${name} = useInterface<I${name}>();`);
  const multi = new Set(specs.filter((spec) => spec.part !== undefined).map((spec) => spec.name));
  const aliases = new Set(specs.filter((spec) => spec.alias !== undefined).map((spec) => spec.name));
  const roots = namesOf(specs)
    .filter((name) => !aliases.has(name))
    .map((name) => (multi.has(name) ? `{ all: t${name} }` : `t${name}`));
  const eager = options.eager === undefined ? '' : ` eager: [${options.eager.map((name) => `t${name}`).join(', ')}],`;
  const optimization = cell.mode === 'closed' ? `optimization: { mode: 'closed', roots: [${roots.join(', ')}],${eager} },` : '';
  const concurrency = options.initialization ?? (options.concurrency === undefined ? '' : `initialization: { concurrency: ${options.concurrency} },`);
  const parent = options.parent === undefined
    ? ''
    : `export const parent = defineBuilderConfig({
  name: 'F11Parent',
  injections: [
    ${parentSpecs.map(injection).join('\n    ')}
  ],
});
`;
  return `${HEAD}
${declarations.join('\n')}
${parent}export const box = defineBuilderConfig({
  name: ${JSON.stringify(options.name ?? 'F11')},
  runtime: { profile: '${cell.profile}' },
  ${options.parent === undefined ? '' : 'useContainer: parent,'}
  ${optimization}
  ${concurrency}
  injections: [
    ${specs.map(injection).join('\n    ')}
  ],
});
`;
}

export interface Deferred {
  promise: Promise<void>;
  open: () => void;
}

export function deferred(): Deferred {
  let open = (): void => {};
  const promise = new Promise<void>((done) => {
    open = done;
  });
  return { promise, open };
}

/** What a factory of the source reports to, and what the test reads back. */
export interface Controller {
  /** `start:X`, `end:X` and `dispose:X`, in the order the factories reported them. */
  readonly log: string[];
  /** The labels that started, in order. */
  readonly started: string[];
  readonly built: Map<string, number>;
  readonly disposed: Map<string, number>;
  /** The context each factory was called with, by label (the last call wins). */
  readonly contexts: Map<string, unknown>;
  /** The `signal` of the context, read when the factory was called (the last call wins), `undefined` when it has none. */
  readonly signals: Map<string, unknown>;
  /**
   * Whether the factory reads `context.signal` when it is called (default: it does). A test that sets it to `false` keeps
   * the context in `contexts` and reads the signal itself, later, or never.
   */
  readSignal: boolean;
  /** How many factories are between `start` and `end` right now, and the most there ever were. */
  active(): number;
  peak(): number;
  /** The factories of `names` wait until `open(name)`. */
  hold(...names: string[]): void;
  open(...names: string[]): void;
  openAll(): void;
  /** The factory `name` throws `error` once its gate is open; `undefined` lets it succeed again. */
  failWith(name: string, error: Error | undefined): void;
  /** The `dispose()` of the value of `name` reports itself, then throws `error`. */
  failDisposeWith(name: string, error: Error): void;
  /** A `cooperative` factory `name` rejects with `error` when its signal aborts; `undefined` restores the signal's reason. */
  cooperateWith(name: string, error: Error | undefined): void;
  /** `run` is called, once per call, as the factory `name` starts (before it waits on its gate). */
  onStart(name: string, run: () => void): void;
}

/** The controller and the object the module reads as `probe`, made together so they share their state. */
function wire(): { ctl: Controller; probe: object } {
  const gates = new Map<string, Deferred>();
  const failures = new Map<string, Error>();
  const disposeFailures = new Map<string, Error>();
  const cooperation = new Map<string, Error>();
  const starts = new Map<string, () => void>();
  const state = { active: 0, peak: 0 };
  const ctl: Controller = {
    log: [],
    started: [],
    built: new Map(),
    disposed: new Map(),
    contexts: new Map(),
    signals: new Map(),
    readSignal: true,
    active: () => state.active,
    peak: () => state.peak,
    hold(...names) {
      for (const name of names) gates.set(name, deferred());
    },
    open(...names) {
      for (const name of names) gates.get(name)?.open();
    },
    openAll() {
      for (const gate of gates.values()) gate.open();
    },
    failWith(name, error) {
      if (error === undefined) failures.delete(name);
      else failures.set(name, error);
    },
    failDisposeWith(name, error) {
      disposeFailures.set(name, error);
    },
    cooperateWith(name, error) {
      if (error === undefined) cooperation.delete(name);
      else cooperation.set(name, error);
    },
    onStart(name, run) {
      starts.set(name, run);
    },
  };
  const probe = {
    start: (name: string): void => {
      state.active += 1;
      state.peak = Math.max(state.peak, state.active);
      ctl.log.push(`start:${name}`);
      ctl.started.push(name);
      starts.get(name)?.();
    },
    end: (name: string): void => {
      state.active -= 1;
      ctl.log.push(`end:${name}`);
    },
    gate: (name: string): Promise<void> => gates.get(name)?.promise ?? Promise.resolve(),
    fail: (name: string): void => {
      const error = failures.get(name);
      if (error !== undefined) throw error;
    },
    built: (name: string): void => {
      ctl.built.set(name, (ctl.built.get(name) ?? 0) + 1);
    },
    disposed: (name: string): void => {
      ctl.log.push(`dispose:${name}`);
      ctl.disposed.set(name, (ctl.disposed.get(name) ?? 0) + 1);
      const error = disposeFailures.get(name);
      if (error !== undefined) throw error;
    },
    twoFaced: (): unknown => {
      let reads = 0;
      return {
        get then(): unknown {
          reads += 1;
          if (reads > 1) throw new Error('then read twice');
          return undefined;
        },
      };
    },
    stopping: (name: string, signal: { reason?: unknown }): unknown => cooperation.get(name) ?? signal.reason,
    context: (name: string, context: unknown): void => {
      ctl.contexts.set(name, context);
      ctl.signals.set(name, ctl.readSignal && typeof context === 'object' && context !== null ? Reflect.get(context, 'signal') : undefined);
    },
  };
  return { ctl, probe };
}

export interface Settled {
  ok: boolean;
  error: unknown;
}

export interface Run {
  box: object;
  /** The `useContainer` parent, when the source has one. */
  parent: object | undefined;
  graph: DependencyGraph;
  ctl: Controller;
  /** The emitted text of the container. */
  text: string;
  /** The runtime key of the token `name` (the `name` of a `Spec`). */
  token: (name: string) => string;
  /** `box.initialize(options)`; the rejection is held in `settled`, never left unhandled. */
  start: (options?: { signal?: unknown }) => { promise: Promise<unknown>; settled: Promise<Settled> };
  /** One turn of the event loop: every microtask queued so far has run. No clock. */
  settle: () => Promise<void>;
}

const PROBE_KEY = '__f11Probe';

/** The key of the token `I<name>` in the graph: an interface token id is its name, `_`, then a hash. */
function keyOf(graph: DependencyGraph, name: string): string {
  const keys = [...graph.nodes.keys(), ...(graph.multiNodes?.keys() ?? [])];
  const found = keys.find((key) => key.startsWith(`I${name}_`));
  if (found === undefined) throw new Error(`missing token ${name}`);
  return found;
}

export function namesOf(specs: readonly Spec[]): string[] {
  const names: string[] = [];
  for (const spec of specs) if (!names.includes(spec.name)) names.push(spec.name);
  return names;
}

/** Builds one cell, runs `scenario`, and always opens the gates and destroys the containers. */
export async function withRun<T>(
  cell: Cell,
  specs: readonly Spec[],
  options: SourceOptions,
  scenario: (run: Run) => Promise<T> | T,
): Promise<T> {
  const opaque = [...(options.parent ?? []), ...specs].some((spec) => spec.opaque === true);
  const loaded = loadSource(sourceOf(cell, specs, options), opaque ? { validation: 'compatible' } : {});
  const graph = loaded.graph('box');
  const { ctl, probe } = wire();
  const everything = namesOf([...(options.parent ?? []), ...specs]);
  const own = namesOf(specs);
  const prelude = [
    ...everything.map((name) => `const t${name} = ${JSON.stringify(keyOf(own.includes(name) ? graph : loaded.graph('parent'), name))};`),
    `const probe = Reflect.get(globalThis, '${PROBE_KEY}');`,
  ].join('\n');
  Reflect.set(globalThis, PROBE_KEY, probe);
  const observation = options.observation === true;
  const parent = options.parent === undefined ? undefined : loaded.open('parent', { emitter: cell.emitter, prelude, observation });
  const opened = loaded.open('box', { emitter: cell.emitter, prelude, parent: parent?.container, testOverrides: options.testOverrides === true, observation });
  const box: object = opened.container;
  try {
    return await scenario({
      box,
      parent: parent?.container,
      graph,
      ctl,
      text: opened.source,
      token: (name) => keyOf(graph, name),
      start: (options) => {
        const promise = options === undefined ? opened.container.initialize() : opened.container.initialize(options);
        return { promise, settled: promise.then((): Settled => ({ ok: true, error: undefined }), (error: unknown): Settled => ({ ok: false, error })) };
      },
      settle: () => tick(),
    });
  } finally {
    await release(ctl, [opened.container, ...(parent ? [parent.container] : [])]);
  }
}

/** Opens every gate, lets the factories finish, and destroys the containers in order; one already destroyed is fine. */
async function release(ctl: Controller, containers: readonly { destroy: () => Promise<void> }[]): Promise<void> {
  ctl.openAll();
  await tick();
  // The module read `probe` once, when it ran: no factory reads the global any more.
  Reflect.deleteProperty(globalThis, PROBE_KEY);
  for (const container of containers) {
    try {
      await container.destroy();
    } catch (error) {
      if (!(error instanceof Error) || Reflect.get(error, 'code') !== 'NEO_CONTAINER_DESTROYED') throw error;
    }
  }
}

/** The text of `initialize()` and `_runInitialize()` of an emitted container, whether `initialize` is `async` or not. */
export function initializeText(code: string): string {
  const start = code.search(/public (?:async )?initialize\(/);
  const end = code.indexOf('private _guardPublic');
  if (start < 0 || end < start) throw new Error('no async initialize in the emitted text');
  return code.slice(start, end);
}

/** `owner[name](...args)` through `Reflect` on `unknown`; `undefined` when the member is not a function. */
export function member(owner: object, name: string): ((...args: unknown[]) => unknown) | undefined {
  const found: unknown = Reflect.get(owner, name);
  if (typeof found !== 'function') return undefined;
  return (...args: unknown[]) => Reflect.apply(found, owner, args);
}
