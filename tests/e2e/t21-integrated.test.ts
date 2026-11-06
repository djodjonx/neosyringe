import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { executeFixture } from './helpers/execute-fixture';

// T21-A01: parent, scopes, async factory, multi, test override and close in ONE generated container set.
// The scenario runs once, through the real plugin and the built runtime. Each test reads one slice.
// Needs a fresh `pnpm build` (executeFixture checks it).

const fixtureDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

interface Report {
  early: string;
  startsAfterInit: number;
  identity: Record<string, boolean>;
  multi: {
    parent: string[];
    child: string[];
    scope: string[];
    freshArray: boolean;
    sameItems: boolean;
    childSameItems: boolean;
    scopeSameItems: boolean;
  };
  afterScopeA: Record<string, boolean | number | string>;
  afterChildren: Record<string, boolean | number>;
  override: {
    seen: string[];
    consumerRebuilt: boolean;
    dbRebuilt: boolean;
    dbClosedByOverride: boolean;
    clocksClosedByOverride: number;
    clockRebuilt: boolean;
    dbStarts: number;
    fakeDisposed: number;
  };
  afterParent: Record<string, boolean | number | string | string[]>;
  leaf: Record<string, boolean | number | string>;
  counts: Record<string, number>;
}

describe('T21 integrated scenario', () => {
  let report: Report;
  let warnings: string[] = [];

  beforeAll(async () => {
    const source = readFileSync(path.join(fixtureDir, 't21-scenario.ts'), 'utf8');
    // compatible: strict does not follow the result of createScope(). testOverrides: the scenario calls override.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let outcome: Awaited<ReturnType<typeof executeFixture>>;
    try {
      outcome = await executeFixture(source, { validation: 'compatible', testOverrides: true });
    } finally {
      warnings = warn.mock.calls.map((call) => String(call[0]));
      warn.mockRestore();
    }
    expect(outcome, JSON.stringify(outcome)).toMatchObject({ phase: 'ok' });
    if (outcome.phase !== 'ok') return;
    report = outcome.value as Report;
  }, 20_000);

  it('T21-A01 parent value keeps identity, child scopes share the parent singleton', () => {
    expect(report.identity).toEqual({
      dbThroughChild: true,
      dbThroughScopeA: true,
      dbThroughScopeB: true,
      clockThroughScopes: true,
      settingsThroughScopes: true,
      repoDbIsParentDb: true,
      repoClockIsParentClock: true,
      scopesOwnTheirRepo: true,
      repoStable: true,
    });
    // One shared clock for the parent, the child and both scopes; one Repo for each of scope A, scope B and the child.
    expect(report.afterChildren.clocks).toBe(1);
    expect(report.counts.repos).toBe(3);
  });

  it('T21-A01 concurrent initialize runs the async factory once', () => {
    expect(report.early).toBe('NEO_NOT_INITIALIZED');
    expect(report.startsAfterInit).toBe(1);
  });

  it('T21-A01 resolveAll returns contributions in registration order', () => {
    expect(report.multi).toEqual({
      parent: ['auth', 'audit', 'log'],
      child: ['auth', 'audit', 'log'],
      scope: ['auth', 'audit', 'log'],
      freshArray: true,
      sameItems: true,
      childSameItems: true,
      scopeSameItems: true,
    });
  });

  it('T21-A01 awaited override shows the mock, clearOverrides rebuilds the original', () => {
    expect(report.override).toEqual({
      seen: ['real', 'fake', 'real'],
      consumerRebuilt: true,
      dbRebuilt: true,
      dbClosedByOverride: true,
      // ADR005: the awaited override already closed the owned sync clock (one dispose, read before destroy), and the next resolve builds a new one.
      clocksClosedByOverride: 1,
      clockRebuilt: true,
      // 1 at initialize, then one rebuild after override and one after clearOverrides.
      dbStarts: 3,
      fakeDisposed: 0,
    });
  });

  it('T21-A01 destroy is terminal, owned disposed once, borrowed parent value untouched', () => {
    // Closing scope A closes its own Repo only, twice is the same as once.
    expect(report.afterScopeA).toEqual({
      closeScopeA: 'no error',
      closeScopeAAgain: 'no error',
      reposDisposed: 1,
      dbClosed: false,
      clocksDisposed: 0,
      resolveRepo: 'NEO_CONTAINER_DESTROYED',
      resolveRepoMessage: 'NEO_CONTAINER_DESTROYED: [T21Child] container is destroyed',
      resolveParentValue: 'NEO_CONTAINER_DESTROYED',
      initialize: 'NEO_CONTAINER_DESTROYED',
      createScope: 'NEO_CONTAINER_DESTROYED',
      scopeBStillWorks: true,
      parentStillWorks: true,
    });
    // Closing the scopes and the child never closes what the parent owns.
    expect(report.afterChildren).toEqual({
      reposDisposed: 3,
      dbClosed: false,
      clocksDisposed: 0,
      clocks: 1,
      parentStillWorks: true,
    });
    expect(report.afterParent).toEqual({
      dbDisposed: 3,
      dbClosed: true,
      clocksDisposed: 2,
      reposDisposed: 3,
      repoDisposals: ['repo1', 'repo2', 'repo3'],
      resolve: 'NEO_CONTAINER_DESTROYED',
      resolveMessage: 'NEO_CONTAINER_DESTROYED: [T21Parent] container is destroyed',
      initialize: 'NEO_CONTAINER_DESTROYED',
      createScope: 'NEO_CONTAINER_DESTROYED',
      override: 'NEO_CONTAINER_DESTROYED',
      destroyedChildResolve: 'NEO_CONTAINER_DESTROYED',
    });
    // A sync container has no state field: `_closed` alone makes destroy terminal there.
    expect(report.leaf).toEqual({
      stable: true,
      destroy: 'no error',
      destroyAgain: 'no error',
      disposed: 1,
      resolve: 'NEO_CONTAINER_DESTROYED',
      resolveMessage: 'NEO_CONTAINER_DESTROYED: [T21Leaf] container is destroyed',
      initialize: 'NEO_CONTAINER_DESTROYED',
      createScope: 'NEO_CONTAINER_DESTROYED',
    });
    expect(report.counts).toEqual({
      // Two clocks: the one the override closed, and the one built after it (closed by clearOverrides).
      clocks: 2,
      clocksDisposed: 2,
      dbStarts: 3,
      dbDisposed: 3,
      repos: 3,
      reposDisposed: 3,
      fakeDisposed: 0,
    });
  });

  it('T21-A01 the only build warnings are the scope receivers compatible mode allows', () => {
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.filter((text) => !text.startsWith('NEO_UNKNOWN_CONTAINER:'))).toEqual([]);
  });

  it('T21-A01 the pinned expectation file equals the executed report', () => {
    // scripts/ci/consumer-dist.mjs compares the report of the installed tarballs with this file.
    const pinned: unknown = JSON.parse(readFileSync(path.join(fixtureDir, 't21-scenario.expected.json'), 'utf8'));
    expect(report).toEqual(pinned);
  });
});
