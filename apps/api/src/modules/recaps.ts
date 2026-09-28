import type { FastifyInstance } from 'fastify';
import { createRecapSchema, RECAP_SOURCES, type Recap, type RecapCandidates, type RecapSource } from '@yapilapi/shared';
import { z } from 'zod';
import { AppError, featureDisabled, notFound, parse } from '../lib/errors.ts';
import type { AppContext } from '../lib/context.ts';
import { recapSharing } from '../lib/recap-sharing.ts';
import { preselect, recapCandidates, recapsLeftToday, removeRecapMedia, startRecap } from '../lib/recaps.ts';
import { isEnabled, track } from '../lib/services.ts';
import { me, requireAuth } from '../plugins/auth.ts';

const idParam = z.object({ id: z.string().uuid() });

const RECAP_SELECT = `
  SELECT r.*, s.title AS sound_title, m.url AS m_url, m.variants AS m_variants, m.poster_url AS m_poster_url, m.hls_url AS m_hls_url,
         m.width AS m_width, m.height AS m_height
  FROM recaps r LEFT JOIN sounds s ON s.id = r.sound_id LEFT JOIN media m ON m.id = r.media_id AND m.deleted_at IS NULL`;

/** A safe file name for saving a recap: its title in plain letters and numbers. */
function fileName(title: string, id: string): string {
  const slug = title
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .toLowerCase()
    .slice(0, 40);
  return `${slug || 'recap'}-${id.slice(0, 8)}.mp4`;
}

/**
 * Recap videos from Memories and Chapters (see lib/recaps.ts for how they're
 * made). Only the maker ever sees a recap. It's posted as a reel through the
 * normal POST /v1/posts, and sent through the normal chat messages; both check
 * there that everything in it may go where it's going (lib/recap-sharing.ts).
 */
export default async function recapsModule(app: FastifyInstance, ctx: AppContext) {
  const db = ctx.db;
  // Recaps come from Memories and Chapters (the Memory feature) and from Together albums (Real Together).
  const recapsOn = async () => {
    if (!(await isEnabled(db, 'MEMORY')) && !(await isEnabled(db, 'REAL_TOGETHER'))) throw featureDisabled('Memory');
  };
  /** Each source needs its own feature on. */
  const sourceOn = async (source: RecapSource) => {
    if (source === 'together' ? !(await isEnabled(db, 'REAL_TOGETHER')) : !(await isEnabled(db, 'MEMORY')))
      throw featureDisabled(source === 'together' ? 'Real Together' : 'Memory');
  };
  // Signed in, and Memory or Together is on.
  const gate = [requireAuth, recapsOn];

  async function dtos(rows: Record<string, any>[]): Promise<Recap[]> {
    const sharing = await recapSharing(
      db,
      rows.filter((r) => r.status === 'ready').map((r) => r.id),
    );
    return rows.map((r) => {
      const ready = r.status === 'ready' && r.media_id && r.m_url;
      const s = sharing.get(r.id);
      return {
        id: r.id,
        title: r.title,
        source: r.source_type,
        sourceId: r.source_id,
        style: r.style,
        aspect: r.aspect,
        sound: r.sound_id ? { id: r.sound_id, title: r.sound_title ?? '' } : null,
        lengthSeconds: r.length_seconds,
        status: r.status,
        error: r.error,
        itemCount: Array.isArray(r.items) ? r.items.length : 0,
        usedCount: r.used_media_ids ? r.used_media_ids.length : null,
        durationMs: r.duration_ms,
        video: ready
          ? {
              mediaId: r.media_id,
              url: r.m_variants?.mp4 ?? r.m_url,
              posterUrl: r.m_poster_url ?? null,
              hlsUrl: r.m_hls_url ?? null,
              width: r.m_width ?? null,
              height: r.m_height ?? null,
            }
          : null,
        fileName: fileName(r.title, r.id),
        canPost: !!ready && !!s?.canPost,
        canSend: !!ready && !!s?.canSend,
        createdAt: new Date(r.created_at).toISOString(),
        finishedAt: r.finished_at ? new Date(r.finished_at).toISOString() : null,
      } satisfies Recap;
    });
  }

  async function own(id: string, userId: string) {
    const r = (await db.query(`${RECAP_SELECT} WHERE r.id = $1 AND r.owner_id = $2 AND r.deleted_at IS NULL`, [id, userId])).rows[0];
    if (!r) throw notFound('That recap');
    return r;
  }

  /** Your recaps, newest first. */
  app.get('/v1/recaps', { preHandler: gate }, async (req) => {
    const q = parse(z.object({ source: z.enum(RECAP_SOURCES).optional(), sourceId: z.string().uuid().optional() }), req.query);
    const { rows } = await db.query(
      `${RECAP_SELECT} WHERE r.owner_id = $1 AND r.deleted_at IS NULL AND ($2::text IS NULL OR r.source_type = $2) AND ($3::uuid IS NULL OR r.source_id = $3)
       ORDER BY r.created_at DESC LIMIT 100`,
      [me(req).id, q.source ?? null, q.sourceId ?? null],
    );
    return { items: await dtos(rows), remainingToday: await recapsLeftToday(db, me(req).id) };
  });

  /** What can go in a recap from a source, with the suggested pick. */
  app.get('/v1/recaps/candidates', { preHandler: gate }, async (req): Promise<RecapCandidates> => {
    const u = me(req);
    const q = parse(z.object({ source: z.enum(RECAP_SOURCES), sourceId: z.string().uuid().optional() }), req.query);
    if (q.source !== 'on_this_day' && !q.sourceId) throw new AppError(400, 'validation_failed', 'Choose a memory or chapter.');
    await sourceOn(q.source);
    const { title, items } = await recapCandidates(db, u.id, q);
    const pub = items.map(({ storageKey: _k, hasWebMp4: _w, sizeBytes: _s, ...c }) => c);
    return { title, items: pub, preselected: preselect(pub), remainingToday: await recapsLeftToday(db, u.id) };
  });

  /**
   * Make a recap. Each photo or video must be one you can see in the source now;
   * the sound follows the same rules as for reels. Renders in the background.
   */
  app.post('/v1/recaps', { preHandler: gate, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const u = me(req);
    const input = parse(createRecapSchema, req.body);
    await sourceOn(input.source);
    const recap = await startRecap(db, u.id, input);
    track(db, u.id, 'recap_created', { source: input.source, style: input.style, aspect: input.aspect, items: input.mediaIds.length, sound: !!input.soundId });
    reply.code(202);
    const [dto] = await dtos([await own(recap, u.id)]);
    return { recap: dto };
  });

  app.get('/v1/recaps/:id', { preHandler: gate }, async (req) => {
    const { id } = parse(idParam, req.params);
    const [dto] = await dtos([await own(id, me(req).id)]);
    return { recap: dto };
  });

  /**
   * Delete a recap and its video file. The file stays only where you already
   * shared it (a reel, a story or a chat message), since those use it.
   */
  app.delete('/v1/recaps/:id', { preHandler: gate }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const r = await own(id, u.id);
    await db.query(`UPDATE recaps SET deleted_at = now() WHERE id = $1`, [id]);
    const fileRemoved = r.media_id ? await removeRecapMedia(ctx, r.media_id) : true;
    return { ok: true, fileRemoved };
  });
}
