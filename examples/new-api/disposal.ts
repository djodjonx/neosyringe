import { defineBuilderConfig } from '@djodjonx/neosyringe';

const closed: string[] = [];

class Connection {
  readonly name = 'connection';

  dispose(): void {
    closed.push(this.name);
  }
}

class Repo {
  readonly name = 'repo';

  constructor(readonly connection: Connection) {}

  async dispose(): Promise<void> {
    closed.push(this.name);
  }
}

// #region container
// The container owns what it builds. `destroy()` calls `dispose()` once per instance, in the reverse order of construction.
export const container = defineBuilderConfig({
  name: 'DisposalApp',
  injections: [{ token: Connection }, { token: Repo }],
});
// #endregion container

export async function run() {
  // #region destroy
  const scope = container.createScope();
  scope.resolve(Repo);
  await scope.destroy();
  const afterFirstDestroy = [...closed];
  await scope.destroy();
  // #endregion destroy

  await container.destroy();
  return { afterFirstDestroy, afterSecondDestroy: [...closed] };
}
