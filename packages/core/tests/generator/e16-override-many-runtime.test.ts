import { beforeAll, describe, expect, it } from 'vitest';
import { build } from '../helpers/e17-build';
import {
  CELLS,
  call,
  capabilityMany,
  failure,
  gateA,
  label,
  mockOf,
  overrideMany,
  overridesOf,
  readKey,
  rejection,
  resolve,
  slice,
  sourceFor,
  thrown,
  withEnv,
  type Cell,
  type Env,
} from '../helpers/e16-build';
import { warmLibCache } from '../fastProgram';

/**
 * E16 `overrideMany` at runtime, on the two emitters, open and closed, sync and async, full profile. Every test calls
 * `capabilityMany(box)` first, then reads what a user can observe: the error code and message, the factories called,
 * the disposals counted, the instance a token resolves to. The container is reached through `Reflect` on `unknown`.
 */

const BUSY = { code: 'NEO_CONTAINER_BUSY', message: 'NEO_CONTAINER_BUSY: [E16] container is transitioning' };
const DESTROYED = { code: 'NEO_CONTAINER_DESTROYED', message: 'NEO_CONTAINER_DESTROYED: [E16] container is destroyed' };
const DISABLED = { code: 'NEO_TEST_API_DISABLED', message: 'NEO_TEST_API_DISABLED: [E16] test overrides are disabled' };

const only = (cells: readonly Cell[], timing: Cell['timing']): Cell[] => cells.filter((cell) => cell.timing === timing);

/** Resolves the three singletons of a cell. */
function resolved(env: Env): unknown[] {
  return [resolve(env.box, env.a), resolve(env.box, env.b), resolve(env.box, env.c)];
}

/** `initialize()` again, for the async cells: a transition empties the cache and the state. */
async function reinitialize(cell: Cell, env: Env): Promise<void> {
  if (cell.timing === 'async') await call(env.box, 'initialize');
}

/** Makes the dispose of `PortB` throw, then runs a valid batch: the container ends in the failed state. */
async function failTheContainer(env: Env): Promise<{ error: unknown; boom: Error; mock: ReturnType<typeof mockOf> }> {
  const boom = new Error('dispose boom');
  const mock = mockOf('failed-a');
  resolved(env);
  env.built.probe.fail = boom;
  const error = await rejection(overrideMany(env.box, [[env.a, mock.factory]]));
  return { error, boom, mock };
}

