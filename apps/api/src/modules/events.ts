import type { FastifyInstance } from 'fastify';
import { tx } from '@yapilapi/database';
import { COMMUNITY_ROLE_RANK, createEventSchema, rsvpSchema, updateEventSchema, type EventItem } from '@yapilapi/shared';
import { z } from 'zod';
import { AppError, forbidden, notFound, parse } from '../lib/errors.ts';
import type { AppContext } from '../lib/context.ts';
import { notify, track } from '../lib/services.ts';
import { emitWebhook } from '../lib/webhooks.ts';
import { PUBLIC_USER_COLS, publicUserFrom, toPublicUser, type PublicUserRow } from '../lib/users.ts';
import { eventVisibleSql } from '../lib/visibility.ts';
import { cancelEventTickets, cancelRsvpTicket, issueRsvpTicket, publishDoor } from '../lib/tickets.ts';
import { me, requireAuth } from '../plugins/auth.ts';

const idParam = z.object({ id: z.string().uuid() });

export const EVENT_SELECT = `
  SELECT e.id, e.title, e.description, e.starts_at, e.ends_at, e.timezone, e.location_text, e.capacity, e.visibility, e.online, e.ticket_transfers,
         pr.user_id AS h_id, pr.username AS h_username, pr.display_name AS h_display_name, pr.avatar_url AS h_avatar_url, pr.mode AS h_mode,
         pl.id AS pl_id, pl.name AS pl_name, c.id AS c_id, c.slug AS c_slug, c.name AS c_name,
         (SELECT count(*) FROM event_attendees WHERE event_id = e.id AND status = 'going') AS going,
         (SELECT count(*) FROM event_attendees WHERE event_id = e.id AND status = 'interested') AS interested,
         (SELECT status FROM event_attendees WHERE event_id = e.id AND user_id = $1) AS my_rsvp,
         coalesce(e.host_id = $1 OR EXISTS (SELECT 1 FROM event_cohosts ec WHERE ec.event_id = e.id AND ec.user_id = $1), false) AS can_check_in
  FROM events e JOIN profiles pr ON pr.user_id = e.host_id
  LEFT JOIN places pl ON pl.id = e.place_id LEFT JOIN communities c ON c.id = e.community_id`;

export function toEvent(r: Record<string, any>): EventItem {
  return {
    id: r.id,
    title: r.title,
    description: r.description,
    host: publicUserFrom(r, 'h_'),
    startsAt: r.starts_at.toISOString(),
    endsAt: r.ends_at?.toISOString() ?? null,
    timezone: r.timezone,
    locationText: r.location_text,
    place: r.pl_id ? { id: r.pl_id, name: r.pl_name } : null,
    community: r.c_id ? { id: r.c_id, slug: r.c_slug, name: r.c_name } : null,
    capacity: r.capacity,
    visibility: r.visibility,
    online: r.online,
    counts: { going: r.going, interested: r.interested },
    myRsvp: r.my_rsvp === 'waitlist' ? 'interested' : r.my_rsvp,
    ticketTransfers: r.ticket_transfers,
    canCheckIn: !!r.can_check_in,
  };
}

