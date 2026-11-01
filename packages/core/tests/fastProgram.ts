import { createRequire } from 'node:module';
import path from 'node:path';
import * as ts from 'typescript';

const require = createRequire(import.meta.url);
const libDir = path.join(
  path.dirname(require.resolve('typescript/package.json')),
  'lib',
).replace(/\\/g, '/');

/**
 * Parsed `lib.*.d.ts`, keyed by file name and language version.
 * The first program pays for the parse. Every later program in this module reuses it.
 */
const libSourceFiles = new Map<string, ts.SourceFile>();

/** Passed straight to `ts.createProgram`. A tsconfig JSON file uses `"lib": ["ES5"]` instead. */
export const FAST_LIB = ['lib.es5.d.ts'] as const;

function libCacheKey(fileName: string, languageVersion: ts.ScriptTarget): string | undefined {
  const norm = fileName.replace(/\\/g, '/');
  if (!norm.startsWith(`${libDir}/`) || !norm.endsWith('.d.ts')) return undefined;
  return `${languageVersion}\0${norm}`;
}

/** Lib files come from the cache. Every other file stays on the original host. */
export function cacheLibHost(host: ts.CompilerHost): ts.CompilerHost {
  const read = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
    const key = typeof languageVersion === 'number' ? libCacheKey(fileName, languageVersion) : undefined;
    if (key && !shouldCreateNewSourceFile) {
      const hit = libSourceFiles.get(key);
      if (hit) return hit;
      const created = read(fileName, languageVersion, onError, shouldCreateNewSourceFile);
      if (created) libSourceFiles.set(key, created);
      return created;
    }
    return read(fileName, languageVersion, onError, shouldCreateNewSourceFile);
  };
  return host;
}

export function createFastProgram(
  rootNames: readonly string[],
  options: ts.CompilerOptions = {},
  host?: ts.CompilerHost,
  oldProgram?: ts.Program,
): ts.Program {
  const merged: ts.CompilerOptions = {
    ...options,
    lib: [...FAST_LIB],
    types: [],
    skipLibCheck: true,
  };
  return ts.createProgram(
    rootNames,
    merged,
    cacheLibHost(host ?? ts.createCompilerHost(merged)),
    oldProgram,
  );
}

/** Parse the lib once in `beforeAll`, so the first `it` does not pay for it. */
export function warmLibCache(): void {
  if (libSourceFiles.size > 0) return;
  createFastProgram([], {
    strict: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
  });
}
