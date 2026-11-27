/**
 * `resolveMany` of a generated container and of a factory context (topic 17).
 *
 * The public method is an overload set: a generic signature that answers a tuple of the values of its tokens, a second one
 * for the string form of a token (below), over an implementation that reads and answers `unknown`. The values are never
 * asserted to a type: the overload states the contract of the call, like `resolve<T>(token)`, so the generated file needs no cast. The generated file declares its own
 * two type aliases (the output imports nothing from the product): `Token<T>` and the tuple of values of a token list, the
 * same shapes as `Token` and `ValuesOf` of packages/neosyringe/src/types.ts. Their names come from the name pool of the
 * source file, so a binding of the user's file or a second container written into it never collides with them.
 *
 * A second overload takes the rewritten form of a token. The ts-patch Program transformer rewrites `useInterface<X>()` and
 * `useProperty(...)` to their string id before tsc checks the file, and `resolve(token: unknown)` accepts that id, so the
 * list must too. That overload comes after the precise one: a list of class, interface and property tokens of the source
 * Program, and the public `Container` and `FactoryContext` types, keep the first. An element that is a string answers
 * `unknown` (its interface is gone from the text), a class keeps its own type, and the call needs no cast. The local
 * function of a factory context needs no such overload: the context type below states it, and the function is only
 * assigned to it.
 */

/** The names of the aliases a generated class and its factory contexts write. */
export interface ManyNames {
  /** `Token<T>`: a class constructor, an interface token or a property token. */
  readonly token: string;
  /** The tuple of the values of a list of tokens. */
  readonly values: string;
  /**
   * One `overrideMany` pair: a token (or its string id, see `emitOverrideMany`) and a factory. Written only by a full
   * container with test overrides.
   */
  readonly overrideEntry: string;
  /** The pair, or `never` when the factory returns another type than the value of its token. */
  readonly overrideInvalid: string;
  /** `unknown` when every pair of a batch matches, `never` otherwise. */
  readonly overrideGuard: string;
}

/** The plain names, for a caller that has no pool (a hand-built test of an emitter). */
export const DEFAULT_MANY_NAMES: ManyNames = {
  token: '__NeoToken',
  values: '__NeoValues',
  overrideEntry: '__NeoOverrideEntry',
  overrideInvalid: '__NeoOverrideInvalid',
  overrideGuard: '__NeoOverrideGuard',
};

/**
 * The two aliases, as top-level declarations. `values` maps a tuple or an array of tokens to the same shape of values.
 * A token that is a union (`Mail | Clock`) answers the union of the values, as `ValueOf` does (packages/neosyringe/src/types.ts:134):
 * the covariant `infer V` collects every member, so no distributive wrapper is needed.
 */
export function emitManyAliases(names: ManyNames): string {
  return `type ${names.token}<T> =
  | (new (...args: never[]) => T)
  | { __brand: 'InterfaceToken'; __type: T }
  | { __brand: 'PropertyToken'; __type: T; __class: unknown; __name: string };
type ${names.values}<T extends readonly ${names.token}<unknown>[]> = {
  -readonly [K in keyof T]: T[K] extends ${names.token}<infer V> ? V : never;
};`;
}

/**
 * The three aliases of `overrideMany`, the same shapes as `OverrideEntry` and `OverrideGuard` of
 * packages/neosyringe/src/types.ts, except that the token of a pair may also be a string: the form the Program
 * transformer writes for an interface or a property token. A pair with a string token is valid (its value type is gone
 * from the text, as for `resolveMany`); a pair with a real token keeps the check. The pair is checked as a unit:
 * `invalid` distributes over a union of pairs before the result is compared, so a union that holds an incoherent pair is
 * refused, and a union of coherent pairs is accepted. The value of a token is read inline (`infer V`), so the output
 * needs no other alias.
 */
export function emitOverrideAliases(names: ManyNames): string {
  return `type ${names.overrideEntry} = readonly [${names.token}<unknown> | string, () => unknown];
type ${names.overrideInvalid}<E> = E extends ${names.overrideEntry}
  ? E[0] extends string ? never
  : [ReturnType<E[1]>] extends [E[0] extends ${names.token}<infer V> ? V : never] ? never : E
  : E;
type ${names.overrideGuard}<E extends readonly ${names.overrideEntry}[]> =
  [{ [K in keyof E]: [${names.overrideInvalid}<E[K]>] extends [never] ? never : K }[number]] extends [never] ? unknown : never;`;
}

/**
 * The tuple of the values of a list that may hold the string id of an interface or property token (the form the Program
 * transformer writes). The shape is written inline, so it adds no name to the generated file. `infer E` distributes over
 * a union element (`Mail | string` answers `unknown`, since the string member does).
 */
function looseValues(names: ManyNames): string {
  return `{ -readonly [K in keyof T]: T[K] extends infer E ? E extends string ? unknown : E extends ${names.token}<infer V> ? V : never : never }`;
}

/** The type parameter and the parameter list of the overload that accepts the string id of a token. */
function looseHead(names: ManyNames): string {
  return `<const T extends readonly (${names.token}<unknown> | string)[]>(tokens: T)`;
}

/**
 * The public method of a container. `entryGuard` is the text of the guard the container reads before it touches the
 * list: the same state, destroyed, initialization and parent checks as `resolve`, so an empty list is refused as a list
 * of one token is. The list is copied once, then each token goes through the public `resolve` of the same container: the
 * token guard of a closed container, the events, the override of a test, the parent bridge and the errors are the ones
 * of a single call. The first error leaves the loop.
 */
