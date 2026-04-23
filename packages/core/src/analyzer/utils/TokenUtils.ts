import type { TokenId } from '../types';

/**
 * Extracts the human-readable name from a token ID.
 *
 * Token IDs can have several forms:
 * - "IEventBus_714d1af6" -> "IEventBus"
 * - "useInterface<ILogger>()" -> "ILogger"
 * - "UserService" -> "UserService" (no suffix, returned as-is)
 *
 * @param tokenId - The raw token identifier
 * @returns The simplified display name
 */
export function getSimpleName(tokenId: TokenId): string {
  const interfaceMatch = tokenId.match(/useInterface<([^>]+)>/);
  if (interfaceMatch) {
    return interfaceMatch[1].split('_')[0];
  }
  const parts = tokenId.split('_');
  if (parts.length > 1) {
    const lastPart = parts[parts.length - 1];
    if (/^[a-f0-9]{6,12}$/i.test(lastPart)) {
      return parts.slice(0, -1).join('_');
    }
  }
  return tokenId;
}
