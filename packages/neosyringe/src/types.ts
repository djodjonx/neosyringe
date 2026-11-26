/**
 * Represents a generic class constructor.
 * @template T - The type of the instance created by the constructor.
 */
export type Constructor<T = unknown> = new (...args: never[]) => T;

/**
 * Defines the lifecycle of a service.
 * - `singleton`: One instance per container.
 * - `transient`: A new instance every time it is resolved.
 */
export type Lifecycle = 'singleton' | 'transient';

/**
 * `[Symbol.asyncDispose]` of a container and of a scope, which makes them `await using` resources. The member is typed
 * only when the consumer's lib declares `Symbol.asyncDispose` (`lib: ["ESNext.Disposable"]`, TypeScript 5.2): the key is
 * read from `SymbolConstructor`, so a consumer without that lib sees no new member and no missing global type, and the
 * minimum TypeScript version of the package does not move. It delegates to `destroy()`. A runtime without
 * `Symbol.asyncDispose` has no such protocol; `destroy()` works everywhere.
 */
export type AsyncDisposalMembers = SymbolConstructor extends { readonly asyncDispose: infer K extends symbol }
  ? { [P in K]: () => Promise<void> }
  : Record<never, never>;

/**
 * Capabilities shared by every generated container, including the minimal profile.
 * `Token` is declared below; the methods only mention it.
 */
export interface CoreContainer extends AsyncDisposalMembers {
  /**
   * Resolves a service by its token.
   *
   * @template T - The type of the service to resolve.
   * @param token - The service token (class constructor, interface token, or property token).
   * @returns The resolved service instance.
   * @throws {Error} If the service is not found or not registered.
   */
  resolve<T>(token: Token<T>): T;

  /**
   * Resolves all registrations for a token registered with `multi: true`.
   * Returns an empty array if no multi-registrations exist for the token.
   */
  resolveAll<T>(token: Token<T>): T[];

  /**
   * Resolves several tokens in one call and answers their values as a tuple, in the order of the tokens.
   *
   * - The result has one value per token, with its own type: `resolveMany([Mailer, clock])` is `[Mailer, Clock]`.
   *   An array that is not a tuple gives an array, and an empty list gives `[]`.
   * - Every token is resolved by `resolve()`, left to right, so it has the same guards, events and errors.
   *   A token listed twice is resolved twice: a singleton answers the same instance, a transient a new one.
   * - The container is checked before the list is read: an empty list on a destroyed container, a container
   *   that is not initialized or whose parent is destroyed throws the same error code as `resolve()`. The message
   *   names `resolveMany()` for `NEO_NOT_INITIALIZED`; the other guards keep the message of `resolve()`.
   * - The first error stops the batch: later tokens are not resolved, and what the earlier tokens built stays
   *   built. There is no rollback.
   * - Synchronous: a token of an async factory is read after `initialize()`, and the values are never promises.
   *
   * The build plugin reads a literal list: each element is checked like a `resolve()` call, at its own position.
   * A list the plugin cannot read (a variable, a call, a spread of a variable) works at run time and is reported
   * like a receiver it cannot follow (`NEO_UNKNOWN_CONTAINER`, an error in `strict`, a warning in `compatible`).
   */
  resolveMany<const T extends readonly Token<unknown>[]>(tokens: T): ValuesOf<T>;

  /** Brings async singletons to ready. Sync containers resolve this immediately. */
  initialize(): Promise<void>;

  /**
   * Ends this container. Terminal and idempotent: a later resolve() or initialize()
   * throws NEO_CONTAINER_DESTROYED, and a second destroy() does nothing.
   * Disposes owned singleton instances, once each, with one method: `dispose()` when it is callable, otherwise
   * `[Symbol.asyncDispose]()`, otherwise `[Symbol.dispose]()`. A promise the method returns is awaited, and every
   * failure is reported together in one `AggregateError`. Borrowed factory results, useValue values,
   * override mocks and parent references are not disposed.
   */
  destroy(): Promise<void>;

  /** Returns a child with the same parents and name. It does not copy instances or call initialize(). */
  createScope(): this;
}

/**
 * Full profile. Adds test overrides and resolve events on top of {@link CoreContainer}.
 */
