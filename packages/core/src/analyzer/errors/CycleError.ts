/**
 * Custom error for cycle detection.
 */
export class CycleError extends Error {
  constructor(public readonly chain: string[]) {
    super(`Circular dependency detected: ${chain.join(' -> ')}`);
    this.name = 'CycleError';
  }
}
