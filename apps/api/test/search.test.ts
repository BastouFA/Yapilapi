import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, createTestApp, signup, uniq, type TestApp, type TestUser } from './helpers.js';
import { purgeExpiredSearchHistory } from '../src/modules/search/index.js';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
});

const anon = () => new Client(t);
const teenBirth = () => `${new Date().getUTCFullYear() - 15}-02-02`;
const db = () => t.ctx.db;
const q = (text: string, params: unknown[] = []) => db().query(text, params);

// ------------------------------------------------------------------ fixture helpers
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
const setPref = (u: TestUser, col: 'discoverable' | 'personalization', v: boolean) =>
  q(`UPDATE user_preferences SET ${col} = $2 WHERE user_id = $1`, [u.id, v]);
const setProfile = (u: TestUser, over: { display_name?: string; bio?: string; mode?: string }) =>
  q(
    `UPDATE profiles SET display_name = COALESCE($2, display_name), bio = COALESCE($3, bio), mode = COALESCE($4, mode) WHERE user_id = $1`,
    [u.id, over.display_name ?? null, over.bio ?? null, over.mode ?? null],
  );

const mkPost = async (u: TestUser, body: Record<string, unknown>) => {
  const r = await u.client.post('/v1/posts', body);
  if (r.status !== 201) throw new Error(`post failed ${r.status} ${JSON.stringify(r.body)}`);
  return r.body as { id: string };
};
async function mkVideo(u: TestUser, body: string, extra: Record<string, unknown> = {}) {
  const media = await q(
    `INSERT INTO media (owner_id, kind, storage_key, mime_type, size_bytes, duration_ms, status) VALUES ($1,'video',$2,'video/mp4',1000,30000,'ready') RETURNING id`,
    [u.id, `k/${uniq('v')}.mp4`],
  );
  const r = await u.client.post('/v1/posts', {
    body,
    mediaIds: [media.rows[0].id],
    visibility: 'public',
    ...extra,
  });
  if (r.status !== 201) throw new Error(`video failed ${r.status} ${JSON.stringify(r.body)}`);
  return r.body as { id: string; kind: string };
}
const mkCommunity = async (owner: TestUser, over: Record<string, unknown> = {}) => {
  const r = await owner.client.post('/v1/communities', { name: `Community ${uniq('n')}`, ...over });
  if (r.status !== 201) throw new Error(`community failed ${r.status} ${JSON.stringify(r.body)}`);
  return r.body as { id: string; slug: string; name: string };
};
async function invite(owner: TestUser, c: { id: string }, u: TestUser) {
  const inv = await owner.client.post(`/v1/communities/${c.id}/invitations`, { userId: u.id });
  if (inv.status !== 201)
    throw new Error(`invite failed ${inv.status} ${JSON.stringify(inv.body)}`);
  const acc = await u.client.post(`/v1/communities/${c.id}/invitation/accept`);
  if (acc.status !== 200)
    throw new Error(`accept invite failed ${acc.status} ${JSON.stringify(acc.body)}`);
}

