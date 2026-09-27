import type { Pool, PoolClient } from 'pg';
import { DROP_HOLD_MINUTES } from '@yapilapi/shared';
import { AppError, notFound } from './errors.ts';
import { enqueue } from './jobs.ts';
import type { RealtimeHub } from './realtime.ts';
import { notify } from './services.ts';
import { isBlockedEitherWay } from './users.ts';
import { notBlockedSql } from './visibility.ts';

type Q = Pool | PoolClient;

/** Opens a scheduled drop at its start time and tells the people waiting. */
export const DROP_OPEN_JOB = 'drops.open';
/** Ends an open drop at its end time. */
export const DROP_END_JOB = 'drops.end';
/** Gives back the units an unpaid drop order was holding, once its hold is over. */
export const DROP_RELEASE_JOB = 'drops.release';

/**
 * Drops aliased `d`, the seller's profile `dpr` and user `du`. The seller always sees their own
 * (drafts included); anyone else sees a published drop by an active seller they haven't blocked
 * (and who hasn't blocked them), and for a private account only when they follow it. Drops a
 * moderator removed are hidden from everyone.
 */
export function dropVisibleSql(v: string): string {
  return `(d.deleted_at IS NULL AND (d.seller_id = ${v} OR (
    d.status <> 'draft' AND du.status = 'active' AND ${notBlockedSql('d.seller_id', v)}
    AND (NOT dpr.is_private OR EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = ${v} AND f.followee_id = d.seller_id)))))`;
}

/**
 * The status of the newest published drop holding the product `pd` ('scheduled', 'open' or
 * 'ended'), or NULL when it isn't in one (drafts and cancelled drops don't count). Anything but
 * NULL or 'open' means the product isn't on sale right now.
 */
export const dropGateSql = (pd: string) =>
  `(SELECT d.status FROM drop_items di JOIN drops d ON d.id = di.drop_id
    WHERE di.product_id = ${pd} AND d.status IN ('scheduled', 'open', 'ended') ORDER BY d.published_at DESC LIMIT 1)`;

/** Tell the seller's and the waiting people's open pages that a drop changed. */
export async function publishDropChange(db: Q, realtime: RealtimeHub, dropId: string): Promise<void> {
  const { rows } = await db.query<{ id: string; status: string }>(
    `SELECT d.id, d.status, d.seller_id, array(SELECT user_id FROM drop_reminders WHERE drop_id = d.id LIMIT 5000) AS waiting FROM drops d WHERE d.id = $1`,
    [dropId],
  );
  const d = rows[0] as { id: string; status: string; seller_id: string; waiting: string[] } | undefined;
  if (d) await realtime.publish([d.seller_id, ...d.waiting], { type: 'drop.updated', data: { id: d.id, status: d.status } });
}

/**
 * Ends an open drop when every product in it has a set number and none are left. Returns
 * whether it ended now. The seller is told.
 */
async function endIfSoldOut(c: Q, realtime: RealtimeHub, dropId: string): Promise<boolean> {
  const { rows } = await c.query<{ seller_id: string; title: string }>(
    `UPDATE drops SET status = 'ended', end_reason = 'sold_out', ended_at = now(), updated_at = now()
     WHERE id = $1 AND status = 'open'
       AND NOT EXISTS (SELECT 1 FROM drop_items di JOIN products pd ON pd.id = di.product_id
                       WHERE di.drop_id = $1 AND pd.deleted_at IS NULL AND (di.quantity IS NULL OR di.taken < di.quantity))
     RETURNING seller_id, title`,
    [dropId],
  );
  const d = rows[0];
  if (!d) return false;
  await notify(c, realtime, {
    userId: d.seller_id,
    category: 'commerce',
    type: 'drop_sold_out',
    entityType: 'drop',
    entityId: dropId,
    data: { title: d.title },
  });
  return true;
}

const soldOut = (left: number) =>
  left > 0 ? new AppError(409, 'out_of_stock', left === 1 ? 'Only 1 is left.' : `Only ${left} are left.`) : new AppError(409, 'sold_out', 'This has sold out.');

/**
 * Called inside the transaction that creates an order, after its items are inserted: products
 * that are in a published drop can only be bought while that drop is open. Each unit is taken in
 * one statement that checks what is left (so parallel orders can never take more than there
 * is), then the buyer's own total is checked against the per-buyer limit while that row is
 * still locked. The units are held for DROP_HOLD_MINUTES; unpaid by then, they go back.
 */
