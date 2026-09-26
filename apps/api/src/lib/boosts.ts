import type { Pool, PoolClient } from 'pg';
import { tx } from '@yapilapi/database';
import { refundUnspentBudget } from './ad-refunds.ts';
import { analyzeText } from './moderation.ts';
import type { PaymentRegistry } from './payments.ts';
import { audit } from './services.ts';

/**
 * A boost goes to the same ad review as any campaign as soon as its budget is
 * paid (called from the payment webhook). Clearly unsafe posts, and posts that
 * are no longer public, are turned down straight away and the budget goes
 * back. Anything else waits for a moderator, who starts it by approving it.
 * Call inside a transaction. Does nothing for campaigns that aren't boosts or
 * have already been submitted.
 */
export async function submitBoostForReview(c: PoolClient, payments: PaymentRegistry, campaignId: string): Promise<'pending_review' | 'rejected' | null> {
  const camp = (await c.query(`SELECT id, advertiser_id, post_id, name, status, boost_days FROM ad_campaigns WHERE id = $1 FOR UPDATE`, [campaignId])).rows[0];
  if (!camp || camp.status !== 'draft' || camp.boost_days === null) return null;
  const post = (await c.query(`SELECT body, visibility, moderation_status, deleted_at FROM posts WHERE id = $1`, [camp.post_id])).rows[0];
  const risk = post ? analyzeText(post.body).risk : 'escalate';
  if (!post || post.deleted_at || post.visibility !== 'public' || post.moderation_status !== 'normal' || risk === 'escalate') {
    await c.query(`UPDATE ad_campaigns SET status = 'rejected', review_note = $2 WHERE id = $1`, [
      campaignId,
      !post || post.deleted_at || post.visibility !== 'public'
        ? "The post is no longer public, so it can't be boosted. Your budget has been refunded."
        : "This post can't be boosted because it may break the advertising rules. Your budget has been refunded.",
    ]);
    await refundUnspentBudget(c, payments, campaignId, null);
    await audit(c, { action: 'ads.boost.auto_rejected', entityType: 'ad_campaign', entityId: campaignId, metadata: { risk } });
    return 'rejected';
  }
  const mc = await c.query(
    `INSERT INTO moderation_cases (target_type, target_id, subject_user_id, source, risk, signals) VALUES ('ad_campaign', $1, $2, 'ad_review', $3, $4)
     ON CONFLICT (target_type, target_id) WHERE status = 'open' DO UPDATE SET created_at = moderation_cases.created_at RETURNING id`,
    [campaignId, camp.advertiser_id, risk, { postId: camp.post_id, name: camp.name, boost: true }],
  );
  await c.query(`UPDATE ad_campaigns SET status = 'pending_review', submitted_at = now(), review_note = NULL, review_case_id = $2 WHERE id = $1`, [
    campaignId,
    mc.rows[0].id,
  ]);
  await audit(c, { actorId: camp.advertiser_id, action: 'ads.boost.submitted', entityType: 'ad_campaign', entityId: campaignId });
  return 'pending_review';
}

/**
 * Campaigns (boosts included) whose end date has passed are ended, and what
 * they didn't spend goes back to the advertiser, as when they end a campaign
 * themselves. Run periodically by the job worker. Returns how many ended.
 */
export async function endExpiredCampaigns(db: Pool, payments: PaymentRegistry, limit = 50): Promise<number> {
  const due = await db.query<{ id: string }>(
    `SELECT id FROM ad_campaigns WHERE status IN ('active', 'paused') AND ends_at IS NOT NULL AND ends_at <= now() ORDER BY ends_at LIMIT $1`,
    [limit],
  );
  let ended = 0;
  for (const { id } of due.rows)
    await tx(db, async (c) => {
      const r = await c.query(`UPDATE ad_campaigns SET status = 'ended' WHERE id = $1 AND status IN ('active', 'paused') AND ends_at <= now()`, [id]);
      if (!r.rowCount) return;
      await refundUnspentBudget(c, payments, id, null);
      ended++;
    });
  return ended;
}
