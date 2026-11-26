import { beforeAll, describe, expect, it } from 'vitest';
import { warmLibCache } from '../fastProgram';
import { EMITTERS, checkStrict, emitCase, formatDiagnostic, unsafeTypesMessage, type EmissionCase } from '../helpers/t23-program';

/**
 * T14 factory types. The user's factory is copied into the output typed against the type its registration is declared
 * under, and the multi accessors answer that type like the single accessors do. The output holds no unsafe type and
 * passes a strict Program, the consumer included.
 */

const STUB = `
  import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';
  declare function defineBuilderConfig<T>(config: T): T;
  declare function useInterface<T>(): T;
`;

/** The interfaces are exported: the output names them through `import type`, so the accessors can be typed. */
const SOURCE = `
  ${STUB}
  export class T14Dep { n = 1; }
  export interface T14Item { n: number }
  export interface T14Made { n: number }
  export interface T14Later { n: number }
  const item = useInterface<T14Item>();
  const made = useInterface<T14Made>();
  const later = useInterface<T14Later>();
  export const box = defineBuilderConfig({
    name: 'T14Box',
    injections: [
      { token: T14Dep },
      { token: item, multi: true, useFactory: true, dependencies: [T14Dep], provider: (ctx) => ((dep: T14Dep) => ({ n: dep.n }))(ctx.resolve(T14Dep)) },
      { token: item, multi: true, useFactory: true, dependencies: [], provider: async () => ({ n: 2 }) },
      { token: item, multi: true, useValue: { n: 3 } },
      { token: made, useFactory: true, dependencies: [T14Dep], provider: (ctx) => ((dep: T14Dep) => ({ n: dep.n }))(ctx.resolve(T14Dep)) },
      { token: later, useFactory: true, dependencies: [T14Dep], provider: async (ctx) => ((dep: T14Dep) => ({ n: dep.n }))(ctx.resolve(T14Dep)) },
    ],
  });
`;

/** `T14Dep` is a name of the user's file: the output is a separate file, the factory text reads it as a type. */
const AMBIENT = 'declare class T14Dep { n: number }\n';

const CASE: EmissionCase = {
  name: 't14 typed factories',
  profile: 'full',
  source: SOURCE,
  testOverrides: false,
  parent: false,
  ambient: AMBIENT,
};

/** The context type the copied factory is written against: the public shape, generic in what it answers. */
const CONTEXT = '\\(context: \\{ resolve<T>\\(token: unknown\\): T; resolveAll<T>\\(token: unknown\\): T\\[\\]; resolveMany<const T extends readonly __NeoToken<unknown>\\[\\]>\\(tokens: T\\): __NeoValues<T>; resolveMany<const T extends readonly \\(__NeoToken<unknown> \\| string\\)\\[\\]>\\(tokens: T\\): \\{ -readonly \\[K in keyof T\\]: T\\[K\\] extends infer E \\? E extends string \\? unknown : E extends __NeoToken<infer V> \\? V : never : never \\} \\}\\)';

/**
 * The public `Factory<T>` answers `T | PromiseLike<T>`. The analyzer flags `isAsync` only for an `async` function or a
 * return type named `Promise`/`PromiseLike`, so these two factories are not flagged and still answer a promise.
 */
const WIDE_SOURCE = `
  ${STUB}
  export interface T14Wide { n: number }
  export interface T14Chained { n: number }
  export class T14Chain<T> implements PromiseLike<T> {
    constructor(private readonly value: T) {}
    then<R1 = T, R2 = never>(
      onfulfilled?: ((value: T) => R1 | PromiseLike<R1>) | null,
      onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
    ): PromiseLike<R1 | R2> {
      return Promise.resolve(this.value).then(onfulfilled, onrejected);
    }
  }
  const wide = useInterface<T14Wide>();
  const chained = useInterface<T14Chained>();
  export const box = defineBuilderConfig({
    name: 'T14Wide',
    injections: [
      { token: wide, useFactory: true, dependencies: [], provider: (): T14Wide | Promise<T14Wide> => Promise.resolve({ n: 1 }) },
      { token: chained, useFactory: true, dependencies: [], provider: (): T14Chain<T14Chained> => new T14Chain({ n: 2 }) },
    ],
  });
`;

