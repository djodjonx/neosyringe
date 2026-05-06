import type { AnalysisError, ConfigGraph, TokenId } from '../types';
import type { IValidator, ValidationContext } from './Validator';
import type { DependencyAnalyzer } from './DependencyAnalyzer';
import { getSimpleName } from '../utils/TokenUtils';

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
    const reportedCycles = new Set<string>();

    for (const tokenId of depMap.keys()) {
      if (!visited.has(tokenId)) {
        this.detectCycles(tokenId, depMap, config, visited, stack, errors, reportedCycles);
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

    if (config.multiInjections) {
      for (const [tokenId, infos] of config.multiInjections) {
        for (const info of infos) {
          const deps = this.dependencyAnalyzer.getRequiredDependencies(info.definition);
          const localDeps = deps.filter(
            dep => config.localInjections.has(dep) || config.multiInjections!.has(dep)
          );
          const existing = map.get(tokenId) ?? [];
          map.set(tokenId, [...new Set([...existing, ...localDeps])]);
        }
      }
    }

    return map;
  }

  private detectCycles(
    tokenId: TokenId,
    depMap: Map<TokenId, TokenId[]>,
    config: ConfigGraph,
    visited: Set<TokenId>,
    stack: Set<TokenId>,
    errors: AnalysisError[],
    reportedCycles: Set<string>
  ): void {
    visited.add(tokenId);
    stack.add(tokenId);

    const deps = depMap.get(tokenId) ?? [];
    for (const dep of deps) {
      if (!visited.has(dep)) {
        this.detectCycles(dep, depMap, config, visited, stack, errors, reportedCycles);
      } else if (stack.has(dep)) {
        const cycle = [...stack, dep];
        const cycleKey = [...cycle].sort().join('\0');
        if (reportedCycles.has(cycleKey)) continue;
        reportedCycles.add(cycleKey);

        const readableCycle = cycle.map(id => getSimpleName(id));
        const localInfo = config.localInjections.get(tokenId);
        if (localInfo) {
          errors.push({
            type: 'cycle',
            message: `Circular dependency detected: ${readableCycle.join(' -> ')}`,
            node: localInfo.node,
            sourceFile: config.sourceFile,
          });
        } else {
          // Multi-injection: emit one error per provider participating in the cycle
          const multiInfos = config.multiInjections?.get(tokenId);
          if (multiInfos) {
            for (const info of multiInfos) {
              errors.push({
                type: 'cycle',
                message: `Circular dependency detected: ${readableCycle.join(' -> ')}`,
                node: info.node,
                sourceFile: config.sourceFile,
              });
            }
          }
        }
      }
    }

    stack.delete(tokenId);
  }
}
