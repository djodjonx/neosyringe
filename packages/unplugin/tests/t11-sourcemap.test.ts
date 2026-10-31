import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import * as esbuild from 'esbuild';
import { rollup } from 'rollup';
import ts from 'typescript';
import { TraceMap, decodedMappings, originalPositionFor } from '@jridgewell/trace-mapping';
import { TSContext } from '@djodjonx/neosyringe-core/context';
import { neoSyringePlugin } from '../src/index';

const ROOT = repoRoot();

const dirs: string[] = [];
let cwdToRestore: string | undefined;

afterEach(() => {
  if (cwdToRestore !== undefined) {
    process.chdir(cwdToRestore);
    cwdToRestore = undefined;
  }
  TSContext.reset();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function repoRoot(): string {
  let dir = path.resolve(process.cwd());
  while (!readExists(path.join(dir, 'pnpm-workspace.yaml'))) {
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('racine du dépôt introuvable');
    dir = parent;
  }
  return dir;
}

function readExists(file: string): boolean {
  try {
    readFileSync(file);
    return true;
  } catch {
    return false;
  }
}

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function positionOf(text: string, index: number): { line: number; column: number } {
  let line = 1;
  let column = 0;
  for (let i = 0; i < index; i += 1) {
    if (text.charCodeAt(i) === 10) {
      line += 1;
      column = 0;
    } else {
      column += 1;
    }
  }
  return { line, column };
}

function isWordChar(code: number): boolean {
  return (code >= 48 && code <= 57)
    || (code >= 65 && code <= 90)
    || (code >= 97 && code <= 122)
    || code === 36
    || code === 95;
}

function wordRun(text: string, offset: number): string {
  if (offset < 0 || offset >= text.length || !isWordChar(text.charCodeAt(offset))) return '';
  let end = offset + 1;
  while (end < text.length && isWordChar(text.charCodeAt(end))) end += 1;
  return text.slice(offset, end);
}

function offsetOf(text: string, line: number, column: number): number {
  let current = 1;
  let columnAt = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (current === line && columnAt === column) return i;
    if (text.charCodeAt(i) === 10) {
      current += 1;
      columnAt = 0;
    } else {
      columnAt += 1;
    }
  }
  return current === line && columnAt === column ? text.length : -1;
}

type PluginMap = { version: 3; sources: string[]; names: string[]; mappings: string };

function codeOf(result: unknown, fallback: string): { code: string; map: PluginMap | null } {
  if (typeof result === 'string') return { code: result, map: null };
  if (result && typeof result === 'object' && 'code' in result && typeof (result as { code: unknown }).code === 'string') {
    const map = (result as { map?: PluginMap | null }).map ?? null;
    return { code: (result as { code: string }).code, map };
  }
  return { code: fallback, map: null };
}

describe('T11 source maps', () => {
  it('T11-P7-factory-sourcemap', async () => {
    const dir = tempDir('t11-p7-');
    if (cwdToRestore === undefined) cwdToRestore = process.cwd();
    process.chdir(dir);
    const project = path.join(dir, 'tsconfig.json');
    writeFileSync(project, JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'Bundler',
        strict: false,
        noLib: true,
        types: [],
        skipLibCheck: true,
        baseUrl: '.',
        paths: {
          '@djodjonx/neosyringe': [path.join(ROOT, 'packages/neosyringe/src/index.ts')],
        },
      },
    }));
    const source = [
      "import { defineBuilderConfig } from '@djodjonx/neosyringe';",
      'class Box { constructor(value) { this.value = value; } }',
      'export const container = defineBuilderConfig({',
      '  injections: [{',
      '    token: Box,',
      "    provider: () => { throw new Error('UNIQUE_FACTORY_BOOM_T11'); },",
      '  }],',
      '});',
      'container.resolve(Box);',
      '',
    ].join('\n');
    const entry = path.join(dir, 'app.ts');
    writeFileSync(entry, source);
    const factoryAt = source.indexOf('() => { throw new Error(\'UNIQUE_FACTORY_BOOM_T11\')');
    const factoryPos = positionOf(source, factoryAt);
    const factoryEnd = factoryAt + "() => { throw new Error('UNIQUE_FACTORY_BOOM_T11'); }".length;

    const runtime = path.join(ROOT, 'packages/neosyringe/dist/index.mjs');
    const build = await rollup({
      input: entry,
      plugins: [
        {
          name: 'resolve-neo',
          resolveId(sourceId) {
            if (sourceId === '@djodjonx/neosyringe') return runtime;
            return null;
          },
        },
        neoSyringePlugin.rollup({ project }),
        {
          name: 'strip-ts',
          async transform(sourceText, id) {
            if (!id.endsWith('.ts')) return null;
            const transformed = await esbuild.transform(sourceText, {
              loader: 'ts',
              target: 'es2022',
              format: 'esm',
              sourcemap: true,
              sourcefile: id,
            });
            return { code: transformed.code, map: transformed.map };
          },
        },
      ],
      onwarn() {},
    });
    let chunkCode = '';
    let chunkMap: { mappings?: string } | null = null;
    try {
      const generated = await build.generate({ format: 'esm', sourcemap: 'hidden' });
      const chunk = generated.output.find((item) => item.type === 'chunk');
      if (!chunk || chunk.type !== 'chunk') throw new Error('chunk absent');
      chunkCode = chunk.code;
      chunkMap = chunk.map;
    } finally {
      await build.close();
    }

    const bundle = path.join(dir, 'bundle.mjs');
    writeFileSync(bundle, chunkCode);
    let thrown: unknown;
    try {
      await import(pathToFileURL(bundle).href);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain('UNIQUE_FACTORY_BOOM_T11');

    const tracer = chunkMap ? new TraceMap(chunkMap as never) : null;
    const stack = (thrown as Error).stack ?? '';
    const bundleReal = realpathSync(bundle);
    const bundleMarkers = [bundle, bundleReal, pathToFileURL(bundle).href, pathToFileURL(bundleReal).href]
      .map((value) => value.replace(/\\/g, '/'));
    const frames = stack.split('\n').flatMap((frame) => {
      const normalized = frame.replace(/\\/g, '/');
      if (!bundleMarkers.some((marker) => normalized.includes(marker))) return [];
      const matches = [...normalized.matchAll(/:(\d+):(\d+)/g)];
      const match = matches[matches.length - 1];
      if (!match) return [];
      return [{ line: Number(match[1]), column: Number(match[2]) - 1 }];
    });
    const hits = frames
      .map((frame) => (tracer ? originalPositionFor(tracer, frame) : { line: null, column: null, source: null }))
      .filter((pos) => pos.line === factoryPos.line && pos.column !== null && pos.column >= factoryPos.column && pos.column < positionOf(source, factoryEnd).column);
    expect(hits.length).toBeGreaterThan(0);
  });

  it('T11-P8-tail-after-splice', () => {
    const dir = tempDir('t11-p8-');
    if (cwdToRestore === undefined) cwdToRestore = process.cwd();
    process.chdir(dir);
    const project = path.join(dir, 'tsconfig.json');
    writeFileSync(project, JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'CommonJS',
        moduleResolution: 'Bundler',
        strict: true,
        noLib: true,
        types: [],
        baseUrl: '.',
        paths: {
          '@djodjonx/neosyringe': [path.join(ROOT, 'packages/neosyringe/src/index.ts')],
        },
      },
    }));
    const source = "import { defineBuilderConfig } from '@djodjonx/neosyringe';\nexport const first = defineBuilderConfig({ injections: [] }); export const second = defineBuilderConfig({ injections: [] }); export const tailMarker = 1;\n";
    const id = path.join(dir, 'app.ts');
    writeFileSync(id, source);
    const plugin = neoSyringePlugin.vite({ project }) as unknown as {
      transform: (code: string, file: string) => unknown;
      buildEnd: () => void;
    };
    const output = codeOf(plugin.transform(source, id), source);
    plugin.buildEnd();
    const marker = 'tailMarker';
    const generatedAt = output.code.lastIndexOf(marker);
    const originalAt = source.lastIndexOf(marker);
    const generated = positionOf(output.code, generatedAt);
    const original = positionOf(source, originalAt);
    const traced = output.map
      ? originalPositionFor(new TraceMap(output.map as never), { line: generated.line, column: generated.column })
      : { line: null, column: null };
    expect(traced.line).toBe(original.line);
    expect(traced.column).toBe(original.column);

    mkdirSync(dir, { recursive: true });
    writeFileSync(id, output.code);
    const options = ts.parseJsonConfigFileContent(
      ts.readConfigFile(project, ts.sys.readFile).config,
      ts.sys,
      dir,
    ).options;
    const program = ts.createProgram([id], options);
    let javascript = '';
    program.emit(undefined, (fileName, text) => {
      if (fileName.endsWith('.js')) javascript = text;
    });
    const exportsObject: Record<string, unknown> = {};
    const execute = new Function('exports', 'require', javascript) as (
      exportsObject: Record<string, unknown>,
      req: (id: string) => unknown,
    ) => void;
    execute(exportsObject, () => ({}));
    expect(exportsObject.tailMarker).toBe(1);
  });

  it('T11-P11-map-size', () => {
    const dir = tempDir('t11-p11-');
    if (cwdToRestore === undefined) cwdToRestore = process.cwd();
    process.chdir(dir);
    const project = path.join(dir, 'tsconfig.json');
    writeFileSync(project, JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'CommonJS',
        moduleResolution: 'Bundler',
        strict: true,
        noLib: true,
        types: [],
        baseUrl: '.',
        paths: {
          '@djodjonx/neosyringe': [path.join(ROOT, 'packages/neosyringe/src/index.ts')],
        },
      },
    }));
    const lines = [
      "import { defineBuilderConfig } from '@djodjonx/neosyringe';",
      'export const container = defineBuilderConfig({ injections: [] });',
    ];
    for (let i = 0; i < 2000; i += 1) lines.push(`const filler${i} = ${i};`);
    lines.push('export const endMarkerT11 = 1;');
    lines.push('');
    const source = lines.join('\n');
    const id = path.join(dir, 'app.ts');
    const plugin = neoSyringePlugin.vite({ project }) as unknown as {
      transform: (code: string, file: string) => unknown;
      buildEnd: () => void;
    };
    const output = codeOf(plugin.transform(source, id), source);
    plugin.buildEnd();
    const map = output.map;
    if (map === null) throw new Error('carte absente');
    const decoded = decodedMappings(new TraceMap(map));
    let segments = 0;
    for (const line of decoded) segments += line.length;
    expect(segments).toBeLessThan(output.code.length / 3);
    const marker = 'endMarkerT11';
    const generatedAt = output.code.lastIndexOf(marker);
    const originalAt = source.lastIndexOf(marker);
    const generated = positionOf(output.code, generatedAt);
    const original = positionOf(source, originalAt);
    const traced = originalPositionFor(new TraceMap(map), { line: generated.line, column: generated.column });
    expect(traced.line).toBe(original.line);
    expect(traced.column).toBe(original.column);
  });

  it('T11-P15-short-value-map', () => {
    const dir = tempDir('t11-p15-');
    if (cwdToRestore === undefined) cwdToRestore = process.cwd();
    process.chdir(dir);
    const project = path.join(dir, 'tsconfig.json');
    writeFileSync(project, JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'CommonJS',
        moduleResolution: 'Bundler',
        strict: true,
        noLib: true,
        types: [],
        skipLibCheck: true,
        esModuleInterop: true,
        baseUrl: '.',
        paths: {
          '@djodjonx/neosyringe': [path.join(ROOT, 'packages/neosyringe/src/index.ts')],
        },
      },
    }));
    const twin = '() => 2';
    const unique = "() => { return 'UNIQUE_FACTORY_BODY_T11'; }";
    const source = [
      "import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';",
      'interface Num1 { n: number }',
      'class TwinA {}',
      'class TwinB {}',
      'export interface Unique { tag: string }',
      'export const container = defineBuilderConfig({',
      '  injections: [',
      '    { token: useInterface<Num1>(), useValue: 1 },',
      `    { token: TwinA, provider: ${twin} },`,
      `    { token: TwinB, provider: ${twin} },`,
      `    { token: useInterface<Unique>(), provider: ${unique} },`,
      '  ],',
      '});',
      'export function read() {',
      '  return {',
      '    value: container.resolve(useInterface<Num1>()),',
      '    unique: container.resolve(useInterface<Unique>()),',
      '  };',
      '}',
      '',
    ].join('\n');
    const id = path.join(dir, 'app.ts');
    writeFileSync(id, source);
    const plugin = neoSyringePlugin.vite({ project }) as unknown as {
      transform: (code: string, file: string) => unknown;
      buildEnd: () => void;
    };
    const output = codeOf(plugin.transform(source, id), source);
    plugin.buildEnd();
    expect(output.map).not.toBeNull();
    const tracer = new TraceMap(output.map as never);
    const decoded = decodedMappings(tracer);

    for (let lineIndex = 0; lineIndex < decoded.length; lineIndex += 1) {
      const row = decoded[lineIndex] ?? [];
      for (const segment of row) {
        if (segment.length < 4) continue;
        const sourceLine = segment[2];
        const sourceColumn = segment[3];
        if (sourceLine === undefined || sourceColumn === undefined) continue;
        const generatedOffset = offsetOf(output.code, lineIndex + 1, segment[0]);
        const originalOffset = offsetOf(source, sourceLine + 1, sourceColumn);
        const generatedCode = generatedOffset >= 0 && generatedOffset < output.code.length
          ? output.code.charCodeAt(generatedOffset)
          : -1;
        const originalCode = originalOffset >= 0 && originalOffset < source.length
          ? source.charCodeAt(originalOffset)
          : -1;
        if (!isWordChar(generatedCode) && !isWordChar(originalCode)) continue;
        expect(wordRun(output.code, generatedOffset)).toBe(wordRun(source, originalOffset));
        if (isWordChar(generatedCode)) {
          const previous = generatedOffset > 0 ? output.code.charCodeAt(generatedOffset - 1) : -1;
          expect(isWordChar(previous)).toBe(false);
        }
      }
    }

    const uniqueAt = source.indexOf(unique);
    const uniquePos = positionOf(source, uniqueAt);
    const generatedUnique = positionOf(output.code, output.code.indexOf(unique));
    const tracedUnique = originalPositionFor(tracer, { line: generatedUnique.line, column: generatedUnique.column });
    expect(tracedUnique.line).toBe(uniquePos.line);
    expect(tracedUnique.column).toBe(uniquePos.column);

    const firstTwin = source.indexOf(twin);
    const secondTwin = source.indexOf(twin, firstTwin + twin.length);
    const secondTwinPos = positionOf(source, secondTwin);
    const firstGenerated = output.code.indexOf(twin);
    const secondGenerated = output.code.indexOf(twin, firstGenerated + twin.length);
    const secondGeneratedPos = positionOf(output.code, secondGenerated);
    const secondRow = decoded[secondGeneratedPos.line - 1] ?? [];
    for (const segment of secondRow) {
      if (segment[0] !== secondGeneratedPos.column || segment.length < 4) continue;
      const mappedLine = segment[2];
      const mappedColumn = segment[3];
      if (mappedLine === undefined || mappedColumn === undefined) continue;
      expect(mappedLine + 1).toBe(secondTwinPos.line);
      expect(mappedColumn).toBe(secondTwinPos.column);
    }

    writeFileSync(id, output.code);
    const options = ts.parseJsonConfigFileContent(
      ts.readConfigFile(project, ts.sys.readFile).config,
      ts.sys,
      dir,
    ).options;
    const program = ts.createProgram([id], options);
    let javascript = '';
    program.emit(undefined, (fileName, text) => {
      if (fileName.endsWith('.js')) javascript = text;
    });
    const runtime = readFileSync(path.join(ROOT, 'packages/neosyringe/dist/index.cjs'), 'utf8');
    const exportsObject: Record<string, unknown> = {};
    const loaded = new Map<string, Record<string, unknown>>();
    const execute = new Function('exports', 'require', javascript) as (
      exportsObject: Record<string, unknown>,
      req: (id: string) => unknown,
    ) => void;
    execute(exportsObject, (request: string) => {
      if (request !== '@djodjonx/neosyringe') return {};
      const hit = loaded.get(request);
      if (hit) return hit;
      const runtimeExports: Record<string, unknown> = {};
      loaded.set(request, runtimeExports);
      const runRuntime = new Function('exports', 'require', runtime) as (
        exportsObject: Record<string, unknown>,
        req: (id: string) => unknown,
      ) => void;
      runRuntime(runtimeExports, () => ({}));
      return runtimeExports;
    });
    expect((exportsObject.read as () => { value: number; unique: string })()).toEqual({
      value: 1,
      unique: 'UNIQUE_FACTORY_BODY_T11',
    });
  });
});
