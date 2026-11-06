import { defineBuilderConfig } from '@djodjonx/neosyringe';

class Connection {
  static opened = 0;
  static closed = 0;
  readonly id = ++Connection.opened;

  dispose(): void {
    Connection.closed += 1;
  }
}

class Repo {
  constructor(readonly connection: Connection) {}
}

// #region container
export const container = defineBuilderConfig({
  name: 'ScopedApp',
  injections: [{ token: Connection }, { token: Repo }],
});
// #endregion container

// One scope per unit of work: same recipes, empty caches, no copied instances.
export async function run() {
  const first = container.createScope();
  const second = container.createScope();
  const a = first.resolve(Repo);
  const b = second.resolve(Repo);
  const isolated = a !== b && a.connection !== b.connection;
  const stable = first.resolve(Repo) === a;

  await first.destroy();
  const closedAfterFirst = Connection.closed;
  await first.destroy();
  const closedAfterSecondCall = Connection.closed;

  let afterDestroy = 'no error';
  try {
    first.resolve(Repo);
  } catch (error) {
    afterDestroy = error instanceof Error ? error.message : String(error);
  }

  await second.destroy();
  await container.destroy();
  return { isolated, stable, closedAfterFirst, closedAfterSecondCall, afterDestroy, closedTotal: Connection.closed };
}
