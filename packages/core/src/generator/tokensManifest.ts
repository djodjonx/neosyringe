import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import * as ts from 'typescript';
import { TSContext } from '../TSContext';
import { resolveNeoMarker } from '../analyzer/shared/markerProvenance';
import { TokenResolverService } from '../analyzer/shared/TokenResolverService';
import type { TokenManifestEntry, TokenManifestTypeExport, TokensManifest } from '../analyzer/shared/tokensManifest';
import { TOKENS_MANIFEST_SCHEMA_VERSION } from '../analyzer/shared/tokensManifest';
import { canonicalParts } from '../analyzer/shared/tokenDescriptor';

export interface WriteTokensManifestInput {
  program: ts.Program;
  packageRoot: string;
  /**
   * Descriptor origin. The build uses the tsconfig directory (`resolved.root`).
   * Defaults to `packageRoot`. `exportPath` stays relative to `packageRoot`.
   */
  projectRoot?: string;
  /** Explicit token contract. Independent of package.json `version`. */
  contractVersion: string;
}

const PER_FILE_DECLARATION =
  'run the manifest step after declaration emit; bundled declarations are not supported: per-file declaration emit required';

/**
 * `.d.ts` path relative to the package root.
 * `declarationDir` wins over `outDir`. `rootDir` is the source root.
 * The result is what `tsc` emits for that source file.
 */
export function declarationEmitPath(
  program: ts.Program,
  sourceFile: ts.SourceFile,
  packageRoot: string,
): string {
  const options = program.getCompilerOptions();
  const rootDir = options.rootDir;
  const emitDir = options.declarationDir ?? options.outDir;
  if (!rootDir || !emitDir) {
    throw new Error('tsconfig rootDir and outDir or declarationDir are required for exportPath');
  }
  const sourceRel = path.relative(rootDir, sourceFile.fileName);
  const declarationRel = sourceRel.replace(/\.tsx?$/, '.d.ts');
  const absolute = path.join(emitDir, declarationRel);
  const relative = path.relative(packageRoot, absolute).split(path.sep).join('/');
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`declaration path escapes the package: ${relative}`);
  }
  return relative;
}

function packageNameOf(packageRoot: string): string {
  const parsed: unknown = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  const name = parsed && typeof parsed === 'object' && 'name' in parsed ? parsed.name : undefined;
  if (typeof name !== 'string' || name === '') throw new Error('missing package name');
  return name;
}

function exportedCallName(node: ts.CallExpression): string | undefined {
  const parent = node.parent;
  if (!ts.isVariableDeclaration(parent) || !ts.isIdentifier(parent.name)) return undefined;
  if (parent.initializer !== node) return undefined;
  if ((ts.getCombinedModifierFlags(parent) & ts.ModifierFlags.Export) === 0) return undefined;
  return parent.name.text;
}

function exportNameText(name: ts.ModuleExportName): string {
  return name.text;
}

/** `export { X }` and `export { X as Y }` in this file. A `from` clause is another module. */
function reexportName(sourceFile: ts.SourceFile, localName: string): string | undefined {
  for (const statement of sourceFile.statements) {
    if (!ts.isExportDeclaration(statement) || !statement.exportClause || statement.moduleSpecifier) continue;
    if (!ts.isNamedExports(statement.exportClause)) continue;
    for (const element of statement.exportClause.elements) {
      const local = element.propertyName ?? element.name;
      if (exportNameText(local) === localName) return exportNameText(element.name);
    }
  }
  return undefined;
}

function exportNameOfCall(node: ts.CallExpression): string | undefined {
  const direct = exportedCallName(node);
  if (direct) return direct;
  const parent = node.parent;
  if (!ts.isVariableDeclaration(parent) || !ts.isIdentifier(parent.name) || parent.initializer !== node) return undefined;
  return reexportName(parent.getSourceFile(), parent.name.text);
}

function isDefaultExportCall(node: ts.CallExpression): boolean {
  let current: ts.Node = node;
  while (
    ts.isParenthesizedExpression(current.parent)
    || ts.isAsExpression(current.parent)
    || ts.isNonNullExpression(current.parent)
    || ts.isSatisfiesExpression(current.parent)
  ) {
    current = current.parent;
  }
  return ts.isExportAssignment(current.parent);
}

/** Name of an exported object that holds the call. Unexported objects are skipped. */
function exportedObjectName(node: ts.CallExpression): string | undefined {
  let current: ts.Node = node;
  let sawObject = false;
  while (true) {
    const parent = current.parent;
    if (!parent) return undefined;
    if (ts.isFunctionLike(parent) || ts.isClassLike(parent)) return undefined;
    if (ts.isObjectLiteralExpression(parent)) sawObject = true;
    if (sawObject && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
      const exported = (ts.getCombinedModifierFlags(parent) & ts.ModifierFlags.Export) !== 0;
      if (exported || reexportName(parent.getSourceFile(), parent.name.text) !== undefined) return parent.name.text;
      return undefined;
    }
    current = parent;
  }
}

function hasExportKeyword(node: ts.Node): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true;
}

