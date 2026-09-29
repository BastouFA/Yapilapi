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
const notices = async (u: TestUser, type: string) =>
  (await as(t.app, u).get('/v1/notifications')).body.items.filter((n: any) => n.type === type).map((n: any) => n.actor?.id);

describe('following a private account', () => {
  it('asks first, and only an accepted request opens the posts', async () => {
    const owner = await adult();
    const fan = await adult();
    await as(t.app, owner).patch('/v1/me/profile', { isPrivate: true });
    const post = (await as(t.app, owner).post('/v1/posts', { body: 'For my followers', visibility: 'followers' })).body.post;

    expect((await as(t.app, fan).post(`/v1/users/${owner.id}/follow`)).body).toEqual({ following: false, requested: true });
    // Asking twice is one request and one notification.
    await as(t.app, fan).post(`/v1/users/${owner.id}/follow`);
    expect(await notices(owner, 'follow_request')).toEqual([fan.id]);
    expect((await as(t.app, fan).get(`/v1/users/${owner.username}`)).body.profile.relationship).toMatchObject({ following: false, followRequest: 'sent' });
    expect((await as(t.app, owner).get(`/v1/users/${fan.username}`)).body.profile.relationship.followRequest).toBe('received');
    expect((await as(t.app, owner).get(`/v1/users/${owner.username}`)).body.profile.counts.followers).toBe(0);
    expect((await as(t.app, fan).get(`/v1/posts/${post.id}`)).status).toBe(404);
    expect((await as(t.app, fan).get(`/v1/users/${owner.id}/followers`)).status).toBe(403);

    const list = (await as(t.app, owner).get('/v1/me/follow-requests')).body.items;
    expect(list.map((r: any) => r.user.id)).toEqual([fan.id]);
    // Only the account asked can answer.
    expect((await as(t.app, fan).post(`/v1/me/follow-requests/${fan.id}/accept`)).status).toBe(404);

    expect((await as(t.app, owner).post(`/v1/me/follow-requests/${fan.id}/accept`)).body).toEqual({ status: 'accepted' });
    expect((await as(t.app, fan).get(`/v1/posts/${post.id}`)).status).toBe(200);
    expect(await notices(fan, 'follow_accepted')).toEqual([owner.id]);
    // The request's notification now reads as a follow.
    expect(await notices(owner, 'follow_request')).toEqual([]);
    expect(await notices(owner, 'follow')).toEqual([fan.id]);
    expect((await as(t.app, owner).get('/v1/me/follow-requests')).body.items).toEqual([]);
    expect((await as(t.app, owner).post(`/v1/me/follow-requests/${fan.id}/accept`)).status).toBe(404);
    // Following again changes nothing.
    expect((await as(t.app, fan).post(`/v1/users/${owner.id}/follow`)).body).toEqual({ following: true, requested: false });
  });

  it('lets the asker take a request back, the account decline it, and blocks clear it', async () => {
    const owner = await adult();
    const fan = await adult();
    const other = await adult();
    await as(t.app, owner).patch('/v1/me/profile', { isPrivate: true });

    await as(t.app, fan).post(`/v1/users/${owner.id}/follow`);
    expect((await as(t.app, fan).del(`/v1/users/${owner.id}/follow`)).body).toEqual({ following: false, requested: false });
    expect((await as(t.app, owner).get('/v1/me/follow-requests')).body.items).toEqual([]);
    expect(await notices(owner, 'follow_request')).toEqual([]);

    await as(t.app, fan).post(`/v1/users/${owner.id}/follow`);
    expect((await as(t.app, owner).post(`/v1/me/follow-requests/${fan.id}/decline`)).body).toEqual({ status: 'declined' });
    expect(await notices(owner, 'follow_request')).toEqual([]);
    // Declining isn't told to the asker, and they aren't following.
    expect(await notices(fan, 'follow_accepted')).toEqual([]);
    expect((await as(t.app, fan).get(`/v1/users/${owner.username}`)).body.profile.relationship).toMatchObject({ following: false, followRequest: 'none' });

    await as(t.app, other).post(`/v1/users/${owner.id}/follow`);
    await as(t.app, owner).post(`/v1/users/${other.id}/block`);
    expect((await as(t.app, owner).get('/v1/me/follow-requests')).body.items).toEqual([]);
  });

  it('accepts everyone waiting when the account goes public', async () => {
    const owner = await adult();
    const a = await adult();
    const b = await adult();
    await as(t.app, owner).patch('/v1/me/profile', { isPrivate: true });
    await as(t.app, a).post(`/v1/users/${owner.id}/follow`);
    await as(t.app, b).post(`/v1/users/${owner.id}/follow`);
    await as(t.app, owner).patch('/v1/me/profile', { isPrivate: false });
    expect((await as(t.app, owner).get('/v1/me/follow-requests')).body.items).toEqual([]);
    expect((await as(t.app, owner).get(`/v1/users/${owner.username}`)).body.profile.counts.followers).toBe(2);
    expect((await as(t.app, a).get(`/v1/users/${owner.username}`)).body.profile.relationship.following).toBe(true);
  });

  it("keeps a teen's account closed to adults until the teen says yes", async () => {
    const teen = await signUp(t.app, { birthDate: '2011-06-01' });
    const grownup = await adult();
    expect((await as(t.app, grownup).post(`/v1/users/${teen.id}/follow`)).body).toEqual({ following: false, requested: true });
    expect((await as(t.app, teen).get(`/v1/users/${teen.username}`)).body.profile.counts.followers).toBe(0);
  });

  it('lets you remove a follower quietly', async () => {
    const owner = await adult();
    const fan = await adult();
    await as(t.app, fan).post(`/v1/users/${owner.id}/follow`);
    expect((await as(t.app, owner).del(`/v1/me/followers/${fan.id}`)).body).toEqual({ ok: true });
    expect((await as(t.app, fan).get(`/v1/users/${owner.username}`)).body.profile.relationship.following).toBe(false);
  });
});

