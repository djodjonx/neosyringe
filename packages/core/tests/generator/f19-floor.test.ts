import { describe, expect, it } from 'vitest';
import {
  EMITTERS,
  checkStrict,
  emitCase,
  formatDiagnostic,
  unsafeTypesMessage,
  type EmissionCase,
} from '../helpers/t23-program';

/**
 * F19, the output of a container that takes a signal type-checks where the other outputs do: strict, lib es2021, no dom
 * and no node (docs/release/compatibility.md, "Floor of the emitted code"), and it holds no unsafe type
 * (scripts/ci/lib/no-unsafe-types.mjs). `AbortSignal` and `AbortController` are not in that lib, so the output declares a
 * structural signal type and reads the controller from `globalThis`. The factories of the sources below read
 * `ctx.signal`, so the type of the context the output gives them is checked too. The user's source is an input, not a
 * subject.
 */

const STUB = `
  import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';
  declare function defineBuilderConfig<T>(config: T): T;
  declare function useInterface<T>(): T;
`;

type Profile = 'full' | 'minimal';

/** An async container: declared and opaque factories read `ctx.signal`, with and without a bounded concurrency. */
function asyncSource(profile: Profile, roots: string | undefined, concurrency: boolean): string {
  const optimization = roots === undefined ? '' : `optimization: { mode: 'closed', roots: [${roots}] },`;
  return `
  ${STUB}
  export class F19Db { dispose(): void {} }
  interface F19Made { n: number }
  interface F19Port { id: string }
  const made = useInterface<F19Made>();
  const port = useInterface<F19Port>();
  export const box = defineBuilderConfig({
    name: 'F19Floor',
    runtime: { profile: '${profile}' },
    ${concurrency ? 'initialization: { concurrency: 3 },' : ''}
    ${optimization}
    injections: [
      { token: F19Db },
      { token: made, useFactory: true, dependencies: [F19Db], provider: async (ctx) => {
        const aborted: boolean = ctx.signal.aborted;
        ctx.signal.addEventListener('abort', () => {}, { once: true });
        return { n: aborted ? 0 : 4 };
      } },
      { token: port, useFactory: true, dependencies: [made], provider: async (ctx) => {
        ctx.signal.removeEventListener('abort', () => {});
        return { id: String(ctx.signal.reason) };
      } },
    ],
  });
`;
}

/** A sync container whose factory reads the signal: the signal is never aborted, and the class has no initialization to cancel. */
function syncSource(profile: Profile, roots: string | undefined): string {
  const optimization = roots === undefined ? '' : `optimization: { mode: 'closed', roots: [${roots}] },`;
  return `
  ${STUB}
  interface F19Plain { n: number }
  const plain = useInterface<F19Plain>();
  export const box = defineBuilderConfig({
    name: 'F19SyncFloor',
    runtime: { profile: '${profile}' },
    ${optimization}
    injections: [
      { token: plain, useFactory: true, dependencies: [], provider: (ctx) => ({ n: ctx.signal.aborted ? 1 : 2 }) },
    ],
  });
`;
}

function cell(name: string, profile: Profile, source: string): EmissionCase {
  return { name, profile, source, testOverrides: false, parent: false };
}

const CLOSED_ROOTS = 'F19Db, made, port';

const ASYNC_CELLS: readonly EmissionCase[] = [
  cell('f19 async full open', 'full', asyncSource('full', undefined, false)),
  cell('f19 async full closed', 'full', asyncSource('full', CLOSED_ROOTS, false)),
  cell('f19 async minimal open', 'minimal', asyncSource('minimal', undefined, false)),
  cell('f19 async minimal closed', 'minimal', asyncSource('minimal', CLOSED_ROOTS, false)),
  cell('f19 async full open N=3', 'full', asyncSource('full', undefined, true)),
  cell('f19 async minimal closed N=3', 'minimal', asyncSource('minimal', CLOSED_ROOTS, true)),
];

const SYNC_CELLS: readonly EmissionCase[] = [
  cell('f19 sync full open', 'full', syncSource('full', undefined)),
  cell('f19 sync minimal closed', 'minimal', syncSource('minimal', 'plain')),
];

