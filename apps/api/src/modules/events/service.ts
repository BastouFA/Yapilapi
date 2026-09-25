import { randomInt } from 'node:crypto';
import { withTransaction, type Queryable, type Tx } from '@yapilapi/database';
import { AppError, conflict, forbidden, invalid, notFound } from '@yapilapi/shared';
import type { AppContext } from '../../lib/context.js';
import { notify } from '../../lib/notify.js';
import { audit } from '../../lib/audit.js';

// ------------------------------------------------------------------ constants & small helpers

export const OPEN_ENDED_EVENT_HOURS = 3;
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function newCheckinCode(): string {
  let s = '';
  for (let i = 0; i < 10; i++) s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return s;
}
export const normalizeCode = (raw: string): string => raw.toUpperCase().replace(/[^A-Z0-9]/g, '');

export interface LockedEvent {
  id: string;
  title: string;
  status: 'draft' | 'published' | 'cancelled' | 'completed';
  capacity: number | null;
  waitlist_enabled: boolean;
  starts_at: Date;
  ends_at: Date | null;
  host_id: string | null;
}

const eventEnd = (ev: Pick<LockedEvent, 'starts_at' | 'ends_at'>): Date =>
  ev.ends_at ?? new Date(ev.starts_at.getTime() + OPEN_ENDED_EVENT_HOURS * 3_600_000);

