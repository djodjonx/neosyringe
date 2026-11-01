import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
    const output = `${result.stdout}\n${result.stderr}`;
    expect(result.status).toBe(0);
    expect(output).not.toContain('check-dist warning');
    expect(existsSync(path.join(root, 'scripts/ci/check-dist-allowlist.json'))).toBe(false);
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
