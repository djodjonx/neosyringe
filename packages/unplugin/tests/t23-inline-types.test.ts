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
  "const unavailable: FactoryContext = { resolve: () => { throw new Error('no context'); }, resolveAll: () => [], resolveMany: () => { throw new Error('no context'); } };",
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

/**
 * E17 on the transformed Program: `useInterface<Clock>()` and `useProperty(...)` are rewritten to string ids, so the
 * list a user wrote with a class, an interface and a property token must still be accepted by `resolveMany` of the
 * container and of the factory context, and a class token must keep its own value type.
 */
const MANY_FILE = [
  "import { defineBuilderConfig, useInterface, useProperty } from '@djodjonx/neosyringe';",
  'export class Mail { send(): string { return "sent"; } }',
  'export interface Clock { now(): number; }',
  'const clock = useInterface<Clock>();',
  "const retries = useProperty<number>(Mail, 'retries');",
  'export const box = defineBuilderConfig({',
  "  name: 'InlineMany',",
  '  injections: [',
  '    { token: Mail },',
  '    { token: clock, useFactory: true, dependencies: [], provider: () => ({ now: () => 1 }) },',
  '    { token: retries, useFactory: true, dependencies: [], provider: () => 3 },',
  '    {',
  '      token: useInterface<Pair>(), useFactory: true, dependencies: [Mail, clock, retries],',
  '      provider: (ctx) => { const [mail, clockValue] = ctx.resolveMany([Mail, useInterface<Clock>()]); const first: Mail = mail; return { mail: first, ready: clockValue !== undefined }; },',
  '    },',
  '  ],',
  '});',
  'export interface Pair { mail: Mail; ready: boolean; }',
  'export const everything = box.resolveMany([Mail, useInterface<Clock>(), useProperty<number>(Mail, "retries")]);',
  'export const firstMail: Mail = everything[0];',
  '',
].join('\n');

/**
 * E16 on the transformed Program: the interface and property tokens of an `overrideMany` entry are string ids there. A
 * batch of a class, an interface and a property token must compile with no cast, in an open and a closed container, and
 * a class entry whose factory returns another type must still be refused.
 */
function overrideManyFile(name: string, options: string, batch: readonly string[]): string {
  return [
    "import { defineBuilderConfig, useInterface, useProperty } from '@djodjonx/neosyringe';",
    'export class Mail { send(): string { return "sent"; } }',
    'export interface Clock { now(): number; }',
    'const clock = useInterface<Clock>();',
    "const retries = useProperty<number>(Mail, 'retries');",
    'export const box = defineBuilderConfig({',
    `  name: '${name}',`,
    `  ${options}`,
    '  injections: [',
    '    { token: Mail },',
    '    { token: clock, useFactory: true, dependencies: [], provider: () => ({ now: () => 1 }) },',
    '    { token: retries, useFactory: true, dependencies: [], provider: () => 3 },',
    '  ],',
    '});',
    ...batch,
    '',
  ].join('\n');
}

const OVERRIDE_BATCH = [
  'export const mixed = box.overrideMany([',
  '  [Mail, () => new Mail()],',
  '  [useInterface<Clock>(), () => ({ now: () => 2 })],',
  "  [useProperty<number>(Mail, 'retries'), () => 5],",
  ']);',
  'export const byVariable = box.overrideMany([[clock, () => ({ now: () => 3 })], [retries, () => 7]]);',
  'export const coherent = box.overrideMany([[Mail, () => new Mail()] as const, [clock, () => ({ now: () => 4 })] as const]);',
];

/**
 * E18 on the transformed Program: the interface and property tokens of a scope value are string ids there. A scope
 * created with both kinds of token must compile with no cast, in an open and a closed container, and a call with no
 * options is refused (the model needs its values).
 */
