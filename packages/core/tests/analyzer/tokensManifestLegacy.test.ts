import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import * as ts from 'typescript';
import { Analyzer } from '../../src/analyzer/Analyzer';
import { NeoTokenError } from '../../src/analyzer/errors/NeoTokenError';
import { HashUtils } from '../../src/analyzer/shared/HashUtils';
import { TokenResolverService } from '../../src/analyzer/shared/TokenResolverService';
import { TOKEN_MANIFEST_REMEDY } from '../../src/analyzer/shared/tokensManifest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const neosyringeEntry = path.join(repoRoot, 'packages/neosyringe/src/index.ts');
const scratch: string[] = [];

function keep(dir: string): string {
  scratch.push(dir);
  return dir;
}

function writePackage(root: string, name: string, packageJson: Record<string, unknown>, dts: string): string {
  const pkg = path.join(root, 'node_modules', name, 'dist');
  mkdirSync(pkg, { recursive: true });
  writeFileSync(path.join(root, 'node_modules', name, 'package.json'), JSON.stringify(packageJson));
  writeFileSync(path.join(pkg, 'index.d.ts'), dts);
  return `./node_modules/${name}/dist/index`;
}

function programAt(root: string, source: string): { program: ts.Program; file: string } {
  const file = path.join(root, 'app.ts');
  writeFileSync(file, source);
  writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'bundler',
      strict: true,
      skipLibCheck: true,
      noEmit: true,
      paths: { '@djodjonx/neosyringe': [neosyringeEntry] },
    },
    files: ['app.ts'],
  }));
  const configPath = path.join(root, 'tsconfig.json');
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, root, undefined, configPath);
  return { program: ts.createProgram(parsed.fileNames, parsed.options), file };
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

