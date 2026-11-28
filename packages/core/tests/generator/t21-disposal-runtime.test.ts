import { describe, expect, it } from 'vitest';
import {
  FULL_CELLS,
  MATRIX,
  buildCell,
  call,
  capabilitySymbol,
  destroyFailure,
  envOf,
  errorsOf,
  label,
  messages,
  readKey,
  withCell,
  type Env,
  type Parts,
} from '../helpers/t21-build';
import { createScope, failure, thrown, use } from '../helpers/e18-build';

/**
 * T21 at runtime: the standard disposal protocols, on the two emitters, full and minimal, open and closed. Every test
 * starts with `capabilitySymbol` (the analysis knows the class is a symbol disposer), then reads what a user observes:
 * what a disposal logs, counts, rejects with. The containers are reached through `Reflect` on `unknown`.
 */

const NOT_CALLABLE = 'disposal protocol must be callable';

function resolveAll(env: Env, ...names: string[]): unknown[] {
  return names.map((name) => env.read(env.token(name)));
}

function sorted(entries: readonly string[]): string[] {
  return [...entries].sort();
}

const PRIORITY: Parts = {
  declarations: `
export class All {
  dispose(): void { log('all:legacy'); }
  async [Symbol.asyncDispose](): Promise<void> { log('all:async'); }
  [Symbol.dispose](): void { log('all:sync'); }
}
export class Mixed {
  async [Symbol.asyncDispose](): Promise<void> { log('mixed:async'); }
  [Symbol.dispose](): void { log('mixed:sync'); }
}
export class Plain { [Symbol.dispose](): void { log('plain:sync'); } }
`,
  injections: '{ token: All }, { token: Mixed }, { token: Plain },',
  roots: '[All, Mixed, Plain]',
};

describe('T21-P1 D1 dispose() first, then Symbol.asyncDispose, then Symbol.dispose', () => {
  for (const cell of MATRIX) {
    it(`T21-P1 ${label(cell)}: a class with three methods runs dispose(), one with two runs asyncDispose, one with one runs it`, () =>
      withCell(cell, PRIORITY, async (env) => {
        capabilitySymbol(env.built, 'Mixed');
        capabilitySymbol(env.built, 'Plain');
        resolveAll(env, 'All', 'Mixed', 'Plain');
        await call(env.box, 'destroy');
        expect(sorted(env.log())).toEqual(['all:legacy', 'mixed:async', 'plain:sync']);
      }));
  }
});

const RECEIVER: Parts = {
  declarations: `
export class Base { tag = 'a'; [Symbol.dispose](): void { log('tag:' + this.tag); probe.saved.push(this); } }
export class Child extends Base {}
export class LegacyBase { tag = 'b'; dispose(): void { log('tag:' + this.tag); probe.saved.push(this); } }
export class LegacyChild extends LegacyBase {}
export class AsyncBase { tag = 'c'; async [Symbol.asyncDispose](): Promise<void> { log('tag:' + this.tag); probe.saved.push(this); } }
export class AsyncChild extends AsyncBase {}
`,
  injections: '{ token: Child }, { token: LegacyChild }, { token: AsyncChild },',
  roots: '[Child, LegacyChild, AsyncChild]',
};

describe('T21-P2 D1 an inherited method runs on the instance itself', () => {
  for (const cell of MATRIX) {
    it(`T21-P2 ${label(cell)}: the three inherited protocols read this.tag of the instance the container built`, () =>
      withCell(cell, RECEIVER, async (env) => {
        capabilitySymbol(env.built, 'Child');
        capabilitySymbol(env.built, 'AsyncChild');
        const instances = resolveAll(env, 'Child', 'LegacyChild', 'AsyncChild');
        await call(env.box, 'destroy');
        expect(sorted(env.log())).toEqual(['tag:a', 'tag:b', 'tag:c']);
        expect(env.built.probe.saved).toHaveLength(3);
        for (const instance of instances) expect(env.built.probe.saved).toContain(instance);
      }));
  }
});

const ONCE: Parts = {
  declarations: `
export class Pair {
  tag = 'own';
  async [Symbol.asyncDispose](): Promise<void> { bump('pair:' + this.tag); }
  [Symbol.dispose](): void { bump('pair:' + this.tag); }
}
interface FirstPort extends Pair {}
interface SecondPort extends Pair {}
interface AliasPort extends Pair {}
const shared = Object.assign(new Pair(), { tag: 'shared' });
const first = useInterface<FirstPort>();
const second = useInterface<SecondPort>();
const alias = useInterface<AliasPort>();
`,
  injections: `{ token: Pair },
    { token: first, useFactory: true, dependencies: [], provider: () => shared },
    { token: second, useFactory: true, dependencies: [], provider: () => shared },
    { token: alias, useExisting: first },`,
  roots: '[Pair, first, second, alias]',
};

