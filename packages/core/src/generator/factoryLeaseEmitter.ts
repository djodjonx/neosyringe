import { generatedText, selectHelpers, type Fragment, type Helper } from './fragments';
import { DEFAULT_MANY_NAMES, factoryContextType, manyContextFunction, type ManyNames } from './manyEmitter';
import { contextTypeName, signalTypeName } from './signalEmitter';
import { inlineRefs, type HelperRefs } from './moduleHelpers';

/**
 * Permission policy and lease of a declared factory (topic 14).
 *
 * A factory with a `dependencies` list has one immutable policy, built on the first call and shared by every call and
 * every scope of the generated class: it holds the declared tokens and their modes, never an instance or a scope.
 * Each call has its own lease: its own `expired` flag and its own context. The context checks the lease, then the
 * policy, then reads through the `read` member of the declaration, which takes the `host` (the container or scope that
 * made the call) as an argument, so the policy and the read member hold no `this`.
 *
 * Both helpers are private static members of the generated class, linked only when a declared factory needs them. When the
 * module has a registry of shared helpers (`ModuleHelpers`), they are written once in the module instead, as `leaseFunction`,
 * `policyFunction` and `contextClassDeclaration`, with the same bodies.
 * An opaque factory (no `dependencies` list) keeps its own context: it may ask for any token.
 *
 * The context also has `signal` (topic 19): the signal of the initialization the call belongs to, or a signal that never
 * aborts when the factory is called outside an initialization. It is asked of the `host` when the factory reads it, not when
 * the lease opens: a factory that never reads it costs no controller. A context that has expired refuses `.signal` like
 * every other member.
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

/** The names a helper is written with: the aliases of the class (inline) or of the module (shared). */
export interface LeaseForm {
  readonly signal: string;
  readonly context: string;
  readonly policy: string;
  readonly names: ManyNames;
}

const POLICY_BODY = `const allowed = new Map<unknown, ${MODES}>();
    for (const [token, mode] of entries) allowed.set(token, allowed.get(token) === 'all' ? 'all' : mode);
    return Object.freeze({ mode: (token: unknown) => allowed.get(token) });`;

const POLICY_SHAPE = `{ readonly mode: (token: unknown) => ${MODES} | undefined }`;

/** `__neoPolicyOf`: the entries of one declaration become a frozen policy. The Map stays private in the closure. */
function policyHelper(): string {
  return `private static __neoPolicyOf(entries: ReadonlyArray<readonly [unknown, ${MODES}]>): ${POLICY_SHAPE} {
    ${POLICY_BODY}
  }`;
}

/** The type of a policy, as a top-level alias of the module (shared form). */
export function policyAlias(form: LeaseForm): string {
  return `type ${form.policy} = ${POLICY_SHAPE};`;
}

/** The policy builder as a function of the module (shared form): the same body, no `this`, no class. */
export function policyFunction(name: string, form: LeaseForm): string {
  return `function ${name}(entries: ReadonlyArray<readonly [unknown, ${MODES}]>): ${form.policy} {
    ${POLICY_BODY}
  }`;
}

/** The static member that holds the context class (`factoryContextClass`), shared by every factory of the container. */
export const CONTEXT_CLASS = '__neoContext';

/**
 * The class of a factory context, as the text of a private static member, written once per container for the declared
 * factories (the lease) and the opaque ones alike. Its parameters are typed through the alias of the container
 * (`contextTypeName`), not through the literal. `signal` is an accessor of the class, not of each context: an object
 * literal with a `get signal()` costs a closure and a runtime accessor definition on every call (measured: 136 ns against
 * 17 ns for the same literal without it, tests/bench/runtime-cost.mjs `initialize` of a container with an async factory),
 * and that was paid by every factory call even though few factories read `signal`. The class has the three resolvers as
 * own members and reads the signal through `__neoRead`, which the call gives it: that is the expiry check and the ask of
 * the host. `signal` is therefore on the prototype of a context, not one of its own properties.
 */
export function factoryContextClass(className: string): string {
  return `private static readonly ${CONTEXT_CLASS} = ${contextClassBody(inlineForm(className))};`;
}

/** The context class as a declaration of the module (shared form). */
export function contextClassDeclaration(name: string, form: LeaseForm): string {
  return `class ${name} ${contextClassBody(form).slice('class '.length)}`;
}

function contextClassBody(form: LeaseForm): string {
  return `class {
    constructor(
      private readonly __neoRead: () => ${form.signal},
      readonly resolve: ${form.context}['resolve'],
      readonly resolveAll: ${form.context}['resolveAll'],
      readonly resolveMany: ${form.context}['resolveMany'],
    ) {}

    get signal(): ${form.signal} {
      return this.__neoRead();
    }
  }`;
}

