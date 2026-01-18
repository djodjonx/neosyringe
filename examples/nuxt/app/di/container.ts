/**
 * Main Application Container
 *
 * Single container with all services for the application.
 * Neo-Syringe transforms this file at build time.
 *
 * Lifecycle modes:
 * - singleton (default): One instance shared across the app
 * - transient: New instance created on every resolve()
 */
import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';

// Shared Kernel interfaces
import type { ILogger, IEventBus } from '../shared-kernel/interfaces';
import { ConsoleLogger, InMemoryEventBus } from '../infrastructure/services';

// Shared Kernel services (transient examples)
import type { IRequestContext, IOperationTracker } from '../shared-kernel/services';
import { RequestContext, OperationTracker } from '../shared-kernel/services';

// User domain
import type { IUserRepository } from '../domain/user/repositories';
import { UserService } from '../domain/user/services';
import { InMemoryUserRepository } from '../infrastructure/repositories';

// Product domain
import type { IProductRepository } from '../domain/product/repositories';
import { ProductService } from '../domain/product/services';
import { InMemoryProductRepository } from '../infrastructure/repositories';

export const TOKENS = {
  IRequestContext: useInterface<IRequestContext>(),
  IOperationTracker: useInterface<IOperationTracker>(),
}
/**
 * Application container with all services registered.
 *
 * At build time, Neo-Syringe replaces this with generated factory code.
 * The resolve() calls become direct instantiations - zero runtime overhead!
 */
export const appContainer = defineBuilderConfig({
  name: 'AppContainer',
  injections: [
    // ============================================================
    // SINGLETON SERVICES (default lifecycle)
    // One instance shared across the entire application
    // ============================================================

    // Shared Kernel - Cross-cutting concerns
    { token: useInterface<ILogger>(), provider: ConsoleLogger },
    { token: useInterface<IEventBus>(), provider: InMemoryEventBus },

    // User Bounded Context
    { token: useInterface<IUserRepository>(), provider: InMemoryUserRepository },
    { token: UserService },

    // Product Bounded Context
    { token: useInterface<IProductRepository>(), provider: InMemoryProductRepository },
    { token: ProductService },

    // ============================================================
    // TRANSIENT SERVICES (lifecycle: 'transient')
    // New instance created on every resolve() call
    // ============================================================

    // RequestContext: Each request gets unique ID and timestamp
    {
      token: TOKENS.IRequestContext,
      provider: RequestContext,
      lifecycle: 'transient'
    },

    // OperationTracker: Track individual operations with unique IDs
    {
      token: TOKENS.IOperationTracker,
      provider: OperationTracker,
      lifecycle: 'transient'
    }
  ]
});

