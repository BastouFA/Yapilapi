import type { PoolClient } from 'pg';
import { withTransaction } from '@yapilapi/database';
import type { AppContext } from '../../lib/context.js';
import { audit } from '../../lib/audit.js';
import { getDeletionHooks, registerDeletionHook } from '../../lib/hooks.js';

/**
 * Account deletion finalizer. Schedules are created by POST /v1/account/deletion (auth module): the account becomes
 * `pending_deletion` with a 14-day grace period during which the user can cancel. When the grace period ends,
 * `finalizeDueDeletions` (run by scripts/finalize-deletions.ts every few minutes) does, per account and in ONE
 * transaction:
 *   1. runs every registered deletion hook (lib/hooks.ts): each module removes or anonymises the data it owns
 *   2. anonymises the users/profiles rows (the row stays, so foreign keys from financial/safety records remain valid)
 *   3. deletes credentials (sessions, MFA, tokens, devices, identities, passkeys, push tokens)
 *   4. completes the privacy request
 * If anything throws, the transaction rolls back and the account stays `pending_deletion` for the next run.
 *
 * What is RETAINED, and why (documented in docs/security/privacy.md): audit logs and consent evidence (pseudonymous ids
 * only), moderation cases/enforcements/appeals and reports (safety and legal obligations), orders/payments/ledger entries
 * (financial record keeping; the address on orders is erased), and other users' content that merely references the account.
 */

type Tx = PoolClient;

