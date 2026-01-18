/**
 * Operation Tracker
 *
 * A transient service for tracking individual operations.
 * Each operation gets its own tracker instance.
 *
 * Lifecycle: TRANSIENT - new instance on every resolve()
 */
import type { ILogger } from '../interfaces';

export interface IOperationTracker {
  readonly operationId: string;
  readonly startTime: Date;

  start(name: string): void;
  complete(): { duration: number; name: string };
  fail(error: Error): void;
}

export class OperationTracker implements IOperationTracker {
  public readonly operationId: string;
  public readonly startTime: Date;
  private operationName: string = '';
  private completed: boolean = false;

  constructor(private readonly logger: ILogger) {
    this.operationId = `op_${crypto.randomUUID().slice(0, 8)}`;
    this.startTime = new Date();

    this.logger.debug('OperationTracker created', { operationId: this.operationId });
  }

  start(name: string): void {
    this.operationName = name;
    this.logger.info(`Operation started: ${name}`, { operationId: this.operationId });
  }

  complete(): { duration: number; name: string } {
    if (this.completed) {
      throw new Error('Operation already completed');
    }

    this.completed = true;
    const duration = Date.now() - this.startTime.getTime();

    this.logger.info(`Operation completed: ${this.operationName}`, {
      operationId: this.operationId,
      duration: `${duration}ms`
    });

    return { duration, name: this.operationName };
  }

  fail(error: Error): void {
    this.completed = true;
    const duration = Date.now() - this.startTime.getTime();

    this.logger.error(`Operation failed: ${this.operationName}`, error, {
      operationId: this.operationId,
      duration: `${duration}ms`
    });
  }
}

