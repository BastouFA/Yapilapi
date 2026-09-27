import type { Pool, PoolClient } from 'pg';
import type { Post, SavedFilter } from '@yapilapi/shared';

type Q = Pool | PoolClient;

/**
 * Posts aliased `p`: the Saved page and board filters. Photos are posts with a
 * photo, videos are reels and posts with a video, text is everything with
 * neither. Media blocked by moderation doesn't count.
 */
export function savedFilterSql(filter: SavedFilter): string {
  const has = (kind: string) =>
    `EXISTS (SELECT 1 FROM post_media fpm JOIN media fm ON fm.id = fpm.media_id WHERE fpm.post_id = p.id AND fm.kind = '${kind}' AND fm.moderation <> 'blocked')`;
  switch (filter) {
    case 'photos':
      return `(p.format = 'post' AND ${has('image')})`;
    case 'videos':
      return `(p.format = 'reel' OR ${has('video')})`;
    case 'text':
      return `(p.format = 'post' AND NOT ${has('image')} AND NOT ${has('video')})`;
    default:
      return 'true';
  }
}

/**
 * Add the viewer's own private notes to posts they saved, in place. Notes are
 * only ever read for the viewer, so nobody else's note can reach them.
 */
export async function attachSaveNotes(db: Q, posts: Post[], viewer: string | null): Promise<void> {
  if (!viewer || !posts.length) return;
  const { rows } = await db.query<{ post_id: string; note: string }>(
    `SELECT post_id, note FROM saves WHERE user_id = $1 AND post_id = ANY($2::uuid[]) AND note <> ''`,
    [viewer, posts.map((p) => p.id)],
  );
  const notes = new Map(rows.map((r) => [r.post_id, r.note]));
  for (const p of posts) {
    const note = notes.get(p.id);
    if (note) p.viewer.note = note;
  }
}
