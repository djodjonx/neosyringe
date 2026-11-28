import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { assertTarballFromBuild } from '../../scripts/ci/lib/tarball-proof.mjs';

/**
 * `consumer-types.mjs <dir> --pack [<tarball|dir>]` typechecks the fixture against the extracted package, in place of the
 * `paths` mapping of the fixture. The fake archives below declare `Lifecycle` differently from the source, so a
 * fixture that passes or fails with them has read the archive.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const script = path.join(root, 'scripts/ci/consumer-types.mjs');
const packageDir = path.join(root, 'packages/neosyringe');
const entry = path.join(root, 'packages/neosyringe/src/index.ts');
const scratch: string[] = [];

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

function run(args: readonly string[]) {
  const result = spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { status: result.status, output: `${result.stdout ?? ''}\n${result.stderr ?? ''}` };
}

/** A tarball of a package named like the product, whose `Lifecycle` is `declared`. */
function fakeArchive(declared: string): string {
  const dir = temp('neosyringe-fake-archive-');
  const pkg = path.join(dir, 'package');
  mkdirSync(pkg, { recursive: true });
  writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: '@djodjonx/neosyringe', version: '0.0.0', types: './index.d.ts' }));
  writeFileSync(path.join(pkg, 'index.d.ts'), `export type Lifecycle = ${declared};\n`);
  const tarball = path.join(dir, 'fake.tgz');
  const packed = spawnSync('tar', ['-czf', tarball, '-C', dir, 'package'], { encoding: 'utf8' });
  expect(packed.status, packed.stderr).toBe(0);
  return tarball;
}

/** A fixture that reads `Lifecycle` from the product, with the `paths` mapping to the source. */
function fixture(expected?: string): string {
  const dir = temp('neosyringe-pack-fixture-');
  writeFileSync(path.join(dir, 'tsconfig.json'), `{
  "compilerOptions": {
    "strict": true, "target": "ES2022", "module": "ESNext", "moduleResolution": "bundler",
    "noEmit": true, "skipLibCheck": true, "types": [], "baseUrl": ".",
    "paths": { "@djodjonx/neosyringe": [${JSON.stringify(entry)}] }
  },
  "files": ["consumer.ts"]
}
`);
  writeFileSync(path.join(dir, 'consumer.ts'), "import type { Lifecycle } from '@djodjonx/neosyringe';\nexport const value: Lifecycle = 'singleton';\n");
  if (expected !== undefined) writeFileSync(path.join(dir, 'expected-diagnostic.txt'), expected);
  return dir;
}

/** A real `pnpm pack` tarball of the build on disk. */
function packedArchive(): string {
  const dir = temp('neosyringe-real-archive-');
  const packed = spawnSync('pnpm', ['pack', '--pack-destination', dir], { cwd: packageDir, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  expect(packed.status, `${packed.stdout}\n${packed.stderr}`).toBe(0);
  const tarball = readdirSync(dir).find((name) => name.endsWith('.tgz'));
  if (tarball === undefined) throw new Error('pnpm pack made no tarball');
  const archive = path.join(dir, tarball);
  expect(assertTarballFromBuild(archive, packageDir).distFiles).toBeGreaterThan(0);
  return archive;
}

describe('E17-P12 consumer-types --pack', () => {
  it('control: without --pack the fixture reads the source and the same fixture passes (green on the base too)', () => {
    expect(run([fixture()]).status).toBe(0);
  });

  it('E17-P12 with --pack the fixture is typechecked against the archive, and an archive that disagrees fails it', () => {
    const result = run([fixture(), '--pack', fakeArchive("'archive-only'")]);
    expect(result.output).toContain('TS2322');
    expect(result.status).toBe(1);
  });

  it('E17-P12 with --pack an archive that agrees passes and names itself', () => {
    const result = run([fixture(), '--pack', fakeArchive("'singleton' | 'transient'")]);
    expect(result.output).toContain('from=archive');
    expect(result.output).toContain('types=extracted/package/index.d.ts');
    expect(result.status).toBe(0);
  });

  it('E17-P12 with --pack and --expect-file the expected diagnostic must come from the archive', () => {
    const wanted = `TS2322\nType '"singleton"' is not assignable to type '"archive-only"'`;
    expect(run([fixture(wanted), '--expect-file', 'expected-diagnostic.txt', '--pack', fakeArchive("'archive-only'")]).status).toBe(0);
  });

  it('E17-P12 with --pack and --expect-file a missing expected line fails', () => {
    const missing = `TS2322\nType '"singleton"' is not assignable to type '"archive-only"'\nTS9999`;
    const result = run([fixture(missing), '--expect-file', 'expected-diagnostic.txt', '--pack', fakeArchive("'archive-only'")]);
    // Only the line the archive cannot produce is missing: the first two came from it.
    expect(result.output).toContain('expected diagnostic ["TS9999"] was not reported');
    expect(result.status).toBe(1);
  });

  it('E17-P12 --pack of the real package: the positive fixture passes and reads the extracted dist', () => {
    const result = run(['tests/consumer-types/positive', '--pack', packedArchive()]);
    expect(result.output).toContain('from=archive');
    expect(result.output).toContain('types=extracted/package/dist/index.d.mts');
    expect(result.status, result.output).toBe(0);
  }, 120_000);

  it('E17-P12 --pack of the real package: the negative fixture passes, and a missing expected line fails', () => {
    const archive = packedArchive();
    const real = run(['tests/consumer-types/negative', '--expect-file', 'expected-diagnostic.txt', '--pack', archive]);
    expect(real.status, real.output).toBe(0);
    expect(real.output).toContain('from=archive');
    const extra = path.join(temp('neosyringe-expect-'), 'missing.txt');
    writeFileSync(extra, 'TS2322\nTS9999\n');
    const missing = run(['tests/consumer-types/negative', '--expect-file', extra, '--pack', archive]);
    expect(missing.status).toBe(1);
    expect(missing.output).toContain('TS9999');
  }, 120_000);
});
