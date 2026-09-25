import type { FastifyInstance, FastifyRequest } from 'fastify';
import { tx } from '@yapilapi/database';
import { z } from 'zod';
import { badRequest, featureDisabled, forbidden, notFound, parse } from '../lib/errors.ts';
import type { AppContext } from '../lib/context.ts';
import { hydratePosts } from '../lib/posts.ts';
import { isEnabled } from '../lib/services.ts';
import { areFriends } from '../lib/users.ts';
import { eventVisibleSql, postVisibleSql } from '../lib/visibility.ts';
import { me, requireAuth } from '../plugins/auth.ts';
import { EVENT_SELECT, toEvent } from './events.ts';

const idParam = z.object({ id: z.string().uuid() });
const memorySchema = z.object({
  title: z.string().trim().min(1).max(120),
  kind: z.enum(['event', 'place', 'trip', 'people', 'date', 'community', 'custom']).default('custom'),
  description: z.string().trim().max(2000).default(''),
  startsAt: z.string().datetime({ offset: true }).optional(),
  endsAt: z.string().datetime({ offset: true }).optional(),
});

/**
 * Memory: private-by-default collections of posts, moments, events and places.
 * Only the owner adds items, and only items the owner can already see. Sharing
 * is explicit and limited to friends. AI recaps read only what the owner can see.
 */
