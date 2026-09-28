import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BuiltApp } from '../src/app.ts';
import { as, signUp, testApp, type TestUser } from './helpers.ts';

// Queries rewritten for speed (docs/architecture/performance.md) must still return exactly what they did.

let t: BuiltApp;
beforeAll(async () => {
  t = await testApp();
});
afterAll(async () => {
  await t.close();
});

const db = () => t.ctx.db;
const adult = () => signUp(t.app, { birthDate: '1990-01-01' });
const teen = () => signUp(t.app, { birthDate: `${new Date().getUTCFullYear() - 15}-03-01` });
const follow = (a: TestUser, b: TestUser) => as(t.app, a).post(`/v1/users/${b.id}/follow`);
const ids = (items: { id: string }[]) => items.map((p) => p.id);
async function befriend(a: TestUser, b: TestUser) {
  const [x, y] = [a.id, b.id].sort();
  await db().query(`INSERT INTO friendships (user_a, user_b) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [x, y]);
}
/** A post written `minutesAgo` minutes ago, so the order is certain. */
async function post(u: TestUser, body: string, minutesAgo: number, extra: Record<string, unknown> = {}) {
  const r = await as(t.app, u).post('/v1/posts', { body, ...extra });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  await db().query(`UPDATE posts SET created_at = now() - make_interval(mins => $2) WHERE id = $1`, [r.body.post.id, minutesAgo]);
  return r.body.post.id as string;
}
/** `author` writes a post with `co` as collaborator, who accepts. */
async function collab(author: TestUser, co: TestUser, body: string, minutesAgo: number) {
  const id = await post(author, body, minutesAgo, { collaborators: [co.id] });
  expect((await as(t.app, co).post(`/v1/posts/${id}/collab/accept`)).status).toBe(200);
  return id;
}
/** Every page of a list, following nextCursor. */
async function allPages(u: TestUser | null, url: string) {
  const out: string[] = [];
  let cursor: string | null = null;
  do {
    const r = await as(t.app, u).get(`${url}${url.includes('?') ? '&' : '?'}limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    out.push(...ids(r.body.items));
    cursor = r.body.nextCursor;
  } while (cursor);
  return out;
}

