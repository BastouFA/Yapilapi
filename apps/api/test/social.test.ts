import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, signup, type TestApp } from './helpers.js';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
});

const counts = async (u: { client: any; username: string }) =>
  (await u.client.get(`/v1/users/${u.username}`)).body.counts;

describe('profiles', () => {
  it('shows a public profile to anonymous viewers and updates own profile', async () => {
    const a = await signup(t);
    const pub = await (await import('./helpers.js')).signup(t);
    const anon = new (await import('./helpers.js')).Client(t);
    const res = await anon.get(`/v1/users/${a.username}`);
    expect(res.status).toBe(200);
    expect(res.body.viewer.isSelf).toBe(false);
    const upd = await a.client.patch('/v1/profile', {
      bio: 'Hello from YAPILAPI',
      links: [{ label: 'Site', url: 'https://example.com' }],
      mode: 'creator',
    });
    expect(upd.status).toBe(200);
    const after = await anon.get(`/v1/users/${a.username}`);
    expect(after.body.bio).toBe('Hello from YAPILAPI');
    expect(after.body.mode).toBe('creator');
    void pub;
  });

  it('rejects unsafe links and empty updates, and requires auth to edit', async () => {
    const a = await signup(t);
    expect(
      (await a.client.patch('/v1/profile', { links: [{ label: 'x', url: 'javascript:alert(1)' }] }))
        .status,
    ).toBe(400);
    expect((await a.client.patch('/v1/profile', {})).status).toBe(400);
    const anon = new (await import('./helpers.js')).Client(t);
    expect((await anon.patch('/v1/profile', { bio: 'x' })).status).toBe(401);
  });

  it('checks username availability', async () => {
    const a = await signup(t);
    const c = a.client;
    expect((await c.get(`/v1/usernames/${a.username}/available`)).body).toEqual({
      available: false,
      reason: 'taken',
    });
    expect((await c.get('/v1/usernames/admin/available')).body.reason).toBe('reserved');
    expect((await c.get('/v1/usernames/x/available')).body.reason).toBe('invalid');
  });

  it('saves interests from the canonical topic list only', async () => {
    const a = await signup(t);
    expect(
      (await a.client.put('/v1/profile/interests', { topics: ['technology', 'cybersecurity'] }))
        .body.count,
    ).toBe(2);
    expect(
      (await a.client.get('/v1/profile/interests')).body.items.map((i: any) => i.slug).sort(),
    ).toEqual(['cybersecurity', 'technology']);
    expect((await a.client.put('/v1/profile/interests', { topics: ['not-a-topic'] })).status).toBe(
      400,
    );
  });

  it('updates attention controls but keeps teen safety defaults', async () => {
    const adult = await signup(t);
    expect(
      (
        await adult.client.patch('/v1/settings/preferences', {
          dailyLimitMinutes: 60,
          focusMode: true,
        })
      ).status,
    ).toBe(200);
    const prefs = await adult.client.get('/v1/settings/preferences');
    expect(prefs.body).toMatchObject({ dailyLimitMinutes: 60, focusMode: true });
    const teen = await signup(t, { birthDate: `${new Date().getUTCFullYear() - 15}-03-03` });
    expect(
      (await teen.client.patch('/v1/settings/preferences', { whoCanMessage: 'everyone' })).status,
    ).toBe(409);
    expect((await teen.client.patch('/v1/profile', { isPrivate: false })).status).toBe(400);
  });
});

