import type * as ts from 'typescript';
import type { AnalysisError, ConfigGraph, TokenId, ValidationMode } from '../types';
import type { IValidator, ValidationContext } from './Validator';
import type { IErrorFormatter } from '../errors/ErrorFormatter';
import { buildContainerTokenView, collectResolutionUsages, type ContainerTokenView } from '../collectors/resolutionUsages';
import { DependencyAnalyzer } from './DependencyAnalyzer';
import { findTokenAssignment } from '../utils/PropertyFinder';
import { getSimpleName } from '../utils/TokenUtils';

/**
 * Validates that all required dependencies are available in the container.
 * - For partialConfig: checks only local injections
 * - For defineBuilder: checks local + parent + extends (recursive)
 */
export class MissingDependencyValidator implements IValidator {
  readonly name = 'MissingDependencyValidator';

  constructor(
    private errorFormatter: IErrorFormatter,
    private dependencyAnalyzer: DependencyAnalyzer,
    private checker: ts.TypeChecker,
    private validation: ValidationMode,
  ) {}

  /**
   * Checks each resolve / resolveAll in this file against that call's container.
   * Constructor checks stay on {@link validate} and still union single and multi.
   */
  validateResolutionUsages(sourceFile: ts.SourceFile, allConfigs: Map<string, ConfigGraph>): AnalysisError[] {
    const errors: AnalysisError[] = [];
    const usages = collectResolutionUsages(sourceFile, this.checker);
    const views = new Map<string, ContainerTokenView>();
    for (const usage of usages) {
      if (!usage.containerKey) {
        errors.push(this.unknownContainer(usage.node, sourceFile));
        continue;
      }
      const view = this.viewFor(allConfigs, usage.containerKey, views);
      if (!view) {
        errors.push(this.unknownContainer(usage.node, sourceFile));
        continue;
      }
      if (!usage.tokenId) continue;
      const allowed = usage.kind === 'resolveAll' ? view.multi : view.single;
      const other = usage.kind === 'resolveAll' ? view.single : view.multi;
      if (view.closedPrivate.has(usage.tokenId) && !allowed.has(usage.tokenId)) {
        errors.push({
          type: 'unsupported',
          code: 'NEO_ROOT_NOT_EXPORTED',
          severity: 'error',
          message: `NEO_ROOT_NOT_EXPORTED: '${getSimpleName(usage.tokenId)}' is not an exported root of this closed container.`,
          node: usage.node,
          sourceFile,
          containerId: usage.containerKey,
        });
        continue;
      }
      if (allowed.has(usage.tokenId)) {
        // The token exists. A closed container still refuses it outside its roots.
        // ADR006 lines 29-31. Factory context is not this path.
        const denied = this.privateRoot(allConfigs.get(usage.containerKey), usage.kind, usage.tokenId, usage.node, sourceFile, usage.containerKey);
        if (denied) errors.push(denied);
        continue;
      }
      if (usage.kind === 'resolve' && other.has(usage.tokenId)) {
        errors.push({
          type: 'unsupported',
          code: 'NEO_MULTI_REQUIRES_RESOLVE_ALL',
          severity: 'error',
          message: `NEO_MULTI_REQUIRES_RESOLVE_ALL: '${getSimpleName(usage.tokenId)}' is multi; use resolveAll`,
          node: usage.node,
          sourceFile,
          containerId: usage.containerKey,
          context: { tokenText: usage.tokenId },
        });
        continue;
      }
      // Open mode: resolveAll of a single or absent token returns [] and is not a miss.
      if (usage.kind === 'resolveAll') continue;
      errors.push({
        type: 'missing',
        code: 'NEO_MISSING_PROVIDER',
        severity: 'error',
        message: `NEO_MISSING_PROVIDER: '${getSimpleName(usage.tokenId)}' is not in container '${usage.containerKey}'`,
        node: usage.node,
        sourceFile,
        containerId: usage.containerKey,
        context: { tokenText: usage.tokenId },
      });
    }
    return errors;
  }

  private viewFor(
    allConfigs: Map<string, ConfigGraph>,
    key: string,
    cache: Map<string, ContainerTokenView>,
  ): ContainerTokenView | undefined {
    const cached = cache.get(key);
    if (cached) return cached;
    const config = allConfigs.get(key);
    if (!config) return undefined;
    const view = buildContainerTokenView(config, allConfigs, this.checker);
    cache.set(key, view);
    return view;
  }

  /** resolve of a retained private token. ADR006 lines 29-31. */
  private privateRoot(
    config: ConfigGraph | undefined,
    kind: 'resolve' | 'resolveAll',
    tokenId: TokenId,
    node: ts.Node,
    sourceFile: ts.SourceFile,
    containerId: string | undefined,
  ): AnalysisError | undefined {
    if (!config || config.optimizationMode !== 'closed') return undefined;
    const roots = kind === 'resolveAll' ? config.publicMultiRoots : config.publicRoots;
    if (roots?.includes(tokenId)) return undefined;
    return {
      type: 'unsupported',
      code: 'NEO_ROOT_NOT_EXPORTED',
      severity: 'error',
      message: `NEO_ROOT_NOT_EXPORTED: '${getSimpleName(tokenId)}' is not an exported root of this closed container.`,
      node,
      sourceFile,
      containerId,
    };
  }

