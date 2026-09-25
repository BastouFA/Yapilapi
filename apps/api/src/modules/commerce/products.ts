import { z } from 'zod';
import { withTransaction, type Queryable, type Tx } from '@yapilapi/database';
import { AppError, conflict, forbidden, invalid, notFound } from '@yapilapi/shared';
import { normalizeCurrency, MoneyError } from '@yapilapi/payments';
import type { AppContext } from '../../lib/context.js';
import { audit } from '../../lib/audit.js';
import { assertOwnedImage } from '../../lib/media-check.js';
import { mediaUrl } from '../../lib/media-url.js';
import { screenText } from '../../lib/moderation-hook.js';
import { assertTextAllowed } from '../../lib/text-guard.js';
import {
  activeUserSql,
  businessVisibleSql,
  notBlockedSql,
  teenAllowedSql,
} from '../search/guards.js';
import { hasSellerAccess, productSeller, requireSellerAccess, type SellerNeed } from './access.js';
import type { Payee } from '../payments/ledger.js';
import { getBusinessAccess } from '../business/access.js';

export const PRODUCT_KINDS = ['physical', 'service', 'digital', 'booking'] as const;
export const currencySchema = z
  .string()
  .trim()
  .transform((s, ctx) => {
    try {
      return normalizeCurrency(s);
    } catch (e) {
      ctx.addIssue({
        code: 'custom',
        message: e instanceof MoneyError ? e.message : 'Invalid currency',
      });
      return z.NEVER;
    }
  });

const MAX_PRICE = 1_000_000_000;

export const deliverySchema = z.object({
  methods: z.array(z.string().trim().min(1).max(40)).max(10).default([]),
  estimateDays: z.number().int().min(0).max(365).optional(),
  /** Flat shipping per physical product line (a placeholder: no carrier rates). */
  shippingCents: z.number().int().min(0).max(10_000_000).default(0),
});

export const productCreateBody = z.object({
  kind: z.enum(PRODUCT_KINDS),
  title: z.string().trim().min(2).max(160),
  description: z.string().trim().max(10_000).default(''),
  priceCents: z.number().int().min(1).max(MAX_PRICE),
  currency: currencySchema,
  stock: z.number().int().min(0).max(1_000_000).nullable().optional(),
  delivery: deliverySchema.default({ methods: [], shippingCents: 0 }),
  returnsPolicy: z.string().trim().max(2000).default(''),
  /** Seller-declared flat tax rate in basis points, added on top of the price. NOT a tax engine (see docs). */
  taxBps: z.number().int().min(0).max(3000).default(0),
  businessId: z.uuid().optional(),
  status: z.enum(['draft', 'active']).default('draft'),
});

export const productPatchBody = z
  .object({
    title: z.string().trim().min(2).max(160),
    description: z.string().trim().max(10_000),
    priceCents: z.number().int().min(1).max(MAX_PRICE),
    stock: z.number().int().min(0).max(1_000_000).nullable(),
    delivery: deliverySchema,
    returnsPolicy: z.string().trim().max(2000),
    taxBps: z.number().int().min(0).max(3000),
    status: z.enum(['draft', 'active', 'archived']),
  })
  .partial()
  .refine((b) => Object.keys(b).length > 0, { message: 'Nothing to update' });

export interface ProductRow {
  id: string;
  business_id: string | null;
  seller_user_id: string | null;
  kind: 'physical' | 'service' | 'digital' | 'ticket' | 'booking';
  title: string;
  description: string;
  price_cents: number;
  currency: string;
  stock: number | null;
  delivery: { methods?: string[]; estimateDays?: number; shippingCents?: number };
  returns_policy: string;
  status: 'draft' | 'active' | 'sold_out' | 'archived';
  rating_avg: string;
  rating_count: number;
  tax_bps: number;
  created_at: Date;
  updated_at: Date;
}

export const PRODUCT_COLS = `pd.id, pd.business_id, pd.seller_user_id, pd.kind, pd.title, pd.description, pd.price_cents, pd.currency, pd.stock, pd.delivery,
  pd.returns_policy, pd.status, pd.rating_avg, pd.rating_count, pd.tax_bps, pd.created_at, pd.updated_at`;

