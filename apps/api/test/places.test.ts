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
import {
  auditCount,
  befriend,
  block,
  inDays,
  insertImage,
  notifCount,
  teenBirth,
} from './entity-helpers.js';
import { getDeletionHooks } from '../src/lib/hooks.js';

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
const ALL_DAY = Object.fromEntries(
  ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, [['00:00', '24:00']]]),
);

let seq = 0;
/** Every test gets its own patch of the globe so geo assertions never see other tests' places. */
const region = () => {
  const n = seq++;
  return { lat: -60 + (n % 100) * 1.1, lng: -170 + Math.floor(n / 100) * 2 + (n % 7) * 5 };
};

async function mkPlace(u: TestUser, over: Record<string, unknown> = {}) {
  const r0 = region();
  const r = await u.client.post('/v1/places', {
    name: `Place ${uniq('p')}`,
    kind: 'restaurant',
    latitude: r0.lat,
    longitude: r0.lng,
    ...over,
  });
  if (r.status !== 201)
    throw new Error(`create place failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body as any;
}
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
/** Business owner + claimed place (staff-approved) for tests that need an owned place. */
async function ownedPlace(placeOver: Record<string, unknown> = {}) {
  const owner = await signup(t);
  const biz = await mkBusiness(owner);
  const place = await mkPlace(owner, placeOver);
  const claim = await owner.client.post(`/v1/places/${place.id}/claims`, {
    businessId: biz.id,
    evidence: 'Utility bill on file',
  });
  expect(claim.status).toBe(201);
  const ok = await moderator.client.post(`/v1/staff/place-claims/${claim.body.id}/approve`, {});
  expect(ok.status).toBe(200);
  return { owner, biz, place, claimId: claim.body.id as string };
}
async function addTeam(owner: TestUser, bizId: string, role: 'admin' | 'editor' | 'support') {
  const u = await signup(t);
  expect(
    (await owner.client.post(`/v1/businesses/${bizId}/invitations`, { username: u.username, role }))
      .status,
  ).toBe(201);
  expect((await u.client.post(`/v1/businesses/${bizId}/invitation/accept`)).status).toBe(200);
  return u;
}
const review = (u: TestUser, placeId: string, rating: number, body = '') =>
  u.client.post(`/v1/places/${placeId}/reviews`, { rating, body });
const aggregate = async (placeId: string) =>
  (
    await sql('SELECT rating_avg::float AS avg, rating_count AS n FROM places WHERE id = $1', [
      placeId,
    ])
  ).rows[0] as { avg: number; n: number };

describe('creating and reading places', () => {
  it('creates a place with audit, computed fields and defaults', async () => {
    const u = await signup(t);
    const p = await mkPlace(u, {
      description: 'Best noodles',
      address: { city: 'Lyon', country: 'FR' },
      phone: '+33 4 72 00 00 00',
      website: 'https://noodles.example.com',
      capacity: 40,
      timezone: 'Europe/Paris',
    });
    expect(p).toMatchObject({
      kind: 'restaurant',
      timezone: 'Europe/Paris',
      claimed: false,
      business: null,
      bookingEnabled: false,
      isOpenNow: null,
      capacity: 40,
      rating: { average: 0, count: 0, breakdown: { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 } },
      viewer: { saved: false },
    });
    expect(await auditCount(t, 'place.created', p.id)).toBe(1);
    const got = await anon().get(`/v1/places/${p.id}`);
    expect(got.status).toBe(200);
    expect(got.body).toMatchObject({
      id: p.id,
      name: p.name,
      address: { city: 'Lyon', country: 'FR' },
      viewer: { canEdit: false, editRole: null },
    });
    const mine = await u.client.get(`/v1/places/${p.id}`);
    expect(mine.body.viewer).toMatchObject({ canEdit: true, editRole: 'creator' });
  });

  it('rejects anonymous, invalid, teen and duplicate submissions', async () => {
    const u = await signup(t);
    const r0 = region();
    const base = { name: `Valid ${uniq('v')}`, kind: 'store', latitude: r0.lat, longitude: r0.lng };
    expect((await anon().post('/v1/places', base)).status).toBe(401);
    expect((await u.client.post('/v1/places', { ...base, name: 'x' })).status).toBe(400);
    expect((await u.client.post('/v1/places', { ...base, kind: 'spaceport' })).status).toBe(400);
    expect((await u.client.post('/v1/places', { ...base, latitude: 91 })).status).toBe(400);
    expect((await u.client.post('/v1/places', { ...base, longitude: -181 })).status).toBe(400);
    expect((await u.client.post('/v1/places', { ...base, timezone: 'Mars/Base' })).status).toBe(
      400,
    );
    expect(
      (await u.client.post('/v1/places', { ...base, website: 'javascript:alert(1)' })).status,
    ).toBe(400);
    expect((await u.client.post('/v1/places', { ...base, phone: 'call me maybe' })).status).toBe(
      400,
    );
    expect(
      (
        await u.client.post('/v1/places', {
          ...base,
          hours: {
            mon: [
              ['09:00', '08:59'],
              ['08:00', '10:00'],
            ],
          },
        })
      ).status,
    ).toBe(400);
    expect(
      (await u.client.post('/v1/places', { ...base, hours: { mon: [['9am', '5pm']] } })).status,
    ).toBe(400);
    expect((await u.client.post('/v1/places', { ...base, capacity: 0 })).status).toBe(400);
    const teen = await signup(t, { birthDate: teenBirth() });
    expect((await teen.client.post('/v1/places', base)).status).toBe(422);
    // moderation screening of the public text
    expect(
      (
        await u.client.post('/v1/places', {
          ...base,
          description: 'give me your seed phrase and private key then send it to me',
        })
      ).status,
    ).toBe(422);
    const ok = await u.client.post('/v1/places', base);
    expect(ok.status).toBe(201);
    // same name within 100 m is a duplicate; the same name far away, or another name here, is fine
    const dup = await u.client.post('/v1/places', {
      ...base,
      name: base.name.toUpperCase(),
      latitude: r0.lat + 0.0003,
    });
    expect(dup.status).toBe(409);
    expect(dup.body.error.details).toMatchObject({
      reason: 'duplicate_place',
      placeId: ok.body.id,
    });
    expect((await u.client.post('/v1/places', { ...base, latitude: r0.lat + 0.5 })).status).toBe(
      201,
    );
    expect(
      (await u.client.post('/v1/places', { ...base, name: `Other ${uniq('o')}` })).status,
    ).toBe(201);
  });

  it("reports isOpenNow in the place's own timezone", async () => {
    const u = await signup(t);
    // Open all day: always open. No hours: unknown (null), never a guess.
    const always = await mkPlace(u, { hours: ALL_DAY, timezone: 'Pacific/Auckland' });
    expect(always.isOpenNow).toBe(true);
    const unknown = await mkPlace(u);
    expect(unknown.isOpenNow).toBeNull();
    // A shop that is open 09:00-17:00 in its local time: compute the expectation independently from the zone's wall clock.
    const zones = ['Asia/Tokyo', 'America/Los_Angeles', 'Europe/London'];
    for (const tz of zones) {
      const p = await mkPlace(u, {
        hours: Object.fromEntries(
          ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, [['09:00', '17:00']]]),
        ),
        timezone: tz,
      });
      const hour = Number(
        new Intl.DateTimeFormat('en-GB', {
          timeZone: tz,
          hour: '2-digit',
          hourCycle: 'h23',
        }).format(new Date()),
      );
      expect(p.isOpenNow).toBe(hour >= 9 && hour < 17);
    }
    // Closed all week apart from a slot that is always in the past/future relative to now in that zone
    const closedToday = await mkPlace(u, { hours: { mon: [['00:00', '00:01']] }, timezone: 'UTC' });
    expect([true, false]).toContain(closedToday.isOpenNow);
  });

  it('404s for unknown and deleted places', async () => {
    const u = await signup(t);
    expect((await anon().get(`/v1/places/${crypto.randomUUID()}`)).status).toBe(404);
    expect((await anon().get('/v1/places/not-a-uuid')).status).toBe(400);
    const p = await mkPlace(u);
    expect((await u.client.del(`/v1/places/${p.id}`)).status).toBe(204);
    expect((await anon().get(`/v1/places/${p.id}`)).status).toBe(404);
    expect((await u.client.put(`/v1/places/${p.id}/save`)).status).toBe(404);
  });
});

describe('editing and deleting: authorization matrix', () => {
  it('lets the creator edit an unclaimed place; strangers, anonymous and support staff cannot', async () => {
    const creator = await signup(t);
    const stranger = await signup(t);
    const p = await mkPlace(creator);
    expect((await anon().patch(`/v1/places/${p.id}`, { name: 'Hacked place' })).status).toBe(401);
    expect(
      (await stranger.client.patch(`/v1/places/${p.id}`, { name: 'Hacked place' })).status,
    ).toBe(403);
    expect(
      (await supportStaff.client.patch(`/v1/places/${p.id}`, { name: 'Support edit' })).status,
    ).toBe(403);
    expect((await creator.client.patch(`/v1/places/${p.id}`, {})).status).toBe(400);
    expect((await creator.client.patch(`/v1/places/${p.id}`, { latitude: 10 })).status).toBe(400);
    expect(
      (
        await creator.client.patch(`/v1/places/${p.id}`, {
          hours: {
            mon: [
              ['10:00', '09:00'],
              ['09:30', '11:00'],
            ],
          },
        })
      ).status,
    ).toBe(400);
    const ok = await creator.client.patch(`/v1/places/${p.id}`, {
      name: 'Renamed place',
      hours: ALL_DAY,
      timezone: 'Asia/Tokyo',
      capacity: null,
    });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({
      name: 'Renamed place',
      timezone: 'Asia/Tokyo',
      isOpenNow: true,
      capacity: null,
    });
    expect(await auditCount(t, 'place.updated', p.id)).toBe(1);
    // the creator cannot flip booking settings without a business
    expect(
      (await creator.client.patch(`/v1/places/${p.id}`, { bookingEnabled: true })).status,
    ).toBe(403);
  });

  it('staff (moderator+, MFA) may edit any place; after a claim only the owning team and staff may', async () => {
    const { owner, biz, place } = await ownedPlace();
    const creatorLosesAccess = await owner.client.patch(`/v1/places/${place.id}`, {
      description: 'Owner edit',
    });
    expect(creatorLosesAccess.status).toBe(200); // owner is on the team with places.manage
    const admin = await addTeam(owner, biz.id, 'admin');
    const editor = await addTeam(owner, biz.id, 'editor');
    const support = await addTeam(owner, biz.id, 'support');
    const stranger = await signup(t);
    expect(
      (await admin.client.patch(`/v1/places/${place.id}`, { description: 'Admin edit' })).status,
    ).toBe(200);
    expect(
      (await editor.client.patch(`/v1/places/${place.id}`, { description: 'Editor edit' })).status,
    ).toBe(200);
    expect(
      (await support.client.patch(`/v1/places/${place.id}`, { description: 'Support edit' }))
        .status,
    ).toBe(403);
    expect(
      (await stranger.client.patch(`/v1/places/${place.id}`, { description: 'Stranger edit' }))
        .status,
    ).toBe(403);
    const staffEdit = await moderator.client.patch(`/v1/places/${place.id}`, {
      description: 'Staff edit',
    });
    expect(staffEdit.status).toBe(200);
    const log = await sql(
      `SELECT actor_type FROM audit_logs WHERE action = 'place.updated' AND target_id = $1 AND actor_id = $2`,
      [place.id, moderator.id],
    );
    expect(log.rows[0].actor_type).toBe('staff');
    // A place whose ownership was claimed by a business is no longer editable by whoever created the listing.
    const creator = await signup(t);
    const p2 = await mkPlace(creator);
    const other = await signup(t);
    const b2 = await mkBusiness(other);
    const c = await other.client.post(`/v1/places/${p2.id}/claims`, { businessId: b2.id });
    await moderator.client.post(`/v1/staff/place-claims/${c.body.id}/approve`, {});
    expect(
      (await creator.client.patch(`/v1/places/${p2.id}`, { name: 'Creator retake' })).status,
    ).toBe(403);
    expect(
      (await other.client.patch(`/v1/places/${p2.id}`, { bookingEnabled: true, capacity: 10 }))
        .status,
    ).toBe(200);
    expect(
      (await support.client.patch(`/v1/places/${place.id}`, { bookingEnabled: true })).status,
    ).toBe(403);
  });

  it('deletes: creator only while nobody reviewed it; owner admins; staff always; never strangers', async () => {
    const creator = await signup(t);
    const stranger = await signup(t);
    const p = await mkPlace(creator);
    expect((await stranger.client.del(`/v1/places/${p.id}`)).status).toBe(403);
    expect((await anon().del(`/v1/places/${p.id}`)).status).toBe(401);
    const reviewed = await mkPlace(creator);
    expect((await review(stranger, reviewed.id, 4)).status).toBe(201);
    expect((await creator.client.del(`/v1/places/${reviewed.id}`)).status).toBe(403);
    expect((await moderator.client.del(`/v1/places/${reviewed.id}`)).status).toBe(204);
    expect(await auditCount(t, 'place.deleted', reviewed.id)).toBe(1);
    expect((await creator.client.del(`/v1/places/${p.id}`)).status).toBe(204);
    const { owner, biz, place } = await ownedPlace();
    const editor = await addTeam(owner, biz.id, 'editor');
    expect((await editor.client.del(`/v1/places/${place.id}`)).status).toBe(403);
    expect((await owner.client.del(`/v1/places/${place.id}`)).status).toBe(204);
  });
});

describe('search and geo', () => {
  it('finds places by name, kind and city with alphabetical keyset pagination', async () => {
    const u = await signup(t);
    const tag = uniq('zq');
    const names = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo'].map((n) => `${n} ${tag}`);
    for (const [i, n] of names.entries())
      await mkPlace(u, {
        name: n,
        kind: i % 2 ? 'store' : 'venue',
        address: { city: i < 3 ? 'Lisbon' : 'Porto' },
      });
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 4; i++) {
      const r = await anon().get('/v1/places', {
        q: tag,
        limit: '2',
        ...(cursor ? { cursor } : {}),
      });
      expect(r.status).toBe(200);
      seen.push(...r.body.items.map((x: any) => x.name));
      cursor = r.body.nextCursor ?? undefined;
      if (!cursor) break;
    }
    expect(seen).toEqual(names);
    expect(
      (await anon().get('/v1/places', { q: tag, kind: 'store' })).body.items.map(
        (x: any) => x.name,
      ),
    ).toEqual([names[1], names[3]]);
    expect((await anon().get('/v1/places', { q: tag, city: 'porto' })).body.items).toHaveLength(2);
    // LIKE wildcards in the query are literals
    expect(
      (await anon().get('/v1/places', { q: '%' })).body.items.every((x: any) =>
        x.name.includes('%'),
      ),
    ).toBe(true);
    expect((await anon().get('/v1/places', { limit: '0' })).status).toBe(400);
  });

  it('returns nearby places nearest-first within the radius, with exact distances and stable keyset pages', async () => {
    const u = await signup(t);
    const c = region();
    const offsets = [0.01, 0.02, 0.03, 0.05, 0.08, 0.5]; // degrees of latitude: ~1.1, 2.2, 3.3, 5.6, 8.9, 55 km
    const made: any[] = [];
    for (const [i, d] of offsets.entries())
      made.push(
        await mkPlace(u, { name: `Near ${i} ${uniq('n')}`, latitude: c.lat + d, longitude: c.lng }),
      );
    const all = await anon().get('/v1/places/nearby', {
      lat: String(c.lat),
      lng: String(c.lng),
      radiusKm: '10',
    });
    expect(all.status).toBe(200);
    expect(all.body.items.map((x: any) => x.id)).toEqual(made.slice(0, 5).map((x) => x.id));
    const km = all.body.items.map((x: any) => x.distanceKm);
    expect(km).toEqual([...km].sort((a, b) => a - b));
    expect(km[0]).toBeCloseTo(1.11, 1);
    expect(km[4]).toBeCloseTo(8.9, 0);
    // pagination visits every place exactly once
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 6; i++) {
      const r = await anon().get('/v1/places/nearby', {
        lat: String(c.lat),
        lng: String(c.lng),
        radiusKm: '10',
        limit: '2',
        ...(cursor ? { cursor } : {}),
      });
      seen.push(...r.body.items.map((x: any) => x.id));
      cursor = r.body.nextCursor ?? undefined;
      if (!cursor) break;
    }
    expect(seen).toEqual(made.slice(0, 5).map((x) => x.id));
    expect(
      (
        await anon().get('/v1/places/nearby', {
          lat: String(c.lat),
          lng: String(c.lng),
          radiusKm: '100',
        })
      ).body.items,
    ).toHaveLength(6);
    expect((await anon().get('/v1/places/nearby', { lat: '95', lng: '0' })).status).toBe(400);
    expect((await anon().get('/v1/places/nearby', { lat: '0' })).status).toBe(400);
    expect(
      (await anon().get('/v1/places/nearby', { lat: '0', lng: '0', radiusKm: '5000' })).status,
    ).toBe(400);
  });

  it('filters nearby results by kind, minimum rating, text and open-now', async () => {
    const u = await signup(t);
    const c = region();
    const cafe = await mkPlace(u, {
      name: `Cafe ${uniq('c')}`,
      kind: 'restaurant',
      latitude: c.lat + 0.01,
      longitude: c.lng,
      hours: ALL_DAY,
    });
    const shut = await mkPlace(u, {
      name: `Shut ${uniq('s')}`,
      kind: 'store',
      latitude: c.lat + 0.02,
      longitude: c.lng,
      hours: { mon: [['00:00', '00:01']] },
    });
    const unknown = await mkPlace(u, {
      name: `Unknown ${uniq('k')}`,
      kind: 'store',
      latitude: c.lat + 0.03,
      longitude: c.lng,
    });
    const q = { lat: String(c.lat), lng: String(c.lng), radiusKm: '10' };
    expect(
      (await anon().get('/v1/places/nearby', { ...q, kind: 'store' })).body.items.map(
        (x: any) => x.id,
      ),
    ).toEqual([shut.id, unknown.id]);
    expect(
      (await anon().get('/v1/places/nearby', { ...q, q: 'unknown' })).body.items.map(
        (x: any) => x.id,
      ),
    ).toEqual([unknown.id]);
    // open now: only the place that is certainly open (unknown hours are not claimed to be open)
    const open = await anon().get('/v1/places/nearby', { ...q, openNow: 'true' });
    expect(open.body.items.map((x: any) => x.id)).toEqual([cafe.id]);
    const rater = await signup(t);
    expect((await review(rater, unknown.id, 5)).status).toBe(201);
    expect((await review(rater, cafe.id, 2)).status).toBe(201);
    expect(
      (await anon().get('/v1/places/nearby', { ...q, minRating: '4' })).body.items.map(
        (x: any) => x.id,
      ),
    ).toEqual([unknown.id]);
  });

  it('finds places across the antimeridian and near the poles', async () => {
    const u = await signup(t);
    const east = await mkPlace(u, {
      name: `East ${uniq('e')}`,
      latitude: -75.2,
      longitude: 179.95,
    });
    const west = await mkPlace(u, {
      name: `West ${uniq('w')}`,
      latitude: -75.2,
      longitude: -179.95,
    });
    const r = await anon().get('/v1/places/nearby', {
      lat: '-75.2',
      lng: '179.99',
      radiusKm: '20',
    });
    expect(r.body.items.map((x: any) => x.id).sort()).toEqual([east.id, west.id].sort());
    const pole = await mkPlace(u, { name: `Pole ${uniq('p')}`, latitude: 89.9, longitude: 10 });
    const around = await anon().get('/v1/places/nearby', {
      lat: '89.95',
      lng: '-170',
      radiusKm: '20',
    });
    expect(around.body.items.map((x: any) => x.id)).toContain(pole.id);
  });

  it('save and unsave are idempotent and reflected on the place', async () => {
    const u = await signup(t);
    const p = await mkPlace(u);
    expect((await anon().put(`/v1/places/${p.id}/save`)).status).toBe(401);
    expect((await u.client.put(`/v1/places/${p.id}/save`)).status).toBe(200);
    expect((await u.client.put(`/v1/places/${p.id}/save`)).status).toBe(200);
    expect((await u.client.get(`/v1/places/${p.id}`)).body.viewer.saved).toBe(true);
    expect(
      (await sql(`SELECT 1 FROM saves WHERE user_id = $1 AND target_id = $2`, [u.id, p.id]))
        .rowCount,
    ).toBe(1);
    expect((await u.client.del(`/v1/places/${p.id}/save`)).status).toBe(204);
    expect((await u.client.get(`/v1/places/${p.id}`)).body.viewer.saved).toBe(false);
  });
});

describe('photos', () => {
  it("approves the owner's photos immediately and holds everyone else's for review", async () => {
    const { owner, place } = await ownedPlace();
    const visitor = await signup(t);
    const mine = await insertImage(t, owner.id);
    const theirs = await insertImage(t, visitor.id);
    const add = await owner.client.post(`/v1/places/${place.id}/photos`, {
      mediaId: mine,
      caption: 'Front door',
    });
    expect(add.status).toBe(201);
    expect(add.body.status).toBe('approved');
    const pend = await visitor.client.post(`/v1/places/${place.id}/photos`, {
      mediaId: theirs,
      caption: 'My lunch',
    });
    expect(pend.status).toBe(201);
    expect(pend.body.status).toBe('pending_review');
    // public listing: approved only
    const pub = await anon().get(`/v1/places/${place.id}/photos`);
    expect(pub.body.items.map((x: any) => x.mediaId)).toEqual([mine]);
    expect((await anon().get(`/v1/places/${place.id}`)).body.coverUrl).toContain('.jpg');
    // pending list: reviewers only
    expect(
      (await visitor.client.get(`/v1/places/${place.id}/photos`, { status: 'pending_review' }))
        .status,
    ).toBe(403);
    expect(
      (await anon().get(`/v1/places/${place.id}/photos`, { status: 'pending_review' })).status,
    ).toBe(403);
    const q = await owner.client.get(`/v1/places/${place.id}/photos`, { status: 'pending_review' });
    expect(q.body.items).toMatchObject([{ mediaId: theirs, addedBy: visitor.id }]);
    // only reviewers decide
    expect(
      (
        await visitor.client.patch(`/v1/places/${place.id}/photos/${theirs}`, {
          status: 'approved',
        })
      ).status,
    ).toBe(403);
    expect(
      (await owner.client.patch(`/v1/places/${place.id}/photos/${theirs}`, { status: 'approved' }))
        .status,
    ).toBe(200);
    expect((await anon().get(`/v1/places/${place.id}/photos`)).body.items).toHaveLength(2);
    expect(
      (
        await owner.client.patch(`/v1/places/${place.id}/photos/${crypto.randomUUID()}`, {
          status: 'approved',
        })
      ).status,
    ).toBe(404);
    // removal: authors remove their own, reviewers remove any, others get 404
    const third = await signup(t);
    expect((await third.client.del(`/v1/places/${place.id}/photos/${theirs}`)).status).toBe(404);
    expect((await visitor.client.del(`/v1/places/${place.id}/photos/${theirs}`)).status).toBe(204);
    expect(
      (await owner.client.patch(`/v1/places/${place.id}/photos/${mine}`, { status: 'removed' }))
        .status,
    ).toBe(200);
    expect((await anon().get(`/v1/places/${place.id}/photos`)).body.items).toHaveLength(0);
  });

  it('only accepts images the user owns, rejects teens and duplicates', async () => {
    const creator = await signup(t);
    const other = await signup(t);
    const p = await mkPlace(creator);
    const foreign = await insertImage(t, other.id);
    expect(
      (await creator.client.post(`/v1/places/${p.id}/photos`, { mediaId: foreign })).status,
    ).toBe(400);
    expect(
      (
        await creator.client.post(`/v1/places/${p.id}/photos`, {
          mediaId: await insertImage(t, creator.id, { status: 'blocked' }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await creator.client.post(`/v1/places/${p.id}/photos`, {
          mediaId: await insertImage(t, creator.id, { purpose: 'attachment' }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await creator.client.post(`/v1/places/${p.id}/photos`, {
          mediaId: await insertImage(t, creator.id, { kind: 'video' }),
        })
      ).status,
    ).toBe(400);
    expect((await anon().post(`/v1/places/${p.id}/photos`, { mediaId: foreign })).status).toBe(401);
    const good = await insertImage(t, creator.id);
    expect((await creator.client.post(`/v1/places/${p.id}/photos`, { mediaId: good })).status).toBe(
      201,
    );
    expect((await creator.client.post(`/v1/places/${p.id}/photos`, { mediaId: good })).status).toBe(
      409,
    );
    const teen = await signup(t, { birthDate: teenBirth() });
    expect(
      (
        await teen.client.post(`/v1/places/${p.id}/photos`, {
          mediaId: await insertImage(t, teen.id),
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await creator.client.post(`/v1/places/${p.id}/photos`, {
          mediaId: await insertImage(t, creator.id),
          caption: 'give me your seed phrase and private key then send it to me',
        })
      ).status,
    ).toBe(422);
  });
});

describe('reviews', () => {
  it('maintains exact aggregates through create, edit, delete and revive', async () => {
    const author = await signup(t);
    const p = await mkPlace(author);
    const [a, b, c] = [await signup(t), await signup(t), await signup(t)];
    expect((await anon().post(`/v1/places/${p.id}/reviews`, { rating: 5 })).status).toBe(401);
    for (const bad of [0, 6, 3.5, '4', null])
      expect((await a.client.post(`/v1/places/${p.id}/reviews`, { rating: bad })).status).toBe(400);
    const r1 = await review(a, p.id, 5, 'Wonderful');
    expect(r1.status).toBe(201);
    expect(r1.body).toMatchObject({
      rating: 5,
      body: 'Wonderful',
      author: { id: a.id },
      viewer: { isAuthor: true },
      ownerReply: null,
    });
    expect((await review(b, p.id, 2)).status).toBe(201);
    expect((await review(c, p.id, 2)).status).toBe(201);
    expect(await aggregate(p.id)).toEqual({ avg: 3, n: 3 });
    // one review per user
    const dup = await review(a, p.id, 1);
    expect(dup.status).toBe(409);
    expect(await aggregate(p.id)).toEqual({ avg: 3, n: 3 });
    // detail shows the breakdown
    expect((await anon().get(`/v1/places/${p.id}`)).body.rating).toEqual({
      average: 3,
      count: 3,
      breakdown: { '1': 0, '2': 2, '3': 0, '4': 0, '5': 1 },
    });
    // edit
    expect((await b.client.patch(`/v1/reviews/${r1.body.id}`, { rating: 1 })).status).toBe(404);
    expect((await a.client.patch(`/v1/reviews/${r1.body.id}`, {})).status).toBe(400);
    const edited = await a.client.patch(`/v1/reviews/${r1.body.id}`, { rating: 4 });
    expect(edited.body.rating).toBe(4);
    expect(await aggregate(p.id)).toEqual({ avg: 2.67, n: 3 });
    // delete then re-review (the (author, target) row is revived) without double counting
    expect((await b.client.del(`/v1/reviews/${r1.body.id}`)).status).toBe(404);
    expect((await a.client.del(`/v1/reviews/${r1.body.id}`)).status).toBe(204);
    expect(await aggregate(p.id)).toEqual({ avg: 2, n: 2 });
    const again = await review(a, p.id, 5);
    expect(again.status).toBe(201);
    expect(await aggregate(p.id)).toEqual({ avg: 3, n: 3 });
    const list = await anon().get(`/v1/places/${p.id}/reviews`);
    expect(list.body.items).toHaveLength(3);
    expect(
      (await anon().get(`/v1/places/${p.id}/reviews`, { rating: '2' })).body.items,
    ).toHaveLength(2);
    expect(await auditCount(t, 'review.created', r1.body.id)).toBe(2); // created, then revived after deletion
  });

  it('forbids reviewing your own business, including as team member; the listing owner can review others', async () => {
    const { owner, biz, place } = await ownedPlace();
    const support = await addTeam(owner, biz.id, 'support');
    expect((await review(owner, place.id, 5)).status).toBe(403);
    expect((await review(support, place.id, 5)).status).toBe(403);
    expect(await aggregate(place.id)).toEqual({ avg: 0, n: 0 });
    const other = await mkPlace(await signup(t));
    expect((await review(owner, other.id, 4)).status).toBe(201);
    // a user blocked by the owner cannot review the owner's place (and cannot see that it exists as a reason)
    const blocked = await signup(t);
    await block(owner, blocked);
    expect((await review(blocked, place.id, 1)).status).toBe(404);
  });

  it('screens review text: risky reviews are held back from the public list and from the aggregate', async () => {
    const p = await mkPlace(await signup(t));
    const good = await signup(t);
    const risky = await signup(t);
    expect((await review(good, p.id, 4, 'Nice place')).status).toBe(201);
    const held = await review(
      risky,
      p.id,
      1,
      'Give me your seed phrase and private key then send it to me',
    );
    expect(held.status).toBe(201);
    expect(held.body.moderationStatus).not.toBe('approved');
    expect(await aggregate(p.id)).toEqual({ avg: 4, n: 1 });
    expect((await anon().get(`/v1/places/${p.id}/reviews`)).body.items).toHaveLength(1);
    const mine = await risky.client.get(`/v1/places/${p.id}/reviews`);
    expect(mine.body.items.map((r: any) => r.author.id)).toContain(risky.id);
    expect(
      (
        await sql(
          `SELECT 1 FROM moderation_cases WHERE target_type = 'review' AND target_id = $1`,
          [held.body.id],
        )
      ).rowCount,
    ).toBe(1);
    // held reviews cannot be edited into approval
    expect(
      (await risky.client.patch(`/v1/reviews/${held.body.id}`, { body: 'Actually lovely' })).status,
    ).toBe(403);
  });

  it('hides reviews of blocked users in both directions and reviews of deleted accounts', async () => {
    const p = await mkPlace(await signup(t));
    const [a, b, c] = [await signup(t), await signup(t), await signup(t)];
    await review(a, p.id, 5, 'from a');
    await review(b, p.id, 3, 'from b');
    await block(a, c);
    const seenByC = await c.client.get(`/v1/places/${p.id}/reviews`);
    expect(seenByC.body.items.map((r: any) => r.author.id)).toEqual([b.id]);
    const seenByA = await a.client.get(`/v1/places/${p.id}/reviews`);
    expect(seenByA.body.items.map((r: any) => r.author.id).sort()).toEqual([a.id, b.id].sort());
    await sql(`UPDATE users SET status = 'deleted', deleted_at = now() WHERE id = $1`, [b.id]);
    expect(
      (await anon().get(`/v1/places/${p.id}/reviews`)).body.items.map((r: any) => r.author.id),
    ).toEqual([a.id]);
  });

  it('CONCURRENCY: parallel reviews from many users keep the aggregate exact; parallel duplicates from one user yield exactly one', async () => {
    const p = await mkPlace(await signup(t));
    const users = await Promise.all(Array.from({ length: 8 }, () => signup(t)));
    const res = await Promise.all(users.map((u, i) => review(u, p.id, (i % 5) + 1)));
    expect(res.every((r) => r.status === 201)).toBe(true);
    const truth = (
      await sql(
        `SELECT count(*)::int AS n, round(avg(rating), 2)::float AS avg FROM reviews WHERE target_id = $1 AND deleted_at IS NULL`,
        [p.id],
      )
    ).rows[0];
    expect(await aggregate(p.id)).toEqual({ avg: truth.avg, n: 8 });
    const solo = await signup(t);
    const dupes = await Promise.all(Array.from({ length: 5 }, () => review(solo, p.id, 5)));
    expect(dupes.filter((r) => r.status === 201)).toHaveLength(1);
    expect(dupes.filter((r) => r.status === 409)).toHaveLength(4);
    expect((await aggregate(p.id)).n).toBe(9);
    // concurrent edits + deletes never leave the aggregate inconsistent
    const list = (await anon().get(`/v1/places/${p.id}/reviews`, { limit: '50' })).body
      .items as any[];
    await Promise.all([
      users[0]!.client.del(`/v1/reviews/${list.find((r) => r.author.id === users[0]!.id).id}`),
      users[1]!.client.patch(`/v1/reviews/${list.find((r) => r.author.id === users[1]!.id).id}`, {
        rating: 5,
      }),
      users[2]!.client.del(`/v1/reviews/${list.find((r) => r.author.id === users[2]!.id).id}`),
    ]);
    const truth2 = (
      await sql(
        `SELECT count(*)::int AS n, round(avg(rating), 2)::float AS avg FROM reviews WHERE target_id = $1 AND deleted_at IS NULL AND moderation_status = 'approved'`,
        [p.id],
      )
    ).rows[0];
    expect(await aggregate(p.id)).toEqual({ avg: truth2.avg, n: truth2.n });
  });

  it('lets the business team reply (reviews.reply), notifies the author and validates the reply', async () => {
    const { owner, biz, place } = await ownedPlace();
    const editor = await addTeam(owner, biz.id, 'editor');
    const support = await addTeam(owner, biz.id, 'support');
    const guest = await signup(t);
    const stranger = await signup(t);
    const r = await review(guest, place.id, 3, 'Okay');
    const id = r.body.id;
    expect((await anon().put(`/v1/reviews/${id}/reply`, { body: 'Thanks' })).status).toBe(401);
    expect((await stranger.client.put(`/v1/reviews/${id}/reply`, { body: 'Thanks' })).status).toBe(
      404,
    );
    expect(
      (await guest.client.put(`/v1/reviews/${id}/reply`, { body: 'Replying to myself' })).status,
    ).toBe(404);
    expect((await owner.client.put(`/v1/reviews/${id}/reply`, { body: '' })).status).toBe(400);
    expect(
      (
        await owner.client.put(`/v1/reviews/${id}/reply`, {
          body: 'give me your seed phrase and private key then send it to me',
        })
      ).status,
    ).toBe(422);
    const ok = await editor.client.put(`/v1/reviews/${id}/reply`, {
      body: 'Thank you for visiting',
    });
    expect(ok.status).toBe(200);
    expect(ok.body.ownerReply).toMatchObject({ body: 'Thank you for visiting' });
    expect(await notifCount(t, guest.id, 'review_reply')).toBe(1);
    expect(
      (await support.client.put(`/v1/reviews/${id}/reply`, { body: 'Support reply' })).status,
    ).toBe(200);
    expect((await anon().get(`/v1/places/${place.id}/reviews`)).body.items[0].ownerReply.body).toBe(
      'Support reply',
    );
    expect((await guest.client.del(`/v1/reviews/${id}/reply`)).status).toBe(404);
    expect((await owner.client.del(`/v1/reviews/${id}/reply`)).status).toBe(204);
    expect(
      (await anon().get(`/v1/places/${place.id}/reviews`)).body.items[0].ownerReply,
    ).toBeNull();
    // places without a business cannot have owner replies at all
    const free = await mkPlace(guest);
    const fr = await review(stranger, free.id, 4);
    expect((await guest.client.put(`/v1/reviews/${fr.body.id}/reply`, { body: 'Hi' })).status).toBe(
      404,
    );
  });

  it('reports reviews once per reason, never your own', async () => {
    const p = await mkPlace(await signup(t));
    const author = await signup(t);
    const reporter = await signup(t);
    const r = await review(author, p.id, 1, 'Awful');
    expect(
      (await author.client.post(`/v1/reviews/${r.body.id}/report`, { reason: 'spam' })).status,
    ).toBe(400);
    expect((await anon().post(`/v1/reviews/${r.body.id}/report`, { reason: 'spam' })).status).toBe(
      401,
    );
    expect(
      (await reporter.client.post(`/v1/reviews/${r.body.id}/report`, { reason: 'nonsense' }))
        .status,
    ).toBe(400);
    expect(
      (await reporter.client.post(`/v1/reviews/${r.body.id}/report`, { reason: 'spam' })).status,
    ).toBe(201);
    expect(
      (await reporter.client.post(`/v1/reviews/${r.body.id}/report`, { reason: 'spam' })).status,
    ).toBe(200);
    expect(
      (
        await sql(`SELECT 1 FROM reports WHERE target_type = 'review' AND target_id = $1`, [
          r.body.id,
        ])
      ).rowCount,
    ).toBe(1);
    await block(author, reporter);
    expect(
      (await reporter.client.post(`/v1/reviews/${r.body.id}/report`, { reason: 'other' })).status,
    ).toBe(404);
  });
});

describe('business claims', () => {
  it('runs the claim workflow: request, staff approval, audit, notification, place becomes owned', async () => {
    const owner = await signup(t);
    const biz = await mkBusiness(owner);
    const p = await mkPlace(await signup(t));
    const claim = await owner.client.post(`/v1/places/${p.id}/claims`, {
      businessId: biz.id,
      evidence: 'Lease agreement',
    });
    expect(claim.status).toBe(201);
    expect(claim.body).toMatchObject({
      status: 'pending',
      place: { id: p.id },
      business: { id: biz.id },
    });
    expect((await anon().get(`/v1/places/${p.id}`)).body.claimed).toBe(false);
    // a second pending claim by the same business is refused
    expect(
      (await owner.client.post(`/v1/places/${p.id}/claims`, { businessId: biz.id })).status,
    ).toBe(409);
    const mine = await owner.client.get('/v1/me/place-claims');
    expect(mine.body.items.map((c: any) => c.id)).toEqual([claim.body.id]);
    // the queue is staff only
    const queue = await moderator.client.get('/v1/staff/place-claims');
    expect(queue.status).toBe(200);
    expect(queue.body.items.map((c: any) => c.id)).toContain(claim.body.id);
    expect((await owner.client.get('/v1/staff/place-claims')).status).toBe(403);
    expect((await supportStaff.client.get('/v1/staff/place-claims')).status).toBe(403);
    expect((await anon().get('/v1/staff/place-claims')).status).toBe(401);
    expect(
      (await owner.client.post(`/v1/staff/place-claims/${claim.body.id}/approve`, {})).status,
    ).toBe(403);
    const ok = await moderator.client.post(`/v1/staff/place-claims/${claim.body.id}/approve`, {
      note: 'Documents verified',
    });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ status: 'approved', decisionNote: 'Documents verified' });
    const after = await anon().get(`/v1/places/${p.id}`);
    expect(after.body).toMatchObject({ claimed: true, business: { id: biz.id } });
    expect(await auditCount(t, 'place.claim_approved', p.id)).toBe(1);
    const log = (
      await sql(
        `SELECT actor_id, actor_type FROM audit_logs WHERE action = 'place.claim_approved' AND target_id = $1`,
        [p.id],
      )
    ).rows[0];
    expect(log).toMatchObject({ actor_id: moderator.id, actor_type: 'staff' });
    expect(await notifCount(t, owner.id, 'place_claim_approved')).toBe(1);
    // decided claims cannot be decided again; an owned place cannot be claimed again
    expect(
      (await moderator.client.post(`/v1/staff/place-claims/${claim.body.id}/approve`, {})).status,
    ).toBe(409);
    expect(
      (await moderator.client.post(`/v1/staff/place-claims/${claim.body.id}/reject`, {})).status,
    ).toBe(409);
    expect(
      (await owner.client.post(`/v1/places/${p.id}/claims`, { businessId: biz.id })).status,
    ).toBe(409);
    expect(
      (await moderator.client.get('/v1/staff/place-claims', { status: 'approved' })).body.items.map(
        (c: any) => c.id,
      ),
    ).toContain(claim.body.id);
  });

  it('rejects claims with a note, allows withdrawal by the claimant business only, and permits a new claim afterwards', async () => {
    const owner = await signup(t);
    const editor = await signup(t);
    const biz = await mkBusiness(owner);
    await owner.client.post(`/v1/businesses/${biz.id}/invitations`, {
      username: editor.username,
      role: 'editor',
    });
    await editor.client.post(`/v1/businesses/${biz.id}/invitation/accept`);
    const stranger = await signup(t);
    const p = await mkPlace(await signup(t));
    expect(
      (await editor.client.post(`/v1/places/${p.id}/claims`, { businessId: biz.id })).status,
    ).toBe(403); // editors cannot claim
    expect(
      (await stranger.client.post(`/v1/places/${p.id}/claims`, { businessId: biz.id })).status,
    ).toBe(404);
    expect(
      (await owner.client.post(`/v1/places/${p.id}/claims`, { businessId: crypto.randomUUID() }))
        .status,
    ).toBe(404);
    const c1 = await owner.client.post(`/v1/places/${p.id}/claims`, { businessId: biz.id });
    expect((await stranger.client.post(`/v1/place-claims/${c1.body.id}/withdraw`)).status).toBe(
      404,
    );
    expect((await owner.client.post(`/v1/place-claims/${c1.body.id}/withdraw`)).status).toBe(204);
    expect((await owner.client.post(`/v1/place-claims/${c1.body.id}/withdraw`)).status).toBe(409);
    const c2 = await owner.client.post(`/v1/places/${p.id}/claims`, { businessId: biz.id });
    expect(c2.status).toBe(201);
    const rej = await moderator.client.post(`/v1/staff/place-claims/${c2.body.id}/reject`, {
      note: 'Insufficient evidence',
    });
    expect(rej.body).toMatchObject({ status: 'rejected', decisionNote: 'Insufficient evidence' });
    expect((await anon().get(`/v1/places/${p.id}`)).body.claimed).toBe(false);
    expect(await notifCount(t, owner.id, 'place_claim_rejected')).toBe(1);
    expect(await auditCount(t, 'place.claim_rejected', p.id)).toBe(1);
    expect((await owner.client.post(`/v1/place-claims/${c2.body.id}/withdraw`)).status).toBe(409);
    expect(
      (await moderator.client.post(`/v1/staff/place-claims/${crypto.randomUUID()}/approve`, {}))
        .status,
    ).toBe(404);
  });

  it('CONCURRENCY: competing claims of one place, approved in parallel, produce exactly one owner and no deadlock', async () => {
    const p = await mkPlace(await signup(t));
    const owners = await Promise.all([signup(t), signup(t), signup(t)]);
    const bizs = await Promise.all(owners.map((o) => mkBusiness(o)));
    const claims = await Promise.all(
      owners.map((o, i) => o.client.post(`/v1/places/${p.id}/claims`, { businessId: bizs[i]!.id })),
    );
    expect(claims.every((c) => c.status === 201)).toBe(true);
    const res = await Promise.all(
      claims.map((c) => moderator.client.post(`/v1/staff/place-claims/${c.body.id}/approve`, {})),
    );
    expect(res.filter((r) => r.status === 200)).toHaveLength(1);
    expect(res.filter((r) => r.status === 409)).toHaveLength(2);
    const winner = res.find((r) => r.status === 200)!.body.business.id;
    expect(
      (await sql('SELECT business_id FROM places WHERE id = $1', [p.id])).rows[0].business_id,
    ).toBe(winner);
    expect(
      (
        await sql(
          `SELECT count(*)::int AS n FROM place_claims WHERE place_id = $1 AND status = 'approved'`,
          [p.id],
        )
      ).rows[0].n,
    ).toBe(1);
  });

  it('refuses to approve a claim for a business that is no longer active', async () => {
    const owner = await signup(t);
    const biz = await mkBusiness(owner);
    const p = await mkPlace(await signup(t));
    const c = await owner.client.post(`/v1/places/${p.id}/claims`, { businessId: biz.id });
    await sql(`UPDATE businesses SET status = 'suspended' WHERE id = $1`, [biz.id]);
    expect(
      (await moderator.client.post(`/v1/staff/place-claims/${c.body.id}/approve`, {})).status,
    ).toBe(422);
    expect((await anon().get(`/v1/places/${p.id}`)).body.claimed).toBe(false);
  });
});

describe('suggest an edit', () => {
  it('lets anyone propose validated changes; the owner team applies or rejects them', async () => {
    const { owner, biz, place } = await ownedPlace({ description: 'Original' });
    const editor = await addTeam(owner, biz.id, 'editor');
    const support = await addTeam(owner, biz.id, 'support');
    const guest = await signup(t);
    const stranger = await signup(t);
    expect(
      (
        await anon().post(`/v1/places/${place.id}/suggestions`, {
          changes: { phone: '+1 555 0100' },
        })
      ).status,
    ).toBe(401);
    expect(
      (await guest.client.post(`/v1/places/${place.id}/suggestions`, { changes: {} })).status,
    ).toBe(400);
    expect(
      (
        await guest.client.post(`/v1/places/${place.id}/suggestions`, {
          changes: { bookingEnabled: true },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await guest.client.post(`/v1/places/${place.id}/suggestions`, {
          changes: { hours: { mon: [['5pm', '9pm']] } },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await guest.client.post(`/v1/places/${place.id}/suggestions`, {
          changes: { website: 'ftp://x.example' },
        })
      ).status,
    ).toBe(400);
    const s1 = await guest.client.post(`/v1/places/${place.id}/suggestions`, {
      changes: { phone: '+1 555 0100', hours: { tue: [['08:00', '12:00']] } },
      note: 'Their sign says so',
    });
    expect(s1.status).toBe(201);
    expect(s1.body).toMatchObject({ status: 'pending', placeId: place.id, suggestedBy: guest.id });
    const s2 = await guest.client.post(`/v1/places/${place.id}/suggestions`, {
      changes: { description: 'Better description' },
    });
    // visibility of the review queue
    expect((await guest.client.get(`/v1/places/${place.id}/suggestions`)).status).toBe(403);
    expect((await anon().get(`/v1/places/${place.id}/suggestions`)).status).toBe(401);
    const queue = await editor.client.get(`/v1/places/${place.id}/suggestions`);
    expect(queue.body.items.map((s: any) => s.id).sort()).toEqual([s1.body.id, s2.body.id].sort());
    expect((await guest.client.get('/v1/me/place-suggestions')).body.items).toHaveLength(2);
    // decisions
    expect((await stranger.client.post(`/v1/place-suggestions/${s1.body.id}/accept`)).status).toBe(
      404,
    ); // not a reviewer, and not revealing
    expect((await guest.client.post(`/v1/place-suggestions/${s1.body.id}/accept`)).status).toBe(
      403,
    ); // nobody approves their own suggestion
    expect((await support.client.post(`/v1/place-suggestions/${s1.body.id}/accept`)).status).toBe(
      404,
    ); // support has no places.manage: not a reviewer
    const acc = await editor.client.post(`/v1/place-suggestions/${s1.body.id}/accept`, {
      note: 'Thanks',
    });
    expect(acc.status).toBe(200);
    expect(acc.body.status).toBe('accepted');
    const now = (await anon().get(`/v1/places/${place.id}`)).body;
    expect(now).toMatchObject({
      phone: '+1 555 0100',
      hours: { tue: [['08:00', '12:00']] },
      description: 'Original',
    });
    expect(await notifCount(t, guest.id, 'place_suggestion_accepted')).toBe(1);
    expect((await editor.client.post(`/v1/place-suggestions/${s1.body.id}/accept`)).status).toBe(
      409,
    );
    const rej = await owner.client.post(`/v1/place-suggestions/${s2.body.id}/reject`, {
      note: 'Not accurate',
    });
    expect(rej.body).toMatchObject({ status: 'rejected', reviewNote: 'Not accurate' });
    expect((await anon().get(`/v1/places/${place.id}`)).body.description).toBe('Original');
    expect(await auditCount(t, 'place.suggestion_accepted', place.id)).toBe(1);
  });

  it('lets staff review suggestions on unclaimed places, but never the suggester or the creator', async () => {
    const creator = await signup(t);
    const guest = await signup(t);
    const p = await mkPlace(creator, { name: `Old name ${uniq('o')}` });
    const s = await guest.client.post(`/v1/places/${p.id}/suggestions`, {
      changes: { name: `New name ${uniq('n')}` },
    });
    expect((await creator.client.post(`/v1/place-suggestions/${s.body.id}/accept`)).status).toBe(
      404,
    );
    expect((await guest.client.post(`/v1/place-suggestions/${s.body.id}/accept`)).status).toBe(403); // cannot approve your own
    expect((await moderator.client.post(`/v1/place-suggestions/${s.body.id}/accept`)).status).toBe(
      200,
    );
    expect((await anon().get(`/v1/places/${p.id}`)).body.name).toBe(s.body.changes.name);
    // withdraw: own pending suggestions only
    const s2 = await guest.client.post(`/v1/places/${p.id}/suggestions`, {
      changes: { phone: '+44 20 7946 0000' },
    });
    expect((await creator.client.post(`/v1/place-suggestions/${s2.body.id}/withdraw`)).status).toBe(
      404,
    );
    expect((await guest.client.post(`/v1/place-suggestions/${s2.body.id}/withdraw`)).status).toBe(
      200,
    );
    expect((await guest.client.post(`/v1/place-suggestions/${s2.body.id}/withdraw`)).status).toBe(
      409,
    );
  });

  it('caps pending suggestions per user and place, and refuses stale/invalid stored changes', async () => {
    const p = await mkPlace(await signup(t));
    const guest = await signup(t);
    for (let i = 0; i < 5; i++)
      expect(
        (
          await guest.client.post(`/v1/places/${p.id}/suggestions`, {
            changes: { phone: `+1 555 010${i}` },
          })
        ).status,
      ).toBe(201);
    expect(
      (
        await guest.client.post(`/v1/places/${p.id}/suggestions`, {
          changes: { phone: '+1 555 0199' },
        })
      ).status,
    ).toBe(409);
    const s = await guest.client.post(
      `/v1/places/${(await mkPlace(await signup(t))).id}/suggestions`,
      { changes: { phone: '+1 555 0100' } },
    );
    await sql(
      `UPDATE place_edit_suggestions SET changes = '{"latitude": 999, "longitude": 1}' WHERE id = $1`,
      [s.body.id],
    );
    expect((await moderator.client.post(`/v1/place-suggestions/${s.body.id}/accept`)).status).toBe(
      422,
    );
  });
});

describe('events and products of a place', () => {
  it('lists upcoming events at a place, honouring event visibility', async () => {
    const host = await signup(t);
    const friend = await signup(t);
    const stranger = await signup(t);
    await befriend(host, friend);
    const p = await mkPlace(host);
    const mk = async (over: Record<string, unknown>) =>
      (
        await host.client.post('/v1/events', {
          title: `Gig ${uniq('g')}`,
          startsAt: inDays(2),
          endsAt: inDays(2, 2),
          placeId: p.id,
          publish: true,
          ...over,
        })
      ).body;
    const pub = await mk({ visibility: 'public' });
    const fr = await mk({ visibility: 'friends', startsAt: inDays(3), endsAt: inDays(3, 2) });
    const priv = await mk({ visibility: 'private', startsAt: inDays(4), endsAt: inDays(4, 2) });
    const draft = await host.client.post('/v1/events', {
      title: 'Draft gig',
      startsAt: inDays(5),
      placeId: p.id,
    });
    const past = await mk({});
    await sql(
      `UPDATE events SET starts_at = now() - interval '2 days', ends_at = now() - interval '1 day' WHERE id = $1`,
      [past.id],
    );
    const ids = (r: any) => r.body.items.map((e: any) => e.id);
    expect(ids(await anon().get(`/v1/places/${p.id}/events`))).toEqual([pub.id]);
    expect(ids(await stranger.client.get(`/v1/places/${p.id}/events`))).toEqual([pub.id]);
    expect(ids(await friend.client.get(`/v1/places/${p.id}/events`))).toEqual([pub.id, fr.id]);
    expect(ids(await host.client.get(`/v1/places/${p.id}/events`))).toEqual([
      pub.id,
      fr.id,
      priv.id,
    ]);
    expect(ids(await host.client.get(`/v1/places/${p.id}/events`))).not.toContain(draft.body.id);
    const page1 = await friend.client.get(`/v1/places/${p.id}/events`, { limit: '1' });
    expect(page1.body.nextCursor).toBeTruthy();
    expect(
      ids(
        await friend.client.get(`/v1/places/${p.id}/events`, {
          limit: '1',
          cursor: page1.body.nextCursor,
        }),
      ),
    ).toEqual([fr.id]);
    await block(host, stranger);
    expect(ids(await stranger.client.get(`/v1/places/${p.id}/events`))).toEqual([]);
  });

  it('lists the active products of the owning business and nothing for unclaimed places', async () => {
    const { owner, biz, place } = await ownedPlace();
    const unclaimed = await mkPlace(owner);
    await sql(
      `INSERT INTO products (business_id, kind, title, price_cents, currency, status) VALUES
         ($1,'physical','Mug',1200,'USD','active'), ($1,'service','Haircut',3000,'USD','active'), ($1,'physical','Old mug',900,'USD','archived'), ($1,'physical','Secret draft',900,'USD','draft')`,
      [biz.id],
    );
    const r = await anon().get(`/v1/places/${place.id}/products`);
    expect(r.status).toBe(200);
    expect(r.body.items.map((x: any) => x.title).sort()).toEqual(['Haircut', 'Mug']);
    expect(r.body.items.find((x: any) => x.title === 'Mug')).toMatchObject({
      priceCents: 1200,
      currency: 'USD',
      inStock: true,
    });
    expect((await anon().get(`/v1/places/${unclaimed.id}/products`)).body.items).toEqual([]);
    expect((await anon().get(`/v1/places/${crypto.randomUUID()}/products`)).status).toBe(404);
  });
});

describe('account deletion hook', () => {
  const runHooks = (userId: string) =>
    withTransaction(t.ctx.db, async (tx) => {
      for (const h of getDeletionHooks()) await h(t.ctx, tx, userId);
    });

  it("removes a user's reviews (recomputing aggregates), suggestions, saves, photos and pending claims", async () => {
    const leaver = await signup(t);
    const stay = await signup(t);
    const p = await mkPlace(stay);
    await review(leaver, p.id, 1);
    await review(stay, (await mkPlace(leaver)).id, 3);
    const other = await signup(t);
    await review(other, p.id, 5);
    expect(await aggregate(p.id)).toEqual({ avg: 3, n: 2 });
    await leaver.client.post(`/v1/places/${p.id}/suggestions`, {
      changes: { phone: '+1 555 0100' },
    });
    await leaver.client.put(`/v1/places/${p.id}/save`);
    const media = await insertImage(t, leaver.id);
    await leaver.client.post(`/v1/places/${p.id}/photos`, { mediaId: media });
    const biz = await mkBusiness(leaver);
    const c = await leaver.client.post(`/v1/places/${p.id}/claims`, { businessId: biz.id });
    await runHooks(leaver.id);
    expect(await aggregate(p.id)).toEqual({ avg: 5, n: 1 });
    expect((await sql('SELECT 1 FROM reviews WHERE author_id = $1', [leaver.id])).rowCount).toBe(0);
    expect(
      (await sql('SELECT 1 FROM place_edit_suggestions WHERE suggested_by = $1', [leaver.id]))
        .rowCount,
    ).toBe(0);
    expect((await sql(`SELECT 1 FROM saves WHERE user_id = $1`, [leaver.id])).rowCount).toBe(0);
    expect((await sql('SELECT 1 FROM place_media WHERE added_by = $1', [leaver.id])).rowCount).toBe(
      0,
    );
    expect(
      (await sql('SELECT status FROM place_claims WHERE id = $1', [c.body.id])).rows[0].status,
    ).toBe('withdrawn');
    // the places the leaver created stay (created_by is nulled by the FK when the user row is removed)
    expect((await sql('SELECT 1 FROM places WHERE created_by = $1', [leaver.id])).rowCount).toBe(1);
  });
});
