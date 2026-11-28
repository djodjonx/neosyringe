/**
 * Shared dispatch of the optimized container: a dynamic `resolve` or `resolveAll` finds the accessor of a token in a
 * private static `Map` of the generated class, and calls it with the `this` of the container or scope that was asked.
 * One table per class, shared by every scope (`.call(this)` selects the scope); no per-instance table, no `bind`.
 *
 * The table is built on the first dynamic read, not when the class is defined. A token is an expression of the user's
 * file (an imported class, a class declared further down), and reading it while the class is defined would be a
 * temporal dead zone for a class that comes later in the module.
 *
 * A token that reads `undefined` is no token. With CommonJS output and an import cycle, the first dynamic read can run
 * while an imported token (`Import_N.X`, see `GetImport` in FactoryEmitter.ts) is still `undefined`. A table with such a
 * key is used for that read only and is not stored: the next dynamic read builds it again, so a binding that arrives
 * later is never missed. With ESM output the same read throws at once, a binding not yet initialized.
 *
 * A table of few rows is not worth that machinery. Each table is counted on its own rows: up to `DISPATCH_LINEAR_MAX`
 * rows it is the linear `if (token === key)` cases of the container, no static field, no method, no `Map`; with more rows
 * it is the shared table above. The two read the same way: the guards before, the fallbacks after.
 */

/**
 * Rows up to which a table is the linear cases: a table of at most `DISPATCH_LINEAR_MAX` rows is linear, one of more
 * rows is the shared table. The Generator can force it (`dispatch.linearMax`), `0` for the table always and
 * `Infinity` for the linear cases always.
 *
 * Measured with tests/bench/runtime-cost.mjs, `warm-resolve`, shape flat, 5 processes x 7 samples, the table run with the
 * `k` of the linear run, compared with scripts/ci/performance-budget.mjs. Apple M4 Max, Node 22.23.2. Median ns, linear -> table,
 * for the four profiles (full open, minimal open, full closed, minimal closed):
 * - 16 rows: 27.4 -> 39.3, 26.7 -> 47.9, 32.6 -> 45.1, 34.6 -> 47.8 (three of the four fail the budget)
 * - 64 rows: 32.9 -> 39.5, 33.1 -> 41.8, 40.5 -> 43.0, 40.0 -> 44.1 (three of the four fail the budget)
 * - 128 rows: 48.1 -> 50.7, 63.0 -> 63.4, 54.4 -> 55.5, 70.5 -> 70.6 (parity, no failure)
 * - 256 rows: 123.7 -> 107.1, 86.7 -> 74.1, 130.1 -> 111.5, 94.7 -> 78.8 (the table is faster)
 * - 512 rows: 239.9 -> 208.2, 155.3 -> 128.4, 259.2 -> 204.0, 161.1 -> 125.3 (the table is faster)
 * The table is slower up to 64 rows, level at 128, faster from 256: the threshold is 128, the largest size where the linear
 * cases are not behind. The sizes 16 to 64 ran under a machine load of 7 to 50, the sizes 128 to 512 under 3 to 7.
 * The raw reports are in docs/benchmarks/topic-01-09-14.md.
 */
export const DISPATCH_LINEAR_MAX = 128;

/** `single` answers one value (`resolve`), `list` answers the contributions of a multi token (`resolveAll`). */
export type DispatchKind = 'single' | 'list';

/** One row: the token, and the member of the generated class that serves it. */
export interface DispatchEntry {
  /** Produced by `resolveTokenKey`, never by interpolating a raw user string. */
  readonly keyExpression: string;
  readonly accessor: string;
  /** A `list` row read as a linear case: the body of the reader `accessor`, a statement that returns the list. */
  readonly inline?: string;
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function assertIdentifier(name: string): void {
  if (!IDENTIFIER.test(name)) throw new Error('invalid generated identifier');
}

/** The member a row stores. It is unbound: the call site passes `this`. */
function memberType(className: string, kind: DispatchKind): string {
  return kind === 'list' ? `(this: ${className}, token: unknown) => unknown[]` : `(this: ${className}) => unknown`;
}

/** A table of at most `linearMax` rows is the linear cases. */
export function dispatchIsLinear(entries: readonly DispatchEntry[], linearMax: number): boolean {
  return entries.length <= linearMax;
}

/**
 * The linear read of a table: one `if (token === key)` case per row, in row order. A `single` row calls its accessor
 * on the `this` of the container that was asked. A `list` row is its reader's body, inline. A miss falls through to what follows.
 */
export function emitLinearRead(entries: readonly DispatchEntry[], kind: DispatchKind): string {
  return entries.map((entry) => {
    if (!IDENTIFIER.test(entry.accessor)) throw new Error('invalid generated accessor');
    if (kind === 'single') return `if (token === ${entry.keyExpression}) return this.${entry.accessor}();`;
    if (entry.inline === undefined) throw new Error('missing inline body');
    return `if (token === ${entry.keyExpression}) ${entry.inline}`;
  }).join('\n    ');
}

/**
 * The static field and the static method that builds it on first use. `field` is the name of the field, the method
 * is `<field>Table`. Both are members of the class `className`, so they may name its private accessors.
 */
export function emitDispatchField(
  className: string,
  field: string,
  entries: readonly DispatchEntry[],
  kind: DispatchKind = 'single',
): string {
  assertIdentifier(className);
  assertIdentifier(field);
  const rows = entries.map((entry) => {
    if (!IDENTIFIER.test(entry.accessor)) throw new Error('invalid generated accessor');
    return `[${entry.keyExpression}, ${className}.prototype.${entry.accessor}]`;
  });
  const member = memberType(className, kind);
  const table = `Map<unknown, ${member}>`;
  return `private static ${field}: ${table} | undefined;
  private static ${field}Table(): ${table} {
    let __neoTable = ${className}.${field};
    if (__neoTable === undefined) {
      const __neoRows: Array<readonly [unknown, ${member}]> = [${rows.join(', ')}];
      __neoTable = new ${table}(__neoRows);
      if (__neoRows.every((__neoRow) => __neoRow[0] !== undefined)) ${className}.${field} = __neoTable;
    }
    return __neoTable;
  }`;
}

/**
 * The read of one table: a hit answers, a miss falls through to what follows. A stored `undefined` is the accessor's answer.
 * A built table is read from its field; the method runs only while the field is empty.
 */
export function emitDispatchRead(className: string, field: string, kind: DispatchKind = 'single'): string {
  assertIdentifier(className);
  assertIdentifier(field);
  const args = kind === 'list' ? ', token' : '';
  return `const __neoRead = (${className}.${field} ?? ${className}.${field}Table()).get(token);
    if (__neoRead !== undefined) return __neoRead.call(this${args});`;
}
