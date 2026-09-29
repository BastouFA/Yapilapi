import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { as, signUp, testApp, type TestUser, followAccepted } from './helpers.ts';
import type { BuiltApp } from '../src/app.ts';

let t: BuiltApp;
beforeAll(async () => {
  t = await testApp();
});
afterAll(async () => {
  await t.close();
});

const adult = () => signUp(t.app, { birthDate: '1990-01-01' });
const follow = (a: TestUser, b: TestUser) => followAccepted(t.app, a, b);
const mutual = async (a: TestUser, b: TestUser) => {
  await follow(a, b);
  await follow(b, a);
};
const befriend = async (a: TestUser, b: TestUser) => {
  await as(t.app, a).post(`/v1/users/${b.id}/friend-request`);
  await as(t.app, b).post(`/v1/users/${a.id}/friend-request`);
};
const notes = async (userId: string, type: string) =>
  (await t.ctx.db.query(`SELECT entity_id, actor_id FROM notifications WHERE user_id = $1 AND type = $2`, [userId, type])).rows;
const ids = (items: { id: string }[]) => items.map((p) => p.id);
const photo = (n = 1) => ({ url: `https://cdn.example.test/p${Date.now()}${n}.jpg`, kind: 'image', width: 800, height: 600 });

describe('collab posts and reels', () => {
  it('invites a mutual follow, who accepts, then shows on both profiles, in both audiences and in both stats', async () => {
    const ada = await adult();
    const bola = await adult();
    const fan = await adult(); // follows only Bola
    const stranger = await adult();
    await mutual(ada, bola);
    await follow(fan, bola);

    const created = await as(t.app, ada).post('/v1/posts', { body: 'Made this together', collaborators: [bola.id] });
    expect(created.status).toBe(201);
    const post = created.body.post;
    expect(post.collaborators).toBeUndefined();
    expect(post.pendingCollaborators.map((u: any) => u.id)).toEqual([bola.id]);
    expect(await notes(bola.id, 'collab_invite')).toEqual([{ entity_id: post.id, actor_id: ada.id }]);

    // Pending: Bola sees the invite; nothing is on Bola's profile or in Bola's followers' feeds yet.
    expect((await as(t.app, bola).get(`/v1/posts/${post.id}`)).body.post.viewer.collab).toBe('pending');
    expect((await as(t.app, stranger).get(`/v1/posts/${post.id}`)).body.post.pendingCollaborators).toBeUndefined();
    expect(ids((await as(t.app, bola).get('/v1/me/collab-invites')).body.items)).toEqual([post.id]);
    expect(ids((await as(t.app, stranger).get(`/v1/users/${bola.username}/posts`)).body.items)).not.toContain(post.id);
    expect(ids((await as(t.app, fan).get('/v1/feed?mode=following')).body.items)).not.toContain(post.id);

    // Only the invitee can answer.
    expect((await as(t.app, stranger).post(`/v1/posts/${post.id}/collab/accept`)).status).toBe(404);
    const accepted = await as(t.app, bola).post(`/v1/posts/${post.id}/collab/accept`);
    expect(accepted.status).toBe(200);
    expect(accepted.body.post.collaborators.map((u: any) => u.id)).toEqual([bola.id]);
    expect(accepted.body.post.viewer.collab).toBe('accepted');
    expect(await notes(ada.id, 'collab_accepted')).toEqual([{ entity_id: post.id, actor_id: bola.id }]);

    // Everyone sees "Ada and Bola"; it's on both profiles and reaches Bola's followers.
    const seen = (await as(t.app, stranger).get(`/v1/posts/${post.id}`)).body.post;
    expect(seen.author.id).toBe(ada.id);
    expect(seen.collaborators.map((u: any) => u.username)).toEqual([bola.username]);
    expect(ids((await as(t.app, stranger).get(`/v1/users/${bola.username}/posts`)).body.items)).toContain(post.id);
    expect(ids((await as(t.app, stranger).get(`/v1/users/${ada.username}/posts`)).body.items)).toContain(post.id);
    expect(ids((await as(t.app, fan).get('/v1/feed?mode=following')).body.items)).toContain(post.id);
    expect(ids((await as(t.app, fan).get('/v1/feed?mode=for_you&limit=50')).body.items)).toContain(post.id);
    expect((await as(t.app, stranger).get(`/v1/users/${bola.username}`)).body.profile.counts.posts).toBe(1);
    expect(Number((await as(t.app, bola).get('/v1/creator/analytics')).body.totals.posts)).toBe(1);

    // Only the original author can delete; a co-author leaves instead, which takes it off their profile.
    expect((await as(t.app, bola).del(`/v1/posts/${post.id}`)).status).toBe(404);
    expect((await as(t.app, bola).put(`/v1/posts/${post.id}/remix-settings`, { allowRemix: false })).status).toBe(404);
    expect((await as(t.app, bola).del(`/v1/posts/${post.id}/collab`)).body).toEqual({ ok: true });
    expect(ids((await as(t.app, stranger).get(`/v1/users/${bola.username}/posts`)).body.items)).not.toContain(post.id);
    expect(ids((await as(t.app, fan).get('/v1/feed?mode=following')).body.items)).not.toContain(post.id);
    expect((await as(t.app, stranger).get(`/v1/posts/${post.id}`)).body.post.collaborators).toBeUndefined();
    expect(ids((await as(t.app, stranger).get(`/v1/users/${ada.username}/posts`)).body.items)).toContain(post.id);
    // Someone who left can't be invited back.
    expect((await as(t.app, ada).post(`/v1/posts/${post.id}/collaborators`, { userIds: [bola.id] })).status).toBe(409);
  });

  it('works for reels, declines, invites after posting, and caps co-authors at three', async () => {
    const ada = await adult();
    const others = await Promise.all([1, 2, 3, 4].map(() => adult()));
    for (const o of others) await mutual(ada, o);
    const [b, c, d, e] = others as [TestUser, TestUser, TestUser, TestUser];

    const reel = (
      await as(t.app, ada).post('/v1/posts', {
        format: 'reel',
        body: 'Dance #together',
        media: [{ url: `https://cdn.example.test/r${Date.now()}.mp4`, kind: 'video' }],
        collaborators: [b.id, c.id],
      })
    ).body.post;
    expect(reel.format).toBe('reel');
    expect((await as(t.app, c).post(`/v1/posts/${reel.id}/collab/decline`)).body).toEqual({ ok: true });
    expect((await as(t.app, c).post(`/v1/posts/${reel.id}/collab/accept`)).status).toBe(404);
    await as(t.app, b).post(`/v1/posts/${reel.id}/collab/accept`);

    // Four at once is refused by the schema; after posting, the total stays at three (declines don't count).
    expect((await as(t.app, ada).post('/v1/posts', { body: 'x', collaborators: others.map((o) => o.id) })).status).toBe(400);
    const more = await as(t.app, ada).post(`/v1/posts/${reel.id}/collaborators`, { userIds: [d.id, e.id] });
    expect(more.status).toBe(200);
    expect(more.body.post.pendingCollaborators.map((u: any) => u.id).sort()).toEqual([d.id, e.id].sort());
    const extra = await adult();
    await mutual(ada, extra);
    expect((await as(t.app, ada).post(`/v1/posts/${reel.id}/collaborators`, { userIds: [extra.id] })).status).toBe(400);
    // Only the original author invites or removes.
    expect((await as(t.app, b).post(`/v1/posts/${reel.id}/collaborators`, { userIds: [extra.id] })).status).toBe(403);
    expect((await as(t.app, ada).del(`/v1/posts/${reel.id}/collaborators/${e.id}`)).status).toBe(200);
    expect((await as(t.app, ada).post(`/v1/posts/${reel.id}/collaborators`, { userIds: [extra.id] })).status).toBe(200);
    expect((await as(t.app, e).post(`/v1/posts/${reel.id}/collab/accept`)).status).toBe(404);

    // Reel captions turn #tags into topics like posts do.
    expect(reel.topics).toContain('together');
  });

  it('only invites mutual follows, respects blocks, minors and the audience', async () => {
    const ada = await adult();
    const oneWay = await adult();
    await follow(ada, oneWay); // they don't follow back
    const res = await as(t.app, ada).post('/v1/posts', { body: 'Hi', collaborators: [oneWay.id] });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('collab_not_allowed');
    // Nothing was posted.
    expect((await as(t.app, ada).get(`/v1/users/${ada.username}/posts`)).body.items).toEqual([]);

    // Mutual followers only show up in the co-author picker.
    const mutualFriend = await adult();
    await mutual(ada, mutualFriend);
    const picker = (await as(t.app, ada).get('/v1/people/suggest?scope=mutuals')).body.items.map((x: any) => x.user.id);
    expect(picker).toEqual([mutualFriend.id]);

    // Minors: an adult can't invite a teen who isn't a friend, even a mutual follow.
    const teen = await signUp(t.app, { birthDate: '2011-03-01' });
    await mutual(ada, teen);
    expect((await as(t.app, ada).get('/v1/people/suggest?scope=mutuals')).body.items.map((x: any) => x.user.id)).not.toContain(teen.id);
    const minor = await as(t.app, ada).post('/v1/posts', { body: 'With a teen', collaborators: [teen.id] });
    expect(minor.status).toBe(403);
    expect(minor.body.error.code).toBe('minor_protection');
    await befriend(ada, teen);
    expect((await as(t.app, ada).post('/v1/posts', { body: 'With a friend', collaborators: [teen.id] })).status).toBe(201);

    // Only posts shared publicly, with followers or friends can have co-authors; friends-only needs friends.
    expect(
      (await as(t.app, ada).post('/v1/posts', { body: 'Selected', visibility: 'selected', audience: [mutualFriend.id], collaborators: [mutualFriend.id] }))
        .status,
    ).toBe(400);
    expect((await as(t.app, ada).post('/v1/posts', { body: 'Friends only', visibility: 'friends', collaborators: [mutualFriend.id] })).status).toBe(403);

    // Blocks: a block ends the collab, and a viewer who blocked a co-author doesn't see the post.
    const bola = await adult();
    const viewer = await adult();
    await mutual(ada, bola);
    const post = (await as(t.app, ada).post('/v1/posts', { body: 'Block test', collaborators: [bola.id] })).body.post;
    await as(t.app, bola).post(`/v1/posts/${post.id}/collab/accept`);
    expect((await as(t.app, viewer).get(`/v1/posts/${post.id}`)).status).toBe(200);
    await as(t.app, viewer).post(`/v1/users/${bola.id}/block`);
    expect((await as(t.app, viewer).get(`/v1/posts/${post.id}`)).status).toBe(404);
    expect(ids((await as(t.app, viewer).get(`/v1/users/${ada.username}/posts`)).body.items)).not.toContain(post.id);
    await as(t.app, ada).post(`/v1/users/${bola.id}/block`);
    expect((await as(t.app, viewer).get(`/v1/posts/${post.id}`)).status).toBe(200);
    expect((await as(t.app, viewer).get(`/v1/posts/${post.id}`)).body.post.collaborators).toBeUndefined();
  });

  it("never widens the audience: a private author's post stays private, and a private co-author's profile stays private", async () => {
    const priv = await adult();
    const pub = await adult();
    const pubFan = await adult(); // follows only the public co-author
    const stranger = await adult();
    await t.ctx.db.query(`UPDATE profiles SET is_private = true WHERE user_id = $1`, [priv.id]);
    await mutual(priv, pub);
    await follow(pubFan, pub);

    const post = (await as(t.app, priv).post('/v1/posts', { body: 'From a private account', collaborators: [pub.id] })).body.post;
    await as(t.app, pub).post(`/v1/posts/${post.id}/collab/accept`);
    expect(ids((await as(t.app, pub).get(`/v1/users/${pub.username}/posts`)).body.items)).toContain(post.id);
    expect(ids((await as(t.app, stranger).get(`/v1/users/${pub.username}/posts`)).body.items)).not.toContain(post.id);
    expect(ids((await as(t.app, pubFan).get('/v1/feed?mode=following')).body.items)).not.toContain(post.id);
    expect((await as(t.app, stranger).get(`/v1/posts/${post.id}`)).status).toBe(404);

    // A public author's post with a private co-author: the post stays public, but the private
    // co-author's profile only lists it for people who can see that profile.
    const author = await adult();
    const shy = await adult();
    const shyFan = await adult();
    await t.ctx.db.query(`UPDATE profiles SET is_private = true WHERE user_id = $1`, [shy.id]);
    await mutual(author, shy);
    await follow(shyFan, shy);
    const open = (await as(t.app, author).post('/v1/posts', { body: 'Public collab', collaborators: [shy.id] })).body.post;
    await as(t.app, shy).post(`/v1/posts/${open.id}/collab/accept`);
    expect((await as(t.app, stranger).get(`/v1/posts/${open.id}`)).body.post.visibility).toBe('public');
    expect(ids((await as(t.app, stranger).get(`/v1/users/${shy.username}/posts`)).body.items)).not.toContain(open.id);
    expect(ids((await as(t.app, shyFan).get(`/v1/users/${shy.username}/posts`)).body.items)).toContain(open.id);
    expect(ids((await as(t.app, shyFan).get('/v1/feed?mode=following')).body.items)).toContain(open.id);
  });
});

