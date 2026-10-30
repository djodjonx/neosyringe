import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const script = path.join(root, 'scripts/ci/consumer-types.mjs');

const TSCONFIG = `{
  "compilerOptions": {
    "strict": true,
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "noEmit": true,
    "skipLibCheck": true
  },
  "files": ["consumer.ts"]
}
`;

function writeProject(dir: string, source: string, expectFile?: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'tsconfig.json'), TSCONFIG);
  writeFileSync(path.join(dir, 'consumer.ts'), source);
  if (expectFile !== undefined) writeFileSync(path.join(dir, 'expected-diagnostic.txt'), expectFile);
}

function run(args: string[]) {
  return spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8' });
}

describe('consumer-types harness', () => {
  it('positive passes', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'neosyringe-consumer-ok-'));
    try {
      writeProject(dir, 'const value: number = 1;\nexport const checked = value;\n');
      expect(run([dir]).status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('negative with the expected code passes', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'neosyringe-consumer-neg-'));
    try {
      writeProject(dir, 'const value: number = "no";\nexport const checked = value;\n', 'TS2322');
      expect(run([dir, '--expect-file', 'expected-diagnostic.txt']).status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('absent diagnostic fails', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'neosyringe-consumer-miss-'));
    try {
      writeProject(dir, 'const value: number = "no";\nexport const checked = value;\n', 'TS9999');
      expect(run([dir, '--expect-file', 'expected-diagnostic.txt']).status).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('missing dir fails', () => {
    const missing = path.join(tmpdir(), 'neosyringe-consumer-missing-does-not-exist');
    expect(run([missing]).status).toBe(1);
  });
});
