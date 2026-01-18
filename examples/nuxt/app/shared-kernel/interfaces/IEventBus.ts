/**
 * Shared Kernel - IEventBus Interface
 * Domain events communication across bounded contexts.
 */
export interface DomainEvent {
  readonly type: string;
  readonly occurredAt: Date;
  readonly payload: unknown;
}

export interface IEventBus {
  publish(event: DomainEvent): void;
  subscribe<T extends DomainEvent>(eventType: string, handler: (event: T) => void): void;
}