describe('T21-P3 D1 one method, called once, per instance', () => {
  for (const cell of MATRIX) {
    it(`T21-P3 ${label(cell)}: an instance behind two factory tokens and an alias is released once, with one of its two protocols`, () =>
      withCell(cell, ONCE, async (env) => {
        capabilitySymbol(env.built, 'Pair');
        env.read(env.token('Pair'));
        for (const name of ['FirstPort', 'SecondPort', 'AliasPort']) env.read(env.built.id(name));
        await call(env.box, 'destroy');
        expect(env.count('pair:shared')).toBe(1);
        expect(env.count('pair:own')).toBe(1);
      }));
  }
});

const BROKEN: Parts = {
  declarations: `
export class Sibling { [Symbol.dispose](): void { log('sibling'); } }
interface Broken { id: string }
const broken = useInterface<Broken>();
`,
  injections: `{ token: Sibling },
    { token: broken, useFactory: true, dependencies: [], provider: () => ({ id: 'broken', [Symbol.dispose]: 42 }) },`,
  roots: '[Sibling, broken]',
};

describe('T21-P4 D2 a protocol that is not callable is refused, the other resources are still released', () => {
  for (const cell of MATRIX) {
    it(`T21-P4 ${label(cell)}: destroy rejects an AggregateError that holds a TypeError, and the sibling is disposed`, () =>
      withCell(cell, BROKEN, async (env) => {
        capabilitySymbol(env.built, 'Sibling');
        env.read(env.token('Sibling'));
        env.read(env.built.id('Broken'));
        const rejected = await destroyFailure(env.box);
        expect(rejected).toBeInstanceOf(AggregateError);
        const first = errorsOf(rejected)[0];
        expect(first).toBeInstanceOf(TypeError);
        expect(messages([first])).toEqual([NOT_CALLABLE]);
        expect(env.log()).toEqual(['sibling']);
      }));
  }
});

const SETTLE_HEAD = `
const gate = (): Promise<void> => new Promise<void>((resolve) => { probe.saved.push(resolve); });
const refuse = async (key: string): Promise<void> => { await Promise.resolve(); throw new Error('refused:' + key); };
const refused = (key: string): Promise<void> => { const work = refuse(key); work.catch(() => undefined); return work; };
`;

const SETTLE_SYMBOL: Parts = {
  declarations: `${SETTLE_HEAD}
export class GateSymbol { [Symbol.dispose]: () => void = () => gate().then(() => bump('settled:symbol')); }
export class RefusesSymbol { [Symbol.dispose]: () => void = () => refused('symbol'); }
`,
  injections: '{ token: GateSymbol }, { token: RefusesSymbol },',
  roots: '[GateSymbol, RefusesSymbol]',
};

/** No class of this container has a symbol disposer: its disposal slots are all `dispose()` ones. */
const SETTLE_LEGACY: Parts = {
  declarations: `${SETTLE_HEAD}
export class GateLegacy { dispose: () => void = () => gate().then(() => bump('settled:legacy')); }
export class RefusesLegacy { dispose: () => void = () => refused('legacy'); }
`,
  injections: '{ token: GateLegacy }, { token: RefusesLegacy },',
  roots: '[GateLegacy, RefusesLegacy]',
};

/** Starts destroy, lets the microtasks run, and reports whether it was still waiting; then opens every gate. */
async function destroyWhileGated(env: Env): Promise<{ waited: boolean; done: Promise<unknown> }> {
  let finished = false;
  const done = destroyFailure(env.box).then((outcome) => {
    finished = true;
    return outcome;
  });
  for (let turn = 0; turn < 25; turn += 1) await Promise.resolve();
  const waited = !finished;
  for (const open of env.built.probe.saved) {
    if (typeof open === 'function') Reflect.apply(open, undefined, []);
  }
  return { waited, done };
}

