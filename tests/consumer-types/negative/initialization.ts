import { defineBuilderConfig, definePartialConfig, useInterface } from '@djodjonx/neosyringe';

interface Pool {
  size: number;
}

const pool = useInterface<Pool>();

// The concurrency is a number.
defineBuilderConfig({
  name: 'InitializationString',
  initialization: { concurrency: 'x' },
  injections: [{ token: pool, useFactory: true, dependencies: [], provider: async () => ({ size: 1 }) }],
});
// The option has one member.
defineBuilderConfig({
  name: 'InitializationUnknown',
  initialization: { parallel: 3 },
  injections: [{ token: pool, useFactory: true, dependencies: [], provider: async () => ({ size: 1 }) }],
});
// The option is an object, not a number.
defineBuilderConfig({
  name: 'InitializationNumber',
  initialization: 3,
  injections: [{ token: pool, useFactory: true, dependencies: [], provider: async () => ({ size: 1 }) }],
});
// A partial cannot declare it.
definePartialConfig({
  initialization: { concurrency: 2 },
  injections: [{ token: pool, useFactory: true, dependencies: [], provider: async () => ({ size: 1 }) }],
});
