import { readFileSync } from 'node:fs';
import path from 'node:path';
import type * as ts from 'typescript';
import { TSContext } from '../../TSContext';
import { NeoTokenError } from '../errors/NeoTokenError';
import { containerKeyFor } from '../shared/registrationGraph';
import { NEO_SYRINGE_SPECIFIER, resolveNeoMarker } from '../shared/markerProvenance';
import { DEFAULT_EXPORT_CONTAINER_NAME } from '../shared/constants';
import { TokenResolverService } from '../shared/TokenResolverService';
import type { ConfigGraph, ConfigType, TokenId } from '../types';

/** One `resolve` / `resolveAll` call. `useInterface` is not a usage. */
export interface ResolutionUsage {
  node: ts.CallExpression;
  kind: 'resolve' | 'resolveAll';
  containerKey?: string;
  tokenId?: string;
}

/** Tokens visible to one container, split the way resolve and resolveAll are. */
export interface ContainerTokenView {
  single: Set<TokenId>;
  multi: Set<TokenId>;
  /** Registered on a closed ancestor, outside its exported roots. */
  closedPrivate: Set<TokenId>;
}

type ReceiverTarget =
  | { kind: 'container'; containerKey: string }
  | { kind: 'unknown' }
  | { kind: 'ignore' };

const NEO_CONTAINER_NAMES = new Set(['Container', 'CoreContainer', 'AsyncContainer', 'ContainerFor']);