describe('T21-P5 D2 a promise returned by the chosen disposer is awaited, even when its type says void', () => {
  for (const cell of MATRIX) {
    it(`T21-P5 ${label(cell)}: destroy waits for the promise [Symbol.dispose] returned`, () =>
      withCell(cell, SETTLE_SYMBOL, async (env) => {
        capabilitySymbol(env.built, 'GateSymbol');
        resolveAll(env, 'GateSymbol');
        const { waited, done } = await destroyWhileGated(env);
        expect(waited, 'destroy was still waiting for the promise').toBe(true);
        expect(await done).toBeUndefined();
        expect(env.count('settled:symbol')).toBe(1);
      }));

    it(`T21-P5 ${label(cell)}: destroy waits for the promise a dispose() typed void returned`, () =>
      withCell(cell, SETTLE_LEGACY, async (env) => {
        resolveAll(env, 'GateLegacy');
        const { waited, done } = await destroyWhileGated(env);
        expect(waited, 'destroy was still waiting for the promise').toBe(true);
        expect(await done).toBeUndefined();
        expect(env.count('settled:legacy')).toBe(1);
      }));

    it(`T21-P5 ${label(cell)}: a rejection of the promise [Symbol.dispose] returned reaches destroy`, () =>
      withCell(cell, SETTLE_SYMBOL, async (env) => {
        capabilitySymbol(env.built, 'RefusesSymbol');
        resolveAll(env, 'RefusesSymbol');
        const rejected = await destroyFailure(env.box);
        expect(rejected).toBeInstanceOf(AggregateError);
        expect(messages(errorsOf(rejected))).toEqual(['refused:symbol']);
      }));

    it(`T21-P5 ${label(cell)}: a rejection of the promise a dispose() typed void returned reaches destroy`, () =>
      withCell(cell, SETTLE_LEGACY, async (env) => {
        resolveAll(env, 'RefusesLegacy');
        const rejected = await destroyFailure(env.box);
        expect(rejected).toBeInstanceOf(AggregateError);
        expect(messages(errorsOf(rejected))).toEqual(['refused:legacy']);
      }));
  }
});

const MANY_ERRORS: Parts = {
  declarations: `
export class LegacyBoom { dispose(): void { throw new Error('legacy'); } }
export class AsyncBoom { async [Symbol.asyncDispose](): Promise<void> { await Promise.resolve(); throw new Error('async'); } }
export class SyncBoom { [Symbol.dispose](): void { throw new Error('sync'); } }
export class Fine { [Symbol.dispose](): void { log('fine'); } }
`,
  injections: '{ token: LegacyBoom }, { token: AsyncBoom }, { token: SyncBoom }, { token: Fine },',
  roots: '[LegacyBoom, AsyncBoom, SyncBoom, Fine]',
};

describe('T21-P6 D2 every failure is reported together and the cleanup goes on', () => {
  for (const cell of MATRIX) {
    it(`T21-P6 ${label(cell)}: three failing disposers give one AggregateError of three errors, the fourth resource is released`, () =>
      withCell(cell, MANY_ERRORS, async (env) => {
        capabilitySymbol(env.built, 'AsyncBoom');
        resolveAll(env, 'LegacyBoom', 'AsyncBoom', 'SyncBoom', 'Fine');
        const rejected = await destroyFailure(env.box);
        expect(rejected).toBeInstanceOf(AggregateError);
        expect(sorted(messages(errorsOf(rejected)))).toEqual(['async', 'legacy', 'sync']);
        expect(env.log()).toEqual(['fine']);
      }));
  }
});

const BORROWED: Parts = {
  declarations: `
interface Res { [Symbol.dispose](): void }
interface ValueRes extends Res {}
interface BorrowedRes extends Res {}
interface AliasRes extends Res {}
const resource = (name: string): Res => ({ [Symbol.dispose](): void { log('disposed:' + name); } });
export class Owned { [Symbol.dispose](): void { log('disposed:owned'); } }
const valueToken = useInterface<ValueRes>();
const borrowedToken = useInterface<BorrowedRes>();
const aliasToken = useInterface<AliasRes>();
`,
  injections: `{ token: Owned },
    { token: valueToken, useValue: resource('value') },
    { token: borrowedToken, useFactory: true, dependencies: [], ownership: 'borrowed', provider: () => resource('borrowed') },
    { token: aliasToken, useExisting: valueToken },`,
  roots: '[Owned, valueToken, borrowedToken, aliasToken]',
};

/** `shared` is a factory of the child that answers the parent's resource: the child has a slot for it, and the value is borrowed. */
const WITH_PARENT: Parts = {
  declarations: `export class Owned { [Symbol.dispose](): void { log('disposed:owned'); } }
export class Holder { constructor(readonly parentRes: ParentRes) {} }
interface Shared { [Symbol.dispose](): void }
const shared = useInterface<Shared>();`,
  before: `export class ParentRes { [Symbol.dispose](): void { log('disposed:parent'); } }
export const parent = defineBuilderConfig({ name: 'T21Parent', injections: [{ token: ParentRes }] });`,
  options: 'useContainer: parent,',
  injections: `{ token: Owned }, { token: Holder },
    { token: shared, useFactory: true, dependencies: [ParentRes], provider: (ctx) => ctx.resolve(ParentRes) },`,
  roots: '[Owned, Holder, shared]',
};

