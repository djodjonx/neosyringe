#!/usr/bin/env node
// scripts/ci/consumer-types.mjs
// Typechecks one consumer fixture.
// Without --expect-file, tsc must succeed.
// With --expect-file, tsc must fail and its output must contain that text.
// A missing diagnostic is a failure, not a pass.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dirArg = process.argv[2];
const expectFlag = process.argv.indexOf('--expect-file');
const expectName = expectFlag >= 0 ? process.argv[expectFlag + 1] : undefined;

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (!dirArg || !existsSync(dirArg)) {
  fail(`missing consumer dir: ${dirArg ?? ''}`);
}

const dir = path.resolve(dirArg);
const tsconfig = path.join(dir, 'tsconfig.json');
if (!existsSync(tsconfig)) fail(`missing tsconfig: ${tsconfig}`);

const tsc = path.join(root, 'node_modules/typescript/bin/tsc');
const result = spawnSync(process.execPath, [tsc, '--noEmit', '-p', tsconfig], {
  cwd: root,
  encoding: 'utf8',
});
const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
const failed = result.status !== 0;

if (expectName === undefined) {
  if (failed) {
    console.error(output);
    process.exit(1);
  }
  process.exit(0);
}

const expectPath = path.isAbsolute(expectName) ? expectName : path.join(dir, expectName);
if (!existsSync(expectPath)) fail(`missing expect file: ${expectPath}`);

const expected = readFileSync(expectPath, 'utf8').trim();
if (!failed || !output.includes(expected)) {
  console.error(output);
  fail(`expected diagnostic ${JSON.stringify(expected)} was not reported`);
}
process.exit(0);
