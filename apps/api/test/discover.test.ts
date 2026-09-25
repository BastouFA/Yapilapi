import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, createTestApp, signup, uniq, type TestApp, type TestUser } from './helpers.js';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
});

const anon = () => new Client(t);
const teenBirth = () => `${new Date().getUTCFullYear() - 15}-02-02`;
const q = (text: string, params: unknown[] = []) => t.ctx.db.query(text, params);

// ------------------------------------------------------------------ fixtures
async function befriend(a: TestUser, b: TestUser) {
  const r = await a.client.post('/v1/friends/requests', { username: b.username });
  if (r.status >= 300)
    throw new Error(`friend request failed ${r.status} ${JSON.stringify(r.body)}`);
  const acc = await b.client.post(`/v1/friends/requests/${a.id}/accept`);
  if (acc.status !== 200)
    throw new Error(`accept failed ${acc.status} ${JSON.stringify(acc.body)}`);
}
const follow = (a: TestUser, b: TestUser) => a.client.put(`/v1/users/${b.username}/follow`);
const block = (a: TestUser, b: TestUser) => a.client.put(`/v1/users/${b.username}/block`);
const mute = (a: TestUser, b: TestUser) => a.client.put(`/v1/users/${b.username}/mute`);
const setPref = (u: TestUser, col: 'discoverable' | 'personalization', v: boolean) =>
  q(`UPDATE user_preferences SET ${col} = $2 WHERE user_id = $1`, [u.id, v]);
const setProfile = (
  u: TestUser,
  over: { display_name?: string; bio?: string; mode?: string; followers?: number },
) =>
  q(
    `UPDATE profiles SET display_name = COALESCE($2, display_name), bio = COALESCE($3, bio), mode = COALESCE($4, mode), follower_count = COALESCE($5, follower_count) WHERE user_id = $1`,
    [u.id, over.display_name ?? null, over.bio ?? null, over.mode ?? null, over.followers ?? null],
  );
const interests = (u: TestUser, topics: string[]) =>
  u.client.put('/v1/profile/interests', { topics });

const mkPost = async (u: TestUser, body: Record<string, unknown>) => {
  const r = await u.client.post('/v1/posts', body);
  if (r.status !== 201) throw new Error(`post failed ${r.status} ${JSON.stringify(r.body)}`);
  return r.body as { id: string };
};
const mkCommunity = async (owner: TestUser, over: Record<string, unknown> = {}) => {
  const r = await owner.client.post('/v1/communities', { name: `Community ${uniq('n')}`, ...over });
  if (r.status !== 201) throw new Error(`community failed ${r.status} ${JSON.stringify(r.body)}`);
  return r.body as { id: string; slug: string; name: string };
};
async function join(c: { id: string }, u: TestUser) {
  const r = await u.client.post(`/v1/communities/${c.id}/join`);
  if (r.status >= 300) throw new Error(`join failed ${r.status} ${JSON.stringify(r.body)}`);
}
const like = (u: TestUser, postId: string) =>
  u.client.put(`/v1/posts/${postId}/reaction`, { kind: 'like' });
async function likesFrom(fans: TestUser[], postId: string, n: number) {
  for (const f of fans.slice(0, n)) await like(f, postId);
}
const fans = async (n: number) => Promise.all(Array.from({ length: n }, () => signup(t)));

