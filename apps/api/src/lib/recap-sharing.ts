import type { Pool, PoolClient } from 'pg';
import { AppError } from './errors.ts';

type Q = Pool | PoolClient;

/**
 * Where a recap video may go once it's made. A recap is private to its maker,
 * and it can hold photos and videos other people shared with them (a friend's
 * post in a memory, a contributor's story in a chapter). So:
 *   - posting it (as a reel) or adding it to a story needs everything in it to
 *     be the maker's own;
 *   - sending it in a chat needs everything in it to be the maker's own or from
 *     a post that anyone can see right now.
 * Both are checked again each time, so a friend who makes a post private later
 * is respected. Downloading is always possible for the maker.
 */

export interface RecapSharing {
  canPost: boolean;
  canSend: boolean;
}

/** A post `p` anyone can see: public, from a public account, published and in good standing, outside communities. */
const PUBLIC_POST = `p.visibility = 'public' AND p.status = 'published' AND p.deleted_at IS NULL AND p.moderation_status = 'normal'
  AND p.community_id IS NULL AND NOT ap.is_private AND au.status = 'active'`;

/** What each recap may do, by recap id. */
export async function recapSharing(db: Q, recapIds: string[]): Promise<Map<string, RecapSharing>> {
  const out = new Map<string, RecapSharing>();
  if (!recapIds.length) return out;
  const { rows } = await db.query<{ id: string; own: boolean | null; public: boolean | null }>(
    `SELECT r.id,
            bool_and(coalesce(md.owner_id = r.owner_id, false)) AS own,
            bool_and(coalesce(md.owner_id = r.owner_id, false) OR (it->>'from' = 'post' AND EXISTS (
              SELECT 1 FROM posts p JOIN profiles ap ON ap.user_id = p.author_id JOIN users au ON au.id = p.author_id
              JOIN post_media pm ON pm.post_id = p.id AND pm.media_id = md.id
              WHERE p.id = (it->>'fromId')::uuid AND ${PUBLIC_POST}))) AS public
     FROM recaps r
     CROSS JOIN LATERAL jsonb_array_elements(r.items) it
     LEFT JOIN media md ON md.id = (it->>'mediaId')::uuid
     WHERE r.id = ANY($1::uuid[]) AND (r.used_media_ids IS NULL OR (it->>'mediaId')::uuid = ANY(r.used_media_ids))
     GROUP BY r.id`,
    [recapIds],
  );
  for (const r of rows) out.set(r.id, { canPost: !!r.own, canSend: !!r.own || !!r.public });
  return out;
}

/**
 * Check media about to be posted, added to a story or sent in a chat. When one of
 * them is a recap video, it must be allowed there (see above). Returns the recap's
 * sound, which a reel made from it must use, or null when no recap is involved.
 */
export async function assertRecapUse(
  db: Q,
  userId: string,
  mediaIds: (string | null | undefined)[],
  target: 'post' | 'story' | 'chat',
  opts: { echoId?: string } = {},
): Promise<{ recapId: string; soundId: string | null } | null> {
  const ids = mediaIds.filter((x): x is string => !!x);
  if (!ids.length) return null;
  // An echo video holds someone else's reel: it goes out only as that echo (posted with `echo`,
  // which checks the original is still there and may still be echoed, and shows the echo only to
  // people who can see the original), never as a plain post, a story, a chat attachment or an edit.
  const echoes = await db.query<{ id: string }>(
    `SELECT id FROM echoes WHERE result_media_id = ANY($1::uuid[]) AND owner_id = $2 AND original_author_id IS DISTINCT FROM $2`,
    [ids, userId],
  );
  if (echoes.rows.some((e) => e.id !== opts.echoId))
    throw new AppError(403, 'echo_not_reusable', "This video is an echo of someone else's reel, so it can only be posted as that echo.");
  // Only the person's own recaps: someone else's media is refused by the usual ownership checks.
  const { rows } = await db.query<{ id: string; sound_id: string | null; status: string }>(
    `SELECT id, sound_id, status FROM recaps WHERE media_id = ANY($1::uuid[]) AND owner_id = $2 ORDER BY created_at LIMIT 10`,
    [ids, userId],
  );
  if (!rows.length) return null;
  const sharing = await recapSharing(
    db,
    rows.map((r) => r.id),
  );
  for (const r of rows) {
    const s = sharing.get(r.id) ?? { canPost: false, canSend: false };
    if (target === 'chat' && !s.canSend)
      throw new AppError(
        403,
        'recap_not_sendable',
        "This recap has photos or videos from other people that aren't public, so it can't be sent in a chat. You can still watch it and save it.",
      );
    if (target !== 'chat' && !s.canPost)
      throw new AppError(
        403,
        'recap_not_postable',
        target === 'story'
          ? "This recap has photos or videos from other people, so it can't be added to a story."
          : "This recap has photos or videos from other people, so it can't be posted. You can still watch it and save it.",
      );
  }
  return { recapId: rows[0]!.id, soundId: rows[0]!.sound_id };
}