const WITH_INPUT: Parts = {
  declarations: `
interface InputRes { [Symbol.dispose](): void }
const input = useInterface<InputRes>();
export class UsesInput { constructor(readonly res: InputRes) {} [Symbol.dispose](): void { log('disposed:usesInput'); } }
`,
  options: 'scopeInputs: [input],',
  injections: '{ token: UsesInput },',
  roots: '[UsesInput]',
};

describe('T21-P7 D6 a value that is borrowed is never disposed, an owned one is disposed once', () => {
  for (const cell of MATRIX) {
    it(`T21-P7 ${label(cell)}: useValue, a borrowed factory and an alias of a value stay open; the owned singleton is disposed once`, () =>
      withCell(cell, BORROWED, async (env) => {
        capabilitySymbol(env.built, 'Owned');
        env.read(env.token('Owned'));
        for (const name of ['ValueRes', 'BorrowedRes', 'AliasRes']) env.read(env.built.id(name));
        await call(env.box, 'destroy');
        expect(env.log()).toEqual(['disposed:owned']);
      }));

    it(`T21-P7 ${label(cell)}: a resource of the parent container is not disposed by its child, the parent disposes it once`, () =>
      withCell(cell, WITH_PARENT, async (env) => {
        capabilitySymbol(env.built, 'Owned');
        resolveAll(env, 'Owned', 'Holder');
        env.read(env.built.id('Shared'));
        await call(env.box, 'destroy');
        expect(env.log()).toEqual(['disposed:owned']);
        await call(env.built.exports['parent'], 'destroy');
        expect(env.log()).toEqual(['disposed:owned', 'disposed:parent']);
      }));

    it(`T21-P7 ${label(cell)}: the value a scope was given is not disposed by the scope, what the scope built from it is`, () =>
      withCell(cell, WITH_INPUT, async (env) => {
        capabilitySymbol(env.built, 'UsesInput');
        const given = { [Symbol.dispose](): void { env.log().push('disposed:input'); } };
        const child = createScope(env.box, { values: [{ token: env.built.id('InputRes'), useValue: given }] });
        use(child, 'resolve', env.token('UsesInput'));
        await call(child, 'destroy');
        expect(env.log()).toEqual(['disposed:usesInput']);
        await call(env.box, 'destroy');
        expect(env.log()).toEqual(['disposed:usesInput']);
      }));
  }
});

const ASYNC_INIT: Parts = {
  declarations: `
export class Held { [Symbol.dispose](): void { log('disposed:held'); } }
export class Late {}
interface Broken { id: string }
const broken = useInterface<Broken>();
`,
  injections: `{ token: Held },
    { token: broken, useFactory: true, dependencies: [], provider: async () => ({ id: 'broken', [Symbol.dispose]: 42 }) },
    { token: Late, useFactory: true, dependencies: [Held], provider: async (ctx) => { ctx.resolve(Held); throw new Error('init failed'); } },`,
  roots: '[Held, Late]',
};

const ASYNC_INIT_BROKEN: Parts = {
  declarations: ASYNC_INIT.declarations,
  injections: `{ token: Held },
    { token: broken, useFactory: true, dependencies: [], provider: async () => ({ id: 'broken', [Symbol.dispose]: 42 }) },
    { token: Late, useFactory: true, dependencies: [broken], provider: async (ctx) => { ctx.resolve(broken); throw new Error('init failed'); } },`,
  roots: '[Held, Late]',
};

describe('T21-P8 D6 a failed initialization releases what it built through the same protocols', () => {
  for (const cell of MATRIX) {
    it(`T21-P8 ${label(cell)}: the symbol-only singleton built before the failure is disposed`, () =>
      withCell(cell, ASYNC_INIT, async (env) => {
        capabilitySymbol(env.built, 'Held');
        const failed = await failure(() => call(env.box, 'initialize'));
        expect(failed.message).toBe('init failed');
        expect(env.log()).toEqual(['disposed:held']);
      }));

    it(`T21-P8 ${label(cell)}: a protocol that is not callable is listed in cleanupErrors of the initialization error`, () =>
      withCell(cell, ASYNC_INIT_BROKEN, async (env) => {
        capabilitySymbol(env.built, 'Held');
        let caught: unknown;
        try {
          await call(env.box, 'initialize');
        } catch (error) {
          caught = error;
        }
        const cleanup: unknown = readKey(caught, 'cleanupErrors');
        expect(Array.isArray(cleanup) ? cleanup.length : -1).toBe(1);
        const first = Array.isArray(cleanup) ? cleanup[0] : undefined;
        expect(first).toBeInstanceOf(TypeError);
        expect(messages([first])).toEqual([NOT_CALLABLE]);
      }));
  }
});