export interface Container extends CoreContainer {
  override<T>(token: Token<T>, factory: () => T): Promise<void>;
  /**
   * Replaces several registrations in one transition. The whole batch is checked first, so a refused batch invokes no
   * factory, disposes nothing and changes nothing. A valid batch runs one cleanup pass (each owned singleton is
   * disposed once), then installs every mock together. The mocks are borrowed, not disposed by the container, and an
   * async container needs `initialize()` again, exactly as after {@link Container.override}. An empty batch is checked
   * and changes nothing. A token twice, a multi token, a factory that is not a function, a destroyed or failed
   * container and a build without test overrides are refused with a stable error code.
   */
  overrideMany<const E extends readonly OverrideEntry[]>(entries: E & OverrideGuard<E>): Promise<void>;
  clearOverrides(): Promise<void>;
  on(
    event: 'resolve',
    listener: (token: Token<unknown>, instance: unknown) => void,
  ): () => void;
}

// ============================================================================
// Declarative API (defineBuilderConfig)
// ============================================================================

/**
 * A unique token for an interface, generated at compile-time.
 */
export type InterfaceToken<T> = {
  __brand: 'InterfaceToken';
  __type: T;
};

/**
 * A unique token for a primitive property bound to a specific class parameter.
 * Used for injecting string, number, boolean, etc. into class constructors.
 */
export type PropertyToken<T, C = unknown> = {
  __brand: 'PropertyToken';
  __type: T;
  __class: C;
  __name: string;
};

/**
 * Represents a token that can be injected.
 * Can be a Class Constructor, an Interface Token, or a Property Token.
 */
export type Token<T = unknown> = Constructor<T> | InterfaceToken<T> | PropertyToken<T, unknown>;

/** Value carried by a token. `never` when the token is not a Token. */
export type ValueOf<T> = T extends Token<infer V> ? V : never;

/** Tuple of values, in the same positions as the token tuple. */
export type ValuesOf<T extends readonly Token<unknown>[]> = { -readonly [K in keyof T]: ValueOf<T[K]> };

/** Token that a scope may receive as a value. A class constructor is not a scope input. */
export type InputToken = InterfaceToken<unknown> | PropertyToken<unknown, unknown>;

/** One scope value. The pair is checked as a unit so a union cannot trade values across tokens. */
export type InputEntry = { readonly token: InputToken; readonly useValue: unknown };

/** One override pair. Checked as a unit, same as {@link InputEntry}. */
export type OverrideEntry = readonly [Token<unknown>, () => unknown];

type InvalidInput<E> = E extends InputEntry
  ? [E['useValue']] extends [ValueOf<E['token']>] ? never : E
  : E;

type BadInput<E extends readonly InputEntry[]> = {
  [K in keyof E]: [InvalidInput<E[K]>] extends [never] ? never : K
}[number];

/** `unknown` when every pair matches and the token sets are the same. A union of pairs is checked one pair at a time. */
export type InputGuard<I extends readonly InputToken[], E extends readonly InputEntry[]> =
  [BadInput<E>] extends [never]
    ? [Exclude<I[number], E[number]['token']>, Exclude<E[number]['token'], I[number]>] extends [never, never]
      ? unknown
      : never
    : never;

type InvalidOverride<E> = E extends OverrideEntry
  ? [ReturnType<E[1]>] extends [ValueOf<E[0]>] ? never : E
  : E;

type BadOverride<E extends readonly OverrideEntry[]> = {
  [K in keyof E]: [InvalidOverride<E[K]>] extends [never] ? never : K
}[number];

/** `unknown` when every override pair matches. */
export type OverrideGuard<E extends readonly OverrideEntry[]> = [BadOverride<E>] extends [never] ? unknown : never;

/**
 * Argument list of the `createScope` of a container that declares `scopeInputs`.
 * An empty input list makes the values optional. Any other list requires them.
 */
export type ScopeArguments<I extends readonly InputToken[], E extends readonly InputEntry[]> =
  I extends readonly []
    ? [options?: { readonly values: E & InputGuard<I, E> }]
    : [options: { readonly values: E & InputGuard<I, E> }];

/**
 * What a factory is allowed to resolve. It is not the full container.
 */
export interface FactoryContext {
  resolve<T>(token: Token<T>): T;
  resolveAll<T>(token: Token<T>): T[];
  /**
   * The tuple of the values of the tokens, in order, like {@link CoreContainer.resolveMany}. Every token goes
   * through this context's own `resolve`: an undeclared token throws `NEO_UNDECLARED_FACTORY_DEP`, and a context
   * used after its factory returned throws `NEO_FACTORY_CONTEXT_EXPIRED`, an empty list included.
   */
  resolveMany<const T extends readonly Token<unknown>[]>(tokens: T): ValuesOf<T>;
}

