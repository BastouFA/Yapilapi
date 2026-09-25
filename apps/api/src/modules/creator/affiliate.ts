import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { FastifyRequest } from 'fastify';
import { withTransaction, type Queryable } from '@yapilapi/database';
import { AppError, conflict, notFound } from '@yapilapi/shared';
import type { AppContext } from '../../lib/context.js';
import { audit } from '../../lib/audit.js';
import { shopperVisibleSql } from '../commerce/products.js';
import { postLedger, accountBalance } from '../payments/ledger.js';
import { requireCreator } from './profile.js';
import {
  ATTRIBUTION_WINDOW_DAYS,
  MAX_HITS_PER_VISITOR_DAY,
  clickVerdict,
  visitorHash,
  type ClickVerdict,
} from './rules.js';
import { sellerPayable } from '@yapilapi/payments';

export const linkBody = z.object({
  productId: z.uuid(),
  commissionBps: z.number().int().min(0).max(5000),
});
export const optInBody = z.object({ maxBps: z.number().int().min(0).max(5000) });

interface LinkRow {
  id: string;
  creator_id: string;
  product_id: string;
  code: string;
  commission_bps: number;
  active: boolean;
  created_at: Date;
}
const LC = 'id, creator_id, product_id, code, commission_bps, active, created_at';
export const linkView = (l: LinkRow, extra: Record<string, unknown> = {}) => ({
  id: l.id,
  productId: l.product_id,
  code: l.code,
  commissionBps: l.commission_bps,
  active: l.active,
  createdAt: l.created_at.toISOString(),
  ...extra,
});

const newCode = (): string =>
  randomBytes(6).toString('base64url').replace(/[-_]/g, 'x').toLowerCase();

/** Seller consent: a product offers affiliates up to `maxBps` (0 = none). Lowering it caps existing links at attribution time. */
export async function setProductAffiliateOptIn(
  ctx: AppContext,
  userId: string,
  productId: string,
  maxBps: number,
  req?: FastifyRequest,
): Promise<{ productId: string; maxBps: number }> {
  const { loadProductForSeller } = await import('../commerce/products.js');
  await loadProductForSeller(ctx.db, productId, userId, 'catalog');
  await ctx.db.query('UPDATE products SET affiliate_max_bps = $2 WHERE id = $1', [
    productId,
    maxBps,
  ]);
  await audit(
    ctx,
    {
      actorId: userId,
      action: 'product.affiliate_opt_in',
      targetType: 'product',
      targetId: productId,
      metadata: { maxBps },
    },
    req,
  );
  return { productId, maxBps };
}

export async function createLink(
  ctx: AppContext,
  creatorId: string,
  b: z.infer<typeof linkBody>,
  req?: FastifyRequest,
): Promise<LinkRow> {
  await requireCreator(ctx.db, creatorId);
  const p = (
    await ctx.db.query<{ affiliate_max_bps: number; seller_user_id: string | null; ok: boolean }>(
      `SELECT pd.affiliate_max_bps, pd.seller_user_id, ${shopperVisibleSql('$2::uuid')} AS ok FROM products pd WHERE pd.id = $1 AND pd.deleted_at IS NULL`,
      [b.productId, creatorId],
    )
  ).rows[0];
  if (!p || !p.ok) throw notFound('Product');
  if (p.seller_user_id === creatorId)
    throw new AppError('unprocessable', 'You cannot earn commission on your own product', {
      reason: 'own_product',
    });
  if (p.affiliate_max_bps <= 0)
    throw new AppError(
      'conflict',
      'The seller does not offer affiliate commission on this product',
      { reason: 'not_offered' },
    );
  if (b.commissionBps > p.affiliate_max_bps)
    throw new AppError(
      'unprocessable',
      `The seller offers at most ${p.affiliate_max_bps} bps on this product`,
      { reason: 'commission_too_high', maxBps: p.affiliate_max_bps },
    );
  for (let i = 0; i < 5; i++) {
    const r = await ctx.db.query<LinkRow>(
      `INSERT INTO affiliate_links (creator_id, product_id, code, commission_bps) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING ${LC}`,
      [creatorId, b.productId, newCode(), b.commissionBps],
    );
    if (r.rows[0]) {
      await audit(
        ctx,
        {
          actorId: creatorId,
          action: 'affiliate.link_created',
          targetType: 'affiliate_link',
          targetId: r.rows[0].id,
          metadata: { productId: b.productId, commissionBps: b.commissionBps },
        },
        req,
      );
      return r.rows[0];
    }
    const existing = await ctx.db.query<LinkRow>(
      `SELECT ${LC} FROM affiliate_links WHERE creator_id = $1 AND product_id = $2`,
      [creatorId, b.productId],
    );
    if (existing.rows[0])
      throw conflict('You already have a link for this product', {
        reason: 'link_exists',
        linkId: existing.rows[0].id,
      });
  }
  throw new AppError('internal', 'Could not allocate a link code');
}

