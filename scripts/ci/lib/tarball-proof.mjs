// scripts/ci/lib/tarball-proof.mjs
// Proof that a tarball made by `pnpm pack` carries the build that is on disk, not an older dist.
// Used by scripts/ci/consumer-dist.mjs and tested in tests/ci/tarball-proof.test.ts.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];

function collectPaths(node, out) {
  if (typeof node === 'string') {
    if (node.startsWith('.')) out.push(node);
    return;
  }
  if (node && typeof node === 'object') {
    for (const value of Object.values(node)) collectPaths(value, out);
  }
}

/** Every file path a package.json declares as an entry: main, module, types, exports, bin. */
export function declaredEntries(pkg) {
  const rels = [];
  for (const field of ['main', 'module', 'types']) {
    if (typeof pkg[field] === 'string') rels.push(pkg[field]);
  }
  collectPaths(pkg.exports, rels);
  if (typeof pkg.bin === 'string') rels.push(pkg.bin);
  else if (pkg.bin && typeof pkg.bin === 'object') {
    for (const value of Object.values(pkg.bin)) {
      if (typeof value === 'string') rels.push(value);
    }
  }
  return rels;
}

function filesUnder(dir) {
  const found = [];
  const pending = [dir];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(full);
      else if (entry.isFile()) found.push(full);
    }
  }
  return found.sort();
}

/** Unpacks `tarball` into `destDir` (created if needed) and returns the `package` folder inside it. */
export function extractTarball(tarball, destDir) {
  if (!existsSync(tarball)) throw new Error(`missing tarball ${tarball}`);
  mkdirSync(destDir, { recursive: true });
  const result = spawnSync('tar', ['-xzf', tarball, '-C', destDir], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`could not extract ${tarball}: ${result.stderr || result.error?.message || 'tar failed'}`);
  }
  const unpacked = path.join(destDir, 'package');
  if (!existsSync(path.join(unpacked, 'package.json'))) {
    throw new Error(`${tarball} has no package/package.json`);
  }
  return unpacked;
}

/**
 * Refuses a tarball that does not come from the build on disk in `pkgDir`:
 * another name or version, a declared entry that is missing, a dist file that differs from
 * the disk byte for byte, or a workspace: specifier left in a dependency field.
 * Returns what it checked.
 */
export function assertTarballFromBuild(tarball, pkgDir) {
  const scratch = path.join(path.dirname(tarball), `.proof-${path.basename(tarball, '.tgz')}`);
  rmSync(scratch, { recursive: true, force: true });
  try {
    const unpacked = extractTarball(tarball, scratch);
    const packed = JSON.parse(readFileSync(path.join(unpacked, 'package.json'), 'utf8'));
    const disk = JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
    if (packed.name !== disk.name) {
      throw new Error(`tarball ${tarball} is ${packed.name}, the package on disk is ${disk.name}`);
    }
    if (packed.version !== disk.version) {
      throw new Error(`tarball ${tarball} is version ${packed.version}, package.json says ${disk.version}`);
    }
    for (const rel of declaredEntries(packed)) {
      if (!existsSync(path.join(unpacked, rel))) {
        throw new Error(`tarball ${tarball} lacks the declared entry ${rel}`);
      }
    }
    for (const field of DEPENDENCY_FIELDS) {
      for (const [name, range] of Object.entries(packed[field] ?? {})) {
        if (String(range).startsWith('workspace:')) {
          throw new Error(`tarball ${tarball} keeps ${field}.${name} = ${range}`);
        }
      }
    }
    const distRoot = path.join(unpacked, 'dist');
    const distFiles = existsSync(distRoot) ? filesUnder(distRoot) : [];
    for (const file of distFiles) {
      const rel = path.relative(unpacked, file);
      const onDisk = path.join(pkgDir, rel);
      if (!existsSync(onDisk)) {
        throw new Error(`tarball ${tarball} carries ${rel}, which is not on disk in ${pkgDir}`);
      }
      if (!readFileSync(file).equals(readFileSync(onDisk))) {
        throw new Error(`tarball ${tarball} differs from the disk build: ${rel}`);
      }
    }
    return { name: packed.name, version: packed.version, distFiles: distFiles.length };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function newestMtime(dir) {
  let newest = null;
  for (const file of filesUnder(dir)) {
    const mtime = statSync(file).mtimeMs;
    if (newest === null || mtime > newest) newest = mtime;
  }
  return newest;
}

/** Refuses a dist file that is missing or older than the newest file under `srcDir`. */
export function assertDistNewerThanSrc(distFile, srcDir) {
  if (!existsSync(distFile)) throw new Error(`missing build output ${distFile}; run pnpm build`);
  const newestSrc = existsSync(srcDir) ? newestMtime(srcDir) : null;
  if (newestSrc !== null && statSync(distFile).mtimeMs < newestSrc) {
    throw new Error(`stale build output ${distFile} is older than ${srcDir}; run pnpm build`);
  }
}