/**
 * A factory function that creates an instance.
 * May return the value or a PromiseLike of it. `initialize()` unwraps the promise.
 */
export type Factory<T> = (context: FactoryContext) => T | PromiseLike<T>;

/**
 * A provider can be a class constructor or a factory function.
 */
export type Provider<T> = Constructor<T> | Factory<T>;

export type DependencyRef =
  | Token<unknown>
  | { readonly all: Token<unknown> };

export type RootRef = DependencyRef;

export type Optimization =
  | { mode?: 'open'; roots?: never; eager?: never }
  | {
      mode: 'closed';
      roots: readonly RootRef[];
      eager?: readonly RootRef[];
    };

export type RuntimeProfile = { profile?: 'full' | 'minimal' };

export type BuilderCapabilities = {
  optimization?: Optimization;
  runtime?: RuntimeProfile;
};

/** The two runtime profiles. */
export type Profile = 'full' | 'minimal';

/** What a scope of the profile `P` adds to {@link CoreContainer}: test overrides and resolve events on the full profile. */
interface FullMembers extends Omit<Container, keyof CoreContainer> {}

/**
 * The members both profiles share, for a scope bound to its inputs. `createScope` asks for new values: a scope never
 * copies the values of the one it comes from.
 */
interface BoundCore<I extends readonly InputToken[], P extends Profile> extends Omit<CoreContainer, 'createScope'> {
  /**
   * Returns a child bound to `values`. Every declared input is given once, in any order; an unknown or repeated
   * token is refused at run time. The values are borrowed: the scope never disposes them.
   */
  createScope<const E extends readonly InputEntry[]>(...args: ScopeArguments<I, E>): BoundContainer<I, P>;
}

/**
 * A scope bound to the values of its inputs. It has the API of its profile: {@link CoreContainer} for `'minimal'`,
 * {@link Container} for `'full'`, except that `createScope` asks for values.
 */
export type BoundContainer<I extends readonly InputToken[] = readonly [], P extends Profile = 'full'> =
  BoundCore<I, P> & (P extends 'full' ? FullMembers : unknown);

/**
 * What a builder that declares `scopeInputs` returns: the model of its scopes. It can create scopes and be destroyed,
 * nothing else. Its `resolve` and `initialize` are not typed: called from untyped code, they throw
 * `NEO_SCOPE_INPUTS_UNBOUND`, which names the missing inputs, and the model stays usable.
 */
export interface ContainerTemplate<I extends readonly InputToken[], P extends Profile> extends AsyncDisposalMembers {
  createScope<const E extends readonly InputEntry[]>(...args: ScopeArguments<I, E>): BoundContainer<I, P>;
  destroy(): Promise<void>;
}

type ProfileOf<C> = C extends { runtime: { profile: 'minimal' } } ? 'minimal' : 'full';

type WithoutInputs<C> =
  C extends { runtime: { profile: 'minimal' } }
    ? CoreContainer
    : Container;

/**
 * Minimal profile when `runtime.profile` is the literal `'minimal'`.
 * Anything else, including a missing profile, is the full {@link Container}.
 * A literal, non-empty `scopeInputs` makes it a {@link ContainerTemplate} of that profile instead: the builder
 * is the model of its scopes, not a container that resolves. An empty list is no input.
 */
export type ContainerFor<C> =
  C extends { scopeInputs: infer I extends readonly InputToken[] }
    ? I extends readonly []
      ? WithoutInputs<C>
      : ContainerTemplate<I, ProfileOf<C>>
    : WithoutInputs<C>;

/**
 * A profile is decidable only as `'full'`, `'minimal'`, or the `undefined`
 * literal (the default full profile). An optional profile, any other union,
 * or a `runtime` that includes `undefined` is rejected. Falling through to
 * Container would hide that. A missing `runtime` or a missing `profile` key
 * is the full profile.
 */
type UndecidableProfile = never;

type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

type DecideProfile<R> =
  'profile' extends keyof R
    ? Exact<R['profile'], undefined> extends true
      ? unknown
      : Exact<R['profile'], 'full'> extends true
        ? unknown
        : Exact<R['profile'], 'minimal'> extends true
          ? unknown
          : UndecidableProfile
    : unknown;

