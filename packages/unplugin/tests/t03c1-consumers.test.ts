import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@djodjonx/neosyringe-core/generator', () => import('../../core/src/generator/index'));
vi.mock('@djodjonx/neosyringe-core/analyzer', () => import('../../core/src/analyzer/index'));
vi.mock('@djodjonx/neosyringe-core/context', () => import('../../core/src/TSContext'));

import * as ts from 'typescript';
import type { ProgramTransformerExtras } from 'ts-patch';
import {
  Analyzer,
  normalizeDiagnostic,
  type AnalysisError,
  type NormalizedDiagnostic,
} from '@djodjonx/neosyringe-core/analyzer';
import { TSContext } from '@djodjonx/neosyringe-core/context';
import init from '../../lsp/src/index';
import { buildJsonReport } from '../../cli/src/report';
import { neoSyringePlugin } from '../src/index';
import neoSyringeTransformer from '../src/transformer';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const CONTAINER = `
  import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';

  export interface IPort { id: number }
  export class WrongImpl { name = 'x' }
  export class Dep {}
  export class NeedsMissing { constructor(public dep: Dep) {} }
  export class Dup {}
  export class CycleA { constructor(public b: CycleB) {} }
  export class CycleB { constructor(public a: CycleA) {} }
  export class Conn { dispose(): void {} }
  export class Holder { constructor(public conn: Conn) {} }

  export const container = defineBuilderConfig({
    name: 'P6Container',
    injections: [
      { token: NeedsMissing },
      { token: Dup },
      { token: Dup },
      { token: useInterface<IPort>(), provider: WrongImpl },
      { token: CycleA },
      { token: CycleB },
      { token: Conn, lifecycle: 'transient' },
      { token: Holder },
    ],
  });
`;

// No container here: only a resolve call that the container does not satisfy.
const CALLER = `
  import { container, Dep } from './container';
  export const missing = container.resolve(Dep);
`;

// A third-party package that depends on NeoSyringe and ships no tokens manifest: its token is an
// undeclared boundary (packages/core/src/analyzer/shared/tokensManifest.ts:66).
const BOUNDARY_CONTAINER = `
  import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';
  import type { Clock } from './node_modules/acme-logger/dist/index';

  export class NeedsClock { constructor(public clock: Clock) {} }

  export const container = defineBuilderConfig({
    name: 'BoundaryContainer',
    injections: [
      { token: useInterface<Clock>(), useValue: { now: () => 0 } },
      { token: NeedsClock },
    ],
  });
`;

const BOUNDARY_CALLER = 'export const untouched = 1;\n';

// A closed parent exports Shown only. The child reads Secret, which the parent keeps private.
const CLOSED_CONTAINER = `
  import { defineBuilderConfig } from '@djodjonx/neosyringe';

  export class Secret {}
  export class Shown {}
  export class NeedsSecret { constructor(public secret: Secret) {} }

  export const parent = defineBuilderConfig({
    name: 'ClosedParent',
    optimization: { mode: 'closed', roots: [Shown] },
    injections: [{ token: Shown }, { token: Secret }],
  });

  export const child = defineBuilderConfig({
    name: 'ClosedChild',
    useContainer: parent,
    injections: [{ token: NeedsSecret }],
  });
`;

const CLOSED_CALLER = 'export const untouched = 1;\n';

// The graph reports the duplicate; only the snapshot checks the return type of a factory.
const MIXED_CONTAINER = `
  import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';

  export interface IPort { id: number }
  export class Dup {}

  export const container = defineBuilderConfig({
    name: 'MixedContainer',
    injections: [
      { token: Dup },
      { token: Dup },
      { token: useInterface<IPort>(), useFactory: true, dependencies: [], provider: () => ({ name: 'x' }) },
    ],
  });
`;

const MIXED_CALLER = 'export const untouched = 1;\n';

let dir = '';
let previousCwd = '';
let containerText = CONTAINER;
let callerText = CALLER;

/** Writes the two files of the fixture the next consumers will read. */
function useFixture(container: string, caller: string): void {
  containerText = container;
  callerText = caller;
  writeFileSync(path.join(dir, 'container.ts'), container);
  writeFileSync(path.join(dir, 'caller.ts'), caller);
}

