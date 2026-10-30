import * as ts from 'typescript';
import { formatUnsupportedMarker, HashUtils, resolveNeoMarker } from '@djodjonx/neosyringe-core/analyzer';
import { hasNeoSyringeMarkers } from './markerUtils';

export type UsedTokenEntry = { file: string; line: number; column: number; interfaceName: string };

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
 */
export function transformUseInterfaceCalls(
  code: string,
  id: string,
  compilerOptions: ts.CompilerOptions,
  usedTokens?: Map<string, UsedTokenEntry>
): string | null {
  if (!needsTokenRewrite(code)) return null;

  const sourceFile = ts.createSourceFile(id, code, ts.ScriptTarget.Latest, true);

  const compilerHost = ts.createCompilerHost(compilerOptions);
  const originalGetSourceFile = compilerHost.getSourceFile;
  compilerHost.getSourceFile = (fileName, languageVersion) => {
    if (fileName === id) {
      return sourceFile;
    }
    return originalGetSourceFile(fileName, languageVersion);
  };

  const program = ts.createProgram([id], compilerOptions, compilerHost);
  const checker = program.getTypeChecker();
  if (typeof checker.getSymbolAtLocation !== 'function') return null;

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
        const symbol = type.getSymbol();

        if (symbol) {
          const declarations = symbol.getDeclarations();
          let tokenId: string;

          if (declarations && declarations.length > 0) {
            const declSourceFile = declarations[0].getSourceFile();
            tokenId = HashUtils.generateTokenId(symbol, declSourceFile);
          } else {
            tokenId = symbol.getName();
          }

          replacements.push({
            start: nodeStart,
            end: nodeEnd,
            text: `"${tokenId}"`,
          });

          if (usedTokens && !usedTokens.has(tokenId)) {
            const line = sourceFile.getLineAndCharacterOfPosition(nodeStart);
            usedTokens.set(tokenId, {
              file: id,
              line: line.line + 1,
              column: line.character + 1,
              interfaceName: symbol.getName(),
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
        const tokenId = `PropertyToken:${classArg.text}.${nameArg.text}`;
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
