import type { PoolClient } from 'pg';

/** Remove a follow edge (any status) and keep denormalized counters correct. Returns true if a row existed. */
export async function removeFollow(
  tx: PoolClient,
  followerId: string,
  followeeId: string,
): Promise<boolean> {
  const { rows } = await tx.query<{ status: string }>(
    `DELETE FROM follows WHERE follower_id = $1 AND followee_id = $2 RETURNING status`,
    [followerId, followeeId],
  );
  if (!rows[0]) return false;
  if (rows[0].status === 'active') {
    await tx.query(
      `UPDATE profiles SET following_count = GREATEST(following_count - 1, 0) WHERE user_id = $1`,
      [followerId],
    );
    await tx.query(
      `UPDATE profiles SET follower_count = GREATEST(follower_count - 1, 0) WHERE user_id = $1`,
      [followeeId],
    );
  }
  return true;
}

/** Remove a friendship (pending or accepted) and fix counters. */
export async function removeFriendship(tx: PoolClient, a: string, b: string): Promise<boolean> {
  const { rows } = await tx.query<{ status: string }>(
    `DELETE FROM friendships WHERE user_low = LEAST($1::uuid,$2::uuid) AND user_high = GREATEST($1::uuid,$2::uuid) RETURNING status`,
    [a, b],
  );
  if (!rows[0]) return false;
  if (rows[0].status === 'accepted') {
    await tx.query(
      `UPDATE profiles SET friend_count = GREATEST(friend_count - 1, 0) WHERE user_id = ANY($1::uuid[])`,
      [[a, b]],
    );
  }
  return true;
}

export const sortPair = (a: string, b: string): [string, string] => (a < b ? [a, b] : [b, a]);

export const CARD_COLUMNS = `p.user_id AS id, p.username, p.display_name, p.avatar_url, p.mode, p.is_private`;
export const toCard = (r: Record<string, unknown>) => ({
  id: r.id as string,
  username: r.username as string,
  displayName: r.display_name as string,
  avatarUrl: (r.avatar_url as string | null) ?? null,
  mode: r.mode as string,
  isPrivate: r.is_private as boolean,
});