async function mkPlace(over: Record<string, unknown> = {}) {
  const r = await q(
    `INSERT INTO places (name, kind, description, latitude, longitude, capacity, rating_avg, rating_count, address)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [
      over.name ?? `Place ${uniq('p')}`,
      over.kind ?? 'restaurant',
      over.description ?? '',
      over.latitude ?? 40.7128,
      over.longitude ?? -74.006,
      over.capacity ?? null,
      over.rating_avg ?? 0,
      over.rating_count ?? 0,
      JSON.stringify(over.address ?? { city: 'Testville' }),
    ],
  );
  return r.rows[0].id as string;
}
async function mkEvent(host: TestUser | null, over: Record<string, unknown> = {}) {
  const start = (over.starts_at as Date | undefined) ?? new Date(Date.now() + 3 * 86_400_000);
  const r = await q(
    `INSERT INTO events (title, description, host_id, community_id, place_id, starts_at, ends_at, latitude, longitude, visibility, status, going_count, interested_count)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
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
      over.going_count ?? 0,
      over.interested_count ?? 0,
    ],
  );
  return r.rows[0].id as string;
}
async function mkBusiness(owner: TestUser, over: Record<string, unknown> = {}) {
  const slug = `b-${uniq('s')}`;
  const r = await q(
    `INSERT INTO businesses (owner_id, slug, name, category, description, status) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [
      owner.id,
      slug,
      over.name ?? `Business ${uniq('b')}`,
      over.category ?? 'general',
      over.description ?? '',
      over.status ?? 'active',
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
  description?: string;
  deleted?: boolean;
}) {
  const r = await q(
    `INSERT INTO products (business_id, seller_user_id, kind, title, description, price_cents, currency, status, deleted_at) VALUES ($1,$2,'physical',$3,$4,$5,'USD',$6,$7) RETURNING id`,
    [
      over.business_id ?? null,
      over.business_id ? null : over.seller!.id,
      over.title ?? `Product ${uniq('p')}`,
      over.description ?? '',
      over.price_cents ?? 1000,
      over.status ?? 'active',
      over.deleted ? new Date() : null,
    ],
  );
  return r.rows[0].id as string;
}

type SearchBody = {
  query: string;
  interpretedAs: Record<string, any>;
  types: string[];
  total: number;
  results: Record<string, { items: any[]; nextCursor: string | null }>;
};
async function search(c: Client, text: string, extra: Record<string, string> = {}) {
  const r = await c.get<SearchBody>('/v1/search', { q: text, ...extra });
  return r;
}
const ids = (r: { body: SearchBody }, type: string) =>
  (r.body.results[type]?.items ?? []).map((i: any) => i.id as string);
const only = async (c: Client, text: string, type: string, extra: Record<string, string> = {}) => {
  const r = await search(c, text, { types: type, limit: '50', ...extra });
  if (r.status !== 200) throw new Error(`search failed ${r.status} ${JSON.stringify(r.body)}`);
  return ids(r, type);
};

// ================================================================== validation & access
describe('search endpoint contract', () => {
  it('validates input', async () => {
    const u = await signup(t);
    expect((await u.client.get('/v1/search')).status).toBe(400);
    expect((await u.client.get('/v1/search', { q: 'a' })).status).toBe(400);
    expect((await u.client.get('/v1/search', { q: 'x'.repeat(201) })).status).toBe(400);
    expect((await u.client.get('/v1/search', { q: 'hello', types: 'nonsense' })).status).toBe(400);
    expect((await u.client.get('/v1/search', { q: 'hello', lat: '10' })).status).toBe(400);
    expect((await u.client.get('/v1/search', { q: 'hello', lat: '100', lng: '10' })).status).toBe(
      400,
    );
    expect((await u.client.get('/v1/search', { q: 'hello', limit: '500' })).status).toBe(400);
    expect((await u.client.get('/v1/search', { q: 'hello', cursor: '!!!' })).status).toBe(400);
    expect(
      (
        await u.client.get('/v1/search', {
          q: 'hello',
          types: 'people',
          cursor: Buffer.from(
            JSON.stringify({ s: 1, id: 'nope', snap: new Date().toISOString() }),
          ).toString('base64url'),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await u.client.get('/v1/search', {
          q: 'hello',
          cursor: Buffer.from(
            JSON.stringify({
              s: 1,
              id: '00000000-0000-4000-8000-000000000000',
              snap: new Date().toISOString(),
            }),
          ).toString('base64url'),
        })
      ).status,
    ).toBe(400);
    expect((await u.client.get('/v1/search/suggest')).status).toBe(400);
    expect((await u.client.get('/v1/search/history')).status).toBe(200);
  });

  it('anonymous search works but is limited to public material; history requires auth', async () => {
    const author = await signup(t);
    const tag = uniq('anon');
    const pub = await mkPost(author, { body: `public ${tag}`, visibility: 'public' });
    const fol = await mkPost(author, { body: `followers ${tag}`, visibility: 'followers' });
    expect(await only(anon(), tag, 'posts')).toEqual([pub.id]);
    expect(await only(anon(), tag, 'posts')).not.toContain(fol.id);
    expect((await anon().get('/v1/search/history')).status).toBe(401);
    expect((await anon().del('/v1/search/history')).status).toBe(401);
  });

  it('groups results per type with typed items and reports how the query was interpreted', async () => {
    const owner = await signup(t, { displayName: 'Grouper' });
    const tag = uniq('grp');
    await setProfile(owner, { bio: `about ${tag}` });
    const c = await mkCommunity(owner, { name: `Group ${tag}` });
    const post = await mkPost(owner, { body: `post about ${tag}`, visibility: 'public' });
    const pl = await mkPlace({ name: `Place ${tag}` });
    const r = await search(owner.client, tag);
    expect(r.status).toBe(200);
    expect(r.body.interpretedAs.mode).toBe('keyword');
    expect(r.body.types).toEqual(
      expect.arrayContaining(['people', 'posts', 'communities', 'places', 'topics']),
    );
    expect(ids(r, 'communities')).toEqual([c.id]);
    expect(ids(r, 'posts')).toEqual([post.id]);
    expect(ids(r, 'places')).toEqual([pl]);
    expect(ids(r, 'people')).toEqual([owner.id]);
    const person = r.body.results.people!.items[0];
    expect(person).toMatchObject({
      type: 'people',
      username: owner.username,
      displayName: 'Grouper',
      mode: 'personal',
    });
    expect(Object.keys(person)).not.toContain('email');
    expect(r.body.results.communities!.items[0]).toMatchObject({
      type: 'communities',
      slug: c.slug,
      memberCount: 1,
      access: 'full',
    });
    expect(r.body.results.posts!.items[0]).toMatchObject({
      type: 'posts',
      body: `post about ${tag}`,
      author: { username: owner.username },
    });
    expect(r.body.results.places!.items[0]).toMatchObject({
      type: 'places',
      name: `Place ${tag}`,
      kind: 'restaurant',
    });
  });
});

// ================================================================== people & creators
describe('people and creators', () => {
  it('finds people by display name, username and bio; creators only when mode=creator', async () => {
    const tag = uniq('per');
    const a = await signup(t, { displayName: `Alice ${tag}` });
    const b = await signup(t, { displayName: 'Bob Builder' });
    const c = await signup(t, { displayName: 'Carla Creator' });
    await setProfile(b, { bio: `I make ${tag} things` });
    await setProfile(c, { mode: 'creator', bio: `Creator of ${tag}` });
    const viewer = await signup(t);
    const people = await only(viewer.client, tag, 'people');
    expect(people).toEqual(expect.arrayContaining([a.id, b.id, c.id]));
    const creators = await only(viewer.client, tag, 'creators');
    expect(creators).toEqual([c.id]);
    // by username, partial
    expect(await only(viewer.client, a.username.slice(0, 8), 'people')).toContain(a.id);
    // typo tolerance via trigram
    expect(await only(viewer.client, `Alise ${tag}`, 'people')).toContain(a.id);
    // multi-type search shows a creator once, under creators
    const both = await search(viewer.client, tag, { types: 'people,creators' });
    expect(ids(both, 'creators')).toEqual([c.id]);
    expect(ids(both, 'people')).not.toContain(c.id);
  });

  it('never shows blocked users in either direction', async () => {
    const tag = uniq('blk');
    const a = await signup(t, { displayName: `Ann ${tag}` });
    const b = await signup(t, { displayName: `Ben ${tag}` });
    expect(await only(a.client, tag, 'people')).toContain(b.id);
    await block(a, b);
    expect(await only(a.client, tag, 'people')).not.toContain(b.id);
    expect(await only(b.client, tag, 'people')).not.toContain(a.id);
    // and everyone else still sees both
    const c = await signup(t);
    expect(await only(c.client, tag, 'people')).toEqual(expect.arrayContaining([a.id, b.id]));
  });

  it('hides non-discoverable users from non-friends only (and shows them to themselves)', async () => {
    const tag = uniq('dsc');
    const hidden = await signup(t, { displayName: `Quiet ${tag}` });
    await setPref(hidden, 'discoverable', false);
    const stranger = await signup(t);
    const friend = await signup(t);
    const follower = await signup(t);
    await befriend(hidden, friend);
    await follow(follower, hidden);
    expect(await only(stranger.client, tag, 'people')).not.toContain(hidden.id);
    expect(await only(anon(), tag, 'people')).not.toContain(hidden.id);
    expect(await only(follower.client, tag, 'people')).not.toContain(hidden.id);
    expect(await only(friend.client, tag, 'people')).toContain(hidden.id);
    expect(await only(hidden.client, tag, 'people')).toContain(hidden.id);
    // typeahead applies the same rule
    const s = await stranger.client.get('/v1/search/suggest', { q: `Quiet ${tag}` });
    expect(s.body.items.map((i: any) => i.id)).not.toContain(hidden.id);
    expect(s.body.items.length).toBe(0);
    const sf = await friend.client.get('/v1/search/suggest', { q: `Quiet ${tag}` });
    expect(sf.body.items.map((i: any) => i.id)).toContain(hidden.id);
  });

  it('never shows teens to unrelated adults, even if discoverable is forced on', async () => {
    const tag = uniq('teen');
    const teen = await signup(t, { birthDate: teenBirth(), displayName: `Teeny ${tag}` });
    const stranger = await signup(t);
    const friend = await signup(t);
    const follower = await signup(t);
    const otherTeen = await signup(t, { birthDate: teenBirth() });
    // teen initiates friendship with an adult (adults cannot initiate)
    await befriend(teen, friend);
    expect(await only(stranger.client, tag, 'people')).not.toContain(teen.id);
    expect(await only(anon(), tag, 'people')).not.toContain(teen.id);
    expect(await only(friend.client, tag, 'people')).toContain(teen.id);
    expect(await only(teen.client, tag, 'people')).toContain(teen.id);
    // force discoverable on (the API forbids it): the teen rule still hides them from strangers
    await setPref(teen, 'discoverable', true);
    expect(await only(stranger.client, tag, 'people')).not.toContain(teen.id);
    expect(await only(anon(), tag, 'people')).not.toContain(teen.id);
    // an adult with an active follow relationship counts as related
    await q(`INSERT INTO follows (follower_id, followee_id, status) VALUES ($1,$2,'active')`, [
      follower.id,
      teen.id,
    ]);
    expect(await only(follower.client, tag, 'people')).toContain(teen.id);
    // pending follow request does not
    const pendingAdult = await signup(t);
    await q(`INSERT INTO follows (follower_id, followee_id, status) VALUES ($1,$2,'pending')`, [
      pendingAdult.id,
      teen.id,
    ]);
    expect(await only(pendingAdult.client, tag, 'people')).not.toContain(teen.id);
    // another teen can find a discoverable teen
    expect(await only(otherTeen.client, tag, 'people')).toContain(teen.id);
    // universal search behaves the same
    const uni = await search(stranger.client, tag);
    expect(ids(uni, 'people')).not.toContain(teen.id);
  });

  it('hides suspended and deleted accounts', async () => {
    const tag = uniq('sus');
    const a = await signup(t, { displayName: `Susp ${tag}` });
    const viewer = await signup(t);
    expect(await only(viewer.client, tag, 'people')).toContain(a.id);
    await q(`UPDATE users SET status = 'suspended' WHERE id = $1`, [a.id]);
    expect(await only(viewer.client, tag, 'people')).not.toContain(a.id);
  });
});

// ================================================================== posts & videos
describe('posts and videos: no content leaks', () => {
  it('returns only posts the viewer may see (public, followers, friends, deleted, blocked)', async () => {
    const tag = uniq('pst');
    const author = await signup(t);
    const follower = await signup(t);
    const friend = await signup(t);
    const stranger = await signup(t);
    await follow(follower, author);
    await befriend(author, friend);
    const pub = await mkPost(author, { body: `public ${tag}`, visibility: 'public' });
    const fol = await mkPost(author, { body: `followers ${tag}`, visibility: 'followers' });
    const fri = await mkPost(author, { body: `friends ${tag}`, visibility: 'friends' });
    const priv = await mkPost(author, { body: `private ${tag}`, visibility: 'private' });
    const del = await mkPost(author, { body: `deleted ${tag}`, visibility: 'public' });
    await author.client.del(`/v1/posts/${del.id}`);
    const circle = await author.client.post('/v1/circles', { kind: 'custom', name: uniq('ci') });
    await author.client.put(`/v1/circles/${circle.body.id}/members/${friend.id}`);
    const cir = await mkPost(author, {
      body: `circle ${tag}`,
      visibility: 'circle',
      circleId: circle.body.id,
    });
    const sel = await mkPost(author, {
      body: `selected ${tag}`,
      visibility: 'selected',
      audience: [follower.id],
    });

    expect((await only(stranger.client, tag, 'posts')).sort()).toEqual([pub.id]);
    expect((await only(follower.client, tag, 'posts')).sort()).toEqual(
      [pub.id, fol.id, sel.id].sort(),
    );
    expect((await only(friend.client, tag, 'posts')).sort()).toEqual(
      [pub.id, fri.id, cir.id].sort(),
    );
    expect((await only(author.client, tag, 'posts')).sort()).toEqual(
      [pub.id, fol.id, fri.id, priv.id, cir.id, sel.id].sort(),
    );
    expect(await only(anon(), tag, 'posts')).toEqual([pub.id]);

    // blocked in either direction
    await block(stranger, author);
    expect(await only(stranger.client, tag, 'posts')).toEqual([]);
    expect(await only(author.client, tag, 'posts')).toContain(pub.id);
    const other = await signup(t);
    await block(author, other);
    expect(await only(other.client, tag, 'posts')).toEqual([]);
  });

  it('respects private-account and moderation state', async () => {
    const tag = uniq('prv');
    const author = await signup(t);
    const viewer = await signup(t);
    const p = await mkPost(author, { body: `visible ${tag}`, visibility: 'public' });
    expect(await only(viewer.client, tag, 'posts')).toEqual([p.id]);
    await q(`UPDATE profiles SET is_private = true WHERE user_id = $1`, [author.id]);
    expect(await only(viewer.client, tag, 'posts')).toEqual([]);
    await follow(viewer, author);
    await q(`UPDATE follows SET status = 'active' WHERE follower_id = $1`, [viewer.id]);
    expect(await only(viewer.client, tag, 'posts')).toEqual([p.id]);
    await q(`UPDATE posts SET moderation_status = 'removed' WHERE id = $1`, [p.id]);
    expect(await only(viewer.client, tag, 'posts')).toEqual([]);
    await q(`UPDATE posts SET moderation_status = 'pending_review' WHERE id = $1`, [p.id]);
    expect(await only(viewer.client, tag, 'posts')).toEqual([]);
  });

  it('never leaks private or secret community posts to non-members', async () => {
    const tag = uniq('cmp');
    const owner = await signup(t);
    const member = await signup(t);
    const outsider = await signup(t);
    const pubC = await mkCommunity(owner, { name: `Pub ${tag}` });
    const privC = await mkCommunity(owner, { name: `Priv ${tag}`, visibility: 'private' });
    const secC = await mkCommunity(owner, { name: `Sec ${tag}`, visibility: 'secret' });
    for (const c of [privC, secC]) await invite(owner, c, member);
    const a = await mkPost(owner, { body: `in public community ${tag}`, communityId: pubC.id });
    const b = await mkPost(owner, { body: `in private community ${tag}`, communityId: privC.id });
    const c = await mkPost(owner, { body: `in secret community ${tag}`, communityId: secC.id });
    expect((await only(outsider.client, tag, 'posts')).sort()).toEqual([a.id]);
    expect((await only(anon(), tag, 'posts')).sort()).toEqual([a.id]);
    expect((await only(member.client, tag, 'posts')).sort()).toEqual([a.id, b.id, c.id].sort());
    // banned members lose access
    await q(
      `UPDATE community_members SET status = 'banned' WHERE community_id = $1 AND user_id = $2`,
      [privC.id, member.id],
    );
    expect((await only(member.client, tag, 'posts')).sort()).toEqual([a.id, c.id].sort());
    // teen authors are hidden from unrelated adults even inside a public community
    const teen = await signup(t, { birthDate: teenBirth() });
    await q(
      `INSERT INTO community_members (community_id, user_id, role_key, status, joined_at) VALUES ($1,$2,'member','active',now())`,
      [pubC.id, teen.id],
    );
    const tp = await mkPost(teen, { body: `teen post ${tag}`, communityId: pubC.id });
    expect(await only(outsider.client, tag, 'posts')).not.toContain(tp.id);
    expect(await only(owner.client, tag, 'posts')).not.toContain(tp.id);
    expect(await only(teen.client, tag, 'posts')).toContain(tp.id);
  });

  it('videos are posts of kind video and follow the same rules; posts group excludes them', async () => {
    const tag = uniq('vid');
    const author = await signup(t);
    const stranger = await signup(t);
    const v = await mkVideo(author, `clip ${tag}`);
    const hiddenVideo = await mkVideo(author, `friends clip ${tag}`, { visibility: 'friends' });
    const text = await mkPost(author, { body: `text ${tag}`, visibility: 'public' });
    expect(v.kind).toBe('video');
    expect(await only(stranger.client, tag, 'videos')).toEqual([v.id]);
    expect(await only(stranger.client, tag, 'videos')).not.toContain(hiddenVideo.id);
    expect(await only(author.client, tag, 'videos')).toEqual(
      expect.arrayContaining([v.id, hiddenVideo.id]),
    );
    expect(await only(stranger.client, tag, 'posts')).toEqual([text.id]);
    const r = await search(stranger.client, tag, { types: 'videos' });
    expect(r.body.results.videos!.items[0]).toMatchObject({
      type: 'videos',
      kind: 'video',
      media: [{ kind: 'video' }],
    });
  });

  it('matches topics and honours topic muting is not required for search but topic filter works', async () => {
    const tag = uniq('tpc');
    const author = await signup(t);
    const viewer = await signup(t);
    const withTopic = await mkPost(author, {
      body: `nothing about the word ${tag}`,
      visibility: 'public',
      topics: ['photography'],
    });
    const r = await search(viewer.client, 'photography things', { types: 'posts', limit: '50' });
    expect(r.body.interpretedAs.topics).toEqual(['photography']);
    expect(ids(r, 'posts')).toContain(withTopic.id); // matched through its topic tag even though the text differs
  });
});

// ================================================================== communities
describe('communities', () => {
  it('shows public communities, private ones as a summary, and hides secret ones from non-members', async () => {
    const tag = uniq('com');
    const owner = await signup(t);
    const member = await signup(t);
    const invited = await signup(t);
    const stranger = await signup(t);
    const pub = await mkCommunity(owner, { name: `Public ${tag}`, topics: ['technology'] });
    const priv = await mkCommunity(owner, { name: `Private ${tag}`, visibility: 'private' });
    const sec = await mkCommunity(owner, { name: `Secret ${tag}`, visibility: 'secret' });
    await invite(owner, sec, member);
    await owner.client.post(`/v1/communities/${sec.id}/invitations`, { userId: invited.id }); // pending invitation

    const seen = async (c: Client) => (await only(c, tag, 'communities')).sort();
    expect(await seen(stranger.client)).toEqual([pub.id, priv.id].sort());
    expect(await seen(anon())).toEqual([pub.id, priv.id].sort());
    expect(await seen(member.client)).toEqual([pub.id, priv.id, sec.id].sort());
    expect(await seen(invited.client)).toEqual([pub.id, priv.id, sec.id].sort());
    expect(await seen(owner.client)).toEqual([pub.id, priv.id, sec.id].sort());

    const r = await search(stranger.client, tag, { types: 'communities' });
    const byId = new Map(r.body.results.communities!.items.map((i: any) => [i.id, i]));
    expect(byId.get(priv.id)).toMatchObject({ visibility: 'private', access: 'summary' });
    expect(byId.get(pub.id)).toMatchObject({
      visibility: 'public',
      access: 'full',
      topics: ['technology'],
    });
    // secret community name never appears in typeahead either
    const s = await stranger.client.get('/v1/search/suggest', { q: `Secret ${tag}` });
    expect(s.body.items.map((i: any) => i.id)).not.toContain(sec.id);
    expect(JSON.stringify(r.body)).not.toContain(`Secret ${tag}`);
  });

  it('hides communities from banned members and deleted communities from everyone', async () => {
    const tag = uniq('ban');
    const owner = await signup(t);
    const user = await signup(t);
    const c = await mkCommunity(owner, { name: `Rules ${tag}` });
    const d = await mkCommunity(owner, { name: `Gone ${tag}` });
    expect(await only(user.client, tag, 'communities')).toEqual(
      expect.arrayContaining([c.id, d.id]),
    );
    await q(
      `INSERT INTO community_members (community_id, user_id, role_key, status) VALUES ($1,$2,'member','banned')`,
      [c.id, user.id],
    );
    await q(`UPDATE communities SET deleted_at = now() WHERE id = $1`, [d.id]);
    expect(await only(user.client, tag, 'communities')).toEqual([]);
    expect(await only(owner.client, tag, 'communities')).toEqual([c.id]);
  });

  it('teen-created private communities are only visible to their members', async () => {
    const tag = uniq('tcm');
    const teen = await signup(t, { birthDate: teenBirth() });
    const adult = await signup(t);
    const c = await mkCommunity(teen, { name: `Teen club ${tag}` });
    expect(await only(adult.client, tag, 'communities')).toEqual([]);
    expect(await only(anon(), tag, 'communities')).toEqual([]);
    expect(await only(teen.client, tag, 'communities')).toEqual([c.id]);
  });
});

// ================================================================== events
describe('events', () => {
  it('applies event visibility: public, followers, friends, community, private; drafts and cancelled never appear', async () => {
    const tag = uniq('evt');
    const host = await signup(t);
    const friend = await signup(t);
    const follower = await signup(t);
    const member = await signup(t);
    const invitee = await signup(t);
    const attendee = await signup(t);
    const stranger = await signup(t);
    await befriend(host, friend);
    await follow(follower, host);
    const community = await mkCommunity(host, { name: `Evc ${uniq('c')}`, visibility: 'private' });
    await invite(host, community, member);

    const pub = await mkEvent(host, { title: `Public ${tag}` });
    const fol = await mkEvent(host, { title: `Followers ${tag}`, visibility: 'followers' });
    const fri = await mkEvent(host, { title: `Friends ${tag}`, visibility: 'friends' });
    const com = await mkEvent(host, {
      title: `Community ${tag}`,
      visibility: 'community',
      community_id: community.id,
    });
    const prv = await mkEvent(host, { title: `Private ${tag}`, visibility: 'private' });
    const draft = await mkEvent(host, { title: `Draft ${tag}`, status: 'draft' });
    const cancelled = await mkEvent(host, { title: `Cancelled ${tag}`, status: 'cancelled' });
    const deleted = await mkEvent(host, { title: `Deleted ${tag}` });
    await q(`UPDATE events SET deleted_at = now() WHERE id = $1`, [deleted]);
    await q(`INSERT INTO event_invitations (event_id, user_id, status) VALUES ($1,$2,'pending')`, [
      prv,
      invitee.id,
    ]);
    await q(`INSERT INTO event_attendees (event_id, user_id, status) VALUES ($1,$2,'going')`, [
      prv,
      attendee.id,
    ]);

    const seen = async (c: Client) => (await only(c, tag, 'events')).sort();
    expect(await seen(stranger.client)).toEqual([pub]);
    expect(await seen(anon())).toEqual([pub]);
    expect(await seen(follower.client)).toEqual([pub, fol].sort());
    expect(await seen(friend.client)).toEqual([pub, fri].sort());
    expect(await seen(member.client)).toEqual([pub, com].sort());
    expect(await seen(invitee.client)).toEqual([pub, prv].sort());
    expect(await seen(attendee.client)).toEqual([pub, prv].sort());
    expect(await seen(host.client)).toEqual([pub, fol, fri, com, prv].sort());
    for (const hidden of [draft, cancelled, deleted])
      expect(await seen(host.client)).not.toContain(hidden);
    // blocked hosts vanish
    await block(stranger, host);
    expect(await seen(stranger.client)).toEqual([]);
    // events of teen hosts are hidden from unrelated adults
    const teenHost = await signup(t, { birthDate: teenBirth() });
    const teenEvent = await mkEvent(teenHost, { title: `Teen party ${tag}` });
    expect(await seen(friend.client)).not.toContain(teenEvent);
    expect(await seen(teenHost.client)).toContain(teenEvent);
  });

  it('excludes events that already ended', async () => {
    const tag = uniq('old');
    const host = await signup(t);
    const past = await mkEvent(host, {
      title: `Past ${tag}`,
      starts_at: new Date(Date.now() - 5 * 86_400_000),
    });
    const now = await mkEvent(host, {
      title: `Ongoing ${tag}`,
      starts_at: new Date(Date.now() - 3600_000),
      ends_at: new Date(Date.now() + 3600_000),
    });
    expect(await only(host.client, tag, 'events')).toEqual([now]);
    expect(await only(host.client, tag, 'events')).not.toContain(past);
  });
});

// ================================================================== places, businesses, products
describe('places, businesses and products', () => {
  it('finds places and hides deleted ones', async () => {
    const tag = uniq('plc');
    const viewer = await signup(t);
    const a = await mkPlace({ name: `Cafe ${tag}`, kind: 'restaurant' });
    const b = await mkPlace({ name: `Gone ${tag}` });
    await q(`UPDATE places SET deleted_at = now() WHERE id = $1`, [b]);
    expect(await only(viewer.client, tag, 'places')).toEqual([a]);
  });

  it('only active businesses with visible owners; blocked owners hidden', async () => {
    const tag = uniq('biz');
    const owner = await signup(t);
    const viewer = await signup(t);
    const active = await mkBusiness(owner, { name: `Active ${tag}` });
    const pending = await mkBusiness(owner, { name: `Pending ${tag}`, status: 'pending' });
    const suspended = await mkBusiness(owner, { name: `Suspended ${tag}`, status: 'suspended' });
    const seen = await only(viewer.client, tag, 'businesses');
    expect(seen).toEqual([active]);
    expect(seen).not.toContain(pending);
    expect(seen).not.toContain(suspended);
    await block(viewer, owner);
    expect(await only(viewer.client, tag, 'businesses')).toEqual([]);
  });

  it('products: only active, undeleted, with a visible seller; COMMERCE flag gates the type', async () => {
    const tag = uniq('prd');
    const seller = await signup(t);
    const owner = await signup(t);
    const viewer = await signup(t);
    const biz = await mkBusiness(owner, { name: `Shop ${tag}` });
    const badBiz = await mkBusiness(owner, { name: `Closed shop ${tag}`, status: 'suspended' });
    const okBiz = await mkProduct({ business_id: biz, title: `Biz widget ${tag}` });
    const okUser = await mkProduct({ seller, title: `User widget ${tag}` });
    const draft = await mkProduct({ seller, title: `Draft widget ${tag}`, status: 'draft' });
    const archived = await mkProduct({
      seller,
      title: `Archived widget ${tag}`,
      status: 'archived',
    });
    const soldOut = await mkProduct({
      seller,
      title: `Sold out widget ${tag}`,
      status: 'sold_out',
    });
    const deleted = await mkProduct({ seller, title: `Deleted widget ${tag}`, deleted: true });
    const suspendedBiz = await mkProduct({
      business_id: badBiz,
      title: `Suspended biz widget ${tag}`,
    });

    const seen = (await only(viewer.client, tag, 'products')).sort();
    expect(seen).toEqual([okBiz, okUser].sort());
    for (const hidden of [draft, archived, soldOut, deleted, suspendedBiz])
      expect(seen).not.toContain(hidden);
    const item = (
      await search(viewer.client, tag, { types: 'products' })
    ).body.results.products!.items.find((i: any) => i.id === okBiz);
    expect(item).toMatchObject({
      type: 'products',
      title: `Biz widget ${tag}`,
      priceCents: 1000,
      currency: 'USD',
      inStock: true,
      seller: { type: 'business', id: biz },
    });

    // blocked individual sellers disappear
    await block(viewer, seller);
    expect(await only(viewer.client, tag, 'products')).toEqual([okBiz]);

    // COMMERCE off: products are silently dropped from multi-type searches and 404 when asked for alone
    await q(`UPDATE feature_flags SET enabled = false WHERE key = 'COMMERCE'`);
    t.ctx.flags.invalidate();
    try {
      const multi = await search(viewer.client, tag);
      expect(multi.status).toBe(200);
      expect(multi.body.results.products).toBeUndefined();
      const solo = await viewer.client.get('/v1/search', { q: tag, types: 'products' });
      expect(solo.status).toBe(404);
      expect(solo.body.error.code).toBe('feature_disabled');
    } finally {
      await q(`UPDATE feature_flags SET enabled = true WHERE key = 'COMMERCE'`);
      t.ctx.flags.invalidate();
    }
  });
});

// ================================================================== topics & typeahead
describe('topics and typeahead', () => {
  it('searches topics by name and slug', async () => {
    const viewer = await signup(t);
    const byName = await search(viewer.client, 'Photography', { types: 'topics' });
    expect(byName.body.results.topics!.items.map((i: any) => i.slug)).toContain('photography');
    const bySlug = await search(viewer.client, 'film-tv', { types: 'topics' });
    expect(bySlug.body.results.topics!.items.map((i: any) => i.slug)).toContain('film-tv');
  });

  it('does not offer topics the viewer muted', async () => {
    const viewer = await signup(t);
    await viewer.client.put('/v1/topics/gaming/mute');
    const r = await search(viewer.client, 'Gaming', { types: 'topics' });
    expect(r.body.results.topics!.items.map((i: any) => i.slug)).not.toContain('gaming');
    const other = await signup(t);
    expect(
      (await search(other.client, 'Gaming', { types: 'topics' })).body.results.topics!.items.map(
        (i: any) => i.slug,
      ),
    ).toContain('gaming');
  });

  it('suggests across types by prefix with labels, best matches first', async () => {
    const tag = uniq('sug');
    const viewer = await signup(t);
    const person = await signup(t, { displayName: `Suggest ${tag}` });
    const c = await mkCommunity(person, { name: `${tag} lovers` });
    const pl = await mkPlace({ name: `${tag} Diner` });
    const r = await viewer.client.get('/v1/search/suggest', { q: tag.slice(0, 8) });
    expect(r.status).toBe(200);
    const byType = Object.fromEntries(r.body.items.map((i: any) => [i.type, i]));
    expect(byType.people).toMatchObject({
      id: person.id,
      label: `Suggest ${tag}`,
      sublabel: `@${person.username}`,
    });
    expect(byType.communities).toMatchObject({ id: c.id, label: `${tag} lovers` });
    expect(byType.places).toMatchObject({ id: pl });
    // a community whose name STARTS with the prefix outranks a place where the word appears later
    const scores = r.body.items.map((i: any) => i.score);
    expect([...scores].sort((a: number, b: number) => b - a)).toEqual(scores);
    // one character works, limit is honoured, types can be narrowed
    expect(
      (await viewer.client.get('/v1/search/suggest', { q: 'a', limit: '3' })).body.items.length,
    ).toBeLessThanOrEqual(3);
    const narrow = await viewer.client.get('/v1/search/suggest', {
      q: tag.slice(0, 8),
      types: 'places',
    });
    expect(narrow.body.items.every((i: any) => i.type === 'places')).toBe(true);
    expect(
      (await viewer.client.get('/v1/search/suggest', { q: 'x', types: 'nonsense' })).status,
    ).toBe(400);
    expect((await viewer.client.get('/v1/search/suggest', { q: 'x', limit: '99' })).status).toBe(
      400,
    );
  });

  it('typeahead treats wildcards literally', async () => {
    const viewer = await signup(t);
    const r = await viewer.client.get('/v1/search/suggest', { q: '%' });
    expect(r.status).toBe(200);
    expect(r.body.items).toEqual([]);
    const u = await viewer.client.get('/v1/search/suggest', { q: '_' });
    expect(u.body.items).toEqual([]);
  });
});

// ================================================================== natural language
describe('natural-language search', () => {
  it('"find technology communities" -> communities tagged technology', async () => {
    const owner = await signup(t);
    const viewer = await signup(t);
    const tech = await mkCommunity(owner, {
      name: `Builders ${uniq('t')}`,
      topics: ['technology'],
    });
    const other = await mkCommunity(owner, {
      name: `Gardeners ${uniq('g')}`,
      topics: ['home-garden'],
    });
    const r = await search(viewer.client, 'find technology communities');
    expect(r.status).toBe(200);
    expect(r.body.interpretedAs).toMatchObject({
      mode: 'natural_language',
      entityTypes: ['communities'],
      topics: ['technology'],
      typesOverridden: false,
    });
    expect(r.body.types).toEqual(['communities']);
    expect(ids(r, 'communities')).toContain(tech.id);
    expect(ids(r, 'communities')).not.toContain(other.id);
  });

  it('"restaurants suitable for six people" filters by kind and capacity', async () => {
    const tag = uniq('cap');
    const viewer = await signup(t);
    const big = await mkPlace({
      name: `Big ${tag}`,
      kind: 'restaurant',
      capacity: 40,
      description: `place ${tag}`,
    });
    const unknown = await mkPlace({
      name: `Unknown ${tag}`,
      kind: 'restaurant',
      capacity: null,
      description: `place ${tag}`,
    });
    const tiny = await mkPlace({
      name: `Tiny ${tag}`,
      kind: 'restaurant',
      capacity: 4,
      description: `place ${tag}`,
    });
    const shop = await mkPlace({
      name: `Shop ${tag}`,
      kind: 'store',
      capacity: 50,
      description: `place ${tag}`,
    });
    const r = await search(viewer.client, 'restaurants suitable for six people');
    expect(r.body.interpretedAs).toMatchObject({
      entityTypes: ['places'],
      partySize: 6,
      placeKinds: ['restaurant'],
    });
    const got = ids(r, 'places');
    expect(got).toEqual(expect.arrayContaining([big, unknown]));
    expect(got).not.toContain(tiny);
    expect(got).not.toContain(shop);
  });

  it('"events this weekend near me" uses the time window and location', async () => {
    const tag = uniq('wk');
    const host = await signup(t);
    await q(`UPDATE users SET timezone = 'UTC' WHERE id = $1`, [host.id]);
    const resolved = (await search(host.client, 'events this weekend').then(
      (r) => r.body.interpretedAs.timeWindow,
    )) as { from: string; to: string };
    expect(resolved).toBeTruthy();
    const from = new Date(resolved.from);
    const to = new Date(resolved.to);
    const inside = new Date((from.getTime() + to.getTime()) / 2);
    const outside = new Date(to.getTime() + 2 * 86_400_000);
    const near = await mkEvent(host, {
      title: `Near ${tag}`,
      starts_at: inside,
      latitude: 40.72,
      longitude: -74.0,
    });
    const far = await mkEvent(host, {
      title: `Far ${tag}`,
      starts_at: inside,
      latitude: 34.05,
      longitude: -118.24,
    });
    const later = await mkEvent(host, {
      title: `Later ${tag}`,
      starts_at: outside,
      latitude: 40.72,
      longitude: -74.0,
    });

    const viewer = await signup(t);
    const r = await search(viewer.client, 'events this weekend near me', {
      lat: '40.7128',
      lng: '-74.006',
      radiusKm: '25',
    });
    expect(r.body.interpretedAs).toMatchObject({
      mode: 'natural_language',
      entityTypes: ['events'],
      nearMe: true,
    });
    expect(r.body.interpretedAs.timeWindow.label).toBe('this weekend');
    const got = ids(r, 'events');
    expect(got).toContain(near);
    expect(got).not.toContain(far);
    expect(got).not.toContain(later);
    const item = r.body.results.events!.items.find((i: any) => i.id === near);
    expect(item.distanceKm).toBeGreaterThan(0);
    expect(item.distanceKm).toBeLessThan(5);

    // without coordinates we say so instead of guessing a location
    const noLoc = await search(viewer.client, 'events this weekend near me');
    expect(noLoc.body.interpretedAs.needsLocation).toBe(true);
    expect(ids(noLoc, 'events')).toEqual(expect.arrayContaining([near, far]));
  });

  it('"something interesting to do tonight" searches events and places', async () => {
    const viewer = await signup(t);
    const r = await search(viewer.client, 'something interesting to do tonight', {
      tz: 'America/New_York',
    });
    expect(r.status).toBe(200);
    expect(r.body.interpretedAs).toMatchObject({
      mode: 'natural_language',
      entityTypes: ['events', 'places'],
    });
    expect(r.body.interpretedAs.timeWindow.label).toBe('tonight');
    expect(Object.keys(r.body.results).sort()).toEqual(['events', 'places']);
  });

  it('"creators who teach networking" finds creators by their bio', async () => {
    const tag = uniq('net');
    const teacher = await signup(t, { displayName: 'Nina Network' });
    const other = await signup(t, { displayName: 'Oscar Other' });
    await setProfile(teacher, { mode: 'creator', bio: `I teach networking skills ${tag}` });
    await setProfile(other, { mode: 'personal', bio: 'I teach networking too' });
    const viewer = await signup(t);
    const r = await search(viewer.client, 'creators who teach networking');
    expect(r.body.interpretedAs).toMatchObject({
      entityTypes: ['creators'],
      keywords: ['teach', 'networking'],
    });
    expect(ids(r, 'creators')).toContain(teacher.id);
    expect(ids(r, 'creators')).not.toContain(other.id);
  });

  it('explicit types override the natural-language guess', async () => {
    const owner = await signup(t);
    const tag = uniq('ovr');
    const c = await mkCommunity(owner, { name: `Club ${tag}` });
    const r = await search(owner.client, `${tag} communities`, { types: 'people' });
    expect(r.body.types).toEqual(['people']);
    expect(r.body.interpretedAs.typesOverridden).toBe(true);
    expect(ids(r, 'communities')).toEqual([]);
    void c;
  });

  it('falls back to a plain keyword search when the interpretation finds nothing', async () => {
    const tag = uniq('fb');
    const person = await signup(t, { displayName: `Events ${tag}` });
    const viewer = await signup(t);
    // "events" reads as an entity word, but the person is named "Events <tag>"
    const r = await search(viewer.client, `events ${tag}`);
    expect(r.body.interpretedAs.fellBack).toBe(true);
    expect(ids(r, 'people')).toEqual([person.id]);
    expect(r.body.total).toBe(1);
  });

  it('nonsense queries return empty groups, not errors', async () => {
    const viewer = await signup(t);
    const r = await search(viewer.client, 'qzxwvutsrq plmokn');
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(0);
    expect(r.body.interpretedAs.mode).toBe('keyword');
  });

  it('interpret=off disables the parser', async () => {
    const owner = await signup(t);
    const tag = uniq('off');
    const c = await mkCommunity(owner, { name: `Communities ${tag}` });
    const r = await search(owner.client, `communities ${tag}`, { interpret: 'off' });
    expect(r.body.interpretedAs.mode).toBe('keyword');
    expect(ids(r, 'communities')).toContain(c.id);
  });
});

// ================================================================== ranking
describe('ranking', () => {
  it('ranks an exact name above a partial one above a description-only match', async () => {
    const tag = uniq('rnk');
    const owner = await signup(t);
    const exact = (await mkCommunity(owner, { name: tag })).id;
    const partial = (await mkCommunity(owner, { name: `The ${tag} society` })).id;
    const descr = (
      await mkCommunity(owner, {
        name: `Unrelated ${uniq('u')}`,
        description: `We sometimes talk about ${tag}`,
      })
    ).id;
    const got = await only(owner.client, tag, 'communities');
    expect(got).toEqual([exact, partial, descr]);
  });

  it('popularity and recency both raise a result', async () => {
    const tag = uniq('pop');
    const author = await signup(t);
    const fans = await Promise.all([signup(t), signup(t), signup(t)]);
    const quiet = await mkPost(author, { body: `quiet ${tag}`, visibility: 'public' });
    const loved = await mkPost(author, { body: `loved ${tag}`, visibility: 'public' });
    for (const f of fans) await f.client.put(`/v1/posts/${loved.id}/reaction`, { kind: 'like' });
    const viewer = await signup(t);
    expect(await only(viewer.client, tag, 'posts')).toEqual([loved.id, quiet.id]);

    // same engagement, older post loses
    const t2 = uniq('rec');
    const old = await mkPost(author, { body: `old ${t2}`, visibility: 'public' });
    const fresh = await mkPost(author, { body: `fresh ${t2}`, visibility: 'public' });
    await q(`UPDATE posts SET created_at = now() - interval '20 days' WHERE id = $1`, [old.id]);
    expect(await only(viewer.client, t2, 'posts')).toEqual([fresh.id, old.id]);
  });

  it('larger communities win ties, and topic matches boost', async () => {
    const tag = uniq('mem');
    const owner = await signup(t);
    const small = await mkCommunity(owner, { name: `Small ${tag}` });
    const big = await mkCommunity(owner, { name: `Small ${tag}` });
    await q(`UPDATE communities SET member_count = 500 WHERE id = $1`, [big.id]);
    const viewer = await signup(t);
    expect(await only(viewer.client, tag, 'communities')).toEqual([big.id, small.id]);
  });

  it('soon events outrank distant ones with equal text relevance', async () => {
    const tag = uniq('soon');
    const host = await signup(t);
    const later = await mkEvent(host, {
      title: `Meetup ${tag}`,
      starts_at: new Date(Date.now() + 20 * 86_400_000),
    });
    const sooner = await mkEvent(host, {
      title: `Meetup ${tag}`,
      starts_at: new Date(Date.now() + 1 * 86_400_000),
    });
    expect(await only(host.client, tag, 'events')).toEqual([sooner, later]);
  });

  it('interests give a small boost but never filter', async () => {
    const tag = uniq('int');
    const author = await signup(t);
    const tagged = await mkPost(author, {
      body: `tagged ${tag}`,
      visibility: 'public',
      topics: ['music'],
    });
    const plain = await mkPost(author, { body: `plain ${tag}`, visibility: 'public' });
    await q(`UPDATE posts SET created_at = now() - interval '1 hour' WHERE id = $1`, [tagged.id]); // slightly older: only the boost can lift it
    const fan = await signup(t);
    await fan.client.put('/v1/profile/interests', { topics: ['music'] });
    const neutral = await signup(t);
    expect(await only(fan.client, tag, 'posts')).toEqual([tagged.id, plain.id]);
    expect(await only(neutral.client, tag, 'posts')).toEqual([plain.id, tagged.id]);
    // with personalization off the boost is not applied, and nothing is filtered either way
    await setPref(fan, 'personalization', false);
    expect(await only(fan.client, tag, 'posts')).toEqual([plain.id, tagged.id]);
  });
});

// ================================================================== pagination
describe('pagination', () => {
  it('pages a single type with keyset cursors without gaps or duplicates', async () => {
    const tag = uniq('pg');
    const owner = await signup(t);
    const created: string[] = [];
    for (let i = 0; i < 5; i++)
      created.push((await mkCommunity(owner, { name: `Page ${tag} ${i}` })).id);
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const r = await search(owner.client, tag, {
        types: 'communities',
        limit: '2',
        ...(cursor ? { cursor } : {}),
      });
      expect(r.status).toBe(200);
      seen.push(...ids(r, 'communities'));
      cursor = r.body.results.communities!.nextCursor ?? undefined;
      pages++;
      if (pages === 1) await mkCommunity(owner, { name: `Page ${tag} late` }); // new content mid-pagination must not disturb the sequence
    } while (cursor && pages < 10);
    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toEqual(expect.arrayContaining(created));
    expect(seen.length).toBeLessThanOrEqual(6); // the community added mid-pagination may or may not be included, never twice
  });

  it('multi-type searches return per-type pages and a cursor per type', async () => {
    const tag = uniq('mt');
    const owner = await signup(t);
    for (let i = 0; i < 3; i++) await mkCommunity(owner, { name: `Multi ${tag} ${i}` });
    const r = await search(owner.client, tag, { limit: '2' });
    expect(r.body.results.communities!.items).toHaveLength(2);
    expect(r.body.results.communities!.nextCursor).toBeTruthy();
    expect(
      (
        await owner.client.get('/v1/search', {
          q: tag,
          limit: '2',
          cursor: r.body.results.communities!.nextCursor!,
        })
      ).status,
    ).toBe(400); // needs types=
    const next = await search(owner.client, tag, {
      types: 'communities',
      limit: '2',
      cursor: r.body.results.communities!.nextCursor!,
    });
    expect(next.body.results.communities!.items).toHaveLength(1);
    expect(next.body.results.communities!.nextCursor).toBeNull();
  });
});

// ================================================================== history & personalization
describe('search history', () => {
  it('records searches only with personalization on; can be listed and deleted', async () => {
    const u = await signup(t);
    const tag = uniq('hist');
    expect((await search(u.client, `first ${tag}`)).status).toBe(200);
    await search(u.client, `First   ${tag}`); // same normalised query
    await search(u.client, `second ${tag}`);
    const h = await u.client.get('/v1/search/history');
    expect(h.status).toBe(200);
    expect(h.body.recording).toBe(true);
    expect(h.body.items.map((i: any) => i.query)).toEqual([`second ${tag}`, `First   ${tag}`]);
    expect(h.body.items[1].searchCount).toBe(2);

    // typeahead offers matching recent searches
    const s = await u.client.get('/v1/search/suggest', { q: 'first' });
    expect(s.body.recent).toEqual([`First   ${tag}`]);

    // repeating a search bumps its count
    await search(u.client, `second ${tag}`, { types: 'people', limit: '1' });
    expect(
      (await u.client.get('/v1/search/history')).body.items.find(
        (i: any) => i.query === `second ${tag}`,
      ).searchCount,
    ).toBe(2);

    // delete one entry, then everything
    expect((await u.client.del('/v1/search/history', undefined)).status).toBe(204);
    expect((await u.client.get('/v1/search/history')).body.items).toEqual([]);
    const audits = await q(
      `SELECT count(*)::int AS n FROM audit_logs WHERE actor_id = $1 AND action = 'search.history_cleared'`,
      [u.id],
    );
    expect(audits.rows[0].n).toBe(1);
  });

  it('does not record when personalization is off (and stops the recent-search hints)', async () => {
    const u = await signup(t);
    const tag = uniq('nopers');
    await setPref(u, 'personalization', false);
    await search(u.client, `secret ${tag}`);
    const h = await u.client.get('/v1/search/history');
    expect(h.body.recording).toBe(false);
    expect(h.body.items).toEqual([]);
    const n = await q(`SELECT count(*)::int AS n FROM search_history WHERE user_id = $1`, [u.id]);
    expect(n.rows[0].n).toBe(0);
    expect((await u.client.get('/v1/search/suggest', { q: 'secret' })).body.recent).toEqual([]);
  });

  it('never records for anonymous or teen accounts', async () => {
    const teen = await signup(t, { birthDate: teenBirth() });
    await search(teen.client, 'teen searching things');
    expect(
      (await q(`SELECT count(*)::int AS n FROM search_history WHERE user_id = $1`, [teen.id]))
        .rows[0].n,
    ).toBe(0);
    expect((await search(anon(), 'anonymous searching')).status).toBe(200);
  });

  it('deletes a single entry, keeps only the newest 50, and purges expired rows', async () => {
    const u = await signup(t);
    const other = await signup(t);
    await search(u.client, 'keep this one');
    await search(u.client, 'drop this one');
    await search(other.client, 'drop this one');
    expect((await u.client.del('/v1/search/history?q=Drop%20This%20One')).status).toBe(204);
    expect((await u.client.get('/v1/search/history')).body.items.map((i: any) => i.query)).toEqual([
      'keep this one',
    ]);
    expect((await other.client.get('/v1/search/history')).body.items).toHaveLength(1); // other users' history untouched

    for (let i = 0; i < 55; i++)
      await q(
        `INSERT INTO search_history (user_id, normalized_query, query, last_searched_at) VALUES ($1,$2,$2, now() - ($3 || ' minutes')::interval)`,
        [u.id, `bulk query ${i}`, String(i + 1)],
      );
    await search(u.client, 'trigger cleanup');
    const n = await q(`SELECT count(*)::int AS n FROM search_history WHERE user_id = $1`, [u.id]);
    expect(n.rows[0].n).toBe(50);

    await q(
      `UPDATE search_history SET last_searched_at = now() - interval '100 days' WHERE user_id = $1`,
      [u.id],
    );
    expect((await u.client.get('/v1/search/history')).body.items).toEqual([]); // expired rows are not returned
    expect(await purgeExpiredSearchHistory(db())).toBeGreaterThanOrEqual(50);
    expect(
      (await q(`SELECT count(*)::int AS n FROM search_history WHERE user_id = $1`, [u.id])).rows[0]
        .n,
    ).toBe(0);
  });

  it('is removed with the account', async () => {
    const u = await signup(t);
    await search(u.client, 'to be forgotten');
    await q('DELETE FROM users WHERE id = $1', [u.id]);
    expect(
      (await q(`SELECT count(*)::int AS n FROM search_history WHERE user_id = $1`, [u.id])).rows[0]
        .n,
    ).toBe(0);
  });
});

// ================================================================== injection & abuse
describe('hostile input', () => {
  const evil = [
    `'; DROP TABLE users; --`,
    `" OR 1=1 --`,
    `%`,
    `_`,
    `\\`,
    `& | ! ( ) :*`,
    `a:* & b`,
    '\u0000',
    `((((`,
    `))))`,
    `-`,
    `"unterminated`,
    `<script>alert(1)</script>`,
    `'||(SELECT pg_sleep(0))||'`,
    '日本語 клавиатура',
    '🙂🙂',
    'x'.repeat(200),
  ];
  it.each(evil)('search and typeahead survive %j', async (payload) => {
    const u = await signup(t);
    const q1 = payload.replace('\u0000', 'x');
    const r = await search(u.client, q1.length < 2 ? `${q1}${q1}` : q1);
    expect([200, 400]).toContain(r.status);
    const s = await u.client.get('/v1/search/suggest', { q: q1 });
    expect([200, 400]).toContain(s.status);
    const again = await q('SELECT count(*)::int AS n FROM users');
    expect(again.rows[0].n).toBeGreaterThan(0);
  });

  it('search is rate limited per user', async () => {
    const limited = await createTestApp({ RATE_LIMIT_ENABLED: 'true' });
    try {
      const u = await signup(limited);
      let last = 0;
      for (let i = 0; i < 35; i++) last = (await u.client.del('/v1/search/history')).status;
      expect(last).toBe(429);
      const s = await u.client.get('/v1/search', { q: 'still fine' });
      expect(s.status).toBe(200);
    } finally {
      await limited.close();
    }
  });
});
