import { describe, expect, it } from 'vitest';
import { EMITTERS, HEAD, failureOf, readKey, withBuilt, type Failure } from '../helpers/e17-build';
import { CELLS, call as callAsync, createScope, label as cellLabel, shown, thrown, withEnv } from '../helpers/e18-build';

/**
 * G shared helpers, on the two emitters. Two async containers written into one module with a declared factory each: with a
 * registry (the plugin session gives one) the module holds one controller factory, one lease, one context class, one policy
 * builder and one `formatToken`, written in front of the containers; without one, as a unit's `generate()` does, every
 * container carries its own. Both forms run and answer the same.
 */

const SOURCE = `${HEAD}
export class C { readonly name = '-c'; }
export class X { name = ''; }
export const boxA = defineBuilderConfig({
  name: 'A',
  injections: [
    { token: C },
    { token: X, useFactory: true, dependencies: [C], provider: async (ctx) => Object.assign(new X(), { name: 'A' + ctx.resolve(C).name }) },
  ],
});
export const boxB = defineBuilderConfig({
  name: 'B',
  injections: [
    { token: C },
    { token: X, useFactory: true, dependencies: [C], provider: async (ctx) => Object.assign(new X(), { name: 'B' + ctx.resolve(C).name }) },
  ],
});
`;

function count(code: string, pattern: RegExp): number {
  return code.match(pattern)?.length ?? 0;
}

function call(owner: object, name: string, ...args: unknown[]): unknown {
  const method: unknown = Reflect.get(owner, name);
  if (typeof method !== 'function') throw new Error(`${name} is not a function`);
  return Reflect.apply(method, owner, args);
}

/** `owner[name](...args)` on a value a factory saved: it is `unknown` until a test looks at it. */
function callOn(owner: unknown, name: string, ...args: unknown[]): unknown {
  if (typeof owner !== 'object' || owner === null) throw new Error('not an object');
  return call(owner, name, ...args);
}

const LEASE = /(?:private static |function )__neo(?:Shared)?Lease\b/g;
const CONTROLLER = /(?:private static |function )__neo(?:Shared)?Controller\b/g;
const CONTEXT = /(?:private static readonly __neoContext = class|class __neoSharedContext)\b/g;
const POLICY = /(?:private static |function )__neo(?:Shared)?PolicyOf\b/g;
const FORMAT = /(?:private static |function )(?:formatToken|__neoSharedFormatToken)\b/g;

describe('G the helpers of the containers of one module, written once or once per class (P1, reference and optimized)', () => {
  for (const emitter of EMITTERS) {
    it(`P1 with a registry the module holds one of each helper and both containers run (${emitter})`, async () => {
      await withBuilt(SOURCE, { emitter, shared: true }, async (built) => {
        for (const pattern of [LEASE, CONTROLLER, CONTEXT, POLICY, FORMAT]) expect(count(built.code, pattern)).toBe(1);
        for (const [name, answer] of [['boxA', 'A-c'], ['boxB', 'B-c']] as const) {
          const box = built.box(name);
          await call(box, 'initialize');
          expect(call(box, 'resolve', built.exports.X)).toMatchObject({ name: answer });
        }
      });
    });

    it(`P5 without a registry every container carries its own helpers and both run (${emitter})`, async () => {
      await withBuilt(SOURCE, { emitter }, async (built) => {
        for (const pattern of [LEASE, CONTROLLER, CONTEXT, POLICY, FORMAT]) expect(count(built.code, pattern)).toBe(2);
        for (const [name, answer] of [['boxA', 'A-c'], ['boxB', 'B-c']] as const) {
          const box = built.box(name);
          await call(box, 'initialize');
          expect(call(box, 'resolve', built.exports.X)).toMatchObject({ name: answer });
        }
      });
    });
  }
});

/**
 * The production form, not only its happy path: the lease, the context class and `formatToken` of the module answer what the
 * ones of a class answer (t14 expiry and undeclared, f-perf PE1, e18 scope-input messages), on both emitters. The three
 * declared dependencies of `Made` are a simple token, an `all` token, and the factory asks for one more it never declared.
 */

const EXPIRED = 'NEO_FACTORY_CONTEXT_EXPIRED';
const UNDECLARED = 'NEO_UNDECLARED_FACTORY_DEP';

const LEASE_SOURCE = `${HEAD}
export class Dep { n = 1; }
export class Other { n = 2; }
interface Item { n: number }
const item = useInterface<Item>();
interface Made { ok: boolean }
const made = useInterface<Made>();
export const box = defineBuilderConfig({
  name: 'Box',
  injections: [
    { token: Dep },
    { token: Other },
    { token: item, multi: true, useFactory: true, dependencies: [], provider: () => ({ n: 1 }) },
    { token: item, multi: true, useFactory: true, dependencies: [], provider: () => ({ n: 2 }) },
    { token: made, lifecycle: 'transient', useFactory: true, dependencies: [Dep, { all: item }],
      provider: (ctx) => {
        probe.saved.push(ctx);
        const run = Reflect.get(probe, 'run');
        if (typeof run === 'function') run(ctx);
        return { ok: true };
      } },
  ],
});
`;

const OPAQUE_SOURCE = `${HEAD}
export class Dep { n = 1; }
interface Made { n: number; aborted: boolean }
const made = useInterface<Made>();
export const box = defineBuilderConfig({
  name: 'Box',
  injections: [
    { token: Dep },
    { token: made, lifecycle: 'transient', useFactory: true, provider: (ctx) => { probe.saved.push(ctx); return { n: ctx.resolve(Dep).n, aborted: ctx.signal.aborted }; } },
  ],
});
`;