async function mkPlace(over: Record<string, unknown> = {}) {
  const r = await q(
    `INSERT INTO places (name, kind, description, latitude, longitude, capacity, rating_avg, rating_count, address, business_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [
      over.name ?? `Place ${uniq('p')}`,
      over.kind ?? 'restaurant',
      over.description ?? '',
      over.latitude ?? 40.7128,
      over.longitude ?? -74.006,
      over.capacity ?? null,
      over.rating_avg ?? 0,
      over.rating_count ?? 0,
      JSON.stringify({ city: 'Testville' }),
      over.business_id ?? null,
    ],
  );
  return r.rows[0].id as string;
}
async function mkEvent(host: TestUser | null, over: Record<string, unknown> = {}) {
  const start = (over.starts_at as Date | undefined) ?? new Date(Date.now() + 3 * 86_400_000);
  const r = await q(
    `INSERT INTO events (title, description, host_id, community_id, place_id, starts_at, ends_at, latitude, longitude, visibility, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [
      over.title ?? `Event ${uniq('e')}`,
      over.description ?? '',
      host?.id ?? null,
      over.community_id ?? null,
      over.place_id ?? null,
      start,
      over.ends_at ?? new Date(start.getTime() + 2 * 3600_000),
      over.latitude ?? null,
      over.longitude ?? null,
      over.visibility ?? 'public',
      over.status ?? 'published',
    ],
  );
  return r.rows[0].id as string;
}
async function mkBusiness(owner: TestUser, over: Record<string, unknown> = {}) {
  const r = await q(
    `INSERT INTO businesses (owner_id, slug, name, category, description, status, verified_at) VALUES ($1,$2,$3,$4,'',$5,$6) RETURNING id`,
    [
      owner.id,
      `b-${uniq('s')}`,
      over.name ?? `Business ${uniq('b')}`,
      over.category ?? 'general',
      over.status ?? 'active',
      over.verified ? new Date() : null,
    ],
  );
  return r.rows[0].id as string;
}
async function mkProduct(over: {
  business_id?: string;
  seller?: TestUser;
  title?: string;
  status?: string;
  price_cents?: number;
  stock?: number | null;
  kind?: string;
  rating_count?: number;
  rating_avg?: number;
}) {
  const r = await q(
    `INSERT INTO products (business_id, seller_user_id, kind, title, price_cents, currency, status, stock, rating_count, rating_avg) VALUES ($1,$2,$3,$4,$5,'USD',$6,$7,$8,$9) RETURNING id`,
    [
      over.business_id ?? null,
      over.business_id ? null : over.seller!.id,
      over.kind ?? 'physical',
      over.title ?? `Product ${uniq('p')}`,
      over.price_cents ?? 1000,
      over.status ?? 'active',
      over.stock ?? null,
      over.rating_count ?? 0,
      over.rating_avg ?? 0,
    ],
  );
  return r.rows[0].id as string;
}
async function mkLive(host: TestUser, over: Record<string, unknown> = {}) {
  const r = await q(
    `INSERT INTO live_sessions (host_id, title, status, visibility, started_at, ingest_ref) VALUES ($1,$2,$3,$4,now(),'secret-stream-key') RETURNING id`,
    [
      host.id,
      over.title ?? `Live ${uniq('l')}`,
      over.status ?? 'live',
      over.visibility ?? 'public',
    ],
  );
  return r.rows[0].id as string;
}
async function setFlag(key: string, enabled: boolean) {
  await q(
    `UPDATE feature_flags SET enabled = $2, rollout_pct = CASE WHEN $2 THEN 100 ELSE 0 END WHERE key = $1`,
    [key, enabled],
  );
  t.ctx.flags.invalidate();
}
const ids = (items: Array<{ id: string }>) => items.map((i) => i.id);
const personIds = (items: Array<{ user: { id: string } }>) => items.map((i) => i.user.id);

// ================================================================== trending
describe('trending', () => {
  it('ranks public posts by engagement velocity, with author diversity, and hides everything the viewer may not see', async () => {
    const crowd = await fans(6);
    const a = await signup(t);
    const b = await signup(t);
    const c = await signup(t);
    const viewer = await signup(t);
    const hot = await mkPost(a, { body: 'hot', visibility: 'public', topics: ['comedy'] });
    const warm = await mkPost(b, { body: 'warm', visibility: 'public', topics: ['comedy'] });
    const cold = await mkPost(c, {
      body: 'cold, no engagement',
      visibility: 'public',
      topics: ['comedy'],
    });
    await likesFrom(crowd, hot.id, 5);
    await likesFrom(crowd, warm.id, 1);
    // comments and shares also count, but each person counts once per post
    await crowd[0]!.client.post(`/v1/posts/${warm.id}/comments`, { body: 'nice' });
    await crowd[0]!.client.post(`/v1/posts/${warm.id}/comments`, { body: 'nice again' });

    // things that must never trend
    const friends = await mkPost(a, { body: 'friends only', visibility: 'friends' });
    const followersOnly = await mkPost(a, { body: 'followers only', visibility: 'followers' });
    const comm = await mkCommunity(a, { name: `Trend ${uniq('c')}` });
    const inCommunity = await mkPost(a, { body: 'community', communityId: comm.id });
    for (const p of [friends, followersOnly, inCommunity]) await likesFrom(crowd, p.id, 4);
    const priv = await signup(t);
    await q(`UPDATE profiles SET is_private = true WHERE user_id = $1`, [priv.id]);
    const privPost = await mkPost(priv, {
      body: 'private account public post',
      visibility: 'public',
    });
    await likesFrom(crowd, privPost.id, 4);
    const teen = await signup(t, { birthDate: teenBirth() });
    await q(
      `INSERT INTO community_members (community_id, user_id, role_key, status, joined_at) VALUES ($1,$2,'member','active',now())`,
      [comm.id, teen.id],
    );
    const teenPost = await mkPost(teen, { body: 'teen', communityId: comm.id });
    await likesFrom(crowd, teenPost.id, 4);
    // an author with many engaged posts appears at most twice
    const spammer = await signup(t);
    const spam: string[] = [];
    for (let i = 0; i < 4; i++) {
      const p = await mkPost(spammer, { body: `spam ${i}`, visibility: 'public' });
      spam.push(p.id);
      await likesFrom(crowd, p.id, 3);
    }
    // deleted and removed posts
    const del = await mkPost(b, { body: 'deleted', visibility: 'public' });
    await likesFrom(crowd, del.id, 4);
    await b.client.del(`/v1/posts/${del.id}`);
    const removed = await mkPost(b, { body: 'removed', visibility: 'public' });
    await likesFrom(crowd, removed.id, 4);
    await q(`UPDATE posts SET moderation_status = 'removed' WHERE id = $1`, [removed.id]);

    const r = await viewer.client.get('/v1/discover/trending', { limit: '50' });
    expect(r.status).toBe(200);
    const got = ids(r.body.items);
    expect(got.indexOf(hot.id)).toBeGreaterThanOrEqual(0);
    expect(got.indexOf(hot.id)).toBeLessThan(got.indexOf(warm.id));
    expect(got).not.toContain(cold.id);
    for (const hidden of [
      friends.id,
      followersOnly.id,
      inCommunity.id,
      privPost.id,
      teenPost.id,
      del.id,
      removed.id,
    ])
      expect(got).not.toContain(hidden);
    expect(got.filter((id) => spam.includes(id))).toHaveLength(2);
    expect(r.body.items.find((i: any) => i.id === hot.id)).toMatchObject({
      engagedBy: 5,
      reasons: ['Trending right now'],
      author: { username: a.username },
    });

    // anonymous callers get the same public list
    const an = await anon().get('/v1/discover/trending', { limit: '50' });
    expect(an.status).toBe(200);
    expect(ids(an.body.items)).toContain(hot.id);
  });

  it('honours blocks, mutes, muted topics and "not interested"', async () => {
    const crowd = await fans(4);
    const a = await signup(t);
    const viewer = await signup(t);
    const p = await mkPost(a, {
      body: 'visible to others',
      visibility: 'public',
      topics: ['pets'],
    });
    await likesFrom(crowd, p.id, 3);
    expect(
      ids((await viewer.client.get('/v1/discover/trending', { limit: '50' })).body.items),
    ).toContain(p.id);
    await mute(viewer, a);
    expect(
      ids((await viewer.client.get('/v1/discover/trending', { limit: '50' })).body.items),
    ).not.toContain(p.id);
    await viewer.client.del(`/v1/users/${a.username}/mute`);
    expect(
      ids((await viewer.client.get('/v1/discover/trending', { limit: '50' })).body.items),
    ).toContain(p.id);
    await viewer.client.put('/v1/topics/pets/mute');
    expect(
      ids((await viewer.client.get('/v1/discover/trending', { limit: '50' })).body.items),
    ).not.toContain(p.id);
    await viewer.client.del('/v1/topics/pets/mute');
    await viewer.client.post('/v1/feed/feedback', { postId: p.id, signal: 'not_interested' });
    expect(
      ids((await viewer.client.get('/v1/discover/trending', { limit: '50' })).body.items),
    ).not.toContain(p.id);
    const other = await signup(t);
    await block(other, a);
    expect(
      ids((await other.client.get('/v1/discover/trending', { limit: '50' })).body.items),
    ).not.toContain(p.id);
    // the author's own posts are not "trending for" them
    expect(
      ids((await a.client.get('/v1/discover/trending', { limit: '50' })).body.items),
    ).not.toContain(p.id);
  });

  it('newer engagement outranks the same engagement on an older post', async () => {
    const crowd = await fans(3);
    const a = await signup(t);
    const old = await mkPost(a, { body: 'old', visibility: 'public' });
    const fresh = await mkPost(await signup(t), { body: 'fresh', visibility: 'public' });
    await q(`UPDATE posts SET created_at = now() - interval '3 days' WHERE id = $1`, [old.id]);
    await likesFrom(crowd, old.id, 3);
    await likesFrom(crowd, fresh.id, 3);
    const got = ids(
      (await (await signup(t)).client.get('/v1/discover/trending', { limit: '50', window: '7d' }))
        .body.items,
    );
    expect(got.indexOf(fresh.id)).toBeGreaterThanOrEqual(0);
    expect(got.indexOf(old.id)).toBeGreaterThan(got.indexOf(fresh.id));
    // engagement outside the window does not count
    const stale = await mkPost(await signup(t), { body: 'stale engagement', visibility: 'public' });
    await likesFrom(crowd, stale.id, 3);
    await q(`UPDATE reactions SET created_at = now() - interval '3 hours' WHERE target_id = $1`, [
      stale.id,
    ]);
    const w1 = ids(
      (await (await signup(t)).client.get('/v1/discover/trending', { limit: '50', window: '1h' }))
        .body.items,
    );
    expect(w1).not.toContain(stale.id);
    expect(
      ids(
        (await (await signup(t)).client.get('/v1/discover/trending', { limit: '50', window: '6h' }))
          .body.items,
      ),
    ).toContain(stale.id);
  });

  it('trending topics need several distinct authors and skip muted topics', async () => {
    const crowd = await fans(3);
    const a = await signup(t);
    const b = await signup(t);
    const viewer = await signup(t);
    // 'comedy' style: two authors -> trends; single author on 'faith' -> does not
    const t1 = await mkPost(a, { body: 'topic one', visibility: 'public', topics: ['fashion'] });
    const t2 = await mkPost(b, { body: 'topic two', visibility: 'public', topics: ['fashion'] });
    const solo = await mkPost(a, { body: 'solo topic', visibility: 'public', topics: ['faith'] });
    const solo2 = await mkPost(a, {
      body: 'solo topic 2',
      visibility: 'public',
      topics: ['faith'],
    });
    for (const p of [t1, t2, solo, solo2]) await likesFrom(crowd, p.id, 2);
    const r = await viewer.client.get('/v1/discover/trending', { window: '24h' });
    const slugs = r.body.topics.map((x: any) => x.slug);
    expect(slugs).toContain('fashion');
    expect(slugs).not.toContain('faith');
    const fashion = r.body.topics.find((x: any) => x.slug === 'fashion');
    expect(fashion.authorCount).toBeGreaterThanOrEqual(2);
    expect(fashion).toMatchObject({ name: 'Fashion' });
    await viewer.client.put('/v1/topics/fashion/mute');
    expect(
      (await viewer.client.get('/v1/discover/trending')).body.topics.map((x: any) => x.slug),
    ).not.toContain('fashion');
    // topics are only on the first page
    const page1 = await anon().get('/v1/discover/trending', { limit: '1' });
    if (page1.body.nextCursor)
      expect(
        (await anon().get('/v1/discover/trending', { limit: '1', cursor: page1.body.nextCursor }))
          .body.topics,
      ).toEqual([]);
  });

  it('pages with keyset cursors without repeats', async () => {
    const crowd = await fans(3);
    const authors = await Promise.all([signup(t), signup(t), signup(t), signup(t), signup(t)]);
    const mine: string[] = [];
    for (const [i, a] of authors.entries()) {
      const p = await mkPost(a, { body: `page ${i}`, visibility: 'public' });
      mine.push(p.id);
      await likesFrom(crowd, p.id, 1 + (i % 3));
    }
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let n = 0; n < 60; n++) {
      const r = await anon().get('/v1/discover/trending', {
        limit: '4',
        ...(cursor ? { cursor } : {}),
      });
      expect(r.status).toBe(200);
      seen.push(...ids(r.body.items));
      cursor = r.body.nextCursor ?? undefined;
      if (!cursor) break;
    }
    expect(new Set(seen).size).toBe(seen.length);
    for (const id of mine) expect(seen).toContain(id);
  });

  it('validates input', async () => {
    const u = await signup(t);
    expect((await u.client.get('/v1/discover/trending', { window: '3y' })).status).toBe(400);
    expect((await u.client.get('/v1/discover/trending', { limit: '500' })).status).toBe(400);
    expect((await u.client.get('/v1/discover/trending', { cursor: 'garbage' })).status).toBe(400);
    const bad = Buffer.from(
      JSON.stringify({ s: 1, id: "1' OR '1'='1", snap: new Date().toISOString() }),
    ).toString('base64url');
    expect((await u.client.get('/v1/discover/trending', { cursor: bad })).status).toBe(400);
  });
});

