import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTransaction } from '@yapilapi/database';
import {
  Client,
  createTestApp,
  makeStaff,
  signup,
  uniq,
  type TestApp,
  type TestUser,
} from './helpers.js';
import { auditCount, block, inDays, insertImage, notifCount, teenBirth } from './entity-helpers.js';
import { getDeletionHooks } from '../src/lib/hooks.js';
import {
  expireStaleBookings,
  getAuthorizedBusinessKnowledge,
} from '../src/modules/business/index.js';
import { knowledgeHash } from '../src/modules/business/service.js';

let t: TestApp;
let moderator: TestUser;
let supportStaff: TestUser;
beforeAll(async () => {
  t = await createTestApp();
  moderator = await signup(t);
  await makeStaff(t, moderator, 'moderator');
  supportStaff = await signup(t);
  await makeStaff(t, supportStaff, 'support');
});
afterAll(async () => {
  await t.close();
});

const anon = () => new Client(t);
const sql = (q: string, p: unknown[] = []) => t.ctx.db.query(q, p);
const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const ALL_DAY = Object.fromEntries(DAYS.map((d) => [d, [['00:00', '24:00']]]));
const WEEKDAYS_9_17 = Object.fromEntries(DAYS.slice(0, 5).map((d) => [d, [['09:00', '17:00']]]));

/** A UTC wall-clock instant `daysAhead` days from now. */
const atUtc = (daysAhead: number, hour: number, minute = 0): Date => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysAhead);
  d.setUTCHours(hour, minute, 0, 0);
  return d;
};
/** The next date (at least 2 days ahead) that falls on `dow` (0=Sunday) at the given UTC hour. */
const nextDow = (dow: number, hour: number, minute = 0): Date => {
  for (let i = 2; i < 10; i++) {
    const d = atUtc(i, hour, minute);
    if (d.getUTCDay() === dow) return d;
  }
  throw new Error('unreachable');
};

async function mkBusiness(u: TestUser, over: Record<string, unknown> = {}) {
  const r = await u.client.post('/v1/businesses', {
    name: `Biz ${uniq('b')}`,
    category: 'food',
    ...over,
  });
  if (r.status !== 201)
    throw new Error(`create business failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body as any;
}
async function addTeam(owner: TestUser, bizId: string, role: 'admin' | 'editor' | 'support') {
  const u = await signup(t);
  const inv = await owner.client.post(`/v1/businesses/${bizId}/invitations`, {
    username: u.username,
    role,
  });
  if (inv.status !== 201)
    throw new Error(`invite failed ${inv.status} ${JSON.stringify(inv.body)}`);
  expect((await u.client.post(`/v1/businesses/${bizId}/invitation/accept`)).status).toBe(200);
  return u;
}
/** Owner + business with a full team, one user per role. */
async function team(over: Record<string, unknown> = {}) {
  const owner = await signup(t);
  const biz = await mkBusiness(owner, over);
  return {
    owner,
    biz,
    admin: await addTeam(owner, biz.id, 'admin'),
    editor: await addTeam(owner, biz.id, 'editor'),
    support: await addTeam(owner, biz.id, 'support'),
    stranger: await signup(t),
  };
}
async function mkPlace(u: TestUser, over: Record<string, unknown> = {}) {
  const r = await u.client.post('/v1/places', {
    name: `Venue ${uniq('v')}`,
    kind: 'venue',
    latitude: 20 + Math.random() * 40,
    longitude: 20 + Math.random() * 40,
    ...over,
  });
  if (r.status !== 201)
    throw new Error(`create place failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body as any;
}
/** A business with an approved place that accepts bookings (party-size capacity). */
async function bookablePlace(capacity = 4, settings: Record<string, unknown> = {}) {
  const owner = await signup(t);
  const biz = await mkBusiness(owner, { hours: ALL_DAY });
  const place = await mkPlace(owner, { capacity, hours: ALL_DAY });
  const c = await owner.client.post(`/v1/places/${place.id}/claims`, { businessId: biz.id });
  expect(
    (await moderator.client.post(`/v1/staff/place-claims/${c.body.id}/approve`, {})).status,
  ).toBe(200);
  expect(
    (await owner.client.patch(`/v1/places/${place.id}`, { bookingEnabled: true })).status,
  ).toBe(200);
  if (Object.keys(settings).length)
    expect(
      (await owner.client.patch(`/v1/businesses/${biz.id}`, { bookingSettings: settings })).status,
    ).toBe(200);
  return { owner, biz, place };
}
/** A business with one bookable service (one customer per time slot). */
async function bookableService(
  over: Record<string, unknown> = {},
  settings: Record<string, unknown> = {},
) {
  const owner = await signup(t);
  const biz = await mkBusiness(owner, { hours: ALL_DAY, ...over });
  if (Object.keys(settings).length)
    expect(
      (await owner.client.patch(`/v1/businesses/${biz.id}`, { bookingSettings: settings })).status,
    ).toBe(200);
  const svc = await owner.client.post(`/v1/businesses/${biz.id}/services`, {
    title: 'Consultation',
    priceCents: 5000,
  });
  expect(svc.status).toBe(201);
  return { owner, biz, service: svc.body as any };
}
const book = (
  u: TestUser,
  target: { placeId?: string; productId?: string },
  startsAt: Date,
  over: Record<string, unknown> = {},
) =>
  u.client.post('/v1/bookings', {
    ...target,
    startsAt: startsAt.toISOString(),
    durationMinutes: 60,
    ...over,
  });
const statusOf = async (id: string) =>
  (await sql('SELECT status FROM bookings WHERE id = $1', [id])).rows[0].status as string;

describe('business profiles', () => {
  it('creates a business with the creator as owner, by slug or id, with audit', async () => {
    const u = await signup(t);
    const b = await mkBusiness(u, {
      name: 'Sunrise Bakery',
      slug: `sunrise-${uniq('s')}`.slice(0, 40),
      description: 'Fresh bread',
      legalName: 'Sunrise Bakery Ltd',
      contact: {
        email: 'hi@bakery.example',
        phone: '+44 20 7946 0000',
        website: 'https://bakery.example',
      },
      hours: WEEKDAYS_9_17,
      timezone: 'Europe/London',
      links: [{ label: 'Menu', url: 'https://bakery.example/menu' }],
    });
    expect(b).toMatchObject({
      name: 'Sunrise Bakery',
      category: 'food',
      verified: false,
      followerCount: 0,
      legalName: 'Sunrise Bakery Ltd',
      status: 'active',
      ownerId: u.id,
      timezone: 'Europe/London',
      viewer: { role: 'owner' },
    });
    expect(b.viewer.permissions).toContain('business.delete');
    expect(await auditCount(t, 'business.created', b.id)).toBe(1);
    const bySlug = await anon().get(`/v1/businesses/${b.slug.toUpperCase()}`);
    expect(bySlug.status).toBe(200);
    expect(bySlug.body.id).toBe(b.id);
    expect(bySlug.body).not.toHaveProperty('legalName'); // team-only fields stay private
    expect(bySlug.body).not.toHaveProperty('ownerId');
    expect(bySlug.body.viewer).toMatchObject({ role: null, following: false });
    expect((await anon().get(`/v1/businesses/${b.id}`)).body.slug).toBe(b.slug);
    expect((await u.client.get('/v1/me/businesses')).body.items.map((x: any) => x.id)).toContain(
      b.id,
    );
    expect((await anon().get('/v1/businesses/no-such-business')).status).toBe(404);
  });

  it('validates input, reserves names, generates unique slugs and refuses teens', async () => {
    const u = await signup(t);
    expect((await anon().post('/v1/businesses', { name: 'Anon Shop' })).status).toBe(401);
    expect((await u.client.post('/v1/businesses', { name: 'x' })).status).toBe(400);
    expect(
      (await u.client.post('/v1/businesses', { name: 'Bad Slug', slug: 'Not Allowed!' })).status,
    ).toBe(400);
    expect(
      (await u.client.post('/v1/businesses', { name: 'Reserved', slug: 'admin' })).status,
    ).toBe(400);
    expect(
      (
        await u.client.post('/v1/businesses', {
          name: 'Bad Hours',
          hours: {
            mon: [
              ['17:00', '09:00'],
              ['08:00', '18:00'],
            ],
          },
        })
      ).status,
    ).toBe(400);
    expect(
      (await u.client.post('/v1/businesses', { name: 'Bad Zone', timezone: 'Nowhere/Land' }))
        .status,
    ).toBe(400);
    expect(
      (await u.client.post('/v1/businesses', { name: 'Bad Contact', contact: { email: 'nope' } }))
        .status,
    ).toBe(400);
    expect(
      (
        await u.client.post('/v1/businesses', {
          name: 'Bad Link',
          links: [{ label: 'x', url: 'javascript:alert(1)' }],
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await u.client.post('/v1/businesses', {
          name: 'Spam Shop',
          description: 'Give me your seed phrase and private key then send it to me',
        })
      ).status,
    ).toBe(422);
    const teen = await signup(t, { birthDate: teenBirth() });
    expect((await teen.client.post('/v1/businesses', { name: 'Teen Shop' })).status).toBe(422);
    const first = await mkBusiness(u, { name: `Same Name ${uniq('n')}`.slice(0, 30) });
    const second = await u.client.post('/v1/businesses', { name: first.name });
    expect(second.status).toBe(201); // auto-suffixed slug
    expect(second.body.slug).not.toBe(first.slug);
    expect(
      (await u.client.post('/v1/businesses', { name: 'Explicit', slug: first.slug })).status,
    ).toBe(409);
    // ownership of another user's image is refused
    const other = await signup(t);
    expect(
      (
        await u.client.post('/v1/businesses', {
          name: 'Logo Thief',
          logoMediaId: await insertImage(t, other.id),
        })
      ).status,
    ).toBe(400);
    const withLogo = await mkBusiness(u, { logoMediaId: await insertImage(t, u.id) });
    expect((await anon().get(`/v1/businesses/${withLogo.id}`)).body.logoUrl).toContain('.jpg');
  });

  it('edits by role: owner and admin may; editor, support, strangers and anonymous may not', async () => {
    const { owner, biz, admin, editor, support, stranger } = await team();
    const patch = (u: TestUser, body: Record<string, unknown>) =>
      u.client.patch(`/v1/businesses/${biz.id}`, body);
    expect((await anon().patch(`/v1/businesses/${biz.id}`, { name: 'Nope nope' })).status).toBe(
      401,
    );
    expect((await patch(stranger, { name: 'Hijacked' })).status).toBe(404);
    expect((await patch(support, { name: 'Hijacked' })).status).toBe(403);
    expect((await patch(editor, { name: 'Hijacked' })).status).toBe(403);
    expect((await patch(admin, {})).status).toBe(400);
    const ok = await patch(admin, {
      description: 'Updated by admin',
      hours: WEEKDAYS_9_17,
      timezone: 'America/New_York',
      contact: { phone: '+1 555 0100' },
      bookingSettings: { slotMinutes: 15, autoConfirm: true },
    });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({
      description: 'Updated by admin',
      timezone: 'America/New_York',
      bookingSettings: { slotMinutes: 15, autoConfirm: true, maxPartySize: 20 },
    });
    // settings merge instead of resetting
    expect(
      (await patch(owner, { bookingSettings: { maxPartySize: 6 } })).body.bookingSettings,
    ).toMatchObject({ slotMinutes: 15, autoConfirm: true, maxPartySize: 6 });
    expect((await patch(owner, { bookingSettings: { slotMinutes: 1 } })).status).toBe(400);
    expect((await patch(owner, { bookingSettings: { bogus: true } })).status).toBe(400);
    expect((await patch(owner, { hours: { mon: [['09:00', '17:00']], noday: [] } })).status).toBe(
      400,
    );
    expect(
      (await patch(owner, { name: 'Give me your seed phrase and private key then send it to me' }))
        .status,
    ).toBe(422);
    expect((await patch(owner, { logoMediaId: await insertImage(t, admin.id) })).status).toBe(400); // must be uploaded by the editor
    expect((await patch(admin, { logoMediaId: await insertImage(t, admin.id) })).status).toBe(200);
    expect((await patch(admin, { logoMediaId: null })).status).toBe(200);
    expect(await auditCount(t, 'business.updated', biz.id)).toBeGreaterThanOrEqual(3);
  });

  it('never lets owners verify themselves: only staff (with MFA) set the flag, with audit', async () => {
    const { owner, biz, admin } = await team();
    expect((await owner.client.patch(`/v1/businesses/${biz.id}`, { verified: true })).status).toBe(
      400,
    ); // unknown key is stripped: nothing to update
    const sneaky = await owner.client.patch(`/v1/businesses/${biz.id}`, {
      description: 'Verified official',
      verified: true,
      verifiedAt: new Date().toISOString(),
      verified_at: new Date().toISOString(),
    });
    expect(sneaky.body.verified).toBe(false);
    expect(
      (await sql('SELECT verified_at FROM businesses WHERE id = $1', [biz.id])).rows[0].verified_at,
    ).toBeNull();
    for (const who of [owner, admin, await signup(t), supportStaff])
      expect((await who.client.post(`/v1/staff/businesses/${biz.id}/verify`, {})).status).toBe(403);
    expect((await anon().post(`/v1/staff/businesses/${biz.id}/verify`, {})).status).toBe(401);
    // a moderator who has not enrolled in MFA is refused too
    const noMfa = await signup(t);
    await sql(`UPDATE users SET platform_role = 'moderator' WHERE id = $1`, [noMfa.id]);
    expect((await noMfa.client.post(`/v1/staff/businesses/${biz.id}/verify`, {})).status).toBe(403);
    const ok = await moderator.client.post(`/v1/staff/businesses/${biz.id}/verify`, {
      note: 'Registry checked',
    });
    expect(ok.body).toEqual({ id: biz.id, verified: true });
    expect((await anon().get(`/v1/businesses/${biz.id}`)).body).toMatchObject({ verified: true });
    expect(
      (await sql('SELECT verified_by FROM businesses WHERE id = $1', [biz.id])).rows[0].verified_by,
    ).toBe(moderator.id);
    expect(await notifCount(t, owner.id, 'business_verified')).toBe(1);
    const log = (
      await sql(
        `SELECT actor_id, actor_type, metadata FROM audit_logs WHERE action = 'business.verified' AND target_id = $1`,
        [biz.id],
      )
    ).rows;
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ actor_id: moderator.id, actor_type: 'staff' });
    // idempotent: no second audit entry or notification
    await moderator.client.post(`/v1/staff/businesses/${biz.id}/verify`, {});
    expect(await auditCount(t, 'business.verified', biz.id)).toBe(1);
    expect(
      (
        await moderator.client.get('/v1/businesses', { verified: 'true', q: biz.name })
      ).body.items.map((x: any) => x.id),
    ).toContain(biz.id);
    await moderator.client.post(`/v1/staff/businesses/${biz.id}/unverify`, {});
    expect((await anon().get(`/v1/businesses/${biz.id}`)).body.verified).toBe(false);
    expect(await auditCount(t, 'business.unverified', biz.id)).toBe(1);
    expect(
      (await moderator.client.post(`/v1/staff/businesses/${crypto.randomUUID()}/verify`, {}))
        .status,
    ).toBe(404);
  });

  it('lets staff suspend and reinstate: hidden from the public, read-only for the team', async () => {
    const { owner, biz, stranger } = await team();
    expect(
      (
        await owner.client.put(`/v1/staff/businesses/${biz.id}/status`, {
          status: 'suspended',
          reason: 'Fraud',
        })
      ).status,
    ).toBe(403);
    expect(
      (await moderator.client.put(`/v1/staff/businesses/${biz.id}/status`, { status: 'suspended' }))
        .status,
    ).toBe(400);
    expect(
      (
        await moderator.client.put(`/v1/staff/businesses/${biz.id}/status`, {
          status: 'suspended',
          reason: 'Suspected fraud',
        })
      ).status,
    ).toBe(200);
    expect((await stranger.client.get(`/v1/businesses/${biz.id}`)).status).toBe(404);
    expect((await moderator.client.get('/v1/businesses', { q: biz.name })).body.items).toHaveLength(
      0,
    );
    const own = await owner.client.get(`/v1/businesses/${biz.id}`);
    expect(own.status).toBe(200);
    expect(own.body.status).toBe('suspended');
    expect(
      (await owner.client.patch(`/v1/businesses/${biz.id}`, { description: 'Still editing' }))
        .status,
    ).toBe(403);
    expect(
      (await owner.client.post(`/v1/businesses/${biz.id}/offers`, { title: 'Sale sale' })).status,
    ).toBe(403);
    expect(await notifCount(t, owner.id, 'business_suspended')).toBe(1);
    expect(
      (
        await moderator.client.put(`/v1/staff/businesses/${biz.id}/status`, {
          status: 'active',
          reason: 'Cleared',
        })
      ).status,
    ).toBe(200);
    expect((await stranger.client.get(`/v1/businesses/${biz.id}`)).status).toBe(200);
    expect(
      (await owner.client.patch(`/v1/businesses/${biz.id}`, { description: 'Back in business' }))
        .status,
    ).toBe(200);
    expect(await auditCount(t, 'business.suspended', biz.id)).toBe(1);
  });

  it('hides businesses from users blocked by the owner, in both directions, and paginates the directory', async () => {
    const owner = await signup(t);
    const blocked = await signup(t);
    const tag = uniq('zdir');
    const names = ['Alpha', 'Bravo', 'Charlie'].map((n) => `${n} ${tag}`);
    for (const n of names) await mkBusiness(owner, { name: n, category: 'Cafe' });
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 5; i++) {
      const r = await anon().get('/v1/businesses', {
        q: tag,
        limit: '2',
        ...(cursor ? { cursor } : {}),
      });
      seen.push(...r.body.items.map((x: any) => x.name));
      cursor = r.body.nextCursor ?? undefined;
      if (!cursor) break;
    }
    expect(seen).toEqual(names);
    expect(
      (await anon().get('/v1/businesses', { q: tag, category: 'cafe' })).body.items,
    ).toHaveLength(3);
    await block(owner, blocked);
    expect((await blocked.client.get('/v1/businesses', { q: tag })).body.items).toHaveLength(0);
    const one = (await anon().get('/v1/businesses', { q: tag })).body.items[0];
    expect((await blocked.client.get(`/v1/businesses/${one.id}`)).status).toBe(404);
    expect((await blocked.client.put(`/v1/businesses/${one.id}/follow`)).status).toBe(404);
  });
});

