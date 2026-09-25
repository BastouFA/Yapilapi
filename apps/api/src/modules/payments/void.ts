import type { Queryable } from '@yapilapi/database';
import type { AppContext } from '../../lib/context.js';
import { getPaymentProvider } from './provider.js';

/**
 * Mark unpaid payments of an order as cancelled (inside the caller's transaction) and return their provider refs so the caller can
 * cancel them at the provider after COMMIT (`cancelAtProvider`). A payment that already succeeded at the provider but whose webhook
 * has not arrived cannot be cancelled there; the provider call fails, and the late webhook triggers an automatic refund instead.
 */
export async function voidOpenPayments(
  tx: Queryable,
  orderId: string,
): Promise<Array<{ id: string; providerRef: string }>> {
  const { rows } = await tx.query<{ id: string; provider_ref: string | null }>(
    `UPDATE payments SET status = 'cancelled' WHERE order_id = $1 AND status IN ('requires_payment_method','requires_action','authorized') RETURNING id, provider_ref`,
    [orderId],
  );
  return rows
    .filter((r) => r.provider_ref)
    .map((r) => ({ id: r.id, providerRef: r.provider_ref! }));
}

export async function cancelAtProvider(
  ctx: AppContext,
  payments: Array<{ id: string; providerRef: string }>,
): Promise<void> {
  const provider = getPaymentProvider(ctx);
  for (const p of payments) {
    try {
      await provider.cancelPayment(p.providerRef, { idempotencyKey: `cancel:${p.id}` });
    } catch (err) {
      ctx.log.warn(
        { paymentId: p.id, err: (err as Error).message },
        'could not cancel payment at provider',
      );
    }
  }
}
