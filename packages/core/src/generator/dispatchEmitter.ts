/** Red-commit stub: the shared dispatch table is not emitted yet. */
export type DispatchKind = 'single' | 'list';

export interface DispatchEntry {
  readonly keyExpression: string;
  readonly accessor: string;
}

export function emitDispatchField(
  _className: string,
  _field: string,
  _entries: readonly DispatchEntry[],
  _kind: DispatchKind = 'single',
): string {
  return '';
}

export function emitDispatchRead(_className: string, _field: string, _kind: DispatchKind = 'single'): string {
  return '';
}