/** Row-lock the event. Every mutation of attendance/capacity/ticket counters goes through this lock, which serialises them per event. */
export async function lockEvent(tx: Tx, eventId: string): Promise<LockedEvent> {
  const { rows } = await tx.query<LockedEvent>(
    `SELECT id, title, status, capacity, waitlist_enabled, starts_at, ends_at, host_id FROM events WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
    [eventId],
  );
  if (!rows[0]) throw notFound('Event');
  return rows[0];
}

function assertOpenForAttendance(ev: LockedEvent, now = new Date()): void {
  if (ev.status === 'cancelled')
    throw conflict('This event was cancelled', { reason: 'event_cancelled' });
  if (ev.status !== 'published')
    throw conflict('This event is not open for attendance', { reason: 'event_not_open' });
  if (eventEnd(ev) <= now)
    throw conflict('This event has already ended', { reason: 'event_ended' });
}

async function occupancy(tx: Queryable, eventId: string): Promise<number> {
  const { rows } = await tx.query<{ n: number }>(
    `SELECT COALESCE(sum(spots), 0)::int AS n FROM event_attendees WHERE event_id = $1 AND status IN ('going','attended')`,
    [eventId],
  );
  return rows[0]!.n;
}

/** Denormalised counters are recomputed from rows inside the mutating transaction so they cannot drift. */
export async function recountEvent(
  tx: Queryable,
  eventId: string,
): Promise<{ going: number; interested: number; waitlist: number }> {
  const { rows } = await tx.query<{ going: number; interested: number; waitlist: number }>(
    `UPDATE events SET
       going_count = (SELECT COALESCE(sum(spots), 0) FROM event_attendees WHERE event_id = $1 AND status IN ('going','attended')),
       interested_count = (SELECT count(*) FROM event_attendees WHERE event_id = $1 AND status = 'interested')
     WHERE id = $1
     RETURNING going_count AS going, interested_count AS interested, (SELECT count(*) FROM event_attendees WHERE event_id = $1 AND status = 'waitlist')::int AS waitlist`,
    [eventId],
  );
  return rows[0]!;
}

/** Recompute an attendee's occupied spots from their active ticket grants (1 when they have none). */
async function refreshSpots(tx: Queryable, eventId: string, userId: string): Promise<void> {
  await tx.query(
    `UPDATE event_attendees SET spots = GREATEST(1, COALESCE((SELECT sum(quantity) FROM event_ticket_grants g WHERE g.event_id = $1 AND g.user_id = $2 AND g.status = 'active'), 0))
      WHERE event_id = $1 AND user_id = $2`,
    [eventId, userId],
  );
}

/** Release the free (order-less) RSVP grant of a user, giving the ticket back. */
async function releaseFreeGrants(tx: Queryable, eventId: string, userId: string): Promise<void> {
  const { rows } = await tx.query<{ ticket_type_id: string; quantity: number }>(
    `UPDATE event_ticket_grants SET status = 'released', released_at = now() WHERE event_id = $1 AND user_id = $2 AND order_id IS NULL AND status = 'active' RETURNING ticket_type_id, quantity`,
    [eventId, userId],
  );
  for (const g of rows)
    await tx.query('UPDATE event_ticket_types SET sold = GREATEST(0, sold - $2) WHERE id = $1', [
      g.ticket_type_id,
      g.quantity,
    ]);
}

async function hasPaidGrants(tx: Queryable, eventId: string, userId: string): Promise<boolean> {
  const { rowCount } = await tx.query(
    `SELECT 1 FROM event_ticket_grants WHERE event_id = $1 AND user_id = $2 AND order_id IS NOT NULL AND status = 'active'`,
    [eventId, userId],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Give freed spots to the waitlist in FIFO order. Waitlisted users who wanted a specific free ticket type are skipped while that
 * type is sold out. Returns the promoted user ids (the caller notifies them after commit).
 */
export async function promoteWaitlist(tx: Tx, ev: LockedEvent): Promise<string[]> {
  if (ev.status !== 'published') return [];
  const promoted: string[] = [];
  const { rows: queue } = await tx.query<{
    user_id: string;
    spots: number;
    waitlist_ticket_type_id: string | null;
  }>(
    `SELECT user_id, spots, waitlist_ticket_type_id FROM event_attendees WHERE event_id = $1 AND status = 'waitlist' ORDER BY waitlisted_at, user_id`,
    [ev.id],
  );
  let used = await occupancy(tx, ev.id);
  for (const w of queue) {
    if (ev.capacity !== null && used + w.spots > ev.capacity) {
      if (used >= ev.capacity) break;
      continue;
    }
    if (w.waitlist_ticket_type_id) {
      const t = await tx.query(
        `UPDATE event_ticket_types SET sold = sold + 1 WHERE id = $1 AND archived_at IS NULL AND sold + 1 <= quantity AND price_cents = 0 RETURNING id`,
        [w.waitlist_ticket_type_id],
      );
      if (!t.rowCount) continue;
      await tx.query(
        `INSERT INTO event_ticket_grants (event_id, user_id, ticket_type_id, quantity) VALUES ($1,$2,$3,1) ON CONFLICT (event_id, user_id) WHERE order_id IS NULL AND status = 'active' DO NOTHING`,
        [ev.id, w.user_id, w.waitlist_ticket_type_id],
      );
    }
    await tx.query(
      `UPDATE event_attendees SET status = 'going', waitlisted_at = NULL, waitlist_ticket_type_id = NULL, checkin_code = COALESCE(checkin_code, $3) WHERE event_id = $1 AND user_id = $2`,
      [ev.id, w.user_id, newCheckinCode()],
    );
    used += w.spots;
    promoted.push(w.user_id);
  }
  if (promoted.length) await recountEvent(tx, ev.id);
  return promoted;
}

async function notifyPromoted(
  ctx: AppContext,
  ev: Pick<LockedEvent, 'id' | 'title' | 'host_id'>,
  userIds: string[],
): Promise<void> {
  for (const userId of userIds) {
    await notify(ctx, {
      userId,
      kind: 'event_waitlist_promoted',
      actorId: ev.host_id,
      targetType: 'event',
      targetId: ev.id,
      data: { title: ev.title },
    });
  }
}

// ------------------------------------------------------------------ RSVP (free attendance)

export type RsvpStatus = 'going' | 'interested' | 'not_going';
export interface RsvpResult {
  status: 'going' | 'interested' | 'waitlist' | 'not_going';
  goingCount: number;
  interestedCount: number;
  waitlistCount: number;
  promoted: string[];
}

interface AttendeeRow {
  status: string;
  spots: number;
  checkin_code: string | null;
}

/**
 * Set a user's RSVP. Free attendance only: events with ticket types require picking a *free* ticket type; paid types are
 * bought through checkout (`attendEventWithTicket`). Concurrency-safe: the event row lock serialises RSVPs, so two people racing
 * for the last spot yield exactly one `going` and one `waitlist` (or a 409 when the waitlist is disabled).
 */
export async function setRsvp(
  ctx: AppContext,
  p: { eventId: string; userId: string; status: RsvpStatus; ticketTypeId?: string | undefined },
): Promise<RsvpResult> {
  const out = await withTransaction(ctx.db, async (tx) => {
    const ev = await lockEvent(tx, p.eventId);
    const { rows } = await tx.query<AttendeeRow>(
      'SELECT status, spots, checkin_code FROM event_attendees WHERE event_id = $1 AND user_id = $2 FOR UPDATE',
      [p.eventId, p.userId],
    );
    const existing = rows[0] ?? null;
    let status: RsvpResult['status'];

    if (p.status === 'not_going') {
      if (!existing || existing.status === 'cancelled') {
        status = 'not_going';
      } else {
        if (existing.status === 'attended')
          throw conflict('You have already checked in to this event');
        if (await hasPaidGrants(tx, p.eventId, p.userId))
          throw new AppError(
            'unprocessable',
            'Paid tickets are cancelled through a refund, not an RSVP',
            { reason: 'paid_ticket' },
          );
        await releaseFreeGrants(tx, p.eventId, p.userId);
        await tx.query(
          `UPDATE event_attendees SET status = 'cancelled', spots = 1, waitlisted_at = NULL, waitlist_ticket_type_id = NULL WHERE event_id = $1 AND user_id = $2`,
          [p.eventId, p.userId],
        );
        status = 'not_going';
      }
      await tx.query(
        `UPDATE event_invitations SET status = 'declined' WHERE event_id = $1 AND user_id = $2 AND status = 'pending'`,
        [p.eventId, p.userId],
      );
    } else if (p.status === 'interested') {
      assertOpenForAttendance(ev);
      if (existing?.status === 'attended')
        throw conflict('You have already checked in to this event');
      if (existing && ['going', 'waitlist'].includes(existing.status)) {
        if (await hasPaidGrants(tx, p.eventId, p.userId))
          throw new AppError('unprocessable', 'You hold a paid ticket for this event', {
            reason: 'paid_ticket',
          });
        await releaseFreeGrants(tx, p.eventId, p.userId);
      }
      await tx.query(
        `INSERT INTO event_attendees (event_id, user_id, status) VALUES ($1,$2,'interested')
         ON CONFLICT (event_id, user_id) DO UPDATE SET status = 'interested', spots = 1, waitlisted_at = NULL, waitlist_ticket_type_id = NULL`,
        [p.eventId, p.userId],
      );
      await tx.query(
        `UPDATE event_invitations SET status = 'accepted' WHERE event_id = $1 AND user_id = $2 AND status = 'pending'`,
        [p.eventId, p.userId],
      );
      status = 'interested';
    } else {
      assertOpenForAttendance(ev);
      if (existing?.status === 'going' || existing?.status === 'attended') status = 'going';
      else if (existing?.status === 'waitlist') status = 'waitlist';
      else {
        const { rows: types } = await tx.query<{
          id: string;
          price_cents: number;
          quantity: number;
          sold: number;
          sales_start: Date | null;
          sales_end: Date | null;
        }>(
          `SELECT id, price_cents, quantity, sold, sales_start, sales_end FROM event_ticket_types WHERE event_id = $1 AND archived_at IS NULL ORDER BY position, created_at`,
          [p.eventId],
        );
        let typeId: string | null = null;
        let typeFull = false;
        if (types.length) {
          const paidOnly = types.every((t) => t.price_cents > 0);
          if (paidOnly)
            throw new AppError(
              'payment_required',
              'Tickets for this event are bought at checkout',
              { reason: 'paid_tickets_only' },
            );
          if (!p.ticketTypeId) throw invalid('Choose a ticket type (ticketTypeId) for this event');
          const t = types.find((x) => x.id === p.ticketTypeId);
          if (!t) throw invalid('Unknown ticket type for this event');
          if (t.price_cents > 0)
            throw new AppError('payment_required', 'This ticket type is paid: buy it at checkout', {
              reason: 'paid_ticket_type',
            });
          const now = new Date();
          if ((t.sales_start && t.sales_start > now) || (t.sales_end && t.sales_end <= now))
            throw conflict('Tickets of this type are not on sale right now', {
              reason: 'sales_closed',
            });
          typeFull = t.sold + 1 > t.quantity;
          typeId = t.id;
        }
        const used = await occupancy(tx, p.eventId);
        if (typeFull || (ev.capacity !== null && used + 1 > ev.capacity)) {
          if (!ev.waitlist_enabled)
            throw conflict(typeFull ? 'This ticket type is sold out' : 'This event is full', {
              reason: typeFull ? 'ticket_sold_out' : 'event_full',
            });
          await tx.query(
            `INSERT INTO event_attendees (event_id, user_id, status, waitlisted_at, waitlist_ticket_type_id, spots) VALUES ($1,$2,'waitlist', now(), $3, 1)
             ON CONFLICT (event_id, user_id) DO UPDATE SET status = 'waitlist', waitlisted_at = now(), waitlist_ticket_type_id = EXCLUDED.waitlist_ticket_type_id, spots = 1`,
            [p.eventId, p.userId, typeId],
          );
          status = 'waitlist';
        } else {
          if (typeId) {
            const inc = await tx.query(
              'UPDATE event_ticket_types SET sold = sold + 1 WHERE id = $1 AND sold + 1 <= quantity RETURNING id',
              [typeId],
            );
            if (!inc.rowCount)
              throw conflict('This ticket type is sold out', { reason: 'ticket_sold_out' });
            await tx.query(
              `INSERT INTO event_ticket_grants (event_id, user_id, ticket_type_id, quantity) VALUES ($1,$2,$3,1)`,
              [p.eventId, p.userId, typeId],
            );
          }
          await tx.query(
            `INSERT INTO event_attendees (event_id, user_id, status, spots, checkin_code) VALUES ($1,$2,'going',1,$3)
             ON CONFLICT (event_id, user_id) DO UPDATE SET status = 'going', spots = 1, waitlisted_at = NULL, waitlist_ticket_type_id = NULL, checkin_code = COALESCE(event_attendees.checkin_code, EXCLUDED.checkin_code)`,
            [p.eventId, p.userId, newCheckinCode()],
          );
          status = 'going';
        }
      }
      await tx.query(
        `UPDATE event_invitations SET status = 'accepted' WHERE event_id = $1 AND user_id = $2 AND status = 'pending'`,
        [p.eventId, p.userId],
      );
    }

    let promoted: string[] = [];
    if (p.status !== 'going') promoted = await promoteWaitlist(tx, ev);
    const counts = await recountEvent(tx, p.eventId);
    return {
      ev,
      result: {
        status,
        goingCount: counts.going,
        interestedCount: counts.interested,
        waitlistCount: counts.waitlist,
        promoted,
      } satisfies RsvpResult,
    };
  });
  await notifyPromoted(ctx, out.ev, out.result.promoted);
  return out.result;
}

// ------------------------------------------------------------------ paid tickets (called by commerce)

export interface AttendWithTicketInput {
  eventId: string;
  userId: string;
  ticketTypeId: string;
  orderId: string;
  /** Number of tickets in this order line (default 1). */
  quantity?: number;
}
export interface AttendWithTicketResult {
  status: 'going';
  /** True when this (order, ticket type, user) was already processed: nothing was changed. */
  alreadyProcessed: boolean;
  grantId: string;
  checkinCode: string;
}

/**
 * Commerce contract: call once payment for an order line is confirmed. Idempotent per (orderId, ticketTypeId, userId).
 * Atomically (under the event lock) checks the event is open, the ticket type belongs to the event, the per-user limit and the
 * remaining ticket-type and event capacity, then increments `event_ticket_types.sold`, records a grant and makes the user `going`.
 * Commerce must NOT touch `sold`/`going_count` itself. Throws 409 `conflict` with `details.reason` in
 * `event_closed | ticket_sold_out | event_full | ticket_limit` — in which case commerce must refund the order line.
 */
export async function attendEventWithTicket(
  ctx: AppContext,
  input: AttendWithTicketInput,
): Promise<AttendWithTicketResult> {
  const qty = input.quantity ?? 1;
  if (!Number.isInteger(qty) || qty < 1 || qty > 100)
    throw invalid('quantity must be between 1 and 100');
  const out = await withTransaction(ctx.db, async (tx) => {
    const ev = await lockEvent(tx, input.eventId);
    const { rows: type } = await tx.query<{ id: string; quantity: number; max_per_user: number }>(
      'SELECT id, quantity, max_per_user FROM event_ticket_types WHERE id = $1 AND event_id = $2',
      [input.ticketTypeId, input.eventId],
    );
    if (!type[0]) throw notFound('Ticket type');

    const prior = await tx.query<{ id: string }>(
      'SELECT id FROM event_ticket_grants WHERE order_id = $1 AND ticket_type_id = $2 AND user_id = $3',
      [input.orderId, input.ticketTypeId, input.userId],
    );
    if (prior.rows[0]) {
      const a = await tx.query<{ checkin_code: string | null }>(
        'SELECT checkin_code FROM event_attendees WHERE event_id = $1 AND user_id = $2',
        [input.eventId, input.userId],
      );
      return {
        ev,
        promoted: [] as string[],
        result: {
          status: 'going',
          alreadyProcessed: true,
          grantId: prior.rows[0].id,
          checkinCode: a.rows[0]?.checkin_code ?? '',
        } satisfies AttendWithTicketResult,
      };
    }

    if (ev.status !== 'published' || eventEnd(ev) <= new Date())
      throw conflict('This event is no longer open for tickets', { reason: 'event_closed' });

    const held = await tx.query<{ n: number }>(
      `SELECT COALESCE(sum(quantity), 0)::int AS n FROM event_ticket_grants WHERE event_id = $1 AND user_id = $2 AND ticket_type_id = $3 AND status = 'active'`,
      [input.eventId, input.userId, input.ticketTypeId],
    );
    if (held.rows[0]!.n + qty > type[0].max_per_user)
      throw conflict('Ticket limit per person exceeded', { reason: 'ticket_limit' });

    const { rows: cur } = await tx.query<AttendeeRow>(
      'SELECT status, spots, checkin_code FROM event_attendees WHERE event_id = $1 AND user_id = $2 FOR UPDATE',
      [input.eventId, input.userId],
    );
    const alreadyOccupying = cur[0] && ['going', 'attended'].includes(cur[0].status);
    const used = await occupancy(tx, input.eventId);
    // Buying tickets on top of an existing spot only adds the new tickets; a plain RSVP spot (no grants) is replaced by the tickets.
    const hasGrants = await tx.query(
      `SELECT 1 FROM event_ticket_grants WHERE event_id = $1 AND user_id = $2 AND status = 'active'`,
      [input.eventId, input.userId],
    );
    const extra = alreadyOccupying
      ? hasGrants.rowCount
        ? qty
        : Math.max(0, qty - cur[0]!.spots)
      : qty;
    if (ev.capacity !== null && used + extra > ev.capacity)
      throw conflict('This event is full', { reason: 'event_full' });

    const inc = await tx.query(
      'UPDATE event_ticket_types SET sold = sold + $2 WHERE id = $1 AND sold + $2 <= quantity RETURNING id',
      [input.ticketTypeId, qty],
    );
    if (!inc.rowCount)
      throw conflict('This ticket type is sold out', { reason: 'ticket_sold_out' });

    const g = await tx.query<{ id: string }>(
      `INSERT INTO event_ticket_grants (event_id, user_id, ticket_type_id, order_id, quantity) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [input.eventId, input.userId, input.ticketTypeId, input.orderId, qty],
    );
    const code = newCheckinCode();
    const att = await tx.query<{ checkin_code: string }>(
      `INSERT INTO event_attendees (event_id, user_id, status, spots, checkin_code) VALUES ($1,$2,'going',$3,$4)
       ON CONFLICT (event_id, user_id) DO UPDATE SET status = CASE WHEN event_attendees.status = 'attended' THEN 'attended' ELSE 'going' END,
         waitlisted_at = NULL, waitlist_ticket_type_id = NULL, checkin_code = COALESCE(event_attendees.checkin_code, EXCLUDED.checkin_code)
       RETURNING checkin_code`,
      [input.eventId, input.userId, qty, code],
    );
    await refreshSpots(tx, input.eventId, input.userId);
    await tx.query(
      `UPDATE event_invitations SET status = 'accepted' WHERE event_id = $1 AND user_id = $2 AND status = 'pending'`,
      [input.eventId, input.userId],
    );
    await recountEvent(tx, input.eventId);
    return {
      ev,
      promoted: [] as string[],
      result: {
        status: 'going',
        alreadyProcessed: false,
        grantId: g.rows[0]!.id,
        checkinCode: att.rows[0]!.checkin_code,
      } satisfies AttendWithTicketResult,
    };
  });
  return out.result;
}

