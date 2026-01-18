/**
 * In-Memory Event Bus Implementation
 * Infrastructure adapter for IEventBus.
 */
import type { IEventBus, DomainEvent, ILogger } from '../../shared-kernel/interfaces';

type EventHandler<T extends DomainEvent = DomainEvent> = (event: T) => void;

export class InMemoryEventBus implements IEventBus {
  private handlers = new Map<string, EventHandler[]>();

  constructor(private readonly logger: ILogger) {}

  publish(event: DomainEvent): void {
    this.logger.debug('Publishing event', { type: event.type });

    const handlers = this.handlers.get(event.type) ?? [];
    for (const handler of handlers) {
      try {
        handler(event);
      } catch (error) {
        this.logger.error('Event handler failed', error as Error, { type: event.type });
      }
    }
  }

  subscribe<T extends DomainEvent>(eventType: string, handler: (event: T) => void): void {
    const handlers = this.handlers.get(eventType) ?? [];
    handlers.push(handler as EventHandler);
    this.handlers.set(eventType, handlers);

    this.logger.debug('Subscribed to event', { type: eventType });
  }
}

