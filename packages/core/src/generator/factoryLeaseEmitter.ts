import { generatedText, selectHelpers, type Fragment, type Helper } from './fragments';
import { DEFAULT_MANY_NAMES, factoryContextType, manyContextFunction, type ManyNames } from './manyEmitter';

/**
 * Permission policy and lease of a declared factory (topic 14).
 *
 * A factory with a `dependencies` list has one immutable policy, built on the first call and shared by every call and
 * every scope of the generated class: it holds the declared tokens and their modes, never an instance or a scope.
 * Each call has its own lease: its own `expired` flag and its own context. The context checks the lease, then the
 * policy, then reads through the `read` member of the declaration, which takes the `host` (the container or scope that
 * made the call) as an argument, so the policy and the read member hold no `this`.
 *
 * Both helpers are private static members of the generated class, linked only when a declared factory needs them.
 * An opaque factory (no `dependencies` list) keeps its own context: it may ask for any token.
 */

export type PolicyMode = 'simple' | 'all';

/** One declared token. `keyExpression` is produced by the emitter (`resolveTokenKey`), never a raw user string. */
export interface PolicyEntry {
  readonly keyExpression: string;
  readonly mode: PolicyMode;
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function assertIdentifier(name: string): void {
  if (!IDENTIFIER.test(name)) throw new Error('invalid generated identifier');
}

const MODES = "'simple' | 'all'";

function policyType(className: string): string {
  return `ReturnType<typeof ${className}.__neoPolicyOf>`;
}

/** `__neoPolicyOf`: the entries of one declaration become a frozen policy. The Map stays private in the closure. */
function policyHelper(): string {
  return `private static __neoPolicyOf(entries: ReadonlyArray<readonly [unknown, ${MODES}]>): { readonly mode: (token: unknown) => ${MODES} | undefined } {
    const allowed = new Map<unknown, ${MODES}>();
    for (const [token, mode] of entries) allowed.set(token, allowed.get(token) === 'all' ? 'all' : mode);
    return Object.freeze({ mode: (token: unknown) => allowed.get(token) });
  }`;
}

/**
 * `__neoLease`: one context and its `expire` for one call. The context is generic in what it answers, like the public
 * `resolve<T>(token)`: the read answers `unknown` and the one assertion `as T` is the contract of the user's factory text.
 * The messages are the ones every factory has always thrown.
 */
function leaseHelper(className: string, names: ManyNames): string {
  const expiredCheck = "if (expired) fail('NEO_FACTORY_CONTEXT_EXPIRED', 'context used after the factory returned');";
  return `private static __neoLease(
    policy: ${policyType(className)},
    label: string,
    host: ${className},
    read: (host: ${className}, token: unknown, all: boolean) => unknown,
  ): { readonly context: ${factoryContextType(names)}; readonly expire: () => void } {
    let expired = false;
    const fail = (code: string, detail: string): never => {
      const error = new Error(code + ': factory ' + label + ' ' + detail) as Error & { code: string };
      error.code = code;
      throw error;
    };
    const resolve = <T,>(token: unknown): T => {
      ${expiredCheck}
      const mode = policy.mode(token);
      if (mode !== 'simple' && mode !== 'all') fail('NEO_UNDECLARED_FACTORY_DEP', 'cannot resolve an undeclared dependency');
      return read(host, token, false) as T;
    };
    const resolveAll = <T,>(token: unknown): T[] => {
      ${expiredCheck}
      if (policy.mode(token) !== 'all') fail('NEO_UNDECLARED_FACTORY_DEP', 'cannot resolveAll an undeclared dependency');
      return read(host, token, true) as T[];
    };
    ${manyContextFunction(names, 'resolveMany', 'resolve', expiredCheck)}
    return {
      context: { resolve, resolveAll, resolveMany },
      expire: () => { expired = true; },
    };
  }`;
}

/**
 * The two helpers of the class `className`, as catalog entries. Neither calls another helper. The name is checked where
 * a declaration is emitted ({@link emitFactoryPolicy}), so a class with no declared factory writes nothing of it.
 */
export function factoryLeaseHelpers(className: string, names: ManyNames = DEFAULT_MANY_NAMES): Helper[] {
  return [
    { id: 'factoryPolicy', parts: [generatedText(policyHelper())], needs: [] },
    { id: 'factoryLease', parts: [generatedText(leaseHelper(className, names))], needs: [] },
  ];
}

/** The helpers `roots` ask for, for an emitter that declares its other helpers itself (the reference emitter). */
export function linkedFactoryLeaseHelpers(className: string, roots: readonly Fragment[], names: ManyNames = DEFAULT_MANY_NAMES): Helper[] {
  const own = roots.map((root): Fragment => ({
    parts: root.parts,
    needs: root.needs.filter((id) => id === 'factoryPolicy' || id === 'factoryLease'),
  }));
  return selectHelpers(own, factoryLeaseHelpers(className, names));
}

/** The member and field names of one declaration, so the call site and the declaration cannot drift apart. */
function names(factoryId: string): { field: string; get: string; read: string } {
  assertIdentifier(factoryId);
  return { field: `__neoPolicy_${factoryId}`, get: `__neoPolicy_${factoryId}Get`, read: `__neoRead_${factoryId}` };
}

/**
 * The policy of one declaration: a static field and the static method that builds it on first use. The keys are
 * expressions of the user's file (an imported class, a class declared further down): reading them when the class is
 * defined would be a temporal dead zone, so the policy is built at the first call.
 * A key that reads `undefined` (with CommonJS output and an import cycle, an import not yet bound) is no token: the policy
 * of that call is used for that call only and built again at the next one, so a binding that arrives later is never missed.
 */
export function emitFactoryPolicy(className: string, factoryId: string, entries: readonly PolicyEntry[]): string {
  assertIdentifier(className);
  const { field, get } = names(factoryId);
  const rows = entries.map((entry) => `[${entry.keyExpression}, ${JSON.stringify(entry.mode)}]`).join(', ');
  const type = policyType(className);
  return `private static ${field}: ${type} | undefined;
  private static ${get}(): ${type} {
    const __neoStored = ${className}.${field};
    if (__neoStored !== undefined) return __neoStored;
    const __neoRows: Array<readonly [unknown, ${MODES}]> = [${rows}];
    const __neoPolicy = ${className}.__neoPolicyOf(__neoRows);
    if (__neoRows.every((__neoRow) => __neoRow[0] !== undefined)) ${className}.${field} = __neoPolicy;
    return __neoPolicy;
  }`;
}

/** The read of one declaration. `body` answers `unknown` for the token of the call, read from `host`. */
export function emitFactoryRead(className: string, factoryId: string, body: string): string {
  assertIdentifier(className);
  return `private static ${names(factoryId).read}(host: ${className}, token: unknown, all: boolean): unknown {
    ${body}
  }`;
}

/** The statements of the creator that open the lease of one call. */
export function emitLeaseOpen(className: string, factoryId: string, label: string): string {
  assertIdentifier(className);
  const { get, read } = names(factoryId);
  return `const __neoLease = ${className}.__neoLease(${className}.${get}(), ${label}, this, ${className}.${read});
    const __neoContext = __neoLease.context;
    const __neoExpire = __neoLease.expire;`;
}
