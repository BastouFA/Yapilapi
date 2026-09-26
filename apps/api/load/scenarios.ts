import { rng, type Dataset } from './seed.ts';

export interface RequestSpec {
  method: 'GET' | 'POST' | 'PUT';
  path: string;
  token: string;
  body?: unknown;
}

export interface Scenario {
  name: string;
  /** The route as it appears in /metrics and the docs. */
  route: string;
  /** Target p95 latency in ms at the default concurrency (see docs/architecture/performance.md). */
  sloP95Ms: number;
  next: () => RequestSpec;
}

/**
 * The hot paths of a session: open the app (feed, notifications, a sponsored
 * slot), look around (search), and talk (post, message). Each request picks a
 * different seeded user, so caches and row locks behave as they would with
 * many people rather than one. Reads run before writes, so they are measured
 * against the seeded dataset rather than one inflated by the write scenarios.
 */
export function scenarios(d: Dataset): Scenario[] {
  const r = rng(7);
  const user = () => d.users[r.int(d.users.length)]!;
  let n = 0;
  return [
    {
      name: 'home feed',
      route: 'GET /v1/feed',
      sloP95Ms: 250,
      next: () => ({ method: 'GET', path: '/v1/feed', token: user().token }),
    },
    {
      name: 'reels feed',
      route: 'GET /v1/reels',
      sloP95Ms: 250,
      next: () => ({ method: 'GET', path: '/v1/reels', token: user().token }),
    },
    {
      name: 'stories',
      route: 'GET /v1/moments',
      sloP95Ms: 150,
      next: () => ({ method: 'GET', path: '/v1/moments', token: user().token }),
    },
    {
      name: 'people suggest',
      route: 'GET /v1/people/suggest',
      sloP95Ms: 100,
      next: () => ({
        method: 'GET',
        path: `/v1/people/suggest?q=${encodeURIComponent(d.searchTerms[Math.floor(Math.random() * d.searchTerms.length)]!.slice(0, 2))}`,
        token: user().token,
      }),
    },
    {
      name: 'home feed (following)',
      route: 'GET /v1/feed?mode=following',
      sloP95Ms: 150,
      next: () => ({ method: 'GET', path: '/v1/feed?mode=following', token: user().token }),
    },
    {
      name: 'discover search',
      route: 'GET /v1/search',
      sloP95Ms: 250,
      next: () => ({ method: 'GET', path: `/v1/search?q=${encodeURIComponent(r.pick(d.searchTerms))}`, token: user().token }),
    },
    {
      name: 'notifications list',
      route: 'GET /v1/notifications',
      sloP95Ms: 100,
      next: () => ({ method: 'GET', path: '/v1/notifications', token: user().token }),
    },
    {
      name: 'ads next',
      route: 'GET /v1/ads/next',
      sloP95Ms: 100,
      next: () => ({ method: 'GET', path: '/v1/ads/next', token: user().token }),
    },
    {
      name: 'post create',
      route: 'POST /v1/posts',
      sloP95Ms: 150,
      next: () => ({
        method: 'POST',
        path: '/v1/posts',
        token: user().token,
        body: { body: `Load run post ${++n} about the ${r.pick(d.searchTerms)}`, topics: [r.pick(d.searchTerms)] },
      }),
    },
    {
      name: 'message send',
      route: 'POST /v1/conversations/:id/messages',
      sloP95Ms: 100,
      next: () => {
        const c = d.conversations[r.int(d.conversations.length)]!;
        return { method: 'POST', path: `/v1/conversations/${c.id}/messages`, token: c.token, body: { body: `Load message ${++n}` } };
      },
    },
  ];
}