describe('G the lease and the context class of the module answer what the ones of a class answer (production form, reference and optimized)', () => {
  for (const emitter of EMITTERS) {
    it(`L1 live, a context resolves what it declared, refuses the rest with the declared code and message, and has a signal (${emitter})`, async () => {
      await withBuilt(LEASE_SOURCE, { emitter, shared: true }, (built) => {
        expect(count(built.code, LEASE)).toBe(1);
        const seen: Array<Failure | undefined> = [];
        let signal: unknown;
        Reflect.set(built.probe, 'run', (ctx: unknown) => {
          seen.push(failureOf(() => callOn(ctx, 'resolve', built.exports.Dep)));
          seen.push(failureOf(() => callOn(ctx, 'resolveAll', built.id('Item'))));
          seen.push(failureOf(() => callOn(ctx, 'resolveMany', [built.exports.Dep])));
          seen.push(failureOf(() => callOn(ctx, 'resolve', built.exports.Other)));
          seen.push(failureOf(() => callOn(ctx, 'resolveAll', built.exports.Dep)));
          seen.push(failureOf(() => callOn(ctx, 'resolveMany', [built.exports.Other])));
          signal = readKey(ctx, 'signal');
        });
        call(built.box(), 'resolve', built.id('Made'));
        const undeclared = { code: UNDECLARED, message: `${UNDECLARED}: factory Made cannot resolve an undeclared dependency` };
        const refusedAll = { code: UNDECLARED, message: `${UNDECLARED}: factory Made cannot resolveAll an undeclared dependency` };
        expect(seen).toEqual([undefined, undefined, undefined, undeclared, refusedAll, undeclared]);
        expect(signal).toBeInstanceOf(AbortSignal);
      });
    });

    it(`L2 once the factory returned, every member of its context refuses with NEO_FACTORY_CONTEXT_EXPIRED, and a second call has a context of its own (${emitter})`, async () => {
      await withBuilt(LEASE_SOURCE, { emitter, shared: true }, (built) => {
        call(built.box(), 'resolve', built.id('Made'));
        call(built.box(), 'resolve', built.id('Made'));
        expect(built.probe.saved).toHaveLength(2);
        expect(built.probe.saved[0]).not.toBe(built.probe.saved[1]);
        const expired = { code: EXPIRED, message: `${EXPIRED}: factory Made context used after the factory returned` };
        const [first] = built.probe.saved;
        expect(failureOf(() => callOn(first, 'resolve', built.exports.Dep))).toEqual(expired);
        expect(failureOf(() => callOn(first, 'resolveAll', built.id('Item')))).toEqual(expired);
        expect(failureOf(() => callOn(first, 'resolveMany', [built.exports.Dep]))).toEqual(expired);
        expect(failureOf(() => readKey(first, 'signal'))).toEqual(expired);
      });
    });

    it(`L3 the signal is an accessor of the prototype of the context: not an own property, not copied by a spread (${emitter})`, async () => {
      await withBuilt(LEASE_SOURCE, { emitter, shared: true }, (built) => {
        expect(count(built.code, CONTEXT)).toBe(1);
        call(built.box(), 'resolve', built.id('Made'));
        const context = built.probe.saved[0];
        if (typeof context !== 'object' || context === null) throw new Error('the factory saved no context');
        expect(Object.keys(context).sort()).toEqual(['__neoRead', 'resolve', 'resolveAll', 'resolveMany']);
        expect(Object.keys({ ...context })).not.toContain('signal');
        expect(Reflect.getOwnPropertyDescriptor(context, 'signal')).toBeUndefined();
        expect('signal' in context).toBe(true);
      });
    });

    it(`L4 an opaque factory gets the context class of the module: it resolves any token and reads a signal that is not aborted (${emitter})`, async () => {
      await withBuilt(OPAQUE_SOURCE, { emitter, shared: true, validation: 'compatible' }, (built) => {
        expect(count(built.code, CONTEXT)).toBe(1);
        expect(call(built.box(), 'resolve', built.id('Made'))).toEqual({ n: 1, aborted: false });
        const context = built.probe.saved[0];
        if (typeof context !== 'object' || context === null) throw new Error('the factory saved no context');
        expect(Object.keys(context).sort()).toEqual(['__neoRead', 'resolve', 'resolveAll', 'resolveMany']);
      });
    });
  }
});

describe('G formatToken of the module words the scope-input messages like the one of a class (production form)', () => {
  for (const cell of CELLS) {
    it(`F1 createScope without its inputs names the missing tokens through the module formatToken (${cellLabel(cell)})`, async () => {
      await withEnv(cell, { inputs: '[req, twin, retries]', shared: true }, async (env) => {
        expect(count(env.built.code, FORMAT)).toBe(1);
        const ok = { token: env.req, useValue: { id: 'r', user: 'u' } };
        const refused = thrown(() => createScope(env.box, { values: [ok] }));
        expect(refused).toEqual({
          code: 'NEO_SCOPE_INPUT_MISSING',
          message: `NEO_SCOPE_INPUT_MISSING: [E18] scope inputs missing: ${shown(env.twin)}, ${shown(env.retries)}`,
        });
        const scope = createScope(env.box, { values: [ok, { token: env.twin, useValue: { id: 't', user: 'u' } }, { token: env.retries, useValue: 1 }] });
        expect(typeof scope).toBe('object');
        if (typeof scope === 'object' && scope !== null) await callAsync(scope, 'destroy');
      });
    });
  }
});
