import { defineBuilderConfig, observationChannel, useInterface } from '@djodjonx/neosyringe';

interface Pool {
  size: number;
}

const pool = useInterface<Pool>();

const full = defineBuilderConfig({
  name: 'ObservationNegativeFull',
  injections: [{ token: pool, useFactory: true, dependencies: [], provider: () => ({ size: 1 }) }],
});

const minimal = defineBuilderConfig({
  name: 'ObservationNegativeMinimal',
  runtime: { profile: 'minimal' },
  injections: [{ token: pool, useFactory: true, dependencies: [], provider: () => ({ size: 1 }) }],
});

// The minimal profile has the observation, and nothing else of the full profile: no resolve event, no overrides.
minimal.on('resolve', () => undefined);
minimal.override(pool, () => ({ size: 2 }));
// An event holds no value, no instance, no error and no message.
full.observe?.((event) => event.value);
full.observe?.((event) => event.error);
full.observe?.((event) => event.message);
// A sink is a function.
full.observe?.('console');
// The clock is a function.
full.observe?.(() => undefined, { now: 1 });
// A channel publishes.
observationChannel({ send: () => undefined });