/**
 * Commerce contract for refunds/cancellations: release the tickets of an order (idempotent). Gives capacity back, cancels the user's
 * attendance when no tickets remain and promotes the waitlist.
 */
export async function releaseEventTicket(
  ctx: AppContext,
  input: { eventId: string; userId: string; orderId: string },
): Promise<{ released: number; promoted: string[] }> {
  const out = await withTransaction(ctx.db, async (tx) => {
    const ev = await lockEvent(tx, input.eventId);
    const { rows } = await tx.query<{ ticket_type_id: string; quantity: number }>(
      `UPDATE event_ticket_grants SET status = 'released', released_at = now() WHERE event_id = $1 AND user_id = $2 AND order_id = $3 AND status = 'active' RETURNING ticket_type_id, quantity`,
      [input.eventId, input.userId, input.orderId],
    );
    if (!rows.length) return { ev, released: 0, promoted: [] as string[] };
    for (const g of rows)
      await tx.query('UPDATE event_ticket_types SET sold = GREATEST(0, sold - $2) WHERE id = $1', [
        g.ticket_type_id,
        g.quantity,
      ]);
    const left = await tx.query(
      `SELECT 1 FROM event_ticket_grants WHERE event_id = $1 AND user_id = $2 AND status = 'active'`,
      [input.eventId, input.userId],
    );
    if (!left.rowCount) {
      await tx.query(
        `UPDATE event_attendees SET status = 'cancelled', spots = 1 WHERE event_id = $1 AND user_id = $2 AND status IN ('going','waitlist')`,
        [input.eventId, input.userId],
      );
    } else {
      await refreshSpots(tx, input.eventId, input.userId);
    }
    await recountEvent(tx, input.eventId);
    const promoted = await promoteWaitlist(tx, ev);
    return { ev, released: rows.reduce((n, g) => n + g.quantity, 0), promoted };
  });
  await notifyPromoted(ctx, out.ev, out.promoted);
  return { released: out.released, promoted: out.promoted };
}

