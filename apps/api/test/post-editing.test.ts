import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { as, signUp, testApp, type TestUser, jobRunner, type JobRunner } from './helpers.ts';
import type { BuiltApp } from '../src/app.ts';
import { PUBLISH_JOB, scheduledPostJobHandlers } from '../src/lib/publishing.ts';

let t: BuiltApp;
let runJobs: JobRunner;
beforeAll(async () => {
  t = await testApp();
  runJobs = await jobRunner(t.ctx.db);
});
afterAll(async () => {
  await t.close();
});

const adult = () => signUp(t.app, { birthDate: '1990-01-01' });
const inMinutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString();
const notes = async (userId: string, type: string, postId?: string) =>
  (
    await t.ctx.db.query(`SELECT 1 FROM notifications WHERE user_id = $1 AND type = $2 AND ($3::uuid IS NULL OR entity_id = $3)`, [
      userId,
      type,
      postId ?? null,
    ])
  ).rowCount;
/** Run the scheduled post job for one post as if its time had come. */
async function arrive(postId: string) {
  await t.ctx.db.query(`UPDATE posts SET scheduled_at = now() - interval '1 second' WHERE id = $1 AND status = 'scheduled'`, [postId]);
  await t.ctx.db.query(`UPDATE jobs SET run_at = now() - interval '1 second' WHERE kind = $1 AND payload->>'postId' = $2 AND status = 'queued'`, [
    PUBLISH_JOB,
    postId,
  ]);
  await runJobs(scheduledPostJobHandlers(t.ctx), 50);
}
const ids = (items: { id: string }[]) => items.map((p) => p.id);

