import type * as ts from 'typescript';
import { TSContext } from '../TSContext';
import type { DependencyNode, ServiceDefinition, TypeReference } from '../analyzer/types';

/**
 * What a generated getter answers for one registration, as type text the generated file can write.
 * An absent field is `unknown`: the getter then hands out what it holds and the reader narrows once,
 * at the constructor argument it fills (FactoryEmitter, `constructorArguments`).
 */
export interface ProviderTypes {
  /**
   * Return type of `create_X`. A class provider builds its instance type, a hoisted useValue is its own
   * constant, annotated with the declared type. A factory answers `unknown`: the creator hands out what the user's factory returned, a
   * promise for an async one, and that text is the user's.
   */
  creator?: string;
  /**
   * Return type of `_direct_X` and `_get_X`: the type of the provider, or, for a factory, the type the
   * registration is declared under (the class token, or the type `useInterface<T>()` names).
   */
  accessor?: string;
}

export type GetProviderTypes = (node: DependencyNode) => ProviderTypes;

/** Hand-built callers: every getter is `unknown`. */
export const noProviderTypes: GetProviderTypes = () => ({});

/** Names a type the output can refer to, or `undefined` when no import or name reaches it. */
export type NameType = (reference: TypeReference) => string | undefined;

type GetImport = (symbol: ts.Symbol) => string;

/**
 * A generic class has no single instance type to name: `InstanceType<typeof Box>` is `Box<unknown>`, which a
 * parameter typed `Box<string>` refuses. Its getters answer `unknown` and the constructor argument is narrowed.
 */
function isGenericClass(symbol: ts.Symbol): boolean {
  return (symbol.declarations ?? []).some((declaration) =>
    TSContext.ts.isClassDeclaration(declaration) && (declaration.typeParameters?.length ?? 0) > 0);
}

/** A provider is built with `new`, so its constructor is public: `InstanceType` accepts it. */
function instanceOf(symbol: ts.Symbol, getImport: GetImport): string | undefined {
  if (isGenericClass(symbol)) return undefined;
  // `InstanceType<typeof C>` and not `C`: `typeof C` is the value the generated code constructs, so the type
  // follows the same name (a renamed import, a namespace member).
  return `InstanceType<typeof ${getImport(symbol)}>`;
}

/**
 * Whether the token is bound to a class declaration (the symbol is already followed through import aliases).
 * A local `const Alias = Clock`, a `let` or a property is a value: its name is not a type.
 */
function isClassBinding(symbol: ts.Symbol): boolean {
  return (symbol.flags & TSContext.ts.SymbolFlags.Class) !== 0;
}

/**
 * The instance type of a class token, by the name the generated code reads the class with. A token is not
 * built by the output (a factory or a value stands behind it), so its constructor may be private, protected
 * or abstract: `InstanceType<typeof C>` would be a TS2344 there, the class name as a type is not. A token that
 * is not bound to a class (a value alias of one) has no type name: `undefined`, the getter answers `unknown`.
 */
function tokenInstance(symbol: ts.Symbol, getImport: GetImport): string | undefined {
  if (!isClassBinding(symbol) || isGenericClass(symbol)) return undefined;
  return getImport(symbol);
}

/** The type a factory or a value registration is declared under, when the output can name it. */
function declaredType(service: ServiceDefinition, getImport: GetImport, nameType: NameType): string | undefined {
  if (service.tokenSymbol) return tokenInstance(service.tokenSymbol, getImport);
  if (service.tokenType) return nameType(service.tokenType);
  return undefined;
}

/**
 * The getter types of one registration.
 * Class provider: its instance type. Factory and useValue: the type the registration is declared under
 * (the class token, or the interface of `useInterface<T>()` through an `import type` where it lives in another
 * file). A hoisted useValue constant is annotated with that same type.
 */
export function providerTypesOf(service: ServiceDefinition, getImport: GetImport, nameType: NameType): ProviderTypes {
  if (service.type === 'explicit' || service.type === 'autowire') {
    if (!service.implementationSymbol) return {};
    const type = instanceOf(service.implementationSymbol, getImport);
    return type === undefined ? {} : { creator: type, accessor: type };
  }
  if (service.type === 'value') {
    const declared = declaredType(service, getImport, nameType);
    if (declared === undefined) return {};
    // A hoisted constant carries the declared type (Generator `captureHoists`), so it is that type whatever
    // its literals say; a value the output only reads from a partial is typed by the declaration alone.
    const hoisted = service.valueCapture !== undefined && service.valueCaptureRead !== true && service.valueSource !== undefined;
    return hoisted ? { creator: declared, accessor: declared } : { accessor: declared };
  }
  if (service.type === 'factory') {
    const declared = declaredType(service, getImport, nameType);
    return declared === undefined ? {} : { accessor: declared };
  }
  return {};
}
