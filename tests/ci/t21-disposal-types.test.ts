import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { assertTarballFromBuild } from '../../scripts/ci/lib/tarball-proof.mjs';

/**
 * T21 D7, the disposal protocols on the public types. `await using` is typed when the consumer has the disposable lib:
 * the fixtures of tests/consumer-types/positive-disposable are typechecked against the source of `@djodjonx/neosyringe`
 * and against a packed archive of the build on disk (the archive is what a consumer installs). The existing `positive`
 * consumer has no disposable lib and must still compile. A synchronous `using` of a container stays refused: the cleanup
 * may be asynchronous, so the container offers no `[Symbol.dispose]`.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const harness = path.join(root, 'scripts/ci/consumer-types.mjs');
const packageDir = path.join(root, 'packages/neosyringe');
const scratch: string[] = [];

afterAll(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function run(args: readonly string[]) {
  const result = spawnSync(process.execPath, [harness, ...args], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { status: result.status, output: `${result.stdout ?? ''}\n${result.stderr ?? ''}` };
}

let archive: string | undefined;

/** A real `pnpm pack` tarball of the build on disk, made once for the file. */
function packedArchive(): string {
  if (archive !== undefined) return archive;
  const dir = mkdtempSync(path.join(tmpdir(), 'neosyringe-t21-archive-'));
  scratch.push(dir);
  const packed = spawnSync('pnpm', ['pack', '--pack-destination', dir], { cwd: packageDir, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  expect(packed.status, `${packed.stdout}\n${packed.stderr}`).toBe(0);
  const tarball = readdirSync(dir).find((name) => name.endsWith('.tgz'));
  if (tarball === undefined) throw new Error('pnpm pack made no tarball');
  archive = path.join(dir, tarball);
  expect(assertTarballFromBuild(archive, packageDir).distFiles).toBeGreaterThan(0);
  return archive;
}

describe('T21-P20 D7 a container and a scope are await using resources for a consumer with the disposable lib', () => {
  it('T21-P20 positive-disposable compiles against the source of the package', () => {
    const result = run(['tests/consumer-types/positive-disposable']);
    expect(result.status, result.output).toBe(0);
  }, 120_000);

  it('T21-P20 positive-disposable compiles against the packed archive', () => {
    const result = run(['tests/consumer-types/positive-disposable', '--pack', packedArchive()]);
    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain('from=archive');
  }, 180_000);

  it('T21-P20 the existing consumer, whose lib has no disposable types, still compiles from the source and from the archive', () => {
    const fromSource = run(['tests/consumer-types/positive']);
    expect(fromSource.status, fromSource.output).toBe(0);
    const fromArchive = run(['tests/consumer-types/positive', '--pack', packedArchive()]);
    expect(fromArchive.output).toContain('from=archive');
    expect(fromArchive.status, fromArchive.output).toBe(0);
  }, 240_000);
});

describe('T21-P21 D7 a synchronous using of a container is refused', () => {
  it('T21-P21 negative-disposable reports TS2850 for a container, a minimal one and a scope, from the source and from the archive', () => {
    const fromSource = run(['tests/consumer-types/negative-disposable', '--expect-file', 'expected-diagnostic.txt']);
    expect(fromSource.status, fromSource.output).toBe(0);
    const fromArchive = run(['tests/consumer-types/negative-disposable', '--expect-file', 'expected-diagnostic.txt', '--pack', packedArchive()]);
    expect(fromArchive.status, fromArchive.output).toBe(0);
  }, 240_000);

  it('T21-P21 a line that is not reported fails the harness', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'neosyringe-t21-expect-'));
    scratch.push(dir);
    const extra = path.join(dir, 'missing.txt');
    writeFileSync(extra, 'consumer.ts(1,1): error TS9999: not reported\n');
    const missing = run(['tests/consumer-types/negative-disposable', '--expect-file', extra]);
    expect(missing.status).toBe(1);
    expect(missing.output).toContain('TS9999');
  }, 120_000);
});

describe('T21-P25 D7 a hand-built object typed as a container needs [Symbol.asyncDispose] when the lib declares the symbol', () => {
  const REFUSED = [
    "consumer.ts(34,14): error TS2741: Property '[SymbolConstructor.asyncDispose]' is missing in type 'WithoutAsyncDispose<CoreContainer>' but required in type 'CoreContainer'.",
    "consumer.ts(35,14): error TS2741: Property '[SymbolConstructor.asyncDispose]' is missing in type 'WithoutAsyncDispose<Container>' but required in type 'Container'.",
    'consumer.ts(36,14): error TS2741: Property \'[SymbolConstructor.asyncDispose]\' is missing in type \'WithoutAsyncDispose<ContainerTemplate<readonly [], "full">>\' but required in type \'ContainerTemplate<readonly [], "full">\'.',
    "consumer.ts(37,14): error TS2322: Type 'WithoutAsyncDispose<BoundContainer>' is not assignable to type 'BoundContainer'.",
  ];

  it('T21-P25 CoreContainer, Container, ContainerTemplate and BoundContainer refuse an object without the member, from the source and from the archive', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'neosyringe-t21-double-'));
    scratch.push(dir);
    const expected = path.join(dir, 'double.txt');
    writeFileSync(expected, `${REFUSED.join('\n')}\n`);
    const fromSource = run(['tests/consumer-types/negative-disposable', '--expect-file', expected]);
    expect(fromSource.status, fromSource.output).toBe(0);
    const fromArchive = run(['tests/consumer-types/negative-disposable', '--expect-file', expected, '--pack', packedArchive()]);
    expect(fromArchive.status, fromArchive.output).toBe(0);
  }, 240_000);
});
