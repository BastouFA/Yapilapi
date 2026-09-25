import { NextResponse, type NextRequest } from 'next/server';

const readEnv = (key: string) => process.env[key]?.trim() || undefined;

/**
 * Per-request CSP with a nonce (no 'unsafe-inline' / 'unsafe-eval' for scripts in production) and a header that tells
 * server components which path is being rendered (used by the auth guard for the `next` redirect). The console loads
 * nothing from third parties: it talks to its own origin and the API origin only.
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

  const csp = [
    `default-src 'self'`,
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ''}`,
    `style-src 'self'${dev ? " 'unsafe-inline'" : ''}`,
    `img-src 'self' data:`,
    `font-src 'self'`,
    `connect-src 'self' ${apiOrigin}${dev ? ' ws: wss:' : ''}`.trim(),
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
