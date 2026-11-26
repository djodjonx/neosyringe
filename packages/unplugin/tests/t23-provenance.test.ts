import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import * as esbuild from 'esbuild';
import { rollup } from 'rollup';
import { TraceMap, decodedMappings, originalPositionFor } from '@jridgewell/trace-mapping';
import { TSContext } from '@djodjonx/neosyringe-core/context';
import * as ts from 'typescript';
import { neoSyringePlugin } from '../src/index';
import neoSyringeTransformer from '../src/transformer';

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
  while (!exists(path.join(dir, 'pnpm-workspace.yaml'))) {
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('racine du dépôt introuvable');
    dir = parent;
  }
  return dir;
}

function exists(file: string): boolean {
  try {
    readFileSync(file);
    return true;
  } catch {
    return false;
  }
}

type PluginMap = { version: 3; sources: string[]; names: string[]; mappings: string; sourcesContent?: string[] };
interface Output { code: string; map: PluginMap }
type Hooks = { transform: (code: string, id: string) => unknown };

function hasTransform(plugin: object): plugin is Hooks {
  return 'transform' in plugin && typeof plugin.transform === 'function';
}

function isMap(value: unknown): value is PluginMap {
  return typeof value === 'object' && value !== null && 'mappings' in value && 'sources' in value;
}

/** A project on disk. The directory is a real path, so the program and the plugin spell it alike. */
interface Workspace { dir: string; project: string }

function workspace(files: Record<string, string>): Workspace {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 't23-provenance-')));
  dirs.push(dir);
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
      paths: { '@djodjonx/neosyringe': [path.join(ROOT, 'packages/neosyringe/src/index.ts')] },
    },
  }));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), text);
  }
  return { dir, project };
}

