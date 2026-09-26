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

describe('mentions', () => {
  it('notifies people mentioned in posts and comments, only when they can see the post', async () => {
    const author = await signUp(t.app, { birthDate: '1990-01-01' });
    const friend = await signUp(t.app, { birthDate: '1990-01-01' });
    const stranger = await signUp(t.app, { birthDate: '1990-01-01' });
    await as(t.app, friend).post(`/v1/users/${author.id}/follow`);
    const count = async (userId: string, type: string) =>
      (await t.ctx.db.query(`SELECT 1 FROM notifications WHERE user_id = $1 AND type = $2`, [userId, type])).rowCount;

    const pub = (await as(t.app, author).post('/v1/posts', { body: `Lunch with @${friend.username.toUpperCase()} and @${stranger.username}.` })).body.post;
    expect(await count(friend.id, 'post_mention')).toBe(1);
    expect(await count(stranger.id, 'post_mention')).toBe(1);

    await as(t.app, author).post('/v1/posts', { body: `Followers only, @${stranger.username} @${friend.username}`, visibility: 'followers' });
    expect(await count(stranger.id, 'post_mention')).toBe(1); // can't see it, so not told
    expect(await count(friend.id, 'post_mention')).toBe(2);

    await as(t.app, friend).post(`/v1/posts/${pub.id}/comments`, { body: `Agreed @${stranger.username} and @${author.username}` });
    expect(await count(stranger.id, 'comment_mention')).toBe(1);
    expect(await count(author.id, 'comment_mention')).toBe(0); // already told about the comment
    expect(await count(author.id, 'post_comment')).toBe(1);

    await as(t.app, author).post('/v1/posts', { body: `Talking to myself @${author.username}` });
    expect(await count(author.id, 'post_mention')).toBe(0);
  });
});

describe('message attachments', () => {
  it('sends your own uploads and refuses anyone else’s or raw addresses', async () => {
    const a = await signUp(t.app, { birthDate: '1990-01-01' });
    const b = await signUp(t.app, { birthDate: '1990-01-01' });
    await as(t.app, a).post(`/v1/users/${b.id}/follow`);
    await as(t.app, b).post(`/v1/users/${a.id}/follow`);
    const conv = (await as(t.app, a).post('/v1/conversations', { memberIds: [b.id] })).body.conversation;
    const media = async (owner: typeof a, kind: string, mime: string) =>
      (
        await t.ctx.db.query(
          `INSERT INTO media (owner_id, kind, url, mime, status, duration_ms) VALUES ($1,$2,'http://localhost:4000/media/x','${mime}','ready',4200) RETURNING id`,
          [owner.id, kind],
        )
      ).rows[0].id as string;
    const voice = await media(a, 'audio', 'audio/webm');
    const sent = await as(t.app, a).post(`/v1/conversations/${conv.id}/messages`, { attachments: [{ mediaId: voice }] });
    expect(sent.status).toBe(201);
    expect(sent.body.message.attachments).toEqual([expect.objectContaining({ mediaId: voice, kind: 'audio', durationMs: 4200 })]);

    const theirs = await media(b, 'image', 'image/png');
    expect((await as(t.app, a).post(`/v1/conversations/${conv.id}/messages`, { attachments: [{ mediaId: theirs }] })).status).toBe(404);
    expect(
      (await as(t.app, a).post(`/v1/conversations/${conv.id}/messages`, { attachments: [{ url: 'https://evil.example/x.png', kind: 'image' }] })).status,
    ).toBe(400);
  });
});

describe('realtime tickets', () => {
  it('opens the realtime socket from another origin with a short-lived ticket', async () => {
    const { issueTicket, readTicket } = await import('../src/lib/realtime-ticket.ts');
    const u = await signUp(t.app, { birthDate: '1990-01-01' });
    const r = await as(t.app, u).post('/v1/realtime/ticket');
    expect(r.status).toBe(200);
    const sessionId = readTicket(t.ctx.config, r.body.ticket);
    expect(sessionId).toBeTruthy();
    // Forged, expired and tampered tickets are refused.
    expect(readTicket(t.ctx.config, issueTicket(t.ctx.config, sessionId!, Date.now() - 120_000))).toBeNull();
    expect(
      readTicket(
        t.ctx.config,
        r.body.ticket.replace(/.$/, (c: string) => (c === 'A' ? 'B' : 'A')),
      ),
    ).toBeNull();
    expect(readTicket(t.ctx.config, 'bm90LWEtdGlja2V0.abc')).toBeNull();
    expect((await as(t.app, null).post('/v1/realtime/ticket')).status).toBe(401);
  });
});
