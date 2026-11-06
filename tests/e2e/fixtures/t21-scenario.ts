import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';

// T21 integrated scenario. One file, read as text by tests/e2e/t21-integrated.test.ts and by
// scripts/ci/consumer-dist.mjs, then compiled by the real plugin and executed.
// The expected report is tests/e2e/fixtures/t21-scenario.expected.json.
// Needs testOverrides: true (it calls override). The build uses validation: 'strict'.
// createScope() is the same container (packages/core/src/analyzer/collectors/resolutionUsages.ts:147).
// The closed container is in tests/e2e/fixtures/t21-closed/app.ts: closed mode requires strict validation.

interface Settings {
  region: string;
}

interface Db {
  id: number;
  closed: boolean;
  dispose(): Promise<void>;
}

interface Clock {
  id: number;
}

interface Plugin {
  name: string;
}

interface Logger {
  name(): string;
}

const counts = {
  clocks: 0,
  clocksDisposed: 0,
  dbStarts: 0,
  dbDisposed: 0,
  repos: 0,
  reposDisposed: 0,
  fakeDisposed: 0,
};
const disposeLog: string[] = [];
// The leaf container below has its own counter: the shared `counts` is pinned by the parent scenario.
const leafCounts = { disposed: 0 };

class SystemClock implements Clock {
  readonly id = ++counts.clocks;

  dispose(): void {
    counts.clocksDisposed += 1;
    disposeLog.push('clock');
  }
}

class Repo {
  readonly id = ++counts.repos;

  constructor(readonly db: Db, readonly clock: Clock) {}

  dispose(): void {
    counts.reposDisposed += 1;
    disposeLog.push(`repo${this.id}`);
  }
}

class RealLogger implements Logger {
  name(): string {
    return 'real';
  }
}

class FakeLogger implements Logger {
  name(): string {
    return 'fake';
  }

  dispose(): void {
    counts.fakeDisposed += 1;
  }
}

class Service {
  constructor(readonly logger: Logger) {}
}

// Only sync providers: this container has no _state, so `_closed` is the one thing that makes destroy terminal.
class LeafCache {
  dispose(): void {
    leafCounts.disposed += 1;
  }
}

const settings = useInterface<Settings>();
const db = useInterface<Db>();
const clock = useInterface<Clock>();
const plugin = useInterface<Plugin>();
const logger = useInterface<Logger>();

export const parent = defineBuilderConfig({
  name: 'T21Parent',
  injections: [
    { token: settings, useValue: { region: 'eu' } },
    { token: clock, provider: SystemClock },
    {
      token: db,
      useFactory: true,
      dependencies: [settings],
      provider: async (context): Promise<Db> => {
        counts.dbStarts += 1;
        await Promise.resolve();
        const instance: Db = {
          id: counts.dbStarts,
          closed: false,
          async dispose() {
            instance.closed = true;
            counts.dbDisposed += 1;
            disposeLog.push('db');
          },
        };
        context.resolve(settings);
        return instance;
      },
    },
    { token: plugin, multi: true, useFactory: true, dependencies: [], provider: () => ({ name: 'auth' }) },
    {
      token: plugin,
      multi: true,
      useFactory: true,
      dependencies: [],
      provider: async () => {
        await Promise.resolve();
        return { name: 'audit' };
      },
    },
    { token: plugin, multi: true, useFactory: true, dependencies: [], provider: () => ({ name: 'log' }) },
    { token: logger, provider: RealLogger },
    { token: Service },
  ],
});

export const child = defineBuilderConfig({
  name: 'T21Child',
  useContainer: parent,
  injections: [{ token: Repo }],
});

export const leaf = defineBuilderConfig({
  name: 'T21Leaf',
  injections: [{ token: LeafCache }],
});

function codeOf(error: unknown): string {
  return (error as { code?: string }).code ?? String(error);
}

async function codeOfAsync(action: () => Promise<unknown>): Promise<string> {
  try {
    await action();
    return 'no error';
  } catch (error) {
    return codeOf(error);
  }
}

