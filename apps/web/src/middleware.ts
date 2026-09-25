import { NextResponse, type NextRequest } from 'next/server';

const readEnv = (key: string) => process.env[key]?.trim() || undefined;

/**
 * Per-request CSP with a nonce (no 'unsafe-inline' / 'unsafe-eval' for scripts in production) and a header that
 * tells server components which path is being rendered (used by the auth guard for the `next` redirect).
 */
export function middleware(req: NextRequest) {
  const nonce = btoa(crypto.randomUUID());
  const dev = process.env.NODE_ENV !== 'production';
  const api = (readEnv('NEXT_PUBLIC_API_URL') ?? 'http://localhost:4000').replace(/\/+$/, '');
  const apiOrigin = (() => {
    try {
      return new URL(api).origin;
    } catch {
      return '';
    }
  })();

  // The realtime WebSocket connects to the API origin over ws:// or wss:// (same host as the API).
  const wsOrigin = apiOrigin.replace(/^http/, 'ws');

  const csp = [
    `default-src 'self'`,
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ''}`,
    // Dev-only: Next's dev overlay injects inline styles. Production styles are all external files.
    `style-src 'self'${dev ? " 'unsafe-inline'" : ''}`,
    `img-src 'self' data: blob: https: ${apiOrigin}`.trim(),
    `media-src 'self' blob: https: ${apiOrigin}`.trim(),
    `font-src 'self'`,
    `connect-src 'self' ${apiOrigin} ${wsOrigin}${dev ? ' ws: wss:' : ''}`.trim(),
    `object-src 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `frame-ancestors 'none'`,
  ].join('; ');

  const headers = new Headers(req.headers);
  headers.set('x-nonce', nonce);
  headers.set('content-security-policy', csp);
  headers.set('x-yl-path', req.nextUrl.pathname + req.nextUrl.search);
  const res = NextResponse.next({ request: { headers } });
  res.headers.set('content-security-policy', csp);
  return res;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|icon.svg).*)'],
};
