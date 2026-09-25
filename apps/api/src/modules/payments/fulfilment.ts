import { randomBytes } from 'node:crypto';
import { withTransaction, type Queryable, type Tx } from '@yapilapi/database';
import { AppError } from '@yapilapi/shared';
import type { AppContext } from '../../lib/context.js';
import { audit } from '../../lib/audit.js';
import { transitionOrder } from '../commerce/orders.js';
import { REFUNDABLE_ORDER_STATUSES, type OrderStatus } from '../commerce/order-state.js';
import { grantCommunityMembership } from '../communities/index.js';
import { notifySeller, notifyUser } from './notify.js';
import { createRefund, executeRefund, type PaymentRow } from './refunds.js';
import { orderSeller } from '../commerce/access.js';
import { loadOrder } from '../commerce/orders.js';

interface EntRow {
  id: string;
  payment_id: string;
  order_id: string | null;
  order_item_id: string | null;
  user_id: string;
  kind: 'digital' | 'ticket' | 'booking' | 'community';
  status: string;
  ref_id: string | null;
  quantity: number;
  attempts: number;
}

/** Create one pending entitlement per order line that unlocks something. Runs in the payment-capture transaction (outbox pattern). */
export async function createEntitlements(
  tx: Queryable,
  payment: Pick<PaymentRow, 'id' | 'order_id' | 'payer_id' | 'purpose' | 'metadata'>,
): Promise<number> {
  if (payment.purpose === 'community_membership') {
    const r = await tx.query(
      `INSERT INTO order_entitlements (payment_id, user_id, kind, ref_id) VALUES ($1,$2,'community',$3) ON CONFLICT (payment_id) WHERE kind = 'community' DO NOTHING`,
      [payment.id, payment.payer_id, payment.metadata.communityId],
    );
    return r.rowCount ?? 0;
  }
  if (!payment.order_id) return 0;
  const items = await tx.query<{
    id: string;
    item_type: string;
    product_kind: string | null;
    product_id: string | null;
    ticket_type_id: string | null;
    booking_id: string | null;
    quantity: number;
  }>(
    'SELECT id, item_type, product_kind, product_id, ticket_type_id, booking_id, quantity FROM order_items WHERE order_id = $1',
    [payment.order_id],
  );
  let n = 0;
  for (const it of items.rows) {
    let kind: EntRow['kind'] | null = null;
    let ref: string | null = null;
    if (it.item_type === 'ticket') {
      kind = 'ticket';
      ref = it.ticket_type_id;
    } else if (it.booking_id) {
      kind = 'booking';
      ref = it.booking_id;
    } else if (it.product_kind === 'digital') {
      kind = 'digital';
      ref = it.product_id;
    }
    if (!kind) continue;
    const r = await tx.query(
      `INSERT INTO order_entitlements (payment_id, order_id, order_item_id, user_id, kind, ref_id, quantity) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (order_item_id) WHERE order_item_id IS NOT NULL DO NOTHING`,
      [payment.id, payment.order_id, it.id, payment.payer_id, kind, ref, it.quantity],
    );
    n += r.rowCount ?? 0;
  }
  return n;
}

const TICKET_FAILURES = new Set(['event_closed', 'ticket_sold_out', 'event_full', 'ticket_limit']);
const newTicketCode = (): string => `TKT-${randomBytes(8).toString('hex').toUpperCase()}`;

type AttendFn = (
  ctx: AppContext,
  input: {
    eventId: string;
    userId: string;
    ticketTypeId: string;
    orderId: string;
    quantity?: number;
  },
) => Promise<unknown>;

/**
 * The events module owns capacity. It is loaded lazily so commerce degrades to a *pending* (retryable) entitlement, never to a silent
 * success, if that module is not available in a deployment.
 */
