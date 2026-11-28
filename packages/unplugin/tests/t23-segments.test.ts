import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import * as ts from 'typescript';
import { TraceMap, decodedMappings, encodedMappings, type SourceMapSegment } from '@jridgewell/trace-mapping';
import { Analyzer, type DependencyGraph, type DependencyNode } from '@djodjonx/neosyringe-core/analyzer';
import { snapshotOfFiles, type CopyMapping } from '@djodjonx/neosyringe-core/generator';
import { TSContext } from '@djodjonx/neosyringe-core/context';
import { collectUseSiteEdits, type SourceEdit, type UsedTokenEntry } from '../src/useInterfaceTransform';
import {
  analysisSnapshot,
  applyMappedEdits,
  attachRewrites,
  copiesToSegments,
  rewriteEmittedOutput,
  rewritesIn,
  siblingSourceName,
  type SessionFileMap,
} from '../src/session';

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

function copy(generatedStart: number, sourceFile: string, sourceStart: number, length: number): CopyMapping {
  return { generatedStart, sourceFile, sourceStart, length };
}

describe('T23-P10 copiesToSegments turns the copies a Generator rendered into the copies of an edit', () => {
  it('T23-P10 a copy of the transformed file is source 0, with its own offsets', () => {
    const files = ['/p/app.ts'];
    expect(copiesToSegments([copy(5, '/p/app.ts', 40, 7)], files)).toEqual([{ gen: 5, orig: 40, length: 7, source: 0 }]);
    expect(files).toEqual(['/p/app.ts']);
  });

  it('T23-P10 another file is appended on first use and keeps its index', () => {
    const files = ['/p/app.ts'];
    const segments = copiesToSegments([
      copy(0, '/p/b.ts', 1, 2),
      copy(10, '/p/c.ts', 3, 4),
      copy(20, '/p/b.ts', 5, 6),
      copy(30, '/p/app.ts', 7, 8),
    ], files);
    expect(segments.map((segment) => segment.source)).toEqual([1, 2, 1, 0]);
    expect(segments.map((segment) => [segment.gen, segment.orig, segment.length])).toEqual([
      [0, 1, 2], [10, 3, 4], [20, 5, 6], [30, 7, 8],
    ]);
    expect(files).toEqual(['/p/app.ts', '/p/b.ts', '/p/c.ts']);
  });

  it('T23-P10 no copy gives no segment', () => {
    expect(copiesToSegments([], ['/p/app.ts'])).toEqual([]);
  });
});

describe('T23-P10 siblingSourceName writes another file in the path style of the transformed one', () => {
  it.each([
    ['an absolute name stays absolute', '/a/b/app.ts', '/a/b/app.ts', '/a/b/part.ts', '/a/b/part.ts'],
    ['another directory', '/a/b/app.ts', '/a/b/app.ts', '/a/c/part.ts', '/a/c/part.ts'],
    ['a name relative to a map stays relative', '../src/app.ts', '/proj/src/app.ts', '/proj/lib/part.ts', '../lib/part.ts'],
    ['a bare file name', 'app.ts', '/proj/app.ts', '/proj/sub/part.ts', 'sub/part.ts'],
    ['a file above the directory', 'app.ts', '/proj/app.ts', '/other/part.ts', '../other/part.ts'],
    ['a query on the id is not a directory', '/a/b/app.ts?v=1', '/a/b/app.ts', '/a/b/part.ts', '/a/b/part.ts'],
    ['an id written with backslashes', 'C:\\a\\b\\app.ts', 'C:/a/b/app.ts', 'C:/a/c/part.ts', 'C:\\a\\c\\part.ts'],
  ])('T23-P10 %s', (_label, primaryName, primaryFile, file, expected) => {
    expect(siblingSourceName(primaryName, primaryFile, file)).toBe(expected);
  });
});

