import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as ts from 'typescript';
import { Analyzer } from '../../core/src/analyzer/Analyzer.js';
import type { AnalysisError, DependencyGraph } from '../../core/src/analyzer/types.js';
import { createFastProgram, warmLibCache } from '../../core/tests/fastProgram';
import { attributeErrors, containerLookupOf } from '../../core/src/analyzer/errors';
import { renderRetentionReport, runExplain, writeRetentionReport } from '../src/explain';
import { serializeGraphs } from '../src/graphExport';
import { buildFatalReport, buildJsonReport, CLI_USAGE, findUsageError, parseArgs } from '../src/report';

const ROOT = '/virtual/t19-cli';
const README = fileURLToPath(new URL('../README.md', import.meta.url));
const REPO = fileURLToPath(new URL('../../..', import.meta.url));
const REAL = `import { defineBuilderConfig, type Container } from '@djodjonx/neosyringe';`;

const STUB = `
  import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';
  function defineBuilderConfig(config: any) { return config; }
  function useInterface<T>(): any { return null; }
`;

const DIAMOND = path.join(ROOT, 'diamond.ts');
const OTHER = path.join(ROOT, 'other.ts');
const OPAQUE = path.join(ROOT, 'opaque.ts');
const MISSING = path.join(ROOT, 'missing.ts');
const CYCLE = path.join(ROOT, 'cycle.ts');
const DUPLICATE = path.join(ROOT, 'duplicate.ts');
const SUPPLIER = path.join(ROOT, 'supplier.ts');
const NEEDY = path.join(ROOT, 'needy.ts');
const TWO = path.join(ROOT, 'two.ts');
const PARTS = path.join(ROOT, 'parts.ts');
const STRAY_TWO = path.join(ROOT, 'stray-two.ts');
const STRAY_ONE = path.join(ROOT, 'stray-one.ts');

