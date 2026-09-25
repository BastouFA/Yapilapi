import type { Queryable } from '@yapilapi/database';
import type { CommunityPermission } from '@yapilapi/shared';

export interface CommunityMembership {
  roleKey: string;
  rank: number;
  permissions: string[];
}

/** Active membership + role permissions, or null (non-member, pending, banned, left). */
export async function getMembership(
  db: Queryable,
  communityId: string,
  userId: string,
): Promise<CommunityMembership | null> {
  const { rows } = await db.query<{ role_key: string; rank: number; permissions: string[] }>(
    `SELECT m.role_key, r.rank, r.permissions
       FROM community_members m JOIN community_roles r ON r.community_id = m.community_id AND r.key = m.role_key
       JOIN communities c ON c.id = m.community_id AND c.deleted_at IS NULL
      WHERE m.community_id = $1 AND m.user_id = $2 AND m.status = 'active'`,
    [communityId, userId],
  );
  const r = rows[0];
  return r ? { roleKey: r.role_key, rank: r.rank, permissions: r.permissions } : null;
}

export async function hasCommunityPermission(
  db: Queryable,
  communityId: string,
  userId: string,
  perm: CommunityPermission,
): Promise<boolean> {
  const m = await getMembership(db, communityId, userId);
  return Boolean(m?.permissions.includes(perm));
}
