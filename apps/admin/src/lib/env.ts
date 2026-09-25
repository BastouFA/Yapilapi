/**
 * Runtime configuration, read through computed keys so `next build` does not freeze the API origin into the bundle.
 * Only public origins live here; nothing is secret.
 */
const read = (key: string): string | undefined => {
  const v = process.env[key];
  return v && v.trim() ? v.trim() : undefined;
};

/** Browser-facing API origin (the browser talks to the API directly and sends the httpOnly session cookie). */
export function getPublicApiUrl(): string {
  return (read('NEXT_PUBLIC_API_URL') ?? 'http://localhost:4000').replace(/\/+$/, '');
}

/** Origin the Next.js server uses to reach the API (may be an internal address). Defaults to the public URL. */
export function getServerApiUrl(): string {
  return (read('API_INTERNAL_URL') ?? getPublicApiUrl()).replace(/\/+$/, '');
}

/** Name of the API's session cookie (must match the API's SESSION_COOKIE_NAME). */
export function getSessionCookieName(): string {
  return read('SESSION_COOKIE_NAME') ?? 'yl_session';
}
