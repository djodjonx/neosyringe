import { describe, expect, it } from 'vitest';
import { MATRIX, label, member, withRun, type Cell, type Spec } from '../helpers/f-build';
import { EMITTERS, loadSource } from '../helpers/t06-run';

/**
 * Stage F, cost of making a closed container (docs/benchmarks/stage-f-compile-overhead.md, "Runtime cost"). A closed
 * container used to build its two sets of exported roots, `_singleRoots` and `_multiRoots`, for every instance it made,
 * although they are the same for every instance of the class. A benchmark that keeps thousands of containers alive then
 * spends its time in the collector, and the cost of a closed `create` or `createScope` moved with each field or set the
 * class gained. The sets are now built once per class, on the first container, and every container of the class reads the
 * same two. These tests read what a user observes: how many sets the runtime is asked for when a container is made, which
 * set two containers hold, and that a token the module had not bound yet is not lost. The container is reached through
 * `Reflect` on `unknown`.
 */

const CLOSED: readonly Cell[] = MATRIX.filter((cell) => cell.mode === 'closed');

const SPECS: readonly Spec[] = [{ name: 'A' }, { name: 'B', deps: ['A'] }, { name: 'C', kind: 'sync' }];

/** A second container of the class of `owner`, made the way a user makes one: `new` with no parent and a name. */
function sibling(owner: object, name: string): object {
  const made: unknown = Reflect.construct(owner.constructor, [undefined, name]);
  if (typeof made !== 'object' || made === null) throw new Error('not an object');
  return made;
}

/** How many `Set` the runtime is asked for while `action` runs; the global is always put back. */
function countingSets(action: () => void): number {
  const Native = globalThis.Set;
  let constructed = 0;
  class Counting<T> extends Native<T> {
    constructor(values?: Iterable<T> | null) {
      super(values);
      constructed += 1;
    }
  }
  Reflect.set(globalThis, 'Set', Counting);
  try {
    action();
  } finally {
    Reflect.set(globalThis, 'Set', Native);
  }
  return constructed;
}

function setOf(owner: object, name: string): Set<unknown> {
  const found: unknown = Reflect.get(owner, name);
  if (!(found instanceof Set)) throw new Error(`${name} is not a Set`);
  return found;
}

function codeOf(error: unknown): unknown {
  return error instanceof Error ? Reflect.get(error, 'code') : undefined;
}

describe('RC a closed container does not build its roots again for every instance', () => {
  for (const cell of CLOSED) {
    it(`RC1 two containers of one class hold the very same sets of roots, and they list the exported tokens (${label(cell)})`, async () => {
      await withRun(cell, SPECS, {}, async (run) => {
        const other = sibling(run.box, 'second');
        try {
          expect(setOf(other, '_singleRoots')).toBe(setOf(run.box, '_singleRoots'));
          expect(setOf(other, '_multiRoots')).toBe(setOf(run.box, '_multiRoots'));
          expect([...setOf(run.box, '_singleRoots')].sort()).toEqual([run.token('A'), run.token('B'), run.token('C')].sort());
          expect(setOf(run.box, '_multiRoots').size).toBe(0);
        } finally {
          await member(other, 'destroy')?.();
        }
      });
    });
  }

  for (const emitter of EMITTERS) {
    for (const profile of ['full', 'minimal'] as const) {
      it(`RC2 making a closed container asks for at most two sets, the listeners and the borrowed instances, and none for its roots (${emitter} ${profile})`, async () => {
        await withRun({ emitter, profile, mode: 'closed' }, SPECS, {}, (run) => {
          // The roots of the class are built by the first container (`run.box`): the one counted is the second.
          expect(countingSets(() => sibling(run.box, 'counted'))).toBeLessThanOrEqual(2);
        });
      });
    }
  }
});

/**
 * A token of the roots may be a binding the module has not initialized yet, a class of an import cycle: it reads
 * `undefined` the first time a container is made. The sets of that container are used for it and are not kept: the
 * next container reads the token as it is by then, and its root is answered. The binding is the `Late` member of the module's own
 * namespace import, written by a setter the test installs on the global object through the prelude of the module.
 */
