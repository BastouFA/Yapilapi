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
