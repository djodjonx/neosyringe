import type * as ts from 'typescript';
import { TSContext } from '../../TSContext';
import type {
  ConstructorDiagnostic,
  ConstructorSignature,
  DependencyEdge,
  ServiceDefinition,
  TokenId,
} from '../types';
import { NeoTokenError } from '../errors/NeoTokenError';
import { HashUtils } from './HashUtils';
import { declarationOrigin } from './tokenDescriptor';
import type { TokenResolverService } from './TokenResolverService';

interface ParameterSlot {
  name: string;
  declaration: ts.ParameterDeclaration | undefined;
  type: ts.Type | undefined;
  index: number;
}

/** `${project-relative POSIX path}:${node start}`. Stable across two runs of one program. */
export function registrationIdFor(file: ts.SourceFile, node: ts.Node): string {
  return `${declarationOrigin(file.fileName)}:${node.getStart()}`;
}

/**
 * Hash of the project-relative POSIX path, the call position and the config text.
 * The container name is not an input. The result is not an absolute path.
 */
export function containerKeyFor(node: ts.Node): string {
  const sourceFile = node.getSourceFile();
  return HashUtils.generateContainerId(
    declarationOrigin(sourceFile.fileName),
    node.getStart(),
    node.getText(),
  );
}

/** Owns the registration in `containerKey`. A value records that key as its capture. */
export function stampRegistration(
  definition: ServiceDefinition,
  node: ts.Node,
  containerKey: string | undefined,
): void {
  definition.registrationId = registrationIdFor(node.getSourceFile(), node);
  definition.ownership = 'owned';
  if (definition.type === 'value') {
    definition.capturedInContainerId = containerKey;
  }
}

/**
 * Effective construct signature for `classDecl`.
 * A class with no constructor of its own inherits the base signature, with
 * generic arguments already substituted by the TypeChecker. An own constructor
 * contributes only its own parameters.
 */
export function resolveConstructorSignature(
  checker: ts.TypeChecker,
  tokens: TokenResolverService,
  classDecl: ts.ClassDeclaration,
  knownTokenIds?: Set<TokenId>,
): ConstructorSignature {
  const className = classDecl.name?.text ?? 'Anonymous';
  const instanceType = classDecl.name ? checker.getTypeAtLocation(classDecl.name) : undefined;
  const ownCtor = implementationConstructor(classDecl);
  if (!ownCtor) {
    return inheritedConstructorSignature(checker, tokens, classDecl, knownTokenIds, className, instanceType);
  }
  return signatureFromSlots(
    checker,
    tokens,
    slotsFromConstructor(checker, ownCtor),
    'declared',
    className,
    instanceType,
    knownTokenIds,
  );
}

function implementationConstructor(classDecl: ts.ClassDeclaration): ts.ConstructorDeclaration | undefined {
  const constructors = classDecl.members.filter((member) =>
    TSContext.ts.isConstructorDeclaration(member),
  ) as ts.ConstructorDeclaration[];
  if (constructors.length === 0) return undefined;
  return constructors.find((constructor) => constructor.body !== undefined) ?? constructors[constructors.length - 1];
}

function inheritedConstructorSignature(
  checker: ts.TypeChecker,
  tokens: TokenResolverService,
  classDecl: ts.ClassDeclaration,
  knownTokenIds: Set<TokenId> | undefined,
  className: string,
  instanceType: ts.Type | undefined,
): ConstructorSignature {
  const classSymbol = classDecl.name ? checker.getSymbolAtLocation(classDecl.name) : undefined;
  const staticType = classSymbol ? checker.getTypeOfSymbolAtLocation(classSymbol, classDecl) : undefined;
  const signature = widestSignature(staticType?.getConstructSignatures() ?? []);
  const declaration = signature?.getDeclaration();
  if (signature && declaration && TSContext.ts.isConstructorDeclaration(declaration)) {
    return signatureFromSlots(
      checker,
      tokens,
      slotsFromSignature(checker, signature),
      'inherited',
      className,
      instanceType,
      knownTokenIds,
    );
  }
  if (isUnresolvedMixin(checker, classDecl)) {
    return {
      edges: [],
      diagnostics: [{
        code: 'NEO_CONFIG_UNSUPPORTED',
        message: `Constructor '${className}' extends an unresolved mixin`,
      }],
    };
  }
  return { edges: [], diagnostics: [] };
}

function widestSignature(signatures: readonly ts.Signature[]): ts.Signature | undefined {
  return signatures.reduce<ts.Signature | undefined>((widest, signature) => {
    if (!widest) return signature;
    return signature.getParameters().length >= widest.getParameters().length ? signature : widest;
  }, undefined);
}

function isUnresolvedMixin(checker: ts.TypeChecker, classDecl: ts.ClassDeclaration): boolean {
  const heritage = classDecl.heritageClauses?.find(
    (clause) => clause.token === TSContext.ts.SyntaxKind.ExtendsKeyword,
  )?.types[0];
  if (!heritage) return false;
  const baseType = checker.getTypeFromTypeNode(heritage);
  const flags = TSContext.ts.TypeFlags;
  return (baseType.flags & flags.Any) !== 0 || (baseType.flags & flags.TypeParameter) !== 0;
}

function slotsFromConstructor(checker: ts.TypeChecker, constructor: ts.ConstructorDeclaration): ParameterSlot[] {
  return constructor.parameters.map((parameter, index) => ({
    name: parameterName(parameter.name),
    declaration: parameter,
    type: slotType(checker, parameter),
    index,
  }));
}

