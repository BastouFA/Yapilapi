import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  eventEndsAt,
  firstNameOf,
  TICKET_CODE_ALPHABET,
  TICKET_CODE_LENGTH,
  TICKET_TOKEN_PREFIX,
  type CheckInCounts,
  type EventTicket,
  type TicketGuest,
  type TicketStatus,
} from '@yapilapi/shared';
import type { Config } from '../config.ts';
import type { RealtimeHub } from './realtime.ts';
import { publicUserFrom } from './users.ts';

type Q = Pick<Pool | PoolClient, 'query'>;

/**
 * Event tickets (0059): issuing them for "going" RSVPs and paid ticket orders, the signed token in
 * their QR code, and what the door and the wallet read. The routes are in modules/tickets.ts.
 */

const DEV_SECRET = 'dev-ticket-token-secret';
/** The key the tokens are signed with. Production refuses to start without a real one (config.ts). */
export const ticketSecret = (config: Config) => config.TICKET_TOKEN_SECRET || DEV_SECRET;

/** Bytes of the HMAC kept in a token (96 bits): enough that guessing one is hopeless, short enough for a small QR code. */
const MAC_BYTES = 12;
const BODY_BYTES = 20;

function mac(secret: string, body: Buffer): Buffer {
  return createHmac('sha256', secret).update('ypl-ticket-v1').update(body).digest().subarray(0, MAC_BYTES);
}

/**
 * The token in a ticket's QR code: "YT1." then, in base64url, the ticket id (16 bytes), its current
 * nonce (4 bytes) and an HMAC of both. It can't be made without the server's secret, and a new nonce
 * (transfer, refund, an RSVP taken back) makes every earlier copy stop working.
 */
export function signTicketToken(secret: string, ticketId: string, nonce: number): string {
  const body = Buffer.alloc(BODY_BYTES);
  Buffer.from(ticketId.replace(/-/g, ''), 'hex').copy(body, 0);
  body.writeInt32BE(nonce, 16);
  return TICKET_TOKEN_PREFIX + Buffer.concat([body, mac(secret, body)]).toString('base64url');
}

