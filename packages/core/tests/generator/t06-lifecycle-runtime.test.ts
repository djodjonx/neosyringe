import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { EMITTERS, errorCode, loadSource, type Container, type Emitter, type Loaded, type OpenOptions } from '../helpers/t06-run';

const STUB = `
  import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';
  declare function defineBuilderConfig<T>(config: T): T;
  declare function useInterface<T>(): T;
`;

const READ = '(globalThis as { __t06: {'
  + ' calls: number; disposals: number; created: number; order: string[];'
  + ' gate: Promise<void>; disposeGate: Promise<void>; fail: boolean; boom: Error;'
  + ' during: string; reentry: Promise<void> | undefined;'
  + ' box: { initialize(): Promise<void>; resolve(token: unknown): unknown;'
  + ' override(token: unknown, factory: () => unknown): Promise<void>;'
  + ' clearOverrides(): Promise<void> } | undefined;'
  + ' other: unknown; mocks: number; constructs: number; mockDisposals: number;'
  + ' hitsUndef: number; hitZero: number; hitFalse: number; hitBlank: number; hitNull: number;'
  + ' aliasHits: number; ownedBuilds: number; ownedHits: number;'
  + ' transientBuilds: number; transientHits: number; parentDisposes: number; scopeSeq: number;'
  + ' } }).__t06';

