import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';
import { forbidden, PLATFORM_ROLES, type PlatformRole } from '@yapilapi/shared';
import type { AppContext } from '../../lib/context.js';
import { route, type RouteDef } from '../../lib/route.js';

/**
 * THE staff permission matrix. One file, one table: roles are ordered user < support < moderator < admin < superadmin
 * and each role inherits everything below it. Routes declare the PERMISSION they need (`adminRoute`); the role list the
 * route helper enforces (role check + MFA) is derived from this table, so there is no second place to keep in sync.
 */

export const PERMISSIONS = [
  'users.read',
  'users.read_pii',
  'users.note',
  'users.suspend',
  'users.reactivate',
  'users.role_change',
  'content.read',
  'reports.read',
  'cases.read',
  'cases.decide',
  'cases.escalated',
  'cases.ban',
  'appeals.review',
  'communities.read',
  'communities.suspend',
  'businesses.read',
  'businesses.verify',
  'businesses.suspend',
  'creators.read',
  'creators.suspend',
  'payments.read',
  'fraud.read',
  'ai.read',
  'audit.read',
  'system.read',
  'flags.read',
  'flags.write',
  'analytics.read',
  'miniapps.review',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/** Permissions each role adds on top of the role below it. */
const ADDED: Record<PlatformRole, readonly Permission[]> = {
  user: [],
  // Read-mostly: can look things up and leave internal notes, cannot change anyone's account or content.
  support: [
    'users.read',
    'users.note',
    'content.read',
    'reports.read',
    'cases.read',
    'communities.read',
    'businesses.read',
    'creators.read',
    'payments.read',
  ],
  moderator: ['cases.decide', 'appeals.review', 'users.suspend', 'communities.suspend'],
  admin: [
    'users.read_pii',
    'users.reactivate',
    'cases.escalated',
    'cases.ban',
    'businesses.verify',
    'businesses.suspend',
    'creators.suspend',
    'fraud.read',
    'ai.read',
    'audit.read',
    'system.read',
    'flags.read',
    'flags.write',
    'analytics.read',
    'miniapps.review',
  ],
  superadmin: ['users.role_change'],
};

export const ROLE_RANK: Record<PlatformRole, number> = {
  user: 0,
  support: 1,
  moderator: 2,
  admin: 3,
  superadmin: 4,
};
export const STAFF_ROLES: readonly PlatformRole[] = PLATFORM_ROLES.filter((r) => r !== 'user');

/** Effective permission set for each role (inherited from lower roles). */
export const PERMISSION_MATRIX: Record<PlatformRole, ReadonlySet<Permission>> = (() => {
  const out = {} as Record<PlatformRole, Set<Permission>>;
  let acc = new Set<Permission>();
  for (const role of PLATFORM_ROLES) {
    acc = new Set([...acc, ...ADDED[role]]);
    out[role] = acc;
  }
  return out;
})();

export const roleHas = (role: PlatformRole, perm: Permission): boolean =>
  PERMISSION_MATRIX[role].has(perm);
export const rolesWith = (perm: Permission): PlatformRole[] =>
  STAFF_ROLES.filter((r) => roleHas(r, perm));
export const isSenior = (role: PlatformRole): boolean => ROLE_RANK[role] >= ROLE_RANK.admin;
/** A staff member may only act on accounts that rank strictly below them (superadmins on anyone but themselves). */
export const outranks = (actor: PlatformRole, target: PlatformRole): boolean =>
  ROLE_RANK[actor] > ROLE_RANK[target];

export function requirePermission(role: PlatformRole, perm: Permission): void {
  if (!roleHas(role, perm)) throw forbidden('Your role does not allow this action');
}

type StaffAuth = { staff: readonly PlatformRole[] };

/** A route that requires a permission: the helper enforces staff role + MFA, the permission table decides who. */
export function adminRoute<
  P extends z.ZodType | undefined = undefined,
  Q extends z.ZodType | undefined = undefined,
  B extends z.ZodType | undefined = undefined,
>(
  app: FastifyInstance,
  ctx: AppContext,
  permission: Permission,
  def: Omit<RouteDef<StaffAuth, P, Q, B>, 'auth'>,
): void {
  route(app, ctx, { ...def, auth: { staff: rolesWith(permission) } } as RouteDef<
    StaffAuth,
    P,
    Q,
    B
  >);
}
