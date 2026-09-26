import type { FastifyInstance } from 'fastify';
import { tx } from '@yapilapi/database';
import { COMMUNITY_ROLE_RANK, createEventSchema, rsvpSchema, type EventItem } from '@yapilapi/shared';
import { z } from 'zod';
import { forbidden, notFound, parse } from '../lib/errors.ts';
import type { AppContext } from '../lib/context.ts';
import { notify, track } from '../lib/services.ts';
import { emitWebhook } from '../lib/webhooks.ts';
import { PUBLIC_USER_COLS, publicUserFrom, toPublicUser, type PublicUserRow } from '../lib/users.ts';
import { eventVisibleSql } from '../lib/visibility.ts';
import { me, requireAuth } from '../plugins/auth.ts';

const idParam = z.object({ id: z.string().uuid() });

export const EVENT_SELECT = `
  SELECT e.id, e.title, e.description, e.starts_at, e.ends_at, e.timezone, e.location_text, e.capacity, e.visibility, e.online,
         pr.user_id AS h_id, pr.username AS h_username, pr.display_name AS h_display_name, pr.avatar_url AS h_avatar_url, pr.mode AS h_mode,
         pl.id AS pl_id, pl.name AS pl_name, c.id AS c_id, c.slug AS c_slug, c.name AS c_name,
         (SELECT count(*) FROM event_attendees WHERE event_id = e.id AND status = 'going') AS going,
         (SELECT count(*) FROM event_attendees WHERE event_id = e.id AND status = 'interested') AS interested,
         (SELECT status FROM event_attendees WHERE event_id = e.id AND user_id = $1) AS my_rsvp
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
        `INSERT INTO events (host_id, community_id, place_id, title, description, starts_at, ends_at, timezone, location_text, online, capacity, visibility)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
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
      return s;
    });
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

  app.delete('/v1/events/:id', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const r = await db.query(`UPDATE events SET deleted_at = now() WHERE id = $1 AND host_id = $2 AND deleted_at IS NULL RETURNING id`, [id, u.id]);
    if (!r.rowCount) throw notFound('Event');
    const attendees = await db.query<{ user_id: string }>(
      `SELECT user_id FROM event_attendees WHERE event_id = $1 AND status IN ('going','interested','waitlist')`,
      [id],
    );
    for (const a of attendees.rows)
      await notify(db, ctx.realtime, { userId: a.user_id, category: 'events', type: 'event_cancelled', actorId: u.id, entityType: 'event', entityId: id });
    return { ok: true };
  });
}
