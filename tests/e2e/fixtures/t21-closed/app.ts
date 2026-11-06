import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';
import { Heavy } from './heavy';

// T21 closed container. Bundled by the real plugin in tests/e2e/t21-closed-bundle.test.ts and by
// scripts/ci/consumer-dist.mjs. No override here: testOverrides is refused when NODE_ENV is production.

interface Middleware {
  name: string;
}

interface Pipeline {
  names: string[];
}

interface Worker {
  started: number;
}

interface Banner {
  title: string;
}

const middleware = useInterface<Middleware>();
const pipeline = useInterface<Pipeline>();
const worker = useInterface<Worker>();
const banner = useInterface<Banner>();

let workerStarts = 0;
const effects: string[] = [];

function stamp(title: string): Banner {
  effects.push(title);
  return { title };
}

export const container = defineBuilderConfig({
  name: 'T21Closed',
  optimization: { mode: 'closed', roots: [pipeline], eager: [worker] },
  injections: [
    { token: middleware, multi: true, useFactory: true, dependencies: [], provider: () => ({ name: 'auth' }) },
    { token: middleware, multi: true, useFactory: true, dependencies: [], provider: () => ({ name: 'log' }) },
    {
      token: pipeline,
      useFactory: true,
      dependencies: [{ all: middleware }],
      provider: (context) => ({ names: context.resolveAll(middleware).map((item) => item.name) }),
    },
    {
      token: worker,
      useFactory: true,
      dependencies: [],
      provider: async () => {
        workerStarts += 1;
        return { started: workerStarts };
      },
    },
    // Not reachable from a root: absent from the closed bundle.
    { token: Heavy },
    // Required effect: the expression runs once, where the configuration is evaluated.
    { token: banner, useValue: stamp('T21_EFFECT_REQUIRED') },
  ],
});

export async function run() {
  await container.initialize();
  await container.initialize();
  const names = container.resolve(pipeline).names;
  await container.destroy();
  return { names, workerStarts, effects };
}
