import type * as ts from 'typescript';
import { TSContext } from '../../TSContext';

/**
 * Name of a partial listed in `extends`.
 * An identifier keeps its text. A property access (`P.part`, `N.nested.part`)
 * uses the variable that declares the partial, the same symbol walk as
 * `ConfigParser.parsePartialConfig`. Any other declaration is not a ref.
 */
export function extendsReferenceName(checker: ts.TypeChecker, element: ts.Expression): string | undefined {
  if (TSContext.ts.isIdentifier(element)) return element.text;
  if (!TSContext.ts.isPropertyAccessExpression(element)) return undefined;
  const located = element.name;
  const symbol = checker.getSymbolAtLocation(located);
  if (!symbol) return undefined;
  const resolved = resolveAlias(checker, symbol);
  const declaration = resolved.valueDeclaration ?? resolved.declarations?.[0];
  if (
    declaration
    && TSContext.ts.isVariableDeclaration(declaration)
    && TSContext.ts.isIdentifier(declaration.name)
  ) {
    return declaration.name.text;
  }
  return undefined;
}

/** Text of an `extends` element, as the consumer wrote it (`P.part`, `p`, `part`). */
export function extendsCaptureText(element: ts.Expression): string | undefined {
  if (TSContext.ts.isIdentifier(element) || TSContext.ts.isPropertyAccessExpression(element)) {
    return element.getText();
  }
  return undefined;
}

function resolveAlias(checker: ts.TypeChecker, symbol: ts.Symbol): ts.Symbol {
  let current = symbol;
  let depth = 0;
  while (current.flags & TSContext.ts.SymbolFlags.Alias) {
    if (depth++ > 20) break;
    current = checker.getAliasedSymbol(current);
  }
  return current;
}
