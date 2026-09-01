/* DLT · domain/errors.ts — one error type, one place status codes are decided.
 * WRITTEN, NOT EXECUTED. */

export type ErrorCode =
  | 'VALIDATION' | 'INVALID' | 'UNAUTHENTICATED' | 'INVALID_CREDENTIALS'
  | 'FORBIDDEN' | 'NOT_FOUND' | 'CONFLICT' | 'RATE_LIMITED' | 'INTERNAL';

/** A failure the caller is allowed to see. Anything thrown that is NOT an
 *  AppError is a bug, and the HTTP layer turns it into a generic 500 without
 *  disclosing its message. */
export class AppError extends Error {
  /* A plain field, not a `public readonly` constructor parameter property:
   * parameter properties are non-erasable syntax, which `erasableSyntaxOnly`
   * and Node's `--experimental-strip-types` both reject. The public shape is
   * unchanged — a readonly `code` set once at construction. */
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = 'AppError';
    this.code = code;
  }
}
