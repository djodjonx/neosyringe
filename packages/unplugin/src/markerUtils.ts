/**
 * Returns true if the source text contains any NeoSyringe API marker.
 * Used as a fast pre-filter to skip files that cannot contain container
 * definitions or injection sites, avoiding unnecessary tsconfig loading
 * and TypeScript program creation.
 */
export function hasNeoSyringeMarkers(code: string): boolean {
  return code.includes('defineBuilderConfig') || code.includes('useInterface');
}
