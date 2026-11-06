import { beforeAll, describe, expect, it } from 'vitest';
import { executeFixture } from './helpers/execute-fixture';

// One program for the three open-parent cases. executeFixture builds a program per call
// (tests/e2e/helpers/execute-fixture.ts:111, packages/unplugin/src/session.ts:534).
const HAPPY = `
import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';

interface Plugin {
  name: string;
}

interface Summary {
  names: string[];
}

const plugin = useInterface<Plugin>();
const summary = useInterface<Summary>();

export const parent = defineBuilderConfig({
  name: 'OpenParent',
  injections: [
    { token: plugin, multi: true, useFactory: true, dependencies: [], provider: () => ({ name: 'auth' }) },
    { token: plugin, multi: true, useFactory: true, dependencies: [], provider: () => ({ name: 'log' }) },
  ],
});

export const child = defineBuilderConfig({
  name: 'OpenChild',
  useContainer: parent,
  injections: [
    {
      token: summary,
      useFactory: true,
      dependencies: [{ all: plugin }],
      provider: (context): Summary => ({ names: context.resolveAll(plugin).map((item) => item.name) }),
    },
  ],
});

export const scopedChild = defineBuilderConfig({
  name: 'ScopedChild',
  useContainer: parent,
  injections: [
    { token: plugin, multi: true, scoped: true, useFactory: true, dependencies: [], provider: () => ({ name: 'alpha' }) },
    { token: plugin, multi: true, scoped: true, useFactory: true, dependencies: [], provider: () => ({ name: 'beta' }) },
    {
      token: summary,
      useFactory: true,
      dependencies: [{ all: plugin }],
      provider: (context): Summary => ({ names: context.resolveAll(plugin).map((item) => item.name) }),
    },
  ],
});

export const childA = defineBuilderConfig({
  name: 'ChildA',
  useContainer: parent,
  injections: [
    {
      token: summary,
      useFactory: true,
      dependencies: [{ all: plugin }],
      provider: (context): Summary => ({ names: context.resolveAll(plugin).map((item) => item.name) }),
    },
  ],
});

export const childB = defineBuilderConfig({
  name: 'ChildB',
  useContainer: parent,
  injections: [
    {
      token: summary,
      useFactory: true,
      dependencies: [{ all: plugin }],
      provider: (context): Summary => ({ names: context.resolveAll(plugin).map((item) => item.name) }),
    },
  ],
});

export function run(): { open: string[]; scoped: string[]; first: string[]; second: string[] } {
  const open = child.resolve(summary).names;
  const scoped = scopedChild.resolve(summary).names;
  const first = childA.resolve(summary).names;
  const second = childB.resolve(summary).names;
  return { open, scoped, first, second };
}
`;

const CLOSED_EXPORTED = `
import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';

interface Plugin {
  name: string;
}

interface Summary {
  names: string[];
}

const plugin = useInterface<Plugin>();
const summary = useInterface<Summary>();

export const parent = defineBuilderConfig({
  name: 'ClosedParent',
  optimization: { mode: 'closed', roots: [{ all: plugin }] },
  injections: [
    { token: plugin, multi: true, useFactory: true, dependencies: [], provider: () => ({ name: 'auth' }) },
    { token: plugin, multi: true, useFactory: true, dependencies: [], provider: () => ({ name: 'log' }) },
  ],
});

export const child = defineBuilderConfig({
  name: 'ClosedChild',
  useContainer: parent,
  injections: [
    {
      token: summary,
      useFactory: true,
      dependencies: [{ all: plugin }],
      provider: (context): Summary => ({ names: context.resolveAll(plugin).map((item) => item.name) }),
    },
  ],
});

export function run(): string[] {
  return child.resolve(summary).names;
}
`;