const SOURCE = `
  ${STUB}
  interface OncePort { n: number }
  interface KeptPort { dispose(): void }
  interface BoomPort { n: number }
  interface JoinPort { n: number; dispose(): Promise<void> }
  interface GatePort { n: number }
  interface LatePort { dispose(): void }
  interface AfterPort { n: number }
  interface AggLeft { dispose(): void }
  interface AggRight { dispose(): void }
  interface RollLeft { dispose(): void }
  interface RollRight { dispose(): void }
  interface RollBoom { n: number }
  interface AliasObject { n: number; dispose(): void }
  interface BorrowedPort { n: number; dispose(): void }
  interface OwnedAlias { n: number; dispose(): void }
  interface OwnedPort { n: number; dispose(): void }
  interface TransientPort { n: number; dispose(): void }
  interface ZeroPort { n: number }
  interface FalsePort { n: number }
  interface BlankPort { n: number }
  interface NullPort { n: number }
  interface UndefPort { n: number }
  interface MockPort { n: number; dispose(): void }
  interface ParentPort { n: number; dispose(): void }
  interface ScopePort { n: number }
  interface LocalA { n: number }
  interface LocalB { n: number }
  interface SharedLocal { n: number }
  interface ChildAlias { n: number; dispose(): void }
  interface ReSync { n: number; dispose(): Promise<void> }
  interface ReAsync { n: number }
  interface ReadyHold { n: number }
  interface ReadyPort { n: number }
  interface LifePort { n: number; dispose(): Promise<void> }
  interface MinPort { n: number; dispose(): Promise<void> }
  const oncePort = useInterface<OncePort>();
  const keptPort = useInterface<KeptPort>();
  const boomPort = useInterface<BoomPort>();
  const joinPort = useInterface<JoinPort>();
  const gatePort = useInterface<GatePort>();
  const latePort = useInterface<LatePort>();
  const afterPort = useInterface<AfterPort>();
  const aggLeft = useInterface<AggLeft>();
  const aggRight = useInterface<AggRight>();
  const rollLeft = useInterface<RollLeft>();
  const rollRight = useInterface<RollRight>();
  const rollBoom = useInterface<RollBoom>();
  const aliasObject = useInterface<AliasObject>();
  const borrowedPort = useInterface<BorrowedPort>();
  const ownedAlias = useInterface<OwnedAlias>();
  const ownedPort = useInterface<OwnedPort>();
  const transientPort = useInterface<TransientPort>();
  const zeroPort = useInterface<ZeroPort>();
  const falsePort = useInterface<FalsePort>();
  const blankPort = useInterface<BlankPort>();
  const nullPort = useInterface<NullPort>();
  const undefPort = useInterface<UndefPort>();
  const mockPort = useInterface<MockPort>();
  const parentPort = useInterface<ParentPort>();
  const scopePort = useInterface<ScopePort>();
  const localA = useInterface<LocalA>();
  const localB = useInterface<LocalB>();
  const sharedLocal = useInterface<SharedLocal>();
  const childAlias = useInterface<ChildAlias>();
  const reSync = useInterface<ReSync>();
  const reAsync = useInterface<ReAsync>();
  const readyHold = useInterface<ReadyHold>();
  const readyPort = useInterface<ReadyPort>();
  const lifePort = useInterface<LifePort>();
  const minPort = useInterface<MinPort>();

  export const onceBox = defineBuilderConfig({
    name: 'T06Once',
    injections: [{
      token: oncePort,
      useFactory: true,
      dependencies: [],
      provider: async () => {
        const slot = ${READ};
        slot.calls += 1;
        await slot.gate;
        return { n: 1 };
      },
    }],
  });

  export const failBox = defineBuilderConfig({
    name: 'T06Fail',
    injections: [
      {
        token: keptPort,
        useFactory: true,
        dependencies: [],
        provider: () => {
          const slot = ${READ};
          return { dispose() { slot.disposals += 1; } };
        },
      },
      {
        token: boomPort,
        useFactory: true,
        dependencies: [keptPort],
        provider: async () => {
          const slot = ${READ};
          await slot.gate;
          throw slot.boom;
        },
      },
    ],
  });

  export const joinBox = defineBuilderConfig({
    name: 'T06Join',
    injections: [{
      token: joinPort,
      useFactory: true,
      dependencies: [],
      provider: async () => {
        const slot = ${READ};
        return {
          n: 1,
          dispose() {
            slot.disposals += 1;
            return slot.disposeGate;
          },
        };
      },
    }],
  });

  export const lateBox = defineBuilderConfig({
    name: 'T06Late',
    injections: [
      {
        token: gatePort,
        useFactory: true,
        dependencies: [],
        provider: async () => {
          const slot = ${READ};
          await slot.gate;
          return { n: 1 };
        },
      },
      {
        token: latePort,
        useFactory: true,
        dependencies: [],
        provider: () => {
          const slot = ${READ};
          slot.created += 1;
          return { dispose() { slot.disposals += 1; } };
        },
      },
      {
        token: afterPort,
        useFactory: true,
        dependencies: [gatePort, latePort],
        provider: async () => ({ n: 2 }),
      },
    ],
  });

  export const aggBox = defineBuilderConfig({
    name: 'T06Agg',
    injections: [
      {
        token: aggLeft,
        useFactory: true,
        dependencies: [],
        provider: () => {
          const slot = ${READ};
          return { dispose() { slot.order.push('left'); throw new Error('left'); } };
        },
      },
      {
        token: aggRight,
        useFactory: true,
        dependencies: [],
        provider: () => {
          const slot = ${READ};
          return { dispose() { slot.order.push('right'); throw new Error('right'); } };
        },
      },
    ],
  });

  export const rollBox = defineBuilderConfig({
    name: 'T06Roll',
    injections: [
      {
        token: rollLeft,
        useFactory: true,
        dependencies: [],
        provider: () => {
          const slot = ${READ};
          return { dispose() { slot.order.push('left'); throw new Error('left'); } };
        },
      },
      {
        token: rollRight,
        useFactory: true,
        dependencies: [rollLeft],
        provider: () => {
          const slot = ${READ};
          return { dispose() { slot.order.push('right'); throw new Error('right'); } };
        },
      },
      {
        token: rollBoom,
        useFactory: true,
        dependencies: [rollRight],
        provider: async () => { throw ${READ}.boom; },
      },
    ],
  });

  export const ownBox = defineBuilderConfig({
    name: 'T06Own',
    injections: [
      { token: aliasObject, useValue: (globalThis as { __t06Alias: { n: number; dispose(): void } }).__t06Alias },
      {
        token: borrowedPort,
        useFactory: true,
        ownership: 'borrowed',
        dependencies: [],
        provider: () => (globalThis as { __t06Alias: { n: number; dispose(): void } }).__t06Alias,
      },
      {
        token: ownedAlias,
        useFactory: true,
        dependencies: [],
        provider: () => (globalThis as { __t06Alias: { n: number; dispose(): void } }).__t06Alias,
      },
      {
        token: ownedPort,
        useFactory: true,
        dependencies: [],
        provider: () => {
          const slot = ${READ};
          slot.ownedBuilds += 1;
          return { n: 3, dispose() { slot.ownedHits += 1; } };
        },
      },
      {
        token: transientPort,
        useFactory: true,
        lifecycle: 'transient',
        dependencies: [],
        provider: () => {
          const slot = ${READ};
          slot.transientBuilds += 1;
          return { n: 4, dispose() { slot.transientHits += 1; } };
        },
      },
      { token: zeroPort, useFactory: true, dependencies: [], provider: () => { ${READ}.hitZero += 1; return 0; } },
      { token: falsePort, useFactory: true, dependencies: [], provider: () => { ${READ}.hitFalse += 1; return false; } },
      { token: blankPort, useFactory: true, dependencies: [], provider: () => { ${READ}.hitBlank += 1; return ''; } },
      { token: nullPort, useFactory: true, dependencies: [], provider: () => { ${READ}.hitNull += 1; return null; } },
      { token: undefPort, useFactory: true, dependencies: [], provider: () => { ${READ}.hitsUndef += 1; return undefined; } },
      { token: mockPort, useFactory: true, dependencies: [], provider: () => ({ n: 5, dispose() { ${READ}.mockDisposals += 1; } }) },
    ],
  });

  export const parent = defineBuilderConfig({
    name: 'T06Parent',
    injections: [
      {
        token: parentPort,
        useFactory: true,
        dependencies: [],
        provider: () => {
          const slot = ${READ};
          return { n: 1, dispose() { slot.parentDisposes += 1; } };
        },
      },
      {
        token: scopePort,
        useFactory: true,
        dependencies: [],
        provider: () => {
          const slot = ${READ};
          slot.scopeSeq += 1;
          return { n: slot.scopeSeq };
        },
      },
    ],
  });

  export const childA = defineBuilderConfig({
    name: 'T06ChildA',
    useContainer: parent,
    injections: [
      {
        token: localA,
        useFactory: true,
        dependencies: [],
        provider: () => ({ n: 1 }),
      },
      {
        token: sharedLocal,
        useFactory: true,
        dependencies: [],
        provider: () => ({ n: 3 }),
      },
      {
        token: childAlias,
        useFactory: true,
        dependencies: [parentPort],
        provider: (ctx) => ctx.resolve(parentPort),
      },
    ],
  });

  export const childB = defineBuilderConfig({
    name: 'T06ChildB',
    useContainer: parent,
    injections: [
      {
        token: localB,
        useFactory: true,
        dependencies: [],
        provider: () => ({ n: 2 }),
      },
      {
        token: sharedLocal,
        useFactory: true,
        dependencies: [],
        provider: () => ({ n: 4 }),
      },
    ],
  });

  export const reentryBox = defineBuilderConfig({
    name: 'T06Reentry',
    injections: [
      {
        token: reSync,
        useFactory: true,
        dependencies: [],
        provider: () => {
          const slot = ${READ};
          slot.calls += 1;
          const box = slot.box;
          if (!box) throw new Error('missing box');
          slot.reentry = box.initialize();
          try {
            box.resolve(slot.other);
            slot.during = 'resolved';
          } catch (error) {
            const code = typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined;
            slot.during = typeof code === 'string' ? code : 'thrown';
          }
          return { n: 1, dispose() { return slot.disposeGate; } };
        },
      },
      {
        token: reAsync,
        useFactory: true,
        dependencies: [reSync],
        provider: async () => {
          await ${READ}.gate;
          return { n: 1 };
        },
      },
    ],
  });

  export const readyBox = defineBuilderConfig({
    name: 'T06Ready',
    injections: [
      {
        token: readyHold,
        useFactory: true,
        dependencies: [],
        provider: async () => ({ n: 1 }),
      },
      {
        token: readyPort,
        useFactory: true,
        dependencies: [],
        provider: () => {
          const slot = ${READ};
          slot.calls += 1;
          const box = slot.box;
          if (!box) throw new Error('missing box');
          slot.reentry = box.initialize();
          return { n: 2 };
        },
      },
    ],
  });

  export const lifeBox = defineBuilderConfig({
    name: 'T06Life',
    injections: [{
      token: lifePort,
      useFactory: true,
      dependencies: [],
      provider: async () => {
        const slot = ${READ};
        slot.constructs += 1;
        if (slot.fail) throw slot.boom;
        await slot.gate;
        return { n: 1, dispose() { slot.disposals += 1; return slot.disposeGate; } };
      },
    }],
  });

  export const lifeMin = defineBuilderConfig({
    name: 'T06LifeMin',
    runtime: { profile: 'minimal' },
    injections: [{
      token: minPort,
      useFactory: true,
      dependencies: [],
      provider: async () => {
        const slot = ${READ};
        slot.constructs += 1;
        if (slot.fail) throw slot.boom;
        await slot.gate;
        return { n: 1, dispose() { slot.disposals += 1; return slot.disposeGate; } };
      },
    }],
  });
`;

