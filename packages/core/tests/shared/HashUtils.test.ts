import { describe, it, expect } from 'vitest';
import { HashUtils } from '../../src/analyzer/shared/HashUtils';
import * as ts from 'typescript';

/**
 * Helper to create a TypeScript program from source code
 */
function createProgramFromSource(sourceCode: string, fileName = 'test.ts'): { program: ts.Program; sourceFile: ts.SourceFile; checker: ts.TypeChecker } {
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

describe('HashUtils', () => {
  describe('hashFilePath', () => {
    it('should generate consistent hash for same file', () => {
      const hash1 = HashUtils.hashFilePath(__filename);
      const hash2 = HashUtils.hashFilePath(__filename);
      expect(hash1).toBe(hash2);
    });

    it('should generate 8-character hex hash', () => {
      const hash = HashUtils.hashFilePath(__filename);
      expect(hash).toMatch(/^[0-9a-f]{8}$/);
    });

    it('should generate different hashes for different files', () => {
      const hash1 = HashUtils.hashFilePath('/path/to/file1.ts');
      const hash2 = HashUtils.hashFilePath('/path/to/file2.ts');
      expect(hash1).not.toBe(hash2);
    });

    it('should handle Windows paths correctly', () => {
      // The function should normalize paths regardless of platform
      const hash = HashUtils.hashFilePath('C:\\Users\\test\\file.ts');
      expect(hash).toMatch(/^[0-9a-f]{8}$/);
    });
  });

  describe('hashString', () => {
    it('should generate consistent hash for same string', () => {
      const hash1 = HashUtils.hashString('test');
      const hash2 = HashUtils.hashString('test');
      expect(hash1).toBe(hash2);
    });

    it('should generate 8-character hex hash', () => {
      const hash = HashUtils.hashString('test');
      expect(hash).toMatch(/^[0-9a-f]{8}$/);
    });

    it('should generate different hashes for different strings', () => {
      const hash1 = HashUtils.hashString('test1');
      const hash2 = HashUtils.hashString('test2');
      expect(hash1).not.toBe(hash2);
    });

    it('should handle empty string', () => {
      const hash = HashUtils.hashString('');
      expect(hash).toBe('00000000');
    });

    it('should handle long strings', () => {
      const longString = 'a'.repeat(10000);
      const hash = HashUtils.hashString(longString);
      expect(hash).toMatch(/^[0-9a-f]{8}$/);
    });
  });

  describe('generateTokenId', () => {
    it('should generate token ID with symbol name and file hash', () => {
      const sourceCode = `interface ILogger { }`;
      const { sourceFile, checker } = createProgramFromSource(sourceCode);

      // Find the interface symbol
      let interfaceSymbol: ts.Symbol | undefined;
      ts.forEachChild(sourceFile, (node) => {
        if (ts.isInterfaceDeclaration(node) && node.name) {
          interfaceSymbol = checker.getSymbolAtLocation(node.name);
        }
      });

      if (interfaceSymbol) {
        const tokenId = HashUtils.generateTokenId(interfaceSymbol, sourceFile);
        expect(tokenId).toMatch(/^ILogger_[0-9a-f]{8}$/);
      } else {
        throw new Error('Interface symbol not found');
      }
    });

    it('should generate different IDs for same symbol in different files', () => {
      const sourceCode = `interface ILogger { }`;

      const { sourceFile: sourceFile1, checker } = createProgramFromSource(sourceCode, 'file1.ts');
      const { sourceFile: sourceFile2 } = createProgramFromSource(sourceCode, 'file2.ts');

      let symbol1: ts.Symbol | undefined;
      let symbol2: ts.Symbol | undefined;

      ts.forEachChild(sourceFile1, (node) => {
        if (ts.isInterfaceDeclaration(node) && node.name) {
          symbol1 = checker.getSymbolAtLocation(node.name);
        }
      });

      ts.forEachChild(sourceFile2, (node) => {
        if (ts.isInterfaceDeclaration(node) && node.name) {
          symbol2 = checker.getSymbolAtLocation(node.name);
        }
      });

      if (symbol1 && symbol2) {
        const tokenId1 = HashUtils.generateTokenId(symbol1, sourceFile1);
        const tokenId2 = HashUtils.generateTokenId(symbol2, sourceFile2);

        expect(tokenId1).toMatch(/^ILogger_[0-9a-f]{8}$/);
        expect(tokenId2).toMatch(/^ILogger_[0-9a-f]{8}$/);
        expect(tokenId1).not.toBe(tokenId2); // Different files = different hashes
      }
    });
  });

  describe('generateContainerId', () => {
    it('should generate container ID with hash', () => {
      const containerId = HashUtils.generateContainerId('myFile', 100, '{ injections: [] }');
      expect(containerId).toMatch(/^Container_[0-9a-f]{8}$/);
    });

    it('should generate consistent ID for same inputs', () => {
      const id1 = HashUtils.generateContainerId('myFile', 100, '{ injections: [] }');
      const id2 = HashUtils.generateContainerId('myFile', 100, '{ injections: [] }');
      expect(id1).toBe(id2);
    });

    it('should generate different IDs for different positions', () => {
      const id1 = HashUtils.generateContainerId('myFile', 100, '{ injections: [] }');
      const id2 = HashUtils.generateContainerId('myFile', 200, '{ injections: [] }');
      expect(id1).not.toBe(id2);
    });

    it('should generate different IDs for different config text', () => {
      const id1 = HashUtils.generateContainerId('myFile', 100, '{ injections: [a] }');
      const id2 = HashUtils.generateContainerId('myFile', 100, '{ injections: [b] }');
      expect(id1).not.toBe(id2);
    });
  });
});
