import type { FastifyInstance, FastifyRequest } from 'fastify';
import { tx } from '@yapilapi/database';
import { z } from 'zod';
import { AppError, badRequest, featureDisabled, forbidden, notFound, parse } from '../lib/errors.ts';
import type { AppContext } from '../lib/context.ts';
import { hydratePosts } from '../lib/posts.ts';
import { isEnabled, notify, track } from '../lib/services.ts';
import { areFriends, isAdultViewer, publicUserFrom } from '../lib/users.ts';
import { MEDIA_BLOCKED_MESSAGE } from '../lib/media-moderation.ts';
import { requireVerified } from '../lib/verification.ts';
import { eventVisibleSql, postVisibleSql } from '../lib/visibility.ts';
import { me, requireAuth } from '../plugins/auth.ts';

const FRESH_MINUTES = 5;
const REALS_PER_DAY = 3;

/** Media must be captured in-app moments ago and never used before: that is what makes a Real real. */
async function freshMedia(c: { query: AppContext['db']['query'] }, userId: string, ids: string[]) {
  const { rows } = await c.query(
    `SELECT id, kind, url, moderation FROM media WHERE id = ANY($1) AND owner_id = $2 AND used_at IS NULL AND created_at > now() - make_interval(mins => $3)`,
    [ids, userId, FRESH_MINUTES],
  );
  if (rows.length !== new Set(ids).size)
    throw new AppError(422, 'not_fresh', `Capture your photo now: Real uses media taken in the last ${FRESH_MINUTES} minutes that hasn't been shared before.`);
  if (rows.some((r) => r.moderation === 'blocked')) throw new AppError(422, 'media_blocked', MEDIA_BLOCKED_MESSAGE);
  await c.query(`UPDATE media SET used_at = now() WHERE id = ANY($1)`, [ids]);
  return rows;
}

/**
 * Real: unedited, just-captured moments (optionally front + back camera), labelled
 * with when they were taken. Real Together: several people add their own
 * perspectives of the same moment to one shared, members-only object.
 */