/** After a capacity increase (or any other change that may free spots): promote the waitlist and notify. Caller holds the event lock in `tx`. */
export async function afterCapacityChange(
  ctx: AppContext,
  ev: LockedEvent,
  tx: Tx,
): Promise<() => Promise<void>> {
  const promoted = await promoteWaitlist(tx, ev);
  await recountEvent(tx, ev.id);
  return () => notifyPromoted(ctx, ev, promoted);
}

// ------------------------------------------------------------------ check-in

export interface CheckInResult {
  userId: string;
  alreadyCheckedIn: boolean;
  via: 'user' | 'code' | 'ticket';
}

/**
 * Host check-in by user id or by code (an attendee's personal code, or a purchased ticket code from `tickets`). The caller must already
 * have verified that the actor is an organiser of the event.
 */
export async function checkInAttendee(
  ctx: AppContext,
  p: { eventId: string; actorId: string; userId?: string | undefined; code?: string | undefined },
): Promise<CheckInResult> {
  if (!p.userId && !p.code) throw invalid('Provide userId or code');
  return withTransaction(ctx.db, async (tx) => {
    const ev = await lockEvent(tx, p.eventId);
    if (ev.status === 'cancelled')
      throw conflict('This event was cancelled', { reason: 'event_cancelled' });
    if (ev.status === 'draft')
      throw conflict('This event is not published', { reason: 'event_not_open' });
    if (Date.now() < ev.starts_at.getTime() - 3 * 3_600_000)
      throw conflict('Check-in opens 3 hours before the event starts', {
        reason: 'checkin_not_open',
      });

    let userId = p.userId ?? null;
    let via: CheckInResult['via'] = 'user';
    let ticketId: string | null = null;
    if (p.code) {
      const code = normalizeCode(p.code);
      via = 'code';
      const a = await tx.query<{ user_id: string }>(
        'SELECT user_id FROM event_attendees WHERE event_id = $1 AND checkin_code = $2',
        [p.eventId, code],
      );
      if (a.rows[0]) userId = a.rows[0].user_id;
      else {
        const t = await tx.query<{ id: string; owner_id: string; status: string }>(
          'SELECT id, owner_id, status FROM tickets WHERE event_id = $1 AND code = $2 FOR UPDATE',
          [p.eventId, p.code.trim()],
        );
        if (!t.rows[0]) throw notFound('Ticket');
        if (t.rows[0].status === 'used')
          return { userId: t.rows[0].owner_id, alreadyCheckedIn: true, via: 'ticket' as const };
        if (t.rows[0].status !== 'valid')
          throw new AppError('unprocessable', 'This ticket is not valid', {
            reason: `ticket_${t.rows[0].status}`,
          });
        userId = t.rows[0].owner_id;
        ticketId = t.rows[0].id;
        via = 'ticket';
      }
    }
    if (!userId) throw notFound('Attendee');

    const { rows } = await tx.query<{ status: string }>(
      'SELECT status FROM event_attendees WHERE event_id = $1 AND user_id = $2 FOR UPDATE',
      [p.eventId, userId],
    );
    const cur = rows[0];
    if (!cur || !['going', 'attended'].includes(cur.status))
      throw conflict('This person is not registered as going', {
        reason: cur?.status === 'waitlist' ? 'on_waitlist' : 'not_registered',
      });
    if (ticketId)
      await tx.query(`UPDATE tickets SET status = 'used', checked_in_at = now() WHERE id = $1`, [
        ticketId,
      ]);
    if (cur.status === 'attended') return { userId, alreadyCheckedIn: true, via };
    await tx.query(
      `UPDATE event_attendees SET status = 'attended', checked_in_at = now(), checked_in_by = $3 WHERE event_id = $1 AND user_id = $2`,
      [p.eventId, userId, p.actorId],
    );
    await audit(
      ctx,
      {
        actorId: p.actorId,
        action: 'event.check_in',
        targetType: 'event',
        targetId: p.eventId,
        metadata: { attendeeId: userId, via },
      },
      undefined,
      tx,
    );
    return { userId, alreadyCheckedIn: false, via };
  });
}