describe('notifications and blocks', () => {
  it('leaves out what a blocked person did, while the block lasts', async () => {
    const owner = await adult();
    const fan = await adult();
    await as(t.app, fan).post(`/v1/users/${owner.id}/follow`);
    expect(await notices(owner, 'follow')).toEqual([fan.id]);
    await as(t.app, owner).post(`/v1/users/${fan.id}/block`);
    expect(await notices(owner, 'follow')).toEqual([]);
    expect((await as(t.app, owner).get('/v1/notifications')).body.unread).toBe(0);
    await as(t.app, owner).del(`/v1/users/${fan.id}/block`);
    expect(await notices(owner, 'follow')).toEqual([fan.id]);
  });
});

describe('a private account’s friends', () => {
  it('are listed only for the account and its followers', async () => {
    const owner = await adult();
    const pal = await adult();
    const stranger = await adult();
    await as(t.app, pal).post(`/v1/users/${owner.id}/friend-request`);
    const req = (await as(t.app, owner).get('/v1/me/friend-requests')).body.items[0];
    await as(t.app, owner).post(`/v1/friend-requests/${req.id}/accept`);
    expect((await as(t.app, stranger).get(`/v1/users/${owner.id}/friends`)).body.items.map((u: any) => u.id)).toEqual([pal.id]);
    await as(t.app, owner).patch('/v1/me/profile', { isPrivate: true });
    expect((await as(t.app, stranger).get(`/v1/users/${owner.id}/friends`)).status).toBe(403);
    expect((await as(t.app, null).get(`/v1/users/${owner.id}/friends`)).status).toBe(403);
    expect((await as(t.app, owner).get(`/v1/users/${owner.id}/friends`)).status).toBe(200);
    // A friend was approved by the account too.
    expect((await as(t.app, pal).get(`/v1/users/${owner.id}/followers`)).status).toBe(200);
  });
});

describe('a private account’s reposts', () => {
  it('are for the account and its followers', async () => {
    const owner = await adult();
    const author = await adult();
    const stranger = await adult();
    const post = (await as(t.app, author).post('/v1/posts', { body: 'Public post' })).body.post;
    await as(t.app, owner).put(`/v1/posts/${post.id}/repost`);
    expect((await as(t.app, stranger).get(`/v1/users/${owner.id}/reposts`)).body.items).toHaveLength(1);
    await as(t.app, owner).patch('/v1/me/profile', { isPrivate: true });
    expect((await as(t.app, stranger).get(`/v1/users/${owner.id}/reposts`)).body).toEqual({ items: [], nextCursor: null, hidden: true });
    expect((await as(t.app, null).get(`/v1/users/${owner.id}/reposts`)).body.hidden).toBe(true);
    expect((await as(t.app, owner).get(`/v1/users/${owner.id}/reposts`)).body.items).toHaveLength(1);
  });
});

describe('grouped notifications', () => {
  it('say so live, so the unread count only grows for a new row', async () => {
    const owner = await adult();
    const a = await adult();
    const b = await adult();
    const events: { type: string; data: any }[] = [];
    const remove = t.ctx.realtime.add(owner.id, { readyState: 1, send: (raw: string) => void events.push(JSON.parse(raw)) });
    // Likes on a comment are batched on the server into one row ("Ada and 1 other liked your comment").
    const post = (await as(t.app, owner).post('/v1/posts', { body: 'Grouped' })).body.post;
    const comment = (await as(t.app, owner).post(`/v1/posts/${post.id}/comments`, { body: 'Mine' })).body.comment;
    await as(t.app, a).put(`/v1/comments/${comment.id}/like`);
    await as(t.app, b).put(`/v1/comments/${comment.id}/like`);
    remove();
    const live = events.filter((e) => e.type === 'notification.created').map((e) => !!e.data.grouped);
    expect(live).toEqual([false, true]);
    expect((await as(t.app, owner).get('/v1/notifications')).body.unread).toBe(1);
  });
});
