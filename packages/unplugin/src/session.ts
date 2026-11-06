import * as path from 'node:path';
import { TraceMap, decodedMappings, encodedMappings, originalPositionFor, type SourceMapSegment } from '@jridgewell/trace-mapping';
import * as ts from 'typescript';
import { Analyzer, formatUnsupportedMarker, resolveNeoMarker, resolveProjectConfig, sourceFileUsesMarker } from '@djodjonx/neosyringe-core/analyzer';
import type { DependencyGraph, DependencyNode } from '@djodjonx/neosyringe-core/analyzer';
import { Generator, GraphValidator } from '@djodjonx/neosyringe-core/generator';
import { TSContext } from '@djodjonx/neosyringe-core/context';
import { serializeGraph } from '@djodjonx/neosyringe-ui';
import type { SerializableGraph } from '@djodjonx/neosyringe-ui';
import {
  canonicalPath,
  cloneGraph,
  configChainTexts,
  graphsForProgram,
  noteFileParsed,
} from './analysisCache';
import { collectDefinePartialConfigPureEdits, collectUseSiteEdits, type SourceEdit, type UsedTokenEntry } from './useInterfaceTransform';
import { callsCanReachNeoSyringe } from './markerUtils';

const VLQ_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export interface SessionSourceMap {
  version: 3;
  sources: string[];
  names: string[];
  mappings: string;
}

export interface ResolvedSessionConfig {
  root: string;
  options: ts.CompilerOptions;
  configPath: string;
  /** Text of the tsconfig and its extends chain. */
  contentStamp?: string;
}

/** Session map for one transformed file, plus the user's original text. */
export interface SessionFileMap {
  map: SessionSourceMap;
  originalText: string;
}

export interface SessionState {
  previousProgram?: ts.Program;
  cachedSources: Map<string, { stamp: string; source: ts.SourceFile }>;
  registeredTokens: Set<string>;
  usedTokens: Map<string, UsedTokenEntry>;
  generatedContainerVars: Set<string>;
  devtoolsGraphs: Map<string, SerializableGraph>;
  resolved?: ResolvedSessionConfig;
  graphs?: DependencyGraph[];
  graphProgram?: ts.Program;
  /** Project sources parsed on a cache miss. Not a package export. */
  filesParsed: number;
  /** Graphs produced by extractAll. A cache hit adds nothing. */
  graphsBuilt: number;
  /** Lib and declaration SourceFiles for this plugin instance only. */
  declarationSources: Map<string, { stamp: string; source: ts.SourceFile }>;
}

/** Test and bench handle for the SessionState closed over by one plugin instance. */
export const sessionStateKey: unique symbol = Symbol('neoSyringe.sessionState');

export interface SessionInput {
  code: string;
  id: string;
  project?: string;
  cwd: string;
  emitDebugHelpers: boolean;
  testOverrides: boolean;
  devtools: boolean;
  state: SessionState;
  errorPrefix: string;
  hostProgram?: ts.Program;
  hostSource?: ts.SourceFile;
}

export interface SessionOutput {
  code: string;
  map: SessionSourceMap | null;
}

interface MappedEdit {
  start: number;
  end: number;
  text: string;
  copies?: { gen: number; orig: number; length: number }[];
}

/** `\` → `/`, then drop `?query` and `#hash`. */
export function normalizeModuleId(id: string): string {
  const hash = id.indexOf('#');
  const noHash = hash === -1 ? id : id.slice(0, hash);
  const query = noHash.indexOf('?');
  const noQuery = query === -1 ? noHash : noHash.slice(0, query);
  return noQuery.replace(/\\/g, '/');
}

/** Extension of `id` before a query is removed. `.ts?v=1` is not `.ts`. */
function rawExtension(id: string): string {
  const hash = id.indexOf('#');
  const noHash = hash === -1 ? id : id.slice(0, hash);
  const slash = Math.max(noHash.lastIndexOf('/'), noHash.lastIndexOf('\\'));
  const dot = noHash.lastIndexOf('.');
  if (dot <= slash) return '';
  return noHash.slice(dot).toLowerCase();
}

