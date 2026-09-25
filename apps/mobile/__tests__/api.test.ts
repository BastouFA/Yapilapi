import { ApiError } from '@yapilapi/api-client';
import { createMobileApi } from '../src/api';
import { makeFetch } from './support/harness';

const make = (
  routes: Parameters<typeof makeFetch>[0],
  extra: Partial<Parameters<typeof createMobileApi>[0]> = {},
) => {
  const fetch = makeFetch(routes);
  const api = createMobileApi({
    baseUrl: 'https://api.test/',
    getToken: () => 'tok-1',
    fetch: fetch as never,
    locale: () => 'fr',
    ...extra,
  });
  return { fetch, api };
};

describe('mobile api wrapper', () => {
  it('sends the bearer token and Accept-Language on every request, never cookies/CSRF', async () => {
    const { fetch, api } = make({
      'GET /v1/notifications/unread-count': { json: { total: 2, byCategory: {} } },
    });
    expect(await api.notifications.unreadCount()).toEqual({ total: 2, byCategory: {} });
    const c = fetch.calls[0]!;
    expect(c.headers['authorization']).toBe('Bearer tok-1');
    expect(c.headers['accept-language']).toBe('fr');
    expect(c.headers['x-yl-csrf']).toBeUndefined();
    expect(fetch.mock.calls[0]![1]).not.toHaveProperty('credentials');
  });

  it('requests token delivery for login, register and MFA (deliver:"token")', async () => {
    const { fetch, api } = make({
      'POST /v1/auth/login': { json: { mfaRequired: true, challengeToken: 'c' } },
      'POST /v1/auth/mfa/verify': { json: { user: {}, token: 't', expiresAt: 'x' } },
    });
    await api.auth.login({ email: 'a@b.co', password: 'pw' });
    await api.auth.mfaVerify({ challengeToken: 'c', code: '123456' });
    expect(fetch.calls.map((c) => (c.body as { deliver: string }).deliver)).toEqual([
      'token',
      'token',
    ]);
  });

  it('maps API error envelopes to ApiError with code, status, request id and field issues', async () => {
    const { api } = make({
      'POST /v1/posts': {
        status: 422,
        json: {
          error: {
            code: 'validation_failed',
            message: 'bad',
            requestId: 'r1',
            details: { issues: [{ path: 'body', message: 'too long' }] },
          },
        },
      },
    });
    const err = await api.posts.create({ body: 'x' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ code: 'validation_failed', status: 422, requestId: 'r1' });
    expect((err as ApiError).issues).toEqual([{ path: 'body', message: 'too long' }]);
  });

  it('reads Retry-After on 429 so the UI can say when to try again', async () => {
    const { api } = make({
      'GET /v1/feed': {
        status: 429,
        json: { error: { code: 'rate_limited', message: 'slow down' } },
        headers: { 'retry-after': '12' },
      },
    });
    const err = (await api.feed.get({}).catch((e: unknown) => e)) as ApiError;
    expect(err.retryAfterSec).toBe(12);
    expect(err.retryable).toBe(true);
  });

  it('turns a network failure into a retryable network_error', async () => {
    const { api } = make({
      'GET /v1/feed': () => {
        throw new TypeError('Network request failed');
      },
    });
    const err = (await api.feed.get({}).catch((e: unknown) => e)) as ApiError;
    expect(err).toMatchObject({ code: 'network_error', status: 0 });
    expect(err.retryable).toBe(true);
  });

  it('calls onUnauthorized for 401s (not for the login endpoint)', async () => {
    const onUnauthorized = jest.fn();
    const { api } = make(
      {
        'GET /v1/auth/sessions': {
          status: 401,
          json: { error: { code: 'unauthenticated', message: 'x' } },
        },
        'POST /v1/auth/login': {
          status: 401,
          json: { error: { code: 'unauthenticated', message: 'x' } },
        },
      },
      { onUnauthorized },
    );
    await api.auth.sessions().catch(() => undefined);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    await api.auth.login({ email: 'a@b.co', password: 'x' }).catch(() => undefined);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('builds keyset-pagination queries from cursor and limit only', async () => {
    const { fetch, api } = make({
      'GET /v1/feed': { json: { items: [], nextCursor: null, mode: 'following' } },
      'GET /v1/conversations': { json: { items: [], nextCursor: null } },
    });
    await api.feed.get({ mode: 'following', cursor: 'abc', limit: 15 });
    await api.conversations.list({ cursor: 'def', limit: 30 });
    expect(fetch.calls[0]!.query).toBe('?mode=following&cursor=abc&limit=15');
    expect(fetch.calls[1]!.query).toBe('?cursor=def&limit=30');
  });

  it('exposes the push, discover, search, privacy and media endpoints that exist on the API', async () => {
    const { fetch, api } = make({
      'POST /v1/notifications/push-tokens': { status: 201, json: { id: 'p1' } },
      'DELETE /v1/notifications/push-tokens': { status: 204 },
      'GET /v1/search': { json: { query: 'q', total: 0, results: {} } },
      'POST /v1/privacy/export': {
        status: 202,
        json: { requestId: 'r', status: 'completed', expiresAt: 'x', sizeBytes: 1, next: '/x' },
      },
      'POST /v1/ws/ticket': { json: { ticket: 't', expiresInSec: 60, url: '/v1/ws?ticket=t' } },
    });
    await api.notifications.registerPushToken('ExponentPushToken[abc]', 'android');
    await api.notifications.unregisterPushToken('ExponentPushToken[abc]');
    await api.search.query('q');
    await api.privacy.requestExport('pw');
    expect((await api.realtime.ticket()).ticket).toBe('t');
    expect(fetch.calls[0]!.body).toEqual({
      token: 'ExponentPushToken[abc]',
      platform: 'android',
      provider: 'expo',
    });
    expect(fetch.calls[3]!.body).toEqual({ password: 'pw' });
  });

  it('does not invent endpoints: every path used by the mobile-only helpers is a real API route', () => {
    const fs = require('node:fs') as typeof import('node:fs');
    const path = require('node:path') as typeof import('node:path');
    const openapi = JSON.parse(
      fs.readFileSync(path.join(__dirname, '../../../docs/api/openapi.json'), 'utf8'),
    ) as { paths: Record<string, unknown> };
    const src = fs.readFileSync(path.join(__dirname, '../src/api/index.ts'), 'utf8');
    const used = [...src.matchAll(/'(\/v1\/[^']*)'|`(\/v1\/[^`]*)`/g)].map((m) =>
      (m[1] ?? m[2]!).replace(/\$\{[^}]+\}/g, '{id}').replace(/\/\{id\}$/, '/{id}'),
    );
    const known = Object.keys(openapi.paths).map((p) => p.replace(/\{[^}]+\}/g, '{id}'));
    const missing = [...new Set(used)].filter((u) => !known.includes(u));
    expect(missing).toEqual([]);
  });
});
