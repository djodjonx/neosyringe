import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';

interface Pool {
  size: number;
}

interface SlowPool {
  size: number;
}

const pool = useInterface<Pool>();
const slow = useInterface<SlowPool>();

let observed = false;

// #region container
// A factory reads the signal of its context. It aborts when `initialize({ signal })` is cancelled or the container is destroyed.
export const box = defineBuilderConfig({
  name: 'SignalApp',
  injections: [
    {
      token: pool,
      useFactory: true,
      dependencies: [],
      provider: async (context): Promise<Pool> => {
        await Promise.resolve();
        return { size: context.signal.aborted ? 0 : 4 };
      },
    },
  ],
});

// A factory that waits for the signal: the work ends as soon as the caller aborts.
export const waiting = defineBuilderConfig({
  name: 'SignalWaiting',
  injections: [
    {
      token: slow,
      useFactory: true,
      dependencies: [],
      provider: async (context): Promise<SlowPool> => {
        await new Promise<void>((resolve) => {
          context.signal.addEventListener('abort', () => {
            observed = true;
            resolve();
          }, { once: true });
        });
        return { size: 0 };
      },
    },
  ],
});
// #endregion container

export async function run() {
  await box.initialize();
  const size = box.resolve(pool).size;
  await box.destroy();

  // #region cancel
  const controller = new AbortController();
  const reason = new Error('stop');
  const lookalike = new Error('stop');
  const pending = waiting.initialize({ signal: controller.signal });
  controller.abort(reason);
  const rejection = await pending.then(
    () => undefined,
    (error: unknown) => error,
  );
  // `initialize()` rejects with the very error given to `abort()`: the same object, not a copy with the same message.
  // The same test says no to `lookalike`, an error with the same message that nobody passed to `abort()`.
  const isReason = (value: unknown): boolean => value === reason;
  const rejectedWithReason = isReason(rejection);
  const lookalikeIsReason = isReason(lookalike);
  // #endregion cancel

  await waiting.destroy();
  return { size, rejectedWithReason, lookalikeIsReason, factoryObservedAbort: observed };
}
