import * as crypto from 'node:crypto';
import * as path from 'node:path';
import type * as ts from 'typescript';

/**
 * Utilities for generating deterministic hashes used in token ID generation.
 *
 * These utilities ensure consistency across different environments (CI vs Local)
 * and platforms (Windows vs Unix) by normalizing paths and using stable hash functions.
 *
 * @example
 * ```typescript
 * // Generate token ID for a symbol
 * const tokenId = HashUtils.generateTokenId(symbol, sourceFile);
 * // Returns: "ILogger_a1b2c3d4"
 *
 * // Generate container ID
 * const containerId = HashUtils.generateContainerId('myFile', 100, configText);
 * // Returns: "Container_x9y8z7w6"
 * ```
 */
export class HashUtils {
  /**
   * Generates an MD5 hash (8 characters) from a file path.
   *
   * Ensures cross-platform consistency by:
   * 1. Converting to relative path (CI vs Local)
   * 2. Normalizing separators to POSIX style (Windows vs Unix)
   * 3. Using MD5 for deterministic output
   *
   * @param filePath - Absolute file path to hash
   * @returns 8-character hex hash
   *
   * @example
   * ```typescript
   * HashUtils.hashFilePath('/Users/me/project/src/Logger.ts');
   * // Returns: "a1b2c3d4"
   *
   * // Same hash on CI:
   * HashUtils.hashFilePath('/home/runner/project/src/Logger.ts');
   * // Returns: "a1b2c3d4" (relative path is same: "src/Logger.ts")
   * ```
   */
  static hashFilePath(filePath: string): string {
    // Get relative path to ensure consistency across environments
    let relativePath = path.relative(process.cwd(), filePath);

    // Normalize to POSIX style (forward slashes) for Windows compatibility
    relativePath = relativePath.split(path.sep).join('/');

    // Create deterministic MD5 hash
    return crypto
      .createHash('md5')
      .update(relativePath)
      .digest('hex')
      .substring(0, 8);
  }

  /**
   * Generates a simple numeric hash from a string.
   *
   * Uses a basic hash function (similar to Java's String.hashCode())
   * for lightweight hashing when cryptographic strength is not needed.
   *
   * @param str - String to hash
   * @returns 8-character hex hash (padded with zeros if needed)
   *
   * @example
   * ```typescript
   * HashUtils.hashString('myContainerConfig');
   * // Returns: "0f4e5d6c" (always 8 characters)
   * ```
   */
  static hashString(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    // Convert to hex and pad to 8 characters
    return Math.abs(hash).toString(16).padStart(8, '0').substring(0, 8);
  }

  /**
   * Generates a unique token ID for a TypeScript symbol.
   *
   * Format: `{symbolName}_{fileHash}`
   *
   * The file hash ensures that symbols with the same name in different files
   * get unique IDs, avoiding collisions.
   *
   * @param symbol - TypeScript symbol to generate ID for
   * @param sourceFile - Source file containing the symbol
   * @returns Unique token ID
   *
   * @example
   * ```typescript
   * // File: src/services/Logger.ts
   * interface ILogger { }
   * const tokenId = HashUtils.generateTokenId(loggerSymbol, sourceFile);
   * // Returns: "ILogger_a1b2c3d4"
   *
   * // File: src/shared/Logger.ts
   * interface ILogger { }
   * const tokenId = HashUtils.generateTokenId(loggerSymbol, sourceFile);
   * // Returns: "ILogger_x9y8z7w6" (different file = different hash)
   * ```
   */
  static generateTokenId(symbol: ts.Symbol, sourceFile: ts.SourceFile): string {
    const name = symbol.getName();
    const hash = this.hashFilePath(sourceFile.fileName);
    return `${name}_${hash}`;
  }

  /**
   * Generates a unique container ID for a configuration.
   *
   * Used when no explicit 'name' field is provided in defineBuilderConfig.
   * Combines file name, position, and config text for uniqueness.
   *
   * @param fileName - Base name of the file (without extension)
   * @param position - AST node position in the file
   * @param configText - Text content of the configuration
   * @returns Container ID in format "Container_{hash}"
   *
   * @example
   * ```typescript
   * const id = HashUtils.generateContainerId('container', 1234, '{ injections: [...] }');
   * // Returns: "Container_a1b2c3d4"
   * ```
   */
  static generateContainerId(fileName: string, position: number, configText: string): string {
    const hashInput = `${fileName}:${position}:${configText}`;
    const hash = this.hashString(hashInput);
    return `Container_${hash}`;
  }
}
