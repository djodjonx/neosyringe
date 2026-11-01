import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as ts from 'typescript';
import { NeoTokenError } from '../../src/analyzer/errors/NeoTokenError';
import { HashUtils } from '../../src/analyzer/shared/HashUtils';
import { TokenResolverService } from '../../src/analyzer/shared/TokenResolverService';
import {
  TOKEN_MANIFEST_REMEDY,
  declaredTokenName,
  locatePackage,
} from '../../src/analyzer/shared/tokensManifest';
import { createFastProgram, warmLibCache } from '../fastProgram';

const DESCRIPTOR = 'v1|named|pkg/@acme/unit/dist/user.d.ts|User|';
const USER_DTS = 'export interface User { id: string }\nexport interface Other { id: string }\n';
const TOKEN_DTS = 'export declare const UserToken: unique symbol;\n';

const scratch: string[] = [];
let templatePkg = '';
let runtimeKey = '';
let sharedPkg = '';
let sharedProgram: ts.Program | undefined;
let sharedFile = '';

function keep(dir: string): string {
  scratch.push(dir);
  return dir;
}

function manifestText(contractVersion: string, key: string, schemaVersion = 1, descriptor = DESCRIPTOR): string {
  return JSON.stringify({
    schemaVersion,
    packageName: '@acme/unit',
    contractVersion,
    tokens: [{
      exportPath: 'dist/token.d.ts',
      exportName: 'UserToken',
      runtimeKey: key,
      descriptor,
      typeExport: { exportPath: 'dist/user.d.ts', exportName: 'User' },
    }],
  });
}

function writeUnit(pkg: string, text: string): void {
  mkdirSync(path.join(pkg, 'dist'), { recursive: true });
  writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({
    name: '@acme/unit',
    version: '1.0.0',
    neosyringe: { tokensManifest: './dist/tokens-manifest.json' },
  }));
  writeFileSync(path.join(pkg, 'dist/user.d.ts'), USER_DTS);
  writeFileSync(path.join(pkg, 'dist/token.d.ts'), TOKEN_DTS);
  writeFileSync(path.join(pkg, 'dist/tokens-manifest.json'), text);
}

function installFlat(label: string): { root: string; pkg: string } {
  const root = keep(mkdtempSync(path.join(tmpdir(), `neosyringe-consumer-${label}-`)));
  const pkg = path.join(root, 'node_modules/@acme/unit');
  cpSync(templatePkg, pkg, { recursive: true });
  return { root, pkg };
}

function programFrom(files: Record<string, string>): ts.Program {
  const names = Object.keys(files);
  const options = { strict: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext };
  const host = ts.createCompilerHost(options);
  const original = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersion, onError, create) => {
    const text = files[fileName];
    if (text !== undefined) return ts.createSourceFile(fileName, text, languageVersion, true);
    return original(fileName, languageVersion, onError, create);
  };
  return createFastProgram(names, options, host);
}

function sharedConsumer(): { program: ts.Program; file: string; pkg: string } {
  if (!sharedProgram) throw new Error('missing shared program');
  return { program: sharedProgram, file: sharedFile, pkg: sharedPkg };
}

function restoreShared(): void {
  writeUnit(sharedPkg, manifestText('contract-a', runtimeKey));
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
      && !ts.isImportSpecifier(node.parent)
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

function consumer(root: string, imports: { binding: string; from: string }[], body: string): { program: ts.Program; file: string } {
  const file = path.join(root, 'consumer.ts');
  const lines = imports.map((item) => `import { ${item.binding} } from '${item.from.split(path.sep).join('/')}';`);
  const program = programFrom({ [file]: `${lines.join('\n')}\n${body}\n` });
  return { program, file };
}

function capture(run: () => void): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('expected NEO_TOKEN_BOUNDARY_UNSUPPORTED');
}