/** The async factory is borrowed: it has no disposal slot, so only the async initialization needs the selector. */
const LEGACY_ROLLBACK: Parts = {
  declarations: `
export class Plain { dispose(): void { log('disposed:plain'); } }
export class Late {}
`,
  injections: `{ token: Plain },
    { token: Late, useFactory: true, dependencies: [Plain], ownership: 'borrowed', provider: async (ctx) => { ctx.resolve(Plain); throw new Error('init failed'); } },`,
  roots: '[Plain, Late]',
};

describe('T21-W7 an async container releases a dispose() class through the selector too', () => {
  for (const cell of MATRIX) {
    it(`T21-W7 ${label(cell)}: the dispose()-only singleton built before the failure is disposed`, () =>
      withCell(cell, LEGACY_ROLLBACK, async (env) => {
        const failed = await failure(() => call(env.box, 'initialize'));
        expect(failed.message).toBe('init failed');
        expect(env.log()).toEqual(['disposed:plain']);
      }));
  }
});

const OVERRIDE: Parts = {
  declarations: `
export class Owned { [Symbol.dispose](): void { log('disposed:owned'); } }
export const mock = { [Symbol.dispose](): void { log('disposed:mock'); } };
`,
  injections: '{ token: Owned },',
  roots: '[Owned]',
};

describe('T21-P9 D6 override() releases the owned symbol-only singleton and leaves the mock alone', () => {
  for (const cell of FULL_CELLS) {
    it(`T21-P9 ${label(cell)}: the singleton is disposed once by override(), the mock is not disposed by destroy`, () =>
      withCell(cell, OVERRIDE, async (env) => {
        capabilitySymbol(env.built, 'Owned');
        env.read(env.token('Owned'));
        await call(env.box, 'override', [env.token('Owned'), () => env.built.exports['mock']]);
        expect(env.log()).toEqual(['disposed:owned']);
        expect(env.read(env.token('Owned'))).toBe(env.built.exports['mock']);
        await call(env.box, 'destroy');
        expect(env.log()).toEqual(['disposed:owned']);
      }, { testOverrides: true }));
  }
});

const CLOSING: Parts = {
  declarations: `
export class Plain { dispose(): void { log('disposed:plain'); } }
export const mock = { id: 'mock' };
`,
  injections: '{ token: Plain },',
  roots: '[Plain]',
};

describe('T21-W18 a synchronous graph of dispose() classes is busy until its destroy settles', () => {
  for (const cell of FULL_CELLS) {
    it(`T21-W18 ${label(cell)}: override() and clearOverrides() called while destroy() is pending reject NEO_CONTAINER_BUSY, then NEO_CONTAINER_DESTROYED`, () =>
      withCell(cell, CLOSING, async (env) => {
        env.read(env.token('Plain'));
        const closing = call(env.box, 'destroy');
        const whileOverride = failure(() => call(env.box, 'override', [env.token('Plain'), () => env.built.exports['mock']]));
        const whileClear = failure(() => call(env.box, 'clearOverrides'));
        expect((await whileOverride).code).toBe('NEO_CONTAINER_BUSY');
        expect((await whileClear).code).toBe('NEO_CONTAINER_BUSY');
        await closing;
        expect(env.log()).toEqual(['disposed:plain']);
        expect((await failure(() => call(env.box, 'override', [env.token('Plain'), () => env.built.exports['mock']]))).code).toBe('NEO_CONTAINER_DESTROYED');
        expect((await failure(() => call(env.box, 'clearOverrides'))).code).toBe('NEO_CONTAINER_DESTROYED');
      }, { testOverrides: true }));
  }
});

const PRIMITIVES: Parts = {
  declarations: `
type Count = number;
type Nothing = null;
type Text = string;
interface Callable { (): number; [Symbol.dispose](): void }
const callable: Callable = Object.assign((): number => 1, { [Symbol.dispose](): void { log('function'); } });
const count = useInterface<Count>();
const nothing = useInterface<Nothing>();
const text = useInterface<Text>();
const fn = useInterface<Callable>();
`,
  injections: `{ token: count, useFactory: true, dependencies: [], provider: () => 42 },
    { token: nothing, useFactory: true, dependencies: [], provider: () => null },
    { token: text, useFactory: true, dependencies: [], provider: () => 'text' },
    { token: fn, useFactory: true, dependencies: [], provider: () => callable },`,
  roots: '[count, nothing, text, fn]',
};

