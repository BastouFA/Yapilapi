import type { FastifyRequest } from 'fastify';
import { withTransaction } from '@yapilapi/database';
import { AppError } from '@yapilapi/shared';
import type { AppContext } from '../../lib/context.js';
import { audit } from '../../lib/audit.js';
import { cancelOrderTx, loadOrder, transitionOrder } from '../commerce/orders.js';
import { notifyUser } from './notify.js';
import { cancelAtProvider } from './void.js';

/**
 * Staff decision on an order held by the fraud rules (`pending_review`).
 *  - approve: back to `pending_payment` with a fresh reservation; the order is marked `staff_approved` so the pay-time rules do not
 *    hold it again for the same reasons (hard `block` decisions still apply);
 *  - reject: the order is cancelled and its stock released.
 */
export async function reviewOrder(
  ctx: AppContext,
  staffId: string,
  orderId: string,
  decision: 'approve' | 'reject',
  note: string | undefined,
  req?: FastifyRequest,
): Promise<{ status: string; buyerId: string }> {
  const out = await withTransaction(ctx.db, async (tx) => {
    const order = await loadOrder(tx, orderId, { lock: true });
    if (order.status !== 'pending_review')
      throw new AppError(
        'conflict',
        `This order is ${order.status.replace(/_/g, ' ')}, not waiting for review`,
        { reason: 'not_pending_review', status: order.status },
      );
    if (order.buyer_id === staffId)
      throw new AppError('forbidden', 'You cannot review your own order');
    let voided: Array<{ id: string; providerRef: string }> = [];
    if (decision === 'approve') {
      await transitionOrder(tx, order.id, 'pending_payment', 'staff', {
        reservedUntil: new Date(Date.now() + ctx.config.ORDER_RESERVATION_MINUTES * 60_000),
      });
      await tx.query(
        `UPDATE orders SET fraud_flags = (SELECT COALESCE(array_agg(DISTINCT f), ARRAY[]::text[]) FROM unnest(fraud_flags || ARRAY['staff_approved']) f) WHERE id = $1`,
        [order.id],
      );
    } else {
      voided = await cancelOrderTx(ctx, tx, order.id, 'staff', 'review_rejected');
    }
    await audit(
      ctx,
      {
        actorId: staffId,
        actorType: 'staff',
        action: decision === 'approve' ? 'order.review_approved' : 'order.review_rejected',
        targetType: 'order',
        targetId: order.id,
        metadata: {
          note: note?.slice(0, 500) ?? null,
          score: order.fraud_score,
          flags: order.fraud_flags,
          totalCents: order.total_cents,
          currency: order.currency,
        },
      },
      req,
      tx,
    );
    return {
      buyerId: order.buyer_id,
      voided,
      status: decision === 'approve' ? 'pending_payment' : 'cancelled',
    };
  });
  await cancelAtProvider(ctx, out.voided);
  await notifyUser(ctx, out.buyerId, {
    kind: decision === 'approve' ? 'order_review_approved' : 'order_review_rejected',
    actorId: staffId,
    targetType: 'order',
    targetId: orderId,
  });
  return { status: out.status, buyerId: out.buyerId };
}