function scopeInputsFile(name: string, options: string, scopes: readonly string[]): string {
  return [
    "import { defineBuilderConfig, useInterface, useProperty } from '@djodjonx/neosyringe';",
    'export interface Req { id: string; }',
    'export class Svc { retries = 0; }',
    'const request = useInterface<Req>();',
    "const retries = useProperty<number>(Svc, 'retries');",
    'export const box = defineBuilderConfig({',
    `  name: '${name}',`,
    `  ${options}`,
    '  scopeInputs: [request, retries],',
    '  injections: [{ token: Svc }],',
    '});',
    ...scopes,
    '',
  ].join('\n');
}

const SCOPES = [
  'export const scope = box.createScope({',
  '  values: [',
  "    { token: useInterface<Req>(), useValue: { id: 'r1' } },",
  "    { token: useProperty<number>(Svc, 'retries'), useValue: 3 },",
  '  ],',
  '});',
  'export const byVariable = box.createScope({ values: [{ token: retries, useValue: 4 }, { token: request, useValue: { id: "r2" } }] });',
  'export const empty = box.createScope({ values: [] });',
];

/**
 * E20 on the transformed Program: the token of an alias is a string id there and the alias is an accessor of the
 * container class. A read of the alias token and a `resolveMany` of an alias beside its target must compile with no
 * cast in the four layouts, and an alias whose target has not the type of its token must reach an analyzer error.
 */
function aliasFile(name: string, options: string, tail: readonly string[]): string {
  return [
    "import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';",
    'export interface Logger { id: string; }',
    'export interface Other { label: string; }',
    "export class Engine { readonly id = 'engine'; }",
    'const logger = useInterface<Logger>();',
    'export const box = defineBuilderConfig({',
    `  name: '${name}',`,
    `  ${options}`,
    '  injections: [{ token: Engine }, { token: logger, useExisting: Engine }],',
    '});',
    ...tail,
    '',
  ].join('\n');
}

