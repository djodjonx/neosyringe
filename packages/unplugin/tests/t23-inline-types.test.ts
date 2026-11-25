import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@djodjonx/neosyringe-core/generator', () => import('../../core/src/generator/index'));
vi.mock('@djodjonx/neosyringe-core/analyzer', () => import('../../core/src/analyzer/index'));
vi.mock('@djodjonx/neosyringe-core/context', () => import('../../core/src/TSContext'));

import * as ts from 'typescript';
import type { ProgramTransformerExtras } from 'ts-patch';
import { TSContext } from '@djodjonx/neosyringe-core/context';
import neoSyringeTransformer from '../src/transformer';

/**
 * T23 B5, inline layout. The ts-patch transformer builds a new Program from the transformed text
 * (`useDirectSymbolNames: true`, the container class written into the user's file), and tsc checks that
 * Program with the consumer's options. A factory the user wrote against the public `FactoryContext` must
 * still type-check there, and so must a consumer that calls `container.on` with the public listener shape.
 */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const extras: ProgramTransformerExtras = { ts };

const COMMON = [
  "import { defineBuilderConfig, type FactoryContext } from '@djodjonx/neosyringe';",
  'export class Logger { log(message: string): void { void message; } }',
  'export class UserService { constructor(readonly logger: Logger) {} }',
  'export class Audit { constructor(readonly logger: Logger) {} }',
  'export class Report { constructor(readonly logger: Logger) {} }',
  'export class Later { constructor(readonly logger: Logger) {} }',
  "const unavailable: FactoryContext = { resolve: () => { throw new Error('no context'); }, resolveAll: () => [] };",
].join('\n');

/** The documented factory forms: unannotated context, annotated with the public type, default parameter, async. */
function factories(): string {
  return [
    '{ token: Logger },',
    '{ token: UserService, useFactory: true, dependencies: [Logger], provider: (ctx) => new UserService(ctx.resolve(Logger)) },',
    '{ token: Audit, useFactory: true, dependencies: [Logger], provider: (ctx: FactoryContext) => new Audit(ctx.resolve(Logger)) },',
    '{ token: Report, useFactory: true, dependencies: [Logger], provider: (ctx: FactoryContext = unavailable) => new Report(ctx.resolve(Logger)) },',
    '{ token: Later, useFactory: true, dependencies: [Logger], provider: async (ctx) => new Later(ctx.resolve(Logger)) },',
  ].join('\n    ');
}

function containerFile(name: string, options: string): string {
  return `${COMMON}
export const container = defineBuilderConfig({
  name: '${name}',
  ${options}
  injections: [
    ${factories()}
  ],
});
`;
}

const FILES: Record<string, string> = {
  'open.ts': containerFile('InlineOpen', ''),
  'closed.ts': containerFile('InlineClosed', "optimization: { mode: 'closed', roots: [UserService, Later] },"),
  'minimal.ts': containerFile('InlineMinimal', "runtime: { profile: 'minimal' },"),
  'consumer.ts': [
    "import type { Token } from '@djodjonx/neosyringe';",
    "import { container as open, UserService } from './open';",
    "import { container as closed } from './closed';",
    '',
    'const printed: string[] = [];',
    'export const stopOpen: () => void = open.on(',
    "  'resolve',",
    '  (token: Token<unknown>, instance: unknown) => { printed.push(String(token), String(instance)); },',
    ');',
    'export const stopClosed: () => void = closed.on(',
    "  'resolve',",
    '  (token: Token<unknown>, instance: unknown) => { printed.push(String(token), String(instance)); },',
    ');',
    'export const user: UserService = open.resolve(UserService);',
    'export const everyone: UserService[] = open.resolveAll(UserService);',
    '',
  ].join('\n'),
};

let dir = '';
let previousCwd = '';

beforeAll(() => {
  previousCwd = process.cwd();
  dir = realpathSync(mkdtempSync(path.join(tmpdir(), 't23-inline-')));
  writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'bundler',
      strict: true,
      skipLibCheck: true,
      lib: ['ES2022'],
      types: [],
      baseUrl: REPO,
      paths: { '@djodjonx/neosyringe': ['packages/neosyringe/src/index.ts'] },
    },
  }));
  for (const [name, text] of Object.entries(FILES)) writeFileSync(path.join(dir, name), text);
  process.chdir(dir);
});

afterEach(() => {
  vi.restoreAllMocks();
  TSContext.reset();
});

afterAll(() => {
  process.chdir(previousCwd);
  rmSync(dir, { recursive: true, force: true });
});

function programOf(files: readonly string[]): ts.Program {
  const config = ts.readConfigFile(path.join(dir, 'tsconfig.json'), ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dir, undefined, path.join(dir, 'tsconfig.json'));
  return ts.createProgram(files.map((file) => path.join(dir, file)), parsed.options);
}

/** `TS2345 open.ts:18:9 message`, one line per diagnostic of the user's files in the transformed program. */
function diagnosticsOf(files: readonly string[]): string[] {
  const transformed = neoSyringeTransformer(programOf(files), undefined, {}, extras);
  const found: string[] = [];
  for (const diagnostic of ts.getPreEmitDiagnostics(transformed)) {
    const file = diagnostic.file;
    if (!file || file.fileName.includes('node_modules') || !file.fileName.startsWith(dir)) continue;
    const position = file.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ');
    found.push(`TS${diagnostic.code} ${path.basename(file.fileName)}:${position.line + 1}:${position.character + 1} ${message}`);
  }
  return found;
}

function transformedText(name: string): string {
  const transformed = neoSyringeTransformer(programOf([name]), undefined, {}, extras);
  const file = transformed.getSourceFile(path.join(dir, name));
  if (!file) throw new Error(`missing ${name} in the transformed program`);
  return file.text;
}

describe('T23 B5 the transformed program type-checks with the consumer options (inline layout)', () => {
  it('T23-R1 factories written against the public FactoryContext, in an open container, raise no diagnostic', () => {
    expect(diagnosticsOf(['open.ts'])).toEqual([]);
  });

  it('T23-R1 the same factories in a closed container (direct reads, internal resolvers) raise no diagnostic', () => {
    expect(diagnosticsOf(['closed.ts'])).toEqual([]);
  });

  it('T23-R1 the same factories in a minimal container raise no diagnostic', () => {
    expect(diagnosticsOf(['minimal.ts'])).toEqual([]);
  });

  it('T23-R2 a consumer that types its resolve listener with the public Token shape raises no diagnostic', () => {
    expect(diagnosticsOf(['open.ts', 'closed.ts', 'consumer.ts'])).toEqual([]);
  });

  it('T23-R2 the inline program is really transformed: the container class is in the user file', () => {
    expect(transformedText('open.ts')).toContain('class NeoContainer_');
  });
});