function transform(space: Workspace, name: string, source: string): Output {
  const plugin = neoSyringePlugin.vite({ project: space.project, debug: false });
  if (Array.isArray(plugin) || !hasTransform(plugin)) throw new Error('hook transform attendu');
  const id = path.join(space.dir, name);
  const result = plugin.transform(source, id);
  if (typeof result !== 'object' || result === null || !('code' in result) || typeof result.code !== 'string') {
    throw new Error('le plugin n\'a rien transformé');
  }
  const map = 'map' in result ? result.map : undefined;
  if (!isMap(map)) throw new Error('le plugin n\'a pas rendu de carte');
  return { code: result.code, map };
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

/**
 * Line (1-based) and column of an offset as a source map consumer counts them: LF, a lone CR,
 * U+2028 and U+2029 end a line, CRLF is one line end. Written apart from the plugin on purpose.
 */
function lineColumnOf(text: string, index: number): { line: number; column: number } {
  let line = 1;
  let column = 0;
  for (let i = 0; i < index; i += 1) {
    const char = text.charCodeAt(i);
    const crlf = char === 13 && text.charCodeAt(i + 1) === 10;
    if (!crlf && (char === 10 || char === 13 || char === 0x2028 || char === 0x2029)) {
      line += 1;
      column = 0;
    } else if (!crlf) {
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

function allIndexesOf(text: string, needle: string): number[] {
  const found: number[] = [];
  for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + 1)) found.push(at);
  return found;
}

/** Offsets of a copied text where the plugin writes a segment: its first character, a line start, a word start. */
function segmentOffsets(text: string): number[] {
  const offsets: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const word = isWordChar(text.charCodeAt(i));
    const previousWord = i > 0 && text.charCodeAt(i - 1) !== 10 && isWordChar(text.charCodeAt(i - 1));
    if (i === 0 || text.charCodeAt(i - 1) === 10 || (word && !previousWord)) offsets.push(i);
  }
  return offsets;
}

interface Traced { source: string | null; line: number | null; column: number | null }

/** The generated columns where the plugin wrote a segment, line by line (line 1 is index 0). */
function segmentRows(output: Output): number[][] {
  return decodedMappings(new TraceMap(output.map)).map((row) => row.map((segment) => segment[0]));
}

function tracerOf(output: Output): (generatedOffset: number) => Traced {
  const trace = new TraceMap(output.map);
  return (generatedOffset) => {
    const { line, column } = positionOf(output.code, generatedOffset);
    const traced = originalPositionFor(trace, { line, column });
    return { source: traced.source, line: traced.line, column: traced.column };
  };
}

/**
 * Every position the plugin maps inside one copied text must be the position of the same character
 * in `sourceText`. Returns how many positions were checked.
 */
function expectCopyMapped(
  output: Output,
  generatedStart: number,
  sourceText: string,
  sourceStart: number,
  length: number,
  sourceName: string,
): number {
  const trace = tracerOf(output);
  const rows = segmentRows(output);
  const copied = sourceText.slice(sourceStart, sourceStart + length);
  expect(output.code.slice(generatedStart, generatedStart + length)).toBe(copied);
  let checked = 0;
  for (const offset of segmentOffsets(copied)) {
    const original = positionOf(sourceText, sourceStart + offset);
    const here = positionOf(output.code, generatedStart + offset);
    // The segment sits at this column, not before it: a lookup would find an earlier one too.
    expect({ at: copied.slice(offset, offset + 12), segment: rows[here.line - 1]?.includes(here.column) })
      .toEqual({ at: copied.slice(offset, offset + 12), segment: true });
    const traced = trace(generatedStart + offset);
    expect({ at: copied.slice(offset, offset + 12), source: traced.source && path.basename(traced.source), line: traced.line, column: traced.column })
      .toEqual({ at: copied.slice(offset, offset + 12), source: sourceName, line: original.line, column: original.column });
    checked += 1;
  }
  return checked;
}

const HEADER = "import { defineBuilderConfig } from '@djodjonx/neosyringe';";

/**
 * The namespace the output imports `./part` through. A factory of another file is copied into this one, and the
 * names its text reads are bound by that import (T23-G3): each read is generated text, the rest stays a copy.
 */
function partNamespaceOf(output: Output): string {
  const found = output.code.match(/import \* as (__neo_Import_\d+) from '\.\/part';/);
  if (!found) throw new Error('no namespace import of ./part in the output');
  return found[1];
}

/** Two class tokens, one factory text written twice. */
function twinSource(eol: string): string {
  return [
    HEADER,
    'class A {} class B {}',
    'export const container = defineBuilderConfig({',
    '  injections: [',
    "    { token: A, useFactory: true, dependencies: [], provider: () => ({ twin: 'same text' }) },",
    "    { token: B, useFactory: true, dependencies: [], provider: () => ({ twin: 'same text' }) },",
    '  ],',
    '});',
    '',
  ].join(eol);
}

describe('T23-P5 a copied expression maps to its own range of the original file (B3)', () => {
  it('T23-P5 the same factory text copied twice maps each copy to its own line', () => {
    const source = twinSource('\n');
    const output = transform(workspace({ 'app.ts': source }), 'app.ts', source);
    const needle = "() => ({ twin: 'same text' })";
    const generated = allIndexesOf(output.code, needle);
    const original = allIndexesOf(source, needle);
    expect(generated).toHaveLength(2);
    expect(original).toHaveLength(2);
    const trace = tracerOf(output);
    const origins = generated.map((offset) => {
      const traced = trace(offset);
      return allIndexesOf(source, needle).find((at) => {
        const position = positionOf(source, at);
        return position.line === traced.line && position.column === traced.column;
      });
    });
    expect([...origins].sort()).toEqual(original);
    generated.forEach((offset, index) => {
      const at = origins[index];
      if (at === undefined) throw new Error('copie sans origine');
      expect(expectCopyMapped(output, offset, source, at, needle.length, 'app.ts')).toBeGreaterThan(3);
    });
  });

  it('T23-P5 a file with CRLF line ends maps a multi-line factory line by line', () => {
    const eol = '\r\n';
    const source = [
      HEADER,
      'class Box {}',
      'export const container = defineBuilderConfig({',
      '  injections: [{',
      '    token: Box,',
      '    useFactory: true,',
      '    dependencies: [],',
      '    provider: () => {',
      '      const crlfProbe = 1;',
      '      const second = crlfProbe + 1;',
      '      return { second };',
      '    },',
      '  }],',
      '});',
      '',
    ].join(eol);
    const output = transform(workspace({ 'app.ts': source }), 'app.ts', source);
    const factory = source.slice(source.indexOf('() => {'), source.indexOf('},\r\n  }],') + 1);
    const generated = output.code.indexOf(factory);
    expect(generated).toBeGreaterThan(-1);
    expect(expectCopyMapped(output, generated, source, source.indexOf(factory), factory.length, 'app.ts')).toBeGreaterThan(8);
  });

  it('T23-P5 an emoji before the factory and inside it moves no column (UTF-16 units)', () => {
    const source = [
      HEADER,
      "const note = '😀😀 before the container';",
      'class Box {}',
      'export const container = defineBuilderConfig({',
      '  injections: [{ token: Box, useFactory: true, dependencies: [], /* 😀😀 */ provider: () => ({ face: \'😀\', afterEmoji: 1 }) }],',
      '});',
      '',
    ].join('\n');
    const output = transform(workspace({ 'app.ts': source }), 'app.ts', source);
    const factory = "() => ({ face: '😀', afterEmoji: 1 })";
    const generated = output.code.indexOf(factory);
    expect(generated).toBeGreaterThan(-1);
    expect(expectCopyMapped(output, generated, source, source.indexOf(factory), factory.length, 'app.ts')).toBeGreaterThan(3);
    const after = tracerOf(output)(generated + factory.indexOf('afterEmoji'));
    expect(after.column).toBe(source.slice(source.lastIndexOf('\n', source.indexOf('afterEmoji')) + 1).indexOf('afterEmoji'));
  });

  it('T23-P5 U+2028 inside a copied string and a lone CR inside a copied comment: the code after them maps to its exact line and column', () => {
    const factory = "() => ({ s: 'a\u2028b', /* c\rd */ after: 1 })";
    const source = [
      HEADER,
      'class Box {}',
      'export const container = defineBuilderConfig({',
      `  injections: [{ token: Box, useFactory: true, dependencies: [], provider: ${factory} }],`,
      '});',
      '',
    ].join('\n');
    const output = transform(workspace({ 'app.ts': source }), 'app.ts', source);
    const generated = output.code.indexOf(factory);
    expect(generated).toBeGreaterThan(-1);
    const original = source.indexOf(factory);
    const trace = new TraceMap(output.map);
    for (const probe of [factory.indexOf('\u2028') + 1, factory.indexOf('\r') + 1, factory.indexOf('after')]) {
      const traced = originalPositionFor(trace, lineColumnOf(output.code, generated + probe));
      expect({ probe: factory.slice(probe, probe + 5), line: traced.line, column: traced.column })
        .toEqual({ probe: factory.slice(probe, probe + 5), ...lineColumnOf(source, original + probe) });
    }
  });

  it('T23-P5 a container whose own text is before and after the copy keeps its mapping', () => {
    const source = twinSource('\n') + 'export const tail = 1;\n';
    const output = transform(workspace({ 'app.ts': source }), 'app.ts', source);
    const tail = 'tail';
    const traced = tracerOf(output)(output.code.lastIndexOf(tail));
    expect({ line: traced.line, column: traced.column }).toEqual(positionOf(source, source.lastIndexOf(tail)));
  });
});

const PART = [
  "import { definePartialConfig } from '@djodjonx/neosyringe';",
  'export class Remote { constructor(public label: string) {} }',
  'export const part = definePartialConfig({',
  '  injections: [',
  "    { token: Remote, useFactory: true, dependencies: [], provider: () => new Remote('from the partial file') },",
  '  ],',
  '});',
  '',
].join('\n');

const APP_WITH_PART = [
  HEADER,
  "import { part } from './part';",
  'class Local {}',
  'export const container = defineBuilderConfig({',
  '  extends: [part],',
  "  injections: [{ token: Local, useFactory: true, dependencies: [], provider: () => ({ local: 'in the container file' }) }],",
  '});',
  '',
].join('\n');

describe('T23-P5 a factory written in another file maps to that file (B3)', () => {
  it('T23-P5 the copy points at the other file, at its own line and column', () => {
    const space = workspace({ 'part.ts': PART, 'app.ts': APP_WITH_PART });
    const output = transform(space, 'app.ts', APP_WITH_PART);
    const foreign = "() => new Remote('from the partial file')";
    // `Remote` is a name of part.ts: the output reads it through the namespace import (generated text), the
    // text on each side of it is still a copy, mapped to its own line and column of part.ts.
    const namespace = partNamespaceOf(output);
    const head = '() => new ';
    const tail = "('from the partial file')";
    const generated = output.code.indexOf(`${head}${namespace}.Remote${tail}`);
    expect(generated).toBeGreaterThan(-1);
    expect(output.code).not.toContain(foreign);
    const from = PART.indexOf(foreign);
    expect(expectCopyMapped(output, generated, PART, from, head.length, 'part.ts')).toBeGreaterThan(1);
    const tailAt = generated + head.length + `${namespace}.Remote`.length;
    expect(expectCopyMapped(output, tailAt, PART, from + head.length + 'Remote'.length, tail.length, 'part.ts')).toBeGreaterThan(1);
    const own = "() => ({ local: 'in the container file' })";
    expect(expectCopyMapped(output, output.code.indexOf(own), APP_WITH_PART, APP_WITH_PART.indexOf(own), own.length, 'app.ts'))
      .toBeGreaterThan(3);
  });

  it('T23-P5 the map names the other file with the path style of its own source, and keeps both texts', () => {
    const space = workspace({ 'part.ts': PART, 'app.ts': APP_WITH_PART });
    const output = transform(space, 'app.ts', APP_WITH_PART);
    expect(output.map.sources).toEqual([path.join(space.dir, 'app.ts'), path.join(space.dir, 'part.ts')]);
    expect(output.map.sourcesContent).toEqual([APP_WITH_PART, PART]);
  });

  it('T23-P5 a map with one source keeps one source and its text', () => {
    const source = twinSource('\n');
    const space = workspace({ 'app.ts': source });
    const output = transform(space, 'app.ts', source);
    expect(output.map.sources).toEqual([path.join(space.dir, 'app.ts')]);
    expect(output.map.sourcesContent).toEqual([source]);
  });
});

describe('T23-P5 the map the TypeScript transformer emits names the other file too', () => {
  it('T23-P5 a copy from another file is a segment of that file in the emitted .js.map', () => {
    const space = workspace({ 'part.ts': PART, 'app.ts': APP_WITH_PART });
    const parsed = ts.parseJsonConfigFileContent(
      { ...ts.readConfigFile(space.project, ts.sys.readFile).config, include: ['*.ts'] },
      ts.sys,
      space.dir,
    );
    const options: ts.CompilerOptions = { ...parsed.options, sourceMap: true, inlineSources: true };
    const host = ts.createCompilerHost(options);
    const program = ts.createProgram(parsed.fileNames, options, host);
    const files = new Map<string, string>();
    neoSyringeTransformer(program, host, {}, { ts }).emit(undefined, (fileName, text) => {
      files.set(path.basename(fileName), text);
    });
    const js = files.get('app.js') ?? '';
    const map = JSON.parse(files.get('app.js.map') ?? '{}') as PluginMap;
    expect(map.sources).toEqual(['app.ts', 'part.ts']);
    expect(map.sourcesContent).toEqual([APP_WITH_PART, PART]);
    // `Remote` is read through the namespace import of part.ts; `new` and the argument are copies of part.ts.
    const keyword = 'new __neo_Import_';
    const argument = "('from the partial file')";
    const keywordAt = tracerOf({ code: js, map })(js.indexOf(keyword));
    expect({ source: keywordAt.source, line: keywordAt.line, column: keywordAt.column })
      .toEqual({ source: 'part.ts', ...positionOf(PART, PART.indexOf("new Remote('from the partial file')")) });
    const argumentAt = tracerOf({ code: js, map })(js.indexOf(argument));
    expect({ source: argumentAt.source, line: argumentAt.line, column: argumentAt.column })
      .toEqual({ source: 'part.ts', ...positionOf(PART, PART.indexOf(argument)) });
  });
});

const INTERFACES = [
  'interface IA { n: number }',
  'interface IB { n: number }',
  'class AImpl implements IA { n = 4; }',
].join('\n');

const WITH_MARKERS = [
  "import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';",
  INTERFACES,
  'export const container = defineBuilderConfig({',
  '  injections: [',
  '    { token: useInterface<IA>(), provider: AImpl },',
  '    {',
  '      token: useInterface<IB>(),',
  '      useFactory: true,',
  '      dependencies: [useInterface<IA>()],',
  '      provider: (k: { resolve(token: unknown): IA }) => k.resolve(useInterface<IA>()),',
  '    },',
  '  ],',
  '});',
  '',
].join('\n');

/** The segment starts of one generated line, as columns. */
function segmentColumns(output: Output, generatedOffset: number): number[] {
  const { line } = positionOf(output.code, generatedOffset);
  const row = decodedMappings(new TraceMap(output.map))[line - 1] ?? [];
  return row.map((segment) => segment[0]);
}

describe('T23-P5 a rewritten marker inside a factory splits the copy (B2, B3)', () => {
  it('T23-P5 the text around the marker maps exactly and nothing is mapped inside the generated replacement', () => {
    const space = workspace({ 'app.ts': WITH_MARKERS });
    const output = transform(space, 'app.ts', WITH_MARKERS);
    const before = '(k: { resolve(token: unknown): IA }) => k.resolve(';
    const generated = output.code.indexOf(before);
    expect(generated).toBeGreaterThan(-1);
    const original = WITH_MARKERS.indexOf(before);
    expect(expectCopyMapped(output, generated, WITH_MARKERS, original, before.length, 'app.ts')).toBeGreaterThan(3);

    const marker = 'useInterface<IA>()';
    const markerAt = WITH_MARKERS.indexOf(marker, original);
    const replacementAt = generated + before.length;
    const replacement = output.code.slice(replacementAt).match(/^"[^"]+"/)?.[0];
    if (!replacement) throw new Error('marqueur réécrit absent');
    expect(replacement).not.toContain('useInterface');
    expect(markerAt).toBe(original + before.length);

    const tailAt = replacementAt + replacement.length;
    expect(output.code.slice(tailAt, tailAt + 1)).toBe(')');
    const tail = tracerOf(output)(tailAt);
    expect({ line: tail.line, column: tail.column })
      .toEqual(positionOf(WITH_MARKERS, markerAt + marker.length));

    const columns = segmentColumns(output, generated);
    const startColumn = positionOf(output.code, replacementAt).column;
    expect(columns.filter((column) => column >= startColumn && column < startColumn + replacement.length)).toEqual([]);
  });

  it('T23-P5 the code of the rewritten factory is unchanged by carrying the rewrite as data', () => {
    const space = workspace({ 'app.ts': WITH_MARKERS });
    const output = transform(space, 'app.ts', WITH_MARKERS);
    expect(output.code).toMatch(/const userFactory: \(context: \{ resolve<T>\(token: unknown\): T; resolveAll<T>\(token: unknown\): T\[\]; resolveMany<const T extends readonly __NeoToken_[0-9a-f]+<unknown>\[\]>\(tokens: T\): __NeoValues_[0-9a-f]+<T>; resolveMany<const T extends readonly \(__NeoToken_[0-9a-f]+<unknown> \| string\)\[\]>\(tokens: T\): \{ -readonly \[K in keyof T\]: T\[K\] extends infer E \? E extends string \? unknown : E extends __NeoToken_[0-9a-f]+<infer V> \? V : never : never \} \}\) => IB \| PromiseLike<IB> = \(k: \{ resolve\(token: unknown\): IA \}\) => k\.resolve\("IA_[0-9a-f]+"\);/);
    expect(output.code).not.toContain('useInterface<');
  });

  it('T23-P5 a useValue that holds a marker maps the text around it', () => {
    const source = [
      "import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';",
      'interface IA { n: number }',
      'interface IZ { held: unknown }',
      'class AImpl implements IA { n = 1; }',
      'export const container = defineBuilderConfig({',
      '  injections: [',
      '    { token: useInterface<IA>(), provider: AImpl },',
      '    { token: useInterface<IZ>(), useValue: { held: useInterface<IA>(), after: 2 } },',
      '  ],',
      '});',
      '',
    ].join('\n');
    const output = transform(workspace({ 'app.ts': source }), 'app.ts', source);
    const before = '{ held: ';
    const generated = output.code.indexOf('{ held: "');
    expect(generated).toBeGreaterThan(-1);
    expect(expectCopyMapped(output, generated, source, source.indexOf('{ held: useInterface'), before.length, 'app.ts'))
      .toBeGreaterThan(0);
    const afterAt = output.code.indexOf('after: 2', generated);
    const traced = tracerOf(output)(afterAt);
    expect({ line: traced.line, column: traced.column }).toEqual(positionOf(source, source.indexOf('after: 2')));
  });

  it('T23-P5 a marker inside a factory written in another file splits the copy of that file', () => {
    const part = [
      "import { definePartialConfig, useInterface } from '@djodjonx/neosyringe';",
      'export interface IA { n: number }',
      'export interface IR { n: number }',
      'export const part = definePartialConfig({',
      '  injections: [',
      '    {',
      '      token: useInterface<IR>(),',
      '      useFactory: true,',
      '      dependencies: [useInterface<IA>()],',
      '      provider: (k: { resolve(token: unknown): IA }) => k.resolve(useInterface<IA>()),',
      '    },',
      '  ],',
      '});',
      '',
    ].join('\n');
    const app = [
      "import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';",
      "import { part, type IA } from './part';",
      'class AImpl implements IA { n = 4; }',
      'export const container = defineBuilderConfig({',
      '  extends: [part],',
      '  injections: [{ token: useInterface<IA>(), provider: AImpl }],',
      '});',
      '',
    ].join('\n');
    const output = transform(workspace({ 'part.ts': part, 'app.ts': app }), 'app.ts', app);
    // `IA` is a type of part.ts, read in a type position only: it is imported with `import type`, so the copy
    // adds no runtime dependency. The text on each side stays a copy.
    expect(output.code).toContain("import type { IA as __neo_Type_IA } from './part';");
    const before = '(k: { resolve(token: unknown): IA }) => k.resolve(';
    const head = '(k: { resolve(token: unknown): ';
    const tail = ' }) => k.resolve(';
    const generated = output.code.indexOf(`${head}__neo_Type_IA${tail}`);
    expect(generated).toBeGreaterThan(-1);
    expect(output.code).not.toContain('useInterface<');
    const from = part.indexOf(before);
    expect(expectCopyMapped(output, generated, part, from, head.length, 'part.ts')).toBeGreaterThan(3);
    const tailAt = generated + head.length + '__neo_Type_IA'.length;
    expect(expectCopyMapped(output, tailAt, part, from + head.length + 'IA'.length, tail.length, 'part.ts')).toBeGreaterThan(1);
  });
});

const BOOM_PREFIX = [
  HEADER,
  'class Box { constructor(value) { this.value = value; } }',
  'class Twin { constructor(value) { this.value = value; } }',
].join('\n');

/**
 * Bundles `source` the way T11-P7 does, runs it and returns the frames of the thrown error mapped through the
 * chunk map: the original file, line and column the stack points at.
 */
async function thrownFrames(
  source: string,
  otherFiles: Record<string, string> = {},
): Promise<{ message: string; frames: { source: string | null; line: number; column: number }[] }> {
  const space = workspace({ ...otherFiles, 'app.ts': source });
  const entry = path.join(space.dir, 'app.ts');
  const runtime = path.join(ROOT, 'packages/neosyringe/dist/index.mjs');
  const build = await rollup({
    input: entry,
    plugins: [
      {
        name: 'resolve-neo',
        resolveId(sourceId, importer) {
          if (sourceId === '@djodjonx/neosyringe') return runtime;
          if (!importer || !sourceId.startsWith('./')) return null;
          const sibling = path.resolve(path.dirname(importer), `${sourceId}.ts`);
          return exists(sibling) ? sibling : null;
        },
      },
      neoSyringePlugin.rollup({ project: space.project, debug: false }),
      {
        name: 'strip-ts',
        async transform(sourceText, id) {
          if (!id.endsWith('.ts')) return null;
          const transformed = await esbuild.transform(sourceText, {
            loader: 'ts', target: 'es2022', format: 'esm', sourcemap: true, sourcefile: id,
          });
          return { code: transformed.code, map: transformed.map };
        },
      },
    ],
    onwarn() {},
  });
  let chunkCode = '';
  let chunkMap: ConstructorParameters<typeof TraceMap>[0] | null = null;
  try {
    const generated = await build.generate({ format: 'esm', sourcemap: 'hidden' });
    const chunk = generated.output.find((item) => item.type === 'chunk');
    if (!chunk || chunk.type !== 'chunk') throw new Error('chunk absent');
    chunkCode = chunk.code;
    chunkMap = chunk.map ? { ...chunk.map, version: 3 } : null;
  } finally {
    await build.close();
  }
  const bundle = path.join(space.dir, 'bundle.mjs');
  writeFileSync(bundle, chunkCode);
  let thrown: unknown;
  try {
    await import(pathToFileURL(bundle).href);
  } catch (error) {
    thrown = error;
  }
  if (!(thrown instanceof Error)) throw new Error('aucune erreur levée');
  const tracer = chunkMap ? new TraceMap(chunkMap) : null;
  const markers = [bundle, realpathSync(bundle), pathToFileURL(bundle).href, pathToFileURL(realpathSync(bundle)).href]
    .map((value) => value.replace(/\\/g, '/'));
  const frames = (thrown.stack ?? '').split('\n').flatMap((frame) => {
    const normalized = frame.replace(/\\/g, '/');
    if (!markers.some((marker) => normalized.includes(marker))) return [];
    const match = [...normalized.matchAll(/:(\d+):(\d+)/g)].pop();
    if (!match || !tracer) return [];
    const traced = originalPositionFor(tracer, { line: Number(match[1]), column: Number(match[2]) - 1 });
    return traced.line === null || traced.column === null
      ? []
      : [{ source: traced.source && path.basename(traced.source), line: traced.line, column: traced.column }];
  });
  return { message: thrown.message, frames };
}

function boomSource(): { source: string; first: number; second: number } {
  const factory = (label: string): string => `() => { throw new Error('${label}'); }`;
  const lines = [
    BOOM_PREFIX,
    'export const container = defineBuilderConfig({',
    '  injections: [',
    `    { token: Box, useFactory: true, dependencies: [], provider: ${factory('TWIN_BOOM_T23')} },`,
    `    { token: Twin, useFactory: true, dependencies: [], provider: ${factory('TWIN_BOOM_T23')} },`,
    '  ],',
    '});',
    'container.resolve(Twin);',
    '',
  ];
  const source = lines.join('\n');
  const first = source.indexOf('new Error');
  return { source, first, second: source.indexOf('new Error', first + 1) };
}

describe('T23-P6 the stack of an error thrown in a copied factory points at the original factory', () => {
  it('T23-P6 a unique factory: the frame is the file, line and column of its `new Error`', async () => {
    const source = [
      HEADER,
      'class Box { constructor(value) { this.value = value; } }',
      'export const container = defineBuilderConfig({',
      '  injections: [{',
      '    token: Box,',
      '    useFactory: true,',
      '    dependencies: [],',
      "    provider: () => { throw new Error('UNIQUE_BOOM_T23'); },",
      '  }],',
      '});',
      'container.resolve(Box);',
      '',
    ].join('\n');
    const { message, frames } = await thrownFrames(source);
    expect(message).toContain('UNIQUE_BOOM_T23');
    expect(frames).toContainEqual({ source: 'app.ts', ...positionOf(source, source.indexOf('new Error')) });
  });

  it('T23-P6 the same factory text twice: the error of the second one points at the second', async () => {
    const { source, first, second } = boomSource();
    expect(second).toBeGreaterThan(first);
    const { message, frames } = await thrownFrames(source);
    expect(message).toContain('TWIN_BOOM_T23');
    expect(frames).toContainEqual({ source: 'app.ts', ...positionOf(source, second) });
    expect(frames).not.toContainEqual({ source: 'app.ts', ...positionOf(source, first) });
  });
});

describe('T23-P6 known limit: Rollup keeps one source per transform map', () => {
  // The plugin map names part.ts and the ts transformer emit maps it (P5 above). A Rollup or Vite build does
  // not: it links every transform map to ONE source (rollup@4.55.2 node-entry.js:20304, `new Link(map, [source])`)
  // and skips a segment whose source index is not 0 (node-entry.js:20228-20230). The frame of a factory written in
  // another file then falls back to the neighbouring segment of the file being transformed. This pins today's
  // result so that a Rollup that follows several sources turns it red and the limit can be lifted.
  it('T23-P6 known limit: a frame in a factory of another file is not mapped to that file in a Rollup build', async () => {
    const part = [
      "import { definePartialConfig } from '@djodjonx/neosyringe';",
      'export class Box {}',
      'export const part = definePartialConfig({',
      "  injections: [{ token: Box, useFactory: true, dependencies: [], provider: () => { throw new Error('FOREIGN_BOOM_T23'); } }],",
      '});',
      '',
    ].join('\n');
    const app = [
      HEADER,
      "import { Box, part } from './part';",
      'export const container = defineBuilderConfig({ extends: [part], injections: [] });',
      'container.resolve(Box);',
      '',
    ].join('\n');
    const { message, frames } = await thrownFrames(app, { 'part.ts': part });
    expect(message).toContain('FOREIGN_BOOM_T23');
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.map((frame) => frame.source)).not.toContain('part.ts');
    expect(frames.map((frame) => frame.source)).toContain('app.ts');
  });
});

