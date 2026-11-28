import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import * as ts from 'typescript';
import { assertNoUnsafeTypes } from '../../scripts/ci/lib/no-unsafe-types.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const cli = path.join(root, 'scripts/ci/no-unsafe-types.mjs');
const scratch: string[] = [];

const STAGE_A = [
  'packages/core/tests/helpers/t00-contract.ts',
  'packages/core/tests/generator/t00-contract-matrix.test.ts',
  'scripts/ci/lib/evidence.mjs',
  'scripts/ci/lib/evidence.d.mts',
  'scripts/ci/lib/no-unsafe-types.mjs',
  'scripts/ci/lib/no-unsafe-types.d.mts',
  'scripts/ci/no-unsafe-types.mjs',
  'tests/ci/evidence.test.ts',
  'tests/ci/no-unsafe-types.test.ts',
  'tests/ci/t21-dossier.test.ts',
];

function messageOf(source: string, filename: string): string {
  try {
    assertNoUnsafeTypes(ts, source, filename);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return '';
}

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 't00-unsafe-'));
  scratch.push(dir);
  return dir;
}

function runCli(args: readonly string[]): { status: number | null; stderr: string } {
  const run = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', cwd: root });
  return { status: run.status, stderr: run.stderr };
}

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('T00 no unsafe types', () => {
  it('flags an any keyword', () => {
    const source = 'const value: any = 1;\n';
    expect(messageOf(source, 'bad.ts')).toBe(`bad.ts: unsafe type at ${source.indexOf('any')}`);
  });

  it('flags as unknown as', () => {
    const source = 'const value = 1;\nconst boxed = value as unknown as string;\n';
    const at = source.indexOf('value as unknown as string');
    expect(messageOf(source, 'bad.ts')).toBe(`bad.ts: double assertion through unknown at ${at}`);
  });

  it('flags an angle-bracket assertion through unknown', () => {
    const source = 'const value = 1;\nconst boxed = <string><unknown>value;\n';
    const at = source.indexOf('<string><unknown>value');
    expect(messageOf(source, 'bad.ts')).toBe(`bad.ts: double assertion through unknown at ${at}`);
  });

  it('flags a parenthesized assertion through unknown', () => {
    const source = 'const value = 1;\nconst boxed = (value as unknown) as string;\n';
    const at = source.indexOf('(value as unknown) as string');
    expect(messageOf(source, 'bad.ts')).toBe(`bad.ts: double assertion through unknown at ${at}`);
  });

  it('ignores a double assertion that is not through unknown', () => {
    const source = 'const value = 1;\nconst boxed = value as A as B;\n';
    expect(messageOf(source, 'clean.ts')).toBe('');
  });

  it('flags a block ts-ignore', () => {
    const source = '/* @ts-ignore */\nconst value = 1;\n';
    expect(messageOf(source, 'bad.ts')).toBe('bad.ts: type-check suppression');
  });

  it('flags ts-ignore', () => {
    const source = '// @ts-ignore\nconst value = 1;\n';
    expect(messageOf(source, 'bad.ts')).toBe('bad.ts: type-check suppression');
  });

  it('flags ts-nocheck', () => {
    const source = '// @ts-nocheck\nconst value = 1;\n';
    expect(messageOf(source, 'bad.ts')).toBe('bad.ts: type-check suppression');
  });

  it('ignores any in a comment', () => {
    const source = '// the word any is not a type\n/* any */\nconst value = 1;\n';
    expect(messageOf(source, 'clean.ts')).toBe('');
  });

  it('ignores ts-expect-error', () => {
    const source = '// @ts-expect-error\nconst value = 1;\n';
    expect(messageOf(source, 'clean.ts')).toBe('');
  });

  it('rejects invalid TypeScript', () => {
    expect(messageOf('const value = ;\n', 'broken.ts')).toBe('invalid TypeScript: broken.ts');
  });

  it('CLI exits 1 and writes the message', () => {
    const source = 'const value: any = 1;\n';
    const file = path.join(tempDir(), 'bad.ts');
    writeFileSync(file, source);
    const run = runCli([file]);
    expect(run.status).toBe(1);
    expect(run.stderr.trim()).toBe(messageOf(source, file));
  });

  it('CLI exits 0 on a clean file', () => {
    const file = path.join(tempDir(), 'clean.ts');
    writeFileSync(file, 'const value = 1;\n');
    const run = runCli([file]);
    expect(run.status).toBe(0);
    expect(run.stderr).toBe('');
  });

  it('CLI exits 0 with no arguments', () => {
    const run = runCli([]);
    expect(run.status).toBe(0);
    expect(run.stderr).toBe('');
  });

  it('CLI exits 0 on every stage A file', () => {
    const run = runCli(STAGE_A.map((file) => path.join(root, file)));
    expect(run.status).toBe(0);
    expect(run.stderr).toBe('');
  });
});
