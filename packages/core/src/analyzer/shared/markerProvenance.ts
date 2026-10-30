import type * as ts from 'typescript';
import { TSContext } from '../../TSContext';

/** Public package whose exports are the NeoSyringe markers. */
export const NEO_SYRINGE_SPECIFIER = '@djodjonx/neosyringe';

const MARKER_NAMES = [
  'defineBuilderConfig',
  'definePartialConfig',
  'declareContainerTokens',
  'useInterface',
  'useProperty',
] as const;

export type NeoMarkerName = (typeof MARKER_NAMES)[number];

export type NeoMarkerResolution = NeoMarkerName | { code: 'NEO_CONFIG_UNSUPPORTED' } | null;

const MARKER_SET: ReadonlySet<string> = new Set(MARKER_NAMES);

function asMarker(name: string): NeoMarkerName | null {
  return MARKER_SET.has(name) ? (name as NeoMarkerName) : null;
}

function moduleSpecifierNode(decl: ts.Node): ts.Expression | undefined {
  let current: ts.Node | undefined = decl;
  while (current) {
    if (TSContext.ts.isImportDeclaration(current) || TSContext.ts.isExportDeclaration(current)) {
      return current.moduleSpecifier;
    }
    current = current.parent;
  }
  return undefined;
}

function moduleSpecifierOf(decl: ts.Node): string | undefined {
  const specifier = moduleSpecifierNode(decl);
  if (specifier && TSContext.ts.isStringLiteral(specifier)) return specifier.text;
  return undefined;
}

function moduleSourceFile(checker: ts.TypeChecker, specifier: ts.Expression): ts.SourceFile | undefined {
  const symbol = checker.getSymbolAtLocation(specifier);
  if (!symbol) return undefined;
  for (const decl of symbol.declarations ?? []) {
    if (TSContext.ts.isSourceFile(decl)) return decl;
  }
  return undefined;
}

/**
 * True when `sourceFile` re-exports `@djodjonx/neosyringe` through `export *`.
 * The match is the module specifier, never a user-written identifier.
 */
function starReexportsPackage(
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  seen: Set<ts.SourceFile>,
): boolean {
  if (seen.has(sourceFile)) return false;
  seen.add(sourceFile);
  for (const stmt of sourceFile.statements) {
    if (!TSContext.ts.isExportDeclaration(stmt) || stmt.exportClause) continue;
    const spec = stmt.moduleSpecifier;
    if (!spec || !TSContext.ts.isStringLiteral(spec)) continue;
    if (spec.text === NEO_SYRINGE_SPECIFIER) return true;
    const inner = moduleSourceFile(checker, spec);
    if (inner && starReexportsPackage(checker, inner, seen)) return true;
  }
  return false;
}

function aliasEnd(checker: ts.TypeChecker, symbol: ts.Symbol): ts.Symbol | undefined {
  const seen = new Set<ts.Symbol>();
  let current: ts.Symbol | undefined = symbol;
  while (current && (current.flags & TSContext.ts.SymbolFlags.Alias) !== 0 && !seen.has(current)) {
    seen.add(current);
    const next = immediateAlias(checker, current);
    if (!next) return undefined;
    current = next;
  }
  return current;
}