beforeAll(() => {
  previousCwd = process.cwd();
  dir = realpathSync(mkdtempSync(path.join(tmpdir(), 't03c1-p6-')));
  writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      target: 'ES2020',
      module: 'ESNext',
      moduleResolution: 'bundler',
      strict: true,
      skipLibCheck: true,
      lib: ['ES2020'],
      types: [],
      baseUrl: REPO,
      paths: { '@djodjonx/neosyringe': ['packages/neosyringe/src/index.ts'] },
    },
  }));
  const packageDist = path.join(dir, 'node_modules', 'acme-logger', 'dist');
  mkdirSync(packageDist, { recursive: true });
  writeFileSync(
    path.join(dir, 'node_modules', 'acme-logger', 'package.json'),
    JSON.stringify({ name: 'acme-logger', version: '1.0.0', dependencies: { '@djodjonx/neosyringe': '0.0.0' } }),
  );
  writeFileSync(path.join(packageDist, 'index.d.ts'), 'export interface Clock { now(): number }\n');
  useFixture(CONTAINER, CALLER);
  process.chdir(dir);
});

afterAll(() => {
  TSContext.reset();
  process.chdir(previousCwd);
  rmSync(dir, { recursive: true, force: true });
});

function programOf(): ts.Program {
  const config = ts.readConfigFile(path.join(dir, 'tsconfig.json'), ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dir, undefined, path.join(dir, 'tsconfig.json'));
  return ts.createProgram([path.join(dir, 'container.ts'), path.join(dir, 'caller.ts')], parsed.options);
}

function sorted(items: readonly NormalizedDiagnostic[]): NormalizedDiagnostic[] {
  return [...items].sort((left, right) =>
    left.file.localeCompare(right.file) || left.start - right.start || left.code.localeCompare(right.code));
}

function fromAnalysisErrors(errors: readonly AnalysisError[]): NormalizedDiagnostic[] {
  return sorted(errors.map(normalizeDiagnostic));
}

/** CLI: what main() calls — the analyzer's extractAllErrors, written by buildJsonReport. */
function viaCli(program: ts.Program): NormalizedDiagnostic[] {
  const errors = new Analyzer(program).extractAllErrors();
  const report = buildJsonReport(errors, dir);
  return sorted(report.errors.map((item) => {
    const file = path.join(dir, item.file);
    const text = readFileSync(file, 'utf8');
    const lines = text.split('\n');
    let start = 0;
    for (let index = 0; index < item.line - 1; index += 1) start += (lines[index] ?? '').length + 1;
    return {
      code: item.code ?? item.type,
      severity: item.severity,
      file,
      start: start + item.column - 1,
    };
  }));
}

const TYPE_OF_LSP_CODE: Record<number, string> = {
  9994: 'unsupported',
  9995: 'missing',
  9996: 'cycle',
  9997: 'type-mismatch',
  9998: 'duplicate',
};

interface FakeLspInfo {
  languageService: Pick<ts.LanguageService, 'getSemanticDiagnostics' | 'getProgram'>;
  project: {
    getCurrentDirectory(): string;
    projectService: { logger: { info(): void; loggingEnabled(): boolean; startGroup(): void; endGroup(): void } };
  };
}

/** The part of PluginCreateInfo the plugin reads, checked at run time before it is used as the whole. */
function isCreateInfo(value: FakeLspInfo): value is FakeLspInfo & ts.server.PluginCreateInfo {
  return typeof value.languageService.getProgram === 'function'
    && typeof value.languageService.getSemanticDiagnostics === 'function'
    && typeof value.project.getCurrentDirectory === 'function';
}

function fakeCreateInfo(program: ts.Program): ts.server.PluginCreateInfo {
  const info: FakeLspInfo = {
    languageService: { getSemanticDiagnostics: () => [], getProgram: () => program },
    project: {
      getCurrentDirectory: () => dir,
      projectService: { logger: { info: () => {}, loggingEnabled: () => false, startGroup: () => {}, endGroup: () => {} } },
    },
  };
  if (!isCreateInfo(info)) throw new Error('the fake plugin info is incomplete');
  return info;
}

