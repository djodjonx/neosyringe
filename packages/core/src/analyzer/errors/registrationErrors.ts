import type * as ts from 'typescript';

/**
 * Error thrown when a duplicate registration is detected.
 * Includes the position of the duplicate registration node.
 */
export class DuplicateRegistrationError extends Error {
  public readonly fileName: string;
  public readonly line: number;
  public readonly character: number;
  /** Byte offset of the end of the offending node (for diagnostic span width). */
  public readonly endOffset: number;

  constructor(
    message: string,
    node: ts.Node,
    sourceFile: ts.SourceFile
  ) {
    super(message);
    this.name = 'DuplicateRegistrationError';
    this.fileName = sourceFile.fileName;
    const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    this.line = pos.line;
    this.character = pos.character;
    this.endOffset = node.getEnd();
  }
}

/**
 * Error thrown when a provider type is incompatible with the token type.
 * Includes the position of the registration node.
 */
export class TypeMismatchError extends Error {
  public readonly fileName: string;
  public readonly line: number;
  public readonly character: number;
  /** Byte offset of the end of the offending node (for diagnostic span width). */
  public readonly endOffset: number;

  constructor(
    message: string,
    node: ts.Node,
    sourceFile: ts.SourceFile
  ) {
    super(message);
    this.name = 'TypeMismatchError';
    this.fileName = sourceFile.fileName;
    const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    this.line = pos.line;
    this.character = pos.character;
    this.endOffset = node.getEnd();
  }
}

/**
 * Error thrown when a `defineBuilderConfig(...)` call site has a shape the
 * plugin cannot statically position for replacement — e.g. a bare
 * `return defineBuilderConfig({...})` with no intermediate variable.
 *
 * Without this check, such a call is silently left untransformed: no error,
 * no generated container, just the literal `defineBuilderConfig(...)` call
 * shipped as-is, which throws (or behaves incorrectly) at runtime with no
 * indication the build plugin ever saw it.
 */
export class UnsupportedContainerShapeError extends Error {
  public readonly fileName: string;
  public readonly line: number;
  public readonly character: number;
  /** Byte offset of the end of the offending node (for diagnostic span width). */
  public readonly endOffset: number;

  constructor(
    message: string,
    node: ts.Node,
    sourceFile: ts.SourceFile
  ) {
    super(message);
    this.name = 'UnsupportedContainerShapeError';
    this.fileName = sourceFile.fileName;
    const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    this.line = pos.line;
    this.character = pos.character;
    this.endOffset = node.getEnd();
  }
}

export const UNSUPPORTED_SHAPE_MESSAGE =
  "defineBuilderConfig() must be assigned to a variable — 'const container = defineBuilderConfig({...})' " +
  "(then `return container;` separately if inside a function) — or used as 'export default defineBuilderConfig({...})'. " +
  "A bare 'return defineBuilderConfig({...})' (or any other shape) cannot be located for replacement and would " +
  "silently ship the untransformed call, which is unsafe at runtime.";