describe('T23-P10 rewritesIn keeps the edits that sit inside a range', () => {
  const origin = { file: 'f.ts', start: 10, length: 10 };
  const edit = (start: number, end: number, text = 'T'): { start: number; end: number; text: string } => ({ start, end, text });

  it('T23-P10 an edit that sits inside, or touches both ends, is a rewrite; the others are not', () => {
    expect(rewritesIn(origin, [
      edit(12, 14, 'a'), edit(10, 11, 'first'), edit(19, 20, 'last'),
      edit(9, 11), edit(19, 21), edit(0, 5), edit(25, 30),
    ])).toEqual([
      { start: 10, end: 11, text: 'first' },
      { start: 12, end: 14, text: 'a' },
      { start: 19, end: 20, text: 'last' },
    ]);
  });

  it('T23-P10 an insertion inside the range is kept, in position order', () => {
    expect(rewritesIn(origin, [edit(15, 15, 'later'), edit(11, 11, 'sooner')]))
      .toEqual([{ start: 11, end: 11, text: 'sooner' }, { start: 15, end: 15, text: 'later' }]);
  });

  it('T23-P10 no edit gives no rewrite', () => {
    expect(rewritesIn(origin, [])).toEqual([]);
  });
});

/** The map of one edit as rows of [genCol, source, line, column]. */
function rowsOf(map: { sources: string[]; mappings: string }): SourceMapSegment[][] {
  return decodedMappings(new TraceMap({ version: 3, names: [], ...map })).map((row) => [...row]);
}

describe('T23-P10 applyMappedEdits writes a copy from another file as a segment of that source', () => {
  const code = 'AAAA\nBBBB\n';
  const other = { name: '/p/part.ts', text: 'xx\r\nüñ😀 target value\r\nlast' };
  const copied = 'target value';
  const copiedAt = other.text.indexOf(copied);

  it('T23-P10 the other file is source 1: its line and column are UTF-16, its text is kept', () => {
    const applied = applyMappedEdits(
      code,
      [{ start: 5, end: 9, text: `const f = ${copied};`, copies: [{ gen: 10, orig: copiedAt, length: copied.length, source: 1 }] }],
      '/p/app.ts',
      [other],
    );
    expect(applied.code).toBe(`AAAA\nconst f = ${copied};\n`);
    expect(applied.map.sources).toEqual(['/p/app.ts', '/p/part.ts']);
    expect(applied.map.sourcesContent).toEqual([code, other.text]);
    const rows = rowsOf(applied.map);
    expect(rows[0]).toEqual([[0, 0, 0, 0]]);
    expect(rows[1]).toEqual([[10, 1, 1, 5], [17, 1, 1, 12]]);
  });

  it('T23-P10 several copies of one other file are several segments of that source', () => {
    const applied = applyMappedEdits(
      code,
      [{
        start: 5,
        end: 9,
        text: 'first(target) then(value)',
        copies: [
          { gen: 6, orig: other.text.indexOf('target'), length: 6, source: 1 },
          { gen: 19, orig: other.text.indexOf('value'), length: 5, source: 1 },
        ],
      }],
      '/p/app.ts',
      [other],
    );
    expect(rowsOf(applied.map)[1]).toEqual([[6, 1, 1, 5], [19, 1, 1, 12]]);
  });

  it('T23-P10 a copy that names a source the map does not have is not mapped', () => {
    const applied = applyMappedEdits(
      code,
      [{ start: 5, end: 9, text: 'abc', copies: [{ gen: 0, orig: 0, length: 3, source: 2 }] }],
      '/p/app.ts',
      [other],
    );
    expect(applied.code).toBe('AAAA\nabc\n');
    expect(rowsOf(applied.map)[1] ?? []).toEqual([]);
  });

  it('T23-P10 a copy that does not continue the one before it starts a segment, even inside a word', () => {
    const applied = applyMappedEdits(
      'ab----ef',
      [{
        start: 0,
        end: 8,
        text: 'abef',
        copies: [{ gen: 0, orig: 0, length: 2 }, { gen: 2, orig: 6, length: 2 }],
      }],
      '/p/app.ts',
    );
    expect(rowsOf(applied.map)[0]).toEqual([[0, 0, 0, 0], [2, 0, 0, 6]]);
  });

  it('T23-P10 copies of two sources side by side start a segment at the second', () => {
    const applied = applyMappedEdits(
      'ab',
      [{
        start: 0,
        end: 2,
        text: 'ab',
        copies: [{ gen: 0, orig: 0, length: 1 }, { gen: 1, orig: 0, length: 1, source: 1 }],
      }],
      '/p/app.ts',
      [{ name: '/p/part.ts', text: 'z' }],
    );
    expect(rowsOf(applied.map)[0]).toEqual([[0, 0, 0, 0], [1, 1, 0, 0]]);
  });

  it('T23-P10 every copy starts a segment, whether it continues the one before it, jumps in the same file, or comes from another file', () => {
    // No copy begins a word here (each follows a word character), so only the copy boundary can start a segment.
    const applied = applyMappedEdits(
      'abcdXXXXXXij',
      [{
        start: 0,
        end: 12,
        text: 'abcdzzij',
        copies: [
          { gen: 0, orig: 0, length: 2 },
          { gen: 2, orig: 2, length: 2 },
          { gen: 4, orig: 0, length: 2, source: 1 },
          { gen: 6, orig: 10, length: 2 },
        ],
      }],
      '/p/app.ts',
      [{ name: '/p/part.ts', text: 'zz' }],
    );
    expect(applied.code).toBe('abcdzzij');
    expect(rowsOf(applied.map)[0]).toEqual([[0, 0, 0, 0], [2, 0, 0, 2], [4, 1, 0, 0], [6, 0, 0, 10]]);
  });

  it('T23-P10 a map without another source has one source and its text', () => {
    const applied = applyMappedEdits(code, [], '/p/app.ts');
    expect(applied.map.sources).toEqual(['/p/app.ts']);
    expect(applied.map.sourcesContent).toEqual([code]);
  });
});

