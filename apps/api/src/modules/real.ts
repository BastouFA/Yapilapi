import type { FastifyInstance, FastifyRequest } from 'fastify';
import { tx } from '@yapilapi/database';
import { z } from 'zod';
import { AppError, badRequest, featureDisabled, parse } from '../lib/errors.ts';
import type { AppContext } from '../lib/context.ts';
import { hydratePosts } from '../lib/posts.ts';
import { isEnabled, track } from '../lib/services.ts';
import { MEDIA_BLOCKED_MESSAGE } from '../lib/media-moderation.ts';
import { requireVerified } from '../lib/verification.ts';
import { postVisibleSql } from '../lib/visibility.ts';
import { me, requireAuth } from '../plugins/auth.ts';
import { langOf } from '../lib/translation.ts';

const FRESH_MINUTES = 5;
const REALS_PER_DAY = 3;

/** Media must be captured in-app moments ago and never used before: that is what makes a Real real. */
async function freshMedia(c: { query: AppContext['db']['query'] }, userId: string, ids: string[]) {
  const { rows } = await c.query(
    `SELECT id, kind, url, moderation FROM media WHERE id = ANY($1) AND owner_id = $2 AND NOT private AND used_at IS NULL AND created_at > now() - make_interval(mins => $3)`,
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
 * with when they were taken. Only Real keeps the camera-only rule; Together albums
 * (modules/together.ts) take photos and videos from the library too.
 */
export default async function realModule(app: FastifyInstance, ctx: AppContext) {
  const db = ctx.db;
  const gate = (flag: 'REAL') => async (req: FastifyRequest) => {
    await requireAuth(req, undefined as never);
    if (!(await isEnabled(db, flag))) throw featureDisabled('Real');
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
      `SELECT count(*) AS n FROM posts WHERE author_id = $1 AND metadata ? 'real' AND created_at > now() - interval '24 hours' AND deleted_at IS NULL AND status = 'published'`,
      [u.id],
    );
    if (Number(today.rows[0].n) >= REALS_PER_DAY) throw new AppError(429, 'real_limit', `You can share ${REALS_PER_DAY} Reals a day.`);
    if (input.visibility === 'public') await requireVerified(db, ctx.config, u.id, 'post');
    const postId = await tx(db, async (c) => {
      const media = await freshMedia(c, u.id, input.mediaIds);
      if (media.some((m) => m.kind !== 'image')) throw badRequest('Real is for photos.');
      const { rows } = await c.query(
        `INSERT INTO posts (author_id, kind, body, visibility, topics, metadata, rights, lang) VALUES ($1,$2,$3,$4,'{real}',$5,$6,$7) RETURNING id`,
        [
          u.id,
          media.length > 1 ? 'carousel' : 'photo',
          input.caption,
          input.visibility,
          { real: { capturedAt: new Date().toISOString(), dual: media.length > 1, locationText: input.locationText ?? null } },
          { owner: u.id, license: 'all_rights_reserved' },
          langOf(input.caption),
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
}
