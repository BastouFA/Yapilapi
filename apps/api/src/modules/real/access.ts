/**
 * THE visibility rule for Real captures (the Real counterpart of momentVisibleSql in lib/visibility.ts). Same audience model as posts and
 * moments (public|followers|friends|circle|selected|private) without expiry: a Real lives until its author deletes it.
 *
 * `viewer` is a SQL expression evaluating to the viewer's user id or NULL (anonymous); `r` aliases real_captures.
 */
export function realVisibleSql(viewer: string, r = 'r'): string {
  const V = `(${viewer})`;
  const follows = `EXISTS (SELECT 1 FROM follows fw WHERE fw.follower_id = ${V} AND fw.followee_id = ${r}.author_id AND fw.status = 'active')`;
  return `(
    ${r}.deleted_at IS NULL
    AND ${r}.moderation_status = 'approved'
    AND EXISTS (SELECT 1 FROM users ua WHERE ua.id = ${r}.author_id AND ua.deleted_at IS NULL AND ua.status IN ('active','pending_deletion'))
    AND (${V} IS NULL OR NOT EXISTS (SELECT 1 FROM user_blocks bl WHERE (bl.blocker_id = ${V} AND bl.blocked_id = ${r}.author_id) OR (bl.blocker_id = ${r}.author_id AND bl.blocked_id = ${V})))
    AND (
      (${V} IS NOT NULL AND ${r}.author_id = ${V})
      OR CASE ${r}.visibility
        WHEN 'public' THEN (
          NOT EXISTS (SELECT 1 FROM profiles pp WHERE pp.user_id = ${r}.author_id AND pp.is_private)
          OR (${V} IS NOT NULL AND ${follows})
        )
        WHEN 'followers' THEN (${V} IS NOT NULL AND ${follows})
        WHEN 'friends' THEN (${V} IS NOT NULL AND EXISTS (SELECT 1 FROM friendships fr WHERE fr.user_low = LEAST(${V}, ${r}.author_id) AND fr.user_high = GREATEST(${V}, ${r}.author_id) AND fr.status = 'accepted'))
        WHEN 'circle' THEN (${V} IS NOT NULL AND EXISTS (SELECT 1 FROM circle_members cm WHERE cm.circle_id = ${r}.circle_id AND cm.user_id = ${V}))
        WHEN 'selected' THEN (${V} IS NOT NULL AND EXISTS (SELECT 1 FROM real_capture_audience ra WHERE ra.capture_id = ${r}.id AND ra.user_id = ${V}))
        ELSE false
      END
    )
  )`;
}

/** The author may always read their own capture, even while it is held for review (nobody else can). */
export function ownRealSql(viewer: string, r = 'r'): string {
  return `(${r}.deleted_at IS NULL AND (${viewer}) IS NOT NULL AND ${r}.author_id = (${viewer}))`;
}