describe('T23-P10 a lone CR, U+2028 and U+2029 end a line, as CRLF does once (both sides of the map)', () => {
  it('T23-P10 a factory string with U+2028 and a lone CR: the code after each is at its exact original line and column', () => {
    const statement = "const f = () => 'x y\rz' + tail;";
    const code = `// head\n${statement}\n`;
    const applied = applyMappedEdits(
      code,
      [{
        start: 8,
        end: 8 + statement.length,
        text: statement.replace('const f', 'const g'),
        // `() => 'x<2028>y<CR>z' + tail`, without `const g = ` (10 characters) and the closing `;`.
        copies: [{ gen: 10, orig: 18, length: statement.length - 11 }],
      }],
      '/p/app.ts',
    );
    expect(applied.code).toBe(`// head\nconst g = () => 'x y\rz' + tail;\n`);
    // Original and generated lines: 0 `// head`, 1 `const f = () => 'x`, 2 `y`, 3 `z' + tail;`.
    expect(rowsOf(applied.map)).toEqual([
      [[0, 0, 0, 0], [3, 0, 0, 3]],
      [[10, 0, 1, 10], [17, 0, 1, 17]],
      [[0, 0, 2, 0]],
      [[0, 0, 3, 0], [5, 0, 3, 5]],
    ]);
  });

  it('T23-P10 U+2029 is a line end too', () => {
    const applied = applyMappedEdits(
      'k target',
      [{ start: 2, end: 8, text: 'target', copies: [{ gen: 0, orig: 2, length: 6 }] }],
      '/p/app.ts',
    );
    expect(rowsOf(applied.map)).toEqual([[[0, 0, 0, 0]], [[0, 0, 1, 0]]]);
  });

  it('T23-P10 generated text with U+2028, a lone CR and CRLF puts the next copy on its own line', () => {
    const applied = applyMappedEdits(
      'target',
      [{ start: 0, end: 6, text: 'q r\rs\r\nt target', copies: [{ gen: 9, orig: 0, length: 6 }] }],
      '/p/app.ts',
    );
    // Generated lines: `q` | `r` | `s` | `t target`. CRLF is one line end, not two.
    expect(rowsOf(applied.map)).toEqual([[], [], [], [[2, 0, 0, 0]]]);
  });

  it('T23-P10 a source text with U+2028, a lone CR and CRLF gives the copy its exact original line', () => {
    const other = { name: '/p/part.ts', text: 'a b\rc\r\nd target' };
    const applied = applyMappedEdits(
      'AAAA',
      [{ start: 0, end: 4, text: 'target', copies: [{ gen: 0, orig: other.text.indexOf('target'), length: 6, source: 1 }] }],
      '/p/app.ts',
      [other],
    );
    // Original lines: `a` | `b` | `c` | `d target`.
    expect(rowsOf(applied.map)).toEqual([[[0, 1, 3, 2]]]);
  });

  it('T23-P10 a CR that ends one piece and an LF that starts the next are one line end', () => {
    const applied = applyMappedEdits(
      '\nfoo',
      [{ start: 0, end: 4, text: 'a\r\nfoo', copies: [{ gen: 2, orig: 0, length: 4 }] }],
      '/p/app.ts',
    );
    expect(applied.code).toBe('a\r\nfoo');
    expect(rowsOf(applied.map)).toEqual([[], [[0, 0, 1, 0]]]);
  });
});