const ALIAS_READS = [
  'export const viaAlias: Logger = box.resolve(logger);',
  'export const viaType: Logger = box.resolve(useInterface<Logger>());',
  'export const both = box.resolveMany([logger, Engine]);',
  'export const engine: Engine = both[1];',
];

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
  'many.ts': MANY_FILE,
  'override-many-open.ts': overrideManyFile('InlineOverrideOpen', '', OVERRIDE_BATCH),
  'override-many-closed.ts': overrideManyFile('InlineOverrideClosed', "optimization: { mode: 'closed', roots: [Mail] },", OVERRIDE_BATCH),
  'scope-inputs-open.ts': scopeInputsFile('InlineScopeOpen', '', SCOPES),
  'scope-inputs-closed.ts': scopeInputsFile('InlineScopeClosed', "optimization: { mode: 'closed', roots: [Svc] },", SCOPES),
  'scope-inputs-minimal-open.ts': scopeInputsFile('InlineScopeMinimalOpen', "runtime: { profile: 'minimal' },", SCOPES),
  'scope-inputs-minimal-closed.ts': scopeInputsFile(
    'InlineScopeMinimalClosed',
    "runtime: { profile: 'minimal' }, optimization: { mode: 'closed', roots: [Svc] },",
    SCOPES,
  ),
  'scope-inputs-wrong.ts': scopeInputsFile('InlineScopeWrong', '', ['export const none = box.createScope();']),
  'alias-open.ts': aliasFile('InlineAliasOpen', '', ALIAS_READS),
  'alias-closed.ts': aliasFile('InlineAliasClosed', "optimization: { mode: 'closed', roots: [logger, Engine] },", ALIAS_READS),
  'alias-minimal-open.ts': aliasFile('InlineAliasMinimalOpen', "runtime: { profile: 'minimal' },", ALIAS_READS),
  'alias-minimal-closed.ts': aliasFile(
    'InlineAliasMinimalClosed',
    "runtime: { profile: 'minimal' }, optimization: { mode: 'closed', roots: [logger, Engine] },",
    ALIAS_READS,
  ),
  'alias-wrong.ts': [
    "import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';",
    'export interface Other { label: string; }',
    "export class Engine { readonly id = 'engine'; }",
    'export const box = defineBuilderConfig({',
    "  name: 'InlineAliasWrong',",
    '  injections: [{ token: Engine }, { token: useInterface<Other>(), useExisting: Engine }],',
    '});',
    '',
  ].join('\n'),
  'override-many-wrong.ts': overrideManyFile('InlineOverrideWrong', '', [
    'export const wrongClass = box.overrideMany([[Mail, () => 42]]);',
    'export const wrongBesideInterface = box.overrideMany([[useInterface<Clock>(), () => ({ now: () => 2 })], [Mail, () => 42]]);',
  ]),
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
function diagnosticsOf(files: readonly string[], config: { testOverrides?: boolean } = {}): string[] {
  const transformed = neoSyringeTransformer(programOf(files), undefined, config, extras);
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

/** The diagnostics of `files`, or one line that says the transformer threw: a test then fails on what it expects. */
function diagnosticsOrThrown(files: readonly string[]): string[] {
  try {
    return diagnosticsOf(files);
  } catch (error) {
    return [`threw: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`];
  }
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

  it('E17-P17 resolveMany takes a class, an interface and a property token on the transformed program, in the container and in a factory context', () => {
    expect(diagnosticsOf(['many.ts'])).toEqual([]);
  });

  it('E16-P17 overrideMany takes a class, an interface and a property token on the transformed program, open and closed', () => {
    expect(diagnosticsOf(['override-many-open.ts'], { testOverrides: true })).toEqual([]);
    expect(diagnosticsOf(['override-many-closed.ts'], { testOverrides: true })).toEqual([]);
  });

  it('E16-P18 a class entry whose factory returns another type is still refused on the transformed program, alone and beside an interface entry', () => {
    const found = diagnosticsOf(['override-many-wrong.ts'], { testOverrides: true });
    expect(found.map((line) => line.replace(/:\d+:\d+.*$/, ''))).toEqual(['TS2769 override-many-wrong.ts', 'TS2769 override-many-wrong.ts']);
  });

  it('E18-P16 createScope takes the values of an interface and a property token on the transformed program, open and closed', () => {
    expect(diagnosticsOf(['scope-inputs-open.ts'])).toEqual([]);
    expect(diagnosticsOf(['scope-inputs-closed.ts'])).toEqual([]);
  });

  it('E18-P16 createScope takes the same values on a minimal container, open and closed', () => {
    expect(diagnosticsOf(['scope-inputs-minimal-open.ts'])).toEqual([]);
    expect(diagnosticsOf(['scope-inputs-minimal-closed.ts'])).toEqual([]);
  });

  it('E18-P16 createScope with no options is refused on the transformed program', () => {
    const found = diagnosticsOf(['scope-inputs-wrong.ts']);
    expect(found.map((line) => line.replace(/:\d+:\d+.*$/, ''))).toEqual(['TS2554 scope-inputs-wrong.ts']);
  });

  it('E20-P23 an alias token is read and listed beside its target with no cast, open and closed, full and minimal', () => {
    for (const name of ['alias-open.ts', 'alias-closed.ts', 'alias-minimal-open.ts', 'alias-minimal-closed.ts']) {
      expect(diagnosticsOrThrown([name]), name).toEqual([]);
      expect(transformedText(name), `${name}: the container has an accessor of the alias`).toMatch(/private _(?:direct|get)_Logger_\w+\(\)/);
    }
  });

  it('E20-P23 an alias whose target has not the type of its token reaches an analyzer error', () => {
    expect(diagnosticsOrThrown(['alias-wrong.ts']).join('\n')).toMatch(/threw: .*not assignable to token type 'Other'/);
  });

  it('T23-R2 the inline program is really transformed: the container class is in the user file', () => {
    expect(transformedText('open.ts')).toContain('class NeoContainer_');
  });
});
