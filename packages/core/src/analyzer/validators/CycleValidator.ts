import type { AnalysisError, ConfigGraph, ServiceDefinition, TokenId } from '../types';
import type { IValidator, ValidationContext } from './Validator';
import type { DependencyAnalyzer } from './DependencyAnalyzer';
import { getSimpleName } from '../utils/TokenUtils';
import { cyclePaths } from '../../generator/cycleSearch';

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
    const reportedCycles = new Set<string>();

    for (const path of cyclePaths(depMap)) {
      const cycleKey = [...path].sort().join('\0');
      if (reportedCycles.has(cycleKey)) continue;
      reportedCycles.add(cycleKey);

      // The anchor is the back-edge source: the last token before the repeated start.
      const source = path[path.length - 2];
      if (source === undefined) continue;
      const readableCycle = path.map(id => getSimpleName(id));
      const localInfo = config.localInjections.get(source);
      if (localInfo) {
        errors.push({
          type: 'cycle',
          code: 'NEO_CYCLE',
          message: `Circular dependency detected: ${readableCycle.join(' -> ')}`,
          node: localInfo.node,
          sourceFile: config.sourceFile,
          context: { chain: readableCycle },
        });
      } else {
        // Multi-injection: emit one error per provider registered under the source token
        const multiInfos = config.multiInjections?.get(source);
        if (multiInfos) {
          for (const info of multiInfos) {
            errors.push({
              type: 'cycle',
              code: 'NEO_CYCLE',
              message: `Circular dependency detected: ${readableCycle.join(' -> ')}`,
              node: info.node,
              sourceFile: config.sourceFile,
              context: { chain: readableCycle },
            });
          }
        }
      }
    }

    return errors;
  }

  private buildDependencyMap(config: ConfigGraph): Map<TokenId, TokenId[]> {
    const map = new Map<TokenId, TokenId[]>();
    // Collect all registered token IDs so property tokens can be matched
    const allLocalTokens = new Set<TokenId>([
      ...config.localInjections.keys(),
      ...(config.multiInjections ? [...config.multiInjections.keys()] : []),
    ]);

    for (const [tokenId, info] of config.localInjections) {
      const deps = this.cycleDependencies(info.definition, allLocalTokens);
      // Include deps registered as either local or multi-injection (external deps can't form cycles)
      const localDeps = deps.filter(dep =>
        config.localInjections.has(dep) || config.multiInjections?.has(dep)
      );
      map.set(tokenId, localDeps);
    }

    if (config.multiInjections) {
      for (const [tokenId, infos] of config.multiInjections) {
        for (const info of infos) {
          const deps = this.cycleDependencies(info.definition, allLocalTokens);
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

  private cycleDependencies(definition: ServiceDefinition, known: Set<TokenId>): TokenId[] {
    return this.dependencyAnalyzer.getRequiredDependencies(definition, known);
  }
}
