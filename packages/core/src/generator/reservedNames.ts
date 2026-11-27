import type * as ts from 'typescript';
import { TSContext } from '../TSContext';

/**
 * Every name a source file declares in its module scope: variables (destructuring included, and a
 * `var` hoisted out of a block, loop or `try`), functions, classes, enums, interfaces, type
 * aliases, namespaces and imports. A generated binding injected into this file must not reuse one
 * of them.
 *
 * `around` lists positions of the file where generated text is written (a container's statement). The names declared in the
 * scopes that enclose each of them are reserved too: a local of a function that holds a container would otherwise shadow a
 * name the generated text reads from the module.
 *
 * The names are the bindings the checker holds for the file: the checker is the only source of
 * truth, there is no syntax fallback. `sourceFile` must belong to the checker's program.
 */
export function reservedNamesOf(sourceFile: ts.SourceFile, checker: ts.TypeChecker, around: readonly number[] = []): Set<string> {
  const flags = TSContext.ts.SymbolFlags;
  const wanted = flags.Value | flags.Type | flags.Namespace | flags.Alias;
  const names = new Set<string>();
  for (const location of [sourceFile, ...around.map((position) => innermostAt(sourceFile, position))]) {
    for (const symbol of checker.getSymbolsInScope(location, wanted)) {
      // The scope also holds every global of the program; only what this file declares can collide.
      if (symbol.declarations?.some((declaration) => declaration.getSourceFile() === sourceFile)) names.add(symbol.name);
    }
  }
  return names;
}

/** The deepest node of `sourceFile` that contains `position`: the file itself when none does. */
function innermostAt(sourceFile: ts.SourceFile, position: number): ts.Node {
  let found: ts.Node = sourceFile;
  for (let descended = true; descended;) {
    descended = false;
    found.forEachChild((child) => {
      if (!descended && child.getStart(sourceFile) <= position && position < child.getEnd()) {
        found = child;
        descended = true;
      }
    });
  }
  return found;
}
