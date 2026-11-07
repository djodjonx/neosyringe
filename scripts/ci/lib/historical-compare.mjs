// Pure checks for scripts/ci/historical-migration.mjs. No network and no clock.
import { isDeepStrictEqual } from 'node:util';

const EXACT_VERSION = /^\d+\.\d+\.\d+$/;

function pinVersion(spec) {
  const text = String(spec);
  const at = text.lastIndexOf('@');
  if (at <= 0) return text;
  return text.slice(at + 1);
}

/** Refuses a range, a tag, or any spec whose version is not `x.y.z`. */
export function assertExactPins(specs) {
  const list = Array.isArray(specs) ? specs : [specs];
  for (const spec of list) {
    const version = pinVersion(spec);
    if (!EXACT_VERSION.test(version)) {
      throw new Error(`refusing a pin that is not an exact version: ${spec}`);
    }
  }
}

/** The installed package.json version must be the pin, not a nearby release. */
export function assertInstalledVersion(installed, pin) {
  if (installed !== pin) throw new Error(`installed version ${installed} is not pin ${pin}`);
}

/**
 * `declared` maps a key to the only before/after pair that may differ.
 * An equal pair returns no difference. Anything else throws.
 */
export function compareBehaviour(before, after, declared) {
  const pins = declared ?? {};
  const keys = new Set([...Object.keys(before), ...Object.keys(after), ...Object.keys(pins)]);
  for (const key of keys) {
    const left = before[key];
    const right = after[key];
    const same = isDeepStrictEqual(left, right);
    const pin = pins[key];
    if (same) {
      if (pin !== undefined) throw new Error(`declared difference did not occur: ${key}`);
      continue;
    }
    if (pin === undefined) throw new Error(`undeclared difference: ${key}`);
    if (!isDeepStrictEqual(left, pin.before) || !isDeepStrictEqual(right, pin.after)) {
      throw new Error(
        `declared difference ${key} pinned before ${JSON.stringify(pin.before)} after ${JSON.stringify(pin.after)}`,
      );
    }
  }
  return [];
}

/** The build or run text must contain the announced code. Returns that text. */
export function assertDiagnostic(output, code) {
  if (!String(output).includes(code)) throw new Error(`missing diagnostic ${code}`);
  return output;
}

function isUnderRoot(file, root) {
  const text = String(file);
  const base = String(root);
  if (text === base) return true;
  const slash = base.endsWith('/') || base.endsWith('\\') ? base : `${base}/`;
  const back = base.endsWith('/') || base.endsWith('\\') ? base : `${base}\\`;
  return text.startsWith(slash) || text.startsWith(back);
}

/**
 * `proof.projectRoot` and every path must sit outside `root`.
 * A successful build must also have recorded at least one TypeScript read.
 */
export function assertBuildOutsideRepo(proof, root) {
  const projectRoot = proof?.projectRoot;
  if (typeof projectRoot !== 'string' || projectRoot === '') {
    throw new Error('build did not report projectRoot');
  }
  if (proof?.ok === true && (!Array.isArray(proof.reads) || proof.reads.length === 0)) {
    throw new Error('build did not report a TypeScript read');
  }
  const paths = Array.isArray(proof?.paths) ? proof.paths : [];
  for (const file of [projectRoot, ...paths]) {
    const text = String(file);
    if (isUnderRoot(text, root)) throw new Error(`build read a file under the repo: ${text}`);
  }
}

const NESTED_DJODJONX = /(?:^|[\\/])node_modules[\\/]@djodjonx[\\/][^\\/]+[\\/]node_modules[\\/]@djodjonx[\\/]/;

/** Refuses `node_modules/@djodjonx/<pkg>/node_modules/@djodjonx/`. */
export function assertNoNestedDjodjonx(paths) {
  const list = Array.isArray(paths) ? paths : [paths];
  for (const file of list) {
    const text = String(file);
    if (NESTED_DJODJONX.test(text)) throw new Error(`nested @djodjonx package: ${text}`);
  }
}
