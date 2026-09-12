/**
 * Resolves whether generated containers should embed `_graph`/`_dependencyGraph`
 * debug data, given an explicit `debug` option (if any) from the caller.
 *
 * Production always forces this to `false`, with no escape hatch — a
 * container is commonly a long-lived, shared object, and shipping its full
 * token/dependency graph is a build-time decision that shouldn't depend on
 * remembering to pass the right flag. This one function is shared by every
 * entry point (the unplugin-based Vite/Rollup/Webpack/esbuild plugin and the
 * ts-patch program transformer) so the behavior is identical no matter which
 * one a project uses.
 *
 * @param explicit - The `debug` option passed to the plugin/transformer, if any.
 * @returns Whether to embed the debug data in generated containers.
 */
export function resolveDebugFlag(explicit: boolean | undefined): boolean {
  if (typeof process !== 'undefined' && process.env?.NODE_ENV === 'production') {
    return false;
  }
  return explicit ?? true;
}
