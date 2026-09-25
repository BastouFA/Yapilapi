import { ApiError } from '@yapilapi/api-client';
import type { T } from '@/i18n';

export interface DescribedError {
  message: string;
  /** Support reference (request id) for unexpected failures. */
  requestId: string | null;
  /** Per-field problems from the API, keyed by field path. */
  fields: Record<string, string>;
  code: string;
  unauthenticated: boolean;
}

/**
 * Turn any thrown value into localised, user-safe copy. The API's own messages are English and are shown only for
 * 4xx errors where they are specific and actionable (e.g. "That username is already taken").
 */
export function describeError(err: unknown, t: T): DescribedError {
  if (!(err instanceof ApiError))
    return {
      message: t('error.generic'),
      requestId: null,
      fields: {},
      code: 'unknown',
      unauthenticated: false,
    };
  const fields: Record<string, string> = {};
  for (const i of err.issues) fields[i.path] ??= i.message;
  let message: string;
  switch (err.code) {
    case 'network_error':
      message = t('error.network');
      break;
    case 'timeout':
      message = t('error.timeout');
      break;
    case 'rate_limited':
      message = err.retryAfterSec
        ? t('error.rateLimitedIn', { seconds: err.retryAfterSec })
        : t('error.rateLimited');
      break;
    case 'csrf_failed':
      message = t('error.csrf');
      break;
    case 'account_locked':
      message = t('error.locked');
      break;
    case 'internal':
    case 'bad_response':
      message = t('error.server');
      break;
    case 'forbidden': {
      const reason = (err.details as { reason?: unknown } | undefined)?.reason;
      message =
        reason === 'teen_friends_only'
          ? t('msgDenied.teen_friends_only')
          : reason === 'recipient_unavailable'
            ? t('msgDenied.recipient_unavailable')
            : reason === 'recipient_preference'
              ? t('msgDenied.recipient_preference')
              : err.message || t('error.generic');
      break;
    }
    default:
      message =
        err.status >= 500
          ? t('error.server')
          : err.status === 401
            ? t('error.unauthenticated')
            : err.message || t('error.generic');
  }
  return {
    message,
    requestId: err.status >= 500 || err.code === 'bad_response' ? err.requestId : null,
    fields,
    code: err.code,
    unauthenticated: err.status === 401,
  };
}
