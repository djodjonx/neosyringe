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
 */

/** `single` answers one value (`resolve`), `list` answers the contributions of a multi token (`resolveAll`). */
export type DispatchKind = 'single' | 'list';

/** One row: the token, and the member of the generated class that serves it. */
export interface DispatchEntry {
  /** Produced by `resolveTokenKey`, never by interpolating a raw user string. */
  readonly keyExpression: string;
  readonly accessor: string;
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function assertIdentifier(name: string): void {
  if (!IDENTIFIER.test(name)) throw new Error('invalid generated identifier');
}

/** The member a row stores. It is unbound: the call site passes `this`. */
function memberType(className: string, kind: DispatchKind): string {
  return kind === 'list' ? `(this: ${className}, token: unknown) => unknown[]` : `(this: ${className}) => unknown`;
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

/** The read of one table: a hit answers, a miss falls through to what follows. A stored `undefined` is the accessor's answer. */
export function emitDispatchRead(className: string, field: string, kind: DispatchKind = 'single'): string {
  assertIdentifier(className);
  assertIdentifier(field);
  const args = kind === 'list' ? ', token' : '';
  return `const __neoRead = ${className}.${field}Table().get(token);
    if (__neoRead !== undefined) return __neoRead.call(this${args});`;
}