const MULTI: Parts = {
  declarations: `
interface Item { id: string }
const item = useInterface<Item>();
const make = (id: string): Item => ({ id, [Symbol.dispose](): void { log('item:' + id); } });
`,
  injections: `{ token: item, multi: true, useFactory: true, dependencies: [], provider: () => make('a') },
    { token: item, multi: true, useFactory: true, dependencies: [], provider: () => make('b') },`,
  roots: '[{ all: item }]',
};

describe('T21-W2 what a factory answers is looked at before its disposer is', () => {
  for (const cell of MATRIX) {
    it(`T21-W2 ${label(cell)}: a number, null and a string are skipped, a function that carries [Symbol.dispose] is disposed`, () =>
      withCell(cell, PRIMITIVES, async (env) => {
        for (const name of ['number', 'null', 'string', 'Callable']) env.read(env.built.id(name));
        expect(await destroyFailure(env.box)).toBeUndefined();
        expect(env.log()).toEqual(['function']);
      }));

    it(`T21-W16 ${label(cell)}: the contributions of a multi registration are disposed through the selector`, () =>
      withCell(cell, MULTI, async (env) => {
        expect(use(env.box, 'resolveAll', env.built.id('Item'))).toHaveLength(2);
        expect(await destroyFailure(env.box)).toBeUndefined();
        expect(sorted(env.log())).toEqual(['item:a', 'item:b']);
      }));
  }
});

const ABSENT: Parts = {
  declarations: `
export class SymOnly { [Symbol.dispose](): void { log('sym'); } }
export class Legacy { dispose(): void { log('legacy'); } }
interface Made { id: string }
const made = useInterface<Made>();
`,
  injections: `{ token: SymOnly },
    { token: Legacy },
    { token: made, useFactory: true, dependencies: [], provider: () => ({ id: 'made', dispose(): void { log('made'); } }) },`,
  roots: '[SymOnly, Legacy, made]',
};

describe('T21-P11 D3 the symbols are read when they are needed, never installed', () => {
  for (const cell of MATRIX) {
    it(`T21-P11 ${label(cell)}: with the symbols the container exposes asyncDispose and releases the three resources`, () =>
      withCell(cell, ABSENT, async (env) => {
        capabilitySymbol(env.built, 'SymOnly');
        expect(typeof Reflect.get(env.box, Symbol.asyncDispose)).toBe('function');
        resolveAll(env, 'SymOnly', 'Legacy');
        env.read(env.built.id('Made'));
        await call(env.box, 'destroy');
        expect(sorted(env.log())).toEqual(['legacy', 'made', 'sym']);
      }));

    it(`T21-P11 ${label(cell)}: without the symbols the module loads, destroy resolves, dispose() still runs, nothing is installed`, async () => {
      const built = buildCell(cell, ABSENT, { runtimeSymbol: Object.freeze({}) });
      try {
        capabilitySymbol(built, 'SymOnly');
        const env = envOf(built);
        expect(Reflect.get(env.box, Symbol.asyncDispose), 'a realm without the symbol gets no protocol').toBeUndefined();
        resolveAll(env, 'SymOnly', 'Legacy');
        env.read(built.id('Made'));
        expect(await destroyFailure(env.box)).toBeUndefined();
        expect(sorted(env.log())).toEqual(['legacy', 'made']);
        expect(Object.getOwnPropertySymbols(Object.getPrototypeOf(env.box))).toHaveLength(0);
        // Documented limit (LifecycleEmitter.ts, asyncDisposalMember): the key read is `undefined`, so the delegate sits under the string "undefined".
        expect(Object.getOwnPropertyNames(Object.getPrototypeOf(env.box)), 'the delegate is stored under the key "undefined"').toContain('undefined');
        expect(built.generated.join('\n')).not.toContain('Symbol.for');
      } finally {
        await built.close();
      }
    });
  }
});

const SCOPED: Parts = {
  declarations: `
export class Res { [Symbol.dispose](): void { log('res'); } }
export class Fails { [Symbol.dispose](): void { throw new Error('dispose failed'); } }
interface Scoped { resolve(token: unknown): unknown }
export async function scoped(parent: { createScope(): AsyncDisposable & Scoped }, body: (scope: Scoped) => void): Promise<Scoped> {
  await using scope = parent.createScope();
  body(scope);
  return scope;
}
`,
  injections: '{ token: Res }, { token: Fails },',
  roots: '[Res, Fails]',
  after: `
interface Input { id: string }
const input = useInterface<Input>();
export class Held { constructor(readonly input: Input) {} [Symbol.dispose](): void { log('held'); } }
export const tpl = defineBuilderConfig({ name: 'T21Tpl', scopeInputs: [input], injections: [{ token: Held }] });
export async function scopedTemplate(model: { createScope(options: { values: unknown[] }): AsyncDisposable & Scoped }, values: unknown[], body: (scope: Scoped) => void): Promise<Scoped> {
  await using scope = model.createScope({ values });
  body(scope);
  return scope;
}
`,
};

