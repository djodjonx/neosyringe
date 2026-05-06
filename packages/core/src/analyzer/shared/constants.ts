// packages/core/src/analyzer/shared/constants.ts

/** Name used as container ID when the variable is an `export default`. */
export const DEFAULT_EXPORT_CONTAINER_NAME = '__default__';

/** Regex to sanitize token IDs into valid JS identifier fragments. Use only with `.replace()` — the `g` flag makes `.test()` and `.exec()` stateful. */
export const FACTORY_NAME_SANITIZER = /[^a-zA-Z0-9]/g;