  private unknownContainer(node: ts.Node, sourceFile: ts.SourceFile): AnalysisError {
    return {
      type: 'unsupported',
      code: 'NEO_UNKNOWN_CONTAINER',
      severity: this.validation === 'compatible' ? 'warning' : 'error',
      message: 'NEO_UNKNOWN_CONTAINER: resolve receiver is not a known container',
      node,
      sourceFile,
    };
  }

  validate(config: ConfigGraph, context: ValidationContext): AnalysisError[] {
    const errors: AnalysisError[] = [];

    const availableTokens = this.collectAvailableTokens(config, context);

    const checkInfo = (info: import('../types').InjectionInfo) => {
      for (const diagnostic of this.dependencyAnalyzer.constructorDiagnostics(info.definition, availableTokens)) {
        errors.push({
          type: 'unsupported',
          code: diagnostic.code,
          message: diagnostic.message,
          node: info.node,
          sourceFile: config.sourceFile,
        });
      }
      const requiredDeps = this.dependencyAnalyzer.getRequiredDependencies(
        info.definition,
        availableTokens  // pass so property tokens are matched correctly
      );
      const optionalDeps = this.dependencyAnalyzer.getOptionalDependencyIds(
        info.definition,
        availableTokens,
      );
      for (const depTokenId of requiredDeps) {
        if (!availableTokens.has(depTokenId) && !optionalDeps.has(depTokenId)) {
          const tokenNode = findTokenAssignment(info.node);
          const errorNode = tokenNode || info.node;
          errors.push({
            type: 'missing',
            code: 'NEO_MISSING_PROVIDER',
            message: `Missing injection: '${getSimpleName(depTokenId)}' required by '${info.tokenText}' is not registered in this ${config.type === 'builder' ? 'builder nor its parents/extends' : 'partial config'}`,
            node: errorNode,
            sourceFile: config.sourceFile,
            context: {
              tokenText: depTokenId,
              chain: [getSimpleName(info.definition.tokenId), getSimpleName(depTokenId)],
            },
          });
        }
      }
    };

    for (const [_tokenId, info] of config.localInjections) {
      checkInfo(info);
    }

    if (config.multiInjections) {
      for (const [_tokenId, infos] of config.multiInjections) {
        for (const info of infos) {
          checkInfo(info);
        }
      }
    }

    // Phase 2: verify builder satisfies all partial expects
    if (config.type === 'builder') {
      errors.push(...this.checkPartialExpectsSatisfied(config, context, availableTokens));
    }

    return errors;
  }

  /**
   * Collects all available tokens in the current context.
   * - partialConfig: only local tokens
   * - defineBuilder: local + inherited from parent/extends + legacy parent tokens
   */
  private collectAvailableTokens(
    config: ConfigGraph,
    context: ValidationContext
  ): Set<TokenId> {
    const available = new Set<TokenId>();

    // Add local tokens
    for (const tokenId of config.localInjections.keys()) {
      available.add(tokenId);
    }

    // Add local multi-registration tokens — a consumer of a multi-registered
    // token is valid; the token IS provided, just via resolveAll().
    if (config.multiInjections) {
      for (const tokenId of config.multiInjections.keys()) {
        available.add(tokenId);
      }
    }

    // For partials: add tokens declared in `expects` — they will be provided
    // by the host BuilderConfig at assembly time, not by the partial itself.
    if (config.type === 'partial' && config.expectedExternalTokens) {
      for (const tokenId of config.expectedExternalTokens) {
        available.add(tokenId);
      }
    }

    // For builders, add inherited tokens
    if (config.type === 'builder' && context.inheritedTokens) {
      for (const tokenId of context.inheritedTokens.keys()) {
        available.add(tokenId);
      }
    }

    // For builders with legacy parent, add legacy parent tokens
    if (config.type === 'builder' && config.legacyParentTokens) {
      for (const tokenId of config.legacyParentTokens) {
        available.add(tokenId);
      }
    }

    return available;
  }

  /**
   * Phase 2: verifies that for each partial extended by this builder, all tokens
   * declared in the partial's `expects` are actually provided by the builder's
   * available token set (own injections + inherited + legacy parent).
   */
  private checkPartialExpectsSatisfied(
    config: ConfigGraph,
    context: ValidationContext,
    availableTokens: Set<TokenId>
  ): AnalysisError[] {
    const errors: AnalysisError[] = [];

    // Strict tokenId comparison: when the same interface is imported from the same
    // declaration file in both the partial and the builder, their tokenIds are identical
    // (the hash is derived from the symbol's declaration location, not the call site).
    // Using strict comparison preserves the hash-based collision protection.
    for (const extendRef of config.extendsRefs) {
      const partial = this.findPartialConfigByName(extendRef, context.allConfigs);
      if (!partial?.expectedExternalTokens) continue;

      for (const tokenId of partial.expectedExternalTokens) {
        if (!availableTokens.has(tokenId)) {
          errors.push({
            type: 'missing',
            message: `Missing token: '${getSimpleName(tokenId)}' is declared in '${extendRef}.expects' but is not provided by this builder or its parent container.`,
            node: config.node,
            sourceFile: config.sourceFile,
            context: { tokenText: tokenId },
          });
        }
      }
    }

    return errors;
  }

  /** Finds a partial ConfigGraph by its variable name across all collected configs. */
  private findPartialConfigByName(
    name: string,
    allConfigs: Map<string, ConfigGraph>
  ): ConfigGraph | undefined {
    for (const cfg of allConfigs.values()) {
      if (cfg.name === name && cfg.type === 'partial') return cfg;
    }
    return undefined;
  }
}
