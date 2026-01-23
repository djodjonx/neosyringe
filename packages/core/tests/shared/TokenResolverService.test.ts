import { describe, it, expect } from 'vitest';
import { TokenResolverService } from '../../src/analyzer/shared/TokenResolverService';
import * as ts from 'typescript';

describe('TokenResolverService', () => {

  /**
   * Helper to create a TypeScript program and checker from source code
   */
  function createProgramFromSource(sourceCode: string, fileName = 'test.ts') {
    const compilerHost = ts.createCompilerHost({});
    const originalGetSourceFile = compilerHost.getSourceFile;

    compilerHost.getSourceFile = (name, languageVersion) => {
      if (name === fileName) {
        return ts.createSourceFile(name, sourceCode, languageVersion, true);
      }
      return originalGetSourceFile.call(compilerHost, name, languageVersion);
    };

    const program = ts.createProgram([fileName], {}, compilerHost);
    const sourceFile = program.getSourceFile(fileName)!;
    const checker = program.getTypeChecker();

    return { program, sourceFile, checker };
  }

  /**
   * Helper to find a node by predicate
   */
  function findNode<T extends ts.Node>(
    sourceFile: ts.SourceFile,
    predicate: (node: ts.Node) => node is T
  ): T | undefined {
    let result: T | undefined;

    function visit(node: ts.Node) {
      if (result) return;
      if (predicate(node)) {
        result = node;
        return;
      }
      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
    return result;
  }

  describe('isUseInterfaceCall', () => {
    it('should identify useInterface call', () => {
      const sourceCode = `const token = useInterface<ILogger>();`;
      const { sourceFile, checker: testChecker } = createProgramFromSource(sourceCode);
      const testService = new TokenResolverService(testChecker);

      const callExpr = findNode(sourceFile, ts.isCallExpression);
      expect(testService.isUseInterfaceCall(callExpr)).toBe(true);
    });

    it('should return false for non-useInterface calls', () => {
      const sourceCode = `const token = someOtherCall<ILogger>();`;
      const { sourceFile, checker: testChecker } = createProgramFromSource(sourceCode);
      const testService = new TokenResolverService(testChecker);

      const callExpr = findNode(sourceFile, ts.isCallExpression);
      expect(testService.isUseInterfaceCall(callExpr)).toBe(false);
    });

    it('should return false for undefined', () => {
      const { checker: testChecker } = createProgramFromSource('');
      const testService = new TokenResolverService(testChecker);
      expect(testService.isUseInterfaceCall(undefined)).toBe(false);
    });
  });

  describe('isUsePropertyCall', () => {
    it('should identify useProperty call', () => {
      const sourceCode = `const token = useProperty<string>(MyClass, 'prop');`;
      const { sourceFile, checker: testChecker } = createProgramFromSource(sourceCode);
      const testService = new TokenResolverService(testChecker);

      const callExpr = findNode(sourceFile, ts.isCallExpression);
      expect(testService.isUsePropertyCall(callExpr)).toBe(true);
    });

    it('should return false for non-useProperty calls', () => {
      const sourceCode = `const token = useInterface<ILogger>();`;
      const { sourceFile, checker: testChecker } = createProgramFromSource(sourceCode);
      const testService = new TokenResolverService(testChecker);

      const callExpr = findNode(sourceFile, ts.isCallExpression);
      expect(testService.isUsePropertyCall(callExpr)).toBe(false);
    });
  });

  describe('extractInterfaceTokenId', () => {
    it('should extract token ID from useInterface call', () => {
      const sourceCode = `
        interface ILogger { }
        const token = useInterface<ILogger>();
      `;
      const { sourceFile, checker: testChecker } = createProgramFromSource(sourceCode);
      const testService = new TokenResolverService(testChecker);

      const callExpr = findNode(sourceFile, ts.isCallExpression);
      if (callExpr) {
        const tokenId = testService.extractInterfaceTokenId(callExpr);
        expect(tokenId).toMatch(/^ILogger_[0-9a-f]{8}$/);
      } else {
        throw new Error('Call expression not found');
      }
    });

    it('should throw error if type argument is missing', () => {
      const sourceCode = `const token = useInterface();`;
      const { sourceFile, checker: testChecker } = createProgramFromSource(sourceCode);
      const testService = new TokenResolverService(testChecker);

      const callExpr = findNode(sourceFile, ts.isCallExpression);
      if (callExpr) {
        expect(() => testService.extractInterfaceTokenId(callExpr)).toThrow(
          'useInterface must have a type argument'
        );
      }
    });
  });

  describe('extractPropertyTokenId', () => {
    it('should extract token ID from useProperty call', () => {
      const sourceCode = `const token = useProperty<string>(DatabaseService, 'connectionString');`;
      const { sourceFile, checker: testChecker } = createProgramFromSource(sourceCode);
      const testService = new TokenResolverService(testChecker);

      const callExpr = findNode(sourceFile, ts.isCallExpression);
      if (callExpr) {
        const tokenId = testService.extractPropertyTokenId(callExpr);
        expect(tokenId).toBe("PropertyToken:DatabaseService.connectionString");
      }
    });

    it('should throw error if arguments are missing', () => {
      const sourceCode = `const token = useProperty<string>();`;
      const { sourceFile, checker: testChecker } = createProgramFromSource(sourceCode);
      const testService = new TokenResolverService(testChecker);

      const callExpr = findNode(sourceFile, ts.isCallExpression);
      if (callExpr) {
        expect(() => testService.extractPropertyTokenId(callExpr)).toThrow(
          'useProperty requires two arguments'
        );
      }
    });

    it('should throw error if first argument is not identifier', () => {
      const sourceCode = `const token = useProperty<string>("notIdentifier", 'prop');`;
      const { sourceFile, checker: testChecker } = createProgramFromSource(sourceCode);
      const testService = new TokenResolverService(testChecker);

      const callExpr = findNode(sourceFile, ts.isCallExpression);
      if (callExpr) {
        expect(() => testService.extractPropertyTokenId(callExpr)).toThrow(
          'useProperty first argument must be a class identifier'
        );
      }
    });
  });

  describe('resolveToInitializer', () => {
    it('should return call expression as-is', () => {
      const sourceCode = `const token = useInterface<ILogger>();`;
      const { sourceFile, checker: testChecker } = createProgramFromSource(sourceCode);
      const testService = new TokenResolverService(testChecker);

      const callExpr = findNode(sourceFile, ts.isCallExpression);
      if (callExpr) {
        const resolved = testService.resolveToInitializer(callExpr);
        expect(resolved).toBe(callExpr);
      }
    });

    it('should resolve identifier to its initializer', () => {
      const sourceCode = `
        const myToken = useInterface<ILogger>();
        const token = myToken;
      `;
      const { sourceFile, checker: testChecker } = createProgramFromSource(sourceCode);
      const testService = new TokenResolverService(testChecker);

      // Find the second identifier (myToken in assignment)
      let secondIdentifier: ts.Identifier | undefined;
      let count = 0;
      ts.forEachChild(sourceFile, (node) => {
        if (ts.isVariableStatement(node)) {
          ts.forEachChild(node.declarationList, (decl) => {
            if (ts.isVariableDeclaration(decl)) {
              count++;
              if (count === 2 && ts.isIdentifier(decl.initializer!)) {
                secondIdentifier = decl.initializer as ts.Identifier;
              }
            }
          });
        }
      });

      if (secondIdentifier) {
        const resolved = testService.resolveToInitializer(secondIdentifier);
        expect(resolved).toBeDefined();
        expect(ts.isCallExpression(resolved!)).toBe(true);
      }
    });

    it('should unwrap type assertions', () => {
      const sourceCode = `const token = useInterface<ILogger>() as any;`;
      const { sourceFile, checker: testChecker } = createProgramFromSource(sourceCode);
      const testService = new TokenResolverService(testChecker);

      const asExpr = findNode(sourceFile, ts.isAsExpression);
      if (asExpr) {
        const resolved = testService.resolveToInitializer(asExpr);
        expect(resolved).toBeDefined();
        expect(ts.isCallExpression(resolved!)).toBe(true);
      }
    });

    it('should unwrap parenthesized expressions', () => {
      const sourceCode = `const token = (useInterface<ILogger>());`;
      const { sourceFile, checker: testChecker } = createProgramFromSource(sourceCode);
      const testService = new TokenResolverService(testChecker);

      const parenExpr = findNode(sourceFile, ts.isParenthesizedExpression);
      if (parenExpr) {
        const resolved = testService.resolveToInitializer(parenExpr);
        expect(resolved).toBeDefined();
        expect(ts.isCallExpression(resolved!)).toBe(true);
      }
    });
  });

  describe('getTypeId', () => {
    it('should generate type ID for named type', () => {
      const sourceCode = `
        interface ILogger { }
        const x: ILogger = null as any;
      `;
      const { sourceFile, checker: testChecker } = createProgramFromSource(sourceCode);
      const testService = new TokenResolverService(testChecker);

      // Find the type annotation
      const varDecl = findNode(sourceFile, ts.isVariableDeclaration);
      if (varDecl && varDecl.type) {
        const type = testChecker.getTypeFromTypeNode(varDecl.type);
        const typeId = testService.getTypeId(type);
        expect(typeId).toMatch(/^ILogger_[0-9a-f]{8}$/);
      }
    });

    it('should return type string for anonymous types', () => {
      const sourceCode = `const x: { log: () => void } = null as any;`;
      const { sourceFile, checker: testChecker } = createProgramFromSource(sourceCode);
      const testService = new TokenResolverService(testChecker);

      const varDecl = findNode(sourceFile, ts.isVariableDeclaration);
      if (varDecl && varDecl.type) {
        const type = testChecker.getTypeFromTypeNode(varDecl.type);
        const typeId = testService.getTypeId(type);
        expect(typeId).toContain('log');
      }
    });

    it('should handle internal property names', () => {
      const sourceCode = `type BrandedType = { __type: string, __brand: 'test' };`;
      const { sourceFile, checker: testChecker } = createProgramFromSource(sourceCode);
      const testService = new TokenResolverService(testChecker);

      const typeAlias = findNode(sourceFile, ts.isTypeAliasDeclaration);
      if (typeAlias) {
        const type = testChecker.getTypeAtLocation(typeAlias);
        const typeId = testService.getTypeId(type);
        // Should not return __type or __brand
        expect(typeId).not.toBe('__type');
        expect(typeId).not.toBe('__brand');
      }
    });
  });

  describe('resolveTokenId', () => {
    it('should resolve useInterface call', () => {
      const sourceCode = `
        interface ILogger { }
        const token = useInterface<ILogger>();
      `;
      const { sourceFile, checker: testChecker } = createProgramFromSource(sourceCode);
      const testService = new TokenResolverService(testChecker);

      const callExpr = findNode(sourceFile, ts.isCallExpression);
      if (callExpr) {
        const tokenId = testService.resolveTokenId(callExpr);
        expect(tokenId).toMatch(/^ILogger_[0-9a-f]{8}$/);
      }
    });

    it('should resolve useProperty call', () => {
      const sourceCode = `const token = useProperty<string>(MyClass, 'prop');`;
      const { sourceFile, checker: testChecker } = createProgramFromSource(sourceCode);
      const testService = new TokenResolverService(testChecker);

      const callExpr = findNode(sourceFile, ts.isCallExpression);
      if (callExpr) {
        const tokenId = testService.resolveTokenId(callExpr);
        expect(tokenId).toBe("PropertyToken:MyClass.prop");
      }
    });

    it('should resolve class reference', () => {
      const sourceCode = `
        class MyService { }
        const token = MyService;
      `;
      const { sourceFile, checker: testChecker } = createProgramFromSource(sourceCode);
      const testService = new TokenResolverService(testChecker);

      // Find the identifier in the second statement
      let identifier: ts.Identifier | undefined;
      ts.forEachChild(sourceFile, (node) => {
        if (ts.isVariableStatement(node)) {
          ts.forEachChild(node.declarationList, (decl) => {
            if (ts.isVariableDeclaration(decl) && ts.isIdentifier(decl.initializer!)) {
              identifier = decl.initializer as ts.Identifier;
            }
          });
        }
      });

      if (identifier) {
        const tokenId = testService.resolveTokenId(identifier);
        expect(tokenId).toMatch(/^MyService_[0-9a-f]{8}$/);
      }
    });
  });
});