type DecideRuntime<R> =
  Exact<R, undefined> extends true
    ? unknown
    : undefined extends R
      ? UndecidableProfile
      : DecideProfile<R>;

type LiteralProfile<C> =
  'runtime' extends keyof C
    ? DecideRuntime<C['runtime']>
    : unknown;

/**
 * `scopeInputs` is decidable only as a tuple the checker can count (`[a, b]`, `[]`) or as absent. An optional member
 * or a list of unknown length (`readonly InputToken[]`) is rejected: falling through to a plain container would hide
 * that the builder has inputs.
 */
type LiteralInputs<C> =
  'scopeInputs' extends keyof C
    ? undefined extends C['scopeInputs']
      ? UndecidableProfile
      : C['scopeInputs'] extends readonly InputToken[]
        ? number extends C['scopeInputs']['length']
          ? UndecidableProfile
          : unknown
        : unknown
    : unknown;

type EnsureFactory<E> =
  E extends { useFactory: true; token: Token<infer T>; provider: infer P }
    ? [P] extends [Factory<T>]
      ? unknown
      : never
    : unknown;

/**
 * An alias keeps no registration option of its own, and the value of its target must be the value of its token. The
 * target is a token, so the check reads the values the two tokens carry: a class instance, the `T` of
 * `useInterface<T>()`. `provider`, `useFactory`, `useValue`, `lifecycle`, `ownership`, `multi` and `dependencies` are
 * refused here too: a union of injections would otherwise accept an alias that is also another variant.
 */
type EnsureAlias<E> =
  E extends { useExisting: infer U extends Token<unknown>; token: infer T extends Token<unknown> }
    ? E extends
      | { provider: unknown }
      | { useFactory: unknown }
      | { useValue: unknown }
      | { lifecycle: unknown }
      | { ownership: unknown }
      | { multi: unknown }
      | { dependencies: unknown }
      ? never
      : [ValueOf<U>] extends [ValueOf<T>]
        ? unknown
        : never
    : unknown;

type EnsureInjection<E> = [EnsureFactory<E>] extends [never] ? never : EnsureAlias<E>;

type InvalidInjectionIndices<I extends readonly unknown[]> = {
  [K in keyof I]: [EnsureInjection<I[K]>] extends [never] ? K : never
}[number];

type InjectionsOk<I> = I extends readonly unknown[]
  ? [InvalidInjectionIndices<I>] extends [never] ? unknown : never
  : unknown;

type InjectionSites<I> = {
  [K in keyof I]: [EnsureInjection<I[K]>] extends [never] ? never : I[K]
};

type InjectionGuard<C> =
  C extends { injections: infer I extends readonly unknown[] }
    ? [InvalidInjectionIndices<I>] extends [never]
      ? InjectionsOk<I>
      : { readonly injections: InjectionSites<I> }
    : unknown;

/**
 * Definition of a single injection.
 * The five shapes are disjoint: autowire, class for a token, factory, useValue, or an alias (`useExisting`).
 * Optional `never` keys reject the other shape's fields on a widened value too.
 */
export type Injection<T = unknown> =
  | {
      token: Constructor<T>;
      lifecycle?: Lifecycle;
      scoped?: boolean;
      multi?: boolean;
      provider?: never;
      useValue?: never;
    }
  | {
      token: Token<T>;
      provider: Constructor<T>;
      lifecycle?: Lifecycle;
      scoped?: boolean;
      multi?: boolean;
      useValue?: never;
    }
  | {
      token: Token<T>;
      provider: Factory<T>;
      useFactory: true;
      dependencies?: readonly DependencyRef[];
      lifecycle?: Lifecycle;
      scoped?: boolean;
      multi?: boolean;
      ownership?: 'owned' | 'borrowed';
      useValue?: never;
    }
  | {
      token: InterfaceToken<T> | PropertyToken<T, unknown>;
      useValue: T;
      lifecycle?: Lifecycle;
      scoped?: boolean;
      ownership?: 'borrowed';
      provider?: never;
      useFactory?: never;
    }
  | {
      token: Token<T>;
      useExisting: Token<T>;
      scoped?: boolean;
      provider?: never;
      useFactory?: never;
      useValue?: never;
      lifecycle?: never;
      ownership?: never;
      multi?: never;
      dependencies?: never;
    };

