import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BuiltApp } from '../src/app.ts';
import { LIVE_MAX_HOURS, sweepLives } from '../src/lib/live.ts';
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

const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();
async function newEvent(host: TestUser, extra: Record<string, unknown> = {}): Promise<string> {
  const r = await as(t.app, host).post('/v1/events', { title: 'Sweep night', startsAt: inDays(3), timezone: 'Africa/Lagos', ...extra });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.event.id;
}
const rsvp = (u: TestUser, id: string, status: 'going' | 'interested' | 'not_going') => as(t.app, u).post(`/v1/events/${id}/rsvp`, { status });
const validTickets = async (u: TestUser, id: string) =>
  (await as(t.app, u).get('/v1/tickets')).body.items.filter((x: { event: { id: string }; status: string }) => x.event.id === id && x.status === 'valid');

describe('events', () => {
  it('a place that opens goes to the first person on the waitlist, with a ticket and a notification', async () => {
    const host = await signUp(t.app);
    const [a, b, c] = [await signUp(t.app), await signUp(t.app), await signUp(t.app)];
    // The host counts as going, so two places leave one for a guest.
    const id = await newEvent(host, { capacity: 2 });
    expect((await rsvp(a, id, 'going')).body.status).toBe('going');
    expect((await rsvp(b, id, 'going')).body.status).toBe('waitlist');
    expect((await rsvp(c, id, 'going')).body.status).toBe('waitlist');
    const asB = (await as(t.app, b).get(`/v1/events/${id}`)).body.event;
    expect(asB).toMatchObject({ myRsvp: 'interested', onWaitlist: true });
    // Answering again keeps b's place in the line.
    await rsvp(b, id, 'going');
    expect(await validTickets(b, id)).toHaveLength(0);
    await rsvp(a, id, 'not_going');
    expect((await as(t.app, b).get(`/v1/events/${id}`)).body.event).toMatchObject({ myRsvp: 'going', onWaitlist: false });
    expect(await validTickets(b, id)).toHaveLength(1);
    expect((await as(t.app, c).get(`/v1/events/${id}`)).body.event.onWaitlist).toBe(true);
    const told = await db().query(`SELECT user_id FROM notifications WHERE type = 'event_waitlist_in' AND entity_id = $1`, [id]);
    expect(told.rows.map((r) => r.user_id)).toEqual([b.id]);
    // More room from the host lets the rest in.
    expect((await as(t.app, host).patch(`/v1/events/${id}`, { capacity: null })).status).toBe(200);
    expect((await as(t.app, c).get(`/v1/events/${id}`)).body.event.myRsvp).toBe('going');
    expect(await validTickets(c, id)).toHaveLength(1);
  });

  it('an event for people with the link opens by its address but is never listed', async () => {
    const host = await signUp(t.app);
    const guest = await signUp(t.app);
    const id = await newEvent(host, { visibility: 'private', title: 'Secret supper' });
    expect((await as(t.app, guest).get(`/v1/events/${id}`)).status).toBe(200);
    expect((await rsvp(guest, id, 'going')).status).toBe(200);
    const stranger = await signUp(t.app);
    const listed = await as(t.app, stranger).get('/v1/events?limit=50');
    expect(listed.body.items.map((e: { id: string }) => e.id)).not.toContain(id);
    // Someone the host blocked doesn't get it even with the link.
    await as(t.app, host).post(`/v1/users/${stranger.id}/block`);
    expect((await as(t.app, stranger).get(`/v1/events/${id}`)).status).toBe(404);
  });

  it("answering an event that's over is refused", async () => {
    const host = await signUp(t.app);
    const guest = await signUp(t.app);
    const id = await newEvent(host, { startsAt: inDays(-2), endsAt: inDays(-1.9) });
    const r = await rsvp(guest, id, 'going');
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('event_over');
  });

  it("an online event's location must be a web link", async () => {
    const host = await signUp(t.app);
    const bad = await as(t.app, host).post('/v1/events', { title: 'Call', startsAt: inDays(1), online: true, locationText: 'javascript:alert(1)' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.details.fields.locationText).toBeTruthy();
    const id = await newEvent(host, { online: true, locationText: 'https://meet.example.test/abc' });
    expect((await as(t.app, host).patch(`/v1/events/${id}`, { locationText: 'not a link' })).status).toBe(400);
    expect((await as(t.app, host).patch(`/v1/events/${id}`, { title: 'Renamed' })).status).toBe(200);
  });

  it('the host sells kinds of ticket, guests buy them, and the host stops selling', async () => {
    const host = await signUp(t.app);
    const guest = await signUp(t.app);
    const id = await newEvent(host);
    expect((await as(t.app, guest).post(`/v1/events/${id}/tickets`, { title: 'Mine', priceCents: 500, currency: 'USD' })).status).toBe(404);
    expect((await as(t.app, host).post(`/v1/events/${id}/tickets`, { title: 'Cheap', priceCents: 5, currency: 'USD' })).status).toBe(400);
    const made = await as(t.app, host).post(`/v1/events/${id}/tickets`, { title: 'General', priceCents: 1500, currency: 'USD', inventory: 50 });
    expect(made.status).toBe(201);
    const list = await as(t.app, guest).get(`/v1/events/${id}/tickets`);
    expect(list.body.items).toMatchObject([{ title: 'General', priceCents: 1500, currency: 'USD', inventory: 50, soldOut: false }]);
    const order = await as(t.app, guest).post('/v1/orders', { items: [{ productId: made.body.ticket.id, quantity: 1 }], idempotencyKey: `k_${Date.now()}a` });
    expect(order.status).toBe(201);
    await as(t.app, guest).post('/v1/payments/dev/complete', { orderId: order.body.order.id });
    expect(await validTickets(guest, id)).toHaveLength(1);
    expect((await as(t.app, host).del(`/v1/events/${id}/tickets/${made.body.ticket.id}`)).status).toBe(204);
    expect((await as(t.app, guest).get(`/v1/events/${id}/tickets`)).body.items).toHaveLength(0);
    // The ticket bought before still works.
    expect(await validTickets(guest, id)).toHaveLength(1);
  });

  it("tickets can't be bought for an event that's over or that the buyer can't see", async () => {
    const host = await signUp(t.app);
    const guest = await signUp(t.app);
    const past = await newEvent(host, { startsAt: inDays(-2), endsAt: inDays(-1.9) });
    const friendsOnly = await newEvent(host, { visibility: 'friends' });
    for (const id of [past, friendsOnly]) {
      const p = (await as(t.app, host).post('/v1/products', { kind: 'ticket', title: 'Door', priceCents: 1500, eventId: id })).body.product;
      const o = await as(t.app, guest).post('/v1/orders', { items: [{ productId: p.id, quantity: 1 }], idempotencyKey: `k_${Date.now()}_${id}` });
      expect(o.status).toBe(409);
      expect(o.body.error.code).toBe('event_over');
    }
  });

  it('cancelling an event refunds the tickets people paid for and tells them', async () => {
    const host = await signUp(t.app);
    const buyer = await signUp(t.app);
    const id = await newEvent(host);
    const product = (await as(t.app, host).post('/v1/products', { kind: 'ticket', title: 'Door', priceCents: 1500, eventId: id })).body.product;
    const order = await as(t.app, buyer).post('/v1/orders', { items: [{ productId: product.id, quantity: 2 }], idempotencyKey: `k_${Date.now()}` });
    expect(order.status, JSON.stringify(order.body)).toBe(201);
    expect((await as(t.app, buyer).post('/v1/payments/dev/complete', { orderId: order.body.order.id })).body.status).toBe('paid');
    expect(await validTickets(buyer, id)).toHaveLength(2);
    expect((await as(t.app, host).del(`/v1/events/${id}`)).status).toBe(200);
    const o = await db().query(`SELECT status FROM orders WHERE id = $1`, [order.body.order.id]);
    expect(o.rows[0].status).toBe('refunded');
    const told = await db().query(`SELECT 1 FROM notifications WHERE type = 'event_cancelled' AND user_id = $1 AND entity_id = $2`, [buyer.id, id]);
    expect(told.rowCount).toBe(1);
  });
});

async function placeOf(owner: TestUser) {
  n++;
  const biz = (await as(t.app, owner).post('/v1/businesses', { name: `Sweep Kitchen ${n}`, slug: `sweep-kitchen-${Date.now().toString(36)}-${n}` })).body
    .business;
  return (await as(t.app, owner).post('/v1/places', { name: 'Sweep Kitchen', category: 'restaurant', businessId: biz.id })).body.place as { id: string };
}

describe('places', () => {
  it('the owner sets opening hours and people per time slot; nobody else can', async () => {
    const owner = await signUp(t.app);
    const other = await signUp(t.app);
    const place = await placeOf(owner);
    expect((await as(t.app, other).patch(`/v1/places/${place.id}`, { bookingCapacity: 4 })).status).toBe(404);
    const bad = await as(t.app, owner).patch(`/v1/places/${place.id}`, { hours: { someday: '9:00-17:00' } });
    expect(bad.status).toBe(400);
    const r = await as(t.app, owner).patch(`/v1/places/${place.id}`, {
      hours: { mon: 'closed', 'tue-sun': '12:00-22:00' },
      bookingCapacity: 4,
      city: 'Lisbon',
    });
    expect(r.status).toBe(200);
    expect(r.body.place).toMatchObject({ hours: { mon: 'closed', 'tue-sun': '12:00-22:00' }, booking_capacity: 4, city: 'Lisbon' });
    const at = inDays(4);
    const left = await as(t.app, other).get(`/v1/places/${place.id}/availability?at=${encodeURIComponent(at)}`);
    expect(left.body.slots[0].left).toBe(4);
  });

  it('two requests at once cannot both take the last places', async () => {
    const owner = await signUp(t.app);
    const place = await placeOf(owner);
    await as(t.app, owner).patch(`/v1/places/${place.id}`, { bookingCapacity: 4 });
    const [a, b] = [await signUp(t.app), await signUp(t.app)];
    const at = inDays(3);
    const res = await Promise.all([a, b].map((u) => as(t.app, u).post(`/v1/places/${place.id}/bookings`, { partySize: 3, startsAt: at })));
    expect(res.map((r) => r.status).sort()).toEqual([201, 409]);
  });

  it("someone the owner blocked can't book, and blocked reviewers stay out of the list", async () => {
    const owner = await signUp(t.app);
    const blocked = await signUp(t.app);
    const reader = await signUp(t.app);
    const place = await placeOf(owner);
    expect((await as(t.app, blocked).put(`/v1/places/${place.id}/reviews`, { rating: 1, body: 'Meh' })).status).toBe(200);
    expect((await as(t.app, owner).post(`/v1/users/${blocked.id}/block`)).status).toBeLessThan(300);
    expect((await as(t.app, blocked).post(`/v1/places/${place.id}/bookings`, { partySize: 2, startsAt: inDays(2) })).status).toBe(404);
    expect((await as(t.app, reader).post(`/v1/users/${blocked.id}/block`)).status).toBeLessThan(300);
    const list = await as(t.app, reader).get(`/v1/places/${place.id}/reviews`);
    expect(list.body.items).toHaveLength(0);
    expect((await as(t.app, null).get(`/v1/places/${place.id}/reviews`)).body.items).toHaveLength(1);
  });
});

describe('live', () => {
  beforeAll(async () => {
    await db().query(`INSERT INTO feature_flags (key, enabled) VALUES ('LIVE', true) ON CONFLICT (key) DO UPDATE SET enabled = true`);
  });
  afterAll(async () => {
    await db().query(`DELETE FROM feature_flags WHERE key = 'LIVE'`);
  });
  const hook = (body: object) => t.app.inject({ method: 'POST', url: `/v1/live/hooks/auth?secret=${t.ctx.config.LIVE_HOOK_SECRET}`, payload: body });

  it('the host gets a new stream key, and the old one stops working', async () => {
    const host = await signUp(t.app);
    const other = await signUp(t.app);
    const made = (await as(t.app, host).post('/v1/live', { title: 'Key test' })).body;
    const oldKey = new URLSearchParams(made.ingest.streamKey.split('?')[1]).get('key');
    const publish = (key: string | null) => hook({ action: 'publish', path: `live/${made.live.id}`, query: `key=${key}` });
    expect((await publish(oldKey)).statusCode).toBe(200);
    expect((await as(t.app, other).post(`/v1/live/${made.live.id}/key`)).status).toBe(404);
    const fresh = await as(t.app, host).post(`/v1/live/${made.live.id}/key`);
    expect(fresh.status).toBe(200);
    const newKey = new URLSearchParams(fresh.body.ingest.streamKey.split('?')[1]).get('key');
    expect((await publish(oldKey)).statusCode).toBe(401);
    expect((await publish(newKey)).statusCode).toBe(200);
  });

  it('a live left on too long ends by itself, and nobody is counted as watching', async () => {
    const host = await signUp(t.app);
    const viewer = await signUp(t.app);
    const live = (await as(t.app, host).post('/v1/live', { title: 'Forgotten' })).body.live;
    await as(t.app, host).post(`/v1/live/${live.id}/start`);
    await as(t.app, viewer).post(`/v1/live/${live.id}/join`);
    await db().query(`UPDATE live_sessions SET started_at = now() - make_interval(hours => $2) WHERE id = $1`, [live.id, LIVE_MAX_HOURS + 1]);
    const ended = await sweepLives({ db: db(), realtime: t.ctx.realtime, config: t.ctx.config });
    expect(ended).toContain(live.id);
    const after = (await as(t.app, viewer).get(`/v1/live/${live.id}`)).body.live;
    expect(after).toMatchObject({ status: 'ended', viewers: 0 });
  });
});
