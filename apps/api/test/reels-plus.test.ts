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

const adult = () => signUp(t.app, { birthDate: '1990-01-01' });

async function video(owner: TestUser, durationMs: number | null = 12_000) {
  const { rows } = await t.ctx.db.query(
    `INSERT INTO media (owner_id, kind, url, mime, status, duration_ms) VALUES ($1,'video','http://localhost:4000/media/test.mp4','video/mp4','ready',$2) RETURNING id, url`,
    [owner.id, durationMs],
  );
  return rows[0] as { id: string; url: string };
}

async function reelBy(owner: TestUser, extra: Record<string, unknown> = {}, durationMs: number | null = 12_000) {
  const v = await video(owner, durationMs);
  const r = await as(t.app, owner).post('/v1/posts', { format: 'reel', body: 'Kizomba practice', media: [{ id: v.id, url: v.url, kind: 'video' }], ...extra });
  if (r.status !== 201) throw new Error(`reel failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.post as { id: string; highlights?: { atMs: number; label: string }[]; viewer: any };
}

const comment = (u: TestUser, postId: string, body: string, extra: Record<string, unknown> = {}) =>
  as(t.app, u).post(`/v1/posts/${postId}/comments`, { body, ...extra });
const moments = (u: TestUser | null, postId: string) => as(t.app, u).get(`/v1/posts/${postId}/moment-comments`);

describe('moment comments', () => {
  it('anchors top-level comments on reels to a time within the video', async () => {
    const creator = await adult();
    const fan = await adult();
    const reel = await reelBy(creator);

    const at = await comment(fan, reel.id, 'This turn is so clean', { atMs: 5200 });
    expect(at.status).toBe(201);
    expect(at.body.comment.atMs).toBe(5200);
    const plain = (await comment(fan, reel.id, 'Great music')).body.comment;
    expect(plain.atMs).toBeUndefined();

    // Past the end, negative or not a whole number: refused.
    expect((await comment(fan, reel.id, 'Too late', { atMs: 12_000 })).status).toBe(400);
    expect((await comment(fan, reel.id, 'Before it starts', { atMs: -1 })).status).toBe(400);
    expect((await comment(fan, reel.id, 'Half a millisecond', { atMs: 10.5 })).status).toBe(400);
    // Replies stay with their comment.
    expect((await comment(creator, reel.id, 'Thanks', { parentId: at.body.comment.id, atMs: 3000 })).status).toBe(400);
    expect((await comment(creator, reel.id, 'Thanks', { parentId: at.body.comment.id })).status).toBe(201);

    // The comment list carries the time; the moments list has only anchored comments, in time order.
    await comment(creator, reel.id, 'Here is where it starts', { atMs: 1000 });
    const list = (await as(t.app, fan).get(`/v1/posts/${reel.id}/comments?sort=newest`)).body.items;
    expect(list.find((c: any) => c.id === at.body.comment.id).atMs).toBe(5200);
    const m = await moments(fan, reel.id);
    expect(m.status).toBe(200);
    expect(m.body.items.map((x: any) => x.atMs)).toEqual([1000, 5200]);
    expect(m.body.items[1]).toMatchObject({ id: at.body.comment.id, body: 'This turn is so clean', author: { id: fan.id } });
    expect(m.body.items.some((x: any) => x.id === plain.id)).toBe(false);
  });

  it('is only for reels', async () => {
    const author = await adult();
    const fan = await adult();
    const post = (await as(t.app, author).post('/v1/posts', { body: 'Just words' })).body.post;
    expect((await comment(fan, post.id, 'At a moment', { atMs: 1000 })).status).toBe(400);
    expect((await comment(fan, post.id, 'No moment')).status).toBe(201);
    expect((await moments(fan, post.id)).status).toBe(404);
  });

  it('accepts any time up to the longest reel while the length is unknown', async () => {
    const creator = await adult();
    const fan = await adult();
    const reel = await reelBy(creator, {}, null);
    expect((await comment(fan, reel.id, 'Late in the video', { atMs: 90_000 })).status).toBe(201);
    expect((await comment(fan, reel.id, 'Beyond any reel', { atMs: 600_001 })).status).toBe(400);
  });

  it('follows the reel’s visibility, blocks and hidden words', async () => {
    const creator = await adult();
    const follower = await adult();
    const outsider = await adult();
    const troll = await adult();
    await as(t.app, follower).post(`/v1/users/${creator.id}/follow`);
    await as(t.app, troll).post(`/v1/users/${creator.id}/follow`);
    const reel = await reelBy(creator, { visibility: 'followers' });

    expect((await comment(follower, reel.id, 'Nice spin', { atMs: 2000 })).status).toBe(201);
    // Someone who can't see the reel can't read or add moments.
    expect((await moments(outsider, reel.id)).status).toBe(404);
    expect((await moments(null, reel.id)).status).toBe(404);
    expect((await comment(outsider, reel.id, 'Hello', { atMs: 1000 })).status).toBe(404);

    // Blocked: the follower no longer sees the troll's moment.
    const trollMoment = (await comment(troll, reel.id, 'Meh', { atMs: 4000 })).body.comment;
    expect((await moments(follower, reel.id)).body.items.map((x: any) => x.id)).toContain(trollMoment.id);
    await as(t.app, follower).post(`/v1/users/${troll.id}/block`);
    expect((await moments(follower, reel.id)).body.items.map((x: any) => x.id)).not.toContain(trollMoment.id);

    // Hidden words: hidden from everyone but its writer.
    await as(t.app, creator).put('/v1/me/hidden-words', { words: ['spoiler'] });
    const hidden = (await comment(follower, reel.id, 'Spoiler at the end', { atMs: 8000 })).body.comment;
    expect((await moments(creator, reel.id)).body.items.map((x: any) => x.id)).not.toContain(hidden.id);
    expect((await moments(follower, reel.id)).body.items.map((x: any) => x.id)).toContain(hidden.id);
  });
});

describe('highlights', () => {
  it('lets the creator mark up to five named points, in time order, within the video', async () => {
    const creator = await adult();
    const fan = await adult();
    const reel = await reelBy(creator, {
      highlights: [
        { atMs: 8000, label: 'The dip' },
        { atMs: 2000, label: 'First step' },
      ],
    });
    expect(reel.highlights).toEqual([
      { atMs: 2000, label: 'First step' },
      { atMs: 8000, label: 'The dip' },
    ]);
    expect((await as(t.app, fan).get(`/v1/posts/${reel.id}`)).body.post.highlights).toHaveLength(2);

    // Change them later.
    const next = [
      { atMs: 0, label: 'Intro' },
      { atMs: 4000, label: 'Turn' },
    ];
    const put = await as(t.app, creator).put(`/v1/posts/${reel.id}/highlights`, { highlights: next });
    expect(put.status).toBe(200);
    expect(put.body.highlights).toEqual(next);
    expect((await as(t.app, fan).get(`/v1/posts/${reel.id}`)).body.post.highlights).toEqual(next);

    // Only the creator; at most five; a second apart; within the video; a name for each.
    expect((await as(t.app, fan).put(`/v1/posts/${reel.id}/highlights`, { highlights: next })).status).toBe(403);
    const six = Array.from({ length: 6 }, (_, i) => ({ atMs: i * 1500, label: `Part ${i + 1}` }));
    expect((await as(t.app, creator).put(`/v1/posts/${reel.id}/highlights`, { highlights: six })).status).toBe(400);
    const close = [
      { atMs: 1000, label: 'A' },
      { atMs: 1500, label: 'B' },
    ];
    expect((await as(t.app, creator).put(`/v1/posts/${reel.id}/highlights`, { highlights: close })).status).toBe(400);
    expect((await as(t.app, creator).put(`/v1/posts/${reel.id}/highlights`, { highlights: [{ atMs: 12_000, label: 'End' }] })).status).toBe(400);
    expect((await as(t.app, creator).put(`/v1/posts/${reel.id}/highlights`, { highlights: [{ atMs: 1000, label: '  ' }] })).status).toBe(400);

    // An empty list removes them.
    expect((await as(t.app, creator).put(`/v1/posts/${reel.id}/highlights`, { highlights: [] })).status).toBe(200);
    expect((await as(t.app, fan).get(`/v1/posts/${reel.id}`)).body.post.highlights).toBeUndefined();
  });

  it('is only for reels', async () => {
    const author = await adult();
    const res = await as(t.app, author).post('/v1/posts', { body: 'Words', highlights: [{ atMs: 0, label: 'Start' }] });
    expect(res.status).toBe(400);
    const post = (await as(t.app, author).post('/v1/posts', { body: 'Words' })).body.post;
    expect((await as(t.app, author).put(`/v1/posts/${post.id}/highlights`, { highlights: [] })).status).toBe(404);
    // A reel's highlights past its end are refused when it's posted.
    const v = await video(author, 5000);
    const late = await as(t.app, author).post('/v1/posts', {
      format: 'reel',
      media: [{ id: v.id, url: v.url, kind: 'video' }],
      highlights: [{ atMs: 6000, label: 'Later' }],
    });
    expect(late.status).toBe(400);
  });
});

describe('continue where I left off', () => {
  it('keeps each viewer’s own position mid-way and clears it at the start or the end', async () => {
    const creator = await adult();
    const fan = await adult();
    const other = await adult();
    const reel = await reelBy(creator);
    const get = async (u: TestUser) => (await as(t.app, u).get(`/v1/posts/${reel.id}`)).body.post.viewer.resumeMs;

    expect(await get(fan)).toBeUndefined();
    expect((await as(t.app, fan).put(`/v1/posts/${reel.id}/resume`, { positionMs: 6400 })).body).toEqual({ resumeMs: 6400 });
    expect(await get(fan)).toBe(6400);
    // Per person.
    expect(await get(other)).toBeUndefined();
    // Also in the reels feed.
    const feed = (await as(t.app, fan).get('/v1/reels?limit=20')).body.items;
    expect(feed.find((p: any) => p.id === reel.id)?.viewer.resumeMs).toBe(6400);

    // Barely started or nearly done: nothing to resume.
    expect((await as(t.app, fan).put(`/v1/posts/${reel.id}/resume`, { positionMs: 1500 })).body).toEqual({ resumeMs: null });
    expect(await get(fan)).toBeUndefined();
    await as(t.app, fan).put(`/v1/posts/${reel.id}/resume`, { positionMs: 7000 });
    expect((await as(t.app, fan).put(`/v1/posts/${reel.id}/resume`, { positionMs: 11_000 })).body).toEqual({ resumeMs: null });
    expect(await get(fan)).toBeUndefined();

    // Past the end, or not a number: refused.
    expect((await as(t.app, fan).put(`/v1/posts/${reel.id}/resume`, { positionMs: 13_000 })).status).toBe(400);
    expect((await as(t.app, fan).put(`/v1/posts/${reel.id}/resume`, { positionMs: 'soon' })).status).toBe(400);

    // Start over.
    await as(t.app, fan).put(`/v1/posts/${reel.id}/resume`, { positionMs: 5000 });
    expect((await as(t.app, fan).del(`/v1/posts/${reel.id}/resume`)).status).toBe(200);
    expect(await get(fan)).toBeUndefined();
  });

  it('uses the length the player saw while the server has none, and only for reels the viewer can see', async () => {
    const creator = await adult();
    const fan = await adult();
    const outsider = await adult();
    const unknown = await reelBy(creator, {}, null);
    expect((await as(t.app, fan).put(`/v1/posts/${unknown.id}/resume`, { positionMs: 9000, durationMs: 10_000 })).body).toEqual({ resumeMs: null });
    expect((await as(t.app, fan).put(`/v1/posts/${unknown.id}/resume`, { positionMs: 4000, durationMs: 10_000 })).body).toEqual({ resumeMs: 4000 });
    expect((await as(t.app, fan).put(`/v1/posts/${unknown.id}/resume`, { positionMs: 30_000 })).body).toEqual({ resumeMs: 30_000 });

    const hidden = await reelBy(creator, { visibility: 'private' });
    expect((await as(t.app, outsider).put(`/v1/posts/${hidden.id}/resume`, { positionMs: 4000 })).status).toBe(404);
    const post = (await as(t.app, creator).post('/v1/posts', { body: 'Words' })).body.post;
    expect((await as(t.app, fan).put(`/v1/posts/${post.id}/resume`, { positionMs: 4000 })).status).toBe(404);
    expect((await as(t.app, null).put(`/v1/posts/${unknown.id}/resume`, { positionMs: 4000 })).status).toBe(401);
  });
});