function runner(env: Env, name: string): (...args: unknown[]) => Promise<unknown> {
  const member: unknown = env.built.exports[name];
  if (typeof member !== 'function') throw new Error(`${name} is not a function`);
  return async (...args) => Reflect.apply(member, undefined, args);
}

describe.skipIf(typeof Symbol.asyncDispose !== 'symbol')('T21-P12 D4 await using releases the scope (skipped: Symbol.asyncDispose missing on this Node)', () => {
  for (const cell of MATRIX) {
    it(`T21-P12 ${label(cell)}: the scope is closed after the block, the parent stays open, the resource is disposed once`, () =>
      withCell(cell, SCOPED, async (env) => {
        expect(typeof Reflect.get(env.box, Symbol.asyncDispose), 'the container exposes asyncDispose').toBe('function');
        const scope = await runner(env, 'scoped')(env.box, (inner: object) => { use(inner, 'resolve', env.token('Res')); });
        expect(thrown(() => use(scope, 'resolve', env.token('Res'))).code).toBe('NEO_CONTAINER_DESTROYED');
        expect(thrown(() => use(env.box, 'resolve', env.token('Res'))).code).toBe('');
        expect(env.log()).toEqual(['res']);
      }));

    it(`T21-P12 ${label(cell)}: a body error and a disposal error come out as the language's SuppressedError`, () =>
      withCell(cell, SCOPED, async (env) => {
        expect(typeof Reflect.get(env.box, Symbol.asyncDispose), 'the container exposes asyncDispose').toBe('function');
        let caught: unknown;
        try {
          await runner(env, 'scoped')(env.box, (inner: object) => {
            use(inner, 'resolve', env.token('Fails'));
            throw new Error('body failed');
          });
        } catch (error) {
          caught = error;
        }
        expect(readKey(caught, 'name')).toBe('SuppressedError');
        expect(messages([readKey(caught, 'suppressed')])).toEqual(['body failed']);
        const disposal = readKey(caught, 'error');
        expect(disposal).toBeInstanceOf(AggregateError);
        expect(messages(errorsOf(disposal))).toEqual(['dispose failed']);
      }));

    it(`T21-P12 ${label(cell)}: a scope made from a template with inputs is released the same way`, () =>
      withCell(cell, SCOPED, async (env) => {
        const model = env.built.exports['tpl'];
        expect(typeof Reflect.get(model ?? {}, Symbol.asyncDispose), 'the template exposes asyncDispose').toBe('function');
        const values = [{ token: env.built.id('Input'), useValue: { id: 'one' } }];
        const scope = await runner(env, 'scopedTemplate')(model, values, (inner: object) => { use(inner, 'resolve', env.token('Held')); });
        expect(thrown(() => use(scope, 'resolve', env.token('Held'))).code).toBe('NEO_CONTAINER_DESTROYED');
        expect(env.log()).toEqual(['held']);
      }));
  }
});

describe('T21-P13 D6 only a slot that may hold a symbol disposer carries the selector', () => {
  for (const cell of MATRIX) {
    it(`T21-P13 ${label(cell)}: a symbol-only class gets _neoDisposer, a dispose()-typed class keeps its direct call and names no symbol`, () => {
      const symbolOnly = buildCell(cell, { declarations: 'export class Sym { [Symbol.dispose](): void {} }', injections: '{ token: Sym },', roots: '[Sym]' });
      const legacyOnly = buildCell(cell, { declarations: 'export class Old { dispose(): void {} }', injections: '{ token: Old },', roots: '[Old]' });
      expect(symbolOnly.generated.join('\n'), `${label(cell)} symbol-only`).toContain('_neoDisposer');
      const legacy = legacyOnly.generated.join('\n');
      expect(legacy, `${label(cell)} dispose-only calls dispose directly`).toContain('__neoInst.dispose();');
      expect(legacy, `${label(cell)} dispose-only has no selector`).not.toContain('_neoDisposer');
      expect(legacy, `${label(cell)} dispose-only reads no symbol`).not.toMatch(/Symbol\.(dispose|for)/);
    });
  }
});