async function loadAttend(): Promise<AttendFn | null> {
  try {
    const m = (await import('../events/index.js')) as { attendEventWithTicket?: AttendFn };
    return typeof m.attendEventWithTicket === 'function' ? m.attendEventWithTicket : null;
  } catch {
    return null;
  }
}

class PermanentFailure extends Error {
  constructor(
    message: string,
    readonly reason: string,
  ) {
    super(message);
  }
}
class TransientFailure extends Error {}

async function grantOne(ctx: AppContext, e: EntRow): Promise<void> {
  switch (e.kind) {
    case 'digital':
      return; // The granted entitlement row itself is the access record checked by the download endpoints.
    case 'booking': {
      const upd = await ctx.db.query(
        `UPDATE bookings SET status = 'confirmed', decided_at = now() WHERE id = $1 AND status = 'requested'`,
        [e.ref_id],
      );
      if (upd.rowCount) return;
      const cur = await ctx.db.query<{ status: string }>(
        'SELECT status FROM bookings WHERE id = $1',
        [e.ref_id],
      );
      if (cur.rows[0]?.status === 'confirmed') return;
      throw new PermanentFailure('The booking is no longer available', 'booking_unavailable');
    }
    case 'ticket': {
      const attend = await loadAttend();
      if (!attend) throw new TransientFailure('events module unavailable');
      const it = await ctx.db.query<{ event_id: string; ticket_type_id: string; quantity: number }>(
        'SELECT event_id, ticket_type_id, quantity FROM order_items WHERE id = $1',
        [e.order_item_id],
      );
      const item = it.rows[0]!;
      try {
        await attend(ctx, {
          eventId: item.event_id,
          userId: e.user_id,
          ticketTypeId: item.ticket_type_id,
          orderId: e.order_id!,
          quantity: item.quantity,
        });
      } catch (err) {
        const reason =
          err instanceof AppError && err.code === 'conflict'
            ? (err.details as { reason?: string } | undefined)?.reason
            : undefined;
        if (reason && TICKET_FAILURES.has(reason))
          throw new PermanentFailure(`tickets unavailable: ${reason}`, reason);
        if (
          err instanceof AppError &&
          (err.code === 'not_found' || err.code === 'validation_failed')
        )
          throw new PermanentFailure(err.message, 'ticket_type_missing');
        throw err;
      }
      // Issue the ticket rows (one per unit) idempotently.
      const have = await ctx.db.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM tickets WHERE order_item_id = $1',
        [e.order_item_id],
      );
      for (let i = have.rows[0]!.n; i < item.quantity; i++) {
        await ctx.db.query(
          'INSERT INTO tickets (ticket_type_id, event_id, order_item_id, owner_id, code) VALUES ($1,$2,$3,$4,$5)',
          [item.ticket_type_id, item.event_id, e.order_item_id, e.user_id, newTicketCode()],
        );
      }
      return;
    }
    case 'community': {
      try {
        await grantCommunityMembership(ctx, e.ref_id!, e.user_id);
      } catch (err) {
        if (err instanceof AppError && ['forbidden', 'not_found'].includes(err.code))
          throw new PermanentFailure(err.message, 'membership_unavailable');
        throw err;
      }
    }
  }
}

/**
 * Process the pending entitlements of a payment (idempotent; safe to call from the webhook, the retry job or both at once: rows are
 * claimed with an UPDATE ... WHERE claimed_at is old). Permanent failures refund the affected line automatically.
 */
