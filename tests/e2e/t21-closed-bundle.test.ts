import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { executeFixture } from './helpers/execute-fixture';
import { bundleApp, runBundle, type BundleResult } from './helpers/t21-bundle';

// T21-A04: a real production bundle of the closed container, then the bundle is executed.
// Needs a fresh `pnpm build`.

const fixtureDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/t21-closed');
const SENTINEL = 'T21_SENTINEL_UNREACHABLE';
const CLOSED_OPTION = "optimization: { mode: 'closed', roots: [pipeline], eager: [worker] },";

function fixture(name: string): string {
  return readFileSync(path.join(fixtureDir, name), 'utf8');
}

describe('T21 closed bundle', () => {
  let closed: BundleResult;
  let open: BundleResult;

  beforeAll(async () => {
    const app = fixture('app.ts');
    expect(app).toContain(CLOSED_OPTION);
    const heavy = fixture('heavy.ts');
    closed = await bundleApp({ 'app.ts': app, 'heavy.ts': heavy });
    // Control: the same sources, open by default, must carry the sentinel, or the checks below prove nothing.
    open = await bundleApp({ 'app.ts': app.replace(CLOSED_OPTION, ''), 'heavy.ts': heavy });
  }, 20_000);

  it('T21-A04 closed bundle drops the unreachable sentinel and keeps the required effect', () => {
    expect(open.code).toContain(SENTINEL);
    expect(open.inputs).toContain('heavy.ts');
    expect(open.outputInputs).toContain('heavy.ts');

    // metafile.inputs lists every module esbuild loaded. The plugin keeps a bare import of a pruned
    // provider's module (packages/core/src/generator/Generator.ts:192-196), so heavy.ts may be loaded
    // there. What the bundle carries is metafile.outputs[*].inputs.
    expect(closed.code).not.toContain(SENTINEL);
    expect(closed.outputInputs).not.toContain('heavy.ts');
    expect(closed.inputs).toContain('app.ts');
    expect(closed.outputInputs).toContain('app.ts');
    expect(closed.code).toContain('T21_EFFECT_REQUIRED');
  });

  it('T21-A04 the executed bundle runs the effect once and starts the eager root', async () => {
    expect(await runBundle(closed.code)).toEqual({
      names: ['auth', 'log'],
      workerStarts: 1,
      effects: ['T21_EFFECT_REQUIRED'],
    });
  });

});

const SCOPE_SENTINEL = 'T21_SCOPE_SENTINEL_UNREACHABLE';
const SCOPE_ROOT = 'T21_SCOPE_ROOT_KEPT';

const SCOPE_HEAVY = `
export const MARK = '${SCOPE_SENTINEL}';

export class ScopeHeavy {
  tag(): string {
    return MARK;
  }
}
`;

const SCOPE_APP = `
import { defineBuilderConfig } from '@djodjonx/neosyringe';
import { ScopeHeavy } from './scope-heavy';

class PublicRoot {
  label = '${SCOPE_ROOT}';
}

export const container = defineBuilderConfig({
  name: 'T21ClosedScope',
  optimization: { mode: 'closed', roots: [PublicRoot] },
  injections: [
    { token: PublicRoot },
    { token: ScopeHeavy },
  ],
});

export async function run() {
  const scope = container.createScope();
  const label = scope.resolve(PublicRoot).label;
  await scope.destroy();
  await container.destroy();
  return label;
}
`;

describe('T21 closed scope root', () => {
  let scopeBundle: BundleResult;

  beforeAll(async () => {
    expect(SCOPE_HEAVY).toContain(SCOPE_SENTINEL);
    expect(SCOPE_SENTINEL).not.toBe(SENTINEL);
    scopeBundle = await bundleApp({ 'app.ts': SCOPE_APP, 'scope-heavy.ts': SCOPE_HEAVY });
  }, 20_000);

  it('scope.resolve(PublicRoot) drops the pruned sentinel and keeps the root', async () => {
    expect(scopeBundle.code).not.toContain(SCOPE_SENTINEL);
    expect(scopeBundle.outputInputs).not.toContain('scope-heavy.ts');
    expect(scopeBundle.code).toContain(SCOPE_ROOT);
    expect(await runBundle(scopeBundle.code)).toBe(SCOPE_ROOT);
  });

  it('scope.resolve(PrivateToken) -> NEO_ROOT_NOT_EXPORTED', async () => {
    const source = `
      import { defineBuilderConfig } from '@djodjonx/neosyringe';
      class PublicRoot {}
      class PrivateToken {}
      export const container = defineBuilderConfig({
        optimization: { mode: 'closed', roots: [PublicRoot] },
        injections: [{ token: PublicRoot }, { token: PrivateToken }],
      });
      export function run() {
        return container.createScope().resolve(PrivateToken);
      }
    `;
    const outcome = await executeFixture(source);
    expect(outcome.phase).toBe('build');
    const diagnostic = outcome.phase === 'build' ? outcome.diagnostic : '';
    expect(diagnostic).toContain("NEO_ROOT_NOT_EXPORTED: 'PrivateToken' is not an exported root of this closed container.");
  });
});
