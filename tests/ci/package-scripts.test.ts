import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function quotedScripts(file: string): string[] {
  const parsed: unknown = JSON.parse(readFileSync(path.join(root, file), 'utf8'));
  if (typeof parsed !== 'object' || parsed === null || !('scripts' in parsed)) return [];
  const scripts = parsed.scripts;
  if (typeof scripts !== 'object' || scripts === null) return [];
  const hits: string[] = [];
  for (const [name, value] of Object.entries(scripts)) {
    if (typeof value === 'string' && value.includes("'")) hits.push(`${file} scripts.${name}`);
  }
  return hits;
}

describe('package scripts', () => {
  it('no package script uses single quotes (cmd.exe does not strip them)', () => {
    const packages = readdirSync(path.join(root, 'packages'), { withFileTypes: true });
    const files = [
      'package.json',
      ...packages.filter((entry) => entry.isDirectory()).map((entry) => `packages/${entry.name}/package.json`),
    ];
    const hits = files.flatMap(quotedScripts);
    expect(hits, hits.join(', ')).toEqual([]);
  });
});
