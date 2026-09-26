import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { as, signUp, testApp, type TestUser } from './helpers.ts';
import type { BuiltApp } from '../src/app.ts';
import { excerpt } from '../src/modules/public.ts';

let t: BuiltApp;
let admin: TestUser;
const ADULT = '1990-04-02';
const tag = () => Math.random().toString(36).slice(2, 8);
const anon = () => as(t.app, null);

beforeAll(async () => {
  t = await testApp();
  admin = await signUp(t.app, { birthDate: '1985-01-01' });
  await t.ctx.db.query(`UPDATE users SET role = 'admin' WHERE id = $1`, [admin.id]);
});
afterAll(async () => {
  await t.ctx.db.query(`DELETE FROM regional_rules WHERE term LIKE 'previewword%'`);
  await t.close();
});

async function postAs(u: TestUser, body: Record<string, unknown>) {
  const r = await as(t.app, u).post('/v1/posts', body);
  expect(r.status).toBe(201);
  return r.body.post as { id: string };
}

describe('public post previews', () => {
  it('shows a public post from a public account, trimmed, with only public fields and a cache header', async () => {
    const author = await signUp(t.app, { birthDate: ADULT, displayName: 'Ada Preview' });
    const long = `Sunrise over the harbour. ${'The boats come in one by one and the gulls follow. '.repeat(10)}`;
    const post = await postAs(author, {
      body: long,
      media: [{ url: 'https://cdn.example.test/harbour.jpg', kind: 'image', altText: 'Boats at dawn', width: 1600, height: 900 }],
    });
    const res = await t.app.inject({ method: 'GET', url: `/v1/public/posts/${post.id}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=300');
    const p = res.json().post;
    expect(p).toMatchObject({
      id: post.id,
      format: 'post',
      kind: 'photo',
      author: { username: author.username, displayName: 'Ada Preview', avatarUrl: null },
      image: { url: 'https://cdn.example.test/harbour.jpg', width: 1600, height: 900, alt: 'Boats at dawn' },
      video: null,
      counts: { likes: 0, comments: 0, reposts: 0 },
      community: null,
    });
    expect(p.excerpt.length).toBeLessThanOrEqual(201);
    expect(p.excerpt.endsWith('…')).toBe(true);
    expect(p.excerpt.startsWith('Sunrise over the harbour.')).toBe(true);
    // Nothing that identifies the account beyond its public profile, and nothing about the viewer.
    expect(JSON.stringify(p)).not.toContain(author.id);
    expect(JSON.stringify(p)).not.toContain(author.email);
    expect(p.viewer).toBeUndefined();
    expect(p.visibility).toBeUndefined();
  });

  it('gives reels their poster frame and a direct MP4', async () => {
    const author = await signUp(t.app, { birthDate: ADULT });
    const reel = await postAs(author, { body: 'Tiny waves', format: 'reel', media: [{ url: 'https://cdn.example.test/waves.mov', kind: 'video' }] });
    await t.ctx.db.query(
      `UPDATE media SET poster_url = 'https://cdn.example.test/waves.jpg', variants = '{"mp4":"https://cdn.example.test/waves.mp4"}', width = 1080, height = 1920, duration_ms = 12000
       WHERE id = (SELECT media_id FROM post_media WHERE post_id = $1)`,
      [reel.id],
    );
    const p = (await anon().get(`/v1/public/posts/${reel.id}`)).body.post;
    expect(p.format).toBe('reel');
    expect(p.image).toEqual({ url: 'https://cdn.example.test/waves.jpg', width: 1080, height: 1920, alt: null });
    expect(p.video).toEqual({ url: 'https://cdn.example.test/waves.mp4', width: 1080, height: 1920, durationMs: 12000 });
  });

  it('never shows followers-only, friends-only, circle, chosen-people or private posts', async () => {
    const author = await signUp(t.app, { birthDate: ADULT });
    const friend = await signUp(t.app, { birthDate: ADULT });
    await as(t.app, author).post(`/v1/users/${friend.id}/friend-request`);
    const fr = (await as(t.app, friend).get('/v1/me/friend-requests')).body.items[0];
    await as(t.app, friend).post(`/v1/friend-requests/${fr.id}/accept`);
    await as(t.app, friend).post(`/v1/users/${author.id}/follow`);

    const followers = await postAs(author, { body: 'For followers', visibility: 'followers' });
    const friends = await postAs(author, { body: 'For friends', visibility: 'friends' });
    const selected = await postAs(author, { body: 'For one person', visibility: 'selected', audience: [friend.id] });
    const onlyMe = await postAs(author, { body: 'Just for me', visibility: 'private' });
    for (const p of [followers, friends, selected, onlyMe]) {
      // The friend can see it in the app…
      if (p !== onlyMe) expect((await as(t.app, friend).get(`/v1/posts/${p.id}`)).status).toBe(200);
      // …but a preview is the same for everyone, and it isn't public.
      const pub = await t.app.inject({ method: 'GET', url: `/v1/public/posts/${p.id}` });
      expect(pub.statusCode).toBe(404);
      expect(pub.headers['cache-control']).toBe('no-store');
      expect((await as(t.app, friend).get(`/v1/public/posts/${p.id}`)).status).toBe(404);
      expect((await as(t.app, author).get(`/v1/public/posts/${p.id}`)).status).toBe(404);
    }
  });

  it('never shows posts from private accounts, even to their followers', async () => {
    const author = await signUp(t.app, { birthDate: ADULT });
    const follower = await signUp(t.app, { birthDate: ADULT });
    const post = await postAs(author, { body: 'Public audience, private account' });
    await as(t.app, author).patch('/v1/me/profile', { isPrivate: true });
    await as(t.app, follower).post(`/v1/users/${author.id}/follow`);
    const pending = (await as(t.app, author).get('/v1/me/follow-requests')).body?.items?.[0];
    if (pending) await as(t.app, author).post(`/v1/follow-requests/${pending.id}/accept`);
    expect((await anon().get(`/v1/public/posts/${post.id}`)).status).toBe(404);
    expect((await as(t.app, follower).get(`/v1/public/posts/${post.id}`)).status).toBe(404);
    expect((await anon().get(`/v1/public/users/${author.username}`)).status).toBe(404);
  });

  it('never shows deleted posts, posts under review, restricted or removed posts, or posts from suspended accounts', async () => {
    const author = await signUp(t.app, { birthDate: ADULT });
    const deleted = await postAs(author, { body: 'Soon gone' });
    expect((await anon().get(`/v1/public/posts/${deleted.id}`)).status).toBe(200);
    expect((await as(t.app, author).del(`/v1/posts/${deleted.id}`)).status).toBe(200);
    expect((await anon().get(`/v1/public/posts/${deleted.id}`)).status).toBe(404);

    for (const status of ['review', 'restricted', 'removed']) {
      const p = await postAs(author, { body: `Moderated ${status}` });
      await t.ctx.db.query(`UPDATE posts SET moderation_status = $2 WHERE id = $1`, [p.id, status]);
      expect((await anon().get(`/v1/public/posts/${p.id}`)).status).toBe(404);
      // Signed in as an adult doesn't unlock a preview either.
      expect((await as(t.app, admin).get(`/v1/public/posts/${p.id}`)).status).toBe(404);
    }

    const suspended = await signUp(t.app, { birthDate: ADULT });
    const sp = await postAs(suspended, { body: 'Before suspension' });
    await t.ctx.db.query(`UPDATE users SET status = 'suspended' WHERE id = $1`, [suspended.id]);
    expect((await anon().get(`/v1/public/posts/${sp.id}`)).status).toBe(404);
    expect((await anon().get(`/v1/public/users/${suspended.username}`)).status).toBe(404);
  });

  it('never shows anything from someone under 18, even if their account was made public', async () => {
    const teen = await signUp(t.app, { birthDate: `${new Date().getUTCFullYear() - 15}-01-01` });
    const post = await postAs(teen, { body: 'Hello from a teen' });
    await t.ctx.db.query(`UPDATE profiles SET is_private = false WHERE user_id = $1`, [teen.id]);
    expect((await anon().get(`/v1/public/posts/${post.id}`)).status).toBe(404);
    expect((await anon().get(`/v1/public/users/${teen.username}`)).status).toBe(404);
  });

  it('never shows posts in private communities', async () => {
    const owner = await signUp(t.app, { birthDate: ADULT });
    const slug = `pv-${tag()}`;
    const c = (await as(t.app, owner).post('/v1/communities', { name: 'Quiet room', slug, visibility: 'private' })).body.community;
    const inside = await postAs(owner, { body: 'Members only talk', communityId: c.id });
    expect((await anon().get(`/v1/public/posts/${inside.id}`)).status).toBe(404);
    expect((await anon().get(`/v1/public/communities/${slug}`)).status).toBe(404);

    const openSlug = `pv-${tag()}`;
    const open = (await as(t.app, owner).post('/v1/communities', { name: 'Open room', slug: openSlug, description: 'Anyone can read' })).body.community;
    const outside = await postAs(owner, { body: 'Hello everyone', communityId: open.id });
    const p = (await anon().get(`/v1/public/posts/${outside.id}`)).body.post;
    expect(p.community).toEqual({ slug: openSlug, name: 'Open room' });
  });

  it('withholds posts from visitors in a country with a regional rule, and varies the cache by country', async () => {
    process.env.TRUSTED_COUNTRY_HEADER = 'cf-ipcountry';
    const cdn = await testApp();
    delete process.env.TRUSTED_COUNTRY_HEADER;
    try {
      const author = await signUp(cdn.app, { birthDate: ADULT });
      const word = `previewword${tag()}`;
      const post = (await as(cdn.app, author).post('/v1/posts', { body: `This mentions ${word}` })).body.post;
      await as(cdn.app, admin).post('/v1/admin/regional-rules', { kind: 'blocked_term', country: 'ZZ', term: word, legalBasis: 'Preview test order' });
      const get = (country: string) => cdn.app.inject({ method: 'GET', url: `/v1/public/posts/${post.id}`, headers: { 'cf-ipcountry': country } });
      expect((await get('ZZ')).statusCode).toBe(404);
      const elsewhere = await get('YY');
      expect(elsewhere.statusCode).toBe(200);
      expect(elsewhere.headers.vary).toContain('cf-ipcountry');
      // A session from elsewhere doesn't lift it: previews are always evaluated as a visitor from the request's country.
      const signedIn = await cdn.app.inject({
        method: 'GET',
        url: `/v1/public/posts/${post.id}`,
        headers: { 'cf-ipcountry': 'ZZ', authorization: `Bearer ${author.token}` },
      });
      expect(signedIn.statusCode).toBe(404);
    } finally {
      await cdn.close();
    }
  });

  it('refuses ids that are not uuids', async () => {
    expect((await anon().get('/v1/public/posts/not-a-uuid')).status).toBe(400);
  });
});

describe('public profile previews', () => {
  it('shows a public profile with counts and a trimmed bio', async () => {
    const u = await signUp(t.app, { birthDate: ADULT, displayName: 'Bo Public' });
    const fan = await signUp(t.app, { birthDate: ADULT });
    await as(t.app, u).patch('/v1/me/profile', { bio: `Painter. ${'Colour and light. '.repeat(30)}` });
    await as(t.app, fan).post(`/v1/users/${u.id}/follow`);
    await postAs(u, { body: 'First' });
    await postAs(u, { body: 'Second', visibility: 'friends' });
    const res = await t.app.inject({ method: 'GET', url: `/v1/public/users/${u.username.toUpperCase()}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=300');
    const p = res.json().profile;
    expect(p).toMatchObject({ username: u.username, displayName: 'Bo Public', mode: 'personal', counts: { followers: 1, following: 0, posts: 2 } });
    expect(p.bio.length).toBeLessThanOrEqual(201);
    expect(p.id).toBeUndefined();
    expect(p.relationship).toBeUndefined();
    expect(JSON.stringify(p)).not.toContain(u.email);
  });

  it('returns not found for unknown and private profiles', async () => {
    expect((await anon().get(`/v1/public/users/nobody_${tag()}`)).status).toBe(404);
    const priv = await signUp(t.app, { birthDate: ADULT });
    await as(t.app, priv).patch('/v1/me/profile', { isPrivate: true });
    expect((await as(t.app, priv).get(`/v1/public/users/${priv.username}`)).status).toBe(404);
  });
});

describe('public event and community previews', () => {
  const soon = () => new Date(Date.now() + 7 * 86_400_000).toISOString();

  it('shows public events only', async () => {
    const host = await signUp(t.app, { birthDate: ADULT, displayName: 'Host Person' });
    const open = (await as(t.app, host).post('/v1/events', { title: 'Picnic', description: 'Bring a blanket', startsAt: soon(), locationText: 'The park' }))
      .body.event;
    const res = await t.app.inject({ method: 'GET', url: `/v1/public/events/${open.id}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=300');
    expect(res.json().event).toMatchObject({
      id: open.id,
      title: 'Picnic',
      excerpt: 'Bring a blanket',
      host: { username: host.username, displayName: 'Host Person' },
      locationText: 'The park',
      counts: { going: 1, interested: 0 },
    });

    for (const visibility of ['followers', 'friends', 'private']) {
      const ev = (await as(t.app, host).post('/v1/events', { title: `Hidden ${visibility}`, startsAt: soon(), visibility })).body.event;
      expect((await anon().get(`/v1/public/events/${ev.id}`)).status).toBe(404);
    }
    const gone = (await as(t.app, host).post('/v1/events', { title: 'Cancelled', startsAt: soon() })).body.event;
    await t.ctx.db.query(`UPDATE events SET deleted_at = now() WHERE id = $1`, [gone.id]);
    expect((await anon().get(`/v1/public/events/${gone.id}`)).status).toBe(404);

    const slug = `pe-${tag()}`;
    const c = (await as(t.app, host).post('/v1/communities', { name: 'Closed club', slug, visibility: 'private' })).body.community;
    const inClub = (await as(t.app, host).post('/v1/events', { title: 'Club night', startsAt: soon(), communityId: c.id })).body.event;
    expect((await anon().get(`/v1/public/events/${inClub.id}`)).status).toBe(404);
  });

  it('shows public communities only', async () => {
    const owner = await signUp(t.app, { birthDate: ADULT });
    const slug = `pc-${tag()}`;
    await as(t.app, owner).post('/v1/communities', { name: 'Gardeners', slug, description: 'Seeds, soil and patience', topics: ['gardening'] });
    const res = await t.app.inject({ method: 'GET', url: `/v1/public/communities/${slug}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().community).toEqual({ slug, name: 'Gardeners', excerpt: 'Seeds, soil and patience', memberCount: 1, topics: ['gardening'] });

    await t.ctx.db.query(`UPDATE communities SET deleted_at = now() WHERE lower(slug) = $1`, [slug]);
    expect((await anon().get(`/v1/public/communities/${slug}`)).status).toBe(404);
  });
});

describe('excerpt', () => {
  it('collapses whitespace and trims on a word boundary', () => {
    expect(excerpt('  hello \n\n world  ')).toBe('hello world');
    const out = excerpt('word '.repeat(100));
    expect(out.length).toBeLessThanOrEqual(201);
    expect(out.endsWith('word…')).toBe(true);
    expect(excerpt('x'.repeat(300))).toBe(`${'x'.repeat(200)}…`);
  });
});
