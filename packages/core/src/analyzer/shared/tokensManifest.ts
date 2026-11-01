import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type * as ts from 'typescript';
import { TSContext } from '../../TSContext';
import { NeoTokenError } from '../errors/NeoTokenError';

/** Protocol v1. A manifest is generated, never hand-edited. */
export const TOKENS_MANIFEST_SCHEMA_VERSION = 1;

export interface TokenManifestTypeExport {
  exportPath: string;
  exportName: string;
}

export interface TokenManifestEntry {
  exportPath: string;
  exportName: string;
  runtimeKey: string;
  descriptor: string;
  typeExport?: TokenManifestTypeExport;
}

export interface TokensManifest {
  schemaVersion: number;
  packageName: string;
  contractVersion: string;
  tokens: TokenManifestEntry[];
}

export interface PublishedTokenRef {
  packageName: string;
  contractVersion: string;
  runtimeKey: string;
}

export interface PublishedNamedParts {
  descriptor: string;
  published: PublishedTokenRef;
}

export type BoundaryReason =
  | 'manifest-absent'
  | 'schema-version'
  | 'runtime-key'
  | 'token-not-listed'
  | 'contract-version';

const MANIFEST_KEYS = ['schemaVersion', 'packageName', 'contractVersion', 'tokens'] as const;
const TOKEN_KEYS = ['exportPath', 'exportName', 'runtimeKey', 'descriptor', 'typeExport'] as const;
const TOKEN_REQUIRED = ['exportPath', 'exportName', 'runtimeKey', 'descriptor'] as const;
const TYPE_EXPORT_KEYS = ['exportPath', 'exportName'] as const;

/** Remedy named by the boundary diagnostic. The code and the reason stay in front. */
export const TOKEN_MANIFEST_REMEDY =
  'publish the token through a tokens manifest: neosyringe-check --tokens-manifest <file> --contract-version <v>, and reference it in package.json neosyringe.tokensManifest';

export interface BoundaryDetail {
  packageName?: string;
  subject?: string;
}

export function boundaryUnsupported(reason: BoundaryReason, detail?: BoundaryDetail): never {
  const where = [detail?.packageName, detail?.subject].filter((part) => part !== undefined && part !== '').join(' ');
  const tail = where === '' ? '' : ` ${where}`;
  throw new NeoTokenError(
    'NEO_TOKEN_BOUNDARY_UNSUPPORTED',
    `NEO_TOKEN_BOUNDARY_UNSUPPORTED: ${reason}${tail}. ${TOKEN_MANIFEST_REMEDY}`,
  );
}