describe('people tagged in photos', () => {
  it('tags people at a spot, tells those who can see the post, and lets them remove the tag', async () => {
    const ada = await adult();
    const bola = await adult();
    const chi = await adult(); // can't see a followers-only post
    await follow(bola, ada);

    const created = await as(t.app, ada).post('/v1/posts', {
      body: 'Beach day',
      visibility: 'followers',
      media: [
        {
          ...photo(1),
          tags: [
            { userId: bola.id, x: 0.25, y: 0.5 },
            { userId: chi.id, x: 0.75, y: 0.4 },
          ],
        },
        { ...photo(2), tags: [{ userId: bola.id, x: 0.1, y: 0.1 }] },
      ],
    });
    expect(created.status).toBe(201);
    const post = created.body.post;
    expect(post.media[0].tags.map((x: any) => [x.user.id, x.x, x.y])).toEqual([
      [bola.id, 0.25, 0.5],
      [chi.id, 0.75, 0.4],
    ]);
    expect(post.media[1].tags).toHaveLength(1);
    // One notification per person, only for people who can see the post.
    expect(await notes(bola.id, 'photo_tag')).toEqual([{ entity_id: post.id, actor_id: ada.id }]);
    expect(await notes(chi.id, 'photo_tag')).toEqual([]);

    // Tagged tab: posts you're tagged in that the viewer can see.
    expect(ids((await as(t.app, bola).get(`/v1/users/${bola.username}/tagged`)).body.items)).toEqual([post.id]);
    expect((await as(t.app, chi).get(`/v1/users/${chi.username}/tagged`)).body.items).toEqual([]);
    expect((await as(t.app, null).get(`/v1/users/${bola.username}/tagged`)).body.items).toEqual([]);

    // The person tagged removes their own tag; others can't.
    const tagId = post.media[0].tags[0].id;
    expect((await as(t.app, chi).del(`/v1/posts/${post.id}/tags/${tagId}`)).status).toBe(404);
    expect((await as(t.app, bola).del(`/v1/posts/${post.id}/tags/${tagId}`)).body).toEqual({ ok: true });
    const after = (await as(t.app, ada).get(`/v1/posts/${post.id}`)).body.post;
    expect(after.media[0].tags.map((x: any) => x.user.id)).toEqual([chi.id]);

    // The author adds a tag later (moving it if it's there), only on photos.
    const added = await as(t.app, ada).post(`/v1/posts/${post.id}/tags`, { mediaId: post.media[0].id, userId: bola.id, x: 0.3, y: 0.3 });
    expect(added.status).toBe(201);
    expect(added.body.tag).toMatchObject({ user: { id: bola.id }, x: 0.3, y: 0.3 });
    expect((await as(t.app, ada).post(`/v1/posts/${post.id}/tags`, { mediaId: post.media[0].id, userId: bola.id, x: 0.4, y: 0.3 })).status).toBe(200);
    expect(await notes(bola.id, 'photo_tag')).toHaveLength(2);
    expect((await as(t.app, bola).post(`/v1/posts/${post.id}/tags`, { mediaId: post.media[0].id, userId: bola.id, x: 0.4, y: 0.3 })).status).toBe(403);
    expect(
      (
        await as(t.app, ada).post('/v1/posts', {
          body: 'Video',
          media: [{ url: 'https://cdn.example.test/v.mp4', kind: 'video', tags: [{ userId: bola.id, x: 0.5, y: 0.5 }] }],
        })
      ).status,
    ).toBe(400);
  });

  it('follows each person’s choice of who can tag them, blocks and minor protection', async () => {
    const ada = await adult();
    const picky = await adult();
    const closed = await adult();
    const teen = await signUp(t.app, { birthDate: '2011-03-01' });

    expect((await as(t.app, picky).get('/v1/me/tagging')).body).toEqual({ allowFrom: 'everyone' });
    expect((await as(t.app, picky).put('/v1/me/tagging', { allowFrom: 'following' })).body).toEqual({ allowFrom: 'following' });
    await as(t.app, closed).put('/v1/me/tagging', { allowFrom: 'nobody' });
    expect((await as(t.app, closed).put('/v1/me/tagging', { allowFrom: 'friends' })).status).toBe(400);

    const tagIn = (u: TestUser) => as(t.app, ada).post('/v1/posts', { body: 'Tagging', media: [{ ...photo(), tags: [{ userId: u.id, x: 0.5, y: 0.5 }] }] });
    const refused = await tagIn(picky);
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('tag_not_allowed');
    await follow(picky, ada);
    expect((await tagIn(picky)).status).toBe(201);
    expect((await tagIn(closed)).status).toBe(403);
    expect((await tagIn(teen)).body.error.code).toBe('minor_protection');

    // The picker says who you can tag.
    const suggest = async (u: TestUser) =>
      (await as(t.app, ada).get(`/v1/people/suggest?q=${encodeURIComponent('@' + u.username)}`)).body.items.find((x: any) => x.user.id === u.id);
    expect((await suggest(picky)).canTag).toBe(true);
    expect((await suggest(closed)).canTag).toBe(false);
    expect((await suggest(teen)).canTag).toBe(false);

    // Blocking removes tags between the two and stops new ones.
    const pickyTagged = (await as(t.app, picky).get(`/v1/users/${picky.username}/tagged`)).body.items;
    expect(pickyTagged).toHaveLength(1);
    await as(t.app, picky).post(`/v1/users/${ada.id}/block`);
    expect((await as(t.app, picky).get(`/v1/users/${picky.username}/tagged`)).body.items).toEqual([]);
    expect((await tagIn(picky)).status).toBe(403);
  });

  it('hides the Tagged tab of a private account from people who don’t follow it', async () => {
    const ada = await adult();
    const shy = await adult();
    const fan = await adult();
    const stranger = await adult();
    await follow(fan, shy);
    const post = (await as(t.app, ada).post('/v1/posts', { body: 'Group photo', media: [{ ...photo(), tags: [{ userId: shy.id, x: 0.5, y: 0.5 }] }] })).body
      .post;
    await t.ctx.db.query(`UPDATE profiles SET is_private = true WHERE user_id = $1`, [shy.id]);
    expect((await as(t.app, stranger).get(`/v1/users/${shy.username}/tagged`)).body).toMatchObject({ items: [], hidden: true });
    expect(ids((await as(t.app, fan).get(`/v1/users/${shy.username}/tagged`)).body.items)).toEqual([post.id]);
    expect(ids((await as(t.app, shy).get(`/v1/users/${shy.username}/tagged`)).body.items)).toEqual([post.id]);
    // The post itself is still public, tags and all.
    expect((await as(t.app, stranger).get(`/v1/posts/${post.id}`)).body.post.media[0].tags).toHaveLength(1);
  });
});