/**
 * Name stored on the SourceFile.
 * An id whose own text ends in `.ts` or `.tsx` keeps its query (`App.vue?lang.ts`).
 * A query that merely follows a `.ts` path (`a.ts?v=1`) is removed.
 */
export function programFileName(id: string): string {
  const hash = id.indexOf('#');
  const noHash = hash === -1 ? id : id.slice(0, hash);
  const ext = rawExtension(noHash);
  if (ext === '.ts' || ext === '.tsx') return noHash.replace(/\\/g, '/');
  return normalizeModuleId(id);
}

export function moduleExtension(id: string): string {
  const ext = rawExtension(id);
  if (ext === '.ts' || ext === '.tsx' || ext === '.mts' || ext === '.cts') return ext;
  const base = normalizeModuleId(id);
  const slash = base.lastIndexOf('/');
  const dot = base.lastIndexOf('.');
  if (dot <= slash) return '';
  return base.slice(dot).toLowerCase();
}

export function shouldTransformId(id: string): boolean {
  const ext = moduleExtension(id);
  return ext === '.ts' || ext === '.tsx' || ext === '.mts' || ext === '.cts';
}

function vlq(value: number): string {
  let n = value < 0 ? ((-value) << 1) + 1 : value << 1;
  let encoded = '';
  for (;;) {
    let digit = n & 31;
    n >>>= 5;
    if (n > 0) digit |= 32;
    encoded += VLQ_CHARS[digit];
    if (n === 0) return encoded;
  }
}