/** Products a viewer may see as a shopper: live (active/sold out), not deleted, seller visible (blocks, suspended businesses, teen rules). */
export function shopperVisibleSql(V: string, pd = 'pd'): string {
  return `(
    ${pd}.deleted_at IS NULL AND ${pd}.status IN ('active','sold_out')
    AND (
      (${pd}.business_id IS NOT NULL AND EXISTS (SELECT 1 FROM businesses pbx WHERE pbx.id = ${pd}.business_id AND ${businessVisibleSql(V, 'pbx')}))
      OR (${pd}.seller_user_id IS NOT NULL AND ${activeUserSql(`${pd}.seller_user_id`)} AND ${notBlockedSql(V, `${pd}.seller_user_id`)} AND ${teenAllowedSql(V, `${pd}.seller_user_id`)})
    )
  )`;
}

/** A product the viewer may open: shopper-visible, or one they can manage as the seller (drafts and archived included). Otherwise 404. */
export async function loadProductForViewer(
  db: Queryable,
  id: string,
  viewerId: string | null,
): Promise<{ p: ProductRow; isSeller: boolean }> {
  const { rows } = await db.query<ProductRow & { visible: boolean }>(
    `SELECT ${PRODUCT_COLS}, ${shopperVisibleSql('$2::uuid')} AS visible FROM products pd WHERE pd.id = $1 AND pd.deleted_at IS NULL`,
    [id, viewerId],
  );
  const p = rows[0];
  if (!p) throw notFound('Product');
  const isSeller = viewerId
    ? await hasSellerAccess(db, productSeller(p), viewerId, 'catalog', { allowInactive: true })
    : false;
  if (!p.visible && !isSeller) throw notFound('Product');
  return { p, isSeller };
}

/** Load a product for a seller-side change; non-members of the seller get 404, members lacking the permission 403. */
export async function loadProductForSeller(
  db: Queryable,
  id: string,
  userId: string,
  need: SellerNeed = 'catalog',
  opts: { lock?: boolean } = {},
): Promise<ProductRow> {
  const { rows } = await db.query<ProductRow>(
    `SELECT ${PRODUCT_COLS} FROM products pd WHERE pd.id = $1 AND pd.deleted_at IS NULL ${opts.lock ? 'FOR UPDATE' : ''}`,
    [id],
  );
  const p = rows[0];
  if (!p) throw notFound('Product');
  await requireSellerAccess(db, productSeller(p), userId, need, { allowInactive: true });
  return p;
}

/** Status that follows from stock: a sold-out physical product flips automatically and back when restocked. */
export function stockStatus(
  status: ProductRow['status'],
  stock: number | null,
  kind: ProductRow['kind'],
): ProductRow['status'] {
  if (kind !== 'physical' || stock === null) return status === 'sold_out' ? 'active' : status;
  if (status === 'active' && stock === 0) return 'sold_out';
  if (status === 'sold_out' && stock > 0) return 'active';
  return status;
}

async function fileCount(db: Queryable, productId: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM product_files WHERE product_id = $1',
    [productId],
  );
  return rows[0]!.n;
}

