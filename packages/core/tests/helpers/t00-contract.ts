import * as ts from 'typescript';
import { expect } from 'vitest';
import { Analyzer } from '../../src/analyzer/Analyzer';
import type { DependencyGraph } from '../../src/analyzer/types';
import { Generator } from '../../src/generator/Generator';
import { createFastProgram, warmLibCache } from '../fastProgram';

/**
 * One cell of the topic 00 matrix.
 * `emitProduct` forwards `emitter` to `new Generator`, so each cell can run on
 * the reference emitter and on the optimized emitter. Shared assertions stay
 * in {@link assertCell}.
 */
export interface ContractCell {
  profile: 'full' | 'minimal';
  mode: 'open' | 'closed';
  timing: 'sync' | 'async';
  owner: 'root' | 'scope' | 'parent';
}

/** Generator constructor argument. Undefined keeps the generator's default choice. */
export type ProductEmitter = 'reference' | 'optimized';

const PROFILES = ['full', 'minimal'] as const;
const MODES = ['open', 'closed'] as const;
const TIMINGS = ['sync', 'async'] as const;
const OWNERS = ['root', 'scope', 'parent'] as const;

export const CELLS: readonly ContractCell[] = PROFILES.flatMap((profile) =>
  MODES.flatMap((mode) =>
    TIMINGS.flatMap((timing) =>
      OWNERS.map((owner) => ({ profile, mode, timing, owner })),
    ),
  ),
);

function includes<T extends string>(allowed: readonly T[], value: string): value is T {
  return allowed.some((item) => item === value);
}

/** `T00 <profile> <mode> <timing> <owner>`, the literal title of one matrix test. */
export function cellFromTitle(title: string): ContractCell {
  const parts = title.split(' ');
  if (parts.length !== 5 || parts[0] !== 'T00') throw new Error(`bad title ${title}`);
  const profile = parts[1];
  const mode = parts[2];
  const timing = parts[3];
  const owner = parts[4];
  if (
    profile === undefined || mode === undefined || timing === undefined || owner === undefined
    || !includes(PROFILES, profile) || !includes(MODES, mode) || !includes(TIMINGS, timing) || !includes(OWNERS, owner)
  ) {
    throw new Error(`bad title ${title}`);
  }
  return { profile, mode, timing, owner };
}

interface Runtime {
  initialize: () => Promise<void>;
  resolve: (token: unknown) => unknown;
  destroy: () => Promise<void>;
  createScope: () => Runtime;
}

interface Closable {
  destroy: () => Promise<void>;
}

interface ChildView {
  readonly parent: unknown;
}

type ChildCtor = new (parent: unknown) => ChildView;
type SingleCtor = new () => { n: number };

export interface Executed {
  box: Runtime;
  parent?: Runtime;
  /** Generated source of the cell container. Optimized output names `_direct_` accessors. */
  source: string;
  single: unknown;
  fresh: string;
  hidden: string;
  parentToken?: string;
  childToken?: ChildCtor;
  close: () => Promise<void>;
}

/** Compiles one cell and returns the running container. Assertions stay in {@link assertCell}. */
export type Emit = (cell: ContractCell) => Promise<Executed>;

export const PARENT_DISPOSE_KEY = '__t00ParentDisposes';

function sourceFor(cell: ContractCell): string {
  const closed = cell.mode === 'closed';
  const parent = cell.owner === 'parent';
  const sync = cell.timing === 'sync';
  const roots = parent
    ? (sync ? '[T00Single, fresh, T00ChildView]' : '[single, fresh, T00ChildView]')
    : (sync ? '[T00Single, fresh]' : '[single, fresh]');
  const optimization = closed ? `optimization: { mode: 'closed', roots: ${roots} },` : '';
  const singleClass = sync ? 'export class T00Single { n = 1; }' : '';
  const parentTypes = parent
    ? `
    interface T00ParentPort { n: number; dispose(): void }
    export class T00ChildView { constructor(readonly parent: T00ParentPort) {} }
    const parentPort = useInterface<T00ParentPort>();
    export const parent = defineBuilderConfig({
      name: 'T00Parent',
      injections: [
        {
          token: parentPort,
          useFactory: true,
          dependencies: [],
          provider: () => {
            const value = {
              n: 4,
              dispose() {
                const holder = globalThis as { ${PARENT_DISPOSE_KEY}?: number };
                holder.${PARENT_DISPOSE_KEY} = (holder.${PARENT_DISPOSE_KEY} ?? 0) + 1;
              },
            };
            return value;
          },
        },
      ],
    });
    `
    : '';
  const single = sync
    ? '{ token: T00Single },'
    : '{ token: single, useFactory: true, dependencies: [], provider: async () => ({ n: 1 }) },';
  const child = parent ? '{ token: T00ChildView },' : '';
  return `
    import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';
    declare function defineBuilderConfig<T>(config: T): T;
    declare function useInterface<T>(): T;
    interface T00Fresh { n: number }
    interface T00Hidden { n: number }
    ${sync ? '' : 'interface T00Single { n: number }'}
    ${singleClass}
    const fresh = useInterface<T00Fresh>();
    const hidden = useInterface<T00Hidden>();
    ${sync ? '' : 'const single = useInterface<T00Single>();'}
    ${parentTypes}
    export const box = defineBuilderConfig({
      name: 'T00',
      runtime: { profile: '${cell.profile}' },
      ${optimization}
      ${parent ? 'useContainer: parent,' : ''}
      injections: [
        ${single}
        { token: fresh, useFactory: true, lifecycle: 'transient', dependencies: [hidden], provider: () => ({ n: 2 }) },
        { token: hidden, useValue: { n: 3 } },
        ${child}
      ],
    });
  `;
}

