import { ApiError, createClient } from '@yapilapi/api-client';
import { t } from '@yapilapi/shared';
import { dataSaverHeaders, prepareUpload } from './data-saver';

// On Data saver every request says Save-Data: on, so the API leaves out large photo sizes,
// and photos are made smaller in the browser before they upload.
export const api = createClient({ baseUrl: '/api', headers: dataSaverHeaders, prepareUpload });
export { ApiError };

export const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? 'ws://localhost:4000/v1/realtime';

const OWN_ERRORS: Record<string, 'error.network' | 'error.processingFailed' | 'error.editFailed' | 'error.slow'> = {
  network: 'error.network',
  processing_failed: 'error.processingFailed',
  edit_failed: 'error.editFailed',
  timeout: 'error.slow',
};

/**
 * What went wrong, for showing to people. Messages from the API are shown as they come (the API
 * speaks English); ours are in the reader's language, which the app puts on <html lang>.
 */
export function errorMessage(e: unknown): string {
  const locale = typeof document === 'undefined' ? 'en' : document.documentElement.lang || 'en';
  if (e instanceof ApiError) {
    // Errors the app itself raises while waiting on a file: in the reader's language.
    const own = OWN_ERRORS[e.code];
    return own ? t(own, locale) : e.message;
  }
  return t('error.generic', locale);
}

/**
 * Whether a failed request means the thing is gone or not for this person (not found, private,
 * removed), rather than that it couldn't load right now (offline, a timeout, a server error).
 */
export const isGone = (e: unknown) => e instanceof ApiError && (e.status === 403 || e.status === 404 || e.status === 410);

export function fieldErrors(e: unknown): Record<string, string> {
  return e instanceof ApiError && e.fields ? e.fields : {};
}

const inFlight = new Map<string, Promise<unknown>>();

/**
 * One request for callers that ask for the same thing at the same moment (the session's unread
 * counts and the inbox page, the sidebar and the home page's suggestions). Once it settles, the
 * next call asks again, so nothing is kept longer than the request itself.
 */
export function sharedRequest<T>(key: string, run: () => Promise<T>): Promise<T> {
  const pending = inFlight.get(key) as Promise<T> | undefined;
  if (pending) return pending;
  const p = run().finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}