describe('T23-P10 the emitted map of a transformed file names the other files a copy comes from', () => {
  const primary = '/proj/a/app.ts';
  const partText = 'export const p = () => 42;\n';
  const original = 'ORIGINAL\n';
  const copied = '() => 42';
  const applied = applyMappedEdits(
    original,
    [{
      start: 0,
      end: 8,
      text: `const f = ${copied};`,
      copies: [{ gen: 10, orig: partText.indexOf(copied), length: copied.length, source: 1 }],
    }],
    primary,
    [{ name: '/proj/b/part.ts', text: partText }],
  );
  const sessions = new Map<string, SessionFileMap>([[primary, { map: applied.map, originalText: original }]]);

  /** A JS file that is the transformed text as it is: every position maps to itself. */
  function emittedMap(extra: Record<string, unknown>): string {
    const identity: SourceMapSegment[][] = [[[0, 0, 0, 0], [10, 0, 0, 10], [16, 0, 0, 16]]];
    const mappings = encodedMappings(new TraceMap({ version: 3, sources: ['x'], names: [], mappings: identity }));
    return JSON.stringify({ version: 3, file: 'app.js', names: [], mappings, ...extra });
  }

  function composed(emitted: string): { sources: string[]; sourcesContent?: (string | null)[]; sourceRoot?: string; rows: SourceMapSegment[][] } {
    const text = rewriteEmittedOutput('app.js.map', emitted, [{ fileName: primary }], sessions);
    const parsed = JSON.parse(text) as { sources: string[]; mappings: string; sourcesContent?: (string | null)[]; sourceRoot?: string };
    return { ...parsed, rows: rowsOf(parsed) };
  }

  it('T23-P10 the other file is added next to the emitted source, in the same style, with its text', () => {
    const result = composed(emittedMap({ sources: ['app.ts'], sourcesContent: [applied.code] }));
    expect(result.sources).toEqual(['app.ts', '../b/part.ts']);
    expect(result.sourcesContent).toEqual([original, partText]);
    expect(result.rows[0]).toEqual([[10, 1, 0, 17], [16, 1, 0, 23]]);
  });

  it('T23-P10 an emitted source written with an outDir keeps the path style', () => {
    const result = composed(emittedMap({ sources: ['../a/app.ts'], sourceRoot: '/src-root/' }));
    expect(result.sources).toEqual(['../a/app.ts', '../b/part.ts']);
    expect(result.sourceRoot).toBe('/src-root/');
    expect(result.sourcesContent).toBeUndefined();
  });

  it('T23-P10 a map whose copies all come from the transformed file keeps its sources', () => {
    const own = applyMappedEdits(
      original,
      [{ start: 0, end: 8, text: 'const f = ORIGINAL;', copies: [{ gen: 10, orig: 0, length: 8 }] }],
      primary,
    );
    const text = rewriteEmittedOutput(
      'app.js.map',
      emittedMap({ sources: ['app.ts'], sourcesContent: [own.code] }),
      [{ fileName: primary }],
      new Map<string, SessionFileMap>([[primary, { map: own.map, originalText: original }]]),
    );
    expect((JSON.parse(text) as { sources: string[] }).sources).toEqual(['app.ts']);
  });
});

