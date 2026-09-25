import type { Queryable } from '@yapilapi/database';
import { notFound } from '@yapilapi/shared';
import type { AppContext } from './context.js';

/** True if either user has blocked the other. */
export async function isBlockedEitherWay(db: Queryable, a: string, b: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `SELECT 1 FROM user_blocks WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1) LIMIT 1`,
    [a, b],
  );
  return (rowCount ?? 0) > 0;
}

export interface ResolvedUser {
  id: string;
  username: string;
  isPrivate: boolean;
  status: string;
}

/**
 * Look up a user by username for a viewer. Deleted/suspended users and users in a block relationship with
 * the viewer resolve to 404 so that block state is not revealed.
 */
export async function resolveUser(
  ctx: AppContext,
  viewerId: string | null,
  username: string,
): Promise<ResolvedUser> {
  const { rows } = await ctx.db.query<{
    user_id: string;
    username: string;
    is_private: boolean;
    status: string;
  }>(
    `SELECT p.user_id, p.username, p.is_private, u.status
       FROM profiles p JOIN users u ON u.id = p.user_id
      WHERE p.username = $1 AND u.deleted_at IS NULL AND u.status IN ('active','pending_deletion','deactivated')`,
    [username.toLowerCase()],
  );
  const r = rows[0];
  if (!r || r.status === 'deactivated') throw notFound('User');
  if (viewerId && viewerId !== r.user_id && (await isBlockedEitherWay(ctx.db, viewerId, r.user_id)))
    throw notFound('User');
  return { id: r.user_id, username: r.username, isPrivate: r.is_private, status: r.status };
}
