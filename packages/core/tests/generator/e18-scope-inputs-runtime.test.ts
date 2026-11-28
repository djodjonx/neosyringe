import { beforeAll, describe, expect, it } from 'vitest';
import {
  CELLS,
  MATRIX,
  call,
  capabilityInputs,
  createScope,
  deferred,
  failure,
  label,
  readKey,
  shown,
  slice,
  thrown,
  use,
  withEnv,
  type Cell,
  type Env,
} from '../helpers/e18-build';
import { warmLibCache } from '../fastProgram';

/**
 * E18 scope inputs at runtime, on the two emitters, open and closed, sync and async, full and minimal. Every test calls
 * `capabilityInputs(built)` first (the analysis knows the inputs), then reads what a user can observe: the value a
 * service was given, the error code and message, the constructions and disposals counted. The containers are reached
 * through `Reflect` on `unknown`.
 */

const UNBOUND = 'NEO_SCOPE_INPUTS_UNBOUND';
const DESTROYED = 'NEO_CONTAINER_DESTROYED';
const PARENT_DESTROYED = 'NEO_SCOPE_PARENT_DESTROYED';
const NOT_EXPORTED = 'NEO_ROOT_NOT_EXPORTED';

const THREE = '[req, twin, retries]';
const only = (cells: readonly Cell[], mode: Cell['mode']): Cell[] => cells.filter((cell) => cell.mode === mode);

/** The `Svc` of a scope: its factory read a `Holder`, which read both inputs in its constructor. */
async function svcOf(cell: Cell, env: Env, scope: object): Promise<object> {
  if (cell.timing === 'async') await call(scope, 'initialize');
  const svc: unknown = use(scope, 'resolve', env.built.id('Svc'));
  if (typeof svc !== 'object' || svc === null) throw new Error('Svc is not an object');
  return svc;
}

function holderOf(svc: object): unknown {
  return readKey(svc, 'holder');
}