/** Annotation first: `flag?: boolean` stays `boolean`, and `{ a }: Logger` still has a type. */
function slotType(checker: ts.TypeChecker, parameter: ts.ParameterDeclaration): ts.Type | undefined {
  if (parameter.type) return checker.getTypeFromTypeNode(parameter.type);
  if (TSContext.ts.isIdentifier(parameter.name)) {
    const named = checker.getSymbolAtLocation(parameter.name);
    if (named) return checker.getTypeOfSymbol(named);
  }
  return checker.getTypeAtLocation(parameter);
}

function slotsFromSignature(checker: ts.TypeChecker, signature: ts.Signature): ParameterSlot[] {
  return signature.getParameters().map((parameterSymbol, index) => {
    const valueDeclaration = parameterSymbol.valueDeclaration;
    const declaration = valueDeclaration && TSContext.ts.isParameter(valueDeclaration)
      ? valueDeclaration
      : undefined;
    return {
      name: parameterSymbol.getName(),
      declaration,
      type: checker.getTypeOfSymbol(parameterSymbol),
      index,
    };
  });
}

function signatureFromSlots(
  checker: ts.TypeChecker,
  tokens: TokenResolverService,
  slots: readonly ParameterSlot[],
  origin: DependencyEdge['origin'],
  className: string,
  instanceType: ts.Type | undefined,
  knownTokenIds: Set<TokenId> | undefined,
): ConstructorSignature {
  const edges: DependencyEdge[] = [];
  const diagnostics: ConstructorDiagnostic[] = [];
  for (const slot of slots) {
    pushSlot(checker, tokens, slot, origin, className, instanceType, knownTokenIds, edges, diagnostics);
  }
  return { edges, diagnostics };
}

function pushSlot(
  checker: ts.TypeChecker,
  tokens: TokenResolverService,
  slot: ParameterSlot,
  origin: DependencyEdge['origin'],
  className: string,
  instanceType: ts.Type | undefined,
  knownTokenIds: Set<TokenId> | undefined,
  edges: DependencyEdge[],
  diagnostics: ConstructorDiagnostic[],
): void {
  const { name, declaration, type, index } = slot;
  if (declaration?.dotDotDotToken) {
    diagnostics.push({
      code: 'NEO_CONFIG_UNSUPPORTED',
      message: `Constructor '${className}' parameter '${name}' is a rest parameter`,
      paramName: name,
    });
    return;
  }
  const optional = parameterIsOptional(declaration, type);
  if (takePropertyToken(tokens, name, index, optional, origin, instanceType, knownTokenIds, edges)) return;
  if (!declaration?.type && !optional) {
    reportMissingType(diagnostics, className, name);
    return;
  }
  const tokenType = origin === 'inherited' && type ? stripUndefined(checker, type) : type;
  if (!tokenType) {
    pushAbsentOptional(edges, className, index, origin);
    return;
  }
  try {
    const tokenId = tokens.getTypeId(tokenType);
    edges.push({ tokenId, paramIndex: index, optional, multi: false, origin });
  } catch (error) {
    if (!(error instanceof NeoTokenError) || error.code !== 'NEO_TOKEN_UNSUPPORTED' || !optional) throw error;
    pushAbsentOptional(edges, className, index, origin);
  }
}

function takePropertyToken(
  tokens: TokenResolverService,
  name: string,
  index: number,
  optional: boolean,
  origin: DependencyEdge['origin'],
  instanceType: ts.Type | undefined,
  knownTokenIds: Set<TokenId> | undefined,
  edges: DependencyEdge[],
): boolean {
  if (!knownTokenIds || !instanceType) return false;
  const propertyTokenId = tokens.getPropertyTokenId(instanceType, name);
  if (!knownTokenIds.has(propertyTokenId)) return false;
  edges.push({ tokenId: propertyTokenId, paramIndex: index, optional, multi: false, origin });
  return true;
}

/** Not a real token. Codegen prints `undefined`, so a default value applies. */
function pushAbsentOptional(
  edges: DependencyEdge[],
  className: string,
  index: number,
  origin: DependencyEdge['origin'],
): void {
  edges.push({
    tokenId: absentTokenId(className, index),
    paramIndex: index,
    optional: true,
    multi: false,
    origin,
  });
}

function absentTokenId(className: string, index: number): TokenId {
  return `AbsentOptional:${className}#${index}`;
}

function reportMissingType(
  diagnostics: ConstructorDiagnostic[],
  className: string,
  name: string,
): void {
  diagnostics.push({
    code: 'NEO_CONFIG_UNSUPPORTED',
    message: `Constructor '${className}' parameter '${name}' has no type annotation`,
    paramName: name,
  });
}

function parameterName(name: ts.BindingName): string {
  return TSContext.ts.isIdentifier(name) ? name.text : name.getText();
}

function parameterIsOptional(
  declaration: ts.ParameterDeclaration | undefined,
  type: ts.Type | undefined,
): boolean {
  if (declaration?.questionToken) return true;
  if (declaration?.initializer) return true;
  if (!type?.isUnion()) return false;
  return type.types.some((part) => (part.flags & TSContext.ts.TypeFlags.Undefined) !== 0);
}

function stripUndefined(checker: ts.TypeChecker, type: ts.Type): ts.Type {
  if (!type.isUnion()) return type;
  const undefinedFlag = TSContext.ts.TypeFlags.Undefined;
  if (!type.types.some((part) => (part.flags & undefinedFlag) !== 0)) return type;
  const kept = type.types.filter((part) => (part.flags & undefinedFlag) === 0);
  if (kept.length === 1) return kept[0];
  const nullFlag = TSContext.ts.TypeFlags.Null;
  if (type.types.some((part) => (part.flags & nullFlag) !== 0)) return type;
  return checker.getNonNullableType(type);
}