export async function takeDropStock(
  c: PoolClient,
  realtime: RealtimeHub,
  order: { orderId: string; buyerId: string; items: { productId: string; quantity: number }[] },
): Promise<void> {
  // The same product on two lines counts as one amount.
  const wanted = new Map<string, number>();
  for (const i of order.items) wanted.set(i.productId, (wanted.get(i.productId) ?? 0) + i.quantity);
  const ids = [...wanted.keys()];
  const { rows: gates } = await c.query<{
    product_id: string;
    drop_id: string;
    status: string;
    end_reason: string | null;
    seller_id: string;
    past_end: boolean;
  }>(
    `SELECT DISTINCT ON (di.product_id) di.product_id, di.drop_id, d.status, d.end_reason, d.seller_id, coalesce(d.ends_at <= now(), false) AS past_end
     FROM drop_items di JOIN drops d ON d.id = di.drop_id
     WHERE di.product_id = ANY($1) AND d.status IN ('scheduled', 'open', 'ended')
     ORDER BY di.product_id, d.published_at DESC`,
    [ids],
  );
  if (!gates.length) return;
  const drops = new Set<string>();
  for (const g of gates) {
    if (g.status === 'scheduled') throw new AppError(409, 'drop_not_open', 'This goes on sale when the drop opens.');
    // Sold out (it may come back if an unpaid order's hold ends) or past its end time.
    if (g.status === 'ended' && g.end_reason === 'sold_out' && !g.past_end) throw soldOut(0);
    if (g.status === 'ended' || g.past_end) throw new AppError(409, 'drop_ended', 'This drop has ended.');
    if (await isBlockedEitherWay(c, order.buyerId, g.seller_id)) throw notFound('One of those products');
    const quantity = wanted.get(g.product_id)!;
    const took = await c.query<{ per_buyer_limit: number | null }>(
      `UPDATE drop_items SET taken = taken + $3,
              sold_out_at = CASE WHEN quantity IS NOT NULL AND taken + $3 >= quantity THEN now() ELSE sold_out_at END
       WHERE drop_id = $1 AND product_id = $2 AND (quantity IS NULL OR taken + $3 <= quantity)
       RETURNING per_buyer_limit`,
      [g.drop_id, g.product_id, quantity],
    );
    if (!took.rows[0]) {
      const left = (
        await c.query<{ left: number }>(`SELECT greatest(0, quantity - taken) AS left FROM drop_items WHERE drop_id = $1 AND product_id = $2`, [
          g.drop_id,
          g.product_id,
        ])
      ).rows[0]?.left;
      throw soldOut(left ?? 0);
    }
    const limit = took.rows[0].per_buyer_limit;
    if (limit !== null) {
      // The row above stays locked until this transaction ends, so the buyer's other orders for it are all counted here.
      const had = (
        await c.query<{ n: number }>(
          `SELECT coalesce(sum(quantity), 0)::int AS n FROM drop_orders WHERE drop_id = $1 AND product_id = $2 AND buyer_id = $3 AND status <> 'released'`,
          [g.drop_id, g.product_id, order.buyerId],
        )
      ).rows[0]!.n;
      if (had + quantity > limit)
        throw new AppError(
          409,
          'drop_limit',
          had > 0 ? `You can buy up to ${limit} of this, and you already have ${had}.` : `You can buy up to ${limit} of this.`,
          { limit, had },
        );
    }
    await c.query(
      `INSERT INTO drop_orders (order_id, product_id, drop_id, buyer_id, quantity, hold_until) VALUES ($1,$2,$3,$4,$5, now() + make_interval(mins => $6))`,
      [order.orderId, g.product_id, g.drop_id, order.buyerId, quantity, DROP_HOLD_MINUTES],
    );
    drops.add(g.drop_id);
  }
  await enqueue(c, DROP_RELEASE_JOB, { orderId: order.orderId }, DROP_HOLD_MINUTES * 60);
  for (const id of drops) if (await endIfSoldOut(c, realtime, id)) await publishDropChange(c, realtime, id);
}

