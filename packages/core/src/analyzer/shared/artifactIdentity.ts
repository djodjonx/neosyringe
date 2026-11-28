import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { TSContext } from '../../TSContext';

/**
 * Stable identity of one generated container.
 * `projectId` is the package name, plus `#` and the tsconfig directory when that
 * directory sits inside the package. `relativeFile` never contains `..`.
 */
export interface ArtifactIdentity {
  projectId: string;
  relativeFile: string;
  declarationId: string;
}

const MESSAGE = 'stable project-relative identity required';

/**
 * Marker for a file outside every known root.
 * The rest is a posix absolute path, or a drive letter and a slash path.
 * Any other form is refused. A rooted relative path never uses it.
 */
function isAcceptedUnrooted(file: string): boolean {
  const rest = file.slice('unrooted:'.length);
  const posix = rest.startsWith('/');
  const drive = /^[A-Za-z]:\//.test(rest);
  if (!posix && !drive) return false;
  const segments = rest.split('/').slice(1);
  if (segments.length === 0) return false;
  return segments.every((part) => part.length > 0 && part !== '.' && part !== '..');
}

/** Canonical text hashed into an internal artifact id. Not a public token. */
export function artifactDescriptor(input: ArtifactIdentity): string {
  const projectId = input.projectId;
  const declarationId = input.declarationId;
  const file = input.relativeFile.replaceAll('\\', '/');
  if (projectId.length === 0 || declarationId.length === 0 || file.length === 0) {
    throw new Error(MESSAGE);
  }
  if (file.startsWith('unrooted:')) {
    if (!isAcceptedUnrooted(file)) throw new Error(MESSAGE);
  } else if (file.startsWith('/')) {
    throw new Error(MESSAGE);
  } else if (/^[A-Za-z]:/.test(file)) {
    throw new Error(MESSAGE);
  } else if (file.split('/').some((part) => part === '..')) {
    throw new Error(MESSAGE);
  } else if (file.split('/').some((part) => part === '.')) {
    throw new Error(MESSAGE);
  }
  return JSON.stringify(['neo-artifact-v1', projectId, file, declarationId]);
}

/** First 24 hex characters of the artifact descriptor. `hash` replaces SHA-256 in tests. */
export function hashArtifactDescriptor(descriptor: string, hash?: (descriptor: string) => string): string {
  const full = hash ? hash(descriptor) : createHash('sha256').update(descriptor).digest('hex');
  return full.slice(0, 24);
}

export function artifactId(input: ArtifactIdentity, hash?: (descriptor: string) => string): string {
  return hashArtifactDescriptor(artifactDescriptor(input), hash);
}

/**
 * One registry per build. Each key remembers the normalized source that owns it.
 * `bind` drops that source's keys, so the same file may compile again.
 * A different source on the same key throws `identity collision`,
 * even when the descriptor text is the same.
 */
export class CollisionRegistry {
  #descriptors = new Map<string, string>();
  #owner = new Map<string, string>();
  #bound: string | undefined;

  /** Attribute the next registrations to `file` and drop the ones it already owns. */
  bind(file: string): void {
    this.release(file);
    this.#bound = file;
  }