interface Slot {
  calls: number;
  disposals: number;
  created: number;
  order: string[];
  gate: Promise<void>;
  disposeGate: Promise<void>;
  openGate: () => void;
  openDispose: () => void;
  fail: boolean;
  boom: Error;
  during: string;
  reentry: Promise<void> | undefined;
  box: Container | undefined;
  other: unknown;
  mocks: number;
  constructs: number;
  mockDisposals: number;
  hitsUndef: number;
  hitZero: number;
  hitFalse: number;
  hitBlank: number;
  hitNull: number;
  aliasHits: number;
  ownedBuilds: number;
  ownedHits: number;
  transientBuilds: number;
  transientHits: number;
  parentDisposes: number;
  scopeSeq: number;
}

interface Settled {
  kind: 'sync' | 'reject' | 'value' | 'pending';
  value: unknown;
  error: unknown;
}

type Op = 'initialize' | 'destroy' | 'createScope' | 'resolve' | 'override' | 'clearOverrides';
type State = 'created' | 'initializing' | 'ready' | 'reconfiguring' | 'failed' | 'destroying' | 'destroyed';
type Delivery = Settled['kind'];

interface Cell {
  readonly op: Op;
  readonly state: State;
  readonly delivery: Delivery;
  readonly code: string;
  readonly failure?: 'self' | 'cause' | 'absent';
}