export async function setLinkActive(
  ctx: AppContext,
  creatorId: string,
  id: string,
  active: boolean,
  req?: FastifyRequest,
): Promise<LinkRow> {
  const { rows } = await ctx.db.query<LinkRow>(
    `UPDATE affiliate_links SET active = $3 WHERE id = $1 AND creator_id = $2 RETURNING ${LC}`,
    [id, creatorId, active],
  );
  if (!rows[0]) throw notFound('Link');
  await audit(
    ctx,
    {
      actorId: creatorId,
      action: active ? 'affiliate.link_enabled' : 'affiliate.link_disabled',
      targetType: 'affiliate_link',
      targetId: id,
    },
    req,
  );
  return rows[0];
}

// ------------------------------------------------------------------ clicks
export interface ClickResult {
  productId: string;
  counted: boolean;
  verdict: ClickVerdict;
}

/**
 * Record a click on an affiliate link. Never trusts the client: bots (user agent), self clicks and floods are recorded with a verdict and not counted;
 * one visitor (HMAC of ip + user agent + UTC day) counts once per link per day (`hits` keeps the raw number). The visitor hash is not comparable across days
 * and no address is stored. Logged-in visitors are remembered by user id so a later purchase can be attributed.
 */
export async function recordClick(
  ctx: AppContext,
  code: string,
  v: { ip: string; userAgent: string | undefined; viewerId: string | null },
): Promise<ClickResult> {
  const link = (
    await ctx.db.query<LinkRow & { ok: boolean }>(
      `SELECT l.id, l.creator_id, l.product_id, l.code, l.commission_bps, l.active, l.created_at,
            (l.active AND pd.deleted_at IS NULL AND pd.status IN ('active','sold_out') AND pd.affiliate_max_bps > 0 AND EXISTS (SELECT 1 FROM creators c WHERE c.user_id = l.creator_id AND c.status = 'active')) AS ok
       FROM affiliate_links l JOIN products pd ON pd.id = l.product_id WHERE l.code = $1`,
      [code.toLowerCase()],
    )
  ).rows[0];
  if (!link || !link.ok) throw notFound('Link');
  const day = new Date().toISOString().slice(0, 10);
  const vh = visitorHash(
    ctx.config.IP_HASH_SALT ?? ctx.config.webhookSigningSecret,
    v.ip,
    v.userAgent ?? '',
    day,
  );
  const initial = clickVerdict({
    userAgent: v.userAgent,
    viewerId: v.viewerId,
    creatorId: link.creator_id,
    hitsToday: 1,
  });
  const { rows } = await ctx.db.query<{ verdict: ClickVerdict; hits: number }>(
    `INSERT INTO affiliate_clicks (link_id, visitor_hash, day, viewer_id, verdict) VALUES ($1,$2,$3::date,$4,$5)
     ON CONFLICT (link_id, visitor_hash, day) DO UPDATE SET hits = affiliate_clicks.hits + 1, last_at = now(), viewer_id = COALESCE(affiliate_clicks.viewer_id, EXCLUDED.viewer_id),
       verdict = CASE WHEN affiliate_clicks.verdict = 'counted' AND affiliate_clicks.hits + 1 > $6 THEN 'excessive' ELSE affiliate_clicks.verdict END
     RETURNING verdict, hits`,
    [link.id, vh, day, v.viewerId, initial, MAX_HITS_PER_VISITOR_DAY],
  );
  const r = rows[0]!;
  return {
    productId: link.product_id,
    counted: r.verdict === 'counted' && r.hits === 1,
    verdict: r.verdict,
  };
}

// ------------------------------------------------------------------ conversions
export interface AttributionResult {
  attributed: number;
  reversed: number;
  settled: number;
}

const PAID_ORDER = ['paid', 'fulfilled', 'completed', 'partially_refunded'];

/**
 * Read-only on commerce data: finds PAID order lines (orders / order_items are only ever read here) of products with an affiliate link whose buyer
 * has a counted click on that link within ATTRIBUTION_WINDOW_DAYS before the order (last click wins), and records ONE conversion per order line.
 * Self purchases (creator = buyer) and inactive/suspended creators never convert. The commission is capped by what the seller still offers.
 */
