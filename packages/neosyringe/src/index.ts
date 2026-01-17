/**
 * Neo-Syringe: Zero-Overhead, Compile-Time Dependency Injection
 *
 * @example
 * ```typescript
 * import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';
 *
 * interface ILogger { log(msg: string): void; }
 * class ConsoleLogger implements ILogger { log(msg: string) { console.log(msg); } }
 * class UserService { constructor(private logger: ILogger) {} }
 *
 * export const container = defineBuilderConfig({
 *   injections: [
 *     { token: useInterface<ILogger>(), provider: ConsoleLogger },
 *     { token: UserService }
 *   ]
 * });
 * ```
 */

export * from './types';

