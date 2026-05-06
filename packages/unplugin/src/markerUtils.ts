export function hasNeoSyringeMarkers(code: string): boolean {
  return code.includes('defineBuilderConfig') || code.includes('useInterface');
}
