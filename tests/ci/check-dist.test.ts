import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const script = path.join(root, 'scripts/ci/check-dist.mjs');

function run(target: string) {
  return spawnSync(process.execPath, [script, target], { cwd: root, encoding: 'utf8' });
}

describe('check-dist', () => {
  it('passes on the built repo', () => {
    const result = run(root);
    expect(result.status).toBe(0);
  });

  it('fails when a declared bin entry is absent', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'neosyringe-dist-miss-'));
    try {
      writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
        name: 'bin-only',
        bin: { tool: 'dist/index.mjs' },
      }));
      expect(run(dir).status).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails when an unlisted package omits a root index', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'neosyringe-dist-unlisted-'));
    try {
      writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
        name: 'unlisted-root',
        main: 'dist/index.cjs',
      }));
      const result = run(dir);
      const output = `${result.stdout}\n${result.stderr}`;
      expect(result.status).toBe(1);
      expect(output).toContain(`missing dist entry: ${path.join(dir, 'dist/index.cjs')}`);
      expect(output).not.toContain('TypeError');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails when an allowlisted package declares a path that is not allowlisted', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'neosyringe-dist-allow-extra-'));
    try {
      writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
        name: '@djodjonx/neosyringe-core',
        main: 'dist/index.cjs',
        types: 'dist/other.d.mts',
      }));
      const result = run(dir);
      const output = `${result.stdout}\n${result.stderr}`;
      expect(result.status).toBe(1);
      expect(output).toContain(
        'check-dist warning: skip @djodjonx/neosyringe-core dist/index.cjs followUp=T15',
      );
      expect(output).toContain(`missing dist entry: ${path.join(dir, 'dist/other.d.mts')}`);
      expect(output).not.toContain('TypeError');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('warns when skipping the named core root index', () => {
    const result = run(root);
    const output = `${result.stdout}\n${result.stderr}`;
    const skipped = [
      'dist/index.cjs',
      'dist/index.mjs',
      'dist/index.d.mts',
      './dist/index.d.mts',
      './dist/index.mjs',
      './dist/index.cjs',
    ];
    expect(result.status).toBe(0);
    for (const rel of skipped) {
      expect(output).toContain(
        `check-dist warning: skip @djodjonx/neosyringe-core ${rel} followUp=T15`,
      );
    }
  });

  it('skips a private package whose entry is absent', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'neosyringe-dist-private-'));
    try {
      writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
        name: 'private-extension',
        private: true,
        main: 'dist/extension.js',
      }));
      expect(run(dir).status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