/** LSP: the plugin's getSemanticDiagnostics, file by file. */
function viaLsp(program: ts.Program): NormalizedDiagnostic[] {
  const proxy = init({ typescript: ts }).create(fakeCreateInfo(program));
  const found: NormalizedDiagnostic[] = [];
  for (const file of [path.join(dir, 'container.ts'), path.join(dir, 'caller.ts')]) {
    for (const diagnostic of proxy.getSemanticDiagnostics(file)) {
      const text = typeof diagnostic.messageText === 'string' ? diagnostic.messageText : '';
      if (!text.includes('[NeoSyringe]')) continue;
      const named = /\[NeoSyringe\] (NEO_[A-Z_]+)/.exec(text);
      found.push({
        code: named?.[1] ?? TYPE_OF_LSP_CODE[diagnostic.code] ?? String(diagnostic.code),
        severity: diagnostic.category === ts.DiagnosticCategory.Warning ? 'warning' : 'error',
        file: diagnostic.file?.fileName ?? '',
        start: diagnostic.start ?? -1,
      });
    }
  }
  return sorted(found);
}

function analysisErrorsOf(error: unknown): AnalysisError[] {
  if (!(error instanceof Error)) throw new Error('an Error was expected');
  const carried = (error as Error & { analysisErrors?: AnalysisError[] }).analysisErrors;
  if (!carried) throw new Error(`the error carries no analysis errors: ${error.message}`);
  return carried;
}

function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error: unknown) {
    return error;
  }
  throw new Error('a throw was expected');
}

/** The analysis errors of a failure, none when the step did not fail. */
function failedWith(run: () => unknown): AnalysisError[] {
  try {
    run();
  } catch (error: unknown) {
    return analysisErrorsOf(error);
  }
  return [];
}

/** Bundler plugin: transform of each file, then buildEnd. The failures carry the analysis errors. */
function viaPlugin(): NormalizedDiagnostic[] {
  const plugin = neoSyringePlugin.vite({ project: 'tsconfig.json' });
  if (Array.isArray(plugin) || typeof plugin.transform !== 'function' || typeof plugin.buildEnd !== 'function') {
    throw new Error('hooks transform et buildEnd attendus');
  }
  const transform = plugin.transform as (code: string, id: string) => unknown;
  const buildEnd = plugin.buildEnd as () => void;
  const errors: AnalysisError[] = [];
  const containerFile = path.join(dir, 'container.ts');
  errors.push(...failedWith(() => transform(containerText, containerFile)));
  errors.push(...failedWith(() => transform(callerText, path.join(dir, 'caller.ts'))));
  errors.push(...failedWith(() => buildEnd()));
  return fromAnalysisErrors(errors);
}

const transformerExtras: ProgramTransformerExtras = { ts };

/** ts-patch transformer: one program, the failure of the container file, with the resolve calls added. */
function viaTransformer(program: ts.Program): NormalizedDiagnostic[] {
  return fromAnalysisErrors(failedWith(() => neoSyringeTransformer(program, undefined, {}, transformerExtras)));
}

