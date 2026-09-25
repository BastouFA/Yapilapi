import type { Queryable } from '@yapilapi/database';
import { sellerPayable } from '@yapilapi/payments';
import { kAnonymizeCountries } from './rules.js';

/** A country appears in audience analytics only when at least this many people share it (see rules.kAnonymizeCountries). */
export const AUDIENCE_K = 20;

const dayStart = (days: number): Date => {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return new Date(d.getTime() - (days - 1) * 86_400_000);
};

/**
 * Creator dashboard. Every number comes from rows that exist (follows, posts and their counters, subscriptions, the ledger); nothing is
 * estimated. `views` is the post view counter as recorded by the platform: it is reported next to the engagement it is computed from.
 * Audience geography is aggregated with k-anonymity; there are no per-person breakdowns anywhere.
 */
export async function dashboard(db: Queryable, creatorId: string, days: number) {
  const since = dayStart(days);
  const [followers, growth, posts, top, subs, tiers, countries] = await Promise.all([
    db.query<{ total: number }>(
      `SELECT count(*)::int AS total FROM follows WHERE followee_id = $1 AND status = 'active'`,
      [creatorId],
    ),
    db.query<{ day: string; gained: number }>(
      `SELECT to_char(g.day, 'YYYY-MM-DD') AS day, COALESCE(c.n, 0)::int AS gained
         FROM generate_series($2::date, (now() AT TIME ZONE 'UTC')::date, interval '1 day') AS g(day)
         LEFT JOIN (SELECT (created_at AT TIME ZONE 'UTC')::date AS d, count(*) AS n FROM follows WHERE followee_id = $1 AND status = 'active' AND created_at >= $2 GROUP BY 1) c ON c.d = g.day::date
        ORDER BY g.day`,
      [creatorId, since],
    ),
    db.query<{
      posts: number;
      likes: number;
      comments: number;
      shares: number;
      saves: number;
      views: string;
    }>(
      `SELECT count(*)::int AS posts, COALESCE(sum(like_count),0)::int AS likes, COALESCE(sum(comment_count),0)::int AS comments, COALESCE(sum(share_count),0)::int AS shares,
              COALESCE(sum(save_count),0)::int AS saves, COALESCE(sum(view_count),0)::bigint AS views
         FROM posts WHERE author_id = $1 AND deleted_at IS NULL AND moderation_status = 'approved' AND created_at >= $2`,
      [creatorId, since],
    ),
    db.query<{
      id: string;
      kind: string;
      visibility: string;
      created_at: Date;
      like_count: number;
      comment_count: number;
      share_count: number;
      save_count: number;
      view_count: string;
      score: number;
    }>(
      `SELECT id, kind, visibility, created_at, like_count, comment_count, share_count, save_count, view_count, (like_count + 2 * comment_count + 3 * share_count + 2 * save_count) AS score
         FROM posts WHERE author_id = $1 AND deleted_at IS NULL AND moderation_status = 'approved' AND created_at >= $2 ORDER BY score DESC, created_at DESC LIMIT 5`,
      [creatorId, since],
    ),
    db.query<{ status: string; n: number }>(
      `SELECT status, count(*)::int AS n FROM subscriptions WHERE creator_id = $1 AND status IN ('active','past_due','incomplete') GROUP BY status`,
      [creatorId],
    ),
    db.query<{ tier: number; name: string; active: number }>(
      `SELECT sp.tier, sp.name, count(s.id) FILTER (WHERE s.status = 'active')::int AS active
         FROM subscription_plans sp LEFT JOIN subscriptions s ON s.plan_id = sp.id WHERE sp.creator_id = $1 AND sp.active GROUP BY sp.id ORDER BY sp.tier, sp.name`,
      [creatorId],
    ),
    db.query<{ country: string; n: number }>(
      `SELECT u.country_code AS country, count(*)::int AS n FROM follows f JOIN users u ON u.id = f.follower_id AND u.deleted_at IS NULL AND u.country_code IS NOT NULL
        WHERE f.followee_id = $1 AND f.status = 'active' GROUP BY 1`,
      [creatorId],
    ),
  ]);
  const p = posts.rows[0]!;
  const views = Number(p.views);
  const interactions = p.likes + p.comments + p.shares + p.saves;
  const audience = kAnonymizeCountries(
    countries.rows.map((r) => ({ country: r.country.toUpperCase(), count: r.n })),
    AUDIENCE_K,
  );
  return {
    window: { days, since: since.toISOString() },
    followers: {
      total: followers.rows[0]!.total,
      gained: growth.rows.reduce((n, r) => n + r.gained, 0),
      daily: growth.rows,
    },
    content: {
      posts: p.posts,
      views,
      likes: p.likes,
      comments: p.comments,
      shares: p.shares,
      saves: p.saves,
      engagementRate: views > 0 ? Math.round((interactions / views) * 10_000) / 10_000 : null,
      topPosts: top.rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        visibility: r.visibility,
        createdAt: r.created_at.toISOString(),
        likes: r.like_count,
        comments: r.comment_count,
        shares: r.share_count,
        saves: r.save_count,
        views: Number(r.view_count),
      })),
    },
    subscribers: {
      active: subs.rows.find((r) => r.status === 'active')?.n ?? 0,
      pastDue: subs.rows.find((r) => r.status === 'past_due')?.n ?? 0,
      byTier: tiers.rows.map((r) => ({ tier: r.tier, plan: r.name, active: r.active })),
    },
    audience: {
      countries: audience.countries.map((c) => ({ country: c.country, followers: c.count })),
      other: audience.other,
      minGroupSize: AUDIENCE_K,
    },
  };
}

