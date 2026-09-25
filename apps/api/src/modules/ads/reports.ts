import type { Queryable } from '@yapilapi/database';
import { z } from 'zod';
import { loadManagedCampaign } from './campaigns.js';

export const reportQuery = z.object({ days: z.coerce.number().int().min(1).max(365).default(30) });

/**
 * Advertiser report: AGGREGATES ONLY (no viewer identifiers, ever). Billable numbers come from valid events; filtered traffic is shown by reason so the
 * advertiser can see what they were not charged for. `billing` is what the ledger holds (settled) versus what is still accrued.
 */
export async function campaignReport(
  db: Queryable,
  userId: string,
  campaignId: string,
  days: number,
) {
  const c = await loadManagedCampaign(db, campaignId, userId);
  const since = new Date(Date.now() - days * 86_400_000);
  const q = async <T extends Record<string, unknown>>(sql: string): Promise<T[]> =>
    (await db.query<T>(sql, [campaignId, since])).rows;
  const [imp] = await q<{ valid: string; invalid: string; cost: string }>(
    `SELECT count(*) FILTER (WHERE valid) AS valid, count(*) FILTER (WHERE NOT valid) AS invalid, COALESCE(sum(cost_milli),0) AS cost FROM ad_impressions WHERE campaign_id = $1 AND created_at >= $2`,
  );
  const [clk] = await q<{ valid: string; invalid: string; cost: string }>(
    `SELECT count(*) FILTER (WHERE valid) AS valid, count(*) FILTER (WHERE NOT valid) AS invalid, COALESCE(sum(cost_milli),0) AS cost FROM ad_clicks WHERE campaign_id = $1 AND created_at >= $2`,
  );
  const filtered = await q<{ kind: string; reason: string; n: string }>(
    `SELECT 'impression' AS kind, reason, count(*) AS n FROM ad_impressions WHERE campaign_id = $1 AND created_at >= $2 AND NOT valid GROUP BY reason
     UNION ALL SELECT 'click', reason, count(*) FROM ad_clicks WHERE campaign_id = $1 AND created_at >= $2 AND NOT valid GROUP BY reason`,
  );
  const byDay = await q<{ day: string; impressions: string; clicks: string; cost: string }>(
    `SELECT d::date::text AS day,
            (SELECT count(*) FROM ad_impressions i WHERE i.campaign_id = $1 AND i.valid AND i.created_at::date = d::date) AS impressions,
            (SELECT count(*) FROM ad_clicks k WHERE k.campaign_id = $1 AND k.valid AND k.created_at::date = d::date) AS clicks,
            COALESCE((SELECT spent_milli FROM ad_daily_spend s WHERE s.campaign_id = $1 AND s.day = d::date), 0) AS cost
       FROM generate_series($2::date, now()::date, interval '1 day') d ORDER BY d`,
  );
  const byAd = await q<{
    ad_id: string;
    headline: string;
    impressions: string;
    clicks: string;
    cost: string;
  }>(
    `SELECT a.id AS ad_id, a.headline,
            (SELECT count(*) FROM ad_impressions i WHERE i.ad_id = a.id AND i.valid AND i.created_at >= $2) AS impressions,
            (SELECT count(*) FROM ad_clicks k WHERE k.ad_id = a.id AND k.valid AND k.created_at >= $2) AS clicks,
            COALESCE((SELECT sum(cost_milli) FROM ad_impressions i WHERE i.ad_id = a.id AND i.created_at >= $2), 0) + COALESCE((SELECT sum(cost_milli) FROM ad_clicks k WHERE k.ad_id = a.id AND k.created_at >= $2), 0) AS cost
       FROM advertisements a WHERE a.campaign_id = $1 ORDER BY a.created_at`,
  );
  const byPlacement = await q<{ placement: string; impressions: string; clicks: string }>(
    `SELECT i.placement, count(*) AS impressions, (SELECT count(*) FROM ad_clicks k WHERE k.impression_id IN (SELECT id FROM ad_impressions i2 WHERE i2.campaign_id = $1 AND i2.placement = i.placement AND i2.created_at >= $2) AND k.valid) AS clicks
       FROM ad_impressions i WHERE i.campaign_id = $1 AND i.valid AND i.created_at >= $2 GROUP BY i.placement ORDER BY i.placement`,
  );
  const [settled] = await db
    .query<{ cents: string }>(
      'SELECT COALESCE(sum(amount_cents),0) AS cents FROM ad_settlements WHERE campaign_id = $1',
      [campaignId],
    )
    .then((r) => r.rows);

  const impressions = Number(imp!.valid);
  const clicks = Number(clk!.valid);
  const spendMilli = Number(imp!.cost) + Number(clk!.cost);
  const cents = (m: number | string): number => Math.floor(Number(m) / 1000);
  return {
    campaignId,
    currency: c.currency,
    status: c.status,
    days,
    totals: {
      impressions,
      clicks,
      ctr: impressions ? Number((clicks / impressions).toFixed(4)) : 0,
      spendCents: cents(spendMilli),
      filteredImpressions: Number(imp!.invalid),
      filteredClicks: Number(clk!.invalid),
    },
    filteredByReason: filtered.map((f) => ({ kind: f.kind, reason: f.reason, count: Number(f.n) })),
    billing: {
      accruedCents: Math.floor(Number(c.spent_milli) / 1000),
      settledCents: Number(settled!.cents),
      unsettledCents: Math.floor(Number(c.spent_milli) / 1000) - Number(settled!.cents),
      note: 'Spend is booked as an amount owed; no payment is collected automatically.',
    },
    byDay: byDay.map((d) => ({
      day: d.day,
      impressions: Number(d.impressions),
      clicks: Number(d.clicks),
      spendCents: cents(d.cost),
    })),
    byAd: byAd.map((a) => ({
      adId: a.ad_id,
      headline: a.headline,
      impressions: Number(a.impressions),
      clicks: Number(a.clicks),
      spendCents: cents(a.cost),
    })),
    byPlacement: byPlacement.map((p) => ({
      placement: p.placement,
      impressions: Number(p.impressions),
      clicks: Number(p.clicks),
    })),
  };
}