// ------------------------------------------------------------------ cancel / complete / notifications

/** Notify everyone with a stake in the event (excluding `exceptUserId`). Fans out in batches; notify() honours blocks/preferences. */
export async function notifyEventAudience(
  ctx: AppContext,
  eventId: string,
  statuses: string[],
  n: { kind: string; actorId: string | null; data?: Record<string, unknown> },
  exceptUserId?: string,
  db: Queryable = ctx.db,
): Promise<number> {
  let after = '00000000-0000-0000-0000-000000000000';
  let total = 0;
  for (;;) {
    const { rows } = await db.query<{ user_id: string }>(
      `SELECT user_id FROM event_attendees WHERE event_id = $1 AND status = ANY($2::text[]) AND user_id > $3::uuid ORDER BY user_id LIMIT 500`,
      [eventId, statuses, after],
    );
    if (!rows.length) break;
    for (const r of rows) {
      if (r.user_id === exceptUserId) continue;
      await notify(
        ctx,
        {
          userId: r.user_id,
          kind: n.kind,
          actorId: n.actorId,
          targetType: 'event',
          targetId: eventId,
          ...(n.data ? { data: n.data } : {}),
        },
        db,
      );
      total++;
    }
    after = rows[rows.length - 1]!.user_id;
  }
  return total;
}

