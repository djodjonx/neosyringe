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
 * The dependency injection container interface.
 * Provides access to the registered services.
 */
export interface Container {
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
   * Creates a child container.
   * Child containers can override services from the parent and have their own singleton scope.
   *
   * @returns A new child Container instance.
   */
  createChildContainer(): Container;
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
 * A factory function that creates an instance.
 * Receives the container to resolve dependencies.
 */
export type Factory<T> = (container: Container) => T;

/**
 * A provider can be a class constructor or a factory function.
 */
export type Provider<T> = Constructor<T> | Factory<T>;

/**
 * Definition of a single injection.
 */
export interface Injection<T = any> {
  token: Token<T>;
  provider?: Provider<T>;
  /**
   * If true, the provider is treated as a factory function.
   * Required when provider is a function, not a class.
   */
  useFactory?: boolean;
  /**
   * Lifecycle of the service.
   * - `singleton`: One instance per container (default).
   * - `transient`: A new instance every time it is resolved.
   */
  lifecycle?: Lifecycle;
  /**
   * If true, this injection is scoped to this container only.
   * Allows overriding a token from a parent container without causing a duplicate error.
   * The local instance will be used instead of delegating to the parent.
   *
   * @example
   * ```typescript
   * const parent = defineBuilderConfig({
   *   injections: [{ token: useInterface<ILogger>(), provider: ConsoleLogger }]
   * });
   *
   * const child = defineBuilderConfig({
   *   useContainer: parent,
   *   injections: [
   *     // Override parent's ILogger with a local FileLogger
   *     { token: useInterface<ILogger>(), provider: FileLogger, scoped: true }
   *   ]
   * });
   * ```
   */
  scoped?: boolean;
}

/**
 * Partial configuration that can be shared/extended.
 */
export interface PartialConfig {
  injections?: Injection[];
}

/**
 * Main configuration for a container builder.
 */
export interface BuilderConfig extends PartialConfig {
  name?: string;
  extends?: PartialConfig[];
  /**
   * Parent container instance to bridge (Neo-Syringe or legacy).
   */
  useContainer?: any;
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
 * @throws {Error} If called at runtime without the build plugin.
 */
export function defineBuilderConfig(_config: BuilderConfig): Container {
  throw new Error(
    'neo-syringe: defineBuilderConfig() called at runtime. ' +
    'This library requires the compiler plugin to generate the container. ' +
    'Ensure the plugin is configured in your build system (Vite, Rollup, Webpack).'
  );
}

/**
 * Runtime helper to create an interface token.
 * This function is replaced at compile-time by a unique ID.
 *
 * @throws {Error} If called at runtime without compilation.
 */
export function useInterface<T>(): InterfaceToken<T> {
  throw new Error('neo-syringe: useInterface<T>() called at runtime. The build plugin is missing.');
}

/**
 * Creates a property token for injecting primitive values into class constructors.
 * The token is bound to a specific class and parameter name for type-safety.
 *
 * @example
 * ```typescript
 * const apiUrl = useProperty<string>(ApiService, 'apiUrl');
 *
 * defineBuilderConfig({
 *   injections: [
 *     { token: apiUrl, provider: () => 'http://localhost' },
 *     { token: ApiService }
 *   ]
 * });
 * ```
 *
 * @throws {Error} If called at runtime without compilation.
 */
export function useProperty<T, C extends Constructor<any>>(
  targetClass: C,
  paramName: string
): PropertyToken<T, InstanceType<C>> {
  throw new Error(
    `neo-syringe: useProperty(${targetClass.name}, '${paramName}') called at runtime. The build plugin is missing.`
  );
}

/**
 * Declares the tokens provided by a legacy container.
 * This is a type-level helper; it returns the container instance as-is at runtime.
 *
 * @template T - A map of Token -> Type provided by the container.
 * @param container - The legacy container instance.
 */
export function declareContainerTokens<T extends Record<string, any>>(container: any): T & { [K in keyof T]: T[K] } {
  return container;
}

