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
 * F11, the output of a container with a bounded concurrency type-checks where the other outputs do: strict, lib es2021,
 * no dom and no node (docs/release/compatibility.md, "Floor of the emitted code"), and it holds no unsafe type
 * (scripts/ci/lib/no-unsafe-types.mjs). The scheduler member is the only new text; it reads `AggregateError`, which the
 * floor has. The user's source is an input, not a subject.
 */

const STUB = `
  import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';
  declare function defineBuilderConfig<T>(config: T): T;
  declare function useInterface<T>(): T;
`;

type Profile = 'full' | 'minimal';

function source(profile: Profile, roots: string | undefined): string {
  const optimization = roots === undefined ? '' : `optimization: { mode: 'closed', roots: [${roots}] },`;
  return `
  ${STUB}
  export class F11Db { dispose(): void {} }
  interface F11Made { n: number }
  interface F11Port { id: string }
  interface F11Item { n: number }
  const made = useInterface<F11Made>();
  const port = useInterface<F11Port>();
  const item = useInterface<F11Item>();
  export const box = defineBuilderConfig({
    name: 'F11Floor',
    runtime: { profile: '${profile}' },
    initialization: { concurrency: 3 },
    ${optimization}
    injections: [
      { token: F11Db },
      { token: made, useFactory: true, dependencies: [F11Db], provider: async () => ({ n: 4 }) },
      { token: port, useFactory: true, dependencies: [made, { all: item }], provider: async () => ({ id: 'p' }) },
      { token: item, useFactory: true, dependencies: [], multi: true, provider: async () => ({ n: 1 }) },
      { token: item, useFactory: true, dependencies: [F11Db], multi: true, provider: async () => ({ n: 2 }) },
    ],
  });
`;
}

function cell(name: string, profile: Profile, roots: string | undefined): EmissionCase {
  return { name, profile, source: source(profile, roots), testOverrides: false, parent: false };
}

const CELLS: readonly EmissionCase[] = [
  cell('f11 full open', 'full', undefined),
  cell('f11 full closed', 'full', 'F11Db, made, port, { all: item }'),
  cell('f11 minimal open', 'minimal', undefined),
  cell('f11 minimal closed', 'minimal', 'F11Db, made, port, { all: item }'),
];

const ES2021 = ['lib.es2021.d.ts'] as const;

describe('F11 the output with a bounded concurrency type-checks at lib es2021 and holds no unsafe type', () => {
  for (const emitter of EMITTERS) {
    for (const item of CELLS) {
      it(`F11-floor ${emitter}, ${item.name}: the output has the scheduler, no diagnostic at lib es2021, no unsafe type`, () => {
        const emitted = emitCase(item, emitter);
        const code = emitted.outputs[0]?.code ?? '';
        expect(code).toContain('__neoRunJobs');
        expect(checkStrict({ ...emitted.input, lib: ES2021 }).map(formatDiagnostic)).toEqual([]);
        expect(unsafeTypesMessage(code, 'box.out.ts')).toBe('');
      });
    }
  }
});
