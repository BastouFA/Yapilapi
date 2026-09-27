import type { Pool, PoolClient } from 'pg';
import type { NowStatus, NowStatusAudience, NowStatusIcon } from '@yapilapi/shared';
import { notBlockedSql } from './visibility.ts';

type Q = Pool | PoolClient;

/**
 * "Now" statuses (profile_statuses aliased `ns`): a short line that ends 24
 * hours after it was set. Viewer `v` (may be NULL for people without an
 * account) sees one when it hasn't ended, its owner is active, nobody blocked
 * the other, and the viewer is in its audience:
 *   everyone       anyone who can see the profile (a private profile: its followers)
 *   followers      people who follow the owner
 *   close_friends  people on the owner's close friends list who also follow them
 * The owner always sees their own.
 */
export function nowStatusVisibleSql(v: string, ns = 'ns'): string {
  const follows = `EXISTS (SELECT 1 FROM follows nf WHERE nf.follower_id = ${v} AND nf.followee_id = ${ns}.user_id)`;
  return `(
    ${ns}.expires_at > now()
    AND EXISTS (SELECT 1 FROM users nu WHERE nu.id = ${ns}.user_id AND nu.status = 'active')
    AND (
      ${ns}.user_id = ${v}
      OR (${notBlockedSql(`${ns}.user_id`, v)} AND (
        (${ns}.audience = 'everyone' AND (NOT (SELECT np.is_private FROM profiles np WHERE np.user_id = ${ns}.user_id) OR ${follows}))
        OR (${ns}.audience = 'followers' AND ${follows})
        OR (${ns}.audience = 'close_friends' AND ${follows}
            AND EXISTS (SELECT 1 FROM close_friends ncf WHERE ncf.owner_id = ${ns}.user_id AND ncf.friend_id = ${v}))
      ))
    )
  )`;
}

interface StatusRow {
  user_id: string;
  text: string;
  icon: string | null;
  audience: NowStatusAudience;
  expires_at: Date;
}

function toNowStatus(r: StatusRow, viewer: string | null): NowStatus {
  return {
    text: r.text,
    icon: (r.icon as NowStatusIcon | null) ?? null,
    expiresAt: r.expires_at.toISOString(),
    // Only the owner learns who a status is for.
    ...(r.user_id === viewer ? { audience: r.audience } : {}),
  };
}

/** The statuses of these people that the viewer may see, by person. */
export async function nowStatusesFor(db: Q, ownerIds: string[], viewer: string | null): Promise<Map<string, NowStatus>> {
  const ids = [...new Set(ownerIds)];
  if (!ids.length) return new Map();
  const { rows } = await db.query<StatusRow>(
    `SELECT ns.user_id, ns.text, ns.icon, ns.audience, ns.expires_at FROM profile_statuses ns
     WHERE ns.user_id = ANY($1::uuid[]) AND ${nowStatusVisibleSql('$2::uuid')}`,
    [ids, viewer],
  );
  return new Map(rows.map((r) => [r.user_id, toNowStatus(r, viewer)]));
}

/** Your own status, if it hasn't ended. */
export async function ownNowStatus(db: Q, userId: string): Promise<NowStatus | null> {
  const { rows } = await db.query<StatusRow>(
    `SELECT user_id, text, icon, audience, expires_at FROM profile_statuses WHERE user_id = $1 AND expires_at > now()`,
    [userId],
  );
  return rows[0] ? toNowStatus(rows[0], userId) : null;
}