function textOf(run: () => string): string {
  try {
    return run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe('third-party package without a tokens manifest', () => {
  afterAll(() => {
    for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
  });

  it('resolves a class, an interface and a constructor param with the legacy pkg key', () => {
    const root = keep(mkdtempSync(path.join(tmpdir(), 'neosyringe-legacy-plain-')));
    const from = writePackage(root, 'acme-logger', {
      name: 'acme-logger',
      version: '1.0.0',
      types: './dist/index.d.ts',
    }, [
      'export declare class Logger { log(message: string): void }',
      'export interface Clock { now(): number }',
      '',
    ].join('\n'));
    const { program, file } = programAt(root, `
      import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';
      import { Logger } from '${from}';
      import type { Clock } from '${from}';
      class ClockImpl implements Clock { now(): number { return 0; } }
      class App { constructor(public logger: Logger, public clock: Clock) {} }
      export const clockProbe: Clock = null!;
      export const loggerProbe: Logger = null!;
      export const container = defineBuilderConfig({
        injections: [
          { token: Logger },
          { token: useInterface<Clock>(), provider: ClockImpl },
          { token: App },
        ],
      });
    `);
    const errors = new Analyzer(program).extractAllErrors();
    expect(errors.map((error) => error.message)).toEqual([]);
    const service = new TokenResolverService(program.getTypeChecker());
    const clockText = textOf(() => service.describeType(variableType(program, file, 'clockProbe')));
    const loggerText = textOf(() => service.describeType(variableType(program, file, 'loggerProbe')));
    expect(clockText).toContain('|pkg/acme-logger/dist/index.d.ts|Clock|');
    expect(loggerText).toContain('|pkg/acme-logger/dist/index.d.ts|Logger|');
    expect(service.getTypeId(variableType(program, file, 'clockProbe'))).toBe(`Clock_${HashUtils.hashDescriptor(clockText)}`);
    expect(service.getTypeIdFromConstructor(variableType(program, file, 'loggerProbe'))).toBe(`Logger_${HashUtils.hashDescriptor(loggerText)}`);
  });

  it('keeps the legacy pkg key when the package lists neosyringe only in devDependencies', () => {
    const root = keep(mkdtempSync(path.join(tmpdir(), 'neosyringe-legacy-dev-')));
    const from = writePackage(root, 'acme-logger', {
      name: 'acme-logger',
      version: '1.0.0',
      devDependencies: { '@djodjonx/neosyringe': '0.0.0' },
    }, 'export interface Clock { now(): number }\n');
    const { program, file } = programAt(root, `
      import { defineBuilderConfig } from '@djodjonx/neosyringe';
      import type { Clock } from '${from}';
      class App { constructor(public clock?: Clock) {} }
      export const clockProbe: Clock = null!;
      export const container = defineBuilderConfig({
        injections: [{ token: App }],
      });
    `);
    const errors = new Analyzer(program).extractAllErrors();
    expect(errors.map((error) => error.message)).toEqual([]);
    const text = textOf(() => new TokenResolverService(program.getTypeChecker()).describeType(variableType(program, file, 'clockProbe')));
    expect(text).toContain('|pkg/acme-logger/dist/index.d.ts|Clock|');
  });

  it('refuses a producer package that has no tokens manifest', () => {
    const root = keep(mkdtempSync(path.join(tmpdir(), 'neosyringe-legacy-producer-')));
    const from = writePackage(root, 'acme-logger', {
      name: 'acme-logger',
      version: '1.0.0',
      dependencies: { '@djodjonx/neosyringe': '0.0.0' },
    }, 'export interface Clock { now(): number }\n');
    const { program, file } = programAt(root, `
      import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';
      import type { Clock } from '${from}';
      class App { constructor(public clock: Clock) {} }
      export const container = defineBuilderConfig({
        injections: [
          { token: useInterface<Clock>(), useValue: { now: () => 0 } },
          { token: App },
        ],
      });
    `);
    const errors = new Analyzer(program).extractAllErrors();
    expect(errors.some((error) => error.code === 'NEO_TOKEN_BOUNDARY_UNSUPPORTED' && error.message.includes('manifest-absent') && error.message.includes('acme-logger') && error.message.includes(TOKEN_MANIFEST_REMEDY))).toBe(true);
    const probe = programAt(root, `
      import type { Clock } from '${from}';
      export const clockProbe: Clock = null!;
    `);
    let caught: unknown;
    try {
      new TokenResolverService(probe.program.getTypeChecker()).getTypeId(variableType(probe.program, probe.file, 'clockProbe'));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(NeoTokenError);
    expect((caught as NeoTokenError).message).toContain('NEO_TOKEN_BOUNDARY_UNSUPPORTED: manifest-absent acme-logger Clock');
  });

  it('refuses a useInterface const from a package that has no tokens manifest', () => {
    const root = keep(mkdtempSync(path.join(tmpdir(), 'neosyringe-legacy-const-')));
    const from = writePackage(root, 'acme-logger', {
      name: 'acme-logger',
      version: '1.0.0',
    }, [
      "import type { InterfaceToken } from '@djodjonx/neosyringe';",
      'export interface Clock { now(): number }',
      'export declare const ClockToken: InterfaceToken<Clock>;',
      '',
    ].join('\n'));
    const { program, file } = programAt(root, `
      import { ClockToken } from '${from}';
      export const probe = ClockToken;
    `);
    const source = program.getSourceFile(file);
    if (!source) throw new Error(`missing ${file}`);
    let token: ts.Expression | undefined;
    const visit = (node: ts.Node): void => {
      if (token) return;
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'probe') {
        token = node.initializer;
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    if (!token) throw new Error('missing ClockToken');
    let caught: unknown;
    try {
      new TokenResolverService(program.getTypeChecker()).resolveTokenId(token);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(NeoTokenError);
    expect((caught as NeoTokenError).message).toContain('NEO_TOKEN_BOUNDARY_UNSUPPORTED: manifest-absent acme-logger ClockToken');
  });
});