describe('hashtags and mentions everywhere', () => {
  it('links #tags in reel captions and comments, counts comments on the tag page, and notifies @mentions in reel captions', async () => {
    const tag = `jam${Date.now().toString(36)}`;
    const ada = await adult();
    const bola = await adult();
    const reel = (
      await as(t.app, ada).post('/v1/posts', {
        format: 'reel',
        body: `Tonight with @${bola.username} #${tag}`,
        media: [{ url: `https://cdn.example.test/r${tag}.mp4`, kind: 'video' }],
      })
    ).body.post;
    expect(reel.topics).toEqual([tag]);
    expect(await notes(bola.id, 'post_mention')).toEqual([{ entity_id: reel.id, actor_id: ada.id }]);
    expect(ids((await as(t.app, bola).get(`/v1/tags/${tag}/posts`)).body.items)).toEqual([reel.id]);

    await as(t.app, bola).post(`/v1/posts/${reel.id}/comments`, { body: `So good #${tag.toUpperCase()} #encore` });
    const hidden = (await as(t.app, ada).post('/v1/posts', { body: 'Just me', visibility: 'friends' })).body.post;
    await as(t.app, ada).post(`/v1/posts/${hidden.id}/comments`, { body: `Note to self #${tag}` });
    expect((await as(t.app, bola).get(`/v1/tags/${tag}`)).body).toMatchObject({ posts: 1, comments: 1 });
    expect((await as(t.app, ada).get(`/v1/tags/${tag}`)).body).toMatchObject({ posts: 1, comments: 2 });
  });
});
