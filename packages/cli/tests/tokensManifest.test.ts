import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import * as ts from 'typescript';
import { readTokensManifest } from '../../core/src/analyzer/shared/tokensManifest';
import { resolveProjectConfig } from '../../core/src/resolveProjectConfig';
import { emitUnderRoot } from '../../core/tests/emitUnderRoot';
import { parseArgs } from '../src/report';
import { cliEntryMatches } from '../src/index';
import { emitTokensManifest } from '../src/tokensManifest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const neosyringeEntry = path.join(repoRoot, 'packages/neosyringe/src/index.ts');
const scratch: string[] = [];

function producer(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'neosyringe-cli-manifest-'));
  scratch.push(root);
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    name: '@acme/cli',
    version: '9.9.9',
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
      paths: { '@djodjonx/neosyringe': [neosyringeEntry] },
    },
    include: ['src'],
  }));
  mkdirSync(path.join(root, 'src'), { recursive: true });
  writeFileSync(path.join(root, 'src/user.ts'), 'export interface User { id: string }\n');
  writeFileSync(path.join(root, 'src/token.ts'), `
    import { useInterface } from '@djodjonx/neosyringe';
    import type { User } from './user';
    export const UserToken = useInterface<User>();
  `);
  return root;
}

describe('CLI tokens manifest', () => {
  afterEach(() => {
    for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('parses --tokens-manifest and --contract-version', () => {
    expect(parseArgs(['--tokens-manifest', 'dist/tokens-manifest.json', '--contract-version', 'tokens-v1'])).toMatchObject({
      tokensManifest: 'dist/tokens-manifest.json',
      contractVersion: 'tokens-v1',
    });
  });

  it('refuses --tokens-manifest without --contract-version', () => {
    const root = producer();
    expect(() => emitTokensManifest({
      tokensManifest: path.join(root, 'dist/tokens-manifest.json'),
      cwd: root,
    })).toThrow('NEO_TOKEN_BOUNDARY_UNSUPPORTED: contract-version');
  });

  it('writes the manifest from the flag inputs', () => {
    const root = producer();
    const out = path.join(root, 'dist/tokens-manifest.json');
    const resolved = resolveProjectConfig(root);
    emitUnderRoot(ts.createProgram(resolved.fileNames, resolved.options), root);
    emitTokensManifest({
      tokensManifest: out,
      contractVersion: 'tokens-v1',
      cwd: root,
    });
    const manifest = readTokensManifest(readFileSync(out, 'utf8'));
    expect(manifest.contractVersion).toBe('tokens-v1');
    expect(manifest.packageName).toBe('@acme/cli');
    expect(manifest.tokens[0]?.exportName).toBe('UserToken');
    expect(manifest.tokens[0]?.runtimeKey).toMatch(/^User_[0-9a-f]{8}$/);
    expect(JSON.stringify(manifest)).not.toContain('9.9.9');
  });

  it('rejects a flag value that starts with --', () => {
    expect(parseArgs(['--tokens-manifest', '--contract-version', 'v1'])).toMatchObject({
      tokensManifest: '',
      contractVersion: 'v1',
    });
  });

  it('reports a usage error when only --contract-version is set', () => {
    const root = producer();
    expect(() => emitTokensManifest({
      tokensManifest: undefined,
      contractVersion: 'v1',
      cwd: root,
    })).toThrow('--tokens-manifest <file> is required');
  });

  it('importing the cli module does not run main', async () => {
    await import('../src/index');
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('compares the raw paths when realpath throws', () => {
    const missing = path.join(tmpdir(), `neosyringe-cli-missing-${process.pid}`);
    expect(cliEntryMatches(missing, missing)).toBe(true);
    expect(cliEntryMatches(missing, `${missing}-other`)).toBe(false);
  });
});
