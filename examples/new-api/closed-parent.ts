import { defineBuilderConfig } from '@djodjonx/neosyringe';

class Settings {
  region(): string {
    return 'eu';
  }
}

class ParentOnly {
  tag(): string {
    return 'NEO_T20_SENTINEL_PARENT_ONLY';
  }
}

class ChildOnly {
  tag(): string {
    return 'NEO_T20_SENTINEL_CHILD_ONLY';
  }
}

class Api {
  constructor(readonly region: string) {}
}

// #region containers
// The parent stays open: the child's usage does not prune anything inside it.
export const parent = defineBuilderConfig({
  name: 'SharedParent',
  injections: [{ token: Settings }, { token: ParentOnly }],
});

// A closed child reaches the parent only through tokens named in `dependencies`.
export const child = defineBuilderConfig({
  name: 'ClosedChild',
  useContainer: parent,
  optimization: { mode: 'closed', roots: [Api] },
  injections: [
    {
      token: Api,
      useFactory: true,
      dependencies: [Settings],
      provider: (context) => new Api(context.resolve(Settings).region()),
    },
    { token: ChildOnly },
  ],
});
// #endregion containers

export async function run() {
  const region = child.resolve(Api).region;
  await child.destroy();
  await parent.destroy();
  return region;
}