const files = new Map<string, string>([
  [DIAMOND, `${STUB}
    class CliD {}
    class CliB { constructor(d: CliD) {} }
    class CliC { constructor(d: CliD) {} }
    class CliRoot { constructor(b: CliB, c: CliC) {} }
    export const diamond = defineBuilderConfig({
      name: 'CliDiamond',
      optimization: { mode: 'closed', roots: [CliRoot] },
      injections: [{ token: CliRoot }, { token: CliB }, { token: CliC }, { token: CliD }],
    });
  `],
  [OTHER, `${STUB}
    interface CliOnlyHere { n: number }
    const only = useInterface<CliOnlyHere>();
    export const other = defineBuilderConfig({
      name: 'CliOther',
      optimization: { mode: 'closed', roots: [only] },
      injections: [{ token: only, useFactory: true, dependencies: [], provider: () => ({ n: 1 }) }],
    });
  `],
  [OPAQUE, `${STUB}
    interface CliOpaque { n: number }
    const host = useInterface<CliOpaque>();
    export const opaque = defineBuilderConfig({
      name: 'CliOpaque',
      injections: [{ token: host, useFactory: true, provider: () => ({ n: 1 }) }],
    });
  `],
  [MISSING, `${STUB}
    interface CliAbsent { n: number }
    class CliNeeds { constructor(dep: CliAbsent) {} }
    export const missing = defineBuilderConfig({ name: 'CliMissing', injections: [{ token: CliNeeds }] });
  `],
  [CYCLE, `${STUB}
    class CliCycA { constructor(b: CliCycB) {} }
    class CliCycB { constructor(a: CliCycA) {} }
    export const cycle = defineBuilderConfig({ name: 'CliCycle', injections: [{ token: CliCycA }, { token: CliCycB }] });
  `],
  [SUPPLIER, `${STUB}
    export interface CliNeeded { n: number }
    export const supplier = defineBuilderConfig({
      name: 'CliSupplier',
      injections: [{ token: useInterface<CliNeeded>(), useFactory: true, dependencies: [], provider: () => ({ n: 1 }) }],
    });
  `],
  [NEEDY, `${STUB}
    import type { CliNeeded } from './supplier';
    class CliNeedy { constructor(dep: CliNeeded) {} }
    export const needy = defineBuilderConfig({ name: 'CliNeedy', injections: [{ token: CliNeedy }] });
  `],
  [TWO, `${STUB}
    class CliTwoDup {}
    export const twoA = defineBuilderConfig({ name: 'CliTwoA', injections: [{ token: CliTwoDup }, { token: CliTwoDup }] });
    class CliTwoFine {}
    export const twoB = defineBuilderConfig({ name: 'CliTwoB', injections: [{ token: CliTwoFine }] });
  `],
  [PARTS, `${STUB}
    interface CliPart { n: number }
    interface CliPartsRoot { n: number }
    const part = useInterface<CliPart>();
    const root = useInterface<CliPartsRoot>();
    export const parts = defineBuilderConfig({
      name: 'CliParts',
      optimization: { mode: 'closed', roots: [root] },
      injections: [
        { token: root, useFactory: true, dependencies: [{ all: part }], provider: (ctx) => ({ n: ctx.resolveAll(part).length }) },
        { token: part, multi: true, useFactory: true, dependencies: [], provider: () => ({ n: 1 }) },
        { token: part, multi: true, useFactory: true, dependencies: [], provider: () => ({ n: 2 }) },
      ],
    });
  `],
  [STRAY_TWO, `${REAL}
    class CliStrayOne {}
    export const strayA = defineBuilderConfig({ name: 'CliStrayA', injections: [{ token: CliStrayOne }] });
    class CliStrayTwo {}
    export const strayB = defineBuilderConfig({ name: 'CliStrayB', injections: [{ token: CliStrayTwo }] });
    function pickStray(): Container { return strayA; }
    pickStray().resolve(CliStrayOne);
  `],
  [STRAY_ONE, `${REAL}
    class CliLoneService {}
    export const loneBox = defineBuilderConfig({ name: 'CliLone', injections: [{ token: CliLoneService }] });
    function pickLone(): Container { return loneBox; }
    pickLone().resolve(CliLoneService);
  `],
  [DUPLICATE, `${STUB}
    class CliDup {}
    export const duplicate = defineBuilderConfig({ name: 'CliDuplicate', injections: [{ token: CliDup }, { token: CliDup }] });
  `],
]);

function programFrom(sources: Map<string, string>): ts.Program {
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    noImplicitAny: false,
    baseUrl: REPO,
    paths: { '@djodjonx/neosyringe': ['packages/neosyringe/src/index.ts'] },
  };
  const host = ts.createCompilerHost(options);
  const read = host.getSourceFile.bind(host);
  const exists = host.fileExists.bind(host);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
    const text = sources.get(fileName);
    if (text !== undefined) return ts.createSourceFile(fileName, text, languageVersion, true);
    return read(fileName, languageVersion, onError, shouldCreateNewSourceFile);
  };
  host.fileExists = (fileName) => sources.has(fileName) || exists(fileName);
  const directoryExists = host.directoryExists?.bind(host);
  host.directoryExists = (directory) => directory === ROOT || (directoryExists?.(directory) ?? false);
  return createFastProgram([...sources.keys()], options, host);
}

