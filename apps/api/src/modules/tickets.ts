import type { FastifyInstance } from 'fastify';
import { tx } from '@yapilapi/database';
import {
  addCohostSchema,
  checkInSchema,
  EVENT_DEFAULT_HOURS,
  guestListQuerySchema,
  normalizeTicketCode,
  transferTicketSchema,
  type CheckInMethod,
  type CheckInResult,
  type CheckInResultKind,
  type DoorSummary,
} from '@yapilapi/shared';
import { z } from 'zod';
import type { AppContext } from '../lib/context.ts';
import { AppError, badRequest, forbidden, notFound, parse } from '../lib/errors.ts';
import { audit, notify, track } from '../lib/services.ts';
import {
  doorCounts,
  doorRole,
  freshCode,
  GUEST_COLS,
  GUEST_FROM,
  newNonce,
  publishDoor,
  readTicketToken,
  TICKET_SELECT,
  ticketSecret,
  toGuest,
  toTicket,
} from '../lib/tickets.ts';
import { areFriends, isBlockedEitherWay, PUBLIC_USER_COLS, toPublicUser, type PublicUserRow } from '../lib/users.ts';
import { me, requireAuth } from '../plugins/auth.ts';

const idParam = z.object({ id: z.string().uuid() });
const ticketParam = z.object({ id: z.string().uuid(), ticketId: z.string().uuid() });
const cohostParam = z.object({ id: z.string().uuid(), userId: z.string().uuid() });

/** Attempts at the door that found nothing (a wrong code, a changed QR code) before the door has to wait. */
export const FAILED_CHECK_INS_MAX = 20;
export const FAILED_CHECK_INS_MINUTES = 10;
/** Co-hosts per event. */
export const COHOSTS_MAX = 10;
/** A check-in kept offline can be dated this far back, at most. */
const OFFLINE_HOURS = 12;

const ENDED = `coalesce(e.ends_at, e.starts_at + interval '${EVENT_DEFAULT_HOURS} hours')`;

/**
 * Event tickets and check-in at the door (0059). Tickets are issued where RSVPs and payments happen
 * (modules/events.ts, the payment webhook in modules/commerce.ts); here are the wallet, transfers to
 * friends, the guest list, check-in and co-hosts.
 *
 * Only the host and co-hosts see the guest list and check people in; to anyone else those routes are
 * "not found". Someone under 18 on the guest list shows by first name only to hosts who aren't their
 * friend. Failed attempts at the door are limited per person, so backup codes can't be guessed.
 */
