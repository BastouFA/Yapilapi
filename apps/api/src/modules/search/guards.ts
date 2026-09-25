import { postVisibleSql } from '../../lib/visibility.js';
import type { SearchType, VisibilityGuard } from '@yapilapi/search';

/**
 * Authorisation predicates for search and discovery. These are the ONLY place that decides whether an entity may be
 * shown to a viewer in search/discover results; both the ranking query (candidate generation) and the hydration
 * query apply them, so an external index can never widen what a viewer sees.
 *
 * `V` is a SQL expression for the viewer's user id (NULL for anonymous). Post visibility itself is delegated to the
 * central `postVisibleSql`; everything else is expressed here using the same building blocks.
 */

export const blockedSql = (V: string, other: string) =>
  `EXISTS (SELECT 1 FROM user_blocks bx WHERE (bx.blocker_id = ${V} AND bx.blocked_id = ${other}) OR (bx.blocker_id = ${other} AND bx.blocked_id = ${V}))`;
export const notBlockedSql = (V: string, other: string) =>
  `(${V} IS NULL OR NOT ${blockedSql(V, other)})`;
export const friendsSql = (V: string, other: string) =>
  `EXISTS (SELECT 1 FROM friendships fx WHERE fx.user_low = LEAST(${V}, ${other}) AND fx.user_high = GREATEST(${V}, ${other}) AND fx.status = 'accepted')`;
export const followsSql = (V: string, followee: string) =>
  `EXISTS (SELECT 1 FROM follows flx WHERE flx.follower_id = ${V} AND flx.followee_id = ${followee} AND flx.status = 'active')`;
export const activeUserSql = (userExpr: string) =>
  `EXISTS (SELECT 1 FROM users ux WHERE ux.id = ${userExpr} AND ux.deleted_at IS NULL AND ux.status = 'active')`;

/**
 * Minor safety: an under-18 account is only ever shown to its own network. A teen target is visible to the viewer
 * only if the viewer is the teen, a friend, someone in an active follow relationship (either direction), an active
 * guardian, or a teen themselves (teens are additionally hidden by `discoverable = false`, which they cannot change).
 */
export const teenAllowedSql = (V: string, userExpr: string) => `(
  NOT EXISTS (SELECT 1 FROM users tx WHERE tx.id = ${userExpr} AND tx.age_band = 'teen')
  OR (${V} IS NOT NULL AND (
    ${V} = ${userExpr}
    OR ${friendsSql(V, userExpr)}
    OR ${followsSql(V, userExpr)}
    OR EXISTS (SELECT 1 FROM follows fbx WHERE fbx.follower_id = ${userExpr} AND fbx.followee_id = ${V} AND fbx.status = 'active')
    OR EXISTS (SELECT 1 FROM guardian_links gx WHERE gx.minor_id = ${userExpr} AND gx.guardian_id = ${V} AND gx.status = 'active')
    OR EXISTS (SELECT 1 FROM users vx WHERE vx.id = ${V} AND vx.age_band = 'teen')
  ))
)`;

/** A profile a viewer may find via search/suggestions. `pr` = alias of `profiles`. */
export function personVisibleSql(V: string, pr = 'pr'): string {
  return `(
    ${activeUserSql(`${pr}.user_id`)}
    AND ${notBlockedSql(V, `${pr}.user_id`)}
    AND (
      (${V} IS NOT NULL AND ${pr}.user_id = ${V})
      OR (
        (COALESCE((SELECT upx.discoverable FROM user_preferences upx WHERE upx.user_id = ${pr}.user_id), true) OR (${V} IS NOT NULL AND ${friendsSql(V, `${pr}.user_id`)}))
        AND ${teenAllowedSql(V, `${pr}.user_id`)}
      )
    )
  )`;
}

/** Posts in search/discover: the central post predicate plus the teen-author rule (teen posts in public communities). */
export function postSearchVisibleSql(V: string, p = 'p'): string {
  return `(${postVisibleSql(V, p)} AND ${teenAllowedSql(V, `${p}.author_id`)})`;
}

/** Communities: secret only to active/invited members, private shows a summary, public to all; banned members see nothing. */
export function communityVisibleSql(V: string, c = 'c'): string {
  const member = (statuses: string) =>
    `(${V} IS NOT NULL AND EXISTS (SELECT 1 FROM community_members cmx WHERE cmx.community_id = ${c}.id AND cmx.user_id = ${V} AND cmx.status IN (${statuses})))`;
  return `(
    ${c}.deleted_at IS NULL
    AND (
      (
        ${c}.visibility IN ('public','private')
        AND NOT (${V} IS NOT NULL AND EXISTS (SELECT 1 FROM community_members cbx WHERE cbx.community_id = ${c}.id AND cbx.user_id = ${V} AND cbx.status = 'banned'))
        AND (
          ${c}.visibility = 'public'
          OR NOT EXISTS (SELECT 1 FROM users ccx WHERE ccx.id = ${c}.created_by AND ccx.age_band = 'teen')
          OR ${member(`'active'`)}
        )
      )
      OR ${member(`'active','invited'`)}
    )
  )`;
}

