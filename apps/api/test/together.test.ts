import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTransaction } from '@yapilapi/database';
import { getDeletionHooks } from '../src/lib/hooks.js';
import { canViewMedia } from '../src/modules/media/access.js';
import { Client, createTestApp, signup, type TestApp, type TestUser } from './helpers.js';
import {
  auditCount,
  befriend,
  block,
  follow,
  insertImage,
  notifCount,
  teenBirth,
} from './entity-helpers.js';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
});

const sql = <R extends Record<string, any> = any>(text: string, params: unknown[] = []) =>
  t.ctx.db.query<R>(text, params);
const setFlag = async (key: string, enabled: boolean) => {
  await sql('UPDATE feature_flags SET enabled = $2 WHERE key = $1', [key, enabled]);
  t.ctx.flags.invalidate();
};
const media = (u: TestUser) => insertImage(t, u.id, { purpose: 'attachment' });
const anon = () => new Client(t);

async function experience(owner: TestUser, over: Record<string, unknown> = {}) {
  const r = await owner.client.post('/v1/together', {
    title: 'Summer festival',
    visibility: 'private',
    ...over,
  });
  if (r.status !== 201) throw new Error(`create failed ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}
async function join(
  owner: TestUser,
  id: string,
  u: TestUser,
  role: 'contributor' | 'viewer' = 'contributor',
) {
  await befriend(owner, u).catch(() => undefined);
  const inv = await owner.client.post(`/v1/together/${id}/members`, { userId: u.id, role });
  if (inv.status !== 201)
    throw new Error(`invite failed ${inv.status} ${JSON.stringify(inv.body)}`);
  const acc = await u.client.post(`/v1/together/${id}/accept`);
  if (acc.status !== 200) throw new Error(`accept failed ${acc.status}`);
}
async function contribute(
  u: TestUser,
  id: string,
  body: Record<string, unknown> = { body: 'a moment' },
) {
  const r = await u.client.post(`/v1/together/${id}/contributions`, body);
  if (r.status !== 201) throw new Error(`contribute failed ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}
const timeline = async (u: Client, id: string, query: Record<string, string> = {}) =>
  u.get(`/v1/together/${id}/timeline`, query);
const seesHeader = async (u: Client, id: string) =>
  (await u.get(`/v1/together/${id}`)).status === 200;
const timelineTexts = async (u: Client, id: string) => {
  const r = await timeline(u, id);
  return r.status === 200 ? r.body.items.map((i: any) => i.text) : null;
};

describe('creating and editing', () => {
  it('requires auth, validates input, and makes the creator the owner', async () => {
    const a = await signup(t);
    expect((await anon().post('/v1/together', { title: 'x' })).status).toBe(401);
    expect((await a.client.post('/v1/together', { title: '' })).status).toBe(400);
    expect(
      (await a.client.post('/v1/together', { title: 'ok', visibility: 'circle' })).status,
    ).toBe(400);
    expect(
      (
        await a.client.post('/v1/together', {
          title: 'ok',
          startsAt: '2026-01-02T10:00:00Z',
          endsAt: '2026-01-02T09:00:00Z',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await a.client.post('/v1/together', {
          title: 'ok',
          placeId: '00000000-0000-4000-8000-000000000000',
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await a.client.post('/v1/together', {
          title: 'ok',
          eventId: '00000000-0000-4000-8000-000000000000',
        })
      ).status,
    ).toBe(404);
    const e = await experience(a, { description: 'friends at the lake' });
    expect(e).toMatchObject({
      title: 'Summer festival',
      visibility: 'private',
      status: 'open',
      counts: { members: 1, contributions: 0 },
      viewer: {
        role: 'owner',
        membership: 'joined',
        isOwner: true,
        canContribute: true,
        showOnProfile: false,
      },
    });
    expect(await auditCount(t, 'together.created', e.id)).toBe(1);
  });

  it('teens and private accounts cannot make public experiences', async () => {
    const teen = await signup(t, { birthDate: teenBirth() });
    expect(
      (await teen.client.post('/v1/together', { title: 'ok', visibility: 'public' })).status,
    ).toBe(422);
    expect(
      (await teen.client.post('/v1/together', { title: 'ok', visibility: 'friends' })).status,
    ).toBe(201);
    const priv = await signup(t);
    await priv.client.patch('/v1/profile', { isPrivate: true });
    expect(
      (await priv.client.post('/v1/together', { title: 'ok', visibility: 'public' })).status,
    ).toBe(422);
  });

  it('only the owner edits; visibility changes are audited; risky text is refused', async () => {
    const o = await signup(t);
    const c = await signup(t);
    const e = await experience(o);
    await join(o, e.id, c);
    expect((await c.client.patch(`/v1/together/${e.id}`, { title: 'mine now' })).status).toBe(403);
    expect(
      (await o.client.patch(`/v1/together/${e.id}`, { title: 'Renamed', visibility: 'friends' }))
        .body,
    ).toMatchObject({ title: 'Renamed', visibility: 'friends' });
    expect(await auditCount(t, 'together.visibility_changed', e.id)).toBe(1);
    expect(
      (
        await o.client.patch(`/v1/together/${e.id}`, {
          title: 'I will kill you and your family, you are going to die',
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await o.client.patch(`/v1/together/${e.id}`, {
          startsAt: '2026-01-02T10:00:00Z',
          endsAt: '2026-01-01T10:00:00Z',
        })
      ).status,
    ).toBe(400);
  });
});

describe('membership', () => {
  it('invites friends only; accept/decline/leave; nothing shows on a profile without opt-in', async () => {
    const o = await signup(t);
    const friend = await signup(t);
    const stranger = await signup(t);
    const decliner = await signup(t);
    await befriend(o, friend);
    await befriend(o, decliner);
    const e = await experience(o);
    expect(
      (await o.client.post(`/v1/together/${e.id}/members`, { userId: stranger.id })).status,
    ).toBe(400); // not a friend
    expect((await o.client.post(`/v1/together/${e.id}/members`, { userId: o.id })).status).toBe(
      400,
    );
    expect(
      (await friend.client.post(`/v1/together/${e.id}/members`, { userId: stranger.id })).status,
    ).toBe(404); // not even visible to them yet
    expect(
      (await o.client.post(`/v1/together/${e.id}/members`, { userId: friend.id, role: 'owner' }))
        .status,
    ).toBe(400);
    expect(
      (await o.client.post(`/v1/together/${e.id}/members`, { userId: friend.id })).status,
    ).toBe(201);
    expect(
      (await o.client.post(`/v1/together/${e.id}/members`, { userId: friend.id })).status,
    ).toBe(201); // idempotent while pending
    expect(await notifCount(t, friend.id, 'together_invite')).toBe(1);
    // an invitee sees the header but not the perspectives, and cannot contribute
    expect(await seesHeader(friend.client, e.id)).toBe(true);
    expect((await timeline(friend.client, e.id)).body.items).toEqual([]);
    expect(
      (await friend.client.post(`/v1/together/${e.id}/contributions`, { body: 'hi' })).status,
    ).toBe(403);
    expect(
      (await friend.client.get('/v1/together', { membership: 'invited' })).body.items.map(
        (i: any) => i.id,
      ),
    ).toEqual([e.id]);
    expect((await friend.client.get('/v1/together')).body.items).toEqual([]);
    expect((await friend.client.post(`/v1/together/${e.id}/accept`)).body.status).toBe('joined');
    expect((await friend.client.post(`/v1/together/${e.id}/accept`)).status).toBe(409);
    expect(
      (await o.client.post(`/v1/together/${e.id}/members`, { userId: friend.id })).status,
    ).toBe(409); // already a member
    // never on a profile unless the member opts in
    expect((await anon().get(`/v1/users/${friend.username}/experiences`)).body.items).toEqual([]);
    await sql(`UPDATE shared_experiences SET visibility = 'public' WHERE id = $1`, [e.id]);
    expect((await anon().get(`/v1/users/${friend.username}/experiences`)).body.items).toEqual([]);
    expect((await friend.client.put(`/v1/together/${e.id}/profile`, { show: true })).status).toBe(
      204,
    );
    expect(
      (await anon().get(`/v1/users/${friend.username}/experiences`)).body.items.map(
        (i: any) => i.id,
      ),
    ).toEqual([e.id]);
    expect((await o.client.put(`/v1/together/${e.id}/profile`, { show: true })).status).toBe(204);
    await friend.client.put(`/v1/together/${e.id}/profile`, { show: false });
    expect((await anon().get(`/v1/users/${friend.username}/experiences`)).body.items).toEqual([]);
    // decline, and the cooldown
    await o.client.post(`/v1/together/${e.id}/members`, { userId: decliner.id });
    expect((await decliner.client.post(`/v1/together/${e.id}/decline`)).body.status).toBe(
      'declined',
    );
    expect(
      (await o.client.post(`/v1/together/${e.id}/members`, { userId: decliner.id })).status,
    ).toBe(409);
    expect((await decliner.client.post(`/v1/together/${e.id}/accept`)).status).toBe(409);
    await sql(
      `UPDATE shared_experience_members SET invited_at = now() - interval '31 days' WHERE experience_id = $1 AND user_id = $2`,
      [e.id, decliner.id],
    );
    expect(
      (await o.client.post(`/v1/together/${e.id}/members`, { userId: decliner.id })).status,
    ).toBe(201);
  });

  it('members list hides pending invites from non-owners and hides blocked pairs; owner cannot leave', async () => {
    const o = await signup(t);
    const a = await signup(t);
    const b = await signup(t);
    const pending = await signup(t);
    const e = await experience(o);
    await join(o, e.id, a);
    await join(o, e.id, b);
    await befriend(o, pending);
    await o.client.post(`/v1/together/${e.id}/members`, { userId: pending.id });
    const names = async (u: TestUser) =>
      (await u.client.get(`/v1/together/${e.id}/members`)).body.items.map(
        (i: any) => i.user.username,
      );
    expect((await names(a)).sort()).toEqual([o.username, a.username, b.username].sort());
    expect(await names(o)).toContain(pending.username);
    expect(
      (await a.client.get(`/v1/together/${e.id}/members`)).body.items.some(
        (i: any) => i.status === 'invited',
      ),
    ).toBe(false);
    await block(a, b);
    expect(await names(a)).not.toContain(b.username);
    expect(await names(b)).not.toContain(a.username);
    expect((await o.client.post(`/v1/together/${e.id}/leave`, {})).status).toBe(409);
    expect((await o.client.del(`/v1/together/${e.id}/members/${o.id}`)).status).toBe(409);
    expect((await a.client.get(`/v1/together/${e.id}/members`)).status).toBe(200);
    expect((await anon().get(`/v1/together/${e.id}/members`)).status).toBe(401);
  });

  it("leaving withdraws contributions by default (or keeps them on request); removal withdraws them; roles are the owner's call", async () => {
    const o = await signup(t);
    const a = await signup(t);
    const b = await signup(t);
    const c = await signup(t);
    const e = await experience(o);
    for (const u of [a, b, c]) await join(o, e.id, u);
    await contribute(a, e.id, { body: 'a-one' });
    await contribute(b, e.id, { body: 'b-one' });
    await contribute(c, e.id, { body: 'c-one' });
    expect((await a.client.post(`/v1/together/${e.id}/leave`, {})).status).toBe(204);
    expect(
      (await b.client.post(`/v1/together/${e.id}/leave`, { keepContributions: true })).status,
    ).toBe(204);
    expect((await o.client.del(`/v1/together/${e.id}/members/${c.id}`)).status).toBe(204);
    expect(await timelineTexts(o.client, e.id)).toEqual(['b-one']);
    expect(await seesHeader(a.client, e.id)).toBe(false); // out means out
    expect((await a.client.post(`/v1/together/${e.id}/leave`, {})).status).toBe(404);
    expect((await o.client.del(`/v1/together/${e.id}/members/${c.id}`)).status).toBe(404);
    expect(await auditCount(t, 'together.member_removed', e.id)).toBe(1);
    // roles
    const v = await signup(t);
    await join(o, e.id, v);
    expect(
      (await v.client.patch(`/v1/together/${e.id}/members/${v.id}`, { role: 'viewer' })).status,
    ).toBe(403);
    expect(
      (await o.client.patch(`/v1/together/${e.id}/members/${v.id}`, { role: 'viewer' })).status,
    ).toBe(204);
    expect(
      (await v.client.post(`/v1/together/${e.id}/contributions`, { body: 'nope' })).status,
    ).toBe(403);
    expect(
      (await o.client.patch(`/v1/together/${e.id}/members/${o.id}`, { role: 'viewer' })).status,
    ).toBe(409);
  });
});

describe('contributions', () => {
  it('lets owners and contributors add media, their own Reals and text; refuses everyone else', async () => {
    const o = await signup(t);
    const c = await signup(t);
    const viewer = await signup(t);
    const outsider = await signup(t);
    const e = await experience(o, { startsAt: '2026-05-01T10:00:00Z' });
    await join(o, e.id, c);
    await join(o, e.id, viewer, 'viewer');
    await befriend(o, outsider);
    const own = await media(c);
    const pic = await contribute(c, e.id, {
      mediaId: own,
      body: 'stage view',
      takenAt: '2026-05-01T12:00:00Z',
    });
    expect(pic).toMatchObject({ text: 'stage view', mine: true, contributor: { id: c.id } });
    expect(pic.media.id).toBe(own);
    expect(
      (await c.client.post(`/v1/together/${e.id}/contributions`, { mediaId: own })).status,
    ).toBe(409); // same file twice
    expect(
      (await c.client.post(`/v1/together/${e.id}/contributions`, { mediaId: await media(o) }))
        .status,
    ).toBe(400); // not your media
    expect((await c.client.post(`/v1/together/${e.id}/contributions`, {})).status).toBe(400);
    expect(
      (
        await c.client.post(`/v1/together/${e.id}/contributions`, {
          realCaptureId: '00000000-0000-4000-8000-000000000000',
        })
      ).status,
    ).toBe(400);
    expect(
      (await viewer.client.post(`/v1/together/${e.id}/contributions`, { body: 'x' })).status,
    ).toBe(403);
    expect(
      (await outsider.client.post(`/v1/together/${e.id}/contributions`, { body: 'x' })).status,
    ).toBe(404);
    expect((await anon().post(`/v1/together/${e.id}/contributions`, { body: 'x' })).status).toBe(
      401,
    );
    await contribute(o, e.id, { body: 'owner note' });
    expect(await notifCount(t, o.id, 'together_contribution')).toBe(1);
  });

  it("accepts a Real only if it is the contributor's own, exposing authenticity but not its location", async () => {
    const o = await signup(t);
    const c = await signup(t);
    const e = await experience(o);
    await join(o, e.id, c);
    const sess = (
      await c.client.post('/v1/real/capture-sessions', { deviceId: 'device-contrib-1' })
    ).body;
    const real = (
      await c.client.post('/v1/real/captures', {
        captureToken: sess.token,
        deviceId: 'device-contrib-1',
        rearMediaId: await media(c),
        capturedAt: new Date().toISOString(),
        visibility: 'private',
        latitude: 1,
        longitude: 2,
        caption: 'from the crowd',
      })
    ).body;
    const contrib = await contribute(c, e.id, { realCaptureId: real.id });
    expect(contrib.real).toMatchObject({ id: real.id, caption: 'from the crowd' });
    expect(contrib.real.authenticity.method).toBe('in_app_token');
    expect(JSON.stringify(contrib)).not.toContain('latitude');
    // the owner (not the Real's author) sees it in the timeline, and the private Real's picture is served to members via the experience only
    const seen = (await timeline(o.client, e.id)).body.items[0];
    expect(seen.real.rear.id).toBe(real.rear.id);
    expect(await canViewMedia(t.ctx.db, o.id, real.rear.id)).toBe(true);
    expect((await o.client.get(`/v1/real/captures/${real.id}`)).status).toBe(404);
    const stranger = await signup(t);
    expect(await canViewMedia(t.ctx.db, stranger.id, real.rear.id)).toBe(false);
    // someone else's Real is refused
    expect(
      (await o.client.post(`/v1/together/${e.id}/contributions`, { realCaptureId: real.id }))
        .status,
    ).toBe(400);
    // deleting the Real removes it from the experience
    await c.client.del(`/v1/real/captures/${real.id}`);
    expect((await timeline(o.client, e.id)).body.items).toEqual([]);
  });

  it('holds flagged text: only its author sees it; a moderation case is opened', async () => {
    const o = await signup(t);
    const c = await signup(t);
    const e = await experience(o);
    await join(o, e.id, c);
    const bad = await contribute(c, e.id, {
      body: 'I will kill you and your family, you are going to die tonight',
    });
    expect(bad.moderationStatus).not.toBe('approved');
    expect(await timelineTexts(c.client, e.id)).toHaveLength(1);
    expect(await timelineTexts(o.client, e.id)).toEqual([]);
    expect(
      (
        await sql(
          `SELECT count(*)::int AS n FROM moderation_cases WHERE target_type = 'experience_contribution' AND target_id = $1`,
          [bad.id],
        )
      ).rows[0].n,
    ).toBe(1);
  });

  it('closed and archived experiences take no new contributions but stay readable; reopen restores', async () => {
    const o = await signup(t);
    const c = await signup(t);
    const e = await experience(o);
    await join(o, e.id, c);
    await contribute(c, e.id, { body: 'before' });
    expect((await c.client.post(`/v1/together/${e.id}/close`)).status).toBe(403);
    expect((await o.client.post(`/v1/together/${e.id}/close`)).body.status).toBe('closed');
    expect(
      (await c.client.post(`/v1/together/${e.id}/contributions`, { body: 'late' })).status,
    ).toBe(409);
    expect((await c.client.get(`/v1/together/${e.id}`)).body.viewer.canContribute).toBe(false);
    expect(await timelineTexts(c.client, e.id)).toEqual(['before']);
    expect(
      (await o.client.post(`/v1/together/${e.id}/members`, { userId: (await signup(t)).id }))
        .status,
    ).toBe(409); // closed experiences take no invitations
    expect((await o.client.post(`/v1/together/${e.id}/reopen`)).body.status).toBe('open');
    await contribute(c, e.id, { body: 'after' });
    expect((await o.client.post(`/v1/together/${e.id}/archive`)).body.status).toBe('archived');
    expect((await o.client.patch(`/v1/together/${e.id}`, { title: 'x' })).status).toBe(409);
    expect((await o.client.get('/v1/together')).body.items).toEqual([]);
    expect(
      (await o.client.get('/v1/together', { includeArchived: 'true' })).body.items.map(
        (i: any) => i.id,
      ),
    ).toEqual([e.id]);
    expect(await timelineTexts(c.client, e.id)).toEqual(['before', 'after']);
    expect(await auditCount(t, 'together.closed', e.id)).toBe(1);
    expect(await auditCount(t, 'together.archived', e.id)).toBe(1);
  });

  it('contributors remove their own; the owner removes any; nobody else can', async () => {
    const o = await signup(t);
    const a = await signup(t);
    const b = await signup(t);
    const e = await experience(o);
    await join(o, e.id, a);
    await join(o, e.id, b);
    const ca = await contribute(a, e.id, { body: 'a' });
    const cb = await contribute(b, e.id, { body: 'b' });
    expect((await a.client.del(`/v1/together/${e.id}/contributions/${cb.id}`)).status).toBe(404); // not yours, not the owner
    expect((await anon().del(`/v1/together/${e.id}/contributions/${cb.id}`)).status).toBe(401);
    expect((await a.client.del(`/v1/together/${e.id}/contributions/${ca.id}`)).status).toBe(204);
    expect((await a.client.del(`/v1/together/${e.id}/contributions/${ca.id}`)).status).toBe(404);
    expect((await o.client.del(`/v1/together/${e.id}/contributions/${cb.id}`)).status).toBe(204);
    expect(await auditCount(t, 'together.contribution_removed_by_owner', e.id)).toBe(1);
    expect(await timelineTexts(o.client, e.id)).toEqual([]);
    expect(
      (await sql('SELECT body FROM shared_experience_contributions WHERE id = $1', [cb.id])).rows[0]
        .body,
    ).toBe('');
  });
});

describe('timeline', () => {
  it('merges every perspective chronologically with attribution, in either order, with pagination and a contributor filter', async () => {
    const o = await signup(t);
    const a = await signup(t);
    const b = await signup(t);
    const e = await experience(o);
    await join(o, e.id, a);
    await join(o, e.id, b);
    await contribute(b, e.id, { body: 't3', takenAt: '2026-06-01T10:03:00Z' });
    await contribute(a, e.id, { body: 't1', takenAt: '2026-06-01T10:01:00Z' });
    await contribute(o, e.id, { body: 't2', takenAt: '2026-06-01T10:02:00Z' });
    await contribute(a, e.id, { body: 't4', takenAt: '2026-06-01T10:04:00Z' });
    const asc = (await timeline(a.client, e.id)).body;
    expect(asc.items.map((i: any) => [i.text, i.contributor.username])).toEqual([
      ['t1', a.username],
      ['t2', o.username],
      ['t3', b.username],
      ['t4', a.username],
    ]);
    expect(asc.items[0].mine).toBe(true);
    expect(asc.items[1].mine).toBe(false);
    expect(
      (await timeline(a.client, e.id, { order: 'desc' })).body.items.map((i: any) => i.text),
    ).toEqual(['t4', 't3', 't2', 't1']);
    const p1 = (await timeline(a.client, e.id, { limit: '3' })).body;
    const p2 = (await timeline(a.client, e.id, { limit: '3', cursor: p1.nextCursor })).body;
    expect([...p1.items, ...p2.items].map((i: any) => i.text)).toEqual(['t1', 't2', 't3', 't4']);
    expect(p2.nextCursor).toBeNull();
    expect(
      (await timeline(a.client, e.id, { contributorId: a.id })).body.items.map((i: any) => i.text),
    ).toEqual(['t1', 't4']);
    expect((await a.client.get(`/v1/together/${e.id}`)).body.counts).toEqual({
      members: 3,
      contributions: 4,
    });
  });

  it('audience matrix: owner, member, viewer role, invited, friend, follower, stranger, blocked, anonymous', async () => {
    const o = await signup(t);
    const member = await signup(t);
    const viewer = await signup(t);
    const invited = await signup(t);
    const friend = await signup(t);
    const follower = await signup(t);
    const stranger = await signup(t);
    await befriend(o, friend);
    await follow(follower, o);
    const e = await experience(o, { visibility: 'private' });
    await join(o, e.id, member);
    await join(o, e.id, viewer, 'viewer');
    await befriend(o, invited);
    await o.client.post(`/v1/together/${e.id}/members`, { userId: invited.id });
    await contribute(member, e.id, { body: 'secret' });
    const matrix = async () =>
      Object.fromEntries(
        await Promise.all(
          Object.entries({ o, member, viewer, invited, friend, follower, stranger })
            .map(async ([k, u]) => [
              k,
              [await seesHeader(u.client, e.id), await timelineTexts(u.client, e.id)],
            ])
            .concat([
              (async () => [
                'anon',
                [await seesHeader(anon(), e.id), await timelineTexts(anon(), e.id)],
              ])() as any,
            ]),
        ),
      );
    const S = [true, ['secret']];
    const H = [true, []];
    const N = [false, null];
    expect(await matrix()).toEqual({
      o: S,
      member: S,
      viewer: S,
      invited: H,
      friend: N,
      follower: N,
      stranger: N,
      anon: N,
    });
    await sql(`UPDATE shared_experiences SET visibility = 'friends' WHERE id = $1`, [e.id]);
    expect(await matrix()).toEqual({
      o: S,
      member: S,
      viewer: S,
      invited: S,
      friend: S,
      follower: N,
      stranger: N,
      anon: N,
    }); // the invitee here is also the owner's friend
    await sql(`UPDATE shared_experiences SET visibility = 'public' WHERE id = $1`, [e.id]);
    expect(await matrix()).toEqual({
      o: S,
      member: S,
      viewer: S,
      invited: S,
      friend: S,
      follower: S,
      stranger: S,
      anon: S,
    });
    // media follows the same audience
    const m = await media(member);
    await contribute(member, e.id, { mediaId: m });
    expect(await canViewMedia(t.ctx.db, stranger.id, m)).toBe(true);
    expect(await canViewMedia(t.ctx.db, null, m)).toBe(true);
    await sql(`UPDATE shared_experiences SET visibility = 'private' WHERE id = $1`, [e.id]);
    expect(await canViewMedia(t.ctx.db, stranger.id, m)).toBe(false);
    expect(await canViewMedia(t.ctx.db, viewer.id, m)).toBe(true);
    expect(await canViewMedia(t.ctx.db, invited.id, m)).toBe(false);
  });

  it("blocks hide a contributor's perspectives both ways, and the whole experience from someone the owner blocks", async () => {
    const o = await signup(t);
    const a = await signup(t);
    const b = await signup(t);
    const e = await experience(o);
    await join(o, e.id, a);
    await join(o, e.id, b);
    await contribute(a, e.id, { body: 'from-a' });
    await contribute(b, e.id, { body: 'from-b' });
    expect(await timelineTexts(a.client, e.id)).toEqual(['from-a', 'from-b']);
    await block(a, b);
    expect(await timelineTexts(a.client, e.id)).toEqual(['from-a']);
    expect(await timelineTexts(b.client, e.id)).toEqual(['from-b']);
    expect(await timelineTexts(o.client, e.id)).toEqual(['from-a', 'from-b']);
    expect((await a.client.get(`/v1/together/${e.id}`)).body.counts.contributions).toBe(1);
    await block(o, a);
    expect(await seesHeader(a.client, e.id)).toBe(false);
    expect(await timelineTexts(a.client, e.id)).toBeNull();
  });

  it('under-18 contributions in a public experience are members-only', async () => {
    const o = await signup(t);
    const teen = await signup(t, { birthDate: teenBirth() });
    const stranger = await signup(t);
    const e = await experience(o, { visibility: 'friends' });
    await befriend(teen, o).catch(() => undefined);
    await join(o, e.id, teen);
    await contribute(teen, e.id, { body: 'teen note' });
    await contribute(o, e.id, { body: 'adult note' });
    await sql(`UPDATE shared_experiences SET visibility = 'public' WHERE id = $1`, [e.id]);
    expect(await timelineTexts(stranger.client, e.id)).toEqual(['adult note']);
    expect(await timelineTexts(anon(), e.id)).toEqual(['adult note']);
    expect(await timelineTexts(o.client, e.id)).toEqual(['teen note', 'adult note']);
    // and a teen cannot add to a public experience
    expect(
      (await teen.client.post(`/v1/together/${e.id}/contributions`, { body: 'more' })).status,
    ).toBe(422);
  });
});

describe('cover', () => {
  it("is the owner's pin, else the most-voted image, computed per viewer", async () => {
    const o = await signup(t);
    const a = await signup(t);
    const b = await signup(t);
    const e = await experience(o);
    await join(o, e.id, a);
    await join(o, e.id, b);
    const ca = await contribute(a, e.id, {
      mediaId: await media(a),
      takenAt: '2026-06-01T10:00:00Z',
    });
    const cb = await contribute(b, e.id, {
      mediaId: await media(b),
      takenAt: '2026-06-01T10:05:00Z',
    });
    const txt = await contribute(a, e.id, { body: 'no image' });
    expect((await o.client.get(`/v1/together/${e.id}`)).body.cover.contributionId).toBe(ca.id); // earliest by default
    await a.client.put(`/v1/together/${e.id}/cover`, { contributionId: cb.id });
    await b.client.put(`/v1/together/${e.id}/cover`, { contributionId: cb.id });
    expect((await o.client.get(`/v1/together/${e.id}`)).body.cover).toMatchObject({
      contributionId: cb.id,
      votes: 2,
      pinned: false,
    });
    expect(
      (await o.client.put(`/v1/together/${e.id}/cover`, { contributionId: ca.id })).body.cover,
    ).toMatchObject({ contributionId: ca.id, pinned: true });
    expect(
      (await o.client.put(`/v1/together/${e.id}/cover`, { contributionId: null })).body.cover
        .contributionId,
    ).toBe(cb.id);
    expect(
      (await o.client.put(`/v1/together/${e.id}/cover`, { contributionId: txt.id })).status,
    ).toBe(404); // must carry an image
    const viewer = await signup(t);
    await join(o, e.id, viewer, 'viewer');
    expect(
      (await viewer.client.put(`/v1/together/${e.id}/cover`, { contributionId: ca.id })).status,
    ).toBe(403);
    // a blocked contributor's picture is never the cover for the viewer who blocked them
    await block(a, b);
    expect((await a.client.get(`/v1/together/${e.id}`)).body.cover.contributionId).toBe(ca.id);
    await sql(`UPDATE shared_experience_contributions SET deleted_at = now() WHERE id = $1`, [
      ca.id,
    ]);
    expect((await o.client.get(`/v1/together/${e.id}`)).body.cover.contributionId).toBe(cb.id);
  });
});

describe('event link, suggestions and memory export', () => {
  async function pastEvent(host: TestUser, attendees: TestUser[]) {
    const { rows } = await sql(
      `INSERT INTO events (title, host_id, starts_at, ends_at, status, visibility) VALUES ('Lake party', $1, now() - interval '2 days', now() - interval '2 days' + interval '3 hours', 'completed', 'public') RETURNING id`,
      [host.id],
    );
    for (const u of attendees)
      await sql(
        `INSERT INTO event_attendees (event_id, user_id, status) VALUES ($1,$2,'attended')`,
        [rows[0].id, u.id],
      );
    return rows[0].id as string;
  }

  it('suggests only friends who attended the linked event and are not already in, never blocked or non-attending people', async () => {
    const o = await signup(t);
    const f1 = await signup(t);
    const f2 = await signup(t);
    const f3 = await signup(t);
    const notFriend = await signup(t);
    const blocked = await signup(t);
    for (const u of [f1, f2, f3, blocked]) await befriend(o, u);
    const ev = await pastEvent(o, [o, f1, f2, notFriend, blocked]);
    await block(o, blocked);
    const e = await experience(o, { eventId: ev });
    expect(
      (await o.client.get(`/v1/together/${e.id}/suggested-invites`)).body.suggestions
        .map((s: any) => s.userId)
        .sort(),
    ).toEqual([f1.id, f2.id].sort());
    await join(o, e.id, f1);
    expect(
      (await o.client.get(`/v1/together/${e.id}/suggested-invites`)).body.suggestions.map(
        (s: any) => s.userId,
      ),
    ).toEqual([f2.id]);
    expect((await f1.client.get(`/v1/together/${e.id}/suggested-invites`)).status).toBe(403);
    const none = await experience(o);
    expect((await o.client.get(`/v1/together/${none.id}/suggested-invites`)).body).toEqual({
      suggestions: [],
      reason: 'no_linked_event',
    });
    // an owner who did NOT attend learns nothing about who did
    const ev2 = await pastEvent(f3, [f3, f1]);
    const e2 = await experience(o, { eventId: ev2 });
    expect((await o.client.get(`/v1/together/${e2.id}/suggested-invites`)).body).toEqual({
      suggestions: [],
      reason: 'not_attended',
    });
    // cannot link an event you cannot see
    const { rows } = await sql(
      `INSERT INTO events (title, host_id, starts_at, status, visibility) VALUES ('Secret', $1, now() - interval '1 day', 'published', 'private') RETURNING id`,
      [f3.id],
    );
    expect((await o.client.post('/v1/together', { title: 'x', eventId: rows[0].id })).status).toBe(
      404,
    );
  });

  it('each member keeps their own private copy (their contributions only), once', async () => {
    const o = await signup(t);
    const c = await signup(t);
    const outsider = await signup(t);
    const e = await experience(o, { title: 'Road trip' });
    await join(o, e.id, c);
    const cm = await media(c);
    await contribute(c, e.id, { mediaId: cm });
    await contribute(o, e.id, { mediaId: await media(o) });
    expect((await outsider.client.post(`/v1/together/${e.id}/memory`)).status).toBe(404);
    expect((await anon().post(`/v1/together/${e.id}/memory`)).status).toBe(401);
    const r = await c.client.post(`/v1/together/${e.id}/memory`);
    expect(r.status).toBe(201);
    const mem = (await c.client.get(`/v1/memories/${r.body.memoryId}`)).body;
    expect(mem).toMatchObject({ title: 'Road trip', privacy: 'private', kind: 'collection' });
    expect(mem.items.map((i: any) => i.type).sort()).toEqual(['experience', 'media']);
    expect(mem.links.map((l: any) => l.type)).toEqual(['experience']);
    expect((await c.client.post(`/v1/together/${e.id}/memory`)).status).toBe(409);
    expect((await o.client.get(`/v1/memories/${r.body.memoryId}`)).status).toBe(404); // a copy is private to its member
    await setFlag('MEMORY', false);
    try {
      expect((await o.client.post(`/v1/together/${e.id}/memory`)).status).toBe(404);
    } finally {
      await setFlag('MEMORY', true);
    }
  });
});

describe('deletion, propagation, flag', () => {
  it('deleting an experience hides everything, and memory items pointing at it vanish', async () => {
    const o = await signup(t);
    const c = await signup(t);
    const e = await experience(o);
    await join(o, e.id, c);
    const cm = await media(c);
    await contribute(c, e.id, { mediaId: cm, body: 'gone soon' });
    const mem = await c.client.post(`/v1/together/${e.id}/memory`);
    expect((await c.client.del(`/v1/together/${e.id}`)).status).toBe(403);
    expect((await o.client.del(`/v1/together/${e.id}`)).status).toBe(204);
    expect((await c.client.get(`/v1/together/${e.id}`)).status).toBe(404);
    expect((await o.client.get(`/v1/together/${e.id}`)).status).toBe(404);
    expect(await canViewMedia(t.ctx.db, o.id, cm)).toBe(false);
    expect(
      (
        await sql(
          'SELECT count(*)::int AS n FROM shared_experience_contributions WHERE experience_id = $1 AND deleted_at IS NULL',
          [e.id],
        )
      ).rows[0].n,
    ).toBe(0);
    expect(
      (
        await sql(
          `SELECT count(*)::int AS n FROM memory_items WHERE item_type = 'experience' AND item_id = $1`,
          [e.id],
        )
      ).rows[0].n,
    ).toBe(0);
    expect(
      (await c.client.get(`/v1/memories/${mem.body.memoryId}`)).body.items.map((i: any) => i.type),
    ).toEqual(['media']);
    expect(await auditCount(t, 'together.deleted', e.id)).toBe(1);
  });

  it('account deletion hands the experience to the longest-standing contributor, or deletes it when nobody is left', async () => {
    const o = await signup(t);
    const c1 = await signup(t);
    const c2 = await signup(t);
    const lone = await signup(t);
    const shared = await experience(o);
    await join(o, shared.id, c1);
    await join(o, shared.id, c2);
    await contribute(o, shared.id, { body: 'owner text' });
    await contribute(c2, shared.id, { body: 'c2 text' });
    const solo = await experience(lone);
    await contribute(lone, solo.id, { body: 'solo' });
    const run = (u: TestUser) =>
      withTransaction(t.ctx.db, async (tx) => {
        for (const h of getDeletionHooks()) await h(t.ctx, tx, u.id);
      });
    await run(o);
    const row = (
      await sql('SELECT owner_id, deleted_at FROM shared_experiences WHERE id = $1', [shared.id])
    ).rows[0];
    expect(row.owner_id).toBe(c1.id);
    expect(row.deleted_at).toBeNull();
    expect(
      (
        await sql(
          `SELECT role FROM shared_experience_members WHERE experience_id = $1 AND user_id = $2`,
          [shared.id, c1.id],
        )
      ).rows[0].role,
    ).toBe('owner');
    expect(await timelineTexts(c1.client, shared.id)).toEqual(['c2 text']);
    await run(lone);
    expect(
      (await sql('SELECT deleted_at FROM shared_experiences WHERE id = $1', [solo.id])).rows[0]
        .deleted_at,
    ).not.toBeNull();
    // the export section only contains the person's own data
    expect(
      (
        await sql(`SELECT count(*)::int AS n FROM shared_experience_members WHERE user_id = $1`, [
          o.id,
        ])
      ).rows[0].n,
    ).toBe(0);
  });

  it('REAL_TOGETHER off hides every endpoint', async () => {
    const o = await signup(t);
    const e = await experience(o);
    await setFlag('REAL_TOGETHER', false);
    try {
      for (const [m, url] of [
        ['get', '/v1/together'],
        ['get', `/v1/together/${e.id}`],
        ['get', `/v1/together/${e.id}/timeline`],
        ['post', '/v1/together'],
        ['get', `/v1/users/${o.username}/experiences`],
      ] as const) {
        const r = m === 'post' ? await o.client.post(url, { title: 'x' }) : await o.client.get(url);
        expect([r.status, r.body?.error?.code]).toEqual([404, 'feature_disabled']);
      }
      expect((await anon().get(`/v1/together/${e.id}`)).status).toBe(404);
    } finally {
      await setFlag('REAL_TOGETHER', true);
    }
    expect((await o.client.get(`/v1/together/${e.id}`)).status).toBe(200);
  });

  it('paginates my experiences newest first and rejects bad ids', async () => {
    const o = await signup(t);
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) ids.push((await experience(o, { title: `Exp ${i}` })).id);
    const p1 = (await o.client.get('/v1/together', { limit: '3' })).body;
    const p2 = (await o.client.get('/v1/together', { limit: '3', cursor: p1.nextCursor })).body;
    expect([...p1.items, ...p2.items].map((i: any) => i.id)).toEqual([...ids].reverse());
    expect(p2.nextCursor).toBeNull();
    expect((await o.client.get('/v1/together/nope')).status).toBe(400);
    expect((await o.client.get('/v1/together/00000000-0000-4000-8000-000000000000')).status).toBe(
      404,
    );
  });
});