/** Give units back to their drops: drop_orders rows (already marked released) of these amounts. */
async function giveBack(c: Q, rows: { drop_id: string; product_id: string; quantity: number }[]): Promise<void> {
  for (const r of rows)
    await c.query(
      `UPDATE drop_items SET taken = greatest(0, taken - $3),
              sold_out_at = CASE WHEN quantity IS NOT NULL AND taken - $3 < quantity THEN NULL ELSE sold_out_at END
       WHERE drop_id = $1 AND product_id = $2`,
      [r.drop_id, r.product_id, r.quantity],
    );
  // A drop that ended because it sold out is on sale again while its end time hasn't come.
  for (const id of new Set(rows.map((r) => r.drop_id)))
    await c.query(
      `UPDATE drops SET status = 'open', end_reason = NULL, ended_at = NULL, updated_at = now()
       WHERE id = $1 AND status = 'ended' AND end_reason = 'sold_out' AND (ends_at IS NULL OR ends_at > now())`,
      [id],
    );
}

/**
 * The units of an order go back on sale: its payment failed, it wasn't paid in time, or it was
 * refunded. Safe to call more than once, and for orders that have nothing in a drop.
 */
export async function releaseDropOrder(c: Q, orderId: string): Promise<void> {
  const { rows } = await c.query<{ drop_id: string; product_id: string; quantity: number }>(
    `UPDATE drop_orders SET status = 'released', updated_at = now() WHERE order_id = $1 AND status IN ('held', 'paid') RETURNING drop_id, product_id, quantity`,
    [orderId],
  );
  await giveBack(c, rows);
}

/**
 * The payment for an order came in. Units still held become sold. Units already given back
 * (the payment came after the hold ended) are taken again if the drop is still open and they
 * are still there; returns false when they aren't, and the caller refunds the order.
 */
export async function confirmDropOrder(c: PoolClient, orderId: string): Promise<boolean> {
  const { rows } = await c.query<{ drop_id: string; product_id: string; quantity: number; status: string; buyer_id: string }>(
    `SELECT drop_id, product_id, quantity, status, buyer_id FROM drop_orders WHERE order_id = $1 ORDER BY product_id FOR UPDATE`,
    [orderId],
  );
  if (!rows.length) return true;
  const retaken: typeof rows = [];
  let ok = true;
  for (const r of rows.filter((x) => x.status === 'released')) {
    const took = await c.query(
      `UPDATE drop_items di SET taken = taken + $3,
              sold_out_at = CASE WHEN quantity IS NOT NULL AND taken + $3 >= quantity THEN now() ELSE sold_out_at END
       FROM drops d
       WHERE di.drop_id = $1 AND di.product_id = $2 AND d.id = di.drop_id AND d.status = 'open' AND coalesce(d.ends_at > now(), true)
         AND (di.quantity IS NULL OR di.taken + $3 <= di.quantity)
         AND (di.per_buyer_limit IS NULL OR $3 + (SELECT coalesce(sum(o.quantity), 0) FROM drop_orders o
               WHERE o.drop_id = $1 AND o.product_id = $2 AND o.buyer_id = $4 AND o.status <> 'released' AND o.order_id <> $5) <= di.per_buyer_limit)
       RETURNING di.drop_id`,
      [r.drop_id, r.product_id, r.quantity, r.buyer_id, orderId],
    );
    if (!took.rowCount) {
      ok = false;
      break;
    }
    retaken.push(r);
  }
  if (!ok) {
    await giveBack(c, retaken);
    await releaseDropOrder(c, orderId);
    return false;
  }
  await c.query(`UPDATE drop_orders SET status = 'paid', updated_at = now() WHERE order_id = $1`, [orderId]);
  return true;
}

/**
 * An unpaid order's hold is over: the order is cancelled and its units go back on sale. A
 * payment that still arrives later is handled by confirmDropOrder.
 */
export async function expireDropHold(c: PoolClient, orderId: string): Promise<boolean> {
  const o = (await c.query<{ status: string }>(`SELECT status FROM orders WHERE id = $1 FOR UPDATE`, [orderId])).rows[0];
  if (!o || o.status !== 'pending') return false;
  const held = await c.query(`SELECT 1 FROM drop_orders WHERE order_id = $1 AND status = 'held'`, [orderId]);
  if (!held.rowCount) return false;
  await c.query(`UPDATE orders SET status = 'cancelled', updated_at = now() WHERE id = $1`, [orderId]);
  await releaseDropOrder(c, orderId);
  return true;
}
