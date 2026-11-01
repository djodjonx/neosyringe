import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import * as ts from 'typescript';

/**
 * `program.emit()` writes every source in the program. A path mapping to the
 * repo pulls those sources in, and TypeScript then drops their outputs beside
 * the repo files. Keep only the outputs that stay under the temp producer root.
 */
export function emitUnderRoot(program: ts.Program, producerRoot: string): ts.EmitResult {
  const root = canonical(producerRoot);
  return program.emit(undefined, (fileName, text, writeByteOrderMark) => {
    if (!isInside(fileName, root)) return;
    mkdirSync(path.dirname(fileName), { recursive: true });
    ts.sys.writeFile(fileName, text, writeByteOrderMark);
  });
}

function canonical(fileName: string): string {
  const resolved = path.resolve(fileName);
  const missing: string[] = [];
  let current = resolved;
  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return resolved;
    missing.push(path.basename(current));
    current = parent;
  }
  let real = realpathSync(current);
  for (const part of missing.reverse()) real = path.join(real, part);
  return real;
}

function isInside(fileName: string, root: string): boolean {
  const relative = path.relative(root, canonical(fileName));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
