import * as path from 'node:path';

/**
 * A cache that lives as long as one object, a Program. `begin` with another object drops every entry:
 * a key and a text that repeat do not prove the type environment repeats, so nothing is shared
 * between two Programs. Entries may hold checker-bound objects because they die with their Program.
 */
export class SnapshotCache<T> {
  #snapshot: object | undefined;
  readonly #entries = new Map<string, T>();

  begin(snapshot: object): void {
    if (this.#snapshot === snapshot) return;
    this.#snapshot = snapshot;
    this.#entries.clear();
  }

  getOrCompute(key: string, compute: () => T): T {
    if (!this.#snapshot) throw new Error('begin(snapshot) is required');
    if (this.#entries.has(key)) return this.#entries.get(key)!;
    const value = compute();
    this.#entries.set(key, value);
    return value;
  }

  clear(): void {
    this.#entries.clear();
    this.#snapshot = undefined;
  }
}

/** What a watcher event asks of the session. A reason is recorded with every invalidation. */
export interface WatchInvalidation {
  kind: 'files' | 'environment';
  reason: string;
}

export type WatchEvent = 'create' | 'update' | 'delete';

const CONFIG_FILE = /^(?:ts|js)config(?:\..+)?\.json$/;

/** A file whose edit can change how every module resolves or which options apply, without being a source file. */
export function isEnvironmentFile(file: string): boolean {
  const name = path.posix.basename(file.replace(/\\/g, '/'));
  return name === 'package.json' || CONFIG_FILE.test(name);
}

/**
 * Creation, deletion, a package.json or a tsconfig change what a module resolves to: the whole environment.
 * An edit of a file the session holds changes that file. An edit of a file it does not hold may be a
 * resolution input (a manifest, a declaration found later), so it counts as the environment.
 */
export function classifyWatchChange(
  file: string,
  event: WatchEvent,
  context: { known: (file: string) => boolean },
): WatchInvalidation {
  if (isEnvironmentFile(file)) {
    return { kind: 'environment', reason: path.posix.basename(file.replace(/\\/g, '/')) === 'package.json' ? 'package-json' : 'config' };
  }
  if (event === 'create') return { kind: 'environment', reason: 'create' };
  if (event === 'delete') return { kind: 'environment', reason: 'delete' };
  if (context.known(file)) return { kind: 'files', reason: 'update' };
  return { kind: 'environment', reason: 'unknown-file' };
}
