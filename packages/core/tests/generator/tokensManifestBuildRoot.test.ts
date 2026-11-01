import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type * as ts from 'typescript';
import { Analyzer } from '../../src/analyzer/Analyzer';
import { readTokensManifest } from '../../src/analyzer/shared/tokensManifest';
import { Generator } from '../../src/generator/Generator';
import { resolveProjectConfig } from '../../src/resolveProjectConfig';
import { TSContext } from '../../src/TSContext';
import { emitUnderRoot } from '../emitUnderRoot';
import { createFastProgram, warmLibCache } from '../fastProgram';
import { emitTokensManifest } from '../../../cli/src/tokensManifest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const neosyringeEntry = path.join(repoRoot, 'packages/neosyringe/src/index.ts');
const scratch: string[] = [];

function keep(dir: string): string {
  scratch.push(dir);
  return dir;
}

function writeSources(root: string, tsconfigDir: string, tsconfig: Record<string, unknown>): void {
  mkdirSync(path.join(root, 'src'), { recursive: true });
  mkdirSync(tsconfigDir, { recursive: true });
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    name: '@acme/build',
    version: '1.0.0',
    peerDependencies: { '@djodjonx/neosyringe': '*' },
  }));
  writeFileSync(path.join(tsconfigDir, 'tsconfig.json'), JSON.stringify(tsconfig));
  writeFileSync(path.join(root, 'src/user.ts'), 'export interface User { id: string }\n');
  writeFileSync(path.join(root, 'src/container.ts'), `
    import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';
    import type { User } from './user';
    export const UserToken = useInterface<User>();
    export const container = defineBuilderConfig({
      injections: [{ token: UserToken, useValue: { id: 'a' } }],
    });
  `);
}

function compilerOptions(rootDir: string, outDir: string): Record<string, unknown> {
  return {
    target: 'ES2022',
    module: 'ESNext',
    moduleResolution: 'bundler',
    strict: true,
    declaration: true,
    emitDeclarationOnly: true,
    rootDir,
    outDir,
    skipLibCheck: true,
    lib: ['ES5'],
    types: [],
    paths: { '@djodjonx/neosyringe': [neosyringeEntry] },
  };
}

interface CompiledLayout {
  configRoot: string;
  program: ts.Program;
  key: string;
}

/** One program per layout. The manifest is written from that program. */
function compileLayout(root: string, project: string | undefined): CompiledLayout {
  const resolved = resolveProjectConfig(root, project);
  const program = createFastProgram(resolved.fileNames, resolved.options);
  const emitted = emitUnderRoot(program, root);
  if (emitted.emitSkipped) throw new Error('declaration emit skipped');
  const manifestPath = emitTokensManifest({
    tokensManifest: path.join(root, 'dist/tokens-manifest.json'),
    contractVersion: 'tokens-v1',
    project,
    cwd: root,
    program,
  });
  const manifest = readTokensManifest(readFileSync(manifestPath, 'utf8'));
  const key = manifest.tokens.find((token) => token.exportName === 'UserToken')?.runtimeKey;
  if (!key) throw new Error('missing UserToken');
  return { configRoot: resolved.root, program, key };
}

/** Generator output for one tsconfig layout, compared with the manifest key. */
function manifestKeyInGeneratedCode(layout: CompiledLayout): string {
  const code = TSContext.runWithProjectRoot(layout.configRoot, () => {
    const graphs = new Analyzer(layout.program).extractAll();
    const graph = graphs.find((item) => item.nodes.has(layout.key));
    if (!graph) return graphs.map((item) => [...item.nodes.keys()].join(',')).join('|');
    return new Generator(graph, true).generate();
  });
  return code.includes(`"${layout.key}"`) ? layout.key : `${layout.key} missing from ${code}`;
}

describe('manifest runtime key matches the producer build', () => {
  let beside: CompiledLayout;
  let nested: CompiledLayout;

  beforeAll(() => {
    warmLibCache();
    const root = keep(mkdtempSync(path.join(tmpdir(), 'neosyringe-build-root-')));
    writeSources(root, root, {
      compilerOptions: compilerOptions('src', 'dist'),
      include: ['src'],
    });
    beside = compileLayout(root, undefined);
    const nestedRoot = keep(mkdtempSync(path.join(tmpdir(), 'neosyringe-build-nested-')));
    const tools = path.join(nestedRoot, 'tools');
    writeSources(nestedRoot, tools, {
      compilerOptions: compilerOptions('../src', '../dist'),
      include: ['../src'],
    });
    nested = compileLayout(nestedRoot, 'tools/tsconfig.json');
  });

  afterAll(() => {
    for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
  });

  it('matches when tsconfig sits beside package.json', () => {
    expect(manifestKeyInGeneratedCode(beside)).toMatch(/^User_[0-9a-f]{8}$/);
  });

  it('matches when tsconfig lives in a subfolder', () => {
    expect(manifestKeyInGeneratedCode(nested)).toMatch(/^User_[0-9a-f]{8}$/);
  });
});
