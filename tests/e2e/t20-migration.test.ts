import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { executeFixture } from './helpers/execute-fixture';
import { executeCompatible } from './helpers/t20-compat';

// T20-A06 and 07-migration-et-release.md "Protocole de migration".
// No archive of the previous release is installed in this checkout: "before" is a legacy-shaped
// consumer (no `dependencies`, override without await) run through the built core in compatible
// mode. It shows what the documented changes keep, not what the old package printed.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const examplesDir = path.join(repoRoot, 'examples/new-api');

interface BuildOptions {
  validation?: 'strict' | 'compatible';
  testOverrides?: boolean;
}

const WITH_TEST_API: BuildOptions = { validation: 'strict', testOverrides: true };
const COMPATIBLE_WITH_TEST_API: BuildOptions = { validation: 'compatible', testOverrides: true };

function example(file: string): string {
  return readFileSync(path.join(examplesDir, file), 'utf8');
}

// 07-migration-et-release.md "Protocole de migration" step 2: one singleton with a test override,
// one async factory, one parent and child. Same values and same disposals before and after.
const EXPECTED = {
  real: 'report from real',
  mocked: 'report from fake',
  restored: 'report from real',
  disposed: 2,
  afterDestroy: 'NEO_CONTAINER_DESTROYED',
  asyncBeforeInit: 'NEO_NOT_INITIALIZED',
  asyncEndpoint: '/api',
  asyncClosed: 1,
  asyncAfterDestroy: 'NEO_CONTAINER_DESTROYED',
  childLine: 'parent handled',
  sharedLogger: true,
  parentClosedAfterChild: 0,
  parentClosedAfterParent: 1,
};

describe('T20 migration of a legacy consumer', () => {
  it('T20-A06 before (compatible, opaque factory) and after (strict, declared) give the same values and disposals', async () => {
    const before = await executeCompatible(example('migration-before.ts'), true);
    expect(before, JSON.stringify(before)).toMatchObject({ phase: 'ok' });
    if (before.phase !== 'ok') return;
    expect(before.value).toEqual(EXPECTED);
    expect(before.warnings.join('\n')).toContain('NEO_FACTORY_DEPENDENCIES_REQUIRED');

    const after = await executeFixture(example('migration-after.ts'), WITH_TEST_API);
    expect(after).toMatchObject({ phase: 'ok' });
    if (after.phase !== 'ok') return;
    expect(after.value).toEqual(EXPECTED);
    expect(after.value).toEqual(before.value);
  });

  it('T20-A06 the default strict plugin refuses the legacy factory with NEO_FACTORY_DEPENDENCIES_REQUIRED', async () => {
    const outcome = await executeFixture(example('migration-before.ts'), WITH_TEST_API);
    expect(outcome.phase).toBe('build');
    if (outcome.phase === 'build') expect(outcome.diagnostic).toContain('NEO_FACTORY_DEPENDENCIES_REQUIRED');
  });

  it('T20-A06 plugin validation: compatible does not reach the transform: the legacy factory is still refused', async () => {
    const outcome = await executeFixture(example('migration-before.ts'), COMPATIBLE_WITH_TEST_API);
    expect(outcome.phase).toBe('build');
    if (outcome.phase === 'build') expect(outcome.diagnostic).toContain('NEO_FACTORY_DEPENDENCIES_REQUIRED');
  });

  it('T20-A06 a reconfiguration that is not awaited leaves the container busy while async resources close', async () => {
    const asyncResource = [
      "import { defineBuilderConfig } from '@djodjonx/neosyringe';",
      'class Db {',
      '  static closed = 0;',
      '  label(): string { return "real"; }',
      '  async dispose(): Promise<void> { await Promise.resolve(); Db.closed += 1; }',
      '}',
      'class Fake extends Db { label(): string { return "fake"; } }',
      "export const container = defineBuilderConfig({ name: 'Busy', injections: [{ token: Db }] });",
      'export async function run() {',
      '  container.resolve(Db);',
      '  const pending = container.override(Db, () => new Fake());',
      '  let during = "no error";',
      '  try { container.resolve(Db); } catch (error) { during = (error as { code?: string }).code ?? String(error); }',
      '  await pending;',
      '  return { during, after: container.resolve(Db).label(), closed: Db.closed };',
      '}',
      '',
    ].join('\n');
    const outcome = await executeFixture(asyncResource, WITH_TEST_API);
    expect(outcome).toMatchObject({ phase: 'ok', value: { during: 'NEO_CONTAINER_BUSY', after: 'fake', closed: 1 } });
  });

  it('T20-A06 step 2 only: the same candidate turned closed keeps the values and the disposals', async () => {
    const open = example('migration-after.ts');
    const closed = open.replace("name: 'LegacyApp',", "name: 'LegacyApp',\n  optimization: { mode: 'closed', roots: [Report] },");
    expect(closed).not.toBe(open);
    const outcome = await executeFixture(closed, WITH_TEST_API);
    expect(outcome).toMatchObject({ phase: 'ok' });
    if (outcome.phase === 'ok') expect(outcome.value).toEqual(EXPECTED);
  });

  it('T20-A06 step 2 only: a call outside the roots is refused at build with NEO_ROOT_NOT_EXPORTED', async () => {
    const open = example('migration-after.ts');
    const closed = open
      .replace("name: 'LegacyApp',", "name: 'LegacyApp',\n  optimization: { mode: 'closed', roots: [Report] },")
      .replace("const real = container.resolve(Report).summary();", "const real = container.resolve(Report).summary();\n  container.resolve(Database);");
    const outcome = await executeFixture(closed, WITH_TEST_API);
    expect(outcome.phase).toBe('build');
    if (outcome.phase === 'build') expect(outcome.diagnostic).toContain('NEO_ROOT_NOT_EXPORTED');
  });

  it('T20-A06 the migration guide ships the executed before and after files', () => {
    const guide = path.join(repoRoot, 'docs/guide/migration.md');
    expect(existsSync(guide), 'missing docs/guide/migration.md').toBe(true);
    const text = existsSync(guide) ? readFileSync(guide, 'utf8') : '';
    expect(text).toContain('<<< @/../examples/new-api/migration-before.ts');
    expect(text).toContain('<<< @/../examples/new-api/migration-after.ts');
    for (const row of [
      'FactoryContext',
      'NEO_FACTORY_DEPENDENCIES_REQUIRED',
      'NEO_CONTAINER_DESTROYED',
      'testOverrides',
      'useValue',
      "profile: 'minimal'",
    ]) {
      expect(text, row).toContain(row);
    }
  });
});