/**
 * The same project written under another root: the map says the same thing once `sources` is relative.
 * Only `sources` is made relative. The code is compared as it is, so a root that leaks into it fails here.
 */
function relativeTo(root: string, output: Output): { code: string; map: PluginMap } {
  expect(output.code).not.toContain(root);
  return {
    code: output.code,
    map: { ...output.map, sources: output.map.sources.map((item) => path.relative(root, item).split(path.sep).join('/')) },
  };
}

describe('T23-P9 the same input gives the same code and the same map (B7)', () => {
  const files = { 'part.ts': PART, 'app.ts': APP_WITH_PART };

  it('T23-P9 compiled twice in one root', () => {
    const space = workspace(files);
    const first = transform(space, 'app.ts', APP_WITH_PART);
    const second = transform(space, 'app.ts', APP_WITH_PART);
    expect(second).toEqual(first);
    expect(first.map.mappings.length).toBeGreaterThan(0);
  });

  it('T23-P9 compiled under two roots: same code, same mappings, same texts, sources relative to the root', () => {
    const one = workspace(files);
    const two = workspace(files);
    expect(two.dir).not.toBe(one.dir);
    const first = relativeTo(one.dir, transform(one, 'app.ts', APP_WITH_PART));
    const second = relativeTo(two.dir, transform(two, 'app.ts', APP_WITH_PART));
    expect(second.map.mappings).toBe(first.map.mappings);
    expect(second.map.sourcesContent).toEqual(first.map.sourcesContent);
    expect(second.map.sources).toEqual(['app.ts', 'part.ts']);
    expect(second.map.sources).toEqual(first.map.sources);
    expect(second.code).toBe(first.code);
  });
});
