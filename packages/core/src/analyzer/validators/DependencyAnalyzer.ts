import type * as ts from 'typescript';
import { TSContext } from '../../TSContext';
import type {
  ConstructorDiagnostic,
  ConstructorSignature,
  DependencyEdge,
  TokenId,
  ServiceDefinition,
} from '../types';
import { resolveConstructorSignature } from '../shared/registrationGraph';
import { TokenResolverService } from '../shared/TokenResolverService';

/**
 * Analyzes class constructors and factory functions to extract required dependencies.
 */
export class DependencyAnalyzer {
  constructor(
    private readonly checker: ts.TypeChecker,
    private readonly tokenResolverService: TokenResolverService
  ) {}

  /**
   * Extracts all dependencies required by a service definition.
   * @param definition - Service definition to analyze
   * @param knownTokenIds - Optional set of registered token IDs. When provided,
   *   constructor params whose PropertyToken (PropertyToken:ClassName.paramName)
   *   is present in this set are resolved to that property token ID instead of
   *   the bare TypeScript type. This prevents false-positive "missing dependency"
   *   errors for primitive params covered by useProperty registrations.
   */
  getRequiredDependencies(
    definition: ServiceDefinition,
    knownTokenIds?: Set<TokenId>
  ): TokenId[] {
    // Factories handle their own dependencies via container.resolve()
    if (definition.type === 'factory') {
      return [];
    }

    // No implementation symbol means no dependencies to analyze
    if (!definition.implementationSymbol) {
      return [];
    }

    return this.readSignature(definition, knownTokenIds).edges.map((edge) => edge.tokenId);
  }

  /** Constructor edges, including inherited parameters and kept positions. */
  edgesFor(definition: ServiceDefinition, knownTokenIds?: Set<TokenId>): DependencyEdge[] {
    return this.readSignature(definition, knownTokenIds).edges;
  }

  /**
   * Returns the subset of a service's required dependencies that are optional —
   * the constructor parameter is marked `?`, typed `T | undefined`, or has an
   * initializer. These are exempt from "missing dependency" diagnostics.
   */
  getOptionalDependencyIds(definition: ServiceDefinition, knownTokenIds?: Set<TokenId>): Set<TokenId> {
    const optional = new Set<TokenId>();
    for (const edge of this.readSignature(definition, knownTokenIds).edges) {
      if (edge.optional) optional.add(edge.tokenId);
    }
    return optional;
  }

  /** Constructor shapes this registration cannot treat as zero dependencies. */
  constructorDiagnostics(definition: ServiceDefinition, knownTokenIds?: Set<TokenId>): ConstructorDiagnostic[] {
    return this.readSignature(definition, knownTokenIds).diagnostics;
  }

  private readSignature(
    definition: ServiceDefinition,
    knownTokenIds?: Set<TokenId>,
  ): ConstructorSignature {
    if (definition.type === 'factory' || definition.type === 'value' || !definition.implementationSymbol) {
      return { edges: [], diagnostics: [] };
    }
    const declarations = definition.implementationSymbol.getDeclarations();
    const classDecl = declarations?.find((declaration) =>
      TSContext.ts.isClassDeclaration(declaration),
    ) as ts.ClassDeclaration | undefined;
    if (!classDecl) return { edges: [], diagnostics: [] };
    return resolveConstructorSignature(this.checker, this.tokenResolverService, classDecl, knownTokenIds);
  }
}