function messageOfSync(action: () => unknown): string {
  try {
    action();
    return 'no error';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function codeOfSync(action: () => unknown): string {
  try {
    action();
    return 'no error';
  } catch (error) {
    return codeOf(error);
  }
}

export async function run() {
  const early = codeOfSync(() => parent.resolve(db));
  const scopeA = child.createScope();
  const scopeB = child.createScope();

  await Promise.all([
    parent.initialize(),
    parent.initialize(),
    child.initialize(),
    scopeA.initialize(),
    scopeB.initialize(),
  ]);
  const startsAfterInit = counts.dbStarts;

  const parentDb = parent.resolve(db);
  const parentClock = parent.resolve(clock);
  const parentSettings = parent.resolve(settings);
  const repoA = scopeA.resolve(Repo);
  const repoB = scopeB.resolve(Repo);
  const repoChild = child.resolve(Repo);
  const identity = {
    dbThroughChild: child.resolve(db) === parentDb,
    dbThroughScopeA: scopeA.resolve(db) === parentDb,
    dbThroughScopeB: scopeB.resolve(db) === parentDb,
    clockThroughScopes: scopeA.resolve(clock) === parentClock && scopeB.resolve(clock) === parentClock,
    settingsThroughScopes: scopeA.resolve(settings) === parentSettings && scopeB.resolve(settings) === parentSettings,
    repoDbIsParentDb: repoA.db === parentDb && repoB.db === parentDb && repoChild.db === parentDb,
    repoClockIsParentClock: repoA.clock === parentClock && repoB.clock === parentClock,
    scopesOwnTheirRepo: repoA !== repoB && repoA !== repoChild && repoB !== repoChild,
    repoStable: scopeA.resolve(Repo) === repoA && scopeB.resolve(Repo) === repoB,
  };

  const firstAll = parent.resolveAll(plugin);
  const secondAll = parent.resolveAll(plugin);
  const childAll = child.resolveAll(plugin);
  const scopeAll = scopeA.resolveAll(plugin);
  const multi = {
    parent: firstAll.map((item) => item.name),
    child: childAll.map((item) => item.name),
    scope: scopeAll.map((item) => item.name),
    freshArray: firstAll !== secondAll,
    // Same objects, position by position: the order is checked by identity, not only by name.
    sameItems: firstAll.length === 3 && firstAll.every((item, index) => item === secondAll[index]),
    childSameItems: childAll.length === 3 && childAll.every((item, index) => item === firstAll[index]),
    scopeSameItems: scopeAll.length === 3 && scopeAll.every((item, index) => item === firstAll[index]),
  };

  const afterScopeA = {
    closeScopeA: await codeOfAsync(() => scopeA.destroy()),
    closeScopeAAgain: await codeOfAsync(() => scopeA.destroy()),
    reposDisposed: counts.reposDisposed,
    dbClosed: parentDb.closed,
    clocksDisposed: counts.clocksDisposed,
    resolveRepo: codeOfSync(() => scopeA.resolve(Repo)),
    resolveRepoMessage: messageOfSync(() => scopeA.resolve(Repo)),
    resolveParentValue: codeOfSync(() => scopeA.resolve(db)),
    initialize: await codeOfAsync(() => scopeA.initialize()),
    createScope: codeOfSync(() => scopeA.createScope()),
    scopeBStillWorks: scopeB.resolve(Repo) === repoB,
    parentStillWorks: parent.resolve(db) === parentDb,
  };

  await scopeB.destroy();
  await child.destroy();
  const afterChildren = {
    reposDisposed: counts.reposDisposed,
    dbClosed: parentDb.closed,
    clocksDisposed: counts.clocksDisposed,
    // Read before the override below builds a second clock: the parent, the child and the scopes shared one.
    clocks: counts.clocks,
    parentStillWorks: parent.resolve(db) === parentDb,
  };

  // ADR005: a reconfiguration closes the owned instances of the container (the sync clock too) and asks for initialize() again.
  const consumerBefore = parent.resolve(Service);
  const closedByNow = counts.dbDisposed;
  const clocksClosedBefore = counts.clocksDisposed;
  await parent.override(logger, () => new FakeLogger());
  // Read right after the awaited override: destroy() later closes nothing of this.
  const clocksClosedByOverride = counts.clocksDisposed - clocksClosedBefore;
  await parent.initialize();
  const consumerDuring = parent.resolve(Service);
  const dbAfterOverride = parent.resolve(db);
  const clockRebuilt = parent.resolve(clock) !== parentClock;
  await parent.clearOverrides();
  await parent.initialize();
  const consumerAfter = parent.resolve(Service);
  const override = {
    seen: [consumerBefore.logger.name(), consumerDuring.logger.name(), consumerAfter.logger.name()],
    consumerRebuilt: consumerBefore !== consumerDuring && consumerDuring !== consumerAfter,
    dbRebuilt: dbAfterOverride !== parentDb && parent.resolve(db) !== dbAfterOverride,
    dbClosedByOverride: parentDb.closed && counts.dbDisposed - closedByNow === 2,
    clocksClosedByOverride,
    clockRebuilt,
    dbStarts: counts.dbStarts,
    fakeDisposed: counts.fakeDisposed,
  };

  await parent.destroy();
  await parent.destroy();
  const afterParent = {
    dbDisposed: counts.dbDisposed,
    dbClosed: parentDb.closed,
    clocksDisposed: counts.clocksDisposed,
    reposDisposed: counts.reposDisposed,
    repoDisposals: disposeLog.filter((entry) => entry.startsWith('repo')),
    resolve: codeOfSync(() => parent.resolve(db)),
    resolveMessage: messageOfSync(() => parent.resolve(db)),
    initialize: await codeOfAsync(() => parent.initialize()),
    createScope: codeOfSync(() => parent.createScope()),
    override: await codeOfAsync(() => parent.override(logger, () => new FakeLogger())),
    destroyedChildResolve: codeOfSync(() => child.resolve(clock)),
  };

  // A sync container: destroy twice disposes once, then every entry point refuses with the same code and message.
  const leafCache = leaf.resolve(LeafCache);
  const leafStable = leaf.resolve(LeafCache) === leafCache;
  const leafReport = {
    stable: leafStable,
    destroy: await codeOfAsync(() => leaf.destroy()),
    destroyAgain: await codeOfAsync(() => leaf.destroy()),
    disposed: leafCounts.disposed,
    resolve: codeOfSync(() => leaf.resolve(LeafCache)),
    resolveMessage: messageOfSync(() => leaf.resolve(LeafCache)),
    initialize: await codeOfAsync(() => leaf.initialize()),
    createScope: codeOfSync(() => leaf.createScope()),
  };

  return { early, startsAfterInit, identity, multi, afterScopeA, afterChildren, override, afterParent, leaf: leafReport, counts: { ...counts } };
}