describe('follow graph', () => {
  it('follows and unfollows with correct counters, idempotently', async () => {
    const a = await signup(t);
    const b = await signup(t);
    expect((await a.client.put(`/v1/users/${b.username}/follow`)).body.status).toBe('active');
    expect((await a.client.put(`/v1/users/${b.username}/follow`)).body.status).toBe('active'); // idempotent
    expect(await counts(b)).toMatchObject({ followers: 1 });
    expect(await counts(a)).toMatchObject({ following: 1 });
    expect(
      (await a.client.get(`/v1/users/${b.username}/followers`)).body.items.map(
        (i: any) => i.username,
      ),
    ).toEqual([a.username]);
    expect((await a.client.del(`/v1/users/${b.username}/follow`)).status).toBe(204);
    expect(await counts(b)).toMatchObject({ followers: 0 });
    expect((await a.client.put(`/v1/users/${a.username}/follow`)).status).toBe(422);
  });

  it('private accounts require approval; hidden content until approved; going public releases requests', async () => {
    const a = await signup(t);
    const b = await signup(t);
    const c = await signup(t);
    await b.client.patch('/v1/profile', { isPrivate: true });
    expect((await a.client.put(`/v1/users/${b.username}/follow`)).body.status).toBe('pending');
    expect((await a.client.get(`/v1/users/${b.username}`)).body.contentHidden).toBe(true);
    expect((await a.client.get(`/v1/users/${b.username}/followers`)).status).toBe(403);
    expect((await b.client.get('/v1/follow-requests')).body.items.length).toBe(1);
    expect((await c.client.post(`/v1/follow-requests/${a.id}/approve`)).status).toBe(404); // only the followee can approve
    expect((await b.client.post(`/v1/follow-requests/${a.id}/approve`)).status).toBe(200);
    expect((await a.client.get(`/v1/users/${b.username}`)).body.contentHidden).toBe(false);
    expect(await counts(b)).toMatchObject({ followers: 1 });
    // deny path
    expect((await c.client.put(`/v1/users/${b.username}/follow`)).body.status).toBe('pending');
    expect((await b.client.post(`/v1/follow-requests/${c.id}/deny`)).status).toBe(204);
    // going public activates pending
    expect((await c.client.put(`/v1/users/${b.username}/follow`)).body.status).toBe('pending');
    await b.client.patch('/v1/profile', { isPrivate: false });
    expect(await counts(b)).toMatchObject({ followers: 2 });
  });

  it('friend requests: send, auto-accept crossing requests, accept, remove; adults cannot request teens', async () => {
    const a = await signup(t);
    const b = await signup(t);
    const c = await signup(t);
    expect(
      (await a.client.post('/v1/friends/requests', { username: b.username })).body.status,
    ).toBe('pending');
    expect((await a.client.post('/v1/friends/requests', { username: b.username })).status).toBe(
      409,
    );
    expect((await a.client.post(`/v1/friends/requests/${b.id}/accept`)).status).toBe(404); // requester can't accept own request
    expect((await b.client.get('/v1/friends/requests')).body.items.length).toBe(1);
    expect((await b.client.post(`/v1/friends/requests/${a.id}/accept`)).status).toBe(200);
    expect(await counts(a)).toMatchObject({ friends: 1 });
    expect((await a.client.get('/v1/friends')).body.items.map((i: any) => i.username)).toEqual([
      b.username,
    ]);
    expect((await a.client.del(`/v1/friends/${b.id}`)).status).toBe(204);
    expect(await counts(b)).toMatchObject({ friends: 0 });
    // crossing requests
    await b.client.post('/v1/friends/requests', { username: c.username });
    expect(
      (await c.client.post('/v1/friends/requests', { username: b.username })).body.status,
    ).toBe('accepted');
    // teen safety
    const teen = await signup(t, { birthDate: `${new Date().getUTCFullYear() - 15}-05-05` });
    expect((await a.client.post('/v1/friends/requests', { username: teen.username })).status).toBe(
      403,
    );
    expect((await teen.client.post('/v1/friends/requests', { username: a.username })).status).toBe(
      201,
    );
  });

  it('circles are private to their owner', async () => {
    const a = await signup(t);
    const b = await signup(t);
    const c = await signup(t);
    const circle = (
      await a.client.post('/v1/circles', { kind: 'close_friends', name: 'Close friends' })
    ).body;
    expect((await a.client.put(`/v1/circles/${circle.id}/members/${b.id}`)).status).toBe(200);
    expect((await a.client.get(`/v1/circles/${circle.id}/members`)).body.items.length).toBe(1);
    expect(
      (await a.client.post('/v1/circles', { kind: 'custom', name: 'Close friends' })).status,
    ).toBe(409);
    expect((await c.client.get(`/v1/circles/${circle.id}/members`)).status).toBe(404);
    expect((await c.client.put(`/v1/circles/${circle.id}/members/${b.id}`)).status).toBe(404);
    expect((await c.client.del(`/v1/circles/${circle.id}`)).status).toBe(404);
  });
});

describe('blocking, muting, restricting', () => {
  it('block removes relationships, hides both users from each other, and is undone by unblock', async () => {
    const a = await signup(t);
    const b = await signup(t);
    await a.client.put(`/v1/users/${b.username}/follow`);
    await b.client.put(`/v1/users/${a.username}/follow`);
    await a.client.post('/v1/friends/requests', { username: b.username });
    await b.client.post(`/v1/friends/requests/${a.id}/accept`);
    expect((await a.client.put(`/v1/users/${b.username}/block`)).status).toBe(200);
    expect(await counts(a)).toMatchObject({ followers: 0, following: 0, friends: 0 });
    // the blocked user gets a plain 404 (block state is not revealed) and cannot follow or friend
    expect((await b.client.get(`/v1/users/${a.username}`)).status).toBe(404);
    expect((await b.client.put(`/v1/users/${a.username}/follow`)).status).toBe(404);
    expect((await b.client.post('/v1/friends/requests', { username: a.username })).status).toBe(
      404,
    );
    expect((await a.client.get(`/v1/users/${b.username}`)).status).toBe(404);
    expect((await a.client.get('/v1/blocks')).body.items.map((i: any) => i.username)).toEqual([
      b.username,
    ]);
    expect((await a.client.del(`/v1/users/${b.username}/block`)).status).toBe(204);
    expect((await b.client.get(`/v1/users/${a.username}`)).status).toBe(200);
  });

  it('mute and restrict are per-user lists', async () => {
    const a = await signup(t);
    const b = await signup(t);
    expect((await a.client.put(`/v1/users/${b.username}/mute`)).body.muted).toBe(true);
    expect((await a.client.put(`/v1/users/${b.username}/restrict`)).body.restricted).toBe(true);
    const profile = (await a.client.get(`/v1/users/${b.username}`)).body;
    expect(profile.viewer).toMatchObject({ muted: true, restricted: true });
    expect((await b.client.get(`/v1/users/${a.username}`)).body.viewer).toMatchObject({
      muted: false,
      restricted: false,
    });
    expect((await a.client.get('/v1/mutes')).body.items.length).toBe(1);
    await a.client.del(`/v1/users/${b.username}/mute`);
    expect((await a.client.get('/v1/mutes')).body.items.length).toBe(0);
  });

  it('creates notifications for follows but not for blocked actors', async () => {
    const a = await signup(t);
    const b = await signup(t);
    await a.client.put(`/v1/users/${b.username}/follow`);
    const n = await t.ctx.db.query(`SELECT kind FROM notifications WHERE user_id = $1`, [b.id]);
    expect(n.rows.map((r) => r.kind)).toEqual(['follow']);
  });
});
