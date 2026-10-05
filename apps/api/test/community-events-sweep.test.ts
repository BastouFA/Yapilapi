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
