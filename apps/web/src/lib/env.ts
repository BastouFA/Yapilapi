/**
 * Runtime configuration. Values are read through computed keys on purpose: Next.js inlines
 * `process.env.NEXT_PUBLIC_*` literals at build time, which would freeze the API URL into the build. Reading at
 * request time lets one build run against any environment. Nothing secret lives here: only public origins.
 */
const read = (key: string): string | undefined => {
  const v = process.env[key];
  return v && v.trim() ? v.trim() : undefined;
};

/** Browser-facing API origin (the browser talks to the API directly and sends the httpOnly session cookie). */
export function getPublicApiUrl(): string {
  return (read('NEXT_PUBLIC_API_URL') ?? 'http://localhost:4000').replace(/\/+$/, '');
}

/** Origin the Next.js *server* uses to reach the API (may be an internal address). Defaults to the public URL. */
export function getServerApiUrl(): string {
  return (read('API_INTERNAL_URL') ?? getPublicApiUrl()).replace(/\/+$/, '');
}

/** Name of the API's session cookie (must match the API's SESSION_COOKIE_NAME). */
export function getSessionCookieName(): string {
  return read('SESSION_COOKIE_NAME') ?? 'yl_session';
}
