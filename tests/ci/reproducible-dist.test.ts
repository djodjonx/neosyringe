import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const packagesDir = path.join(root, 'packages');

const ABSOLUTE = /\/(?:Users|home|private|tmp)\//;
const DRIVE = /(?:^|[^A-Za-z])[A-Za-z]:[\\/]/;
const TIMESTAMP = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

function readPackage(file: string): { private: boolean } {
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null || !('private' in parsed)) return { private: false };
  return { private: parsed.private === true };
}

function filesUnder(dir: string): string[] {
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return [];
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) found.push(...filesUnder(full));
    else found.push(full);
  }
  return found;
}

describe('reproducible dist', () => {
  it('dist has no absolute path', () => {
    const hits: string[] = [];
    for (const name of readdirSync(packagesDir)) {
      const packageJson = path.join(packagesDir, name, 'package.json');
      if (!statSync(packageJson, { throwIfNoEntry: false })?.isFile()) continue;
      if (readPackage(packageJson).private) continue;
      for (const file of filesUnder(path.join(packagesDir, name, 'dist'))) {
        const lines = readFileSync(file, 'utf8').split('\n');
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index] ?? '';
          if (ABSOLUTE.test(line) || DRIVE.test(line) || TIMESTAMP.test(line)) {
            hits.push(`${path.relative(root, file)}:${index + 1}:${line.trim()}`);
          }
        }
      }
    }
    expect(hits).toEqual([]);
  });

  it('plugin dist does not inline core source', () => {
    const hits: string[] = [];
    for (const file of filesUnder(path.join(packagesDir, 'unplugin', 'dist'))) {
      const text = readFileSync(file, 'utf8');
      if (text.includes('../core/src')) hits.push(path.relative(root, file));
    }
    expect(hits).toEqual([]);
  });
});
