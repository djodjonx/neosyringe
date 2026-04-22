import type { AnalysisError, ConfigGraph, TokenId } from '../types';
import type { IValidator, ValidationContext } from './Validator';
import type { DependencyAnalyzer } from './DependencyAnalyzer';

/**
 * Extracts the simple name from a token ID for human-readable error messages.
 * - "IEventBus_714d1af6" -> "IEventBus"
 * - "useInterface<ILogger>()" -> "ILogger"
 * - "UserService" -> "UserService"
 */
function getSimpleName(tokenId: TokenId): string {
  const interfaceMatch = tokenId.match(/useInterface<([^>]+)>/);
  if (interfaceMatch) {
    return interfaceMatch[1].split('_')[0];
  }
  const parts = tokenId.split('_');
  if (parts.length > 1) {
    const lastPart = parts[parts.length - 1];
    if (/^[a-f0-9]{6,12}$/i.test(lastPart)) {
      return parts.slice(0, -1).join('_');
    }
  }
  return tokenId;
}

/**
 * Validates a ConfigGraph for circular dependencies using DFS.
 *
 * This validator is part of the modular validation pipeline used by the LSP.
 * It replaces the legacy double-traversal (extract() + GraphValidator) in the LSP plugin.
 *
 * @example
 * ```typescript
 * const cycleValidator = new CycleValidator(dependencyAnalyzer);
 * const errors = cycleValidator.validate(config, context);
 * ```
 */
export class CycleValidator implements IValidator {
  readonly name = 'CycleValidator';

  constructor(private readonly dependencyAnalyzer: DependencyAnalyzer) {}

  validate(config: ConfigGraph, _context: ValidationContext): AnalysisError[] {
    const errors: AnalysisError[] = [];
    const depMap = this.buildDependencyMap(config);

    const visited = new Set<TokenId>();
    const stack = new Set<TokenId>();

    for (const tokenId of depMap.keys()) {
      if (!visited.has(tokenId)) {
        this.detectCycles(tokenId, depMap, config, visited, stack, errors);
      }
    }

    return errors;
  }

  private buildDependencyMap(config: ConfigGraph): Map<TokenId, TokenId[]> {
    const map = new Map<TokenId, TokenId[]>();

    for (const [tokenId, info] of config.localInjections) {
      const deps = this.dependencyAnalyzer.getRequiredDependencies(info.definition);
      // Only include deps that are registered locally (external deps can't form local cycles)
      const localDeps = deps.filter(dep => config.localInjections.has(dep));
      map.set(tokenId, localDeps);
    }

    return map;
  }

  private detectCycles(
    tokenId: TokenId,
    depMap: Map<TokenId, TokenId[]>,
    config: ConfigGraph,
    visited: Set<TokenId>,
    stack: Set<TokenId>,
    errors: AnalysisError[]
  ): void {
    visited.add(tokenId);
    stack.add(tokenId);

    const deps = depMap.get(tokenId) ?? [];
    for (const dep of deps) {
      if (!visited.has(dep)) {
        this.detectCycles(dep, depMap, config, visited, stack, errors);
      } else if (stack.has(dep)) {
        const cycle = [...stack, dep];
        const readableCycle = cycle.map(id => getSimpleName(id));
        const info = config.localInjections.get(tokenId);
        if (info) {
          errors.push({
            type: 'cycle',
            message: `Circular dependency detected: ${readableCycle.join(' -> ')}`,
            node: info.node,
            sourceFile: config.sourceFile,
          });
        }
      }
    }

    stack.delete(tokenId);
  }
}
