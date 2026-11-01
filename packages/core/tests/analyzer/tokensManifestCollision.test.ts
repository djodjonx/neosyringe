import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as ts from 'typescript';
import { NeoTokenError } from '../../src/analyzer/errors/NeoTokenError';
import { TokenResolverService } from '../../src/analyzer/shared/TokenResolverService';
import type { TokensManifest } from '../../src/analyzer/shared/tokensManifest';
import { readTokensManifest } from '../../src/analyzer/shared/tokensManifest';
import { emitTokensManifest } from '../../../cli/src/tokensManifest';
import { TSContext } from '../../src/TSContext';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const neosyringeEntry = path.join(repoRoot, 'packages/neosyringe/dist/index.d.mts');
const tsc = path.join(repoRoot, 'node_modules/typescript/bin/tsc');
const scratch: string[] = [];

let template = '';
let userKey = '';

function keep(dir: string): string {
  scratch.push(dir);
  return dir;
}

function variableType(program: ts.Program, fileName: string, name: string): ts.Type {
  const source = program.getSourceFile(fileName);
  if (!source) throw new Error(`missing ${fileName}`);
  const checker = program.getTypeChecker();
  let found: ts.Type | undefined;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.type) {
      found = checker.getTypeFromTypeNode(node.type);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!found) throw new Error(`missing type ${name}`);
  return found;
}

function programOf(files: Record<string, string>): { program: ts.Program; file: string } {
  const file = Object.keys(files)[0];
  if (!file) throw new Error('missing file');
  const host = ts.createCompilerHost({ strict: true, target: ts.ScriptTarget.ES2022 });
  const original = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersion, onError, create) => {
    const text = files[fileName];
    if (text !== undefined) return ts.createSourceFile(fileName, text, languageVersion, true);
    return original(fileName, languageVersion, onError, create);
  };
  const program = ts.createProgram(Object.keys(files), {
    strict: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
  }, host);
  return { program, file };
}

function install(root: string, folder: string, packageName: string): { pkg: string; manifest: TokensManifest } {
  const pkg = path.join(root, 'node_modules', folder);
  cpSync(template, pkg, { recursive: true });
  const manifest = readTokensManifest(readFileSync(path.join(pkg, 'dist/tokens-manifest.json'), 'utf8'));
  manifest.packageName = packageName;
  writeFileSync(path.join(pkg, 'dist/tokens-manifest.json'), JSON.stringify(manifest));
  const packageJson = JSON.parse(readFileSync(path.join(pkg, 'package.json'), 'utf8')) as { name: string };
  packageJson.name = packageName;
  writeFileSync(path.join(pkg, 'package.json'), JSON.stringify(packageJson));
  return { pkg, manifest };
}

function caught(run: () => void): NeoTokenError | undefined {
  try {
    run();
  } catch (error) {
    if (error instanceof NeoTokenError) return error;
    throw error;
  }
  return undefined;
}

