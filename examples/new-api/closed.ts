import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';

interface Middleware {
  name: string;
}

interface Pipeline {
  names: string[];
}

interface Worker {
  started: number;
}

interface Report {
  text(): string;
}

interface Banner {
  title: string;
}

// #region container
const middleware = useInterface<Middleware>();
const pipeline = useInterface<Pipeline>();
const worker = useInterface<Worker>();
const report = useInterface<Report>();
const banner = useInterface<Banner>();

let workerStarts = 0;
let bannerStamps = 0;

function stamp(title: string): Banner {
  bannerStamps += 1;
  return { title };
}

export const container = defineBuilderConfig({
  name: 'ClosedApp',
  // Step 2 of the migration: leave `mode: 'open'` and name what the outside may ask for.
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
    // Not reachable from a root: absent from the generated container.
    { token: report, useFactory: true, dependencies: [], provider: () => ({ text: () => 'NEO_T20_SENTINEL_UNREACHABLE' }) },
    // The expression runs once, where the configuration is evaluated, even though no root uses it.
    { token: banner, useValue: stamp('NEO_T20_SENTINEL_BANNER') },
  ],
});
// #endregion container

export async function run() {
  await container.initialize();
  await container.initialize();
  const names = container.resolve(pipeline).names;
  await container.destroy();
  return { names, workerStarts, bannerStamps };
}