function project(files: Record<string, string>): { program: ts.Program; graphs: DependencyGraph[]; dir: string } {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 't23-snapshot-')));
  dirs.push(dir);
  if (cwdToRestore === undefined) cwdToRestore = process.cwd();
  process.chdir(dir);
  const names: string[] = [];
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), text);
    names.push(path.join(dir, name));
  }
  const program = ts.createProgram(names, {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noLib: true,
    types: [],
    baseUrl: dir,
    paths: { '@djodjonx/neosyringe': [fileURLToPath(new URL('../../neosyringe/src/index.ts', import.meta.url))] },
  });
  return { program, graphs: new Analyzer(program).extractAll(), dir };
}

describe('T23-P10 analysisSnapshot holds the texts the graphs copy from, read from the Program', () => {
  const PART = [
    "import { definePartialConfig } from '@djodjonx/neosyringe';",
    'export class Remote {}',
    'export const part = definePartialConfig({',
    '  injections: [{ token: Remote, useFactory: true, dependencies: [], provider: () => new Remote() }],',
    '});',
    '',
  ].join('\n');
  const APP = [
    "import { defineBuilderConfig } from '@djodjonx/neosyringe';",
    "import { part } from './part';",
    'class Local {}',
    'export const container = defineBuilderConfig({',
    '  extends: [part],',
    '  injections: [{ token: Local, useFactory: true, dependencies: [], provider: () => new Local() }],',
    '});',
    '',
  ].join('\n');
  const UNRELATED = 'export const unrelated = 1;\n';

  it('T23-P10 it holds the file of every origin, and nothing else of the Program', () => {
    const { program, graphs, dir } = project({ 'app.ts': APP, 'part.ts': PART, 'unrelated.ts': UNRELATED });
    const container = graphs.filter((graph) => graph.exportedVariableName === 'container');
    const snapshot = analysisSnapshot(container, program);
    expect([...snapshot.files.keys()].sort()).toEqual([path.join(dir, 'app.ts'), path.join(dir, 'part.ts')]);
    expect(snapshot.files.get(path.join(dir, 'part.ts'))).toBe(PART);
    expect(snapshot.files.get(path.join(dir, 'app.ts'))).toBe(APP);
    expect(snapshot.id).toBe(snapshotOfFiles(snapshot.files).id);
  });

  it('T23-P10 a file the Program does not hold is not in the snapshot: its text is never guessed', () => {
    const { graphs, dir } = project({ 'app.ts': APP, 'part.ts': PART, 'unrelated.ts': UNRELATED });
    const container = graphs.filter((graph) => graph.exportedVariableName === 'container');
    const other = ts.createProgram([path.join(dir, 'unrelated.ts')], { noLib: true, types: [] });
    expect(other.getSourceFile(path.join(dir, 'app.ts'))).toBeUndefined();
    expect(analysisSnapshot(container, other).files.size).toBe(0);
  });

  it('T23-P10 graphs with no origin give an empty snapshot', () => {
    const { program } = project({ 'unrelated.ts': UNRELATED });
    expect(analysisSnapshot([], program).files.size).toBe(0);
  });
});

