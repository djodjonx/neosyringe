import { expect } from 'vitest';
import * as ts from 'typescript';
import type { DependencyGraph, DependencyNode, ServiceDefinition } from '../../src/analyzer/types';
import { Generator } from '../../src/generator/Generator';
import { EMITTERS, HEAD, build, readKey, type Built, type Emitter } from './e17-build';
import { call, failure, shown, slice, thrown, use } from './e18-build';

/**
 * E20 (topic 20, `useExisting`) build helper, on top of the E17 one. Every call goes through `Reflect` on `unknown`:
 * no test types the member it checks. The source of a cell declares:
 * - `Engine` (a class, owned, with `dispose`), the target of the aliases; its sync form is a class registration, its
 *   async form a class token with an async factory;
 * - `Reader` (a class) whose constructor reads the alias token `Logger`;
 * - three interface tokens that alias, in a chain: `logger` -> `Engine`, `audit` -> `logger`, `sink` -> `audit`.
 * The three tokens are also registered with `useValue` in a second container, `E20Ids`, so that their runtime ids
 * exist in the analysis whether or not the container under test knows its aliases.
 */

export { EMITTERS, HEAD, build, readKey, call, failure, shown, slice, thrown, use };
export type { Built, Emitter };

export type Mode = 'open' | 'closed';
export type Timing = 'sync' | 'async';
export type Profile = 'full' | 'minimal';

export interface Cell {
  emitter: Emitter;
  mode: Mode;
  timing: Timing;
  profile: Profile;
}

const MODES: readonly Mode[] = ['open', 'closed'];
const TIMINGS: readonly Timing[] = ['sync', 'async'];
const PROFILES: readonly Profile[] = ['full', 'minimal'];

/** Both emitters x open and closed x sync and async, full profile. */
export const CELLS: readonly Cell[] = EMITTERS.flatMap((emitter) =>
  MODES.flatMap((mode) => TIMINGS.map((timing) => ({ emitter, mode, timing, profile: 'full' as const }))),
);

/** The same cells in both profiles: 16 cells. */
export const MATRIX: readonly Cell[] = PROFILES.flatMap((profile) => CELLS.map((cell) => ({ ...cell, profile })));

export function label(cell: Cell): string {
  return `${cell.emitter} ${cell.profile} ${cell.mode} ${cell.timing}`;
}

export interface SourceOptions {
  /** How `Engine` is registered. `none`: not at all (a parent provides it). Default: `singleton`. */
  target?: 'singleton' | 'transient' | 'none';
  /** The roots of a closed cell. Default: the three aliases, `Reader` and `Engine`. */
  roots?: string;
  /** The alias registrations. Default: the chain `logger` -> `Engine`, `audit` -> `logger`, `sink` -> `audit`. */
  aliases?: string;
  /** Extra injections written after the aliases. */
  extra?: string;
  /** Text written before the container under test (a parent container). */
  before?: string;
  /** Text written after the container under test. */
  after?: string;
  /** The `useContainer` line of the container under test. */
  useContainer?: string;
  /** Modules the container file imports (see E17 `build`). */
  modules?: ReadonlyMap<string, string>;
  /** Extra declarations written before the container under test. */
  declarations?: string;
  /** `Engine` has a `dispose`. Default: true. A singleton that reads a disposable transient is refused, so a transient cell turns it off. */
  disposable?: boolean;
  /**
   * `Reader` gets an async `dispose` and both classes append their name to `probe.log` when they are disposed: the order
   * a container disposes a consumer and the target its alias reaches is then readable.
   */
  logDisposal?: boolean;
}

const DEFAULT_ALIASES = `
    { token: logger, useExisting: Engine },
    { token: audit, useExisting: logger },
    { token: sink, useExisting: audit },`;