describe('profile posts (own posts and collabs read separately, then merged)', () => {
  it('pages through own posts and accepted collabs newest first, with the pinned post only on top of the first page', async () => {
    const ada = await adult();
    const bola = await adult();
    const viewer = await adult();
    await follow(ada, bola);
    await follow(bola, ada);
    const p1 = await post(ada, 'Oldest', 50);
    const c1 = await collab(bola, ada, 'Made together, early', 40);
    const p2 = await post(ada, 'Middle', 30);
    const pinned = await post(ada, 'Pinned one', 25);
    const c2 = await collab(bola, ada, 'Made together, late', 20);
    const p3 = await post(ada, 'Newest', 10);
    // Bola's own post never shows on Ada's profile.
    await post(bola, 'Only Bola', 5);
    expect((await as(t.app, ada).put('/v1/me/pinned-post', { postId: pinned })).status).toBe(200);

    const first = await as(t.app, viewer).get(`/v1/users/${ada.username}/posts?limit=2`);
    expect(first.body.items[0]).toMatchObject({ id: pinned, pinned: true });
    const pages = await allPages(viewer, `/v1/users/${ada.username}/posts`);
    expect(pages).toEqual([pinned, p3, c2, p2, c1, p1]);

    // The post count on the profile counts the collabs too.
    expect((await as(t.app, viewer).get(`/v1/users/${ada.username}`)).body.profile.counts.posts).toBe(6);
  });

  it("lists a private co-author's collabs only to the people who can see their profile", async () => {
    const quiet = await adult();
    const author = await adult();
    const follower = await adult();
    const stranger = await adult();
    await follow(author, quiet);
    await follow(quiet, author);
    const c = await collab(author, quiet, 'Our shoot', 5);
    await db().query(`UPDATE profiles SET is_private = true WHERE user_id = $1`, [quiet.id]);
    await db().query(`INSERT INTO follows (follower_id, followee_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [follower.id, quiet.id]);

    expect(await allPages(quiet, `/v1/users/${quiet.username}/posts`)).toEqual([c]);
    expect(await allPages(follower, `/v1/users/${quiet.username}/posts`)).toEqual([c]);
    expect((await as(t.app, stranger).get(`/v1/users/${quiet.username}/posts`)).body.items ?? []).toEqual([]);
  });
});

describe('following and friends feeds (joined through your people instead of checking every post)', () => {
  it('shows your posts, people you follow, collabs of people you follow and their reposts, never strangers', async () => {
    const me = await adult();
    const followed = await adult();
    const partner = await adult();
    const reposter = await adult();
    const stranger = await adult();
    await follow(me, followed);
    await follow(me, reposter);
    await follow(followed, partner);
    await follow(partner, followed);
    const mine = await post(me, 'My own', 40);
    const theirs = await post(followed, 'Followed person', 30);
    const together = await collab(partner, followed, 'Partner with followed', 20);
    const strangers = await post(stranger, 'Stranger', 15);
    expect((await as(t.app, reposter).put(`/v1/posts/${strangers}/repost`)).status).toBe(200);
    const unrelated = await post(stranger, 'Not reposted', 5);

    const items = (await as(t.app, me).get('/v1/feed?mode=following&limit=20')).body.items as { id: string; reason?: string }[];
    const seen = ids(items);
    expect(seen).toEqual(expect.arrayContaining([mine, theirs, together, strangers]));
    expect(seen).not.toContain(unrelated);
    // The repost is placed at the time of the repost, the newest of them.
    expect(seen[0]).toBe(strangers);
    expect(seen.indexOf(together)).toBeLessThan(seen.indexOf(theirs));
    expect(seen.indexOf(theirs)).toBeLessThan(seen.indexOf(mine));
  });

  it('shows friends only in the friends feed', async () => {
    const me = await adult();
    const friend = await adult();
    const followed = await adult();
    await befriend(me, friend);
    await follow(me, followed);
    const f = await post(friend, 'From a friend', 10);
    const o = await post(followed, 'Only followed', 5);
    const seen = ids((await as(t.app, me).get('/v1/feed?mode=friends&limit=20')).body.items);
    expect(seen).toContain(f);
    expect(seen).not.toContain(o);
  });
});

describe('reels (ranked among the newest reels and your people’s reels)', () => {
  it("ranks a followed person's reel above a stranger's newer one", async () => {
    const fan = await adult();
    const creator = await adult();
    const stranger = await adult();
    await follow(fan, creator);
    const reel = async (u: TestUser, minutesAgo: number) => {
      const { rows } = await db().query(
        `INSERT INTO media (owner_id, kind, url, mime, status, duration_ms) VALUES ($1,'video','http://localhost:4000/media/r.mp4','video/mp4','ready',12000) RETURNING id, url`,
        [u.id],
      );
      return post(u, 'A reel', minutesAgo, { format: 'reel', media: [{ id: rows[0].id, url: rows[0].url, kind: 'video' }] });
    };
    const followedReel = await reel(creator, 30);
    const strangerReel = await reel(stranger, 1);
    // Other test files leave reels in the shared database, so read far enough to find both.
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const r = await as(t.app, fan).get(`/v1/reels?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      seen.push(...ids(r.body.items));
      cursor = seen.includes(strangerReel) ? null : r.body.nextCursor;
    } while (cursor);
    expect(seen).toContain(strangerReel);
    expect(seen).toContain(followedReel);
    expect(seen.indexOf(followedReel)).toBeLessThan(seen.indexOf(strangerReel));
  });
});

