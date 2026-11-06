// Registered in app.ts, reachable from no root. The closed bundle must not carry it.
export const HEAVY_SENTINEL = 'T21_SENTINEL_UNREACHABLE';

export class Heavy {
  tag(): string {
    return HEAVY_SENTINEL;
  }
}
