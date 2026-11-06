import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
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