// ================================================================== people
describe('people you may know', () => {
  it('suggests friends-of-friends, shared communities and shared interests, each with an explanation', async () => {
    const me = await signup(t);
    const friend = await signup(t);
    const fof = await signup(t, { displayName: 'Friend Of Friend' });
    const commMate = await signup(t);
    const interestMate = await signup(t);
    await befriend(me, friend);
    await befriend(friend, fof);
    const c = await mkCommunity(commMate, { name: `Shared ${uniq('s')}` });
    await join(c, me);
    await interests(me, ['travel', 'music']);
    await interests(interestMate, ['travel', 'gaming']);

    const r = await me.client.get('/v1/discover/people', { limit: '50' });
    expect(r.status).toBe(200);
    expect(r.body.source).toBe('graph');
    const by = new Map<string, any>(r.body.items.map((i: any) => [i.user.id, i]));
    expect(by.get(fof.id)).toMatchObject({
      reasons: ['1 mutual friend'],
      explanation: '1 mutual friend',
    });
    expect(by.get(fof.id).user).toMatchObject({
      username: fof.username,
      displayName: 'Friend Of Friend',
    });
    expect(by.get(commMate.id).reasons[0]).toBe(`Also in ${c.name}`);
    expect(by.get(interestMate.id).reasons[0]).toBe('Shares your interest in Travel');
    // ordering: mutual friends > shared community > shared interest
    const order = personIds(r.body.items);
    expect(order.indexOf(fof.id)).toBeLessThan(order.indexOf(commMate.id));
    expect(order.indexOf(commMate.id)).toBeLessThan(order.indexOf(interestMate.id));
    // never suggests yourself or people you are already friends with
    expect(order).not.toContain(me.id);
    expect(order).not.toContain(friend.id);
  });

  it('excludes followed, blocked, muted, non-discoverable, teen, suspended and pending-friend accounts', async () => {
    const me = await signup(t);
    const friend = await signup(t);
    await befriend(me, friend);
    const cands: Record<string, TestUser> = {};
    for (const k of [
      'ok',
      'followed',
      'blocked',
      'blockedMe',
      'muted',
      'quiet',
      'teen',
      'suspended',
      'pending',
      'requested',
    ]) {
      cands[k] = await signup(t, k === 'teen' ? { birthDate: teenBirth() } : {});
      if (k !== 'teen') await befriend(friend, cands[k]!);
      else
        await q(
          `INSERT INTO friendships (user_low, user_high, requester_id, status, accepted_at) VALUES (LEAST($1::uuid,$2::uuid), GREATEST($1::uuid,$2::uuid), $1, 'accepted', now())`,
          [friend.id, cands[k]!.id],
        );
    }
    await follow(me, cands.followed!);
    await q(`UPDATE follows SET status = 'active' WHERE follower_id = $1`, [me.id]);
    await block(me, cands.blocked!);
    await block(cands.blockedMe!, me);
    await mute(me, cands.muted!);
    await setPref(cands.quiet!, 'discoverable', false);
    await q(`UPDATE users SET status = 'suspended' WHERE id = $1`, [cands.suspended!.id]);
    // pending friend request from me: no point suggesting them
    await q(
      `INSERT INTO friendships (user_low, user_high, requester_id, status) VALUES (LEAST($1::uuid,$2::uuid), GREATEST($1::uuid,$2::uuid), $1, 'pending')`,
      [me.id, cands.pending!.id],
    );
    await q(
      `INSERT INTO friendships (user_low, user_high, requester_id, status) VALUES (LEAST($1::uuid,$2::uuid), GREATEST($1::uuid,$2::uuid), $2, 'pending')`,
      [me.id, cands.requested!.id],
    );

    const r = await me.client.get('/v1/discover/people', { limit: '50' });
    const got = personIds(r.body.items);
    expect(got).toContain(cands.ok!.id);
    for (const k of [
      'followed',
      'blocked',
      'blockedMe',
      'muted',
      'quiet',
      'teen',
      'suspended',
      'pending',
      'requested',
    ])
      expect(got, k).not.toContain(cands[k]!.id);
    // once the block is lifted the person is suggestable again (and never leaks while blocked)
    await me.client.del(`/v1/users/${cands.blocked!.username}/block`);
  });

  it('teens only get suggestions from their own network and never see adult strangers via interests', async () => {
    const teen = await signup(t, { birthDate: teenBirth() });
    const stranger = await signup(t);
    await interests(teen, ['music']);
    await interests(stranger, ['music']);
    const r = await teen.client.get('/v1/discover/people', { limit: '50' });
    expect(personIds(r.body.items)).not.toContain(stranger.id);
    // and the reverse: an adult never gets a teen suggested from shared interests / communities
    const adult = await signup(t);
    await interests(adult, ['music']);
    const c = await mkCommunity(teen, { name: `Teen club ${uniq('t')}` });
    void c;
    const r2 = await adult.client.get('/v1/discover/people', { limit: '50' });
    expect(personIds(r2.body.items)).not.toContain(teen.id);
  });

  it('falls back to cold-start suggestions and respects the personalization opt-out', async () => {
    const creator = await signup(t, { displayName: 'Popular Creator' });
    await setProfile(creator, { mode: 'creator', followers: 900 });
    const newbie = await signup(t);
    const r = await newbie.client.get('/v1/discover/people', { limit: '30' });
    expect(r.status).toBe(200);
    expect(r.body.source).toBe('popular');
    const c = r.body.items.find((i: any) => i.user.id === creator.id);
    expect(c.reasons).toEqual(['Popular creator on YAPILAPI']);
    expect(personIds(r.body.items)).not.toContain(newbie.id);

    // with interests the cold start is topical (a topic nobody else lists, so the graph is empty)
    const musical = await signup(t);
    await setProfile(musical, { mode: 'creator' });
    await mkPost(musical, { body: 'a garden', visibility: 'public', topics: ['home-garden'] });
    const listener = await signup(t);
    await interests(listener, ['home-garden']);
    const r2 = await listener.client.get('/v1/discover/people', { limit: '50' });
    expect(r2.body.source).toBe('interests');
    expect(r2.body.items.find((i: any) => i.user.id === musical.id).reasons).toContain(
      'Posts about Home & Garden',
    );

    // opting out of personalization removes interest/graph signals entirely
    const friend = await signup(t);
    const fof = await signup(t);
    await befriend(listener, friend);
    await befriend(friend, fof);
    expect(
      personIds((await listener.client.get('/v1/discover/people', { limit: '50' })).body.items),
    ).toContain(fof.id);
    await setPref(listener, 'personalization', false);
    const off = await listener.client.get('/v1/discover/people', { limit: '50' });
    expect(off.body.source).toBe('popular');
    expect(
      off.body.items.every(
        (i: any) => !/mutual|Shares your interest|Posts about/.test(i.explanation),
      ),
    ).toBe(true);
  });

  it('pages friend-of-friend suggestions without repeats', async () => {
    const me = await signup(t);
    const friend = await signup(t);
    await befriend(me, friend);
    const fofs: TestUser[] = [];
    for (let i = 0; i < 5; i++) {
      const f = await signup(t);
      await befriend(friend, f);
      fofs.push(f);
    }
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let n = 0; n < 10; n++) {
      const r = await me.client.get('/v1/discover/people', {
        limit: '2',
        ...(cursor ? { cursor } : {}),
      });
      seen.push(...personIds(r.body.items));
      cursor = r.body.nextCursor ?? undefined;
      if (!cursor) break;
    }
    expect(seen.sort()).toEqual(fofs.map((f) => f.id).sort());
  });

  it('requires authentication', async () => {
    expect((await anon().get('/v1/discover/people')).status).toBe(401);
    expect((await anon().get('/v1/discover/suggested-follows')).status).toBe(401);
  });
});

