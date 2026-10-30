import * as ts from 'typescript';
import { formatUnsupportedMarker, NeoTokenError, resolveNeoMarker, TokenResolverService } from '@djodjonx/neosyringe-core/analyzer';
import { hasNeoSyringeMarkers } from './markerUtils';

export type UsedTokenEntry = {
  file: string;
  line: number;
  column: number;
  interfaceName: string;
  /** Full canonical descriptor, kept so a later file can detect a hash collision. */
  descriptor: string;
};

const LIB_SOURCE_CACHE = Symbol('libSourceCache');

function reusableDeclaration(fileName: string): string | undefined {
  const norm = fileName.replace(/\\/g, '/');
  if (!norm.endsWith('.d.ts')) return undefined;
  if (norm.includes('/node_modules/') || norm.includes('/typescript/lib/')) return norm;
  return undefined;
}

function libSourceCache(options: ts.CompilerOptions): Map<string, ts.SourceFile> {
  const holder = options as ts.CompilerOptions & { [LIB_SOURCE_CACHE]?: Map<string, ts.SourceFile> };
  const existing = holder[LIB_SOURCE_CACHE];
  if (existing) return existing;
  const created = new Map<string, ts.SourceFile>();
  Object.defineProperty(holder, LIB_SOURCE_CACHE, { value: created });
  return created;
}

const CONTAINER_MARKER_NAMES: ReadonlySet<string> = new Set([
  'defineBuilderConfig',
  'definePartialConfig',
  'declareContainerTokens',
]);

/**
 * A container-only file has nothing for this pass to rewrite.
 * Any other call can be an alias, a namespace access, or `neo[key]()`.
 */
function needsTokenRewrite(code: string): boolean {
  if (!hasNeoSyringeMarkers(code)) return false;
  const sourceFile = ts.createSourceFile('marker-scan.ts', code, ts.ScriptTarget.Latest, false);
  let needs = false;

  const visit = (node: ts.Node): void => {
    if (needs) return;
    if (ts.isCallExpression(node)) {
      const expr = node.expression;
      if (!ts.isIdentifier(expr) || !CONTAINER_MARKER_NAMES.has(expr.text)) {
        needs = true;
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return needs;
}

/**
 * Transforms useInterface<T>() and useProperty() calls into token strings.
 * Positions come from the source file parsed from `code` (the text after any
 * container splice), so they are never taken from an earlier string.
 *
 * `options.hash` is for tests. A constant hash puts two descriptors on one id
 * so a cross-file collision can be asserted.
 */
export function transformUseInterfaceCalls(
  code: string,
  id: string,
  compilerOptions: ts.CompilerOptions,
  usedTokens?: Map<string, UsedTokenEntry>,
  options?: { hash?: (value: string) => string },
): string | null {
  if (!needsTokenRewrite(code)) return null;

  const sourceFile = ts.createSourceFile(id, code, ts.ScriptTarget.Latest, true);

  // One parsed copy of each lib .d.ts per compiler-options object. The plugin keeps that
  // object for the build, so a second file does not parse the default library again.
  const libSources = libSourceCache(compilerOptions);
  const compilerHost = ts.createCompilerHost(compilerOptions);
  const originalGetSourceFile = compilerHost.getSourceFile;
  compilerHost.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
    if (fileName === id) return sourceFile;
    const key = reusableDeclaration(fileName);
    if (!key || shouldCreateNewSourceFile) {
      return originalGetSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
    }
    const hit = libSources.get(key);
    if (hit) return hit;
    const created = originalGetSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
    if (created) libSources.set(key, created);
    return created;
  };

  const program = ts.createProgram([id], compilerOptions, compilerHost);
  const checker = program.getTypeChecker();
  if (typeof checker.getSymbolAtLocation !== 'function') return null;
  const resolver = new TokenResolverService(checker, undefined, options);

  const replacements: { start: number; end: number; text: string }[] = [];

  function visit(node: ts.Node) {
    if (ts.isCallExpression(node)) {
      const marker = resolveNeoMarker(checker, node);
      if (marker && typeof marker === 'object') {
        throw new Error(formatUnsupportedMarker(node));
      }

      if (marker === 'useInterface' && node.typeArguments && node.typeArguments.length > 0) {
        const nodeStart = node.getStart(sourceFile);
        const nodeEnd = node.getEnd();
        const typeArg = node.typeArguments[0];
        const type = checker.getTypeFromTypeNode(typeArg);
        const tokenId = resolver.getTypeId(type);
        const descriptor = resolver.describeType(type);

        replacements.push({
          start: nodeStart,
          end: nodeEnd,
          text: `"${tokenId}"`,
        });

        if (usedTokens) {
          const previous = usedTokens.get(tokenId);
          if (previous && previous.descriptor !== descriptor) {
            throw new NeoTokenError(
              'NEO_TOKEN_COLLISION',
              `NEO_TOKEN_COLLISION: ${previous.descriptor} <> ${descriptor}`,
            );
          }
          if (!previous) {
            const line = sourceFile.getLineAndCharacterOfPosition(nodeStart);
            usedTokens.set(tokenId, {
              file: id,
              line: line.line + 1,
              column: line.character + 1,
              interfaceName: type.getSymbol()?.getName() ?? tokenId,
              descriptor,
            });
          }
        }
      }

      if (marker === 'useProperty') {
        const classArg = node.arguments[0];
        const nameArg = node.arguments[1];
        if (
          !classArg ||
          !ts.isIdentifier(classArg) ||
          !nameArg ||
          !ts.isStringLiteral(nameArg)
        ) {
          throw new Error(formatUnsupportedMarker(node));
        }
        const classType = checker.getTypeAtLocation(classArg);
        const tokenId = resolver.getPropertyTokenId(classType, nameArg.text);
        replacements.push({
          start: node.getStart(sourceFile),
          end: node.getEnd(),
          text: JSON.stringify(tokenId),
        });
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  if (replacements.length === 0) return null;

  let result = code;
  for (const r of replacements.sort((a, b) => b.start - a.start)) {
    result = result.slice(0, r.start) + r.text + result.slice(r.end);
  }

  return result;
}