describe('T19 CLI explain and report', () => {
  let graphs: DependencyGraph[];
  let strictErrors: AnalysisError[];
  let compatibleErrors: AnalysisError[];
  let outDir: string;

  beforeAll(() => {
    warmLibCache();
    const program = programFrom(files);
    graphs = new Analyzer(program).extractAll();
    strictErrors = new Analyzer(program).extractAllErrors();
    compatibleErrors = new Analyzer(program, { validation: 'compatible' }).extractAllErrors();
    outDir = mkdtempSync(path.join(tmpdir(), 't19-cli-'));
  });

  afterAll(() => {
    rmSync(outDir, { recursive: true, force: true });
    graphs = [];
    strictErrors = [];
    compatibleErrors = [];
  });

  it('T19-A05 schemaVersion survives a reworded message', () => {
    const missing = strictErrors.find((error) => error.code === 'NEO_MISSING_PROVIDER' && error.sourceFile.fileName === MISSING);
    if (!missing) throw new Error('missing provider error not produced');
    const original = JSON.parse(JSON.stringify(buildJsonReport([missing], ROOT)));
    const reworded = JSON.parse(JSON.stringify(buildJsonReport([{ ...missing, message: 'Another human sentence' }], ROOT)));

    expect(original.schemaVersion).toBe(1);
    expect(JSON.parse(JSON.stringify(buildJsonReport([], ROOT))).schemaVersion).toBe(1);
    expect(original.errors[0].code).toBe('NEO_MISSING_PROVIDER');
    expect(reworded.errors[0].code).toBe(original.errors[0].code);
    expect(reworded.errors[0].message).toBe('Another human sentence');
    expect(reworded.errors[0].message).not.toBe(original.errors[0].message);
  });

  it('T19 fatal report is versioned', () => {
    expect(JSON.parse(JSON.stringify(buildFatalReport('boom')))).toEqual({
      schemaVersion: 1,
      ok: false,
      errorCount: 0,
      errors: [],
      fatal: 'boom',
    });
  });

  it('T19 flags parse and are documented', () => {
    expect(parseArgs(['--explain', 'CliD', '--container', 'CliDiamond'])).toMatchObject({
      explain: 'CliD',
      container: 'CliDiamond',
      retentionReport: false,
      help: false,
    });
    expect(parseArgs(['--retention-report'])).toMatchObject({ retentionReport: true });
    expect(parseArgs(['--retention-report', 'out/r.json'])).toMatchObject({ retentionReport: 'out/r.json' });
    expect(parseArgs(['--retention-report', '--json']).retentionReport).toBe(true);
    expect(parseArgs(['--help']).help).toBe(true);
    expect(parseArgs(['--explain', '--json']).explain).toBeUndefined();
    expect(parseArgs([])).toMatchObject({ explain: undefined, container: undefined, retentionReport: false, help: false });

    const readme = readFileSync(README, 'utf8');
    for (const flag of ['--explain <token>', '--container <name|key>', '--retention-report [path]', '--help']) {
      expect(CLI_USAGE).toContain(flag);
      expect(readme).toContain(flag);
    }
    expect(readme).toContain('schemaVersion');
    for (const cause of ['root', 'eager', 'dependency-of', 'multi-contribution-of', 'open-parent', 'opaque-boundary', 'unreachable']) {
      expect(readme).toContain(`\`${cause}\``);
    }
    expect(readme).toContain('no size');
  });

  it('T19 explain exits 0 when found and 1 when absent', () => {
    const found = runExplain(graphs, 'CliD', { json: true, cwd: ROOT });
    const report = JSON.parse(found.output);
    expect(found.exitCode).toBe(0);
    expect(report.schemaVersion).toBe(1);
    expect(report.results).toHaveLength(1);
    expect(report.results[0]).toMatchObject({ found: true, cause: 'dependency-of', path: ['CliRoot', 'CliB', 'CliD'], sourceFile: 'diamond.ts' });

    const text = runExplain(graphs, 'CliD', { json: false, cwd: ROOT });
    expect(text.exitCode).toBe(0);
    expect(text.output).toContain('dependency-of');
    for (const name of ['CliRoot', 'CliB', 'CliD', 'diamond.ts']) expect(text.output).toContain(name);

    const absent = runExplain(graphs, 'CliOnlyHere', { container: 'CliDiamond', json: true, cwd: ROOT });
    expect(absent.exitCode).toBe(1);
    expect(JSON.parse(absent.output).results[0]).toMatchObject({ found: false, containerName: 'CliDiamond', sourceFile: 'diamond.ts' });
    expect(runExplain(graphs, 'CliOnlyHere', { container: 'CliOther', json: true, cwd: ROOT }).exitCode).toBe(0);
    expect(runExplain(graphs, 'NoSuchToken', { json: false, cwd: ROOT })).toMatchObject({ exitCode: 1 });
    expect(runExplain(graphs, 'NoSuchToken', { json: false, cwd: ROOT }).output).toContain('NoSuchToken');
  });

  it('T19 retention report is written and printed', () => {
    const target = path.join(outDir, 'nested', 'retention.json');
    const written = writeRetentionReport(graphs, target, outDir);
    const fromFile = JSON.parse(readFileSync(written, 'utf8'));
    const printed = JSON.parse(renderRetentionReport(graphs, ROOT));

    expect(written).toBe(target);
    expect(fromFile.schemaVersion).toBe(1);
    expect(fromFile.containers.length).toBe(graphs.length);
    expect(printed.schemaVersion).toBe(1);
    expect(printed.containers.map((item: { containerName: string }) => item.containerName)).toEqual(graphs.map((graph) => graph.containerName));
    expect(printed.containers[0].sourceFile).toBe('diamond.ts');
    expect(printed.containers[0].entries.map((entry: { token: string }) => entry.token)).toEqual(['CliRoot', 'CliB', 'CliC', 'CliD']);
  });

  it('T19 warning stays a warning', () => {
    const warning = compatibleErrors.find((error) => error.code === 'NEO_FACTORY_DEPENDENCIES_REQUIRED');
    if (!warning) throw new Error('opaque warning not produced');
    const entry = JSON.parse(JSON.stringify(buildJsonReport([warning], ROOT))).errors[0];

    expect(warning.severity).toBe('warning');
    expect(entry.severity).toBe('warning');
    expect(entry.code).toBe('NEO_FACTORY_DEPENDENCIES_REQUIRED');
  });

  it('T19 JSON diagnostic fields', () => {
    const missing = strictErrors.find((error) => error.code === 'NEO_MISSING_PROVIDER' && error.sourceFile.fileName === MISSING);
    const cycle = strictErrors.find((error) => error.type === 'cycle' && error.sourceFile.fileName === CYCLE);
    const duplicate = strictErrors.find((error) => error.type === 'duplicate' && error.sourceFile.fileName === DUPLICATE);
    if (!missing || !cycle || !duplicate) throw new Error('expected diagnostics were not produced');
    const report = JSON.parse(JSON.stringify(buildJsonReport([missing, cycle, duplicate], ROOT)));

    expect(report.errorCount).toBe(3);
    expect(report.errors[0]).toMatchObject({ code: 'NEO_MISSING_PROVIDER', severity: 'error', file: 'missing.ts', type: 'missing', token: 'CliAbsent', chain: ['CliNeeds', 'CliAbsent'] });
    expect(report.errors[0].line).toBeGreaterThan(0);
    expect(report.errors[0].column).toBeGreaterThan(0);
    expect(report.errors[1]).toMatchObject({ code: 'NEO_CYCLE', severity: 'error' });
    expect(report.errors[1].chain).toHaveLength(3);
    expect(report.errors[2]).toMatchObject({ code: 'NEO_DUPLICATE_PROVIDER', severity: 'error' });
  });

  it('T19 dash-led values are flags, not values', () => {
    expect(parseArgs(['--retention-report', '-p', 'tsconfig.json'])).toMatchObject({
      retentionReport: true,
      project: 'tsconfig.json',
    });
    expect(parseArgs(['--explain', '-p', 'tsconfig.json'])).toMatchObject({ explain: undefined, project: 'tsconfig.json' });
    expect(parseArgs(['--explain', 'CliD', '--container', '-p']).container).toBeUndefined();
    expect(parseArgs(['--retention-report', 'out/r.json']).retentionReport).toBe('out/r.json');
  });

  it('T19 flag combinations are checked', () => {
    const check = (argv: string[]) => findUsageError(argv, parseArgs(argv));

    expect(check([])).toBeUndefined();
    expect(check(['--json', '--retention-report', 'out.json'])).toBeUndefined();
    expect(check(['--explain', 'CliD'])).toBeUndefined();
    expect(check(['--explain', 'CliD', '--container', 'CliDiamond', '--json'])).toBeUndefined();
    expect(check(['--retention-report'])).toBeUndefined();
    expect(check(['--retention-report', '--graph', 'g.html'])).toBeUndefined();
    expect(check(['--explain'])).toBeDefined();
    expect(check(['--explain', '--json'])).toBeDefined();
    expect(check(['--container', 'CliDiamond'])).toBeDefined();
    expect(check(['--explain', 'CliD', '--container'])).toBeDefined();
    expect(check(['--explain', 'CliD', '--retention-report'])).toBeDefined();
    expect(check(['--explain', 'CliD', '--retention-report', 'r.json'])).toBeDefined();
    expect(check(['--explain', 'CliD', '--graph'])).toBeDefined();
    expect(check(['--explain', 'CliD', '--mermaid'])).toBeDefined();
    expect(check(['--retention-report', '--json'])).toBeDefined();
    expect(check(['--retention-report', '--mermaid'])).toBeDefined();
  });

  it('T19 exit codes and flag combinations are documented', () => {
    const readme = readFileSync(README, 'utf8');
    for (const text of [readme, CLI_USAGE]) {
      expect(text).toContain('exit 2');
      expect(text).toContain('containerFound');
    }
    expect(readme).toContain('--explain');
    expect(readme).toContain('stdout');
  });

  it('T19 unknown container is told apart from an absent token', () => {
    const unknown = runExplain(graphs, 'CliD', { container: 'NoSuchContainer', json: true, cwd: ROOT });
    const text = runExplain(graphs, 'CliD', { container: 'NoSuchContainer', json: false, cwd: ROOT });
    const absent = runExplain(graphs, 'CliOnlyHere', { container: 'CliDiamond', json: false, cwd: ROOT });

    expect(unknown.exitCode).toBe(1);
    expect(JSON.parse(unknown.output).results).toEqual([
      { found: false, token: 'CliD', containerFound: false, container: 'NoSuchContainer' },
    ]);
    expect(text.exitCode).toBe(1);
    expect(text.output).toContain('NoSuchContainer');
    expect(text.output).not.toBe(absent.output);
    expect(absent.output).toContain('CliDiamond');
    expect(absent.output).not.toContain('NoSuchContainer');
  });

  it('T19 several matches in one container show their registration ids', () => {
    const run = runExplain(graphs, 'CliPart', { json: false, cwd: ROOT });
    const lines = run.output.split('\n').filter((line) => line.includes('is kept'));
    const ids = (JSON.parse(runExplain(graphs, 'CliPart', { json: true, cwd: ROOT }).output).results as { registrationId: string }[])
      .map((result) => result.registrationId);

    expect(run.exitCode).toBe(0);
    expect(lines).toHaveLength(2);
    expect(new Set(lines).size).toBe(2);
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) expect(run.output).toContain(id);
    const single = runExplain(graphs, 'CliD', { json: false, cwd: ROOT });
    expect(single.output).not.toContain(JSON.parse(runExplain(graphs, 'CliD', { json: true, cwd: ROOT }).output).results[0].registrationId);
  });

  it('T19-A04 missing provider diagnostic names its container and source', () => {
    const needy = graphs.find((graph) => graph.containerName === 'CliNeedy');
    const supplier = graphs.find((graph) => graph.containerName === 'CliSupplier');
    const missing = strictErrors.find((error) => error.code === 'NEO_MISSING_PROVIDER' && error.sourceFile.fileName === NEEDY);
    if (!needy || !supplier || !missing) throw new Error('fixture not produced');

    expect(missing.containerId).toBeUndefined();
    const entry = JSON.parse(JSON.stringify(buildJsonReport([missing], ROOT, containerLookupOf(graphs)))).errors[0];
    expect(entry).toMatchObject({
      code: 'NEO_MISSING_PROVIDER',
      containerId: needy.containerKey,
      containerName: 'CliNeedy',
      containerFile: 'needy.ts',
      file: 'needy.ts',
    });
    expect(entry.containerId).not.toBe(supplier.containerKey);
    const owned = attributeErrors(graphs, strictErrors);
    const serializedNeedy = serializeGraphs(graphs, strictErrors).find((item) => item.containerName === 'CliNeedy');
    const diagnostic = serializedNeedy?.diagnostics?.find((item) => item.code === 'NEO_MISSING_PROVIDER');
    expect(diagnostic).toMatchObject({
      containerId: entry.containerId,
      containerName: entry.containerName,
      containerFile: NEEDY,
      file: NEEDY,
    });
    expect(owned.get(supplier)?.some((error) => error.code === 'NEO_MISSING_PROVIDER')).toBe(false);
  });

  it('T19 errors are attributed to their own container', () => {
    const twoA = graphs.find((graph) => graph.containerName === 'CliTwoA');
    const twoB = graphs.find((graph) => graph.containerName === 'CliTwoB');
    const duplicate = strictErrors.find((error) => error.type === 'duplicate' && error.sourceFile.fileName === TWO);
    if (!twoA || !twoB || !duplicate) throw new Error('fixture not produced');
    const owned = attributeErrors(graphs, strictErrors);

    expect(duplicate.containerId).toBeUndefined();
    expect(owned.get(twoA)).toContain(duplicate);
    expect(owned.get(twoB)).not.toContain(duplicate);
    for (const graph of graphs) {
      for (const error of owned.get(graph) ?? []) expect(error.sourceFile.fileName).toBe(graph.sourceFileName);
    }
    expect(attributeErrors(graphs, []).get(twoA)).toEqual([]);
  });

  it('T19 devtools and CLI JSON agree on code and severity', () => {
    const warning = compatibleErrors.find((error) => error.code === 'NEO_FACTORY_DEPENDENCIES_REQUIRED');
    const opaque = graphs.find((graph) => graph.containerName === 'CliOpaque');
    if (!warning || !opaque) throw new Error('fixture not produced');
    const owned = attributeErrors(graphs, compatibleErrors);
    const serialized = serializeGraphs(graphs, compatibleErrors).find((item) => item.containerName === 'CliOpaque')?.diagnostics ?? [];
    const json = buildJsonReport(owned.get(opaque) ?? [], ROOT, containerLookupOf(graphs)).errors;

    expect(serialized.length).toBeGreaterThan(0);
    expect(serialized.map(({ code, severity }) => ({ code, severity }))).toEqual(json.map(({ code, severity }) => ({ code, severity })));
    expect(serialized.find((item) => item.code === 'NEO_FACTORY_DEPENDENCIES_REQUIRED')?.severity).toBe('warning');
  });

  it('T19 a diagnostic outside every container range names no container', () => {
    const outside = strictErrors.filter((error) => error.code === 'NEO_UNKNOWN_CONTAINER'
      && (error.sourceFile.fileName === STRAY_TWO || error.sourceFile.fileName === STRAY_ONE));
    expect(outside.map((error) => error.sourceFile.fileName).sort()).toEqual([STRAY_ONE, STRAY_TWO]);

    for (const error of outside) {
      expect(error.containerId).toBeUndefined();
      const entry = JSON.parse(JSON.stringify(buildJsonReport([error], ROOT, containerLookupOf(graphs)))).errors[0];
      expect(entry.code).toBe('NEO_UNKNOWN_CONTAINER');
      expect(entry.line).toBeGreaterThan(0);
      expect(entry).not.toHaveProperty('containerId');
      expect(entry).not.toHaveProperty('containerName');
      expect(entry).not.toHaveProperty('containerFile');

      const shown = serializeGraphs(graphs, strictErrors)
        .filter((item) => item.sourceFileName === error.sourceFile.fileName)
        .flatMap((item) => (item.diagnostics ?? []).filter((diagnostic) => diagnostic.code === 'NEO_UNKNOWN_CONTAINER'));
      expect(shown.length).toBeGreaterThan(0);
      for (const diagnostic of shown) {
        expect(diagnostic).not.toHaveProperty('containerId');
        expect(diagnostic).not.toHaveProperty('containerName');
        expect(diagnostic).not.toHaveProperty('containerFile');
      }
    }
  });
});