describe('onboarding: suggested follows', () => {
  it('suggests creators and people for chosen topics before interests are saved', async () => {
    const poster = await signup(t, { displayName: 'Photo Person' });
    await mkPost(poster, { body: 'sunset', visibility: 'public', topics: ['photography'] });
    const lister = await signup(t, { displayName: 'Interest Lister' });
    await interests(lister, ['photography']);
    const other = await signup(t);
    await mkPost(other, { body: 'unrelated', visibility: 'public', topics: ['cars'] });
    const newbie = await signup(t);
    const r = await newbie.client.get('/v1/discover/suggested-follows', { topics: 'photography' });
    expect(r.status).toBe(200);
    expect(r.body.basedOn).toEqual(['photography']);
    expect(r.body.source).toBe('interests');
    const got = personIds(r.body.items);
    expect(got).toEqual(expect.arrayContaining([poster.id, lister.id]));
    expect(got).not.toContain(other.id);
    expect(r.body.items.find((i: any) => i.user.id === poster.id).explanation).toBe(
      'Posts about Photography',
    );
    expect(r.body.items.find((i: any) => i.user.id === lister.id).explanation).toBe(
      'Interested in Photography',
    );

    // uses saved interests when no topics are given; unknown topics are ignored; invalid slugs are rejected
    await interests(newbie, ['photography']);
    expect((await newbie.client.get('/v1/discover/suggested-follows')).body.basedOn).toEqual([
      'photography',
    ]);
    expect(
      (await newbie.client.get('/v1/discover/suggested-follows', { topics: 'no-such-topic' })).body
        .basedOn,
    ).toEqual([]);
    expect(
      (
        await newbie.client.get('/v1/discover/suggested-follows', {
          topics: "x'; drop table users;--",
        })
      ).status,
    ).toBe(400);
    expect(
      (await newbie.client.get('/v1/discover/suggested-follows', { limit: '99' })).status,
    ).toBe(400);
  });

  it('never suggests already followed, blocked or non-discoverable accounts, or teens to adults', async () => {
    const newbie = await signup(t);
    const followed = await signup(t);
    const blocked = await signup(t);
    const quiet = await signup(t);
    const teen = await signup(t, { birthDate: teenBirth() });
    const ok = await signup(t);
    for (const u of [followed, blocked, quiet, teen, ok]) await interests(u, ['diy-crafts']);
    await q(`UPDATE user_preferences SET discoverable = true WHERE user_id = $1`, [teen.id]); // forced on: teens are still excluded
    await follow(newbie, followed);
    await block(newbie, blocked);
    await setPref(quiet, 'discoverable', false);
    const got = personIds(
      (await newbie.client.get('/v1/discover/suggested-follows', { topics: 'diy-crafts' })).body
        .items,
    );
    expect(got).toContain(ok.id);
    for (const u of [followed, blocked, quiet, teen]) expect(got).not.toContain(u.id);
  });

  it('gives teens creators only', async () => {
    const teen = await signup(t, { birthDate: teenBirth() });
    const person = await signup(t);
    const creator = await signup(t);
    await setProfile(creator, { mode: 'creator' });
    for (const u of [person, creator]) await interests(u, ['nature']);
    const got = personIds(
      (await teen.client.get('/v1/discover/suggested-follows', { topics: 'nature' })).body.items,
    );
    expect(got).toContain(creator.id);
    expect(got).not.toContain(person.id);
  });
});

// ================================================================== creators
describe('creators', () => {
  it('lists discoverable creators with reasons; topic filter; exclusions', async () => {
    const viewer = await signup(t);
    const c1 = await signup(t, { displayName: 'Creator One' });
    const c2 = await signup(t, { displayName: 'Creator Two' });
    const followed = await signup(t);
    const quiet = await signup(t);
    const notCreator = await signup(t);
    const teenCreator = await signup(t, { birthDate: teenBirth() });
    for (const u of [c1, c2, followed, quiet, teenCreator])
      await setProfile(u, { mode: 'creator' });
    await setProfile(c1, { followers: 40 });
    await mkPost(c1, { body: 'on topic', visibility: 'public', topics: ['writing'] });
    await mkPost(c1, { body: 'more', visibility: 'public', topics: ['writing'] });
    await mkPost(c1, { body: 'more 2', visibility: 'public', topics: ['writing'] });
    await mkPost(c2, { body: 'other topic', visibility: 'public', topics: ['cars'] });
    await follow(viewer, followed);
    await setPref(quiet, 'discoverable', false);
    await interests(viewer, ['writing']);

    const r = await viewer.client.get('/v1/discover/creators', { limit: '50' });
    expect(r.status).toBe(200);
    const got = personIds(r.body.items);
    expect(got).toEqual(expect.arrayContaining([c1.id, c2.id]));
    for (const hidden of [followed.id, quiet.id, notCreator.id, teenCreator.id, viewer.id])
      expect(got).not.toContain(hidden);
    expect(got.indexOf(c1.id)).toBeLessThan(got.indexOf(c2.id)); // interest match + followers + recent activity
    expect(r.body.items.find((i: any) => i.user.id === c1.id).reasons).toEqual([
      'Posts about Writing & Books',
      'Active recently',
      '40 followers',
    ]);

    const filtered = await viewer.client.get('/v1/discover/creators', {
      topic: 'cars',
      limit: '50',
    });
    expect(personIds(filtered.body.items)).toEqual([c2.id]);
    expect((await viewer.client.get('/v1/discover/creators', { topic: 'Bad Topic!' })).status).toBe(
      400,
    );

    // anonymous callers can browse creators too (no personalisation)
    const an = await anon().get('/v1/discover/creators', { limit: '50' });
    expect(personIds(an.body.items)).toEqual(expect.arrayContaining([c1.id, c2.id, followed.id]));
    expect(personIds(an.body.items)).not.toContain(quiet.id);

    await block(viewer, c2);
    expect(
      personIds((await viewer.client.get('/v1/discover/creators', { limit: '50' })).body.items),
    ).not.toContain(c2.id);
  });
});

