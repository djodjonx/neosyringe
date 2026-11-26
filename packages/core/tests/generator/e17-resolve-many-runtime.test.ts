import { beforeAll, describe, expect, it } from 'vitest';
import { CELLS, emitProduct, type ContractCell, type Executed } from '../helpers/t00-contract';
import {
  EMITTERS,
  HEAD,
  capability,
  codeOf,
  failureOf,
  many,
  method,
  one,
  readKey,
  thrownBy,
  withBuilt,
  type Emitter,
} from '../helpers/e17-build';
import { warmLibCache } from '../fastProgram';

/**
 * E17 `resolveMany` at runtime, on the two emitters. Every test calls `capability(box)` first (through `many`), then
 * reads what a user can observe: the values, their order and identity, the error codes and messages, the constructions
 * that happened. The container is reached through `Reflect` on `unknown`, never through a typed handle.
 */

const NOT_INITIALIZED = 'NEO_NOT_INITIALIZED';
const DESTROYED = 'NEO_CONTAINER_DESTROYED';
const ROOT_NOT_EXPORTED = 'NEO_ROOT_NOT_EXPORTED';
const PARENT_DESTROYED = 'NEO_SCOPE_PARENT_DESTROYED';

function label(cell: ContractCell, emitter: Emitter): string {
  return `${emitter} ${cell.profile} ${cell.mode} ${cell.timing} ${cell.owner}`;
}

function asArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error(`not an array: ${String(value)}`);
  return value;
}

function n(value: unknown): unknown {
  return readKey(value, 'n');
}

/** Emits one matrix cell, runs `scenario`, and always releases what the cell opened. */
async function withCell<T>(cell: ContractCell, emitter: Emitter, scenario: (executed: Executed) => Promise<T> | T): Promise<T> {
  const executed = await emitProduct(cell, emitter);
  try {
    return await scenario(executed);
  } finally {
    await executed.close();
  }
}

const ROOT_CELLS = CELLS.filter((cell) => cell.owner === 'root');

