import { describe, expect, it } from 'vitest';
import { executeFixture } from './helpers/execute-fixture';

// T21 known issues: defects of earlier tasks that this round pins and does not fix.
// Each test is green while the defect exists and goes red when it is fixed. The day it goes red,
// replace the assertion by the desired behaviour (written in the comment) and drop the KNOWN label.

// ADR002 allows { all: token } as a dependency entry and asks the validation to use the effective view
// (local, parent, public roots when closed). The open-parent path copies only the single nodes of the
// parent (packages/core/src/analyzer/resolvers/ParentContainerResolver.ts:135), so the validator
// (packages/core/src/generator/GraphValidator.ts:77) does not see the parent multi token.
const CHILD_ALL_ON_OPEN_PARENT = `
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
  name: 'KnownParent',
  injections: [
    { token: plugin, multi: true, useFactory: true, dependencies: [], provider: () => ({ name: 'auth' }) },
    { token: plugin, multi: true, useFactory: true, dependencies: [], provider: () => ({ name: 'log' }) },
  ],
});

export const child = defineBuilderConfig({
  name: 'KnownChild',
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

describe('T21 known issues', () => {
  it('T21-KNOWN child factory { all } on an open parent multi token', async () => {
    const outcome = await executeFixture(CHILD_ALL_ON_OPEN_PARENT, { validation: 'strict' });
    // KNOWN DEFECT against ADR002: the build refuses a registered parent multi token (missing injection).
    // Desired behaviour: phase 'ok' and value ['auth', 'log'] (the runtime child.resolveAll already works,
    // packages/core/tests/generator/t08-multi-runtime.test.ts T08-P12).
    expect(outcome.phase).toBe('build');
    if (outcome.phase !== 'build') return;
    // The plugin message carries the text of the validator error (code NEO_MISSING_PROVIDER, packages/core/src/generator/GraphValidator.ts:83).
    expect(outcome.diagnostic).toContain("Missing injection: 'Plugin' required by 'Summary' is not registered.");
  });
});
