import type { Queryable } from '@yapilapi/database';
import { momentVisibleSql, postVisibleSql } from '../../lib/visibility.js';
import { loadAccess } from '../messaging/access.js';
import { realVisibleSql } from '../real/access.js';
import { contributionVisibleSql } from '../together/access.js';

/** Statuses whose bytes may be served. pending (no file yet), failed and blocked never are. */
export const SERVABLE = ['uploaded', 'processing', 'ready'] as const;

/**
 * THE media authorization predicate (SQL part). `viewer` is a SQL expr for the viewer id or NULL; `m` aliases `media`.
 * Media is served to:
 *  - its owner (unless blocked by moderation / deleted / not yet uploaded),
 *  - anyone, when it was uploaded with purpose 'public' (avatars, covers),
 *  - anyone who can see a post or a moment it is attached to (postVisibleSql / momentVisibleSql: blocks, privacy, expiry),
 * Real captures and shared-experience contributions carry their own audience rules (real/access.ts, together/access.ts).
 * Message attachments need conversation membership; that part lives in `canViewMessageMedia` because the conversation
 * rules (blocks, group history cutoff, community channels) are owned by the messaging module.
 */
export function mediaAccessSql(viewer: string, m = 'm'): string {
  const V = `(${viewer})`;
  return `(
    ${m}.deleted_at IS NULL AND ${m}.status IN ('uploaded','processing','ready')
    AND (
      (${V} IS NOT NULL AND ${m}.owner_id = ${V})
      OR ${m}.purpose = 'public'
      OR EXISTS (SELECT 1 FROM post_media pmx JOIN posts px ON px.id = pmx.post_id WHERE pmx.media_id = ${m}.id AND ${postVisibleSql(viewer, 'px')})
      OR EXISTS (SELECT 1 FROM moments mox WHERE mox.media_id = ${m}.id AND ${momentVisibleSql(viewer, 'mox')})
      OR EXISTS (SELECT 1 FROM real_captures rcx WHERE (rcx.front_media_id = ${m}.id OR rcx.rear_media_id = ${m}.id) AND ${realVisibleSql(viewer, 'rcx')})
      OR EXISTS (SELECT 1 FROM shared_experience_contributions scx JOIN shared_experiences sex ON sex.id = scx.experience_id
                  LEFT JOIN real_captures scr ON scr.id = scx.real_capture_id AND scr.deleted_at IS NULL
                 WHERE (scx.media_id = ${m}.id OR scr.front_media_id = ${m}.id OR scr.rear_media_id = ${m}.id) AND ${contributionVisibleSql(viewer, 'scx', 'sex')})
    )
  )`;
}

/** Attached to a message in a conversation the viewer can read right now (and, for groups, sent after they joined). */
export async function canViewMessageMedia(
  db: Queryable,
  viewerId: string | null,
  mediaId: string,
): Promise<boolean> {
  if (!viewerId) return false;
  const { rows } = await db.query<{ conversation_id: string; created_at: string }>(
    `SELECT ms.conversation_id, ms.created_at::text AS created_at
       FROM message_attachments ma JOIN messages ms ON ms.id = ma.message_id
      WHERE ma.media_id = $1 AND ms.deleted_at IS NULL AND ms.moderation_status = 'approved'`,
    [mediaId],
  );
  for (const r of rows) {
    const access = await loadAccess(db, r.conversation_id, viewerId);
    if (!access) continue;
    if (access.joinedAtRaw) {
      const ok = await db.query<{ ok: boolean }>(
        'SELECT $1::timestamptz >= $2::timestamptz AS ok',
        [r.created_at, access.joinedAtRaw],
      );
      if (!ok.rows[0]!.ok) continue;
    }
    return true;
  }
  return false;
}

/** Full check: SQL rules first (cheap, covers most media), then message attachments. */
export async function canViewMedia(
  db: Queryable,
  viewerId: string | null,
  mediaId: string,
): Promise<boolean> {
  const { rows } = await db.query<{ ok: boolean; live: boolean }>(
    `SELECT ${mediaAccessSql('$1::uuid')} AS ok,
            (m.deleted_at IS NULL AND m.status IN ('uploaded','processing','ready')) AS live
       FROM media m WHERE m.id = $2`,
    [viewerId, mediaId],
  );
  const r = rows[0];
  if (!r || !r.live) return false;
  if (r.ok) return true;
  return canViewMessageMedia(db, viewerId, mediaId);
}
