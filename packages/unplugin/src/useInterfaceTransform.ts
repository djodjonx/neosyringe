import * as ts from 'typescript';
import { formatUnsupportedMarker, NeoTokenError, resolveNeoMarker, TokenResolverService } from '@djodjonx/neosyringe-core/analyzer';
import { hasNeoSyringeMarkers } from './markerUtils';

type SourceEdit = { start: number; end: number; text: string };

/**
 * The call's result is read by a property, element, call, tag or non-null
 * chain. Marking it PURE lets the bundler delete that later effect.
 * `as`, `satisfies`, `<T>` and parentheses are not a read. Emit drops them,
 * so the check walks through them and only then looks for a chain.
 */
function partialCallFeedsChain(node: ts.Node): boolean {
  let current = node;
  let chained = false;
  for (;;) {
    const parent = current.parent;
    if (!parent) return chained;
    if (
      (ts.isParenthesizedExpression(parent) ||
        ts.isAsExpression(parent) ||
        ts.isSatisfiesExpression(parent) ||
        ts.isTypeAssertionExpression(parent)) &&
      parent.expression === current
    ) {
      current = parent;
      continue;
    }
    if (
      (ts.isPropertyAccessExpression(parent) ||
        ts.isElementAccessExpression(parent) ||
        ts.isNonNullExpression(parent)) &&
      parent.expression === current
    ) {
      chained = true;
      current = parent;
      continue;
    }
    if (ts.isCallExpression(parent) && parent.expression === current) {
      chained = true;
      current = parent;
      continue;
    }
    if (ts.isTaggedTemplateExpression(parent) && parent.tag === current) {
      chained = true;
      current = parent;
      continue;
    }
    return chained;
  }
}

/**
 * Insert offsets on `sourceFile` (the text of `code`). A chained call is
 * skipped: its result is already read. A non-string marker is ignored here;
 * transformUseInterfaceCalls reports it.
 */
export function collectDefinePartialConfigPureEdits(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
): SourceEdit[] {
  const edits: SourceEdit[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const marker = resolveNeoMarker(checker, node);
      if (marker === 'definePartialConfig' && !partialCallFeedsChain(node)) {
        const start = node.getStart(sourceFile);
        edits.push({ start, end: start, text: '/* @__PURE__ */ ' });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return edits;
}

export function applySourceEdits(code: string, edits: readonly SourceEdit[]): string {
  let result = code;
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  }
  return result;
}

/**
 * Marks a definePartialConfig call imported from @djodjonx/neosyringe so a
 * bundler can drop it when nothing reads the result. A local function with
 * the same name is left untouched. The call is not replaced by its argument.
 * The comment is inserted at getStart. The rest of the call text stays.
 */
export function annotateDefinePartialConfigCalls(
  code: string,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
): string {
  return applySourceEdits(code, collectDefinePartialConfigPureEdits(sourceFile, checker));
}

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
