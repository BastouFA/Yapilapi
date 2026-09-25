import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { withTransaction } from '@yapilapi/database';
import { conflict, notFound } from '@yapilapi/shared';
import type { AppContext } from '../../lib/context.js';
import type { AuthContext } from '../../lib/auth-context.js';
import { audit } from '../../lib/audit.js';
import { publishLive } from './events.js';
import { loadAccess, requireCan } from './access.js';
import { readRoom } from './interact.js';

const MAX_PRODUCTS = 20;
export const productParams = z.object({ id: z.uuid(), productId: z.uuid() });

interface ProdRow {
  product_id: string;
  pinned: boolean;
  position: number;
  title: string;
  price_cents: number;
  currency: string;
  kind: string;
  status: string;
  stock: number | null;
}
const view = (p: ProdRow) => ({
  productId: p.product_id,
  title: p.title,
  priceCents: p.price_cents,
  currency: p.currency,
  kind: p.kind,
  pinned: p.pinned,
  available: p.status === 'active' && (p.stock === null || p.stock > 0),
  buyUrl: `/v1/products/${p.product_id}`,
});

/** A live session can showcase only products the HOST sells (their own, or a business they own/manage) and that are on sale. */
export async function addProduct(
  ctx: AppContext,
  auth: AuthContext,
  id: string,
  productId: string,
  req?: FastifyRequest,
) {
  await ctx.flags.require('LIVE', auth.userId);
  await ctx.flags.require('COMMERCE', auth.userId);
  const a = await loadAccess(ctx.db, auth.userId, id);
  requireCan(a, 'products');
  if (a.session.status === 'ended' || a.session.status === 'cancelled')
    throw conflict('This session is over', { reason: 'invalid_state' });
  const p = (
    await ctx.db.query<{ id: string }>(
      `SELECT p.id FROM products p WHERE p.id = $1 AND p.deleted_at IS NULL AND p.status = 'active'
        AND (p.seller_user_id = $2 OR EXISTS (SELECT 1 FROM business_members bm WHERE bm.business_id = p.business_id AND bm.user_id = $2 AND bm.role IN ('owner','manager')))`,
      [productId, a.session.host_id],
    )
  ).rows[0];
  if (!p) throw notFound('Product');
  const n = Number(
    (await ctx.db.query('SELECT count(*)::int AS n FROM live_products WHERE live_id = $1', [id]))
      .rows[0]!.n,
  );
  const r = await ctx.db.query(
    `INSERT INTO live_products (live_id, product_id, position) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING 1`,
    [id, productId, n],
  );
  if (r.rowCount && n >= MAX_PRODUCTS) {
    await ctx.db.query('DELETE FROM live_products WHERE live_id = $1 AND product_id = $2', [
      id,
      productId,
    ]);
    throw conflict(`At most ${MAX_PRODUCTS} products per session`, { reason: 'too_many_products' });
  }
  await audit(
    ctx,
    {
      actorId: auth.userId,
      action: 'live.product_added',
      targetType: 'live_session',
      targetId: id,
      metadata: { productId },
    },
    req,
  );
}

export async function removeProduct(
  ctx: AppContext,
  auth: AuthContext,
  id: string,
  productId: string,
  req?: FastifyRequest,
): Promise<void> {
  await ctx.flags.require('LIVE', auth.userId);
  const a = await loadAccess(ctx.db, auth.userId, id);
  requireCan(a, 'products');
  const r = await ctx.db.query(
    'DELETE FROM live_products WHERE live_id = $1 AND product_id = $2 RETURNING pinned',
    [id, productId],
  );
  if (!r.rowCount) throw notFound('Product');
  await audit(
    ctx,
    {
      actorId: auth.userId,
      action: 'live.product_removed',
      targetType: 'live_session',
      targetId: id,
      metadata: { productId },
    },
    req,
  );
  if (r.rows[0]!.pinned) publishLive(ctx, id, { type: 'product.unpinned', productId });
}

