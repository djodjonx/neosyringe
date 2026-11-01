import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as ts from 'typescript';
import { Analyzer, NeoTokenError, readTokensManifest, TokenResolverService } from '../../packages/core/src/analyzer';
import type { AnalysisError } from '../../packages/core/src/analyzer';
import type { TokensManifest } from '../../packages/core/src/analyzer/shared/tokensManifest';
import { emitTokensManifest } from '../../packages/cli/src/tokensManifest';
import { TSContext } from '../../packages/core/src/TSContext';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fixtureSrc = path.join(repoRoot, 'tests/e2e/fixtures/t15-producer/src');
const tsc = path.join(repoRoot, 'node_modules/typescript/bin/tsc');
const neosyringeTypes = path.join(repoRoot, 'packages/neosyringe/dist/index.d.mts');

const scratch: string[] = [];
let producerRoot = '';
let manifestPath = '';
let manifest: TokensManifest;
let producerUserKey = '';
let producerRepoKey = '';

function keep(dir: string): string {
  scratch.push(dir);
  return dir;
}

function writeProducerPackage(dir: string, version: string): void {
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: '@acme/tokens',
    version,
    type: 'module',
    types: './dist/tokens.d.ts',
    exports: { '.': { types: './dist/tokens.d.ts' } },
    peerDependencies: { '@djodjonx/neosyringe': '*' },
    neosyringe: { tokensManifest: './dist/tokens-manifest.json' },
  }));
  writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({
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
      paths: { '@djodjonx/neosyringe': [neosyringeTypes] },
    },
    include: ['src'],
  }));
}

function installLayout(root: string, layout: 'flat' | 'pnpm', version: string, contractVersion: string): string {
  const packageDir = layout === 'flat'
    ? path.join(root, 'node_modules/@acme/tokens')
    : path.join(root, 'node_modules/.pnpm/@acme+tokens@1.0.0/node_modules/@acme/tokens');
  mkdirSync(packageDir, { recursive: true });
  cpSync(path.join(producerRoot, 'dist'), path.join(packageDir, 'dist'), { recursive: true });
  const pkg = JSON.parse(readFileSync(path.join(producerRoot, 'package.json'), 'utf8')) as { version: string };
  pkg.version = version;
  writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify(pkg));
  const text = readFileSync(manifestPath, 'utf8');
  const copy = JSON.parse(text) as TokensManifest;
  copy.contractVersion = contractVersion;
  writeFileSync(path.join(packageDir, 'dist/tokens-manifest.json'), JSON.stringify(copy));
  return packageDir;
}

function consumerSource(imports: { binding: string; from: string }[], body: string): string {
  const lines = imports.map((item) => `import { ${item.binding} } from '${item.from}';`);
  return `${lines.join('\n')}\n${body}\n`;
}

function programFrom(files: Record<string, string>): ts.Program {
  const names = Object.keys(files);
  const host = ts.createCompilerHost({ strict: true, target: ts.ScriptTarget.ES2022 });
  const original = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersion, onError, create) => {
    const text = files[fileName];
    if (text !== undefined) return ts.createSourceFile(fileName, text, languageVersion, true);
    return original(fileName, languageVersion, onError, create);
  };
  return ts.createProgram(names, {
    strict: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
  }, host);
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

function identifier(program: ts.Program, fileName: string, name: string): ts.Identifier {
  const source = program.getSourceFile(fileName);
  if (!source) throw new Error(`missing ${fileName}`);
  let found: ts.Identifier | undefined;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (
      ts.isIdentifier(node)
      && node.text === name
      && !(ts.isVariableDeclaration(node.parent) && node.parent.name === node)
    ) {
      found = node;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!found) throw new Error(`missing identifier ${name}`);
  return found;
}

const REMEDY = 'publish the token through a tokens manifest: neosyringe-check --tokens-manifest <file> --contract-version <v>, and reference it in package.json neosyringe.tokensManifest';

function expectBoundary(error: NeoTokenError, reason: string, packageName: string): void {
  expect(error.code).toBe('NEO_TOKEN_BOUNDARY_UNSUPPORTED');
  expect(error.message).toContain(`NEO_TOKEN_BOUNDARY_UNSUPPORTED: ${reason}`);
  expect(error.message).toContain(packageName);
  expect(error.message).toContain(REMEDY);
}

