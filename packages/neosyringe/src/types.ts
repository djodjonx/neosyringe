/**
 * Represents a generic class constructor.
 * @template T - The type of the instance created by the constructor.
 */
export type Constructor<T = any> = new (...args: any[]) => T;

/**
 * Defines the lifecycle of a service.
 * - `singleton`: One instance per container.
 * - `transient`: A new instance every time it is resolved.
 */
export type Lifecycle = 'singleton' | 'transient';

/**
 * Capabilities shared by every generated container, including the minimal profile.
 * `Token` is declared below; the methods only mention it.
 */
export interface CoreContainer {
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

  /** Brings async singletons to ready. Sync containers resolve this immediately. */
  initialize(): Promise<void>;

  /** Disposes singleton services that implement IDisposable/IAsyncDisposable, then clears the instance cache. */
  destroy(): Promise<void>;

  /** Returns a container with the same capability profile. Scope behaviour is not in this build. */
  createScope(): this;
}

/**
 * Full profile. Adds test overrides and resolve events on top of {@link CoreContainer}.
 */
export interface Container extends CoreContainer {
  override<T>(token: Token<T>, factory: () => T): Promise<void>;
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
export type Token<T = any> = Constructor<T> | InterfaceToken<T> | PropertyToken<T, any>;

/**
 * What a factory is allowed to resolve. It is not the full container.
 */
export interface FactoryContext {
  resolve<T>(token: Token<T>): T;
  resolveAll<T>(token: Token<T>): T[];
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

/**
 * Minimal profile when `runtime.profile` is the literal `'minimal'`.
 * Anything else, including a missing profile, is the full {@link Container}.
 */
export type ContainerFor<C> =
  C extends { runtime: { profile: 'minimal' } }
    ? CoreContainer
    : Container;

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

type EnsureFactory<E> =
  E extends { useFactory: true; token: Token<infer T>; provider: infer P }
    ? [P] extends [Factory<T>]
      ? unknown
      : never
    : unknown;

type InjectionsOk<I> =
  I extends readonly unknown[]
    ? number extends I['length']
      ? unknown
      : I extends readonly [infer Head, ...infer Tail]
        ? EnsureFactory<Head> extends never
          ? never
          : InjectionsOk<Tail>
        : unknown
    : unknown;

type InjectionGuard<C> =
  C extends { injections: infer I extends readonly unknown[] }
    ? InjectionsOk<I>
    : unknown;

/**
 * Definition of a single injection.
 * The four shapes are disjoint: autowire, class for a token, factory, or useValue.
 * Optional `never` keys reject the other shape's fields on a widened value too.
 */
export type Injection<T = any> =
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
      useValue?: never;
    }
  | {
      token: InterfaceToken<T> | PropertyToken<T, any>;
      useValue: T;
      lifecycle?: Lifecycle;
      scoped?: boolean;
      provider?: never;
      useFactory?: never;
    };

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
  expects?: readonly Token<any>[];
}

/**
 * Main configuration for a container builder.
 */
export interface BuilderConfig extends PartialConfig, BuilderCapabilities {
  name?: string;
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
 * only with {@link InjectionGuard}. `LiteralProfile<C>` stays on the constraint:
 * putting that conditional on the parameter drops contextual typing of factory
 * callbacks (`provider: context => ...` would be implicit any).
 *
 * @throws {Error} If called at runtime without the build plugin.
 */
export function defineBuilderConfig(
  _config: never,
): Container;
export function defineBuilderConfig<
  const C extends BuilderConfig & LiteralProfile<C>,
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
export function useProperty<T, C extends Constructor<any> = Constructor<any>>(
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
 * @template T - A map of Token -> Type provided by the container.
 * @param container - The legacy container instance.
 */
export function declareContainerTokens<T extends Record<string, any>>(container: any): T {
  return container;
}

