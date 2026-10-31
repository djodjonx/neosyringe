import { describe, expect, it } from 'vitest';
import { executeFixture } from './helpers/execute-fixture';

const MARKERS = `import { defineBuilderConfig, definePartialConfig, useInterface } from '@djodjonx/neosyringe';`;

async function runFixture(source: string): Promise<unknown> {
  const outcome = await executeFixture(source);
  expect(outcome.phase).toBe('ok');
  if (outcome.phase !== 'ok') return undefined;
  return outcome.value;
}

describe('T04 graphe et constructeurs', () => {
  it('T04-A01 Derived sans constructeur reçoit le logger', async () => {
    const value = await runFixture(`
      ${MARKERS}

      class A01Logger { readonly id = 'L'; }
      class A01Base {
        constructor(public logger: A01Logger) {}
      }
      class A01Derived extends A01Base {}
      class A01Deeper extends A01Derived {}

      export const c = defineBuilderConfig({
        injections: [
          { token: A01Logger },
          { token: A01Derived },
          { token: A01Deeper },
        ],
      });

      export function run() {
        const logger = c.resolve(A01Logger);
        return {
          one: c.resolve(A01Derived).logger === logger,
          two: c.resolve(A01Deeper).logger === logger,
        };
      }
    `);
    expect(value).toEqual({ one: true, two: true });
  });

  it('T04-A02 base générique spécialisée', async () => {
    const value = await runFixture(`
      ${MARKERS}

      class A02Logger { readonly id = 'L'; }
      class A02Base<T> {
        constructor(public dep: T) {}
      }
      class A02Repo extends A02Base<A02Logger> {}

      export const c = defineBuilderConfig({
        injections: [
          { token: A02Logger },
          { token: A02Repo },
        ],
      });

      export function run() {
        return c.resolve(A02Repo).dep === c.resolve(A02Logger);
      }
    `);
    expect(value).toBe(true);
  });

  it('T04-A03 constructeur propre sans double injection', async () => {
    const value = await runFixture(`
      ${MARKERS}

      class A03Logger {}
      class A03Other { readonly id = 'O'; }
      class A03Base {
        constructor(public logger: A03Logger) {}
      }
      class A03Derived extends A03Base {
        readonly argc: number;
        constructor(public other: A03Other) {
          super(new A03Logger());
          this.argc = arguments.length;
        }
      }

      export const c = defineBuilderConfig({
        injections: [
          { token: A03Logger },
          { token: A03Other },
          { token: A03Derived },
        ],
      });

      export function run() {
        const derived = c.resolve(A03Derived);
        return {
          argc: derived.argc,
          sameOther: derived.other === c.resolve(A03Other),
          loggerIsRegistered: derived.logger === c.resolve(A03Logger),
        };
      }
    `);
    expect(value).toEqual({ argc: 1, sameOther: true, loggerIsRegistered: false });
  });

  it('T04-A04 positions', async () => {
    const value = await runFixture(`
      ${MARKERS}

      class A04A { readonly id = 'a'; }
      class A04B { readonly id = 'b'; }
      class A04C { readonly id = 'c'; }
      class A04D { readonly id = 'd'; }
      const a04Fallback = new A04D();
      class A04Holder {
        constructor(
          public a: A04A,
          public b?: A04B,
          public c: A04C,
          public d: A04D = a04Fallback,
        ) {}
      }

      export const c = defineBuilderConfig({
        injections: [
          { token: A04A },
          { token: A04C },
          { token: A04Holder },
        ],
      });

      export function run() {
        const holder = c.resolve(A04Holder);
        return {
          a: holder.a === c.resolve(A04A),
          b: holder.b,
          c: holder.c === c.resolve(A04C),
          d: holder.d === a04Fallback,
        };
      }
    `);
    expect(value).toEqual({ a: true, b: undefined, c: true, d: true });
  });

  it('T04-A05 ordre', async () => {
    const value = await runFixture(`
      ${MARKERS}

      interface A05Port { tag: string }
      class A05P1 implements A05Port { tag = 'p1'; }
      class A05P2 implements A05Port { tag = 'p2'; }
      class A05Local implements A05Port { tag = 'local'; }

      const partial1 = definePartialConfig({
        injections: [{ token: useInterface<A05Port>(), provider: A05P1, multi: true }],
      });
      const partial2 = definePartialConfig({
        injections: [{ token: useInterface<A05Port>(), provider: A05P2, multi: true }],
      });

      export const c = defineBuilderConfig({
        extends: [partial1, partial2],
        injections: [{ token: useInterface<A05Port>(), provider: A05Local, multi: true }],
      });

      export function run() {
        const read = () => c.resolveAll(useInterface<A05Port>()).map((item: A05Port) => item.tag);
        const first = read();
        const second = read();
        return { first, second };
      }
    `);
    expect(value).toEqual({
      first: ['p1', 'p2', 'local'],
      second: ['p1', 'p2', 'local'],
    });
  });

  it('T04-P12 défaut et optionnel sans jeton', async () => {
    const outcome = await executeFixture(`
      ${MARKERS}

      class P12Dep { readonly id = 'dep'; }
      class P12Opts {
        constructor(private opts = { retries: 3 }, public dep: P12Dep) {}
        read(): { retries: number; dep: string } {
          return { retries: this.opts.retries, dep: this.dep.id };
        }
      }
      class P12Optional {
        constructor(public x?, public dep: P12Dep) {}
      }

      export const c = defineBuilderConfig({
        injections: [
          { token: P12Dep },
          { token: P12Opts },
          { token: P12Optional },
        ],
      });

      export function run() {
        const opts = c.resolve(P12Opts);
        const optional = c.resolve(P12Optional);
        return {
          retries: opts.read().retries,
          sameDep: opts.dep === c.resolve(P12Dep),
          optional: optional.x,
          optionalDep: optional.dep === c.resolve(P12Dep),
        };
      }
    `);
    const value = outcome.phase === 'ok'
      ? outcome.value
      : outcome.phase === 'build'
        ? outcome.diagnostic
        : outcome.error;
    expect(value).toEqual({ retries: 3, sameDep: true, optional: undefined, optionalDep: true });
  });
});