describe('editing a post', () => {
  it('lets only the author change the text, visibility and photo descriptions, and keeps a history', async () => {
    const author = await adult();
    const other = await adult();
    const created = (
      await as(t.app, author).post('/v1/posts', {
        body: 'First try #alpha',
        topics: ['travel'],
        media: [{ url: 'https://cdn.example.test/a.jpg', kind: 'image', width: 800, height: 600 }],
      })
    ).body.post;
    expect(created.editedAt).toBeUndefined();
    const mediaId = created.media[0].id;

    expect((await as(t.app, null).patch(`/v1/posts/${created.id}`, { body: 'Hacked' })).status).toBe(401);
    expect((await as(t.app, other).patch(`/v1/posts/${created.id}`, { body: 'Hacked' })).status).toBe(403);
    expect((await as(t.app, other).patch(`/v1/posts/${created.id}`, { media: [{ id: mediaId, altText: 'Not mine' }] })).status).toBe(403);

    const edited = await as(t.app, author).patch(`/v1/posts/${created.id}`, {
      body: 'Second try #beta',
      visibility: 'followers',
      media: [{ id: mediaId, altText: 'A red bicycle against a wall' }],
    });
    expect(edited.status).toBe(200);
    expect(edited.body.post.body).toBe('Second try #beta');
    expect(edited.body.post.visibility).toBe('followers');
    expect(edited.body.post.media[0].altText).toBe('A red bicycle against a wall');
    expect(edited.body.post.editedAt).toEqual(expect.any(String));
    expect(edited.body.post.createdAt).toBe(created.createdAt);
    // Hashtags follow the text; chosen topics stay.
    expect(edited.body.post.topics).toEqual(['travel', 'beta']);
    // Only a new text counts as an edit: a description alone doesn't add to the history.
    await as(t.app, author).patch(`/v1/posts/${created.id}`, { media: [{ id: mediaId, altText: 'A red bicycle' }] });

    const history = (await as(t.app, author).get(`/v1/posts/${created.id}/history`)).body.items;
    expect(history.map((v: any) => [v.body, v.current])).toEqual([
      ['Second try #beta', true],
      ['First try #alpha', false],
    ]);
    expect(history[1].at).toBe(created.createdAt);
    // Only media of this post can be described through it.
    const elsewhere = (await as(t.app, author).post('/v1/posts', { body: 'x', media: [{ url: 'https://cdn.example.test/b.jpg', kind: 'image' }] })).body.post;
    expect((await as(t.app, author).patch(`/v1/posts/${created.id}`, { media: [{ id: elsewhere.media[0].id, altText: 'Nope' }] })).status).toBe(404);
  });

  it('updates tag pages from the new text', async () => {
    const author = await adult();
    const viewer = await adult();
    const before = `old${Date.now().toString(36)}`;
    const after = `new${Date.now().toString(36)}`;
    const post = (await as(t.app, author).post('/v1/posts', { body: `Hello #${before}` })).body.post;
    expect(ids((await as(t.app, viewer).get(`/v1/tags/${before}/posts`)).body.items)).toEqual([post.id]);
    await as(t.app, author).patch(`/v1/posts/${post.id}`, { body: `Hello #${after}` });
    expect((await as(t.app, viewer).get(`/v1/tags/${before}/posts`)).body.items).toEqual([]);
    expect(ids((await as(t.app, viewer).get(`/v1/tags/${after}/posts`)).body.items)).toEqual([post.id]);
    expect((await as(t.app, viewer).get(`/v1/tags/${after}`)).body.posts).toBe(1);
  });

  it('tells only people the edit newly mentions', async () => {
    const author = await adult();
    const ann = await adult();
    const ben = await adult();
    const post = (await as(t.app, author).post('/v1/posts', { body: `Lunch with @${ann.username}` })).body.post;
    expect(await notes(ann.id, 'post_mention', post.id)).toBe(1);

    await as(t.app, author).patch(`/v1/posts/${post.id}`, { body: `Lunch with @${ann.username} and @${ben.username}` });
    expect(await notes(ann.id, 'post_mention', post.id)).toBe(1);
    expect(await notes(ben.id, 'post_mention', post.id)).toBe(1);

    // Taken out and put back: already told once.
    await as(t.app, author).patch(`/v1/posts/${post.id}`, { body: `Lunch with @${ann.username}` });
    await as(t.app, author).patch(`/v1/posts/${post.id}`, { body: `Lunch with @${ben.username} again` });
    expect(await notes(ben.id, 'post_mention', post.id)).toBe(1);
  });

  it('shows the history only to people who can see the post', async () => {
    const author = await adult();
    const follower = await adult();
    const stranger = await adult();
    await as(t.app, follower).post(`/v1/users/${author.id}/follow`);
    const post = (await as(t.app, author).post('/v1/posts', { body: 'For followers', visibility: 'followers' })).body.post;
    await as(t.app, author).patch(`/v1/posts/${post.id}`, { body: 'For followers, edited' });

    expect((await as(t.app, follower).get(`/v1/posts/${post.id}/history`)).body.items).toHaveLength(2);
    expect((await as(t.app, stranger).get(`/v1/posts/${post.id}/history`)).status).toBe(404);
    expect((await as(t.app, null).get(`/v1/posts/${post.id}/history`)).status).toBe(404);
    // A stranger can't change it either, and isn't told whether it exists.
    expect((await as(t.app, stranger).patch(`/v1/posts/${post.id}`, { body: 'x' })).status).toBe(404);

    const pub = (await as(t.app, author).post('/v1/posts', { body: 'Public' })).body.post;
    expect((await as(t.app, null).get(`/v1/posts/${pub.id}/history`)).body.items).toEqual([{ body: 'Public', at: pub.createdAt, current: true }]);
    // Blocked people don't get it.
    await as(t.app, author).post(`/v1/users/${stranger.id}/block`);
    expect((await as(t.app, stranger).get(`/v1/posts/${pub.id}/history`)).status).toBe(404);
  });

  it('checks what an edit can change', async () => {
    const author = await adult();
    const post = (await as(t.app, author).post('/v1/posts', { body: 'Something' })).body.post;
    const edit = (b: unknown) => as(t.app, author).patch(`/v1/posts/${post.id}`, b);
    expect((await edit({})).status).toBe(400);
    expect((await edit({ body: 'x'.repeat(5001) })).status).toBe(400);
    expect((await edit({ body: '' })).status).toBe(400); // nothing left to show
    expect((await edit({ visibility: 'circle' })).status).toBe(400);
    expect((await edit({ visibility: 'subscribers' })).status).toBe(400); // no subscription plan
    expect(
      (
        await edit({
          media: [
            { id: post.id, altText: 'a' },
            { id: post.id, altText: 'b' },
          ],
        })
      ).status,
    ).toBe(400);
    expect((await edit({ body: 'you should hurt yourself' })).status).toBe(422);
    expect((await as(t.app, author).get(`/v1/posts/${post.id}`)).body.post.body).toBe('Something');

    // Held for review when flagged, and nobody is told about mentions meanwhile.
    const friend = await adult();
    const held = await edit({ body: `What an idiot, @${friend.username}` });
    expect(held.status).toBe(200);
    expect(held.body.moderation.status).toBe('review');
    expect(await notes(friend.id, 'post_mention', post.id)).toBe(0);

    // A limit on edits a day.
    await t.ctx.db.query(`INSERT INTO post_edits (post_id, body) SELECT $1, 'old ' || g FROM generate_series(1, 20) g`, [post.id]);
    const tooMany = await edit({ body: 'One more time' });
    expect(tooMany.status).toBe(429);
    expect(tooMany.body.error.code).toBe('slow_down');

    // Deleted posts and drafts aren't edited here.
    await as(t.app, author).del(`/v1/posts/${post.id}`);
    expect((await edit({ body: 'Back' })).status).toBe(404);
    const draft = (await as(t.app, author).post('/v1/posts', { body: 'Draft', draft: true })).body.post;
    expect((await as(t.app, author).patch(`/v1/posts/${draft.id}`, { body: 'x' })).status).toBe(404);
  });

  it('keeps reposts pointing at the edited post', async () => {
    const author = await adult();
    const fan = await adult();
    const follower = await adult();
    await as(t.app, follower).post(`/v1/users/${fan.id}/follow`);
    const post = (await as(t.app, author).post('/v1/posts', { body: 'Original' })).body.post;
    await as(t.app, fan).put(`/v1/posts/${post.id}/repost`);
    await as(t.app, author).patch(`/v1/posts/${post.id}`, { body: 'Original, fixed a typo' });
    const feed = (await as(t.app, follower).get('/v1/feed?mode=following')).body.items;
    const shared = feed.find((p: any) => p.id === post.id);
    expect(shared).toMatchObject({ body: 'Original, fixed a typo', reason: expect.stringContaining('reposted') });
    expect(shared.editedAt).toEqual(expect.any(String));
  });
});

