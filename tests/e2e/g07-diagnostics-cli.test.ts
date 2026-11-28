import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// G07 stage G: the same error in the CLI text, the CLI JSON and the language service plugin.
// Spawns the built CLI and loads the built LSP plugin, so it needs a fresh `pnpm build`.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const cli = path.join(repoRoot, 'packages/cli/dist/index.mjs');
const lspRequire = createRequire(path.join(repoRoot, 'packages/lsp/package.json'));

const STUB = `
  import { defineBuilderConfig } from '@djodjonx/neosyringe';
  function defineBuilderConfig(config: any) { return config; }
`;

// The provider is declared in b.ts, re-exported by barrel.ts and registered in app.ts.
const B_SOURCE = `
  export interface Absent { n: number }
  export class Needy { constructor(dep: Absent) {} }
`;
const BARREL_SOURCE = "export { Needy, type Absent } from './b';\n";
const APP_SOURCE = `${STUB}
  import { Needy } from './barrel';
  class CycA { constructor(b: CycB) {} }
  class CycB { constructor(c: CycC) {} }
  class CycC { constructor(a: CycA) {} }
  export const needy = defineBuilderConfig({
    name: 'Needy',
    injections: [
      { token: Needy },
    ],
  });
  export const cyc = defineBuilderConfig({ name: 'Cyc', injections: [{ token: CycA }, { token: CycB }, { token: CycC }] });
`;

interface JsonError {
  code: string;
  severity: string;
  file: string;
  line: number;
  column: number;
  type: string;
  message: string;
  containerName?: string;
  containerFile?: string;
  token?: string;
  chain?: string[];
  hint?: string;
}

interface JsonReport {
  schemaVersion: number;
  ok: boolean;
  errorCount: number;
  errors: JsonError[];
}

let scratch = '';
let project = '';

/** 1-based line and column of the first `needle` in `text`. */
function positionOf(text: string, needle: string): { line: number; column: number } {
  const offset = text.indexOf(needle);
  expect(offset, `missing ${needle}`).toBeGreaterThanOrEqual(0);
  const before = text.slice(0, offset).split('\n');
  return { line: before.length, column: (before[before.length - 1] ?? '').length + 1 };
}

function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd: project, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function jsonReport(): JsonReport {
  return JSON.parse(runCli(['--json']).stdout) as JsonReport;
}

function errorOf(report: JsonReport, code: string): JsonError {
  const found = report.errors.find((item) => item.code === code);
  if (!found) throw new Error(`no ${code} in ${JSON.stringify(report.errors.map((item) => item.code))}`);
  return found;
}

function messageOf(diagnostic: ts.Diagnostic): string {
  return typeof diagnostic.messageText === 'string' ? diagnostic.messageText : diagnostic.messageText.messageText;
}