describe('published runtime key owners', () => {
  beforeAll(() => {
    template = keep(mkdtempSync(path.join(tmpdir(), 'neosyringe-collision-template-')));
    mkdirSync(path.join(template, 'src'), { recursive: true });
    writeFileSync(path.join(template, 'package.json'), JSON.stringify({
      name: '@acme/a',
      version: '1.0.0',
      peerDependencies: { '@djodjonx/neosyringe': '*' },
      neosyringe: { tokensManifest: './dist/tokens-manifest.json' },
    }));
    writeFileSync(path.join(template, 'tsconfig.json'), JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'bundler',
        strict: true,
        declaration: true,
        emitDeclarationOnly: true,
        rootDir: 'src',
        outDir: 'dist',
        skipLibCheck: true,
        paths: { '@djodjonx/neosyringe': [neosyringeEntry] },
      },
      include: ['src'],
    }));
    writeFileSync(path.join(template, 'src/types.ts'), 'export interface User { id: string }\n');
    writeFileSync(path.join(template, 'src/tokens.ts'), `
      import { useInterface } from '@djodjonx/neosyringe';
      import type { User } from './types';
      export const UserToken = useInterface<User>();
    `);
    const compiled = spawnSync(process.execPath, [tsc, '-p', path.join(template, 'tsconfig.json')], {
      cwd: template,
      encoding: 'utf8',
    });
    if (compiled.status !== 0) throw new Error(`tsc failed\n${compiled.stdout}\n${compiled.stderr}`);
    emitTokensManifest({
      tokensManifest: path.join(template, 'dist/tokens-manifest.json'),
      contractVersion: 'tokens-v1',
      cwd: template,
    });
    const manifest = readTokensManifest(readFileSync(path.join(template, 'dist/tokens-manifest.json'), 'utf8'));
    const user = manifest.tokens.find((token) => token.typeExport?.exportName === 'User');
    if (!user) throw new Error('missing User token');
    userKey = user.runtimeKey;
  });

  afterAll(() => {
    for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
  });

  it('refuses the same key claimed by two packages built from one fixture', () => {
    const root = keep(mkdtempSync(path.join(tmpdir(), 'neosyringe-collision-two-')));
    const left = install(root, '@acme/a', '@acme/a');
    const right = install(root, '@zeta/b', '@zeta/b');
    const file = path.join(root, 'consumer.ts');
    const { program } = programOf({
      [file]: `
        import type { User as UserA } from '${path.join(left.pkg, 'dist/types.d.ts').split(path.sep).join('/')}';
        import type { User as UserB } from '${path.join(right.pkg, 'dist/types.d.ts').split(path.sep).join('/')}';
        export const leftProbe: UserA = null!;
        export const rightProbe: UserB = null!;
      `,
    });
    const service = new TokenResolverService(program.getTypeChecker());
    expect(service.getTypeId(variableType(program, file, 'leftProbe'))).toBe(userKey);
    const error = caught(() => service.getTypeId(variableType(program, file, 'rightProbe')));
    expect(error?.code).toBe('NEO_TOKEN_COLLISION');
    expect(error?.message).toBe('NEO_TOKEN_COLLISION: @acme/a <> @zeta/b');
  });

  it('refuses the same key claimed by a package and a local declaration', () => {
    const root = keep(mkdtempSync(path.join(tmpdir(), 'neosyringe-collision-local-')));
    const installed = install(root, '@acme/a', '@acme/a');
    mkdirSync(path.join(root, 'src'), { recursive: true });
    const localFile = path.join(root, 'src/types.ts');
    const consumerFile = path.join(root, 'src/consumer.ts');
    writeFileSync(localFile, 'export interface User { id: string }\n');
    writeFileSync(consumerFile, `
      import type { User as Foreign } from '${path.join(installed.pkg, 'dist/types.d.ts').split(path.sep).join('/')}';
      import type { User } from './types';
      export const localProbe: User = null!;
      export const foreignProbe: Foreign = null!;
    `);
    const { program } = programOf({
      [localFile]: readFileSync(localFile, 'utf8'),
      [consumerFile]: readFileSync(consumerFile, 'utf8'),
    });
    const error = TSContext.runWithProjectRoot(root, () => {
      const service = new TokenResolverService(program.getTypeChecker());
      expect(service.getTypeId(variableType(program, consumerFile, 'localProbe'))).toBe(userKey);
      return caught(() => service.getTypeId(variableType(program, consumerFile, 'foreignProbe')));
    });
    expect(error?.code).toBe('NEO_TOKEN_COLLISION');
    expect(error?.message).toBe('NEO_TOKEN_COLLISION: local <> @acme/a');
  });

  it('shares one key for two copies of the same package and contract', () => {
    const root = keep(mkdtempSync(path.join(tmpdir(), 'neosyringe-collision-same-')));
    const left = install(root, '.pnpm/left/node_modules/@acme/a', '@acme/a');
    const right = install(root, '.pnpm/right/node_modules/@acme/a', '@acme/a');
    const file = path.join(root, 'consumer.ts');
    const { program } = programOf({
      [file]: `
        import type { User as UserA } from '${path.join(left.pkg, 'dist/types.d.ts').split(path.sep).join('/')}';
        import type { User as UserB } from '${path.join(right.pkg, 'dist/types.d.ts').split(path.sep).join('/')}';
        export const leftProbe: UserA = null!;
        export const rightProbe: UserB = null!;
      `,
    });
    const service = new TokenResolverService(program.getTypeChecker());
    expect(service.getTypeId(variableType(program, file, 'leftProbe'))).toBe(userKey);
    expect(service.getTypeId(variableType(program, file, 'rightProbe'))).toBe(userKey);
  });
});