export async function fulfilPayment(
  ctx: AppContext,
  paymentId: string,
): Promise<{ granted: number; failed: number; pending: number }> {
  const { rows } = await ctx.db.query<EntRow>(
    `SELECT id FROM order_entitlements WHERE payment_id = $1 AND status = 'pending' ORDER BY created_at, id`,
    [paymentId],
  );
  let granted = 0;
  let failed = 0;
  let pending = 0;
  let orderId: string | null = null;
  for (const r of rows) {
    const claimed = await ctx.db.query<EntRow>(
      `UPDATE order_entitlements SET attempts = attempts + 1, claimed_at = now()
        WHERE id = $1 AND status = 'pending' AND (claimed_at IS NULL OR claimed_at < now() - interval '2 minutes')
        RETURNING id, payment_id, order_id, order_item_id, user_id, kind, status, ref_id, quantity, attempts`,
      [r.id],
    );
    const e = claimed.rows[0];
    if (!e) continue;
    orderId = e.order_id;
    try {
      await grantOne(ctx, e);
      await ctx.db.query(
        `UPDATE order_entitlements SET status = 'granted', granted_at = now(), last_error = NULL WHERE id = $1 AND status = 'pending'`,
        [e.id],
      );
      await audit(ctx, {
        actorType: 'system',
        action: 'entitlement.granted',
        targetType: 'order_entitlement',
        targetId: e.id,
        metadata: { kind: e.kind, orderId: e.order_id, paymentId },
      });
      granted += 1;
    } catch (err) {
      if (err instanceof PermanentFailure) {
        await ctx.db.query(
          `UPDATE order_entitlements SET status = 'failed', last_error = $2 WHERE id = $1`,
          [e.id, err.reason],
        );
        await audit(ctx, {
          actorType: 'system',
          action: 'entitlement.failed',
          targetType: 'order_entitlement',
          targetId: e.id,
          metadata: { kind: e.kind, reason: err.reason, orderId: e.order_id },
        });
        await autoRefundFailedEntitlement(ctx, e, err.reason);
        failed += 1;
      } else {
        // Transient: release the claim so the retry job (or the next webhook) tries again.
        await ctx.db.query(
          `UPDATE order_entitlements SET claimed_at = NULL, last_error = $2 WHERE id = $1`,
          [e.id, (err as Error).message.slice(0, 200)],
        );
        ctx.log.error(
          { entitlementId: e.id, err: (err as Error).message },
          'fulfilment step failed; will retry',
        );
        pending += 1;
      }
    }
  }
  if (orderId) await finalizeOrderFulfilment(ctx, orderId);
  return { granted, failed, pending };
}

/** Money was taken but the goods cannot be delivered: refund that line (or the whole payment for a membership) automatically. */
async function autoRefundFailedEntitlement(
  ctx: AppContext,
  e: EntRow,
  reason: string,
): Promise<void> {
  try {
    if (e.order_id && e.order_item_id) {
      const { refund } = await createRefund(ctx, {
        orderId: e.order_id,
        actor: 'system',
        actorId: 'system',
        itemId: e.order_item_id,
        reason: `Automatic refund: ${reason}`,
        key: `auto:${e.id}`,
        auto: true,
        restock: false,
      });
      await executeRefund(ctx, refund.id);
    } else {
      await refundWholePayment(ctx, e.payment_id, `Automatic refund: ${reason}`, `auto:${e.id}`);
    }
    const order = e.order_id ? await loadOrder(ctx.db, e.order_id) : null;
    await notifyUser(ctx, e.user_id, {
      kind: 'order_item_refunded',
      targetType: e.order_id ? 'order' : 'payment',
      targetId: e.order_id ?? e.payment_id,
      data: { reason },
    });
    if (order)
      await notifySeller(ctx, orderSeller(order), {
        kind: 'order_item_refunded',
        targetType: 'order',
        targetId: order.id,
        data: { reason },
      });
  } catch (err) {
    ctx.log.error({ entitlementId: e.id, err: (err as Error).message }, 'automatic refund failed');
    await audit(ctx, {
      actorType: 'system',
      action: 'refund.auto_failed',
      targetType: 'order_entitlement',
      targetId: e.id,
      metadata: { reason, error: (err as Error).message.slice(0, 200) },
    });
  }
}

/**
 * Refund an entire captured payment (late payments on cancelled orders, failed community membership). Orders that are still refundable go
 * through the normal workflow; otherwise (cancelled order, no order) a payment-level refund row is created directly.
 */