// ================================================================== communities
describe('communities', () => {
  it('matches public communities to interests with reasons and excludes what you are in', async () => {
    const owner = await signup(t);
    const viewer = await signup(t);
    const friend = await signup(t);
    await befriend(viewer, friend);
    await interests(viewer, ['startups']);
    const matched = await mkCommunity(owner, {
      name: `Founders ${uniq('f')}`,
      topics: ['startups'],
    });
    const social = await mkCommunity(owner, { name: `Friends here ${uniq('f')}` });
    const plain = await mkCommunity(owner, { name: `Plain ${uniq('p')}` });
    const priv = await mkCommunity(owner, {
      name: `Private ${uniq('p')}`,
      visibility: 'private',
      topics: ['startups'],
    });
    const sec = await mkCommunity(owner, {
      name: `Secret ${uniq('s')}`,
      visibility: 'secret',
      topics: ['startups'],
    });
    const joined = await mkCommunity(owner, { name: `Joined ${uniq('j')}`, topics: ['startups'] });
    const banned = await mkCommunity(owner, { name: `Banned ${uniq('b')}`, topics: ['startups'] });
    await join(social, friend);
    await join(joined, viewer);
    await q(
      `INSERT INTO community_members (community_id, user_id, role_key, status) VALUES ($1,$2,'member','banned')`,
      [banned.id, viewer.id],
    );
    for (let i = 0; i < 3; i++)
      await mkPost(owner, { body: `activity ${i}`, communityId: plain.id });

    const r = await viewer.client.get('/v1/discover/communities', { limit: '50' });
    expect(r.status).toBe(200);
    const by = new Map<string, any>(r.body.items.map((i: any) => [i.id, i]));
    expect(by.get(matched.id).reasons).toContain('Matches your interests: Startups');
    expect(by.get(social.id).reasons).toContain('1 of your friends is a member');
    expect(by.get(plain.id).reasons).toContain('Active this week');
    expect(by.get(matched.id).topics).toEqual(['startups']);
    for (const hidden of [priv.id, sec.id, joined.id, banned.id])
      expect(by.has(hidden)).toBe(false);
    const order = ids(r.body.items);
    expect(order.indexOf(matched.id)).toBeLessThan(order.indexOf(plain.id));

    // topic filter
    const f = await viewer.client.get('/v1/discover/communities', {
      topic: 'startups',
      limit: '50',
    });
    expect(ids(f.body.items)).toEqual([matched.id]);

    // anonymous browsing works without personalisation
    const an = await anon().get('/v1/discover/communities', { limit: '50' });
    expect(ids(an.body.items)).toEqual(expect.arrayContaining([matched.id, joined.id]));
    expect(ids(an.body.items)).not.toContain(priv.id);
    expect(ids(an.body.items)).not.toContain(sec.id);
  });

  it('does not use interests or friends when personalization is off; pages by keyset', async () => {
    const owner = await signup(t);
    const viewer = await signup(t);
    await interests(viewer, ['languages']);
    const cs: string[] = [];
    for (let i = 0; i < 5; i++)
      cs.push(
        (await mkCommunity(owner, { name: `Lang ${uniq('l')} ${i}`, topics: ['languages'] })).id,
      );
    expect(
      (await viewer.client.get('/v1/discover/communities', { topic: 'languages' })).body.items[0]
        .reasons[0],
    ).toMatch(/Matches your interests/);
    await setPref(viewer, 'personalization', false);
    const off = await viewer.client.get('/v1/discover/communities', {
      topic: 'languages',
      limit: '50',
    });
    expect(off.body.items.every((i: any) => !/interests/.test(i.explanation))).toBe(true);
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let n = 0; n < 10; n++) {
      const r = await viewer.client.get('/v1/discover/communities', {
        topic: 'languages',
        limit: '2',
        ...(cursor ? { cursor } : {}),
      });
      seen.push(...ids(r.body.items));
      cursor = r.body.nextCursor ?? undefined;
      if (!cursor) break;
    }
    expect(seen.sort()).toEqual([...cs].sort());
  });
});

// ================================================================== topics
describe('topics', () => {
  it('lists topics to explore, un-followed first, with reasons; muted topics are omitted', async () => {
    const viewer = await signup(t);
    await interests(viewer, ['beauty']);
    const author = await signup(t);
    for (let i = 0; i < 2; i++)
      await mkPost(author, { body: `hair ${i}`, visibility: 'public', topics: ['cars'] });
    await viewer.client.put('/v1/topics/politics/mute');
    const r = await viewer.client.get('/v1/discover/topics', { limit: '50' });
    expect(r.status).toBe(200);
    const slugs = r.body.items.map((i: any) => i.slug);
    expect(slugs).not.toContain('politics');
    const beauty = r.body.items.find((i: any) => i.slug === 'beauty');
    expect(beauty).toMatchObject({ interested: true, reason: 'In your interests' });
    expect(r.body.items.findIndex((i: any) => i.slug === 'cars')).toBeLessThan(
      slugs.indexOf('beauty'),
    );
    expect(r.body.items.find((i: any) => i.slug === 'cars').postsThisWeek).toBeGreaterThanOrEqual(
      2,
    );
    expect(
      (await viewer.client.get('/v1/discover/topics', { limit: '3' })).body.items,
    ).toHaveLength(3);
    expect((await viewer.client.get('/v1/discover/topics', { limit: '0' })).status).toBe(400);
    expect((await anon().get('/v1/discover/topics')).status).toBe(200);
  });

  it('does not count private accounts or teens in topic activity', async () => {
    const before = (await anon().get('/v1/discover/topics', { limit: '50' })).body.items.find(
      (i: any) => i.slug === 'parenting',
    ).postsThisWeek;
    const priv = await signup(t);
    await q(`UPDATE profiles SET is_private = true WHERE user_id = $1`, [priv.id]);
    await mkPost(priv, { body: 'private acct', visibility: 'public', topics: ['parenting'] });
    const after = (await anon().get('/v1/discover/topics', { limit: '50' })).body.items.find(
      (i: any) => i.slug === 'parenting',
    ).postsThisWeek;
    expect(after).toBe(before);
  });
});

