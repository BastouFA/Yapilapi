import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BuiltApp } from '../src/app.ts';
import { as, signUp, testApp, type TestUser } from './helpers.ts';

/** Bugs found in the communities, events, tickets, places and live sweep (2026-10-05). */
let t: BuiltApp;
beforeAll(async () => {
  t = await testApp();
});
afterAll(async () => {
  await t.close();
});
const db = () => t.ctx.db;

let n = 0;
async function community(owner: TestUser, visibility: 'public' | 'private' = 'public') {
  n++;
  const slug = `sweep-${Date.now().toString(36)}-${n}`;
  const r = await as(t.app, owner).post('/v1/communities', { name: `Sweep ${n}`, slug, visibility });
  expect(r.status).toBe(201);
  return r.body.community as { id: string; slug: string };
}

describe('communities', () => {
  it('asking twice to join a private community tells the moderators once', async () => {
    const owner = await signUp(t.app);
    const asker = await signUp(t.app);
    const c = await community(owner, 'private');
    expect((await as(t.app, asker).post(`/v1/communities/${c.slug}/join`)).body.status).toBe('pending');
    expect((await as(t.app, asker).post(`/v1/communities/${c.slug}/join`)).body.status).toBe('pending');
    const { rows } = await db().query(`SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND type = 'join_request'`, [owner.id]);
    expect(rows[0].n).toBe(1);
  });

  it('someone waiting to join can take the request back', async () => {
    const owner = await signUp(t.app);
    const asker = await signUp(t.app);
    const c = await community(owner, 'private');
    await as(t.app, asker).post(`/v1/communities/${c.slug}/join`);
    expect((await as(t.app, asker).post(`/v1/communities/${c.slug}/leave`)).status).toBe(200);
    expect((await as(t.app, asker).get(`/v1/communities/${c.slug}`)).body.community.membershipStatus).toBeNull();
    expect((await as(t.app, owner).get(`/v1/communities/${c.slug}/members?status=pending`)).body.items).toHaveLength(0);
    // The member count only counted members.
    expect((await as(t.app, owner).get(`/v1/communities/${c.slug}`)).body.community.memberCount).toBe(1);
  });

  it('a request to join can be banned, and a ban that bans no one is a 404', async () => {
    const owner = await signUp(t.app);
    const asker = await signUp(t.app);
    const c = await community(owner, 'private');
    await as(t.app, asker).post(`/v1/communities/${c.slug}/join`);
    expect((await as(t.app, owner).post(`/v1/communities/${c.slug}/members/${asker.id}/ban`)).status).toBe(200);
    expect((await as(t.app, owner).get(`/v1/communities/${c.slug}/members?status=banned`)).body.items.map((m: { user: { id: string } }) => m.user.id)).toEqual([
      asker.id,
    ]);
    expect((await as(t.app, asker).post(`/v1/communities/${c.slug}/join`)).status).toBe(403);
    expect((await as(t.app, owner).get(`/v1/communities/${c.slug}`)).body.community.memberCount).toBe(1);
    const stranger = await signUp(t.app);
    expect((await as(t.app, owner).post(`/v1/communities/${c.slug}/members/${stranger.id}/ban`)).status).toBe(404);
  });

  it('the owner hands the community over and can then leave', async () => {
    const owner = await signUp(t.app);
    const next = await signUp(t.app);
    const guest = await signUp(t.app);
    const c = await community(owner);
    await as(t.app, next).post(`/v1/communities/${c.slug}/join`);
    await as(t.app, guest).post(`/v1/communities/${c.slug}/join`);
    await as(t.app, owner).put(`/v1/communities/${c.slug}/members/${guest.id}/role`, { role: 'guest' });
    expect((await as(t.app, owner).post(`/v1/communities/${c.slug}/leave`)).status).toBe(400);
    // Only the owner, only to a member who isn't a guest.
    expect((await as(t.app, next).post(`/v1/communities/${c.slug}/members/${next.id}/owner`)).status).toBe(403);
    expect((await as(t.app, owner).post(`/v1/communities/${c.slug}/members/${guest.id}/owner`)).status).toBe(400);
    expect((await as(t.app, owner).post(`/v1/communities/${c.slug}/members/${next.id}/owner`)).status).toBe(200);
    expect((await as(t.app, next).get(`/v1/communities/${c.slug}`)).body.community.myRole).toBe('owner');
    expect((await as(t.app, owner).get(`/v1/communities/${c.slug}`)).body.community.myRole).toBe('admin');
    const { rows } = await db().query(`SELECT owner_id FROM communities WHERE id = $1`, [c.id]);
    expect(rows[0].owner_id).toBe(next.id);
    // The new owner outranks the old one now.
    expect((await as(t.app, owner).post(`/v1/communities/${c.slug}/members/${next.id}/ban`)).status).toBe(403);
    expect((await as(t.app, owner).post(`/v1/communities/${c.slug}/leave`)).status).toBe(200);
  });

  it("a public community's member list leaves private accounts out for people outside it", async () => {
    const owner = await signUp(t.app);
    const teen = await signUp(t.app, { birthDate: `${new Date().getFullYear() - 15}-01-01` });
    const c = await community(owner);
    await as(t.app, teen).post(`/v1/communities/${c.slug}/join`);
    const ids = (r: { body: { items: { user: { id: string } }[] } }) => r.body.items.map((m) => m.user.id);
    expect(ids(await as(t.app, null).get(`/v1/communities/${c.slug}/members`))).not.toContain(teen.id);
    expect(ids(await as(t.app, await signUp(t.app)).get(`/v1/communities/${c.slug}/members`))).not.toContain(teen.id);
    expect(ids(await as(t.app, owner).get(`/v1/communities/${c.slug}/members`))).toContain(teen.id);
    expect(ids(await as(t.app, teen).get(`/v1/communities/${c.slug}/members`))).toContain(teen.id);
  });
});
