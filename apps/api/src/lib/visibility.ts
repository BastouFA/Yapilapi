import type { Queryable } from '@yapilapi/database';

/**
 * THE central visibility rules for user content. Every query that returns posts to a viewer must
 * include `postVisibleSql`. Keeping it in one place means blocks, privacy, moderation and community
 * membership are enforced identically in feeds, profiles, search, comments, notifications and AI tools.
 *
 * `viewer` is a SQL expression (e.g. '$1::uuid') evaluating to the viewer's user id, or NULL for anonymous.
 * `p` is the alias of the posts table in the calling query.
 */
export function postVisibleSql(viewer: string, p = 'p'): string {
  const V = `(${viewer})`;
  const follows = `EXISTS (SELECT 1 FROM follows fw WHERE fw.follower_id = ${V} AND fw.followee_id = ${p}.author_id AND fw.status = 'active')`;
  const friends = `EXISTS (SELECT 1 FROM friendships fr WHERE fr.user_low = LEAST(${V}, ${p}.author_id) AND fr.user_high = GREATEST(${V}, ${p}.author_id) AND fr.status = 'accepted')`;
  // Subscriber-only posts: an ENTITLED subscription to the author (see creator/entitlements.ts, which mirrors this rule for code paths that
  // are not SQL): status active, or past_due inside the dunning grace period, and a plan tier >= posts.metadata.minTier (default 1).
  const subscribed = `EXISTS (SELECT 1 FROM subscriptions sb JOIN subscription_plans sbp ON sbp.id = sb.plan_id
      WHERE sb.subscriber_id = ${V} AND sb.creator_id = ${p}.author_id
        AND ((sb.status = 'active' AND sb.current_period_end + interval '1 day' > now()) OR (sb.status = 'past_due' AND sb.current_period_end + interval '3 days' > now()))
        AND sbp.tier >= CASE WHEN ${p}.metadata->>'minTier' ~ '^[0-9]{1,2}$' THEN (${p}.metadata->>'minTier')::int ELSE 1 END)`;
  return `(
    ${p}.deleted_at IS NULL
    AND (${p}.moderation_status = 'approved' OR (${V} IS NOT NULL AND ${p}.author_id = ${V} AND ${p}.moderation_status <> 'removed'))
    AND EXISTS (SELECT 1 FROM users ua WHERE ua.id = ${p}.author_id AND ua.deleted_at IS NULL AND ua.status IN ('active','pending_deletion'))
    AND (${V} IS NULL OR NOT EXISTS (SELECT 1 FROM user_blocks bl WHERE (bl.blocker_id = ${V} AND bl.blocked_id = ${p}.author_id) OR (bl.blocker_id = ${p}.author_id AND bl.blocked_id = ${V})))
    AND (
      (${V} IS NOT NULL AND ${p}.author_id = ${V})
      OR CASE ${p}.visibility
        WHEN 'public' THEN (
          NOT EXISTS (SELECT 1 FROM profiles pp WHERE pp.user_id = ${p}.author_id AND pp.is_private)
          OR ${p}.business_id IS NOT NULL
          OR (${V} IS NOT NULL AND ${follows})
        )
        WHEN 'followers' THEN (${V} IS NOT NULL AND ${follows})
        WHEN 'friends' THEN (${V} IS NOT NULL AND ${friends})
        WHEN 'circle' THEN (${V} IS NOT NULL AND EXISTS (SELECT 1 FROM circle_members cm WHERE cm.circle_id = ${p}.circle_id AND cm.user_id = ${V}))
        WHEN 'selected' THEN (${V} IS NOT NULL AND EXISTS (SELECT 1 FROM post_audience pa WHERE pa.post_id = ${p}.id AND pa.user_id = ${V}))
        WHEN 'subscribers' THEN (${V} IS NOT NULL AND ${subscribed})
        WHEN 'community' THEN (
          EXISTS (SELECT 1 FROM communities cx WHERE cx.id = ${p}.community_id AND cx.deleted_at IS NULL AND (
            (cx.visibility = 'public' AND NOT (${V} IS NOT NULL AND EXISTS (SELECT 1 FROM community_members bm WHERE bm.community_id = cx.id AND bm.user_id = ${V} AND bm.status = 'banned')))
            OR (${V} IS NOT NULL AND EXISTS (SELECT 1 FROM community_members mm WHERE mm.community_id = cx.id AND mm.user_id = ${V} AND mm.status = 'active'))
          ))
        )
        ELSE false
      END
    )
  )`;
}

/** Same idea for moments (temporary content): expiry, blocks, audience. */
export function momentVisibleSql(viewer: string, m = 'm'): string {
  const V = `(${viewer})`;
  return `(
    ${m}.deleted_at IS NULL
    AND (${m}.expires_at IS NULL OR ${m}.expires_at > now())
    AND ${m}.moderation_status = 'approved'
    AND EXISTS (SELECT 1 FROM users ua WHERE ua.id = ${m}.author_id AND ua.deleted_at IS NULL AND ua.status IN ('active','pending_deletion'))
    AND (${V} IS NULL OR NOT EXISTS (SELECT 1 FROM user_blocks bl WHERE (bl.blocker_id = ${V} AND bl.blocked_id = ${m}.author_id) OR (bl.blocker_id = ${m}.author_id AND bl.blocked_id = ${V})))
    AND (
      (${V} IS NOT NULL AND ${m}.author_id = ${V})
      OR CASE ${m}.visibility
        WHEN 'public' THEN (
          NOT EXISTS (SELECT 1 FROM profiles pp WHERE pp.user_id = ${m}.author_id AND pp.is_private)
          OR (${V} IS NOT NULL AND EXISTS (SELECT 1 FROM follows fw WHERE fw.follower_id = ${V} AND fw.followee_id = ${m}.author_id AND fw.status = 'active'))
        )
        WHEN 'followers' THEN (${V} IS NOT NULL AND EXISTS (SELECT 1 FROM follows fw WHERE fw.follower_id = ${V} AND fw.followee_id = ${m}.author_id AND fw.status = 'active'))
        WHEN 'friends' THEN (${V} IS NOT NULL AND EXISTS (SELECT 1 FROM friendships fr WHERE fr.user_low = LEAST(${V}, ${m}.author_id) AND fr.user_high = GREATEST(${V}, ${m}.author_id) AND fr.status = 'accepted'))
        WHEN 'circle' THEN (${V} IS NOT NULL AND EXISTS (SELECT 1 FROM circle_members cm WHERE cm.circle_id = ${m}.circle_id AND cm.user_id = ${V}))
        WHEN 'selected' THEN (${V} IS NOT NULL AND EXISTS (SELECT 1 FROM moment_audience ma WHERE ma.moment_id = ${m}.id AND ma.user_id = ${V}))
        ELSE false
      END
    )
  )`;
}

/** Load one post the viewer is allowed to see, or null (callers respond 404 — never reveal existence). */
export async function loadVisiblePost<T = Record<string, unknown>>(
  db: Queryable,
  viewerId: string | null,
  postId: string,
): Promise<T | null> {
  const { rows } = await db.query(
    `SELECT p.* FROM posts p WHERE p.id = $2 AND ${postVisibleSql('$1::uuid')}`,
    [viewerId, postId],
  );
  return (rows[0] as T | undefined) ?? null;
}