/** The aliases of a class, as the helpers of that class write them. */
function inlineForm(className: string, names: ManyNames = DEFAULT_MANY_NAMES): LeaseForm {
  return { signal: signalTypeName(className), context: contextTypeName(className), policy: policyType(className), names };
}

/** The alias of the factory context of the module (shared form). */
export function emitFactoryContextAlias(form: LeaseForm): string {
  return `type ${form.context} = ${factoryContextType(form.names, form.signal)};`;
}

/**
 * `__neoLease`: one context and its `expire` for one call. The context is generic in what it answers, like the public
 * `resolve<T>(token)`: the read answers `unknown` and the one assertion `as T` is the contract of the user's factory text.
 * The messages are the ones every factory has always thrown.
 */
function leaseHelper(className: string, names: ManyNames): string {
  const form = inlineForm(className, names);
  return leaseText(
    `private static __neoLease(
    policy: ${form.policy},
    label: string,
    host: ${className},
    read: (host: ${className}, token: unknown, all: boolean) => unknown,
  )`,
    form,
    'host._neoSignal()',
    `${className}.${CONTEXT_CLASS}`,
  );
}

/**
 * The lease as a function of the module (shared form). It is generic in the host: the read member and the host are typed
 * against each other at the call. The one thing it needs of the host, the signal of the initialization, comes as a method
 * the call site hands it from inside the class (`this._neoSignal`, see {@link emitLeaseOpen}), where the private member is
 * reachable, and the lease calls it on the host: the function needs no assertion on the host. The call site writes the member
 * itself, never an arrow function around it: a function made for each call added about 157 ns to the 219 ns of an
 * `initialize()` that makes one factory call (docs/benchmarks/stage-f-compile-overhead.md, "Round 6").
 */
export function leaseFunction(name: string, contextClass: string, form: LeaseForm): string {
  return leaseText(
    `function ${name}<H>(
    policy: ${form.policy},
    label: string,
    host: H,
    read: (host: H, token: unknown, all: boolean) => unknown,
    hostSignal: (this: H) => ${form.signal},
  )`,
    form,
    'hostSignal.call(host)',
    contextClass,
  );
}

function leaseText(head: string, form: LeaseForm, signalRead: string, contextClass: string): string {
  const expiredCheck = "if (expired) fail('NEO_FACTORY_CONTEXT_EXPIRED', 'context used after the factory returned');";
  return `${head}: { readonly context: ${form.context}; readonly expire: () => void } {
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
    ${manyContextFunction(form.names, 'resolveMany', 'resolve', expiredCheck)}
    const readSignal = (): ${form.signal} => {
      ${expiredCheck}
      return ${signalRead};
    };
    return {
      context: new ${contextClass}(readSignal, resolve, resolveAll, resolveMany),
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
    { id: 'factoryLease', parts: [generatedText(leaseHelper(className, names))], needs: ['factoryContext'] },
    { id: 'factoryContext', parts: [generatedText(factoryContextClass(className))], needs: [] },
  ];
}

/** The helpers `roots` ask for, for an emitter that declares its other helpers itself (the reference emitter). */
export function linkedFactoryLeaseHelpers(className: string, roots: readonly Fragment[], names: ManyNames = DEFAULT_MANY_NAMES): Helper[] {
  const own = roots.map((root): Fragment => ({
    parts: root.parts,
    needs: root.needs.filter((id) => id === 'factoryPolicy' || id === 'factoryLease' || id === 'factoryContext'),
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
export function emitFactoryPolicy(className: string, factoryId: string, entries: readonly PolicyEntry[], refs: HelperRefs = inlineRefs(className)): string {
  assertIdentifier(className);
  const { field, get } = names(factoryId);
  const rows = entries.map((entry) => `[${entry.keyExpression}, ${JSON.stringify(entry.mode)}]`).join(', ');
  const type = refs.policyType;
  return `private static ${field}: ${type} | undefined;
  private static ${get}(): ${type} {
    const __neoStored = ${className}.${field};
    if (__neoStored !== undefined) return __neoStored;
    const __neoRows: Array<readonly [unknown, ${MODES}]> = [${rows}];
    const __neoPolicy = ${refs.policyOf}(__neoRows);
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
export function emitLeaseOpen(className: string, factoryId: string, label: string, refs: HelperRefs = inlineRefs(className)): string {
  assertIdentifier(className);
  const { get, read } = names(factoryId);
  return `const __neoLease = ${refs.lease}(${className}.${get}(), ${label}, this, ${className}.${read}${refs.leaseSignal});
    const __neoContext = __neoLease.context;
    const __neoExpire = __neoLease.expire;`;
}
