import { defineBuilderConfig, definePartialConfig, useInterface, type InitializationOptions } from '@djodjonx/neosyringe';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;

interface Pool {
  size: number;
}
interface Cache {
  size: number;
}

const pool = useInterface<Pool>();
const cache = useInterface<Cache>();

// The option is a literal of the builder: how many initialization steps run at once. Default: 1.
export const bounded = defineBuilderConfig({
  name: 'InitializationBounded',
  initialization: { concurrency: 3 },
  injections: [
    { token: pool, useFactory: true, dependencies: [], provider: async () => ({ size: 1 }) },
    { token: cache, useFactory: true, dependencies: [], provider: async () => ({ size: 2 }) },
  ],
});

// Both profiles take it, with the other capabilities.
export const lean = defineBuilderConfig({
  name: 'InitializationLean',
  runtime: { profile: 'minimal' },
  optimization: { mode: 'closed', roots: [pool, cache] },
  initialization: { concurrency: 2 },
  injections: [
    { token: pool, useFactory: true, dependencies: [], provider: async () => ({ size: 1 }) },
    { token: cache, useFactory: true, dependencies: [pool], provider: async () => ({ size: 2 }) },
  ],
});

// Absent, empty or without a concurrency is the sequential default.
export const sequential = defineBuilderConfig({
  name: 'InitializationSequential',
  initialization: {},
  injections: [{ token: pool, useFactory: true, dependencies: [], provider: async () => ({ size: 1 }) }],
});

export const absent = defineBuilderConfig({
  name: 'InitializationAbsent',
  injections: [{ token: pool, useFactory: true, dependencies: [], provider: async () => ({ size: 1 }) }],
});

// `initialize()` takes no option: the bound is the builder's, not the call's.
export async function start(): Promise<void> {
  await bounded.initialize();
  await lean.initialize();
}

// The option is a plain object type with one optional number.
type _Shape = Expect<Equal<InitializationOptions, { concurrency?: number }>>;
export type { _Shape };

// A partial does not carry it: it stays a builder option.
export const shared = definePartialConfig({
  injections: [{ token: pool, useFactory: true, dependencies: [], provider: async () => ({ size: 1 }) }],
});
