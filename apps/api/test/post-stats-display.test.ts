import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { as, followAccepted, signUp, testApp, type TestUser } from './helpers.ts';
import type { BuiltApp } from '../src/app.ts';
import { resetRisingCutoff, RISING } from '../src/lib/rising.ts';

/**
 * The numbers under posts, reels and stories (docs/product/post-stats.md): views, likes,
 * comments, reposts and shares in every post; hiding like and view counts; Rising; milestones;
 * "Liked by". Other test files share the database, so each test makes its own people and posts.
 */
let t: BuiltApp;
beforeAll(async () => {
  t = await testApp();
});
afterAll(() => t.close());

const db = () => t.ctx.db;
const adult = () => signUp(t.app);
const publish = async (u: TestUser, body: string, extra: Record<string, unknown> = {}) => {
  const r = await as(t.app, u).post('/v1/posts', { body, visibility: 'public', ...extra });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.post.id as string;
};
const read = async (u: TestUser | null, id: string) => {
  const r = await as(t.app, u).get(`/v1/posts/${id}`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.post;
};
const seen = (u: TestUser, postId: string, kind = 'impression', surface = 'for_you') =>
  as(t.app, u).post('/v1/feed/events', { events: [{ postId, surface, kind }] });
const milestones = async (u: TestUser, postId: string) =>
  (await as(t.app, u).get('/v1/notifications')).body.items.filter((n: any) => n.type === 'post_milestone' && n.entityId === postId);

describe('the numbers in a post', () => {
  it('come with every post: views, likes, comments, reposts and shares', async () => {
    const author = await adult();
    const fan = await adult();
    const id = await publish(author, 'Counted');
    expect((await read(fan, id)).counts).toMatchObject({ likes: 0, comments: 0, reposts: 0, views: 0, shares: 0 });
    await as(t.app, fan).put(`/v1/posts/${id}/reaction`, { kind: 'like' });
    await as(t.app, fan).post(`/v1/posts/${id}/comments`, { body: 'Nice' });
    await as(t.app, fan).put(`/v1/posts/${id}/repost`);
    await seen(fan, id);
    const post = await read(author, id);
    expect(post.counts).toMatchObject({ likes: 1, comments: 1, reposts: 1, views: 1, shares: 0 });
    expect(post.countsHidden).toBeUndefined();
    // Feeds carry them too.
    const profile = await as(t.app, fan).get(`/v1/users/${author.username}/posts`);
    expect(profile.body.items.find((p: any) => p.id === id).counts).toMatchObject({ likes: 1, views: 1, shares: 0 });
  });

  it('count views as different people other than the author, each once, from a feed or a watch', async () => {
    const author = await adult();
    const [a, b] = [await adult(), await adult()];
    const id = await publish(author, 'Viewed');
    // The author looking at their own post isn't a view.
    await seen(author, id);
    await as(t.app, author).post(`/v1/posts/${id}/view`);
    expect((await read(author, id)).counts.views).toBe(0);
    // Seen in two feeds, opened, and seen again later: one person, one view.
    await seen(a, id, 'impression', 'for_you');
    await seen(a, id, 'impression', 'profile');
    expect((await as(t.app, a).post(`/v1/posts/${id}/view`)).body).toEqual({ views: 1 });
    await seen(a, id);
    expect((await read(author, id)).counts.views).toBe(1);
    // A second person is a second view.
    await as(t.app, b).post(`/v1/posts/${id}/view`);
    expect((await read(author, id)).counts.views).toBe(2);
    // Raw impressions are something else (post_stats), counted for ranking.
    const stats = (await db().query(`SELECT impressions, viewers FROM post_stats WHERE post_id = $1`, [id])).rows[0];
    expect(stats.impressions).toBeGreaterThanOrEqual(2);
  });
});

describe('hiding like and view counts', () => {
  it('per post: others get neither number, the author still does', async () => {
    const author = await adult();
    const fan = await adult();
    const id = await publish(author, 'Quiet numbers');
    await as(t.app, fan).put(`/v1/posts/${id}/reaction`, { kind: 'like' });
    await seen(fan, id);
    // Only the author can change it.
    expect((await as(t.app, fan).put(`/v1/posts/${id}/counts`, { hidden: true })).status).toBe(404);
    expect((await as(t.app, author).put(`/v1/posts/${id}/counts`, { hidden: true })).body).toEqual({ countsHidden: true });

    const theirs = await read(fan, id);
    expect(theirs.counts.likes).toBeUndefined();
    expect(theirs.counts.views).toBeUndefined();
    expect(theirs.counts).toMatchObject({ comments: 0, reposts: 0, shares: 0 });
    expect(theirs.countsHidden).toBe(true);
    expect(theirs.viewer.liked).toBe(true);
    const mine = await read(author, id);
    expect(mine.counts).toMatchObject({ likes: 1, views: 1 });
    expect(mine.countsHidden).toBe(true);
    // Liking, unliking and viewing don't give the number away either, nor does the link preview.
    const other = await adult();
    expect((await as(t.app, other).put(`/v1/posts/${id}/reaction`, { kind: 'like' })).body).toEqual({ liked: true });
    expect((await as(t.app, other).post(`/v1/posts/${id}/view`)).body).toEqual({});
    expect((await as(t.app, null).get(`/v1/public/posts/${id}`)).body.post.counts.likes).toBeUndefined();
    expect((await as(t.app, author).put(`/v1/posts/${id}/reaction`, { kind: 'like' })).body).toEqual({ liked: true, likes: 3 });

    await as(t.app, author).put(`/v1/posts/${id}/counts`, { hidden: false });
    const shown = await read(fan, id);
    expect(shown.counts).toMatchObject({ likes: 3, views: 2 });
    expect(shown.countsHidden).toBeUndefined();
  });

  it('as the account default, which each post can override, and when posting', async () => {
    const author = await adult();
    const fan = await adult();
    const before = await publish(author, 'Posted before the setting');
    expect((await as(t.app, author).get('/v1/me/sharing')).body.settings.hideCounts).toBe(false);
    expect((await as(t.app, author).put('/v1/me/sharing', { hideCounts: true })).body.settings.hideCounts).toBe(true);
    // Every post follows the account, the older ones too.
    expect((await read(fan, before)).counts.likes).toBeUndefined();
    const after = await publish(author, 'Posted after');
    expect((await read(fan, after)).counts.views).toBeUndefined();
    expect((await read(author, after)).counts).toMatchObject({ likes: 0, views: 0 });
    // A post shown on purpose stays shown.
    await as(t.app, author).put(`/v1/posts/${before}/counts`, { hidden: false });
    expect((await read(fan, before)).counts.likes).toBe(0);
    // Chosen in the composer.
    const shownOne = await publish(author, 'Shown from the composer', { hideCounts: false });
    expect((await read(fan, shownOne)).counts.likes).toBe(0);
    await as(t.app, author).put('/v1/me/sharing', { hideCounts: false });
    const hiddenOne = await publish(author, 'Hidden from the composer', { hideCounts: true });
    expect((await read(fan, hiddenOne)).counts.likes).toBeUndefined();
    expect((await read(fan, after)).counts.likes).toBe(0);
  });

  it('applies to story likes; replies and shares stay the owner’s', async () => {
    const author = await adult();
    const fan = await adult();
    await followAccepted(t.app, fan, author);
    const story = (await as(t.app, author).post('/v1/moments', { body: 'A story', visibility: 'followers' })).body.moment;
    await as(t.app, fan).put(`/v1/moments/${story.id}/like`, { liked: true });
    await as(t.app, fan).post(`/v1/moments/${story.id}/reply`, { body: 'Lovely' });
    const mine = (await as(t.app, author).get(`/v1/moments/${story.id}`)).body.group.moments[0];
    expect(mine).toMatchObject({ likes: 1, replies: 1, shares: 0 });
    const theirs = (await as(t.app, fan).get(`/v1/moments/${story.id}`)).body.group.moments[0];
    expect(theirs.likes).toBe(1);
    expect(theirs.replies).toBeUndefined();
    expect(theirs.views).toBeUndefined();
    await as(t.app, author).put('/v1/me/sharing', { hideCounts: true });
    expect((await as(t.app, fan).get(`/v1/moments/${story.id}`)).body.group.moments[0].likes).toBeUndefined();
    expect((await as(t.app, author).get(`/v1/moments/${story.id}`)).body.group.moments[0].likes).toBe(1);
  });
});

describe('shares', () => {
  it('count the share sheet and a copied link (feed events), never the author’s own, and not reposts', async () => {
    const author = await adult();
    const fan = await adult();
    const id = await publish(author, 'Share me');
    await seen(author, id, 'share');
    expect((await read(author, id)).counts.shares).toBe(0);
    // The share sheet (reels surface), then a copied link (a post page): two shares.
    await seen(fan, id, 'share', 'reels');
    await seen(fan, id, 'share', 'other');
    // The same again within half an hour counts once.
    await seen(fan, id, 'share', 'other');
    await as(t.app, fan).put(`/v1/posts/${id}/repost`);
    const post = await read(author, id);
    expect(post.counts.shares).toBe(2);
    expect(post.counts.reposts).toBe(1);
  });

  it('count a post sent into a chat, with its link, once per person in half an hour', async () => {
    const author = await adult();
    const fan = await adult();
    const friend = await adult();
    const id = await publish(author, 'Send me');
    expect((await as(t.app, fan).post(`/v1/posts/${id}/send`, {})).status).toBe(400);
    const r = await as(t.app, fan).post(`/v1/posts/${id}/send`, { userIds: [friend.id], body: 'Look' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.conversationIds).toHaveLength(1);
    const messages = (await as(t.app, friend).get(`/v1/conversations/${r.body.conversationIds[0]}/messages`)).body.items;
    expect(messages.map((m: any) => m.body)).toContainEqual(expect.stringMatching(new RegExp(`^Look\\n.*/p/${id}$`)));
    expect((await read(author, id)).counts.shares).toBe(1);
    await as(t.app, fan).post(`/v1/posts/${id}/send`, { conversationIds: r.body.conversationIds });
    expect((await read(author, id)).counts.shares).toBe(1);
    // The author sending their own post isn't a share.
    await as(t.app, author).post(`/v1/posts/${id}/send`, { userIds: [friend.id] });
    expect((await read(author, id)).counts.shares).toBe(1);
    // A post you can't see can't be sent.
    const hidden = await publish(author, 'Only me', { visibility: 'private' });
    expect((await as(t.app, fan).post(`/v1/posts/${hidden}/send`, { userIds: [friend.id] })).status).toBe(404);
  });
});

describe('Rising', () => {
  it('marks a fast-growing post with enough viewers, and not a quiet one', async () => {
    const author = await adult();
    const fan = await adult();
    const fast = await publish(author, 'Taking off');
    const quiet = await publish(author, 'Quiet one');
    const few = await publish(author, 'Fast but barely seen');
    // Momentum far above everything else in the last 48 hours, for two of them; enough viewers for one.
    await db().query(
      `INSERT INTO post_stats (post_id, trend, trend_at) VALUES ($1, 100000, now()), ($2, 100000, now()) ON CONFLICT (post_id) DO UPDATE SET trend = 100000, trend_at = now()`,
      [fast, few],
    );
    await db().query(`UPDATE posts SET view_count = $2 WHERE id = $1`, [fast, RISING.minViewers]);
    await db().query(`UPDATE posts SET view_count = $2 WHERE id = $1`, [quiet, RISING.minViewers * 5]);
    resetRisingCutoff();
    expect((await read(fan, fast)).rising).toBe(true);
    expect((await read(fan, quiet)).rising).toBeUndefined();
    expect((await read(fan, few)).rising).toBeUndefined();
    // Other files share the database: momentum this high would top their feeds and the cut-off.
    await db().query(`UPDATE post_stats SET trend = 0 WHERE post_id = ANY($1::uuid[])`, [[fast, few]]);
    await db().query(`DELETE FROM posts WHERE id = ANY($1::uuid[])`, [[fast, quiet, few]]);
    resetRisingCutoff();
  });
});

describe('milestones', () => {
  it('tell the author once when views pass 100', async () => {
    const author = await adult();
    const id = await publish(author, 'Almost there');
    await db().query(`UPDATE posts SET view_count = 99 WHERE id = $1`, [id]);
    await as(t.app, await adult()).post(`/v1/posts/${id}/view`);
    let notes = await milestones(author, id);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ category: 'milestones', entityType: 'post', actor: null, data: { metric: 'views', threshold: 100, format: 'post' } });
    // More views (from a feed too) don't tell again.
    await seen(await adult(), id);
    await as(t.app, await adult()).post(`/v1/posts/${id}/view`);
    notes = await milestones(author, id);
    expect(notes).toHaveLength(1);
  });

  it('tell the author once when likes pass 100, even after an unlike and a new like', async () => {
    const author = await adult();
    const id = await publish(author, 'Liked a lot');
    await db().query(`UPDATE posts SET like_count = 99 WHERE id = $1`, [id]);
    const fan = await adult();
    await as(t.app, fan).put(`/v1/posts/${id}/reaction`, { kind: 'like' });
    await as(t.app, fan).del(`/v1/posts/${id}/reaction`);
    await as(t.app, fan).put(`/v1/posts/${id}/reaction`, { kind: 'like' });
    const notes = await milestones(author, id);
    expect(notes).toHaveLength(1);
    expect(notes[0].data).toEqual({ metric: 'likes', threshold: 100, format: 'post' });
    expect((await db().query(`SELECT metric, threshold FROM post_milestones WHERE post_id = $1`, [id])).rows).toEqual([{ metric: 'likes', threshold: 100 }]);
  });

  it('respect the Milestones setting', async () => {
    const author = await adult();
    expect((await as(t.app, author).get('/v1/me/preferences')).body.notifications.milestones).toBe(true);
    await as(t.app, author).put('/v1/me/preferences/notifications', { categories: { milestones: false } });
    expect((await as(t.app, author).get('/v1/me/preferences')).body.notifications.milestones).toBe(false);
    const id = await publish(author, 'Nobody tells me');
    await db().query(`UPDATE posts SET view_count = 99 WHERE id = $1`, [id]);
    await as(t.app, await adult()).post(`/v1/posts/${id}/view`);
    expect(await milestones(author, id)).toHaveLength(0);
    // It still counts as passed: turning them on later doesn't tell about this one.
    await as(t.app, author).put('/v1/me/preferences/notifications', { categories: { milestones: true } });
    await as(t.app, await adult()).post(`/v1/posts/${id}/view`);
    expect(await milestones(author, id)).toHaveLength(0);
  });
});

