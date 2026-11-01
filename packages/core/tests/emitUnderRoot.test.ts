import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveProjectConfig } from '../src/resolveProjectConfig';
import { emitUnderRoot } from './emitUnderRoot';
import { createFastProgram, warmLibCache } from './fastProgram';

const here = path.dirname(fileURLToPath(import.meta.url));
const neosyringeSrc = path.resolve(here, '../../neosyringe/src');
const neosyringeEntry = path.join(neosyringeSrc, 'index.ts');
const originalNames = new Set(readdirSync(neosyringeSrc));
const scratch: string[] = [];

function writeProducer(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'neosyringe-emit-hygiene-'));
  scratch.push(root);
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    name: '@acme/hygiene',
    version: '1.0.0',
  }));
  writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'bundler',
      strict: true,
      rootDir: 'src',
      outDir: 'dist',
      declaration: true,
      skipLibCheck: true,
      lib: ['ES5'],
      types: [],
      paths: { '@djodjonx/neosyringe': [neosyringeEntry] },
    },
    include: ['src'],
  }));
  const src = path.join(root, 'src');
  mkdirSync(src, { recursive: true });
  writeFileSync(path.join(src, 'user.ts'), 'export interface User { id: string }\n');
  writeFileSync(path.join(src, 'token.ts'), `
    import { useInterface } from '@djodjonx/neosyringe';
    import type { User } from './user';
    export const UserToken = useInterface<User>();
  `);
  return root;
}

describe('producer emit stays inside the temp project', () => {
  beforeAll(() => {
    warmLibCache();
  });

  afterAll(() => {
    for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
    for (const name of readdirSync(neosyringeSrc)) {
      if (originalNames.has(name)) continue;
      rmSync(path.join(neosyringeSrc, name), { force: true });
    }
  });

  it('no file appeared under packages/neosyringe/src', () => {
    const before = readdirSync(neosyringeSrc).sort();
    const root = writeProducer();
    const resolved = resolveProjectConfig(root);
    const program = createFastProgram(resolved.fileNames, resolved.options);
    emitUnderRoot(program, root);
    const after = readdirSync(neosyringeSrc).sort();
    expect(after, 'no file appeared').toEqual(before);
    expect(existsSync(path.join(root, 'dist/token.d.ts'))).toBe(true);
    expect(existsSync(path.join(root, 'dist/user.d.ts'))).toBe(true);
  });
});