describe('drafts and scheduled posts', () => {
  async function everywhere(viewer: TestUser | null, author: TestUser, tag: string, word: string) {
    const v = as(t.app, viewer);
    const lists = [
      (await v.get(`/v1/users/${author.username}/posts`)).body.items,
      (await v.get(`/v1/tags/${tag}/posts`)).body.items,
      (await v.get(`/v1/tags/${tag}/posts?sort=top`)).body.items,
      (await v.get(`/v1/search?q=${word}&type=posts`)).body.results.posts ?? [],
    ];
    if (viewer) for (const mode of ['for_you', 'following', 'friends']) lists.push((await v.get(`/v1/feed?mode=${mode}`)).body.items);
    return lists.flatMap(ids);
  }

  it('keeps drafts and scheduled posts out of every listing, count and notification', async () => {
    const author = await adult();
    const follower = await adult();
    const mentioned = await adult();
    await as(t.app, follower).post(`/v1/users/${author.id}/follow`);
    await as(t.app, author).post(`/v1/users/${follower.id}/follow`);
    const tag = `hush${Date.now().toString(36)}`;
    const word = `zebra${Date.now().toString(36)}`;
    const draft = await as(t.app, author).post('/v1/posts', { body: `Draft ${word} #${tag} @${mentioned.username}`, draft: true });
    expect(draft.status).toBe(201);
    expect(draft.body.post).toMatchObject({ status: 'draft', scheduledAt: null });
    const later = await as(t.app, author).post('/v1/posts', { body: `Later ${word} #${tag} @${mentioned.username}`, scheduledAt: inMinutes(30) });
    expect(later.status).toBe(201);
    expect(later.body.post).toMatchObject({ status: 'scheduled', scheduledAt: expect.any(String) });
    const hidden = [draft.body.post.id, later.body.post.id];

    for (const viewer of [author, follower, mentioned, null]) {
      const seen = await everywhere(viewer, author, tag, word);
      expect(seen.filter((id) => hidden.includes(id))).toEqual([]);
    }
    for (const id of hidden) {
      for (const viewer of [author, follower, null]) expect((await as(t.app, viewer).get(`/v1/posts/${id}`)).status).toBe(404);
      expect((await as(t.app, null).get(`/v1/public/posts/${id}`)).status).toBe(404);
      expect((await as(t.app, follower).put(`/v1/posts/${id}/reaction`, { kind: 'like' })).status).toBe(404);
      expect((await as(t.app, follower).post(`/v1/posts/${id}/comments`, { body: 'Hi' })).status).toBe(404);
      expect((await as(t.app, follower).get(`/v1/posts/${id}/history`)).status).toBe(404);
      expect((await as(t.app, follower).post('/v1/reports', { targetType: 'post', targetId: id, reason: 'spam' })).status).toBe(404);
      expect((await as(t.app, author).put('/v1/me/pinned-post', { postId: id })).status).toBe(404);
    }
    const tagPage = (await as(t.app, follower).get(`/v1/tags/${tag}`)).body;
    expect(tagPage).toMatchObject({ posts: 0, people: 0 });
    expect(Number((await as(t.app, follower).get(`/v1/users/${author.username}`)).body.profile.counts.posts)).toBe(0);
    expect(Number((await as(t.app, author).get(`/v1/users/${author.username}`)).body.profile.counts.posts)).toBe(0);
    expect((await as(t.app, null).get(`/v1/public/users/${author.username}`)).body.profile.counts.posts).toBe(0);
    expect((await as(t.app, null).get('/v1/trending?limit=30')).body.items.map((x: any) => x.tag)).not.toContain(tag);
    expect(await notes(mentioned.id, 'post_mention')).toBe(0);

    // Only the author lists and opens them.
    expect(ids((await as(t.app, author).get('/v1/me/drafts')).body.items)).toEqual([later.body.post.id, draft.body.post.id]);
    expect((await as(t.app, follower).get('/v1/me/drafts')).body.items).toEqual([]);
    expect((await as(t.app, null).get('/v1/me/drafts')).status).toBe(401);
    for (const id of hidden) {
      expect((await as(t.app, follower).get(`/v1/drafts/${id}`)).status).toBe(404);
      expect((await as(t.app, follower).put(`/v1/drafts/${id}`, { body: 'Mine now' })).status).toBe(404);
      expect((await as(t.app, follower).post(`/v1/drafts/${id}/publish`)).status).toBe(404);
      expect((await as(t.app, follower).put(`/v1/drafts/${id}/schedule`, { scheduledAt: inMinutes(20) })).status).toBe(404);
      expect((await as(t.app, follower).del(`/v1/drafts/${id}`)).status).toBe(404);
    }
    expect((await as(t.app, author).get(`/v1/drafts/${draft.body.post.id}`)).body.post.body).toContain('Draft');
  });

  it('saves a draft again, then publishes it as a new post that tells the people it mentions', async () => {
    const author = await adult();
    const follower = await adult();
    const friend = await adult();
    await as(t.app, follower).post(`/v1/users/${author.id}/follow`);
    const draft = (
      await as(t.app, author).post('/v1/posts', {
        body: 'Work in progress',
        draft: true,
        media: [{ url: 'https://cdn.example.test/c.jpg', kind: 'image', altText: 'A harbour at dawn' }],
      })
    ).body.post;
    expect(draft.media[0].altText).toBe('A harbour at dawn');
    const saved = await as(t.app, author).put(`/v1/drafts/${draft.id}`, {
      body: `Ready now with @${friend.username} #launch`,
      media: [{ id: draft.media[0].id, url: draft.media[0].url, kind: 'image', altText: 'A harbour at sunrise' }],
      poll: { options: ['Yes', 'No'] },
    });
    expect(saved.status).toBe(200);
    expect(saved.body.post).toMatchObject({ status: 'draft', kind: 'poll', topics: ['launch'] });
    expect(saved.body.post.media.map((m: any) => m.altText)).toEqual(['A harbour at sunrise']);
    expect(await notes(friend.id, 'post_mention')).toBe(0);

    const published = await as(t.app, author).post(`/v1/drafts/${draft.id}/publish`);
    expect(published.status).toBe(200);
    expect(published.body.post.status).toBeUndefined();
    expect(new Date(published.body.post.createdAt).getTime()).toBeGreaterThan(new Date(draft.createdAt).getTime());
    expect(await notes(friend.id, 'post_mention', draft.id)).toBe(1);
    expect(ids((await as(t.app, follower).get('/v1/feed?mode=following')).body.items)).toContain(draft.id);
    expect((await as(t.app, author).get('/v1/me/drafts')).body.items).toEqual([]);
    // Once out, it's a post: the drafts routes don't touch it.
    expect((await as(t.app, author).post(`/v1/drafts/${draft.id}/publish`)).status).toBe(404);
    expect((await as(t.app, author).del(`/v1/drafts/${draft.id}`)).status).toBe(404);

    const gone = (await as(t.app, author).post('/v1/posts', { body: 'Never mind', draft: true })).body.post;
    expect((await as(t.app, author).del(`/v1/drafts/${gone.id}`)).body).toEqual({ ok: true });
    expect((await as(t.app, author).get(`/v1/drafts/${gone.id}`)).status).toBe(404);
  });

  it('publishes a scheduled post at its time, once', async () => {
    const author = await adult();
    const follower = await adult();
    const mentioned = await adult();
    await as(t.app, follower).post(`/v1/users/${author.id}/follow`);
    const post = (await as(t.app, author).post('/v1/posts', { body: `Out soon, @${mentioned.username}`, scheduledAt: inMinutes(10) })).body.post;

    // Not yet due: nothing happens.
    await runJobs(scheduledPostJobHandlers(t.ctx), 50);
    expect(ids((await as(t.app, follower).get('/v1/feed?mode=following')).body.items)).not.toContain(post.id);

    await arrive(post.id);
    const row = (await t.ctx.db.query(`SELECT status, scheduled_at, created_at > now() - interval '1 minute' AS fresh FROM posts WHERE id = $1`, [post.id]))
      .rows[0];
    expect(row).toMatchObject({ status: 'published', scheduled_at: null, fresh: true });
    expect(ids((await as(t.app, follower).get('/v1/feed?mode=following')).body.items)).toContain(post.id);
    expect((await as(t.app, null).get(`/v1/public/posts/${post.id}`)).status).toBe(200);
    expect(await notes(mentioned.id, 'post_mention', post.id)).toBe(1);

    // Running the job again doesn't publish or notify twice.
    await t.ctx.db.query(`INSERT INTO jobs (kind, payload, run_at) VALUES ($1, $2, now() - interval '1 second')`, [PUBLISH_JOB, { postId: post.id }]);
    await runJobs(scheduledPostJobHandlers(t.ctx), 50);
    expect(await notes(mentioned.id, 'post_mention', post.id)).toBe(1);
  });

  it('reschedules, publishes now or cancels a scheduled post', async () => {
    const author = await adult();
    const post = (await as(t.app, author).post('/v1/posts', { body: 'Moving target', scheduledAt: inMinutes(10) })).body.post;

    const moved = await as(t.app, author).put(`/v1/drafts/${post.id}/schedule`, { scheduledAt: inMinutes(120) });
    expect(moved.status).toBe(200);
    expect(new Date(moved.body.post.scheduledAt).getTime()).toBeGreaterThan(Date.now() + 100 * 60_000);
    // The first job comes due but the post has moved: it stays scheduled.
    await t.ctx.db.query(`UPDATE jobs SET run_at = now() - interval '1 second' WHERE kind = $1 AND payload->>'postId' = $2`, [PUBLISH_JOB, post.id]);
    await runJobs(scheduledPostJobHandlers(t.ctx), 50);
    expect((await t.ctx.db.query(`SELECT status FROM posts WHERE id = $1`, [post.id])).rows[0].status).toBe('scheduled');

    const cancelled = await as(t.app, author).del(`/v1/drafts/${post.id}/schedule`);
    expect(cancelled.body.post).toMatchObject({ status: 'draft', scheduledAt: null });
    expect((await as(t.app, author).del(`/v1/drafts/${post.id}/schedule`)).status).toBe(404);
    await arrive(post.id);
    expect((await t.ctx.db.query(`SELECT status FROM posts WHERE id = $1`, [post.id])).rows[0].status).toBe('draft');

    await as(t.app, author).put(`/v1/drafts/${post.id}/schedule`, { scheduledAt: inMinutes(30) });
    const now = await as(t.app, author).post(`/v1/drafts/${post.id}/publish`);
    expect(now.status).toBe(200);
    await arrive(post.id);
    expect((await t.ctx.db.query(`SELECT count(*)::int AS n FROM posts WHERE id = $1 AND status = 'published'`, [post.id])).rows[0].n).toBe(1);
  });

  it('puts a scheduled post that can no longer go out back in the drafts and says why', async () => {
    const author = await adult();
    const post = (await as(t.app, author).post('/v1/posts', { body: 'you should hurt yourself', scheduledAt: inMinutes(15) })).body.post;
    await arrive(post.id);
    const row = (await t.ctx.db.query(`SELECT status, scheduled_at FROM posts WHERE id = $1`, [post.id])).rows[0];
    expect(row).toMatchObject({ status: 'draft', scheduled_at: null });
    expect(await notes(author.id, 'scheduled_post_failed', post.id)).toBe(1);
  });

  it('checks the time and what can be saved', async () => {
    const author = await adult();
    const create = (b: object) => as(t.app, author).post('/v1/posts', { body: 'Timing', ...b });
    expect((await create({ scheduledAt: inMinutes(2) })).status).toBe(400);
    expect((await create({ scheduledAt: inMinutes(61 * 24 * 60) })).status).toBe(400);
    expect((await create({ scheduledAt: 'tomorrow' })).status).toBe(400);
    expect((await create({ scheduledAt: inMinutes(30), draft: true })).status).toBe(400);
    expect((await create({ scheduledAt: inMinutes(59 * 24 * 60) })).status).toBe(201);
    const draft = (await create({ draft: true })).body.post;
    expect((await as(t.app, author).put(`/v1/drafts/${draft.id}/schedule`, { scheduledAt: inMinutes(1) })).status).toBe(400);
    expect((await as(t.app, author).put(`/v1/drafts/${draft.id}`, { body: '' })).status).toBe(400);
  });
});