export function sourceFor(cell: Cell, options: SourceOptions = {}): string {
  const target = options.target ?? 'singleton';
  const engine = target === 'none'
    ? ''
    : cell.timing === 'async'
      ? '{ token: Engine, useFactory: true, dependencies: [], provider: async () => { bump(\'asyncEngine\'); return new Engine(); } },'
      : target === 'transient'
        ? "{ token: Engine, lifecycle: 'transient' },"
        : '{ token: Engine },';
  const roots = options.roots ?? '[sink, audit, logger, Reader, Engine]';
  const closed = cell.mode === 'closed' ? `optimization: { mode: 'closed', roots: ${roots} },` : '';
  return `${HEAD}
const bump = (key: string): void => { probe.counts[key] = (probe.counts[key] ?? 0) + 1; };
interface Logger { id: string }
interface Audit { id: string }
interface Sink { id: string }
export class Engine {
  readonly id = 'engine';
  constructor() { bump('buildEngine'); }
  ${options.disposable === false ? '' : `dispose(): void { bump('disposeEngine'); ${options.logDisposal === true ? "probe.log.push('Engine'); " : ''}}`}
}
export class Reader {
  constructor(readonly logger: Logger) { bump('buildReader'); }
  ${options.logDisposal === true ? "async dispose(): Promise<void> { await Promise.resolve(); probe.log.push('Reader'); }" : ''}
}
const logger = useInterface<Logger>();
const audit = useInterface<Audit>();
const sink = useInterface<Sink>();
const ids = defineBuilderConfig({
  name: 'E20Ids',
  injections: [
    { token: logger, useValue: { id: 'ids' } },
    { token: audit, useValue: { id: 'ids' } },
    { token: sink, useValue: { id: 'ids' } },
  ],
});
${options.declarations ?? ''}
${options.before ?? ''}
export const box = defineBuilderConfig({
  name: 'E20',
  runtime: { profile: '${cell.profile}' },
  ${options.useContainer ?? ''}
  ${closed}
  injections: [
    ${engine}${options.aliases ?? DEFAULT_ALIASES}
    { token: Reader },
    ${options.extra ?? ''}
  ],
});
${options.after ?? ''}
`;
}

export interface Env {
  built: Built;
  box: object;
  logger: string;
  audit: string;
  sink: string;
  /** The class token `Engine`, as the module exports it. */
  engine: unknown;
  reader: unknown;
  /** How many times the counter `key` of the source was bumped. */
  count: (key: string) => number;
  /** `box.resolve(token)`, after `initialize()` in an async cell. */
  read: (token: unknown) => unknown;
}

export interface EnvOptions extends SourceOptions {
  testOverrides?: boolean;
  /** Leave an async cell uninitialized: `read` then calls `resolve` at once. */
  skipInitialize?: boolean;
}

/** Builds one cell, runs `scenario`, and always releases the containers the scenario made. */
export async function withEnv<T>(cell: Cell, options: EnvOptions, scenario: (env: Env) => Promise<T> | T): Promise<T> {
  const built = build(sourceFor(cell, options), {
    emitter: cell.emitter,
    testOverrides: options.testOverrides ?? false,
    modules: options.modules,
  });
  try {
    const box = built.box();
    return await scenario({
      built,
      box,
      logger: built.id('Logger'),
      audit: built.id('Audit'),
      sink: built.id('Sink'),
      engine: built.exports['Engine'],
      reader: built.exports['Reader'],
      count: (key) => built.probe.counts[key] ?? 0,
      read: (token) => use(box, 'resolve', token),
    });
  } finally {
    await built.close();
  }
}

/** Initializes the container of an async cell. A sync cell has nothing to prepare. */
export async function ready(cell: Cell, env: Env): Promise<void> {
  if (cell.timing === 'async') await call(env.box, 'initialize');
}

/** The graph of the container under test. */
export function graphOf(built: Built, name = 'E20'): DependencyGraph {
  const graph = built.graphs.find((candidate) => candidate.containerName === name);
  if (!graph) throw new Error(`missing graph ${name}`);
  return graph;
}

/**
 * Every test of the topic starts here: the analysis knows the alias, a node of its own whose type is `alias`.
 * Today `useExisting` is ignored, so the token has no node at all.
 */
