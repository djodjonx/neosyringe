// Shape of the generated provider. The measure script does not read this file.
// It writes a 500-method class into the build directory (scripts/measure-chunk-split.mjs).
export const HEAVY_SENTINEL = 'CHUNK_SPLIT_HEAVY';

export class Heavy {
  tag(): string {
    return HEAVY_SENTINEL;
  }
}
