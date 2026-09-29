import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { as, signUp, testApp } from './helpers.ts';
import type { BuiltApp } from '../src/app.ts';

let t: BuiltApp;
beforeAll(async () => {
  t = await testApp();
});
afterAll(async () => {
  await t.close();
});

const adult = { birthDate: '1990-01-01' };

describe('For you with a busy account', () => {
  it('spreads one author out over the pages instead of dropping their posts, and ends only at the end', async () => {
    const busy = await signUp(t.app, adult);
    const quiet = await signUp(t.app, adult);
    const viewer = await signUp(t.app, adult);
    await as(t.app, viewer).post(`/v1/users/${busy.id}/follow`);
    await as(t.app, viewer).post(`/v1/users/${quiet.id}/follow`);
    const mine: string[] = [];
    for (let i = 0; i < 9; i++) mine.push((await as(t.app, busy).post('/v1/posts', { body: `Busy post ${i}` })).body.post.id);
    const theirs = (await as(t.app, quiet).post('/v1/posts', { body: 'Quiet post' })).body.post.id;

    for (const personalization of [true, false]) {
      await as(t.app, viewer).put('/v1/me/consents', { purpose: 'personalization', granted: personalization });
      const seen: string[] = [];
      let cursor: string | null = null;
      let firstPage: string[] = [];
      for (let page = 0; page < 200; page++) {
        const r = await as(t.app, viewer).get(`/v1/feed?mode=for_you&limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
        expect(r.status).toBe(200);
        const ids = (r.body.items as { id: string }[]).map((p) => p.id);
        if (page === 0) firstPage = ids;
        seen.push(...ids);
        cursor = r.body.nextCursor;
        if (!cursor) break;
      }
      // Every post once, nothing skipped between pages.
      for (const id of [...mine, theirs]) expect(seen.filter((x) => x === id)).toHaveLength(1);
      // With personalization on, the quiet account you follow isn't pushed off the first page by the busy one.
      if (personalization) expect(firstPage).toContain(theirs);
    }
  });
});

describe('cursors someone made up', () => {
  it('are refused with a 400, not a server error, and real ones still page', async () => {
    const viewer = await signUp(t.app, adult);
    const post = (await as(t.app, viewer).post('/v1/posts', { body: 'Paging #cursortest' })).body.post;
    const made = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const bad = [made({ t: 'yesterday', id: 'nope' }), made({ asOf: 'soon', o: -5 }), made([1, 2]), made('text'), made({ t: '2026-09-29T07:00:00Z', id: 'x' })];
    const urls = [
      '/v1/feed?mode=following',
      '/v1/feed?mode=for_you',
      `/v1/posts/${post.id}/comments?sort=newest`,
      `/v1/posts/${post.id}/comments?sort=top`,
      '/v1/tags/cursortest/posts',
      '/v1/me/saved',
      `/v1/users/${viewer.username}/posts`,
    ];
    for (const url of urls)
      for (const cursor of bad) {
        const r = await as(t.app, viewer).get(`${url}${url.includes('?') ? '&' : '?'}cursor=${cursor}`);
        expect(r.status, `${url} with ${Buffer.from(cursor, 'base64url').toString()}`).toBe(400);
      }
    // Cursors the API writes are still taken (an ISO time, and Postgres' own text form).
    const ok = [made({ t: new Date().toISOString(), id: post.id }), made({ t: '2026-09-29 07:00:00.123456+00', id: post.id })];
    for (const cursor of ok) expect((await as(t.app, viewer).get(`/v1/feed?mode=following&cursor=${cursor}`)).status).toBe(200);
    expect((await as(t.app, viewer).get(`/v1/feed?mode=for_you&cursor=${made({ asOf: new Date().toISOString(), o: 0 })}`)).status).toBe(200);
  });
});

describe('products in search', () => {
  it("say whose shop they're in, and leave out sellers blocked either way", async () => {
    const seller = await signUp(t.app, adult);
    const viewer = await signUp(t.app, adult);
    const word = `lantern${Date.now().toString(36)}`;
    expect((await as(t.app, seller).post('/v1/products', { title: `Paper ${word}`, priceCents: 1500 })).status).toBe(201);
    const found = (await as(t.app, viewer).get(`/v1/search?q=${word}`)).body.results.products;
    expect(found).toEqual([expect.objectContaining({ title: `Paper ${word}`, sellerUsername: seller.username })]);
    await as(t.app, seller).post(`/v1/users/${viewer.id}/block`);
    expect((await as(t.app, viewer).get(`/v1/search?q=${word}`)).body.results.products).toEqual([]);
  });
});

describe('search sentences', () => {
  it('reads a group size at the end of a sentence', async () => {
    const r = await as(t.app, null).get('/v1/search?q=restaurants%20for%20six');
    expect(r.body.intent).toMatchObject({ types: ['places'], placeCategory: 'restaurant', groupSize: 6 });
    expect((await as(t.app, null).get('/v1/search?q=a%20table%20for%204%20people')).body.intent.groupSize).toBe(4);
  });
});

describe('photo and video addresses', () => {
  it('takes only web addresses, never javascript: or data:', async () => {
    const author = await signUp(t.app, adult);
    for (const url of ['javascript:alert(1)', 'data:image/png;base64,AAAA'])
      expect((await as(t.app, author).post('/v1/posts', { body: 'Look', media: [{ url, kind: 'image' }] })).status).toBe(400);
  });
});

describe('hashtags from places not everyone can see', () => {
  it('keeps tags of private communities and private accounts out of trending, topic search, NOW and related tags', async () => {
    const owner = await signUp(t.app, adult);
    const quiet = await signUp(t.app, adult);
    const viewer = await signUp(t.app, adult);
    const sfx = Date.now().toString(36);
    const inside = `insidetag${sfx}`;
    const hushed = `hushedtag${sfx}`;
    const shared = `sharedtag${sfx}`;
    const community = (await as(t.app, owner).post('/v1/communities', { name: 'Back room', slug: `back-${sfx}`, visibility: 'private' })).body.community;
    expect((await as(t.app, owner).post('/v1/posts', { body: `Plans #${inside} #${shared}`, communityId: community.id })).status).toBe(201);
    await as(t.app, quiet).patch('/v1/me/profile', { isPrivate: true });
    expect((await as(t.app, quiet).post('/v1/posts', { body: `Just us #${hushed} #${shared}` })).status).toBe(201);
    // A public post with the shared tag, so its page and related tags have something to show.
    expect((await as(t.app, viewer).post('/v1/posts', { body: `Out here #${shared}` })).status).toBe(201);

    const trending = JSON.stringify((await as(t.app, null).get('/v1/trending?limit=30')).body);
    const now = JSON.stringify((await as(t.app, viewer).get('/v1/now')).body);
    for (const tag of [inside, hushed]) {
      expect(trending).not.toContain(tag);
      expect(now).not.toContain(tag);
      expect(JSON.stringify((await as(t.app, viewer).get(`/v1/search?type=topics&q=${tag.slice(0, 9)}`)).body)).not.toContain(tag);
    }
    const page = (await as(t.app, viewer).get(`/v1/tags/${shared}`)).body;
    expect(page.related).not.toContain(inside);
    expect(page.related).not.toContain(hushed);
    // The public use still counts.
    const found = (await as(t.app, viewer).get(`/v1/search?type=topics&q=${shared}`)).body.results.topics;
    expect(found).toEqual([{ slug: shared, name: shared, posts: 1 }]);
  });
});

describe('reporting posts and comments', () => {
  it("is refused for a post the reporter can't see, so a minor-safety report can't hide it", async () => {
    const author = await signUp(t.app, adult);
    const stranger = await signUp(t.app, adult);
    const hidden = (await as(t.app, author).post('/v1/posts', { body: 'Only me', visibility: 'private' })).body.post;
    const r = await as(t.app, stranger).post('/v1/reports', { targetType: 'post', targetId: hidden.id, reason: 'minor_safety' });
    expect(r.status).toBe(404);
    const status = await t.ctx.db.query(`SELECT moderation_status FROM posts WHERE id = $1`, [hidden.id]);
    expect(status.rows[0].moderation_status).toBe('normal');
  });

  it("is refused for a comment on a post the reporter can't see", async () => {
    const author = await signUp(t.app, adult);
    const friend = await signUp(t.app, adult);
    const stranger = await signUp(t.app, adult);
    await as(t.app, friend).post(`/v1/users/${author.id}/follow`);
    const post = (await as(t.app, author).post('/v1/posts', { body: 'For followers', visibility: 'followers' })).body.post;
    const comment = (await as(t.app, friend).post(`/v1/posts/${post.id}/comments`, { body: 'Nice' })).body.comment;
    expect(comment?.id).toBeTruthy();
    expect((await as(t.app, stranger).post('/v1/reports', { targetType: 'comment', targetId: comment.id, reason: 'spam' })).status).toBe(404);
    expect((await as(t.app, author).post('/v1/reports', { targetType: 'comment', targetId: comment.id, reason: 'spam' })).status).toBe(201);
  });

  it('still takes a report on a post someone can see, and across a block', async () => {
    const author = await signUp(t.app, adult);
    const viewer = await signUp(t.app, adult);
    const post = (await as(t.app, author).post('/v1/posts', { body: 'Out in the open' })).body.post;
    expect((await as(t.app, viewer).post('/v1/reports', { targetType: 'post', targetId: post.id, reason: 'spam' })).status).toBe(201);
    const other = (await as(t.app, author).post('/v1/posts', { body: 'Another one' })).body.post;
    await as(t.app, author).post(`/v1/users/${viewer.id}/block`);
    expect((await as(t.app, viewer).post('/v1/reports', { targetType: 'post', targetId: other.id, reason: 'harassment' })).status).toBe(201);
  });
});
