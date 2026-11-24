import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as ts from 'typescript';
import { Analyzer } from '../../src/analyzer/Analyzer';
import type { DependencyGraph } from '../../src/analyzer/types';
import { Generator } from '../../src/generator/Generator';
import { GraphValidator } from '../../src/generator/GraphValidator';
import { createFastProgram, warmLibCache } from '../fastProgram';

const STUB_NAME = '/virtual/t13-depth-stub.ts';
const STUB_TEXT = 'export function defineBuilderConfig<T>(config: T): T { return config; }\n';

function chainSource(depth: number): string {
  const classes: string[] = [];
  for (let index = 0; index < depth; index += 1) {
    const next = index + 1 < depth ? `S${index + 1}` : '';
    const ctor = next === '' ? '' : `constructor(public d0: ${next}) {}`;
    classes.push(`class S${index} { value = ${index}; ${ctor} }`);
  }
  const injections = Array.from({ length: depth }, (_, index) => `{ token: S${index} }`).join(', ');
  return `import { defineBuilderConfig } from '@djodjonx/neosyringe';
${classes.join('\n')}
export const box = defineBuilderConfig({
  name: 'Depth',
  optimization: { mode: 'open' },
  runtime: { profile: 'full' },
  injections: [${injections}],
});
`;
}

function programOf(fileName: string, source: string): ts.Program {
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    strict: true,
    noImplicitAny: false,
  };
  const sources = new Map<string, string>([[fileName, source], [STUB_NAME, STUB_TEXT]]);
  const host = ts.createCompilerHost(options);
  const read = host.getSourceFile.bind(host);
  const exists = host.fileExists.bind(host);
  host.getSourceFile = (name, languageVersion, onError, shouldCreateNewSourceFile) => {
    const text = sources.get(name);
    if (text !== undefined) return ts.createSourceFile(name, text, languageVersion, true);
    return read(name, languageVersion, onError, shouldCreateNewSourceFile);
  };
  host.fileExists = (name) => sources.has(name) || exists(name);
  host.resolveModuleNames = (names, containing) => names.map((name) => {
    if (name === '@djodjonx/neosyringe') {
      return { resolvedFileName: STUB_NAME, extension: ts.Extension.Ts, isExternalLibraryImport: false };
    }
    return ts.resolveModuleName(name, containing, options, host).resolvedModule;
  });
  return createFastProgram([fileName], options, host);
}

function stripConfig(source: string, graph: DependencyGraph): string {
  const start = graph.variableStatementStart;
  const end = graph.defineBuilderConfigEnd;
  if (start === undefined || end === undefined) throw new Error('missing container position');
  return source.slice(0, start) + source.slice(end);
}

function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const stripped = (env.NODE_OPTIONS ?? '').replace(/--stack-size(?:=|\s+)\d+/g, '').trim();
  if (stripped === '') delete env.NODE_OPTIONS;
  else env.NODE_OPTIONS = stripped;
  return env;
}

function resolveChain(depth: number, emitter: 'reference' | 'optimized'): { hops: number; value: number } {
  warmLibCache();
  const fileName = `/virtual/t13-depth-${emitter}.ts`;
  const source = chainSource(depth);
  const graphs = new Analyzer(programOf(fileName, source)).extractAll();
  const graph = graphs[0];
  if (!graph) throw new Error('missing graph');
  const cycles = new GraphValidator().validateAll(graph).errors.filter((error) => error.code === 'NEO_CYCLE');
  if (cycles.length > 0) throw new Error(cycles[0]?.message ?? 'cycle');
  const generator = new Generator(graph, true, undefined, false, false, emitter);
  const code = generator.generate()
    .replace(/import \* as __neo_Import_\d+ from '[^']+';\s*/g, '')
    .replace(/__neo_Import_\d+\./g, '');
  const instantiation = generator.generateInstantiation();
  const user = stripConfig(source, graph).replace(/import\s*\{[^}]*\}\s*from\s*'@djodjonx\/neosyringe';\s*/g, '');
  const js = ts.transpileModule(`${user}\n${code}\nexports.__open = function () {\n  const box = ${instantiation};\n  let cursor = box.resolve(S0);\n  let hops = 1;\n  while (cursor && cursor.d0) { cursor = cursor.d0; hops += 1; }\n  return { hops: hops, value: cursor.value };\n};\ntry {\n  process.stdout.write(JSON.stringify(exports.__open()));\n} catch (__neoErr) {\n  const name = __neoErr && __neoErr.name ? __neoErr.name : 'Error';\n  const message = __neoErr && __neoErr.message ? __neoErr.message : String(__neoErr);\n  process.stderr.write(name + ': ' + message);\n  process.exit(1);\n}\n`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const dir = mkdtempSync(path.join(tmpdir(), 'neo-depth-'));
  const file = path.join(dir, 'chain.cjs');
  try {
    writeFileSync(file, js);
    const run = spawnSync(process.execPath, [file], {
      encoding: 'utf8',
      env: childEnv(),
      timeout: 60_000,
      maxBuffer: 32 * 1024 * 1024,
    });
    if (run.error) throw run.error;
    if (run.status !== 0) throw new Error((run.stderr || run.stdout || `status ${run.status}`).trim());
    const parsed: unknown = JSON.parse(run.stdout);
    if (typeof parsed !== 'object' || parsed === null) throw new Error('missing depth');
    const hops = Reflect.get(parsed, 'hops');
    const value = Reflect.get(parsed, 'value');
    if (typeof hops !== 'number' || typeof value !== 'number') throw new Error('bad depth');
    return { hops, value };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Fresh node, default stack, no --stack-size. Measured in that setup:
// reference succeeds at 317 and throws RangeError at 318; optimized succeeds at 2766 and throws at 2767.
const REFERENCE_LIMIT = 317;
const OPTIMIZED_LIMIT = 2766;
const REFERENCE_DEPTH = 158;
const OPTIMIZED_DEPTH = 1383;

describe('t13 runtime depth', () => {
  it('P31 pinned resolve depth', () => {
    expect(REFERENCE_DEPTH * 2).toBeLessThanOrEqual(REFERENCE_LIMIT);
    expect(OPTIMIZED_DEPTH * 2).toBeLessThanOrEqual(OPTIMIZED_LIMIT);
    const reference = resolveChain(REFERENCE_DEPTH, 'reference');
    expect(reference.hops).toBe(REFERENCE_DEPTH);
    expect(reference.value).toBe(REFERENCE_DEPTH - 1);
    const optimized = resolveChain(OPTIMIZED_DEPTH, 'optimized');
    expect(optimized.hops).toBe(OPTIMIZED_DEPTH);
    expect(optimized.value).toBe(OPTIMIZED_DEPTH - 1);
  }, 180_000);
});
