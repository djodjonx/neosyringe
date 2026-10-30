import * as ts from 'typescript';

const MARKER_NAMES: ReadonlySet<string> = new Set([
  'defineBuilderConfig',
  'definePartialConfig',
  'declareContainerTokens',
  'useInterface',
  'useProperty',
]);

const NEO_SYRINGE_SPECIFIER = '@djodjonx/neosyringe';

/**
 * Returns true if the source might contain a NeoSyringe marker.
 * A value import, an import-equals, or a call whose root is one of the five
 * marker names is enough. Type-only imports, comments and string literals are not.
 */
export function hasNeoSyringeMarkers(code: string): boolean {
  const sourceFile = ts.createSourceFile('marker-filter.ts', code, ts.ScriptTarget.Latest, true);
  let found = false;
  const imported = new Set<string>();

  const bind = (name: ts.Identifier | undefined): void => {
    if (name) imported.add(name.text);
  };

  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      if (clause && !clause.isTypeOnly) {
        if (clause.name) bind(clause.name);
        const named = clause.namedBindings;
        if (named && ts.isNamespaceImport(named)) bind(named.name);
        if (named && ts.isNamedImports(named)) {
          for (const element of named.elements) {
            if (!element.isTypeOnly) bind(element.name);
          }
        }
        if (imported.size > 0) found = true;
      }
      return;
    }
    if (ts.isImportEqualsDeclaration(node)) {
      bind(node.name);
      found = true;
      return;
    }
    if (ts.isCallExpression(node)) {
      const root = calleeRoot(node.expression);
      if (root && (MARKER_NAMES.has(root.text) || imported.has(root.text))) {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return found;
}

type NamedBinding = { kind: 'named'; specifier: string; imported: string };
type NamespaceBinding = { kind: 'namespace'; specifier: string };
type Binding = NamedBinding | NamespaceBinding;

function calleeRoot(expression: ts.Expression): ts.Identifier | undefined {
  if (ts.isIdentifier(expression)) return expression;
  if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
    return calleeRoot(expression.expression);
  }
  if (ts.isParenthesizedExpression(expression)) return calleeRoot(expression.expression);
  return undefined;
}

function collectBindings(sourceFile: ts.SourceFile): Map<string, Binding> {
  const bindings = new Map<string, Binding>();
  for (const stmt of sourceFile.statements) {
    if (
      ts.isImportDeclaration(stmt) &&
      stmt.importClause &&
      !stmt.importClause.isTypeOnly &&
      stmt.moduleSpecifier &&
      ts.isStringLiteral(stmt.moduleSpecifier)
    ) {
      const specifier = stmt.moduleSpecifier.text;
      const clause = stmt.importClause;
      if (clause.name) bindings.set(clause.name.text, { kind: 'named', specifier, imported: 'default' });
      const named = clause.namedBindings;
      if (named && ts.isNamespaceImport(named)) {
        bindings.set(named.name.text, { kind: 'namespace', specifier });
      }
      if (named && ts.isNamedImports(named)) {
        for (const element of named.elements) {
          if (element.isTypeOnly) continue;
          const imported =
            element.propertyName && ts.isIdentifier(element.propertyName)
              ? element.propertyName.text
              : element.name.text;
          bindings.set(element.name.text, { kind: 'named', specifier, imported });
        }
      }
    }
    if (ts.isImportEqualsDeclaration(stmt) && ts.isExternalModuleReference(stmt.moduleReference)) {
      const expr = stmt.moduleReference.expression;
      if (ts.isStringLiteral(expr)) {
        bindings.set(stmt.name.text, { kind: 'namespace', specifier: expr.text });
      }
    }
  }
  return bindings;
}

function resolveFile(specifier: string, from: string, options: ts.CompilerOptions): string | undefined {
  return ts.resolveModuleName(specifier, from, options, ts.sys).resolvedModule?.resolvedFileName;
}

function loadFile(fileName: string, cache: Map<string, ts.SourceFile | null>): ts.SourceFile | undefined {
  const cached = cache.get(fileName);
  if (cached !== undefined) return cached ?? undefined;
  const text = ts.sys.readFile(fileName);
  if (text === undefined) {
    cache.set(fileName, null);
    return undefined;
  }
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  cache.set(fileName, source);
  return source;
}

function hasExportKeyword(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false)
  );
}

function localExportNames(sourceFile: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const stmt of sourceFile.statements) {
    if (!hasExportKeyword(stmt)) continue;
    if ((ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt)) && stmt.name) names.add(stmt.name.text);
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) names.add(decl.name.text);
      }
    }
  }
  return names;
}

function importBinding(sourceFile: ts.SourceFile, localName: string): NamedBinding | NamespaceBinding | undefined {
  return collectBindings(sourceFile).get(localName);
}

/**
 * Follows `export default <identifier>` when that name is an import.
 * `export =` is not a marker. A property access is not a marker.
 * A name with no import is a local value.
 */
function exportAssignmentReaches(
  source: ts.SourceFile,
  options: ts.CompilerOptions,
  cache: Map<string, ts.SourceFile | null>,
  seen: Set<string>,
): boolean {
  for (const stmt of source.statements) {
    if (!ts.isExportAssignment(stmt) || stmt.isExportEquals) continue;
    if (!ts.isIdentifier(stmt.expression)) continue;
    const binding = importBinding(source, stmt.expression.text);
    if (!binding) continue;
    if (binding.kind === 'namespace') {
      if (namespaceReaches(binding.specifier, source.fileName, options, cache, seen)) return true;
    } else if (namedReaches(binding.specifier, binding.imported, source.fileName, options, cache, seen)) {
      return true;
    }
  }
  return false;
}

