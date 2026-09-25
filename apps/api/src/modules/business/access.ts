import type { Queryable } from '@yapilapi/database';
import { forbidden, notFound } from '@yapilapi/shared';

export const BUSINESS_ROLES = ['owner', 'admin', 'editor', 'support'] as const;
export type BusinessRole = (typeof BUSINESS_ROLES)[number];

export const BUSINESS_PERMISSIONS = [
  'profile.edit',
  'team.manage',
  'offers.manage',
  'posts.publish',
  'events.manage',
  'places.manage',
  'claims.manage',
  'bookings.manage',
  'reviews.reply',
  'analytics.view',
  'ai.manage',
  'ai.approve',
  'business.delete',
] as const;
export type BusinessPermission = (typeof BUSINESS_PERMISSIONS)[number];

/** Role -> permissions. Owners hold everything (analytics, AI approvals and closing the business are owner-only); support staff only work with customers (bookings, review replies). */
export const ROLE_PERMISSIONS: Record<BusinessRole, readonly BusinessPermission[]> = {
  owner: BUSINESS_PERMISSIONS,
  admin: [
    'profile.edit',
    'team.manage',
    'offers.manage',
    'posts.publish',
    'events.manage',
    'places.manage',
    'claims.manage',
    'bookings.manage',
    'reviews.reply',
    'ai.manage',
  ],
  editor: ['offers.manage', 'posts.publish', 'events.manage', 'places.manage', 'reviews.reply'],
  support: ['bookings.manage', 'reviews.reply'],
};
export const ROLE_RANK: Record<BusinessRole, number> = {
  owner: 100,
  admin: 60,
  editor: 30,
  support: 10,
};

export interface BusinessAccess {
  businessId: string;
  role: BusinessRole;
  permissions: readonly BusinessPermission[];
  status: string;
}

/** Active team membership of a live business, or null. Invitations never grant access (they live in `business_invitations`). */
export async function getBusinessAccess(
  db: Queryable,
  businessId: string,
  userId: string | null,
): Promise<BusinessAccess | null> {
  if (!userId) return null;
  const { rows } = await db.query<{ role: BusinessRole; status: string }>(
    `SELECT m.role, b.status FROM business_members m JOIN businesses b ON b.id = m.business_id AND b.deleted_at IS NULL
      WHERE m.business_id = $1 AND m.user_id = $2`,
    [businessId, userId],
  );
  const r = rows[0];
  return r
    ? { businessId, role: r.role, permissions: ROLE_PERMISSIONS[r.role], status: r.status }
    : null;
}

export const can = (a: BusinessAccess | null, perm: BusinessPermission): boolean =>
  Boolean(a && a.permissions.includes(perm));

/**
 * Require an active member holding `perm`. Non-members get 404 (the business may still be public, but its management
 * surface is not), members lacking the permission get 403. Suspended/closed businesses are read-only.
 */
export async function requireBusinessPermission(
  db: Queryable,
  businessId: string,
  userId: string,
  perm: BusinessPermission,
  opts: { allowInactive?: boolean } = {},
): Promise<BusinessAccess> {
  const a = await getBusinessAccess(db, businessId, userId);
  if (!a) throw notFound('Business');
  if (!a.permissions.includes(perm)) throw forbidden('Your role does not allow that');
  if (!opts.allowInactive && a.status !== 'active') throw forbidden('This business is not active');
  return a;
}

/** Is `userId` on the team of the business that owns place/… `businessId` (any role)? */
export async function isBusinessMember(
  db: Queryable,
  businessId: string | null,
  userId: string,
): Promise<boolean> {
  if (!businessId) return false;
  const { rowCount } = await db.query(
    'SELECT 1 FROM business_members WHERE business_id = $1 AND user_id = $2',
    [businessId, userId],
  );
  return (rowCount ?? 0) > 0;
}
