import type { Pool, PoolClient } from 'pg';
import { MUSIC_CLIP_MAX_MS, musicCredit, type MusicLicence, type MusicTrack } from '@yapilapi/shared';
import { soundUsableSql, soundVisibleSql } from '../sounds.ts';

type Q = Pool | PoolClient;

/**
 * The `library` source: original audio people made here (every reel's own sound). Always on.
 * Its rights come from the creator, who lets others reuse a reel's sound (remixes on) or not, so
 * the rules are the sounds library's own (lib/sounds.ts); there is no outside licence to check.
 */
export const ORIGINAL_SOUND_LICENCE: MusicLicence = {
  name: 'Original sound',
  url: null,
  commercialUse: true,
  regions: null,
  excludedRegions: [],
  maxClipSeconds: MUSIC_CLIP_MAX_MS / 1000,
  attribution: null,
  expiresAt: null,
  cacheAllowed: true,
};

/** Sounds as picker tracks, for ids the viewer may see, in order. */
export async function libraryByIds(db: Q, ids: string[], viewer: string | null): Promise<MusicTrack[]> {
  if (!ids.length) return [];
  const { rows } = await db.query(
    `SELECT s.id, s.title, coalesce(s.duration_ms, m.duration_ms) AS duration_ms, coalesce(m.variants->>'mp4', m.url) AS audio_url, m.poster_url,
            pr.display_name,
            (SELECT count(*) FROM posts p WHERE p.sound_id = s.id AND p.deleted_at IS NULL AND p.status = 'published')::int
              + (SELECT count(*) FROM moments mo WHERE mo.sound_id = s.id AND mo.deleted_at IS NULL AND mo.music IS NOT NULL)::int AS uses,
            EXISTS (SELECT 1 FROM music_saves ms WHERE ms.sound_id = s.id AND ms.user_id = $2) AS saved,
            ${soundUsableSql('$2')} AS can_use
     FROM sounds s JOIN profiles pr ON pr.user_id = s.owner_id LEFT JOIN media m ON m.id = s.media_id
     WHERE s.id = ANY($1::uuid[]) AND (${soundVisibleSql('$2')} OR ${soundUsableSql('$2')})`,
    [ids, viewer],
  );
  const byId = new Map<string, MusicTrack>(
    rows.map((r) => [
      r.id as string,
      {
        source: 'library',
        id: r.id,
        title: r.title,
        artist: r.display_name,
        album: null,
        durationMs: r.duration_ms ?? null,
        coverUrl: r.poster_url ?? null,
        previewUrl: r.audio_url ?? null,
        licence: ORIGINAL_SOUND_LICENCE,
        attribution: musicCredit({ title: r.title, artist: r.display_name, licenceName: ORIGINAL_SOUND_LICENCE.name }),
        maxClipMs: MUSIC_CLIP_MAX_MS,
        uses: r.uses,
        saved: !!r.saved,
        canUse: !!r.can_use,
        ...(r.can_use ? {} : { blocked: 'unavailable' as const }),
      } satisfies MusicTrack,
    ]),
  );
  return ids.map((id) => byId.get(id)).filter((x): x is MusicTrack => !!x);
}

/** Sounds the viewer can use, most used in the last 30 days first; `q` matches the title or who made it. */
export async function librarySearch(db: Q, viewer: string, q: string, limit: number): Promise<string[]> {
  const term = q.replace(/[\\%_]/g, (c) => `\\${c}`);
  const { rows } = await db.query<{ id: string }>(
    `SELECT s.id,
            (SELECT count(*) FROM posts p WHERE p.sound_id = s.id AND p.deleted_at IS NULL AND p.status = 'published' AND p.created_at > now() - interval '30 days')
            + (SELECT count(*) FROM moments m WHERE m.sound_id = s.id AND m.deleted_at IS NULL AND m.created_at > now() - interval '30 days') AS recent_uses
     FROM sounds s JOIN profiles pr ON pr.user_id = s.owner_id
     WHERE ($2 = '' OR s.title ILIKE '%' || $2 || '%' OR pr.display_name ILIKE $2 || '%' OR pr.username ILIKE $2 || '%')
       AND ${soundUsableSql('$1')}
     ORDER BY recent_uses DESC, s.created_at DESC, s.id
     LIMIT $3`,
    [viewer, term, limit],
  );
  return rows.map((r) => r.id);
}

/** Sounds people you follow used lately in posts, reels and stories (that you can use too). */
export async function libraryFromFollows(db: Q, viewer: string, limit: number): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT u.sound_id AS id FROM (
       SELECT p.sound_id FROM posts p JOIN follows f ON f.followee_id = p.author_id AND f.follower_id = $1
       WHERE p.sound_id IS NOT NULL AND p.deleted_at IS NULL AND p.status = 'published' AND p.created_at > now() - interval '30 days'
       UNION ALL
       SELECT m.sound_id FROM moments m JOIN follows f ON f.followee_id = m.author_id AND f.follower_id = $1
       WHERE m.sound_id IS NOT NULL AND m.deleted_at IS NULL AND m.created_at > now() - interval '30 days'
     ) u JOIN sounds s ON s.id = u.sound_id
     WHERE ${soundUsableSql('$1')}
     GROUP BY u.sound_id ORDER BY count(*) DESC, u.sound_id LIMIT $2`,
    [viewer, limit],
  );
  return rows.map((r) => r.id);
}