function lineStartsOf(code: string): number[] {
  const starts = [0];
  for (let i = 0; i < code.length; i += 1) {
    if (code.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return starts;
}

function positionAt(starts: number[], offset: number): { line: number; column: number } {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (starts[mid] <= offset) low = mid;
    else high = mid - 1;
  }
  return { line: low, column: offset - starts[low] };
}

function isWordChar(code: number): boolean {
  return (code >= 48 && code <= 57)
    || (code >= 65 && code <= 90)
    || (code >= 97 && code <= 122)
    || code === 36
    || code === 95;
}

/** Line start, copy/generated boundary, or the first character of a word. */
function mappedSegment(lineStart: boolean, boundary: boolean, wordChar: boolean, prevWord: boolean): boolean {
  if (lineStart || boundary) return true;
  return wordChar && !prevWord;
}

function copiedOrigin(from: number, index: number): number {
  return from + index;
}

function encodeMappings(segments: readonly { genLine: number; genCol: number; orig: number }[], original: string): string {
  const starts = lineStartsOf(original);
  let prevGenCol = 0;
  let prevSrcLine = 0;
  let prevSrcCol = 0;
  let line = 0;
  const groups: string[][] = [[]];
  for (const segment of segments) {
    while (line < segment.genLine) {
      line += 1;
      groups.push([]);
      prevGenCol = 0;
    }
    const pos = positionAt(starts, segment.orig);
    groups[line].push(
      vlq(segment.genCol - prevGenCol) +
      vlq(0) +
      vlq(pos.line - prevSrcLine) +
      vlq(pos.column - prevSrcCol),
    );
    prevGenCol = segment.genCol;
    prevSrcLine = pos.line;
    prevSrcCol = pos.column;
  }
  return groups.map((group) => group.join(',')).join(';');
}

/**
 * Applies edits on the original text and emits one v3 map.
 * Segments sit on line starts, copy boundaries and word starts.
 * trace-mapping does not interpolate columns, so a word start keeps its column.
 */
export function applyMappedEdits(code: string, edits: readonly MappedEdit[], sourceName: string): { code: string; map: SessionSourceMap } {
  const sorted = edits
    .filter((edit) => edit.start >= 0 && edit.end >= edit.start && edit.start <= code.length)
    .map((edit) => ({ ...edit, end: Math.min(edit.end, code.length) }))
    .sort((a, b) => a.start - b.start || b.end - a.end);
  const chosen: MappedEdit[] = [];
  let cursor = 0;
  for (const edit of sorted) {
    if (edit.start < cursor) continue;
    chosen.push(edit);
    cursor = edit.end;
  }

  const parts: string[] = [];
  const segments: { genLine: number; genCol: number; orig: number }[] = [];
  let genLine = 0;
  let genCol = 0;
  let mappedBefore = false;
  let prevWord = false;
  const emit = (text: string, originalAt: ((index: number) => number) | null): void => {
    if (originalAt === null) mappedBefore = false;
    if (text.length === 0) return;
    for (let index = 0; index < text.length; index += 1) {
      const codePoint = text.charCodeAt(index);
      if (codePoint === 10) {
        genLine += 1;
        genCol = 0;
        mappedBefore = false;
        prevWord = false;
        continue;
      }
      const origin = originalAt === null ? -1 : originalAt(index);
      const mapped = origin >= 0;
      if (mapped && mappedSegment(genCol === 0, !mappedBefore, isWordChar(codePoint), prevWord)) {
        segments.push({ genLine, genCol, orig: origin });
      }
      mappedBefore = mapped;
      prevWord = isWordChar(codePoint);
      genCol += 1;
    }
    parts.push(text);
  };
  const emitReplacement = (edit: MappedEdit): void => {
    const copies = [...(edit.copies ?? [])].sort((a, b) => a.gen - b.gen);
    let at = 0;
    for (const copy of copies) {
      if (copy.gen < at || copy.length <= 0) continue;
      emit(edit.text.slice(at, copy.gen), null);
      const length = Math.min(copy.length, edit.text.length - copy.gen);
      emit(edit.text.slice(copy.gen, copy.gen + length), (index) => copiedOrigin(copy.orig, index));
      at = copy.gen + length;
    }
    emit(edit.text.slice(at), null);
  };

  let from = 0;
  for (const edit of chosen) {
    emit(code.slice(from, edit.start), (index) => copiedOrigin(from, index));
    emitReplacement(edit);
    from = edit.end;
  }
  emit(code.slice(from), (index) => copiedOrigin(from, index));
  const edited = parts.join('');
  return {
    code: edited,
    map: {
      version: 3,
      sources: [sourceName],
      names: [],
      mappings: encodeMappings(segments, code),
    },
  };
}

/** Excludes TS18003 (no input files). Joins the remaining diagnostic messages. */
export function blockingConfigMessage(
  diagnostics: readonly ts.Diagnostic[],
  tsInstance: typeof ts,
): string | undefined {
  const blocking = diagnostics.filter((diagnostic) => diagnostic.code !== 18003);
  if (blocking.length === 0) return undefined;
  return blocking
    .map((diagnostic) => tsInstance.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
    .join('\n  ');
}

function resolveCached(input: SessionInput): ResolvedSessionConfig {
  const previous = input.state.resolved;
  const abs = input.project
    ? path.resolve(input.cwd, input.project)
    : ts.findConfigFile(input.cwd, ts.sys.fileExists, 'tsconfig.json');
  let knownChain: string | undefined;
  if (abs && previous && previous.configPath === abs) {
    const chain = configChainTexts(abs);
    if (previous.contentStamp === chain) return previous;
    knownChain = chain;
  }
  const resolved = resolveProjectConfig(input.cwd, input.project);
  const messages = blockingConfigMessage(resolved.parseErrors, ts);
  if (messages !== undefined) {
    throw new Error(`${input.errorPrefix}\n  ${messages}`);
  }
  if (previous) {
    // registeredTokens and usedTokens stay. They belong to the build, not to this tsconfig.
    input.state.previousProgram = undefined;
    input.state.cachedSources = new Map();
    input.state.graphs = undefined;
    input.state.graphProgram = undefined;
  }
  const chain = knownChain !== undefined && resolved.configPath === abs
    ? knownChain
    : configChainTexts(resolved.configPath);
  const stored: ResolvedSessionConfig = {
    root: resolved.root,
    options: resolved.options,
    configPath: resolved.configPath,
    contentStamp: chain,
  };
  input.state.resolved = stored;
  return stored;
}

function rejectUnsupportedMarkers(sourceFile: ts.SourceFile, checker: ts.TypeChecker): void {
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const marker = resolveNeoMarker(checker, node);
      if (marker && typeof marker === 'object') {
        throw new Error(formatUnsupportedMarker(node));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

function propertyInitializer(node: ts.Node, name: string): ts.Expression | undefined {
  if (!ts.isObjectLiteralExpression(node)) return undefined;
  for (const prop of node.properties) {
    if (!ts.isPropertyAssignment(prop)) continue;
    const propName = prop.name;
    if ((ts.isIdentifier(propName) || ts.isStringLiteral(propName)) && propName.text === name) {
      return prop.initializer;
    }
  }
  return undefined;
}

/** Applies use-site edits that sit entirely inside one embedded expression. */
function rewriteEmbedded(code: string, start: number, end: number, edits: readonly SourceEdit[]): string {
  const inner = edits
    .filter((edit) => edit.start >= start && edit.end <= end)
    .sort((a, b) => b.start - a.start);
  let text = code.slice(start, end);
  for (const edit of inner) {
    const relStart = edit.start - start;
    const relEnd = edit.end - start;
    text = text.slice(0, relStart) + edit.text + text.slice(relEnd);
  }
  return text;
}

function visitServices(graph: DependencyGraph, visit: (node: DependencyNode) => void): void {
  for (const node of graph.nodes.values()) visit(node);
  if (!graph.multiNodes) return;
  for (const nodes of graph.multiNodes.values()) {
    for (const node of nodes) visit(node);
  }
}

/** Use-site edits of one foreign file, walked once per compileWith call. */
function cachedForeignUseEdits(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  usedTokens: Map<string, UsedTokenEntry>,
  cache: Map<ts.SourceFile, readonly SourceEdit[]>,
): readonly SourceEdit[] {
  const cached = cache.get(sourceFile);
  if (cached) return cached;
  const collected = collectUseSiteEdits(sourceFile, checker, usedTokens);
  cache.set(sourceFile, collected);
  return collected;
}

/**
 * Rewrites use-site calls inside a provider or useValue before the generator
 * copies that text. The original offset is the initializer's start.
 * A registration that lives in another file is rewritten from that file.
 * Its offset belongs to that file, so it is not a source-map copy.
 */
function collectEmbeddings(
  graph: DependencyGraph,
  sourceFile: ts.SourceFile,
  code: string,
  edits: readonly SourceEdit[],
  checker: ts.TypeChecker,
  usedTokens: Map<string, UsedTokenEntry>,
  foreignEdits: Map<ts.SourceFile, readonly SourceEdit[]>,
): { orig: number; needle: string }[] {
  const found: { orig: number; needle: string }[] = [];
  visitServices(graph, (node) => {
    if (!node.service?.registrationNode) return;
    const registration = node.service.registrationNode;
    const registrationFile = registration.getSourceFile();
    const foreign = registrationFile !== sourceFile;
    const text = foreign ? registrationFile.text : code;
    const fileEdits = foreign
      ? cachedForeignUseEdits(registrationFile, checker, usedTokens, foreignEdits)
      : edits;
    const factory = node.service.type === 'factory' ? node.service.factorySource : undefined;
    const value = node.service.type === 'value' ? node.service.valueSource : undefined;
    const initializer = factory !== undefined
      ? propertyInitializer(registration, 'provider')
      : value !== undefined
        ? propertyInitializer(registration, 'useValue')
        : undefined;
    if (!initializer) return;
    const start = initializer.getStart(registrationFile);
    const end = initializer.getEnd();
    const needle = text.slice(start, end);
    if (needle !== (factory !== undefined ? factory : value)) return;
    const rewritten = rewriteEmbedded(text, start, end, fileEdits);
    if (factory !== undefined) node.service.factorySource = rewritten;
    else node.service.valueSource = rewritten;
    if (foreign) return;
    found.push({ orig: start, needle });
  });
  return found;
}

/** One whole-token hit, or none. A second hit, or a hit inside an identifier, is not mapped. */
function soleWholeToken(haystack: string, needle: string): number | undefined {
  if (needle.length === 0) return undefined;
  let found = -1;
  let count = 0;
  let from = 0;
  while (from < haystack.length) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) break;
    const before = at > 0 ? haystack.charCodeAt(at - 1) : 0;
    const afterAt = at + needle.length;
    const after = afterAt < haystack.length ? haystack.charCodeAt(afterAt) : 0;
    if (!isWordChar(before) && !isWordChar(after)) {
      count += 1;
      found = at;
      if (count > 1) return undefined;
    }
    from = at + 1;
  }
  return count === 1 ? found : undefined;
}

function isProjectParse(fileName: string, root: string): boolean {
  const canon = canonicalPath(fileName);
  const base = canonicalPath(root).replace(/\/$/, '');
  if (canon !== base && !canon.startsWith(`${base}/`)) return false;
  return !canon.endsWith('.d.ts') && !canon.endsWith('.d.mts') && !canon.endsWith('.d.cts');
}

function rememberSource(
  state: SessionState,
  fileName: string,
  sourceText: string,
  projectRoot: string | undefined,
): ts.SourceFile {
  const canon = canonicalPath(fileName);
  const cached = state.cachedSources.get(fileName) ?? state.cachedSources.get(canon);
  if (cached && cached.stamp === sourceText) {
    state.cachedSources.set(fileName, cached);
    return cached.source;
  }
  const created = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
  const stored = { stamp: sourceText, source: created };
  state.cachedSources.set(fileName, stored);
  state.cachedSources.set(canon, stored);
  if (projectRoot && isProjectParse(fileName, projectRoot)) noteFileParsed(state);
  return created;
}

function compileWith(input: SessionInput, resolved: ResolvedSessionConfig | undefined): SessionOutput {
  const key = programFileName(input.id);
  if (!input.hostProgram && !callsCanReachNeoSyringe(input.code, key, resolved?.options ?? {})) {
    return { code: input.code, map: null };
  }
  let program = input.hostProgram;
  if (!program) {
    const options = resolved?.options ?? {};
    const projectRoot = resolved?.root;
    const norm = (fileName: string) => fileName.replace(/\\/g, '/');
    const compilerHost: ts.CompilerHost = {
      getSourceFile: (fileName) => {
        const isEntry = norm(fileName) === key || canonicalPath(fileName) === canonicalPath(key);
        if (isEntry) return rememberSource(input.state, fileName, input.code, projectRoot);
        try {
          const sourceText = ts.sys.readFile(fileName);
          if (!sourceText) return undefined;
          return rememberSource(input.state, fileName, sourceText, projectRoot);
        } catch {
          return undefined;
        }
      },
      getDefaultLibFileName: (opts) => ts.getDefaultLibFileName(opts),
      writeFile: () => {},
      getCurrentDirectory: () => input.cwd,
      getDirectories: (dir) => ts.sys.getDirectories(dir),
      fileExists: (fileName) => {
        if (norm(fileName) === key) return true;
        return ts.sys.fileExists(fileName);
      },
      readFile: (fileName) => {
        if (norm(fileName) === key) return input.code;
        return ts.sys.readFile(fileName);
      },
      getCanonicalFileName: (fileName) => fileName,
      useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
      getNewLine: () => '\n',
    };
    program = ts.createProgram([key], options, compilerHost, input.state.previousProgram);
    input.state.previousProgram = program;
  }

  const checker = program.getTypeChecker();
  const sourceFile = input.hostSource
    ?? (typeof program.getSourceFile === 'function' ? program.getSourceFile(key) ?? program.getSourceFile(input.id) : undefined);
  if (
    sourceFile &&
    typeof checker.getSymbolAtLocation === 'function' &&
    !sourceFileUsesMarker(checker, sourceFile)
  ) {
    return { code: input.code, map: null };
  }
  if (sourceFile && typeof checker.getSymbolAtLocation === 'function') {
    rejectUnsupportedMarkers(sourceFile, checker);
  }

  // Same host program object: the files cannot have changed inside this call.
  let allGraphs: DependencyGraph[];
  if (input.hostProgram && input.state.graphProgram === program && input.state.graphs) {
    allGraphs = input.state.graphs.map(cloneGraph);
  } else {
    allGraphs = graphsForProgram(
      input.state,
      () => new Analyzer(program).extractAll(),
      input.hostProgram,
    );
  }

  for (const graph of allGraphs) {
    if (!graph.errors || graph.errors.length === 0) continue;
    const graphFile = (graph.sourceFileName ?? key).replace(/\\/g, '/');
    if (graphFile !== key) continue;
    const messages = graph.errors.map((error) => `${input.errorPrefix} ${error.message}`).join('\n');
    const buildError = new Error(messages) as Error & { file?: string };
    buildError.name = graph.errors[0].type === 'duplicate' ? 'DuplicateRegistrationError' : 'TypeMismatchError';
    buildError.file = graph.sourceFileName ?? input.id;
    throw buildError;
  }

  for (const graph of allGraphs) {
    for (const tokenId of graph.nodes.keys()) input.state.registeredTokens.add(tokenId);
    if (graph.multiNodes) {
      for (const tokenId of graph.multiNodes.keys()) input.state.registeredTokens.add(tokenId);
    }
    if (graph.parentProvidedTokens) {
      for (const tokenId of graph.parentProvidedTokens) input.state.registeredTokens.add(tokenId);
    }
  }

  const thisFileGraphs = allGraphs.filter((graph) => {
    const graphFile = (graph.sourceFileName ?? key).replace(/\\/g, '/');
    return graphFile === key &&
      graph.defineBuilderConfigStart !== undefined &&
      graph.defineBuilderConfigEnd !== undefined &&
      graph.variableStatementStart !== undefined;
  });

  if (thisFileGraphs.length > 0) {
    const validator = new GraphValidator();
    for (const graph of thisFileGraphs) {
      const validationResult = validator.validateAll(graph);
      if (!validationResult.valid) {
        const messages = validationResult.errors.map((error) => error.message).join('\n  ');
        const buildError = new Error(`${input.errorPrefix}\n  ${messages}`) as Error & { file?: string };
        buildError.file = input.id;
        throw buildError;
      }
    }
  }

  const pureEdits: SourceEdit[] = [];
  const useEdits: SourceEdit[] = [];
  if (sourceFile && typeof checker.getSymbolAtLocation === 'function') {
    pureEdits.push(...collectDefinePartialConfigPureEdits(sourceFile, checker));
    useEdits.push(...collectUseSiteEdits(sourceFile, checker, input.state.usedTokens));
  }

  const foreignEdits = new Map<ts.SourceFile, readonly SourceEdit[]>();
  const edits: MappedEdit[] = [];
  for (const graph of thisFileGraphs) {
    const embeddings = sourceFile
      ? collectEmbeddings(graph, sourceFile, input.code, useEdits, checker, input.state.usedTokens, foreignEdits)
      : [];
    const generator = new Generator(graph, true, undefined, input.emitDebugHelpers, input.testOverrides);
    const containerClass = generator.generate();
    const instantiation = generator.generateInstantiation();
    const start = graph.variableStatementStart!;
    const end = graph.defineBuilderConfigEnd!;
    const varDecl = input.code.slice(start, graph.defineBuilderConfigStart!);
    const text = containerClass + '\n' + varDecl + instantiation;
    const copies: { gen: number; orig: number; length: number }[] = [];
    if (varDecl.length > 0) {
      copies.push({ gen: containerClass.length + 1, orig: start, length: varDecl.length });
    }
    // Provider and useValue positions come from the injection object.
    // Map one only when that exact text occurs once, on a whole token, in the class.
    for (const embedding of embeddings) {
      const gen = soleWholeToken(text, embedding.needle);
      if (gen === undefined) continue;
      copies.push({ gen, orig: embedding.orig, length: embedding.needle.length });
    }
    edits.push({ start, end, text, copies });
    if (graph.exportedVariableName) input.state.generatedContainerVars.add(graph.exportedVariableName);
  }

  if (sourceFile && typeof checker.getSymbolAtLocation === 'function') {
    const ranges = edits.map((edit) => ({ start: edit.start, end: edit.end }));
    const outside = (offset: number) => !ranges.some((range) => offset >= range.start && offset < range.end);
    for (const edit of pureEdits) {
      if (outside(edit.start)) edits.push(edit);
    }
    for (const edit of useEdits) {
      if (outside(edit.start)) edits.push(edit);
    }
  }

  if (input.devtools) {
    const fileKey = programFileName(input.id);
    for (const [graphKey, stored] of input.state.devtoolsGraphs) {
      if ((stored.sourceFileName ?? '').replace(/\\/g, '/') === fileKey) {
        input.state.devtoolsGraphs.delete(graphKey);
      }
    }
    for (const graph of thisFileGraphs) {
      const graphKey = graph.containerKey ?? `${fileKey}:${graph.defineBuilderConfigStart}`;
      input.state.devtoolsGraphs.set(graphKey, serializeGraph(graph));
    }
  }

  if (edits.length === 0) return { code: input.code, map: null };
  const edited = applyMappedEdits(input.code, edits, input.id);
  return { code: edited.code, map: edited.map };
}

export function runCompilationSession(input: SessionInput): SessionOutput {
  if (input.hostProgram && !input.project) {
    const configFilePath = input.hostProgram.getCompilerOptions().configFilePath;
    const root = typeof configFilePath === 'string' ? path.dirname(configFilePath) : input.cwd;
    return TSContext.runWithProjectRoot(root, () => compileWith(input, undefined));
  }
  const resolved = resolveCached(input);
  return TSContext.runWithProjectRoot(resolved.root, () => compileWith(input, resolved));
}

interface EmittedSourceMap {
  version: 3;
  file?: string;
  sourceRoot?: string;
  sources?: (string | null)[];
  sourcesContent?: (string | null)[];
  names?: string[];
  mappings?: string;
}

/**
 * Composes an emitted `.js` or `.js.map` with the session map
 * (generated JS → transformed TS → original TS).
 * `.d.ts` and `.d.ts.map` are left untouched, so `declarationMap` still points
 * at the transformed text. `.tsbuildinfo` is not rewritten either: an
 * incremental host keeps the transformed text.
 */
export function rewriteEmittedOutput(
  fileName: string,
  text: string,
  sourceFiles: readonly { fileName: string }[] | undefined,
  sessions: ReadonlyMap<string, SessionFileMap>,
): string {
  if (fileName.endsWith('.d.ts') || fileName.endsWith('.d.ts.map')) return text;
  if (fileName.endsWith('.js.map')) return composeMapText(text, sourceFiles, sessions);
  if (fileName.endsWith('.js')) return composeInlineMap(text, sourceFiles, sessions);
  return text;
}

function composeInlineMap(
  text: string,
  sourceFiles: readonly { fileName: string }[] | undefined,
  sessions: ReadonlyMap<string, SessionFileMap>,
): string {
  const match = text.match(/((?:\/\/[#@]|\/\*#)[ \t]*sourceMappingURL=data:application\/json(?:;charset=utf-8)?;base64,)([A-Za-z0-9+/=]+)/);
  if (!match || match.index === undefined) return text;
  let json: string;
  try {
    json = Buffer.from(match[2], 'base64').toString('utf8');
  } catch {
    return text;
  }
  const composed = composeMapText(json, sourceFiles, sessions);
  if (composed === json) return text;
  const encoded = Buffer.from(composed, 'utf8').toString('base64');
  return text.slice(0, match.index) + match[1] + encoded + text.slice(match.index + match[0].length);
}

function composeMapText(
  text: string,
  sourceFiles: readonly { fileName: string }[] | undefined,
  sessions: ReadonlyMap<string, SessionFileMap>,
): string {
  let emitted: EmittedSourceMap;
  try {
    emitted = JSON.parse(text) as EmittedSourceMap;
  } catch {
    return text;
  }
  if (emitted.version !== 3 || typeof emitted.mappings !== 'string') return text;
  const sources = emitted.sources ?? [];
  const bound = bindSessions(sources, sourceFiles, sessions);
  if (!bound.some((record) => record)) return text;

  const tracers = new Map<SessionFileMap, TraceMap>();
  const tracerFor = (record: SessionFileMap): TraceMap => {
    const cached = tracers.get(record);
    if (cached) return cached;
    const created = new TraceMap(record.map);
    tracers.set(record, created);
    return created;
  };

  const nextContent = emitted.sourcesContent ? emitted.sourcesContent.slice() : undefined;
  if (nextContent) {
    for (let index = 0; index < nextContent.length; index += 1) {
      const record = bound[index];
      if (record && nextContent[index] != null) nextContent[index] = record.originalText;
    }
  }

  const decoded = decodedMappings(new TraceMap({
    version: 3,
    file: emitted.file,
    names: emitted.names ?? [],
    sources,
    sourcesContent: emitted.sourcesContent,
    mappings: emitted.mappings,
  }));
  const mappings: SourceMapSegment[][] = decoded.map((row) => {
    const next: SourceMapSegment[] = [];
    for (const segment of row) {
      const generatedColumn = segment[0];
      const sourceIndex = segment[1];
      const sourceLine = segment[2];
      const sourceColumn = segment[3];
      const nameIndex = segment[4];
      if (sourceIndex === undefined || sourceLine === undefined || sourceColumn === undefined) {
        next.push([generatedColumn]);
        continue;
      }
      const record = bound[sourceIndex];
      if (!record) {
        next.push(nameIndex === undefined
          ? [generatedColumn, sourceIndex, sourceLine, sourceColumn]
          : [generatedColumn, sourceIndex, sourceLine, sourceColumn, nameIndex]);
        continue;
      }
      // Copied columns outside the container are word-start granular.
      // The session map records word starts, and trace-mapping does not fill the gap.
      const pos = originalPositionFor(tracerFor(record), { line: sourceLine + 1, column: sourceColumn });
      if (pos.line == null || pos.column == null) continue;
      const composedLine = pos.line - 1;
      const composedColumn = pos.column;
      next.push(nameIndex === undefined
        ? [generatedColumn, sourceIndex, composedLine, composedColumn]
        : [generatedColumn, sourceIndex, composedLine, composedColumn, nameIndex]);
    }
    return next;
  });

  const encoded = encodedMappings(new TraceMap({
    version: 3,
    file: emitted.file,
    names: emitted.names ?? [],
    sources,
    sourcesContent: nextContent,
    mappings,
  }));
  const output: EmittedSourceMap = {
    version: 3,
    file: emitted.file,
    sources,
    names: emitted.names ?? [],
    mappings: encoded,
  };
  if (emitted.sourceRoot !== undefined) output.sourceRoot = emitted.sourceRoot;
  if (nextContent) output.sourcesContent = nextContent;
  return JSON.stringify(output);
}

function bindSessions(
  sources: readonly (string | null)[],
  sourceFiles: readonly { fileName: string }[] | undefined,
  sessions: ReadonlyMap<string, SessionFileMap>,
): (SessionFileMap | undefined)[] {
  if (sourceFiles && sourceFiles.length === sources.length) {
    return sourceFiles.map((file) => sessions.get(file.fileName));
  }
  return sources.map((): SessionFileMap | undefined => undefined);
}