function programOf(fileName: string, source: string): ts.Program {
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    strict: true,
    noImplicitAny: false,
  };
  const sources = new Map([[fileName, source]]);
  const host = ts.createCompilerHost(options);
  const read = host.getSourceFile.bind(host);
  const exists = host.fileExists.bind(host);
  host.getSourceFile = (name, languageVersion, onError, shouldCreateNewSourceFile) => {
    const text = sources.get(name);
    if (text !== undefined) return ts.createSourceFile(name, text, languageVersion, true);
    return read(name, languageVersion, onError, shouldCreateNewSourceFile);
  };
  host.fileExists = (name) => sources.has(name) || exists(name);
  return createFastProgram([fileName], options, host);
}

function named(graphs: readonly DependencyGraph[], name: string): DependencyGraph {
  const graph = graphs.find((item) => item.exportedVariableName === name);
  if (!graph) throw new Error(`missing container ${name}`);
  const messages = (graph.errors ?? [])
    .filter((error) => error.severity !== 'warning')
    .map((error) => error.message);
  if (messages.length > 0) throw new Error(messages.join('\n'));
  return graph;
}

function tokenId(graph: DependencyGraph, name: string): string {
  const keys = [...graph.nodes.keys()];
  const found = keys.find((id) => id.includes(name));
  if (!found) throw new Error(`missing token ${name}`);
  return found;
}

function singleCtor(): SingleCtor {
  return class T00Single {
    n = 1;
  };
}

function childCtor(): ChildCtor {
  return class T00ChildView {
    readonly parent: unknown;
    constructor(parent: unknown) {
      this.parent = parent;
    }
  };
}

/**
 * Analyzer.extractAll, then `new Generator` with the requested emitter,
 * transpileModule, then new Function. `emitter` undefined keeps the default.
 */
function instantiate(
  graph: DependencyGraph,
  parent: Runtime | undefined,
  modules: { T00Single: SingleCtor; T00ChildView: ChildCtor },
  emitter: ProductEmitter | undefined,
): { container: Runtime; source: string } {
  const generated = new Generator(graph, false, undefined, true, false, emitter).generate();
  const js = ts.transpileModule(generated, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: false,
    },
  }).outputText;
  const record: { exports: Record<string, Runtime | undefined> } = { exports: {} };
  const run = new Function('parent', 'module', 'exports', 'require', js) as (
    parent: Runtime | undefined,
    module: { exports: Record<string, Runtime | undefined> },
    exports: Record<string, Runtime | undefined>,
    require: (id: string) => { T00Single: SingleCtor; T00ChildView: ChildCtor },
  ) => void;
  run(parent, record, record.exports, () => modules);
  const name = graph.exportedVariableName ?? 'box';
  const container = record.exports[name];
  if (!container) throw new Error(`generated module did not export ${name}`);
  return { container, source: generated };
}

function errorCode(error: unknown): string {
  if (!(error instanceof Error)) return '';
  const code = Reflect.get(error, 'code');
  return typeof code === 'string' ? code : '';
}

/**
 * Destroys every container, last opened first.
 * A container that is already destroyed is ignored. Any other destroy error fails the caller.
 */
export async function destroyContainers(opened: Closable[]): Promise<void> {
  const errors: unknown[] = [];
  for (const container of opened.splice(0).reverse()) {
    try {
      await container.destroy();
    } catch (error) {
      if (errorCode(error) !== 'NEO_CONTAINER_DESTROYED') errors.push(error);
    }
  }
  const error = errors[0];
  if (error instanceof Error) throw error;
  if (error !== undefined) throw new Error('teardown failed');
}

/** Runs `run`. If it throws, destroys `opened` and then rethrows the build error. */
export async function finishBuild<T>(opened: Closable[], run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    await destroyContainers(opened);
    throw error;
  }
}