/** The ticket id and nonce in a token, or null when it isn't one the server signed (or was changed). */
export function readTicketToken(secret: string, token: string): { ticketId: string; nonce: number } | null {
  if (!token.startsWith(TICKET_TOKEN_PREFIX)) return null;
  const text = token.slice(TICKET_TOKEN_PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return null;
  const raw = Buffer.from(text, 'base64url');
  // Only the one canonical spelling of the bytes counts.
  if (raw.length !== BODY_BYTES + MAC_BYTES || raw.toString('base64url') !== text) return null;
  const body = raw.subarray(0, BODY_BYTES);
  if (!timingSafeEqual(raw.subarray(BODY_BYTES), mac(secret, body))) return null;
  const hex = body.subarray(0, 16).toString('hex');
  return { ticketId: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`, nonce: body.readInt32BE(16) };
}

/** A new nonce for a token (any 32-bit number; it only has to change). */
export const newNonce = () => randomInt(-2_147_483_648, 2_147_483_647);
/** The same, in SQL, for updates that rotate many tickets at once. */
const NEW_NONCE_SQL = `(floor(random() * 4294967295) - 2147483647)::int`;

function randomCode(): string {
  let s = '';
  for (let i = 0; i < TICKET_CODE_LENGTH; i++) s += TICKET_CODE_ALPHABET[randomInt(TICKET_CODE_ALPHABET.length)];
  return s;
}

/** A backup code not yet used in this event (the unique index is the final guard). */
export async function freshCode(c: Q, eventId: string): Promise<string> {
  for (;;) {
    const code = randomCode();
    const taken = await c.query(`SELECT 1 FROM event_tickets WHERE event_id = $1 AND backup_code = $2`, [eventId, code]);
    if (!taken.rowCount) return code;
  }
}

/**
 * Someone answered "going": their RSVP ticket, new or given back (with a new token and code, and
 * not checked in). The host has none: they're at the door. Call inside the RSVP's transaction.
 */
export async function issueRsvpTicket(c: Q, eventId: string, userId: string): Promise<boolean> {
  const host = (await c.query<{ host_id: string }>(`SELECT host_id FROM events WHERE id = $1 AND deleted_at IS NULL`, [eventId])).rows[0];
  if (!host || host.host_id === userId) return false;
  // An event that sells tickets lets people in with the tickets they bought: answering "going" there
  // doesn't give a free one (a ticket given earlier, before the sale began, stays).
  const selling = await c.query(`SELECT 1 FROM products WHERE event_id = $1 AND kind = 'ticket' AND status = 'active' AND deleted_at IS NULL LIMIT 1`, [
    eventId,
  ]);
  if (selling.rowCount) return false;
  const cur = (
    await c.query<{ id: string; status: TicketStatus }>(
      `SELECT id, status FROM event_tickets WHERE event_id = $1 AND holder_id = $2 AND source = 'rsvp' FOR UPDATE`,
      [eventId, userId],
    )
  ).rows[0];
  if (cur?.status === 'valid') return false;
  const code = await freshCode(c, eventId);
  if (cur)
    await c.query(
      `UPDATE event_tickets SET status = 'valid', token_nonce = $2, backup_code = $3, checked_in_at = NULL, checked_in_by = NULL, check_in_ref = NULL, updated_at = now()
       WHERE id = $1`,
      [cur.id, newNonce(), code],
    );
  else
    await c.query(`INSERT INTO event_tickets (event_id, holder_id, source, token_nonce, backup_code) VALUES ($1,$2,'rsvp',$3,$4)`, [
      eventId,
      userId,
      newNonce(),
      code,
    ]);
  return true;
}

/** Someone is no longer going: their RSVP ticket stops working. Returns whether one did. */
export async function cancelRsvpTicket(c: Q, eventId: string, userId: string): Promise<boolean> {
  const r = await c.query(
    `UPDATE event_tickets SET status = 'cancelled', token_nonce = ${NEW_NONCE_SQL}, updated_at = now()
     WHERE event_id = $1 AND holder_id = $2 AND source = 'rsvp' AND status = 'valid'`,
    [eventId, userId],
  );
  return !!r.rowCount;
}

/**
 * An order was paid: one ticket per ticket bought for an event that's still on, held by the buyer.
 * Safe to call twice. Returns the events that got tickets. Call inside the payment's transaction.
 */
export async function issueOrderTickets(c: Q, orderId: string): Promise<string[]> {
  const { rows } = await c.query<{ product_id: string; quantity: number; title: string; event_id: string; buyer_id: string }>(
    `SELECT oi.product_id, oi.quantity, p.title, p.event_id, o.buyer_id
     FROM order_items oi JOIN products p ON p.id = oi.product_id JOIN orders o ON o.id = oi.order_id JOIN events e ON e.id = p.event_id
     WHERE oi.order_id = $1 AND p.kind = 'ticket' AND e.deleted_at IS NULL`,
    [orderId],
  );
  const events = new Set<string>();
  for (const r of rows)
    for (let seq = 1; seq <= r.quantity; seq++) {
      const made = await c.query(
        `INSERT INTO event_tickets (event_id, holder_id, source, order_id, product_id, seq, type_title, token_nonce, backup_code)
         VALUES ($1,$2,'order',$3,$4,$5,$6,$7,$8)
         ON CONFLICT (order_id, product_id, seq) WHERE order_id IS NOT NULL DO NOTHING`,
        [r.event_id, r.buyer_id, orderId, r.product_id, seq, r.title, newNonce(), await freshCode(c, r.event_id)],
      );
      if (made.rowCount) events.add(r.event_id);
    }
  return [...events];
}

/** An order was refunded: its tickets stop working (with new tokens), wherever they are now. */
export async function refundOrderTickets(c: Q, orderId: string): Promise<void> {
  await c.query(
    `UPDATE event_tickets SET status = 'refunded', token_nonce = ${NEW_NONCE_SQL}, updated_at = now() WHERE order_id = $1 AND status <> 'refunded'`,
    [orderId],
  );
}

/** The host cancelled the event: every ticket for it stops working. */
export async function cancelEventTickets(c: Q, eventId: string): Promise<void> {
  await c.query(`UPDATE event_tickets SET status = 'cancelled', token_nonce = ${NEW_NONCE_SQL}, updated_at = now() WHERE event_id = $1 AND status = 'valid'`, [
    eventId,
  ]);
}

/** Whether `userId` runs the door: the host, or a co-host. Null for anyone else (and for a cancelled event). */
export async function doorRole(db: Q, eventId: string, userId: string): Promise<'host' | 'cohost' | null> {
  const r = (
    await db.query<{ host: boolean; cohost: boolean }>(
      `SELECT e.host_id = $2 AS host, EXISTS (SELECT 1 FROM event_cohosts ec WHERE ec.event_id = e.id AND ec.user_id = $2) AS cohost
       FROM events e WHERE e.id = $1 AND e.deleted_at IS NULL`,
      [eventId, userId],
    )
  ).rows[0];
  return r?.host ? 'host' : r?.cohost ? 'cohost' : null;
}

export async function doorCounts(db: Q, eventId: string): Promise<CheckInCounts> {
  const r = (
    await db.query<{ expected: number; checked_in: number }>(
      `SELECT count(*) FILTER (WHERE status = 'valid')::int AS expected,
              count(*) FILTER (WHERE status = 'valid' AND checked_in_at IS NOT NULL)::int AS checked_in
       FROM event_tickets WHERE event_id = $1`,
      [eventId],
    )
  ).rows[0]!;
  return { checkedIn: r.checked_in, expected: r.expected };
}

/** The host and co-hosts: the only people who get the door's live updates. */
export async function doorTeam(db: Q, eventId: string): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT host_id AS id FROM events WHERE id = $1 UNION SELECT user_id FROM event_cohosts WHERE event_id = $1`,
    [eventId],
  );
  return rows.map((r) => r.id);
}

/**
 * Tell the door team the new counts (and which ticket changed), and the ticket's holder that their
 * ticket changed (checked in, undone), so every open check-in screen and wallet keeps up.
 */
export async function publishDoor(
  db: Q,
  realtime: RealtimeHub,
  eventId: string,
  change?: { ticketId: string; holderId: string; checkedInAt: string | null },
): Promise<CheckInCounts> {
  const counts = await doorCounts(db, eventId);
  await realtime.publish(await doorTeam(db, eventId), {
    type: 'checkin.updated',
    data: { eventId, counts, ticketId: change?.ticketId ?? null, checkedInAt: change?.checkedInAt ?? null },
  });
  if (change) await realtime.publish([change.holderId], { type: 'ticket.updated', data: { ticketId: change.ticketId } });
  return counts;
}

/** The guest list's columns: `t` is the ticket, `$1` the person looking (for friends). */
export const GUEST_COLS = `t.id AS ticket_id, t.holder_id, pr.display_name, pr.username, pr.avatar_url, t.type_title, t.status, t.checked_in_at,
  t.checked_in_by, cb.display_name AS by_name,
  coalesce(hu.birth_date > current_date - interval '18 years', false) AS minor,
  EXISTS (SELECT 1 FROM friendships fr WHERE (fr.user_a = $1 AND fr.user_b = t.holder_id) OR (fr.user_b = $1 AND fr.user_a = t.holder_id)) AS friend`;
export const GUEST_FROM = `event_tickets t JOIN profiles pr ON pr.user_id = t.holder_id JOIN users hu ON hu.id = t.holder_id
  LEFT JOIN profiles cb ON cb.user_id = t.checked_in_by`;

/**
 * A guest as the door sees them. Someone under 18 who isn't the viewer's friend shows by first
 * name only, without username or photo.
 */
export function toGuest(r: Record<string, any>, viewer: string): TicketGuest {
  const limited = !!r.minor && !r.friend && r.holder_id !== viewer;
  return {
    ticketId: r.ticket_id,
    userId: r.holder_id,
    name: limited ? firstNameOf(r.display_name) : r.display_name,
    username: limited ? null : r.username,
    avatarUrl: limited ? null : r.avatar_url,
    limited,
    type: r.type_title ?? null,
    status: r.status,
    checkedInAt: r.checked_in_at?.toISOString() ?? null,
    checkedInBy: r.checked_in_by ? { id: r.checked_in_by, name: r.by_name ?? '' } : null,
  };
}

/** A wallet ticket's columns: `t` the ticket, `$1` the holder. */
export const TICKET_SELECT = `
  SELECT t.id, t.holder_id, t.source, t.type_title, t.status, t.token_nonce, t.backup_code, t.checked_in_at,
         e.id AS e_id, e.title AS e_title, e.starts_at, e.ends_at, e.timezone, e.online, e.location_text, e.deleted_at AS e_deleted_at, e.ticket_transfers,
         pl.id AS pl_id, pl.name AS pl_name, pl.address AS pl_address, pl.city AS pl_city, pl.lat AS pl_lat, pl.lng AS pl_lng,
         hp.user_id AS h_id, hp.username AS h_username, hp.display_name AS h_display_name, hp.avatar_url AS h_avatar_url, hp.mode AS h_mode, (hp.plus_until > now()) AS h_plus,
         me.display_name AS holder_name,
         fp.user_id AS f_id, fp.username AS f_username, fp.display_name AS f_display_name, fp.avatar_url AS f_avatar_url, fp.mode AS f_mode, (fp.plus_until > now()) AS f_plus
  FROM event_tickets t JOIN events e ON e.id = t.event_id JOIN profiles hp ON hp.user_id = e.host_id JOIN profiles me ON me.user_id = t.holder_id
  LEFT JOIN places pl ON pl.id = e.place_id
  LEFT JOIN LATERAL (SELECT tt.from_id FROM ticket_transfers tt WHERE tt.ticket_id = t.id AND tt.to_id = t.holder_id ORDER BY tt.created_at DESC LIMIT 1) gift ON true
  LEFT JOIN profiles fp ON fp.user_id = gift.from_id`;

export function toTicket(r: Record<string, any>, secret: string, now = Date.now()): EventTicket {
  const cancelled = !!r.e_deleted_at;
  const status: TicketStatus = cancelled && r.status === 'valid' ? 'cancelled' : r.status;
  const event = {
    id: r.e_id,
    title: r.e_title,
    startsAt: r.starts_at.toISOString(),
    endsAt: r.ends_at?.toISOString() ?? null,
    timezone: r.timezone,
    online: r.online,
    locationText: r.location_text,
    place: r.pl_id ? { id: r.pl_id, name: r.pl_name, address: r.pl_address, city: r.pl_city, lat: r.pl_lat, lng: r.pl_lng } : null,
    host: publicUserFrom(r, 'h_'),
    cancelled,
  };
  const valid = status === 'valid';
  return {
    id: r.id,
    event,
    source: r.source,
    type: r.type_title ?? null,
    status,
    holder: { id: r.holder_id, displayName: r.holder_name },
    token: valid ? signTicketToken(secret, r.id, r.token_nonce) : null,
    code: valid ? r.backup_code : null,
    checkedInAt: r.checked_in_at?.toISOString() ?? null,
    transferable: valid && !r.checked_in_at && r.ticket_transfers && eventEndsAt(event).getTime() > now,
    from: r.f_id ? publicUserFrom(r, 'f_') : null,
  };
}