const ES2021 = ['lib.es2021.d.ts'] as const;

describe('F19 the output of a container that takes a signal type-checks at lib es2021 and holds no unsafe type', () => {
  for (const emitter of EMITTERS) {
    for (const item of ASYNC_CELLS) {
      it(`F19-floor ${emitter}, ${item.name}: the output has the signal members, no diagnostic at lib es2021, no unsafe type`, () => {
        const emitted = emitCase(item, emitter);
        const code = emitted.outputs[0]?.code ?? '';
        expect(code).toContain('_neoCheck');
        expect(code).toContain('__neoController');
        expect(checkStrict({ ...emitted.input, lib: ES2021 }).map(formatDiagnostic)).toEqual([]);
        expect(unsafeTypesMessage(code, 'box.out.ts')).toBe('');
      });
    }

    for (const item of SYNC_CELLS) {
      it(`F19-floor ${emitter}, ${item.name}: a sync class has an idle signal and no controller of its own, no diagnostic at lib es2021`, () => {
        const emitted = emitCase(item, emitter);
        const code = emitted.outputs[0]?.code ?? '';
        expect(code).toContain('_neoSignal');
        expect(code).not.toContain('_initController');
        expect(checkStrict({ ...emitted.input, lib: ES2021 }).map(formatDiagnostic)).toEqual([]);
        expect(unsafeTypesMessage(code, 'box.out.ts')).toBe('');
      });
    }
  }
});

/** A sync container with no factory at all: classes and a value. Nothing in it reads a signal. */
function plainSource(profile: Profile, roots: string | undefined): string {
  const optimization = roots === undefined ? '' : `optimization: { mode: 'closed', roots: [${roots}] },`;
  return `
  ${STUB}
  export class F19Leaf { n = 1; }
  export class F19User { constructor(readonly leaf: F19Leaf) {} }
  interface F19Conf { url: string }
  const conf = useInterface<F19Conf>();
  export const box = defineBuilderConfig({
    name: 'F19Plain',
    runtime: { profile: '${profile}' },
    ${optimization}
    injections: [
      { token: F19Leaf },
      { token: F19User },
      { token: conf, useValue: { url: 'x' } },
    ],
  });
`;
}

const PLAIN_CELLS: readonly EmissionCase[] = [
  cell('f19 plain full open', 'full', plainSource('full', undefined)),
  cell('f19 plain full closed', 'full', plainSource('full', 'F19User, conf')),
  cell('f19 plain minimal open', 'minimal', plainSource('minimal', undefined)),
  cell('f19 plain minimal closed', 'minimal', plainSource('minimal', 'F19User, conf')),
];

/** What the output of a class reads only for a signal: a member, a type alias, the check of an initialization. */
const SIGNAL_TEXT = ['__neoController', '__neoIdle', '_neoSignal', '_neoCheck', 'Signal =', 'Controller =', '_initController'] as const;

describe('F19 Q15 a container emits the signal members only when something reads them', () => {
  for (const emitter of EMITTERS) {
    for (const item of PLAIN_CELLS) {
      it(`Q15 ${emitter}, ${item.name}: no async step and no factory context, no signal member and no signal type in the output`, () => {
        const code = emitCase(item, emitter).outputs[0]?.code ?? '';
        for (const text of SIGNAL_TEXT) expect(code.includes(text), text).toBe(false);
        // The one-line check of the sync `initialize(options?)` stays: it reads the option, not a member.
        expect(code.includes('options?.signal?.aborted')).toBe(true);
      });
    }

    for (const item of SYNC_CELLS) {
      it(`Q15 ${emitter}, ${item.name}: a sync class with a factory context has the smallest idle signal, no controller, no stand-in, no initialization check`, () => {
        const code = emitCase(item, emitter).outputs[0]?.code ?? '';
        expect(code.includes('_neoSignal')).toBe(true);
        for (const text of ['__neoController', '__neoIdle()', '_neoCheck', '_initController', 'Controller =', '__neoListeners']) expect(code.includes(text), text).toBe(false);
      });
    }
  }
});