describe('E17 resolveMany runtime', () => {
  beforeAll(() => {
    warmLibCache();
  });

  it('E17-P1 resolves [single, fresh, single, fresh] in order, with singleton identity and fresh transients, in every cell', async () => {
    for (const emitter of EMITTERS) {
      for (const cell of CELLS) {
        await withCell(cell, emitter, async (executed) => {
          const { box } = executed;
          capability(box);
          if (cell.timing === 'async') await box.initialize();
          const tokens = [executed.single, executed.fresh, executed.single, executed.fresh];
          const values = asArray(many(box, tokens));
          const name = label(cell, emitter);
          expect(values, name).toHaveLength(4);
          expect(n(values[0]), `${name}: single`).toBe(1);
          expect(n(values[1]), `${name}: fresh`).toBe(2);
          expect(values[2], `${name}: the singleton twice`).toBe(values[0]);
          expect(values[3], `${name}: a new transient each time`).not.toBe(values[1]);
          expect(n(values[3]), `${name}: second fresh`).toBe(2);
          expect(box.resolve(executed.single), `${name}: same instance as resolve`).toBe(values[0]);
          const swapped = asArray(many(box, [executed.fresh, executed.single]));
          expect(swapped.map(n), `${name}: left to right`).toEqual([2, 1]);
          if (cell.owner === 'scope') {
            const scope = box.createScope();
            try {
              if (cell.timing === 'async') await scope.initialize();
              const scoped = asArray(many(scope, [executed.single]));
              expect(scoped[0], `${name}: the scope has its own singleton`).not.toBe(values[0]);
              expect(scoped[0], `${name}: and keeps it`).toBe(scope.resolve(executed.single));
            } finally {
              await scope.destroy();
            }
          }
        });
      }
    }
  }, 120_000);

  const MIXED = `${HEAD}
export class Plain { n = 1; }
export class Jwt { constructor(readonly secret: string) {} }
interface Port { n: number }
const port = useInterface<Port>();
const secret = useProperty<string>(Jwt, 'secret');
export const box = defineBuilderConfig({
  name: 'Mixed',
  injections: [
    { token: Plain },
    { token: port, useFactory: true, dependencies: [], lifecycle: 'transient', provider: () => ({ n: 2 }) },
    { token: secret, useFactory: true, dependencies: [], provider: () => 's3cret' },
    { token: Jwt },
  ],
});
`;

  it('E17-P1b resolves class, interface and property tokens, from frozen, runtime-built, empty, union and duplicate lists', async () => {
    for (const emitter of EMITTERS) {
      await withBuilt(MIXED, { emitter }, (built) => {
        const box = built.box();
        capability(box);
        const plain = built.exports.Plain;
        const jwt = built.exports.Jwt;
        const port = built.id('Port');
        const secret = built.id('secret');
        const tuple = asArray(many(box, [plain, port, secret, jwt]));
        expect(tuple, emitter).toHaveLength(4);
        expect(tuple[0], `${emitter}: class`).toBe(one(box, plain));
        expect(n(tuple[1]), `${emitter}: interface`).toBe(2);
        expect(tuple[2], `${emitter}: property`).toBe('s3cret');
        expect(readKey(tuple[3], 'secret'), `${emitter}: constructor property`).toBe('s3cret');
        const frozen = Object.freeze([secret, plain]);
        expect(many(box, frozen), `${emitter}: frozen input`).toEqual(['s3cret', one(box, plain)]);
        expect(Object.isFrozen(frozen), `${emitter}: input untouched`).toBe(true);
        const names = ['Plain', 'Port'];
        const built2 = names.map((name) => (name === 'Plain' ? plain : port));
        expect(asArray(many(box, built2)).map(n), `${emitter}: runtime-built array`).toEqual([1, 2]);
        const first = asArray(many(box, []));
        const second = asArray(many(box, []));
        expect(first, `${emitter}: empty`).toEqual([]);
        expect(second, `${emitter}: empty again`).toEqual([]);
        expect(first === second, `${emitter}: a new array each call`).toBe(false);
        const union: unknown[] = [plain, secret];
        expect(many(box, union), `${emitter}: union list`).toEqual([one(box, plain), 's3cret']);
        const twice = asArray(many(box, [plain, plain]));
        expect(twice[1], `${emitter}: duplicates kept, same singleton`).toBe(twice[0]);
        const out = asArray(many(box, [secret]));
        out.push('mutated');
        expect(many(box, [secret]), `${emitter}: the result is not shared`).toEqual(['s3cret']);
      });
    }
  });

  it('E17-P1b a token list changed while the batch runs is read once, from a copy', async () => {
    const source = `${HEAD}
export class First { constructor() { probe.log.push('First'); const list = Reflect.get(probe, 'list'); if (Array.isArray(list)) list.push(Last); } }
export class Last { constructor() { probe.log.push('Last'); } }
export const box = defineBuilderConfig({ name: 'Copy', injections: [{ token: First }, { token: Last }] });
`;
    for (const emitter of EMITTERS) {
      await withBuilt(source, { emitter }, (built) => {
        const box = built.box();
        capability(box);
        const list: unknown[] = [built.exports.First];
        Reflect.set(built.probe, 'list', list);
        const values = asArray(many(box, list));
        expect(values, `${emitter}: only the token of the call`).toHaveLength(1);
        expect(built.probe.log, `${emitter}: Last never built`).toEqual(['First']);
      });
    }
  });

  const SEQUENCE = `${HEAD}
function count(name: string): void { probe.counts[name] = (probe.counts[name] ?? 0) + 1; probe.log.push(name); }
export class A { constructor() { count('A'); } }
export class C { constructor() { count('C'); } }
interface Bx { n: number }
const boom = useInterface<Bx>();
export const box = defineBuilderConfig({
  name: 'Sequence',
  injections: [
    { token: A },
    { token: boom, useFactory: true, dependencies: [], provider: () => { count('B'); if (probe.fail) throw probe.fail; return { n: 1 }; } },
    { token: C },
  ],
});
`;

  it('E17-P2 stops on the first error: the same Error, the third token never built, the first stays constructed', async () => {
    for (const emitter of EMITTERS) {
      await withBuilt(SEQUENCE, { emitter }, (built) => {
        const box = built.box();
        capability(box);
        const failure = new Error('boom');
        built.probe.fail = failure;
        const a = built.exports.A;
        const c = built.exports.C;
        const thrown = thrownBy(() => many(box, [a, built.id('Bx'), c]));
        expect(thrown, `${emitter}: the factory's own error`).toBe(failure);
        expect(built.probe.log, `${emitter}: built in order, stopped at B`).toEqual(['A', 'B']);
        expect(built.probe.counts.C ?? 0, `${emitter}: C never resolved`).toBe(0);
        const later = one(box, a);
        expect(later, `${emitter}: A kept`).toBe(one(box, a));
        expect(built.probe.counts.A, `${emitter}: A built once`).toBe(1);
      });
    }
  });

  it('E17-P3 a destroyed container refuses a batch, empty or not, like resolve, in every profile, timing and mode', async () => {
    for (const emitter of EMITTERS) {
      for (const cell of ROOT_CELLS) {
        await withCell(cell, emitter, async (executed) => {
          const { box } = executed;
          capability(box);
          await box.destroy();
          const name = label(cell, emitter);
          const expected = failureOf(() => box.resolve(executed.single));
          expect(expected?.code, `${name}: resolve`).toBe(DESTROYED);
          expect(failureOf(() => many(box, [])), `${name}: empty batch`).toEqual(expected);
          expect(failureOf(() => many(box, [executed.single])), `${name}: batch`).toEqual(expected);
        });
      }
    }
  }, 120_000);

  it('E17-P4 a closed container refuses a private token inside a batch with the code and message of resolve', async () => {
    const closed = ROOT_CELLS.filter((cell) => cell.mode === 'closed');
    for (const emitter of EMITTERS) {
      for (const cell of closed) {
        await withCell(cell, emitter, async (executed) => {
          const { box } = executed;
          capability(box);
          if (cell.timing === 'async') await box.initialize();
          const name = label(cell, emitter);
          const expected = failureOf(() => box.resolve(executed.hidden));
          expect(expected?.code, `${name}: resolve`).toBe(ROOT_NOT_EXPORTED);
          expect(failureOf(() => many(box, [executed.single, executed.hidden])), `${name}: second`).toEqual(expected);
          expect(failureOf(() => many(box, [executed.hidden, executed.single])), `${name}: first`).toEqual(expected);
        });
      }
    }
  }, 120_000);

  it('E17-P5 an async container refuses a batch, empty or not, before initialize, and answers values after it', async () => {
    const asyncCells = ROOT_CELLS.filter((cell) => cell.timing === 'async');
    for (const emitter of EMITTERS) {
      for (const cell of asyncCells) {
        await withCell(cell, emitter, async (executed) => {
          const { box } = executed;
          capability(box);
          const name = label(cell, emitter);
          const expected = failureOf(() => box.resolve(executed.single));
          expect(expected?.code, `${name}: resolve`).toBe(NOT_INITIALIZED);
          // The guard is resolve's, the message names the method that was called.
          const asMany = { code: NOT_INITIALIZED, message: (expected?.message ?? '').replace('resolve()', 'resolveMany()') };
          expect(failureOf(() => many(box, [])), `${name}: empty batch`).toEqual(asMany);
          expect(failureOf(() => many(box, [executed.single])), `${name}: batch`).toEqual(asMany);
          await box.initialize();
          const values = asArray(many(box, [executed.single, executed.fresh]));
          expect(values.some((value) => value instanceof Promise), `${name}: no promise`).toBe(false);
          expect(values.map(n), name).toEqual([1, 2]);
        });
      }
    }
  }, 120_000);

  it('E17-P6 a child refuses a batch, empty or not, once its parent is destroyed, like resolve', async () => {
    const children = CELLS.filter((cell) => cell.owner === 'parent');
    for (const emitter of EMITTERS) {
      for (const cell of children) {
        await withCell(cell, emitter, async (executed) => {
          const { box, parent } = executed;
          capability(box);
          if (!parent) throw new Error('parent cell has no parent');
          if (cell.timing === 'async') await box.initialize();
          await parent.destroy();
          const name = label(cell, emitter);
          const expected = failureOf(() => box.resolve(executed.single));
          expect(expected?.code, `${name}: resolve`).toBe(PARENT_DESTROYED);
          expect(failureOf(() => many(box, [])), `${name}: empty batch`).toEqual(expected);
          expect(failureOf(() => many(box, [executed.single])), `${name}: batch`).toEqual(expected);
          if (executed.parentToken !== undefined && cell.mode === 'open') {
            expect(codeOf(() => many(box, [executed.parentToken])), `${name}: parent token`).toBe(PARENT_DESTROYED);
          }
        });
      }
    }
  }, 120_000);

  it('E17-P13 a batch of 1000 tokens answers 1000 values in order', async () => {
    const classes = Array.from({ length: 1000 }, (_, index) => `export class T${index} { n = ${index}; readonly id = 'T${index}'; }`).join('\n');
    const rows = Array.from({ length: 1000 }, (_, index) => `{ token: T${index} }`).join(',\n    ');
    const source = `${HEAD}
${classes}
export const box = defineBuilderConfig({ name: 'Thousand', injections: [
    ${rows},
] });
`;
    for (const emitter of EMITTERS) {
      await withBuilt(source, { emitter }, (built) => {
        const box = built.box();
        capability(box);
        const tokens = Array.from({ length: 1000 }, (_, index) => built.exports[`T${index}`]);
        const values = asArray(many(box, tokens));
        expect(values, emitter).toHaveLength(1000);
        expect(values.map(n), `${emitter}: order`).toEqual(Array.from({ length: 1000 }, (_, index) => index));
        expect(values.map((value) => readKey(value, 'id')), `${emitter}: ids`).toEqual(Array.from({ length: 1000 }, (_, index) => `T${index}`));
        const last = method(box, 'resolve', [tokens[999]]);
        expect(values[999], `${emitter}: last is the singleton`).toBe(last);
      });
    }
  }, 120_000);
});
