import {
  defineBuilderConfig,
  observationChannel,
  useInterface,
  type ObservationEvent,
  type ObservationSink,
  type ObservationSnapshot,
  type ObserveOptions,
} from '@djodjonx/neosyringe';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;

interface Pool {
  size: number;
}

const pool = useInterface<Pool>();

// The observation is a build option (`observation: true` of the plugin), invisible to TypeScript: the two members are
// optional on both profiles, and a call says what it does when the build has none.
export const full = defineBuilderConfig({
  name: 'ObservationFull',
  injections: [{ token: pool, useFactory: true, dependencies: [], provider: () => ({ size: 1 }) }],
});

export const minimal = defineBuilderConfig({
  name: 'ObservationMinimal',
  runtime: { profile: 'minimal' },
  injections: [{ token: pool, useFactory: true, dependencies: [], provider: () => ({ size: 1 }) }],
});

// An event is scalars: every field has a plain type, and the optional ones are the ones of an `end`.
export const sink: ObservationSink = (event: Readonly<ObservationEvent>) => {
  const phase: 'construct' | 'initialize' | 'dispose' = event.phase;
  const kind: 'start' | 'end' = event.kind;
  const ids: string = event.containerId + event.scopeId + event.registrationId;
  const outcome: 'ok' | 'error' | undefined = event.outcome;
  const milliseconds: number | undefined = event.durationMs;
  const code: string | undefined = event.errorCode;
  void [phase, kind, ids, outcome, milliseconds, code];
  // A sink may answer a promise: the container consumes it.
  return Promise.resolve();
};

// A real clock, or none: `performance.now` is the default.
export const options: ObserveOptions = { now: () => performance.now() };

export function watch(): void {
  const stopFull: (() => void) | undefined = full.observe?.(sink, options);
  const stopMinimal: (() => void) | undefined = minimal.observe?.(sink);
  const snapshot: ObservationSnapshot | undefined = full.stateSnapshot?.();
  const state: string | undefined = snapshot?.state;
  const counted: number | undefined = snapshot === undefined ? undefined : snapshot.constructs + snapshot.initializes + snapshot.disposes + snapshot.failures + snapshot.cancellations + snapshot.activeScopes;
  const flight: number | undefined = snapshot?.inFlight.construct;
  void [state, counted, flight];
  stopFull?.();
  stopMinimal?.();
}

// The trace adapter takes anything with the two members of a Node diagnostics_channel channel.
declare const channel: { publish(message: unknown): void; readonly hasSubscribers: boolean };
export const traced: ObservationSink = observationChannel(channel);
export const bare: ObservationSink = observationChannel({ publish: () => undefined });

// The full profile keeps the resolve event it always had.
export const stopResolve: () => void = full.on('resolve', () => undefined);

type _Snapshot = Expect<Equal<ObservationSnapshot['inFlight'], Readonly<{ construct: number; initialize: number; dispose: number }>>>;
export type { _Snapshot };
