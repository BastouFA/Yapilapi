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

describe('reposts', () => {
  it('shares public posts with your followers at the time you repost', async () => {
    const author = await signUp(t.app, { birthDate: '1990-01-01', displayName: 'Author' });
    const sharer = await signUp(t.app, { birthDate: '1990-01-01', displayName: 'Sharer' });
    const follower = await signUp(t.app, { birthDate: '1990-01-01' });
    await as(t.app, follower).post(`/v1/users/${sharer.id}/follow`);
    const post = (await as(t.app, author).post('/v1/posts', { body: 'Worth sharing' })).body.post;
    const privatePost = (await as(t.app, author).post('/v1/posts', { body: 'Friends only', visibility: 'friends' })).body.post;

    expect((await as(t.app, author).put(`/v1/posts/${post.id}/repost`)).status).toBe(400); // your own
    expect((await as(t.app, sharer).put(`/v1/posts/${privatePost.id}/repost`)).status).toBe(404); // can't even see it
    const r = await as(t.app, sharer).put(`/v1/posts/${post.id}/repost`);
    expect(r.body).toEqual({ reposted: true, reposts: 1 });
    expect((await as(t.app, sharer).put(`/v1/posts/${post.id}/repost`)).body.reposts).toBe(1); // idempotent

    // The follower doesn't follow the author, but sees the repost, labelled.
    const feed = (await as(t.app, follower).get('/v1/feed?mode=following')).body.items;
    const item = feed.find((p: any) => p.id === post.id);
    expect(item).toMatchObject({ reason: 'Sharer reposted', counts: { reposts: 1 } });
    expect((await as(t.app, sharer).get(`/v1/posts/${post.id}`)).body.post.viewer.reposted).toBe(true);
    expect((await as(t.app, follower).get(`/v1/users/${sharer.id}/reposts`)).body.items.map((p: any) => p.id)).toEqual([post.id]);
    expect((await t.ctx.db.query(`SELECT 1 FROM notifications WHERE user_id = $1 AND type = 'post_repost'`, [author.id])).rowCount).toBe(1);

    expect((await as(t.app, sharer).del(`/v1/posts/${post.id}/repost`)).body).toEqual({ reposted: false, reposts: 0 });
    const after = (await as(t.app, follower).get('/v1/feed?mode=following')).body.items;
    expect(after.some((p: any) => p.id === post.id)).toBe(false);
  });

  it('gives each reel author a follower count and whether you follow them', async () => {
    const creator = await signUp(t.app, { birthDate: '1990-01-01' });
    const fan = await signUp(t.app, { birthDate: '1990-01-01' });
    await as(t.app, fan).post(`/v1/users/${creator.id}/follow`);
    const v = await video(creator);
    await as(t.app, creator).post('/v1/posts', { format: 'reel', body: 'Hi', media: [{ id: v.id, url: v.url, kind: 'video' }] });
    const res = await as(t.app, fan).get('/v1/reels?limit=20');
    expect(res.body.authors[creator.id]).toEqual({ followers: 1, following: true });
  });
});

describe('follower lists', () => {
  it('keeps a private account’s lists to itself and approved followers, and says who you follow', async () => {
    const owner = await signUp(t.app, { birthDate: '1990-01-01' });
    const fan = await signUp(t.app, { birthDate: '1990-01-01' });
    const stranger = await signUp(t.app, { birthDate: '1990-01-01' });
    await as(t.app, fan).post(`/v1/users/${owner.id}/follow`);
    await as(t.app, stranger).post(`/v1/users/${fan.id}/follow`);

    const open = await as(t.app, stranger).get(`/v1/users/${owner.id}/followers`);
    expect(open.body.items.map((u: any) => u.id)).toEqual([fan.id]);
    expect(open.body.viewerFollows).toEqual([fan.id]);

    await t.ctx.db.query(`UPDATE profiles SET is_private = true WHERE user_id = $1`, [owner.id]);
    expect((await as(t.app, stranger).get(`/v1/users/${owner.id}/followers`)).status).toBe(403);
    expect((await as(t.app, stranger).get(`/v1/users/${owner.id}/following`)).status).toBe(403);
    expect((await as(t.app, fan).get(`/v1/users/${owner.id}/followers`)).status).toBe(200);
    expect((await as(t.app, owner).get(`/v1/users/${owner.id}/following`)).status).toBe(200);
  });
});

