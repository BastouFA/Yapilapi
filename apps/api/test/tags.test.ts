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

describe('hashtags', () => {
  it('turns #tags in a post into topics with a page, posts and related tags', async () => {
    const tag = `sunset${Date.now().toString(36)}`;
    const a = await signUp(t.app, { birthDate: '1990-01-01' });
    const b = await signUp(t.app, { birthDate: '1990-01-01' });
    const viewer = await signUp(t.app, { birthDate: '1990-01-01' });
    const p1 = (await as(t.app, a).post('/v1/posts', { body: `Evening walk #${tag.toUpperCase()} #lagos`, topics: ['travel'] })).body.post;
    expect(p1.topics).toEqual(['travel', tag, 'lagos']);
    const p2 = (await as(t.app, b).post('/v1/posts', { body: `Same sky #${tag}` })).body.post;
    const hidden = (await as(t.app, b).post('/v1/posts', { body: `Friends only #${tag}`, visibility: 'friends' })).body.post;
    await as(t.app, viewer).post(`/v1/posts/${p2.id}/like`);

    const page = await as(t.app, viewer).get(`/v1/tags/${encodeURIComponent('#' + tag)}`);
    expect(page.body).toMatchObject({ tag, posts: 2, people: 2, following: false });
    expect(page.body.related).toContain('lagos');

    const recent = (await as(t.app, viewer).get(`/v1/tags/${tag}/posts?limit=1`)).body;
    expect(recent.items.map((p: any) => p.id)).toEqual([p2.id]);
    const more = (await as(t.app, viewer).get(`/v1/tags/${tag}/posts?limit=1&cursor=${recent.nextCursor}`)).body;
    expect(more.items.map((p: any) => p.id)).toEqual([p1.id]);
    expect(more.nextCursor).toBeNull();
    const top = (await as(t.app, viewer).get(`/v1/tags/${tag}/posts?sort=top`)).body.items.map((p: any) => p.id);
    expect(top[0]).toBe(p2.id);
    expect(top).not.toContain(hidden.id);

    expect((await as(t.app, viewer).get('/v1/tags/a')).status).toBe(400);
  });

  it('follows a tag as an interest and ranks trending tags by how many people use them', async () => {
    const tag = `wave${Date.now().toString(36)}`;
    const users = await Promise.all([1, 2, 3].map(() => signUp(t.app, { birthDate: '1990-01-01' })));
    for (const u of users) await as(t.app, u).post('/v1/posts', { body: `On the #${tag}` });
    const spammer = await signUp(t.app, { birthDate: '1990-01-01' });
    for (let i = 0; i < 3; i++) await as(t.app, spammer).post('/v1/posts', { body: `Buy now #solo${tag} ${i}` });

    const trending = (await as(t.app, null).get('/v1/trending?limit=30')).body.items;
    const mine = trending.findIndex((x: any) => x.tag === tag);
    expect(mine).toBeGreaterThanOrEqual(0);
    expect(trending[mine]).toMatchObject({ posts: 3, people: 3 });
    const solo = trending.findIndex((x: any) => x.tag === `solo${tag}`);
    if (solo >= 0) expect(solo).toBeGreaterThan(mine);

    const me = users[0]!;
    expect((await as(t.app, me).put(`/v1/tags/${tag}/follow`)).body).toEqual({ following: true });
    expect((await as(t.app, me).get(`/v1/tags/${tag}`)).body.following).toBe(true);
    expect((await as(t.app, me).del(`/v1/tags/${tag}/follow`)).body).toEqual({ following: false });
    expect((await as(t.app, null).put(`/v1/tags/${tag}/follow`)).status).toBe(401);
  });
});