// ================================================================== places & events
describe('places and events', () => {
  const HOME = { lat: 51.5, lng: -0.12 };

  it('lists places by distance (haversine) within a radius, filters by kind, and pages', async () => {
    const tag = uniq('pl');
    const viewer = await signup(t);
    const near = await mkPlace({ name: `Near ${tag}`, latitude: 51.505, longitude: -0.12 });
    const mid = await mkPlace({
      name: `Mid ${tag}`,
      latitude: 51.55,
      longitude: -0.12,
      kind: 'venue',
    });
    const far = await mkPlace({ name: `Far ${tag}`, latitude: 52.5, longitude: -0.12 });
    const deleted = await mkPlace({ name: `Deleted ${tag}`, latitude: 51.5, longitude: -0.121 });
    await q(`UPDATE places SET deleted_at = now() WHERE id = $1`, [deleted]);
    const r = await viewer.client.get('/v1/discover/places', {
      ...{ lat: String(HOME.lat), lng: String(HOME.lng) },
      radiusKm: '20',
      limit: '50',
    });
    expect(r.status).toBe(200);
    const order = ids(r.body.items).filter((i) => [near, mid, far, deleted].includes(i));
    expect(order).toEqual([near, mid]);
    expect(r.body.items.find((i: any) => i.id === near).distanceKm).toBeCloseTo(0.6, 0);
    expect(r.body.items.find((i: any) => i.id === mid).distanceKm).toBeCloseTo(5.6, 0);
    const wide = await viewer.client.get('/v1/discover/places', {
      lat: String(HOME.lat),
      lng: String(HOME.lng),
      radiusKm: '200',
      limit: '50',
    });
    expect(ids(wide.body.items).filter((i) => [near, mid, far].includes(i))).toEqual([
      near,
      mid,
      far,
    ]);
    const venues = await viewer.client.get('/v1/discover/places', {
      lat: String(HOME.lat),
      lng: String(HOME.lng),
      radiusKm: '20',
      kind: 'venue',
      limit: '50',
    });
    expect(ids(venues.body.items)).toEqual([mid]);

    // paging
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let n = 0; n < 10; n++) {
      const p = await viewer.client.get('/v1/discover/places', {
        lat: String(HOME.lat),
        lng: String(HOME.lng),
        radiusKm: '200',
        limit: '1',
        ...(cursor ? { cursor } : {}),
      });
      seen.push(...ids(p.body.items));
      cursor = p.body.nextCursor ?? undefined;
      if (!cursor) break;
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.filter((i) => [near, mid, far].includes(i))).toEqual([near, mid, far]);

    // without coordinates: top rated first
    const best = await mkPlace({
      name: `Best ${tag}`,
      rating_avg: 4.9,
      rating_count: 500,
      latitude: -33.9,
      longitude: 151.2,
    });
    const top = await anon().get('/v1/discover/places', { limit: '5' });
    expect(ids(top.body.items)).toContain(best);
    expect(top.body.items[0].distanceKm).toBeUndefined();

    expect((await viewer.client.get('/v1/discover/places', { lat: '10' })).status).toBe(400);
    expect((await viewer.client.get('/v1/discover/places', { lat: '95', lng: '0' })).status).toBe(
      400,
    );
    expect((await viewer.client.get('/v1/discover/places', { kind: 'spaceship' })).status).toBe(
      400,
    );
  });

  it('lists upcoming events in start order, nearby, in time windows, applying event visibility', async () => {
    const host = await signup(t);
    const friend = await signup(t);
    const stranger = await signup(t);
    await befriend(host, friend);
    const day = 86_400_000;
    const soon = await mkEvent(host, {
      title: 'Soon',
      starts_at: new Date(Date.now() + 2 * 3600_000),
      latitude: 35.0,
      longitude: 139.7,
    });
    const later = await mkEvent(host, {
      title: 'Later',
      starts_at: new Date(Date.now() + 5 * day),
      latitude: 35.01,
      longitude: 139.7,
    });
    const faraway = await mkEvent(host, {
      title: 'Faraway',
      starts_at: new Date(Date.now() + 3 * day),
      latitude: 48.85,
      longitude: 2.35,
    });
    const friendsOnly = await mkEvent(host, {
      title: 'Friends',
      visibility: 'friends',
      starts_at: new Date(Date.now() + 4 * day),
      latitude: 35.0,
      longitude: 139.7,
    });
    const draft = await mkEvent(host, {
      title: 'Draft',
      status: 'draft',
      latitude: 35.0,
      longitude: 139.7,
    });
    const past = await mkEvent(host, {
      title: 'Past',
      starts_at: new Date(Date.now() - 3 * day),
      latitude: 35.0,
      longitude: 139.7,
    });
    const geo = { lat: '35.0', lng: '139.7', radiusKm: '30' };

    const s = await stranger.client.get('/v1/discover/events', { ...geo, limit: '50' });
    expect(ids(s.body.items)).toEqual([soon, later]);
    expect(s.body.items[0]).toMatchObject({ title: 'Soon', host: { username: host.username } });
    expect(s.body.items[0].distanceKm).toBeLessThan(1);
    const f = await friend.client.get('/v1/discover/events', { ...geo, limit: '50' });
    expect(ids(f.body.items)).toEqual([soon, friendsOnly, later]);
    expect(ids(f.body.items)).not.toContain(draft);
    expect(ids(f.body.items)).not.toContain(past);
    expect(ids(f.body.items)).not.toContain(faraway);
    const all = await stranger.client.get('/v1/discover/events', { limit: '50' });
    expect(ids(all.body.items)).toEqual(expect.arrayContaining([soon, later, faraway]));
    expect(ids(all.body.items)).not.toContain(friendsOnly);
    await block(stranger, host);
    expect(
      ids((await stranger.client.get('/v1/discover/events', { ...geo, limit: '50' })).body.items),
    ).toEqual([]);

    // paging in start order
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let n = 0; n < 10; n++) {
      const p = await friend.client.get('/v1/discover/events', {
        ...geo,
        limit: '1',
        ...(cursor ? { cursor } : {}),
      });
      seen.push(...ids(p.body.items));
      cursor = p.body.nextCursor ?? undefined;
      if (!cursor) break;
    }
    expect(seen).toEqual([soon, friendsOnly, later]);
    expect((await friend.client.get('/v1/discover/events', { cursor: 'nope' })).status).toBe(400);
    expect((await friend.client.get('/v1/discover/events', { when: 'someday' })).status).toBe(400);
  });

  it('resolves time windows in the viewer time zone', async () => {
    const host = await signup(t);
    const viewer = await signup(t);
    const r = await viewer.client.get('/v1/discover/events', {
      when: 'tomorrow',
      tz: 'Pacific/Auckland',
    });
    expect(r.status).toBe(200);
    expect(r.body.window.label).toBe('tomorrow');
    const from = new Date(r.body.window.from);
    const inside = await mkEvent(host, {
      title: 'Tomorrow evening',
      starts_at: new Date(from.getTime() + 18 * 3600_000),
      latitude: -36.85,
      longitude: 174.76,
    });
    const outside = await mkEvent(host, {
      title: 'Day after',
      starts_at: new Date(from.getTime() + 30 * 3600_000),
      latitude: -36.85,
      longitude: 174.76,
    });
    const again = await viewer.client.get('/v1/discover/events', {
      when: 'tomorrow',
      tz: 'Pacific/Auckland',
      limit: '50',
    });
    expect(ids(again.body.items)).toContain(inside);
    expect(ids(again.body.items)).not.toContain(outside);
  });
});

// ================================================================== commerce
describe('products and businesses', () => {
  it('lists only purchasable products from visible sellers; COMMERCE flag gates them', async () => {
    const seller = await signup(t);
    const owner = await signup(t);
    const viewer = await signup(t);
    const biz = await mkBusiness(owner, { name: `Shop ${uniq('s')}` });
    const closed = await mkBusiness(owner, { status: 'suspended' });
    const good = await mkProduct({
      business_id: biz,
      title: 'Good',
      rating_avg: 4.5,
      rating_count: 20,
    });
    const cheap = await mkProduct({ seller, title: 'Cheap', price_cents: 300, kind: 'digital' });
    const draft = await mkProduct({ seller, status: 'draft' });
    const soldOut = await mkProduct({ seller, status: 'sold_out' });
    const noStock = await mkProduct({ seller, stock: 0 });
    const closedBiz = await mkProduct({ business_id: closed });
    const r = await viewer.client.get('/v1/discover/products', { limit: '50' });
    expect(r.status).toBe(200);
    const got = ids(r.body.items);
    expect(got).toEqual(expect.arrayContaining([good, cheap]));
    for (const hidden of [draft, soldOut, noStock, closedBiz]) expect(got).not.toContain(hidden);
    expect(got.indexOf(good)).toBeLessThan(got.indexOf(cheap)); // rated product first
    expect(r.body.items.find((i: any) => i.id === good)).toMatchObject({
      seller: { type: 'business', id: biz },
      inStock: true,
      currency: 'USD',
    });

    expect(
      ids(
        (await viewer.client.get('/v1/discover/products', { kind: 'digital', limit: '50' })).body
          .items,
      ),
    ).toContain(cheap);
    expect(
      ids(
        (await viewer.client.get('/v1/discover/products', { kind: 'digital', limit: '50' })).body
          .items,
      ),
    ).not.toContain(good);
    expect(
      ids(
        (await viewer.client.get('/v1/discover/products', { maxPriceCents: '500', limit: '50' }))
          .body.items,
      ),
    ).toEqual([cheap].filter((x) => x));

    await block(viewer, seller);
    expect(
      ids((await viewer.client.get('/v1/discover/products', { limit: '50' })).body.items),
    ).not.toContain(cheap);

    await setFlag('COMMERCE', false);
    try {
      const off = await viewer.client.get('/v1/discover/products');
      expect(off.status).toBe(404);
      expect(off.body.error.code).toBe('feature_disabled');
    } finally {
      await setFlag('COMMERCE', true);
    }
  });

  it('lists active businesses, verified first, optionally near a place', async () => {
    const owner = await signup(t);
    const viewer = await signup(t);
    const verified = await mkBusiness(owner, {
      name: `Verified ${uniq('v')}`,
      verified: true,
      category: 'cafe-x',
    });
    const plain = await mkBusiness(owner, { name: `Plain ${uniq('p')}`, category: 'cafe-x' });
    const pending = await mkBusiness(owner, { status: 'pending', category: 'cafe-x' });
    await mkPlace({ name: 'Branch', latitude: -20.0, longitude: 30.0, business_id: plain });
    const r = await viewer.client.get('/v1/discover/businesses', {
      category: 'cafe-x',
      limit: '50',
    });
    expect(ids(r.body.items)).toEqual([verified, plain]);
    expect(ids(r.body.items)).not.toContain(pending);
    const near = await viewer.client.get('/v1/discover/businesses', {
      lat: '-20.0',
      lng: '30.0',
      radiusKm: '5',
      limit: '50',
    });
    expect(ids(near.body.items)).toEqual([plain]);
    await block(viewer, owner);
    expect(
      ids(
        (await viewer.client.get('/v1/discover/businesses', { category: 'cafe-x', limit: '50' }))
          .body.items,
      ),
    ).toEqual([]);
  });
});