function boundary(run: () => void): NeoTokenError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(NeoTokenError);
    return error as NeoTokenError;
  }
  throw new Error('expected NEO_TOKEN_BOUNDARY_UNSUPPORTED');
}

describe('T15 token manifest', () => {
  beforeAll(() => {
    producerRoot = keep(mkdtempSync(path.join(tmpdir(), 'neosyringe-t15-producer-')));
    mkdirSync(path.join(producerRoot, 'src'), { recursive: true });
    cpSync(fixtureSrc, path.join(producerRoot, 'src'), { recursive: true });
    writeFileSync(path.join(producerRoot, 'src/types.ts'), `${readFileSync(path.join(fixtureSrc, 'types.ts'), 'utf8')}\nexport const userProbe: User = null!;\n`);
    writeFileSync(path.join(producerRoot, 'src/tokens.ts'), `${readFileSync(path.join(fixtureSrc, 'tokens.ts'), 'utf8')}\nexport const repoProbe: Repo<User> = null!;\n`);
    writeProducerPackage(producerRoot, '1.0.0');
    const compiled = spawnSync(process.execPath, [tsc, '-p', path.join(producerRoot, 'tsconfig.json')], {
      cwd: producerRoot,
      encoding: 'utf8',
    });
    if (compiled.status !== 0) {
      throw new Error(`tsc failed\n${compiled.stdout}\n${compiled.stderr}`);
    }
    manifestPath = emitTokensManifest({
      tokensManifest: path.join(producerRoot, 'dist/tokens-manifest.json'),
      contractVersion: 'tokens-v1',
      cwd: producerRoot,
    });
    manifest = readTokensManifest(readFileSync(manifestPath, 'utf8'));
    const resolved = resolveProject(producerRoot);
    const program = ts.createProgram(resolved.fileNames, resolved.options);
    TSContext.runWithProjectRoot(producerRoot, () => {
      const checker = program.getTypeChecker();
      const service = new TokenResolverService(checker);
      const userFile = resolved.fileNames.find((file) => file.endsWith(`${path.sep}types.ts`));
      const tokenFile = resolved.fileNames.find((file) => file.endsWith(`${path.sep}tokens.ts`));
      if (!userFile || !tokenFile) throw new Error('producer sources missing');
      producerUserKey = service.getTypeId(variableType(program, userFile, 'userProbe'));
      producerRepoKey = service.getTypeId(variableType(program, tokenFile, 'repoProbe'));
    });
  });

  afterAll(() => {
    for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
    TSContext.reset();
  });

  it('producer token keeps key in consumer', () => {
    expect(manifest.contractVersion).toBe('tokens-v1');
    const user = manifest.tokens.find((token) => token.exportName === 'UserToken');
    const repo = manifest.tokens.find((token) => token.exportName === 'UserRepoToken');
    expect(user?.runtimeKey).toBe(producerUserKey);
    expect(repo?.runtimeKey).toBe(producerRepoKey);
    expect(user?.typeExport).toEqual({ exportPath: 'dist/types.d.ts', exportName: 'User' });
    expect(repo?.typeExport).toBeUndefined();
    for (const token of manifest.tokens) {
      const file = path.join(producerRoot, token.exportPath);
      const text = readFileSync(file, 'utf8');
      expect(text).toContain(token.exportName);
      if (token.typeExport) {
        const typeFile = path.join(producerRoot, token.typeExport.exportPath);
        expect(readFileSync(typeFile, 'utf8')).toContain(token.typeExport.exportName);
      }
    }
    expect(JSON.stringify(manifest)).not.toContain(producerRoot);

    const root = keep(mkdtempSync(path.join(tmpdir(), 'neosyringe-t15-consumer-')));
    const pkg = installLayout(root, 'flat', '1.0.0', 'tokens-v1');
    const dts = path.join(pkg, 'dist/types.d.ts').split(path.sep).join('/');
    const tokensDts = path.join(pkg, 'dist/tokens.d.ts').split(path.sep).join('/');
    const file = path.join(root, 'consumer.ts');
    const source = consumerSource([
      { binding: 'User, Other, Repo', from: dts },
      { binding: 'UserToken, UserRepoToken', from: tokensDts },
    ], `
      export const userProbe: User = null!;
      export const repoProbe: Repo<User> = null!;
      export const tokenProbe = UserToken;
      export const repoTokenProbe = UserRepoToken;
    `);
    const program = programFrom({ [file]: source });
    const service = new TokenResolverService(program.getTypeChecker());
    expect(service.getTypeId(variableType(program, file, 'userProbe'))).toBe(producerUserKey);
    expect(service.resolveTokenId(identifier(program, file, 'UserToken'))).toBe(producerUserKey);
    expect(service.resolveTokenId(identifier(program, file, 'UserRepoToken'))).toBe(producerRepoKey);
  });

  it('key stable when consumer root or node_modules path changes', () => {
    const keys: string[] = [];
    for (const layout of ['flat', 'pnpm'] as const) {
      const root = keep(mkdtempSync(path.join(tmpdir(), `neosyringe-t15-${layout}-`)));
      const pkg = installLayout(root, layout, '1.0.0', 'tokens-v1');
      const dts = path.join(pkg, 'dist/types.d.ts');
      const file = path.join(root, 'consumer.ts');
      const program = programFrom({
        [file]: consumerSource(
          [{ binding: 'User', from: dts.split(path.sep).join('/') }],
          'export const userProbe: User = null!;\n',
        ),
      });
      const key = new TokenResolverService(program.getTypeChecker())
        .getTypeId(variableType(program, file, 'userProbe'));
      expect(key).not.toContain(root);
      expect(key).not.toContain('node_modules');
      keys.push(key);
    }
    expect(keys[0]).toBe(producerUserKey);
    expect(keys[1]).toBe(producerUserKey);
  });

  it('manifest absent / schemaVersion unknown / runtimeKey contradicts descriptor / token not listed', () => {
    const root = keep(mkdtempSync(path.join(tmpdir(), 'neosyringe-t15-diag-')));
    const pkg = installLayout(root, 'flat', '1.0.0', 'tokens-v1');
    const dts = path.join(pkg, 'dist/types.d.ts').split(path.sep).join('/');
    const file = path.join(root, 'consumer.ts');
    const source = consumerSource(
      [{ binding: 'User, Other, Repo', from: dts }],
      `
        export const userProbe: User = null!;
        export const otherProbe: Other = null!;
        export const repoProbe: Repo<User> = null!;
      `,
    );
    const program = programFrom({ [file]: source });
    const checker = program.getTypeChecker();

    const absentDir = keep(mkdtempSync(path.join(tmpdir(), 'neosyringe-t15-absent-')));
    const absentPkg = path.join(absentDir, 'node_modules/@acme/tokens');
    mkdirSync(path.join(absentPkg, 'dist'), { recursive: true });
    writeFileSync(path.join(absentPkg, 'package.json'), JSON.stringify({
      name: '@acme/tokens',
      version: '1.0.0',
      peerDependencies: { '@djodjonx/neosyringe': '*' },
    }));
    cpSync(path.join(pkg, 'dist/types.d.ts'), path.join(absentPkg, 'dist/types.d.ts'));
    const absentFile = path.join(absentDir, 'consumer.ts');
    const absentProgram = programFrom({
      [absentFile]: consumerSource(
        [{ binding: 'User', from: path.join(absentPkg, 'dist/types.d.ts').split(path.sep).join('/') }],
        'export const userProbe: User = null!;\n',
      ),
    });
    const absentError = boundary(() => {
      new TokenResolverService(absentProgram.getTypeChecker())
        .getTypeId(variableType(absentProgram, absentFile, 'userProbe'));
    });
    expectBoundary(absentError, 'manifest-absent', '@acme/tokens');

    const manifestFile = path.join(pkg, 'dist/tokens-manifest.json');
    const original = readFileSync(manifestFile, 'utf8');
    try {
      const badSchema = JSON.parse(original) as TokensManifest;
      badSchema.schemaVersion = 2;
      writeFileSync(manifestFile, JSON.stringify(badSchema));
      const schemaError = boundary(() => {
        new TokenResolverService(checker).getTypeId(variableType(program, file, 'userProbe'));
      });
      expectBoundary(schemaError, 'schema-version', '@acme/tokens');

      const badKey = JSON.parse(original) as TokensManifest;
      const user = badKey.tokens.find((token) => token.exportName === 'UserToken');
      if (!user) throw new Error('UserToken missing');
      user.runtimeKey = 'User_deadbeef';
      writeFileSync(manifestFile, JSON.stringify(badKey));
      const keyError = boundary(() => {
        new TokenResolverService(checker).getTypeId(variableType(program, file, 'userProbe'));
      });
      expectBoundary(keyError, 'runtime-key', '@acme/tokens');
    } finally {
      writeFileSync(manifestFile, original);
    }

    const service = new TokenResolverService(checker);
    const unlisted = boundary(() => service.getTypeId(variableType(program, file, 'otherProbe')));
    expectBoundary(unlisted, 'token-not-listed', '@acme/tokens');
    expect(unlisted.message).toContain('Other');
    const generic = boundary(() => service.getTypeId(variableType(program, file, 'repoProbe')));
    expectBoundary(generic, 'token-not-listed', '@acme/tokens');
    expect(generic.message).toContain('Repo');
    expect(service.getTypeId(variableType(program, file, 'userProbe'))).toBe(producerUserKey);
  });

  it('two copies of the package', () => {
    const root = keep(mkdtempSync(path.join(tmpdir(), 'neosyringe-t15-copies-')));
    const left = installLayout(path.join(root, 'left'), 'flat', '1.0.0', 'tokens-v1');
    const right = installLayout(path.join(root, 'right'), 'flat', '1.0.1', 'tokens-v1');
    const other = installLayout(path.join(root, 'other'), 'flat', '1.0.0', 'tokens-v2');
    const file = path.join(root, 'consumer.ts');
    const program = programFrom({
      [file]: consumerSource([
        { binding: 'User as UserA', from: path.join(left, 'dist/types.d.ts').split(path.sep).join('/') },
        { binding: 'User as UserB', from: path.join(right, 'dist/types.d.ts').split(path.sep).join('/') },
        { binding: 'User as UserC', from: path.join(other, 'dist/types.d.ts').split(path.sep).join('/') },
      ], `
        export const leftProbe: UserA = null!;
        export const rightProbe: UserB = null!;
        export const otherProbe: UserC = null!;
      `),
    });
    const service = new TokenResolverService(program.getTypeChecker());
    const leftKey = service.getTypeId(variableType(program, file, 'leftProbe'));
    const rightKey = service.getTypeId(variableType(program, file, 'rightProbe'));
    expect(leftKey).toBe(producerUserKey);
    expect(rightKey).toBe(leftKey);
    const error = boundary(() => service.getTypeId(variableType(program, file, 'otherProbe')));
    expectBoundary(error, 'contract-version', '@acme/tokens');
  });

  it('public analysis reports an unlisted external token and an unknown schemaVersion', () => {
    const unlistedRoot = keep(mkdtempSync(path.join(tmpdir(), 'neosyringe-t15-public-unlisted-')));
    installLayout(unlistedRoot, 'flat', '1.0.0', 'tokens-v1');
    const unlisted = publicAnalysis(unlistedRoot, `
      import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';
      import type { Other } from './node_modules/@acme/tokens/dist/types';
      class App { constructor(public other: Other) {} }
      export const container = defineBuilderConfig({
        injections: [{ token: useInterface<Other>(), provider: App }],
      });
    `);
    expect(unlisted.thrown).toBeUndefined();
    const unlistedDiag = boundaryDiagnostic(unlisted.errors);
    expect(unlistedDiag?.code).toBe('NEO_TOKEN_BOUNDARY_UNSUPPORTED');
    expect(unlistedDiag?.message).toContain('NEO_TOKEN_BOUNDARY_UNSUPPORTED: token-not-listed');
    expect(unlistedDiag?.message).toContain('@acme/tokens');
    expect(unlistedDiag?.message).toContain('Other');
    expect(unlistedDiag?.message).toContain(REMEDY);
    expect(unlistedDiag?.message).not.toContain(unlistedRoot);

    const schemaRoot = keep(mkdtempSync(path.join(tmpdir(), 'neosyringe-t15-public-schema-')));
    const schemaPkg = installLayout(schemaRoot, 'flat', '1.0.0', 'tokens-v1');
    const manifestFile = path.join(schemaPkg, 'dist/tokens-manifest.json');
    const badSchema = JSON.parse(readFileSync(manifestFile, 'utf8')) as TokensManifest;
    badSchema.schemaVersion = 2;
    writeFileSync(manifestFile, JSON.stringify(badSchema));
    const schema = publicAnalysis(schemaRoot, `
      import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';
      import type { User } from './node_modules/@acme/tokens/dist/types';
      class App { constructor(public user: User) {} }
      export const container = defineBuilderConfig({
        injections: [{ token: useInterface<User>(), provider: App }],
      });
    `);
    expect(schema.thrown).toBeUndefined();
    const schemaDiag = boundaryDiagnostic(schema.errors);
    expect(schemaDiag?.code).toBe('NEO_TOKEN_BOUNDARY_UNSUPPORTED');
    expect(schemaDiag?.message).toContain('NEO_TOKEN_BOUNDARY_UNSUPPORTED: schema-version');
    expect(schemaDiag?.message).toContain('@acme/tokens');
    expect(schemaDiag?.message).toContain(REMEDY);
    expect(schemaDiag?.message).not.toMatch(/User_[0-9a-f]{8}/);
  });

  it('optional node_modules parameter without a manifest does not crash', () => {
    const root = keep(mkdtempSync(path.join(tmpdir(), 'neosyringe-t15-public-optional-')));
    const plain = path.join(root, 'node_modules/@acme/plain/dist');
    mkdirSync(plain, { recursive: true });
    writeFileSync(path.join(root, 'node_modules/@acme/plain/package.json'), JSON.stringify({
      name: '@acme/plain',
      version: '1.0.0',
      types: './dist/index.d.ts',
    }));
    writeFileSync(path.join(plain, 'index.d.ts'), 'export interface Plain { n: number }\n');
    const result = publicAnalysis(root, `
      import { defineBuilderConfig } from '@djodjonx/neosyringe';
      import type { Plain } from './node_modules/@acme/plain/dist/index';
      class App { constructor(public plain?: Plain) {} }
      export const plainProbe: Plain = null!;
      export const container = defineBuilderConfig({
        injections: [{ token: App }],
      });
    `);
    expect(result.thrown).toBeUndefined();
    expect(result.errors.map((error) => error.message)).toEqual([]);
    const read = ts.readConfigFile(path.join(root, 'tsconfig.json'), ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, root);
    const program = ts.createProgram(parsed.fileNames, parsed.options);
    const app = path.join(root, 'app.ts');
    const text = new TokenResolverService(program.getTypeChecker()).describeType(variableType(program, app, 'plainProbe'));
    expect(text).toContain('|pkg/@acme/plain/dist/index.d.ts|Plain|');
  });
});

function publicAnalysis(dir: string, source: string): { errors: AnalysisError[]; thrown: unknown } {
  writeFileSync(path.join(dir, 'app.ts'), source);
  writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'bundler',
      strict: true,
      skipLibCheck: true,
      noEmit: true,
      baseUrl: repoRoot,
      paths: { '@djodjonx/neosyringe': ['packages/neosyringe/src/index.ts'] },
    },
    files: ['app.ts'],
  }));
  const read = ts.readConfigFile(path.join(dir, 'tsconfig.json'), ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dir);
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  try {
    return { errors: new Analyzer(program).extractAllErrors(), thrown: undefined };
  } catch (error) {
    return { errors: [], thrown: error };
  }
}

function boundaryDiagnostic(errors: AnalysisError[]): AnalysisError | undefined {
  return errors.find((error) =>
    error.code === 'NEO_TOKEN_BOUNDARY_UNSUPPORTED'
    || error.message.includes('NEO_TOKEN_BOUNDARY_UNSUPPORTED'));
}

function resolveProject(cwd: string) {
  const configPath = path.join(cwd, 'tsconfig.json');
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, cwd);
  return { fileNames: parsed.fileNames, options: parsed.options };
}