function declarationExportsName(file: string, exportName: string): boolean {
  if (!existsSync(file)) return false;
  const text = readFileSync(file, 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  for (const statement of source.statements) {
    if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      if (statement.exportClause.elements.some((element) => exportNameText(element.name) === exportName)) return true;
    }
    if (!hasExportKeyword(statement)) continue;
    if (ts.isVariableStatement(statement)) {
      for (const decl of statement.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.name.text === exportName) return true;
      }
    }
    const named = statement as ts.DeclarationStatement;
    if (named.name && ts.isIdentifier(named.name) && named.name.text === exportName) return true;
  }
  return false;
}

function assertPerFileDeclarations(packageRoot: string, tokens: TokenManifestEntry[]): void {
  const seen = new Set<string>();
  const check = (exportPath: string, exportName: string): void => {
    const key = `${exportPath}\0${exportName}`;
    if (seen.has(key)) return;
    seen.add(key);
    const file = path.join(packageRoot, exportPath);
    if (!declarationExportsName(file, exportName)) {
      throw new Error(`${PER_FILE_DECLARATION} (${exportPath}#${exportName})`);
    }
  };
  for (const token of tokens) {
    check(token.exportPath, token.exportName);
    if (token.typeExport) check(token.typeExport.exportPath, token.typeExport.exportName);
  }
}

function typeArgumentsOf(checker: ts.TypeChecker, type: ts.Type): readonly ts.Type[] {
  const reference = type as ts.TypeReference;
  if (reference.target) return checker.getTypeArguments(reference);
  return type.aliasTypeArguments ?? [];
}

function typeExportOf(
  checker: ts.TypeChecker,
  program: ts.Program,
  packageRoot: string,
  type: ts.Type,
): TokenManifestTypeExport | undefined {
  if (typeArgumentsOf(checker, type).length > 0) return undefined;
  const symbol = type.aliasSymbol ?? type.getSymbol();
  if (!symbol) return undefined;
  const resolved = (symbol.flags & ts.SymbolFlags.Alias) !== 0
    ? checker.getAliasedSymbol(symbol)
    : symbol;
  const declaration = resolved.declarations?.find((node) => {
    const file = node.getSourceFile();
    return !file.isDeclarationFile && program.getSourceFile(file.fileName) !== undefined;
  });
  if (!declaration) return undefined;
  const sourceFile = declaration.getSourceFile();
  const fileSymbol = checker.getSymbolAtLocation(sourceFile);
  if (!fileSymbol) return undefined;
  const resolvedDecls = new Set(resolved.declarations ?? []);
  for (const exported of checker.getExportsOfModule(fileSymbol)) {
    const target = (exported.flags & ts.SymbolFlags.Alias) !== 0
      ? checker.getAliasedSymbol(exported)
      : exported;
    const same = target === resolved
      || (target.declarations ?? []).some((node) => resolvedDecls.has(node));
    if (!same) continue;
    return {
      exportPath: declarationEmitPath(program, sourceFile, packageRoot),
      exportName: exported.getName(),
    };
  }
  return undefined;
}

function collectTokens(
  program: ts.Program,
  packageRoot: string,
): TokenManifestEntry[] {
  const checker = program.getTypeChecker();
  const resolver = new TokenResolverService(checker);
  const tokens: TokenManifestEntry[] = [];
  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) continue;
    const visit = (node: ts.Node): void => {
      if (ts.isFunctionLike(node) || ts.isClassLike(node)) return;
      if (ts.isCallExpression(node) && resolveNeoMarker(checker, node) === 'useInterface') {
        if (isDefaultExportCall(node)) throw new Error('export default tokens are not supported');
        const holder = exportedObjectName(node);
        if (holder) throw new Error(`tokens held inside an exported object are not supported: ${holder}`);
        const exportName = exportNameOfCall(node);
        const typeNode = node.typeArguments?.[0];
        if (exportName && typeNode) {
          const type = checker.getTypeFromTypeNode(typeNode);
          const parts = canonicalParts(checker, type);
          const runtimeKey = resolver.getTypeId(type);
          const entry: TokenManifestEntry = {
            exportPath: declarationEmitPath(program, sourceFile, packageRoot),
            exportName,
            runtimeKey,
            descriptor: parts.descriptor,
          };
          const typeExport = typeExportOf(checker, program, packageRoot, type);
          if (typeExport) entry.typeExport = typeExport;
          tokens.push(entry);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  tokens.sort((left, right) =>
    left.exportPath.localeCompare(right.exportPath) || left.exportName.localeCompare(right.exportName));
  return tokens;
}

/** Writes protocol v1 from exported `useInterface` calls. `contractVersion` is required. */
export function writeTokensManifest(input: WriteTokensManifestInput): TokensManifest {
  if (input.contractVersion === '') {
    throw new Error('NEO_TOKEN_BOUNDARY_UNSUPPORTED: contract-version');
  }
  const projectRoot = input.projectRoot ?? input.packageRoot;
  return TSContext.runWithProjectRoot(projectRoot, () => {
    const manifest: TokensManifest = {
      schemaVersion: TOKENS_MANIFEST_SCHEMA_VERSION,
      packageName: packageNameOf(input.packageRoot),
      contractVersion: input.contractVersion,
      tokens: collectTokens(input.program, input.packageRoot),
    };
    assertPerFileDeclarations(input.packageRoot, manifest.tokens);
    return manifest;
  });
}