describe('liked by', () => {
  it('names someone the viewer follows, and never someone blocked or a private account they don’t follow', async () => {
    const author = await adult();
    const viewer = await adult();
    const [amara, blocked, hidden, stranger] = [await adult(), await adult(), await adult(), await adult()];
    await followAccepted(t.app, viewer, amara);
    await followAccepted(t.app, viewer, blocked);
    // A private account the viewer is friends with but doesn't follow.
    await as(t.app, hidden).patch('/v1/me/profile', { isPrivate: true });
    const [x, y] = [viewer.id, hidden.id].sort();
    await db().query(`INSERT INTO friendships (user_a, user_b) VALUES ($1, $2)`, [x, y]);
    const id = await publish(author, 'Who liked it');
    for (const u of [amara, stranger]) await as(t.app, u).put(`/v1/posts/${id}/reaction`, { kind: 'like' });
    expect((await read(viewer, id)).likedBy).toMatchObject({ user: { id: amara.id }, others: 1 });
    // Newer likes from people who can't be named don't take Amara's place.
    for (const u of [blocked, hidden]) await as(t.app, u).put(`/v1/posts/${id}/reaction`, { kind: 'like' });
    await as(t.app, viewer).post(`/v1/users/${blocked.id}/block`);
    expect((await read(viewer, id)).likedBy).toMatchObject({ user: { id: amara.id }, others: 3 });
    // Nobody the viewer knows: no line. Signed out: no line.
    expect((await read(stranger, id)).likedBy).toBeUndefined();
    expect((await read(null, id)).likedBy).toBeUndefined();
    // When the author hides like counts, the line goes too.
    await as(t.app, author).put(`/v1/posts/${id}/counts`, { hidden: true });
    expect((await read(viewer, id)).likedBy).toBeUndefined();
  });
});
