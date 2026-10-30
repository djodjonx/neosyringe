import * as path from 'node:path';
import type * as ts from 'typescript';
import { TSContext } from '../../TSContext';
import { NeoTokenError } from '../errors/NeoTokenError';

/**
 * Version of the canonical token descriptor.
 * It is the first field of every serialized descriptor (`v1|...`), so a later
 * change of identity stays distinct from a hash collision.
 */
export const TOKEN_DESCRIPTOR_SCHEMA = 'v1';

const MAX_DEPTH = 32;

const SKIPPED_SYMBOL_NAMES = new Set(['__type', '__brand', 'InterfaceToken']);

const PRIMITIVE_FLAGS: ReadonlyArray<readonly [ts.TypeFlags, string]> = [
  [TSContext.ts.TypeFlags.String, 'string'],
  [TSContext.ts.TypeFlags.Number, 'number'],
  [TSContext.ts.TypeFlags.BigInt, 'bigint'],
  [TSContext.ts.TypeFlags.Boolean, 'boolean'],
  [TSContext.ts.TypeFlags.Void, 'void'],
  [TSContext.ts.TypeFlags.Undefined, 'undefined'],
  [TSContext.ts.TypeFlags.Null, 'null'],
  [TSContext.ts.TypeFlags.Never, 'never'],
  [TSContext.ts.TypeFlags.ESSymbol, 'symbol'],
  [TSContext.ts.TypeFlags.NonPrimitive, 'object'],
];

export interface CanonicalParts {
  name: string;
  descriptor: string;
}

export interface CanonicalOptions {
  /** Class value token: declaration only, type arguments dropped. */
  valueClass?: boolean;
}

/**
 * Canonical text for `type`, built before any hash and before any registry write.
 * An unsupported form throws {@link NeoTokenError} here, not a marker string.
 */
export function canonicalDescriptor(checker: ts.TypeChecker, type: ts.Type): string {
  return canonicalParts(checker, type).descriptor;
}

/** Declaration name plus the canonical descriptor. */
export function canonicalParts(
  checker: ts.TypeChecker,
  type: ts.Type,
  options?: CanonicalOptions,
): CanonicalParts {
  return describeType(checker, type, 0, options?.valueClass === true);
}

function unsupported(reason: string): never {
  throw new NeoTokenError('NEO_TOKEN_UNSUPPORTED', `NEO_TOKEN_UNSUPPORTED: ${reason}`);
}

function anonymousObject(): CanonicalParts {
  return unsupported('anonymous-object');
}

/**
 * Length-prefixed parts. The count and each part's length make the text injective:
 * `Repo<[Pair<A, [B, C]>]>` and `Repo<[Pair<A, [B]>, C]>` cannot share a string.
 * A named type with no arguments stays `v1|named|origin|Name|` (empty tail).
 */
function pack(parts: readonly string[]): string {
  return `<${parts.length}>[${parts.map((part) => `${part.length}:${part}`).join('')}]`;
}

function composite(kind: string, parts: readonly string[]): string {
  return `${TOKEN_DESCRIPTOR_SCHEMA}|${kind}|${pack(parts)}`;
}

function escapeToken(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/;/g, '\\;')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n');
}

function isDefaultLib(fileName: string): boolean {
  const base = path.posix.basename(fileName);
  if (!/^lib\..+\.d\.ts$/i.test(base)) return false;
  const libFile = TSContext.ts.getDefaultLibFilePath({}).replace(/\\/g, '/');
  const libDir = path.posix.dirname(libFile);
  return fileName.startsWith(`${libDir}/`) || fileName.includes('/typescript/lib/');
}

function packageOrigin(fileName: string): string | undefined {
  const marker = '/node_modules/';
  const index = fileName.lastIndexOf(marker);
  if (index < 0) return undefined;
  const parts = fileName.slice(index + marker.length).split('/');
  const scopeName = parts[0];
  if (scopeName === undefined || scopeName === '') return undefined;
  if (scopeName.startsWith('@')) {
    const packageName = parts[1];
    if (packageName === undefined || packageName === '' || parts.length < 3) return undefined;
    return `pkg/${scopeName}/${packageName}/${parts.slice(2).join('/')}`;
  }
  if (parts.length < 2) return undefined;
  return `pkg/${scopeName}/${parts.slice(1).join('/')}`;
}

function declarationOrigin(fileName: string): string {
  const normalized = fileName.replace(/\\/g, '/');
  if (isDefaultLib(normalized)) return `lib/${path.posix.basename(normalized)}`;
  const packaged = packageOrigin(normalized);
  if (packaged) return packaged;
  const normalizedRelative = path.relative(TSContext.projectRoot, fileName).split(path.sep).join('/');
  return normalizedRelative;
}

function resolveAlias(checker: ts.TypeChecker, symbol: ts.Symbol): ts.Symbol {
  let current = symbol;
  for (let hop = 0; hop < MAX_DEPTH; hop += 1) {
    if ((current.flags & TSContext.ts.SymbolFlags.Alias) === 0) return current;
    const next = checker.getAliasedSymbol(current);
    if (next === current) return current;
    current = next;
  }
  return unsupported('alias-cycle');
}

