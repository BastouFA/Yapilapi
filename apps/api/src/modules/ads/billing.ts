import { withTransaction } from '@yapilapi/database';
import type { AppContext } from '../../lib/context.js';
import { audit } from '../../lib/audit.js';
import { postLedger } from '../payments/ledger.js';

export const PLATFORM_AD_REVENUE = 'platform:ad_revenue';
export const advertiserReceivable = (campaignId: string): string => `ad:receivable:${campaignId}`;

/**
 * Turn accrued spend into ledger entries. Spend accrues in milli-cents per valid event; settlement moves whole cents only, leaving the sub-cent
 * remainder accrued. Each settlement is ONE balanced transaction: debit the advertiser's receivable (an asset: what they owe us), credit platform ad revenue.
 *
 * HONEST SCOPE: this books what advertisers OWE. It does not charge a card or issue an invoice; collecting the money (prepaid balance, invoice, card on file)
 * is a separate billing feature that is not built (docs/architecture/ads.md). Idempotent: (kind, ref_type, ref_id) is unique in the ledger.
 */
export async function settleAdSpend(
  ctx: AppContext,
  opts: { campaignId?: string } = {},
): Promise<{ settlements: number; cents: number }> {
  const due = await ctx.db.query<{ id: string }>(
    `SELECT id FROM ad_campaigns WHERE spent_milli - settled_milli >= 1000 AND ($1::uuid IS NULL OR id = $1) ORDER BY id LIMIT 500`,
    [opts.campaignId ?? null],
  );
  let settlements = 0;
  let cents = 0;
  for (const d of due.rows) {
    const done = await withTransaction(ctx.db, async (tx) => {
      const c = (
        await tx.query<{
          id: string;
          currency: string;
          spent_milli: string;
          settled_milli: string;
        }>(
          'SELECT id, currency, spent_milli, settled_milli FROM ad_campaigns WHERE id = $1 FOR UPDATE',
          [d.id],
        )
      ).rows[0]!;
      const amount = Math.floor((Number(c.spent_milli) - Number(c.settled_milli)) / 1000);
      if (amount <= 0) return 0;
      const s = (
        await tx.query<{ id: string }>(
          'INSERT INTO ad_settlements (campaign_id, amount_cents, currency) VALUES ($1,$2,$3) RETURNING id',
          [c.id, amount, c.currency],
        )
      ).rows[0]!;
      await postLedger(tx, {
        kind: 'fee',
        refType: 'ad_settlement',
        refId: s.id,
        currency: c.currency,
        entries: [
          { account: advertiserReceivable(c.id), direction: 'debit', amount },
          { account: PLATFORM_AD_REVENUE, direction: 'credit', amount },
        ],
      });
      await tx.query('UPDATE ad_campaigns SET settled_milli = settled_milli + $2 WHERE id = $1', [
        c.id,
        amount * 1000,
      ]);
      await audit(
        ctx,
        {
          actorType: 'system',
          action: 'ads.spend_settled',
          targetType: 'ad_campaign',
          targetId: c.id,
          metadata: { settlementId: s.id, amountCents: amount, currency: c.currency },
        },
        undefined,
        tx,
      );
      return amount;
    });
    if (done > 0) {
      settlements += 1;
      cents += done;
    }
  }
  return { settlements, cents };
}

export interface AdsMaintenanceResult {
  ended: number;
  settlements: number;
  settledCents: number;
}
/** Scheduled job (scripts/ads-maintenance.ts): end campaigns past their end date or out of budget, then settle spend. Idempotent. */
export async function runAdsMaintenance(
  ctx: AppContext,
  opts: { now?: Date } = {},
): Promise<AdsMaintenanceResult> {
  const now = opts.now ?? new Date();
  const ended = await ctx.db.query<{ id: string }>(
    `UPDATE ad_campaigns SET status = 'ended' WHERE status IN ('active','paused') AND ((ends_at IS NOT NULL AND ends_at <= $1) OR spent_milli >= total_budget_cents * 1000) RETURNING id`,
    [now],
  );
  for (const r of ended.rows) {
    await ctx.db.query(
      `INSERT INTO ad_review_events (campaign_id, event, from_status, to_status, reason) VALUES ($1,'campaign_ended',NULL,'ended','schedule or budget reached')`,
      [r.id],
    );
    await audit(ctx, {
      actorType: 'system',
      action: 'ads.campaign_ended',
      targetType: 'ad_campaign',
      targetId: r.id,
      metadata: { reason: 'schedule_or_budget' },
    });
  }
  const s = await settleAdSpend(ctx);
  return { ended: ended.rows.length, settlements: s.settlements, settledCents: s.cents };
}
