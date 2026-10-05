import type { NextConfig } from 'next';

const API = process.env.API_INTERNAL_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
const dev = process.env.NODE_ENV !== 'production';
// A production build run against an API on this machine (the accessibility checks) serves media over plain http.
const localApi = /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(API);

/** Stripe.js and its card form (https://docs.stripe.com/security/guide#content-security-policy). */
const STRIPE_SCRIPTS = 'https://js.stripe.com https://*.js.stripe.com';

/**
 * What pages may load. Scripts only from this site and Stripe (Next's own inline bootstrap needs
 * 'unsafe-inline'; dev's fast refresh needs eval). Media may come from a storage host or CDN,
 * the realtime socket may be on the API's host, and Mini Apps are iframes on their own https sites.
 * Nothing may frame YAPILAPI, and there are no plugins.
 */
function contentSecurityPolicy(): string {
  const ws = process.env.NEXT_PUBLIC_WS_URL;
  const local = dev || localApi ? ' http://localhost:* http://127.0.0.1:* ws://localhost:* ws://127.0.0.1:*' : '';
  return [
    `default-src 'self'`,
    `script-src 'self' 'unsafe-inline' ${STRIPE_SCRIPTS}${dev ? ` 'unsafe-eval'` : ''}`,
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' data: blob: https:${local}`,
    `media-src 'self' data: blob: https:${local}`,
    `font-src 'self' data:`,
    `connect-src 'self' https: wss:${ws ? ` ${new URL(ws).origin}` : ''}${local}`,
    `frame-src https:${local}`,
    `worker-src 'self' blob:`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `frame-ancestors 'none'`,
  ].join('; ');
}

const config: NextConfig = {
  transpilePackages: ['@yapilapi/design-system', '@yapilapi/shared', '@yapilapi/api-client'],
  // Settings > Help shows the version (pnpm sets npm_package_version when it runs the web app's scripts).
  env: { NEXT_PUBLIC_APP_VERSION: process.env.NEXT_PUBLIC_APP_VERSION || process.env.npm_package_version || '0.1.0' },
  // The browser talks to the API through /api on the same origin, so the
  // session cookie is first-party and httpOnly.
  async rewrites() {
    return [
      { source: '/api/:path*', destination: `${API}/:path*` },
      { source: '/media/:path*', destination: `${API}/media/:path*` },
    ];
  },
  // Share videos print yapilapi.com/@username on their end card.
  async redirects() {
    return [
      { source: '/@:username', destination: '/u/:username', permanent: false },
      // Short links to the policies, for app store listings, emails and printed material.
      ...['terms', 'privacy', 'guidelines', 'cookies', 'copyright'].map((slug) => ({ source: `/${slug}`, destination: `/legal/${slug}`, permanent: false })),
      { source: '/dmca', destination: '/legal/copyright', permanent: false },
    ];
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Content-Security-Policy', value: contentSecurityPolicy() },
          { key: 'Permissions-Policy', value: 'camera=(self), microphone=(self), geolocation=(self)' },
        ],
      },
    ];
  },
};

export default config;
