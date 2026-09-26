import type { FastifyInstance } from 'fastify';
import type { Sound } from '@yapilapi/shared';
import { z } from 'zod';
import { notFound, parse } from '../lib/errors.ts';
import type { AppContext } from '../lib/context.ts';
import { decodeCursor, encodeCursor } from '../lib/cursor.ts';
import { hydratePosts } from '../lib/posts.ts';
import { soundUsableSql, soundVisibleSql } from '../lib/sounds.ts';
import { plusCol, publicUserFrom } from '../lib/users.ts';
import { postVisibleSql } from '../lib/visibility.ts';
import { me, requireAuth } from '../plugins/auth.ts';

const idParam = z.object({ id: z.string().uuid() });
const REELS_FROM = `FROM posts p JOIN profiles ap ON ap.user_id = p.author_id JOIN users au ON au.id = p.author_id`;
/** How far "top" reels for a sound page. */
const TOP_LIMIT = 500;

/**
 * Sounds: a reel's audio, reusable by other reels. Each sound has a page with
 * the reels that use it (most recent or top) and a "Use this sound" action.
 */
export default async function soundsModule(app: FastifyInstance, ctx: AppContext) {
  const db = ctx.db;

  /** Sound DTOs for ids the viewer may see (`s` visible), preserving order. */
  async function soundsByIds(ids: string[], viewer: string | null): Promise<Sound[]> {
    if (!ids.length) return [];
    const { rows } = await db.query(
      `SELECT s.id, s.title, s.created_at, coalesce(s.duration_ms, m.duration_ms) AS duration_ms, coalesce(m.variants->>'mp4', m.url) AS audio_url, m.poster_url,
              pr.user_id AS o_id, pr.username AS o_username, pr.display_name AS o_display_name, pr.avatar_url AS o_avatar_url, pr.mode AS o_mode, ${plusCol('o_')},
              (SELECT p.id ${REELS_FROM} WHERE p.id = s.source_post_id AND ${postVisibleSql('$2')}) AS source_post_id,
              (SELECT count(*) ${REELS_FROM} WHERE p.sound_id = s.id AND p.format = 'reel' AND ${postVisibleSql('$2')})::int AS reels,
              ${soundUsableSql('$2')} AS can_use
       FROM sounds s JOIN profiles pr ON pr.user_id = s.owner_id LEFT JOIN media m ON m.id = s.media_id
       WHERE s.id = ANY($1) AND ${soundVisibleSql('$2')}`,
      [ids, viewer],
    );
    const byId = new Map(
      rows.map((r) => [
        r.id as string,
        {
          id: r.id,
          title: r.title,
          owner: publicUserFrom(r, 'o_'),
          sourcePostId: r.source_post_id ?? null,
          durationMs: r.duration_ms ?? null,
          audioUrl: r.audio_url ?? null,
          coverUrl: r.poster_url ?? null,
          reels: r.reels,
          canUse: !!r.can_use,
          createdAt: r.created_at.toISOString(),
        } satisfies Sound,
      ]),
    );
    return ids.map((id) => byId.get(id)).filter((x): x is Sound => !!x);
  }

  /**
   * Sounds to pick from when making a reel: ones you can use, most used in the
   * last 30 days first. `q` matches the title or the owner's name.
   */
  app.get('/v1/sounds', { preHandler: requireAuth, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req) => {
    const u = me(req);
    const q = parse(z.object({ q: z.string().trim().max(60).default(''), limit: z.coerce.number().int().min(1).max(30).default(12) }), req.query);
    const term = q.q.replace(/[\\%_]/g, (c) => `\\${c}`);
    const { rows } = await db.query(
      `SELECT s.id,
              (SELECT count(*) FROM posts p WHERE p.sound_id = s.id AND p.deleted_at IS NULL AND p.created_at > now() - interval '30 days') AS recent_uses
       FROM sounds s JOIN profiles pr ON pr.user_id = s.owner_id
       WHERE ($2 = '' OR s.title ILIKE '%' || $2 || '%' OR pr.display_name ILIKE $2 || '%' OR pr.username ILIKE $2 || '%')
         AND ${soundUsableSql('$1')}
       ORDER BY recent_uses DESC, s.created_at DESC, s.id
       LIMIT $3`,
      [u.id, term, q.limit],
    );
    return {
      items: await soundsByIds(
        rows.map((r) => r.id),
        u.id,
      ),
    };
  });

  app.get('/v1/sounds/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    const [sound] = await soundsByIds([id], req.user?.id ?? null);
    if (!sound) throw notFound('That sound');
    return { sound };
  });

  /** Rename your own sound. */
  app.patch('/v1/sounds/:id', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const { title } = parse(z.object({ title: z.string().trim().min(1).max(100) }), req.body);
    const r = await db.query(`UPDATE sounds SET title = $3 WHERE id = $1 AND owner_id = $2`, [id, u.id, title]);
    if (!r.rowCount) throw notFound('That sound');
    const [sound] = await soundsByIds([id], u.id);
    return { sound };
  });

  /** Reels you can see that use a sound: most recent, or top (by likes, comments and reposts). */
  app.get('/v1/sounds/:id/reels', async (req) => {
    const { id } = parse(idParam, req.params);
    const q = parse(
      z.object({
        sort: z.enum(['recent', 'top']).default('recent'),
        cursor: z.string().max(200).optional(),
        limit: z.coerce.number().int().min(1).max(50).default(18),
      }),
      req.query,
    );
    const viewer = req.user?.id ?? null;
    const visible = await db.query(`SELECT 1 FROM sounds s WHERE s.id = $2 AND ${soundVisibleSql('$1')}`, [viewer, id]);
    if (!visible.rowCount) throw notFound('That sound');
    const where = `p.sound_id = $2 AND p.format = 'reel' AND ${postVisibleSql('$1')}`;
    if (q.sort === 'top') {
      const c = decodeCursor<{ o: number }>(q.cursor);
      const offset = Math.max(0, Math.min(c?.o ?? 0, TOP_LIMIT));
      const { rows } = await db.query(
        `SELECT p.id ${REELS_FROM} WHERE ${where}
         ORDER BY p.like_count + 2 * p.comment_count + 3 * p.repost_count DESC, p.view_count DESC, p.created_at DESC, p.id LIMIT $3 OFFSET $4`,
        [viewer, id, q.limit + 1, offset],
      );
      const page = rows.slice(0, q.limit);
      return {
        items: await hydratePosts(
          db,
          page.map((r) => r.id),
          viewer,
        ),
        nextCursor: rows.length > q.limit && offset + q.limit < TOP_LIMIT ? encodeCursor({ o: offset + q.limit }) : null,
      };
    }
    const c = decodeCursor<{ t: string; id: string }>(q.cursor);
    const { rows } = await db.query(
      `SELECT p.id, p.created_at ${REELS_FROM} WHERE ${where}
       ${c ? 'AND (p.created_at, p.id) < ($4::timestamptz, $5::uuid)' : ''}
       ORDER BY p.created_at DESC, p.id DESC LIMIT $3`,
      c ? [viewer, id, q.limit + 1, c.t, c.id] : [viewer, id, q.limit + 1],
    );
    const page = rows.slice(0, q.limit);
    const last = page.at(-1);
    return {
      items: await hydratePosts(
        db,
        page.map((r) => r.id),
        viewer,
      ),
      nextCursor: rows.length > q.limit && last ? encodeCursor({ t: new Date(last.created_at).toISOString(), id: last.id }) : null,
    };
  });
}