export default async function ticketsModule(app: FastifyInstance, ctx: AppContext) {
  const db = ctx.db;
  const secret = ticketSecret(ctx.config);

  async function loadTicket(id: string, holderId: string) {
    const row = (await db.query(`${TICKET_SELECT} WHERE t.id = $2 AND t.holder_id = $1`, [holderId, id])).rows[0];
    if (!row) throw notFound('Ticket');
    return toTicket(row, secret);
  }

  /** The door team only: anyone else gets "not found", as if there were no such event. */
  async function assertDoor(eventId: string, userId: string) {
    const role = await doorRole(db, eventId, userId);
    if (!role) throw notFound('Event');
    return role;
  }

  // ── Your wallet ────────────────────────────────────────────────────────
  /**
   * Your tickets. Upcoming: valid ones for events still to come or on now, soonest first. Past: events
   * that ended or were cancelled, and refunded tickets, most recent first. A ticket you gave back by
   * changing your RSVP isn't listed.
   */
  app.get('/v1/tickets', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const q = parse(z.object({ when: z.enum(['upcoming', 'past']).default('upcoming'), limit: z.coerce.number().min(1).max(100).default(50) }), req.query);
    const where =
      q.when === 'upcoming'
        ? `t.status = 'valid' AND e.deleted_at IS NULL AND ${ENDED} >= now() ORDER BY e.starts_at, t.created_at`
        : `NOT (t.status = 'cancelled' AND e.deleted_at IS NULL) AND (t.status = 'refunded' OR e.deleted_at IS NOT NULL OR ${ENDED} < now())
           ORDER BY e.starts_at DESC, t.created_at`;
    const { rows } = await db.query(`${TICKET_SELECT} WHERE t.holder_id = $1 AND ${where} LIMIT $2`, [u.id, q.limit]);
    return { items: rows.map((r) => toTicket(r, secret)) };
  });

  app.get('/v1/tickets/:id', { preHandler: requireAuth }, async (req) => {
    const { id } = parse(idParam, req.params);
    return { ticket: await loadTicket(id, me(req).id) };
  });

  /**
   * Give your ticket to a friend, when the host allows it and it hasn't been used. It gets a new QR
   * code and backup code, so the copy you had stops working. Giving an RSVP ticket gives your place:
   * they're going instead of you.
   */
  app.post('/v1/tickets/:id/transfer', { preHandler: requireAuth, config: { rateLimit: { max: 20, timeWindow: '1 hour' } } }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const { userId } = parse(transferTicketSchema, req.body);
    if (userId === u.id) throw badRequest('This ticket is already yours.');
    const done = await tx(db, async (c) => {
      const t = (
        await c.query(
          `SELECT t.id, t.event_id, t.source, t.status, t.checked_in_at, e.host_id, e.ticket_transfers, e.deleted_at, ${ENDED} < now() AS ended
           FROM event_tickets t JOIN events e ON e.id = t.event_id WHERE t.id = $1 AND t.holder_id = $2 FOR UPDATE OF t`,
          [id, u.id],
        )
      ).rows[0];
      if (!t) throw notFound('Ticket');
      if (t.status !== 'valid' || t.deleted_at) throw new AppError(409, 'ticket_not_valid', 'This ticket can’t be used any more, so it can’t be given away.');
      if (t.checked_in_at) throw new AppError(409, 'ticket_used', 'This ticket was already used at the door.');
      if (t.ended) throw new AppError(409, 'event_over', 'This event is over.');
      if (!t.ticket_transfers) throw new AppError(403, 'transfers_off', 'The host has turned off giving tickets to friends for this event.');
      const friend = (await c.query<{ status: string }>(`SELECT status FROM users WHERE id = $1`, [userId])).rows[0];
      // Friends only: that also keeps the rule that adults reach people under 18 only as friends.
      if (!friend || friend.status !== 'active' || !(await areFriends(c, u.id, userId)))
        throw new AppError(403, 'friends_only', 'You can give a ticket to friends only.');
      if (userId === t.host_id) throw badRequest('The host doesn’t need a ticket.');
      if (await isBlockedEitherWay(c, t.host_id, userId)) throw new AppError(403, 'cant_transfer', 'You can’t give this ticket to them.');
      if (t.source === 'rsvp') {
        const has = await c.query(`SELECT status FROM event_tickets WHERE event_id = $1 AND holder_id = $2 AND source = 'rsvp'`, [t.event_id, userId]);
        if (has.rows[0]?.status === 'valid') throw new AppError(409, 'already_has_ticket', 'They already have a ticket for this event.');
        // Their old RSVP ticket (given back earlier) makes way; you're no longer going, they are.
        await c.query(`DELETE FROM event_tickets WHERE event_id = $1 AND holder_id = $2 AND source = 'rsvp'`, [t.event_id, userId]);
        await c.query(`UPDATE event_attendees SET status = 'not_going', updated_at = now() WHERE event_id = $1 AND user_id = $2`, [t.event_id, u.id]);
        await c.query(
          `INSERT INTO event_attendees (event_id, user_id, status) VALUES ($1,$2,'going')
           ON CONFLICT (event_id, user_id) DO UPDATE SET status = 'going', updated_at = now()`,
          [t.event_id, userId],
        );
      }
      await c.query(`UPDATE event_tickets SET holder_id = $2, token_nonce = $3, backup_code = $4, updated_at = now() WHERE id = $1`, [
        id,
        userId,
        newNonce(),
        await freshCode(c, t.event_id),
      ]);
      await c.query(`INSERT INTO ticket_transfers (ticket_id, from_id, to_id) VALUES ($1,$2,$3)`, [id, u.id, userId]);
      await audit(c, { actorId: u.id, action: 'ticket.transfer', entityType: 'ticket', entityId: id, metadata: { to: userId } });
      return { eventId: t.event_id as string };
    });
    await notify(db, ctx.realtime, { userId, category: 'events', type: 'ticket_received', actorId: u.id, entityType: 'ticket', entityId: id });
    await ctx.realtime.publish([u.id, userId], { type: 'ticket.updated', data: { ticketId: id } });
    await publishDoor(db, ctx.realtime, done.eventId);
    track(db, u.id, 'ticket_transferred');
    return { ok: true };
  });

  // ── The door ───────────────────────────────────────────────────────────
  /** The check-in screen: the event, whether you host or co-host it, the counts and the co-hosts. */
  app.get('/v1/events/:id/check-in', { preHandler: requireAuth }, async (req): Promise<DoorSummary> => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const role = await assertDoor(id, u.id);
    const e = (await db.query(`SELECT id, title, starts_at, ends_at, timezone, ticket_transfers FROM events WHERE id = $1`, [id])).rows[0];
    const cohosts = await db.query<PublicUserRow>(
      `SELECT ${PUBLIC_USER_COLS} FROM event_cohosts ec JOIN profiles pr ON pr.user_id = ec.user_id WHERE ec.event_id = $1 ORDER BY ec.created_at`,
      [id],
    );
    return {
      event: { id: e.id, title: e.title, startsAt: e.starts_at.toISOString(), endsAt: e.ends_at?.toISOString() ?? null, timezone: e.timezone },
      role,
      counts: await doorCounts(db, id),
      ticketTransfers: e.ticket_transfers,
      cohosts: cohosts.rows.map(toPublicUser),
    };
  });

  /**
   * The guest list: valid tickets, by name. `q` finds a name, a username or a backup code; someone
   * under 18 who isn't your friend is found by first name only. `filter`: everyone, checked in, or not yet.
   */
  app.get('/v1/events/:id/guests', { preHandler: requireAuth, config: { rateLimit: { max: 240, timeWindow: '1 minute' } } }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const q = parse(guestListQuerySchema, req.query);
    await assertDoor(id, u.id);
    const params: unknown[] = [u.id, id];
    const where = [`t.event_id = $2`, `t.status = 'valid'`];
    if (q.filter === 'in') where.push(`t.checked_in_at IS NOT NULL`);
    if (q.filter === 'waiting') where.push(`t.checked_in_at IS NULL`);
    if (q.q) {
      params.push(`%${q.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
      const like = `$${params.length}`;
      params.push(normalizeTicketCode(q.q));
      const code = `$${params.length}`;
      // What a host who isn't their friend sees of someone under 18 is all they can search by.
      const limited = `(coalesce(hu.birth_date > current_date - interval '18 years', false) AND t.holder_id <> $1
        AND NOT EXISTS (SELECT 1 FROM friendships fr WHERE (fr.user_a = $1 AND fr.user_b = t.holder_id) OR (fr.user_b = $1 AND fr.user_a = t.holder_id)))`;
      where.push(`(t.backup_code = ${code}
        OR (${limited} AND split_part(btrim(pr.display_name), ' ', 1) ILIKE ${like})
        OR (NOT ${limited} AND (pr.display_name ILIKE ${like} OR pr.username ILIKE ${like})))`);
    }
    // ($1, the viewer, is named even when the search doesn't need it, so every parameter has a type.)
    const total = (await db.query<{ n: number }>(`SELECT count(*)::int AS n, $1::uuid AS viewer FROM ${GUEST_FROM} WHERE ${where.join(' AND ')}`, params))
      .rows[0]!.n;
    params.push(q.limit, q.offset);
    const { rows } = await db.query(
      `SELECT ${GUEST_COLS} FROM ${GUEST_FROM} WHERE ${where.join(' AND ')}
       ORDER BY lower(pr.display_name), t.created_at LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return { items: rows.map((r) => toGuest(r, u.id)), total, nextOffset: q.offset + rows.length < total ? q.offset + rows.length : null };
  });

  /**
   * Check someone in with a scanned QR code, a typed backup code or a pick from the guest list. The
   * answer says what the door should know (see CHECK_IN_RESULTS); only a valid ticket for this event
   * says who it is. A check-in a browser kept while offline comes with its clientRef and when it was
   * scanned: sent again, it's the same check-in (not a conflict).
   */
  app.post(
    '/v1/events/:id/check-in',
    { preHandler: requireAuth, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (req): Promise<CheckInResult> => {
      const u = me(req);
      const { id } = parse(idParam, req.params);
      const input = parse(checkInSchema, req.body);
      await assertDoor(id, u.id);
      const failed = await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM ticket_scans
         WHERE scanner_id = $1 AND result IN ('invalid', 'wrong_event') AND created_at > now() - make_interval(mins => $2)`,
        [u.id, FAILED_CHECK_INS_MINUTES],
      );
      if (failed.rows[0]!.n >= FAILED_CHECK_INS_MAX)
        throw new AppError(429, 'too_many_attempts', 'Too many codes didn’t match. Wait a few minutes before trying again, or find the guest in the list.');
      const method: CheckInMethod = input.token ? 'qr' : input.code !== undefined ? 'code' : 'list';

      // Which ticket this is, if any. A token names its ticket; a code or a pick only counts in this event.
      let ticketId: string | null = null;
      let result: CheckInResultKind | null = null;
      let nonce: number | null = null;
      if (input.token) {
        const read = readTicketToken(secret, input.token);
        if (!read) result = 'invalid';
        else {
          const t = (await db.query<{ event_id: string }>(`SELECT event_id FROM event_tickets WHERE id = $1`, [read.ticketId])).rows[0];
          if (!t) result = 'invalid';
          else if (t.event_id !== id) result = 'wrong_event';
          else {
            ticketId = read.ticketId;
            nonce = read.nonce;
          }
        }
      } else if (input.code !== undefined) {
        const code = normalizeTicketCode(input.code);
        const t = code ? (await db.query<{ id: string }>(`SELECT id FROM event_tickets WHERE event_id = $1 AND backup_code = $2`, [id, code])).rows[0] : null;
        if (t) ticketId = t.id;
        else result = 'invalid';
      } else {
        const t = (await db.query<{ id: string }>(`SELECT id FROM event_tickets WHERE event_id = $1 AND id = $2`, [id, input.ticketId])).rows[0];
        if (t) ticketId = t.id;
        else result = 'invalid';
      }

      let replayed = false;
      let changed: { holderId: string; checkedInAt: string } | null = null;
      if (ticketId) {
        const at = input.scannedAt ?? null;
        const outcome = await tx(db, async (c) => {
          const t = (
            await c.query(`SELECT id, holder_id, status, token_nonce, checked_in_at, check_in_ref FROM event_tickets WHERE id = $1 FOR UPDATE`, [ticketId])
          ).rows[0];
          // Refunded and cancelled say so whatever copy of the code it is; an old copy of a valid ticket is not valid.
          if (t.status === 'refunded') return { result: 'refunded' as const };
          if (t.status === 'cancelled') return { result: 'cancelled' as const };
          if (nonce !== null && nonce !== t.token_nonce) return { result: 'invalid' as const, hide: true };
          if (t.checked_in_at) {
            if (input.clientRef && t.check_in_ref === input.clientRef) return { result: 'valid' as const, replayed: true };
            return { result: 'already' as const };
          }
          const r = await c.query<{ checked_in_at: Date }>(
            `UPDATE event_tickets SET checked_in_at = least(now(), greatest(now() - make_interval(hours => $4), coalesce($3::timestamptz, now()))),
                    checked_in_by = $2, check_in_ref = $5, updated_at = now()
             WHERE id = $1 RETURNING checked_in_at`,
            [ticketId, u.id, at, OFFLINE_HOURS, input.clientRef ?? null],
          );
          return { result: 'valid' as const, changed: { holderId: t.holder_id as string, checkedInAt: r.rows[0]!.checked_in_at.toISOString() } };
        });
        result = outcome.result;
        replayed = !!outcome.replayed;
        changed = outcome.changed ?? null;
        if (outcome.hide) ticketId = null;
      }
      await db.query(`INSERT INTO ticket_scans (event_id, scanner_id, ticket_id, method, result) VALUES ($1,$2,$3,$4,$5)`, [
        id,
        u.id,
        ticketId,
        method,
        result,
      ]);
      const counts = changed
        ? await publishDoor(db, ctx.realtime, id, { ticketId: ticketId!, holderId: changed.holderId, checkedInAt: changed.checkedInAt })
        : await doorCounts(db, id);
      const guest = ticketId ? (await db.query(`SELECT ${GUEST_COLS} FROM ${GUEST_FROM} WHERE t.id = $2`, [u.id, ticketId])).rows[0] : null;
      return { result: result!, guest: guest ? toGuest(guest, u.id) : null, counts, ...(replayed ? { replayed } : {}) };
    },
  );

  /** Undo a check-in (checked in the wrong person, or by mistake). */
  app.post('/v1/events/:id/check-in/:ticketId/undo', { preHandler: requireAuth, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
    const u = me(req);
    const { id, ticketId } = parse(ticketParam, req.params);
    await assertDoor(id, u.id);
    const r = await db.query<{ holder_id: string }>(
      `UPDATE event_tickets SET checked_in_at = NULL, checked_in_by = NULL, check_in_ref = NULL, updated_at = now()
       WHERE id = $1 AND event_id = $2 AND checked_in_at IS NOT NULL RETURNING holder_id`,
      [ticketId, id],
    );
    if (!r.rows[0]) throw notFound('Check-in');
    await db.query(`INSERT INTO ticket_scans (event_id, scanner_id, ticket_id, method, result) VALUES ($1,$2,$3,'undo','undone')`, [id, u.id, ticketId]);
    const counts = await publishDoor(db, ctx.realtime, id, { ticketId, holderId: r.rows[0].holder_id, checkedInAt: null });
    const guest = (await db.query(`SELECT ${GUEST_COLS} FROM ${GUEST_FROM} WHERE t.id = $2`, [u.id, ticketId])).rows[0];
    return { guest: toGuest(guest, u.id), counts };
  });

  // ── Co-hosts ───────────────────────────────────────────────────────────
  app.get('/v1/events/:id/cohosts', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    await assertDoor(id, u.id);
    const { rows } = await db.query<PublicUserRow>(
      `SELECT ${PUBLIC_USER_COLS} FROM event_cohosts ec JOIN profiles pr ON pr.user_id = ec.user_id WHERE ec.event_id = $1 ORDER BY ec.created_at`,
      [id],
    );
    return { items: rows.map(toPublicUser) };
  });

  /** The host adds a friend as a co-host: they can see the guest list and check people in. */
  app.post('/v1/events/:id/cohosts', { preHandler: requireAuth, config: { rateLimit: { max: 30, timeWindow: '1 hour' } } }, async (req, reply) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const { userId } = parse(addCohostSchema, req.body);
    if ((await assertDoor(id, u.id)) !== 'host') throw forbidden('Only the host can choose co-hosts.');
    if (userId === u.id) throw badRequest('You’re the host.');
    const who = (await db.query<{ status: string }>(`SELECT status FROM users WHERE id = $1`, [userId])).rows[0];
    if (!who || who.status !== 'active' || !(await areFriends(db, u.id, userId)))
      throw new AppError(403, 'friends_only', 'Co-hosts are chosen from your friends.');
    const count = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM event_cohosts WHERE event_id = $1`, [id])).rows[0]!.n;
    if (count >= COHOSTS_MAX) throw new AppError(409, 'too_many_cohosts', `An event can have up to ${COHOSTS_MAX} co-hosts.`);
    const added = await db.query(`INSERT INTO event_cohosts (event_id, user_id, added_by) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [id, userId, u.id]);
    if (added.rowCount) {
      await notify(db, ctx.realtime, { userId, category: 'events', type: 'event_cohost', actorId: u.id, entityType: 'event', entityId: id });
      await audit(db, { actorId: u.id, action: 'event.cohost_add', entityType: 'event', entityId: id, metadata: { userId } });
    }
    reply.code(added.rowCount ? 201 : 200);
    return { ok: true };
  });

  /** The host removes a co-host, or a co-host steps down. */
  app.delete('/v1/events/:id/cohosts/:userId', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id, userId } = parse(cohostParam, req.params);
    const role = await assertDoor(id, u.id);
    if (role !== 'host' && userId !== u.id) throw forbidden('Only the host can remove co-hosts.');
    const r = await db.query(`DELETE FROM event_cohosts WHERE event_id = $1 AND user_id = $2`, [id, userId]);
    if (!r.rowCount) throw notFound('Co-host');
    await audit(db, { actorId: u.id, action: 'event.cohost_remove', entityType: 'event', entityId: id, metadata: { userId } });
    return { ok: true };
  });
}
