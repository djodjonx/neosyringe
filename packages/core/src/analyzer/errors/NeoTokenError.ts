/**
 * Identity error raised while a token descriptor is built or claimed.
 * `code` is the stable machine contract. The message names the reason.
 */
export type NeoTokenErrorCode = 'NEO_TOKEN_COLLISION' | 'NEO_TOKEN_UNSUPPORTED';

export class NeoTokenError extends Error {
  readonly code: NeoTokenErrorCode;

  constructor(code: NeoTokenErrorCode, message: string) {
    super(message);
    this.name = 'NeoTokenError';
    this.code = code;
  }
}