function expectBoundary(error: unknown, reason: string, packageName: string): void {
  expect(error).toBeInstanceOf(NeoTokenError);
  const tokenError = error as NeoTokenError;
  expect(tokenError.code).toBe('NEO_TOKEN_BOUNDARY_UNSUPPORTED');
  expect(tokenError.message).toContain(`NEO_TOKEN_BOUNDARY_UNSUPPORTED: ${reason}`);
  expect(tokenError.message).toContain(packageName);
  expect(tokenError.message).toContain(TOKEN_MANIFEST_REMEDY);
}

describe('tokens manifest consumer', () => {
  beforeAll(() => {
    warmLibCache();
    runtimeKey = `User_${HashUtils.hashDescriptor(DESCRIPTOR)}`;
    const root = keep(mkdtempSync(path.join(tmpdir(), 'neosyringe-consumer-template-')));
    templatePkg = path.join(root, 'node_modules/@acme/unit');
    writeUnit(templatePkg, manifestText('contract-a', runtimeKey));
    const installed = installFlat('shared');
    sharedPkg = installed.pkg;
    const built = consumer(installed.root, [
      { binding: 'User', from: path.join(sharedPkg, 'dist/user.d.ts') },
      { binding: 'Other', from: path.join(sharedPkg, 'dist/user.d.ts') },
      { binding: 'UserToken', from: path.join(sharedPkg, 'dist/token.d.ts') },
    ], `
      export const userProbe: User = null!;
      export const otherProbe: Other = null!;
      export const tokenProbe = UserToken;
    `);
    sharedProgram = built.program;
    sharedFile = built.file;
  });

  beforeEach(() => {
    restoreShared();
  });

  afterAll(() => {
    for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
  });

  it('reuses the published runtime key', () => {
    const { program, file } = sharedConsumer();
    const service = new TokenResolverService(program.getTypeChecker());
    expect(service.getTypeId(variableType(program, file, 'userProbe'))).toBe(runtimeKey);
    expect(service.resolveTokenId(identifier(program, file, 'UserToken'))).toBe(runtimeKey);
  });

  it('refuses a missing manifest', () => {
    const { program, file, pkg } = sharedConsumer();
    rmSync(path.join(pkg, 'dist/tokens-manifest.json'));
    const error = capture(() => {
      new TokenResolverService(program.getTypeChecker()).getTypeId(variableType(program, file, 'userProbe'));
    });
    expectBoundary(error, 'manifest-absent', '@acme/unit');

    writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({
      version: '1.0.0',
      neosyringe: { tokensManifest: './dist/tokens-manifest.json' },
    }));
    const unnamedError = capture(() => {
      new TokenResolverService(program.getTypeChecker()).getTypeId(variableType(program, file, 'userProbe'));
    });
    expectBoundary(unnamedError, 'manifest-absent', 'unit');

    writeFileSync(path.join(pkg, 'package.json'), '{');
    const brokenError = capture(() => {
      new TokenResolverService(program.getTypeChecker()).getTypeId(variableType(program, file, 'userProbe'));
    });
    expectBoundary(brokenError, 'manifest-absent', 'User');
  });

  it('refuses an unknown schema version', () => {
    const { program, file, pkg } = sharedConsumer();
    writeFileSync(path.join(pkg, 'dist/tokens-manifest.json'), manifestText('contract-a', runtimeKey, 2));
    const error = capture(() => {
      new TokenResolverService(program.getTypeChecker()).getTypeId(variableType(program, file, 'userProbe'));
    });
    expectBoundary(error, 'schema-version', '@acme/unit');
  });

  it('refuses a runtime key that contradicts the descriptor', () => {
    const { program, file, pkg } = sharedConsumer();
    writeFileSync(path.join(pkg, 'dist/tokens-manifest.json'), manifestText('contract-a', 'User_deadbeef'));
    const error = capture(() => {
      new TokenResolverService(program.getTypeChecker()).getTypeId(variableType(program, file, 'userProbe'));
    });
    expectBoundary(error, 'runtime-key', '@acme/unit');
    expect((error as NeoTokenError).message).toContain('User_deadbeef');
  });

  it('refuses a token that is not listed', () => {
    const { program, file } = sharedConsumer();
    const error = capture(() => {
      new TokenResolverService(program.getTypeChecker()).getTypeId(variableType(program, file, 'otherProbe'));
    });
    expectBoundary(error, 'token-not-listed', '@acme/unit');
    expect((error as NeoTokenError).message).toContain('Other');
  });

  it('refuses a second contract version', () => {
    const root = keep(mkdtempSync(path.join(tmpdir(), 'neosyringe-consumer-contract-')));
    const left = path.join(root, 'left/node_modules/@acme/unit');
    const right = path.join(root, 'right/node_modules/@acme/unit');
    cpSync(templatePkg, left, { recursive: true });
    cpSync(templatePkg, right, { recursive: true });
    writeFileSync(path.join(left, 'dist/tokens-manifest.json'), manifestText('tokens-v1', runtimeKey));
    writeFileSync(path.join(right, 'dist/tokens-manifest.json'), manifestText('tokens-v2', runtimeKey));
    const { program, file } = consumer(root, [
      { binding: 'User as UserA', from: path.join(left, 'dist/user.d.ts') },
      { binding: 'User as UserB', from: path.join(right, 'dist/user.d.ts') },
    ], `
      export const leftProbe: UserA = null!;
      export const rightProbe: UserB = null!;
    `);
    const service = new TokenResolverService(program.getTypeChecker());
    expect(service.getTypeId(variableType(program, file, 'leftProbe'))).toBe(runtimeKey);
    const error = capture(() => service.getTypeId(variableType(program, file, 'rightProbe')));
    expectBoundary(error, 'contract-version', '@acme/unit');
    expect((error as NeoTokenError).message).toContain('tokens-v2');
  });

  it('locatePackage returns the root inside node_modules', () => {
    const flat = installFlat('locate-flat');
    const flatFile = path.join(flat.pkg, 'dist/user.d.ts');
    expect(locatePackage(flatFile)).toEqual({
      packageRoot: flat.pkg,
      packageJsonPath: path.join(flat.pkg, 'package.json'),
      relativePath: 'dist/user.d.ts',
    });

    const pnpmRoot = keep(mkdtempSync(path.join(tmpdir(), 'neosyringe-consumer-pnpm-')));
    const pnpmPkg = path.join(pnpmRoot, 'node_modules/.pnpm/@acme+unit@1.0.0/node_modules/@acme/unit');
    cpSync(templatePkg, pnpmPkg, { recursive: true });
    const pnpmFile = path.join(pnpmPkg, 'dist/user.d.ts');
    expect(locatePackage(pnpmFile)).toEqual({
      packageRoot: pnpmPkg,
      packageJsonPath: path.join(pnpmPkg, 'package.json'),
      relativePath: 'dist/user.d.ts',
    });

    const outside = path.join(flat.root, 'src/user.d.ts');
    mkdirSync(path.dirname(outside), { recursive: true });
    writeFileSync(outside, USER_DTS);
    writeFileSync(path.join(flat.root, 'package.json'), JSON.stringify({ name: 'app' }));
    expect(locatePackage(outside)).toBeUndefined();
  });

  it('locatePackage uses the package root after node_modules when dist has its own package.json', () => {
    const { pkg } = installFlat('nested-json');
    const nested = path.join(pkg, 'dist/esm');
    mkdirSync(nested, { recursive: true });
    writeFileSync(path.join(nested, 'package.json'), JSON.stringify({ type: 'module' }));
    writeFileSync(path.join(nested, 'index.d.ts'), USER_DTS);
    expect(locatePackage(path.join(nested, 'index.d.ts'))).toEqual({
      packageRoot: pkg,
      packageJsonPath: path.join(pkg, 'package.json'),
      relativePath: 'dist/esm/index.d.ts',
    });

    const pnpmRoot = keep(mkdtempSync(path.join(tmpdir(), 'neosyringe-consumer-pnpm-nested-')));
    const pnpmPkg = path.join(pnpmRoot, 'node_modules/.pnpm/@acme+unit@1.0.0/node_modules/@acme/unit');
    cpSync(templatePkg, pnpmPkg, { recursive: true });
    const pnpmNested = path.join(pnpmPkg, 'dist/esm');
    mkdirSync(pnpmNested, { recursive: true });
    writeFileSync(path.join(pnpmNested, 'package.json'), JSON.stringify({ type: 'module' }));
    writeFileSync(path.join(pnpmNested, 'index.d.ts'), USER_DTS);
    expect(locatePackage(path.join(pnpmNested, 'index.d.ts'))).toEqual({
      packageRoot: pnpmPkg,
      packageJsonPath: path.join(pnpmPkg, 'package.json'),
      relativePath: 'dist/esm/index.d.ts',
    });
  });

  it('declaredTokenName returns the leaf of a namespace', () => {
    expect(declaredTokenName('v1|named|pkg/@acme/unit/dist/user.d.ts|NS\\.User|')).toBe('User');
  });

  it('declaredTokenName refuses a malformed descriptor', () => {
    const error = capture(() => declaredTokenName('v1|nope|pkg/@acme/unit/dist/user.d.ts|User|'));
    expect(error).toBeInstanceOf(NeoTokenError);
    const tokenError = error as NeoTokenError;
    expect(tokenError.code).toBe('NEO_TOKEN_BOUNDARY_UNSUPPORTED');
    expect(tokenError.message).toContain('NEO_TOKEN_BOUNDARY_UNSUPPORTED: runtime-key');
    expect(tokenError.message).toContain(TOKEN_MANIFEST_REMEDY);
    const bare = capture(() => declaredTokenName('not-a-descriptor'));
    expect(bare).toBeInstanceOf(NeoTokenError);
    expect((bare as NeoTokenError).message).toContain('NEO_TOKEN_BOUNDARY_UNSUPPORTED: runtime-key');
  });

  it('keeps the first manifest for one resolver instance', () => {
    const { program, file, pkg } = sharedConsumer();
    const type = variableType(program, file, 'userProbe');
    const checker = program.getTypeChecker();
    const first = new TokenResolverService(checker);
    expect(first.getTypeId(type)).toBe(runtimeKey);
    const nextDescriptor = `${DESCRIPTOR}next`;
    const nextKey = `User_${HashUtils.hashDescriptor(nextDescriptor)}`;
    expect(nextKey).not.toBe(runtimeKey);
    writeFileSync(
      path.join(pkg, 'dist/tokens-manifest.json'),
      manifestText('contract-a', nextKey, 1, nextDescriptor),
    );
    expect(first.getTypeId(type)).toBe(runtimeKey);
    expect(new TokenResolverService(checker).getTypeId(type)).toBe(nextKey);
  });

  it('caches a manifest failure until the next resolver', () => {
    const { program, file, pkg } = sharedConsumer();
    writeFileSync(path.join(pkg, 'dist/tokens-manifest.json'), manifestText('contract-a', runtimeKey, 2));
    const type = variableType(program, file, 'userProbe');
    const checker = program.getTypeChecker();
    const first = new TokenResolverService(checker);
    const firstError = capture(() => first.getTypeId(type));
    expectBoundary(firstError, 'schema-version', '@acme/unit');
    writeFileSync(path.join(pkg, 'dist/tokens-manifest.json'), manifestText('contract-a', runtimeKey));
    const secondError = capture(() => first.getTypeId(type));
    expectBoundary(secondError, 'schema-version', '@acme/unit');
    expect(new TokenResolverService(checker).getTypeId(type)).toBe(runtimeKey);
  });
});