describe('E16 overrideMany runtime', () => {
  beforeAll(() => {
    warmLibCache();
  });

  it('E16-P3 a batch whose last entry is invalid invokes no factory, disposes nothing and mutates nothing', async () => {
    for (const cell of CELLS) {
      await withEnv(cell, {}, async (env) => {
        capabilityMany(env.box);
        const name = label(cell);
        const mockA = mockOf('a');
        const mockB = mockOf('b');
        const before = resolved(env);
        const refused = await failure(overrideMany(env.box, [[env.a, mockA.factory], [env.b, mockB.factory], [env.c, 42]]));
        expect(refused, name).toEqual({
          code: 'NEO_OVERRIDE_INVALID',
          message: 'NEO_OVERRIDE_INVALID: [E16] override must be a factory',
        });
        expect(mockA.calls + mockB.calls, `${name}: no mock factory`).toBe(0);
        expect(env.count('disposeA') + env.count('disposeB'), `${name}: no dispose`).toBe(0);
        expect(resolved(env), `${name}: the same singletons`).toEqual(before);
        expect(resolve(env.box, env.a), `${name}: the same A`).toBe(before[0]);
        expect(overridesOf(env.box).size, `${name}: the table is unchanged`).toBe(0);
      });
    }
  }, 120_000);

  it('E16-P4 a token twice in a batch is refused before any change', async () => {
    for (const cell of CELLS) {
      await withEnv(cell, {}, async (env) => {
        capabilityMany(env.box);
        const name = label(cell);
        const first = mockOf('first');
        const second = mockOf('second');
        const before = resolved(env);
        const expected = {
          code: 'NEO_OVERRIDE_DUPLICATE',
          message: 'NEO_OVERRIDE_DUPLICATE: [E16] duplicate override in batch',
        };
        expect(await failure(overrideMany(env.box, [[env.a, first.factory], [env.b, second.factory], [env.a, second.factory]])), name).toEqual(expected);
        expect(await failure(overrideMany(env.box, [[env.a, first.factory], [env.a, first.factory]])), `${name}: the same factory twice`).toEqual(expected);
        expect(first.calls + second.calls, `${name}: no factory`).toBe(0);
        expect(env.count('disposeA') + env.count('disposeB'), `${name}: no dispose`).toBe(0);
        expect(resolved(env), `${name}: nothing changed`).toEqual(before);
        expect(overridesOf(env.box).size, `${name}: the table is unchanged`).toBe(0);
      });
    }
  }, 120_000);

  it('E16-P5 a multi token in a batch is refused with the message override gives', async () => {
    for (const cell of CELLS) {
      await withEnv(cell, { multi: true }, async (env) => {
        capabilityMany(env.box);
        const name = label(cell);
        const mockA = mockOf('a');
        const before = resolved(env);
        const single = await failure(call(env.box, 'override', [env.m, mockA.factory]));
        expect(single.code, `${name}: override`).toBe('NEO_OVERRIDE_MULTI_UNSUPPORTED');
        const refused = await failure(overrideMany(env.box, [[env.a, mockA.factory], [env.m, mockA.factory]]));
        expect(refused, name).toEqual(single);
        expect(refused.message, name).toBe('NEO_OVERRIDE_MULTI_UNSUPPORTED: [E16] cannot override a multi token');
        expect(mockA.calls, `${name}: no factory`).toBe(0);
        expect(env.count('disposeA'), `${name}: no dispose`).toBe(0);
        expect(resolved(env), `${name}: nothing changed`).toEqual(before);
      });
    }
  }, 120_000);

  it('E16-P6 with the test API disabled every batch is refused, the empty one too', async () => {
    for (const cell of CELLS) {
      await withEnv(cell, { testOverrides: false }, async (env) => {
        capabilityMany(env.box);
        const name = label(cell);
        const mockA = mockOf('a');
        resolved(env);
        const single = await failure(call(env.box, 'override', [env.a, mockA.factory]));
        expect(single, `${name}: override`).toEqual(DISABLED);
        expect(await failure(overrideMany(env.box, [])), `${name}: empty`).toEqual(DISABLED);
        expect(await failure(overrideMany(env.box, [[env.a, mockA.factory]])), `${name}: valid`).toEqual(DISABLED);
        expect(await failure(overrideMany(env.box, [[env.a, 42]])), `${name}: invalid`).toEqual(DISABLED);
        expect(mockA.calls, `${name}: no factory`).toBe(0);
        expect(env.count('disposeA'), `${name}: no dispose`).toBe(0);
      });
    }
  }, 120_000);

  it('E16-P6b the minimal profile has no overrideMany, on both emitters, whatever the flag', async () => {
    for (const cell of CELLS) {
      await withEnv(cell, {}, async (full) => {
        capabilityMany(full.box);
        for (const testOverrides of [true, false]) {
          const built = build(sourceFor(cell, { profile: 'minimal' }), { emitter: cell.emitter, testOverrides });
          try {
            const name = `${label(cell)} flag ${String(testOverrides)}`;
            expect(readKey(built.box(), 'overrideMany'), name).toBeUndefined();
          } finally {
            await built.close();
          }
        }
      });
    }
  }, 120_000);

  it('E16-P7 a destroyed container refuses a batch, the empty one too; a failed container refuses with its cause', async () => {
    for (const cell of CELLS) {
      await withEnv(cell, {}, async (env) => {
        capabilityMany(env.box);
        const name = label(cell);
        const mockA = mockOf('a');
        resolved(env);
        await call(env.box, 'destroy');
        expect(await failure(overrideMany(env.box, [])), `${name}: destroyed, empty`).toEqual(DESTROYED);
        expect(await failure(overrideMany(env.box, [[env.a, mockA.factory]])), `${name}: destroyed, valid`).toEqual(DESTROYED);
        expect(mockA.calls, `${name}: no factory`).toBe(0);
      });
      await withEnv(cell, {}, async (env) => {
        capabilityMany(env.box);
        const name = label(cell);
        const mockC = mockOf('c');
        const { error } = await failTheContainer(env);
        expect(error, `${name}: the cleanup failed`).toBeInstanceOf(AggregateError);
        for (const entries of [[], [[env.c, mockC.factory]]]) {
          const refused = await rejection(overrideMany(env.box, entries));
          expect(readKey(refused, 'code'), `${name}: failed, ${entries.length} entries`).toBe('NEO_CONTAINER_FAILED');
          expect(readKey(refused, 'message'), name).toBe('NEO_CONTAINER_FAILED: [E16] container initialization failed');
          expect(readKey(refused, 'cause'), `${name}: the cause is the cleanup failure`).toBe(error);
        }
        expect(mockC.calls, `${name}: no factory`).toBe(0);
      });
    }
  }, 120_000);

  it('E16-P7b a destroyed, failed or busy container refuses before it reads one entry of the batch, even an invalid one', async () => {
    for (const cell of CELLS) {
      const name = label(cell);
      /** A batch with a duplicate and a last entry that counts the times its iterator is read. */
      const batchOf = (env: Env, reads: { count: number }): unknown[] => {
        const mock = mockOf('x');
        const counting = {
          *[Symbol.iterator](): Generator<unknown> {
            reads.count += 1;
            yield env.c;
            yield mock.factory;
          },
        };
        return [[env.a, mock.factory], [env.a, mock.factory], counting];
      };
      await withEnv(cell, {}, async (env) => {
        capabilityMany(env.box);
        const reads = { count: 0 };
        resolved(env);
        await call(env.box, 'destroy');
        expect(await failure(overrideMany(env.box, batchOf(env, reads))), `${name}: destroyed`).toEqual(DESTROYED);
        expect(reads.count, `${name}: destroyed, no entry read`).toBe(0);
      });
      await withEnv(cell, {}, async (env) => {
        capabilityMany(env.box);
        const reads = { count: 0 };
        const { error } = await failTheContainer(env);
        expect(error, `${name}: the cleanup failed`).toBeInstanceOf(AggregateError);
        const refused = await failure(overrideMany(env.box, batchOf(env, reads)));
        expect(refused.code, `${name}: failed`).toBe('NEO_CONTAINER_FAILED');
        expect(reads.count, `${name}: failed, no entry read`).toBe(0);
      });
      await withEnv(cell, {}, async (env) => {
        capabilityMany(env.box);
        const reads = { count: 0 };
        resolved(env);
        const gate = gateA(env);
        const first = overrideMany(env.box, [[env.c, mockOf('c').factory]]);
        expect(await failure(overrideMany(env.box, batchOf(env, reads))), `${name}: busy`).toEqual(BUSY);
        expect(reads.count, `${name}: busy, no entry read`).toBe(0);
        gate.open();
        await first;
      });
    }
  }, 120_000);

  it('E16-P8 a valid batch disposes each owned singleton once, shows every mock, borrows them', async () => {
    for (const cell of CELLS) {
      await withEnv(cell, {}, async (env) => {
        capabilityMany(env.box);
        const name = label(cell);
        const mockA = mockOf('a');
        const mockB = mockOf('b');
        const [oldA, oldB, oldC] = resolved(env);
        await overrideMany(env.box, [[env.a, mockA.factory], [env.b, mockB.factory]]);
        expect(env.count('disposeA'), `${name}: A disposed once`).toBe(1);
        expect(env.count('disposeB'), `${name}: B disposed once`).toBe(1);
        await reinitialize(cell, env);
        expect(resolve(env.box, env.a), `${name}: mock A`).toBe(mockA.instance);
        expect(resolve(env.box, env.b), `${name}: mock B`).toBe(mockB.instance);
        expect(resolve(env.box, env.a), `${name}: mock A, cached`).not.toBe(oldA);
        expect(resolve(env.box, env.b), `${name}: mock B, cached`).not.toBe(oldB);
        expect(mockA.calls + mockB.calls, `${name}: each mock built once`).toBe(2);
        expect(resolve(env.box, env.c), `${name}: the cache was emptied`).not.toBe(oldC);
        expect(env.count('buildC'), `${name}: C rebuilt once`).toBe(2);
        await call(env.box, 'destroy');
        expect(env.count('disposeA'), `${name}: A not disposed again`).toBe(1);
        expect(env.count('disposeB'), `${name}: B not disposed again`).toBe(1);
        expect(mockA.disposals + mockB.disposals, `${name}: mocks are borrowed`).toBe(0);
      });
    }
  }, 120_000);

  it('E16-P9 an async container needs initialize() again after a batch, as after override', async () => {
    for (const cell of only(CELLS, 'async')) {
      await withEnv(cell, {}, async (env) => {
        capabilityMany(env.box);
        const name = label(cell);
        const mockA = mockOf('a');
        const twin = mockOf('twin');
        resolved(env);
        await overrideMany(env.box, [[env.a, mockA.factory]]);
        const refused = thrown(() => resolve(env.box, env.a));
        expect(refused, name).toEqual({
          code: 'NEO_NOT_INITIALIZED',
          message: 'NEO_NOT_INITIALIZED: [E16] call await container.initialize() before resolve()',
        });
        await call(env.box, 'initialize');
        expect(resolve(env.box, env.a), `${name}: the mock after initialize`).toBe(mockA.instance);
        await call(env.box, 'override', [env.b, twin.factory]);
        expect(thrown(() => resolve(env.box, env.b)).code, `${name}: override needs it too`).toBe('NEO_NOT_INITIALIZED');
      });
    }
  }, 120_000);

  it('E16-P10 an empty batch changes nothing: same singletons, no dispose, no new initialize', async () => {
    for (const cell of CELLS) {
      await withEnv(cell, {}, async (env) => {
        capabilityMany(env.box);
        const name = label(cell);
        const before = resolved(env);
        await overrideMany(env.box, []);
        expect(resolved(env), `${name}: same singletons`).toEqual(before);
        expect(resolve(env.box, env.a), `${name}: same A`).toBe(before[0]);
        expect(env.count('disposeA') + env.count('disposeB'), `${name}: no dispose`).toBe(0);
        expect(env.count('buildC'), `${name}: no rebuild`).toBe(1);
      });
    }
  }, 120_000);

  it('E16-P11 during the transition a second override, overrideMany, clearOverrides, initialize or resolve is BUSY', async () => {
    for (const cell of CELLS) {
      await withEnv(cell, {}, async (env) => {
        capabilityMany(env.box);
        const name = label(cell);
        const mockA = mockOf('a');
        const other = mockOf('other');
        resolved(env);
        const gate = gateA(env);
        const first = overrideMany(env.box, [[env.a, mockA.factory]]);
        expect(await failure(overrideMany(env.box, [[env.c, other.factory]])), `${name}: overrideMany`).toEqual(BUSY);
        expect(await failure(overrideMany(env.box, [])), `${name}: empty batch`).toEqual(BUSY);
        expect(await failure(call(env.box, 'override', [env.c, other.factory])), `${name}: override`).toEqual(BUSY);
        expect(await failure(call(env.box, 'clearOverrides')), `${name}: clearOverrides`).toEqual(BUSY);
        expect(await failure(call(env.box, 'initialize')), `${name}: initialize`).toEqual(BUSY);
        expect(thrown(() => resolve(env.box, env.c)), `${name}: resolve`).toEqual(BUSY);
        gate.open();
        await first;
        await reinitialize(cell, env);
        expect(resolve(env.box, env.a), `${name}: the first batch won`).toBe(mockA.instance);
        expect(resolve(env.box, env.c), `${name}: the refused ones changed nothing`).toEqual({ n: 3 });
        expect(other.calls, `${name}: no refused factory`).toBe(0);
      });
    }
  }, 120_000);

  it('E16-P12 a destroy requested during a batch is BUSY; the batch ends with its mocks, a later destroy disposes the owned', async () => {
    for (const cell of CELLS) {
      await withEnv(cell, {}, async (env) => {
        capabilityMany(env.box);
        const name = label(cell);
        const mockA = mockOf('a');
        resolved(env);
        const gate = gateA(env);
        const first = overrideMany(env.box, [[env.a, mockA.factory]]);
        expect(await failure(call(env.box, 'destroy')), `${name}: destroy`).toEqual(BUSY);
        gate.open();
        await first;
        await reinitialize(cell, env);
        expect(resolve(env.box, env.a), `${name}: the mock is visible`).toBe(mockA.instance);
        expect(env.count('disposeA'), `${name}: A disposed by the batch`).toBe(1);
        resolve(env.box, env.b);
        await call(env.box, 'destroy');
        expect(env.count('disposeB'), `${name}: the rebuilt B disposed by the destroy`).toBe(2);
        expect(env.count('disposeA'), `${name}: A once`).toBe(1);
        expect(mockA.disposals, `${name}: the mock is borrowed`).toBe(0);
        expect(thrown(() => resolve(env.box, env.a)), `${name}: closed`).toEqual(DESTROYED);
      });
    }
  }, 120_000);

  it('E16-P12b a destroy started while the entries are read refuses the batch: no mock, no reopen', async () => {
    for (const cell of CELLS) {
      await withEnv(cell, {}, async (env) => {
        capabilityMany(env.box);
        const name = label(cell);
        const mockA = mockOf('a');
        const probeOverride = mockOf('probe');
        resolved(env);
        let during: Promise<unknown> | undefined;
        let sameState: Promise<unknown> | undefined;
        const entry = {
          *[Symbol.iterator](): Generator<unknown> {
            during = call(env.box, 'destroy');
            sameState = call(env.box, 'override', [env.c, probeOverride.factory]);
            yield env.a;
            yield mockA.factory;
          },
        };
        const refused = await failure(overrideMany(env.box, [entry]));
        if (during === undefined || sameState === undefined) throw new Error('the entry was not read');
        const expected = await failure(sameState);
        expect(expected.code, `${name}: override is refused in that state`).not.toBe('');
        expect(refused, `${name}: the code override gives`).toEqual(expected);
        await during;
        expect(mockA.calls + probeOverride.calls, `${name}: no mock installed`).toBe(0);
        expect(thrown(() => resolve(env.box, env.a)), `${name}: closed, not reopened`).toEqual(DESTROYED);
        expect(env.count('disposeA'), `${name}: A disposed once`).toBe(1);
        expect(env.count('disposeB'), `${name}: B disposed once`).toBe(1);
      });
    }
  }, 120_000);

  it('E16-P12c a batch requested while destroy() is pending is refused as override is; after it the container is closed', async () => {
    for (const cell of CELLS) {
      await withEnv(cell, {}, async (env) => {
        capabilityMany(env.box);
        const name = label(cell);
        const mockC = mockOf('c');
        resolved(env);
        const gate = gateA(env);
        const destroying = call(env.box, 'destroy');
        const single = await failure(call(env.box, 'override', [env.c, mockC.factory]));
        expect(single, `${name}: override while destroying`).toEqual(BUSY);
        expect(await failure(overrideMany(env.box, [[env.c, mockC.factory]])), `${name}: batch`).toEqual(single);
        expect(await failure(overrideMany(env.box, [])), `${name}: empty batch`).toEqual(single);
        gate.open();
        await destroying;
        expect(thrown(() => resolve(env.box, env.c)), `${name}: closed after the destroy`).toEqual(DESTROYED);
        expect(mockC.calls, `${name}: no mock installed`).toBe(0);
        expect(env.count('disposeA'), `${name}: A disposed once`).toBe(1);
        expect(env.count('disposeB'), `${name}: B disposed once`).toBe(1);
        expect(await failure(overrideMany(env.box, [])), `${name}: closed, empty`).toEqual(DESTROYED);
      });
    }
  }, 120_000);

  it('E16-P13 a failed cleanup fails the container as override does and installs no mock', async () => {
    for (const cell of CELLS) {
      await withEnv(cell, {}, async (env) => {
        capabilityMany(env.box);
        const name = label(cell);
        const kept = mockOf('kept');
        await call(env.box, 'override', [env.c, kept.factory]);
        await reinitialize(cell, env);
        const disposedBefore = env.count('disposeA');
        const { error, boom, mock } = await failTheContainer(env);
        expect(error, `${name}: AggregateError`).toBeInstanceOf(AggregateError);
        expect(readKey(error, 'errors'), `${name}: the dispose failure`).toEqual([boom]);
        expect(overridesOf(env.box).has(env.c), `${name}: the old override stays`).toBe(true);
        expect(overridesOf(env.box).has(env.a), `${name}: the new mock is not installed`).toBe(false);
        expect(overridesOf(env.box).size, `${name}: the table is the old one`).toBe(1);
        expect(thrown(() => resolve(env.box, env.a)).code, `${name}: failed`).toBe('NEO_CONTAINER_FAILED');
        expect(mock.calls, `${name}: no mock factory`).toBe(0);
        expect(env.count('disposeA') - disposedBefore, `${name}: the cleanup ran to the end`).toBe(1);
      });
    }
  }, 120_000);

  it('E16-P14 the batch is copied before the transition: a caller who changes the array afterwards changes nothing', async () => {
    for (const cell of CELLS) {
      await withEnv(cell, {}, async (env) => {
        capabilityMany(env.box);
        const name = label(cell);
        const mockA = mockOf('a');
        const mockB = mockOf('b');
        const evil = mockOf('evil');
        resolved(env);
        const pairB: unknown[] = [env.b, mockB.factory];
        const entries: unknown[] = [[env.a, mockA.factory], pairB];
        const gate = gateA(env);
        const pending = overrideMany(env.box, entries);
        entries[0] = [env.a, evil.factory];
        entries.push([env.c, evil.factory]);
        pairB[1] = evil.factory;
        gate.open();
        await pending;
        await reinitialize(cell, env);
        expect(resolve(env.box, env.a), `${name}: A`).toBe(mockA.instance);
        expect(resolve(env.box, env.b), `${name}: B`).toBe(mockB.instance);
        expect(resolve(env.box, env.c), `${name}: C is the real one`).toEqual({ n: 3 });
        expect(evil.calls, `${name}: the changed entries are not read`).toBe(0);
      });
    }
  }, 120_000);

  it('E16-P15 with the flag off the output keeps a refusing member and none of the batch machinery', async () => {
    for (const cell of CELLS) {
      const built = build(sourceFor(cell), { emitter: cell.emitter, testOverrides: false });
      try {
        const text = built.generated.join('\n');
        expect(text, label(cell)).toContain('overrideMany');
        expect(text, `${label(cell)}: no batch table`).not.toContain('__neoNext');
        expect(text, `${label(cell)}: no override alias`).not.toMatch(/__NeoOverride/);
      } finally {
        await built.close();
      }
    }
  }, 120_000);

  it('E16-P16 the emitted batch has one reject and one table, and the aliases only for a full container with the flag', async () => {
    for (const cell of CELLS) {
      const name = label(cell);
      const on = build(sourceFor(cell), { emitter: cell.emitter, testOverrides: true });
      try {
        const text = on.generated.join('\n');
        const member = slice(text, 'public overrideMany<', ['private async _reconfigure(']);
        expect(member, `${name}: the table`).toContain('__neoNext');
        expect(member.match(/Promise\.reject/g)?.length, `${name}: one reject, in the catch`).toBe(1);
        expect(member, `${name}: no sync field read in an async output`).not.toContain(cell.timing === 'async' ? '_reconfiguring' : '_state');
        expect(text.match(/type __NeoOverrideEntry\w*/g)?.length, `${name}: one alias`).toBe(1);
        expect(member.trimEnd(), `${name}: no whitespace-only line`).not.toMatch(/^[ \t]+$/m);
        const gateIndents = member
          .split('\n')
          .filter((line) => /throw this\._neoFail\('NEO_CONTAINER_(BUSY|DESTROYED|FAILED)'/.test(line))
          .map((line) => line.length - line.trimStart().length);
        expect(gateIndents.length, `${name}: the gates are written twice`).toBe(6);
        expect(new Set(gateIndents).size, `${name}: every gate line has the indent of the others`).toBe(1);
      } finally {
        await on.close();
      }
      for (const options of [
        { profile: 'full' as const, testOverrides: false },
        { profile: 'minimal' as const, testOverrides: true },
      ]) {
        const off = build(sourceFor(cell, { profile: options.profile }), { emitter: cell.emitter, testOverrides: options.testOverrides });
        try {
          expect(off.generated.join('\n'), `${name}: ${options.profile} ${String(options.testOverrides)}`).not.toMatch(/__NeoOverride|__neoNext/);
          expect(off.generated.join('\n'), `${name}: ${options.profile} keeps its own members`).toContain(options.profile === 'full' ? 'overrideMany' : '__NeoToken');
        } finally {
          await off.close();
        }
      }
    }
  }, 120_000);
});