describe('RC3 a root that was not bound yet when the first container was made is not lost for the next one', () => {
  const BIND = '__perf2Bind';
  const SOURCE = `
    import { defineBuilderConfig } from '@djodjonx/neosyringe';
    declare function defineBuilderConfig<T>(config: T): T;
    export class Late { readonly n = 1; }
    export const box = defineBuilderConfig({
      name: 'Perf2Late',
      optimization: { mode: 'closed', roots: [Late] },
      injections: [{ token: Late }],
    });
  `;
  // The module imports its own file as `Import_0` (the stand-in `require` of the harness answers `{}`): the setter writes `Late` there.
  const PRELUDE = `Reflect.set(globalThis, '${BIND}', (value: unknown) => { Reflect.set(Import_0, 'Late', value); });`;

  for (const emitter of EMITTERS) {
    it(`RC3 the second container answers the root, the first refuses it as it did (${emitter})`, () => {
      const opened = loadSource(SOURCE).open('box', { emitter, prelude: PRELUDE });
      const bind: unknown = Reflect.get(globalThis, BIND);
      try {
        if (typeof bind !== 'function') throw new Error('the prelude installed no setter');
        class Late {
          readonly n = 1;
        }
        Reflect.apply(bind, undefined, [Late]);
        const second = sibling(opened.container, 'second');
        const answer: unknown = member(second, 'resolve')?.(Late);
        expect(Reflect.get(objectOf(answer), 'n')).toBe(1);
        let refused: unknown;
        try {
          member(opened.container, 'resolve')?.(Late);
        } catch (error) {
          refused = error;
        }
        expect(codeOf(refused), 'the first container kept the set it was made with').toBe('NEO_ROOT_NOT_EXPORTED');
      } finally {
        Reflect.deleteProperty(globalThis, BIND);
      }
    });
  }
});

/**
 * The same guard for a multi root (`{ all: Late }`, read by `resolveAll`): the set of the multi roots is the second of the
 * pair, and the check that keeps a pair out of the class while a root reads `undefined` has one half for each set. The
 * single roots of this source are empty, so only the half of the multi set can keep the first container's pair away
 * from the next container.
 */
describe('RC3 a multi root that was not bound yet when the first container was made is not lost for the next one', () => {
  const BIND = '__perf2BindAll';
  const SOURCE = `
    import { defineBuilderConfig } from '@djodjonx/neosyringe';
    declare function defineBuilderConfig<T>(config: T): T;
    export class Late { readonly n = 1; }
    export const box = defineBuilderConfig({
      name: 'Perf2LateAll',
      optimization: { mode: 'closed', roots: [{ all: Late }] },
      injections: [{ token: Late, multi: true, useFactory: true, dependencies: [], provider: () => ({ n: 1 }) }],
    });
  `;
  const PRELUDE = `Reflect.set(globalThis, '${BIND}', (value: unknown) => { Reflect.set(Import_0, 'Late', value); });`;

  for (const emitter of EMITTERS) {
    it(`RC3 the second container answers resolveAll of the root, the first refuses it as it did (${emitter})`, () => {
      const opened = loadSource(SOURCE).open('box', { emitter, prelude: PRELUDE });
      const bind: unknown = Reflect.get(globalThis, BIND);
      try {
        if (typeof bind !== 'function') throw new Error('the prelude installed no setter');
        class Late {
          readonly n = 1;
        }
        Reflect.apply(bind, undefined, [Late]);
        const second = sibling(opened.container, 'second');
        const answer: unknown = member(second, 'resolveAll')?.(Late);
        expect(Array.isArray(answer) ? answer.length : undefined, 'the second container answers the multi root').toBe(1);
        let refused: unknown;
        try {
          member(opened.container, 'resolveAll')?.(Late);
        } catch (error) {
          refused = error;
        }
        expect(codeOf(refused), 'the first container kept the set it was made with').toBe('NEO_ROOT_NOT_EXPORTED');
      } finally {
        Reflect.deleteProperty(globalThis, BIND);
      }
    });
  }
});

/**
 * The two sets are shared by every container of the class, so the emitted code must not be able to change them: their
 * type is `ReadonlySet`, and a later change of an emitter that adds or deletes a token fails the strict typecheck of the
 * emitted program (DECISIONS.md:10, shared mutable state).
 */
describe('RC4 the shared sets of roots are typed read only', () => {
  for (const emitter of EMITTERS) {
    for (const profile of ['full', 'minimal'] as const) {
      it(`RC4 the fields and the class static are ReadonlySet (${emitter} ${profile})`, async () => {
        await withRun({ emitter, profile, mode: 'closed' }, SPECS, {}, (run) => {
          expect(run.text).toMatch(/private readonly _singleRoots: ReadonlySet<unknown> = /);
          expect(run.text).toMatch(/private readonly _multiRoots: ReadonlySet<unknown> = /);
          expect(run.text).toMatch(/private static __neoRootSets\?: readonly \[ReadonlySet<unknown>, ReadonlySet<unknown>\];/);
          expect(run.text, 'no mutable Set type is left on the roots').not.toMatch(/_(?:single|multi)Roots: Set</);
        });
      });
    }
  }
});

function objectOf(value: unknown): object {
  if (typeof value !== 'object' || value === null) throw new Error('not an object');
  return value;
}
