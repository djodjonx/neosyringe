/** Red-commit stub: no factory policy or lease is emitted yet. */
import type { Helper } from './fragments';

export type PolicyMode = 'simple' | 'all';

export interface PolicyEntry {
  readonly keyExpression: string;
  readonly mode: PolicyMode;
}

export function factoryLeaseHelpers(_className: string): Helper[] {
  return [];
}

export function emitFactoryPolicy(_className: string, _factoryId: string, _entries: readonly PolicyEntry[]): string {
  return '';
}
