import { defineBuilderConfig, useInterface, type FactoryContext } from '@djodjonx/neosyringe';

interface Pool {
  size: number;
}

const pool = useInterface<Pool>();

const box = defineBuilderConfig({
  name: 'SignalNegative',
  injections: [{ token: pool, useFactory: true, dependencies: [], provider: async () => ({ size: 1 }) }],
});

// The signal is a signal, not a string.
box.initialize({ signal: 'x' });
// The options have one member.
box.initialize({ timeout: 1000 });
// The options are an object.
box.initialize(3);
// A context that a test builds by hand has a signal too.
export const fake: FactoryContext = {
  resolve: () => { throw new Error('no context'); },
  resolveAll: () => [],
  resolveMany: () => { throw new Error('no context'); },
};