describe('views and pinned posts', () => {
  it('counts each viewer once and never the author', async () => {
    const creator = await signUp(t.app, { birthDate: '1990-01-01' });
    const fan = await signUp(t.app, { birthDate: '1990-01-01' });
    const v = await video(creator);
    const reel = (await as(t.app, creator).post('/v1/posts', { format: 'reel', media: [{ id: v.id, url: v.url, kind: 'video' }] })).body.post;
    expect((await as(t.app, fan).post(`/v1/posts/${reel.id}/view`)).body).toEqual({ views: 1 });
    expect((await as(t.app, fan).post(`/v1/posts/${reel.id}/view`)).body).toEqual({ views: 1 });
    expect((await as(t.app, creator).post(`/v1/posts/${reel.id}/view`)).body).toEqual({ views: 1 });
    expect((await as(t.app, fan).get(`/v1/posts/${reel.id}`)).body.post.counts.views).toBe(1);
    const hidden = (await as(t.app, creator).post('/v1/posts', { body: 'Just me', visibility: 'private' })).body.post;
    expect((await as(t.app, fan).post(`/v1/posts/${hidden.id}/view`)).status).toBe(404);
  });

  it('shows your pinned post first on your profile, once', async () => {
    const author = await signUp(t.app, { birthDate: '1990-01-01' });
    const other = await signUp(t.app, { birthDate: '1990-01-01' });
    const first = (await as(t.app, author).post('/v1/posts', { body: 'First' })).body.post;
    const second = (await as(t.app, author).post('/v1/posts', { body: 'Second' })).body.post;
    const third = (await as(t.app, author).post('/v1/posts', { body: 'Third' })).body.post;
    const theirs = (await as(t.app, other).post('/v1/posts', { body: 'Not yours' })).body.post;
    expect((await as(t.app, author).put('/v1/me/pinned-post', { postId: theirs.id })).status).toBe(404);
    await as(t.app, author).put('/v1/me/pinned-post', { postId: first.id });

    const p1 = (await as(t.app, other).get(`/v1/users/${author.username}/posts?limit=2`)).body;
    expect(p1.items.map((p: any) => [p.id, !!p.pinned])).toEqual([
      [first.id, true],
      [third.id, false],
      [second.id, false],
    ]);
    expect(p1.nextCursor).toBeNull();
    const p2 = (await as(t.app, other).get(`/v1/users/${author.username}/posts?limit=1`)).body;
    const rest = (await as(t.app, other).get(`/v1/users/${author.username}/posts?limit=1&cursor=${p2.nextCursor}`)).body;
    expect(rest.items.map((p: any) => p.id)).toEqual([second.id]); // the pinned post doesn't repeat

    await as(t.app, author).put('/v1/me/pinned-post', { postId: null });
    expect((await as(t.app, other).get(`/v1/users/${author.username}/posts`)).body.items.map((p: any) => p.id)).toEqual([third.id, second.id, first.id]);
  });
});

describe('profiles without an account', () => {
  it('hides under-18 accounts and the details of private ones', async () => {
    const teen = await signUp(t.app, { birthDate: new Date(Date.now() - 15 * 365.25 * 86_400_000).toISOString().slice(0, 10) });
    const adult = await signUp(t.app, { birthDate: '1990-01-01' });
    await as(t.app, adult).patch('/v1/me/profile', { bio: 'Hello there', isPrivate: true });
    expect((await as(t.app, null).get(`/v1/users/${teen.username}`)).status).toBe(404);
    expect((await as(t.app, adult).get(`/v1/users/${teen.username}`)).status).toBe(200);
    const anon = (await as(t.app, null).get(`/v1/users/${adult.username}`)).body.profile;
    expect(anon).toMatchObject({ username: adult.username, bio: '', isPrivate: true });
    expect((await as(t.app, teen).get(`/v1/users/${adult.username}`)).body.profile.bio).toBe('Hello there');
  });
});
