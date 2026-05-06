/**
 * Test: useInterface transformation
 *
 * Verifies that useInterface<T>() calls are transformed to tokenId strings
 * in all files, not just container files.
 */
import { describe, it, expect } from 'vitest';
import * as ts from 'typescript';
import { HashUtils } from '../../core/src/analyzer/shared/HashUtils.js';
import { transformUseInterfaceCalls, type UsedTokenEntry } from '../src/useInterfaceTransform.js';

// Import the transform function (we need to extract it or test the plugin directly)

describe('useInterface Transformation', () => {

  const transformCode = (code: string, fileName = 'test-file.ts'): string => {
    const sourceFile = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true);

    // Create a simple program for type checking
    const compilerHost: ts.CompilerHost = {
      getSourceFile: (name) => name === fileName ? sourceFile : undefined,
      getDefaultLibFileName: () => 'lib.d.ts',
      writeFile: () => {},
      getCurrentDirectory: () => process.cwd(), // Use real CWD to match Analyzer behavior
      getCanonicalFileName: (f) => f,
      useCaseSensitiveFileNames: () => true,
      getNewLine: () => '\n',
      fileExists: () => true,
      readFile: () => undefined,
    };

    const program = ts.createProgram([fileName], {}, compilerHost);
    const checker = program.getTypeChecker();

    const replacements: { start: number; end: number; text: string }[] = [];

    function visit(node: ts.Node) {
      if (ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === 'useInterface' &&
          node.typeArguments &&
          node.typeArguments.length > 0) {

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
            start: node.getStart(),
            end: node.getEnd(),
            text: `"${tokenId}"`
          });
        }
      }

      ts.forEachChild(node, visit);
    }

    visit(sourceFile);

    if (replacements.length === 0) return code;

    let result = code;
    for (const r of replacements.sort((a, b) => b.start - a.start)) {
      result = result.slice(0, r.start) + r.text + result.slice(r.end);
    }

    return result;
  };

  it('should transform useInterface<T>() to tokenId string', () => {
    const input = `
      interface ILogger { log(msg: string): void; }
      function useInterface<T>(): any { return null; }

      export const LoggerToken = useInterface<ILogger>();
    `;

    const output = transformCode(input);
    console.log('Transformed:', output);

    // Should replace useInterface<ILogger>() with a string tokenId
    expect(output).toContain('export const LoggerToken = "');
    expect(output).toContain('ILogger_');
    expect(output).not.toContain('useInterface<ILogger>()');
  });

  it('should transform multiple useInterface calls', () => {
    const input = `
      interface ILogger { log(msg: string): void; }
      interface IEventBus { publish(event: any): void; }
      function useInterface<T>(): any { return null; }

      export const TOKENS = {
        Logger: useInterface<ILogger>(),
        EventBus: useInterface<IEventBus>()
      };
    `;

    const output = transformCode(input);
    console.log('Transformed:', output);

    expect(output).toContain('Logger: "');
    expect(output).toContain('ILogger_');
    expect(output).toContain('EventBus: "');
    expect(output).toContain('IEventBus_');
  });

  it('should transform useInterface in resolve() calls', () => {
    const input = `
      interface IOperationTracker { operationId: string; }
      function useInterface<T>(): any { return null; }

      // This is what users should write
      const tracker = container.resolve(useInterface<IOperationTracker>());
    `;

    const output = transformCode(input);
    console.log('Transformed:', output);

    // The useInterface call inside resolve should be replaced
    expect(output).toContain('container.resolve("');
    expect(output).toContain('IOperationTracker_');
  });

  it('should track useInterface<T>() calls in usedTokens map when provided', () => {
    const input = `
      interface IMyService { getValue(): string; }
      function useInterface<T>(): any { return null; }

      export const service = container.resolve(useInterface<IMyService>());
    `;

    const usedTokens: Map<string, UsedTokenEntry> = new Map();
    const compilerOptions = {
      target: ts.ScriptTarget.ES2021,
      module: ts.ModuleKind.ESNext,
    };

    const output = transformUseInterfaceCalls(input, 'test-service.ts', compilerOptions, usedTokens);

    // Verify transformation happened
    expect(output).toBeDefined();
    expect(output).toContain('container.resolve("');
    expect(output).not.toContain('useInterface<IMyService>()');

    // Verify usedTokens was populated
    expect(usedTokens.size).toBeGreaterThan(0);

    // Find the IMyService token entry
    let foundEntry: UsedTokenEntry | undefined;
    for (const [tokenId, entry] of usedTokens) {
      if (entry.interfaceName === 'IMyService') {
        foundEntry = entry;
        break;
      }
    }

    expect(foundEntry).toBeDefined();
    expect(foundEntry?.file).toBe('test-service.ts');
    expect(foundEntry?.line).toBeGreaterThan(0);
    expect(foundEntry?.column).toBeGreaterThan(0);
  });
});

