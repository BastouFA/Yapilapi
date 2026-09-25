import { z } from 'zod';
import { withTransaction, type Tx } from '@yapilapi/database';
import {
  AppError,
  clampLimit,
  conflict,
  decodeCursor,
  encodeCursor,
  invalid,
  notFound,
} from '@yapilapi/shared';
import { route } from '../../lib/route.js';
import { audit } from '../../lib/audit.js';
import { registerDeletionHook } from '../../lib/hooks.js';
import { hydratePosts, postFrom, postSelect } from '../../lib/post-view.js';
import { notBlockedSql } from '../search/guards.js';
import { createPost } from '../content/service.js';
import { requireBusinessPermission } from '../business/index.js';
import type { ApiModule } from '../types.js';
import { notifyUser } from '../payments/notify.js';
import { hasSellerAccess, requireSellerAccess } from './access.js';
import { serveDownload, signDownloadToken, verifyDownloadToken, canDownload } from './downloads.js';
import {
  ORDER_COLS,
  IDEMPOTENCY_KEY,
  cancelOrder,
  createOrder,
  createOrderBody,
  loadOrder,
  orderViewer,
  orderViews,
  transitionOrder,
  cancelOrderTx,
  type OrderRow,
} from './orders.js';
import { OPEN_ORDER_STATUSES, PAID_ORDER_STATUSES, ORDER_STATUSES } from './order-state.js';
import {
  PRODUCT_COLS,
  createProduct,
  createProductReview,
  deleteProduct,
  deleteProductReview,
  loadProductForSeller,
  loadProductForViewer,
  productCreateBody,
  productPatchBody,
  productViews,
  sellerFlagsFor,
  setProductFiles,
  setProductMedia,
  shopperVisibleSql,
  updateProduct,
  updateProductReview,
  type ProductRow,
} from './products.js';

export {
  releaseExpiredReservations,
  autoCompleteOrders,
  createOrder,
  transitionOrder,
  cancelOrder,
} from './orders.js';
export { ORDER_TRANSITIONS, canTransition, assertTransition } from './order-state.js';
export type { OrderStatus } from './order-state.js';
export { canDownload } from './downloads.js';

const idParams = z.object({ id: z.uuid() });
const pageQuery = z.object({
  cursor: z.string().max(300).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});
const escapeLike = (s: string) => s.replace(/[\\%_]/g, '\\$&');
const W = { limit: 60, windowSec: 600, by: 'user' } as const;
type Cursor = { t: string; id: string };

const idemHeader = (req: { headers: Record<string, string | string[] | undefined> }): string => {
  const raw = req.headers['idempotency-key'];
  const key = Array.isArray(raw) ? raw[0] : raw;
  if (!key || !IDEMPOTENCY_KEY.test(key))
    throw invalid(
      'An Idempotency-Key header (8-128 characters: letters, digits, . _ : -) is required',
    );
  return key;
};

