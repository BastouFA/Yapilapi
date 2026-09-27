import { ApiError, createClient } from '@yapilapi/api-client';
import { dataSaverHeaders, prepareUpload } from './data-saver';

// On Data saver every request says Save-Data: on, so the API leaves out large photo sizes,
// and photos are made smaller in the browser before they upload.
export const api = createClient({ baseUrl: '/api', headers: dataSaverHeaders, prepareUpload });
export { ApiError };

export const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? 'ws://localhost:4000/v1/realtime';

export function errorMessage(e: unknown): string {
  return e instanceof ApiError ? e.message : 'Something went wrong. Try again.';
}

export function fieldErrors(e: unknown): Record<string, string> {
  return e instanceof ApiError && e.fields ? e.fields : {};
}