/**
 * Cancel an event (draft/published). Attendees, waitlisted and interested people are notified. Paid ticket refunds belong to commerce:
 * it finds affected orders via `event_ticket_grants` (status 'active', order_id not null) — the grants are left untouched here.
 */
export async function cancelEvent(
  ctx: AppContext,
  p: { eventId: string; actorId: string | null; reason?: string | undefined },
  db?: Tx,
): Promise<boolean> {
  const run = async (tx: Tx) => {
    const ev = await lockEvent(tx, p.eventId);
    if (ev.status === 'cancelled') return { changed: false, ev };
    if (ev.status === 'completed')
      throw conflict('A completed event cannot be cancelled', { reason: 'event_completed' });
    await tx.query(
      `UPDATE events SET status = 'cancelled', cancelled_at = now(), cancel_reason = $2 WHERE id = $1`,
      [p.eventId, p.reason?.trim() || null],
    );
    return { changed: true, ev };
  };
  const { changed, ev } = db ? await run(db) : await withTransaction(ctx.db, run);
  if (changed && !db) {
    await notifyEventAudience(ctx, p.eventId, ['going', 'waitlist', 'interested', 'attended'], {
      kind: 'event_cancelled',
      actorId: p.actorId,
      data: { title: ev.title, reason: p.reason ?? null },
    });
  }
  return changed;
}

/** Mark published events that have ended as completed. Safe to run repeatedly/concurrently. Returns the completed event ids. */
export async function completeEndedEvents(
  ctx: AppContext,
  now: Date = new Date(),
): Promise<string[]> {
  const { rows } = await ctx.db.query<{ id: string }>(
    `UPDATE events e SET status = 'completed', completed_at = $1
      WHERE e.status = 'published' AND e.deleted_at IS NULL AND ${`COALESCE(e.ends_at, e.starts_at + interval '${OPEN_ENDED_EVENT_HOURS} hours')`} < $1
      RETURNING e.id`,
    [now],
  );
  return rows.map((r) => r.id);
}

// ------------------------------------------------------------------ reminders

export interface ReminderStats {
  considered: number;
  sent: number;
  alreadySent: number;
}

/**
 * Job: send `event_reminder` notifications for published events starting within 24h (going + interested) and within 1h (going).
 * Idempotent: `event_reminders` (event, user, kind) is claimed before notifying, so concurrent workers or re-runs never double-send.
 * Wire to a scheduler through `scripts/send-event-reminders.ts`.
 */
