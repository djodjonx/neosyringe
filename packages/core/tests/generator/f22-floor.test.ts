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
 * F22, the output of a container built with the observation type-checks where the other outputs do: strict, lib es2021, no
 * dom and no node (docs/release/compatibility.md, "Floor of the emitted code"), and it holds no unsafe type
 * (scripts/ci/lib/no-unsafe-types.mjs). The clock is read from `globalThis`, because `performance` is a global of the dom
 * and node libs and not of es2021. The consumer reads the event and the snapshot with the types the public API declares,
 * so the output types a sink and a snapshot as the package does.
 */

const STUB = `
  import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';
  declare function defineBuilderConfig<T>(config: T): T;
  declare function useInterface<T>(): T;
`;

type Profile = 'full' | 'minimal';

/** An async container with a class, a declared factory and a sync one: the three things a container observes. */
function asyncSource(profile: Profile, roots: string | undefined, concurrency: boolean): string {
  const optimization = roots === undefined ? '' : `optimization: { mode: 'closed', roots: [${roots}] },`;
  return `
  ${STUB}
  export class F22Db { dispose(): void {} }
  interface F22Made { n: number }
  interface F22Port { id: string }
  const made = useInterface<F22Made>();
  const port = useInterface<F22Port>();
  export const box = defineBuilderConfig({
    name: 'F22Floor',
    runtime: { profile: '${profile}' },
    ${concurrency ? 'initialization: { concurrency: 3 },' : ''}
    ${optimization}
    injections: [
      { token: F22Db },
      { token: made, useFactory: true, dependencies: [F22Db], provider: async () => ({ n: 4 }) },
      { token: port, useFactory: true, dependencies: [made], provider: () => ({ id: 'p' }) },
    ],
  });
`;
}

function syncSource(profile: Profile, roots: string | undefined): string {
  const optimization = roots === undefined ? '' : `optimization: { mode: 'closed', roots: [${roots}] },`;
  return `
  ${STUB}
  export class F22Leaf { dispose(): void {} }
  interface F22Plain { n: number }
  const plain = useInterface<F22Plain>();
  export const box = defineBuilderConfig({
    name: 'F22SyncFloor',
    runtime: { profile: '${profile}' },
    ${optimization}
    injections: [
      { token: F22Leaf },
      { token: plain, useFactory: true, dependencies: [], provider: () => ({ n: 2 }) },
    ],
  });
`;
}

const CONSUMER = `import { box } from './box.out.ts';

export function consume(): void {
  const stop: () => void = box.observe((event) => {
    const phase: 'construct' | 'initialize' | 'dispose' = event.phase;
    const kind: 'start' | 'end' = event.kind;
    const ids: string = event.containerId + event.scopeId + event.registrationId;
    const outcome: 'ok' | 'error' | undefined = event.outcome;
    const milliseconds: number | undefined = event.durationMs;
    const code: string | undefined = event.errorCode;
    void [phase, kind, ids, outcome, milliseconds, code];
  }, { now: () => 1 });
  stop();
  // A sink may answer a promise: the container consumes it.
  box.observe(async () => {});
  const snapshot = box.stateSnapshot();
  const state: string = snapshot.state;
  const inFlight: number = snapshot.inFlight.construct + snapshot.inFlight.initialize + snapshot.inFlight.dispose;
  const counted: number = snapshot.constructs + snapshot.initializes + snapshot.disposes + snapshot.failures + snapshot.cancellations + snapshot.activeScopes;
  void [state, inFlight, counted];
}
`;

function cell(name: string, profile: Profile, source: string): EmissionCase {
  return { name, profile, source, testOverrides: false, parent: false, observation: true };
}

const CLOSED_ASYNC = 'F22Db, made, port';
const CLOSED_SYNC = 'F22Leaf, plain';

const CELLS: readonly EmissionCase[] = [
  cell('f22 async full open', 'full', asyncSource('full', undefined, false)),
  cell('f22 async full closed', 'full', asyncSource('full', CLOSED_ASYNC, false)),
  cell('f22 async minimal open', 'minimal', asyncSource('minimal', undefined, false)),
  cell('f22 async minimal closed', 'minimal', asyncSource('minimal', CLOSED_ASYNC, false)),
  cell('f22 async full open N=3', 'full', asyncSource('full', undefined, true)),
  cell('f22 async minimal closed N=3', 'minimal', asyncSource('minimal', CLOSED_ASYNC, true)),
  cell('f22 sync full open', 'full', syncSource('full', undefined)),
  cell('f22 sync full closed', 'full', syncSource('full', CLOSED_SYNC)),
  cell('f22 sync minimal open', 'minimal', syncSource('minimal', undefined)),
  cell('f22 sync minimal closed', 'minimal', syncSource('minimal', CLOSED_SYNC)),
];

const ES2021 = ['lib.es2021.d.ts'] as const;

describe('F22 the output of a container with observation type-checks at lib es2021 and holds no unsafe type', () => {
  for (const emitter of EMITTERS) {
    for (const item of CELLS) {
      it(`F22-floor ${emitter}, ${item.name}: the members are there, no diagnostic at lib es2021, no unsafe type`, () => {
        const emitted = emitCase(item, emitter);
        const code = emitted.outputs[0]?.code ?? '';
        expect(code).toContain('stateSnapshot');
        expect(code).toContain('_neoObs');
        const input = { ...emitted.input, consumer: { file: 'consumer.ts', code: CONSUMER }, lib: ES2021 };
        expect(checkStrict(input).map(formatDiagnostic)).toEqual([]);
        expect(unsafeTypesMessage(code, 'box.out.ts')).toBe('');
      });
    }
  }
});