export default async function memoryModule(app: FastifyInstance, ctx: AppContext) {
  const db = ctx.db;
  const gate = async (req: FastifyRequest) => {
    await requireAuth(req, undefined as never);
    if (!(await isEnabled(db, 'MEMORY'))) throw featureDisabled('Memory');
  };

  async function load(id: string, viewer: string, ownerOnly = false) {
    const { rows } = await db.query(
      `SELECT m.*, (m.owner_id = $2) AS mine FROM memories m
       WHERE m.id = $1 AND (m.owner_id = $2 OR (NOT $3 AND m.visibility = 'selected' AND EXISTS (SELECT 1 FROM memory_shares s WHERE s.memory_id = m.id AND s.user_id = $2)))`,
      [id, viewer, ownerOnly],
    );
    if (!rows[0]) throw notFound('Memory');
    return rows[0];
  }

  function dto(r: Record<string, any>, itemCount?: number) {
    return {
      id: r.id,
      title: r.title,
      kind: r.kind,
      description: r.description,
      recap: r.recap,
      startsAt: r.starts_at,
      endsAt: r.ends_at,
      visibility: r.visibility,
      mine: r.mine ?? true,
      itemCount: itemCount ?? Number(r.item_count ?? 0),
      createdAt: r.created_at,
    };
  }

  app.get('/v1/memories', { preHandler: gate }, async (req) => {
    const { rows } = await db.query(
      `SELECT m.*, (m.owner_id = $1) AS mine, (SELECT count(*) FROM memory_items i WHERE i.memory_id = m.id) AS item_count
       FROM memories m WHERE m.owner_id = $1 OR EXISTS (SELECT 1 FROM memory_shares s WHERE s.memory_id = m.id AND s.user_id = $1 AND m.visibility = 'selected')
       ORDER BY coalesce(m.starts_at, m.created_at) DESC LIMIT 200`,
      [me(req).id],
    );
    return { items: rows.map((r) => dto(r)) };
  });

  app.post('/v1/memories', { preHandler: gate }, async (req, reply) => {
    const input = parse(memorySchema, req.body);
    const { rows } = await db.query(`INSERT INTO memories (owner_id, title, kind, description, starts_at, ends_at) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [
      me(req).id,
      input.title,
      input.kind,
      input.description,
      input.startsAt ?? null,
      input.endsAt ?? null,
    ]);
    reply.code(201);
    return { memory: dto(rows[0], 0) };
  });

  app.patch('/v1/memories/:id', { preHandler: gate }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const input = parse(memorySchema.partial(), req.body);
    await load(id, u.id, true);
    const { rows } = await db.query(
      `UPDATE memories SET title = coalesce($2, title), kind = coalesce($3, kind), description = coalesce($4, description),
         starts_at = coalesce($5, starts_at), ends_at = coalesce($6, ends_at), updated_at = now() WHERE id = $1 RETURNING *`,
      [id, input.title ?? null, input.kind ?? null, input.description ?? null, input.startsAt ?? null, input.endsAt ?? null],
    );
    return { memory: dto(rows[0]) };
  });

  app.delete('/v1/memories/:id', { preHandler: gate }, async (req) => {
    const { id } = parse(idParam, req.params);
    await load(id, me(req).id, true);
    await db.query(`DELETE FROM memories WHERE id = $1`, [id]);
    return { ok: true };
  });

  app.get('/v1/memories/:id', { preHandler: gate }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const m = await load(id, u.id);
    const items = await db.query(`SELECT item_type, item_id, note, added_at FROM memory_items WHERE memory_id = $1 ORDER BY added_at`, [id]);
    // Items are re-checked against the viewer: a shared memory never reveals posts the viewer can't see.
    const postIds = items.rows.filter((i) => i.item_type === 'post').map((i) => i.item_id);
    const visiblePosts = postIds.length
      ? (
          await db.query(
            `SELECT p.id FROM posts p JOIN profiles ap ON ap.user_id = p.author_id JOIN users au ON au.id = p.author_id WHERE p.id = ANY($2) AND ${postVisibleSql('$1')}`,
            [u.id, postIds],
          )
        ).rows.map((r) => r.id)
      : [];
    const eventIds = items.rows.filter((i) => i.item_type === 'event').map((i) => i.item_id);
    const events = eventIds.length
      ? (await db.query(`${EVENT_SELECT} WHERE e.id = ANY($2) AND ${eventVisibleSql('$1')}`, [u.id, eventIds])).rows.map(toEvent)
      : [];
    const momentIds = items.rows.filter((i) => i.item_type === 'moment').map((i) => i.item_id);
    const moments = momentIds.length
      ? (
          await db.query(`SELECT id, body, media_url, media_kind, created_at FROM moments WHERE id = ANY($1) AND author_id = $2 AND deleted_at IS NULL`, [
            momentIds,
            m.owner_id,
          ])
        ).rows
      : [];
    return {
      memory: dto(m, items.rowCount ?? 0),
      posts: await hydratePosts(
        db,
        postIds.filter((p) => visiblePosts.includes(p)),
        u.id,
      ),
      events,
      moments: m.mine ? moments : moments.filter(() => m.visibility === 'selected'),
      hiddenItems: postIds.length - visiblePosts.length,
    };
  });

  app.post('/v1/memories/:id/items', { preHandler: gate }, async (req, reply) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const input = parse(z.object({ itemType: z.enum(['post', 'moment', 'event']), itemId: z.string().uuid(), note: z.string().max(500).optional() }), req.body);
    await load(id, u.id, true);
    const check: Record<string, [string, unknown[]]> = {
      post: [
        `SELECT 1 FROM posts p JOIN profiles ap ON ap.user_id = p.author_id JOIN users au ON au.id = p.author_id WHERE p.id = $2 AND ${postVisibleSql('$1')}`,
        [u.id, input.itemId],
      ],
      event: [`SELECT 1 FROM events e WHERE e.id = $2 AND ${eventVisibleSql('$1')}`, [u.id, input.itemId]],
      moment: [`SELECT 1 FROM moments WHERE id = $2 AND author_id = $1 AND deleted_at IS NULL`, [u.id, input.itemId]],
    };
    const [sql, params] = check[input.itemType]!;
    if (!(await db.query(sql, params)).rowCount) throw notFound('That item');
    await db.query(`INSERT INTO memory_items (memory_id, item_type, item_id, note) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [
      id,
      input.itemType,
      input.itemId,
      input.note ?? null,
    ]);
    reply.code(201);
    return { ok: true };
  });

  app.delete('/v1/memories/:id/items/:type/:itemId', { preHandler: gate }, async (req) => {
    const { id, type, itemId } = parse(z.object({ id: z.string().uuid(), type: z.enum(['post', 'moment', 'event']), itemId: z.string().uuid() }), req.params);
    await load(id, me(req).id, true);
    await db.query(`DELETE FROM memory_items WHERE memory_id = $1 AND item_type = $2 AND item_id = $3`, [id, type, itemId]);
    return { ok: true };
  });

  /** Share with specific friends, or make private again with an empty list. */
  app.put('/v1/memories/:id/shares', { preHandler: gate }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const { userIds } = parse(z.object({ userIds: z.array(z.string().uuid()).max(100) }), req.body);
    await load(id, u.id, true);
    for (const other of userIds) if (!(await areFriends(db, u.id, other))) throw forbidden('You can only share memories with friends.');
    await tx(db, async (c) => {
      await c.query(`DELETE FROM memory_shares WHERE memory_id = $1`, [id]);
      if (userIds.length) await c.query(`INSERT INTO memory_shares (memory_id, user_id) SELECT $1, unnest($2::uuid[])`, [id, userIds]);
      await c.query(`UPDATE memories SET visibility = $2 WHERE id = $1`, [id, userIds.length ? 'selected' : 'private']);
    });
    return { visibility: userIds.length ? 'selected' : 'private', sharedWith: userIds.length };
  });

  /** Suggestions: past events you went to, and your posts from this day in earlier years. */
  app.get('/v1/memories/suggestions', { preHandler: gate }, async (req) => {
    const u = me(req);
    const events = await db.query(
      `${EVENT_SELECT} WHERE EXISTS (SELECT 1 FROM event_attendees ea WHERE ea.event_id = e.id AND ea.user_id = $1 AND ea.status = 'going')
         AND coalesce(e.ends_at, e.starts_at + interval '3 hours') < now() AND e.deleted_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM memories m WHERE m.owner_id = $1 AND m.source_type = 'event' AND m.source_id = e.id)
       ORDER BY e.starts_at DESC LIMIT 10`,
      [u.id],
    );
    const onThisDay = await db.query(
      `SELECT id FROM posts WHERE author_id = $1 AND deleted_at IS NULL AND extract(month FROM created_at) = extract(month FROM now())
         AND extract(day FROM created_at) = extract(day FROM now()) AND created_at < date_trunc('year', now()) ORDER BY created_at DESC LIMIT 10`,
      [u.id],
    );
    return {
      events: events.rows.map(toEvent),
      onThisDay: await hydratePosts(
        db,
        onThisDay.rows.map((r) => r.id),
        u.id,
      ),
    };
  });

  /** Turn an event you attended into a memory with your posts and the visible posts about it. */
  app.post('/v1/memories/from-event/:id', { preHandler: gate }, async (req, reply) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const ev = (await db.query(`${EVENT_SELECT} WHERE e.id = $2 AND ${eventVisibleSql('$1')}`, [u.id, id])).rows[0];
    if (!ev) throw notFound('Event');
    const memoryId = await tx(db, async (c) => {
      const { rows } = await c.query(
        `INSERT INTO memories (owner_id, title, kind, starts_at, ends_at, source_type, source_id) VALUES ($1,$2,'event',$3,$4,'event',$5)
         ON CONFLICT (owner_id, source_type, source_id) WHERE source_id IS NOT NULL DO UPDATE SET updated_at = now() RETURNING id`,
        [u.id, ev.title, ev.starts_at, ev.ends_at, id],
      );
      const mid = rows[0].id as string;
      await c.query(`INSERT INTO memory_items (memory_id, item_type, item_id) VALUES ($1,'event',$2) ON CONFLICT DO NOTHING`, [mid, id]);
      await c.query(
        `INSERT INTO memory_items (memory_id, item_type, item_id)
         SELECT $2, 'post', p.id FROM posts p JOIN profiles ap ON ap.user_id = p.author_id JOIN users au ON au.id = p.author_id
         WHERE p.event_id = $3 AND ${postVisibleSql('$1')} ON CONFLICT DO NOTHING`,
        [u.id, mid, id],
      );
      return mid;
    });
    reply.code(201);
    return { memoryId };
  });

  /** AI recap from the posts in the memory the owner can see. Stored, editable, never shared automatically. */
  app.post('/v1/memories/:id/recap', { preHandler: gate, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const m = await load(id, u.id, true);
    const r = await ctx.ai.run({ userId: u.id, task: 'memory_recap', input: m.title, memoryId: id });
    if (typeof r.output !== 'string' || !r.output) throw badRequest(r.notice ?? 'Add some posts to this memory first.');
    await db.query(`UPDATE memories SET recap = $2, updated_at = now() WHERE id = $1`, [id, r.output]);
    return { recap: r.output, notice: r.notice };
  });
}