function isLocalValue(symbol: ts.Symbol, file: ts.SourceFile): boolean {
  for (const decl of symbol.declarations ?? []) {
    if (decl.getSourceFile() !== file) continue;
    if (
      TSContext.ts.isFunctionDeclaration(decl) ||
      TSContext.ts.isClassDeclaration(decl) ||
      TSContext.ts.isVariableDeclaration(decl)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Named import or export whose target module is `export *` from the package.
 * A local value declared in that module hides the star re-export.
 */
function starBarrelMarker(checker: ts.TypeChecker, symbol: ts.Symbol): NeoMarkerName | null {
  for (const decl of symbol.declarations ?? []) {
    if (!TSContext.ts.isImportSpecifier(decl) && !TSContext.ts.isExportSpecifier(decl)) continue;
    const marker = asMarker(exportedName(decl));
    if (!marker) continue;
    if (moduleSpecifierOf(decl) === NEO_SYRINGE_SPECIFIER) continue;
    const specNode = moduleSpecifierNode(decl);
    if (!specNode) continue;
    const source = moduleSourceFile(checker, specNode);
    if (!source || !starReexportsPackage(checker, source, new Set())) continue;
    const end = aliasEnd(checker, symbol);
    if (end && isLocalValue(end, source)) return null;
    return marker;
  }
  return null;
}

function exportedName(decl: ts.ImportSpecifier | ts.ExportSpecifier): string {
  const property = decl.propertyName;
  if (property && TSContext.ts.isIdentifier(property)) return property.text;
  return decl.name.text;
}

function immediateAlias(checker: ts.TypeChecker, symbol: ts.Symbol): ts.Symbol | undefined {
  if ((symbol.flags & TSContext.ts.SymbolFlags.Alias) === 0) return undefined;
  const withImmediate = checker as ts.TypeChecker & {
    getImmediateAliasedSymbol?(symbol: ts.Symbol): ts.Symbol | undefined;
  };
  if (typeof withImmediate.getImmediateAliasedSymbol !== 'function') return undefined;
  const next = withImmediate.getImmediateAliasedSymbol(symbol);
  return next && next !== symbol ? next : undefined;
}

/**
 * Follows import aliases, namespace imports and re-exports to a canonical
 * marker exported by `@djodjonx/neosyringe`. A local declaration wins when
 * the symbol is not that import.
 */
function markerFromSymbol(checker: ts.TypeChecker, symbol: ts.Symbol): NeoMarkerName | null {
  const seen = new Set<ts.Symbol>();
  let current: ts.Symbol | undefined = symbol;
  for (let hop = 0; current && hop < 20; hop += 1) {
    if (seen.has(current)) return null;
    seen.add(current);
    for (const decl of current.declarations ?? []) {
      if (TSContext.ts.isImportSpecifier(decl) || TSContext.ts.isExportSpecifier(decl)) {
        if (moduleSpecifierOf(decl) === NEO_SYRINGE_SPECIFIER) {
          return asMarker(exportedName(decl));
        }
      }
    }
    const viaStar = starBarrelMarker(checker, current);
    if (viaStar) return viaStar;
    const next = immediateAlias(checker, current);
    if (!next) return null;
    current = next;
  }
  return null;
}

function isNeoNamespace(checker: ts.TypeChecker, expression: ts.Expression): boolean {
  const symbol = checker.getSymbolAtLocation(expression);
  if (!symbol) return false;
  const seen = new Set<ts.Symbol>();
  let current: ts.Symbol | undefined = symbol;
  for (let hop = 0; current && hop < 20; hop += 1) {
    if (seen.has(current)) return false;
    seen.add(current);
    for (const decl of current.declarations ?? []) {
      if (
        TSContext.ts.isNamespaceImport(decl) &&
        moduleSpecifierOf(decl) === NEO_SYRINGE_SPECIFIER
      ) {
        return true;
      }
      if (TSContext.ts.isNamespaceExport(decl) && moduleSpecifierOf(decl) === NEO_SYRINGE_SPECIFIER) {
        return true;
      }
      if (TSContext.ts.isNamespaceImport(decl)) {
        const specNode = moduleSpecifierNode(decl);
        const source = specNode && moduleSourceFile(checker, specNode);
        if (source && starReexportsPackage(checker, source, new Set())) return true;
      }
    }
    const next = immediateAlias(checker, current);
    if (!next) return false;
    current = next;
  }
  return false;
}

/**
 * Classifies a call by the provenance of its callee.
 * `null` leaves the call untouched. A computed access on the NeoSyringe
 * namespace that is not a string literal is not analysable.
 */
export function resolveNeoMarker(checker: ts.TypeChecker, node: ts.Node): NeoMarkerResolution {
  if (!checker || typeof checker.getSymbolAtLocation !== 'function') {
    throw new TypeError('resolveNeoMarker requires a TypeChecker.getSymbolAtLocation');
  }
  if (!TSContext.ts.isCallExpression(node)) return null;

  const expr = node.expression;
  if (TSContext.ts.isIdentifier(expr)) {
    const symbol = checker.getSymbolAtLocation(expr);
    return symbol ? markerFromSymbol(checker, symbol) : null;
  }

  if (TSContext.ts.isPropertyAccessExpression(expr)) {
    if (isNeoNamespace(checker, expr.expression)) return asMarker(expr.name.text);
    const symbol = checker.getSymbolAtLocation(expr.name);
    return symbol ? markerFromSymbol(checker, symbol) : null;
  }

  if (TSContext.ts.isElementAccessExpression(expr)) {
    if (!isNeoNamespace(checker, expr.expression)) return null;
    const argument = expr.argumentExpression;
    if (argument && TSContext.ts.isStringLiteral(argument)) return asMarker(argument.text);
    return { code: 'NEO_CONFIG_UNSUPPORTED' };
  }

  return null;
}

/** True when any call in the file resolves to a NeoSyringe marker. */
export function sourceFileUsesMarker(checker: ts.TypeChecker, sourceFile: ts.SourceFile): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (TSContext.ts.isCallExpression(node) && resolveNeoMarker(checker, node)) found = true;
    TSContext.ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

/** Stable text for a non-analysable marker call. Includes file and line. */
export function formatUnsupportedMarker(node: ts.Node): string {
  const sourceFile = node.getSourceFile();
  const position = node.getStart(sourceFile, false);
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(position);
  return (
    `NEO_CONFIG_UNSUPPORTED: non-analysable config form at ${sourceFile.fileName}:${line + 1}:${character + 1}. ` +
    'Supported alternative: a direct call, an import alias, or a property access such as neo.defineBuilderConfig({ ... }).'
  );
}
