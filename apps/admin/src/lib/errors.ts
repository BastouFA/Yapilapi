import { ApiError } from '@yapilapi/api-client';
import type { T } from '@/i18n';

export interface DescribedError {
  message: string;
  /** Request id from the API: staff always get it, so a failure can be traced in the audit log and server logs. */
  requestId: string | null;
  code: string;
  status: number;
  /** Per-field problems from the API keyed by field path. */
  fields: Record<string, string>;
}

/** Turn any thrown value into localised copy. The API's own message is included for 4xx errors (specific and actionable for staff). */
export function describeError(err: unknown, t: T): DescribedError {
  if (!(err instanceof ApiError))
    return { message: t('error.generic'), requestId: null, code: 'unknown', status: 0, fields: {} };
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
    case 'feature_disabled':
      message = t('error.featureDisabled');
      break;
    case 'internal':
    case 'bad_response':
      message = t('error.server');
      break;
    default:
      if (err.status >= 500) message = t('error.server');
      else if (err.status === 403)
        message = err.message
          ? t('error.forbiddenWith', { message: err.message })
          : t('error.forbidden');
      else message = err.message || t('error.generic');
  }
  const first = Object.entries(fields)[0];
  if ((first && err.status === 422) || (first && err.code === 'validation_failed'))
    message = `${message} (${first[0]}: ${first[1]})`;
  return { message, requestId: err.requestId, code: err.code, status: err.status, fields };
}