/**
 * An alias: `token` answers what `useExisting` answers. It is the object a registration `{ token, useExisting }`
 * is checked against, and it names the shape in your own code. The pair is valid when the value of the target is
 * assignable to the value of the token (a class instance, the `T` of `useInterface<T>()`): a subtype is accepted.
 * An alias has no provider, factory, value, lifecycle, ownership, dependency list or `multi`: it owns nothing, the
 * target keeps its lifecycle and its owner. `scoped` is allowed.
 *
 * @example
 * ```typescript
 * const logger: Alias<typeof loggerToken, typeof ConsoleLogger> = {
 *   token: loggerToken,
 *   useExisting: ConsoleLogger,
 * };
 * ```
 */
export type Alias<T extends Token<unknown>, U extends Token<unknown>> = {
  readonly token: T;
  readonly useExisting: U;
  readonly scoped?: boolean;
  readonly provider?: never;
  readonly useFactory?: never;
  readonly useValue?: never;
  readonly lifecycle?: never;
  readonly ownership?: never;
  readonly multi?: never;
  readonly dependencies?: never;
} & ([ValueOf<U>] extends [ValueOf<T>] ? unknown : never);

/**
 * `useValue` is only valid for an interface or property token. A class token
 * with `useValue` is rejected at build time (`TypeMismatchError`): register a
 * factory that returns the instance instead. `multi` applies to a class or a
 * factory, not to `useValue`. `scoped: true` replaces a parent registration
 * in this container only. `dependencies` on a factory stays optional.
 *
 * Partial configuration that can be shared/extended.
 */
export interface PartialConfig {
  injections?: readonly Injection[];
  /**
   * Declares tokens this partial expects to be provided by its host container.
   *
   * Use when a partial's injections depend on tokens registered elsewhere
   * (e.g. in a shared kernel or parent container). Declaring them in `expects`
   * suppresses false-positive "missing dependency" errors during partial
   * validation and documents the partial's external contract.
   *
   * Accepts the same token expressions as `token:` in an injection:
   * - `useInterface<T>()` for interface tokens
   * - A class constructor for class tokens
   *
   * The host `defineBuilderConfig` must provide all declared tokens either
   * in its own `injections` or via `useContainer` / other `extends`.
   *
   * @example
   * ```typescript
   * export const userPartial = definePartialConfig({
   *   expects: [
   *     useInterface<ICacheClient>(),
   *     useInterface<ITokenService>(),
   *   ],
   *   injections: [
   *     { token: Login },
   *     { token: Register },
   *   ]
   * });
   * ```
   */
  expects?: readonly Token<unknown>[];
}

/**
 * Main configuration for a container builder.
 */
export interface BuilderConfig extends PartialConfig, BuilderCapabilities {
  name?: string;
  /**
   * The values each scope of this builder is given by `createScope({ values })`: a literal list of interface and
   * property tokens (`useInterface<T>()`, `useProperty(...)`). Every input is required, the values are borrowed, and
   * the builder becomes a {@link ContainerTemplate}: it creates scopes, it does not resolve. Not available in a
   * partial in this version.
   */
  scopeInputs?: readonly InputToken[];
  extends?: readonly PartialConfig[];
  /**
   * Parent container instance to bridge with this container.
   * Accepts any NeoSyringe container (sync or async) or a legacy token map
   * produced by `declareContainerTokens`.
   */
  useContainer?: CoreContainer | Record<string, unknown>;
}

/**
 * @deprecated AsyncContainer adds no method. It aliases {@link CoreContainer},
 * so a minimal profile stays assignable. `initialize` lives on CoreContainer.
 * The alias stays exported so existing imports keep compiling.
 *
 * @example
 * ```typescript
 * const container: AsyncContainer = defineBuilderConfig({ ... });
 * await container.initialize();
 * const db = container.resolve(useInterface<IDatabase>());
 * ```
 */
export interface AsyncContainer extends CoreContainer {}

/** A service that can release resources when the container is destroyed. */
export interface IDisposable {
  dispose(): void;
}

/** A service that releases resources asynchronously when the container is destroyed. */
export interface IAsyncDisposable {
  dispose(): Promise<void>;
}

/**
 * Runtime helper to define a partial configuration.
 */