/** Hook for tables owned by modules that do not register their own deletion hook (messaging, graph, moments, AI, ...). */
async function coreDeletionHook(_ctx: AppContext, tx: Tx, userId: string): Promise<void> {
  // ---- messaging: sent messages are blanked (the other participants keep a "deleted message" placeholder); membership ends
  await tx.query(
    `UPDATE messages SET body = '', metadata = '{}'::jsonb, deleted_at = COALESCE(deleted_at, now()) WHERE sender_id = $1`,
    [userId],
  );
  await tx.query('DELETE FROM message_poll_votes WHERE user_id = $1', [userId]);
  await tx.query(
    'UPDATE conversation_members SET left_at = COALESCE(left_at, now()) WHERE user_id = $1',
    [userId],
  );
  await tx.query('DELETE FROM call_participants WHERE user_id = $1', [userId]);
  await tx.query('DELETE FROM plan_participants WHERE user_id = $1', [userId]);

  // ---- social graph, with denormalised counters kept correct for the OTHER side
  const following = await tx.query<{ followee_id: string; status: string }>(
    'DELETE FROM follows WHERE follower_id = $1 RETURNING followee_id, status',
    [userId],
  );
  for (const f of following.rows)
    if (f.status === 'active')
      await tx.query(
        'UPDATE profiles SET follower_count = GREATEST(follower_count - 1, 0) WHERE user_id = $1',
        [f.followee_id],
      );
  const followers = await tx.query<{ follower_id: string; status: string }>(
    'DELETE FROM follows WHERE followee_id = $1 RETURNING follower_id, status',
    [userId],
  );
  for (const f of followers.rows)
    if (f.status === 'active')
      await tx.query(
        'UPDATE profiles SET following_count = GREATEST(following_count - 1, 0) WHERE user_id = $1',
        [f.follower_id],
      );
  const friends = await tx.query<{ user_low: string; user_high: string; status: string }>(
    'DELETE FROM friendships WHERE user_low = $1 OR user_high = $1 RETURNING user_low, user_high, status',
    [userId],
  );
  for (const f of friends.rows) {
    if (f.status === 'accepted')
      await tx.query(
        'UPDATE profiles SET friend_count = GREATEST(friend_count - 1, 0) WHERE user_id = $1',
        [f.user_low === userId ? f.user_high : f.user_low],
      );
  }
  // Circles are kept (deleting one would null circle_id on posts and violate their visibility constraint) but emptied and unnamed.
  await tx.query(
    'DELETE FROM circle_members WHERE user_id = $1 OR circle_id IN (SELECT id FROM circles WHERE owner_id = $1)',
    [userId],
  );
  await tx.query('UPDATE circles SET name = id::text WHERE owner_id = $1', [userId]);
  await tx.query('DELETE FROM user_blocks WHERE blocker_id = $1', [userId]); // blocks AGAINST the account stay: they protect other people
  await tx.query('DELETE FROM user_mutes WHERE muter_id = $1 OR muted_id = $1', [userId]);
  await tx.query('DELETE FROM user_restrictions WHERE restrictor_id = $1 OR restricted_id = $1', [
    userId,
  ]);
  await tx.query('DELETE FROM user_interests WHERE user_id = $1', [userId]);
  await tx.query('DELETE FROM topic_mutes WHERE user_id = $1', [userId]);
  await tx.query('DELETE FROM poll_votes WHERE user_id = $1', [userId]);

  // ---- ephemeral / personal content
  await tx.query(
    `UPDATE moments SET body = '', music = NULL, latitude = NULL, longitude = NULL, deleted_at = COALESCE(deleted_at, now()) WHERE author_id = $1`,
    [userId],
  );
  await tx.query(
    `UPDATE real_captures SET caption = '', latitude = NULL, longitude = NULL, deleted_at = COALESCE(deleted_at, now()) WHERE author_id = $1`,
    [userId],
  );
  await tx.query(
    `UPDATE memories SET deleted_at = COALESCE(deleted_at, now()) WHERE owner_id = $1`,
    [userId],
  );
  await tx.query('DELETE FROM shared_experience_contributions WHERE contributor_id = $1', [userId]);
  await tx.query(`DELETE FROM shared_experience_members WHERE user_id = $1`, [userId]);
  await tx.query(
    `UPDATE reviews SET body = '', deleted_at = COALESCE(deleted_at, now()) WHERE author_id = $1`,
    [userId],
  );
  await tx.query('DELETE FROM recommendation_feedback WHERE user_id = $1', [userId]);
  await tx.query('DELETE FROM user_topic_affinity WHERE user_id = $1', [userId]);

  // ---- AI (memory, conversations, drafts, tool audit)
  await tx.query('DELETE FROM ai_conversations WHERE user_id = $1', [userId]); // cascades ai_messages
  await tx.query('DELETE FROM ai_memories WHERE user_id = $1', [userId]);
  await tx.query('DELETE FROM ai_artifacts WHERE user_id = $1', [userId]);
  await tx.query('DELETE FROM ai_tool_calls WHERE user_id = $1', [userId]);

  // ---- commerce: keep the financial record, erase the personal address; close creator payout link
  await tx.query('UPDATE orders SET shipping_address = NULL WHERE buyer_id = $1', [userId]);
  await tx.query(
    `UPDATE creators SET status = 'closed', payout_account_ref = NULL WHERE user_id = $1`,
    [userId],
  );

  // ---- developer platform
  await tx.query('DELETE FROM oauth_grants WHERE user_id = $1', [userId]); // cascades tokens
  await tx.query('DELETE FROM developer_apps WHERE owner_id = $1', [userId]); // cascades keys, webhooks, deliveries, mini apps
  await tx.query('DELETE FROM mini_app_installs WHERE user_id = $1', [userId]);

  // ---- notifications, preferences, attention controls, privacy artefacts
  await tx.query('DELETE FROM notifications WHERE user_id = $1', [userId]);
  await tx.query('DELETE FROM notification_preferences WHERE user_id = $1', [userId]);
  await tx.query('DELETE FROM email_digest_log WHERE user_id = $1', [userId]);
  await tx.query('DELETE FROM user_preferences WHERE user_id = $1', [userId]);
  await tx.query('DELETE FROM ad_preferences WHERE user_id = $1', [userId]);
  await tx.query('DELETE FROM privacy_exports WHERE user_id = $1', [userId]);
  await tx.query('DELETE FROM guardian_links WHERE minor_id = $1 OR guardian_id = $1', [userId]);
  await tx.query('DELETE FROM feature_flag_overrides WHERE user_id = $1', [userId]);
  await tx.query('DELETE FROM admin_user_notes WHERE user_id = $1', [userId]);
  // Analytics: detach (aggregates survive, attribution does not).
  await tx.query('UPDATE analytics_events SET user_id = NULL WHERE user_id = $1', [userId]);
}

