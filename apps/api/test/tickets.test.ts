import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readTicketInput, TICKET_TOKEN_PREFIX, type EventTicket } from '@yapilapi/shared';
import { issueOrderTickets, readTicketToken, signTicketToken, ticketSecret } from '../src/lib/tickets.ts';
import { FAILED_CHECK_INS_MAX } from '../src/modules/tickets.ts';
import type { BuiltApp } from '../src/app.ts';
import { as, signUp, testApp, type TestUser } from './helpers.ts';

let t: BuiltApp;
beforeAll(async () => {
  t = await testApp();
});
afterAll(async () => {
  await t.close();
});

const db = () => t.ctx.db;
const adult = (displayName?: string) => signUp(t.app, { birthDate: '1990-04-02', ...(displayName ? { displayName } : {}) });
const teen = (displayName?: string) => signUp(t.app, { birthDate: `${new Date().getUTCFullYear() - 15}-03-01`, ...(displayName ? { displayName } : {}) });
const key = () => `k_${Math.random().toString(36).slice(2)}${Date.now()}`;
const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();

async function befriend(a: TestUser, b: TestUser) {
  const [x, y] = [a.id, b.id].sort();
  await db().query(`INSERT INTO friendships (user_a, user_b) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [x, y]);
}

/** A fake connected device: records every realtime event the user gets. */
function connect(u: TestUser) {
  const events: { type: string; data: any }[] = [];
  const remove = t.ctx.realtime.add(u.id, { readyState: 1, send: (raw: string) => void events.push(JSON.parse(raw)) });
  return { events, remove, of: (type: string) => events.filter((e) => e.type === type) };
}

async function newEvent(host: TestUser, extra: Record<string, unknown> = {}): Promise<string> {
  const r = await as(t.app, host).post('/v1/events', {
    title: 'Rooftop night',
    startsAt: inDays(3),
    timezone: 'Africa/Lagos',
    locationText: 'Lagos',
    ...extra,
  });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.event.id;
}

async function going(u: TestUser, eventId: string) {
  const r = await as(t.app, u).post(`/v1/events/${eventId}/rsvp`, { status: 'going' });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
}

async function wallet(u: TestUser, when: 'upcoming' | 'past' = 'upcoming'): Promise<EventTicket[]> {
  const r = await as(t.app, u).get(`/v1/tickets?when=${when}`);
  expect(r.status).toBe(200);
  return r.body.items;
}

const ticketFor = async (u: TestUser, eventId: string) => (await wallet(u)).find((x) => x.event.id === eventId)!;
const checkIn = (u: TestUser, eventId: string, body: Record<string, unknown>) => as(t.app, u).post(`/v1/events/${eventId}/check-in`, body);

/** A host selling `quantity` tickets for their event, bought and paid by `buyer`. */
async function buyTickets(host: TestUser, buyer: TestUser, eventId: string, quantity = 1) {
  const product = (await as(t.app, host).post('/v1/products', { kind: 'ticket', title: 'Early bird', priceCents: 1500, eventId })).body.product;
  const order = await as(t.app, buyer).post('/v1/orders', { items: [{ productId: product.id, quantity }], idempotencyKey: key() });
  expect(order.status, JSON.stringify(order.body)).toBe(201);
  const paid = await as(t.app, buyer).post('/v1/payments/dev/complete', { orderId: order.body.order.id });
  expect(paid.body.status).toBe('paid');
  return { orderId: order.body.order.id as string, productId: product.id as string };
}

describe('Tickets in the wallet', () => {
  it('gives everyone going a ticket with a signed QR token and a backup code, and takes it back when they change their mind', async () => {
    const [host, guest] = [await adult(), await adult('Bola Ade')];
    const eventId = await newEvent(host);
    await going(guest, eventId);

    const [ticket] = await wallet(guest);
    expect(ticket).toMatchObject({
      source: 'rsvp',
      type: null,
      status: 'valid',
      holder: { id: guest.id, displayName: 'Bola Ade' },
      checkedInAt: null,
      transferable: true,
      event: { id: eventId, title: 'Rooftop night', timezone: 'Africa/Lagos', locationText: 'Lagos', cancelled: false },
    });
    expect(ticket!.token!.startsWith(TICKET_TOKEN_PREFIX)).toBe(true);
    // Never the ticket id alone: the token only reads with the server's secret.
    expect(ticket!.token).not.toContain(ticket!.id);
    expect(readTicketToken(ticketSecret(t.ctx.config), ticket!.token!)?.ticketId).toBe(ticket!.id);
    expect(ticket!.code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
    expect((await as(t.app, guest).get(`/v1/tickets/${ticket!.id}`)).body.ticket.id).toBe(ticket!.id);
    expect((await as(t.app, host).get(`/v1/tickets/${ticket!.id}`)).status).toBe(404);
    // The host is at the door, without a ticket.
    expect(await wallet(host)).toEqual([]);
    expect((await as(t.app, host).get(`/v1/events/${eventId}`)).body.event).toMatchObject({ canCheckIn: true, ticketTransfers: true });
    expect((await as(t.app, guest).get(`/v1/events/${eventId}`)).body.event.canCheckIn).toBe(false);

    // Interested instead: the ticket stops working and leaves the wallet (it isn't in "past" either).
    await as(t.app, guest).post(`/v1/events/${eventId}/rsvp`, { status: 'interested' });
    expect(await wallet(guest)).toEqual([]);
    expect(await wallet(guest, 'past')).toEqual([]);
    expect((await checkIn(host, eventId, { token: ticket!.token })).body.result).toBe('cancelled');

    // Going again: the same ticket back, with a new QR code and backup code.
    await going(guest, eventId);
    const again = await ticketFor(guest, eventId);
    expect(again.id).toBe(ticket!.id);
    expect(again.token).not.toBe(ticket!.token);
    expect((await checkIn(host, eventId, { token: ticket!.token })).body.result).toBe('invalid');
    expect((await checkIn(host, eventId, { token: again.token })).body.result).toBe('valid');
  });

  it('gives a paid order one ticket per ticket bought, and a refund stops them all', async () => {
    const [host, buyer] = [await adult(), await adult()];
    const eventId = await newEvent(host);
    const hostDoor = connect(host);
    const { orderId } = await buyTickets(host, buyer, eventId, 2);
    const tickets = await wallet(buyer);
    expect(tickets).toHaveLength(2);
    expect(tickets.map((x) => x.type)).toEqual(['Early bird', 'Early bird']);
    expect(new Set(tickets.map((x) => x.code)).size).toBe(2);
    expect(hostDoor.of('checkin.updated').at(-1)?.data).toMatchObject({ eventId, counts: { checkedIn: 0, expected: 2 } });
    // Issuing again (the payment's notice arriving twice) doesn't make more.
    expect(await issueOrderTickets(db(), orderId)).toEqual([]);
    const n = (await db().query(`SELECT count(*)::int AS n FROM event_tickets WHERE order_id = $1`, [orderId])).rows[0].n;
    expect(n).toBe(2);

    const before = (await db().query(`SELECT id, token_nonce FROM event_tickets WHERE order_id = $1 ORDER BY seq`, [orderId])).rows;
    const refund = await as(t.app, host).post(`/v1/orders/${orderId}/refund`, { reason: 'Changed plans' });
    expect(refund.body.status).toBe('succeeded');
    const after = (await db().query(`SELECT id, token_nonce, status FROM event_tickets WHERE order_id = $1 ORDER BY seq`, [orderId])).rows;
    expect(after.map((r) => r.status)).toEqual(['refunded', 'refunded']);
    // New tokens: nothing signed before the refund matches.
    expect(after[0].token_nonce).not.toBe(before[0].token_nonce);

    const r = await checkIn(host, eventId, { token: tickets[0]!.token });
    expect(r.body).toMatchObject({ result: 'refunded', guest: { userId: buyer.id, status: 'refunded' }, counts: { checkedIn: 0, expected: 0 } });
    expect((await checkIn(host, eventId, { code: tickets[1]!.code })).body.result).toBe('refunded');
    expect(await wallet(buyer)).toEqual([]);
    const past = await wallet(buyer, 'past');
    expect(past.map((x) => x.status)).toEqual(['refunded', 'refunded']);
    expect(past[0]!.token).toBe(null);
    expect(past[0]!.code).toBe(null);
    hostDoor.remove();
  });

  it('cancels every ticket when the host cancels the event', async () => {
    const [host, guest] = [await adult(), await adult()];
    const eventId = await newEvent(host);
    await going(guest, eventId);
    const ticket = await ticketFor(guest, eventId);
    expect((await as(t.app, host).del(`/v1/events/${eventId}`)).status).toBe(200);
    expect(await wallet(guest)).toEqual([]);
    expect((await wallet(guest, 'past'))[0]).toMatchObject({ id: ticket.id, status: 'cancelled', event: { cancelled: true } });
    // Nobody runs the door of a cancelled event.
    expect((await checkIn(host, eventId, { token: ticket.token })).status).toBe(404);
  });
});

describe('Ticket tokens', () => {
  const secret = 'test-secret-for-tickets-0123456789';
  const id = '6f1d2c3b-4a59-4e7f-9a8b-0c1d2e3f4a5b';

  it('signs the ticket id and nonce, and refuses anything changed', () => {
    const token = signTicketToken(secret, id, 123456);
    expect(readTicketInput(token)).toEqual({ kind: 'token', token });
    expect(token.length).toBeLessThan(50);
    expect(readTicketToken(secret, token)).toEqual({ ticketId: id, nonce: 123456 });
    expect(readTicketToken(secret, signTicketToken(secret, id, -5))).toEqual({ ticketId: id, nonce: -5 });
    // Another secret, another nonce, a changed character, a cut-off or padded token: all refused.
    expect(readTicketToken('another-secret', token)).toBe(null);
    const body = token.slice(TICKET_TOKEN_PREFIX.length);
    for (let i = 0; i < body.length; i += 7) {
      const swapped = body[i] === 'A' ? 'B' : 'A';
      expect(readTicketToken(secret, TICKET_TOKEN_PREFIX + body.slice(0, i) + swapped + body.slice(i + 1))).toBe(null);
    }
    expect(readTicketToken(secret, token.slice(0, -2))).toBe(null);
    expect(readTicketToken(secret, `${token}A`)).toBe(null);
    expect(readTicketToken(secret, `${token}=`)).toBe(null);
    expect(readTicketToken(secret, `YT2.${body}`)).toBe(null);
    // The ticket id alone, in the token's shape, isn't a ticket.
    expect(readTicketToken(secret, TICKET_TOKEN_PREFIX + Buffer.from(id.replace(/-/g, ''), 'hex').toString('base64url'))).toBe(null);
  });

  it('shows a changed or forged token as not valid at the door', async () => {
    const [host, guest] = [await adult(), await adult()];
    const eventId = await newEvent(host);
    await going(guest, eventId);
    const ticket = await ticketFor(guest, eventId);
    const nonce = (await db().query(`SELECT token_nonce FROM event_tickets WHERE id = $1`, [ticket.id])).rows[0].token_nonce;
    const forged = signTicketToken('guessed-secret', ticket.id, nonce);
    for (const token of [forged, `${ticket.token!.slice(0, -1)}${ticket.token!.endsWith('A') ? 'B' : 'A'}`]) {
      const r = await checkIn(host, eventId, { token });
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ result: 'invalid', guest: null });
    }
    expect((await checkIn(host, eventId, { code: 'ZZZZZZ' })).body.result).toBe('invalid');
    expect((await checkIn(host, eventId, { code: 'not a code' })).body.result).toBe('invalid');
    expect((await checkIn(host, eventId, { token: ticket.token, code: ticket.code })).status).toBe(400);
    expect((await checkIn(host, eventId, {})).status).toBe(400);
  });
});

describe('Check-in at the door', () => {
  it('checks in once, says who did it and when after that, and can be undone', async () => {
    const [host, cohost, guest] = [await adult('Ada Host'), await adult('Chi Cohost'), await adult('Bola Ade')];
    await befriend(host, cohost);
    const eventId = await newEvent(host);
    expect((await as(t.app, host).post(`/v1/events/${eventId}/cohosts`, { userId: cohost.id })).status).toBe(201);
    await going(guest, eventId);
    const ticket = await ticketFor(guest, eventId);
    const [hostDoor, cohostDoor, guestPhone] = [connect(host), connect(cohost), connect(guest)];

    const first = await checkIn(cohost, eventId, { token: ticket.token });
    expect(first.body).toMatchObject({
      result: 'valid',
      guest: { ticketId: ticket.id, userId: guest.id, name: 'Bola Ade', type: null, checkedInBy: { id: cohost.id, name: 'Chi Cohost' } },
      counts: { checkedIn: 1, expected: 1 },
    });
    // Every host's screen hears it, and the guest's wallet too.
    for (const d of [hostDoor, cohostDoor])
      expect(d.of('checkin.updated').at(-1)?.data).toMatchObject({ eventId, ticketId: ticket.id, counts: { checkedIn: 1 } });
    expect(guestPhone.of('ticket.updated').at(-1)?.data).toEqual({ ticketId: ticket.id });
    expect((await ticketFor(guest, eventId)).checkedInAt).toBeTruthy();
    expect((await ticketFor(guest, eventId)).transferable).toBe(false);

    // Twice: already in, when and by whom (by code, or by the guest list).
    const second = await checkIn(host, eventId, { code: ticket.code!.toLowerCase() });
    expect(second.body).toMatchObject({ result: 'already', guest: { checkedInBy: { name: 'Chi Cohost' } }, counts: { checkedIn: 1 } });
    expect(second.body.guest.checkedInAt).toBe(first.body.guest.checkedInAt);
    expect((await checkIn(host, eventId, { ticketId: ticket.id })).body.result).toBe('already');

    // Undo: out again, and the next scan checks them in.
    const undo = await as(t.app, host).post(`/v1/events/${eventId}/check-in/${ticket.id}/undo`);
    expect(undo.body).toMatchObject({ guest: { checkedInAt: null, checkedInBy: null }, counts: { checkedIn: 0, expected: 1 } });
    expect(cohostDoor.of('checkin.updated').at(-1)?.data).toMatchObject({ ticketId: ticket.id, checkedInAt: null, counts: { checkedIn: 0 } });
    expect((await as(t.app, host).post(`/v1/events/${eventId}/check-in/${ticket.id}/undo`)).status).toBe(404);
    expect((await checkIn(host, eventId, { ticketId: ticket.id })).body).toMatchObject({ result: 'valid', guest: { checkedInBy: { id: host.id } } });
    const log = (await db().query(`SELECT method, result FROM ticket_scans WHERE event_id = $1 ORDER BY created_at`, [eventId])).rows;
    expect(log).toEqual([
      { method: 'qr', result: 'valid' },
      { method: 'code', result: 'already' },
      { method: 'list', result: 'already' },
      { method: 'undo', result: 'undone' },
      { method: 'list', result: 'valid' },
    ]);
    for (const d of [hostDoor, cohostDoor, guestPhone]) d.remove();
  });

  it('keeps an offline check-in sent twice as one, dated when it was scanned, and flags a real conflict', async () => {
    const [host, cohost, guest] = [await adult(), await adult('Chi Cohost'), await adult()];
    await befriend(host, cohost);
    const eventId = await newEvent(host);
    await as(t.app, host).post(`/v1/events/${eventId}/cohosts`, { userId: cohost.id });
    await going(guest, eventId);
    const ticket = await ticketFor(guest, eventId);
    const scannedAt = new Date(Date.now() - 20 * 60_000).toISOString();

    const queued = await checkIn(host, eventId, { code: ticket.code, clientRef: 'dev1-abc', scannedAt });
    expect(queued.body.result).toBe('valid');
    expect(new Date(queued.body.guest.checkedInAt).getTime()).toBe(new Date(scannedAt).getTime());
    // The same one sent again after a dropped answer: not a conflict.
    const retry = await checkIn(host, eventId, { code: ticket.code, clientRef: 'dev1-abc', scannedAt });
    expect(retry.body).toMatchObject({ result: 'valid', replayed: true, counts: { checkedIn: 1 } });
    // Another device that checked them in meanwhile: already in, by the first one.
    const other = await checkIn(cohost, eventId, { token: ticket.token, clientRef: 'dev2-xyz', scannedAt: new Date().toISOString() });
    expect(other.body).toMatchObject({ result: 'already', guest: { checkedInBy: { id: host.id } } });
    expect(other.body.replayed).toBeUndefined();
    // A time far in the past (or the future) is kept within the last 12 hours, never later than now.
    const [late] = [await adult()];
    await going(late, eventId);
    const lateTicket = await ticketFor(late, eventId);
    const r = await checkIn(host, eventId, { ticketId: lateTicket.id, clientRef: 'dev1-late', scannedAt: inDays(2) });
    expect(new Date(r.body.guest.checkedInAt).getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it('says when a ticket is for another event, without saying whose it is', async () => {
    const [host, otherHost, guest] = [await adult(), await adult(), await adult()];
    const [mine, theirs] = [await newEvent(host), await newEvent(otherHost, { title: 'Book club' })];
    await going(guest, theirs);
    const ticket = await ticketFor(guest, theirs);
    const r = await checkIn(host, mine, { token: ticket.token });
    expect(r.body).toEqual({ result: 'wrong_event', guest: null, counts: { checkedIn: 0, expected: 0 } });
    // A backup code only means something in its own event.
    expect((await checkIn(host, mine, { code: ticket.code })).body.result).toBe('invalid');
    expect((await checkIn(host, mine, { ticketId: ticket.id })).body.result).toBe('invalid');
    expect((await ticketFor(guest, theirs)).checkedInAt).toBe(null);
  });

  it('lets only the host and co-hosts see the guest list and run the door', async () => {
    const [host, cohost, guest, stranger, notFriend] = [await adult(), await adult(), await adult('Bola Ade'), await adult(), await adult()];
    await befriend(host, cohost);
    const eventId = await newEvent(host);
    await going(guest, eventId);
    const ticket = await ticketFor(guest, eventId);

    for (const u of [guest, stranger, cohost]) {
      expect((await as(t.app, u).get(`/v1/events/${eventId}/check-in`)).status).toBe(404);
      expect((await as(t.app, u).get(`/v1/events/${eventId}/guests`)).status).toBe(404);
      expect((await checkIn(u, eventId, { token: ticket.token })).status).toBe(404);
      expect((await as(t.app, u).post(`/v1/events/${eventId}/check-in/${ticket.id}/undo`)).status).toBe(404);
      expect((await as(t.app, u).get(`/v1/events/${eventId}/cohosts`)).status).toBe(404);
    }
    expect((await as(t.app, null).get(`/v1/events/${eventId}/guests`)).status).toBe(401);

    // Co-hosts are the host's friends; they can run the door but not choose other co-hosts.
    expect((await as(t.app, host).post(`/v1/events/${eventId}/cohosts`, { userId: notFriend.id })).status).toBe(403);
    expect((await as(t.app, guest).post(`/v1/events/${eventId}/cohosts`, { userId: guest.id })).status).toBe(404);
    expect((await as(t.app, host).post(`/v1/events/${eventId}/cohosts`, { userId: cohost.id })).status).toBe(201);
    expect((await as(t.app, host).post(`/v1/events/${eventId}/cohosts`, { userId: cohost.id })).status).toBe(200);
    await befriend(cohost, stranger);
    expect((await as(t.app, cohost).post(`/v1/events/${eventId}/cohosts`, { userId: stranger.id })).status).toBe(403);
    const summary = await as(t.app, cohost).get(`/v1/events/${eventId}/check-in`);
    expect(summary.body).toMatchObject({ role: 'cohost', counts: { checkedIn: 0, expected: 1 }, cohosts: [{ id: cohost.id }], ticketTransfers: true });
    expect((await as(t.app, cohost).get(`/v1/events/${eventId}`)).body.event.canCheckIn).toBe(true);
    const list = await as(t.app, cohost).get(`/v1/events/${eventId}/guests`);
    expect(list.body).toMatchObject({ total: 1, nextOffset: null, items: [{ ticketId: ticket.id, name: 'Bola Ade', limited: false }] });
    expect((await as(t.app, cohost).get(`/v1/events/${eventId}/guests?q=bola`)).body.total).toBe(1);
    expect((await as(t.app, cohost).get(`/v1/events/${eventId}/guests?q=${ticket.code}`)).body.total).toBe(1);
    expect((await as(t.app, cohost).get(`/v1/events/${eventId}/guests?q=nobody`)).body.total).toBe(0);
    expect((await as(t.app, cohost).get(`/v1/events/${eventId}/guests?filter=in`)).body.total).toBe(0);

    // A co-host can step down; then the door is closed to them again.
    expect((await as(t.app, cohost).del(`/v1/events/${eventId}/cohosts/${cohost.id}`)).status).toBe(200);
    expect((await as(t.app, cohost).get(`/v1/events/${eventId}/guests`)).status).toBe(404);
  });

  it('shows people under 18 by first name only to hosts who are not their friends', async () => {
    const [host, cohost, young] = [await adult(), await adult(), await teen('Tobi Adeyemi')];
    await befriend(host, cohost);
    await befriend(cohost, young);
    const eventId = await newEvent(host);
    await as(t.app, host).post(`/v1/events/${eventId}/cohosts`, { userId: cohost.id });
    await going(young, eventId);
    const ticket = await ticketFor(young, eventId);

    const seenByHost = (await as(t.app, host).get(`/v1/events/${eventId}/guests`)).body.items[0];
    expect(seenByHost).toMatchObject({ name: 'Tobi', username: null, avatarUrl: null, limited: true });
    // Their full name finds nothing for the host, their first name does.
    expect((await as(t.app, host).get(`/v1/events/${eventId}/guests?q=Adeyemi`)).body.total).toBe(0);
    expect((await as(t.app, host).get(`/v1/events/${eventId}/guests?q=${young.username}`)).body.total).toBe(0);
    expect((await as(t.app, host).get(`/v1/events/${eventId}/guests?q=tobi`)).body.total).toBe(1);
    expect((await checkIn(host, eventId, { token: ticket.token })).body.guest).toMatchObject({ name: 'Tobi', limited: true });
    // Their friend sees them as usual.
    const seenByFriend = (await as(t.app, cohost).get(`/v1/events/${eventId}/guests?q=Adeyemi`)).body.items[0];
    expect(seenByFriend).toMatchObject({ name: 'Tobi Adeyemi', username: young.username, limited: false });
  });

  it('limits attempts that find nothing, so backup codes cannot be guessed', async () => {
    const [host, guest] = [await adult(), await adult()];
    const eventId = await newEvent(host);
    await going(guest, eventId);
    const ticket = await ticketFor(guest, eventId);
    const wrong = ticket.code === 'AAAAAA' ? 'BBBBBB' : 'AAAAAA';
    for (let i = 0; i < FAILED_CHECK_INS_MAX; i++) expect((await checkIn(host, eventId, { code: wrong })).body.result).toBe('invalid');
    const blocked = await checkIn(host, eventId, { code: ticket.code });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('too_many_attempts');
    // After the wait, the door works again.
    await db().query(`UPDATE ticket_scans SET created_at = created_at - interval '11 minutes' WHERE scanner_id = $1`, [host.id]);
    expect((await checkIn(host, eventId, { code: ticket.code })).body.result).toBe('valid');
  });
});

describe('Giving a ticket to a friend', () => {
  it('moves the ticket with a new QR code and backup code, so the old copy stops working', async () => {
    const [host, buyer, friend, notFriend] = [await adult(), await adult('Ngozi Buyer'), await adult('Femi Friend'), await adult()];
    await befriend(buyer, friend);
    const eventId = await newEvent(host, { visibility: 'friends' });
    await befriend(host, buyer);
    await buyTickets(host, buyer, eventId);
    const ticket = await ticketFor(buyer, eventId);

    expect((await as(t.app, buyer).post(`/v1/tickets/${ticket.id}/transfer`, { userId: notFriend.id })).body.error.code).toBe('friends_only');
    expect((await as(t.app, friend).post(`/v1/tickets/${ticket.id}/transfer`, { userId: friend.id })).status).toBe(400);
    expect((await as(t.app, notFriend).post(`/v1/tickets/${ticket.id}/transfer`, { userId: friend.id })).status).toBe(404);
    const friendPhone = connect(friend);
    expect((await as(t.app, buyer).post(`/v1/tickets/${ticket.id}/transfer`, { userId: friend.id })).status).toBe(200);
    expect(friendPhone.of('ticket.updated').at(-1)?.data).toEqual({ ticketId: ticket.id });
    friendPhone.remove();

    expect(await wallet(buyer)).toEqual([]);
    const given = await ticketFor(friend, eventId);
    expect(given).toMatchObject({ id: ticket.id, type: 'Early bird', holder: { id: friend.id, displayName: 'Femi Friend' }, from: { id: buyer.id } });
    expect(given.token).not.toBe(ticket.token);
    expect(given.code).not.toBe(ticket.code);
    // The friend can see the event (it's for the host's friends) because they hold a ticket.
    expect((await as(t.app, friend).get(`/v1/events/${eventId}`)).status).toBe(200);
    const note = (await as(t.app, friend).get('/v1/notifications')).body.items.find((n: any) => n.type === 'ticket_received');
    expect(note).toMatchObject({ actor: { id: buyer.id }, entityType: 'ticket', entityId: ticket.id });

    expect((await checkIn(host, eventId, { token: ticket.token })).body).toMatchObject({ result: 'invalid', guest: null });
    expect((await checkIn(host, eventId, { code: ticket.code })).body.result).toBe('invalid');
    expect((await checkIn(host, eventId, { token: given.token })).body).toMatchObject({ result: 'valid', guest: { name: 'Femi Friend' } });
    // Used at the door: it can't be given on.
    expect((await as(t.app, friend).post(`/v1/tickets/${ticket.id}/transfer`, { userId: buyer.id })).body.error.code).toBe('ticket_used');
    const log = (await db().query(`SELECT from_id, to_id FROM ticket_transfers WHERE ticket_id = $1`, [ticket.id])).rows;
    expect(log).toEqual([{ from_id: buyer.id, to_id: friend.id }]);
  });

  it('gives your place when it is an RSVP, and follows the host’s switch', async () => {
    const [host, guest, friend, other] = [await adult(), await adult(), await adult(), await adult()];
    await befriend(guest, friend);
    await befriend(friend, other);
    const eventId = await newEvent(host);
    await going(guest, eventId);
    const ticket = await ticketFor(guest, eventId);
    expect((await as(t.app, guest).post(`/v1/tickets/${ticket.id}/transfer`, { userId: friend.id })).status).toBe(200);
    expect((await as(t.app, guest).get(`/v1/events/${eventId}`)).body.event.myRsvp).toBe('not_going');
    expect((await as(t.app, friend).get(`/v1/events/${eventId}`)).body.event.myRsvp).toBe('going');
    expect((await ticketFor(friend, eventId)).source).toBe('rsvp');

    // Someone who already has a ticket for it can't be given another RSVP.
    await going(guest, eventId);
    const second = await ticketFor(guest, eventId);
    expect(second.id).not.toBe(ticket.id);
    expect((await as(t.app, guest).post(`/v1/tickets/${second.id}/transfer`, { userId: friend.id })).body.error.code).toBe('already_has_ticket');

    // The host turns transfers off.
    expect((await as(t.app, host).patch(`/v1/events/${eventId}`, { ticketTransfers: false })).body.event.ticketTransfers).toBe(false);
    const theirs = await ticketFor(friend, eventId);
    expect(theirs.transferable).toBe(false);
    expect((await as(t.app, friend).post(`/v1/tickets/${theirs.id}/transfer`, { userId: other.id })).body.error.code).toBe('transfers_off');
  });
});

describe('Your data', () => {
  it('exports tickets without their codes, and deleting the account removes them', async () => {
    const [host, guest, friend] = [await adult(), await adult(), await adult()];
    await befriend(guest, friend);
    await befriend(host, friend);
    const eventId = await newEvent(host);
    await as(t.app, host).post(`/v1/events/${eventId}/cohosts`, { userId: friend.id });
    await going(guest, eventId);
    await buyTickets(host, guest, eventId);
    const tickets = await wallet(guest);
    await as(t.app, guest).post(`/v1/tickets/${tickets[1]!.id}/transfer`, { userId: friend.id });
    await checkIn(friend, eventId, { token: tickets[0]!.token });

    const mine = (await as(t.app, guest).get('/v1/me/export')).body;
    const text = JSON.stringify(mine);
    expect(mine.content.tickets).toHaveLength(1);
    expect(mine.content.ticketTransfers).toMatchObject([{ direction: 'you gave it', username: friend.username }]);
    for (const x of tickets) {
      expect(text).not.toContain(x.token);
      expect(text).not.toContain(`"${x.code}"`);
    }
    const theirs = (await as(t.app, friend).get('/v1/me/export')).body.content;
    expect(theirs.eventsCohosted).toMatchObject([{ event_id: eventId }]);
    expect(theirs.doorCheckIns).toMatchObject([{ event_id: eventId, checked_in: 1 }]);

    expect((await as(t.app, guest).del('/v1/me', { password: guest.password })).status).toBe(200);
    expect((await db().query(`SELECT count(*)::int AS n FROM event_tickets WHERE holder_id = $1`, [guest.id])).rows[0].n).toBe(0);
    // The ticket they gave away stays with their friend.
    expect((await wallet(friend)).map((x) => x.id)).toEqual([tickets[1]!.id]);
    expect((await db().query(`SELECT count(*)::int AS n FROM ticket_transfers WHERE from_id = $1 OR to_id = $1`, [guest.id])).rows[0].n).toBe(0);
    expect((await as(t.app, friend).del('/v1/me', { password: friend.password })).status).toBe(200);
    expect((await db().query(`SELECT count(*)::int AS n FROM event_cohosts WHERE user_id = $1`, [friend.id])).rows[0].n).toBe(0);
    expect((await db().query(`SELECT count(*)::int AS n FROM ticket_scans WHERE scanner_id = $1`, [friend.id])).rows[0].n).toBe(0);
  });
});