  /** Drop the keys owned by `file`. A deleted file no longer occupies them. */
  release(file: string): void {
    const keys: string[] = [];
    for (const [key, owner] of this.#owner) {
      if (owner === file) keys.push(key);
    }
    for (const key of keys) {
      this.#owner.delete(key);
      this.#descriptors.delete(key);
    }
    if (this.#bound === file) this.#bound = undefined;
  }

  /** Drop every key. The session does this when the watcher closes. */
  clear(): void {
    this.#descriptors.clear();
    this.#owner.clear();
    this.#bound = undefined;
  }

  register(key: string, descriptor: string): void {
    const previous = this.#descriptors.get(key);
    const owner = this.#owner.get(key);
    if (previous !== undefined && previous !== descriptor) {
      throw new Error('identity collision');
    }
    if (owner !== undefined && owner !== this.#bound) {
      throw new Error('identity collision');
    }
    this.#descriptors.set(key, descriptor);
    if (this.#bound !== undefined) this.#owner.set(key, this.#bound);
  }
}

export interface ArtifactSource {
  sourceFileName?: string;
  defineBuilderConfigStart?: number;
  containerId: string;
}

function packageName(file: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || !('name' in parsed)) return undefined;
  const name = parsed.name;
  return typeof name === 'string' && name.length > 0 ? name : undefined;
}

function hasDriveLetter(file: string): boolean {
  return /^[A-Za-z]:/.test(file.replaceAll('\\', '/'));
}

interface PathApi {
  resolve(file: string): string;
  join(...parts: string[]): string;
  dirname(file: string): string;
  relative(from: string, to: string): string;
  readonly sep: string;
}

/** Drive-letter paths stay on the win32 API so `path.resolve` does not join them to the cwd. */
function pathFor(file: string): PathApi {
  return hasDriveLetter(file) ? path.win32 : path;
}

function findPackage(start: string): { root: string; name: string } | undefined {
  const api = pathFor(start);
  let dir = api.resolve(start);
  for (;;) {
    const file = api.join(dir, 'package.json');
    if (existsSync(file)) return { root: dir, name: packageName(file) ?? 'local' };
    const parent = api.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function isAbsoluteSource(file: string): boolean {
  return path.isAbsolute(file) || path.win32.isAbsolute(file);
}

/** Drop a `#hash` and a `?query` before two spellings of one file are compared. */
function withoutQueryOrHash(file: string): string {
  const hash = file.indexOf('#');
  const noHash = hash === -1 ? file : file.slice(0, hash);
  const query = noHash.indexOf('?');
  return query === -1 ? noHash : noHash.slice(0, query);
}

/**
 * Forward slashes. The drive letter and the original case stay.
 * `.` and `..` segments collapse so two spellings of one file match.
 */
function normalizedAbsoluteSource(source: string): string {
  const slashed = withoutQueryOrHash(source).replaceAll('\\', '/');
  const driveMatch = /^([A-Za-z]:)(\/.*)?$/.exec(slashed);
  const drive = driveMatch?.[1] ?? '';
  const body = drive ? (driveMatch?.[2] ?? '/') : slashed;
  const absolute = body.startsWith('/');
  const stack: string[] = [];
  for (const part of body.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (stack.length > 0) stack.pop();
      continue;
    }
    stack.push(part);
  }
  const pathBody = `${absolute ? '/' : ''}${stack.join('/')}`;
  return `${drive}${pathBody}`;
}

/** A path that stays inside `root`, or undefined when it would escape. */
function insideRoot(root: string, file: string): string | undefined {
  if (hasDriveLetter(root) !== hasDriveLetter(file)) return undefined;
  const api = pathFor(file);
  const relative = api.relative(root, file).split(api.sep).join('/');
  if (!relative || relative === '.' || relative.startsWith('..') || relative.startsWith('/')) return undefined;
  if (/^[A-Za-z]:/.test(relative)) return undefined;
  if (relative.split('/').some((part) => part === '.' || part === '..')) return undefined;
  return relative;
}

/**
 * Logical identity of one container.
 * A file inside the package or the project root keeps that relative path.
 * A file outside both uses `unrooted:` plus its normalized absolute path.
 * The directory is kept. A silent `../` path is not.
 */
export function resolveArtifactIdentity(input: ArtifactSource): ArtifactIdentity {
  const source = input.sourceFileName === undefined
    ? undefined
    : normalizedAbsoluteSource(input.sourceFileName);
  if (source !== undefined && !isAbsoluteSource(source)) {
    throw new Error(MESSAGE);
  }
  const projectRoot = TSContext.knownProjectRoot;
  const start = source !== undefined ? pathFor(source).dirname(source) : projectRoot;
  const pkg = start !== undefined && isAbsoluteSource(start) ? findPackage(start) : undefined;
  let projectId = pkg?.name ?? 'local';
  if (pkg && projectRoot !== undefined) {
    const tsconfigDir = insideRoot(pkg.root, projectRoot);
    if (tsconfigDir) projectId = `${projectId}#${tsconfigDir}`;
  }
  const declarationId = input.defineBuilderConfigStart !== undefined
    ? `defineBuilderConfig:${input.defineBuilderConfigStart}`
    : `container:${input.containerId}`;
  let relativeFile = 'unrooted/graph';
  if (source !== undefined) {
    const fromPackage = pkg ? insideRoot(pkg.root, source) : undefined;
    const fromProject = projectRoot !== undefined ? insideRoot(projectRoot, source) : undefined;
    if (fromPackage) relativeFile = fromPackage;
    else if (fromProject) relativeFile = fromProject;
    else relativeFile = `unrooted:${normalizedAbsoluteSource(source)}`;
  }
  return { projectId, relativeFile, declarationId };
}
