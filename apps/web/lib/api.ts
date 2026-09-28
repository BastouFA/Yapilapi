import { ApiError, createClient } from '@yapilapi/api-client';
import { t } from '@yapilapi/shared';
import { dataSaverHeaders, prepareUpload } from './data-saver';

// On Data saver every request says Save-Data: on, so the API leaves out large photo sizes,
// and photos are made smaller in the browser before they upload.
export const api = createClient({ baseUrl: '/api', headers: dataSaverHeaders, prepareUpload });
export { ApiError };

export const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? 'ws://localhost:4000/v1/realtime';

/**
 * What went wrong, for showing to people. Messages from the API are shown as they come (the API
 * speaks English); ours are in the reader's language, which the app puts on <html lang>.
 */
export function errorMessage(e: unknown): string {
  const locale = typeof document === 'undefined' ? 'en' : document.documentElement.lang || 'en';
  if (e instanceof ApiError) return e.code === 'network' ? t('error.network', locale) : e.message;
  return t('error.generic', locale);
}

export function fieldErrors(e: unknown): Record<string, string> {
  return e instanceof ApiError && e.fields ? e.fields : {};
}
