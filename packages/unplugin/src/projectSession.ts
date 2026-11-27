import * as path from 'node:path';
import * as ts from 'typescript';

/** A lib or declaration SourceFile kept by a plugin instance. The stamp is the file text it was parsed from. */
export type DeclarationStore = Map<string, { stamp: string; source: ts.SourceFile }>;

export interface ProjectSessionOptions {
  /** Where lib and declaration SourceFiles live. The plugin instance owns it; close does not empty it. */
  declarationStore?: DeclarationStore;
  /** Called with the file name each time a project SourceFile is parsed (a cache miss). */
  onParse?: (file: string) => void;
}

export interface ProjectSessionStats {
  /** Programs created by `snapshot`. A snapshot at an unchanged revision adds nothing. */
  programsBuilt: number;
  sourcesParsed: number;
  sourcesReused: number;
  overlays: number;
  /** Invalidations by kind and reason, counted. Bounded by the number of distinct reasons. */
  invalidations: { kind: 'files' | 'environment'; reason: string; count: number }[];
}

interface Held {
  file: string;
  text: string;
  parseKey: string;
  source: ts.SourceFile;
}

type ParseOptions = ts.ScriptTarget | ts.CreateSourceFileOptions;

/** What decides the shape of a parsed SourceFile. The options object itself holds a function, which JSON drops. */
function parseKeyOf(options: ParseOptions): string {
  if (typeof options === 'number') return JSON.stringify({ languageVersion: options });
  return JSON.stringify({
    languageVersion: options.languageVersion,
    impliedNodeFormat: options.impliedNodeFormat,
    jsDocParsingMode: options.jsDocParsingMode,
  });
}

function parsedAs(source: ts.SourceFile, options: ParseOptions): boolean {
  const languageVersion = typeof options === 'number' ? options : options.languageVersion;
  const format = typeof options === 'number' ? undefined : options.impliedNodeFormat;
  return source.languageVersion === languageVersion && source.impliedNodeFormat === format;
}

/** The compiler options as one stable string, keys sorted. Two sessions compile alike only when it is equal. */
export function optionsFingerprint(options: ts.CompilerOptions): string {
  return JSON.stringify(options, (_key, value: unknown) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)));
  });
}

function isDeclarationName(file: string): boolean {
  return file.endsWith('.d.ts') || file.endsWith('.d.mts') || file.endsWith('.d.cts');
}

/**
 * One instance per plugin instance, project, compiler options and bundler environment. It owns the text
 * the bundler transformed (overlays), the parsed SourceFiles, and the one Program built from every root.
 * It never owns the Program of an IDE. Compiler options are fixed for its life: a change of options is a
 * new instance (`optionsFingerprint`).
 */
export class ProjectSession {
  closed = false;
  readonly #cwd: string;
  readonly #options: ts.CompilerOptions;
  readonly #declarations: DeclarationStore | undefined;
  readonly #onParse: ((file: string) => void) | undefined;
  readonly #libDirectory: string;
  readonly #overlays = new Map<string, string>();
  readonly #names = new Map<string, string>();
  readonly #sources = new Map<string, Held>();
  /** Resolved project imports per file: the closure the freshness probe walks. */
  readonly #edges = new Map<string, Set<string>>();
  readonly #dirty = new Set<string>();
  /** package.json and token manifests that carry a `neosyringe` key, with the text read at the last build. */
  readonly #manifests = new Map<string, string | undefined>();
  readonly #packageJsonOf = new Map<string, string | null>();
  /** Project declaration files the program read, by key: the ones `revalidate` compares with the disk. Lib files are not in it. */
  readonly #declared = new Map<string, string>();
  readonly #invalidations = new Map<string, { kind: 'files' | 'environment'; reason: string; count: number }>();
  #roots = new Map<string, string>();
  readonly #extraRoots = new Map<string, string>();
  #ambientRoots: string[] = [];
  #program: ts.Program | undefined;
  /** The last view `scoped` gave: one entry, so a build of N files does not hold N analyses. */
  #view: { program: ts.Program; entry: string; scoped: ts.Program } | undefined;
  #revision = 0;
  #builtRevision = -1;
  #allDirty = false;
  #environmentDirty = false;
  #programsBuilt = 0;
  #parsed = 0;
  #reused = 0;

