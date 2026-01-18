/**
 * Request Context
 *
 * A transient service that creates a new instance for each request.
 * Useful for request-scoped data like correlation IDs, timestamps, etc.
 *
 * Lifecycle: TRANSIENT - new instance on every resolve()
 */

export interface IRequestContext {
  readonly requestId: string;
  readonly timestamp: Date;
  readonly metadata: Map<string, unknown>;

  setMetadata(key: string, value: unknown): void;
  getMetadata<T>(key: string): T | undefined;
}

export class RequestContext implements IRequestContext {
  public readonly requestId: string;
  public readonly timestamp: Date;
  public readonly metadata: Map<string, unknown>;

  constructor() {
    this.requestId = crypto.randomUUID();
    this.timestamp = new Date();
    this.metadata = new Map();

    console.log(`[RequestContext] New instance created: ${this.requestId}`);
  }

  setMetadata(key: string, value: unknown): void {
    this.metadata.set(key, value);
  }

  getMetadata<T>(key: string): T | undefined {
    return this.metadata.get(key) as T | undefined;
  }
}