export function capabilityAlias(built: Built, name = 'Logger', containerName = 'E20'): void {
  const node = graphOf(built, containerName).nodes.get(built.id(name));
  const type: unknown = readKey(node?.service, 'type');
  expect(type, `the graph has an alias node for ${name}`).toBe('alias');
}

/** The text of the generated container that holds `Engine` (not the `E20Ids` one). */
export function containerText(built: Built): string {
  const text = built.generated.find((candidate) => candidate.includes('Engine') && candidate.includes('class NeoContainer'));
  if (text === undefined) throw new Error('missing generated container');
  return text;
}

// ---------------------------------------------------------------------------------------------------------------
// Hand-built graphs
// ---------------------------------------------------------------------------------------------------------------

function anchor(): ts.CallExpression {
  const sourceFile = ts.createSourceFile(
    'synthetic.ts',
    'declare function defineBuilderConfig(config: unknown): unknown;\ndefineBuilderConfig({});\n',
    ts.ScriptTarget.ES2022,
    true,
  );
  let found: ts.CallExpression | undefined;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(node)) found = node;
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (!found) throw new Error('missing call');
  return found;
}

/**
 * A definition of an alias of `target`. `Object.assign` keeps the helper compilable whatever the registration types
 * are: the generator reads `type` and `aliasTarget`, nothing else of it.
 */
export function aliasService(id: string, target: string, node: ts.Node): ServiceDefinition {
  const base: ServiceDefinition = {
    tokenId: id,
    registrationNode: node,
    registrationId: id,
    type: 'value',
    lifecycle: 'singleton',
    isInterfaceToken: true,
  };
  return Object.assign(base, { type: 'alias', aliasTarget: { tokenId: target, isInterfaceToken: true } });
}

/**
 * `size` aliases in a chain over one target: `A_0` aliases `T`, `A_i` aliases `A_{i-1}`. The target is a hoisted
 * `useValue`, so the generated text needs no import. Hand-built: no checker, no source file.
 */
export function chainGraph(size: number): DependencyGraph {
  const call = anchor();
  const nodes = new Map<string, DependencyNode>();
  const target: ServiceDefinition = {
    tokenId: 'T',
    registrationNode: call,
    registrationId: 'T',
    type: 'value',
    lifecycle: 'singleton',
    isInterfaceToken: true,
    ownership: 'borrowed',
    valueSource: '{ id: 1 }',
    valueCapture: '__neoTarget',
  };
  nodes.set('T', { service: target, dependencies: [] });
  for (let index = 0; index < size; index += 1) {
    const id = `A_${index}`;
    const previous = index === 0 ? 'T' : `A_${index - 1}`;
    nodes.set(id, { service: aliasService(id, previous, call), dependencies: [previous] });
  }
  return { containerId: 'chain', containerName: 'Chain', nodes, roots: [], sourceFileName: '/virtual/e20-chain.ts', defineBuilderConfigStart: 0 };
}

/** What `run` throws, as a message; `undefined` when it answers. A test expects `undefined` before it reads more. */
export function attempt(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    const message: unknown = readKey(error, 'message');
    return typeof message === 'string' ? message : String(error);
  }
  return undefined;
}

/** The container class of a generator, as an object: the generated text is TypeScript, it is transpiled and run. */
export function runGenerated(generator: Generator, extra = ''): { box: object; text: string } {
  const text = generator.generate();
  const js = ts.transpileModule(`${text}\n${extra}\nexports.box = ${generator.generateInstantiation()};\n`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const record: { exports: Record<string, unknown> } = { exports: {} };
  const run: unknown = new Function('exports', js);
  if (typeof run !== 'function') throw new Error('the generated module is not callable');
  Reflect.apply(run, undefined, [record.exports]);
  const box = record.exports['box'];
  if (typeof box !== 'object' || box === null) throw new Error('the generated module has no container');
  return { box, text };
}