export function emitResolveMany(entryGuard: string, names: ManyNames): string {
  return `public resolveMany<const T extends readonly ${names.token}<unknown>[]>(tokens: T): ${names.values}<T>;
  public resolveMany${looseHead(names)}: ${looseValues(names)};
  public resolveMany(tokens: readonly (${names.token}<unknown> | string)[]): unknown[] {
    ${entryGuard}
    const __neoTokens = [...tokens];
    const __neoValues: unknown[] = [];
    for (const __neoToken of __neoTokens) __neoValues.push(this.resolve(__neoToken));
    return __neoValues;
  }`;
}

/** What `emitOverrideMany` writes around the loop. Every text is a statement list of the method body. */
export interface OverrideManyInput {
  /** The refusals of the container state, in the `throw` form: the try block makes them rejections. Run twice. */
  readonly gates: string;
  /** The refusals of one token (a multi token), in the `throw` form, inside the loop. Empty when the graph has none. */
  readonly tokenChecks: string;
  /** The first statement of a transition, exactly the one `override` runs before `_reconfigure`. */
  readonly arm: string;
}

/**
 * The public `overrideMany` of a full container with test overrides. The gates run before the entries are read, and
 * again after: reading an entry runs user code (a getter, an iterator) that may close the container. Then the
 * caller's pairs are copied, the whole batch is checked against a candidate table, and only a valid batch arms the
 * transition. The candidate becomes the table once the cleanup has succeeded, so a refused batch invokes no factory,
 * disposes nothing and changes nothing. An empty batch is checked and returns before the transition. Every refusal is
 * a throw inside the try block: the method never throws synchronously and never returns from inside the loop.
 *
 * Two overloads, like `resolveMany`. The first takes the pairs of the source Program (a class, an interface or a property
 * token) and checks each factory against its token. The second takes the string id the Program transformer writes in
 * place of an interface or property token; it keeps the same check for the pairs whose token is real.
 */
export function emitOverrideMany(input: OverrideManyInput, names: ManyNames): string {
  const checks = input.tokenChecks === '' ? '' : `\n        ${input.tokenChecks}`;
  return `public overrideMany<const E extends readonly (readonly [${names.token}<unknown>, () => unknown])[]>(entries: E & ${names.overrideGuard}<E>): Promise<void>;
  public overrideMany<const E extends readonly ${names.overrideEntry}[]>(entries: E & ${names.overrideGuard}<E>): Promise<void>;
  public overrideMany(entries: readonly ${names.overrideEntry}[]): Promise<void> {
    try {
      ${input.gates}
      const __neoEntries = entries.map(([token, factory]) => [token, factory] as const);
      const __neoNext = new Map(this.overrides);
      const __neoSeen = new Set<unknown>();
      for (const [token, factory] of __neoEntries) {
        if (__neoSeen.has(token)) throw this._neoFail('NEO_OVERRIDE_DUPLICATE', 'duplicate override in batch');
        if (typeof factory !== 'function') throw this._neoFail('NEO_OVERRIDE_INVALID', 'override must be a factory');${checks}
        __neoSeen.add(token);
        __neoNext.set(token, factory);
      }
      ${input.gates}
      if (__neoEntries.length === 0) return Promise.resolve();
      ${input.arm}
      return this._reconfigure(() => { this.overrides = __neoNext; });
    } catch (__neoError) {
      return Promise.reject(__neoError);
    }
  }`;
}

/**
 * The same precise overload, over the same implementation, as a local function of a factory context. `resolveCall` is the expression that resolves one
 * token for this context (the checked `resolve` of the lease, or the opaque context's own); the function copies the list
 * and loops over it, so it never reaches the container behind the context's checks. `before` runs first, so an expired
 * context refuses an empty list too. `functionName` is a name no user text can read: the factory text of a user is
 * written in the scope of this function, and a `resolveMany` of the user's own must keep meaning that.
 */
export function manyContextFunction(names: ManyNames, functionName: string, resolveCall: string, before = ''): string {
  return `function ${functionName}<const T extends readonly ${names.token}<unknown>[]>(tokens: T): ${names.values}<T>;
    function ${functionName}(tokens: readonly (${names.token}<unknown> | string)[]): unknown[] {
      ${before}
      const __neoTokens = [...tokens];
      const __neoValues: unknown[] = [];
      for (const __neoToken of __neoTokens) __neoValues.push(${resolveCall}(__neoToken));
      return __neoValues;
    }`;
}

/**
 * What a factory body reads of its context. The calls are generic: the factory text is the user's and states the type it
 * expects (`new UserService(ctx.resolve(loggerToken))` asks for an `ILogger`), the context only forwards a token. A context
 * that answered `unknown` would refuse that text (TS2345) in the Program the transformer builds from the transformed
 * source, and would refuse a parameter annotated with the public `FactoryContext`. `signal` is the name of the signal alias
 * of the class (`signalTypeName`): the public `FactoryContext` has a `signal` too, so the context stays assignable to it.
 */
export function factoryContextType(names: ManyNames, signal: string): string {
  return `{ readonly signal: ${signal}; resolve<T>(token: unknown): T; resolveAll<T>(token: unknown): T[]; resolveMany<const T extends readonly ${names.token}<unknown>[]>(tokens: T): ${names.values}<T>; resolveMany${looseHead(names)}: ${looseValues(names)} }`;
}