/** True when the text calls `resolve` or `resolveAll`, including `resolve<T>(`. */
export function textCallsResolve(text: string): boolean {
  return /\.resolve(All)?\s*[<(]/.test(text);
}

/**
 * `resolve` / `resolveAll` calls in one file.
 * A receiver that is not a NeoSyringe container is omitted (`ignore`).
 */
export function collectResolutionUsages(sourceFile: ts.SourceFile, checker: ts.TypeChecker): ResolutionUsage[] {
  const found: ResolutionUsage[] = [];
  const tokens = new TokenResolverService(checker);

  const visit = (node: ts.Node): void => {
    if (TSContext.ts.isCallExpression(node)) {
      const marker = resolveNeoMarker(checker, node);
      if (marker === 'useInterface') {
        TSContext.ts.forEachChild(node, visit);
        return;
      }
      const kind = resolutionKind(node.expression);
      if (kind) {
        const receiver = TSContext.ts.isPropertyAccessExpression(node.expression)
          ? node.expression.expression
          : undefined;
        let target: ReceiverTarget = receiver ? classifyReceiver(receiver, checker) : { kind: 'ignore' };
        if (target.kind === 'ignore') return;
        found.push(toUsage(node, kind, target, tokens));
      }
    }
    TSContext.ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return found;
}

/**
 * Local injections, partials in `extends`, parent containers, and legacy parent tokens.
 * Keyed by `containerKey`, not by the variable name. `expects` are not included.
 */
export function buildContainerTokenView(
  config: ConfigGraph,
  allConfigs: Map<string, ConfigGraph>,
  checker?: ts.TypeChecker,
): ContainerTokenView {
  const single = new Set<TokenId>();
  const multi = new Set<TokenId>();
  const closedPrivate = new Set<TokenId>();
  addView(config, allConfigs, single, multi, closedPrivate, new Set(), checker);
  return { single, multi, closedPrivate };
}

function toUsage(
  node: ts.CallExpression,
  kind: 'resolve' | 'resolveAll',
  target: ReceiverTarget,
  tokens: TokenResolverService,
): ResolutionUsage {
  let tokenId: string | undefined;
  const arg = node.arguments[0];
  if (arg && target.kind === 'container') {
    try {
      tokenId = tokens.resolveTokenId(arg) ?? undefined;
    } catch (error) {
      if (!(error instanceof NeoTokenError)) throw error;
    }
  }
  return {
    node,
    kind,
    containerKey: target.kind === 'container' ? target.containerKey : undefined,
    tokenId,
  };
}

function resolutionKind(expr: ts.Expression): 'resolve' | 'resolveAll' | undefined {
  if (!TSContext.ts.isPropertyAccessExpression(expr)) return undefined;
  if (expr.name.text === 'resolve') return 'resolve';
  if (expr.name.text === 'resolveAll') return 'resolveAll';
  return undefined;
}

function classifyReceiver(expr: ts.Expression, checker: ts.TypeChecker): ReceiverTarget {
  const call = resolveConfigCall(expr, checker);
  if (call) return { kind: 'container', containerKey: containerKeyFor(call) };
  if (isNeoContainerType(checker.getTypeAtLocation(expr), checker)) return { kind: 'unknown' };
  return { kind: 'ignore' };
}

function resolveConfigCall(
  expr: ts.Expression,
  checker: ts.TypeChecker,
  depth = 0,
): ts.CallExpression | undefined {
  if (depth > 20) return undefined;
  const current = unwrap(expr);
  if (TSContext.ts.isCallExpression(current)) {
    return resolveNeoMarker(checker, current) === 'defineBuilderConfig' ? current : undefined;
  }
  if (TSContext.ts.isConditionalExpression(current)) {
    const whenTrue = resolveConfigCall(current.whenTrue, checker, depth + 1);
    const whenFalse = resolveConfigCall(current.whenFalse, checker, depth + 1);
    if (!whenTrue || !whenFalse) return undefined;
    return containerKeyFor(whenTrue) === containerKeyFor(whenFalse) ? whenTrue : undefined;
  }
  if (TSContext.ts.isIdentifier(current)) {
    const next = initializerOf(current, checker);
    if (!next) return undefined;
    return resolveConfigCall(next, checker, depth + 1);
  }
  if (TSContext.ts.isPropertyAccessExpression(current)) {
    const next = propertyInitializer(current, checker);
    if (!next) return undefined;
    return resolveConfigCall(next, checker, depth + 1);
  }
  return undefined;
}

function unwrap(expr: ts.Expression): ts.Expression {
  let current = expr;
  while (
    TSContext.ts.isParenthesizedExpression(current)
    || TSContext.ts.isAsExpression(current)
    || TSContext.ts.isSatisfiesExpression(current)
    || TSContext.ts.isTypeAssertionExpression(current)
    || TSContext.ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function initializerOf(node: ts.Identifier, checker: ts.TypeChecker): ts.Expression | undefined {
  const symbol = checker.getSymbolAtLocation(node);
  if (!symbol) return undefined;
  return expressionOfDeclaration(valueDeclaration(checker, symbol), checker);
}

function propertyInitializer(
  access: ts.PropertyAccessExpression,
  checker: ts.TypeChecker,
): ts.Expression | undefined {
  const symbol = checker.getSymbolAtLocation(access.name) ?? checker.getSymbolAtLocation(access);
  if (!symbol) return undefined;
  return expressionOfDeclaration(valueDeclaration(checker, symbol), checker);
}

function valueDeclaration(checker: ts.TypeChecker, symbol: ts.Symbol): ts.Declaration | undefined {
  let current = symbol;
  for (let hop = 0; hop < 20; hop += 1) {
    if ((current.flags & TSContext.ts.SymbolFlags.Alias) === 0) break;
    current = checker.getAliasedSymbol(current);
  }
  return current.valueDeclaration ?? current.declarations?.[0];
}

function expressionOfDeclaration(
  declaration: ts.Declaration | undefined,
  checker: ts.TypeChecker,
): ts.Expression | undefined {
  if (!declaration) return undefined;
  if (TSContext.ts.isVariableDeclaration(declaration)) {
    if (!keepsInitializer(declaration, checker)) return undefined;
    return declaration.initializer;
  }
  if (TSContext.ts.isExportAssignment(declaration) && declaration.isExportEquals !== true) {
    return declaration.expression;
  }
  return undefined;
}

/** `const`, or `let` / `var` that is never written after its initializer. */
function keepsInitializer(declaration: ts.VariableDeclaration, checker: ts.TypeChecker): boolean {
  const list = declaration.parent;
  if (!TSContext.ts.isVariableDeclarationList(list)) return false;
  if ((list.flags & TSContext.ts.NodeFlags.Const) !== 0) return true;
  if (!TSContext.ts.isIdentifier(declaration.name)) return false;
  const symbol = checker.getSymbolAtLocation(declaration.name);
  if (!symbol) return false;
  return !writtenAfterInitializer(symbol, declaration.name, declaration.getSourceFile(), checker);
}

function writtenAfterInitializer(
  symbol: ts.Symbol,
  name: ts.Identifier,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
): boolean {
  let written = false;
  const visit = (node: ts.Node): void => {
    if (written) return;
    if (node !== name && TSContext.ts.isIdentifier(node) && isAssignmentTarget(node)) {
      if (checker.getSymbolAtLocation(node) === symbol) written = true;
    }
    TSContext.ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return written;
}

function isAssignmentTarget(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (TSContext.ts.isBinaryExpression(parent) && parent.left === node) {
    const kind = parent.operatorToken.kind;
    return kind >= TSContext.ts.SyntaxKind.FirstAssignment
      && kind <= TSContext.ts.SyntaxKind.LastAssignment;
  }
  if (
    (TSContext.ts.isPrefixUnaryExpression(parent) || TSContext.ts.isPostfixUnaryExpression(parent))
    && parent.operand === node
  ) {
    return parent.operator === TSContext.ts.SyntaxKind.PlusPlusToken
      || parent.operator === TSContext.ts.SyntaxKind.MinusMinusToken;
  }
  return false;
}

function isNeoContainerType(
  type: ts.Type,
  checker: ts.TypeChecker,
  seen = new Set<ts.Type>(),
): boolean {
  if (seen.has(type)) return false;
  seen.add(type);
  const flags = TSContext.ts.TypeFlags;
  // The public TypeFlags enum has no Error member. An error type is Any.
  if ((type.flags & (flags.Any | flags.Unknown)) !== 0) return false;
  if (type.isUnion()) {
    const parts = type.types.filter((part) =>
      (part.flags & (flags.Undefined | flags.Null | flags.Void)) === 0,
    );
    return parts.length > 0 && parts.every((part) => isNeoContainerType(part, checker, seen));
  }
  if (type.isIntersection()) {
    return type.types.some((part) => isNeoContainerType(part, checker, seen));
  }
  const name = type.aliasSymbol?.getName() ?? type.getSymbol()?.getName();
  if (name === 'FactoryContext') return false;
  if (name && NEO_CONTAINER_NAMES.has(name)) return typeDeclaredByNeoSyringe(type, checker);
  const bases = type.getBaseTypes?.() ?? [];
  return bases.some((base) => isNeoContainerType(base, checker, seen));
}

function addView(
  config: ConfigGraph,
  allConfigs: Map<string, ConfigGraph>,
  single: Set<TokenId>,
  multi: Set<TokenId>,
  closedPrivate: Set<TokenId>,
  seen: Set<string>,
  checker: ts.TypeChecker | undefined,
): void {
  const mark = config.containerKey ?? `${config.sourceFile.fileName}:${config.node.getStart()}`;
  if (seen.has(mark)) return;
  seen.add(mark);
  for (const tokenId of config.localInjections.keys()) single.add(tokenId);
  if (config.multiInjections) {
    for (const tokenId of config.multiInjections.keys()) multi.add(tokenId);
  }
  if (config.legacyParentTokens) {
    for (const tokenId of config.legacyParentTokens) single.add(tokenId);
  }
  for (const ref of config.extendsRefs) {
    const partial = findNamedConfig(config, ref, allConfigs, 'partial', checker);
    if (partial) addView(partial, allConfigs, single, multi, closedPrivate, seen, checker);
  }
  if (config.type !== 'builder') return;
  const parent = config.useContainerRef
    ? findNamedConfig(config, config.useContainerRef, allConfigs, 'builder', checker)
    : undefined;
  if (!parent) return;
  if (parent.optimizationMode === 'closed') {
    addClosedParent(parent, single, multi, closedPrivate);
    return;
  }
  addView(parent, allConfigs, single, multi, closedPrivate, seen, checker);
}

/** A closed parent contributes its exported roots only. ADR006 lines 45-46. */
function addClosedParent(
  parent: ConfigGraph,
  single: Set<TokenId>,
  multi: Set<TokenId>,
  closedPrivate: Set<TokenId>,
): void {
  const roots = new Set(parent.publicRoots ?? []);
  const multiRoots = new Set(parent.publicMultiRoots ?? []);
  for (const tokenId of parent.localInjections.keys()) {
    if (roots.has(tokenId)) single.add(tokenId);
    else closedPrivate.add(tokenId);
  }
  if (!parent.multiInjections) return;
  for (const tokenId of parent.multiInjections.keys()) {
    if (multiRoots.has(tokenId)) multi.add(tokenId);
    else closedPrivate.add(tokenId);
  }
}

function findNamedConfig(
  from: ConfigGraph,
  name: string,
  allConfigs: Map<string, ConfigGraph>,
  type: ConfigType,
  checker: ts.TypeChecker | undefined,
): ConfigGraph | undefined {
  const sameFile = configsNamed(allConfigs, from.sourceFile.fileName, name, type);
  if (sameFile.length === 1) return sameFile[0];
  if (sameFile.length > 1) return nearestPrior(sameFile, from.node.getStart());
  if (checker) {
    const viaSymbol = configBySymbol(from, name, allConfigs, type, checker);
    if (viaSymbol) return viaSymbol;
  }
  const binding = importBinding(from.sourceFile, name);
  if (binding) {
    const file = fileForSpecifier(from.sourceFile, binding.specifier, allConfigs);
    if (!file) return undefined;
    const exportName = binding.exportName === 'default' ? DEFAULT_EXPORT_CONTAINER_NAME : binding.exportName;
    const imported = configsNamed(allConfigs, file, exportName, type);
    return imported.length === 1 ? imported[0] : undefined;
  }
  const global = [...allConfigs.values()].filter((config) => config.name === name && config.type === type);
  return global.length === 1 ? global[0] : undefined;
}

function configsNamed(
  allConfigs: Map<string, ConfigGraph>,
  fileName: string,
  name: string,
  type: ConfigType,
): ConfigGraph[] {
  const wanted = fileName.replace(/\\/g, '/');
  return [...allConfigs.values()].filter((config) =>
    config.sourceFile.fileName.replace(/\\/g, '/') === wanted
    && config.name === name
    && config.type === type,
  );
}

function nearestPrior(configs: ConfigGraph[], start: number): ConfigGraph | undefined {
  const prior = configs.filter((config) => config.node.getStart() < start);
  if (prior.length === 0) return undefined;
  return prior.reduce((best, config) => (config.node.getStart() > best.node.getStart() ? config : best));
}

function importBinding(
  sourceFile: ts.SourceFile,
  localName: string,
): { specifier: string; exportName: string } | undefined {
  for (const statement of sourceFile.statements) {
    if (!TSContext.ts.isImportDeclaration(statement)) continue;
    if (!TSContext.ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const specifier = statement.moduleSpecifier.text;
    const clause = statement.importClause;
    if (!clause || clause.isTypeOnly) continue;
    if (clause.name?.text === localName) return { specifier, exportName: 'default' };
    const named = clause.namedBindings;
    if (!named || !TSContext.ts.isNamedImports(named)) continue;
    for (const element of named.elements) {
      if (element.isTypeOnly || element.name.text !== localName) continue;
      return { specifier, exportName: element.propertyName?.text ?? element.name.text };
    }
  }
  return undefined;
}

function fileForSpecifier(
  from: ts.SourceFile,
  specifier: string,
  allConfigs: Map<string, ConfigGraph>,
): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const dir = path.posix.dirname(from.fileName.replace(/\\/g, '/'));
  const joined = path.posix.normalize(path.posix.join(dir, specifier));
  const candidates = new Set([
    joined,
    `${joined}.ts`,
    `${joined}.tsx`,
    `${joined}.mts`,
    `${joined}.cts`,
    `${joined}/index.ts`,
    `${joined}/index.tsx`,
  ]);
  for (const config of allConfigs.values()) {
    const file = config.sourceFile.fileName.replace(/\\/g, '/');
    if (candidates.has(file)) return config.sourceFile.fileName;
  }
  return undefined;
}

function configBySymbol(
  from: ConfigGraph,
  name: string,
  allConfigs: Map<string, ConfigGraph>,
  type: ConfigType,
  checker: ts.TypeChecker,
): ConfigGraph | undefined {
  const identifier = identifierNamed(from.sourceFile, name);
  if (!identifier) return undefined;
  const symbol = checker.getSymbolAtLocation(identifier);
  if (!symbol) return undefined;
  const expression = expressionOfDeclaration(valueDeclaration(checker, symbol), checker);
  if (!expression) return undefined;
  const call = configCallOf(expression, checker);
  if (!call) return undefined;
  const marker = type === 'builder' ? 'defineBuilderConfig' : 'definePartialConfig';
  if (resolveNeoMarker(checker, call) !== marker) return undefined;
  const config = allConfigs.get(containerKeyFor(call));
  if (!config || config.type !== type) return undefined;
  return config;
}

function configCallOf(
  expr: ts.Expression,
  checker: ts.TypeChecker,
  depth = 0,
): ts.CallExpression | undefined {
  if (depth > 20) return undefined;
  const current = unwrap(expr);
  if (TSContext.ts.isCallExpression(current)) {
    const marker = resolveNeoMarker(checker, current);
    if (marker === 'defineBuilderConfig' || marker === 'definePartialConfig') return current;
    return undefined;
  }
  if (TSContext.ts.isIdentifier(current)) {
    const followed = initializerOf(current, checker);
    if (!followed) return undefined;
    return configCallOf(followed, checker, depth + 1);
  }
  if (TSContext.ts.isPropertyAccessExpression(current)) {
    const followed = propertyInitializer(current, checker);
    if (!followed) return undefined;
    return configCallOf(followed, checker, depth + 1);
  }
  return undefined;
}

function identifierNamed(sourceFile: ts.SourceFile, name: string): ts.Identifier | undefined {
  let found: ts.Identifier | undefined;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (TSContext.ts.isIdentifier(node) && node.text === name) {
      found = node;
      return;
    }
    TSContext.ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

/** Name match is not enough: the declaration must come from `@djodjonx/neosyringe`. */
function typeDeclaredByNeoSyringe(type: ts.Type, checker: ts.TypeChecker): boolean {
  const alias = type.aliasSymbol;
  const symbol = type.getSymbol();
  if (alias && symbolFromNeoSyringe(checker, alias)) return true;
  if (symbol && symbol !== alias && symbolFromNeoSyringe(checker, symbol)) return true;
  return false;
}

function symbolFromNeoSyringe(checker: ts.TypeChecker, symbol: ts.Symbol): boolean {
  const seen = new Set<ts.Symbol>();
  let current: ts.Symbol | undefined = symbol;
  for (let hop = 0; current && hop < 20; hop += 1) {
    if (seen.has(current)) return false;
    seen.add(current);
    for (const decl of current.declarations ?? []) {
      if (moduleSpecifierText(decl) === NEO_SYRINGE_SPECIFIER) return true;
      if (packageNameOf(decl.getSourceFile().fileName) === NEO_SYRINGE_SPECIFIER) return true;
    }
    if ((current.flags & TSContext.ts.SymbolFlags.Alias) === 0) return false;
    const next = checker.getAliasedSymbol(current);
    if (!next || next === current) return false;
    current = next;
  }
  return false;
}

function moduleSpecifierText(decl: ts.Node): string | undefined {
  let current: ts.Node | undefined = decl;
  while (current) {
    if (TSContext.ts.isImportDeclaration(current) || TSContext.ts.isExportDeclaration(current)) {
      const specifier = current.moduleSpecifier;
      return specifier && TSContext.ts.isStringLiteral(specifier) ? specifier.text : undefined;
    }
    current = current.parent;
  }
  return undefined;
}

const packageNameByFile = new Map<string, string | undefined>();

function packageNameOf(fileName: string): string | undefined {
  const normalized = fileName.replace(/\\/g, '/');
  if (packageNameByFile.has(normalized)) return packageNameByFile.get(normalized);
  let dir = path.posix.dirname(normalized);
  const seen = new Set<string>();
  while (!seen.has(dir)) {
    seen.add(dir);
    try {
      const parsed = JSON.parse(readFileSync(`${dir}/package.json`, 'utf8')) as { name?: unknown };
      const name = typeof parsed.name === 'string' ? parsed.name : undefined;
      packageNameByFile.set(normalized, name);
      return name;
    } catch {
      const parent = path.posix.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  packageNameByFile.set(normalized, undefined);
  return undefined;
}