const MARKED_PART = [
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

const MARKED_APP = [
  "import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';",
  "import { part, type IA } from './part';",
  'interface IZ { held: unknown }',
  'interface IY { plain: number }',
  'class AImpl implements IA { n = 4; }',
  'export const container = defineBuilderConfig({',
  '  extends: [part],',
  '  injections: [',
  '    { token: useInterface<IA>(), provider: AImpl },',
  '    { token: useInterface<IZ>(), useValue: { held: useInterface<IA>() } },',
  '    { token: useInterface<IY>(), useFactory: true, dependencies: [], provider: () => ({ plain: 1 }) },',
  '  ],',
  '});',
  '',
].join('\n');

describe('T23-P10 attachRewrites carries the use-site rewrites of a provider and a useValue on the graph', () => {
  function attached(mutate?: (service: DependencyNode['service']) => void) {
    const { program, graphs, dir } = project({ 'app.ts': MARKED_APP, 'part.ts': MARKED_PART });
    const graph = graphs.find((item) => item.exportedVariableName === 'container');
    const sourceFile = program.getSourceFile(path.join(dir, 'app.ts'));
    if (!graph || !sourceFile) throw new Error('graphe absent');
    const checker = program.getTypeChecker();
    const usedTokens = new Map<string, UsedTokenEntry>();
    const edits: readonly SourceEdit[] = collectUseSiteEdits(sourceFile, checker, usedTokens);
    if (mutate) for (const node of graph.nodes.values()) mutate(node.service);
    attachRewrites(graph, sourceFile, edits, checker, usedTokens, new Map());
    const byToken = (name: string) => {
      const found = [...graph.nodes.values()].find((node) => node.service.tokenId.includes(name));
      if (!found) throw new Error(`missing ${name}`);
      return found.service;
    };
    return { byToken };
  }

  const markerIn = (text: string, within: string): { start: number; end: number } => {
    const start = text.indexOf('useInterface<IA>()', text.indexOf(within));
    return { start, end: start + 'useInterface<IA>()'.length };
  };
  const rewritten = expect.stringMatching(/^"IA_[0-9a-f]+"$/);

  it('T23-P10 a useValue of this file: the marker is a rewrite at its offsets in this file', () => {
    const value = attached().byToken('IZ').valueRewrites;
    expect(value).toEqual([{ ...markerIn(MARKED_APP, 'useValue: { held:'), text: rewritten }]);
  });

  it('T23-P10 a factory written in another file: the marker is a rewrite at its offsets in that file', () => {
    const factory = attached().byToken('IR');
    expect(factory.factoryRewrites).toEqual([{ ...markerIn(MARKED_PART, '(k: {'), text: rewritten }]);
    expect(factory.factorySource).toContain('useInterface<IA>()');
  });

  it('T23-P10 a provider with nothing to rewrite has no rewrites at all', () => {
    const plain = attached().byToken('IY');
    expect(plain.factoryRewrites).toBeUndefined();
    expect(plain.valueRewrites).toBeUndefined();
  });

  it('T23-P10 a service whose origin names another file than its registration gets none', () => {
    const { byToken } = attached((service) => {
      if (service.valueOrigin) service.valueOrigin = { ...service.valueOrigin, file: '/elsewhere.ts' };
    });
    expect(byToken('IZ').valueRewrites).toBeUndefined();
  });
});

describe('T23-P10 an emitted source the map does not name keeps the other file by its own name', () => {
  it('T23-P10 a null entry in `sources` is not a directory to write next to', () => {
    const applied = applyMappedEdits(
      'ORIGINAL\n',
      [{ start: 0, end: 8, text: 'const f = () => 1;', copies: [{ gen: 10, orig: 0, length: 6, source: 1 }] }],
      '/proj/a/app.ts',
      [{ name: '/proj/b/part.ts', text: '() => 1;\n' }],
    );
    const sessions = new Map<string, SessionFileMap>([['/proj/a/app.ts', { map: applied.map, originalText: 'ORIGINAL\n' }]]);
    const mappings = encodedMappings(new TraceMap({ version: 3, sources: ['x'], names: [], mappings: [[[10, 0, 0, 10]]] }));
    const text = rewriteEmittedOutput(
      'app.js.map',
      JSON.stringify({ version: 3, names: [], sources: [null], mappings }),
      [{ fileName: '/proj/a/app.ts' }],
      sessions,
    );
    expect((JSON.parse(text) as { sources: (string | null)[] }).sources).toEqual([null, '/proj/b/part.ts']);
  });
});
