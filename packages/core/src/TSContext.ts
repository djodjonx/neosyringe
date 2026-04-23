import type * as ts from 'typescript';
import * as defaultTs from 'typescript';

/**
 * Singleton that holds the active TypeScript instance.
 *
 * In LSP/IDE context, the IDE passes its own TypeScript module via the plugin
 * init function. Injecting it here ensures all AST operations (isCallExpression,
 * forEachChild, etc.) use the same instance that created the AST nodes — required
 * for type-guard checks to work correctly across module boundaries.
 *
 * In CLI/build-plugin context, the setter is never called and the local
 * TypeScript dependency is used as the default.
 *
 * @remarks
 * **Test isolation:** Call `TSContext.reset()` in `afterEach` or `afterAll` to
 * restore defaults between tests. This prevents cross-test pollution when tests
 * set a custom TypeScript instance or project root.
 */
export class TSContext {
  private static _ts: typeof ts | undefined;
  private static _projectRoot: string | undefined;

  static get ts(): typeof ts {
    return this._ts ?? defaultTs;
  }

  static set ts(instance: typeof ts) {
    this._ts = instance;
  }

  static get projectRoot(): string {
    return this._projectRoot ?? process.cwd();
  }

  static set projectRoot(root: string) {
    this._projectRoot = root;
  }

  /**
   * Resets the singleton to its default state.
   * Clears any custom TypeScript instance and project root override.
   * Use in `afterEach` / `afterAll` blocks to prevent cross-test pollution.
   */
  static reset(): void {
    this._ts = undefined;
    this._projectRoot = undefined;
  }
}