export async function sendEventReminders(
  ctx: AppContext,
  now: Date = new Date(),
  maxRows = 5000,
): Promise<ReminderStats> {
  const { rows } = await ctx.db.query<{
    event_id: string;
    title: string;
    starts_at: Date;
    host_id: string | null;
    user_id: string;
    kind: '24h' | '1h';
  }>(
    `SELECT e.id AS event_id, e.title, e.starts_at, e.host_id, a.user_id,
            CASE WHEN e.starts_at <= $1::timestamptz + interval '1 hour' THEN '1h' ELSE '24h' END AS kind
       FROM events e JOIN event_attendees a ON a.event_id = e.id
      WHERE e.status = 'published' AND e.deleted_at IS NULL AND e.starts_at > $1::timestamptz AND e.starts_at <= $1::timestamptz + interval '24 hours'
        AND (a.status = 'going' OR (a.status = 'interested' AND e.starts_at > $1::timestamptz + interval '1 hour'))
        AND NOT EXISTS (SELECT 1 FROM event_reminders r WHERE r.event_id = e.id AND r.user_id = a.user_id
                          AND r.kind = CASE WHEN e.starts_at <= $1::timestamptz + interval '1 hour' THEN '1h' ELSE '24h' END)
      ORDER BY e.starts_at, a.user_id LIMIT $2`,
    [now, maxRows],
  );
  const stats: ReminderStats = { considered: rows.length, sent: 0, alreadySent: 0 };
  for (const r of rows) {
    const claim = await ctx.db.query(
      'INSERT INTO event_reminders (event_id, user_id, kind, sent_at) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING',
      [r.event_id, r.user_id, r.kind, now],
    );
    if (!claim.rowCount) {
      stats.alreadySent++;
      continue;
    }
    await notify(ctx, {
      userId: r.user_id,
      kind: 'event_reminder',
      targetType: 'event',
      targetId: r.event_id,
      data: { title: r.title, startsAt: r.starts_at.toISOString(), window: r.kind },
    });
    stats.sent++;
  }
  return stats;
}

// ------------------------------------------------------------------ memory feature hooks

export interface MemoryEventSummary {
  id: string;
  title: string;
  startsAt: string;
  endsAt: string | null;
  placeId: string | null;
  locationText: string | null;
  latitude: number | null;
  longitude: number | null;
}

/** Events a user attended (checked in, or went to a completed event), most recent first. For the memory module. Only the user's own history. */
export async function listAttendedEventsForMemory(
  ctx: AppContext,
  userId: string,
  opts: { since?: Date; until?: Date; limit?: number } = {},
): Promise<MemoryEventSummary[]> {
  const { rows } = await ctx.db.query(
    `SELECT e.id, e.title, e.starts_at, e.ends_at, e.place_id, e.location_text, e.latitude, e.longitude
       FROM event_attendees a JOIN events e ON e.id = a.event_id AND e.deleted_at IS NULL
      WHERE a.user_id = $1 AND (a.status = 'attended' OR (a.status = 'going' AND e.status = 'completed'))
        AND e.status IN ('published','completed') AND e.starts_at < now()
        AND ($2::timestamptz IS NULL OR e.starts_at >= $2) AND ($3::timestamptz IS NULL OR e.starts_at < $3)
      ORDER BY e.starts_at DESC, e.id LIMIT $4`,
    [userId, opts.since ?? null, opts.until ?? null, Math.min(opts.limit ?? 50, 200)],
  );
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    startsAt: r.starts_at.toISOString(),
    endsAt: r.ends_at?.toISOString() ?? null,
    placeId: r.place_id,
    locationText: r.location_text,
    latitude: r.latitude,
    longitude: r.longitude,
  }));
}

/**
 * The people a user shared an event with, for memory features. Requires the user to have attended (or gone to a completed event); returns
 * only *friends* of the user who also attended, never blocked users and never anyone else. Returns null when the user has no standing.
 */
export async function listEventAttendeesForMemory(
  ctx: AppContext,
  p: { eventId: string; userId: string },
): Promise<{
  event: MemoryEventSummary;
  attendees: Array<{ userId: string; username: string; displayName: string }>;
} | null> {
  const mine = await ctx.db.query(
    `SELECT e.id, e.title, e.starts_at, e.ends_at, e.place_id, e.location_text, e.latitude, e.longitude
       FROM event_attendees a JOIN events e ON e.id = a.event_id AND e.deleted_at IS NULL
      WHERE a.event_id = $1 AND a.user_id = $2 AND (a.status = 'attended' OR (a.status = 'going' AND e.status = 'completed')) AND e.status IN ('published','completed')`,
    [p.eventId, p.userId],
  );
  const e = mine.rows[0];
  if (!e) return null;
  const { rows } = await ctx.db.query<{ user_id: string; username: string; display_name: string }>(
    `SELECT a.user_id, pr.username, pr.display_name
       FROM event_attendees a JOIN profiles pr ON pr.user_id = a.user_id JOIN users u ON u.id = a.user_id AND u.deleted_at IS NULL AND u.status = 'active'
      WHERE a.event_id = $1 AND a.user_id <> $2 AND (a.status = 'attended' OR a.status = 'going')
        AND EXISTS (SELECT 1 FROM friendships fr WHERE fr.user_low = LEAST($2::uuid, a.user_id) AND fr.user_high = GREATEST($2::uuid, a.user_id) AND fr.status = 'accepted')
        AND NOT EXISTS (SELECT 1 FROM user_blocks bl WHERE (bl.blocker_id = $2 AND bl.blocked_id = a.user_id) OR (bl.blocker_id = a.user_id AND bl.blocked_id = $2))
      ORDER BY pr.display_name, a.user_id LIMIT 200`,
    [p.eventId, p.userId],
  );
  return {
    event: {
      id: e.id,
      title: e.title,
      startsAt: e.starts_at.toISOString(),
      endsAt: e.ends_at?.toISOString() ?? null,
      placeId: e.place_id,
      locationText: e.location_text,
      latitude: e.latitude,
      longitude: e.longitude,
    },
    attendees: rows.map((r) => ({
      userId: r.user_id,
      username: r.username,
      displayName: r.display_name,
    })),
  };
}

