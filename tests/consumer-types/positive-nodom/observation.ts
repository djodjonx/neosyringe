import { defineBuilderConfig, observationChannel, useInterface, type ObservationSink } from '@djodjonx/neosyringe';

interface Pool {
  size: number;
}

const pool = useInterface<Pool>();

// This fixture has `lib: ["ES2021"]`: no DOM and no Node types, so `performance` and `diagnostics_channel` are names it
// does not know. The types of the package do not need them: the clock is a function the caller gives, and a channel is
// anything with the members of `ObservationChannel`.
export const box = defineBuilderConfig({
  name: 'ObservationNoDom',
  injections: [{ token: pool, useFactory: true, dependencies: [], provider: () => ({ size: 1 }) }],
});

const events: string[] = [];
export const sink: ObservationSink = (event) => {
  events.push(`${event.phase}:${event.kind}`);
};

let ticks = 0;
export const stop: (() => void) | undefined = box.observe?.(sink, { now: () => (ticks += 1) });
export const forwarded: ObservationSink = observationChannel({ publish: (message) => void events.push(String(message)) });
export const state: string | undefined = box.stateSnapshot?.().state;
