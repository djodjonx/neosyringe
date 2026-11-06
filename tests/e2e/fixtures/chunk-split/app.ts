import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';

// The container stays in this file. The root factory loads the heavy provider through
// a dynamic import, which is the split point. scripts/measure-chunk-split.mjs writes
// the generated heavy.ts into the build directory and rewrites this factory for the
// static control (a top-level import, no import()).

export const CHUNK_SPLIT_CONTAINER = 'CHUNK_SPLIT_CONTAINER';

interface Port {
  tag: string;
}

const port = useInterface<Port>();

export const container = defineBuilderConfig({
  name: 'ChunkSplit',
  injections: [
    {
      token: port,
      useFactory: true,
      dependencies: [],
      provider: async () => {
        const { Heavy } = await import('./heavy');
        return { tag: new Heavy().tag() };
      },
    },
  ],
});

export async function run() {
  await container.initialize();
  const tag = container.resolve(port).tag;
  return { tag, marker: CHUNK_SPLIT_CONTAINER };
}
