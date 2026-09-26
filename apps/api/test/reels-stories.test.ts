import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { as, signUp, testApp, type TestUser } from './helpers.ts';
import type { BuiltApp } from '../src/app.ts';

let t: BuiltApp;
beforeAll(async () => {
  t = await testApp();
});
afterAll(async () => {
  await t.close();
});

async function video(owner: TestUser, durationMs: number | null = 12_000) {
  const { rows } = await t.ctx.db.query(
    `INSERT INTO media (owner_id, kind, url, mime, status, duration_ms) VALUES ($1,'video','http://localhost:4000/media/test.mp4','video/mp4','ready',$2) RETURNING id, url`,
    [owner.id, durationMs],
  );
  return rows[0] as { id: string; url: string };
}

describe('reels', () => {
  it('publishes one short video as a reel and serves it in the reels feed', async () => {
    const creator = await signUp(t.app, { birthDate: '1990-01-01' });
    const fan = await signUp(t.app, { birthDate: '1990-01-01' });
    await as(t.app, fan).post(`/v1/users/${creator.id}/follow`);
    const v = await video(creator);

    // A reel is exactly one video.
    expect((await as(t.app, creator).post('/v1/posts', { format: 'reel', body: 'No video' })).status).toBe(400);
    const long = await video(creator, 240_000);
    expect((await as(t.app, creator).post('/v1/posts', { format: 'reel', media: [{ id: long.id, url: long.url, kind: 'video' }] })).status).toBe(400);

    const reel = await as(t.app, creator).post('/v1/posts', { format: 'reel', body: 'Sunset timelapse', media: [{ id: v.id, url: v.url, kind: 'video' }] });
    expect(reel.status).toBe(201);
    expect(reel.body.post).toMatchObject({ format: 'reel', kind: 'video' });
    const plain = await as(t.app, creator).post('/v1/posts', { body: 'Just words' });
    expect(plain.body.post.format).toBe('post');

    const feed = await as(t.app, fan).get('/v1/reels?limit=20');
    const ids = feed.body.items.map((p: any) => p.id);
    expect(ids).toContain(reel.body.post.id);
    expect(ids).not.toContain(plain.body.post.id);
    expect(feed.body.items.every((p: any) => p.format === 'reel')).toBe(true);
  });
});

describe('stories', () => {
  it('shows unseen stories first, records views and likes, and lists viewers for the author', async () => {
    const author = await signUp(t.app, { birthDate: '1990-01-01' });
    const friend = await signUp(t.app, { birthDate: '1990-01-01' });
    const outsider = await signUp(t.app, { birthDate: '1990-01-01' });
    await as(t.app, friend).post(`/v1/users/${author.id}/follow`);
    const v = await video(author);
    const other = await signUp(t.app, { birthDate: '1990-01-01' });
    await as(t.app, friend).post(`/v1/users/${other.id}/follow`);

    const s1 = (await as(t.app, author).post('/v1/moments', { body: 'Morning run', visibility: 'followers' })).body.moment;
    const s2 = (await as(t.app, author).post('/v1/moments', { mediaId: v.id, visibility: 'followers' })).body.moment;
    await as(t.app, other).post('/v1/moments', { body: 'Hello', visibility: 'followers' });
    // Someone else's upload can't be used.
    expect((await as(t.app, other).post('/v1/moments', { mediaId: v.id })).status).toBe(404);

    let groups = (await as(t.app, friend).get('/v1/moments')).body.items;
    const g = groups.find((x: any) => x.author.id === author.id);
    expect(g.moments.map((m: any) => m.id)).toEqual([s1.id, s2.id]);
    expect(g.moments[1]).toMatchObject({ mediaKind: 'video', seen: false });
    expect(g.allSeen).toBe(false);

    // Outsiders can't see, view or like it.
    expect((await as(t.app, outsider).post(`/v1/moments/${s1.id}/view`)).status).toBe(404);

    await as(t.app, friend).post(`/v1/moments/${s1.id}/view`);
    await as(t.app, friend).post(`/v1/moments/${s2.id}/view`);
    expect((await as(t.app, friend).put(`/v1/moments/${s2.id}/like`, { liked: true })).body.liked).toBe(true);
    groups = (await as(t.app, friend).get('/v1/moments')).body.items;
    // Fully seen groups move after ones with something new.
    expect(groups.findIndex((x: any) => x.author.id === other.id)).toBeLessThan(groups.findIndex((x: any) => x.author.id === author.id));
    expect(groups.find((x: any) => x.author.id === author.id)).toMatchObject({ allSeen: true });

    const mine = (await as(t.app, author).get('/v1/moments')).body.items[0];
    expect(mine.mine).toBe(true);
    expect(mine.moments[1].views).toBe(1);
    const viewers = await as(t.app, author).get(`/v1/moments/${s2.id}/viewers`);
    expect(viewers.body.items).toEqual([expect.objectContaining({ liked: true, user: expect.objectContaining({ id: friend.id }) })]);
    expect((await as(t.app, friend).get(`/v1/moments/${s2.id}/viewers`)).status).toBe(403);
  });

  it('delivers a story reply as a direct message', async () => {
    const author = await signUp(t.app, { birthDate: '1990-01-01' });
    const friend = await signUp(t.app, { birthDate: '1990-01-01' });
    await as(t.app, friend).post(`/v1/users/${author.id}/follow`);
    const s = (await as(t.app, author).post('/v1/moments', { body: 'New studio', visibility: 'followers' })).body.moment;
    const r = await as(t.app, friend).post(`/v1/moments/${s.id}/reply`, { body: 'Looks great' });
    expect(r.status).toBe(201);
    const msgs = await as(t.app, author).get(`/v1/conversations/${r.body.conversationId}/messages`);
    expect(msgs.body.items.at(-1).body).toBe('Replied to “New studio”: Looks great');
    expect((await as(t.app, author).post(`/v1/moments/${s.id}/reply`, { body: 'me' })).status).toBe(400);
  });
});
