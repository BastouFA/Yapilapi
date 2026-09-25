import { ApiError } from '@yapilapi/api-client';
import type { T } from '../i18n';

/** Localised, user-facing text for any thrown value. API messages (English) are only shown for expected 4xx business errors. */
export function errorMessage(e: unknown, t: T): string {
  if (!(e instanceof ApiError)) return t('error.generic');
  switch (e.code) {
    case 'network_error':
      return t('error.network');
    case 'timeout':
      return t('error.timeout');
    case 'rate_limited':
      return e.retryAfterSec
        ? t('error.rateLimitedIn', { seconds: e.retryAfterSec })
        : t('error.rateLimited');
    case 'unauthenticated':
      return t('error.session');
    case 'account_locked':
      return t('error.locked');
    case 'validation_failed':
      return e.issues[0]?.message ?? t('error.validation');
    case 'not_found':
      return t('error.notFound');
    case 'feature_disabled':
      return t('error.featureOff');
    case 'csrf_failed':
    case 'bad_response':
      return t('error.generic');
    default:
      return e.status >= 400 && e.status < 500 && e.message ? e.message : t('error.generic');
  }
}

/** Per-field problems keyed by the API's field path (`birthDate`, `email`...). */
export function fieldErrors(e: unknown): Record<string, string> {
  if (!(e instanceof ApiError)) return {};
  return Object.fromEntries(e.issues.map((i) => [i.path.split('.')[0] ?? i.path, i.message]));
}

export const isOffline = (e: unknown) =>
  e instanceof ApiError && (e.code === 'network_error' || e.code === 'timeout');