export default async function realModule(app: FastifyInstance, ctx: AppContext) {
  const db = ctx.db;
  const gate = (flag: 'REAL' | 'REAL_TOGETHER') => async (req: FastifyRequest) => {
    await requireAuth(req, undefined as never);
    if (!(await isEnabled(db, flag))) throw featureDisabled(flag === 'REAL' ? 'Real' : 'Real Together');
  };

  // ── Real ──────────────────────────────────────────────────────────────
  app.post('/v1/real', { preHandler: gate('REAL'), config: { rateLimit: { max: 10, timeWindow: '1 hour' } } }, async (req, reply) => {
    const u = me(req);
    const input = parse(
      z.object({
        mediaIds: z.array(z.string().uuid()).min(1).max(2),
        caption: z.string().trim().max(300).default(''),
        visibility: z.enum(['public', 'followers', 'friends']).default('friends'),
        locationText: z.string().trim().max(120).optional(),
      }),
      req.body,
    );
    const today = await db.query(
      `SELECT count(*) AS n FROM posts WHERE author_id = $1 AND metadata ? 'real' AND created_at > now() - interval '24 hours' AND deleted_at IS NULL`,
      [u.id],
    );
    if (Number(today.rows[0].n) >= REALS_PER_DAY) throw new AppError(429, 'real_limit', `You can share ${REALS_PER_DAY} Reals a day.`);
    if (input.visibility === 'public') await requireVerified(db, ctx.config, u.id, 'post');
    const postId = await tx(db, async (c) => {
      const media = await freshMedia(c, u.id, input.mediaIds);
      if (media.some((m) => m.kind !== 'image')) throw badRequest('Real is for photos.');
      const { rows } = await c.query(
        `INSERT INTO posts (author_id, kind, body, visibility, topics, metadata, rights) VALUES ($1,$2,$3,$4,'{real}',$5,$6) RETURNING id`,
        [
          u.id,
          media.length > 1 ? 'carousel' : 'photo',
          input.caption,
          input.visibility,
          { real: { capturedAt: new Date().toISOString(), dual: media.length > 1, locationText: input.locationText ?? null } },
          { owner: u.id, license: 'all_rights_reserved' },
        ],
      );
      for (const [i, id] of input.mediaIds.entries())
        await c.query(`INSERT INTO post_media (post_id, media_id, position) VALUES ($1,$2,$3)`, [rows[0].id, id, i]);
      return rows[0].id as string;
    });
    track(db, u.id, 'real_created');
    reply.code(201);
    return { post: (await hydratePosts(db, [postId], u.id))[0] };
  });

  app.get('/v1/real', { preHandler: gate('REAL') }, async (req) => {
    const u = me(req);
    const { rows } = await db.query(
      `SELECT p.id FROM posts p JOIN profiles ap ON ap.user_id = p.author_id JOIN users au ON au.id = p.author_id
       WHERE p.metadata ? 'real' AND p.created_at > now() - interval '24 hours' AND ${postVisibleSql('$1')}
         AND (p.author_id = $1 OR EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = $1 AND f.followee_id = p.author_id)
              OR EXISTS (SELECT 1 FROM friendships fr WHERE (fr.user_a = $1 AND fr.user_b = p.author_id) OR (fr.user_b = $1 AND fr.user_a = p.author_id)))
       ORDER BY p.created_at DESC LIMIT 100`,
      [u.id],
    );
    return {
      items: await hydratePosts(
        db,
        rows.map((r) => r.id),
        u.id,
      ),
    };
  });

  // ── Real Together ─────────────────────────────────────────────────────
  async function loadTogether(id: string, userId: string) {
    const { rows } = await db.query(
      `SELECT t.*, (SELECT role FROM together_members m WHERE m.together_id = t.id AND m.user_id = $2) AS my_role FROM togethers t WHERE t.id = $1`,
      [id, userId],
    );
    if (!rows[0] || !rows[0].my_role) throw notFound('Together');
    const t = rows[0];
    if (t.status === 'open' && t.closes_at && t.closes_at < new Date()) {
      await db.query(`UPDATE togethers SET status = 'closed' WHERE id = $1`, [id]);
      t.status = 'closed';
    }
    return t;
  }

  /** You can invite friends, or people going to the same event. */
  async function canInvite(creatorId: string, userId: string, eventId: string | null) {
    if (await areFriends(db, creatorId, userId)) return true;
    if (!eventId) return false;
    const r = await db.query(`SELECT 1 FROM event_attendees WHERE event_id = $1 AND user_id = $2 AND status = 'going'`, [eventId, userId]);
    return !!r.rowCount;
  }

  app.post('/v1/together', { preHandler: gate('REAL_TOGETHER'), config: { rateLimit: { max: 20, timeWindow: '1 hour' } } }, async (req, reply) => {
    const u = me(req);
    const input = parse(
      z.object({
        title: z.string().trim().min(1).max(120),
        memberIds: z.array(z.string().uuid()).max(50).default([]),
        eventId: z.string().uuid().optional(),
        closesInHours: z
          .number()
          .int()
          .min(1)
          .max(24 * 14)
          .default(48),
      }),
      req.body,
    );
    if (input.eventId) {
      const ev = await db.query(`SELECT 1 FROM events e WHERE e.id = $2 AND ${eventVisibleSql('$1')}`, [u.id, input.eventId]);
      if (!ev.rowCount) throw notFound('Event');
    }
    const others = [...new Set(input.memberIds.filter((m) => m !== u.id))];
    for (const m of others)
      if (!(await canInvite(u.id, m, input.eventId ?? null))) throw forbidden('You can invite friends, or people going to the same event.');
    const id = await tx(db, async (c) => {
      const { rows } = await c.query(
        `INSERT INTO togethers (creator_id, event_id, title, closes_at) VALUES ($1,$2,$3, now() + make_interval(hours => $4)) RETURNING id`,
        [u.id, input.eventId ?? null, input.title, input.closesInHours],
      );
      await c.query(`INSERT INTO together_members (together_id, user_id, role) VALUES ($1,$2,'creator')`, [rows[0].id, u.id]);
      if (others.length) await c.query(`INSERT INTO together_members (together_id, user_id) SELECT $1, unnest($2::uuid[])`, [rows[0].id, others]);
      return rows[0].id as string;
    });
    for (const m of others)
      await notify(db, ctx.realtime, {
        userId: m,
        category: 'friends',
        type: 'together_invite',
        actorId: u.id,
        entityType: 'together',
        entityId: id,
        data: { title: input.title },
      });
    reply.code(201);
    return { together: await detail(id, u.id) };
  });

  async function detail(id: string, userId: string) {
    const t = await loadTogether(id, userId);
    const members = await db.query(
      `SELECT m.role, pr.user_id AS u_id, pr.username AS u_username, pr.display_name AS u_display_name, pr.avatar_url AS u_avatar_url, pr.mode AS u_mode
       FROM together_members m JOIN profiles pr ON pr.user_id = m.user_id WHERE m.together_id = $1 ORDER BY m.joined_at`,
      [id],
    );
    const contributions = await db.query(
      `SELECT c.id, c.caption, c.captured_at, md.url, md.kind, md.alt_text, md.moderation,
              pr.user_id AS u_id, pr.username AS u_username, pr.display_name AS u_display_name, pr.avatar_url AS u_avatar_url, pr.mode AS u_mode
       FROM together_contributions c JOIN profiles pr ON pr.user_id = c.user_id LEFT JOIN media md ON md.id = c.media_id
       WHERE c.together_id = $1 AND c.deleted_at IS NULL AND md.moderation IS DISTINCT FROM 'blocked'
         AND (md.moderation IS DISTINCT FROM 'sensitive' OR $2) ORDER BY c.captured_at, c.created_at`,
      [id, await isAdultViewer(db, userId)],
    );
    return {
      id: t.id,
      title: t.title,
      status: t.status,
      eventId: t.event_id,
      closesAt: t.closes_at,
      myRole: t.my_role,
      members: members.rows.map((m) => ({ user: publicUserFrom(m, 'u_'), role: m.role })),
      contributions: contributions.rows.map((c) => ({
        id: c.id,
        caption: c.caption,
        capturedAt: c.captured_at,
        media: c.url ? { url: c.url, kind: c.kind, altText: c.alt_text, ...(c.moderation === 'sensitive' ? { sensitive: true } : {}) } : null,
        author: publicUserFrom(c, 'u_'),
      })),
    };
  }

  app.get('/v1/together', { preHandler: gate('REAL_TOGETHER') }, async (req) => {
    const { rows } = await db.query(
      `SELECT t.id, t.title, t.status, t.closes_at, (SELECT count(*) FROM together_contributions c WHERE c.together_id = t.id AND c.deleted_at IS NULL) AS contributions,
              (SELECT count(*) FROM together_members m2 WHERE m2.together_id = t.id) AS members
       FROM togethers t JOIN together_members m ON m.together_id = t.id AND m.user_id = $1 ORDER BY t.created_at DESC LIMIT 100`,
      [me(req).id],
    );
    return {
      items: rows.map((r) => ({
        id: r.id,
        title: r.title,
        status: r.status,
        closesAt: r.closes_at,
        contributions: Number(r.contributions),
        members: Number(r.members),
      })),
    };
  });

  app.get('/v1/together/:id', { preHandler: gate('REAL_TOGETHER') }, async (req) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    return { together: await detail(id, me(req).id) };
  });

  app.post(
    '/v1/together/:id/contributions',
    { preHandler: gate('REAL_TOGETHER'), config: { rateLimit: { max: 60, timeWindow: '1 hour' } } },
    async (req, reply) => {
      const u = me(req);
      const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
      const input = parse(z.object({ mediaId: z.string().uuid(), caption: z.string().trim().max(300).default('') }), req.body);
      const t = await loadTogether(id, u.id);
      if (t.status !== 'open') throw badRequest('This Together is closed.');
      await tx(db, async (c) => {
        const r = await c.query(`UPDATE media SET used_at = now() WHERE id = $1 AND owner_id = $2 AND used_at IS NULL RETURNING id`, [input.mediaId, u.id]);
        if (!r.rowCount) throw notFound('Media');
        await c.query(`INSERT INTO together_contributions (together_id, user_id, media_id, caption) VALUES ($1,$2,$3,$4)`, [
          id,
          u.id,
          input.mediaId,
          input.caption,
        ]);
      });
      const members = (
        await db.query<{ user_id: string }>(`SELECT user_id FROM together_members WHERE together_id = $1 AND user_id <> $2`, [id, u.id])
      ).rows.map((r) => r.user_id);
      await ctx.realtime.publish(members, { type: 'together.contribution', data: { togetherId: id, userId: u.id } });
      reply.code(201);
      return { together: await detail(id, u.id) };
    },
  );

  app.delete('/v1/together/:id/contributions/:cid', { preHandler: gate('REAL_TOGETHER') }, async (req) => {
    const u = me(req);
    const { id, cid } = parse(z.object({ id: z.string().uuid(), cid: z.string().uuid() }), req.params);
    const t = await loadTogether(id, u.id);
    const r = await db.query(
      `UPDATE together_contributions SET deleted_at = now() WHERE id = $1 AND together_id = $2 AND (user_id = $3 OR $4) AND deleted_at IS NULL`,
      [cid, id, u.id, t.my_role === 'creator'],
    );
    if (!r.rowCount) throw notFound('Contribution');
    return { ok: true };
  });

  app.post('/v1/together/:id/members', { preHandler: gate('REAL_TOGETHER') }, async (req) => {
    const u = me(req);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const { userIds } = parse(z.object({ userIds: z.array(z.string().uuid()).min(1).max(50) }), req.body);
    const t = await loadTogether(id, u.id);
    if (t.my_role !== 'creator') throw forbidden('Only the creator can invite people.');
    for (const m of userIds) if (!(await canInvite(u.id, m, t.event_id))) throw forbidden('You can invite friends, or people going to the same event.');
    await db.query(`INSERT INTO together_members (together_id, user_id) SELECT $1, unnest($2::uuid[]) ON CONFLICT DO NOTHING`, [id, userIds]);
    return { together: await detail(id, u.id) };
  });

  app.post('/v1/together/:id/leave', { preHandler: gate('REAL_TOGETHER') }, async (req) => {
    const u = me(req);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const t = await loadTogether(id, u.id);
    if (t.my_role === 'creator') throw badRequest('Close it instead: you created it.');
    await db.query(`DELETE FROM together_members WHERE together_id = $1 AND user_id = $2`, [id, u.id]);
    return { ok: true };
  });

  app.post('/v1/together/:id/close', { preHandler: gate('REAL_TOGETHER') }, async (req) => {
    const u = me(req);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const t = await loadTogether(id, u.id);
    if (t.my_role !== 'creator') throw forbidden();
    await db.query(`UPDATE togethers SET status = 'closed' WHERE id = $1`, [id]);
    return { together: await detail(id, u.id) };
  });
}
