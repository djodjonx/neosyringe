import { describe, expect, it } from 'vitest';
import {
  MATRIX,
  call,
  capabilitySymbol,
  destroyFailure,
  label,
  readKey,
  serviceOf,
  withCell,
  type Env,
  type Parts,
} from '../helpers/t21-build';

/**
 * The shared disposal member of a generated class (`_neoDisposeSlot`, docs/benchmarks/stage-f-compile-overhead.md) at
 * runtime, on the paths of it that the stage F change touched: a LATE slot (a slot disposed after an asynchronously
 * disposable consumer, which is awaited at once), a guarded slot whose value has no disposer, and a slot whose instance was
 * never built. Each test runs on both emitters, full and minimal, open and closed, and on a graph with and without an
 * async factory (a sync and an async container write the destroy differently). Containers are reached through `Reflect`.
 */

const SHAPES: ReadonlyArray<{ title: string; async: boolean }> = [
  { title: 'sync graph', async: false },
  { title: 'async graph', async: true },
];

/** `Warm` makes the container async: its factory is async, so the container must be initialized before it resolves. */
function parts(shape: { async: boolean }, declarations: string, injections: string, roots: string): Parts {
  const warm = shape.async
    ? {
        declarations: `interface IWarm { name: string }
const warm = useInterface<IWarm>();
`,
        injections: `{ token: warm, useFactory: true, dependencies: [], provider: async () => ({ name: 'warm' }) },`,
        roots: ', warm',
      }
    : { declarations: '', injections: '', roots: '' };
  return {
    declarations: `${warm.declarations}${declarations}`,
    injections: `${warm.injections}\n    ${injections}`,
    roots: `[${roots}${warm.roots}]`,
  };
}

async function ready(env: Env, shape: { async: boolean }): Promise<void> {
  if (shape.async) await call(env.box, 'initialize');
}

/** `Late` is disposed asynchronously and depends on `Dep`: the slot of `Dep` is late, it waits for the slot of `Late`. */
const CONSUMER = `
export class Dep { dispose(): void { log('dispose:Dep'); } }
export class Late {
  constructor(readonly dep: Dep) {}
  async [Symbol.asyncDispose](): Promise<void> { log('start:Late'); await Promise.resolve(); await Promise.resolve(); log('end:Late'); }
}
`;

const REJECTING_CONSUMER = `
export class Dep { dispose(): void { log('dispose:Dep'); } }
export class Late {
  constructor(readonly dep: Dep) {}
  async [Symbol.asyncDispose](): Promise<void> { await Promise.resolve(); log('refused:Late'); throw new Error('late refused'); }
}
`;

function expectLate(env: Env): void {
  capabilitySymbol(env.built, 'Late');
  expect(readKey(serviceOf(env.built, 'Late'), 'isAsyncDisposable'), 'Late is asynchronously disposable').toBe(true);
}

describe('L1 a dependency of an asynchronously disposable consumer is disposed after the consumer settles', () => {
  for (const cell of MATRIX) {
    for (const shape of SHAPES) {
      it(`L1 destroy waits for the late slot before the next one runs (${shape.title}, ${label(cell)})`, () =>
        withCell(cell, parts(shape, CONSUMER, '{ token: Late }, { token: Dep },', 'Late, Dep'), async (env) => {
          expectLate(env);
          await ready(env, shape);
          env.read(env.token('Late'));
          await call(env.box, 'destroy');
          expect(env.log(), 'Dep is disposed once Late has ended').toEqual(['start:Late', 'end:Late', 'dispose:Dep']);
        }));
    }
  }
});

describe('L2 the rejection of a late slot is gathered, and the slots after it still run', () => {
  for (const cell of MATRIX) {
    for (const shape of SHAPES) {
      it(`L2 destroy rejects with the error of the late disposer and still disposes the dependency (${shape.title}, ${label(cell)})`, () =>
        withCell(cell, parts(shape, REJECTING_CONSUMER, '{ token: Late }, { token: Dep },', 'Late, Dep'), async (env) => {
          expectLate(env);
          await ready(env, shape);
          env.read(env.token('Late'));
          const rejected = await destroyFailure(env.box);
          expect(rejected, 'destroy rejects').toBeInstanceOf(AggregateError);
          const errors: unknown = readKey(rejected, 'errors');
          expect(Array.isArray(errors) ? errors.map((error: unknown) => readKey(error, 'message')) : errors).toEqual(['late refused']);
          expect(env.log(), 'the dependency is released after the late disposer failed').toEqual(['refused:Late', 'dispose:Dep']);
        }));
    }
  }
});

const NO_DISPOSER = `
interface Plain { name: string }
const plain = useInterface<Plain>();
`;

describe('L3 a guarded slot whose value has no disposer is not a disposal', () => {
  for (const cell of MATRIX) {
    for (const shape of SHAPES) {
      it(`L3 destroy resolves and reports nothing for a factory value with no disposer (${shape.title}, ${label(cell)})`, () =>
        withCell(
          cell,
          parts(shape, NO_DISPOSER, "{ token: plain, useFactory: true, dependencies: [], provider: () => ({ name: 'plain' }) },", 'plain'),
          async (env) => {
            await ready(env, shape);
            env.read(env.built.id('Plain'));
            expect(await destroyFailure(env.box), 'a value with nothing to call is not an error').toBeUndefined();
            expect(env.log()).toEqual([]);
          },
        ));
    }
  }
});

const NEVER_BUILT = `
export class Never { dispose(): void { log('dispose:Never'); } }
export class Built { dispose(): void { log('dispose:Built'); } }
`;

describe('L4 a slot whose instance was never built disposes nothing and fails nothing', () => {
  for (const cell of MATRIX) {
    for (const shape of SHAPES) {
      it(`L4 destroy skips the registration nobody resolved (${shape.title}, ${label(cell)})`, () =>
        withCell(cell, parts(shape, NEVER_BUILT, '{ token: Never }, { token: Built },', 'Never, Built'), async (env) => {
          await ready(env, shape);
          env.read(env.token('Built'));
          expect(await destroyFailure(env.box), 'a registration with no instance is not a failure').toBeUndefined();
          expect(env.log(), 'only what was built is disposed').toEqual(['dispose:Built']);
        }));
    }
  }
});
