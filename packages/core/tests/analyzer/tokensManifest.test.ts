import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readTokensManifest } from '../../src/analyzer/shared/tokensManifest';
import { declarationEmitPath, writeTokensManifest } from '../../src/generator/tokensManifest';
import { resolveProjectConfig } from '../../src/resolveProjectConfig';
import { emitUnderRoot } from '../emitUnderRoot';
import { createFastProgram, warmLibCache } from '../fastProgram';
import * as ts from 'typescript';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const neosyringeEntry = path.join(repoRoot, 'packages/neosyringe/src/index.ts');
const scratch: string[] = [];

function writeProducer(name: string): string {
  const root = mkdtempSync(path.join(tmpdir(), `neosyringe-manifest-${name}-`));
  scratch.push(root);
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    name: '@acme/unit',
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

describe('tokens manifest read and write', () => {
  beforeAll(() => {
    warmLibCache();
  });

  afterAll(() => {
    for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
  });

  it('read write round trip', () => {
    const root = writeProducer('round');
    const resolved = resolveProjectConfig(root);
    const program = createFastProgram(resolved.fileNames, resolved.options);
    emitUnderRoot(program, root);
    const manifest = writeTokensManifest({
      program,
      packageRoot: root,
      contractVersion: 'contract-a',
    });
    const text = `${JSON.stringify(manifest)}\n`;
    expect(readTokensManifest(text)).toEqual(manifest);
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.packageName).toBe('@acme/unit');
    expect(manifest.contractVersion).toBe('contract-a');
    expect(Object.keys(manifest)).toEqual(['schemaVersion', 'packageName', 'contractVersion', 'tokens']);
    const token = manifest.tokens[0];
    expect(token).toBeDefined();
    expect(Object.keys(token ?? {})).toEqual([
      'exportPath',
      'exportName',
      'runtimeKey',
      'descriptor',
      'typeExport',
    ]);
    expect(Object.keys(token?.typeExport ?? {})).toEqual(['exportPath', 'exportName']);
    expect(text).not.toContain(root);
    expect(text).not.toContain(path.basename(root));
    expect(text).not.toContain('9.9.9');
    expect(token?.exportPath).toBe('dist/token.d.ts');
    expect(token?.typeExport).toEqual({ exportPath: 'dist/user.d.ts', exportName: 'User' });
  });

  it('rejects an unknown field', () => {
    const text = JSON.stringify({
      schemaVersion: 1,
      packageName: '@acme/unit',
      contractVersion: 'contract-a',
      tokens: [],
      extra: true,
    });
    expect(() => readTokensManifest(text)).toThrow('unknown field manifest.extra');
  });

  it('rejects text that is not json', () => {
    expect(() => readTokensManifest('not-json')).toThrow('missing field manifest');
  });

  it('rejects a missing field', () => {
    const text = JSON.stringify({
      schemaVersion: 1,
      packageName: '@acme/unit',
      tokens: [],
    });
    expect(() => readTokensManifest(text)).toThrow('missing field manifest.contractVersion');
  });

  it('rejects an empty contract version', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'neosyringe-manifest-empty-'));
    scratch.push(root);
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: '@acme/unit' }));
    const program = createFastProgram([], { strict: true });
    expect(thrownMessage(() => writeTokensManifest({
      program,
      packageRoot: root,
      contractVersion: '',
    }))).toBe('NEO_TOKEN_BOUNDARY_UNSUPPORTED: contract-version');
  });

  it('rejects a missing package name', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'neosyringe-manifest-name-'));
    scratch.push(root);
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '0.0.0' }));
    const program = createFastProgram([], { strict: true });
    expect(thrownMessage(() => writeTokensManifest({
      program,
      packageRoot: root,
      contractVersion: 'contract-a',
    }))).toBe('missing package name');
  });

  it('rejects a missing rootDir', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'neosyringe-manifest-root-'));
    scratch.push(root);
    const fileName = path.join(root, 'token.ts');
    writeFileSync(fileName, 'export const token = 1;\n');
    const program = createFastProgram([fileName], { strict: true, target: ts.ScriptTarget.ES2022 });
    const source = program.getSourceFiles().find((file) => file.fileName.endsWith('token.ts'));
    expect(source).toBeDefined();
    expect(thrownMessage(() => declarationEmitPath(program, source!, root))).toBe(
      'tsconfig rootDir and outDir or declarationDir are required for exportPath',
    );
  });

  it('rejects a declaration path that escapes the package', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'neosyringe-manifest-escape-'));
    scratch.push(root);
    const src = path.join(root, 'src');
    mkdirSync(src, { recursive: true });
    const fileName = path.join(src, 'token.ts');
    writeFileSync(fileName, 'export const token = 1;\n');
    const program = createFastProgram([fileName], {
      strict: true,
      target: ts.ScriptTarget.ES2022,
      rootDir: src,
      outDir: path.resolve(root, '../out'),
    });
    const source = program.getSourceFiles().find((file) => file.fileName.endsWith('token.ts'));
    expect(source).toBeDefined();
    expect(thrownMessage(() => declarationEmitPath(program, source!, root))).toBe(
      'declaration path escapes the package: ../out/token.d.ts',
    );
  });

  it('sorts tokens by export name and omits an unexported type', () => {
    const root = writeProducer('sorted');
    writeFileSync(path.join(root, 'src/token.ts'), `
      import { useInterface } from '@djodjonx/neosyringe';
      import type { User } from './user';
      interface Hidden { id: string }
      export const ZToken = useInterface<User>();
      export const AToken = useInterface<Hidden>();
    `);
    const resolved = resolveProjectConfig(root);
    const program = createFastProgram(resolved.fileNames, resolved.options);
    emitUnderRoot(program, root);
    const manifest = writeTokensManifest({
      program,
      packageRoot: root,
      contractVersion: 'contract-a',
    });
    expect(manifest.tokens.map((token) => token.exportName)).toEqual(['AToken', 'ZToken']);
    expect(manifest.tokens[0]?.typeExport).toBeUndefined();
    expect(manifest.tokens[1]?.typeExport).toEqual({ exportPath: 'dist/user.d.ts', exportName: 'User' });
  });

  it('refuses a manifest when the declaration file is missing', () => {
    const root = writeProducer('missing-dts');
    const resolved = resolveProjectConfig(root);
    const program = createFastProgram(resolved.fileNames, resolved.options);
    expect(thrownMessage(() => writeTokensManifest({
      program,
      packageRoot: root,
      contractVersion: 'contract-a',
    }))).toContain('run the manifest step after declaration emit; bundled declarations are not supported: per-file declaration emit required');
  });

  it('lists a token re-exported with export { X }', () => {
    const root = writeProducer('export-clause');
    writeFileSync(path.join(root, 'src/token.ts'), `
      import { useInterface } from '@djodjonx/neosyringe';
      import type { User } from './user';
      const UserToken = useInterface<User>();
      export { UserToken };
    `);
    const resolved = resolveProjectConfig(root);
    const program = createFastProgram(resolved.fileNames, resolved.options);
    emitUnderRoot(program, root);
    const manifest = writeTokensManifest({
      program,
      packageRoot: root,
      contractVersion: 'contract-a',
    });
    expect(manifest.tokens.map((token) => token.exportName)).toEqual(['UserToken']);
    expect(manifest.tokens[0]?.typeExport).toEqual({ exportPath: 'dist/user.d.ts', exportName: 'User' });
  });

  it('lists a token re-exported with export { X as Y }', () => {
    const root = writeProducer('export-rename');
    writeFileSync(path.join(root, 'src/token.ts'), `
      import { useInterface } from '@djodjonx/neosyringe';
      import type { User } from './user';
      const UserToken = useInterface<User>();
      export { UserToken as Token };
    `);
    const resolved = resolveProjectConfig(root);
    const program = createFastProgram(resolved.fileNames, resolved.options);
    emitUnderRoot(program, root);
    const manifest = writeTokensManifest({
      program,
      packageRoot: root,
      contractVersion: 'contract-a',
    });
    expect(manifest.tokens.map((token) => token.exportName)).toEqual(['Token']);
  });

  it('refuses export default useInterface', () => {
    const root = writeProducer('export-default');
    writeFileSync(path.join(root, 'src/token.ts'), `
      import { useInterface } from '@djodjonx/neosyringe';
      import type { User } from './user';
      export default useInterface<User>();
    `);
    const resolved = resolveProjectConfig(root);
    const program = createFastProgram(resolved.fileNames, resolved.options);
    expect(thrownMessage(() => writeTokensManifest({
      program,
      packageRoot: root,
      contractVersion: 'contract-a',
    }))).toBe('export default tokens are not supported');
  });

  it('refuses a token held inside an exported object', () => {
    const root = writeProducer('export-object');
    writeFileSync(path.join(root, 'src/token.ts'), `
      import { useInterface } from '@djodjonx/neosyringe';
      import type { User } from './user';
      export const bag = { token: useInterface<User>() };
    `);
    const resolved = resolveProjectConfig(root);
    const program = createFastProgram(resolved.fileNames, resolved.options);
    expect(thrownMessage(() => writeTokensManifest({
      program,
      packageRoot: root,
      contractVersion: 'contract-a',
    }))).toBe('tokens held inside an exported object are not supported: bag');
  });
});

function thrownMessage(run: () => void): string {
  try {
    run();
  } catch (error) {
    if (error instanceof Error) return error.message;
    throw error;
  }
  throw new Error('expected an error');
}