export default async function eventsModule(app: FastifyInstance, ctx: AppContext) {
  const db = ctx.db;

  async function load(id: string, viewer: string | null) {
    const { rows } = await db.query(`${EVENT_SELECT} WHERE e.id = $2 AND ${eventVisibleSql('$1')}`, [viewer, id]);
    if (!rows[0]) throw notFound('Event');
    return rows[0];
  }

  app.post('/v1/events', { preHandler: requireAuth, config: { rateLimit: { max: 20, timeWindow: '1 hour' } } }, async (req, reply) => {
    const u = me(req);
    const input = parse(createEventSchema, req.body);
    if (input.communityId) {
      const r = await db.query(`SELECT role FROM community_members WHERE community_id = $1 AND user_id = $2 AND status = 'active'`, [input.communityId, u.id]);
      const role = r.rows[0]?.role;
      if (!role || COMMUNITY_ROLE_RANK[role as keyof typeof COMMUNITY_ROLE_RANK] < COMMUNITY_ROLE_RANK.organizer)
        throw forbidden('Only organizers, moderators and admins can create community events.');
    }
    if (input.placeId) {
      const p = await db.query(`SELECT 1 FROM places WHERE id = $1 AND deleted_at IS NULL`, [input.placeId]);
      if (!p.rowCount) throw notFound('Place');
    }
    const id = await tx(db, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO events (host_id, community_id, place_id, title, description, starts_at, ends_at, timezone, location_text, online, capacity, visibility, ticket_transfers)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
        [
          u.id,
          input.communityId ?? null,
          input.placeId ?? null,
          input.title,
          input.description,
          input.startsAt,
          input.endsAt ?? null,
          input.timezone,
          input.locationText ?? null,
          input.online,
          input.capacity ?? null,
          input.visibility,
          input.ticketTransfers,
        ],
      );
      await c.query(`INSERT INTO event_attendees (event_id, user_id, status) VALUES ($1,$2,'going')`, [rows[0]!.id, u.id]);
      return rows[0]!.id;
    });
    track(db, u.id, 'event_created');
    reply.code(201);
    return { event: toEvent(await load(id, u.id)) };
  });

  app.get('/v1/events', async (req) => {
    const viewer = req.user?.id ?? null;
    const q = parse(
      z.object({
        scope: z.enum(['upcoming', 'going', 'hosting', 'now']).default('upcoming'),
        communityId: z.string().uuid().optional(),
        from: z.string().datetime({ offset: true }).optional(),
        to: z.string().datetime({ offset: true }).optional(),
        limit: z.coerce.number().min(1).max(50).default(20),
      }),
      req.query,
    );
    const where = [`${eventVisibleSql('$1')}`];
    const params: unknown[] = [viewer];
    const add = (sql: string, v: unknown) => {
      params.push(v);
      where.push(sql.replace('?', `$${params.length}`));
    };
    if (q.scope === 'now') where.push(`e.starts_at <= now() + interval '3 hours' AND coalesce(e.ends_at, e.starts_at + interval '3 hours') >= now()`);
    else where.push(`coalesce(e.ends_at, e.starts_at + interval '3 hours') >= now()`);
    if (q.scope === 'going')
      where.push(`EXISTS (SELECT 1 FROM event_attendees ea WHERE ea.event_id = e.id AND ea.user_id = $1 AND ea.status IN ('going','interested'))`);
    if (q.scope === 'hosting') where.push(`e.host_id = $1`);
    if (q.communityId) add('e.community_id = ?', q.communityId);
    if (q.from) add('e.starts_at >= ?', q.from);
    if (q.to) add('e.starts_at < ?', q.to);
    params.push(q.limit);
    const { rows } = await db.query(`${EVENT_SELECT} WHERE ${where.join(' AND ')} ORDER BY e.starts_at LIMIT $${params.length}`, params);
    return { items: rows.map(toEvent) };
  });

  app.get('/v1/events/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    return { event: toEvent(await load(id, req.user?.id ?? null)) };
  });

  app.post('/v1/events/:id/rsvp', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const { status } = parse(rsvpSchema, req.body);
    const ev = await load(id, u.id);
    const stored = await tx(db, async (c) => {
      await c.query(`SELECT id FROM events WHERE id = $1 FOR UPDATE`, [id]);
      let s: string = status;
      if (status === 'going' && ev.capacity) {
        const going = await c.query(`SELECT count(*) AS n FROM event_attendees WHERE event_id = $1 AND status = 'going' AND user_id <> $2`, [id, u.id]);
        if (going.rows[0].n >= ev.capacity) s = 'waitlist';
      }
      await c.query(
        `INSERT INTO event_attendees (event_id, user_id, status) VALUES ($1,$2,$3) ON CONFLICT (event_id, user_id) DO UPDATE SET status = EXCLUDED.status, updated_at = now()`,
        [id, u.id, s],
      );
      // Going comes with a ticket in the wallet; anything else takes it back.
      if (s === 'going') await issueRsvpTicket(c, id, u.id);
      else await cancelRsvpTicket(c, id, u.id);
      return s;
    });
    await publishDoor(db, ctx.realtime, id);
    if (stored === 'going') {
      await notify(db, ctx.realtime, { userId: ev.h_id, category: 'events', type: 'event_rsvp', actorId: u.id, entityType: 'event', entityId: id });
      track(db, u.id, 'event_rsvp_going');
      await emitWebhook(db, ev.h_id, 'event.rsvp', { eventId: id, status: stored });
    }
    return { status: stored, event: toEvent(await load(id, u.id)) };
  });

  app.get('/v1/events/:id/attendees', async (req) => {
    const viewer = req.user?.id ?? null;
    const { id } = parse(idParam, req.params);
    await load(id, viewer);
    const { rows } = await db.query(
      `SELECT ea.status, ${PUBLIC_USER_COLS} FROM event_attendees ea JOIN profiles pr ON pr.user_id = ea.user_id
       WHERE ea.event_id = $1 AND ea.status IN ('going','interested') AND NOT pr.is_private ORDER BY ea.updated_at LIMIT 200`,
      [id],
    );
    return { items: rows.map((r) => ({ user: toPublicUser(r as PublicUserRow), status: r.status })) };
  });

  /**
   * The host changes an event: only the fields sent change, and null clears an optional one.
   * People who answered going or interested are told when the time or the place changes.
   */
  app.patch('/v1/events/:id', { preHandler: requireAuth, config: { rateLimit: { max: 60, timeWindow: '1 hour' } } }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const input = parse(updateEventSchema, req.body);
    const cur = (await db.query(`SELECT host_id, starts_at, ends_at, place_id, location_text, online FROM events WHERE id = $1 AND deleted_at IS NULL`, [id]))
      .rows[0];
    if (!cur || cur.host_id !== u.id) throw notFound('Event');
    if (input.placeId) {
      const p = await db.query(`SELECT 1 FROM places WHERE id = $1 AND deleted_at IS NULL`, [input.placeId]);
      if (!p.rowCount) throw notFound('Place');
    }
    const startsAt = input.startsAt ? new Date(input.startsAt) : (cur.starts_at as Date);
    const endsAt = input.endsAt === undefined ? (cur.ends_at as Date | null) : input.endsAt === null ? null : new Date(input.endsAt);
    if (endsAt && endsAt <= startsAt)
      throw new AppError(400, 'validation_failed', 'The end must be after the start.', { fields: { endsAt: 'The end must be after the start.' } });
    const sets: string[] = [];
    const params: unknown[] = [id];
    const set = (col: string, v: unknown) => {
      params.push(v);
      sets.push(`${col} = $${params.length}`);
    };
    if (input.title !== undefined) set('title', input.title);
    if (input.description !== undefined) set('description', input.description);
    if (input.startsAt !== undefined) set('starts_at', input.startsAt);
    if (input.endsAt !== undefined) set('ends_at', input.endsAt);
    if (input.timezone !== undefined) set('timezone', input.timezone);
    if (input.locationText !== undefined) set('location_text', input.locationText || null);
    if (input.placeId !== undefined) set('place_id', input.placeId);
    if (input.capacity !== undefined) set('capacity', input.capacity);
    if (input.visibility !== undefined) set('visibility', input.visibility);
    if (input.online !== undefined) set('online', input.online);
    if (input.ticketTransfers !== undefined) set('ticket_transfers', input.ticketTransfers);
    if (sets.length) await db.query(`UPDATE events SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, params);
    const moved =
      (input.startsAt !== undefined && new Date(input.startsAt).getTime() !== (cur.starts_at as Date).getTime()) ||
      (input.placeId !== undefined && input.placeId !== cur.place_id) ||
      (input.locationText !== undefined && (input.locationText || null) !== cur.location_text) ||
      (input.online !== undefined && input.online !== cur.online);
    if (moved) {
      const attendees = await db.query<{ user_id: string }>(
        `SELECT user_id FROM event_attendees WHERE event_id = $1 AND user_id <> $2 AND status IN ('going','interested','waitlist')`,
        [id, u.id],
      );
      for (const a of attendees.rows)
        await notify(db, ctx.realtime, { userId: a.user_id, category: 'events', type: 'event_updated', actorId: u.id, entityType: 'event', entityId: id });
    }
    return { event: toEvent(await load(id, u.id)) };
  });

  app.delete('/v1/events/:id', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const r = await db.query(`UPDATE events SET deleted_at = now() WHERE id = $1 AND host_id = $2 AND deleted_at IS NULL RETURNING id`, [id, u.id]);
    if (!r.rowCount) throw notFound('Event');
    // Every ticket for it stops working (the wallet shows it as cancelled).
    await cancelEventTickets(db, id);
    const attendees = await db.query<{ user_id: string }>(
      `SELECT user_id FROM event_attendees WHERE event_id = $1 AND status IN ('going','interested','waitlist')`,
      [id],
    );
    for (const a of attendees.rows)
      await notify(db, ctx.realtime, { userId: a.user_id, category: 'events', type: 'event_cancelled', actorId: u.id, entityType: 'event', entityId: id });
    return { ok: true };
  });
}