describe('T03 C1 every consumer reports the same normalized diagnostics', () => {
  it('P6 CLI, LSP, plugin (transform + buildEnd) and transformer agree on one fixture', () => {
    useFixture(CONTAINER, CALLER);
    const cli = viaCli(programOf());
    const codes = cli.map((item) => item.code);
    expect(codes).toEqual(expect.arrayContaining([
      'NEO_MISSING_PROVIDER',
      'NEO_DUPLICATE_PROVIDER',
      'type-mismatch',
      'NEO_CYCLE',
      'NEO_DISPOSABLE_TRANSIENT_CAPTURED',
    ]));
    // The resolve call of a file with no container is part of the set.
    expect(cli.some((item) => item.file.endsWith('caller.ts') && item.code === 'NEO_MISSING_PROVIDER')).toBe(true);

    expect(viaLsp(programOf())).toEqual(cli);
    expect(viaPlugin()).toEqual(cli);
    expect(viaTransformer(programOf())).toEqual(cli);
  });

  it('W8 the build keeps the wording of the graph for a missing dependency and still carries the snapshot errors', () => {
    useFixture(CONTAINER, CALLER);
    const plugin = neoSyringePlugin.vite({ project: 'tsconfig.json' });
    if (Array.isArray(plugin) || typeof plugin.transform !== 'function') throw new Error('hook transform attendu');
    const transform = plugin.transform as (code: string, id: string) => unknown;
    const failure = thrown(() => transform(CONTAINER, path.join(dir, 'container.ts')));
    if (!(failure instanceof Error)) throw new Error('an Error was expected');
    // Token name and final dot: packages/core/src/generator/GraphValidator.ts:83, tests/e2e/t08-child-all-open-parent.test.ts:257.
    expect(failure.message).toContain("Missing injection: 'Dep' required by 'NeedsMissing' is not registered.");
    const carried = analysisErrorsOf(failure).map(normalizeDiagnostic);
    expect(carried.some((item) => item.code === 'NEO_MISSING_PROVIDER')).toBe(true);
  });

  it('W9 an undeclared token boundary is the same diagnostics for the CLI, the IDE, the build and the transformer, and extractAll does not throw', () => {
    useFixture(BOUNDARY_CONTAINER, BOUNDARY_CALLER);
    const cli = viaCli(programOf());
    const boundary = cli.filter((item) => item.code === 'NEO_TOKEN_BOUNDARY_UNSUPPORTED');
    const at = (start: number) => ({
      code: 'NEO_TOKEN_BOUNDARY_UNSUPPORTED',
      severity: 'error',
      file: path.join(dir, 'container.ts'),
      start,
    });
    // One per injection that reaches the boundary: the value of Clock, and the constructor of NeedsClock.
    expect(boundary).toEqual([
      at(BOUNDARY_CONTAINER.indexOf('{ token: useInterface<Clock>()')),
      at(BOUNDARY_CONTAINER.indexOf('{ token: NeedsClock }')),
    ]);
    expect(viaLsp(programOf())).toEqual(cli);
    expect(viaPlugin()).toEqual(cli);
    expect(viaTransformer(programOf())).toEqual(cli);

    // Base: extractAll threw a NeoTokenError here. The snapshot keeps the error on the graph instead.
    const graphs = new Analyzer(programOf()).extractAll();
    expect(graphs.flatMap((graph) => graph.errors ?? []).map((error) => error.code)).toContain('NEO_TOKEN_BOUNDARY_UNSUPPORTED');
  });

  it('W10 a private token of a closed parent read by the child is the same diagnostic for the CLI, the IDE, the build and the transformer', () => {
    useFixture(CLOSED_CONTAINER, CLOSED_CALLER);
    const cli = viaCli(programOf());
    // The child reads Secret, which the closed parent keeps private (the build path refused it already).
    expect(cli).toEqual([{
      code: 'NEO_MISSING_PROVIDER',
      severity: 'error',
      file: path.join(dir, 'container.ts'),
      start: CLOSED_CONTAINER.indexOf('token: NeedsSecret'),
    }]);
    expect(viaLsp(programOf())).toEqual(cli);
    expect(viaPlugin()).toEqual(cli);
    expect(viaTransformer(programOf())).toEqual(cli);
  });

  it('W11 the build names every blocking snapshot error, also the one the graph does not report', () => {
    useFixture(MIXED_CONTAINER, MIXED_CALLER);
    const plugin = neoSyringePlugin.vite({ project: 'tsconfig.json' });
    if (Array.isArray(plugin) || typeof plugin.transform !== 'function') throw new Error('hook transform attendu');
    const transform = plugin.transform as (code: string, id: string) => unknown;
    const failure = thrown(() => transform(MIXED_CONTAINER, path.join(dir, 'container.ts')));
    if (!(failure instanceof Error)) throw new Error('an Error was expected');
    const carried = analysisErrorsOf(failure);
    expect(carried.map((error) => error.type).sort()).toEqual(['duplicate', 'type-mismatch']);
    // One line per blocking snapshot error, each with the wording of its error.
    const lines = failure.message.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines.some((line) => line.includes("Duplicate registration: 'Dup' is already registered."))).toBe(true);
    expect(lines.some((line) => line.includes("Type mismatch: Provider '{ name: string; }' is not assignable to token type 'IPort'."))).toBe(true);
  });
});
