import { defineBuilderConfig, useInterface, type AbortSignalLike, type FactoryContext } from '@djodjonx/neosyringe';

interface Pool {
  size: number;
}

const pool = useInterface<Pool>();

// This fixture has `lib: ["ES2021"]`: no DOM and no Node types, so `AbortSignal` is not a name it knows. The types of the
// package do not need it: a signal is anything with the members of `AbortSignalLike`.
export const box = defineBuilderConfig({
  name: 'SignalNoDom',
  injections: [
    {
      token: pool,
      useFactory: true,
      dependencies: [],
      provider: async (ctx: FactoryContext) => ({ size: ctx.signal.aborted ? 0 : 1 }),
    },
  ],
});

const listeners = new Set<() => void>();
export const own: AbortSignalLike = {
  aborted: false,
  addEventListener(_type, listener) {
    listeners.add(listener);
  },
  removeEventListener(_type, listener) {
    listeners.delete(listener);
  },
};

export async function start(): Promise<void> {
  await box.initialize({ signal: own });
}