export async function createProduct(
  ctx: AppContext,
  actor: { userId: string; ageBand: 'teen' | 'adult' },
  body: z.infer<typeof productCreateBody>,
  req?: Parameters<typeof audit>[2],
): Promise<string> {
  if (actor.ageBand === 'teen')
    throw new AppError('unprocessable', 'Accounts under 18 cannot sell');
  if (body.kind === 'physical' && (body.stock === undefined || body.stock === null))
    throw invalid('Physical products need a stock quantity');
  if (body.kind !== 'physical' && body.stock !== undefined && body.stock !== null)
    throw invalid('Only physical products track stock');
  if (body.status === 'active' && body.kind === 'digital')
    throw invalid('Attach the downloadable files first, then activate the product');
  assertTextAllowed(body.title, body.description, body.returnsPolicy);
  if (body.businessId) {
    const a = await getBusinessAccess(ctx.db, body.businessId, actor.userId);
    if (!a) throw notFound('Business');
    if (!a.permissions.includes('offers.manage')) throw forbidden('Your role does not allow that');
    if (a.status !== 'active') throw forbidden('This business is not active');
  }
  const stock = body.kind === 'physical' ? body.stock! : null;
  const status = stockStatus(body.status, stock, body.kind);
  const { rows } = await ctx.db.query<{ id: string }>(
    `INSERT INTO products (business_id, seller_user_id, kind, title, description, price_cents, currency, stock, delivery, returns_policy, status, tax_bps)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
    [
      body.businessId ?? null,
      body.businessId ? null : actor.userId,
      body.kind,
      body.title,
      body.description,
      body.priceCents,
      body.currency,
      stock,
      JSON.stringify(body.delivery),
      body.returnsPolicy,
      status,
      body.taxBps,
    ],
  );
  await audit(
    ctx,
    {
      actorId: actor.userId,
      action: 'product.created',
      targetType: 'product',
      targetId: rows[0]!.id,
      metadata: {
        kind: body.kind,
        priceCents: body.priceCents,
        currency: body.currency,
        businessId: body.businessId ?? null,
      },
    },
    req,
  );
  return rows[0]!.id;
}

export async function updateProduct(
  ctx: AppContext,
  userId: string,
  id: string,
  body: z.infer<typeof productPatchBody>,
  req?: Parameters<typeof audit>[2],
): Promise<void> {
  await withTransaction(ctx.db, async (tx) => {
    const cur = await loadProductForSeller(tx, id, userId, 'catalog', { lock: true });
    if (body.stock !== undefined && cur.kind !== 'physical' && body.stock !== null)
      throw invalid('Only physical products track stock');
    if (body.stock === null && cur.kind === 'physical')
      throw invalid('Physical products need a stock quantity');
    assertTextAllowed(body.title, body.description, body.returnsPolicy);
    const next = {
      title: body.title ?? cur.title,
      description: body.description ?? cur.description,
      price: body.priceCents ?? cur.price_cents,
      stock: body.stock !== undefined ? body.stock : cur.stock,
      delivery: body.delivery ?? cur.delivery,
      returns: body.returnsPolicy ?? cur.returns_policy,
      tax: body.taxBps ?? cur.tax_bps,
      status: (body.status ??
        (cur.status === 'sold_out' ? 'active' : cur.status)) as ProductRow['status'],
    };
    if (next.status === 'active' && cur.kind === 'digital' && (await fileCount(tx, id)) === 0)
      throw invalid('Attach the downloadable files before activating a digital product');
    next.status = stockStatus(next.status, next.stock, cur.kind);
    await tx.query(
      `UPDATE products SET title = $2, description = $3, price_cents = $4, stock = $5, delivery = $6, returns_policy = $7, tax_bps = $8, status = $9 WHERE id = $1`,
      [
        id,
        next.title,
        next.description,
        next.price,
        next.stock,
        JSON.stringify(next.delivery),
        next.returns,
        next.tax,
        next.status,
      ],
    );
    await audit(
      ctx,
      {
        actorId: userId,
        action: 'product.updated',
        targetType: 'product',
        targetId: id,
        metadata: {
          fields: Object.keys(body),
          priceCents: body.priceCents ?? undefined,
          status: next.status,
        },
      },
      req,
      tx,
    );
  });
}

export async function deleteProduct(
  ctx: AppContext,
  userId: string,
  id: string,
  req?: Parameters<typeof audit>[2],
): Promise<void> {
  await withTransaction(ctx.db, async (tx) => {
    await loadProductForSeller(tx, id, userId, 'catalog', { lock: true });
    await tx.query(`UPDATE products SET deleted_at = now(), status = 'archived' WHERE id = $1`, [
      id,
    ]);
    await audit(
      ctx,
      { actorId: userId, action: 'product.deleted', targetType: 'product', targetId: id },
      req,
      tx,
    );
  });
}

// ------------------------------------------------------------------ media and files
export async function setProductMedia(
  ctx: AppContext,
  userId: string,
  id: string,
  mediaIds: string[],
  req?: Parameters<typeof audit>[2],
): Promise<void> {
  const ids = [...new Set(mediaIds)];
  await withTransaction(ctx.db, async (tx) => {
    await loadProductForSeller(tx, id, userId, 'catalog', { lock: true });
    // Only public-purpose images the acting seller uploaded and that the media pipeline has not blocked.
    for (const m of ids) await assertOwnedImage(tx, m, userId);
    await tx.query('DELETE FROM product_media WHERE product_id = $1', [id]);
    for (const [i, m] of ids.entries())
      await tx.query(
        'INSERT INTO product_media (product_id, media_id, position) VALUES ($1,$2,$3)',
        [id, m, i],
      );
    await audit(
      ctx,
      {
        actorId: userId,
        action: 'product.media_set',
        targetType: 'product',
        targetId: id,
        metadata: { count: ids.length },
      },
      req,
      tx,
    );
  });
}

export async function setProductFiles(
  ctx: AppContext,
  userId: string,
  id: string,
  mediaIds: string[],
  req?: Parameters<typeof audit>[2],
): Promise<void> {
  const ids = [...new Set(mediaIds)];
  await withTransaction(ctx.db, async (tx) => {
    const p = await loadProductForSeller(tx, id, userId, 'catalog', { lock: true });
    if (p.kind !== 'digital') throw invalid('Only digital products have downloadable files');
    if (!ids.length && p.status === 'active')
      throw invalid('An active digital product needs at least one file; archive it first');
    if (ids.length) {
      const { rows } = await tx.query<{ id: string; purpose: string; attached: boolean }>(
        `SELECT m.id, m.purpose,
                (EXISTS (SELECT 1 FROM post_media pm WHERE pm.media_id = m.id) OR EXISTS (SELECT 1 FROM moments mo WHERE mo.media_id = m.id)) AS attached
           FROM media m WHERE m.id = ANY($1::uuid[]) AND m.owner_id = $2 AND m.deleted_at IS NULL AND m.status IN ('uploaded','ready')`,
        [ids, userId],
      );
      if (rows.length !== ids.length)
        throw invalid(
          'One or more files are unavailable (they must be your own, fully uploaded files)',
        );
      // A world-readable or publicly attached file would let anyone bypass the purchase.
      if (rows.some((r) => r.purpose === 'public' || r.attached))
        throw new AppError(
          'unprocessable',
          'Files sold as digital products must be private (not public media and not attached to posts)',
          { reason: 'file_not_private' },
        );
    }
    await tx.query('DELETE FROM product_files WHERE product_id = $1', [id]);
    for (const m of ids)
      await tx.query('INSERT INTO product_files (product_id, media_id) VALUES ($1,$2)', [id, m]);
    await audit(
      ctx,
      {
        actorId: userId,
        action: 'product.files_set',
        targetType: 'product',
        targetId: id,
        metadata: { count: ids.length },
      },
      req,
      tx,
    );
  });
}

// ------------------------------------------------------------------ views
export async function productViews(
  ctx: AppContext,
  rows: ProductRow[],
  viewerId: string | null,
  sellerFlags: Map<string, boolean>,
) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const bizIds = [
    ...new Set(rows.map((r) => r.business_id).filter((x): x is string => Boolean(x))),
  ];
  const userIds = [
    ...new Set(rows.map((r) => r.seller_user_id).filter((x): x is string => Boolean(x))),
  ];
  const [biz, users, media, files, purchased] = await Promise.all([
    bizIds.length
      ? ctx.db.query<{ id: string; name: string; slug: string }>(
          'SELECT id, name, slug::text AS slug FROM businesses WHERE id = ANY($1::uuid[])',
          [bizIds],
        )
      : { rows: [] },
    userIds.length
      ? ctx.db.query<{ user_id: string; username: string; display_name: string }>(
          'SELECT user_id, username::text AS username, display_name FROM profiles WHERE user_id = ANY($1::uuid[])',
          [userIds],
        )
      : { rows: [] },
    ctx.db.query<{ product_id: string; id: string; storage_key: string; alt_text: string | null }>(
      `SELECT pm.product_id, m.id, m.storage_key, m.alt_text FROM product_media pm JOIN media m ON m.id = pm.media_id
        WHERE pm.product_id = ANY($1::uuid[]) AND m.deleted_at IS NULL AND m.status IN ('uploaded','processing','ready') ORDER BY pm.position`,
      [ids],
    ),
    ctx.db.query<{ product_id: string; n: number }>(
      'SELECT product_id, count(*)::int AS n FROM product_files WHERE product_id = ANY($1::uuid[]) GROUP BY product_id',
      [ids],
    ),
    viewerId
      ? ctx.db.query<{ product_id: string }>(
          `SELECT DISTINCT oi.product_id FROM order_items oi JOIN orders o ON o.id = oi.order_id
            WHERE o.buyer_id = $1 AND oi.product_id = ANY($2::uuid[]) AND o.status IN ('paid','fulfilled','completed','partially_refunded')`,
          [viewerId, ids],
        )
      : { rows: [] },
  ]);
  const bizBy = new Map(biz.rows.map((b) => [b.id, b]));
  const userBy = new Map(users.rows.map((u) => [u.user_id, u]));
  const fileBy = new Map(files.rows.map((f) => [f.product_id, f.n]));
  const bought = new Set(purchased.rows.map((r) => r.product_id));
  return rows.map((r) => {
    const isSeller = sellerFlags.get(r.id) ?? false;
    const b = r.business_id ? bizBy.get(r.business_id) : null;
    const u = r.seller_user_id ? userBy.get(r.seller_user_id) : null;
    return {
      id: r.id,
      kind: r.kind,
      title: r.title,
      description: r.description,
      priceCents: r.price_cents,
      currency: r.currency,
      taxBps: r.tax_bps,
      inStock: r.stock === null || r.stock > 0,
      ...(isSeller ? { stock: r.stock } : {}),
      delivery: {
        methods: r.delivery.methods ?? [],
        estimateDays: r.delivery.estimateDays ?? null,
        shippingCents: r.delivery.shippingCents ?? 0,
      },
      returnsPolicy: r.returns_policy,
      status: r.status,
      rating: { average: Number(r.rating_avg), count: r.rating_count },
      seller: b
        ? { type: 'business' as const, id: b.id, name: b.name, slug: b.slug }
        : {
            type: 'user' as const,
            id: r.seller_user_id,
            name: u?.display_name ?? null,
            username: u?.username ?? null,
          },
      media: media.rows
        .filter((m) => m.product_id === r.id)
        .map((m) => ({ id: m.id, url: mediaUrl(ctx.config, m.storage_key), alt: m.alt_text })),
      ...(r.kind === 'digital'
        ? { fileCount: isSeller || bought.has(r.id) ? (fileBy.get(r.id) ?? 0) : undefined }
        : {}),
      createdAt: r.created_at.toISOString(),
      viewer: { isSeller, hasPurchased: bought.has(r.id) },
    };
  });
}

export async function sellerFlagsFor(
  db: Queryable,
  rows: ProductRow[],
  viewerId: string | null,
): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>();
  if (!viewerId) return out;
  const cache = new Map<string, boolean>();
  for (const r of rows) {
    const seller: Payee = productSeller(r);
    const k = `${seller.type}:${seller.id}`;
    if (!cache.has(k))
      cache.set(k, await hasSellerAccess(db, seller, viewerId, 'catalog', { allowInactive: true }));
    out.set(r.id, cache.get(k)!);
  }
  return out;
}

// ------------------------------------------------------------------ reviews (verified purchasers only)
export async function recomputeProductRating(tx: Queryable, productId: string): Promise<void> {
  await tx.query(
    `UPDATE products SET
       rating_count = (SELECT count(*) FROM reviews WHERE target_type = 'product' AND target_id = $1 AND deleted_at IS NULL AND moderation_status = 'approved'),
       rating_avg = COALESCE((SELECT round(avg(rating)::numeric, 2) FROM reviews WHERE target_type = 'product' AND target_id = $1 AND deleted_at IS NULL AND moderation_status = 'approved'), 0)
     WHERE id = $1`,
    [productId],
  );
}

/** A verified purchase: a paid, not-fully-refunded line for this product in one of the reviewer's orders. */
export async function hasVerifiedPurchase(
  db: Queryable,
  userId: string,
  productId: string,
): Promise<boolean> {
  const { rowCount } = await db.query(
    `SELECT 1 FROM order_items oi JOIN orders o ON o.id = oi.order_id
      WHERE o.buyer_id = $1 AND oi.product_id = $2 AND o.status IN ('paid','fulfilled','completed','partially_refunded')
        AND oi.refunded_cents < oi.unit_price_cents * oi.quantity LIMIT 1`,
    [userId, productId],
  );
  return (rowCount ?? 0) > 0;
}

export async function createProductReview(
  ctx: AppContext,
  userId: string,
  productId: string,
  input: { rating: number; body: string },
  req?: Parameters<typeof audit>[2],
): Promise<string> {
  const { p, isSeller } = await loadProductForViewer(ctx.db, productId, userId);
  if (isSeller) throw forbidden('You cannot review your own product');
  if (input.body) assertTextAllowed(input.body);
  if (!(await hasVerifiedPurchase(ctx.db, userId, p.id)))
    throw new AppError('forbidden', 'Only customers who bought this product can review it', {
      reason: 'not_a_verified_purchaser',
    });
  return withTransaction(ctx.db, async (tx) => {
    await tx.query('SELECT 1 FROM products WHERE id = $1 FOR UPDATE', [productId]);
    const ex = await tx.query<{ id: string; deleted_at: Date | null }>(
      `SELECT id, deleted_at FROM reviews WHERE author_id = $1 AND target_type = 'product' AND target_id = $2 FOR UPDATE`,
      [userId, productId],
    );
    let id: string;
    if (ex.rows[0] && !ex.rows[0].deleted_at)
      throw conflict('You have already reviewed this product', { reviewId: ex.rows[0].id });
    if (ex.rows[0]) {
      id = ex.rows[0].id;
      await tx.query(
        `UPDATE reviews SET rating = $2, body = $3, deleted_at = NULL, moderation_status = 'approved', verified_purchase = true, created_at = now() WHERE id = $1`,
        [id, input.rating, input.body],
      );
    } else {
      const ins = await tx.query<{ id: string }>(
        `INSERT INTO reviews (author_id, target_type, target_id, rating, body, verified_purchase) VALUES ($1,'product',$2,$3,$4,true) RETURNING id`,
        [userId, productId, input.rating, input.body],
      );
      id = ins.rows[0]!.id;
    }
    if (input.body)
      await screenText(ctx, tx, { type: 'review', id, authorId: userId, text: input.body });
    await recomputeProductRating(tx, productId);
    await audit(
      ctx,
      {
        actorId: userId,
        action: 'review.created',
        targetType: 'review',
        targetId: id,
        metadata: { productId, rating: input.rating },
      },
      req,
      tx,
    );
    return id;
  });
}

export async function updateProductReview(
  ctx: AppContext,
  userId: string,
  productId: string,
  patch: { rating?: number | undefined; body?: string | undefined },
  req?: Parameters<typeof audit>[2],
): Promise<string> {
  if (patch.body) assertTextAllowed(patch.body);
  return withTransaction(ctx.db, async (tx) => {
    await tx.query('SELECT 1 FROM products WHERE id = $1 FOR UPDATE', [productId]);
    const { rows } = await tx.query<{ id: string; moderation_status: string }>(
      `SELECT id, moderation_status FROM reviews WHERE author_id = $1 AND target_type = 'product' AND target_id = $2 AND deleted_at IS NULL FOR UPDATE`,
      [userId, productId],
    );
    const r = rows[0];
    if (!r) throw notFound('Review');
    if (r.moderation_status !== 'approved')
      throw forbidden('This review is under moderation and cannot be edited');
    await tx.query(
      'UPDATE reviews SET rating = COALESCE($2, rating), body = COALESCE($3, body) WHERE id = $1',
      [r.id, patch.rating ?? null, patch.body ?? null],
    );
    if (patch.body)
      await screenText(ctx, tx, { type: 'review', id: r.id, authorId: userId, text: patch.body });
    await recomputeProductRating(tx, productId);
    await audit(
      ctx,
      { actorId: userId, action: 'review.updated', targetType: 'review', targetId: r.id },
      req,
      tx,
    );
    return r.id;
  });
}

export async function deleteProductReview(
  ctx: AppContext,
  userId: string,
  productId: string,
  req?: Parameters<typeof audit>[2],
): Promise<void> {
  await withTransaction(ctx.db, async (tx) => {
    await tx.query('SELECT 1 FROM products WHERE id = $1 FOR UPDATE', [productId]);
    const r = await tx.query<{ id: string }>(
      `UPDATE reviews SET deleted_at = now() WHERE author_id = $1 AND target_type = 'product' AND target_id = $2 AND deleted_at IS NULL RETURNING id`,
      [userId, productId],
    );
    if (!r.rows[0]) throw notFound('Review');
    await recomputeProductRating(tx, productId);
    await audit(
      ctx,
      { actorId: userId, action: 'review.deleted', targetType: 'review', targetId: r.rows[0].id },
      req,
      tx,
    );
  });
}

export type { Tx };
