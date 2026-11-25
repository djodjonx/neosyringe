import type * as ts from 'typescript';
import { TSContext } from '../TSContext';

/**
 * Every name a source file declares in its module scope: variables (destructuring included, and a
 * `var` hoisted out of a block, loop or `try`), functions, classes, enums, interfaces, type
 * aliases, namespaces and imports. A generated binding injected into this file must not reuse one
 * of them.
 *
 * The names are the bindings the checker holds for the file: the checker is the only source of
 * truth, there is no syntax fallback. `sourceFile` must belong to the checker's program.
 */
export function reservedNamesOf(sourceFile: ts.SourceFile, checker: ts.TypeChecker): Set<string> {
  const flags = TSContext.ts.SymbolFlags;
  const names = new Set<string>();
  for (const symbol of checker.getSymbolsInScope(sourceFile, flags.Value | flags.Type | flags.Namespace | flags.Alias)) {
    // The scope also holds every global of the program; only what this file declares can collide.
    if (symbol.declarations?.some((declaration) => declaration.getSourceFile() === sourceFile)) names.add(symbol.name);
  }
  return names;
}
