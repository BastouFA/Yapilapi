import { eventVisibleSql } from '../events/access.js';
import { mediaAccessSql } from '../media/access.js';
import { momentVisibleSql, postVisibleSql } from '../../lib/visibility.js';
import { realVisibleSql, ownRealSql } from '../real/access.js';
import { experienceVisibleSql } from '../together/access.js';

/**
 * MEMORY PRIVACY: who sees a memory, and, separately, which of its items each viewer sees.
 *
 * The memory's own `privacy` (private|friends|public) decides who may open the memory at all. It NEVER grants access to an item: every item is
 * re-checked against the viewer with the item's OWN visibility rule (postVisibleSql, momentVisibleSql, realVisibleSql, eventVisibleSql,
 * experienceVisibleSql, mediaAccessSql), so sharing a memory cannot widen the audience of anything in it. Items the viewer may not see are
 * omitted (never reported by count to anyone but the owner).
 */
export function memoryVisibleSql(viewer: string, m = 'mem'): string {
  const V = `(${viewer})`;
  return `(
    ${m}.deleted_at IS NULL
    AND EXISTS (SELECT 1 FROM users ua WHERE ua.id = ${m}.owner_id AND ua.deleted_at IS NULL AND ua.status IN ('active','pending_deletion'))
    AND (${V} IS NULL OR NOT EXISTS (SELECT 1 FROM user_blocks bl WHERE (bl.blocker_id = ${V} AND bl.blocked_id = ${m}.owner_id) OR (bl.blocker_id = ${m}.owner_id AND bl.blocked_id = ${V})))
    AND (
      (${V} IS NOT NULL AND ${m}.owner_id = ${V})
      OR CASE ${m}.privacy
        WHEN 'public' THEN (
          NOT EXISTS (SELECT 1 FROM profiles pp WHERE pp.user_id = ${m}.owner_id AND pp.is_private)
          OR (${V} IS NOT NULL AND EXISTS (SELECT 1 FROM follows fw WHERE fw.follower_id = ${V} AND fw.followee_id = ${m}.owner_id AND fw.status = 'active')))
        WHEN 'friends' THEN (${V} IS NOT NULL AND EXISTS (SELECT 1 FROM friendships fr WHERE fr.user_low = LEAST(${V}, ${m}.owner_id) AND fr.user_high = GREATEST(${V}, ${m}.owner_id) AND fr.status = 'accepted'))
        ELSE false
      END
    )
  )`;
}

/**
 * May `viewer` see the item behind a memory_items row? `mi` aliases memory_items, `mem` the memory. Messages are the exception to "the item's own
 * rule": a message is the private communication of a conversation, so it is only ever shown to the memory's owner, who sent it.
 */
export function memoryItemVisibleSql(viewer: string, mi = 'mi', mem = 'mem'): string {
  const V = `(${viewer})`;
  return `(CASE ${mi}.item_type
    WHEN 'post' THEN EXISTS (SELECT 1 FROM posts p WHERE p.id = ${mi}.item_id AND ${postVisibleSql(viewer, 'p')})
    WHEN 'moment' THEN EXISTS (SELECT 1 FROM moments mo WHERE mo.id = ${mi}.item_id AND ${momentVisibleSql(viewer, 'mo')})
    WHEN 'media' THEN EXISTS (SELECT 1 FROM media md WHERE md.id = ${mi}.item_id AND ${mediaAccessSql(viewer, 'md')})
    WHEN 'event' THEN EXISTS (SELECT 1 FROM events ev WHERE ev.id = ${mi}.item_id AND ${eventVisibleSql(viewer, 'ev')})
    WHEN 'real_capture' THEN EXISTS (SELECT 1 FROM real_captures rc WHERE rc.id = ${mi}.item_id AND (${realVisibleSql(viewer, 'rc')} OR ${ownRealSql(viewer, 'rc')}))
    WHEN 'experience' THEN EXISTS (SELECT 1 FROM shared_experiences se WHERE se.id = ${mi}.item_id AND ${experienceVisibleSql(viewer, 'se')})
    WHEN 'message' THEN (${V} IS NOT NULL AND ${mem}.owner_id = ${V} AND EXISTS (
      SELECT 1 FROM messages ms WHERE ms.id = ${mi}.item_id AND ms.sender_id = ${V} AND ms.deleted_at IS NULL AND ms.moderation_status <> 'removed'))
    ELSE false END)`;
}
