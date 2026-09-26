import type { Pool, PoolClient } from 'pg';
import { AppError, badRequest, forbidden, notFound } from './errors.ts';
import { postVisibleSql } from './visibility.ts';

type Q = Pool | PoolClient;

/**
 * Sounds: every reel's audio is registered as a sound that other reels can
 * use. The audio is the source reel's own video track, so nothing is copied
 * or mixed on the server; players play the sound from the source media.
 */

/** A reel `p` (with `ap` profile and `au` user) that the viewer may duet or remix, or whose sound they may use. */
export const remixableSql = (v: string) =>
  `(p.format = 'reel' AND p.visibility = 'public' AND NOT ap.is_private AND p.allow_remix AND p.moderation_status = 'normal' AND ${postVisibleSql(v)})`;

/** Sound `s` can be used by the viewer: its source reel is public, allows remixes and is visible to them. */
export const soundUsableSql = (v: string) =>
  `(s.media_id IS NOT NULL AND EXISTS (SELECT 1 FROM posts p JOIN profiles ap ON ap.user_id = p.author_id JOIN users au ON au.id = p.author_id
                                      WHERE p.id = s.source_post_id AND ${remixableSql(v)}))`;

/** Sound `s` is visible to the viewer when they can see at least one reel that uses it (its source reel included). */
export const soundVisibleSql = (v: string) =>
  `EXISTS (SELECT 1 FROM posts p JOIN profiles ap ON ap.user_id = p.author_id JOIN users au ON au.id = p.author_id
           WHERE p.sound_id = s.id AND p.format = 'reel' AND ${postVisibleSql(v)})`;

/** The default name for a reel's own sound. */
export const originalSoundTitle = (displayName: string) => `Original sound - ${displayName}`.slice(0, 100);

/** Register a reel's own audio as a new sound and link the reel to it. */
export async function registerOwnSound(db: Q, reel: { postId: string; ownerId: string; mediaId: string; title?: string | null }): Promise<string> {
  const title =
    reel.title?.trim() ||
    originalSoundTitle((await db.query(`SELECT display_name FROM profiles WHERE user_id = $1`, [reel.ownerId])).rows[0]?.display_name ?? 'YAPILAPI');
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO sounds (title, owner_id, source_post_id, media_id, duration_ms)
     SELECT $1, $2, $3, m.id, m.duration_ms FROM media m WHERE m.id = $4
     ON CONFLICT (source_post_id) WHERE source_post_id IS NOT NULL DO UPDATE SET title = sounds.title
     RETURNING id`,
    [title, reel.ownerId, reel.postId, reel.mediaId],
  );
  const id = rows[0]!.id;
  await db.query(`UPDATE posts SET sound_id = $2 WHERE id = $1`, [reel.postId, id]);
  return id;
}

/** A reel's sound, registering it first for reels made before sounds existed. */
export async function soundOfReel(db: Q, postId: string): Promise<string> {
  const { rows } = await db.query(
    `SELECT p.sound_id, p.author_id, (SELECT pm.media_id FROM post_media pm WHERE pm.post_id = p.id ORDER BY pm.position LIMIT 1) AS media_id
     FROM posts p WHERE p.id = $1`,
    [postId],
  );
  const r = rows[0];
  if (!r) throw notFound('That reel');
  if (r.sound_id) return r.sound_id;
  if (!r.media_id) throw badRequest("That reel's sound isn't available.");
  return registerOwnSound(db, { postId, ownerId: r.author_id, mediaId: r.media_id });
}

/**
 * Check that the viewer may duet or remix a reel. Returns the original's author
 * and sound. Hidden reels are "not found"; visible ones that can't be remixed say why.
 */
export async function assertRemixable(db: Q, postId: string, viewer: string): Promise<{ authorId: string; soundId: string }> {
  const { rows } = await db.query(
    `SELECT p.author_id, p.format, p.visibility, p.allow_remix, p.moderation_status, ap.is_private
     FROM posts p JOIN profiles ap ON ap.user_id = p.author_id JOIN users au ON au.id = p.author_id
     WHERE p.id = $2 AND ${postVisibleSql('$1')}`,
    [viewer, postId],
  );
  const o = rows[0];
  if (!o) throw notFound('That reel');
  if (o.format !== 'reel') throw badRequest('Only reels can be remixed.');
  if (o.visibility !== 'public' || o.is_private || o.moderation_status !== 'normal') throw badRequest('Only public reels can be remixed.');
  if (!o.allow_remix) throw forbidden('The creator of this reel turned off duets and remixes.');
  return { authorId: o.author_id, soundId: await soundOfReel(db, postId) };
}

/** Check that the viewer may use a sound in a new reel. */
export async function assertSoundUsable(db: Q, soundId: string, viewer: string): Promise<void> {
  const { rows } = await db.query(`SELECT ${soundUsableSql('$1')} AS usable, ${soundVisibleSql('$1')} AS visible FROM sounds s WHERE s.id = $2`, [
    viewer,
    soundId,
  ]);
  const r = rows[0];
  if (!r || (!r.visible && !r.usable)) throw notFound('That sound');
  if (!r.usable) throw new AppError(403, 'forbidden', "This sound can't be used in new reels.");
}