describe('G07 actionable diagnostics, CLI text / JSON / LSP', () => {
  beforeAll(() => {
    scratch = mkdtempSync(path.join(tmpdir(), 'g07-diagnostics-'));
    project = path.join(scratch, 'app');
    mkdirSync(path.join(project, 'src'), { recursive: true });
    writeFileSync(path.join(project, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', strict: true, noEmit: true, lib: ['ES5'], types: [], skipLibCheck: true },
      include: ['src/**/*.ts'],
    }));
    writeFileSync(path.join(project, 'src/b.ts'), B_SOURCE);
    writeFileSync(path.join(project, 'src/barrel.ts'), BARREL_SOURCE);
    writeFileSync(path.join(project, 'src/app.ts'), APP_SOURCE);
  });

  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it('G07-P1 the text report prints code, dependency chain and a targeted fix for a missing provider and a cycle', () => {
    const result = runCli([]);
    const needy = positionOf(APP_SOURCE, 'token: Needy');
    // A cycle is reported at the whole registration of the last token of the chain, a missing provider at its `token` property.
    const lastCycle = positionOf(APP_SOURCE, '{ token: CycC }');

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`src/app.ts:${needy.line}:${needy.column} error NEO_MISSING_PROVIDER`);
    expect(result.stderr).toContain('Dependency chain: Needy -> Absent');
    expect(result.stderr).toMatch(/^Fix: .*'Absent'.*'Needy'/m);
    expect(result.stderr).toContain(`src/app.ts:${lastCycle.line}:${lastCycle.column} error NEO_CYCLE`);
    expect(result.stderr).toContain('Dependency chain: CycA -> CycB -> CycC -> CycA');
    expect(result.stderr).toMatch(/^Fix: .*cycle/im);
  });

  it('G07-M6 the fatal JSON the CLI prints, with its keys in that order, is the example of the CLI guide', () => {
    const empty = path.join(scratch, 'empty');
    mkdirSync(empty, { recursive: true });
    const run = spawnSync(process.execPath, [cli, '--json'], { cwd: empty, encoding: 'utf8' });
    const printed = JSON.parse(run.stdout) as Record<string, unknown>;
    const guide = readFileSync(path.join(repoRoot, 'docs/guide/cli.md'), 'utf8');

    expect(run.status).toBe(1);
    expect(Object.keys(printed)).toEqual(['schemaVersion', 'ok', 'errorCount', 'errors', 'fatal']);
    expect(guide).toContain(JSON.stringify({ ...printed, fatal: '<message>' }));
  });

  it('G07-P2 the JSON report returns code, position, chain and hint as fields and keeps the existing ones', () => {
    const report = jsonReport();
    const needy = positionOf(APP_SOURCE, 'token: Needy');
    const missing = errorOf(report, 'NEO_MISSING_PROVIDER');

    expect(report.schemaVersion).toBe(1);
    expect(missing).toMatchObject({
      code: 'NEO_MISSING_PROVIDER',
      severity: 'error',
      file: 'src/app.ts',
      line: needy.line,
      column: needy.column,
      type: 'missing',
      containerName: 'Needy',
      containerFile: 'src/app.ts',
      token: 'Absent',
      chain: ['Needy', 'Absent'],
    });
    expect(missing.hint).toBeDefined();
    expect(missing.hint).toMatch(/'Absent'.*'Needy'/);
    expect(errorOf(report, 'NEO_CYCLE').chain).toEqual(['CycA', 'CycB', 'CycC', 'CycA']);
    expect(errorOf(report, 'NEO_CYCLE').hint).toBeDefined();
    expect(errorOf(report, 'NEO_CYCLE').hint).toMatch(/cycle/i);
  });

  it('G07-P2 the text fix line and the JSON hint are the same sentence', () => {
    const text = runCli([]).stderr;
    const missing = errorOf(jsonReport(), 'NEO_MISSING_PROVIDER');

    expect(missing.hint).toBeDefined();
    expect(text).toContain(`Fix: ${missing.hint}`);
  });

  it('G07-P4 the position is the registration in app.ts, through a re-export, not the start of defineBuilderConfig', () => {
    const registration = positionOf(APP_SOURCE, 'token: Needy');
    const configStart = positionOf(APP_SOURCE, 'defineBuilderConfig({\n    name: \'Needy\'');
    const missing = errorOf(jsonReport(), 'NEO_MISSING_PROVIDER');
    const text = runCli([]).stderr;

    expect(registration.line).not.toBe(configStart.line);
    expect(text.split('\n')).toContain(`src/app.ts:${registration.line}:${registration.column} error NEO_MISSING_PROVIDER`);
    expect({ line: missing.line, column: missing.column }).toEqual(registration);
  });

  it('G07-P3 the language service plugin reports the same code and source, with the chain and the fix of the CLI', () => {
    const program = ts.createProgram([path.join(project, 'src/app.ts')], {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      strict: true,
      noEmit: true,
      lib: ['lib.es5.d.ts'],
      types: [],
      skipLibCheck: true,
    });
    const appFile = path.join(project, 'src/app.ts');
    const sourceFile = program.getSourceFile(appFile);
    if (!sourceFile) throw new Error('missing app.ts in the program');
    const init: (modules: { typescript: typeof ts }) => { create: (info: never) => ts.LanguageService } = lspRequire('./dist/index.cjs');
    const plugin = init({ typescript: ts });
    const service = plugin.create({
      languageService: { getSemanticDiagnostics: () => [], getProgram: () => program },
      project: { projectService: { logger: { info: () => {}, loggingEnabled: () => false, startGroup: () => {}, endGroup: () => {} } } },
    } as never);
    const published = service.getSemanticDiagnostics(appFile);
    const lsp = published.find((item) => messageOf(item).includes('NEO_MISSING_PROVIDER'));
    const cliError = errorOf(jsonReport(), 'NEO_MISSING_PROVIDER');
    const cliText = runCli([]).stderr;

    expect(lsp).toBeDefined();
    if (!lsp || lsp.start === undefined) return;
    const where = sourceFile.getLineAndCharacterOfPosition(lsp.start);
    expect({ line: where.line + 1, column: where.character + 1 }).toEqual({ line: cliError.line, column: cliError.column });
    const related = (lsp.relatedInformation ?? []).map((item) => messageOf(item));
    expect(related).toContain('Dependency chain: Needy -> Absent');
    expect(related).toContain(`Fix: ${cliError.hint}`);
    expect(cliText).toContain(`Fix: ${cliError.hint}`);
  });
});
