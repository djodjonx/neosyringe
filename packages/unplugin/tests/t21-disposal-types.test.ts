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
 * T21 D7 on the transformed Program (inline layout, the harness of t23-inline-types.test.ts). The container class is
 * written into the user's file, so the type the consumer sees is the class: `await using` must be typed there when the
 * consumer has the disposable lib, and a consumer without it must still compile and end its containers with `destroy()`.
 */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const extras: ProgramTransformerExtras = { ts };

const WITH_LIB = 'tsconfig.json';
const WITHOUT_LIB = 'tsconfig.nolib.json';

function containerFile(name: string, options: string, tail: readonly string[]): string {
  return [
    "import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';",
    'export class Mail { send(): string { return "sent"; } }',
    'export class Late { constructor(readonly mail: Mail) {} }',
    'export interface Req { id: string; }',
    'const request = useInterface<Req>();',
    'export const box = defineBuilderConfig({',
    `  name: '${name}',`,
    `  ${options}`,
    '  injections: [',
    '    { token: Mail },',
    '    { token: Late, useFactory: true, dependencies: [Mail], provider: async (ctx) => new Late(ctx.resolve(Mail)) },',
    '  ],',
    '});',
    ...tail,
    '',
  ].join('\n');
}

function modelFile(name: string, options: string, tail: readonly string[]): string {
  return [
    "import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';",
    'export class Mail { send(): string { return "sent"; } }',
    'export interface Req { id: string; }',
    'const request = useInterface<Req>();',
    'export const box = defineBuilderConfig({',
    `  name: '${name}',`,
    `  ${options}`,
    '  scopeInputs: [request],',
    '  injections: [{ token: Mail }],',
    '});',
    ...tail,
    '',
  ].join('\n');
}

const USING = [
  'export async function run(): Promise<void> {',
  '  await using scope = box.createScope();',
  '  await using whole = box;',
  '  const resource: AsyncDisposable = scope;',
  '  void resource;',
  '  void whole;',
  '}',
];

const USING_MODEL = [
  'export async function run(): Promise<void> {',
  "  await using scope = box.createScope({ values: [{ token: useInterface<Req>(), useValue: { id: 'r1' } }] });",
  '  await using whole = box;',
  '  void scope;',
  '  void whole;',
  '}',
];

const ENDING = [
  'export async function end(): Promise<void> {',
  '  const scope = box.createScope();',
  '  await scope.destroy();',
  '  await box.destroy();',
  '}',
];

const ENDING_MODEL = [
  'export async function end(): Promise<void> {',
  "  const scope = box.createScope({ values: [{ token: useInterface<Req>(), useValue: { id: 'r1' } }] });",
  '  await scope.destroy();',
  '  await box.destroy();',
  '}',
];

const CLOSED = "optimization: { mode: 'closed', roots: [Mail, Late] },";
const MINIMAL = "runtime: { profile: 'minimal' },";
const CLOSED_MODEL = "optimization: { mode: 'closed', roots: [Mail] },";

const FILES: Record<string, string> = {
  'using-open.ts': containerFile('UsingOpen', '', USING),
  'using-closed.ts': containerFile('UsingClosed', CLOSED, USING),
  'using-minimal.ts': containerFile('UsingMinimal', MINIMAL, USING),
  'using-minimal-closed.ts': containerFile('UsingMinimalClosed', `${MINIMAL} ${CLOSED}`, USING),
  'using-model-open.ts': modelFile('UsingModelOpen', '', USING_MODEL),
  'using-model-closed.ts': modelFile('UsingModelClosed', CLOSED_MODEL, USING_MODEL),
  'using-model-minimal.ts': modelFile('UsingModelMinimal', MINIMAL, USING_MODEL),
  'ending-open.ts': containerFile('EndingOpen', '', ENDING),
  'ending-closed.ts': containerFile('EndingClosed', CLOSED, ENDING),
  'ending-minimal.ts': containerFile('EndingMinimal', MINIMAL, ENDING),
  'ending-model-open.ts': modelFile('EndingModelOpen', '', ENDING_MODEL),
  'ending-model-closed.ts': modelFile('EndingModelClosed', CLOSED_MODEL, ENDING_MODEL),
  'ending-model-minimal.ts': modelFile('EndingModelMinimal', MINIMAL, ENDING_MODEL),
};

let dir = '';
let previousCwd = '';

function tsconfig(lib: readonly string[]): string {
  return JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'bundler',
      strict: true,
      skipLibCheck: true,
      lib,
      types: [],
      baseUrl: REPO,
      paths: { '@djodjonx/neosyringe': ['packages/neosyringe/src/index.ts'] },
    },
  });
}

beforeAll(() => {
  previousCwd = process.cwd();
  dir = realpathSync(mkdtempSync(path.join(tmpdir(), 't21-inline-')));
  writeFileSync(path.join(dir, WITH_LIB), tsconfig(['ES2022', 'ESNext.Disposable']));
  writeFileSync(path.join(dir, WITHOUT_LIB), tsconfig(['ES2022']));
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

function programOf(file: string, config: string): ts.Program {
  const read = ts.readConfigFile(path.join(dir, config), ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dir, undefined, path.join(dir, config));
  return ts.createProgram([path.join(dir, file)], parsed.options);
}

/** `TS2851 using-open.ts:5:9 message`, one line per diagnostic of the user's file in the transformed program. */
function diagnosticsOf(file: string, config: string): string[] {
  const transformed = neoSyringeTransformer(programOf(file, config), undefined, {}, extras);
  const found: string[] = [];
  for (const diagnostic of ts.getPreEmitDiagnostics(transformed)) {
    const source = diagnostic.file;
    if (!source || source.fileName.includes('node_modules') || !source.fileName.startsWith(dir)) continue;
    const position = source.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ');
    found.push(`TS${diagnostic.code} ${path.basename(source.fileName)}:${position.line + 1}:${position.character + 1} ${message}`);
  }
  return found;
}

describe('T21-P23 D7 await using is typed on the transformed program when the consumer has the disposable lib', () => {
  it('T21-P23 a container and a scope are await using resources, open, closed and minimal', () => {
    for (const file of ['using-open.ts', 'using-closed.ts', 'using-minimal.ts', 'using-minimal-closed.ts']) {
      expect(diagnosticsOf(file, WITH_LIB), file).toEqual([]);
    }
  });

  it('T21-P23 a scope made from a template with inputs, and the template itself, are await using resources', () => {
    for (const file of ['using-model-open.ts', 'using-model-closed.ts', 'using-model-minimal.ts']) {
      expect(diagnosticsOf(file, WITH_LIB), file).toEqual([]);
    }
  });
});

describe('T21-P24 D7 a consumer without the disposable lib still compiles and ends its containers with destroy()', () => {
  it('T21-P24 the same containers, ended with destroy(), raise no diagnostic at lib ES2022', () => {
    for (const file of ['ending-open.ts', 'ending-closed.ts', 'ending-minimal.ts', 'ending-model-open.ts', 'ending-model-closed.ts', 'ending-model-minimal.ts']) {
      expect(diagnosticsOf(file, WITHOUT_LIB), file).toEqual([]);
    }
  });

  it('T21-P24 the same containers, ended with destroy(), raise no diagnostic with the disposable lib either', () => {
    for (const file of ['ending-open.ts', 'ending-model-closed.ts', 'ending-minimal.ts']) {
      expect(diagnosticsOf(file, WITH_LIB), file).toEqual([]);
    }
  });
});
