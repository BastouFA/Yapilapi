import 'server-only';
import { cookies } from 'next/headers';
import { ApiError, createApiClient, type MeResponse } from '@yapilapi/api-client';
import { getServerApiUrl, getSessionCookieName } from './env';

export type ServerSession =
  | { status: 'ok'; me: MeResponse }
  | { status: 'anonymous' }
  | { status: 'unavailable'; requestId: string | null };

/**
 * Server-verified session: forwards the browser's httpOnly session cookie to GET /v1/auth/me.
 * Only a real 401 means "signed out"; a network error or 5xx is reported as `unavailable` so an API outage
 * never silently logs people out or bounces them around.
 */
export async function getServerSession(): Promise<ServerSession> {
  const jar = await cookies();
  const token = jar.get(getSessionCookieName())?.value;
  if (!token) return { status: 'anonymous' };
  const api = createApiClient({
    baseUrl: getServerApiUrl(),
    mode: 'cookie',
    timeoutMs: 8000,
    fetch: (input, init) =>
      fetch(input, {
        ...init,
        cache: 'no-store',
        headers: {
          ...(init?.headers as Record<string, string>),
          cookie: `${getSessionCookieName()}=${token}`,
        },
      }),
  });
  try {
    return { status: 'ok', me: await api.auth.me({ skipUnauthorizedHook: true }) };
  } catch (err) {
    if (err instanceof ApiError && (err.status === 401 || err.status === 403))
      return { status: 'anonymous' };
    return { status: 'unavailable', requestId: err instanceof ApiError ? err.requestId : null };
  }
}