function isImportLike(node: ts.Node): boolean {
  return TSContext.ts.isImportSpecifier(node)
    || TSContext.ts.isExportSpecifier(node)
    || TSContext.ts.isImportClause(node)
    || TSContext.ts.isNamespaceImport(node)
    || TSContext.ts.isImportEqualsDeclaration(node);
}

/** Smallest normalised origin, then source position. Program file order is not identity. */
function canonicalDeclaration(symbol: ts.Symbol): ts.Declaration {
  const declarations = symbol.declarations ?? [];
  const real = declarations.filter((declaration) => !isImportLike(declaration));
  const pool = real.length > 0 ? real : declarations.slice();
  if (pool.length === 0) return unsupported('anonymous-object');
  return pool.slice().sort((left, right) => {
    const order = declarationOrigin(left.getSourceFile().fileName)
      .localeCompare(declarationOrigin(right.getSourceFile().fileName));
    if (order !== 0) return order;
    return left.getStart() - right.getStart();
  })[0];
}

/**
 * A function body, a static block and a bare block are `SyntaxKind.Block`.
 * A namespace body is `ModuleBlock`, so it stays a real container.
 */
function isFunctionOrBlockLocal(declaration: ts.Declaration): boolean {
  let current: ts.Node | undefined = declaration.parent;
  while (current) {
    if (TSContext.ts.isBlock(current)) return true;
    current = current.parent;
  }
  return false;
}

function qualifiedDeclarationName(declaration: ts.Declaration, leaf: string): string {
  const containers: string[] = [];
  let current: ts.Node | undefined = declaration.parent;
  while (current) {
    if (TSContext.ts.isModuleBlock(current) && TSContext.ts.isModuleDeclaration(current.parent)) {
      containers.push(current.parent.name.text);
      current = current.parent.parent;
      continue;
    }
    if (TSContext.ts.isEnumDeclaration(current)) containers.push(current.name.text);
    current = current.parent;
  }
  containers.reverse();
  return containers.length === 0 ? leaf : `${containers.join('.')}.${leaf}`;
}

function namedFromSymbol(
  checker: ts.TypeChecker,
  symbol: ts.Symbol,
  argumentDescriptors: readonly string[],
): CanonicalParts {
  const resolved = resolveAlias(checker, symbol);
  const declaration = canonicalDeclaration(resolved);
  if (isFunctionOrBlockLocal(declaration)) return unsupported('local-declaration');
  const declName = qualifiedDeclarationName(declaration, resolved.getName());
  const origin = declarationOrigin(declaration.getSourceFile().fileName);
  const argBody = argumentDescriptors.length === 0 ? '' : pack(argumentDescriptors);
  const descriptor = `${TOKEN_DESCRIPTOR_SCHEMA}|named|${escapeToken(origin)}|${escapeToken(declName)}|${argBody}`;
  return { name: resolved.getName(), descriptor };
}

function valueClassSymbol(checker: ts.TypeChecker, type: ts.Type): ts.Symbol {
  const signatures = type.getConstructSignatures();
  const instance = signatures.length > 0 ? signatures[0].getReturnType() : type;
  const symbol = instance.getSymbol() ?? instance.aliasSymbol;
  if (!symbol) return unsupported('anonymous-object');
  return resolveAlias(checker, symbol);
}

function referenceArguments(checker: ts.TypeChecker, type: ts.Type): readonly ts.Type[] {
  const reference = type as ts.TypeReference;
  if (reference.target) return checker.getTypeArguments(reference);
  if (type.aliasTypeArguments && type.aliasTypeArguments.length > 0) return type.aliasTypeArguments;
  return [];
}

function primitiveName(type: ts.Type): string | undefined {
  const intrinsic = (type as ts.Type & { intrinsicName?: string }).intrinsicName;
  if (
    intrinsic === 'string' || intrinsic === 'number' || intrinsic === 'bigint'
    || intrinsic === 'boolean' || intrinsic === 'void' || intrinsic === 'undefined'
    || intrinsic === 'null' || intrinsic === 'never' || intrinsic === 'symbol'
    || intrinsic === 'object'
  ) {
    return intrinsic;
  }
  for (const [flag, name] of PRIMITIVE_FLAGS) {
    if ((type.flags & flag) !== 0) return name;
  }
  return undefined;
}

function literalParts(type: ts.Type): CanonicalParts | undefined {
  if (type.isStringLiteral()) {
    return {
      name: 'Literal',
      descriptor: `${TOKEN_DESCRIPTOR_SCHEMA}|lit|string|${escapeToken(type.value)}`,
    };
  }
  if (type.isNumberLiteral()) {
    const value = String((type as ts.NumberLiteralType).value);
    return {
      name: 'Literal',
      descriptor: `${TOKEN_DESCRIPTOR_SCHEMA}|lit|number|${escapeToken(value)}`,
    };
  }
  if ((type.flags & TSContext.ts.TypeFlags.BigIntLiteral) !== 0) {
    const value = (type as ts.BigIntLiteralType).value;
    const text = `${value.negative ? '-' : ''}${value.base10Value}`;
    return {
      name: 'Literal',
      descriptor: `${TOKEN_DESCRIPTOR_SCHEMA}|lit|bigint|${escapeToken(text)}`,
    };
  }
  if ((type.flags & TSContext.ts.TypeFlags.BooleanLiteral) !== 0) {
    const intrinsic = (type as ts.Type & { intrinsicName?: string }).intrinsicName ?? 'true';
    return {
      name: 'Literal',
      descriptor: `${TOKEN_DESCRIPTOR_SCHEMA}|lit|boolean|${escapeToken(intrinsic)}`,
    };
  }
  return undefined;
}