export const commerceModule: ApiModule = {
  name: 'commerce',
  register(app, ctx) {
    const gate = (userId?: string) => ctx.flags.require('COMMERCE', userId);

    registerDeletionHook(async (c, tx, userId) => {
      // Sellers: their listings disappear and their unpaid orders are released. Buyers: unpaid orders are cancelled.
      // Paid orders, payments, refunds and the ledger are financial records that must be retained (see docs/security/payments.md).
      await tx.query(
        `UPDATE products SET deleted_at = now(), status = 'archived' WHERE seller_user_id = $1 AND deleted_at IS NULL`,
        [userId],
      );
      const open = await tx.query<{ id: string }>(
        `SELECT id FROM orders WHERE (buyer_id = $1 OR seller_user_id = $1) AND status = ANY($2::text[]) FOR UPDATE`,
        [userId, [...OPEN_ORDER_STATUSES]],
      );
      for (const o of open.rows)
        await cancelOrderTx(c, tx as unknown as Tx, o.id, 'system', 'account_deleted');
    });

    // ================================================================== catalogue
    route(app, ctx, {
      method: 'GET',
      url: '/v1/products',
      summary: 'Browse products',
      tags: ['commerce'],
      auth: 'optional',
      query: pageQuery.extend({
        q: z.string().trim().min(1).max(100).optional(),
        kind: z.enum(['physical', 'service', 'digital', 'booking']).optional(),
        businessId: z.uuid().optional(),
        sellerId: z.uuid().optional(),
        minPriceCents: z.coerce.number().int().min(0).optional(),
        maxPriceCents: z.coerce.number().int().min(0).optional(),
      }),
      rateLimit: { limit: 300, windowSec: 600, by: 'ip' },
      handler: async ({ auth, query }) => {
        await gate(auth?.userId);
        const viewer = auth?.userId ?? null;
        const limit = clampLimit(query.limit);
        const cur = decodeCursor<Cursor>(query.cursor);
        const { rows } = await ctx.db.query<ProductRow>(
          `SELECT ${PRODUCT_COLS} FROM products pd
            WHERE ${shopperVisibleSql('$1::uuid')}
              AND ($2::text IS NULL OR pd.kind = $2) AND ($3::uuid IS NULL OR pd.business_id = $3) AND ($4::uuid IS NULL OR pd.seller_user_id = $4)
              AND ($5::text IS NULL OR pd.title ILIKE '%' || $5 || '%' ESCAPE '\\')
              AND ($6::bigint IS NULL OR pd.price_cents >= $6) AND ($7::bigint IS NULL OR pd.price_cents <= $7)
              AND ($8::timestamptz IS NULL OR (pd.created_at, pd.id) < ($8::timestamptz, $9::uuid))
            ORDER BY pd.created_at DESC, pd.id DESC LIMIT $10`,
          [
            viewer,
            query.kind ?? null,
            query.businessId ?? null,
            query.sellerId ?? null,
            query.q ? escapeLike(query.q) : null,
            query.minPriceCents ?? null,
            query.maxPriceCents ?? null,
            cur?.t ?? null,
            cur?.id ?? null,
            limit + 1,
          ],
        );
        const page = rows.slice(0, limit);
        const last = page[page.length - 1];
        return {
          items: await productViews(ctx, page, viewer, await sellerFlagsFor(ctx.db, page, viewer)),
          nextCursor:
            rows.length > limit && last
              ? encodeCursor({ t: last.created_at.toISOString(), id: last.id })
              : null,
        };
      },
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/me/products',
      summary: 'My products (as an individual seller, or for a business I can manage)',
      tags: ['commerce'],
      auth: 'user',
      query: pageQuery.extend({
        businessId: z.uuid().optional(),
        status: z.enum(['draft', 'active', 'sold_out', 'archived']).optional(),
      }),
      rateLimit: W,
      handler: async ({ auth, query }) => {
        await gate(auth.userId);
        if (query.businessId)
          await requireSellerAccess(
            ctx.db,
            { type: 'business', id: query.businessId },
            auth.userId,
            'catalog',
            { allowInactive: true },
          );
        const limit = clampLimit(query.limit);
        const cur = decodeCursor<Cursor>(query.cursor);
        const { rows } = await ctx.db.query<ProductRow>(
          `SELECT ${PRODUCT_COLS} FROM products pd
            WHERE pd.deleted_at IS NULL AND ($1::uuid IS NULL AND pd.seller_user_id = $2 OR pd.business_id = $1) AND ($3::text IS NULL OR pd.status = $3)
              AND ($4::timestamptz IS NULL OR (pd.created_at, pd.id) < ($4::timestamptz, $5::uuid))
            ORDER BY pd.created_at DESC, pd.id DESC LIMIT $6`,
          [
            query.businessId ?? null,
            auth.userId,
            query.status ?? null,
            cur?.t ?? null,
            cur?.id ?? null,
            limit + 1,
          ],
        );
        const page = rows.slice(0, limit);
        const last = page[page.length - 1];
        return {
          items: await productViews(ctx, page, auth.userId, new Map(page.map((p) => [p.id, true]))),
          nextCursor:
            rows.length > limit && last
              ? encodeCursor({ t: last.created_at.toISOString(), id: last.id })
              : null,
        };
      },
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/products/:id',
      summary: 'Product detail',
      tags: ['commerce'],
      auth: 'optional',
      params: idParams,
      rateLimit: { limit: 300, windowSec: 600, by: 'ip' },
      handler: async ({ auth, params }) => {
        await gate(auth?.userId);
        const viewer = auth?.userId ?? null;
        const { p, isSeller } = await loadProductForViewer(ctx.db, params.id, viewer);
        return (await productViews(ctx, [p], viewer, new Map([[p.id, isSeller]])))[0];
      },
    });

    route(app, ctx, {
      method: 'POST',
      url: '/v1/products',
      summary: 'Create a product (individual seller, or for a business you manage)',
      tags: ['commerce'],
      auth: 'user',
      body: productCreateBody,
      rateLimit: { limit: 60, windowSec: 3600, by: 'user' },
      handler: async ({ auth, req, reply, body }) => {
        await gate(auth.userId);
        const id = await createProduct(
          ctx,
          { userId: auth.userId, ageBand: auth.ageBand },
          body,
          req,
        );
        const { p } = await loadProductForViewer(ctx.db, id, auth.userId);
        void reply.code(201);
        return (await productViews(ctx, [p], auth.userId, new Map([[p.id, true]])))[0];
      },
    });

    route(app, ctx, {
      method: 'PATCH',
      url: '/v1/products/:id',
      summary: 'Update a product',
      tags: ['commerce'],
      auth: 'user',
      params: idParams,
      body: productPatchBody,
      rateLimit: { limit: 120, windowSec: 3600, by: 'user' },
      handler: async ({ auth, req, params, body }) => {
        await gate(auth.userId);
        await updateProduct(ctx, auth.userId, params.id, body, req);
        const { p } = await loadProductForViewer(ctx.db, params.id, auth.userId);
        return (await productViews(ctx, [p], auth.userId, new Map([[p.id, true]])))[0];
      },
    });

    route(app, ctx, {
      method: 'DELETE',
      url: '/v1/products/:id',
      summary: 'Delete a product (existing orders keep their snapshot)',
      tags: ['commerce'],
      auth: 'user',
      params: idParams,
      rateLimit: W,
      handler: async ({ auth, req, params }) => {
        await gate(auth.userId);
        await deleteProduct(ctx, auth.userId, params.id, req);
      },
    });

    route(app, ctx, {
      method: 'PUT',
      url: '/v1/products/:id/media',
      summary: 'Set product images (your own public images, in order)',
      tags: ['commerce'],
      auth: 'user',
      params: idParams,
      body: z.object({ mediaIds: z.array(z.uuid()).max(10) }),
      rateLimit: W,
      handler: async ({ auth, req, params, body }) => {
        await gate(auth.userId);
        await setProductMedia(ctx, auth.userId, params.id, body.mediaIds, req);
        const { p } = await loadProductForViewer(ctx.db, params.id, auth.userId);
        return (await productViews(ctx, [p], auth.userId, new Map([[p.id, true]])))[0];
      },
    });

    route(app, ctx, {
      method: 'PUT',
      url: '/v1/products/:id/files',
      summary: 'Set the downloadable files of a digital product (your own private uploads)',
      tags: ['commerce'],
      auth: 'user',
      params: idParams,
      body: z.object({ mediaIds: z.array(z.uuid()).max(20) }),
      rateLimit: W,
      handler: async ({ auth, req, params, body }) => {
        await gate(auth.userId);
        await setProductFiles(ctx, auth.userId, params.id, body.mediaIds, req);
        const { p } = await loadProductForViewer(ctx.db, params.id, auth.userId);
        return (await productViews(ctx, [p], auth.userId, new Map([[p.id, true]])))[0];
      },
    });

    // ================================================================== digital delivery (paid buyers only, short-lived URLs)
    route(app, ctx, {
      method: 'GET',
      url: '/v1/products/:id/downloads',
      summary: 'Short-lived download links for a digital product you bought',
      tags: ['commerce'],
      auth: 'user',
      params: idParams,
      rateLimit: { limit: 60, windowSec: 600, by: 'user' },
      handler: async ({ auth, req, params }) => {
        await gate(auth.userId);
        // Unentitled callers cannot tell whether the product exists: 404 either way.
        if (!(await canDownload(ctx.db, auth.userId, params.id))) throw notFound('Product');
        const { rows } = await ctx.db.query<{
          media_id: string;
          mime_type: string;
          size_bytes: number;
        }>(
          `SELECT pf.media_id, m.mime_type, m.size_bytes FROM product_files pf JOIN media m ON m.id = pf.media_id
            WHERE pf.product_id = $1 AND m.deleted_at IS NULL AND m.status IN ('uploaded','processing','ready') ORDER BY pf.media_id`,
          [params.id],
        );
        const files = rows.map((f) => {
          const { token, expiresAt } = signDownloadToken(ctx, {
            u: auth.userId,
            p: params.id,
            m: f.media_id,
          });
          return {
            id: f.media_id,
            mimeType: f.mime_type,
            sizeBytes: f.size_bytes,
            url: `/v1/downloads?token=${token}`,
            expiresAt: expiresAt.toISOString(),
          };
        });
        await audit(
          ctx,
          {
            actorId: auth.userId,
            action: 'product.download_links_issued',
            targetType: 'product',
            targetId: params.id,
            metadata: { files: files.length },
          },
          req,
        );
        return { files };
      },
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/downloads',
      summary: 'Redeem a download link (must be the user it was issued to, and still entitled)',
      tags: ['commerce'],
      auth: 'user',
      query: z.object({ token: z.string().min(20).max(1000) }),
      rateLimit: { limit: 60, windowSec: 600, by: 'user' },
      handler: async ({ auth, req, reply, query }) => {
        await gate(auth.userId);
        const t = verifyDownloadToken(ctx, query.token);
        if (!t || t.u !== auth.userId) throw notFound('Download');
        await serveDownload(ctx, query.token, req, reply);
        return reply;
      },
    });

    // ================================================================== reviews (verified purchasers)
    route(app, ctx, {
      method: 'GET',
      url: '/v1/products/:id/reviews',
      summary: 'Reviews of a product',
      tags: ['commerce'],
      auth: 'optional',
      params: idParams,
      query: pageQuery,
      rateLimit: { limit: 300, windowSec: 600, by: 'ip' },
      handler: async ({ auth, params, query }) => {
        await gate(auth?.userId);
        const viewer = auth?.userId ?? null;
        await loadProductForViewer(ctx.db, params.id, viewer);
        const limit = clampLimit(query.limit);
        const cur = decodeCursor<Cursor>(query.cursor);
        const { rows } = await ctx.db.query<{
          id: string;
          author_id: string;
          rating: number;
          body: string;
          created_at: Date;
          username: string;
          display_name: string;
        }>(
          `SELECT r.id, r.author_id, r.rating, r.body, r.created_at, pr.username::text AS username, pr.display_name
             FROM reviews r JOIN profiles pr ON pr.user_id = r.author_id
            WHERE r.target_type = 'product' AND r.target_id = $1 AND r.deleted_at IS NULL AND r.moderation_status = 'approved' AND ${notBlockedSql('$2::uuid', 'r.author_id')}
              AND ($3::timestamptz IS NULL OR (r.created_at, r.id) < ($3::timestamptz, $4::uuid))
            ORDER BY r.created_at DESC, r.id DESC LIMIT $5`,
          [params.id, viewer, cur?.t ?? null, cur?.id ?? null, limit + 1],
        );
        const page = rows.slice(0, limit);
        const last = page[page.length - 1];
        return {
          items: page.map((r) => ({
            id: r.id,
            rating: r.rating,
            body: r.body,
            verifiedPurchase: true,
            author: { id: r.author_id, username: r.username, displayName: r.display_name },
            createdAt: r.created_at.toISOString(),
            mine: r.author_id === viewer,
          })),
          nextCursor:
            rows.length > limit && last
              ? encodeCursor({ t: last.created_at.toISOString(), id: last.id })
              : null,
        };
      },
    });

    const reviewBody = z.object({
      rating: z.number().int().min(1).max(5),
      body: z.string().trim().max(3000).default(''),
    });
    route(app, ctx, {
      method: 'POST',
      url: '/v1/products/:id/reviews',
      summary: 'Review a product you bought (one per product)',
      tags: ['commerce'],
      auth: 'user',
      params: idParams,
      body: reviewBody,
      rateLimit: { limit: 20, windowSec: 3600, by: 'user' },
      handler: async ({ auth, req, reply, params, body }) => {
        await gate(auth.userId);
        const id = await createProductReview(ctx, auth.userId, params.id, body, req);
        void reply.code(201);
        return { id };
      },
    });
    route(app, ctx, {
      method: 'PATCH',
      url: '/v1/products/:id/reviews/mine',
      summary: 'Edit your review',
      tags: ['commerce'],
      auth: 'user',
      params: idParams,
      body: z
        .object({
          rating: z.number().int().min(1).max(5).optional(),
          body: z.string().trim().max(3000).optional(),
        })
        .refine((b) => b.rating !== undefined || b.body !== undefined, {
          message: 'Nothing to update',
        }),
      rateLimit: { limit: 20, windowSec: 3600, by: 'user' },
      handler: async ({ auth, req, params, body }) => {
        await gate(auth.userId);
        return { id: await updateProductReview(ctx, auth.userId, params.id, body, req) };
      },
    });
    route(app, ctx, {
      method: 'DELETE',
      url: '/v1/products/:id/reviews/mine',
      summary: 'Delete your review',
      tags: ['commerce'],
      auth: 'user',
      params: idParams,
      rateLimit: W,
      handler: async ({ auth, req, params }) => {
        await gate(auth.userId);
        await deleteProductReview(ctx, auth.userId, params.id, req);
      },
    });

    // ================================================================== product-linked posts
    route(app, ctx, {
      method: 'POST',
      url: '/v1/products/:id/posts',
      summary: 'Publish a post that promotes one of your active products',
      tags: ['commerce'],
      auth: 'user',
      params: idParams,
      body: z.object({
        body: z.string().trim().max(10_000).default(''),
        mediaIds: z.array(z.uuid()).max(10).optional(),
        topics: z.array(z.string().min(1).max(50)).max(10).optional(),
        language: z.string().min(2).max(10).optional(),
      }),
      rateLimit: { limit: 30, windowSec: 3600, by: 'user' },
      handler: async ({ auth, req, reply, params, body }) => {
        await gate(auth.userId);
        const p = await loadProductForSeller(ctx.db, params.id, auth.userId, 'catalog');
        if (!['active', 'sold_out'].includes(p.status))
          throw new AppError('conflict', 'Only live products can be promoted', {
            reason: 'product_not_live',
          });
        if (p.business_id)
          await requireBusinessPermission(ctx.db, p.business_id, auth.userId, 'posts.publish');
        const id = await createPost(
          ctx,
          { userId: auth.userId, ageBand: auth.ageBand },
          {
            ...body,
            visibility: 'public',
            productId: p.id,
            ...(p.business_id ? { businessId: p.business_id } : {}),
          },
        );
        await audit(
          ctx,
          {
            actorId: auth.userId,
            action: 'product.post_created',
            targetType: 'post',
            targetId: id,
            metadata: { productId: p.id },
          },
          req,
        );
        const { rows } = await ctx.db.query(
          `SELECT ${postSelect('$1::uuid')} FROM ${postFrom} WHERE p.id = $2`,
          [auth.userId, id],
        );
        void reply.code(201);
        return { product: { id: p.id }, post: (await hydratePosts(ctx, auth.userId, rows))[0] };
      },
    });

    // ================================================================== orders
    route(app, ctx, {
      method: 'POST',
      url: '/v1/orders',
      summary:
        'Create an order (server-side pricing, stock reserved). Requires an Idempotency-Key header.',
      tags: ['commerce'],
      auth: 'user',
      body: createOrderBody,
      rateLimit: { limit: 30, windowSec: 3600, by: 'user' },
      handler: async ({ auth, req, reply, body }) => {
        await gate(auth.userId);
        const key = idemHeader(req);
        const r = await createOrder(
          ctx,
          { userId: auth.userId, ageBand: auth.ageBand },
          key,
          body,
          { id: req.id, clientIp: req.clientIp },
          req,
        );
        void reply.code(r.replayed ? 200 : 201);
        if (r.replayed) void reply.header('idempotent-replayed', 'true');
        return {
          order: (await orderViews(ctx, [r.order], 'buyer'))[0],
          held: r.held,
          replayed: r.replayed,
        };
      },
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/orders',
      summary: 'My orders (as buyer)',
      tags: ['commerce'],
      auth: 'user',
      query: pageQuery.extend({ status: z.enum(ORDER_STATUSES).optional() }),
      rateLimit: W,
      handler: async ({ auth, query }) => {
        await gate(auth.userId);
        const limit = clampLimit(query.limit);
        const cur = decodeCursor<Cursor>(query.cursor);
        const { rows } = await ctx.db.query<OrderRow>(
          `SELECT ${ORDER_COLS} FROM orders o WHERE o.buyer_id = $1 AND ($2::text IS NULL OR o.status = $2) AND ($3::timestamptz IS NULL OR (o.created_at, o.id) < ($3::timestamptz, $4::uuid))
            ORDER BY o.created_at DESC, o.id DESC LIMIT $5`,
          [auth.userId, query.status ?? null, cur?.t ?? null, cur?.id ?? null, limit + 1],
        );
        const page = rows.slice(0, limit);
        const last = page[page.length - 1];
        return {
          items: await orderViews(ctx, page, 'buyer'),
          nextCursor:
            rows.length > limit && last
              ? encodeCursor({ t: last.created_at.toISOString(), id: last.id })
              : null,
        };
      },
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/seller/orders',
      summary:
        'Paid orders containing my items (individual seller, or a business I handle orders for)',
      tags: ['commerce'],
      auth: 'user',
      query: pageQuery.extend({
        businessId: z.uuid().optional(),
        status: z.enum(ORDER_STATUSES).optional(),
      }),
      rateLimit: W,
      handler: async ({ auth, query }) => {
        await gate(auth.userId);
        if (query.businessId)
          await requireSellerAccess(
            ctx.db,
            { type: 'business', id: query.businessId },
            auth.userId,
            'orders',
            { allowInactive: true },
          );
        const limit = clampLimit(query.limit);
        const cur = decodeCursor<Cursor>(query.cursor);
        const { rows } = await ctx.db.query<OrderRow>(
          `SELECT ${ORDER_COLS} FROM orders o
            WHERE ($1::uuid IS NULL AND o.seller_user_id = $2 OR o.seller_business_id = $1) AND o.status = ANY($3::text[]) AND ($4::text IS NULL OR o.status = $4)
              AND ($5::timestamptz IS NULL OR (o.created_at, o.id) < ($5::timestamptz, $6::uuid))
            ORDER BY o.created_at DESC, o.id DESC LIMIT $7`,
          [
            query.businessId ?? null,
            auth.userId,
            [...PAID_ORDER_STATUSES],
            query.status ?? null,
            cur?.t ?? null,
            cur?.id ?? null,
            limit + 1,
          ],
        );
        const page = rows.slice(0, limit);
        const last = page[page.length - 1];
        return {
          items: await orderViews(ctx, page, 'seller'),
          nextCursor:
            rows.length > limit && last
              ? encodeCursor({ t: last.created_at.toISOString(), id: last.id })
              : null,
        };
      },
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/orders/:id',
      summary: 'One order (its buyer, or the seller / business team it contains items of)',
      tags: ['commerce'],
      auth: 'user',
      params: idParams,
      rateLimit: W,
      handler: async ({ auth, params }) => {
        await gate(auth.userId);
        const o = await loadOrder(ctx.db, params.id).catch(() => null);
        const who = o ? await orderViewer(ctx.db, o, auth.userId) : null;
        // Sellers only ever see orders that were actually paid; everyone else gets a plain 404.
        if (
          !o ||
          !who ||
          (who === 'seller' && !(PAID_ORDER_STATUSES as readonly string[]).includes(o.status))
        )
          throw notFound('Order');
        return (await orderViews(ctx, [o], who))[0];
      },
    });

    route(app, ctx, {
      method: 'POST',
      url: '/v1/orders/:id/cancel',
      summary: 'Cancel an unpaid order (paid orders are refunded, not cancelled)',
      tags: ['commerce'],
      auth: 'user',
      params: idParams,
      rateLimit: { limit: 30, windowSec: 3600, by: 'user' },
      handler: async ({ auth, req, params }) => {
        await gate(auth.userId);
        const o = await loadOrder(ctx.db, params.id).catch(() => null);
        if (!o || o.buyer_id !== auth.userId) throw notFound('Order');
        if (!(OPEN_ORDER_STATUSES as readonly string[]).includes(o.status)) {
          throw new AppError(
            'conflict',
            PAID_ORDER_STATUSES.includes(o.status)
              ? 'This order is already paid. Request a refund instead.'
              : `This order is already ${o.status.replace(/_/g, ' ')}`,
            { reason: 'invalid_order_transition', status: o.status },
          );
        }
        await cancelOrder(ctx, o.id, 'buyer', auth.userId, 'buyer_cancelled', req);
        return (await orderViews(ctx, [await loadOrder(ctx.db, o.id)], 'buyer'))[0];
      },
    });

    route(app, ctx, {
      method: 'POST',
      url: '/v1/orders/:id/fulfil',
      summary: 'Mark a paid order shipped / delivered (seller side)',
      tags: ['commerce'],
      auth: 'user',
      params: idParams,
      body: z
        .object({
          carrier: z.string().trim().max(60).optional(),
          trackingNumber: z.string().trim().max(100).optional(),
          trackingUrl: z
            .url({ protocol: /^https?$/ })
            .max(500)
            .optional(),
          note: z.string().trim().max(500).optional(),
        })
        .default({}),
      rateLimit: { limit: 120, windowSec: 3600, by: 'user' },
      handler: async ({ auth, req, params, body }) => {
        await gate(auth.userId);
        const o0 = await loadOrder(ctx.db, params.id).catch(() => null);
        if (
          !o0 ||
          !(await hasSellerAccess(
            ctx.db,
            o0.seller_business_id
              ? { type: 'business', id: o0.seller_business_id }
              : { type: 'user', id: o0.seller_user_id! },
            auth.userId,
            'orders',
          ))
        )
          throw notFound('Order');
        await withTransaction(ctx.db, async (tx) => {
          const o = await loadOrder(tx, params.id, { lock: true });
          if (!['paid', 'partially_refunded'].includes(o.status))
            throw new AppError(
              'conflict',
              `An order that is ${o.status.replace(/_/g, ' ')} cannot be fulfilled`,
              { reason: 'invalid_order_transition', status: o.status },
            );
          const unfinished = await tx.query(
            `SELECT 1 FROM order_entitlements WHERE order_id = $1 AND status = 'pending' LIMIT 1`,
            [o.id],
          );
          if (unfinished.rowCount)
            throw conflict('Digital items or tickets on this order are still being delivered', {
              reason: 'entitlements_pending',
            });
          await transitionOrder(tx, o.id, 'fulfilled', 'seller');
          await tx.query('UPDATE orders SET tracking = $2 WHERE id = $1', [
            o.id,
            JSON.stringify({
              carrier: body.carrier ?? null,
              trackingNumber: body.trackingNumber ?? null,
              trackingUrl: body.trackingUrl ?? null,
              note: body.note ?? null,
            }),
          ]);
          await audit(
            ctx,
            {
              actorId: auth.userId,
              action: 'order.fulfilled',
              targetType: 'order',
              targetId: o.id,
              metadata: { carrier: body.carrier ?? null },
            },
            req,
            tx,
          );
        });
        const o = await loadOrder(ctx.db, params.id);
        await notifyUser(ctx, o.buyer_id, {
          kind: 'order_fulfilled',
          actorId: auth.userId,
          targetType: 'order',
          targetId: o.id,
        });
        return (await orderViews(ctx, [o], 'seller'))[0];
      },
    });

    route(app, ctx, {
      method: 'POST',
      url: '/v1/orders/:id/complete',
      summary: 'Confirm receipt (buyer)',
      tags: ['commerce'],
      auth: 'user',
      params: idParams,
      rateLimit: { limit: 60, windowSec: 3600, by: 'user' },
      handler: async ({ auth, req, params }) => {
        await gate(auth.userId);
        const o0 = await loadOrder(ctx.db, params.id).catch(() => null);
        if (!o0 || o0.buyer_id !== auth.userId) throw notFound('Order');
        await withTransaction(ctx.db, async (tx) => {
          const o = await loadOrder(tx, params.id, { lock: true });
          if (o.status === 'partially_refunded' && !o.fulfilled_at)
            throw new AppError('conflict', 'This order has not been fulfilled yet', {
              reason: 'invalid_order_transition',
              status: o.status,
            });
          await transitionOrder(tx, o.id, 'completed', 'buyer');
          await audit(
            ctx,
            {
              actorId: auth.userId,
              action: 'order.completed',
              targetType: 'order',
              targetId: o.id,
            },
            req,
            tx,
          );
        });
        return (await orderViews(ctx, [await loadOrder(ctx.db, params.id)], 'buyer'))[0];
      },
    });
  },
};