const WIDE_AMBIENT = `interface T14Wide { n: number }
interface T14Chained { n: number }
declare class T14Chain<T> implements PromiseLike<T> {
  constructor(value: T);
  then<R1 = T, R2 = never>(
    onfulfilled?: ((value: T) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2>;
}
`;

const WIDE_CASE: EmissionCase = {
  name: 't14 wide factories',
  profile: 'full',
  source: WIDE_SOURCE,
  testOverrides: false,
  parent: false,
  ambient: WIDE_AMBIENT,
};

describe('T14 factory types', () => {
  beforeAll(() => {
    warmLibCache();
  });

  it('P8 the multi accessors and the copied user factories are typed, and the output passes a strict Program', () => {
    for (const emitter of EMITTERS) {
      const emitted = emitCase(CASE, emitter);
      const code = emitted.outputs.map((output) => output.code).join('\n');
      // Every factory answers the public `Factory<T>` return: the declared type or a promise of it.
      expect(code, `${emitter}: sync factory typed`).toMatch(
        new RegExp(`const userFactory: ${CONTEXT} => (\\S*T14Made) \\| PromiseLike<\\1> = `),
      );
      expect(code, `${emitter}: async factory typed`).toMatch(
        new RegExp(`const userFactory: ${CONTEXT} => (\\S*T14Later) \\| PromiseLike<\\1> = async`),
      );
      expect(code, `${emitter}: a multi factory typed with the declared item type`).toMatch(
        new RegExp(`const userFactory: ${CONTEXT} => (\\S*T14Item) \\| PromiseLike<\\1> = \\(ctx\\)`),
      );
      // The creators keep `unknown`: the thenable branch of the invocation may return a promise.
      expect(code, `${emitter}: creators`).toMatch(/private create_T14Made_\w+\(\): unknown \{/);
      if (emitter === 'optimized') {
        expect(code, 'multi accessors typed').toMatch(/private _direct_T14Item_\w+_0\(\): \S*T14Item \{/);
        expect(code, 'multi accessors typed').toMatch(/private _direct_T14Item_\w+_1\(\): \S*T14Item \{/);
        expect(code, 'multi accessors typed').toMatch(/private _direct_T14Item_\w+_2\(\): \S*T14Item \{/);
        expect(code, 'no multi accessor answers unknown').not.toMatch(/private _direct_T14Item_\w+_\d+\(\): unknown/);
      }
      for (const output of emitted.outputs) {
        expect(unsafeTypesMessage(output.code, output.file), `${emitter} ${output.file}`).toBe('');
      }
      expect(checkStrict(emitted.input).map(formatDiagnostic), `${emitter}: strict diagnostics`).toEqual([]);
    }
  }, 120_000);

  it('P8c a factory answering a promise or a thenable without being flagged async is not refused', () => {
    for (const emitter of EMITTERS) {
      const emitted = emitCase(WIDE_CASE, emitter);
      const code = emitted.outputs.map((output) => output.code).join('\n');
      expect(checkStrict(emitted.input).map(formatDiagnostic), `${emitter}: strict diagnostics`).toEqual([]);
      for (const output of emitted.outputs) {
        expect(unsafeTypesMessage(output.code, output.file), `${emitter} ${output.file}`).toBe('');
      }
      expect(code, `${emitter}: union with a promise typed`).toMatch(
        new RegExp(`const userFactory: ${CONTEXT} => (\\S*T14Wide) \\| PromiseLike<\\1> = \\(\\): `),
      );
      expect(code, `${emitter}: thenable class typed`).toMatch(
        new RegExp(`const userFactory: ${CONTEXT} => (\\S*T14Chained) \\| PromiseLike<\\1> = \\(\\): `),
      );
    }
  }, 120_000);
});