  constructor(cwd: string, roots: readonly string[], options: ts.CompilerOptions, extra: ProjectSessionOptions = {}) {
    this.#cwd = cwd;
    this.#options = options;
    this.#declarations = extra.declarationStore;
    this.#onParse = extra.onParse;
    const lib = ts.getDefaultLibFilePath(options).replace(/\\/g, '/');
    this.#libDirectory = lib.slice(0, lib.lastIndexOf('/'));
    this.#roots = this.#rootMap(roots);
  }

  #key(file: string): string {
    const absolute = path.resolve(this.#cwd, file).replace(/\\/g, '/');
    return ts.sys.useCaseSensitiveFileNames ? absolute : absolute.toLowerCase();
  }

  /** The name a root keeps in the program: as given, with `/`. The SourceFile and its graphs are named by it. */
  #display(file: string): string {
    return file.replace(/\\/g, '/');
  }

  #rootMap(files: readonly string[]): Map<string, string> {
    const roots = new Map<string, string>();
    for (const file of files) roots.set(this.#key(file), this.#display(file));
    return roots;
  }

  #readDisk(file: string): string | undefined {
    return ts.sys.readFile(path.resolve(this.#cwd, file));
  }

  #assertOpen(): void {
    if (this.closed) throw new Error('[NeoSyringe] the project session is closed');
  }

  #touch(key: string): void {
    this.#dirty.add(key);
    this.#revision += 1;
  }

  #log(kind: 'files' | 'environment', reason: string): void {
    const id = `${kind}:${reason}`;
    const known = this.#invalidations.get(id);
    if (known) known.count += 1;
    else this.#invalidations.set(id, { kind, reason, count: 1 });
  }

  /** True when the session holds this file: an overlay, a parsed source, or a root. */
  has(file: string): boolean {
    const key = this.#key(file);
    return this.#overlays.has(key) || this.#sources.has(key) || this.#roots.has(key) || this.#extraRoots.has(key);
  }

  /**
   * Records the text of a file as the bundler transformed it. A text equal to the one on disk is no
   * overlay: the file is read from disk, and a build of N files does not make N revisions.
   */
  update(file: string, text: string): void {
    this.#assertOpen();
    const key = this.#key(file);
    const disk = this.#readDisk(file);
    const hadOverlay = this.#overlays.has(key);
    const held = this.#sources.get(key)?.text;
    if (text === disk) {
      this.#overlays.delete(key);
      this.#names.delete(key);
      if (hadOverlay || (held !== undefined && held !== text)) this.#touch(key);
      return;
    }
    if (this.#overlays.get(key) === text) return;
    this.#overlays.set(key, text);
    this.#names.set(key, this.#display(file));
    this.#touch(key);
  }

  /** The file is a root of the program even when the tsconfig does not list it (a file the plugin transformed). */
  addRoot(file: string): void {
    this.#assertOpen();
    const key = this.#key(file);
    if (this.#roots.has(key) || this.#extraRoots.has(key)) return;
    this.#extraRoots.set(key, this.#display(file));
    // A file the program already holds (imported by a root) changes nothing in it by becoming a root.
    if (!this.#sources.has(key)) this.#revision += 1;
  }

  /** The file is gone: its overlay, its parsed source and its root go, and the environment changes. */
  remove(file: string): void {
    this.#assertOpen();
    const key = this.#key(file);
    this.#overlays.delete(key);
    this.#names.delete(key);
    this.#sources.delete(key);
    this.#edges.delete(key);
    this.#extraRoots.delete(key);
    this.#roots.delete(key);
    this.invalidateEnvironment('delete');
  }

  /** The text the bundler transformed is no longer current (the file changed on disk): read the disk again. */
  dropOverlay(file: string): void {
    this.#assertOpen();
    const key = this.#key(file);
    if (this.#overlays.delete(key)) {
      this.#names.delete(key);
      this.#touch(key);
    }
  }

  /** The roots the tsconfig lists. A change of the list is a change of environment. */
  setRoots(roots: readonly string[]): void {
    this.#assertOpen();
    const next = this.#rootMap(roots);
    const same = next.size === this.#roots.size && [...next.keys()].every((key) => this.#roots.has(key));
    if (same) return;
    this.#roots = next;
    this.invalidateEnvironment('roots');
  }

  /** These files changed on disk, or all of them when none is named. Their text is read again at the next snapshot. */
  invalidateFiles(files?: readonly string[], reason = 'update'): void {
    this.#assertOpen();
    if (files === undefined) this.#allDirty = true;
    else for (const file of files) this.#dirty.add(this.#key(file));
    this.#revision += 1;
    this.#log('files', reason);
  }

  /**
   * A creation, a deletion, a package.json or a tsconfig changed what modules resolve to. Every text is
   * read again and the old Program is not reused: its resolutions would be kept for unchanged files.
   */
  invalidateEnvironment(reason: string): void {
    this.#assertOpen();
    this.#allDirty = true;
    this.#environmentDirty = true;
    this.#packageJsonOf.clear();
    this.#revision += 1;
    this.#log('environment', reason);
  }

  /**
   * Reads again the disk text of the files this entry reaches (its import closure), of the roots that are
   * scripts, and of the manifests of the packages it uses. A bundler without a watcher event for them
   * still gets the current text. Returns whether anything changed. A file with an overlay is not probed:
   * its text is not the disk text on purpose.
   */
  revalidate(entry: string): boolean {
    this.#assertOpen();
    // Nothing is held, or a rebuild already reads every file again: there is nothing new to learn.
    if (!this.#program || this.#allDirty) return false;
    const changed: string[] = [];
    let deleted = false;
    const seen = new Set<string>();
    const start = this.#key(entry);
    // An entry the program has not read yet has no known imports: every project file it holds is probed once.
    const queue = this.#sources.has(start) ? [start, ...this.#ambientRoots] : [...this.#sources.keys(), ...this.#declared.keys()];
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const key = queue[cursor];
      if (seen.has(key)) continue;
      seen.add(key);
      for (const next of this.#edges.get(key) ?? []) queue.push(next);
      if (this.#overlays.has(key) || this.#dirty.has(key)) continue;
      const held = this.#sources.get(key);
      // A project declaration file lives in the declaration store: its stamp is the text it was parsed from.
      const declared = held ? undefined : this.#declared.get(key);
      const file = held?.file ?? declared;
      if (file === undefined) continue;
      const known = held ? held.text : this.#declarations?.get(file)?.stamp;
      if (known === undefined) continue;
      const disk = this.#readDisk(file);
      if (disk === undefined) deleted = true;
      else if (disk !== known) changed.push(file);
    }
    let manifest = false;
    for (const [file, stamp] of this.#manifests) {
      if (ts.sys.readFile(file) !== stamp) manifest = true;
    }
    if (deleted) this.invalidateEnvironment('probe-delete');
    else if (changed.length > 0 || manifest) this.invalidateFiles(changed, manifest ? 'probe-manifest' : 'probe');
    return deleted || changed.length > 0 || manifest;
  }

  /** The overlays and the extra roots, to hand to a new instance that replaces this one. */
  carry(): { overlays: [string, string][]; roots: string[] } {
    const overlays: [string, string][] = [];
    for (const [key, text] of this.#overlays) overlays.push([this.#names.get(key) ?? key, text]);
    return { overlays, roots: [...this.#extraRoots.values()] };
  }

  /** The Program of the current revision: built from every root, with every overlay. Same revision, same object. */
  snapshot(): ts.Program {
    this.#assertOpen();
    if (this.#program && this.#builtRevision === this.#revision) return this.#program;
    const host = ts.createCompilerHost(this.#options, true);
    const accessed = new Set<string>();
    const oldProgram = this.#environmentDirty ? undefined : this.#program;
    if (oldProgram === undefined) this.#edges.clear();
    host.getCurrentDirectory = () => this.#cwd;
    host.readFile = (file) => this.#overlays.get(this.#key(file)) ?? this.#readDisk(file);
    host.fileExists = (file) => this.#overlays.has(this.#key(file)) || ts.sys.fileExists(path.resolve(this.#cwd, file));
    host.getSourceFile = (file, languageVersionOrOptions, _onError, shouldCreateNewSourceFile) => {
      accessed.add(this.#key(file));
      return this.#sourceFor(file, languageVersionOrOptions, shouldCreateNewSourceFile === true);
    };
    const cache = ts.createModuleResolutionCache(this.#cwd, (file) => host.getCanonicalFileName(file), this.#options);
    host.resolveModuleNameLiterals = (literals, containingFile, redirected, options, containingSourceFile) => {
      const results = literals.map((literal) => {
        const mode = ts.getModeForUsageLocation(containingSourceFile, literal, options);
        return ts.resolveModuleName(literal.text, containingFile, options, host, cache, redirected, mode);
      });
      this.#recordEdges(containingFile, results);
      return results;
    };
    const program = ts.createProgram({
      rootNames: [...this.#roots.values(), ...this.#extraRoots.values()],
      options: this.#options,
      host,
      oldProgram,
    });
    for (const key of this.#sources.keys()) if (!accessed.has(key)) this.#sources.delete(key);
    for (const key of this.#edges.keys()) if (!accessed.has(key)) this.#edges.delete(key);
    for (const key of this.#declared.keys()) if (!accessed.has(key)) this.#declared.delete(key);
    this.#program = program;
    this.#builtRevision = this.#revision;
    this.#dirty.clear();
    this.#allDirty = false;
    this.#environmentDirty = false;
    this.#programsBuilt += 1;
    this.#ambientRoots = [...this.#roots.keys(), ...this.#extraRoots.keys()].filter((key) => {
      const source = this.#sources.get(key)?.source ?? this.#declaredSource(key);
      return source !== undefined && !ts.isExternalModule(source);
    });
    this.#readManifests(program);
    return program;
  }

  /**
   * The Program one file's analysis reads. It is the Program of the current revision (its type checker, every
   * root, every overlay) seen through the files that entry imports, itself included. The analysis collects the
   * containers of the files the Program lists, so its cost follows what the entry depends on, not the number of
   * roots. The closure is the one `revalidate` walks. A container in a file the entry does not import, directly
   * or not, is not analysed. Declarations are left out: nothing is collected from them. Same revision and
   * entry, same object.
   */
  scoped(entry: string): ts.Program {
    const program = this.snapshot();
    const start = this.#key(entry);
    if (this.#view && this.#view.program === program && this.#view.entry === start) return this.#view.scoped;
    const listed = new Set<ts.SourceFile>();
    const seen = new Set<string>([start]);
    const queue = [start];
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const source = this.#sources.get(queue[cursor])?.source;
      if (source) listed.add(source);
      for (const next of this.#edges.get(queue[cursor]) ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        queue.push(next);
      }
    }
    const files = program.getSourceFiles().filter((source) => listed.has(source));
    const scoped: ts.Program = { ...program, getSourceFiles: () => files };
    this.#view = { program, entry: start, scoped };
    return scoped;
  }

  stats(): ProjectSessionStats {
    return {
      programsBuilt: this.#programsBuilt,
      sourcesParsed: this.#parsed,
      sourcesReused: this.#reused,
      overlays: this.#overlays.size,
      invalidations: [...this.#invalidations.values()].map((item) => ({ ...item })),
    };
  }

  /** Frees the sources, the overlays and the Program. The declaration store belongs to the plugin instance. */
  close(): void {
    this.closed = true;
    this.#program = undefined;
    this.#view = undefined;
    this.#builtRevision = -1;
    this.#overlays.clear();
    this.#names.clear();
    this.#sources.clear();
    this.#edges.clear();
    this.#dirty.clear();
    this.#manifests.clear();
    this.#packageJsonOf.clear();
    this.#declared.clear();
    this.#roots = new Map();
    this.#extraRoots.clear();
    this.#ambientRoots = [];
  }

  #declaredSource(key: string): ts.SourceFile | undefined {
    const file = this.#declared.get(key);
    return file === undefined ? undefined : this.#declarations?.get(file)?.source;
  }

  #isLibFile(file: string): boolean {
    return this.#libDirectory.length > 0 && file.replace(/\\/g, '/').startsWith(`${this.#libDirectory}/`);
  }

  #isDeclarationFile(file: string): boolean {
    return isDeclarationName(file) || this.#isLibFile(file);
  }

  #sourceFor(file: string, options: ParseOptions, fresh: boolean): ts.SourceFile | undefined {
    const key = this.#key(file);
    const overlay = this.#overlays.get(key);
    if (overlay === undefined && this.#declarations && this.#isDeclarationFile(file)) {
      return this.#declarationFor(file, key, options);
    }
    const held = this.#sources.get(key);
    let text: string | undefined;
    if (overlay !== undefined) text = overlay;
    else if (held && !this.#allDirty && !this.#dirty.has(key)) text = held.text;
    else text = this.#readDisk(file);
    if (text === undefined) {
      this.#sources.delete(key);
      return undefined;
    }
    const parseKey = parseKeyOf(options);
    if (held && !fresh && held.text === text && held.parseKey === parseKey) {
      this.#reused += 1;
      return held.source;
    }
    const source = ts.createSourceFile(file, text, options, true);
    this.#sources.set(key, { file, text, parseKey, source });
    this.#edges.delete(key);
    this.#parsed += 1;
    this.#onParse?.(file);
    return source;
  }

  #declarationFor(file: string, key: string, options: ParseOptions): ts.SourceFile | undefined {
    const store = this.#declarations;
    if (!store) return undefined;
    // A declaration file of the project, not of a package or of TypeScript itself, is probed by `revalidate`.
    if (!this.#isLibFile(file) && !file.replace(/\\/g, '/').includes('/node_modules/')) this.#declared.set(key, file);
    const cached = store.get(file);
    if (cached && !this.#allDirty && !this.#dirty.has(key) && parsedAs(cached.source, options)) {
      this.#reused += 1;
      return cached.source;
    }
    const text = this.#readDisk(file);
    if (text === undefined) {
      store.delete(file);
      this.#declared.delete(key);
      return undefined;
    }
    if (cached && cached.stamp === text && parsedAs(cached.source, options)) {
      this.#reused += 1;
      return cached.source;
    }
    const source = ts.createSourceFile(file, text, options, true);
    store.set(file, { stamp: text, source });
    this.#parsed += 1;
    return source;
  }

  #recordEdges(containingFile: string, results: readonly ts.ResolvedModuleWithFailedLookupLocations[]): void {
    const key = this.#key(containingFile);
    const edges = this.#edges.get(key) ?? new Set<string>();
    for (const result of results) {
      const resolved = result.resolvedModule;
      if (!resolved) continue;
      // The declarations of a package are not project text. Its TypeScript source is: a workspace package, or a
      // container shared as source, is read and analysed like any file the entry imports.
      if (resolved.isExternalLibraryImport && resolved.extension !== ts.Extension.Ts && resolved.extension !== ts.Extension.Tsx) continue;
      const name = resolved.resolvedFileName;
      if (this.#isDeclarationFile(name) && name.includes('/node_modules/')) continue;
      edges.add(this.#key(name));
    }
    this.#edges.set(key, edges);
  }

  /** The package.json owning a directory, or null. Memoized until the environment changes. */
  #owner(dir: string): string | null {
    const known = this.#packageJsonOf.get(dir);
    if (known !== undefined) return known;
    const candidate = path.posix.join(dir, 'package.json');
    const parent = path.posix.dirname(dir);
    const owner = ts.sys.fileExists(candidate) ? candidate : parent === dir ? null : this.#owner(parent);
    this.#packageJsonOf.set(dir, owner);
    return owner;
  }

  /**
   * The analysis reads token manifests with the file system, outside the Program. The text of a package.json
   * that names one, and of the manifest, is kept so `revalidate` can see an edit that no event announced.
   */
  #readManifests(program: ts.Program): void {
    this.#manifests.clear();
    const seen = new Set<string>();
    for (const source of program.getSourceFiles()) {
      const name = source.fileName.replace(/\\/g, '/');
      if (!name.includes('/node_modules/')) continue;
      const owner = this.#owner(path.posix.dirname(name));
      if (owner === null || seen.has(owner)) continue;
      seen.add(owner);
      const text = ts.sys.readFile(owner);
      if (text === undefined || !text.includes('"neosyringe"')) continue;
      this.#manifests.set(owner, text);
      const manifest = manifestPathOf(owner, text);
      if (manifest !== undefined) this.#manifests.set(manifest, ts.sys.readFile(manifest));
    }
  }
}

/** The `neosyringe.tokensManifest` path of a package.json text, resolved from its directory. */
function manifestPathOf(packageJson: string, text: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || !('neosyringe' in parsed)) return undefined;
  const section = parsed.neosyringe;
  if (typeof section !== 'object' || section === null || !('tokensManifest' in section)) return undefined;
  const relative = section.tokensManifest;
  return typeof relative === 'string' ? path.posix.join(path.posix.dirname(packageJson), relative) : undefined;
}