const FULL: readonly Cell[] = [
  { op: 'initialize', state: 'created', delivery: 'pending', code: '' },
  { op: 'initialize', state: 'initializing', delivery: 'pending', code: '' },
  { op: 'initialize', state: 'ready', delivery: 'value', code: '' },
  { op: 'initialize', state: 'reconfiguring', delivery: 'reject', code: 'NEO_CONTAINER_BUSY' },
  { op: 'initialize', state: 'failed', delivery: 'reject', code: '', failure: 'self' },
  { op: 'initialize', state: 'destroying', delivery: 'reject', code: 'NEO_CONTAINER_DESTROYED' },
  { op: 'initialize', state: 'destroyed', delivery: 'reject', code: 'NEO_CONTAINER_DESTROYED' },
  { op: 'destroy', state: 'created', delivery: 'value', code: '' },
  { op: 'destroy', state: 'initializing', delivery: 'pending', code: '' },
  { op: 'destroy', state: 'ready', delivery: 'value', code: '' },
  { op: 'destroy', state: 'reconfiguring', delivery: 'reject', code: 'NEO_CONTAINER_BUSY' },
  { op: 'destroy', state: 'failed', delivery: 'value', code: '' },
  { op: 'destroy', state: 'destroying', delivery: 'pending', code: '' },
  { op: 'destroy', state: 'destroyed', delivery: 'value', code: '' },
  { op: 'createScope', state: 'created', delivery: 'value', code: '' },
  { op: 'createScope', state: 'initializing', delivery: 'sync', code: 'NEO_CONTAINER_BUSY' },
  { op: 'createScope', state: 'ready', delivery: 'value', code: '' },
  { op: 'createScope', state: 'reconfiguring', delivery: 'sync', code: 'NEO_CONTAINER_BUSY' },
  { op: 'createScope', state: 'failed', delivery: 'sync', code: 'NEO_CONTAINER_FAILED', failure: 'absent' },
  { op: 'createScope', state: 'destroying', delivery: 'sync', code: 'NEO_CONTAINER_DESTROYED' },
  { op: 'createScope', state: 'destroyed', delivery: 'sync', code: 'NEO_CONTAINER_DESTROYED' },
  { op: 'resolve', state: 'created', delivery: 'sync', code: 'NEO_NOT_INITIALIZED' },
  { op: 'resolve', state: 'initializing', delivery: 'sync', code: 'NEO_NOT_INITIALIZED' },
  { op: 'resolve', state: 'ready', delivery: 'value', code: '' },
  { op: 'resolve', state: 'reconfiguring', delivery: 'sync', code: 'NEO_CONTAINER_BUSY' },
  { op: 'resolve', state: 'failed', delivery: 'sync', code: 'NEO_CONTAINER_FAILED', failure: 'cause' },
  { op: 'resolve', state: 'destroying', delivery: 'sync', code: 'NEO_CONTAINER_DESTROYED' },
  { op: 'resolve', state: 'destroyed', delivery: 'sync', code: 'NEO_CONTAINER_DESTROYED' },
  { op: 'override', state: 'created', delivery: 'value', code: '' },
  { op: 'override', state: 'initializing', delivery: 'reject', code: 'NEO_CONTAINER_BUSY' },
  { op: 'override', state: 'ready', delivery: 'value', code: '' },
  { op: 'override', state: 'reconfiguring', delivery: 'reject', code: 'NEO_CONTAINER_BUSY' },
  { op: 'override', state: 'failed', delivery: 'reject', code: 'NEO_CONTAINER_FAILED', failure: 'cause' },
  { op: 'override', state: 'destroying', delivery: 'reject', code: 'NEO_CONTAINER_BUSY' },
  { op: 'override', state: 'destroyed', delivery: 'reject', code: 'NEO_CONTAINER_DESTROYED' },
  { op: 'clearOverrides', state: 'created', delivery: 'value', code: '' },
  { op: 'clearOverrides', state: 'initializing', delivery: 'reject', code: 'NEO_CONTAINER_BUSY' },
  { op: 'clearOverrides', state: 'ready', delivery: 'value', code: '' },
  { op: 'clearOverrides', state: 'reconfiguring', delivery: 'reject', code: 'NEO_CONTAINER_BUSY' },
  { op: 'clearOverrides', state: 'failed', delivery: 'reject', code: 'NEO_CONTAINER_FAILED', failure: 'cause' },
  { op: 'clearOverrides', state: 'destroying', delivery: 'reject', code: 'NEO_CONTAINER_BUSY' },
  { op: 'clearOverrides', state: 'destroyed', delivery: 'reject', code: 'NEO_CONTAINER_DESTROYED' },
];

const MINIMAL: readonly Cell[] = FULL.filter((cell) => (
  cell.op !== 'override' && cell.op !== 'clearOverrides' && cell.state !== 'reconfiguring'
));

const opened: Container[] = [];
const work: Promise<unknown>[] = [];
let loaded: Loaded;
let slot: Slot;

function freshSlot(): Slot {
  const next: Slot = {
    calls: 0,
    disposals: 0,
    created: 0,
    order: [],
    gate: Promise.resolve(),
    disposeGate: Promise.resolve(),
    openGate: () => undefined,
    openDispose: () => undefined,
    fail: false,
    boom: new Error('boom'),
    during: '',
    reentry: undefined,
    box: undefined,
    other: undefined,
    mocks: 0,
    constructs: 0,
    mockDisposals: 0,
    hitsUndef: 0,
    hitZero: 0,
    hitFalse: 0,
    hitBlank: 0,
    hitNull: 0,
    aliasHits: 0,
    ownedBuilds: 0,
    ownedHits: 0,
    transientBuilds: 0,
    transientHits: 0,
    parentDisposes: 0,
    scopeSeq: 0,
  };
  slot = next;
  Reflect.set(globalThis, '__t06', next);
  return next;
}

function arm(which: 'gate' | 'disposeGate'): void {
  let open = (): void => undefined;
  const pending = new Promise<void>((resolve) => {
    open = resolve;
  });
  if (which === 'gate') {
    slot.gate = pending;
    slot.openGate = open;
    return;
  }
  slot.disposeGate = pending;
  slot.openDispose = open;
}