// ================================================================== live
describe('live (feature flag LIVE)', () => {
  it('is hidden while the flag is off, then lists live sessions the viewer may watch', async () => {
    const host = await signup(t);
    const follower = await signup(t);
    const subscriber = await signup(t);
    const stranger = await signup(t);
    await follow(follower, host);
    const pub = await mkLive(host, { title: 'Public live' });
    const fol = await mkLive(host, { title: 'Followers live', visibility: 'followers' });
    const sub = await mkLive(host, { title: 'Subscribers live', visibility: 'subscribers' });
    const prv = await mkLive(host, { title: 'Private live', visibility: 'private' });
    const ended = await mkLive(host, { title: 'Ended', status: 'ended' });
    const scheduled = await mkLive(host, { title: 'Scheduled', status: 'scheduled' });
    await q(`INSERT INTO creators (user_id) VALUES ($1)`, [host.id]);
    const plan = await q(
      `INSERT INTO subscription_plans (creator_id, name, price_cents, currency, interval) VALUES ($1,'Gold',500,'USD','month') RETURNING id`,
      [host.id],
    );
    await q(
      `INSERT INTO subscriptions (subscriber_id, plan_id, creator_id, status, current_period_end) VALUES ($1,$2,$3,'active', now() + interval '30 days')`,
      [subscriber.id, plan.rows[0].id, host.id],
    );

    const off = await stranger.client.get('/v1/discover/live');
    expect(off.status).toBe(404);
    expect(off.body.error.code).toBe('feature_disabled');
    expect((await anon().get('/v1/discover/live')).status).toBe(404);

    await setFlag('LIVE', true);
    try {
      const seen = async (c: Client) =>
        ids((await c.get('/v1/discover/live', { limit: '50' })).body.items)
          .filter((i) => [pub, fol, sub, prv, ended, scheduled].includes(i))
          .sort();
      expect(await seen(stranger.client)).toEqual([pub]);
      expect(await seen(anon())).toEqual([pub]);
      expect(await seen(follower.client)).toEqual([pub, fol].sort());
      expect(await seen(subscriber.client)).toEqual([pub, sub].sort());
      expect(await seen(host.client)).toEqual([pub, fol, sub].sort()); // own private live is managed elsewhere, not "discovered"
      const item = (
        await stranger.client.get('/v1/discover/live', { limit: '50' })
      ).body.items.find((i: any) => i.id === pub);
      expect(item).toMatchObject({
        title: 'Public live',
        host: { username: host.username },
        viewerCount: 0,
        ticketed: false,
      });
      expect(JSON.stringify(item)).not.toContain('secret-stream-key');
      expect(Object.keys(item)).not.toContain('ingestRef');
      // blocked hosts and teen hosts
      await block(stranger, host);
      expect(await seen(stranger.client)).toEqual([]);
      const teenHost = await signup(t, { birthDate: teenBirth() });
      const teenLive = await mkLive(teenHost, { title: 'Teen live' });
      expect(
        ids((await follower.client.get('/v1/discover/live', { limit: '50' })).body.items),
      ).not.toContain(teenLive);
      // paging
      const p1 = await follower.client.get('/v1/discover/live', { limit: '1' });
      expect(p1.body.items).toHaveLength(1);
      expect(p1.body.nextCursor).toBeTruthy();
      const p2 = await follower.client.get('/v1/discover/live', {
        limit: '1',
        cursor: p1.body.nextCursor,
      });
      expect(p2.body.items[0].id).not.toBe(p1.body.items[0].id);
      expect((await follower.client.get('/v1/discover/live', { cursor: 'x' })).status).toBe(400);
    } finally {
      await setFlag('LIVE', false);
    }
  });
});

// ================================================================== local
describe('local', () => {
  it('bundles places, events, public posts and businesses around a location', async () => {
    const tag = uniq('loc');
    const author = await signup(t);
    const viewer = await signup(t);
    const owner = await signup(t);
    const geo = { lat: '-1.29', lng: '36.82', radiusKm: '10' };
    const place = await mkPlace({ name: `Local ${tag}`, latitude: -1.29, longitude: 36.82 });
    const farPlace = await mkPlace({ name: `Faraway ${tag}`, latitude: 10, longitude: 40 });
    const event = await mkEvent(author, {
      title: `Local event ${tag}`,
      latitude: -1.291,
      longitude: 36.821,
    });
    const biz = await mkBusiness(owner, { name: `Local biz ${tag}` });
    await mkPlace({
      name: `Biz branch ${tag}`,
      latitude: -1.292,
      longitude: 36.82,
      business_id: biz,
    });
    const post = await mkPost(author, {
      body: `local post ${tag}`,
      visibility: 'public',
      latitude: -1.2905,
      longitude: 36.8205,
    });
    const friendsPost = await mkPost(author, {
      body: `friends local ${tag}`,
      visibility: 'friends',
      latitude: -1.2905,
      longitude: 36.8205,
    });
    const farPost = await mkPost(author, {
      body: `far post ${tag}`,
      visibility: 'public',
      latitude: 40,
      longitude: -70,
    });
    const r = await viewer.client.get('/v1/discover/local', geo);
    expect(r.status).toBe(200);
    expect(ids(r.body.places)).toContain(place);
    expect(ids(r.body.places)).not.toContain(farPlace);
    expect(ids(r.body.events)).toContain(event);
    expect(ids(r.body.posts)).toEqual([post.id]);
    expect(ids(r.body.posts)).not.toContain(friendsPost.id);
    expect(ids(r.body.posts)).not.toContain(farPost.id);
    expect(ids(r.body.businesses)).toContain(biz);
    expect(r.body.radiusKm).toBe(10);
    expect((await viewer.client.get('/v1/discover/local')).status).toBe(400);
    expect((await viewer.client.get('/v1/discover/local', { lat: '1' })).status).toBe(400);
    expect((await viewer.client.get('/v1/discover/local', { ...geo, limit: '99' })).status).toBe(
      400,
    );
    await block(viewer, author);
    const b = await viewer.client.get('/v1/discover/local', geo);
    expect(ids(b.body.posts)).toEqual([]);
    expect(ids(b.body.events)).not.toContain(event);
    expect((await anon().get('/v1/discover/local', geo)).status).toBe(200);
  });
});