/**
 * D1 priority where the selector `_neoDisposer` is the only way the right method runs. The type a factory answers names
 * no disposer (`Opaque` is `{ id: string }`), so the analysis has no static slot kind for it; the value has all three
 * methods. A control value with the async symbol alone proves the same slot reaches the symbols (the selector exists).
 */
const SELECTOR_HEAD = `
export class Full {
  tag = 'full';
  dispose(): void { log('legacy:' + this.tag); probe.saved.push(this); }
  async [Symbol.asyncDispose](): Promise<void> { log('async:' + this.tag); }
  [Symbol.dispose](): void { log('sync:' + this.tag); }
}
export class OnlyAsync { async [Symbol.asyncDispose](): Promise<void> { log('async:control'); } }
interface Opaque { id: string }
interface Control { id: string }
const opaque = useInterface<Opaque>();
const control = useInterface<Control>();
const opaqueFull = (): Opaque => Object.assign(new Full(), { id: 'opaque' });
const opaqueControl = (): Control => Object.assign(new OnlyAsync(), { id: 'control' });
`;

const SELECTOR_DESTROY: Parts = {
  declarations: SELECTOR_HEAD,
  injections: `{ token: opaque, useFactory: true, dependencies: [], provider: opaqueFull },
    { token: control, useFactory: true, dependencies: [], provider: opaqueControl },`,
  roots: '[opaque, control]',
};

const SELECTOR_MULTI: Parts = {
  declarations: `${SELECTOR_HEAD}
interface Item { id: string }
const item = useInterface<Item>();
const itemFull = (): Item => Object.assign(new Full(), { id: 'item' });
`,
  injections: `{ token: item, multi: true, useFactory: true, dependencies: [], provider: itemFull },
    { token: control, useFactory: true, dependencies: [], provider: opaqueControl },`,
  roots: '[{ all: item }, control]',
};

/** `Late` is borrowed: it has no slot, so the rollback of the failed initialization is the only disposal here. */
const SELECTOR_ROLLBACK: Parts = {
  declarations: `${SELECTOR_HEAD}
export class Late {}
`,
  injections: `{ token: Full },
    { token: OnlyAsync },
    { token: Late, useFactory: true, dependencies: [Full, OnlyAsync], ownership: 'borrowed', provider: async (ctx) => { ctx.resolve(Full); ctx.resolve(OnlyAsync); throw new Error('init failed'); } },`,
  roots: '[Full, OnlyAsync, Late]',
};

function noStaticDisposer(env: Env, name: string): void {
  const service = Reflect.get(env.built.graphs.find((graph) => graph.containerName === 'T21')?.nodes.get(env.built.id(name)) ?? {}, 'service');
  const flags: unknown[] = ['isDisposable', 'isAsyncDisposable', 'symbolDisposer'].map((key) => readKey(service, key));
  expect(flags.filter(Boolean), `${name} has no static disposer`).toEqual([]);
}

describe('T21-W3 D1 a callable dispose() wins over both symbols when the selector is the only way to find it', () => {
  for (const cell of MATRIX) {
    it(`T21-W3 ${label(cell)}: destroy of a factory value typed with no disposer calls dispose() once, on the value, and neither symbol method`, () =>
      withCell(cell, SELECTOR_DESTROY, async (env) => {
        noStaticDisposer(env, 'Opaque');
        const value = env.read(env.built.id('Opaque'));
        env.read(env.built.id('Control'));
        await call(env.box, 'destroy');
        expect(sorted(env.log())).toEqual(['async:control', 'legacy:full']);
        expect(env.built.probe.saved).toHaveLength(1);
        expect(env.built.probe.saved[0]).toBe(value);
      }));

    it(`T21-W3 ${label(cell)}: a multi contribution typed with no disposer calls dispose() once, on the value, and neither symbol method`, () =>
      withCell(cell, SELECTOR_MULTI, async (env) => {
        const values = use(env.box, 'resolveAll', env.built.id('Item'));
        env.read(env.built.id('Control'));
        await call(env.box, 'destroy');
        expect(sorted(env.log())).toEqual(['async:control', 'legacy:full']);
        expect(env.built.probe.saved).toHaveLength(1);
        expect(values).toContain(env.built.probe.saved[0]);
      }));

    it(`T21-W3 ${label(cell)}: the rollback of a failed initialization calls dispose() once, on the value, and neither symbol method`, () =>
      withCell(cell, SELECTOR_ROLLBACK, async (env) => {
        const failed = await failure(() => call(env.box, 'initialize'));
        expect(failed.message).toBe('init failed');
        expect(sorted(env.log())).toEqual(['async:control', 'legacy:full']);
        expect(env.built.probe.saved).toHaveLength(1);
      }));
  }
});
