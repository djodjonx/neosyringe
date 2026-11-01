import * as ts from 'typescript';
import { formatUnsupportedMarker, NeoTokenError, resolveNeoMarker, TokenResolverService } from '@djodjonx/neosyringe-core/analyzer';

export type SourceEdit = { start: number; end: number; text: string };

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
 * Insert offsets on `sourceFile`. A chained call is skipped: its result is
 * already read. A non-string marker is ignored here; the caller reports it.
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

export type UsedTokenEntry = {
  file: string;
  line: number;
  column: number;
  interfaceName: string;
  /** Full canonical descriptor, kept so a later file can detect a hash collision. */
  descriptor: string;
};

/**
 * useInterface and useProperty edits on an existing SourceFile.
 * Positions are taken from that file. The caller applies them once.
 *
 * `options.hash` is for tests. A constant hash puts two descriptors on one id
 * so a cross-file collision can be asserted.
 */
export function collectUseSiteEdits(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  usedTokens?: Map<string, UsedTokenEntry>,
  options?: { hash?: (value: string) => string },
): SourceEdit[] {
  const resolver = new TokenResolverService(checker, undefined, options);
  const edits: SourceEdit[] = [];

  const record = (node: ts.CallExpression, marker: 'useInterface' | 'useProperty'): void => {
    if (marker === 'useInterface' && node.typeArguments && node.typeArguments.length > 0) {
      const nodeStart = node.getStart(sourceFile);
      const typeArg = node.typeArguments[0];
      const type = checker.getTypeFromTypeNode(typeArg);
      const tokenId = resolver.getTypeId(type);
      const descriptor = resolver.describeType(type);
      edits.push({ start: nodeStart, end: node.getEnd(), text: `"${tokenId}"` });
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
            file: sourceFile.fileName,
            line: line.line + 1,
            column: line.character + 1,
            interfaceName: type.getSymbol()?.getName() ?? tokenId,
            descriptor,
          });
        }
      }
      return;
    }
    if (marker === 'useProperty') {
      const classArg = node.arguments[0];
      const nameArg = node.arguments[1];
      if (!classArg || !ts.isIdentifier(classArg) || !nameArg || !ts.isStringLiteral(nameArg)) {
        throw new Error(formatUnsupportedMarker(node));
      }
      const classType = checker.getTypeAtLocation(classArg);
      const tokenId = resolver.getPropertyTokenId(classType, nameArg.text);
      edits.push({
        start: node.getStart(sourceFile),
        end: node.getEnd(),
        text: JSON.stringify(tokenId),
      });
    }
  };

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const marker = resolveNeoMarker(checker, node);
      if (marker && typeof marker === 'object') {
        throw new Error(formatUnsupportedMarker(node));
      }
      if (marker === 'useInterface' || marker === 'useProperty') {
        record(node, marker);
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return edits;
}
