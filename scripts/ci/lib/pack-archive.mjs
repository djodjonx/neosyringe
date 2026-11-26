// scripts/ci/lib/pack-archive.mjs
// Where a consumer finds the types of the package: its source, a fresh `pnpm pack` archive, a given archive or an
// extracted folder. Used by scripts/ci/consumer-types.mjs and scripts/ci/consumer-types-scale.mjs.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { assertDistNewerThanSrc, assertTarballFromBuild, extractTarball } from './tarball-proof.mjs';

/** A failure of `pnpm pack` itself, which the callers report as a plain message. */
export class PackError extends Error {}

/** The `.d.ts` entry a package folder declares: `exports['.'].types`, `types`, or `index.ts`. */
export function typesEntry(dir) {
  const pkgFile = path.join(dir, 'package.json');
  if (!existsSync(pkgFile)) return path.join(dir, 'index.ts');
  const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'));
  const exported = pkg.exports?.['.']?.types;
  const relative = typeof exported === 'string' ? exported : pkg.types;
  if (typeof relative !== 'string') return path.join(dir, 'index.ts');
  return path.resolve(dir, relative);
}

/**
 * `pnpm pack` of `packageDir` into `destDir`, proved to carry the build on disk (no stale dist, no workspace: specifier).
 * Returns the tarball path.
 */
export function packFresh(packageDir, destDir) {
  const packed = spawnSync('pnpm', ['pack', '--json', '--pack-destination', destDir], {
    cwd: packageDir,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (packed.status !== 0) throw new PackError(`pnpm pack failed\n${packed.stdout ?? ''}\n${packed.stderr ?? ''}`);
  const output = packed.stdout ?? '';
  const parsed = JSON.parse(output.slice(output.indexOf('{'), output.lastIndexOf('}') + 1));
  const filename = parsed.filename ?? parsed.name;
  if (typeof filename !== 'string' || !filename.endsWith('.tgz')) throw new PackError(`pnpm pack json has no tarball:\n${output}`);
  const tarball = path.isAbsolute(filename) ? filename : path.join(destDir, filename);
  const pkg = JSON.parse(readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
  assertDistNewerThanSrc(path.join(packageDir, pkg.types), path.join(packageDir, 'src'));
  assertTarballFromBuild(tarball, packageDir);
  return tarball;
}

/**
 * The types entry a consumer reads. `pack` undefined: `sourceEntry`. `''`: a fresh archive of `packageDir`, extracted
 * into `<scratch>/extracted`. A `.tgz` path: that archive, extracted the same way. Any other value: an extracted folder.
 * `label` says which one it was.
 */
export function resolveTypesEntry({ pack, packageDir, scratch, sourceEntry }) {
  if (pack === undefined) return { entry: sourceEntry, label: 'source' };
  if (pack !== '' && !pack.endsWith('.tgz')) return { entry: typesEntry(path.resolve(pack)), label: 'folder' };
  const tarball = pack === '' ? packFresh(packageDir, scratch) : path.resolve(pack);
  const unpacked = extractTarball(tarball, path.join(scratch, 'extracted'));
  return { entry: typesEntry(unpacked), label: `archive ${path.basename(tarball)}` };
}