describe('team management', () => {
  it('invites, accepts, changes roles and removes members under the role hierarchy', async () => {
    const { owner, biz, admin, editor, support, stranger } = await team();
    const newbie = await signup(t);
    // who may invite whom
    expect(
      (
        await editor.client.post(`/v1/businesses/${biz.id}/invitations`, {
          username: newbie.username,
          role: 'support',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await support.client.post(`/v1/businesses/${biz.id}/invitations`, {
          username: newbie.username,
          role: 'support',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await stranger.client.post(`/v1/businesses/${biz.id}/invitations`, {
          username: newbie.username,
          role: 'support',
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await admin.client.post(`/v1/businesses/${biz.id}/invitations`, {
          username: newbie.username,
          role: 'admin',
        })
      ).status,
    ).toBe(403); // not above own rank
    expect(
      (
        await owner.client.post(`/v1/businesses/${biz.id}/invitations`, {
          username: newbie.username,
          role: 'owner',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await owner.client.post(`/v1/businesses/${biz.id}/invitations`, {
          username: editor.username,
          role: 'support',
        })
      ).status,
    ).toBe(409); // already on the team
    expect(
      (
        await owner.client.post(`/v1/businesses/${biz.id}/invitations`, {
          username: owner.username,
          role: 'admin',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await owner.client.post(`/v1/businesses/${biz.id}/invitations`, {
          username: 'nobody-here-xyz',
          role: 'admin',
        })
      ).status,
    ).toBe(404);
    const teen = await signup(t, { birthDate: teenBirth() });
    expect(
      (
        await owner.client.post(`/v1/businesses/${biz.id}/invitations`, {
          username: teen.username,
          role: 'support',
        })
      ).status,
    ).toBe(422);
    const inv = await admin.client.post(`/v1/businesses/${biz.id}/invitations`, {
      username: newbie.username,
      role: 'editor',
    });
    expect(inv.status).toBe(201);
    expect(
      (
        await admin.client.post(`/v1/businesses/${biz.id}/invitations`, {
          username: newbie.username,
          role: 'editor',
        })
      ).status,
    ).toBe(200); // idempotent re-invite
    expect(await notifCount(t, newbie.id, 'business_team_invitation')).toBe(1);
    // an invitation grants nothing until accepted
    expect((await newbie.client.get(`/v1/businesses/${biz.id}/team`)).status).toBe(404);
    expect((await newbie.client.get('/v1/me/business-invitations')).body.items).toMatchObject([
      { businessId: biz.id, role: 'editor' },
    ]);
    expect((await stranger.client.post(`/v1/businesses/${biz.id}/invitation/accept`)).status).toBe(
      404,
    );
    expect(
      (await admin.client.get(`/v1/businesses/${biz.id}/invitations`)).body.items,
    ).toHaveLength(1);
    expect((await editor.client.get(`/v1/businesses/${biz.id}/invitations`)).status).toBe(403);
    expect((await newbie.client.post(`/v1/businesses/${biz.id}/invitation/accept`)).body).toEqual({
      businessId: biz.id,
      role: 'editor',
    });
    expect((await newbie.client.post(`/v1/businesses/${biz.id}/invitation/accept`)).status).toBe(
      404,
    );
    const roster = await newbie.client.get(`/v1/businesses/${biz.id}/team`);
    expect(roster.body.items.map((m: any) => m.role)).toEqual([
      'owner',
      'admin',
      'editor',
      'editor',
      'support',
    ]);
    expect(roster.body.roles.support).toEqual(['bookings.manage', 'reviews.reply']);
    expect((await stranger.client.get(`/v1/businesses/${biz.id}/team`)).status).toBe(404);
    // decline and revoke
    const declines = await signup(t);
    await owner.client.post(`/v1/businesses/${biz.id}/invitations`, {
      username: declines.username,
      role: 'support',
    });
    expect((await declines.client.post(`/v1/businesses/${biz.id}/invitation/decline`)).status).toBe(
      204,
    );
    expect((await declines.client.post(`/v1/businesses/${biz.id}/invitation/accept`)).status).toBe(
      404,
    );
    const revoked = await signup(t);
    await owner.client.post(`/v1/businesses/${biz.id}/invitations`, {
      username: revoked.username,
      role: 'support',
    });
    expect(
      (await editor.client.del(`/v1/businesses/${biz.id}/invitations/${revoked.id}`)).status,
    ).toBe(403);
    expect(
      (await owner.client.del(`/v1/businesses/${biz.id}/invitations/${revoked.id}`)).status,
    ).toBe(204);
    expect((await revoked.client.post(`/v1/businesses/${biz.id}/invitation/accept`)).status).toBe(
      404,
    );
    // role changes
    expect(
      (await admin.client.patch(`/v1/businesses/${biz.id}/team/${support.id}`, { role: 'editor' }))
        .status,
    ).toBe(200);
    expect(
      (await admin.client.patch(`/v1/businesses/${biz.id}/team/${support.id}`, { role: 'admin' }))
        .status,
    ).toBe(403);
    expect(
      (await admin.client.patch(`/v1/businesses/${biz.id}/team/${admin.id}`, { role: 'support' }))
        .status,
    ).toBe(403); // not your own
    expect(
      (await admin.client.patch(`/v1/businesses/${biz.id}/team/${owner.id}`, { role: 'support' }))
        .status,
    ).toBe(403);
    expect(
      (
        await editor.client.patch(`/v1/businesses/${biz.id}/team/${support.id}`, {
          role: 'support',
        })
      ).status,
    ).toBe(403);
    expect(
      (await owner.client.patch(`/v1/businesses/${biz.id}/team/${owner.id}`, { role: 'admin' }))
        .status,
    ).toBe(403);
    expect(
      (await owner.client.patch(`/v1/businesses/${biz.id}/team/${stranger.id}`, { role: 'admin' }))
        .status,
    ).toBe(404);
    expect(await notifCount(t, support.id, 'business_role_changed')).toBe(1);
    expect(await auditCount(t, 'business.team_role_changed', biz.id)).toBe(1);
    // removal
    expect((await editor.client.del(`/v1/businesses/${biz.id}/team/${admin.id}`)).status).toBe(403);
    expect((await admin.client.del(`/v1/businesses/${biz.id}/team/${owner.id}`)).status).toBe(403);
    expect((await owner.client.del(`/v1/businesses/${biz.id}/team/${owner.id}`)).status).toBe(403);
    expect((await admin.client.del(`/v1/businesses/${biz.id}/team/${editor.id}`)).status).toBe(204);
    expect((await editor.client.get(`/v1/businesses/${biz.id}/team`)).status).toBe(404); // access is gone immediately
    expect((await support.client.del(`/v1/businesses/${biz.id}/team/${support.id}`)).status).toBe(
      204,
    ); // leaving
    expect((await stranger.client.del(`/v1/businesses/${biz.id}/team/${admin.id}`)).status).toBe(
      404,
    );
  });

  it('transfers ownership to a team member (owner only), keeping exactly one owner', async () => {
    const { owner, biz, admin, editor, stranger } = await team();
    expect(
      (await admin.client.post(`/v1/businesses/${biz.id}/transfer-ownership`, { userId: admin.id }))
        .status,
    ).toBe(403);
    expect(
      (await owner.client.post(`/v1/businesses/${biz.id}/transfer-ownership`, { userId: owner.id }))
        .status,
    ).toBe(400);
    expect(
      (
        await owner.client.post(`/v1/businesses/${biz.id}/transfer-ownership`, {
          userId: stranger.id,
        })
      ).status,
    ).toBe(404);
    expect(
      (await owner.client.post(`/v1/businesses/${biz.id}/transfer-ownership`, { userId: admin.id }))
        .body,
    ).toEqual({ ownerId: admin.id });
    const roles = (
      await sql(
        `SELECT user_id, role FROM business_members WHERE business_id = $1 AND role = 'owner'`,
        [biz.id],
      )
    ).rows;
    expect(roles).toEqual([{ user_id: admin.id, role: 'owner' }]);
    expect(
      (await sql('SELECT owner_id FROM businesses WHERE id = $1', [biz.id])).rows[0].owner_id,
    ).toBe(admin.id);
    expect(
      (await owner.client.get(`/v1/businesses/${biz.id}/team`)).body.items.find(
        (m: any) => m.user.id === owner.id,
      ).role,
    ).toBe('admin');
    expect(
      (
        await owner.client.post(`/v1/businesses/${biz.id}/transfer-ownership`, {
          userId: editor.id,
        })
      ).status,
    ).toBe(403); // no longer owner
    expect(await notifCount(t, admin.id, 'business_ownership_received')).toBe(1);
    expect(await auditCount(t, 'business.ownership_transferred', biz.id)).toBe(1);
  });

  it('closing the business is owner-only and cancels bookings and events, releasing places', async () => {
    const { owner, biz, admin, stranger } = await team({ hours: ALL_DAY });
    const place = await mkPlace(owner, { capacity: 4, hours: ALL_DAY });
    const c = await owner.client.post(`/v1/places/${place.id}/claims`, { businessId: biz.id });
    await moderator.client.post(`/v1/staff/place-claims/${c.body.id}/approve`, {});
    await owner.client.patch(`/v1/places/${place.id}`, { bookingEnabled: true });
    const customer = await signup(t);
    const bk = await book(customer, { placeId: place.id }, atUtc(3, 12));
    expect(bk.status).toBe(201);
    const ev = await owner.client.post('/v1/events', {
      title: 'Grand opening',
      startsAt: inDays(4),
      endsAt: inDays(4, 2),
      locationText: 'Here',
      publish: true,
      businessId: biz.id,
    });
    expect(ev.status).toBe(201);
    await customer.client.put(`/v1/events/${ev.body.id}/rsvp`, { status: 'going' });
    expect((await admin.client.del(`/v1/businesses/${biz.id}`)).status).toBe(403);
    expect((await stranger.client.del(`/v1/businesses/${biz.id}`)).status).toBe(404);
    expect((await owner.client.del(`/v1/businesses/${biz.id}`)).status).toBe(204);
    expect(await statusOf(bk.body.id)).toBe('cancelled');
    expect(
      (await sql('SELECT cancelled_by FROM bookings WHERE id = $1', [bk.body.id])).rows[0]
        .cancelled_by,
    ).toBe('business');
    expect(await notifCount(t, customer.id, 'booking_cancelled')).toBe(1);
    expect(
      (await sql('SELECT status FROM events WHERE id = $1', [ev.body.id])).rows[0].status,
    ).toBe('cancelled');
    expect(await notifCount(t, customer.id, 'event_cancelled')).toBe(1);
    expect(
      (await sql('SELECT business_id, booking_enabled FROM places WHERE id = $1', [place.id]))
        .rows[0],
    ).toEqual({ business_id: null, booking_enabled: false });
    expect((await anon().get(`/v1/businesses/${biz.id}`)).status).toBe(404);
    expect((await owner.client.get(`/v1/businesses/${biz.id}`)).status).toBe(404);
    expect(await auditCount(t, 'business.closed', biz.id)).toBe(1);
  });
});

describe('offers', () => {
  it('lets owners, admins and editors manage offers; the public sees only running ones', async () => {
    const { owner, biz, admin, editor, support, stranger } = await team();
    const post = (u: TestUser, body: Record<string, unknown>) =>
      u.client.post(`/v1/businesses/${biz.id}/offers`, body);
    expect(
      (await anon().post(`/v1/businesses/${biz.id}/offers`, { title: 'Sale sale' })).status,
    ).toBe(401);
    expect((await post(support, { title: 'Support offer' })).status).toBe(403);
    expect((await post(stranger, { title: 'Stranger offer' })).status).toBe(404);
    expect((await post(editor, { title: 'x' })).status).toBe(400);
    expect((await post(editor, { title: 'Bad %', discountBps: 10_001 })).status).toBe(400);
    expect((await post(editor, { title: 'Bad code', code: 'no spaces allowed' })).status).toBe(400);
    expect(
      (await post(editor, { title: 'Backwards', startsAt: inDays(2), endsAt: inDays(1) })).status,
    ).toBe(400);
    expect(
      (
        await post(editor, {
          title: 'Scam offer',
          description: 'Give me your seed phrase and private key then send it to me',
        })
      ).status,
    ).toBe(422);
    const live = await post(editor, {
      title: 'Summer sale',
      description: '20% off',
      code: 'summer20',
      discountBps: 2000,
    });
    expect(live.status).toBe(201);
    expect(live.body).toMatchObject({
      title: 'Summer sale',
      code: 'SUMMER20',
      discountBps: 2000,
      status: 'active',
    });
    const draft = await post(admin, { title: 'Secret draft', status: 'draft' });
    const future = await post(admin, { title: 'Coming soon', startsAt: inDays(5) });
    const ended = await post(owner, {
      title: 'Old sale',
      startsAt: inDays(-3),
      endsAt: inDays(-1),
    }); // endsAt in the past relative to now
    expect([draft.status, future.status].every((s) => s === 201)).toBe(true);
    expect(ended.status).toBe(201);
    expect((await post(owner, { title: 'Same code', code: 'SUMMER20' })).status).toBe(409);
    const publicList = await anon().get(`/v1/businesses/${biz.id}/offers`);
    expect(publicList.body.items.map((o: any) => o.title)).toEqual(['Summer sale']);
    const teamList = await support.client.get(`/v1/businesses/${biz.id}/offers`);
    expect(teamList.body.items.map((o: any) => o.title)).toEqual(['Summer sale']); // support cannot manage offers: sees the public view
    const editorList = await editor.client.get(`/v1/businesses/${biz.id}/offers`);
    expect(editorList.body.items.map((o: any) => o.title).sort()).toEqual([
      'Coming soon',
      'Old sale',
      'Secret draft',
      'Summer sale',
    ]);
    expect(editorList.body.items.find((o: any) => o.title === 'Old sale').status).toBe('expired');
    // edit + cancel
    const edited = await editor.client.patch(`/v1/businesses/${biz.id}/offers/${live.body.id}`, {
      title: 'Summer sale 2',
      discountBps: null,
      code: null,
    });
    expect(edited.body).toMatchObject({ title: 'Summer sale 2', discountBps: null, code: null });
    expect(
      (
        await support.client.patch(`/v1/businesses/${biz.id}/offers/${live.body.id}`, {
          title: 'Nope nope',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await editor.client.patch(`/v1/businesses/${biz.id}/offers/${live.body.id}`, {
          endsAt: inDays(-10),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await editor.client.patch(`/v1/businesses/${biz.id}/offers/${crypto.randomUUID()}`, {
          title: 'Ghost offer',
        })
      ).status,
    ).toBe(404);
    expect(
      (await support.client.del(`/v1/businesses/${biz.id}/offers/${live.body.id}`)).status,
    ).toBe(403);
    expect(
      (await editor.client.del(`/v1/businesses/${biz.id}/offers/${live.body.id}`)).status,
    ).toBe(204);
    expect(
      (await editor.client.del(`/v1/businesses/${biz.id}/offers/${live.body.id}`)).status,
    ).toBe(404);
    expect((await anon().get(`/v1/businesses/${biz.id}/offers`)).body.items).toHaveLength(0);
    // another business's offer id is not reachable through this business
    const other = await team();
    const foreign = await other.owner.client.post(`/v1/businesses/${other.biz.id}/offers`, {
      title: 'Foreign offer',
    });
    expect(
      (
        await owner.client.patch(`/v1/businesses/${biz.id}/offers/${foreign.body.id}`, {
          title: 'Steal offer',
        })
      ).status,
    ).toBe(404);
    // a cancelled offer's code can be reused
    expect((await post(owner, { title: 'Reuse code', code: 'SUMMER20' })).status).toBe(201);
  });
});

describe('services', () => {
  it('manages bookable services by role and shows the public only active ones', async () => {
    const { biz, owner, editor, support, stranger } = await team();
    const path = `/v1/businesses/${biz.id}/services`;
    expect((await anon().post(path, { title: 'Massage' })).status).toBe(401);
    expect((await support.client.post(path, { title: 'Massage' })).status).toBe(403);
    expect((await stranger.client.post(path, { title: 'Massage' })).status).toBe(404);
    expect((await editor.client.post(path, { title: 'M' })).status).toBe(400);
    expect((await editor.client.post(path, { title: 'Massage', currency: 'EURO' })).status).toBe(
      400,
    );
    expect((await editor.client.post(path, { title: 'Massage', priceCents: -5 })).status).toBe(400);
    const live = await editor.client.post(path, {
      title: 'Massage',
      description: '60 min',
      priceCents: 6000,
      currency: 'eur',
    });
    expect(live.status).toBe(201);
    expect(live.body).toMatchObject({
      title: 'Massage',
      priceCents: 6000,
      currency: 'EUR',
      status: 'active',
    });
    const draft = await owner.client.post(path, { title: 'Secret service', status: 'draft' });
    expect((await anon().get(path)).body.items.map((s: any) => s.title)).toEqual(['Massage']);
    expect((await stranger.client.get(path)).body.items).toHaveLength(1);
    expect((await editor.client.get(path)).body.items.map((s: any) => s.title)).toEqual([
      'Massage',
      'Secret service',
    ]);
    const edited = await editor.client.patch(`${path}/${live.body.id}`, {
      priceCents: 6500,
      status: 'draft',
    });
    expect(edited.body).toMatchObject({ priceCents: 6500, status: 'draft' });
    expect((await support.client.patch(`${path}/${live.body.id}`, { priceCents: 1 })).status).toBe(
      403,
    );
    expect((await editor.client.patch(`${path}/${live.body.id}`, {})).status).toBe(400);
    expect((await anon().get(path)).body.items).toHaveLength(0);
    // a service belongs to its business only
    const other = await team();
    expect(
      (await other.owner.client.patch(`${path}/${draft.body.id}`, { title: 'Hijack it' })).status,
    ).toBe(404);
    expect(
      (
        await other.owner.client.patch(`/v1/businesses/${other.biz.id}/services/${draft.body.id}`, {
          title: 'Hijack it',
        })
      ).status,
    ).toBe(404);
    expect((await editor.client.del(`${path}/${draft.body.id}`)).status).toBe(204);
    expect((await editor.client.del(`${path}/${draft.body.id}`)).status).toBe(404);
    expect(
      (await sql('SELECT status, kind FROM products WHERE id = $1', [draft.body.id])).rows[0],
    ).toEqual({ status: 'archived', kind: 'service' });
    expect(await auditCount(t, 'service.created', biz.id)).toBe(2);
    // what customers can book
    const bookable = await anon().get(`/v1/businesses/${biz.id}/bookable`);
    expect(bookable.status).toBe(200);
    expect(bookable.body.services).toEqual([]);
    await editor.client.patch(`${path}/${live.body.id}`, { status: 'active' });
    expect(
      (await anon().get(`/v1/businesses/${biz.id}/bookable`)).body.services.map((s: any) => s.id),
    ).toEqual([live.body.id]);
  });
});

describe('bookings: creation rules', () => {
  it('books a place by party size and a service by slot, returning full views', async () => {
    const { biz, place } = await bookablePlace(6);
    const customer = await signup(t);
    const at = atUtc(3, 18);
    const r = await book(customer, { placeId: place.id }, at, {
      partySize: 4,
      notes: 'Window seat please',
    });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({
      status: 'requested',
      placeId: place.id,
      businessId: biz.id,
      customerId: customer.id,
      partySize: 4,
      notes: 'Window seat please',
      startsAt: at.toISOString(),
      targetName: place.name,
    });
    expect(new Date(r.body.endsAt).getTime() - at.getTime()).toBe(3_600_000);
    const got = await customer.client.get(`/v1/bookings/${r.body.id}`);
    expect(got.body).toMatchObject({ id: r.body.id, business: { id: biz.id } });
    expect((await customer.client.get('/v1/me/bookings')).body.items.map((b: any) => b.id)).toEqual(
      [r.body.id],
    );
    expect((await customer.client.get('/v1/me/bookings', { when: 'past' })).body.items).toEqual([]);
    expect(await auditCount(t, 'booking.created', r.body.id)).toBe(1);
    const bookable = await anon().get(`/v1/businesses/${biz.id}/bookable`);
    expect(bookable.body.places).toMatchObject([{ id: place.id, capacity: 6, hasHours: true }]);
    expect(bookable.body.settings).toMatchObject({
      slotMinutes: 30,
      leadTimeMinutes: 60,
      maxAdvanceDays: 90,
    });
    const svc = await bookableService();
    const s = await book(customer, { productId: svc.service.id }, atUtc(4, 10));
    expect(s.status).toBe(201);
    expect(s.body).toMatchObject({
      status: 'requested',
      productId: svc.service.id,
      targetName: 'Consultation',
    });
  });

  it('validates who, what and when: input, lead time, horizon, slot grid, hours, capacity, ownership, blocks, teens', async () => {
    const { owner, biz, place } = await bookablePlace(4);
    const customer = await signup(t);
    const ok = atUtc(3, 12);
    expect(
      (await anon().post('/v1/bookings', { placeId: place.id, startsAt: ok.toISOString() })).status,
    ).toBe(401);
    expect(
      (await customer.client.post('/v1/bookings', { startsAt: ok.toISOString() })).status,
    ).toBe(400); // no target
    expect(
      (
        await customer.client.post('/v1/bookings', {
          placeId: place.id,
          productId: crypto.randomUUID(),
          startsAt: ok.toISOString(),
        })
      ).status,
    ).toBe(400);
    expect(
      (await customer.client.post('/v1/bookings', { placeId: place.id, startsAt: 'tomorrow' }))
        .status,
    ).toBe(400);
    expect(
      (
        await customer.client.post('/v1/bookings', {
          placeId: place.id,
          startsAt: ok.toISOString(),
          partySize: 0,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await customer.client.post('/v1/bookings', {
          placeId: crypto.randomUUID(),
          startsAt: ok.toISOString(),
        })
      ).status,
    ).toBe(404);
    expect(
      (await book(customer, { placeId: place.id }, new Date(Date.now() + 10 * 60_000))).status,
    ).toBe(400); // lead time (60 min)
    expect(
      (await book(customer, { placeId: place.id }, new Date(Date.now() - 3_600_000))).status,
    ).toBe(400);
    expect((await book(customer, { placeId: place.id }, atUtc(200, 12))).status).toBe(400); // beyond 90 days
    expect((await book(customer, { placeId: place.id }, atUtc(3, 12, 15))).status).toBe(400); // off the 30-minute grid
    expect((await book(customer, { placeId: place.id }, ok, { durationMinutes: 45 })).status).toBe(
      400,
    );
    expect((await book(customer, { placeId: place.id }, ok, { durationMinutes: 600 })).status).toBe(
      400,
    ); // above 480
    expect((await book(customer, { placeId: place.id }, ok, { partySize: 5 })).status).toBe(422); // exceeds place capacity 4
    expect(
      (
        await book(customer, { placeId: place.id }, ok, {
          notes: 'Give me your seed phrase and private key then send it to me',
        })
      ).status,
    ).toBe(422);
    expect((await book(owner, { placeId: place.id }, ok)).status).toBe(403); // own business
    const editor = await addTeam(owner, biz.id, 'editor');
    expect((await book(editor, { placeId: place.id }, ok)).status).toBe(403); // team member
    const blocked = await signup(t);
    await block(owner, blocked);
    expect((await book(blocked, { placeId: place.id }, ok)).status).toBe(404);
    const teenCustomer = await signup(t, { birthDate: teenBirth() });
    expect((await book(teenCustomer, { placeId: place.id }, ok)).status).toBe(201); // teens may book; nothing here weakens their protections
    // booking switched off, unclaimed place, suspended business
    await owner.client.patch(`/v1/places/${place.id}`, { bookingEnabled: false });
    expect((await book(customer, { placeId: place.id }, ok)).status).toBe(404);
    const unclaimed = await mkPlace(customer, { capacity: 4, hours: ALL_DAY });
    expect((await book(customer, { placeId: unclaimed.id }, ok)).status).toBe(404);
    const nocap = await bookablePlace(4);
    await sql('UPDATE places SET capacity = NULL WHERE id = $1', [nocap.place.id]);
    expect((await book(customer, { placeId: nocap.place.id }, ok)).status).toBe(422);
    await sql(`UPDATE businesses SET status = 'suspended' WHERE id = $1`, [nocap.biz.id]);
    await sql('UPDATE places SET capacity = 4 WHERE id = $1', [nocap.place.id]);
    expect((await book(customer, { placeId: nocap.place.id }, ok)).status).toBe(404);
  });

  it("validates the slot against opening hours in the resource's own timezone", async () => {
    const svc = await bookableService({ hours: WEEKDAYS_9_17, timezone: 'UTC' });
    const customer = await signup(t);
    const target = { productId: svc.service.id };
    expect((await book(customer, target, nextDow(6, 12))).status).toBe(422); // Saturday: closed
    expect((await book(customer, target, nextDow(3, 8))).status).toBe(422); // Wednesday 08:00, before opening
    expect((await book(customer, target, nextDow(3, 16, 30), { durationMinutes: 60 })).status).toBe(
      422,
    ); // would end 17:30: after closing
    const wed = await book(customer, target, nextDow(3, 16), { durationMinutes: 60 });
    expect(wed.status).toBe(201); // 16:00-17:00 fits exactly
    // the same instants are judged in local time for a business abroad: open 09:00-17:00 Tokyo == 00:00-08:00 UTC
    const tokyo = await bookableService({
      hours: Object.fromEntries(DAYS.map((d) => [d, [['09:00', '17:00']]])),
      timezone: 'Asia/Tokyo',
    });
    expect((await book(customer, { productId: tokyo.service.id }, atUtc(3, 1))).status).toBe(201); // 10:00 JST
    expect((await book(customer, { productId: tokyo.service.id }, atUtc(3, 10))).status).toBe(422); // 19:00 JST
    // a business without published hours cannot take bookings
    const noHours = await bookableService({ hours: {} });
    expect((await book(customer, { productId: noHours.service.id }, atUtc(3, 12))).status).toBe(
      422,
    );
    // overnight hours
    const bar = await bookableService({
      hours: Object.fromEntries(DAYS.map((d) => [d, [['20:00', '03:00']]])),
    });
    expect((await book(customer, { productId: bar.service.id }, atUtc(3, 23))).status).toBe(201);
    expect((await book(customer, { productId: bar.service.id }, atUtc(4, 1))).status).toBe(201);
    expect((await book(customer, { productId: bar.service.id }, atUtc(4, 12))).status).toBe(422);
  });

  it('prevents overlapping bookings of a single-capacity service and duplicate bookings by one customer', async () => {
    const svc = await bookableService();
    const [a, b, c] = [await signup(t), await signup(t), await signup(t)];
    const target = { productId: svc.service.id };
    const first = await book(a, target, atUtc(3, 10));
    expect(first.status).toBe(201);
    const clash = await book(b, target, atUtc(3, 10, 30)); // overlaps 10:30-11:00
    expect(clash.status).toBe(409);
    expect(clash.body.error.details).toMatchObject({ reason: 'slot_unavailable', available: 0 });
    expect((await book(b, target, atUtc(3, 11))).status).toBe(201); // back-to-back is fine
    expect((await book(a, target, atUtc(3, 9, 30), { durationMinutes: 60 })).status).toBe(409);
    const dup = await book(a, { productId: (await bookableService()).service.id }, atUtc(3, 10)); // different resource is fine
    expect(dup.status).toBe(201);
    // the same customer cannot double-book the same resource at overlapping times (even if capacity remains)
    const wide = await bookablePlace(10);
    expect((await book(c, { placeId: wide.place.id }, atUtc(3, 14), { partySize: 2 })).status).toBe(
      201,
    );
    const again = await book(c, { placeId: wide.place.id }, atUtc(3, 14, 30), { partySize: 2 });
    expect(again.status).toBe(409);
    expect(again.body.error.details.reason).toBe('duplicate_booking');
    // cancelled bookings free the slot (b's own 11:00 booking does not overlap 10:00-11:00)
    await a.client.post(`/v1/bookings/${first.body.id}/cancel`, {});
    expect((await book(b, target, atUtc(3, 10))).status).toBe(201);
  });

  it('confirms immediately when the business enabled auto-confirm', async () => {
    const svc = await bookableService({}, { autoConfirm: true });
    const customer = await signup(t);
    const r = await book(customer, { productId: svc.service.id }, atUtc(3, 15));
    expect(r.body.status).toBe('confirmed');
    expect(r.body.decidedAt).toBeTruthy();
    expect(await notifCount(t, customer.id, 'booking_confirmed')).toBe(1);
    expect(await notifCount(t, svc.owner.id, 'booking_requested')).toBe(1);
  });

  it('CONCURRENCY: parallel requests for the same single-capacity slot yield exactly one booking', async () => {
    const svc = await bookableService();
    const customers = await Promise.all(Array.from({ length: 8 }, () => signup(t)));
    const at = atUtc(5, 9);
    const res = await Promise.all(customers.map((c) => book(c, { productId: svc.service.id }, at)));
    expect(res.filter((r) => r.status === 201)).toHaveLength(1);
    expect(res.filter((r) => r.status === 409)).toHaveLength(7);
    expect(
      res
        .filter((r) => r.status === 409)
        .every((r) => r.body.error.details.reason === 'slot_unavailable'),
    ).toBe(true);
    expect(
      (
        await sql(
          `SELECT count(*)::int AS n FROM bookings WHERE product_id = $1 AND status IN ('requested','confirmed')`,
          [svc.service.id],
        )
      ).rows[0].n,
    ).toBe(1);
  });

  it('CONCURRENCY: party-size capacity is never exceeded by parallel requests, and overlapping slots share it', async () => {
    const { place } = await bookablePlace(4);
    const customers = await Promise.all(Array.from({ length: 7 }, () => signup(t)));
    const res = await Promise.all(
      customers.map((c, i) =>
        book(c, { placeId: place.id }, i % 2 ? atUtc(5, 19) : atUtc(5, 19, 30), { partySize: 2 }),
      ),
    );
    // every request overlaps 19:30-20:00, capacity 4, party 2 => exactly two succeed
    expect(res.filter((r) => r.status === 201)).toHaveLength(2);
    const used = (
      await sql(
        `SELECT COALESCE(sum(party_size),0)::int AS n FROM bookings WHERE place_id = $1 AND status IN ('requested','confirmed')`,
        [place.id],
      )
    ).rows[0].n;
    expect(used).toBe(4);
    // one customer firing the same request in parallel gets a single booking
    const solo = await signup(t);
    const svc = await bookableService();
    const dupes = await Promise.all(
      Array.from({ length: 4 }, () => book(solo, { productId: svc.service.id }, atUtc(6, 9))),
    );
    expect(dupes.filter((r) => r.status === 201)).toHaveLength(1);
  });
});

describe('bookings: state machine and access', () => {
  async function requested(autoConfirm = false) {
    const svc = await bookableService({}, autoConfirm ? { autoConfirm: true } : {});
    const customer = await signup(t);
    const support = await addTeam(svc.owner, svc.biz.id, 'support');
    const editor = await addTeam(svc.owner, svc.biz.id, 'editor');
    const b = await book(customer, { productId: svc.service.id }, atUtc(3, 10));
    expect(b.status).toBe(201);
    return { ...svc, customer, id: b.body.id as string, support, editor };
  }
  const act = (u: TestUser, id: string, action: string, body: Record<string, unknown> = {}) =>
    u.client.post(`/v1/bookings/${id}/${action}`, body);
  const start = (id: string) =>
    sql(
      `UPDATE bookings SET starts_at = now() - interval '2 hours', ends_at = now() - interval '1 hour' WHERE id = $1`,
      [id],
    );

  it('lets only the customer and authorised team members see or act on a booking', async () => {
    const { owner, customer, id, support, editor } = await requested();
    const stranger = await signup(t);
    for (const u of [customer, owner, support])
      expect((await u.client.get(`/v1/bookings/${id}`)).status).toBe(200);
    expect((await editor.client.get(`/v1/bookings/${id}`)).status).toBe(404); // editors do not handle bookings
    expect((await stranger.client.get(`/v1/bookings/${id}`)).status).toBe(404);
    expect((await anon().get(`/v1/bookings/${id}`)).status).toBe(401);
    for (const action of ['confirm', 'decline', 'cancel', 'complete', 'no-show']) {
      expect((await act(stranger, id, action)).status).toBe(404);
      expect((await act(editor, id, action)).status).toBe(404);
      expect((await anon().post(`/v1/bookings/${id}/${action}`, {})).status).toBe(401);
    }
    expect((await customer.client.post(`/v1/bookings/${id}/confirm`, {})).status).toBe(403); // the customer cannot confirm their own booking
    expect((await customer.client.post(`/v1/bookings/${id}/decline`, {})).status).toBe(403);
    expect(await statusOf(id)).toBe('requested');
  });

  it('requested -> confirmed -> completed, notifying the other side and auditing', async () => {
    const { owner, customer, id, support } = await requested();
    expect(await notifCount(t, owner.id, 'booking_requested')).toBe(1);
    expect(await notifCount(t, support.id, 'booking_requested')).toBe(1);
    const conf = await act(support, id, 'confirm');
    expect(conf.body.status).toBe('confirmed');
    expect(await notifCount(t, customer.id, 'booking_confirmed')).toBe(1);
    expect((await act(owner, id, 'confirm')).status).toBe(409); // only requested bookings
    expect((await act(owner, id, 'decline')).status).toBe(409);
    expect((await act(owner, id, 'complete')).status).toBe(409); // not started yet
    expect((await act(owner, id, 'no-show')).status).toBe(409);
    await start(id);
    expect((await act(customer, id, 'complete')).status).toBe(403);
    expect((await act(customer, id, 'cancel')).status).toBe(409); // already started
    const done = await act(owner, id, 'complete');
    expect(done.body.status).toBe('completed');
    expect(await auditCount(t, 'booking.completed', id)).toBe(1);
    for (const action of ['confirm', 'decline', 'cancel', 'complete', 'no-show'])
      expect((await act(owner, id, action)).status).toBe(409); // terminal
  });

  it('declines requests, cancels by either side with a reason, and marks no-shows', async () => {
    const dec = await requested();
    const d = await act(dec.owner, dec.id, 'decline', { reason: 'Fully booked' });
    expect(d.body).toMatchObject({ status: 'declined', reason: 'Fully booked' });
    expect(await notifCount(t, dec.customer.id, 'booking_declined')).toBe(1);
    expect((await act(dec.customer, dec.id, 'cancel')).status).toBe(409);

    const byCustomer = await requested();
    await act(byCustomer.owner, byCustomer.id, 'confirm');
    const c = await act(byCustomer.customer, byCustomer.id, 'cancel', {
      reason: 'Change of plans',
    });
    expect(c.body).toMatchObject({
      status: 'cancelled',
      cancelledBy: 'customer',
      reason: 'Change of plans',
    });
    expect(await notifCount(t, byCustomer.owner.id, 'booking_cancelled')).toBe(1);
    expect(await notifCount(t, byCustomer.customer.id, 'booking_cancelled')).toBe(0); // the actor is not notified
    // a cancelled slot can be booked again by someone else
    const again = await book(await signup(t), { productId: byCustomer.service.id }, atUtc(3, 10));
    expect(again.status).toBe(201);

    const byBiz = await requested();
    const bb = await act(byBiz.support, byBiz.id, 'cancel', { reason: 'Staff sick' });
    expect(bb.body).toMatchObject({ status: 'cancelled', cancelledBy: 'business' });
    expect(await notifCount(t, byBiz.customer.id, 'booking_cancelled')).toBe(1);

    const ns = await requested(true);
    expect((await sql('SELECT status FROM bookings WHERE id = $1', [ns.id])).rows[0].status).toBe(
      'confirmed',
    );
    await start(ns.id);
    const n = await act(ns.owner, ns.id, 'no-show');
    expect(n.body.status).toBe('no_show');
    expect(await notifCount(t, ns.customer.id, 'booking_no_show')).toBe(1);
    expect((await act(ns.owner, ns.id, 'cancel')).status).toBe(409);
  });

  it('CONCURRENCY: racing confirm and cancel serialise to a consistent final state', async () => {
    const { owner, customer, id } = await requested();
    const [a, b] = await Promise.all([act(owner, id, 'confirm'), act(customer, id, 'cancel')]);
    // whichever order the row lock grants: cancel always succeeds (from requested or confirmed); confirm succeeds only if it ran first
    expect(b.status).toBe(200);
    expect([200, 409]).toContain(a.status);
    expect(await statusOf(id)).toBe('cancelled');
    const audits = (
      await sql(
        `SELECT count(*)::int AS n FROM audit_logs WHERE target_id = $1 AND action LIKE 'booking.%'`,
        [id],
      )
    ).rows[0].n;
    expect(audits).toBe((a.status === 200 ? 2 : 1) + 1); // + booking.created
  });

  it("lists a business's bookings with filters and keyset pagination (bookings.manage only)", async () => {
    const svc = await bookableService();
    const support = await addTeam(svc.owner, svc.biz.id, 'support');
    const editor = await addTeam(svc.owner, svc.biz.id, 'editor');
    const customers = await Promise.all([signup(t), signup(t), signup(t)]);
    const made = [];
    for (const [i, c] of customers.entries())
      made.push((await book(c, { productId: svc.service.id }, atUtc(3 + i, 10))).body.id);
    await act(svc.owner, made[0]!, 'confirm');
    const path = `/v1/businesses/${svc.biz.id}/bookings`;
    expect((await editor.client.get(path)).status).toBe(403);
    expect((await customers[0]!.client.get(path)).status).toBe(404);
    expect((await anon().get(path)).status).toBe(401);
    const all = await support.client.get(path);
    expect(all.body.items.map((b: any) => b.id)).toEqual(made);
    expect(all.body.items[0].customer).toMatchObject({ id: customers[0]!.id });
    expect(
      (await support.client.get(path, { status: 'confirmed' })).body.items.map((b: any) => b.id),
    ).toEqual([made[0]]);
    expect(
      (
        await support.client.get(path, {
          from: atUtc(4, 0).toISOString(),
          to: atUtc(5, 0).toISOString(),
        })
      ).body.items.map((b: any) => b.id),
    ).toEqual([made[1]]);
    const p1 = await support.client.get(path, { limit: '2' });
    expect(p1.body.items).toHaveLength(2);
    expect(
      (await support.client.get(path, { limit: '2', cursor: p1.body.nextCursor })).body.items.map(
        (b: any) => b.id,
      ),
    ).toEqual([made[2]]);
    // customers list their own past/upcoming bookings
    expect(
      (await customers[0]!.client.get('/v1/me/bookings', { status: 'confirmed' })).body.items,
    ).toHaveLength(1);
    expect(
      (await customers[1]!.client.get('/v1/me/bookings', { status: 'confirmed' })).body.items,
    ).toHaveLength(0);
  });

  it('expires unanswered requests once their start time has passed', async () => {
    const one = await requested();
    const two = await requested(true);
    await start(one.id);
    await start(two.id);
    const n = await expireStaleBookings(t.ctx);
    expect(n).toBeGreaterThanOrEqual(1);
    expect(await statusOf(one.id)).toBe('cancelled');
    expect(
      (await sql('SELECT cancelled_by FROM bookings WHERE id = $1', [one.id])).rows[0].cancelled_by,
    ).toBe('system');
    expect(await statusOf(two.id)).toBe('confirmed'); // confirmed bookings are not expired
    expect(await notifCount(t, one.customer.id, 'booking_cancelled')).toBe(1);
    expect(await expireStaleBookings(t.ctx)).toBe(0); // idempotent
  });
});

describe('following a business', () => {
  it('follows and unfollows idempotently with exact counters; team members cannot follow their own business', async () => {
    const { owner, biz, editor } = await team();
    const [a, b] = [await signup(t), await signup(t)];
    expect((await anon().put(`/v1/businesses/${biz.id}/follow`)).status).toBe(401);
    expect((await a.client.put(`/v1/businesses/${biz.id}/follow`)).body).toEqual({
      following: true,
      followerCount: 1,
    });
    expect((await a.client.put(`/v1/businesses/${biz.id}/follow`)).body).toEqual({
      following: true,
      followerCount: 1,
    });
    expect((await b.client.put(`/v1/businesses/${biz.id}/follow`)).body.followerCount).toBe(2);
    expect((await editor.client.put(`/v1/businesses/${biz.id}/follow`)).status).toBe(400);
    expect((await a.client.get(`/v1/businesses/${biz.id}`)).body).toMatchObject({
      followerCount: 2,
      viewer: { following: true },
    });
    expect(
      (await a.client.get('/v1/me/following-businesses')).body.items.map((x: any) => x.id),
    ).toEqual([biz.id]);
    expect((await a.client.del(`/v1/businesses/${biz.id}/follow`)).status).toBe(204);
    expect((await a.client.del(`/v1/businesses/${biz.id}/follow`)).status).toBe(204);
    expect(
      (await sql('SELECT follower_count FROM businesses WHERE id = $1', [biz.id])).rows[0]
        .follower_count,
    ).toBe(1);
    expect((await a.client.get(`/v1/businesses/${biz.id}`)).body.viewer.following).toBe(false);
    expect((await a.client.put(`/v1/businesses/${crypto.randomUUID()}/follow`)).status).toBe(404);
    // followers list: owner and admin only
    expect(
      (await owner.client.get(`/v1/businesses/${biz.id}/followers`)).body.items.map(
        (f: any) => f.user.id,
      ),
    ).toEqual([b.id]);
    expect((await editor.client.get(`/v1/businesses/${biz.id}/followers`)).status).toBe(403);
    expect((await a.client.get(`/v1/businesses/${biz.id}/followers`)).status).toBe(404);
  });

  it('CONCURRENCY: many parallel follows and unfollows keep follower_count equal to the rows', async () => {
    const { biz } = await team();
    const users = await Promise.all(Array.from({ length: 10 }, () => signup(t)));
    await Promise.all(users.map((u) => u.client.put(`/v1/businesses/${biz.id}/follow`)));
    await Promise.all([
      ...users.slice(0, 4).map((u) => u.client.del(`/v1/businesses/${biz.id}/follow`)),
      ...users.slice(4, 6).map((u) => u.client.put(`/v1/businesses/${biz.id}/follow`)),
    ]);
    const rows = (
      await sql('SELECT count(*)::int AS n FROM business_followers WHERE business_id = $1', [
        biz.id,
      ])
    ).rows[0].n;
    expect(rows).toBe(6);
    expect(
      (await sql('SELECT follower_count FROM businesses WHERE id = $1', [biz.id])).rows[0]
        .follower_count,
    ).toBe(6);
  });
});

describe('posting on behalf of a business', () => {
  it('lets owner, admin and editor post as the business; support and outsiders cannot', async () => {
    const { owner, biz, admin, editor, support, stranger } = await team();
    const path = `/v1/businesses/${biz.id}/posts`;
    expect((await anon().post(path, { body: 'Hello' })).status).toBe(401);
    expect((await support.client.post(path, { body: 'Support post' })).status).toBe(403);
    expect((await stranger.client.post(path, { body: 'Stranger post' })).status).toBe(404);
    expect((await editor.client.post(path, { body: '' })).status).toBe(400);
    const p = await editor.client.post(path, { body: 'Fresh croissants today' });
    expect(p.status).toBe(201);
    expect(p.body.business).toEqual({ id: biz.id });
    expect(p.body.post).toMatchObject({
      body: 'Fresh croissants today',
      author: { id: editor.id },
    });
    expect(
      (await sql('SELECT business_id, visibility FROM posts WHERE id = $1', [p.body.post.id]))
        .rows[0],
    ).toEqual({ business_id: biz.id, visibility: 'public' });
    const p2 = await admin.client.post(path, { body: 'Weekend hours' });
    await owner.client.post(path, { body: 'Owner note' });
    const list = await anon().get(path);
    expect(list.body.items.map((x: any) => x.body)).toEqual([
      'Owner note',
      'Weekend hours',
      'Fresh croissants today',
    ]);
    expect((await anon().get(path, { limit: '2' })).body.nextCursor).toBeTruthy();
    expect((await anon().get(`/v1/businesses/${crypto.randomUUID()}/posts`)).status).toBe(404);
    // blocked users do not see business posts authored by the blocker... nor do teenagers get adult-only behaviour changes
    const blocked = await signup(t);
    await block(editor, blocked);
    expect((await blocked.client.get(path)).body.items.map((x: any) => x.body)).toEqual([
      'Owner note',
      'Weekend hours',
    ]);
    // deleting: authors delete their own, owner/admin delete any, editors cannot delete others'
    const other = await editor.client.post(path, { body: 'Another editor post' });
    expect((await support.client.del(`${path}/${p2.body.post.id}`)).status).toBe(403);
    expect((await stranger.client.del(`${path}/${p2.body.post.id}`)).status).toBe(404);
    const ed2 = await addTeam(owner, biz.id, 'editor');
    expect((await ed2.client.del(`${path}/${other.body.post.id}`)).status).toBe(404);
    expect((await editor.client.del(`${path}/${other.body.post.id}`)).status).toBe(204);
    expect((await admin.client.del(`${path}/${p.body.post.id}`)).status).toBe(204);
    expect((await admin.client.del(`${path}/${p.body.post.id}`)).status).toBe(404);
    expect((await anon().get(path)).body.items.map((x: any) => x.body)).toEqual([
      'Owner note',
      'Weekend hours',
    ]);
    expect(await auditCount(t, 'business.post_created', p.body.post.id)).toBe(1);
  });
});

describe('events hosted by a business', () => {
  it('lets owner/admin/editor host events for the business; support and outsiders cannot; lists upcoming public ones', async () => {
    const { owner, biz, editor, support, stranger } = await team();
    const mk = (u: TestUser, over: Record<string, unknown> = {}) =>
      u.client.post('/v1/events', {
        title: `Biz event ${uniq('e')}`,
        startsAt: inDays(3),
        endsAt: inDays(3, 2),
        locationText: 'Shop',
        publish: true,
        businessId: biz.id,
        ...over,
      });
    expect((await mk(support)).status).toBe(403);
    expect((await mk(stranger)).status).toBe(404);
    const e1 = await mk(editor);
    expect(e1.status).toBe(201);
    expect(e1.body.hostBusiness).toMatchObject({ id: biz.id, slug: biz.slug, verified: false });
    const e2 = await mk(owner, { startsAt: inDays(4), endsAt: inDays(4, 2) });
    const priv = await mk(owner, {
      visibility: 'private',
      startsAt: inDays(5),
      endsAt: inDays(5, 2),
    });
    const list = await anon().get(`/v1/businesses/${biz.id}/events`);
    expect(list.body.items.map((e: any) => e.id)).toEqual([e1.body.id, e2.body.id]);
    expect(
      (await owner.client.get(`/v1/businesses/${biz.id}/events`)).body.items.map((e: any) => e.id),
    ).toEqual([e1.body.id, e2.body.id, priv.body.id]);
    // business team members can run the event (check-in) even though they did not create it
    const guest = await signup(t);
    await guest.client.put(`/v1/events/${e2.body.id}/rsvp`, { status: 'going' });
    await sql(
      `UPDATE events SET starts_at = now() - interval '10 minutes', ends_at = now() + interval '2 hours' WHERE id = $1`,
      [e2.body.id],
    );
    expect(
      (await support.client.post(`/v1/events/${e2.body.id}/check-in`, { userId: guest.id })).status,
    ).toBe(403);
    expect(
      (await editor.client.post(`/v1/events/${e2.body.id}/check-in`, { userId: guest.id })).status,
    ).toBe(200);
    // ...but only owner/admin may cancel it
    expect((await editor.client.post(`/v1/events/${e2.body.id}/cancel`, {})).status).toBe(403);
    expect((await owner.client.post(`/v1/events/${e2.body.id}/cancel`, {})).status).toBe(200);
    expect(
      (await anon().get(`/v1/businesses/${biz.id}/events`)).body.items.map((e: any) => e.id),
    ).toEqual([e1.body.id]);
  });
});

describe('analytics', () => {
  it('reports real numbers to the owner only', async () => {
    const { owner, biz, admin, editor, support, stranger } = await team();
    const path = `/v1/businesses/${biz.id}/analytics`;
    const fans = await Promise.all([signup(t), signup(t), signup(t)]);
    for (const f of fans) await f.client.put(`/v1/businesses/${biz.id}/follow`);
    for (const f of fans) await f.client.post(`/v1/businesses/${biz.id}/view`);
    await fans[0]!.client.post(`/v1/businesses/${biz.id}/view`);
    await anon().post(`/v1/businesses/${biz.id}/view`);
    await editor.client.post(`/v1/businesses/${biz.id}/view`); // team views are not counted
    const svc = await owner.client.post(`/v1/businesses/${biz.id}/services`, { title: 'Cut' });
    await owner.client.patch(`/v1/businesses/${biz.id}`, { hours: ALL_DAY });
    const b1 = await book(fans[0]!, { productId: svc.body.id }, atUtc(3, 10));
    await book(fans[1]!, { productId: svc.body.id }, atUtc(3, 12));
    await owner.client.post(`/v1/bookings/${b1.body.id}/confirm`, {});
    const ev = await owner.client.post('/v1/events', {
      title: 'Open day',
      startsAt: inDays(3),
      endsAt: inDays(3, 2),
      locationText: 'Shop',
      publish: true,
      businessId: biz.id,
    });
    await owner.client.post('/v1/events', {
      title: 'Draft day',
      startsAt: inDays(3),
      locationText: 'Shop',
      businessId: biz.id,
    });
    await fans[0]!.client.put(`/v1/events/${ev.body.id}/rsvp`, { status: 'going' });
    await fans[1]!.client.put(`/v1/events/${ev.body.id}/rsvp`, { status: 'going' });
    await owner.client.post(`/v1/businesses/${biz.id}/posts`, { body: 'Hello world' });
    await owner.client.post(`/v1/businesses/${biz.id}/offers`, { title: 'Half price' });

    expect((await anon().get(path)).status).toBe(401);
    expect((await stranger.client.get(path)).status).toBe(404);
    for (const u of [admin, editor, support]) expect((await u.client.get(path)).status).toBe(403);
    expect((await owner.client.get(path, { days: '0' })).status).toBe(400);
    expect((await owner.client.get(path, { days: '9999' })).status).toBe(400);
    const r = await owner.client.get(path);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      periodDays: 30,
      views: { total: 5 },
      followers: { total: 3, new: 3 },
      bookings: { total: 2, byStatus: { confirmed: 1, requested: 1 }, upcoming: 2 },
      events: { hosted: 1, upcoming: 1, completed: 0, goingTotal: 2 },
      posts: { count: 1 },
      offers: { active: 1 },
      reviews: { count: 0, average: 0 },
    });
    expect(r.body.views.daily).toEqual([{ day: new Date().toISOString().slice(0, 10), views: 5 }]);
    // an empty business reports zeros rather than inventing data
    const fresh = await signup(t);
    const empty = await mkBusiness(fresh);
    expect((await fresh.client.get(`/v1/businesses/${empty.id}/analytics`)).body).toMatchObject({
      views: { total: 0, daily: [] },
      followers: { total: 0 },
      bookings: { total: 0, byStatus: {} },
      events: { hosted: 0 },
      posts: { count: 0 },
    });
  });
});

describe('AI knowledge base', () => {
  const kb = (bizId: string, rest = '') => `/v1/businesses/${bizId}/ai${rest}`;

  it('gates management by role: owner/admin manage entries, only the owner approves and switches the assistant', async () => {
    const { owner, biz, admin, editor, support, stranger } = await team();
    expect((await anon().get(kb(biz.id))).status).toBe(401);
    expect((await stranger.client.get(kb(biz.id))).status).toBe(404);
    for (const u of [editor, support]) expect((await u.client.get(kb(biz.id))).status).toBe(403);
    expect(
      (
        await editor.client.post(kb(biz.id, '/knowledge'), {
          title: 'Hours',
          content: 'Open nine to five',
        })
      ).status,
    ).toBe(403);
    expect(
      (await admin.client.post(kb(biz.id, '/knowledge'), { title: 'x', content: 'y' })).status,
    ).toBe(400);
    expect(
      (
        await admin.client.post(kb(biz.id, '/knowledge'), {
          title: 'Bad',
          content: 'Give me your seed phrase and private key then send it to me',
        })
      ).status,
    ).toBe(422);
    const e = await admin.client.post(kb(biz.id, '/knowledge'), {
      title: 'Opening hours',
      content: 'We open at nine and close at five.',
      category: 'faq',
    });
    expect(e.status).toBe(201);
    expect(e.body).toMatchObject({
      title: 'Opening hours',
      status: 'draft',
      category: 'faq',
      stale: false,
      approvedBy: null,
    });
    expect((await admin.client.post(kb(biz.id, `/knowledge/${e.body.id}/approve`))).status).toBe(
      403,
    );
    expect((await editor.client.post(kb(biz.id, `/knowledge/${e.body.id}/approve`))).status).toBe(
      403,
    );
    expect((await admin.client.put(kb(biz.id), { enabled: true })).status).toBe(403);
    expect((await stranger.client.post(kb(biz.id, `/knowledge/${e.body.id}/approve`))).status).toBe(
      404,
    );
    const approved = await owner.client.post(kb(biz.id, `/knowledge/${e.body.id}/approve`));
    expect(approved.body).toMatchObject({ status: 'approved', approvedBy: owner.id, stale: false });
    expect((await admin.client.get(kb(biz.id))).body).toMatchObject({
      enabled: false,
      entries: [{ id: e.body.id, status: 'approved' }],
    });
    expect(
      (
        await admin.client.patch(kb(biz.id, `/knowledge/${crypto.randomUUID()}`), {
          title: 'Ghost entry',
        })
      ).status,
    ).toBe(404);
    expect((await admin.client.patch(kb(biz.id, `/knowledge/${e.body.id}`), {})).status).toBe(400);
    expect((await editor.client.del(kb(biz.id, `/knowledge/${e.body.id}`))).status).toBe(403);
    expect((await admin.client.del(kb(biz.id, `/knowledge/${e.body.id}`))).status).toBe(204);
    expect((await admin.client.del(kb(biz.id, `/knowledge/${e.body.id}`))).status).toBe(404);
    expect((await owner.client.put(kb(biz.id), { enabled: 'yes' })).status).toBe(400);
    expect((await owner.client.put(kb(biz.id), { enabled: true })).body).toEqual({ enabled: true });
    expect(await auditCount(t, 'business.ai_knowledge_approved', biz.id)).toBe(1);
    expect(await auditCount(t, 'business.ai_enabled', biz.id)).toBe(1);
  });

  it('getAuthorizedBusinessKnowledge returns only owner-approved, unmodified knowledge of an enabled, active business', async () => {
    const { owner, biz, admin } = await team({ description: 'PROFILE-TEXT-NOT-KNOWLEDGE' });
    const add = async (title: string, content: string) =>
      (await admin.client.post(kb(biz.id, '/knowledge'), { title, content })).body;
    const approvedEntry = await add('Refunds', 'Refunds within 14 days.');
    const draftEntry = await add('Secret pricing', 'DRAFT-ONLY internal pricing');
    const editedEntry = await add('Delivery', 'Delivery takes three days.');
    await owner.client.post(kb(biz.id, `/knowledge/${approvedEntry.id}/approve`));
    await owner.client.post(kb(biz.id, `/knowledge/${editedEntry.id}/approve`));
    // disabled assistant: nothing at all, even approved entries
    expect(await getAuthorizedBusinessKnowledge(t.ctx, biz.id)).toBeNull();
    await owner.client.put(kb(biz.id), { enabled: true });
    let k = await getAuthorizedBusinessKnowledge(t.ctx, biz.id);
    expect(k?.entries.map((e) => e.title).sort()).toEqual(['Delivery', 'Refunds']);
    expect(JSON.stringify(k)).not.toContain('DRAFT-ONLY');
    expect(JSON.stringify(k)).not.toContain('PROFILE-TEXT-NOT-KNOWLEDGE'); // profile data is not knowledge
    expect(Object.keys(k!.entries[0]!).sort()).toEqual(['category', 'content', 'id', 'title']); // no approval metadata or authorship leaks
    // editing an approved entry returns it to draft: it disappears until the owner approves again
    const upd = await admin.client.patch(kb(biz.id, `/knowledge/${editedEntry.id}`), {
      content: 'Delivery takes five days.',
    });
    expect(upd.body.status).toBe('draft');
    k = await getAuthorizedBusinessKnowledge(t.ctx, biz.id);
    expect(k?.entries.map((e) => e.title)).toEqual(['Refunds']);
    await owner.client.post(kb(biz.id, `/knowledge/${editedEntry.id}/approve`));
    expect(
      (await getAuthorizedBusinessKnowledge(t.ctx, biz.id))?.entries.find(
        (e) => e.title === 'Delivery',
      )?.content,
    ).toBe('Delivery takes five days.');
    // metadata-only edits (category) keep the approval; revoking removes the entry
    await admin.client.patch(kb(biz.id, `/knowledge/${approvedEntry.id}`), { category: 'policy' });
    expect(
      (await getAuthorizedBusinessKnowledge(t.ctx, biz.id))?.entries.find(
        (e) => e.title === 'Refunds',
      )?.category,
    ).toBe('policy');
    await owner.client.post(kb(biz.id, `/knowledge/${approvedEntry.id}/revoke`));
    expect(
      (await getAuthorizedBusinessKnowledge(t.ctx, biz.id))?.entries.map((e) => e.title),
    ).toEqual(['Delivery']);
    expect(draftEntry.status).toBe('draft');
  });

  it('never serves tampered or forged entries, and nothing for suspended, closed or unknown businesses', async () => {
    const { owner, biz, admin } = await team();
    await owner.client.put(kb(biz.id), { enabled: true });
    const good = (
      await admin.client.post(kb(biz.id, '/knowledge'), {
        title: 'Good',
        content: 'Genuine approved content',
      })
    ).body;
    await owner.client.post(kb(biz.id, `/knowledge/${good.id}/approve`));
    // rows written behind the API's back: forged approval without a matching hash, approval with edited text, missing approver, wrong status
    const now = new Date().toISOString();
    const base = {
      category: null,
      createdBy: admin.id,
      createdAt: now,
      updatedAt: now,
      approvedAt: now,
    };
    const forged = [
      {
        ...base,
        id: crypto.randomUUID(),
        title: 'Forged',
        content: 'no hash',
        status: 'approved',
        approvedBy: owner.id,
        approvedHash: null,
      },
      {
        ...base,
        id: crypto.randomUUID(),
        title: 'Tampered',
        content: 'CHANGED after approval',
        status: 'approved',
        approvedBy: owner.id,
        approvedHash: knowledgeHash('Tampered', 'original text'),
      },
      {
        ...base,
        id: crypto.randomUUID(),
        title: 'NoApprover',
        content: 'approved by nobody',
        status: 'approved',
        approvedBy: null,
        approvedHash: knowledgeHash('NoApprover', 'approved by nobody'),
      },
      {
        ...base,
        id: crypto.randomUUID(),
        title: 'Weird',
        content: 'status pending',
        status: 'pending',
        approvedBy: owner.id,
        approvedHash: knowledgeHash('Weird', 'status pending'),
      },
      'not even an object',
      null,
      { title: 'no id', content: 'x', status: 'approved' },
    ];
    const cur = (await sql('SELECT ai_knowledge FROM businesses WHERE id = $1', [biz.id])).rows[0]
      .ai_knowledge as unknown[];
    await sql('UPDATE businesses SET ai_knowledge = $2 WHERE id = $1', [
      biz.id,
      JSON.stringify([...cur, ...forged]),
    ]);
    const k = await getAuthorizedBusinessKnowledge(t.ctx, biz.id);
    expect(k?.entries.map((e) => e.title)).toEqual(['Good']);
    const view = await admin.client.get(kb(biz.id));
    expect(view.body.entries.find((e: any) => e.title === 'Tampered').stale).toBe(true);
    // suspended, closed, unknown
    await sql(`UPDATE businesses SET status = 'suspended' WHERE id = $1`, [biz.id]);
    expect(await getAuthorizedBusinessKnowledge(t.ctx, biz.id)).toBeNull();
    await sql(`UPDATE businesses SET status = 'active' WHERE id = $1`, [biz.id]);
    expect((await getAuthorizedBusinessKnowledge(t.ctx, biz.id))?.entries).toHaveLength(1);
    expect(await getAuthorizedBusinessKnowledge(t.ctx, crypto.randomUUID())).toBeNull();
    expect((await owner.client.del(`/v1/businesses/${biz.id}`)).status).toBe(204);
    expect(await getAuthorizedBusinessKnowledge(t.ctx, biz.id)).toBeNull();
  });

  it('caps the knowledge base and keeps parallel additions', async () => {
    const { owner, biz } = await team();
    const res = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        owner.client.post(kb(biz.id, '/knowledge'), {
          title: `Entry ${i}`,
          content: `Content number ${i}`,
        }),
      ),
    );
    expect(res.every((r) => r.status === 201)).toBe(true);
    expect((await owner.client.get(kb(biz.id))).body.entries).toHaveLength(6); // no lost updates
    const big = await Promise.all(
      Array.from({ length: 3 }, (_, i) =>
        owner.client.post(kb(biz.id, '/knowledge'), {
          title: `Big ${i}`,
          content: 'x'.repeat(2000),
        }),
      ),
    );
    expect(big.every((r) => r.status === 201)).toBe(true);
    expect(
      (
        await owner.client.post(kb(biz.id, '/knowledge'), {
          title: 'Too long',
          content: 'x'.repeat(2001),
        })
      ).status,
    ).toBe(400);
  });
});

describe('account deletion hook', () => {
  const runHooks = (userId: string) =>
    withTransaction(t.ctx.db, async (tx) => {
      for (const h of getDeletionHooks()) await h(t.ctx, tx, userId);
    });

  it('hands the business to the most senior remaining member, or closes it when the owner was alone', async () => {
    const { owner, biz, admin, editor, support } = await team();
    await runHooks(owner.id);
    expect(
      (await sql('SELECT owner_id FROM businesses WHERE id = $1', [biz.id])).rows[0].owner_id,
    ).toBe(admin.id);
    expect(
      (
        await sql(
          `SELECT user_id FROM business_members WHERE business_id = $1 AND role = 'owner'`,
          [biz.id],
        )
      ).rows,
    ).toEqual([{ user_id: admin.id }]);
    expect(
      (await sql('SELECT 1 FROM business_members WHERE user_id = $1', [owner.id])).rowCount,
    ).toBe(0);
    expect((await anon().get(`/v1/businesses/${biz.id}`)).status).toBe(200);
    expect(editor.id && support.id).toBeTruthy();
    // sole owner: closed, with bookings cancelled and upcoming events cancelled
    const solo = await signup(t);
    const sb = await mkBusiness(solo, { hours: ALL_DAY });
    const svc = await solo.client.post(`/v1/businesses/${sb.id}/services`, { title: 'Consult' });
    const customer = await signup(t);
    const bk = await book(customer, { productId: svc.body.id }, atUtc(3, 10));
    const ev = await solo.client.post('/v1/events', {
      title: 'Farewell',
      startsAt: inDays(3),
      endsAt: inDays(3, 2),
      locationText: 'Shop',
      publish: true,
      businessId: sb.id,
    });
    await customer.client.put(`/v1/events/${ev.body.id}/rsvp`, { status: 'going' });
    await runHooks(solo.id);
    expect(
      (
        await sql(
          'SELECT status, deleted_at IS NOT NULL AS gone, owner_id FROM businesses WHERE id = $1',
          [sb.id],
        )
      ).rows[0],
    ).toEqual({ status: 'closed', gone: true, owner_id: null });
    expect(await statusOf(bk.body.id)).toBe('cancelled');
    expect(
      (await sql('SELECT status FROM events WHERE id = $1', [ev.body.id])).rows[0].status,
    ).toBe('cancelled');
    expect((await anon().get(`/v1/businesses/${sb.id}`)).status).toBe(404);
  });

  it("removes memberships, invitations and follows (recounting), and cancels the user's own upcoming bookings", async () => {
    const { owner, biz, editor } = await team({ hours: ALL_DAY });
    const svc = await owner.client.post(`/v1/businesses/${biz.id}/services`, { title: 'Cut' });
    const fan = await signup(t);
    const other = await signup(t);
    await fan.client.put(`/v1/businesses/${biz.id}/follow`);
    await other.client.put(`/v1/businesses/${biz.id}/follow`);
    const bk = await book(fan, { productId: svc.body.id }, atUtc(3, 10));
    const past = await book(fan, { productId: svc.body.id }, atUtc(3, 12));
    await sql(
      `UPDATE bookings SET status = 'completed', starts_at = now() - interval '2 days', ends_at = now() - interval '2 days' + interval '1 hour' WHERE id = $1`,
      [past.body.id],
    );
    const invitee = await signup(t);
    await owner.client.post(`/v1/businesses/${biz.id}/invitations`, {
      username: invitee.username,
      role: 'support',
    });
    await runHooks(fan.id);
    expect(
      (await sql('SELECT follower_count FROM businesses WHERE id = $1', [biz.id])).rows[0]
        .follower_count,
    ).toBe(1);
    expect(await statusOf(bk.body.id)).toBe('cancelled');
    expect(
      (await sql('SELECT cancelled_by FROM bookings WHERE id = $1', [bk.body.id])).rows[0]
        .cancelled_by,
    ).toBe('customer');
    expect(await statusOf(past.body.id)).toBe('completed'); // history is untouched
    expect(await notifCount(t, owner.id, 'booking_cancelled')).toBe(1);
    await runHooks(invitee.id);
    expect(
      (await sql('SELECT 1 FROM business_invitations WHERE user_id = $1', [invitee.id])).rowCount,
    ).toBe(0);
    await runHooks(editor.id);
    expect(
      (await sql('SELECT 1 FROM business_members WHERE user_id = $1', [editor.id])).rowCount,
    ).toBe(0);
    expect(
      (
        await sql(`SELECT count(*)::int AS n FROM business_members WHERE business_id = $1`, [
          biz.id,
        ])
      ).rows[0].n,
    ).toBe(3); // owner, admin, support remain
  });
});
