import type { Queryable } from '@yapilapi/database';
import type { AppContext } from '../../lib/context.js';

/**
 * Does `userId` hold an entitling subscription to `creatorId` right now (optionally of at least plan tier `tier`)?
 * Same rule as the SQL branch in lib/visibility.ts (`postVisibleSql`, visibility 'subscribers'): status `active` (with a one day slack for a
 * late renewal job) or `past_due` inside the dunning grace period. Use this in every non-SQL path that gates subscriber-only things
 * (live sessions for subscribers, downloads, chat perks). The creator themself is always entitled to their own content.
 */
export async function hasActiveSubscription(
  ctx: Pick<AppContext, 'db'>,
  userId: string,
  creatorId: string,
  tier?: number,
  db: Queryable = ctx.db,
): Promise<boolean> {
  if (userId === creatorId) return true;
  const { rows } = await db.query(
    `SELECT 1 FROM subscriptions sb JOIN subscription_plans sp ON sp.id = sb.plan_id
      WHERE sb.subscriber_id = $1 AND sb.creator_id = $2
        AND ((sb.status = 'active' AND sb.current_period_end + interval '1 day' > now()) OR (sb.status = 'past_due' AND sb.current_period_end + interval '3 days' > now()))
        AND sp.tier >= $3 LIMIT 1`,
    [userId, creatorId, tier ?? 1],
  );
  return rows.length > 0;
}