let registered = false;
export function registerPrivacyHooks(): void {
  if (registered) return;
  registered = true;
  registerDeletionHook(coreDeletionHook);
}

export interface FinalizeResult {
  finalized: number;
  failed: Array<{ userId: string; error: string }>;
}

async function finalizeOne(ctx: AppContext, tx: Tx, userId: string, now: Date): Promise<boolean> {
  const locked = await tx.query<{ status: string; email: string }>(
    `SELECT status, email FROM users WHERE id = $1 AND deleted_at IS NULL AND status = 'pending_deletion' AND deletion_scheduled_for <= $2 FOR UPDATE`,
    [userId, now],
  );
  if (!locked.rows[0]) return false; // cancelled or already finalized since the scan
  await tx.query(
    `UPDATE privacy_requests SET status = 'processing', updated_at = now() WHERE user_id = $1 AND kind = 'delete' AND status = 'pending'`,
    [userId],
  );

  for (const hook of getDeletionHooks()) await hook(ctx, tx, userId);

  // credentials and devices
  for (const table of [
    'sessions',
    'mfa_factors',
    'mfa_recovery_codes',
    'mfa_challenges',
    'one_time_tokens',
    'devices',
    'identities',
    'passkey_credentials',
    'push_tokens',
    'security_events',
  ]) {
    await tx.query(`DELETE FROM ${table} WHERE user_id = $1`, [userId]);
  }
  await tx.query('DELETE FROM ws_tickets WHERE user_id = $1', [userId]);

  await tx.query(
    `UPDATE users SET email = 'deleted+' || id::text || '@deleted.invalid', email_verified_at = NULL, password_hash = NULL, status = 'deleted', deleted_at = now(),
            birth_date = date_trunc('year', birth_date)::date, country_code = NULL, mfa_enabled = false, failed_login_count = 0, locked_until = NULL, last_login_at = NULL
      WHERE id = $1`,
    [userId],
  );
  await tx.query(
    `UPDATE profiles SET username = 'deleted_' || substr(replace(user_id::text, '-', ''), 1, 12), display_name = 'Deleted user', bio = '', avatar_url = NULL, cover_url = NULL,
            links = '[]'::jsonb, location_text = NULL, is_private = true, onboarding_completed_at = NULL
      WHERE user_id = $1`,
    [userId],
  );
  await tx.query(
    `UPDATE privacy_requests SET status = 'completed', completed_at = now(), updated_at = now(), result = COALESCE(result, '{}'::jsonb) || $2::jsonb
      WHERE user_id = $1 AND kind = 'delete' AND status IN ('pending','processing')`,
    [userId, JSON.stringify({ finalizedAt: now.toISOString(), hooks: getDeletionHooks().length })],
  );
  await audit(
    ctx,
    {
      actorType: 'system',
      action: 'account.deleted',
      targetType: 'user',
      targetId: userId,
      metadata: { hooks: getDeletionHooks().length },
    },
    undefined,
    tx,
  );
  return true;
}

/**
 * Finalize every account whose deletion grace period has ended. Idempotent and safe to run concurrently (row locks +
 * re-checks). One account failing never blocks the others.
 */
export async function finalizeDueDeletions(
  ctx: AppContext,
  opts: { now?: Date; limit?: number } = {},
): Promise<FinalizeResult> {
  const now = opts.now ?? new Date();
  const due = await ctx.db.query<{ id: string }>(
    `SELECT id FROM users WHERE status = 'pending_deletion' AND deleted_at IS NULL AND deletion_scheduled_for <= $1 ORDER BY deletion_scheduled_for LIMIT $2`,
    [now, opts.limit ?? 100],
  );
  const result: FinalizeResult = { finalized: 0, failed: [] };
  for (const { id } of due.rows) {
    try {
      const done = await withTransaction(ctx.db, (tx) => finalizeOne(ctx, tx, id, now));
      if (done) result.finalized++;
    } catch (err) {
      ctx.log.error({ err, userId: id }, 'account deletion failed; will retry');
      result.failed.push({ userId: id, error: (err as Error).message.slice(0, 200) });
    }
  }
  return result;
}
