import path from 'node:path';
import ts from 'typescript';
import { assertDistFresh } from './execute-fixture';

// Runs the built core with `validation: 'compatible'`. The plugin has no such path:
// packages/unplugin/src/session.ts:527 builds its Analyzer without options.
const COMPAT_FILE = path.join(process.cwd(), 'tests/e2e/fixtures/t20-compat-program.ts');

export type CompatOutcome =
  | { phase: 'build'; errors: string[] }
  | { phase: 'runtime'; error: string }
  | { phase: 'ok'; value: unknown; warnings: string[] };

interface CompatGraph {
  errors?: { message: string; severity?: 'error' | 'warning' }[];
  sourceFileName?: string;
  variableStatementStart?: number;
  defineBuilderConfigStart?: number;
  defineBuilderConfigEnd?: number;
}

interface CoreAnalyzerModule {
  Analyzer: new (program: ts.Program, options?: { validation?: 'strict' | 'compatible' }) => {
    extractAll(): CompatGraph[];
  };
}

interface CoreGeneratorModule {
  Generator: new (
    graph: CompatGraph,
    useDirectSymbolNames: boolean,
    outputDir: string | undefined,
    emitDebugHelpers: boolean,
    testOverrides: boolean,
  ) => { generate(): string; generateInstantiation(): string };
}

function programFor(source: string): ts.Program {
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    types: [],
    baseUrl: process.cwd(),
    paths: { '@djodjonx/neosyringe': ['packages/neosyringe/src'] },
  };
  const host = ts.createCompilerHost(options);
  const read = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) => (
    fileName === COMPAT_FILE
      ? ts.createSourceFile(fileName, source, languageVersion, true)
      : read(fileName, languageVersion, onError, shouldCreate)
  );
  host.fileExists = (fileName) => fileName === COMPAT_FILE || ts.sys.fileExists(fileName);
  return ts.createProgram([COMPAT_FILE], options, host);
}

/** Analyzes with `validation: 'compatible'`, generates like the plugin does, runs `run()`. */
export async function executeCompatible(source: string, testOverrides: boolean): Promise<CompatOutcome> {
  assertDistFresh(path.join(process.cwd(), 'packages/core/dist/analyzer/index.mjs'), path.join(process.cwd(), 'packages/core/src'));
  const analyzerModule = await import('../../../packages/core/dist/analyzer/index.mjs') as unknown as CoreAnalyzerModule;
  const generatorModule = await import('../../../packages/core/dist/generator/index.mjs') as unknown as CoreGeneratorModule;
  const graphs = new analyzerModule.Analyzer(programFor(source), { validation: 'compatible' }).extractAll();
  const all = graphs.flatMap((graph) => graph.errors ?? []);
  const errors = all.filter((error) => error.severity !== 'warning').map((error) => error.message);
  if (errors.length > 0) return { phase: 'build', errors };
  const warnings = all.filter((error) => error.severity === 'warning').map((error) => error.message);

  let transformed = source;
  const spliced = [...graphs]
    .filter((graph) => graph.variableStatementStart !== undefined)
    .sort((a, b) => (b.variableStatementStart ?? 0) - (a.variableStatementStart ?? 0));
  for (const graph of spliced) {
    const start = graph.variableStatementStart ?? 0;
    const declarationEnd = graph.defineBuilderConfigStart ?? start;
    const end = graph.defineBuilderConfigEnd ?? start;
    const generator = new generatorModule.Generator(graph, true, undefined, false, testOverrides);
    const declaration = transformed.slice(start, declarationEnd);
    transformed = `${transformed.slice(0, start)}${generator.generate()}\n${declaration}${generator.generateInstantiation()}${transformed.slice(end)}`;
  }

  const javascript = ts.transpileModule(transformed, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const record: { exports: { run?: () => unknown } } = { exports: {} };
  const execute = new Function('module', 'exports', 'require', javascript) as (
    module: typeof record,
    exports: typeof record.exports,
    require: (specifier: string) => unknown,
  ) => void;
  try {
    execute(record, record.exports, () => ({}));
    const run = record.exports.run;
    if (typeof run !== 'function') return { phase: 'runtime', error: 'fixture did not export run' };
    return { phase: 'ok', value: await run(), warnings };
  } catch (error) {
    return { phase: 'runtime', error: error instanceof Error ? error.message : String(error) };
  }
}