/** TypeScript's own names (`__object`, `__function`, `__class`). `__type` stays skippable so a named alias of a type literal can still be recovered. */
function isStructuralAnonymousSymbol(symbol: ts.Symbol): boolean {
  const name = symbol.getName();
  if (name === TSContext.ts.InternalSymbolName.Type || !name.startsWith('__')) return false;
  return (Object.values(TSContext.ts.InternalSymbolName) as readonly string[]).includes(name);
}

function describeType(
  checker: ts.TypeChecker,
  type: ts.Type,
  depth: number,
  valueClass: boolean,
): CanonicalParts {
  if (depth > MAX_DEPTH) return unsupported('alias-cycle');
  if (valueClass) return namedFromSymbol(checker, valueClassSymbol(checker, type), []);
  if ((type.flags & TSContext.ts.TypeFlags.Any) !== 0) return unsupported('any');
  if ((type.flags & TSContext.ts.TypeFlags.Unknown) !== 0) return unsupported('unknown');
  if ((type.flags & TSContext.ts.TypeFlags.TypeParameter) !== 0) return unsupported('unbound-type-parameter');
  if ((type.flags & TSContext.ts.TypeFlags.Conditional) !== 0) return unsupported('conditional');
  if ((type.flags & TSContext.ts.TypeFlags.Substitution) !== 0) {
    return describeType(checker, (type as ts.SubstitutionType).baseType, depth + 1, false);
  }

  const enumSymbol = type.getSymbol();
  if (enumSymbol && (enumSymbol.flags & (TSContext.ts.SymbolFlags.Enum | TSContext.ts.SymbolFlags.EnumMember)) !== 0) {
    return namedFromSymbol(checker, enumSymbol, []);
  }

  const literal = literalParts(type);
  if (literal) return literal;

  const primitive = primitiveName(type);
  if (primitive) {
    return { name: primitive, descriptor: `${TOKEN_DESCRIPTOR_SCHEMA}|prim|${primitive}` };
  }

  if (type.isUnion()) {
    const unionMembers = type.types.map((part) => describeType(checker, part, depth + 1, false).descriptor);
    unionMembers.sort();
    return { name: 'Union', descriptor: composite('union', unionMembers) };
  }
  if ((type.flags & TSContext.ts.TypeFlags.Intersection) !== 0) return unsupported('intersection');
  if ((type.flags & (TSContext.ts.TypeFlags.Index | TSContext.ts.TypeFlags.IndexedAccess)) !== 0) {
    return unsupported('indexed-access');
  }
  if ((type.flags & (TSContext.ts.TypeFlags.TemplateLiteral | TSContext.ts.TypeFlags.StringMapping)) !== 0) {
    return unsupported('template-literal');
  }

  if (checker.isTupleType(type)) {
    const parts = checker.getTypeArguments(type as ts.TypeReference)
      .map((part) => describeType(checker, part, depth + 1, false).descriptor);
    return { name: 'Tuple', descriptor: composite('tuple', parts) };
  }
  if (checker.isArrayType(type)) {
    const inner = checker.getTypeArguments(type as ts.TypeReference)[0];
    if (!inner) return anonymousObject();
    const element = describeType(checker, inner, depth + 1, false);
    return { name: 'Array', descriptor: composite('array', [element.descriptor]) };
  }

  const symbol = type.getSymbol();
  if (symbol && isStructuralAnonymousSymbol(symbol)) return unsupported('anonymous-object');
  if (symbol && !SKIPPED_SYMBOL_NAMES.has(symbol.getName())) {
    const argumentTypes = referenceArguments(checker, type);
    const argumentDescriptors = argumentTypes.map((argument) => describeType(checker, argument, depth + 1, false).descriptor);
    return namedFromSymbol(checker, symbol, argumentDescriptors);
  }

  if (type.aliasSymbol) {
    const alias = resolveAlias(checker, type.aliasSymbol);
    const declaration = alias.declarations?.find((node): node is ts.TypeAliasDeclaration =>
      TSContext.ts.isTypeAliasDeclaration(node));
    if (declaration && TSContext.ts.isTypeLiteralNode(declaration.type)) {
      const aliasArgumentDescriptors = (type.aliasTypeArguments ?? [])
        .map((argument) => describeType(checker, argument, depth + 1, false).descriptor);
      return namedFromSymbol(checker, alias, aliasArgumentDescriptors);
    }
  }

  return anonymousObject();
}