/** Events, per migrations 004/150: public; followers; friends; community members; private = attendees/invitees/organisers. */
export function eventVisibleSql(V: string, e = 'e'): string {
  return `(
    ${e}.deleted_at IS NULL AND ${e}.status = 'published'
    AND (${e}.host_id IS NULL OR (${activeUserSql(`${e}.host_id`)} AND ${notBlockedSql(V, `${e}.host_id`)} AND ${teenAllowedSql(V, `${e}.host_id`)}))
    AND (
      ${e}.visibility = 'public'
      OR (${V} IS NOT NULL AND (
        ${e}.host_id = ${V}
        OR (${e}.visibility = 'followers' AND ${e}.host_id IS NOT NULL AND ${followsSql(V, `${e}.host_id`)})
        OR (${e}.visibility = 'friends' AND ${e}.host_id IS NOT NULL AND ${friendsSql(V, `${e}.host_id`)})
        OR (${e}.visibility = 'community' AND EXISTS (SELECT 1 FROM community_members ecm WHERE ecm.community_id = ${e}.community_id AND ecm.user_id = ${V} AND ecm.status = 'active'))
        OR (${e}.visibility = 'private' AND (
          EXISTS (SELECT 1 FROM event_attendees ea WHERE ea.event_id = ${e}.id AND ea.user_id = ${V} AND ea.status IN ('interested','going','waitlist','attended'))
          OR EXISTS (SELECT 1 FROM event_invitations ei WHERE ei.event_id = ${e}.id AND ei.user_id = ${V} AND ei.status IN ('pending','accepted'))
          OR EXISTS (SELECT 1 FROM event_organizers eo WHERE eo.event_id = ${e}.id AND eo.user_id = ${V})
        ))
      ))
    )
  )`;
}

export function businessVisibleSql(V: string, b = 'b'): string {
  return `(${b}.deleted_at IS NULL AND ${b}.status = 'active' AND (${b}.owner_id IS NULL OR (${activeUserSql(`${b}.owner_id`)} AND ${notBlockedSql(V, `${b}.owner_id`)})))`;
}

/** Products: active, not deleted, and the seller (business or individual) must itself be visible to the viewer. */
export function productVisibleSql(V: string, pd = 'pd'): string {
  return `(
    ${pd}.deleted_at IS NULL AND ${pd}.status = 'active'
    AND (
      (${pd}.business_id IS NOT NULL AND EXISTS (SELECT 1 FROM businesses pbx WHERE pbx.id = ${pd}.business_id AND ${businessVisibleSql(V, 'pbx')}))
      OR (${pd}.seller_user_id IS NOT NULL AND ${activeUserSql(`${pd}.seller_user_id`)} AND ${notBlockedSql(V, `${pd}.seller_user_id`)} AND ${teenAllowedSql(V, `${pd}.seller_user_id`)})
    )
  )`;
}

/** Places are public reference data; the viewer is still referenced so the bind parameter always has a type. */
export const placeVisibleSql = (V: string, p = 'pl') =>
  `(${p}.deleted_at IS NULL AND (${V} IS NULL OR TRUE))`;

export const topicVisibleSql = (V: string, t = 'tp') =>
  `(${V} IS NULL OR NOT EXISTS (SELECT 1 FROM topic_mutes tmx WHERE tmx.user_id = ${V} AND tmx.topic_id = ${t}.id))`;

/** The guard handed to the search backend. */
export const searchGuard: VisibilityGuard = (type: SearchType, viewer: string, alias: string) => {
  switch (type) {
    case 'people':
      return personVisibleSql(viewer, alias);
    case 'creators':
      return `(${alias}.mode = 'creator' AND ${personVisibleSql(viewer, alias)})`;
    case 'posts':
      return `(${alias}.kind <> 'video' AND ${postSearchVisibleSql(viewer, alias)})`;
    case 'videos':
      return `(${alias}.kind = 'video' AND ${postSearchVisibleSql(viewer, alias)})`;
    case 'communities':
      return communityVisibleSql(viewer, alias);
    case 'events':
      return eventVisibleSql(viewer, alias);
    case 'places':
      return placeVisibleSql(viewer, alias);
    case 'businesses':
      return businessVisibleSql(viewer, alias);
    case 'products':
      return productVisibleSql(viewer, alias);
    case 'topics':
      return topicVisibleSql(viewer, alias);
  }
};