/**
 * Follows a named export to `@djodjonx/neosyringe`.
 * A local exported value stops the walk. A module these compiler options
 * cannot read is not a marker: the program would not see it either.
 * The package specifier is matched before resolution.
 * The name `default` also follows `export default` of an import.
 */
function namedReaches(
  specifier: string,
  imported: string,
  from: string,
  options: ts.CompilerOptions,
  cache: Map<string, ts.SourceFile | null>,
  seen: Set<string>,
): boolean {
  if (specifier === NEO_SYRINGE_SPECIFIER) return MARKER_NAMES.has(imported);
  const resolved = resolveFile(specifier, from, options);
  if (!resolved) return false;
  const key = `${resolved}\n${imported}`;
  if (seen.has(key)) return false;
  seen.add(key);
  const source = loadFile(resolved, cache);
  if (!source) return false;
  if (localExportNames(source).has(imported)) return false;
  if (imported === 'default' && exportAssignmentReaches(source, options, cache, seen)) return true;

  for (const stmt of source.statements) {
    if (!ts.isExportDeclaration(stmt)) continue;
    const specNode = stmt.moduleSpecifier;
    const spec = specNode && ts.isStringLiteral(specNode) ? specNode.text : undefined;
    if (!stmt.exportClause) {
      if (!spec) continue;
      if (namedReaches(spec, imported, source.fileName, options, cache, seen)) return true;
      continue;
    }
    if (ts.isNamespaceExport(stmt.exportClause)) {
      if (!spec || stmt.exportClause.name.text !== imported) continue;
      if (spec === NEO_SYRINGE_SPECIFIER || namespaceReaches(spec, source.fileName, options, cache, seen)) return true;
      continue;
    }
    if (!ts.isNamedExports(stmt.exportClause)) continue;
    for (const element of stmt.exportClause.elements) {
      if (element.name.text !== imported) continue;
      const original =
        element.propertyName && ts.isIdentifier(element.propertyName)
          ? element.propertyName.text
          : element.name.text;
      if (spec) {
        if (namedReaches(spec, original, source.fileName, options, cache, seen)) return true;
      } else {
        const binding = importBinding(source, original);
        if (!binding) continue;
        if (binding.kind === 'namespace') {
          if (namespaceReaches(binding.specifier, source.fileName, options, cache, seen)) return true;
        } else if (namedReaches(binding.specifier, binding.imported, source.fileName, options, cache, seen)) {
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * Follows a namespace import to `@djodjonx/neosyringe`.
 * `export *`, `export * as`, named re-exports and `export default` of an import all count.
 * A local value or another package does not. A module these options
 * cannot read is not a marker.
 */
function namespaceReaches(
  specifier: string,
  from: string,
  options: ts.CompilerOptions,
  cache: Map<string, ts.SourceFile | null>,
  seen: Set<string>,
): boolean {
  if (specifier === NEO_SYRINGE_SPECIFIER) return true;
  const resolved = resolveFile(specifier, from, options);
  if (!resolved) return false;
  const key = `${resolved}\n*`;
  if (seen.has(key)) return false;
  seen.add(key);
  const source = loadFile(resolved, cache);
  if (!source) return false;
  if (exportAssignmentReaches(source, options, cache, seen)) return true;
  for (const stmt of source.statements) {
    if (!ts.isExportDeclaration(stmt) || stmt.isTypeOnly) continue;
    const specNode = stmt.moduleSpecifier;
    const spec = specNode && ts.isStringLiteral(specNode) ? specNode.text : undefined;
    if (!stmt.exportClause) {
      if (spec && namespaceReaches(spec, source.fileName, options, cache, seen)) return true;
      continue;
    }
    if (ts.isNamespaceExport(stmt.exportClause)) {
      if (spec && namespaceReaches(spec, source.fileName, options, cache, seen)) return true;
      continue;
    }
    if (!ts.isNamedExports(stmt.exportClause)) continue;
    for (const element of stmt.exportClause.elements) {
      if (element.isTypeOnly) continue;
      const original =
        element.propertyName && ts.isIdentifier(element.propertyName)
          ? element.propertyName.text
          : element.name.text;
      if (spec) {
        if (namedReaches(spec, original, source.fileName, options, cache, seen)) return true;
      } else {
        const binding = importBinding(source, original);
        if (!binding) continue;
        if (binding.kind === 'namespace') {
          if (namespaceReaches(binding.specifier, source.fileName, options, cache, seen)) return true;
        } else if (namedReaches(binding.specifier, binding.imported, source.fileName, options, cache, seen)) {
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * True when a call in this file can reach a NeoSyringe marker.
 * A marker-name callee still enters the checker. A barrel rename passes
 * because its import is followed. A module these options cannot read does not.
 */
export function callsCanReachNeoSyringe(code: string, fileName: string, options: ts.CompilerOptions): boolean {
  const sourceFile = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true);
  const bindings = collectBindings(sourceFile);
  const cache = new Map<string, ts.SourceFile | null>();
  const seen = new Set<string>();
  let hit = false;

  const visit = (node: ts.Node): void => {
    if (hit) return;
    if (ts.isCallExpression(node)) {
      const root = calleeRoot(node.expression);
      if (root && MARKER_NAMES.has(root.text)) {
        hit = true;
        return;
      }
      const binding = root && bindings.get(root.text);
      if (binding?.kind === 'namespace') {
        hit = namespaceReaches(binding.specifier, fileName, options, cache, seen);
      } else if (binding?.kind === 'named') {
        hit = namedReaches(binding.specifier, binding.imported, fileName, options, cache, seen);
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return hit;
}