export async function emitProduct(cell: ContractCell, emitter?: ProductEmitter): Promise<Executed> {
  warmLibCache();
  const opened: Runtime[] = [];
  return finishBuild(opened, async () => {
    const fileName = `/virtual/t00/${cell.profile}-${cell.mode}-${cell.timing}-${cell.owner}.ts`;
    const graphs = new Analyzer(programOf(fileName, sourceFor(cell))).extractAll();
    const boxGraph = named(graphs, 'box');
    const modules = { T00Single: singleCtor(), T00ChildView: childCtor() };
    let parent: Runtime | undefined;
    if (cell.owner === 'parent') {
      const built = instantiate(named(graphs, 'parent'), undefined, modules, emitter);
      parent = built.container;
      opened.push(parent);
    }
    const built = instantiate(boxGraph, parent, modules, emitter);
    opened.push(built.container);
    return {
      box: built.container,
      parent,
      source: built.source,
      single: cell.timing === 'sync' ? modules.T00Single : tokenId(boxGraph, 'T00Single'),
      fresh: tokenId(boxGraph, 'T00Fresh'),
      hidden: tokenId(boxGraph, 'T00Hidden'),
      parentToken: parent ? tokenId(named(graphs, 'parent'), 'T00ParentPort') : undefined,
      childToken: cell.owner === 'parent' ? modules.T00ChildView : undefined,
      close: async () => {
        await destroyContainers(opened);
      },
    };
  });
}

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return errorCode(error);
  }
  return '';
}

function readN(value: unknown): number {
  if (typeof value !== 'object' || value === null || !('n' in value)) return -1;
  const n = Reflect.get(value, 'n');
  return typeof n === 'number' ? n : -1;
}

function parentDisposes(): number {
  const value = Reflect.get(globalThis, PARENT_DISPOSE_KEY);
  return typeof value === 'number' ? value : 0;
}

function viewParent(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || !('parent' in value)) {
    throw new Error('child factory did not return the parent instance');
  }
  return Reflect.get(value, 'parent');
}

/** Behaviour shared by every cell. `emit` is the only way a cell is built. */
export async function assertCell(emit: Emit, cell: ContractCell, emitter?: ProductEmitter): Promise<void> {
  Reflect.deleteProperty(globalThis, PARENT_DISPOSE_KEY);
  const scopes: Runtime[] = [];
  let executed: Executed | undefined;
  let failure: unknown;
  try {
    const current = await emit(cell);
    executed = current;
    if (emitter !== undefined) {
      const direct = current.source.includes('private _direct_');
      expect(direct, `${emitter} emitter`).toBe(emitter === 'optimized');
    }
    const { box } = current;
    if (cell.timing === 'async') {
      expect(codeOf(() => box.resolve(current.single))).toBe('NEO_NOT_INITIALIZED');
      await box.initialize();
    }
    const first = box.resolve(current.single);
    const second = box.resolve(current.single);
    expect(second).toBe(first);
    expect(readN(first)).toBe(1);
    const left = box.resolve(current.fresh);
    const right = box.resolve(current.fresh);
    expect(left === right).toBe(false);
    expect(readN(left)).toBe(2);
    if (cell.mode === 'closed') {
      expect(codeOf(() => box.resolve(current.hidden))).toBe('NEO_ROOT_NOT_EXPORTED');
    } else {
      const hidden = box.resolve(current.hidden);
      expect(box.resolve(current.hidden)).toBe(hidden);
      expect(readN(hidden)).toBe(3);
    }
    if (cell.owner === 'scope') {
      const scope = box.createScope();
      scopes.push(scope);
      if (cell.timing === 'async') await scope.initialize();
      const scoped = scope.resolve(current.single);
      expect(scoped === first).toBe(false);
      expect(scope.resolve(current.single)).toBe(scoped);
    }
    if (cell.owner === 'parent') {
      const parent = current.parent;
      const parentToken = current.parentToken;
      const childToken = current.childToken;
      if (!parent || parentToken === undefined || !childToken) throw new Error('parent cell has no parent');
      if (cell.mode === 'open') {
        const viaChild = box.resolve(parentToken);
        expect(viaChild).toBe(parent.resolve(parentToken));
        await box.destroy();
        expect(parentDisposes()).toBe(0);
        expect(parent.resolve(parentToken)).toBe(viaChild);
      } else {
        const viaFactory = viewParent(box.resolve(childToken));
        expect(viaFactory).toBe(parent.resolve(parentToken));
        expect(codeOf(() => box.resolve(parentToken))).toBe('NEO_ROOT_NOT_EXPORTED');
        await box.destroy();
        expect(parentDisposes()).toBe(0);
        expect(parent.resolve(parentToken)).toBe(viaFactory);
      }
    }
  } catch (error) {
    failure = error;
  }
  const teardown: unknown[] = [];
  try {
    await destroyContainers(scopes);
  } catch (error) {
    teardown.push(error);
  }
  if (executed) {
    try {
      await executed.close();
    } catch (error) {
      teardown.push(error);
    }
  }
  Reflect.deleteProperty(globalThis, PARENT_DISPOSE_KEY);
  if (failure !== undefined) throw failure;
  const teardownError = teardown[0];
  if (teardownError !== undefined) throw teardownError;
}