// ------------------------------------------------------------------ account deletion

/**
 * Deletion hook body: remove the user's attendance (giving tickets back and promoting waitlists), hand hosted events to a co-host (or the
 * business owner for business events), and cancel upcoming events that would otherwise be orphaned.
 */
export async function removeUserFromEvents(ctx: AppContext, tx: Tx, userId: string): Promise<void> {
  // hosted events
  const { rows: hosted } = await tx.query<{
    id: string;
    status: string;
    host_business_id: string | null;
    starts_at: Date;
    ends_at: Date | null;
  }>(
    'SELECT id, status, host_business_id, starts_at, ends_at FROM events WHERE host_id = $1 AND deleted_at IS NULL FOR UPDATE',
    [userId],
  );
  for (const h of hosted) {
    let successor: string | null = null;
    const co = await tx.query<{ user_id: string }>(
      'SELECT user_id FROM event_organizers WHERE event_id = $1 AND user_id <> $2 ORDER BY created_at LIMIT 1',
      [h.id, userId],
    );
    successor = co.rows[0]?.user_id ?? null;
    if (!successor && h.host_business_id) {
      const o = await tx.query<{ owner_id: string | null }>(
        'SELECT owner_id FROM businesses WHERE id = $1 AND deleted_at IS NULL',
        [h.host_business_id],
      );
      if (o.rows[0]?.owner_id && o.rows[0].owner_id !== userId) successor = o.rows[0].owner_id;
    }
    if (successor) {
      await tx.query('UPDATE events SET host_id = $2 WHERE id = $1', [h.id, successor]);
      await tx.query('DELETE FROM event_organizers WHERE event_id = $1 AND user_id = $2', [
        h.id,
        successor,
      ]);
      continue;
    }
    if (h.status === 'draft' || h.status === 'published') {
      await tx.query(
        `UPDATE events SET status = 'cancelled', cancelled_at = now(), cancel_reason = 'The host closed their account', host_id = NULL WHERE id = $1`,
        [h.id],
      );
      await notifyEventAudience(
        ctx,
        h.id,
        ['going', 'waitlist', 'interested'],
        { kind: 'event_cancelled', actorId: null, data: { reason: 'host_left' } },
        userId,
        tx,
      );
    } else {
      await tx.query('UPDATE events SET host_id = NULL WHERE id = $1', [h.id]);
    }
  }
  await tx.query('DELETE FROM event_organizers WHERE user_id = $1', [userId]);
  await tx.query('DELETE FROM event_invitations WHERE user_id = $1 OR invited_by = $1', [userId]);
  await tx.query(`DELETE FROM saves WHERE user_id = $1 AND target_type = 'event'`, [userId]);
  await tx.query('DELETE FROM event_reminders WHERE user_id = $1', [userId]);

  // attendance: release spots, then promote waitlists of affected events
  const { rows: affected } = await tx.query<{ event_id: string }>(
    'SELECT event_id FROM event_attendees WHERE user_id = $1',
    [userId],
  );
  for (const a of affected) {
    const ev = await tx.query<LockedEvent>(
      `SELECT id, title, status, capacity, waitlist_enabled, starts_at, ends_at, host_id FROM events WHERE id = $1 FOR UPDATE`,
      [a.event_id],
    );
    await tx.query(
      `UPDATE event_ticket_types t SET sold = GREATEST(0, t.sold - g.q) FROM (
         SELECT ticket_type_id, sum(quantity)::int AS q FROM event_ticket_grants WHERE event_id = $1 AND user_id = $2 AND status = 'active' GROUP BY ticket_type_id) g
        WHERE t.id = g.ticket_type_id`,
      [a.event_id, userId],
    );
    await tx.query(
      `UPDATE event_ticket_grants SET status = 'released', released_at = now() WHERE event_id = $1 AND user_id = $2 AND status = 'active'`,
      [a.event_id, userId],
    );
    await tx.query('DELETE FROM event_attendees WHERE event_id = $1 AND user_id = $2', [
      a.event_id,
      userId,
    ]);
    if (ev.rows[0]) {
      await recountEvent(tx, a.event_id);
      const promoted = await promoteWaitlist(tx, ev.rows[0]);
      for (const u of promoted)
        await notify(
          ctx,
          {
            userId: u,
            kind: 'event_waitlist_promoted',
            targetType: 'event',
            targetId: a.event_id,
            data: { title: ev.rows[0].title },
          },
          tx,
        );
    }
  }
}

export { forbidden };