/** One spotlight at a time: pinning replaces the previous pin (the partial unique index backs this up under concurrency). */
export async function pinProduct(
  ctx: AppContext,
  auth: AuthContext,
  id: string,
  productId: string,
  pinned: boolean,
  req?: FastifyRequest,
) {
  await ctx.flags.require('LIVE', auth.userId);
  const a = await loadAccess(ctx.db, auth.userId, id);
  requireCan(a, 'products');
  if (a.session.status !== 'live')
    throw conflict('Products are pinned while the session is on air', {
      reason: 'not_live',
      status: a.session.status,
    });
  await withTransaction(ctx.db, async (tx) => {
    await tx.query('SELECT 1 FROM live_sessions WHERE id = $1 FOR UPDATE', [id]);
    if (
      !(
        await tx.query('SELECT 1 FROM live_products WHERE live_id = $1 AND product_id = $2', [
          id,
          productId,
        ])
      ).rowCount
    )
      throw notFound('Product');
    if (pinned) {
      await tx.query(
        'UPDATE live_products SET pinned = false WHERE live_id = $1 AND pinned AND product_id <> $2',
        [id, productId],
      );
      await tx.query(
        'UPDATE live_products SET pinned = true WHERE live_id = $1 AND product_id = $2',
        [id, productId],
      );
    } else
      await tx.query(
        'UPDATE live_products SET pinned = false WHERE live_id = $1 AND product_id = $2',
        [id, productId],
      );
  });
  await audit(
    ctx,
    {
      actorId: auth.userId,
      action: pinned ? 'live.product_pinned' : 'live.product_unpinned',
      targetType: 'live_session',
      targetId: id,
      metadata: { productId },
    },
    req,
  );
  const prod = (await listProductsRaw(ctx, id)).find((p) => p.product_id === productId);
  publishLive(
    ctx,
    id,
    pinned
      ? { type: 'product.pinned', product: prod ? view(prod) : { productId } }
      : { type: 'product.unpinned', productId },
  );
}

async function listProductsRaw(ctx: AppContext, id: string): Promise<ProdRow[]> {
  return (
    await ctx.db.query<ProdRow>(
      `SELECT lp.product_id, lp.pinned, lp.position, p.title, p.price_cents, p.currency, p.kind, p.status, p.stock
       FROM live_products lp JOIN products p ON p.id = lp.product_id WHERE lp.live_id = $1 AND p.deleted_at IS NULL AND p.status <> 'draft' ORDER BY lp.pinned DESC, lp.position`,
      [id],
    )
  ).rows;
}

export async function listProducts(ctx: AppContext, viewerId: string, id: string) {
  await readRoom(ctx, viewerId, id);
  // COMMERCE off: the shelf is empty (never a 404 for the room itself).
  if (!(await ctx.flags.isEnabled('COMMERCE', viewerId))) return { items: [], pinned: null };
  const items = (await listProductsRaw(ctx, id)).map(view);
  return { items, pinned: items.find((i) => i.pinned) ?? null };
}

/** Where a viewer buys, tips, gifts and subscribes from inside a session: pointers to the existing (audited, ledgered) payment flows. */
export async function commerceView(ctx: AppContext, viewerId: string, id: string) {
  const a = await readRoom(ctx, viewerId, id);
  const host = a.session.host_id;
  const [plans, creator, products] = await Promise.all([
    ctx.db.query<{
      id: string;
      name: string;
      tier: number;
      price_cents: number;
      currency: string;
      interval: string;
    }>(
      `SELECT id, name, tier, price_cents, currency, interval FROM subscription_plans WHERE creator_id = $1 AND active ORDER BY tier`,
      [host],
    ),
    ctx.db.query(`SELECT 1 FROM creators WHERE user_id = $1 AND status = 'active'`, [host]),
    listProducts(ctx, viewerId, id),
  ]);
  const isCreator = Boolean(creator.rowCount);
  const onAir = a.session.status === 'live';
  return {
    gifts: isCreator
      ? {
          enabled: onAir && viewerId !== host,
          sendTo: `/v1/creators/${host}/gifts`,
          liveSessionId: id,
          catalog: '/v1/gifts/catalog',
        }
      : { enabled: false },
    subscriptions: isCreator
      ? {
          plans: plans.rows.map((p) => ({
            id: p.id,
            name: p.name,
            tier: p.tier,
            priceCents: p.price_cents,
            currency: p.currency,
            interval: p.interval,
          })),
          subscribe: `/v1/creators/${host}/subscribe`,
        }
      : { plans: [] },
    ticket: a.session.ticket_type_id
      ? {
          ticketTypeId: a.session.ticket_type_id,
          eventId: a.session.event_id,
          held: a.entitled,
          buy: `/v1/events/${a.session.event_id}`,
        }
      : null,
    pinnedProduct: products.pinned,
  };
}