const CLOSED_PRIVATE = `
import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';

interface Plugin {
  name: string;
}

interface Secret {
  name: string;
}

interface Leak {
  names: string[];
}

const plugin = useInterface<Plugin>();
const secret = useInterface<Secret>();
const leak = useInterface<Leak>();

export const parent = defineBuilderConfig({
  name: 'ClosedPrivateParent',
  optimization: { mode: 'closed', roots: [{ all: plugin }] },
  injections: [
    { token: plugin, multi: true, useFactory: true, dependencies: [], provider: () => ({ name: 'auth' }) },
    { token: plugin, multi: true, useFactory: true, dependencies: [], provider: () => ({ name: 'log' }) },
    { token: secret, multi: true, useFactory: true, dependencies: [], provider: () => ({ name: 'hidden' }) },
  ],
});

export const child = defineBuilderConfig({
  name: 'ClosedPrivateChild',
  useContainer: parent,
  injections: [
    {
      token: leak,
      useFactory: true,
      dependencies: [{ all: secret }],
      provider: (context): Leak => ({ names: context.resolveAll(secret).map((item) => item.name) }),
    },
  ],
});

export function run(): string[] {
  return child.resolve(leak).names;
}
`;

const MISSING = `
import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';

interface Ghost {
  name: string;
}

interface Needs {
  names: string[];
}

const ghost = useInterface<Ghost>();
const needs = useInterface<Needs>();

export const parent = defineBuilderConfig({
  name: 'EmptyParent',
  injections: [],
});

export const child = defineBuilderConfig({
  name: 'MissingChild',
  useContainer: parent,
  injections: [
    {
      token: needs,
      useFactory: true,
      dependencies: [{ all: ghost }],
      provider: (context): Needs => ({ names: context.resolveAll(ghost).map((item) => item.name) }),
    },
  ],
});

export function run(): string[] {
  return child.resolve(needs).names;
}
`;

type FixtureOutcome = Awaited<ReturnType<typeof executeFixture>>;

const STRICT = { validation: 'strict' as const };

function diagnosticOf(outcome: FixtureOutcome): string {
  return outcome.phase === 'build' ? outcome.diagnostic : '';
}

describe('T08 child { all } of a parent multi token', () => {
  let happy: FixtureOutcome;

  beforeAll(async () => {
    happy = await executeFixture(HAPPY, STRICT);
  });

  it("T08-ALL-1 open parent {all} resolves ['auth','log']", () => {
    expect(happy.phase).toBe('ok');
    if (happy.phase !== 'ok') return;
    expect(happy.value).toMatchObject({ open: ['auth', 'log'] });
  });

  it('T08-ALL-2 child scoped local multi masks the parent list', () => {
    expect(happy.phase).toBe('ok');
    if (happy.phase !== 'ok') return;
    expect(happy.value).toMatchObject({ scoped: ['alpha', 'beta'] });
  });

  it('T08-ALL-5 two children of the same open parent', () => {
    expect(happy.phase).toBe('ok');
    if (happy.phase !== 'ok') return;
    expect(happy.value).toMatchObject({
      first: ['auth', 'log'],
      second: ['auth', 'log'],
    });
  });

  it('T08-ALL-3 missing multi token still NEO_MISSING_PROVIDER (code+message)', async () => {
    const outcome = await executeFixture(MISSING, STRICT);
    expect(outcome.phase).toBe('build');
    // The thrown text is the validator message. The code is not copied into it
    // (packages/unplugin/src/session.ts:598, packages/core/src/generator/GraphValidator.ts:84).
    expect(diagnosticOf(outcome)).toContain("Missing injection: 'Ghost' required by 'Needs' is not registered.");
  });

  it('T08-ALL-4 closed parent exported multi root via {all} still resolves, private multi still refused', async () => {
    const exported = await executeFixture(CLOSED_EXPORTED, STRICT);
    expect(exported.phase).toBe('ok');
    if (exported.phase === 'ok') expect(exported.value).toEqual(['auth', 'log']);
    const hidden = await executeFixture(CLOSED_PRIVATE, STRICT);
    expect(hidden.phase).toBe('build');
    expect(diagnosticOf(hidden)).toContain("Missing injection: 'Secret' required by 'Leak' is not registered.");
  });
});