describe('E18 scope inputs runtime', () => {
  beforeAll(() => {
    warmLibCache();
  });

  it('E18-P1 the values of createScope reach the services in any order, by reference', async () => {
    for (const emitter of ['reference', 'optimized'] as const) {
      for (const cell of MATRIX.filter((candidate) => candidate.emitter === emitter)) {
        await withEnv(cell, {}, async (env) => {
          capabilityInputs(env.built);
          const name = label(cell);
          const given = { id: 'r1', user: 'ann' };
          const forward = env.scope([{ token: env.req, useValue: given }, { token: env.retries, useValue: 3 }]);
          const reversed = env.scope([{ token: env.retries, useValue: 4 }, { token: env.req, useValue: given }]);
          const first = holderOf(await svcOf(cell, env, forward));
          const second = holderOf(await svcOf(cell, env, reversed));
          expect(readKey(first, 'req'), `${name}: the same reference`).toBe(given);
          expect(readKey(first, 'retries'), `${name}: the property value`).toBe(3);
          expect(readKey(second, 'req'), `${name}: reversed, the same reference`).toBe(given);
          expect(readKey(second, 'retries'), `${name}: reversed, the property value`).toBe(4);
        });
      }
    }
  }, 240_000);

  it('E18-P2 a refused binding builds nothing and leaves the model usable', async () => {
    for (const cell of CELLS) {
      await withEnv(cell, { inputs: THREE }, async (env) => {
        capabilityInputs(env.built, [env.req, env.twin, env.retries]);
        const name = label(cell);
        const ok = { token: env.req, useValue: { id: 'r', user: 'u' } };
        const rest = [{ token: env.twin, useValue: { id: 't', user: 'u' } }, { token: env.retries, useValue: 1 }];
        const refused: Array<[string, () => unknown, { code: string; message: string }]> = [
          ['unknown', () => createScope(env.box, { values: [ok, ...rest, { token: 'Nope', useValue: 1 }] }), {
            code: 'NEO_SCOPE_INPUT_UNKNOWN',
            message: "NEO_SCOPE_INPUT_UNKNOWN: [E18] scope input 'Nope' is not declared",
          }],
          ['duplicate', () => createScope(env.box, { values: [ok, ...rest, ok] }), {
            code: 'NEO_SCOPE_INPUT_DUPLICATE',
            message: `NEO_SCOPE_INPUT_DUPLICATE: [E18] scope input '${shown(env.req)}' is given twice`,
          }],
          ['missing', () => createScope(env.box, { values: [ok] }), {
            code: 'NEO_SCOPE_INPUT_MISSING',
            message: `NEO_SCOPE_INPUT_MISSING: [E18] scope inputs missing: ${shown(env.twin)}, ${shown(env.retries)}`,
          }],
          ['no options', () => createScope(env.box), {
            code: 'NEO_SCOPE_INPUT_MISSING',
            message: `NEO_SCOPE_INPUT_MISSING: [E18] scope inputs missing: ${shown(env.req)}, ${shown(env.twin)}, ${shown(env.retries)}`,
          }],
          ['not an object', () => createScope(env.box, 5), {
            code: 'NEO_SCOPE_INPUTS_INVALID',
            message: 'NEO_SCOPE_INPUTS_INVALID: [E18] createScope() needs { values: [{ token, useValue }] }',
          }],
          ['values not a list', () => createScope(env.box, { values: 'req' }), {
            code: 'NEO_SCOPE_INPUTS_INVALID',
            message: 'NEO_SCOPE_INPUTS_INVALID: [E18] createScope() needs { values: [{ token, useValue }] }',
          }],
          ['values an object, not a list', () => createScope(env.box, { values: {} }), {
            code: 'NEO_SCOPE_INPUTS_INVALID',
            message: 'NEO_SCOPE_INPUTS_INVALID: [E18] createScope() needs { values: [{ token, useValue }] }',
          }],
          ['entry not an object', () => createScope(env.box, { values: [ok, 7] }), {
            code: 'NEO_SCOPE_INPUTS_INVALID',
            message: 'NEO_SCOPE_INPUTS_INVALID: [E18] createScope() needs { values: [{ token, useValue }] }',
          }],
        ];
        for (const [what, run, expected] of refused) {
          expect(thrown(run), `${name}: ${what}`).toEqual(expected);
        }
        expect(env.count('buildHolder') + env.count('buildSvc') + env.count('buildEager'), `${name}: nothing was built`).toBe(0);
        const scope = env.scope([ok, ...rest]);
        expect(readKey(holderOf(await svcOf(cell, env, scope)), 'req'), `${name}: the model still makes scopes`).toBe(ok.useValue);
      });
    }
  }, 240_000);

  it('E18-P3 an undefined given on purpose is present, an absent entry is not', async () => {
    for (const cell of CELLS) {
      await withEnv(cell, {}, async (env) => {
        capabilityInputs(env.built);
        const name = label(cell);
        const scope = env.scope([{ token: env.req, useValue: { id: 'r', user: 'u' } }, { token: env.retries, useValue: undefined }]);
        const holder = holderOf(await svcOf(cell, env, scope));
        expect(readKey(holder, 'retries'), `${name}: undefined is the value`).toBeUndefined();
        expect(thrown(() => createScope(env.box, { values: [{ token: env.req, useValue: {} }] })).code, `${name}: an absent entry`).toBe('NEO_SCOPE_INPUT_MISSING');
      });
    }
  }, 120_000);

  it('E18-P4 the entries are read once and the list is copied', async () => {
    for (const cell of CELLS) {
      await withEnv(cell, {}, async (env) => {
        capabilityInputs(env.built);
        const name = label(cell);
        const given = { id: 'r', user: 'u' };
        let tokenReads = 0;
        let valueReads = 0;
        const entry = {
          get token(): string {
            tokenReads += 1;
            return env.req;
          },
          get useValue(): object {
            valueReads += 1;
            return given;
          },
        };
        const values: unknown[] = [entry, { token: env.retries, useValue: 3 }];
        const scope = env.scope(values);
        values[0] = { token: 'Nope', useValue: 1 };
        values.length = 0;
        expect([tokenReads, valueReads], `${name}: each field once`).toEqual([1, 1]);
        expect(readKey(holderOf(await svcOf(cell, env, scope)), 'req'), `${name}: the copy is what was given`).toBe(given);
      });
    }
  }, 120_000);

  it('E18-P5 two tokens of one shape stay two tokens', async () => {
    for (const cell of CELLS) {
      await withEnv(cell, { inputs: THREE }, async (env) => {
        capabilityInputs(env.built, [env.req, env.twin, env.retries]);
        const name = label(cell);
        const a = { id: 'a', user: 'u' };
        const b = { id: 'b', user: 'u' };
        const scope = env.scope([{ token: env.req, useValue: a }, { token: env.twin, useValue: b }, { token: env.retries, useValue: 1 }]);
        if (cell.timing === 'async') await call(scope, 'initialize');
        if (cell.mode === 'open') {
          expect(use(scope, 'resolve', env.req), `${name}: Req`).toBe(a);
          expect(use(scope, 'resolve', env.twin), `${name}: Twin`).toBe(b);
        }
        expect(readKey(holderOf(await svcOf(cell, env, scope)), 'req'), `${name}: Holder reads Req`).toBe(a);
        const twice = thrown(() => createScope(env.box, { values: [...env.entries(), { token: env.twin, useValue: b }, { token: env.twin, useValue: b }] }));
        expect(twice.message, `${name}: Twin twice`).toBe(`NEO_SCOPE_INPUT_DUPLICATE: [E18] scope input '${shown(env.twin)}' is given twice`);
        const swapped = thrown(() => createScope(env.box, { values: [{ token: env.twin, useValue: a }, { token: env.retries, useValue: 1 }] }));
        expect(swapped, `${name}: Twin does not stand for Req`).toEqual({
          code: 'NEO_SCOPE_INPUT_MISSING',
          message: `NEO_SCOPE_INPUT_MISSING: [E18] scope inputs missing: ${shown(env.req)}`,
        });
      });
    }
  }, 120_000);

  it('E18-P6 two scopes keep their values, their singletons and their destruction', async () => {
    for (const cell of CELLS) {
      await withEnv(cell, {}, async (env) => {
        capabilityInputs(env.built);
        const name = label(cell);
        const givenA = { id: 'a', user: 'ann' };
        const givenB = { id: 'b', user: 'bob' };
        const scopeA = env.scope(env.entries({ req: givenA }));
        const scopeB = env.scope(env.entries({ req: givenB }));
        const a1 = await svcOf(cell, env, scopeA);
        const b1 = await svcOf(cell, env, scopeB);
        expect(use(scopeA, 'resolve', env.built.id('Svc')), `${name}: A keeps its singleton`).toBe(a1);
        expect(b1, `${name}: B has its own`).not.toBe(a1);
        expect(readKey(holderOf(a1), 'req'), `${name}: A value`).toBe(givenA);
        expect(readKey(holderOf(b1), 'req'), `${name}: B value`).toBe(givenB);
        await call(scopeA, 'destroy');
        await call(scopeA, 'destroy');
        expect(env.count('disposeHolder'), `${name}: A's owned singleton is disposed once`).toBe(1);
        expect(use(scopeB, 'resolve', env.built.id('Svc')), `${name}: B is alive`).toBe(b1);
        expect(thrown(() => use(env.box, 'resolve', env.built.id('Svc'))).code, `${name}: the model is untouched`).toBe(UNBOUND);
        const again = thrown(() => createScope(scopeB));
        expect(again.code, `${name}: a scope does not copy its values`).toBe('NEO_SCOPE_INPUT_MISSING');
        expect(again.message, `${name}: all are asked again`).toBe(
          `NEO_SCOPE_INPUT_MISSING: [E18] scope inputs missing: ${shown(env.req)}, ${shown(env.retries)}`,
        );
        const givenC = { id: 'c', user: 'cid' };
        const scopeC = env.scope(env.entries({ req: givenC }), scopeB);
        expect(readKey(holderOf(await svcOf(cell, env, scopeC)), 'req'), `${name}: new values`).toBe(givenC);
        expect(readKey(holderOf(await svcOf(cell, env, scopeB)), 'req'), `${name}: B is not changed`).toBe(givenB);
      });
    }
  }, 240_000);

  it('E18-P7 a scope is bound: the value is what createScope was given', async () => {
    for (const cell of only(CELLS, 'open')) {
      await withEnv(cell, {}, async (env) => {
        capabilityInputs(env.built);
        const name = label(cell);
        const given = { id: 'r', user: 'u' };
        const scope = env.scope(env.entries({ req: given }));
        if (cell.timing === 'async') await call(scope, 'initialize');
        expect(scope, `${name}: a new container`).not.toBe(env.box);
        expect(use(scope, 'resolve', env.req), `${name}: the input is answered`).toBe(given);
        expect(use(scope, 'resolve', env.retries), `${name}: the property input is answered`).toBe(3);
        expect(readKey(holderOf(await svcOf(cell, env, scope)), 'req'), `${name}: and read by the service`).toBe(given);
      });
    }
  }, 120_000);

  for (const member of ['resolve', 'resolveAll', 'resolveMany', 'initialize'] as const) {
    it(`E18-P8 the unbound model refuses ${member}() and stays usable`, async () => {
      for (const cell of CELLS) {
        await withEnv(cell, {}, async (env) => {
          capabilityInputs(env.built);
          const name = label(cell);
          const expected = {
            code: UNBOUND,
            message: `${UNBOUND}: [E18] ${member}() needs scope inputs: ${shown(env.req)}, ${shown(env.retries)}; call createScope({ values })`,
          };
          const svc = env.built.id('Svc');
          if (member === 'initialize') {
            const pending: unknown = Reflect.apply(Reflect.get(env.box, 'initialize'), env.box, []);
            expect(pending, `${name}: a promise`).toBeInstanceOf(Promise);
            expect(await failure(async () => pending), name).toEqual(expected);
          } else {
            const argument = member === 'resolveMany' ? [svc] : svc;
            expect(thrown(() => use(env.box, member, argument)), name).toEqual(expected);
          }
          expect(env.count('buildHolder') + env.count('buildSvc') + env.count('buildEager'), `${name}: no factory ran`).toBe(0);
          const scope = env.scope();
          expect(readKey(holderOf(await svcOf(cell, env, scope)), 'retries'), `${name}: the model still makes scopes`).toBe(3);
        });
      }
    }, 120_000);
  }

  it('E18-P9 lazy, eager and async singletons see the values on their first construction', async () => {
    for (const cell of MATRIX) {
      await withEnv(cell, {}, async (env) => {
        capabilityInputs(env.built);
        const name = label(cell);
        const given = { id: 'r', user: 'u' };
        const scope = env.scope(env.entries({ req: given }));
        if (cell.timing === 'sync' && cell.mode === 'open') {
          expect(env.count('buildHolder'), `${name}: lazy, nothing yet`).toBe(0);
        }
        const svc = await svcOf(cell, env, scope);
        expect(env.count('buildHolder'), `${name}: built once`).toBe(1);
        expect(readKey(holderOf(svc), 'req'), `${name}: with the value`).toBe(given);
        if (cell.mode === 'closed') {
          await call(scope, 'initialize');
          expect(env.count('buildEager'), `${name}: the eager root was built with the value`).toBe(1);
          expect(thrown(() => use(scope, 'resolve', env.req)).code, `${name}: an input is not a root`).toBe(NOT_EXPORTED);
        } else {
          expect(use(scope, 'resolve', env.req), `${name}: open, the input is answered`).toBe(given);
        }
      });
    }
  }, 240_000);

  it('E18-P10 values are borrowed: never disposed, whoever owns them; local singletons are disposed once', async () => {
    const before = `
export class Pooled { dispose(): void { bump('disposePooled'); } }
export const parent = defineBuilderConfig({ name: 'E18Parent', injections: [{ token: Pooled }] });
`;
    for (const cell of CELLS) {
      await withEnv(cell, { before, useContainer: 'useContainer: parent,' }, async (env) => {
        capabilityInputs(env.built);
        const name = label(cell);
        const pooled: unknown = use(env.built.exports['parent'], 'resolve', env.built.exports['Pooled']);
        if (typeof pooled !== 'object' || pooled === null) throw new Error('Pooled is not an object');
        const own = {
          id: 'own',
          user: 'u',
          dispose: (): void => {
            env.built.probe.counts['disposeOwn'] = (env.built.probe.counts['disposeOwn'] ?? 0) + 1;
          },
        };
        const scopeOwn = env.scope(env.entries({ req: own }));
        const scopePooled = env.scope(env.entries({ req: pooled }));
        await svcOf(cell, env, scopeOwn);
        expect(readKey(holderOf(await svcOf(cell, env, scopePooled)), 'req'), `${name}: the parent's resource is the value`).toBe(pooled);
        await call(scopeOwn, 'destroy');
        await call(scopePooled, 'destroy');
        expect(env.count('disposeOwn'), `${name}: a value is not disposed`).toBe(0);
        expect(env.count('disposePooled'), `${name}: the parent's resource is not disposed by the scope`).toBe(0);
        expect(env.count('disposeHolder'), `${name}: each local owned singleton is disposed once`).toBe(2);
        await call(env.built.exports['parent'], 'destroy');
        expect(env.count('disposePooled'), `${name}: the owner disposes it, once`).toBe(1);
      });
    }
  }, 240_000);

  it('E18-P11 a destroyed parent, model or scope refuses what it should', async () => {
    const before = `
export class Pooled { dispose(): void { bump('disposePooled'); } }
export const parent = defineBuilderConfig({ name: 'E18Parent', injections: [{ token: Pooled }] });
`;
    for (const cell of CELLS) {
      await withEnv(cell, { before, useContainer: 'useContainer: parent,' }, async (env) => {
        capabilityInputs(env.built);
        const name = label(cell);
        const given = { id: 'held', user: 'u' };
        const scope = env.scope(env.entries({ req: given }));
        await svcOf(cell, env, scope);
        const held = (): boolean => {
          const borrowed = readKey(scope, '_borrowed');
          return borrowed instanceof Set && borrowed.has(given);
        };
        expect(held(), `${name}: a live scope holds the value it resolved`).toBe(true);
        await call(scope, 'destroy');
        expect(readKey(scope, '_inputs'), `${name}: a destroyed scope holds no value`).toBeUndefined();
        expect(held(), `${name}: nor the object it was given`).toBe(false);
        expect(thrown(() => use(scope, 'resolve', env.built.id('Svc'))).code, `${name}: destroyed, not unbound`).toBe(DESTROYED);
        await call(env.built.exports['parent'], 'destroy');
        expect(thrown(() => createScope(env.box, { values: env.entries() })), `${name}: parent destroyed`).toEqual({
          code: PARENT_DESTROYED,
          message: `${PARENT_DESTROYED}: [E18] parent is destroyed: E18Parent`,
        });
        await call(env.box, 'destroy');
        expect(thrown(() => createScope(env.box, { values: env.entries() })), `${name}: model destroyed`).toEqual({
          code: DESTROYED,
          message: `${DESTROYED}: [E18] container is destroyed`,
        });
      });
    }
  }, 240_000);

  it('E18-P12 the plan is built once per class, not once per scope', async () => {
    const after = `
export const second = defineBuilderConfig({ name: 'E18Two', scopeInputs: [req], injections: [{ token: Eager }] });
`;
    await withEnv(CELLS[0] as Cell, { after }, async (env) => {
      capabilityInputs(env.built);
      const text = env.built.generated.join('\n');
      expect(text.match(/static readonly _inputPlan\b/g)?.length ?? 0, 'one plan per class with inputs').toBe(2);
      for (const generated of env.built.generated) {
        if (!generated.includes('_inputPlan')) continue;
        const method = slice(generated, 'public createScope(', ['\n  public ', '\n  private ']);
        expect(method, 'createScope binds through the plan').toContain('_inputPlan.bind(');
        expect(method, 'createScope does not build the plan').not.toContain('_createInputPlan(');
      }
    });
  }, 120_000);

  it('E18-P17 a destroy refused while an override runs leaves the values of the scope in place', async () => {
    for (const cell of CELLS) {
      await withEnv(cell, { slow: true, testOverrides: true }, async (env) => {
        capabilityInputs(env.built);
        const name = label(cell);
        const gate = deferred();
        env.built.probe.saved[0] = gate.promise;
        try {
          const given = { id: 'r', user: 'u' };
          const scope = env.scope(env.entries({ req: given }));
          await svcOf(cell, env, scope);
          const pending = call(scope, 'override', [env.built.exports['Slow'], () => ({ dispose: (): void => {} })]);
          expect(await failure(() => call(scope, 'destroy')), `${name}: destroy is refused while the override runs`).toEqual({
            code: 'NEO_CONTAINER_BUSY',
            message: 'NEO_CONTAINER_BUSY: [E18] container is transitioning',
          });
          gate.open();
          await pending;
          expect(readKey(scope, '_inputs'), `${name}: the scope was not destroyed, it keeps its values`).toBeDefined();
          const holder = holderOf(await svcOf(cell, env, scope));
          expect(readKey(holder, 'req'), `${name}: a service built after it reads the value`).toBe(given);
          expect(readKey(holder, 'retries'), `${name}: and the property value`).toBe(3);
          await call(scope, 'destroy');
          expect(readKey(scope, '_inputs'), `${name}: a destroy that goes through releases them`).toBeUndefined();
        } finally {
          gate.open();
        }
      });
    }
  }, 240_000);

  it('E18-P18 a destroy whose disposal fails still releases the values of the scope', async () => {
    for (const cell of CELLS) {
      await withEnv(cell, {}, async (env) => {
        capabilityInputs(env.built);
        const name = label(cell);
        const given = { id: 'r', user: 'u' };
        const scope = env.scope(env.entries({ req: given }));
        await svcOf(cell, env, scope);
        env.built.probe.fail = new Error('dispose failed');
        const outcome = await call(scope, 'destroy').then(() => 'resolved', () => 'rejected');
        env.built.probe.fail = undefined;
        expect(outcome, `${name}: the disposal error reaches the caller`).toBe('rejected');
        expect(readKey(scope, '_inputs'), `${name}: the scope is closed, its values are released`).toBeUndefined();
        const borrowed = readKey(scope, '_borrowed');
        expect(borrowed instanceof Set && borrowed.has(given), `${name}: and the object it was given`).toBe(false);
      });
    }
  }, 240_000);
});
