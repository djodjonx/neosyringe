#!/usr/bin/env node
// scripts/ci/consumer-types.mjs
// Typechecks one consumer fixture.
// Without --expect-file, tsc must succeed.
// With --expect-file, tsc must fail and its output must contain each
// non-empty line of that file. A missing line is a failure, not a pass.
// With --pack [<tarball|dir>] the fixture reads the package from the extracted package instead of from the
// `paths` mapping of its tsconfig. `--pack` alone runs `pnpm pack` on the package, proves the tarball carries the
// build on disk, and extracts it; a value is a tarball or an extracted folder. It does not build.
// The package is `@djodjonx/neosyringe` (packages/neosyringe) unless `--package ui` names the light UI entry
// `@djodjonx/neosyringe-ui/serialize` (packages/ui).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PackError, resolveTypesEntry } from './lib/pack-archive.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// The package a fixture imports: its folder, the specifier of the fixture, the export it reads and its source entry.
const PACKAGES = {
  neosyringe: { dir: 'packages/neosyringe', specifier: '@djodjonx/neosyringe', subpath: '.', source: 'src/index.ts' },
  ui: { dir: 'packages/ui', specifier: '@djodjonx/neosyringe-ui/serialize', subpath: './serialize', source: 'src/serialize.ts' },
};
const packageFlag = process.argv.indexOf('--package');
const packageName = packageFlag >= 0 ? process.argv[packageFlag + 1] : 'neosyringe';
const target = Object.hasOwn(PACKAGES, packageName ?? '') ? PACKAGES[packageName] : undefined;
if (target === undefined) {
  console.error(`unknown --package ${packageName ?? ''}: expected ${Object.keys(PACKAGES).join(' or ')}`);
  process.exit(1);
}
const packageDir = path.join(root, target.dir);
const sourceEntry = path.join(packageDir, target.source);
const dirArg = process.argv[2];
const expectFlag = process.argv.indexOf('--expect-file');
const expectName = expectFlag >= 0 ? process.argv[expectFlag + 1] : undefined;
const packFlag = process.argv.indexOf('--pack');
const packNext = packFlag < 0 ? undefined : process.argv[packFlag + 1];
// `--pack` alone asks for a fresh tarball. A value is a tarball or an extracted package folder.
const pack = packFlag < 0 ? undefined : packNext === undefined || packNext.startsWith('--') ? '' : packNext;

let scratch;

// process.exit skips `finally`, so the temporary folder is removed here.
function leave(code) {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  process.exit(code);
}

function fail(message) {
  console.error(message);
  leave(1);
}

if (!dirArg || !existsSync(dirArg)) {
  fail(`missing consumer dir: ${dirArg ?? ''}`);
}

const dir = path.resolve(dirArg);
const tsconfig = path.join(dir, 'tsconfig.json');
if (!existsSync(tsconfig)) fail(`missing tsconfig: ${tsconfig}`);

/**
 * The tsconfig tsc reads, and what to say about it once the fixture passes. With --pack, a config that extends the
 * fixture's own and replaces its `paths` mapping with the extracted package. The fixture keeps its `files`, `strict`
 * and every other option.
 */
function project() {
  if (pack === undefined) return { config: tsconfig, label: undefined };
  scratch = mkdtempSync(path.join(tmpdir(), 'neosyringe-consumer-'));
  let resolved;
  try {
    resolved = resolveTypesEntry({ pack, packageDir, scratch, sourceEntry, subpath: target.subpath });
  } catch (error) {
    if (error instanceof PackError) fail(error.message);
    fail(error instanceof Error ? error.message : String(error));
  }
  const { entry, label } = resolved;
  if (!existsSync(entry)) fail(`missing types entry: ${entry}`);
  const config = path.join(scratch, 'tsconfig.json');
  writeFileSync(config, JSON.stringify({
    extends: tsconfig,
    compilerOptions: { baseUrl: '.', paths: { [target.specifier]: [entry] } },
  }));
  const shown = entry.startsWith(scratch) ? path.relative(scratch, entry) : path.relative(root, entry);
  return { config, label: `ok from=${label} types=${shown}` };
}

const { config, label } = project();
const tsc = path.join(root, 'node_modules/typescript/bin/tsc');
const result = spawnSync(process.execPath, [tsc, '--noEmit', '-p', config], {
  cwd: root,
  encoding: 'utf8',
});
const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
const failed = result.status !== 0;

if (expectName === undefined) {
  if (failed) {
    console.error(output);
    leave(1);
  }
  if (label) console.log(label);
  leave(0);
}

const expectPath = path.isAbsolute(expectName) ? expectName : path.join(dir, expectName);
if (!existsSync(expectPath)) fail(`missing expect file: ${expectPath}`);

const expectedLines = readFileSync(expectPath, 'utf8')
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line.length > 0);
const missing = expectedLines.filter((line) => !output.includes(line));
if (!failed || missing.length > 0) {
  console.error(output);
  fail(`expected diagnostic ${JSON.stringify(missing.length > 0 ? missing : expectedLines)} was not reported`);
}
if (label) console.log(label);
leave(0);
