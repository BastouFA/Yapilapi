import type pg from 'pg';
import { signDevWebhook } from '../src/lib/payments.ts';

/**
 * Seeds a load-test dataset through the public API (the same paths real
 * clients use), so every row has the shape production writes give it.
 * Only two things go straight to the database because no public endpoint
 * does them: turning the ADS feature flag on, and reading the dev payment
 * reference to sign the "payment succeeded" webhook.
 *
 * Randomness is seeded, so every run builds a graph of the same shape (exact
 * edges can differ slightly because requests run concurrently).
 */

export interface SeedOptions {
  base: string;
  db: pg.Pool;
  webhookSecret: string;
  users: number;
  postsPerUser: number;
  followsPerUser: number;
  friendsPerUser: number;
  likesPerUser: number;
  commentsPerUser: number;
  conversationsPerUser: number;
  messagesPerConversation: number;
  advertisers: number;
  concurrency: number;
}

export interface SeedUser {
  id: string;
  token: string;
  username: string;
}

export interface Dataset {
  users: SeedUser[];
  postIds: string[];
  /** A conversation and a member who can post in it. */
  conversations: { id: string; token: string }[];
  searchTerms: string[];
}

export const TOPICS = ['music', 'food', 'travel', 'football', 'photography', 'books', 'gaming', 'design', 'fitness', 'film', 'art', 'tech'];
const WORDS = [
  'sunset',
  'market',
  'recipe',
  'concert',
  'weekend',
  'coffee',
  'league',
  'gallery',
  'trail',
  'playlist',
  'studio',
  'harbour',
  'festival',
  'garden',
  'novel',
  'workshop',
  'street',
  'match',
  'bakery',
  'vinyl',
];
const NAMES = ['Amara', 'Kofi', 'Lena', 'Mateo', 'Yuki', 'Ines', 'Tariq', 'Noor', 'Sofia', 'Emeka', 'Hana', 'Luca', 'Zara', 'Ravi', 'Chloe', 'Omar'];

/** mulberry32: small, fast, seeded PRNG. */
export function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n: number) => Math.floor(next() * n);
  const pick = <T>(xs: readonly T[]) => xs[int(xs.length)]!;
  const sample = <T>(xs: readonly T[], n: number) => {
    const copy = [...xs];
    const out: T[] = [];
    while (out.length < n && copy.length) out.push(copy.splice(int(copy.length), 1)[0]!);
    return out;
  };
  return { next, int, pick, sample };
}

/** Run fn over items with at most `limit` in flight. */
export async function pool<T, R>(items: readonly T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const n = i++;
        out[n] = await fn(items[n]!, n);
      }
    }),
  );
  return out;
}

