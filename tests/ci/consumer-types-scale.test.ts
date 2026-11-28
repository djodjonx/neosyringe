import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { assertTarballFromBuild } from '../../scripts/ci/lib/tarball-proof.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const script = path.join(root, 'scripts/ci/consumer-types-scale.mjs');

function scale(args: readonly string[]) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

const packageDir = path.join(root, 'packages/neosyringe');
const scratch: string[] = [];

/** A real `pnpm pack` tarball of the build on disk. The mtime guard of `--pack` alone is left to CI. */
function packedArchive(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'neosyringe-archive-'));
  scratch.push(dir);
  const packed = spawnSync('pnpm', ['pack', '--pack-destination', dir], {
    cwd: packageDir,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  expect(packed.status, `${packed.stdout}\n${packed.stderr}`).toBe(0);
  const tarball = readdirSync(dir).find((name) => name.endsWith('.tgz'));
  if (tarball === undefined) throw new Error('pnpm pack made no tarball');
  const archive = path.join(dir, tarball);
  expect(assertTarballFromBuild(archive, packageDir).distFiles).toBeGreaterThan(0);
  return archive;
}

describe('consumer-types scale', () => {
  afterEach(() => {
    for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('P1 1000 inline registrations have no TS2589', () => {
    const run = scale(['1000']);
    const output = `${run.stdout ?? ''}\n${run.stderr ?? ''}`;
    expect(output).not.toContain('TS2589');
    expect(run.status, output).toBe(0);
  }, 180_000);

  it('P2 10000 inline registrations have no TS2589', () => {
    const run = scale(['10000']);
    const output = `${run.stdout ?? ''}\n${run.stderr ?? ''}`;
    expect(output).not.toContain('TS2589');
    expect(run.status, output).toBe(0);
  }, 180_000);

  it('W12 1000 inline registrations from the packed archive have no TS2589', () => {
    const run = scale(['1000', '--pack', packedArchive()]);
    const output = `${run.stdout ?? ''}\n${run.stderr ?? ''}`;
    expect(output).not.toContain('TS2589');
    expect(run.status, output).toBe(0);
    expect(output).toContain('from=archive');
    expect(output).toContain('types=extracted/package/dist/index.d.mts');
  }, 180_000);

  it('W13 10000 inline registrations from the packed archive have no TS2589', () => {
    const run = scale(['10000', '--pack', packedArchive()]);
    const output = `${run.stdout ?? ''}\n${run.stderr ?? ''}`;
    expect(output).not.toContain('TS2589');
    expect(run.status, output).toBe(0);
    expect(output).toContain('from=archive');
    expect(output).toContain('types=extracted/package/dist/index.d.mts');
  }, 180_000);
});
