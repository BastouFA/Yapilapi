/**
 * THE visibility rules for shared experiences (Real Together), mirroring lib/visibility.ts. `viewer` is a SQL expression for the viewer's user
 * id or NULL; `e` aliases shared_experiences, `c` aliases shared_experience_contributions.
 *
 * Model (kept deliberately small and explicit):
 *  - Members (joined) see everything that is not hidden by a block or held by moderation.
 *  - Invited people see the experience header only (enough to accept or decline), never its contributions.
 *  - Non-members see it only when it is `friends` (viewer is a friend of the owner) or `public` (owner's profile is not private, or viewer follows the owner).
 *  - Blocks hide the whole experience from the blocked pair with its owner, and hide each contributor's contributions from the other side.
 *  - Contributions by accounts under 18 in a PUBLIC experience are visible to members only.
 */
const activeUser = (u: string) =>
  `EXISTS (SELECT 1 FROM users uu WHERE uu.id = ${u} AND uu.deleted_at IS NULL AND uu.status IN ('active','pending_deletion'))`;
const blocked = (V: string, other: string) =>
  `EXISTS (SELECT 1 FROM user_blocks bl WHERE (bl.blocker_id = ${V} AND bl.blocked_id = ${other}) OR (bl.blocker_id = ${other} AND bl.blocked_id = ${V}))`;

/** The viewer is a joined member (any role). */
export function joinedMemberSql(viewer: string, e = 'e'): string {
  const V = `(${viewer})`;
  return `(${V} IS NOT NULL AND EXISTS (SELECT 1 FROM shared_experience_members jm WHERE jm.experience_id = ${e}.id AND jm.user_id = ${V} AND jm.status = 'joined'))`;
}

/** Audience path for non-members: friends of the owner, or the public. */
function audienceSql(viewer: string, e: string): string {
  const V = `(${viewer})`;
  return `(CASE ${e}.visibility
    WHEN 'public' THEN (
      NOT EXISTS (SELECT 1 FROM profiles pp WHERE pp.user_id = ${e}.owner_id AND pp.is_private)
      OR (${V} IS NOT NULL AND EXISTS (SELECT 1 FROM follows fw WHERE fw.follower_id = ${V} AND fw.followee_id = ${e}.owner_id AND fw.status = 'active')))
    WHEN 'friends' THEN (${V} IS NOT NULL AND EXISTS (SELECT 1 FROM friendships fr WHERE fr.user_low = LEAST(${V}, ${e}.owner_id) AND fr.user_high = GREATEST(${V}, ${e}.owner_id) AND fr.status = 'accepted'))
    ELSE false END)`;
}

/** May the viewer see the experience header (title, members count, cover)? */
export function experienceVisibleSql(viewer: string, e = 'e'): string {
  const V = `(${viewer})`;
  return `(
    ${e}.deleted_at IS NULL
    AND ${activeUser(`${e}.owner_id`)}
    AND (${V} IS NOT NULL AND ${e}.owner_id = ${V} OR NOT (${V} IS NOT NULL AND ${blocked(V, `${e}.owner_id`)}))
    AND (
      (${V} IS NOT NULL AND EXISTS (SELECT 1 FROM shared_experience_members vm WHERE vm.experience_id = ${e}.id AND vm.user_id = ${V} AND vm.status IN ('joined','invited')))
      OR ${audienceSql(viewer, e)}
    )
  )`;
}

/** May the viewer see this contribution? (Includes the experience rule.) */
export function contributionVisibleSql(viewer: string, c = 'c', e = 'e'): string {
  const V = `(${viewer})`;
  return `(
    ${c}.deleted_at IS NULL
    AND ${experienceVisibleSql(viewer, e)}
    AND (
      (${V} IS NOT NULL AND ${c}.contributor_id = ${V})
      OR (
        ${c}.moderation_status = 'approved'
        AND ${activeUser(`${c}.contributor_id`)}
        AND NOT (${V} IS NOT NULL AND ${blocked(V, `${c}.contributor_id`)})
        AND (
          ${joinedMemberSql(viewer, e)}
          OR (${audienceSql(viewer, e)}
              AND (${e}.visibility <> 'public' OR EXISTS (SELECT 1 FROM users ut WHERE ut.id = ${c}.contributor_id AND ut.age_band = 'adult')))
        )
      )
    )
  )`;
}