function resetSlot(): void {
  slot.calls = 0;
  slot.disposals = 0;
  slot.created = 0;
  slot.order = [];
  slot.gate = Promise.resolve();
  slot.disposeGate = Promise.resolve();
  slot.openGate = () => undefined;
  slot.openDispose = () => undefined;
  slot.fail = false;
  slot.boom = new Error('boom');
  slot.during = '';
  slot.reentry = undefined;
  slot.mocks = 0;
  slot.constructs = 0;
  slot.mockDisposals = 0;
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function settle(run: () => unknown): Promise<Settled> {
  let returned: unknown;
  try {
    returned = run();
  } catch (error) {
    return { kind: 'sync', value: undefined, error };
  }
  if (returned === null || typeof returned !== 'object' || !('then' in returned)) {
    return { kind: 'value', value: returned, error: undefined };
  }
  const thenable = returned as Promise<unknown>;
  let kind: Settled['kind'] = 'pending';
  let value: unknown;
  let error: unknown;
  void thenable.then(
    (next) => {
      kind = 'value';
      value = next;
    },
    (next: unknown) => {
      kind = 'reject';
      error = next;
    },
  );
  await flush();
  return { kind, value, error };
}

function remember(job: Promise<unknown>): Promise<unknown> {
  work.push(job);
  return job;
}

function openNamed(name: string, options?: OpenOptions): Container {
  const container = loaded.open(name, options).container;
  opened.push(container);
  return container;
}

function readN(value: unknown): number {
  if (typeof value !== 'object' || value === null) return -1;
  const n = Reflect.get(value, 'n');
  return typeof n === 'number' ? n : -1;
}

function causeOf(error: unknown): unknown {
  if (typeof error !== 'object' || error === null) return undefined;
  return Reflect.get(error, 'cause');
}

function cleanupOf(error: unknown): unknown[] {
  if (typeof error !== 'object' || error === null) return [];
  const value = Reflect.get(error, 'cleanupErrors');
  return Array.isArray(value) ? value : [];
}

function journalOf(container: Container): unknown[] {
  const value = Reflect.get(container, '_initJournal');
  return Array.isArray(value) ? value : [];
}

function isContainer(value: unknown): value is Container {
  return typeof value === 'object'
    && value !== null
    && typeof Reflect.get(value, 'destroy') === 'function'
    && typeof Reflect.get(value, 'resolve') === 'function';
}

async function rejected(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('T06 lifecycle runtime', () => {
  beforeAll(() => {
    loaded = loadSource(SOURCE);
  });

  afterEach(async () => {
    const current = Reflect.get(globalThis, '__t06');
    if (typeof current === 'object' && current !== null) {
      const openGate = Reflect.get(current, 'openGate');
      const openDispose = Reflect.get(current, 'openDispose');
      if (typeof openGate === 'function') openGate();
      if (typeof openDispose === 'function') openDispose();
    }
    await Promise.all(work.splice(0).map((job) => Promise.resolve(job).then(() => undefined, () => undefined)));
    for (const container of opened.splice(0).reverse()) {
      try {
        await container.destroy();
      } catch {
        // The test may already have closed this container.
      }
    }
    Reflect.deleteProperty(globalThis, '__t06');
    Reflect.deleteProperty(globalThis, '__t06Alias');
  });

  it('L1 shared initialize', async () => {
    for (const emitter of EMITTERS) {
      freshSlot();
      arm('gate');
      const once = openNamed('onceBox', { emitter });
      const onceToken = loaded.token(loaded.graph('onceBox'), 'OncePort');
      const first = once.initialize();
      const second = once.initialize();
      remember(first);
      remember(second);
      expect(slot.calls, emitter).toBe(1);
      const pending = await settle(() => first);
      const pendingSecond = await settle(() => second);
      expect(pending.kind, emitter).toBe('pending');
      expect(pendingSecond.kind, emitter).toBe('pending');
      slot.openGate();
      await first;
      await second;
      const created = once.resolve(onceToken);
      expect(once.resolve(onceToken), emitter).toBe(created);
      expect(readN(created), emitter).toBe(1);
      expect(slot.calls, emitter).toBe(1);

      freshSlot();
      arm('gate');
      const fail = openNamed('failBox', { emitter });
      const boomToken = loaded.token(loaded.graph('failBox'), 'BoomPort');
      const failed = fail.initialize();
      const joined = fail.initialize();
      remember(failed);
      remember(joined);
      slot.openGate();
      expect(await rejected(() => failed), emitter).toBe(slot.boom);
      expect(await rejected(() => joined), emitter).toBe(slot.boom);
      expect(slot.disposals, emitter).toBe(1);
      const refused = await settle(() => fail.resolve(boomToken));
      expect(refused.kind, emitter).toBe('sync');
      expect(errorCode(refused.error), emitter).toBe('NEO_CONTAINER_FAILED');
      expect(causeOf(refused.error), emitter).toBe(slot.boom);
    }
  });

  it('L2 shared destroy', async () => {
    for (const emitter of EMITTERS) {
      freshSlot();
      const join = openNamed('joinBox', { emitter });
      const token = loaded.token(loaded.graph('joinBox'), 'JoinPort');
      await join.initialize();
      join.resolve(token);
      arm('disposeGate');
      const first = join.destroy();
      const second = join.destroy();
      remember(first);
      expect(second, emitter).toBe(first);
      await flush();
      expect(slot.disposals, emitter).toBe(1);
      const pending = await settle(() => first);
      expect(pending.kind, emitter).toBe('pending');
      slot.openDispose();
      await first;
      expect(slot.disposals, emitter).toBe(1);
      const refused = await settle(() => join.resolve(token));
      expect(refused.kind, emitter).toBe('sync');
      expect(errorCode(refused.error), emitter).toBe('NEO_CONTAINER_DESTROYED');
      const again = await settle(() => join.destroy());
      expect(again.kind, emitter).toBe('value');
      expect(slot.disposals, emitter).toBe(1);
    }
  });

  it('L3 late resource', async () => {
    for (const emitter of EMITTERS) {
      freshSlot();
      arm('gate');
      const late = openNamed('lateBox', { emitter });
      const lateToken = loaded.token(loaded.graph('lateBox'), 'LatePort');
      const init = late.initialize();
      remember(init);
      await flush();
      expect(slot.created, emitter).toBe(0);
      const closing = late.destroy();
      remember(closing);
      const early = await settle(() => closing);
      expect(early.kind, emitter).toBe('pending');
      slot.openGate();
      await expect(init, emitter).resolves.toBeUndefined();
      await closing;
      expect(slot.created, emitter).toBe(1);
      expect(slot.disposals, emitter).toBe(1);
      expect(journalOf(late), emitter).toContain(lateToken);
    }
  });

  it('L4 dispose errors', async () => {
    for (const emitter of EMITTERS) {
      freshSlot();
      const agg = openNamed('aggBox', { emitter });
      agg.resolve(loaded.token(loaded.graph('aggBox'), 'AggLeft'));
      agg.resolve(loaded.token(loaded.graph('aggBox'), 'AggRight'));
      const aggregate = await rejected(() => agg.destroy());
      expect(aggregate, emitter).toBeInstanceOf(AggregateError);
      expect(aggregate instanceof AggregateError ? aggregate.errors : [], emitter).toHaveLength(2);
      expect([...slot.order].sort(), emitter).toEqual(['left', 'right']);

      freshSlot();
      arm('gate');
      const roll = openNamed('rollBox', { emitter });
      const failed = roll.initialize();
      remember(failed);
      slot.openGate();
      const wrapped = await rejected(() => failed);
      expect(wrapped, emitter).toBeInstanceOf(Error);
      expect(wrapped instanceof Error ? wrapped.message : '', emitter).toBe(slot.boom.message);
      expect(causeOf(wrapped), emitter).toBe(slot.boom);
      expect(cleanupOf(wrapped), emitter).toHaveLength(2);
      expect([...slot.order].sort(), emitter).toEqual(['left', 'right']);
    }
  });

  it('L5 ownership', async () => {
    for (const emitter of EMITTERS) {
      freshSlot();
      const alias = { n: 1, dispose() { slot.aliasHits += 1; } };
      Reflect.set(globalThis, '__t06Alias', alias);
      const own = openNamed('ownBox', { emitter, testOverrides: true });
      const graph = loaded.graph('ownBox');
      expect(own.resolve(loaded.token(graph, 'AliasObject')), emitter).toBe(alias);
      expect(own.resolve(loaded.token(graph, 'BorrowedPort')), emitter).toBe(alias);
      expect(own.resolve(loaded.token(graph, 'OwnedAlias')), emitter).toBe(alias);
      expect(own.resolve(loaded.token(graph, 'ZeroPort')), emitter).toBe(0);
      expect(own.resolve(loaded.token(graph, 'FalsePort')), emitter).toBe(false);
      expect(own.resolve(loaded.token(graph, 'BlankPort')), emitter).toBe('');
      expect(own.resolve(loaded.token(graph, 'NullPort')), emitter).toBeNull();
      expect(own.resolve(loaded.token(graph, 'FalsePort')), emitter).toBe(false);
      expect(own.resolve(loaded.token(graph, 'BlankPort')), emitter).toBe('');
      expect(own.resolve(loaded.token(graph, 'NullPort')), emitter).toBeNull();
      const undefToken = loaded.token(graph, 'UndefPort');
      let undefMiss = '';
      let undefValue: unknown = 'missing';
      try {
        undefValue = own.resolve(undefToken);
      } catch (error) {
        undefMiss = errorCode(error);
      }
      expect(undefMiss, emitter).toBe('');
      expect(undefValue, emitter).toBeUndefined();
      expect(own.resolve(undefToken), emitter).toBeUndefined();
      expect(slot.hitsUndef, emitter).toBe(1);
      expect(slot.hitZero, emitter).toBe(1);
      expect(slot.hitFalse, emitter).toBe(1);
      expect(slot.hitBlank, emitter).toBe(1);
      expect(slot.hitNull, emitter).toBe(1);
      own.resolve(loaded.token(graph, 'ZeroPort'));
      expect(slot.hitZero, emitter).toBe(1);
      own.resolve(loaded.token(graph, 'TransientPort'));
      own.resolve(loaded.token(graph, 'TransientPort'));
      expect(slot.transientBuilds, emitter).toBe(2);
      own.resolve(loaded.token(graph, 'OwnedPort'));
      own.resolve(loaded.token(graph, 'OwnedPort'));
      expect(slot.ownedBuilds, emitter).toBe(1);
      const mock = { n: 8, dispose() { slot.mockDisposals += 1; } };
      await own.override(loaded.token(graph, 'MockPort'), () => {
        slot.mocks += 1;
        return mock;
      });
      expect(own.resolve(loaded.token(graph, 'MockPort')), emitter).toBe(mock);
      expect(slot.mocks, emitter).toBe(1);
      await own.destroy();
      expect(slot.aliasHits, emitter).toBe(0);
      expect(slot.mockDisposals, emitter).toBe(0);
      expect(slot.transientHits, emitter).toBe(0);
      expect(slot.ownedHits, emitter).toBe(1);
      await own.destroy();
      expect(slot.ownedHits, emitter).toBe(1);

      const parentBox = openNamed('parent', { emitter });
      const parentToken = loaded.token(loaded.graph('parent'), 'ParentPort');
      const parentValue = parentBox.resolve(parentToken);
      const child = openNamed('childA', {
        emitter,
        parent: parentBox,
        prelude: `const parentPort = ${JSON.stringify(parentToken)};`,
      });
      expect(child.resolve(loaded.token(loaded.graph('childA'), 'ChildAlias')), emitter).toBe(parentValue);
      await child.destroy();
      expect(slot.parentDisposes, emitter).toBe(0);
    }
  });

  it('L6 parent and scopes', async () => {
    for (const emitter of EMITTERS) {
      freshSlot();
      const parentBox = openNamed('parent', { emitter });
      const parentGraph = loaded.graph('parent');
      const parentToken = loaded.token(parentGraph, 'ParentPort');
      const scopeToken = loaded.token(parentGraph, 'ScopePort');
      const root = parentBox.resolve(parentToken);
      const rootScope = parentBox.resolve(scopeToken);
      const scopeA = parentBox.createScope();
      const scopeB = parentBox.createScope();
      opened.push(scopeA, scopeB);
      const localScopeA = scopeA.resolve(scopeToken);
      const localScopeB = scopeB.resolve(scopeToken);
      expect(localScopeA, emitter).not.toBe(localScopeB);
      expect(localScopeA, emitter).not.toBe(rootScope);
      expect(localScopeB, emitter).not.toBe(rootScope);
      await scopeA.destroy();
      await scopeB.destroy();
      expect(slot.parentDisposes, emitter).toBe(0);

      const childOne = openNamed('childA', {
        emitter,
        parent: parentBox,
        prelude: `const parentPort = ${JSON.stringify(parentToken)};`,
      });
      const childTwo = openNamed('childB', { emitter, parent: parentBox });
      const sharedA = loaded.token(loaded.graph('childA'), 'SharedLocal');
      const sharedB = loaded.token(loaded.graph('childB'), 'SharedLocal');
      expect(sharedA, emitter).toBe(sharedB);
      const localOne = childOne.resolve(sharedA);
      expect(childOne.resolve(sharedA), emitter).toBe(localOne);
      const localTwo = childTwo.resolve(sharedB);
      expect(localTwo, emitter).not.toBe(localOne);
      expect(childOne.resolve(parentToken), emitter).toBe(root);
      expect(childTwo.resolve(parentToken), emitter).toBe(root);
      expect(childOne.resolve(loaded.token(loaded.graph('childA'), 'ChildAlias')), emitter).toBe(root);
      await childOne.destroy();
      expect(slot.parentDisposes, emitter).toBe(0);
      await parentBox.destroy();
      const refused = await settle(() => childTwo.resolve(loaded.token(loaded.graph('childB'), 'LocalB')));
      expect(refused.kind, emitter).toBe('sync');
      expect(errorCode(refused.error), emitter).toBe('NEO_SCOPE_PARENT_DESTROYED');
    }
  });

  it('L7 re-entrant initialize', async () => {
    for (const emitter of EMITTERS) {
      freshSlot();
      arm('gate');
      const box = openNamed('reentryBox', { emitter, testOverrides: true });
      const graph = loaded.graph('reentryBox');
      const syncToken = loaded.token(graph, 'ReSync');
      const asyncToken = loaded.token(graph, 'ReAsync');
      slot.box = box;
      slot.other = asyncToken;
      const init = box.initialize();
      remember(init);
      await flush();
      const reentry = await settle(() => slot.reentry);
      expect(reentry.kind, emitter).toBe('reject');
      expect(errorCode(reentry.error), emitter).toBe('NEO_CONTAINER_BUSY');
      expect(slot.during, emitter).toBe('NEO_NOT_INITIALIZED');
      expect(slot.calls, emitter).toBe(1);
      const blocked = await settle(() => box.override(syncToken, () => {
        slot.mocks += 1;
        return { n: 9 };
      }));
      expect(blocked.kind, emitter).toBe('reject');
      expect(errorCode(blocked.error), emitter).toBe('NEO_CONTAINER_BUSY');
      expect(slot.mocks, emitter).toBe(0);
      slot.openGate();
      await init;
      const created = box.resolve(asyncToken);
      expect(box.resolve(asyncToken), emitter).toBe(created);
      expect(readN(created), emitter).toBe(1);
      const scope = box.createScope();
      opened.push(scope);
      await scope.initialize();
      expect(readN(scope.resolve(syncToken)), emitter).toBe(1);
      expect(slot.mocks, emitter).toBe(0);

      arm('disposeGate');
      const override = box.override(syncToken, () => {
        slot.mocks += 1;
        return { n: 7 };
      });
      remember(override);
      const clear = await settle(() => box.clearOverrides());
      expect(clear.kind, emitter).toBe('reject');
      expect(errorCode(clear.error), emitter).toBe('NEO_CONTAINER_BUSY');
      slot.openDispose();
      await override;
      const mid = await settle(() => box.resolve(syncToken));
      expect(mid.kind, emitter).toBe('sync');
      expect(errorCode(mid.error), emitter).toBe('NEO_NOT_INITIALIZED');
      await box.initialize();
      expect(readN(box.resolve(syncToken)), emitter).toBe(7);
      expect(slot.mocks, emitter).toBe(1);
    }
  });

  it('L7b ready factory initialize resolves', async () => {
    for (const emitter of EMITTERS) {
      freshSlot();
      const box = openNamed('readyBox', { emitter });
      const token = loaded.token(loaded.graph('readyBox'), 'ReadyPort');
      await box.initialize();
      slot.box = box;
      expect(readN(box.resolve(token)), emitter).toBe(2);
      expect(slot.calls, emitter).toBe(1);
      const rootInit = await settle(() => slot.reentry);
      expect(rootInit.kind, emitter).toBe('value');
      expect(errorCode(rootInit.error), emitter).toBe('');

      const scope = box.createScope();
      opened.push(scope);
      await scope.initialize();
      slot.box = scope;
      expect(readN(scope.resolve(token)), emitter).toBe(2);
      expect(slot.calls, emitter).toBe(2);
      const scopeInit = await settle(() => slot.reentry);
      expect(scopeInit.kind, emitter).toBe('value');
      expect(errorCode(scopeInit.error), emitter).toBe('');
    }
  });

  it('L8 destroy during reconfiguration', async () => {
    for (const emitter of EMITTERS) {
      freshSlot();
      const life = openNamed('lifeBox', { emitter, testOverrides: true });
      const token = loaded.token(loaded.graph('lifeBox'), 'LifePort');
      await life.initialize();
      expect(readN(life.resolve(token)), emitter).toBe(1);
      arm('disposeGate');
      const override = life.override(token, () => {
        slot.mocks += 1;
        return { n: 2, dispose() { slot.mockDisposals += 1; } };
      });
      remember(override);
      await flush();
      expect(slot.disposals, emitter).toBe(1);
      const closing = await settle(() => life.destroy());
      expect(closing.kind, emitter).toBe('reject');
      expect(errorCode(closing.error), emitter).toBe('NEO_CONTAINER_BUSY');
      const during = await settle(() => life.resolve(token));
      expect(during.kind, emitter).toBe('sync');
      expect(errorCode(during.error), emitter).toBe('NEO_CONTAINER_BUSY');
      slot.openDispose();
      await override;
      const after = await settle(() => life.resolve(token));
      expect(after.kind, emitter).toBe('sync');
      expect(errorCode(after.error), emitter).toBe('NEO_NOT_INITIALIZED');
      await life.initialize();
      expect(readN(life.resolve(token)), emitter).toBe(2);
      expect(slot.mocks, emitter).toBe(1);
      await life.destroy();
      expect(slot.disposals, emitter).toBe(1);
      expect(slot.mockDisposals, emitter).toBe(0);
      const refused = await settle(() => life.resolve(token));
      expect(refused.kind, emitter).toBe('sync');
      expect(errorCode(refused.error), emitter).toBe('NEO_CONTAINER_DESTROYED');
      const again = await settle(() => life.destroy());
      expect(again.kind, emitter).toBe('value');
      expect(slot.disposals, emitter).toBe(1);
      expect(slot.mocks, emitter).toBe(1);
    }
  });

  it('L9 operation table', async () => {
    for (const emitter of EMITTERS) {
      await runTable(emitter, 'full', 'lifeBox', 'LifePort', FULL, 'scope');
      await runTable(emitter, 'minimal', 'lifeMin', 'MinPort', MINIMAL, 'scope');
      await runTable(emitter, 'full', 'lifeBox', 'LifePort', FULL, 'root');
      await runTable(emitter, 'minimal', 'lifeMin', 'MinPort', MINIMAL, 'root');
    }
  }, 120_000);

  it('L11 sync factory omits the reentry counter', () => {
    for (const emitter of EMITTERS) {
      const sync = loaded.open('ownBox', { emitter });
      expect(sync.source, emitter).not.toContain('this._syncInit += 1');
      const asyncBox = loaded.open('onceBox', { emitter });
      expect(asyncBox.source, emitter).toContain('this._syncInit += 1');
      expect(asyncBox.source, emitter).toContain('this._syncInit -= 1');
    }
  });
});

async function runTable(
  emitter: Emitter,
  profile: 'full' | 'minimal',
  graphName: string,
  tokenName: string,
  table: readonly Cell[],
  host: 'root' | 'scope',
): Promise<void> {
  freshSlot();
  const token = loaded.token(loaded.graph(graphName), tokenName);
  const shared = host === 'scope'
    ? openNamed(graphName, { emitter, testOverrides: profile === 'full' })
    : undefined;
  for (const cell of table) {
    resetSlot();
    const container = shared !== undefined
      ? shared.createScope()
      : openNamed(graphName, { emitter, testOverrides: profile === 'full' });
    if (shared !== undefined) opened.push(container);
    const jobs: Promise<unknown>[] = [];
    const keep = (job: Promise<unknown>): Promise<unknown> => {
      jobs.push(job);
      remember(job);
      return job;
    };
    try {
      await reach(container, token, cell.state, keep);
      const settled = await probe(container, token, cell, keep);
      if (cell.op === 'createScope' && isContainer(settled.value)) opened.push(settled.value);
      expectCell(settled, cell, `${host} ${profile} ${emitter} ${cell.op} ${cell.state}`);
    } finally {
      slot.openGate();
      slot.openDispose();
      await Promise.all(jobs.map((job) => Promise.resolve(job).then(() => undefined, () => undefined)));
    }
  }
}

async function reach(
  container: Container,
  token: string,
  state: State,
  keep: (job: Promise<unknown>) => Promise<unknown>,
): Promise<void> {
  if (state === 'created') {
    arm('gate');
    return;
  }
  if (state === 'initializing') {
    arm('gate');
    keep(container.initialize());
    return;
  }
  if (state === 'failed') {
    slot.fail = true;
    await keep(container.initialize()).catch(() => undefined);
    return;
  }
  await keep(container.initialize());
  container.resolve(token);
  if (state === 'ready') return;
  if (state === 'destroyed') {
    await keep(container.destroy());
    return;
  }
  arm('disposeGate');
  if (state === 'reconfiguring') {
    keep(container.override(token, () => ({ n: 2 })));
    return;
  }
  keep(container.destroy());
}

async function probe(
  container: Container,
  token: string,
  cell: Cell,
  keep: (job: Promise<unknown>) => Promise<unknown>,
): Promise<Settled> {
  if (cell.op === 'initialize') return settle(() => keep(container.initialize()));
  if (cell.op === 'destroy') return settle(() => keep(container.destroy()));
  if (cell.op === 'createScope') return settle(() => container.createScope());
  if (cell.op === 'resolve') return settle(() => container.resolve(token));
  if (cell.op === 'override') return settle(() => keep(container.override(token, () => ({ n: 2 }))));
  return settle(() => keep(container.clearOverrides()));
}

function expectCell(settled: Settled, cell: Cell, label: string): void {
  expect(settled.kind, label).toBe(cell.delivery);
  if (cell.failure === 'self') {
    expect(settled.error, label).toBe(slot.boom);
    return;
  }
  if (cell.delivery === 'value') {
    if (cell.op === 'resolve') expect(readN(settled.value), label).toBe(1);
    return;
  }
  if (cell.delivery === 'pending') return;
  expect(errorCode(settled.error), label).toBe(cell.code);
  if (cell.failure === 'cause') expect(causeOf(settled.error), label).toBe(slot.boom);
  if (cell.failure === 'absent') expect(causeOf(settled.error), label).toBeUndefined();
}
