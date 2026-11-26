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
 * T21 D7, the floor of the emitted code. The program has no disposable lib and the lib is es2021 (docs/release/compatibility.md,
 * "Floor of the emitted code"): the protocols are read from `Symbol` through an intersection type, never as a property the
 * lib must declare, so the output type-checks there, and at es2020 the only name it lacks is `AggregateError`. The user's
 * source is an input, not a subject.
 */

const STUB = `
  import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';
  declare function defineBuilderConfig<T>(config: T): T;
  declare function useInterface<T>(): T;
`;

type Profile = 'full' | 'minimal';

function floorSource(profile: Profile, roots: string | undefined): string {
  const optimization = roots === undefined ? '' : `optimization: { mode: 'closed', roots: [${roots}] },`;
  return `
  ${STUB}
  export class T21Db { dispose(): void {} }
  interface T21Made { n: number }
  interface T21Port { id: string }
  const made = useInterface<T21Made>();
  const port = useInterface<T21Port>();
  export const box = defineBuilderConfig({
    name: 'T21Floor',
    runtime: { profile: '${profile}' },
    ${optimization}
    injections: [
      { token: T21Db },
      { token: made, useFactory: true, dependencies: [T21Db], provider: async () => ({ n: 4 }) },
      { token: port, useFactory: true, dependencies: [], provider: () => ({ id: 'p' }) },
    ],
  });
`;
}

function cell(name: string, profile: Profile, roots: string | undefined): EmissionCase {
  return { name, profile, source: floorSource(profile, roots), testOverrides: false, parent: false };
}

const CELLS: readonly EmissionCase[] = [
  cell('floor full open', 'full', undefined),
  cell('floor full closed', 'full', 'T21Db, made, port'),
  cell('floor minimal open', 'minimal', undefined),
  cell('floor minimal closed', 'minimal', 'T21Db, made, port'),
];

const ES2021 = ['lib.es2021.d.ts'] as const;
const ES2020 = ['lib.es2020.d.ts'] as const;

describe('T21-P18 D7 the output of a container with a selector type-checks at lib es2021 without the disposable lib', () => {
  for (const emitter of EMITTERS) {
    for (const item of CELLS) {
      it(`T21-P18 ${emitter}, ${item.name}: the output names _neoDisposer and has no diagnostic at lib es2021`, () => {
        const emitted = emitCase(item, emitter);
        expect(emitted.outputs[0]?.code).toContain('_neoDisposer');
        expect(checkStrict({ ...emitted.input, lib: ES2021 }).map(formatDiagnostic)).toEqual([]);
      });
    }

    it(`T21-P18 ${emitter}: at lib es2020 the same output lacks AggregateError and nothing else`, () => {
      const item = CELLS[0];
      if (!item) throw new Error('no floor cell');
      const emitted = emitCase(item, emitter);
      expect(emitted.outputs[0]?.code).toContain('_neoDisposer');
      const found = checkStrict({ ...emitted.input, lib: ES2020 });
      expect([...new Set(found.map((diagnostic) => `TS${diagnostic.code} ${diagnostic.message}`))]).toEqual(["TS2304 Cannot find name 'AggregateError'."]);
    });
  }
});

describe('T21-P19 D7 the output names no unsafe type', () => {
  for (const emitter of EMITTERS) {
    for (const item of CELLS) {
      it(`T21-P19 ${emitter}, ${item.name}: the selector and the scope protocol add no any, no double assertion`, () => {
        const emitted = emitCase(item, emitter);
        const code = emitted.outputs[0]?.code ?? '';
        expect(code).toContain('_neoDisposer');
        expect(unsafeTypesMessage(code, 'box.out.ts')).toBe('');
      });
    }
  }
});