export async function attributeConversions(
  ctx: AppContext,
  opts: { creatorId?: string } = {},
): Promise<number> {
  const { rows } = await ctx.db.query<{ n: number }>(
    `WITH cand AS (
       SELECT DISTINCT ON (oi.id) oi.id AS order_item_id, oi.order_id, oi.quantity, oi.unit_price_cents, o.buyer_id, o.seller_user_id, o.seller_business_id, o.currency,
              l.id AS link_id, l.creator_id, LEAST(l.commission_bps, pd.affiliate_max_bps) AS bps, c.day AS click_day
         FROM order_items oi
         JOIN orders o ON o.id = oi.order_id AND o.status = ANY($1::text[]) AND o.paid_at IS NOT NULL
         JOIN products pd ON pd.id = oi.product_id
         JOIN affiliate_links l ON l.product_id = oi.product_id AND l.active
         JOIN creators cr ON cr.user_id = l.creator_id AND cr.status = 'active'
         JOIN affiliate_clicks c ON c.link_id = l.id AND c.viewer_id = o.buyer_id AND c.verdict = 'counted'
              AND c.day <= o.created_at::date AND c.day >= (o.created_at::date - $2::int)
        WHERE oi.item_type = 'product' AND l.creator_id <> o.buyer_id AND ($3::uuid IS NULL OR l.creator_id = $3)
          AND NOT EXISTS (SELECT 1 FROM affiliate_conversions ac WHERE ac.order_item_id = oi.id)
        ORDER BY oi.id, c.day DESC, l.created_at DESC
     ), ins AS (
       INSERT INTO affiliate_conversions (link_id, creator_id, order_id, order_item_id, buyer_id, seller_user_id, seller_business_id, line_cents, commission_bps, commission_cents, currency, click_day)
       SELECT link_id, creator_id, order_id, order_item_id, buyer_id, seller_user_id, seller_business_id, quantity * unit_price_cents, bps, (quantity * unit_price_cents * bps) / 10000, currency, click_day FROM cand
       ON CONFLICT (order_item_id) DO NOTHING RETURNING 1
     ) SELECT count(*)::int AS n FROM ins`,
    [PAID_ORDER, ATTRIBUTION_WINDOW_DAYS, opts.creatorId ?? null],
  );
  return rows[0]!.n;
}

/**
 * pending -> settled | reversed. A conversion settles once the order line has matured (PAYOUT_HOLD_DAYS after payment, or the order completed) and
 * NOTHING of it was refunded: ledger `fee` transaction debiting the seller's payable and crediting the creator's (idempotent per conversion; skipped while
 * the seller's balance cannot cover it). A refund before settlement reverses the conversion. Clawback after settlement is not implemented (documented).
 */
