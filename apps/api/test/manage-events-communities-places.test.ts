import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { as, signUp, testApp } from './helpers.ts';
import type { BuiltApp } from '../src/app.ts';

let t: BuiltApp;
beforeAll(async () => {
  t = await testApp();
});
afterAll(async () => {
  await t.close();
});

const ADULT = '1990-04-02';
const tag = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const inDays = (d: number, h = 0) => new Date(Date.now() + d * 86_400_000 + h * 3_600_000).toISOString();

describe('hosts edit their events', () => {
  it('changes only what is sent, checks the end, and tells people when the time moves', async () => {
    const host = await signUp(t.app);
    const guest = await signUp(t.app);
    const other = await signUp(t.app);
    const created = await as(t.app, host).post('/v1/events', {
      title: 'Picnic',
      startsAt: inDays(3),
      endsAt: inDays(3, 2),
      timezone: 'Africa/Lagos',
      locationText: 'Freedom Park',
      capacity: 10,
    });
    expect(created.status).toBe(201);
    const id = created.body.event.id;
    await as(t.app, guest).post(`/v1/events/${id}/rsvp`, { status: 'going' });

    // Someone else can't change it.
    expect((await as(t.app, other).patch(`/v1/events/${id}`, { title: 'Mine now' })).status).toBe(404);

    // A new title alone keeps everything else, and nobody is told.
    const renamed = await as(t.app, host).patch(`/v1/events/${id}`, { title: 'Picnic in the park' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.event).toMatchObject({ title: 'Picnic in the park', locationText: 'Freedom Park', capacity: 10, timezone: 'Africa/Lagos' });
    const quiet = await t.ctx.db.query(`SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND type = 'event_updated'`, [guest.id]);
    expect(quiet.rows[0].n).toBe(0);

    // An end before the start is refused, against the stored start.
    const bad = await as(t.app, host).patch(`/v1/events/${id}`, { endsAt: inDays(2) });
    expect(bad.status).toBe(400);
    expect(bad.body.error.details.fields.endsAt).toBeTruthy();

    // Moving it, clearing the end and the capacity, going online: people who answered hear about it.
    const moved = await as(t.app, host).patch(`/v1/events/${id}`, { startsAt: inDays(4), endsAt: null, capacity: null, online: true, locationText: null });
    expect(moved.status).toBe(200);
    expect(moved.body.event).toMatchObject({ endsAt: null, capacity: null, online: true, locationText: null });
    const told = await t.ctx.db.query(`SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND type = 'event_updated'`, [guest.id]);
    expect(told.rows[0].n).toBe(1);

    // Cancelled events can't be edited.
    expect((await as(t.app, host).del(`/v1/events/${id}`)).status).toBe(200);
    expect((await as(t.app, host).patch(`/v1/events/${id}`, { title: 'Back' })).status).toBe(404);
  });
});

describe('community join requests and bans', () => {
  it('lets moderators decline requests, list bans and lift them', async () => {
    const owner = await signUp(t.app);
    const asker = await signUp(t.app);
    const member = await signUp(t.app);
    const slug = `mod${tag()}`;
    expect((await as(t.app, owner).post('/v1/communities', { slug, name: 'Quiet Readers', visibility: 'private' })).status).toBe(201);

    expect((await as(t.app, asker).post(`/v1/communities/${slug}/join`)).body.status).toBe('pending');
    expect((await as(t.app, member).post(`/v1/communities/${slug}/join`)).body.status).toBe('pending');
    const pending = await as(t.app, owner).get(`/v1/communities/${slug}/members?status=pending`);
    expect(pending.body.items.map((m: any) => m.user.id).sort()).toEqual([asker.id, member.id].sort());

    // Only moderators decline, and a declined person can ask again.
    expect((await as(t.app, asker).post(`/v1/communities/${slug}/members/${asker.id}/decline`)).status).toBe(403);
    expect((await as(t.app, owner).post(`/v1/communities/${slug}/members/${asker.id}/decline`)).status).toBe(200);
    expect((await as(t.app, owner).post(`/v1/communities/${slug}/members/${asker.id}/decline`)).status).toBe(404);
    expect((await as(t.app, asker).post(`/v1/communities/${slug}/join`)).body.status).toBe('pending');

    // Approve, then ban: the ban shows in the banned list, not the members.
    expect((await as(t.app, owner).post(`/v1/communities/${slug}/members/${member.id}/approve`)).status).toBe(200);
    expect((await as(t.app, owner).post(`/v1/communities/${slug}/members/${member.id}/ban`)).status).toBe(200);
    expect((await as(t.app, member).get(`/v1/communities/${slug}/members?status=banned`)).status).toBe(403);
    const banned = await as(t.app, owner).get(`/v1/communities/${slug}/members?status=banned`);
    expect(banned.body.items.map((m: any) => m.user.id)).toEqual([member.id]);
    expect((await as(t.app, member).post(`/v1/communities/${slug}/join`)).status).toBe(403);

    // Lifting the ban lets them ask again.
    expect((await as(t.app, owner).post(`/v1/communities/${slug}/members/${member.id}/unban`)).status).toBe(200);
    expect((await as(t.app, owner).post(`/v1/communities/${slug}/members/${member.id}/unban`)).status).toBe(404);
    expect((await as(t.app, owner).get(`/v1/communities/${slug}/members?status=banned`)).body.items).toEqual([]);
    expect((await as(t.app, member).post(`/v1/communities/${slug}/join`)).body.status).toBe('pending');
  });
});

describe('place availability', () => {
  it('says how many more people fit at each time, counted like a booking', async () => {
    const owner = await signUp(t.app, { birthDate: ADULT });
    const guest = await signUp(t.app, { birthDate: ADULT });
    const biz = (await as(t.app, owner).post('/v1/businesses', { name: 'Slot Kitchen', slug: `slots-${tag()}` })).body.business;
    const place = (await as(t.app, owner).post('/v1/places', { name: 'Slot Kitchen', category: 'restaurant', businessId: biz.id })).body.place;

    const at = [inDays(5), inDays(5, 1), inDays(5, 4)];
    const open = await as(t.app, guest).get(`/v1/places/${place.id}/availability?at=${encodeURIComponent(at.join(','))}`);
    expect(open.status).toBe(200);
    expect(open.body).toMatchObject({ takesBookings: true, capacity: null });
    expect(open.body.slots.map((s: any) => s.left)).toEqual([null, null, null]);

    await t.ctx.db.query(`UPDATE places SET booking_capacity = 10 WHERE id = $1`, [place.id]);
    expect((await as(t.app, guest).post(`/v1/places/${place.id}/bookings`, { partySize: 4, startsAt: at[0] })).status).toBe(201);
    const after = await as(t.app, null).get(`/v1/places/${place.id}/availability?at=${encodeURIComponent(at.join(','))}`);
    expect(after.body.capacity).toBe(10);
    expect(after.body.slots).toEqual([
      { startsAt: at[0], left: 6 },
      { startsAt: at[1], left: 6 },
      { startsAt: at[2], left: 10 },
    ]);

    expect((await as(t.app, guest).get(`/v1/places/${place.id}/availability?at=nope`)).status).toBe(400);
  });
});
