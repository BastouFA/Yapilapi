import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildQuery, createApiClient, isApiError, type ApiError, type FetchLike } from './index';

/**
 * A real HTTP server on a random port stands in for the API's network boundary: we assert on the actual bytes
 * (method, path, headers, body) the client puts on the wire and on how it interprets real responses.
 */
interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: unknown;
}
let server: Server;
let baseUrl: string;
let seen: Seen[] = [];
let respond: (req: IncomingMessage, res: ServerResponse, body: unknown) => void = () => undefined;

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      // Multipart form uploads are not JSON; the assertions on those bodies check headers/url instead.
      let body: unknown;
      if (raw) {
        try {
          body = JSON.parse(raw);
        } catch {
          body = undefined;
        }
      }
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      respond(req, res, body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
beforeEach(() => {
  seen = [];
  respond = (_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end('{}');
  };
});

const json = (
  res: ServerResponse,
  status: number,
  payload: unknown,
  headers: Record<string, string> = {},
) => {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(JSON.stringify(payload));
};

describe('cookie mode (browsers)', () => {
  it('sends credentials and the CSRF header on unsafe methods only', async () => {
    const inits: RequestInit[] = [];
    const spy: FetchLike = (input, init) => {
      inits.push(init ?? {});
      return fetch(input, init);
    };
    const api = createApiClient({ baseUrl, mode: 'cookie', fetch: spy });
    await api.auth.me();
    await api.posts.delete('abc');
    expect(inits.every((i) => i.credentials === 'include')).toBe(true);
    expect(seen[0]!.headers['x-yl-csrf']).toBeUndefined();
    expect(seen[1]!.headers['x-yl-csrf']).toBe('1');
    expect(seen.every((s) => s.headers['authorization'] === undefined)).toBe(true);
  });

  it('is the default mode and asks the API to deliver the session by cookie', async () => {
    const api = createApiClient({ baseUrl });
    respond = (_r, res) => json(res, 200, { mfaRequired: false, user: {}, expiresAt: 'x' });
    await api.auth.login({ email: 'a@b.co', password: 'pw' });
    expect(seen[0]!.body).toEqual({ email: 'a@b.co', password: 'pw', deliver: 'cookie' });
    expect(seen[0]!.headers['content-type']).toBe('application/json');
  });
});

describe('bearer mode (React Native)', () => {
  it('sends the token, no CSRF header, and requests token delivery', async () => {
    const api = createApiClient({ baseUrl, mode: 'bearer', getToken: async () => 'tok_123' });
    respond = (_r, res) =>
      json(res, 200, { mfaRequired: false, user: {}, token: 'tok_new', expiresAt: 'x' });
    const out = await api.auth.login({ email: 'a@b.co', password: 'pw' });
    await api.auth.sessions();
    expect(out).toMatchObject({ token: 'tok_new' });
    expect(seen[0]!.body).toMatchObject({ deliver: 'token' });
    expect(seen[0]!.headers['authorization']).toBe('Bearer tok_123');
    expect(seen[0]!.headers['x-yl-csrf']).toBeUndefined();
  });

  it('omits Authorization when there is no token yet', async () => {
    const api = createApiClient({ baseUrl, mode: 'bearer', getToken: () => null });
    await api.meta.get();
    expect(seen[0]!.headers['authorization']).toBeUndefined();
  });
});

describe('errors', () => {
  it('parses the API error envelope into ApiError', async () => {
    respond = (_r, res) =>
      json(res, 400, {
        error: {
          code: 'validation_failed',
          message: 'Invalid body',
          details: { issues: [{ path: 'email', message: 'Invalid email' }] },
          requestId: 'req-9',
        },
      });
    const api = createApiClient({ baseUrl });
    const err = await api.auth.forgotPassword('nope').catch((e: unknown) => e);
    expect(isApiError(err)).toBe(true);
    const e = err as ApiError;
    expect(e).toMatchObject({
      code: 'validation_failed',
      status: 400,
      requestId: 'req-9',
      message: 'Invalid body',
    });
    expect(e.issues).toEqual([{ path: 'email', message: 'Invalid email' }]);
    expect(e.retryable).toBe(false);
  });

  it('exposes Retry-After on 429 and marks it retryable', async () => {
    respond = (_r, res) =>
      json(
        res,
        429,
        { error: { code: 'rate_limited', message: 'Slow down', requestId: 'r' } },
        { 'retry-after': '42' },
      );
    const e = (await createApiClient({ baseUrl })
      .posts.get('x')
      .catch((x: unknown) => x)) as ApiError;
    expect(e.code).toBe('rate_limited');
    expect(e.retryAfterSec).toBe(42);
    expect(e.retryable).toBe(true);
  });

  it('falls back to x-request-id and bad_response for non-JSON failures', async () => {
    respond = (_r, res) => {
      res.statusCode = 502;
      res.setHeader('x-request-id', 'gw-1');
      res.end('<html>Bad gateway</html>');
    };
    const e = (await createApiClient({ baseUrl })
      .posts.get('x')
      .catch((x: unknown) => x)) as ApiError;
    expect(e).toMatchObject({ code: 'bad_response', status: 502, requestId: 'gw-1' });
    expect(e.retryable).toBe(true);
  });

  it('reports unreachable servers as network_error with status 0', async () => {
    const dead = createServer();
    await new Promise<void>((r) => dead.listen(0, '127.0.0.1', r));
    const port = (dead.address() as AddressInfo).port;
    await new Promise<void>((r) => dead.close(() => r()));
    const e = (await createApiClient({ baseUrl: `http://127.0.0.1:${port}` })
      .meta.get()
      .catch((x: unknown) => x)) as ApiError;
    expect(e).toMatchObject({ code: 'network_error', status: 0 });
    expect(e.retryable).toBe(true);
  });

  it('times out slow responses', async () => {
    respond = () => undefined; // never answers
    const e = (await createApiClient({ baseUrl, timeoutMs: 50 })
      .meta.get()
      .catch((x: unknown) => x)) as ApiError;
    expect(e).toMatchObject({ code: 'timeout', status: 0 });
  });

  it('lets caller-initiated aborts through untouched (not an ApiError)', async () => {
    respond = () => undefined;
    const ctl = new AbortController();
    const p = createApiClient({ baseUrl }).feed.get({}, { signal: ctl.signal });
    ctl.abort();
    const e = await p.catch((x: unknown) => x);
    expect(isApiError(e)).toBe(false);
    expect((e as Error).name).toBe('AbortError');
  });

  it('fires onUnauthorized for 401s, except where the call opts out', async () => {
    respond = (_r, res) =>
      json(res, 401, { error: { code: 'unauthenticated', message: 'Sign in', requestId: 'r' } });
    const onUnauthorized = vi.fn();
    const api = createApiClient({ baseUrl, onUnauthorized });
    await api.feed.get().catch(() => undefined);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    const e = (await api.auth
      .login({ email: 'a@b.co', password: 'x' })
      .catch((x: unknown) => x)) as ApiError;
    expect(e.isUnauthenticated).toBe(true);
    await api.auth.me({ skipUnauthorizedHook: true }).catch(() => undefined);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });
});

describe('responses and requests', () => {
  it('returns undefined for 204 No Content', async () => {
    respond = (_r, res) => {
      res.statusCode = 204;
      res.end();
    };
    await expect(createApiClient({ baseUrl }).posts.delete('p1')).resolves.toBeUndefined();
  });

  it('serialises feed params (arrays comma-joined, empties skipped)', async () => {
    respond = (_r, res) => json(res, 200, { mode: 'custom', items: [], nextCursor: null });
    await createApiClient({ baseUrl }).feed.get({
      mode: 'custom',
      topics: ['music', 'food'],
      cursor: 'a b',
      limit: 10,
      lat: undefined,
    });
    expect(seen[0]!.url).toBe('/v1/feed?mode=custom&cursor=a%20b&limit=10&topics=music%2Cfood');
  });

  it('percent-encodes path segments', async () => {
    await createApiClient({ baseUrl }).profile.get('we/ird name');
    expect(seen[0]!.url).toBe('/v1/users/we%2Fird%20name');
  });

  it('maps typed helpers to the right method, path and body', async () => {
    const api = createApiClient({ baseUrl });
    await api.reactions.reactToPost('p1', 'love');
    await api.saves.save('p1');
    await api.polls.vote('p1', ['o1']);
    await api.comments.create('p1', 'hi', 'c1');
    await api.feed.feedback('p1', 'not_interested');
    await api.graph.follow('sam');
    await api.settings.updatePreferences({ lowBandwidth: true });
    await api.topics.mute('music');
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual([
      'PUT /v1/posts/p1/reaction',
      'PUT /v1/posts/p1/save',
      'POST /v1/posts/p1/poll/vote',
      'POST /v1/posts/p1/comments',
      'POST /v1/feed/feedback',
      'PUT /v1/users/sam/follow',
      'PATCH /v1/settings/preferences',
      'PUT /v1/topics/music/mute',
    ]);
    expect(seen[0]!.body).toEqual({ kind: 'love' });
    expect(seen[3]!.body).toEqual({ body: 'hi', parentId: 'c1' });
    expect(seen[4]!.body).toEqual({ postId: 'p1', signal: 'not_interested' });
    expect(seen[6]!.body).toEqual({ lowBandwidth: true });
  });

  it('allows extra and computed headers (SSR cookie forwarding)', async () => {
    const api = createApiClient({ baseUrl, headers: () => ({ cookie: 'yl_session=abc' }) });
    await api.auth.me();
    expect(seen[0]!.headers['cookie']).toBe('yl_session=abc');
  });

  it('works with an injected fetch (no global fetch needed)', async () => {
    const stub: FetchLike = async () =>
      new Response(JSON.stringify({ app: 'x', tagline: 't', flags: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    const api = createApiClient({ baseUrl: 'http://unused.invalid/', fetch: stub });
    await expect(api.meta.get()).resolves.toMatchObject({ app: 'x' });
  });
});

describe('buildQuery', () => {
  it('handles empties', () => {
    expect(buildQuery(undefined)).toBe('');
    expect(buildQuery({ a: undefined, b: null, c: '' })).toBe('');
    expect(buildQuery({ a: 1, b: true, c: ['x', 'y'] })).toBe('?a=1&b=true&c=x%2Cy');
  });
});

describe('messaging and communities', () => {
  it('lists the inbox with filters and sends idempotent messages', async () => {
    const api = createApiClient({ baseUrl });
    respond = (_r, res) => json(res, 200, { items: [], nextCursor: null });
    await api.conversations.list({ kind: 'group', pinned: true, limit: 20 });
    expect(seen[0]!.url).toBe('/v1/conversations?limit=20&kind=group&pinned=true');
    respond = (_r, res) => json(res, 201, { id: 'm1' });
    await api.conversations.send('c 1', {
      body: 'hi',
      replyToId: 'r1',
      clientMessageId: 'client-msg-0001',
    });
    expect(seen[1]).toMatchObject({
      method: 'POST',
      url: '/v1/conversations/c%201/messages',
      body: { body: 'hi', replyToId: 'r1', clientMessageId: 'client-msg-0001' },
    });
    expect(seen[1]!.headers['x-yl-csrf']).toBe('1');
  });

  it('reacts to messages and requests a realtime ticket', async () => {
    const api = createApiClient({ baseUrl });
    await api.messages.react('m1', 'love');
    await api.messages.unreact('m1');
    await api.realtime.ticket();
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual([
      'PUT /v1/messages/m1/reaction',
      'DELETE /v1/messages/m1/reaction',
      'POST /v1/ws/ticket',
    ]);
    expect(seen[0]!.body).toEqual({ kind: 'love' });
  });

  it('opens direct and group conversations', async () => {
    const api = createApiClient({ baseUrl });
    await api.conversations.direct({ username: 'ada' });
    await api.conversations.createGroup('Crew', ['u1', 'u2']);
    expect(seen[0]!.body).toEqual({ username: 'ada' });
    expect(seen[1]!.body).toEqual({ title: 'Crew', memberIds: ['u1', 'u2'] });
  });

  it('browses, creates, joins and posts channels of communities', async () => {
    const api = createApiClient({ baseUrl });
    respond = (_r, res) => json(res, 200, { items: [], nextCursor: null });
    await api.communities.list({ q: 'cook', topic: 'food', limit: 10 });
    expect(seen[0]!.url).toBe('/v1/communities?limit=10&q=cook&topic=food');
    await api.communities.create({ name: 'Cooks', visibility: 'public', topics: ['food'] });
    await api.communities.join('cooks');
    await api.communities.createChannel('cid', 'general');
    await api.communities.members('cid', { status: 'pending' });
    expect(seen.slice(1).map((s) => `${s.method} ${s.url}`)).toEqual([
      'POST /v1/communities',
      'POST /v1/communities/cooks/join',
      'POST /v1/communities/cid/channels',
      'GET /v1/communities/cid/members?status=pending',
    ]);
    expect(seen[3]!.body).toEqual({ name: 'general', kind: 'text' });
  });
});

describe('search & discover', () => {
  it('builds the search query string, including comma-joined types', async () => {
    const api = createApiClient({ baseUrl });
    respond = (_r, res) =>
      json(res, 200, { query: 'q', interpretedAs: {}, types: [], total: 0, results: {} });
    await api.search.run({
      q: 'sushi tonight',
      types: ['places', 'events'],
      limit: 10,
      lat: 1,
      lng: 2,
    });
    expect(seen[0]!.url).toBe(
      '/v1/search?q=sushi%20tonight&types=places%2Cevents&limit=10&lat=1&lng=2',
    );
  });

  it('requests typeahead suggestions and history', async () => {
    const api = createApiClient({ baseUrl });
    respond = (_r, res) => json(res, 200, { query: 'a', items: [], recent: [] });
    await api.search.suggest('ada', { types: ['people'] });
    expect(seen[0]!.url).toBe('/v1/search/suggest?q=ada&types=people');
    respond = (_r, res) => json(res, 200, { recording: true, items: [] });
    await api.search.history();
    await api.search.clearHistory('old query');
    expect(seen.slice(1).map((s) => `${s.method} ${s.url}`)).toEqual([
      'GET /v1/search/history',
      'DELETE /v1/search/history?q=old%20query',
    ]);
  });

  it('reads trending, people, communities, topics and NOW', async () => {
    const api = createApiClient({ baseUrl });
    respond = (_r, res) =>
      json(res, 200, { window: '24h', topics: [], items: [], nextCursor: null });
    await api.discover.trending({ window: '6h', limit: 5 });
    respond = (_r, res) => json(res, 200, { source: 'graph', items: [], nextCursor: null });
    await api.discover.people({ limit: 5 });
    respond = (_r, res) => json(res, 200, { items: [], nextCursor: null });
    await api.discover.communities({ topic: 'music' });
    respond = (_r, res) => json(res, 200, { items: [] });
    await api.discover.topics({ limit: 30 });
    respond = (_r, res) =>
      json(res, 200, {
        generatedAt: 'x',
        privacy: {},
        live: { enabled: false, items: [] },
        events: [],
        trendingTopics: [],
        activeCommunities: [],
        nearby: null,
        needsLocation: true,
      });
    await api.discover.now({ lat: 1, lng: 2 });
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual([
      'GET /v1/discover/trending?limit=5&window=6h',
      'GET /v1/discover/people?limit=5',
      'GET /v1/discover/communities?topic=music',
      'GET /v1/discover/topics?limit=30',
      'GET /v1/now?lat=1&lng=2',
    ]);
  });
});

describe('notifications', () => {
  it('lists, marks read and updates preferences and quiet-hours settings', async () => {
    const api = createApiClient({ baseUrl });
    respond = (_r, res) => json(res, 200, { items: [], nextCursor: null });
    await api.notifications.list({ category: 'events', unread: true, limit: 20 });
    expect(seen[0]!.url).toBe('/v1/notifications?limit=20&category=events&unread=true');
    respond = (_r, res) => json(res, 200, { total: 0, byCategory: {} });
    await api.notifications.unreadCount();
    respond = (_r, res) => json(res, 200, { updated: 3 });
    await api.notifications.readAll('events');
    expect(seen[2]!.body).toEqual({ category: 'events' });
    await api.notifications.markRead('n1');
    await api.notifications.remove('n2');
    expect(seen.slice(3).map((s) => `${s.method} ${s.url}`)).toEqual([
      'POST /v1/notifications/n1/read',
      'DELETE /v1/notifications/n2',
    ]);
    respond = (_r, res) => json(res, 200, { categories: [], overrides: [], settings: {} });
    await api.notifications.setPreferences([{ key: 'events', channel: 'push', enabled: false }]);
    expect(seen[5]!.body).toEqual({ items: [{ key: 'events', channel: 'push', enabled: false }] });
    await api.notifications.updateSettings({
      quietHours: { start: 60, end: 420 },
      focusMode: true,
    });
    expect(seen[6]!.body).toEqual({ quietHours: { start: 60, end: 420 }, focusMode: true });
  });
});

describe('media', () => {
  it('uploads a file as multipart form data, without a JSON content-type', async () => {
    const api = createApiClient({ baseUrl });
    respond = (_r, res) => json(res, 201, { id: 'm1', kind: 'image', status: 'uploaded' });
    const blob = new Blob(['hello'], { type: 'text/plain' });
    await api.media.upload(blob, { fileName: 'a.txt', altText: 'A file' });
    expect(seen[0]!.method).toBe('POST');
    expect(seen[0]!.url).toBe('/v1/media');
    expect(String(seen[0]!.headers['content-type'] ?? '')).toMatch(/^multipart\/form-data/);
    expect(seen[0]!.body).toBeUndefined(); // the test server only parses JSON bodies in this suite
  });

  it('patches alt text and deletes media', async () => {
    const api = createApiClient({ baseUrl });
    respond = (_r, res) => json(res, 200, { updated: true });
    await api.media.update('m1', { altText: 'desc' });
    await api.media.delete('m1');
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual([
      'PATCH /v1/media/m1',
      'DELETE /v1/media/m1',
    ]);
  });
});

describe('moments', () => {
  it('creates, views and reacts to moments', async () => {
    const api = createApiClient({ baseUrl });
    respond = (_r, res) => json(res, 201, { id: 'mo1' });
    await api.moments.create({
      kind: 'photo',
      mediaId: 'm1',
      visibility: 'friends',
      expiry: '24h',
    });
    expect(seen[0]!.body).toEqual({
      kind: 'photo',
      mediaId: 'm1',
      visibility: 'friends',
      expiry: '24h',
    });
    respond = (_r, res) => json(res, 200, { groups: [], hasMore: false });
    await api.moments.tray(20);
    expect(seen[1]!.url).toBe('/v1/moments/tray?limit=20');
    await api.moments.view('mo1');
    await api.moments.react('mo1', 'love');
    await api.moments.unreact('mo1');
    await api.moments.delete('mo1');
    expect(seen.slice(2).map((s) => `${s.method} ${s.url}`)).toEqual([
      'POST /v1/moments/mo1/view',
      'PUT /v1/moments/mo1/reaction',
      'DELETE /v1/moments/mo1/reaction',
      'DELETE /v1/moments/mo1',
    ]);
  });
});

describe('events', () => {
  it('browses, RSVPs, saves and reads calendar/attendee data', async () => {
    const api = createApiClient({ baseUrl });
    respond = (_r, res) => json(res, 200, { items: [], nextCursor: null });
    await api.events.list({ q: 'jazz', online: true, free: false, limit: 10 });
    expect(seen[0]!.url).toBe('/v1/events?limit=10&q=jazz&online=true&free=false');
    await api.events.nearby({ lat: 1, lng: 2, when: 'this_weekend' });
    expect(seen[1]!.url).toBe('/v1/discover/events?lat=1&lng=2&when=this_weekend');
    respond = (_r, res) => json(res, 200, { status: 'going' });
    await api.events.rsvp('e1', 'going', 't1');
    expect(seen[2]!.body).toEqual({ status: 'going', ticketTypeId: 't1' });
    await api.events.withdrawRsvp('e1');
    await api.events.save('e1');
    await api.events.unsave('e1');
    expect(api.events.calendarIcsUrl('e1')).toBe('/v1/events/e1/calendar.ics');
    respond = (_r, res) => json(res, 200, { items: [], nextCursor: null });
    await api.events.mine('hosting', { limit: 5 });
    expect(seen[seen.length - 1]!.url).toBe('/v1/me/events?limit=5&role=hosting');
  });
});

describe('places, business & bookings', () => {
  it('browses places nearby, saves, reviews and claims', async () => {
    const api = createApiClient({ baseUrl });
    respond = (_r, res) => json(res, 200, { items: [], nextCursor: null });
    await api.places.nearby({ lat: 1, lng: 2, kind: 'restaurant', openNow: true, minRating: 4 });
    expect(seen[0]!.url).toBe(
      '/v1/places/nearby?lat=1&lng=2&kind=restaurant&openNow=true&minRating=4',
    );
    respond = (_r, res) => json(res, 201, { id: 'r1' });
    await api.places.addReview('p1', 5, 'Great place');
    expect(seen[1]!.body).toEqual({ rating: 5, body: 'Great place' });
    await api.places.claim('p1', 'biz1', 'I own this');
    expect(seen[2]!.body).toEqual({ businessId: 'biz1', evidence: 'I own this' });
  });

  it('follows businesses and books a slot', async () => {
    const api = createApiClient({ baseUrl });
    respond = (_r, res) => json(res, 200, { following: true, followerCount: 4 });
    await api.business.follow('b1');
    await api.business.unfollow('b1');
    respond = (_r, res) => json(res, 201, { id: 'bk1', status: 'requested' });
    await api.bookings.create({ placeId: 'p1', startsAt: '2026-01-01T10:00:00Z', partySize: 2 });
    expect(seen[2]!.body).toEqual({
      placeId: 'p1',
      startsAt: '2026-01-01T10:00:00Z',
      partySize: 2,
    });
    respond = (_r, res) => json(res, 200, { id: 'bk1', status: 'confirmed' });
    await api.bookings.confirm('bk1');
    expect(seen[3]).toMatchObject({ method: 'POST', url: '/v1/bookings/bk1/confirm' });
  });
});
