/**
 * SQL predicates that decide what a viewer may see. Every read path (feed,
 * profile, search, AI context) uses these, so authorization lives in one place
 * and is enforced by the server, never the client.
 *
 * `v` is the placeholder for the viewer id (may be NULL for anonymous viewers).
 */

/** The viewer and the other user haven't blocked each other. */
export function notBlockedSql(otherUserCol: string, v: string): string {
  return `NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id = ${v} AND b.blocked_id = ${otherUserCol})
                                          OR (b.blocker_id = ${otherUserCol} AND b.blocked_id = ${v}))`;
}

/** Posts aliased `p`, author's profile aliased `ap`, author user aliased `au`. */
export function postVisibleSql(v: string): string {
  return `(
    p.deleted_at IS NULL
    AND au.status = 'active'
    AND (p.moderation_status IN ('normal', 'review') OR p.author_id = ${v})
    AND ${notBlockedSql('p.author_id', v)}
    AND (
      p.author_id = ${v}
      OR (p.visibility = 'public' AND (NOT ap.is_private OR EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = ${v} AND f.followee_id = p.author_id)))
      OR (p.visibility = 'followers' AND EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = ${v} AND f.followee_id = p.author_id))
      OR (p.visibility = 'friends' AND EXISTS (SELECT 1 FROM friendships fr WHERE (fr.user_a = ${v} AND fr.user_b = p.author_id) OR (fr.user_b = ${v} AND fr.user_a = p.author_id)))
      OR (p.visibility = 'circle' AND EXISTS (SELECT 1 FROM circle_members cm WHERE cm.circle_id = p.circle_id AND cm.user_id = ${v}))
      OR (p.visibility = 'selected' AND EXISTS (SELECT 1 FROM post_audience pa WHERE pa.post_id = p.id AND pa.user_id = ${v}))
    )
    AND (
      p.community_id IS NULL
      OR EXISTS (SELECT 1 FROM communities c WHERE c.id = p.community_id AND c.deleted_at IS NULL AND (
            c.visibility = 'public'
            OR EXISTS (SELECT 1 FROM community_members cm2 WHERE cm2.community_id = c.id AND cm2.user_id = ${v} AND cm2.status = 'active')))
    )
  )`;
}

/**
 * Media aliased `m`. Media has no audience of its own: the owner always sees it,
 * and anyone else sees it when it's attached to a post they can see.
 */
export function mediaVisibleSql(v: string): string {
  return `(
    m.owner_id = ${v}
    OR EXISTS (SELECT 1 FROM post_media pm
               JOIN posts p ON p.id = pm.post_id
               JOIN profiles ap ON ap.user_id = p.author_id
               JOIN users au ON au.id = p.author_id
               WHERE pm.media_id = m.id AND ${postVisibleSql(v)})
  )`;
}

/** Events aliased `e`. */
export function eventVisibleSql(v: string): string {
  return `(
    e.deleted_at IS NULL
    AND ${notBlockedSql('e.host_id', v)}
    AND (
      e.host_id = ${v}
      OR e.visibility = 'public'
      OR (e.visibility = 'followers' AND EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = ${v} AND f.followee_id = e.host_id))
      OR (e.visibility = 'friends' AND EXISTS (SELECT 1 FROM friendships fr WHERE (fr.user_a = ${v} AND fr.user_b = e.host_id) OR (fr.user_b = ${v} AND fr.user_a = e.host_id)))
      OR EXISTS (SELECT 1 FROM event_attendees ea WHERE ea.event_id = e.id AND ea.user_id = ${v})
    )
    AND (e.community_id IS NULL OR EXISTS (SELECT 1 FROM communities c WHERE c.id = e.community_id AND (
      c.visibility = 'public' OR EXISTS (SELECT 1 FROM community_members cm WHERE cm.community_id = c.id AND cm.user_id = ${v} AND cm.status = 'active'))))
  )`;
}