export function definePartialConfig(config: PartialConfig): PartialConfig {
  return config;
}

/**
 * Runtime helper to define the main builder configuration.
 * This function is replaced at compile-time by the generated container.
 *
 * The first overload is a trap (`never`). It never accepts a real argument.
 * A rejected call still types as {@link Container}, so `on` / `override` are
 * not a second diagnostic. The winning overload keeps `_config: C` intersected
 * only with {@link InjectionGuard}. `LiteralProfile<C>` and `LiteralInputs<C>` stay on the constraint:
 * putting that conditional on the parameter drops contextual typing of factory
 * callbacks (`provider: context => ...` would be implicit any).
 *
 * @throws {Error} If called at runtime without the build plugin.
 */
export function defineBuilderConfig(
  _config: never,
): Container;
export function defineBuilderConfig<
  const C extends BuilderConfig & LiteralProfile<C> & LiteralInputs<C>,
>(
  _config: C & InjectionGuard<C>,
): ContainerFor<C>;
export function defineBuilderConfig<const C extends BuilderConfig>(
  _config: C,
): ContainerFor<C> {
  throw new Error(
    'NeoSyringe: defineBuilderConfig() called at runtime. ' +
    'This library requires the compiler plugin to generate the container. ' +
    'Ensure the plugin is configured in your build system (Vite, Rollup, Webpack).'
  );
}

/**
 * Runtime helper to create an interface token.
 * This function is replaced at compile-time by a unique ID.
 *
 * **Scope: by type declaration, not by call site.** The generated token ID is
 * derived from where the interface *type* `T` is declared (its symbol + declaring
 * source file) — not from where `useInterface<T>()` is called. Calling
 * `useInterface<SomePort>()` in three different files, for the same `SomePort`
 * interface, produces the exact same token in all three. This is what makes it
 * possible to `provider`-register a token in one file and `container.resolve(...)`
 * it from a completely different one (see the "Composing across modules" guide).
 *
 * **This is a technical fact, not a file-layout requirement.** You can call
 * `useInterface<T>()` anywhere in your codebase. Confining a module's
 * `defineBuilderConfig` + `useInterface` calls to one composition-root file per
 * module is a *recommended convention* for readability (one obvious place to see
 * everything a module wires up) — it is not something the compiler enforces or
 * needs.
 *
 * @throws {Error} If called at runtime without compilation.
 */
export function useInterface<T>(): InterfaceToken<T> {
  throw new Error('NeoSyringe: useInterface<T>() called at runtime. The build plugin is missing.');
}

/**
 * Creates a property token for injecting primitive values into class constructors.
 * The token is bound to a specific class and parameter name for type-safety.
 *
 * Only `T` (the primitive type) needs to be provided explicitly — `C` is inferred
 * from the `targetClass` argument and rarely needs to be specified.
 *
 * @template T - The primitive type (`string`, `number`, `boolean`, etc.)
 * @template C - The class constructor type. **Inferred** from `targetClass`; almost never explicit.
 *
 * @example
 * ```typescript
 * // T is explicit, C is inferred from the class argument
 * const secret = useProperty<string>(JwtService, 'secret');
 * const ttl = useProperty<number>(JwtService, 'ttl');
 *
 * defineBuilderConfig({
 *   injections: [
 *     { token: secret, provider: () => process.env.JWT_SECRET },
 *     { token: ttl, provider: () => 3600 },
 *     { token: useInterface<TokenService>(), provider: JwtService }
 *   ]
 * });
 * ```
 *
 * @throws {Error} If called at runtime without the build plugin.
 */
export function useProperty<T, C extends Constructor<unknown> = Constructor<unknown>>(
  targetClass: C,
  paramName: string
): PropertyToken<T, InstanceType<C>> {
  throw new Error(
    `NeoSyringe: useProperty(${targetClass.name}, '${paramName}') called at runtime. The build plugin is missing.`
  );
}

/**
 * Declares the tokens provided by a legacy container.
 * This is a type-level helper; it returns the container instance as-is at runtime.
 *
 * Unvalidated trust boundary: `T` is not checked against the runtime value.
 * A lying annotation still compiles. Callers own that claim.
 *
 * @template T - A map of Token -> Type provided by the container.
 * @param container - The legacy container instance.
 */
export function declareContainerTokens<T extends Record<string, any>>(container: any): T {
  return container;
}

