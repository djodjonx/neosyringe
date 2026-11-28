import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The light entry `@djodjonx/neosyringe-ui/serialize` is built next to the root entry. It carries the two
 * serializers and nothing that renders: no HTML, no Mermaid, no panel script. Needs `pnpm build`.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const uiDir = path.join(root, 'packages/ui');
const SERIALIZERS = ['serializeGraph', 'serializeGraphWithErrors'];
const RENDERERS = ['buildStandaloneHtml', 'buildProjectHtml', 'buildWebviewScript', 'graphToMermaid'];

function declaredExports(): Record<string, unknown> {
  const pkg: { exports?: Record<string, unknown> } = JSON.parse(readFileSync(path.join(uiDir, 'package.json'), 'utf8'));
  return pkg.exports ?? {};
}

/** The file a relative specifier names. A declaration file names its sibling `.d.mts` or `.d.cts` with the `.mjs` or `.cjs` it will have. */
function resolveSibling(from: string, specifier: string): string {
  const resolved = path.resolve(path.dirname(from), specifier);
  const candidates = [resolved, resolved.replace(/\.mjs$/, '.d.mts'), resolved.replace(/\.cjs$/, '.d.cts')];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (found === undefined) throw new Error(`${from} reaches ${specifier}, which is not on disk`);
  return found;
}

/** The text of `file` and of every file it reaches through a relative import or require, in either module system. */
function reachableText(file: string): { files: string[]; text: string; bare: string[] } {
  const files: string[] = [];
  const bare = new Set<string>();
  const pending = [file];
  let text = '';
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || files.includes(current)) continue;
    files.push(current);
    const source = readFileSync(current, 'utf8');
    text += `${source}\n`;
    const specifiers = [
      ...[...source.matchAll(/\bfrom\s*["']([^"']+)["']/g)].map((hit) => hit[1]),
      ...[...source.matchAll(/\b(?:require|import)\(\s*["']([^"']+)["']\s*\)/g)].map((hit) => hit[1]),
    ];
    for (const specifier of specifiers) {
      if (specifier === undefined) continue;
      if (specifier.startsWith('.')) pending.push(resolveSibling(current, specifier));
      else bare.add(specifier);
    }
  }
  return { files, text, bare: [...bare].sort() };
}

describe('G15 serialize entry', () => {
  it('serialize subpath ESM and CJS expose exactly the two functions', async () => {
    const esm = path.join(uiDir, 'dist/serialize.mjs');
    const cjs = path.join(uiDir, 'dist/serialize.cjs');
    expect(existsSync(esm), esm).toBe(true);
    expect(existsSync(cjs), cjs).toBe(true);
    const fromEsm: Record<string, unknown> = await import(pathToFileURL(esm).href);
    const fromCjs: Record<string, unknown> = createRequire(import.meta.url)(cjs);
    expect(Object.keys(fromEsm).sort()).toEqual(SERIALIZERS);
    expect(Object.keys(fromCjs).sort()).toEqual(SERIALIZERS);
    for (const name of SERIALIZERS) {
      expect(typeof fromEsm[name], `esm ${name}`).toBe('function');
      expect(typeof fromCjs[name], `cjs ${name}`).toBe('function');
    }
  });

  it('package.json declares the serialize subpath with types, import and require', () => {
    expect(declaredExports()['./serialize']).toEqual({
      types: './dist/serialize.d.mts',
      import: './dist/serialize.mjs',
      require: './dist/serialize.cjs',
    });
  });

  it('serialize entry reaches no html, mermaid or panel code in any format', () => {
    const entries = ['dist/serialize.mjs', 'dist/serialize.cjs', 'dist/serialize.d.mts', 'dist/serialize.d.cts'];
    for (const entry of entries) {
      const file = path.join(uiDir, entry);
      expect(existsSync(file), file).toBe(true);
      const reached = reachableText(file);
      const present = RENDERERS.filter((name) => reached.text.includes(name));
      expect(present, `${entry} reaches ${reached.files.map((item) => path.basename(item)).join(', ')}`).toEqual([]);
      // The only package it may import is the analyzer. The root entry of the UI would bring the renderers back.
      expect(reached.bare, entry).toEqual(['@djodjonx/neosyringe-core/analyzer']);
    }
  });
});