function failField(kind: 'unknown' | 'missing', label: string): never {
  throw new Error(`${kind} field ${label}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[],
  label: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) failField('unknown', `${label}.${key}`);
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) failField('missing', `${label}.${key}`);
  }
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value === '') failField('missing', label);
  return value;
}

function readTypeExport(value: unknown, label: string): TokenManifestTypeExport {
  if (!isRecord(value)) failField('missing', label);
  exactKeys(value, TYPE_EXPORT_KEYS, TYPE_EXPORT_KEYS, label);
  return {
    exportPath: requiredString(value.exportPath, `${label}.exportPath`),
    exportName: requiredString(value.exportName, `${label}.exportName`),
  };
}

function readToken(value: unknown, index: number): TokenManifestEntry {
  const label = `manifest.tokens[${index}]`;
  if (!isRecord(value)) failField('missing', label);
  exactKeys(value, TOKEN_KEYS, TOKEN_REQUIRED, label);
  const entry: TokenManifestEntry = {
    exportPath: requiredString(value.exportPath, `${label}.exportPath`),
    exportName: requiredString(value.exportName, `${label}.exportName`),
    runtimeKey: requiredString(value.runtimeKey, `${label}.runtimeKey`),
    descriptor: requiredString(value.descriptor, `${label}.descriptor`),
  };
  if (Object.prototype.hasOwnProperty.call(value, 'typeExport')) {
    entry.typeExport = readTypeExport(value.typeExport, `${label}.typeExport`);
  }
  return entry;
}

/** Parses a manifest. Unknown or missing fields throw. `schemaVersion` may be any number. */
export function readTokensManifest(text: string): TokensManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    failField('missing', 'manifest');
  }
  if (!isRecord(parsed)) failField('missing', 'manifest');
  exactKeys(parsed, MANIFEST_KEYS, MANIFEST_KEYS, 'manifest');
  if (typeof parsed.schemaVersion !== 'number') failField('missing', 'manifest.schemaVersion');
  if (!Array.isArray(parsed.tokens)) failField('missing', 'manifest.tokens');
  return {
    schemaVersion: parsed.schemaVersion,
    packageName: requiredString(parsed.packageName, 'manifest.packageName'),
    contractVersion: requiredString(parsed.contractVersion, 'manifest.contractVersion'),
    tokens: parsed.tokens.map((token, index) => readToken(token, index)),
  };
}

export interface LocatedPackage {
  packageRoot: string;
  packageJsonPath: string;
  relativePath: string;
}

/**
 * Package root immediately after the last `node_modules/<name>`
 * (or `node_modules/@scope/<name>`, including a `.pnpm` path).
 * A nested `package.json` such as `dist/esm/package.json` is not the root.
 */
export function locatePackage(fileName: string): LocatedPackage | undefined {
  const normalized = fileName.replace(/\\/g, '/');
  const marker = '/node_modules/';
  const index = normalized.lastIndexOf(marker);
  if (index < 0) return undefined;
  const parts = normalized.slice(index + marker.length).split('/');
  const scope = parts[0];
  if (!scope) return undefined;
  const nameCount = scope.startsWith('@') ? 2 : 1;
  if (parts.length <= nameCount) return undefined;
  const packageNameParts = parts.slice(0, nameCount);
  if (packageNameParts.some((part) => part === '')) return undefined;
  const packageRoot = `${normalized.slice(0, index + marker.length)}${packageNameParts.join('/')}`;
  const packageJsonPath = path.join(packageRoot, 'package.json');
  if (!existsSync(packageJsonPath)) return undefined;
  return {
    packageRoot,
    packageJsonPath,
    relativePath: parts.slice(nameCount).join('/'),
  };
}

/** A failure stays in the map too. Stale until the next program (a new resolver). */
export type ManifestCache = Map<string, TokensManifest | NeoTokenError>;

export interface ReadManifestOptions {
  /** Per resolver instance. Not shared across builds. */
  cache?: ManifestCache;
  subject?: string;
}

export function readPublishedManifest(
  packageJsonPath: string,
  options?: ReadManifestOptions,
): TokensManifest {
  const hit = options?.cache?.get(packageJsonPath);
  if (hit instanceof NeoTokenError) throw hit;
  if (hit) return hit;
  try {
    const manifest = loadPublishedManifest(packageJsonPath, options?.subject);
    options?.cache?.set(packageJsonPath, manifest);
    return manifest;
  } catch (error) {
    if (error instanceof NeoTokenError) options?.cache?.set(packageJsonPath, error);
    throw error;
  }
}

function packageNameOfJson(parsed: unknown, packageJsonPath: string): string {
  if (isRecord(parsed) && typeof parsed.name === 'string' && parsed.name !== '') return parsed.name;
  return path.basename(path.dirname(packageJsonPath));
}

function loadPublishedManifest(packageJsonPath: string, subject?: string): TokensManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  } catch {
    boundaryUnsupported('manifest-absent', { subject });
  }
  const packageName = packageNameOfJson(parsed, packageJsonPath);
  const rel = isRecord(parsed) && isRecord(parsed.neosyringe)
    ? parsed.neosyringe.tokensManifest
    : undefined;
  if (typeof rel !== 'string' || rel === '') boundaryUnsupported('manifest-absent', { packageName, subject });
  const file = path.resolve(path.dirname(packageJsonPath), rel);
  if (!existsSync(file)) boundaryUnsupported('manifest-absent', { packageName, subject });
  const manifest = readTokensManifest(readFileSync(file, 'utf8'));
  if (manifest.schemaVersion !== TOKENS_MANIFEST_SCHEMA_VERSION) {
    boundaryUnsupported('schema-version', { packageName: manifest.packageName, subject });
  }
  return manifest;
}

/** Leaf name used by `emit`: the declaration name, after a namespace qualifier. */
export function declaredTokenName(descriptor: string): string {
  const fields: string[] = [];
  let current = '';
  for (let i = 0; i < descriptor.length; i += 1) {
    const ch = descriptor[i];
    if (ch === '\\') {
      current += descriptor[i + 1] ?? '';
      i += 1;
      continue;
    }
    if (ch === '|') {
      fields.push(current);
      current = '';
      if (fields.length === 4) {
        const name = fields[3];
        if (fields[0] !== 'v1' || fields[1] !== 'named' || name === undefined || name === '') {
          boundaryUnsupported('runtime-key');
        }
        const dot = name.lastIndexOf('.');
        return dot >= 0 ? name.slice(dot + 1) : name;
      }
      continue;
    }
    current += ch;
  }
  boundaryUnsupported('runtime-key');
}

function resolveAlias(checker: ts.TypeChecker, symbol: ts.Symbol): ts.Symbol {
  if ((symbol.flags & TSContext.ts.SymbolFlags.Alias) === 0) return symbol;
  return checker.getAliasedSymbol(symbol);
}

export function moduleExportName(
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  resolved: ts.Symbol,
): string | undefined {
  const fileSymbol = checker.getSymbolAtLocation(sourceFile);
  if (!fileSymbol) return undefined;
  const resolvedDecls = new Set(resolved.declarations ?? []);
  for (const exported of checker.getExportsOfModule(fileSymbol)) {
    const target = resolveAlias(checker, exported);
    if (target === resolved) return exported.getName();
    if ((target.declarations ?? []).some((decl) => resolvedDecls.has(decl))) return exported.getName();
  }
  return undefined;
}

function readPackageJson(packageJsonPath: string, subject: string): unknown {
  try {
    return JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  } catch {
    boundaryUnsupported('manifest-absent', { subject });
  }
}

function manifestField(parsed: unknown): string | undefined {
  if (!isRecord(parsed) || !isRecord(parsed.neosyringe)) return undefined;
  const rel = parsed.neosyringe.tokensManifest;
  if (typeof rel !== 'string' || rel === '') return undefined;
  return rel;
}

/** `dependencies` and `peerDependencies` only. A devDependency does not make a producer. */
function declaresNeoSyringe(parsed: unknown): boolean {
  if (!isRecord(parsed)) return false;
  const listed = (bag: unknown): boolean =>
    isRecord(bag) && Object.prototype.hasOwnProperty.call(bag, '@djodjonx/neosyringe');
  return listed(parsed.dependencies) || listed(parsed.peerDependencies);
}

function typeReferenceName(typeNode: ts.TypeNode): string | undefined {
  if (!TSContext.ts.isTypeReferenceNode(typeNode)) return undefined;
  const name = typeNode.typeName;
  if (TSContext.ts.isIdentifier(name)) return name.text;
  return name.right.text;
}

/** A `useInterface` const: its type is the NeoSyringe `InterfaceToken`. */
function isInterfaceTokenConst(checker: ts.TypeChecker, declaration: ts.Declaration): boolean {
  if (!TSContext.ts.isVariableDeclaration(declaration)) return false;
  if (declaration.type && typeReferenceName(declaration.type) === 'InterfaceToken') return true;
  const type = checker.getTypeAtLocation(declaration);
  if (type.aliasSymbol?.getName() === 'InterfaceToken') return true;
  return type.getSymbol()?.getName() === 'InterfaceToken';
}

/**
 * No `neosyringe.tokensManifest` field: legacy `pkg/` origin, except a producer
 * or a `useInterface` const, which stay `manifest-absent`.
 * A present field keeps every refusal (schema, key, listing, contract).
 */
function manifestForPackage(
  located: LocatedPackage,
  subject: string,
  producerSymbol: boolean,
  cache?: ManifestCache,
): TokensManifest | undefined {
  const parsed = readPackageJson(located.packageJsonPath, subject);
  if (manifestField(parsed) === undefined) {
    if (declaresNeoSyringe(parsed) || producerSymbol) {
      boundaryUnsupported('manifest-absent', {
        packageName: packageNameOfJson(parsed, located.packageJsonPath),
        subject,
      });
    }
    return undefined;
  }
  return readPublishedManifest(located.packageJsonPath, { cache, subject });
}

function publishedRef(manifest: TokensManifest, entry: TokenManifestEntry): PublishedTokenRef {
  return {
    packageName: manifest.packageName,
    contractVersion: manifest.contractVersion,
    runtimeKey: entry.runtimeKey,
  };
}

/**
 * Package type matched by `typeExport`.
 * A generic specialization is refused here. `Repo<User>` is resolved from its
 * exported const, matched by `(exportPath, exportName)`.
 * No `package.json`, or a package.json with no `neosyringe.tokensManifest`,
 * keeps the legacy `pkg/` origin. A producer (dependency or peer on
 * `@djodjonx/neosyringe`, not a devDependency) or a `useInterface` const
 * without that field is refused.
 */
export function publishedNamedParts(
  checker: ts.TypeChecker,
  declaration: ts.Declaration,
  resolved: ts.Symbol,
  argumentCount: number,
  fileName: string,
  cache?: ManifestCache,
): PublishedNamedParts | undefined {
  const located = locatePackage(fileName);
  if (!located) return undefined;
  const subject = resolved.getName();
  const manifest = manifestForPackage(located, subject, isInterfaceTokenConst(checker, declaration), cache);
  if (!manifest) return undefined;
  if (argumentCount > 0) boundaryUnsupported('token-not-listed', { packageName: manifest.packageName, subject });
  const exportName = moduleExportName(checker, declaration.getSourceFile(), resolved);
  if (!exportName) boundaryUnsupported('token-not-listed', { packageName: manifest.packageName, subject });
  const entry = manifest.tokens.find((token) =>
    token.typeExport?.exportPath === located.relativePath
    && token.typeExport.exportName === exportName);
  if (!entry) boundaryUnsupported('token-not-listed', { packageName: manifest.packageName, subject: exportName });
  return { descriptor: entry.descriptor, published: publishedRef(manifest, entry) };
}

/** Exported const matched by `(exportPath, exportName)`. */
export function publishedValueToken(
  checker: ts.TypeChecker,
  node: ts.Node,
  cache?: ManifestCache,
): { name: string; descriptor: string; published: PublishedTokenRef } | undefined {
  if (!TSContext.ts.isIdentifier(node)) return undefined;
  const symbol = checker.getSymbolAtLocation(node);
  if (!symbol) return undefined;
  const resolved = resolveAlias(checker, symbol);
  const declaration = resolved.valueDeclaration
    ?? resolved.declarations?.find((decl) => TSContext.ts.isVariableDeclaration(decl));
  if (!declaration || !TSContext.ts.isVariableDeclaration(declaration)) return undefined;
  const sourceFile = declaration.getSourceFile();
  const located = locatePackage(sourceFile.fileName);
  if (!located) return undefined;
  const manifest = manifestForPackage(located, node.text, isInterfaceTokenConst(checker, declaration), cache);
  if (!manifest) return undefined;
  const exportName = moduleExportName(checker, sourceFile, resolved);
  if (!exportName) boundaryUnsupported('token-not-listed', { packageName: manifest.packageName, subject: node.text });
  const entry = manifest.tokens.find((token) =>
    token.exportPath === located.relativePath && token.exportName === exportName);
  if (!entry) boundaryUnsupported('token-not-listed', { packageName: manifest.packageName, subject: exportName });
  return {
    name: declaredTokenName(entry.descriptor),
    descriptor: entry.descriptor,
    published: publishedRef(manifest, entry),
  };
}