export function client(base: string) {
  return async function call<T = any>(method: string, path: string, token: string | null, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 200)}`);
    return (text ? JSON.parse(text) : null) as T;
  };
}

export async function seed(o: SeedOptions, log: (msg: string) => void = console.log): Promise<Dataset> {
  const r = rng(20260925);
  const call = client(o.base);
  const run = Date.now().toString(36);
  const t0 = Date.now();
  const step = (msg: string) => log(`  seed: ${msg} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

  // 1. Users: adults (so ads and messaging rules apply normally), with interests and ad consent.
  const users = await pool(
    Array.from({ length: o.users }, (_, i) => i),
    o.concurrency,
    async (i) => {
      const name = `${NAMES[i % NAMES.length]} ${WORDS[i % WORDS.length]}`;
      const username = `load_${run}_${i}`.slice(0, 30);
      const res = await call('POST', '/v1/auth/register', null, {
        email: `${username}@load.example.test`,
        password: 'load-test-password-1',
        username,
        displayName: name,
        birthDate: '1990-01-01',
      });
      const u: SeedUser = { id: res.user.id, token: res.token, username };
      await call('PUT', '/v1/me/interests', u.token, { topics: r.sample(TOPICS, 3) });
      await call('PUT', '/v1/me/consents', u.token, { purpose: 'advertising', granted: true });
      return u;
    },
  );
  step(`${users.length} users`);

  // 2. Follow graph.
  await pool(users, o.concurrency, async (u) => {
    for (const other of r.sample(users, o.followsPerUser + 1)) if (other.id !== u.id) await call('POST', `/v1/users/${other.id}/follow`, u.token);
  });
  step(`follows`);

  // 3. Friendships: a request each way (the second one accepts).
  await pool(users, o.concurrency, async (u) => {
    for (const other of r.sample(users, o.friendsPerUser + 1)) {
      if (other.id === u.id) continue;
      await call('POST', `/v1/users/${other.id}/friend-request`, u.token);
      await call('POST', `/v1/users/${u.id}/friend-request`, other.token);
    }
  });
  step(`friendships`);

  // 4. Posts with topics and searchable words.
  const posts = await pool(users, o.concurrency, async (u) => {
    const ids: string[] = [];
    for (let k = 0; k < o.postsPerUser; k++) {
      const words = r.sample(WORDS, 4).join(' ');
      const res = await call('POST', '/v1/posts', u.token, {
        body: `Load test ${k}: ${words} with friends this ${r.pick(['morning', 'evening', 'weekend'])}.`,
        topics: r.sample(TOPICS, 2),
      });
      ids.push(res.post.id);
    }
    return ids;
  });
  const postIds = posts.flat();
  step(`${postIds.length} posts`);

  // 5. Reactions, comments and feed feedback (they also create notifications).
  await pool(users, o.concurrency, async (u) => {
    for (const id of r.sample(postIds, o.likesPerUser)) await call('PUT', `/v1/posts/${id}/reaction`, u.token, { kind: 'like' });
    for (const id of r.sample(postIds, o.commentsPerUser)) await call('POST', `/v1/posts/${id}/comments`, u.token, { body: `Love this ${r.pick(WORDS)}!` });
    await call('POST', '/v1/feed/feedback', u.token, { signal: 'less_like_this', postId: r.pick(postIds) });
    await call('POST', '/v1/feed/feedback', u.token, { signal: 'more_like_this', postId: r.pick(postIds) });
  });
  step(`reactions, comments and feedback`);

  // 6. Direct conversations with history.
  const conversations = (
    await pool(users, o.concurrency, async (u) => {
      const mine: { id: string; token: string }[] = [];
      for (const other of r.sample(users, o.conversationsPerUser + 1)) {
        if (other.id === u.id || mine.length >= o.conversationsPerUser) continue;
        const c = await call('POST', '/v1/conversations', u.token, { memberIds: [other.id] });
        for (let k = 0; k < o.messagesPerConversation; k++)
          await call('POST', `/v1/conversations/${c.conversation.id}/messages`, k % 2 ? other.token : u.token, {
            body: `Message ${k} about the ${r.pick(WORDS)}`,
          });
        mine.push({ id: c.conversation.id, token: u.token });
      }
      return mine;
    })
  ).flat();
  step(`${conversations.length} conversations`);

  // 7. Paid, active ad campaigns.
  await o.db.query(`INSERT INTO feature_flags (key, enabled) VALUES ('ADS', true) ON CONFLICT (key) DO UPDATE SET enabled = true`);
  await pool(users.slice(0, o.advertisers), o.concurrency, async (u, i) => {
    const postId = posts[i]![0]!;
    const camp = await call('POST', '/v1/ads/campaigns', u.token, { postId, name: `Load campaign ${i}`, cpmCents: 500 + i * 10 });
    const fund = await call('POST', `/v1/ads/campaigns/${camp.campaign.id}/fund`, u.token, { amountCents: 1_000_000, idempotencyKey: `load_${run}_${i}` });
    const ref = (await o.db.query(`SELECT provider_ref FROM payments WHERE order_id = $1`, [fund.payment.orderId])).rows[0].provider_ref;
    const payload = JSON.stringify({ id: `evt_${fund.payment.orderId}`, type: 'payment.succeeded', providerRef: ref, amountCents: 1_000_000 });
    await call('POST', '/v1/payments/webhook/dev', null, payload, { 'x-signature': signDevWebhook(o.webhookSecret, payload) });
    await call('PATCH', `/v1/ads/campaigns/${camp.campaign.id}`, u.token, { status: 'active' });
  });
  // Starting a campaign sends it to review; approve them the way a moderator would, so ads are actually served.
  await o.db.query(`UPDATE ad_campaigns SET status = 'active', approved_at = now() WHERE status = 'pending_review'`);
  await o.db.query(
    `UPDATE moderation_cases SET status = 'decided', decision = 'approve_ad', decided_at = now() WHERE target_type = 'ad_campaign' AND status = 'open'`,
  );
  step(`${o.advertisers} funded, approved ad campaigns`);

  // 8. Stories from everyone and reels from a fifth of the users (video rows stand in for processed uploads).
  await pool(users, o.concurrency, async (u) => {
    await call('POST', '/v1/moments', u.token, { body: `Today: ${r.sample(WORDS, 3).join(' ')}`, visibility: 'followers' });
  });
  await pool(users.slice(0, Math.max(1, Math.floor(users.length / 5))), o.concurrency, async (u) => {
    const m = await o.db.query(
      `INSERT INTO media (owner_id, kind, url, mime, status, duration_ms) VALUES ($1,'video','http://localhost/media/load.mp4','video/mp4','ready',15000) RETURNING id, url`,
      [u.id],
    );
    await call('POST', '/v1/posts', u.token, {
      format: 'reel',
      body: `Reel: ${r.sample(WORDS, 3).join(' ')}`,
      topics: r.sample(TOPICS, 2),
      media: [{ id: m.rows[0].id, url: m.rows[0].url, kind: 'video' }],
    });
  });
  step(`stories and reels`);

  // Keep planner statistics current, as autovacuum would on a live database.
  await o.db.query('ANALYZE');

  return { users, postIds, conversations, searchTerms: [...WORDS, ...TOPICS, ...NAMES.map((n) => n.toLowerCase())] };
}
