import 'server-only';
import { cookies } from 'next/headers';
import { ApiError, createApiClient, type AdminMe, type SelfUser } from '@yapilapi/api-client';
import { getServerApiUrl, getSessionCookieName } from './env';

export type ServerSession =
  | { status: 'ok'; admin: AdminMe; user: SelfUser }
  | { status: 'anonymous' }
  /** Signed in as staff but the session has not passed MFA (the API refuses every staff route). */
  | { status: 'mfa_required' }
  /** Signed in, but not a staff account. */
  | { status: 'forbidden'; user: SelfUser }
  | { status: 'unavailable'; requestId: string | null };

/**
 * Server-verified staff session: forwards the browser's httpOnly cookie to GET /v1/auth/me and GET /v1/admin/me.
 * Only a real 401 means "signed out"; a network error or 5xx is `unavailable`, so an API outage never logs staff out.
 * This is a convenience gate for rendering: the API re-checks role and MFA on every request.
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
    const { user } = await api.auth.me({ skipUnauthorizedHook: true });
    if (user.platformRole === 'user') return { status: 'forbidden', user };
    try {
      return { status: 'ok', admin: await api.admin.me({ skipUnauthorizedHook: true }), user };
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) return { status: 'mfa_required' };
      throw err;
    }
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return { status: 'anonymous' };
    return { status: 'unavailable', requestId: err instanceof ApiError ? err.requestId : null };
  }
}
