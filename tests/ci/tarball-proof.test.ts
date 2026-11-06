import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertDistNewerThanSrc,
  assertTarballFromBuild,
  extractTarball,
} from '../../scripts/ci/lib/tarball-proof.mjs';

// T21-A03: the consumer tests must run on the tarball of the build on disk, not on an older dist.
// Uses the `tar` command, like scripts/ci/lib/tarball-proof.mjs. No clock: mtimes are set by hand.

const scratch: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

interface Layout {
  pkgDir: string;
  tarball: string;
}

const MANIFEST = {
  name: '@acme/proof',
  version: '1.2.3',
  main: './dist/index.cjs',
  module: './dist/index.mjs',
  exports: { '.': { import: './dist/index.mjs', require: './dist/index.cjs' } },
};

/** A package on disk and a tarball of it, as `pnpm pack` lays it out (a `package/` folder). */
function packFixture(manifest: Record<string, unknown> = MANIFEST, files?: Record<string, string>): Layout {
  const pkgDir = path.join(tempDir('t21-proof-pkg-'), 'proof');
  mkdirSync(path.join(pkgDir, 'dist'), { recursive: true });
  const content = files ?? {
    'dist/index.mjs': 'export const build = "mjs";\n',
    'dist/index.cjs': 'exports.build = "cjs";\n',
  };
  writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: MANIFEST.name, version: MANIFEST.version }));
  for (const [rel, text] of Object.entries(content)) writeFileSync(path.join(pkgDir, rel), text);

  const stage = tempDir('t21-proof-stage-');
  mkdirSync(path.join(stage, 'package/dist'), { recursive: true });
  writeFileSync(path.join(stage, 'package/package.json'), JSON.stringify(manifest));
  for (const [rel, text] of Object.entries(content)) writeFileSync(path.join(stage, 'package', rel), text);
  const tarball = path.join(tempDir('t21-proof-tgz-'), 'acme-proof-1.2.3.tgz');
  const made = spawnSync('tar', ['-czf', tarball, '-C', stage, 'package'], { encoding: 'utf8' });
  expect(made.status, made.stderr).toBe(0);
  return { pkgDir, tarball };
}

describe('T21 tarball proof', () => {
  afterEach(() => {
    for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('T21-A03 a tarball whose dist differs from the disk build is refused', () => {
    const { pkgDir, tarball } = packFixture();
    // The disk build moves on after the tarball was packed: the tarball is now an older dist.
    writeFileSync(path.join(pkgDir, 'dist/index.mjs'), 'export const build = "newer";\n');
    expect(() => assertTarballFromBuild(tarball, pkgDir)).toThrow(/differs from the disk build: dist\/index\.mjs/);
  });

  it('T21-A03 a stale dist is refused', () => {
    const dir = tempDir('t21-proof-stale-');
    const src = path.join(dir, 'src');
    const distFile = path.join(dir, 'dist/index.mjs');
    mkdirSync(src, { recursive: true });
    mkdirSync(path.dirname(distFile), { recursive: true });
    writeFileSync(path.join(src, 'index.ts'), 'export {};\n');
    writeFileSync(distFile, 'export {};\n');
    utimesSync(distFile, 1_000, 1_000);
    utimesSync(path.join(src, 'index.ts'), 2_000, 2_000);
    expect(() => assertDistNewerThanSrc(distFile, src)).toThrow(/stale build output .*index\.mjs/);

    utimesSync(distFile, 3_000, 3_000);
    expect(() => assertDistNewerThanSrc(distFile, src)).not.toThrow();
    expect(() => assertDistNewerThanSrc(path.join(dir, 'dist/absent.mjs'), src)).toThrow(/missing build output/);
  });

  it('T21-A03 a matching tarball passes', () => {
    const { pkgDir, tarball } = packFixture();
    expect(assertTarballFromBuild(tarball, pkgDir)).toEqual({ name: '@acme/proof', version: '1.2.3', distFiles: 2 });
    const unpacked = extractTarball(tarball, tempDir('t21-proof-out-'));
    expect(path.basename(unpacked)).toBe('package');
  });

  it('T21-A03 a tarball of another version is refused', () => {
    const { pkgDir, tarball } = packFixture({ ...MANIFEST, version: '1.2.2' });
    expect(() => assertTarballFromBuild(tarball, pkgDir)).toThrow(/is version 1\.2\.2, package\.json says 1\.2\.3/);
  });

  it('T21-A03 a tarball of another package is refused', () => {
    const { pkgDir, tarball } = packFixture({ ...MANIFEST, name: '@acme/other' });
    expect(() => assertTarballFromBuild(tarball, pkgDir)).toThrow(/is @acme\/other, the package on disk is @acme\/proof/);
  });

  it('T21-A03 a workspace: specifier left in the tarball is refused', () => {
    const { pkgDir, tarball } = packFixture({ ...MANIFEST, dependencies: { '@acme/core': 'workspace:*' } });
    expect(() => assertTarballFromBuild(tarball, pkgDir)).toThrow(/keeps dependencies\.@acme\/core = workspace:\*/);
  });

  it('T21-A03 a tarball that lacks a declared entry is refused', () => {
    const { pkgDir, tarball } = packFixture(MANIFEST, { 'dist/index.mjs': 'export {};\n' });
    expect(() => assertTarballFromBuild(tarball, pkgDir)).toThrow(/lacks the declared entry \.\/dist\/index\.cjs/);
  });

  it('T21-A03 a dist file that exists in the tarball only is refused', () => {
    const { pkgDir, tarball } = packFixture();
    rmSync(path.join(pkgDir, 'dist/index.cjs'));
    expect(() => assertTarballFromBuild(tarball, pkgDir)).toThrow(/carries dist\/index\.cjs, which is not on disk/);
  });
});
