import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { assertTarballFromBuild } from '../../scripts/ci/lib/tarball-proof.mjs';

/**
 * G07: the compiled examples of examples/new-api are typechecked against the extracted archive of the real package, in
 * place of the source. Running them from the archives is `scripts/ci/consumer-dist.mjs` (`pnpm dist:consumer`, which
 * installs from the registry): this suite proves the types, and that the script reads the same list as the sources.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const script = path.join(root, 'scripts/ci/consumer-types.mjs');
const packageDir = path.join(root, 'packages/neosyringe');
const entry = path.join(root, 'packages/neosyringe/src/index.ts');
const expectedFile = path.join(root, 'tests/e2e/fixtures/g07-examples.expected.json');
const scratch: string[] = [];

const EXAMPLES = ['alias', 'disposal', 'resolve-many', 'scope-inputs', 'signal', 'usage-recipes'];

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

/** A real `pnpm pack` tarball of the build on disk. */
function packedArchive(): string {
  const dir = temp('neosyringe-g07-archive-');
  const packed = spawnSync('pnpm', ['pack', '--pack-destination', dir], { cwd: packageDir, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  expect(packed.status, `${packed.stdout}\n${packed.stderr}`).toBe(0);
  const tarball = readdirSync(dir).find((name) => name.endsWith('.tgz'));
  if (tarball === undefined) throw new Error('pnpm pack made no tarball');
  const archive = path.join(dir, tarball);
  expect(assertTarballFromBuild(archive, packageDir).distFiles).toBeGreaterThan(0);
  return archive;
}

/** A fixture holding one example, whose `paths` mapping points at the source: `--pack` replaces it with the archive. */
function fixture(name: string): string {
  const dir = temp(`neosyringe-g07-${name}-`);
  cpSync(path.join(root, 'examples/new-api', `${name}.ts`), path.join(dir, `${name}.ts`));
  writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      strict: true,
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'bundler',
      noEmit: true,
      skipLibCheck: true,
      types: [],
      baseUrl: '.',
      paths: { '@djodjonx/neosyringe': [entry] },
    },
    files: [`${name}.ts`],
  }));
  return dir;
}

describe('G07 examples from the archive', () => {
  it('G07-P10 the expected file names the six examples, and consumer-dist builds and runs that same list', () => {
    const expected = JSON.parse(readFileSync(expectedFile, 'utf8')) as Record<string, unknown>;
    const consumerDist = readFileSync(path.join(root, 'scripts/ci/consumer-dist.mjs'), 'utf8');

    expect(Object.keys(expected).sort()).toEqual(EXAMPLES);
    expect(consumerDist).toContain("path.join(t21Fixtures, 'g07-examples.expected.json')");
    expect(consumerDist).toContain('Object.keys(g07Expected)');
    expect(consumerDist).toContain("'examples/new-api', `${name}.ts`");
    expect(consumerDist).toContain('g07 examples from the tarballs');
  });

  it('G07-P10 every example typechecks against the extracted archive of the real package', () => {
    const archive = packedArchive();
    for (const name of EXAMPLES) {
      const result = run([fixture(name), '--pack', archive]);
      expect(result.status, `${name}\n${result.output}`).toBe(0);
      expect(result.output, name).toContain('from=archive');
      expect(result.output, name).toContain('types=extracted/package/dist/index.d.mts');
    }
  }, 180_000);

  it('G07-P10 an example whose type is wrong fails against the archive (the check reads the archive)', () => {
    const archive = packedArchive();
    const dir = fixture('resolve-many');
    const file = path.join(dir, 'resolve-many.ts');
    writeFileSync(file, `${readFileSync(file, 'utf8')}\nconst wrong: string = container.resolveMany([Mailer])[0];\nvoid wrong;\n`);
    const result = run([dir, '--pack', archive]);

    expect(result.output).toContain('TS2322');
    expect(result.status).toBe(1);
  }, 120_000);
});
