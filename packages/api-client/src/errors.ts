/** Stable machine-readable codes the API returns (mirrors @yapilapi/shared ErrorCode) plus client-side ones. */
export type ApiErrorCode =
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
  | 'internal'
  /** Client-side: the request never produced an HTTP response (offline, DNS, CORS, timeout). */
  | 'network_error'
  | 'timeout'
  /** Client-side: the server answered with something that is not the documented JSON error shape. */
  | 'bad_response';

export interface FieldIssue {
  path: string;
  message: string;
}

export class ApiError extends Error {
  override readonly name = 'ApiError';
  constructor(
    readonly code: ApiErrorCode | (string & {}),
    message: string,
    readonly status: number,
    readonly requestId: string | null = null,
    readonly details: unknown = undefined,
    /** Seconds to wait before retrying, from the Retry-After header (429 responses). */
    readonly retryAfterSec: number | null = null,
  ) {
    super(message);
  }

  /** Per-field validation problems when the API supplied them (`details.issues`). */
  get issues(): FieldIssue[] {
    const d = this.details as { issues?: unknown } | undefined;
    if (!d || !Array.isArray(d.issues)) return [];
    return d.issues.filter(
      (i): i is FieldIssue =>
        typeof (i as FieldIssue)?.path === 'string' &&
        typeof (i as FieldIssue)?.message === 'string',
    );
  }

  is(code: ApiErrorCode): boolean {
    return this.code === code;
  }

  get isUnauthenticated(): boolean {
    return this.status === 401 && this.code === 'unauthenticated';
  }

  /** Worth retrying automatically (transient). */
  get retryable(): boolean {
    return (
      this.code === 'network_error' ||
      this.code === 'timeout' ||
      this.status === 429 ||
      this.status >= 500
    );
  }
}

export const isApiError = (e: unknown): e is ApiError => e instanceof ApiError;
