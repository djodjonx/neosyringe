import {
  defineBuilderConfig,
  useInterface,
  type AbortSignalLike,
  type FactoryContext,
  type InitializeOptions,
} from '@djodjonx/neosyringe';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;

interface Pool {
  size: number;
}

const pool = useInterface<Pool>();

// A factory reads the signal of its context: it aborts when the initialization is cancelled or the container destroyed.
export const box = defineBuilderConfig({
  name: 'SignalBox',
  injections: [
    {
      token: pool,
      useFactory: true,
      dependencies: [],
      provider: async (ctx: FactoryContext) => {
        const aborted: boolean = ctx.signal.aborted;
        const onAbort = (): void => undefined;
        ctx.signal.addEventListener('abort', onAbort, { once: true });
        ctx.signal.removeEventListener('abort', onAbort);
        const why: unknown = ctx.signal.reason;
        return { size: aborted || why !== undefined ? 0 : 1 };
      },
    },
  ],
});

// A real AbortSignal is assignable to the structural type, so `initialize` takes the signal of an AbortController as it is.
const controller = new AbortController();
export const real: AbortSignalLike = controller.signal;
export const timed: AbortSignalLike = AbortSignal.timeout(1000);
export const options: InitializeOptions = { signal: controller.signal };

export async function start(): Promise<void> {
  await box.initialize();
  await box.initialize({});
  await box.initialize({ signal: controller.signal });
  await box.initialize({ signal: AbortSignal.timeout(1000) });
  await box.initialize(options);
}

// `reason` is whatever the signal carries: `initialize()` rejects with it, as it is.
export function reasonOf(signal: AbortSignalLike): unknown {
  return signal.reason;
}

// The options are a plain object type with one optional signal.
type _Options = Expect<Equal<InitializeOptions, { readonly signal?: AbortSignalLike }>>;
export type { _Options };