describe('market browse (your country first, each part read in date order)', () => {
  let n = 0;
  async function listing(u: TestUser, minutesAgo: number) {
    const { rows } = await db().query(
      `INSERT INTO media (owner_id, kind, url, mime, status, moderation) VALUES ($1,'image','http://localhost:4000/media/item.jpg','image/jpeg','ready','ok') RETURNING id`,
      [u.id],
    );
    const r = await as(t.app, u).post('/v1/market/listings', {
      title: `Perfqueries lamp number ${++n}`,
      description: 'A reading lamp with a warm bulb.',
      category: 'home',
      condition: 'good',
      priceCents: 500_000,
      photos: [{ mediaId: rows[0].id, altText: 'A lamp' }],
      area: 'Somewhere',
      delivery: ['pickup'],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    await db().query(`UPDATE market_listings SET created_at = now() - make_interval(mins => $2) WHERE id = $1`, [r.body.listing.id, minutesAgo]);
    return r.body.listing.id as string;
  }
  const inCountry = async (country: string) => {
    const u = await adult();
    await db().query(`UPDATE profiles SET country = $2 WHERE user_id = $1`, [u.id, country]);
    return u;
  };

  it('lists listings in your country newest first, then the others newest first, across pages without repeats', async () => {
    const ng = await inCountry('NG');
    const gh = await inCountry('GH');
    const buyer = await inCountry('GH');
    const ng1 = await listing(ng, 5);
    const gh1 = await listing(gh, 40);
    const ng2 = await listing(ng, 20);
    const gh2 = await listing(gh, 30);
    const mine = new Set([ng1, gh1, ng2, gh2]);

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const r = await as(t.app, buyer).post('/v1/market/search', { q: 'Perfqueries lamp', limit: 1, ...(cursor ? { cursor } : {}) });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      seen.push(...ids(r.body.items).filter((id) => mine.has(id)));
      cursor = r.body.nextCursor;
    } while (cursor);
    expect(seen).toEqual([gh2, gh1, ng1, ng2]);
  });

  it('works out who a teen may write to for a whole page at once', async () => {
    const kid = await teen();
    const friend = await inCountry('NG');
    const stranger = await inCountry('NG');
    await befriend(kid, friend);
    const fromFriend = await listing(friend, 3);
    const fromStranger = await listing(stranger, 2);
    const items = (await as(t.app, kid).post('/v1/market/search', { q: 'Perfqueries lamp', limit: 50 })).body.items as any[];
    expect(items.find((l) => l.id === fromFriend)).toMatchObject({ canContact: true });
    expect(items.find((l) => l.id === fromStranger)).toMatchObject({ canContact: false, contactBlock: 'minor_protection' });
  });
});

describe('orders list (one query for the page)', () => {
  it('lists your orders newest first with their items', async () => {
    const seller = await adult();
    const buyer = await adult();
    const product = async (title: string) => (await as(t.app, seller).post('/v1/products', { title, priceCents: 1500 })).body.product.id as string;
    const a = await product('Print A');
    const b = await product('Print B');
    const first = await as(t.app, buyer).post('/v1/orders', { items: [{ productId: a, quantity: 1 }], idempotencyKey: `perf_${Date.now()}_1` });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const second = await as(t.app, buyer).post('/v1/orders', { items: [{ productId: b, quantity: 2 }], idempotencyKey: `perf_${Date.now()}_2` });
    await db().query(`UPDATE orders SET created_at = now() - interval '1 hour' WHERE id = $1`, [first.body.order.id]);

    const list = (await as(t.app, buyer).get('/v1/orders')).body.items as any[];
    expect(ids(list)).toEqual([second.body.order.id, first.body.order.id]);
    expect(list[0].items).toEqual([expect.objectContaining({ productId: b, title: 'Print B', quantity: 2, unitCents: 1500 })]);
    expect(list[0]).toEqual(
      await as(t.app, buyer)
        .get(`/v1/orders/${second.body.order.id}`)
        .then((r) => r.body.order),
    );
    expect((await as(t.app, seller).get('/v1/orders')).body.items).toEqual([]);
  });
});