export async function settleConversions(
  ctx: AppContext,
  opts: { creatorId?: string; now?: Date } = {},
): Promise<{ settled: number; reversed: number }> {
  const now = opts.now ?? new Date();
  const cutoff = new Date(now.getTime() - ctx.config.PAYOUT_HOLD_DAYS * 86_400_000);
  const rev = await ctx.db.query(
    `UPDATE affiliate_conversions ac SET status = 'reversed' FROM order_items oi JOIN orders o ON o.id = oi.order_id
      WHERE ac.order_item_id = oi.id AND ac.status = 'pending' AND ($1::uuid IS NULL OR ac.creator_id = $1)
        AND (oi.refunded_cents > 0 OR o.status IN ('refunded','cancelled','disputed'))`,
    [opts.creatorId ?? null],
  );
  const { rows } = await ctx.db.query<{
    id: string;
    creator_id: string;
    seller_user_id: string | null;
    seller_business_id: string | null;
    commission_cents: number;
    currency: string;
  }>(
    `SELECT ac.id, ac.creator_id, ac.seller_user_id, ac.seller_business_id, ac.commission_cents, ac.currency
       FROM affiliate_conversions ac JOIN order_items oi ON oi.id = ac.order_item_id JOIN orders o ON o.id = oi.order_id
      WHERE ac.status = 'pending' AND ($1::uuid IS NULL OR ac.creator_id = $1) AND oi.refunded_cents = 0 AND o.status IN ('paid','fulfilled','completed')
        AND (o.status = 'completed' OR o.paid_at <= $2) ORDER BY ac.created_at LIMIT 500`,
    [opts.creatorId ?? null, cutoff],
  );
  let settled = 0;
  for (const c of rows) {
    if (c.commission_cents <= 0) {
      await ctx.db.query(
        `UPDATE affiliate_conversions SET status = 'reversed' WHERE id = $1 AND status = 'pending'`,
        [c.id],
      );
      continue;
    }
    const sellerAccount = sellerPayable(
      c.seller_business_id ? 'business' : 'user',
      (c.seller_business_id ?? c.seller_user_id)!,
    );
    const ok = await withTransaction(ctx.db, async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `ledger:${sellerAccount}`,
      ]);
      const cur = (
        await tx.query<{ status: string }>(
          'SELECT status FROM affiliate_conversions WHERE id = $1 FOR UPDATE',
          [c.id],
        )
      ).rows[0];
      if (cur?.status !== 'pending') return false;
      if ((await accountBalance(tx, sellerAccount, c.currency)) < c.commission_cents) return false; // not covered right now: try again next run
      await postLedger(tx, {
        kind: 'fee',
        refType: 'affiliate_conversion',
        refId: c.id,
        currency: c.currency,
        entries: [
          { account: sellerAccount, direction: 'debit', amount: c.commission_cents },
          {
            account: sellerPayable('user', c.creator_id),
            direction: 'credit',
            amount: c.commission_cents,
          },
        ],
      });
      await tx.query(
        `UPDATE affiliate_conversions SET status = 'settled', settled_at = now() WHERE id = $1`,
        [c.id],
      );
      await audit(
        ctx,
        {
          actorType: 'system',
          action: 'affiliate.commission_settled',
          targetType: 'affiliate_conversion',
          targetId: c.id,
          metadata: {
            creatorId: c.creator_id,
            amountCents: c.commission_cents,
            currency: c.currency,
          },
        },
        undefined,
        tx,
      );
      return true;
    });
    if (ok) settled += 1;
  }
  return { settled, reversed: rev.rowCount ?? 0 };
}

export async function affiliateStats(db: Queryable, creatorId: string) {
  const { rows } = await db.query(
    `SELECT l.id, l.product_id, l.code, l.commission_bps, l.active, l.created_at,
            COALESCE((SELECT count(*) FROM affiliate_clicks c WHERE c.link_id = l.id AND c.verdict = 'counted'), 0)::int AS counted_clicks,
            COALESCE((SELECT sum(c.hits) FROM affiliate_clicks c WHERE c.link_id = l.id), 0)::int AS raw_hits,
            COALESCE((SELECT count(*) FROM affiliate_clicks c WHERE c.link_id = l.id AND c.verdict IN ('bot','excessive')), 0)::int AS rejected_clicks,
            COALESCE((SELECT count(*) FROM affiliate_conversions a WHERE a.link_id = l.id AND a.status <> 'reversed'), 0)::int AS conversions,
            COALESCE((SELECT sum(a.commission_cents) FROM affiliate_conversions a WHERE a.link_id = l.id AND a.status = 'pending'), 0)::bigint AS pending_cents,
            COALESCE((SELECT sum(a.commission_cents) FROM affiliate_conversions a WHERE a.link_id = l.id AND a.status = 'settled'), 0)::bigint AS settled_cents
       FROM affiliate_links l WHERE l.creator_id = $1 ORDER BY l.created_at DESC`,
    [creatorId],
  );
  return rows.map((r) =>
    linkView(r as LinkRow, {
      clicks: { counted: r.counted_clicks, rawHits: r.raw_hits, rejected: r.rejected_clicks },
      conversions: r.conversions,
      commissionCents: { pending: Number(r.pending_cents), settled: Number(r.settled_cents) },
    }),
  );
}

export async function listConversions(db: Queryable, creatorId: string) {
  const { rows } = await db.query(
    `SELECT id, link_id, order_id, line_cents, commission_bps, commission_cents, currency, status, created_at, settled_at FROM affiliate_conversions WHERE creator_id = $1 ORDER BY created_at DESC, id DESC LIMIT 100`,
    [creatorId],
  );
  return rows.map((r) => ({
    id: r.id as string,
    linkId: r.link_id as string,
    lineCents: Number(r.line_cents),
    commissionBps: r.commission_bps as number,
    commissionCents: Number(r.commission_cents),
    currency: r.currency as string,
    status: r.status as string,
    createdAt: (r.created_at as Date).toISOString(),
    settledAt: r.settled_at ? (r.settled_at as Date).toISOString() : null,
  }));
}
