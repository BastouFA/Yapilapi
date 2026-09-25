/** Stable, machine-readable error codes returned by the API. */
export type ErrorCode =
  | 'validation_failed'
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'rate_limited'
  | 'csrf_failed'
  | 'mfa_required'
  | 'account_locked'
  | 'feature_disabled'
  | 'payment_failed'
  | 'payment_required'
  | 'unprocessable'
  | 'unavailable'
  | 'internal';

const STATUS: Record<ErrorCode, number> = {
  validation_failed: 400,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  unprocessable: 422,
  rate_limited: 429,
  csrf_failed: 403,
  mfa_required: 401,
  account_locked: 423,
  feature_disabled: 404,
  payment_failed: 402,
  payment_required: 402,
  unavailable: 503,
  internal: 500,
};

export class AppError extends Error {
  readonly status: number;
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
    this.status = STATUS[code];
  }
}

export const notFound = (what = 'Resource') => new AppError('not_found', `${what} not found`);
export const forbidden = (msg = 'You are not allowed to do that') => new AppError('forbidden', msg);
export const unauthenticated = (msg = 'Authentication required') =>
  new AppError('unauthenticated', msg);
export const conflict = (msg: string, details?: unknown) => new AppError('conflict', msg, details);
export const invalid = (msg: string, details?: unknown) =>
  new AppError('validation_failed', msg, details);