/**
 * Revenue read from the LEDGER (the same source payouts use), split by what earned it. `net` is what lands in the creator's payable account
 * (gross minus platform fee); refunds and payouts are shown so `net - refunds - payouts + adjustments` matches the payable balance.
 */
export async function revenue(db: Queryable, creatorId: string, days: number) {
  const since = dayStart(days);
  const account = sellerPayable('user', creatorId);
  const [earned, affiliate, out, month] = await Promise.all([
    db.query<{
      purpose: string;
      currency: string;
      n: number;
      gross: string;
      fee: string;
      net: string;
    }>(
      `SELECT p.purpose, t.currency, count(*)::int AS n, sum(p.amount_cents)::bigint AS gross, sum(p.platform_fee_cents)::bigint AS fee, sum(e.amount_cents)::bigint AS net
         FROM ledger_transactions t
         JOIN ledger_entries e ON e.transaction_id = t.id AND e.account = $1 AND e.direction = 'credit'
         JOIN payments p ON p.id = t.ref_id
        WHERE t.kind = 'payment_captured' AND t.ref_type = 'payment' AND t.created_at >= $2 GROUP BY p.purpose, t.currency ORDER BY t.currency, p.purpose`,
      [account, since],
    ),
    db.query<{ currency: string; n: number; net: string }>(
      `SELECT t.currency, count(*)::int AS n, sum(e.amount_cents)::bigint AS net FROM ledger_transactions t JOIN ledger_entries e ON e.transaction_id = t.id AND e.account = $1 AND e.direction = 'credit'
        WHERE t.kind = 'fee' AND t.ref_type = 'affiliate_conversion' AND t.created_at >= $2 GROUP BY t.currency`,
      [account, since],
    ),
    db.query<{ kind: string; currency: string; amount: string }>(
      `SELECT t.kind, t.currency, sum(e.amount_cents)::bigint AS amount FROM ledger_transactions t JOIN ledger_entries e ON e.transaction_id = t.id AND e.account = $1 AND e.direction = 'debit'
        WHERE t.kind IN ('refund','payout','adjustment') AND t.created_at >= $2 GROUP BY t.kind, t.currency`,
      [account, since],
    ),
    db.query<{ currency: string; net: string }>(
      `SELECT t.currency, COALESCE(sum(CASE WHEN e.direction = 'credit' THEN e.amount_cents ELSE -e.amount_cents END), 0)::bigint AS net
         FROM ledger_entries e JOIN ledger_transactions t ON t.id = e.transaction_id WHERE e.account = $1 AND t.created_at >= date_trunc('month', now()) GROUP BY t.currency`,
      [account],
    ),
  ]);
  return {
    window: { days, since: since.toISOString() },
    earnings: earned.rows.map((r) => ({
      source: r.purpose,
      currency: r.currency,
      payments: r.n,
      grossCents: Number(r.gross),
      platformFeeCents: Number(r.fee),
      netCents: Number(r.net),
    })),
    affiliate: affiliate.rows.map((r) => ({
      currency: r.currency,
      conversions: r.n,
      netCents: Number(r.net),
    })),
    deductions: out.rows.map((r) => ({
      kind: r.kind,
      currency: r.currency,
      amountCents: Number(r.amount),
    })),
    thisMonth: month.rows.map((r) => ({ currency: r.currency, netCents: Number(r.net) })),
    note: 'Amounts come from the ledger. Payments still inside the hold period are counted as earned but are not yet available for payout.',
  };
}