// ================================================================== NOW
describe('NOW (feature flag NOW)', () => {
  const area = { lat: '10.5', lng: '20.5', radiusKm: '5' };

  it('is 404 feature_disabled while the flag is off and requires authentication', async () => {
    const u = await signup(t);
    const off = await u.client.get('/v1/now');
    expect(off.status).toBe(404);
    expect(off.body.error.code).toBe('feature_disabled');
    expect((await anon().get('/v1/now')).status).toBe(401);
    // a per-user override enables it for one person only
    await q(
      `INSERT INTO feature_flag_overrides (flag_key, user_id, enabled) VALUES ('NOW', $1, true)`,
      [u.id],
    );
    t.ctx.flags.invalidate();
    expect((await u.client.get('/v1/now')).status).toBe(200);
    expect((await (await signup(t)).client.get('/v1/now')).status).toBe(404);
    await q(`DELETE FROM feature_flag_overrides WHERE user_id = $1`, [u.id]);
    t.ctx.flags.invalidate();
  });

  it('shows what is happening now, and only aggregates for groups of at least K people', async () => {
    await setFlag('NOW', true);
    try {
      const viewer = await signup(t);
      const host = await signup(t);
      const now = Date.now();
      const happening = await mkEvent(host, {
        title: 'Happening now',
        starts_at: new Date(now - 30 * 60_000),
        ends_at: new Date(now + 60 * 60_000),
        latitude: 10.5,
        longitude: 20.5,
      });
      const soon = await mkEvent(host, {
        title: 'Starting soon',
        starts_at: new Date(now + 60 * 60_000),
        latitude: 10.5,
        longitude: 20.5,
      });
      const tomorrow = await mkEvent(host, {
        title: 'Tomorrow',
        starts_at: new Date(now + 26 * 3600_000),
        latitude: 10.5,
        longitude: 20.5,
      });
      const friendsOnly = await mkEvent(host, {
        title: 'Friends',
        visibility: 'friends',
        starts_at: new Date(now + 3600_000),
        latitude: 10.5,
        longitude: 20.5,
      });
      const r0 = await viewer.client.get('/v1/now', area);
      expect(r0.status).toBe(200);
      expect(ids(r0.body.events)).toEqual([happening, soon]);
      expect(ids(r0.body.events)).not.toContain(tomorrow);
      expect(ids(r0.body.events)).not.toContain(friendsOnly);
      expect(r0.body.privacy).toMatchObject({
        minGroupSize: 5,
        approximateCounts: true,
        locationStored: false,
        individualsShown: false,
      });
      expect(r0.body.live).toEqual({ enabled: false, items: [] }); // LIVE flag is off
      expect(r0.body.needsLocation).toBe(false);

      // Four eligible people plus people who must not be counted: below K -> nothing is disclosed
      const crowd = await fans(6);
      const place = await mkPlace({ name: 'Crowded square', latitude: 10.5, longitude: 20.5 });
      const c = await mkCommunity(host, { name: `Now crowd ${uniq('c')}` });
      for (const p of crowd) await join(c, p);
      const quiet = crowd[4]!;
      const priv = crowd[5]!;
      await setPref(quiet, 'discoverable', false);
      await q(`UPDATE profiles SET is_private = true WHERE user_id = $1`, [priv.id]);
      const teen = await signup(t, { birthDate: teenBirth() });
      await q(
        `INSERT INTO community_members (community_id, user_id, role_key, status, joined_at) VALUES ($1,$2,'member','active',now())`,
        [c.id, teen.id],
      );
      for (const p of crowd.slice(0, 4))
        await mkPost(p, {
          body: `here ${uniq('x')}`,
          visibility: 'public',
          topics: ['sports'],
          latitude: 10.5,
          longitude: 20.5,
          placeId: place,
        });
      await mkPost(quiet, {
        body: 'quiet here',
        visibility: 'public',
        topics: ['sports'],
        latitude: 10.5,
        longitude: 20.5,
        placeId: place,
      });
      await mkPost(priv, {
        body: 'private acct here',
        visibility: 'public',
        topics: ['sports'],
        latitude: 10.5,
        longitude: 20.5,
        placeId: place,
      });
      await mkPost(teen, { body: 'teen here', communityId: c.id, latitude: 10.5, longitude: 20.5 });
      for (const p of [...crowd.slice(0, 4), quiet, priv, teen])
        await mkPost(p, { body: `community talk ${uniq('y')}`, communityId: c.id });

      const below = (await viewer.client.get('/v1/now', area)).body;
      expect(below.nearby).toEqual({ people: null, places: [] });
      expect(below.activeCommunities.map((x: any) => x.id)).not.toContain(c.id);
      expect(below.trendingTopics.map((x: any) => x.slug)).not.toContain('sports');
      expect(JSON.stringify(below)).not.toContain(place);

      // the fifth eligible person tips it over K: counts appear, rounded down to a multiple of 5, never individuals
      const fifth = await signup(t);
      await join(c, fifth);
      await mkPost(fifth, {
        body: 'fifth here',
        visibility: 'public',
        topics: ['sports'],
        latitude: 10.5,
        longitude: 20.5,
        placeId: place,
      });
      await mkPost(fifth, { body: 'fifth in community', communityId: c.id });
      const above = (await viewer.client.get('/v1/now', area)).body;
      expect(above.nearby.people).toEqual({ count: 5, approximate: true });
      expect(above.nearby.places).toHaveLength(1);
      expect(above.nearby.places[0]).toMatchObject({
        id: place,
        name: 'Crowded square',
        activePeople: 5,
        approximate: true,
      });
      const ac = above.activeCommunities.find((x: any) => x.id === c.id);
      expect(ac).toMatchObject({ activePeople: 5, approximate: true });
      expect(above.trendingTopics.find((x: any) => x.slug === 'sports')).toMatchObject({
        authorCount: 5,
      });
      // nothing individual leaks
      const blob = JSON.stringify(above);
      for (const u of [...crowd, quiet, priv, teen, fifth]) {
        expect(blob).not.toContain(u.id);
        expect(blob).not.toContain(u.username);
      }

      // without a location no local aggregates are computed
      const noLoc = (await viewer.client.get('/v1/now')).body;
      expect(noLoc.nearby).toBeNull();
      expect(noLoc.needsLocation).toBe(true);
      // location is never stored anywhere
      const stored = await q(
        `SELECT count(*)::int AS n FROM audit_logs WHERE metadata::text LIKE '%10.5%'`,
      );
      expect(stored.rows[0].n).toBe(0);
    } finally {
      await setFlag('NOW', false);
    }
  });

  it('includes live sessions only when LIVE is enabled too, and validates input', async () => {
    await setFlag('NOW', true);
    await setFlag('LIVE', true);
    try {
      const host = await signup(t);
      const viewer = await signup(t);
      const live = await mkLive(host, { title: 'Now live' });
      const r = await viewer.client.get('/v1/now', area);
      expect(r.body.live.enabled).toBe(true);
      expect(ids(r.body.live.items)).toContain(live);
      expect((await viewer.client.get('/v1/now', { lat: '5' })).status).toBe(400);
      expect((await viewer.client.get('/v1/now', { ...area, limit: '99' })).status).toBe(400);
      expect((await viewer.client.get('/v1/now', { lat: '500', lng: '1' })).status).toBe(400);
    } finally {
      await setFlag('LIVE', false);
      await setFlag('NOW', false);
    }
  });
});

// ================================================================== abuse
describe('rate limits and injection', () => {
  it('discover endpoints are rate limited per user', async () => {
    const limited = await createTestApp({ RATE_LIMIT_ENABLED: 'true' });
    try {
      const u = await signup(limited);
      let last = 0;
      for (let i = 0; i < 125; i++)
        last = (await u.client.get('/v1/discover/topics', { limit: '1' })).status;
      expect(last).toBe(429);
    } finally {
      await limited.close();
    }
  });

  it.each([
    ['/v1/discover/creators', { topic: "x' OR '1'='1" }],
    ['/v1/discover/communities', { topic: "x'; DROP TABLE users; --" }],
    ['/v1/discover/places', { kind: "restaurant' OR 1=1--" }],
    ['/v1/discover/businesses', { category: "'; DROP TABLE businesses; --" }],
    ['/v1/discover/events', { cursor: "'; DROP TABLE events; --" }],
    ['/v1/discover/products', { kind: "physical'; --" }],
  ])('%s survives hostile parameters', async (url, params) => {
    const u = await signup(t);
    const r = await u.client.get(url, params as Record<string, string>);
    expect([200, 400]).toContain(r.status);
    expect((await q('SELECT count(*)::int AS n FROM users')).rows[0].n).toBeGreaterThan(0);
    expect((await q('SELECT count(*)::int AS n FROM businesses')).rows[0].n).toBeGreaterThanOrEqual(
      0,
    );
  });
});
