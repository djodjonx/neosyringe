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
}