export async function refundWholePayment(
  ctx: AppContext,
  paymentId: string,
  reason: string,
  key: string,
): Promise<void> {
  const pay = (
    await ctx.db.query<{
      id: string;
      order_id: string | null;
      amount_cents: number;
      currency: string;
      payer_id: string;
      refunded_cents: number;
      order_status: string | null;
    }>(
      `SELECT p.id, p.order_id, p.amount_cents, p.currency, p.payer_id, p.refunded_cents, o.status AS order_status FROM payments p LEFT JOIN orders o ON o.id = p.order_id WHERE p.id = $1`,
      [paymentId],
    )
  ).rows[0];
  if (!pay) return;
  if (
    pay.order_id &&
    pay.order_status &&
    REFUNDABLE_ORDER_STATUSES.includes(pay.order_status as OrderStatus)
  ) {
    const { refund } = await createRefund(ctx, {
      orderId: pay.order_id,
      actor: 'system',
      actorId: 'system',
      reason,
      key,
      auto: true,
      restock: false,
    });
    await executeRefund(ctx, refund.id);
    return;
  }
  const remaining = pay.amount_cents - pay.refunded_cents;
  if (remaining <= 0) return;
  const ins = await ctx.db.query<{ id: string }>(
    `INSERT INTO refunds (payment_id, order_id, amount_cents, currency, reason, status, requested_by, idempotency_key, auto, decision_note, decided_at)
     VALUES ($1,$2,$3,$4,$5,'approved',$6,$7,true,'Automatic refund', now()) ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
    [
      pay.id,
      pay.order_id,
      remaining,
      pay.currency,
      reason.slice(0, 1000),
      pay.payer_id,
      `system:${key}`,
    ],
  );
  if (ins.rows[0]) await executeRefund(ctx, ins.rows[0].id);
}

/** Digital-only, ticket-only and booking-only orders are fulfilled once every entitlement has been granted. */
export async function finalizeOrderFulfilment(ctx: AppContext, orderId: string): Promise<void> {
  await withTransaction(ctx.db, async (tx: Tx) => {
    const o = await loadOrder(tx, orderId, { lock: true });
    if (o.status !== 'paid') return;
    const items = await tx.query<{ n: number; manual: number }>(
      `SELECT count(*)::int AS n, count(*) FILTER (WHERE item_type = 'product' AND product_kind IN ('physical','service'))::int AS manual FROM order_items WHERE order_id = $1`,
      [orderId],
    );
    if (items.rows[0]!.manual > 0) return;
    const ents = await tx.query<{ open: number; granted: number }>(
      `SELECT count(*) FILTER (WHERE status = 'pending')::int AS open, count(*) FILTER (WHERE status = 'granted')::int AS granted FROM order_entitlements WHERE order_id = $1`,
      [orderId],
    );
    if (ents.rows[0]!.open > 0 || ents.rows[0]!.granted === 0) return;
    await transitionOrder(tx, orderId, 'fulfilled', 'system');
    await audit(
      ctx,
      {
        actorType: 'system',
        action: 'order.auto_fulfilled',
        targetType: 'order',
        targetId: orderId,
      },
      undefined,
      tx,
    );
  });
}

/** Job: pick up entitlements whose fulfilment crashed or hit a transient error (claims older than 2 minutes). */
export async function retryPendingFulfilments(ctx: AppContext): Promise<number> {
  const { rows } = await ctx.db.query<{ payment_id: string }>(
    `SELECT DISTINCT payment_id FROM order_entitlements WHERE status = 'pending' AND (claimed_at IS NULL OR claimed_at < now() - interval '2 minutes') AND created_at < now() - interval '5 seconds' LIMIT 200`,
  );
  for (const r of rows) await fulfilPayment(ctx, r.payment_id);
  return rows.length;
}
