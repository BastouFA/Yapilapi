import type { FastifyInstance } from 'fastify';
import { MUSIC_SOURCES, MUSIC_TABS } from '@yapilapi/shared';
import { z } from 'zod';
import { notFound, parse } from '../lib/errors.ts';
import type { AppContext } from '../lib/context.ts';
import { decodeCursor, encodeCursor } from '../lib/cursor.ts';
import { devToneWav } from '../lib/music/dev.ts';
import { hydratePosts } from '../lib/posts.ts';
import { soundUsableSql, soundVisibleSql } from '../lib/sounds.ts';
import { postVisibleSql } from '../lib/visibility.ts';
import { me, requireAuth } from '../plugins/auth.ts';

const idParam = z.object({ id: z.string().uuid() });

/**
 * Music for reels, posts and stories: one picker over the sounds library and every catalogue
 * provider that is switched on (lib/music), songs' pages, and saving songs for later.
 */
export default async function musicModule(app: FastifyInstance, ctx: AppContext) {
  const db = ctx.db;
  const music = ctx.music;

  /** Where music comes from here, and which sources are on. */
  app.get('/v1/music/sources', { preHandler: requireAuth }, async () => ({ items: music.sources() }));

  /**
   * The music picker: search every source that's on (`q`), or a tab: For you (what people you follow
   * use, then trending), Trending, Saved, Original sounds. Business accounts only get songs cleared
   * for commercial use; songs your country can't use are left out.
   */
  app.get('/v1/music', { preHandler: requireAuth, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req) => {
    const u = me(req);
    const q = parse(
      z.object({
        q: z.string().trim().max(80).default(''),
        tab: z.enum(MUSIC_TABS).default('for_you'),
        source: z.enum(MUSIC_SOURCES).optional(),
        limit: z.coerce.number().int().min(1).max(40).default(20),
      }),
      req.query,
    );
    return { items: await music.list(u.id, q), sources: music.sources() };
  });

  /** A catalogue song: what it is, its licence and credit, and whether you may use it. */
  app.get('/v1/music/tracks/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    const track = await music.track(id, req.user?.id ?? null);
    if (!track) throw notFound('That song');
    return { track };
  });

  /** Posts, reels and stories' worth of posts you can see that play a song, newest first. */
  app.get('/v1/music/tracks/:id/posts', async (req) => {
    const { id } = parse(idParam, req.params);
    const q = parse(z.object({ cursor: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(50).default(18) }), req.query);
    const viewer = req.user?.id ?? null;
    const exists = await db.query(`SELECT 1 FROM music_tracks WHERE id = $1`, [id]);
    if (!exists.rowCount) throw notFound('That song');
    const c = decodeCursor<{ t: string; id: string }>(q.cursor);
    const { rows } = await db.query(
      `SELECT p.id, p.created_at FROM posts p JOIN profiles ap ON ap.user_id = p.author_id JOIN users au ON au.id = p.author_id
       WHERE p.music_track_id = $2 AND ${postVisibleSql('$1')}
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

  /** Save a song for later (the picker's Saved tab), or take it off. */
  app.put('/v1/music/tracks/:id/save', { preHandler: requireAuth }, async (req) => {
    const { id } = parse(idParam, req.params);
    await music.save(me(req).id, { trackId: id }, true);
    return { saved: true };
  });
  app.delete('/v1/music/tracks/:id/save', { preHandler: requireAuth }, async (req) => {
    const { id } = parse(idParam, req.params);
    await music.save(me(req).id, { trackId: id }, false);
    return { saved: false };
  });

  /** Save a sound for later, or take it off. Only sounds you can see or use. */
  app.put('/v1/sounds/:id/save', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const r = await db.query(`SELECT 1 FROM sounds s WHERE s.id = $2 AND (${soundVisibleSql('$1')} OR ${soundUsableSql('$1')})`, [u.id, id]);
    if (!r.rowCount) throw notFound('That sound');
    await music.save(u.id, { soundId: id }, true);
    return { saved: true };
  });
  app.delete('/v1/sounds/:id/save', { preHandler: requireAuth }, async (req) => {
    const { id } = parse(idParam, req.params);
    await music.save(me(req).id, { soundId: id }, false);
    return { saved: false };
  });

  /** The dev provider's generated tones (development and tests only). */
  if (music.provider('dev')?.enabled)
    app.get('/v1/music/dev/tones/:file', async (req, reply) => {
      const { file } = parse(z.object({ file: z.string().regex(/^[a-z-]{1,40}\.wav$/) }), req.params);
      const wav = devToneWav(file.replace(/\.wav$/, ''));
      if (!wav) throw notFound('That tone');
      reply.header('content-type', 'audio/wav').header('cache-control', 'public, max-age=86400').header('accept-ranges', 'bytes');
      // Players seek to the part they play: answer byte ranges.
      const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
      if (range && (range[1] || range[2])) {
        const start = range[1] ? Number(range[1]) : Math.max(0, wav.length - Number(range[2]));
        const end = range[1] && range[2] ? Math.min(Number(range[2]), wav.length - 1) : wav.length - 1;
        if (start > end || start >= wav.length) return reply.code(416).header('content-range', `bytes */${wav.length}`).send();
        return reply
          .code(206)
          .header('content-range', `bytes ${start}-${end}/${wav.length}`)
          .send(wav.subarray(start, end + 1));
      }
      return reply.send(wav);
    });
}
