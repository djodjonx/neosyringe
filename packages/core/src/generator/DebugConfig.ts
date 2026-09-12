/**
 * Resolves whether generated containers should embed `_graph`/`_dependencyGraph`
 * debug data, given an explicit `debug` option (if any) from the caller.
 *
 * Opt-in, not opt-out: the data is embedded only when `debug: true` is passed
 * explicitly. Anything else — omitted, or `debug: false` — means no data,
 * so a project that never thinks about this option doesn't silently ship (or
 * silently pay the size/exposure cost of) debug data it never asked for.
 *
 * Production additionally forces this to `false` with no escape hatch, even
 * over an explicit `debug: true` — a container is commonly a long-lived,
 * shared object, and this is a safety net, not just a default.
 *
 * This one function is shared by every entry point (the unplugin-based
 * Vite/Rollup/Webpack/esbuild plugin and the ts-patch program transformer) so
 * the behavior is identical no matter which one a project uses.
 *
 * @param explicit - The `debug` option passed to the plugin/transformer, if any.
 * @returns Whether to embed the debug data in generated containers.
 */
export function resolveDebugFlag(explicit: boolean | undefined): boolean {
  if (typeof process !== 'undefined' && process.env?.NODE_ENV === 'production') {
    return false;
  }
  return explicit === true;
}
