import * as ts from 'typescript';
import { HashUtils } from '@djodjonx/neosyringe-core/analyzer';

export type UsedTokenEntry = { file: string; line: number; column: number; interfaceName: string };

/**
 * Transforms useInterface<T>() calls into their tokenId string values.
 * This runs on ALL TypeScript files, not just container files.
 *
 * @param excludeRange - Optional range to exclude from transformation (used for defineBuilderConfig content)
 * @param usedTokens - Registry to collect used tokens for later validation (only when non-null)
 */
export function transformUseInterfaceCalls(
  code: string,
  id: string,
  compilerOptions: ts.CompilerOptions,
  excludeRange?: { start: number; end: number },
  usedTokens?: Map<string, UsedTokenEntry>
): string | null {
  if (!code.includes('useInterface')) return null;

  // Create a virtual source file from the code string (not from disk)
  const sourceFile = ts.createSourceFile(id, code, ts.ScriptTarget.Latest, true);

  // Create a custom compiler host that returns our in-memory source file
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
  const replacements: { start: number; end: number; text: string }[] = [];

  function visit(node: ts.Node) {
    // Look for useInterface<T>() calls
    if (ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'useInterface' &&
        node.typeArguments &&
        node.typeArguments.length > 0) {

      const nodeStart = node.getStart();
      const nodeEnd = node.getEnd();

      // Skip if inside exclude range
      if (excludeRange && nodeStart >= excludeRange.start && nodeEnd <= excludeRange.end) {
        ts.forEachChild(node, visit);
        return;
      }

      const typeArg = node.typeArguments[0];
      const type = checker.getTypeFromTypeNode(typeArg);
      const symbol = type.getSymbol();

      if (symbol) {
        // Generate tokenId: InterfaceName_hash
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
          text: `"${tokenId}"`
        });

        // Collect used tokens for validation at build end
        if (usedTokens && !usedTokens.has(tokenId)) {
          const line = sourceFile.getLineAndCharacterOfPosition(nodeStart);
          usedTokens.set(tokenId, {
            file: id,
            line: line.line + 1,
            column: line.character + 1,
            interfaceName: symbol.getName()
          });
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  if (replacements.length === 0) return null;

  // Apply replacements in reverse order to preserve positions
  let result = code;
  for (const r of replacements.sort((a, b) => b.start - a.start)) {
    result = result.slice(0, r.start) + r.text + result.slice(r.end);
  }

  return result;
}
