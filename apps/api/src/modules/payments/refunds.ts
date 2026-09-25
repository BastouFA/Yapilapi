import { withTransaction, type Queryable, type Tx } from '@yapilapi/database';
import { AppError, conflict, forbidden, invalid, notFound } from '@yapilapi/shared';
import { PaymentProviderError, refundEntries } from '@yapilapi/payments';
import type { AppContext } from '../../lib/context.js';
import { audit, type AuditEntry } from '../../lib/audit.js';
import { hasSellerAccess, orderSeller } from '../commerce/access.js';
import { REFUNDABLE_ORDER_STATUSES, type OrderStatus } from '../commerce/order-state.js';
import {
  loadOrder,
  restoreProductStock,
  transitionOrder,
  type OrderRow,
} from '../commerce/orders.js';
import { releaseEventTicket } from '../events/index.js';
import { postLedger, type Payee } from './ledger.js';
import { notifySeller, notifyUser } from './notify.js';
import { getPaymentProvider } from './provider.js';
import { deliverLocalWebhooks } from './webhook.js';
import type { FastifyRequest } from 'fastify';

export interface RefundRow {
  id: string;
  payment_id: string;
  order_id: string | null;
  amount_cents: number;
  currency: string;
  reason: string;
  status: 'requested' | 'approved' | 'processing' | 'succeeded' | 'failed' | 'rejected';
  requested_by: string;
  decided_by: string | null;
  decision_note: string | null;
  provider_ref: string | null;
  idempotency_key: string;
  item_id: string | null;
  restock: boolean;
  auto: boolean;
  fee_returned_cents: number;
  failure_code: string | null;
  created_at: Date;
  decided_at: Date | null;
  succeeded_at: Date | null;
}
export const REFUND_COLS = `r.id, r.payment_id, r.order_id, r.amount_cents, r.currency, r.reason, r.status, r.requested_by, r.decided_by, r.decision_note, r.provider_ref,
  r.idempotency_key, r.item_id, r.restock, r.auto, r.fee_returned_cents, r.failure_code, r.created_at, r.decided_at, r.succeeded_at`;

export const refundView = (r: RefundRow) => ({
  id: r.id,
  orderId: r.order_id,
  paymentId: r.payment_id,
  amountCents: r.amount_cents,
  currency: r.currency,
  reason: r.reason,
  status: r.status,
  itemId: r.item_id,
  restock: r.restock,
  automatic: r.auto,
  decisionNote: r.decision_note,
  failureCode: r.failure_code,
  requestedBy: r.requested_by,
  decidedBy: r.decided_by,
  createdAt: r.created_at.toISOString(),
  decidedAt: r.decided_at?.toISOString() ?? null,
  succeededAt: r.succeeded_at?.toISOString() ?? null,
});

export interface PaymentRow {
  id: string;
  payer_id: string;
  order_id: string | null;
  purpose: string;
  amount_cents: number;
  currency: string;
  platform_fee_cents: number;
  provider: string;
  provider_ref: string | null;
  status: string;
  refunded_cents: number;
  seller_user_id: string | null;
  seller_business_id: string | null;
  metadata: Record<string, unknown>;
  captured_at: Date | null;
  failure_code: string | null;
  idempotency_key: string;
  client_secret_ref: string | null;
  card_fingerprint: string | null;
  card_country: string | null;
  created_at: Date;
}
export const PAYMENT_COLS = `p.id, p.payer_id, p.order_id, p.purpose, p.amount_cents, p.currency, p.platform_fee_cents, p.provider, p.provider_ref, p.status, p.refunded_cents,
  p.seller_user_id, p.seller_business_id, p.metadata, p.captured_at, p.failure_code, p.idempotency_key, p.client_secret_ref, p.card_fingerprint, p.card_country, p.created_at`;

export const paymentPayee = (
  p: Pick<PaymentRow, 'seller_user_id' | 'seller_business_id'>,
): Payee => {
  if (p.seller_business_id) return { type: 'business', id: p.seller_business_id };
  if (p.seller_user_id) return { type: 'user', id: p.seller_user_id };
  throw new Error('payment has no payee');
};

const SETTLED = ['captured', 'partially_refunded'];

/** Money already promised away: succeeded refunds plus open ones (requested/approved/processing). */
async function committedRefunds(
  db: Queryable,
  paymentId: string,
  opts: { itemId?: string | null; excludeId?: string } = {},
): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    `SELECT COALESCE(sum(amount_cents), 0)::bigint AS n FROM refunds
      WHERE payment_id = $1 AND status IN ('requested','approved','processing','succeeded') AND ($2::uuid IS NULL OR item_id = $2) AND ($3::uuid IS NULL OR id <> $3)`,
    [paymentId, opts.itemId ?? null, opts.excludeId ?? null],
  );
  return rows[0]!.n;
}

interface ItemRow {
  id: string;
  product_id: string | null;
  ticket_type_id: string | null;
  event_id: string | null;
  quantity: number;
  unit_price_cents: number;
  tax_cents: number;
  refunded_cents: number;
  item_type: string;
}

export interface CreateRefundInput {
  orderId: string;
  /** Who is asking. Buyers create `requested` refunds; sellers, staff and the system create `approved` ones. */
  actor: 'buyer' | 'seller' | 'staff' | 'system';
  actorId: string;
  amountCents?: number | undefined;
  itemId?: string | undefined;
  reason: string;
  key?: string | undefined;
  restock?: boolean | undefined;
  auto?: boolean;
}

/**
 * Create a refund (workflow entry). Validates against the captured amount minus everything already refunded or pending, per item for line
 * refunds. Idempotent per (actor, key). Does NOT call the provider; approved refunds are executed by `executeRefund`.
 */
export async function createRefund(
  ctx: AppContext,
  input: CreateRefundInput,
  req?: FastifyRequest,
): Promise<{ refund: RefundRow; created: boolean }> {
  const idem = `${input.actorId}:${input.key ?? `auto:${input.orderId}:${Date.now()}:${Math.random().toString(36).slice(2)}`}`;
  const out = await withTransaction(ctx.db, async (tx) => {
    const dup = await tx.query<RefundRow>(
      `SELECT ${REFUND_COLS} FROM refunds r WHERE r.idempotency_key = $1`,
      [idem],
    );
    if (dup.rows[0]) {
      const d = dup.rows[0];
      if (
        d.order_id !== input.orderId ||
        (input.amountCents !== undefined && d.amount_cents !== input.amountCents) ||
        (input.itemId ?? null) !== d.item_id
      ) {
        throw new AppError(
          'conflict',
          'This Idempotency-Key was already used with a different request',
          { reason: 'idempotency_key_reuse' },
        );
      }
      return {
        refund: d,
        created: false,
        seller: null as Payee | null,
        buyerId: null as string | null,
      };
    }
    const order = await loadOrder(tx, input.orderId, { lock: true });
    if (!REFUNDABLE_ORDER_STATUSES.includes(order.status)) {
      throw new AppError('conflict', 'This order cannot be refunded in its current state', {
        reason: 'order_not_refundable',
        status: order.status,
      });
    }
    const { rows: pays } = await tx.query<PaymentRow>(
      `SELECT ${PAYMENT_COLS} FROM payments p WHERE p.order_id = $1 AND p.status = ANY($2::text[]) FOR UPDATE`,
      [order.id, SETTLED],
    );
    const pay = pays[0];
    if (!pay)
      throw new AppError('conflict', 'There is no captured payment to refund', {
        reason: 'no_captured_payment',
      });

    let item: ItemRow | null = null;
    if (input.itemId) {
      const it = await tx.query<ItemRow>(
        'SELECT id, product_id, ticket_type_id, event_id, quantity, unit_price_cents, tax_cents, refunded_cents, item_type FROM order_items WHERE id = $1 AND order_id = $2',
        [input.itemId, order.id],
      );
      item = it.rows[0] ?? null;
      if (!item) throw notFound('Order item');
      if (item.item_type === 'ticket' && item.event_id) {
        const same = await tx.query(
          'SELECT 1 FROM order_items WHERE order_id = $1 AND event_id = $2 AND id <> $3',
          [order.id, item.event_id, item.id],
        );
        if (same.rowCount)
          throw new AppError(
            'unprocessable',
            'Tickets for the same event in one order are refunded together: refund the whole order',
            { reason: 'refund_whole_order' },
          );
      }
    }
    const paymentRemaining = pay.amount_cents - (await committedRefunds(tx, pay.id));
    let amount = input.amountCents;
    if (item) {
      const lineTotal = item.unit_price_cents * item.quantity + item.tax_cents;
      const lineRemaining = lineTotal - (await committedRefunds(tx, pay.id, { itemId: item.id }));
      amount ??= lineRemaining;
      if (amount > lineRemaining)
        throw new AppError('unprocessable', 'The refund is more than what is left on this item', {
          reason: 'refund_exceeds_remaining',
          remaining: Math.max(0, lineRemaining),
        });
    } else {
      amount ??= paymentRemaining;
    }
    if (!Number.isSafeInteger(amount) || amount < 1)
      throw new AppError('unprocessable', 'There is nothing left to refund', {
        reason: 'nothing_to_refund',
      });
    if (amount > paymentRemaining)
      throw new AppError('unprocessable', 'The refund is more than what is left on this payment', {
        reason: 'refund_exceeds_remaining',
        remaining: Math.max(0, paymentRemaining),
      });

    const approved = input.actor !== 'buyer';
    // Physical goods go back on the shelf by default only if they were never shipped.
    const restock = input.restock ?? order.fulfilled_at === null;
    const ins = await tx.query<RefundRow>(
      `INSERT INTO refunds (payment_id, order_id, amount_cents, currency, reason, status, requested_by, decided_by, decision_note, idempotency_key, item_id, restock, auto, decided_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, CASE WHEN $6 = 'approved' THEN now() END)
       RETURNING ${REFUND_COLS.replace(/r\./g, '')}`,
      [
        pay.id,
        order.id,
        amount,
        pay.currency,
        input.reason.slice(0, 1000),
        approved ? 'approved' : 'requested',
        order.buyer_id,
        approved && input.actor !== 'system' ? input.actorId : null,
        input.auto ? 'Automatic refund' : null,
        idem,
        item?.id ?? null,
        restock,
        input.auto ?? false,
      ],
    );
    const refund = ins.rows[0]!;
    const entry: AuditEntry = {
      actorId: input.actor === 'system' ? null : input.actorId,
      actorType: input.actor === 'system' ? 'system' : input.actor === 'staff' ? 'staff' : 'user',
      action: approved ? 'refund.created_approved' : 'refund.requested',
      targetType: 'refund',
      targetId: refund.id,
      metadata: {
        orderId: order.id,
        paymentId: pay.id,
        amountCents: amount,
        currency: pay.currency,
        itemId: item?.id ?? null,
        actor: input.actor,
        auto: input.auto ?? false,
      },
    };
    await audit(ctx, entry, req, tx);
    return {
      refund,
      created: true,
      seller: orderSeller(order) as Payee | null,
      buyerId: order.buyer_id as string | null,
    };
  });
  if (out.created && out.seller && out.buyerId) {
    if (out.refund.status === 'requested') {
      await notifySeller(ctx, out.seller, {
        kind: 'refund_requested',
        actorId: out.buyerId,
        targetType: 'refund',
        targetId: out.refund.id,
        data: { orderId: out.refund.order_id, amountCents: out.refund.amount_cents },
      });
    }
  }
  return { refund: out.refund, created: out.created };
}

/** Seller/staff decision on a requested refund. Approval executes it (provider call, ledger reversal) before returning. */
export async function decideRefund(
  ctx: AppContext,
  p: {
    refundId: string;
    decidedBy: string;
    actor: 'seller' | 'staff';
    decision: 'approve' | 'deny';
    note?: string | undefined;
    restock?: boolean | undefined;
  },
  req?: FastifyRequest,
): Promise<RefundRow> {
  const r = await withTransaction(ctx.db, async (tx) => {
    const { rows } = await tx.query<RefundRow>(
      `SELECT ${REFUND_COLS} FROM refunds r WHERE r.id = $1 FOR UPDATE`,
      [p.refundId],
    );
    const refund = rows[0];
    if (!refund || !refund.order_id) throw notFound('Refund');
    const order = await loadOrder(tx, refund.order_id);
    if (
      p.actor === 'seller' &&
      !(await hasSellerAccess(tx, orderSeller(order), p.decidedBy, 'orders', {
        allowInactive: true,
      }))
    )
      throw notFound('Refund');
    if (order.buyer_id === p.decidedBy)
      throw forbidden('You cannot decide your own refund request');
    if (refund.status !== 'requested')
      throw conflict(`This refund is already ${refund.status}`, {
        reason: 'refund_already_decided',
        status: refund.status,
      });
    const status = p.decision === 'approve' ? 'approved' : 'rejected';
    await tx.query(
      `UPDATE refunds SET status = $2, decided_by = $3, decision_note = $4, decided_at = now(), restock = COALESCE($5, restock) WHERE id = $1`,
      [refund.id, status, p.decidedBy, p.note?.slice(0, 1000) ?? null, p.restock ?? null],
    );
    await audit(
      ctx,
      {
        actorId: p.decidedBy,
        actorType: p.actor === 'staff' ? 'staff' : 'user',
        action: p.decision === 'approve' ? 'refund.approved' : 'refund.denied',
        targetType: 'refund',
        targetId: refund.id,
        metadata: { orderId: order.id, amountCents: refund.amount_cents, actor: p.actor },
      },
      req,
      tx,
    );
    return { refund, order };
  });
  if (p.decision === 'deny') {
    await notifyUser(ctx, r.order.buyer_id, {
      kind: 'refund_denied',
      actorId: p.decidedBy,
      targetType: 'refund',
      targetId: r.refund.id,
      data: { orderId: r.order.id },
    });
  } else {
    await executeRefund(ctx, r.refund.id);
  }
  const { rows } = await ctx.db.query<RefundRow>(
    `SELECT ${REFUND_COLS} FROM refunds r WHERE r.id = $1`,
    [p.refundId],
  );
  return rows[0]!;
}

/**
 * Execute an approved (or stuck `processing`) refund: reserve it against the payment under lock, call the provider with an idempotent
 * request, and on success reverse the ledger. Ambiguous provider failures leave the refund `processing` for the retry job.
 */
export async function executeRefund(ctx: AppContext, refundId: string): Promise<void> {
  const snap = await withTransaction(ctx.db, async (tx) => {
    const { rows } = await tx.query<RefundRow>(
      `SELECT ${REFUND_COLS} FROM refunds r WHERE r.id = $1 FOR UPDATE`,
      [refundId],
    );
    const refund = rows[0];
    if (!refund || !['approved', 'processing'].includes(refund.status)) return null;
    const pay = (
      await tx.query<PaymentRow>(
        `SELECT ${PAYMENT_COLS} FROM payments p WHERE p.id = $1 FOR UPDATE`,
        [refund.payment_id],
      )
    ).rows[0]!;
    if (!SETTLED.includes(pay.status) || !pay.provider_ref) {
      await tx.query(
        `UPDATE refunds SET status = 'failed', failure_code = 'payment_not_refundable' WHERE id = $1`,
        [refund.id],
      );
      await audit(
        ctx,
        {
          actorType: 'system',
          action: 'refund.failed',
          targetType: 'refund',
          targetId: refund.id,
          metadata: { reason: 'payment_not_refundable', paymentStatus: pay.status },
        },
        undefined,
        tx,
      );
      return null;
    }
    if (refund.status === 'approved')
      await tx.query(`UPDATE refunds SET status = 'processing' WHERE id = $1`, [refund.id]);
    return { refund, pay };
  });
  if (!snap) return;
  const provider = getPaymentProvider(ctx);
  try {
    const res = await provider.refund({
      paymentRef: snap.pay.provider_ref!,
      amount: snap.refund.amount_cents,
      currency: snap.refund.currency,
      idempotencyKey: `refund:${snap.refund.id}`,
      reason: snap.refund.reason.slice(0, 200),
      metadata: { refundId: snap.refund.id, paymentId: snap.pay.id },
    });
    if (res.status === 'succeeded') await finalizeRefund(ctx, snap.refund.id, res.ref);
    else if (res.status === 'failed')
      await failRefund(ctx, snap.refund.id, res.failureCode ?? 'provider_failed');
    else
      await ctx.db.query(
        `UPDATE refunds SET provider_ref = COALESCE(provider_ref, $2) WHERE id = $1`,
        [snap.refund.id, res.ref],
      );
  } catch (err) {
    if (err instanceof PaymentProviderError && !err.retryable)
      await failRefund(ctx, snap.refund.id, err.code);
    else {
      ctx.log.error(
        { refundId: snap.refund.id, err: (err as Error).message },
        'refund provider call failed; will retry',
      );
      await audit(ctx, {
        actorType: 'system',
        action: 'refund.provider_error',
        targetType: 'refund',
        targetId: snap.refund.id,
        metadata: { error: (err as Error).message.slice(0, 200) },
      });
    }
  }
  await deliverLocalWebhooks(ctx);
}

export async function failRefund(ctx: AppContext, refundId: string, code: string): Promise<void> {
  await withTransaction(ctx.db, async (tx) => {
    const r = await tx.query<{ order_id: string | null }>(
      `UPDATE refunds SET status = 'failed', failure_code = $2 WHERE id = $1 AND status IN ('approved','processing') RETURNING order_id`,
      [refundId, code.slice(0, 100)],
    );
    if (r.rows[0])
      await audit(
        ctx,
        {
          actorType: 'system',
          action: 'refund.failed',
          targetType: 'refund',
          targetId: refundId,
          metadata: { code },
        },
        undefined,
        tx,
      );
  });
}

/** Job: repeat provider refunds that were left `processing` by an ambiguous failure (same idempotency key, so never double-refunds). */
export async function retryProcessingRefunds(
  ctx: AppContext,
  olderThanMinutes = 2,
): Promise<number> {
  const { rows } = await ctx.db.query<{ id: string }>(
    `SELECT id FROM refunds WHERE status = 'processing' AND updated_at < now() - ($1::int * interval '1 minute') ORDER BY updated_at LIMIT 100`,
    [olderThanMinutes],
  );
  for (const r of rows) await executeRefund(ctx, r.id);
  return rows.length;
}

// ------------------------------------------------------------------ finalisation (ledger + state + entitlements)
export interface RefundEffects {
  eventReleases: Array<{ eventId: string; userId: string; orderId: string }>;
}

/**
 * Give the order's goods back after money was returned: revoke digital access, refund tickets, cancel bookings, and (if allowed) restock
 * physical items. `itemId` restricts it to one fully refunded line. Idempotent (only touches non-revoked entitlements).
 */
export async function applyRefundEffects(
  tx: Tx,
  order: OrderRow,
  p: { itemId: string | null; restock: boolean },
): Promise<RefundEffects> {
  const effects: RefundEffects = { eventReleases: [] };
  const items = await tx.query<{
    id: string;
    item_type: string;
    product_id: string | null;
    ticket_type_id: string | null;
    event_id: string | null;
    quantity: number;
    stock_state: string;
    booking_id: string | null;
  }>(
    `SELECT id, item_type, product_id, ticket_type_id, event_id, quantity, stock_state, booking_id FROM order_items WHERE order_id = $1 AND ($2::uuid IS NULL OR id = $2) ORDER BY id`,
    [order.id, p.itemId],
  );
  for (const it of items.rows) {
    const ent = await tx.query<{ id: string; kind: string; status: string }>(
      `SELECT id, kind, status FROM order_entitlements WHERE order_item_id = $1 FOR UPDATE`,
      [it.id],
    );
    const e = ent.rows[0];
    if (e && e.status !== 'revoked') {
      await tx.query(
        `UPDATE order_entitlements SET status = 'revoked', revoked_at = now() WHERE id = $1`,
        [e.id],
      );
      if (e.kind === 'ticket' && e.status === 'granted') {
        await tx.query(
          `UPDATE tickets SET status = 'refunded' WHERE order_item_id = $1 AND status = 'valid'`,
          [it.id],
        );
        if (it.event_id)
          effects.eventReleases.push({
            eventId: it.event_id,
            userId: order.buyer_id,
            orderId: order.id,
          });
      }
      if (e.kind === 'booking' && it.booking_id) {
        await tx.query(
          `UPDATE bookings SET status = 'cancelled', cancelled_by = 'system', reason = 'Refunded', decided_at = now() WHERE id = $1 AND status IN ('requested','confirmed')`,
          [it.booking_id],
        );
      }
    }
    if (p.restock && it.stock_state === 'committed' && it.product_id) {
      await tx.query(`UPDATE order_items SET stock_state = 'released' WHERE id = $1`, [it.id]);
      await restoreProductStock(tx, it.product_id, it.quantity);
    }
  }
  return effects;
}

export interface FinalizedRefund {
  refund: RefundRow;
  order: OrderRow | null;
  effects: RefundEffects;
}

/**
 * Record a succeeded refund inside the caller's transaction: ledger reversal (once), payment/order totals and states, restoration rules,
 * audit. Idempotent: returns null when the refund had already succeeded. Call `afterRefundFinalized` after COMMIT.
 */
export async function finalizeRefundTx(
  ctx: AppContext,
  tx: Tx,
  refundId: string,
  providerRef?: string | null,
): Promise<FinalizedRefund | null> {
  const { rows } = await tx.query<RefundRow>(
    `SELECT ${REFUND_COLS} FROM refunds r WHERE r.id = $1 FOR UPDATE`,
    [refundId],
  );
  const refund = rows[0];
  if (!refund) throw notFound('Refund');
  if (refund.status === 'succeeded') return null;
  if (!['approved', 'processing'].includes(refund.status))
    throw conflict(`A ${refund.status} refund cannot succeed`);
  // Lock order first, then payment: the same order as every other flow.
  const payRef = (
    await tx.query<{ order_id: string | null }>('SELECT order_id FROM payments WHERE id = $1', [
      refund.payment_id,
    ])
  ).rows[0]!;
  const order = payRef.order_id ? await loadOrder(tx, payRef.order_id, { lock: true }) : null;
  const pay = (
    await tx.query<PaymentRow>(
      `SELECT ${PAYMENT_COLS} FROM payments p WHERE p.id = $1 FOR UPDATE`,
      [refund.payment_id],
    )
  ).rows[0]!;
  if (pay.refunded_cents + refund.amount_cents > pay.amount_cents)
    throw new AppError('conflict', 'Refund exceeds the captured amount');

  const { entries, feeReturned } = refundEntries({
    payee: paymentPayee(pay),
    paymentAmount: pay.amount_cents,
    paymentFee: pay.platform_fee_cents,
    refundedBefore: pay.refunded_cents,
    refund: refund.amount_cents,
  });
  await postLedger(tx, {
    kind: 'refund',
    refType: 'refund',
    refId: refund.id,
    currency: pay.currency,
    entries,
  });
  const totalRefunded = pay.refunded_cents + refund.amount_cents;
  const full = totalRefunded === pay.amount_cents;
  await tx.query(
    `UPDATE refunds SET status = 'succeeded', provider_ref = COALESCE($2, provider_ref), fee_returned_cents = $3, succeeded_at = now() WHERE id = $1`,
    [refund.id, providerRef ?? null, feeReturned],
  );
  await tx.query(
    `UPDATE payments SET refunded_cents = $2, status = CASE WHEN status = 'disputed' THEN status WHEN $3::boolean THEN 'refunded' ELSE 'partially_refunded' END WHERE id = $1`,
    [pay.id, totalRefunded, full],
  );

  let effects: RefundEffects = { eventReleases: [] };
  if (order) {
    await tx.query('UPDATE orders SET refunded_cents = refunded_cents + $2 WHERE id = $1', [
      order.id,
      refund.amount_cents,
    ]);
    if (refund.item_id)
      await tx.query('UPDATE order_items SET refunded_cents = refunded_cents + $2 WHERE id = $1', [
        refund.item_id,
        refund.amount_cents,
      ]);
    const target: OrderStatus = full ? 'refunded' : 'partially_refunded';
    // Late payments on cancelled orders stay cancelled (nothing was delivered); disputed orders keep their status until the dispute closes.
    if (order.status !== 'disputed' && order.status !== 'cancelled' && order.status !== target)
      await transitionOrder(tx, order.id, target, 'system');
    if (order.status !== 'cancelled') {
      if (full)
        effects = await applyRefundEffects(tx, order, { itemId: null, restock: refund.restock });
      else if (refund.item_id) {
        const li = (
          await tx.query<{
            unit_price_cents: number;
            quantity: number;
            tax_cents: number;
            refunded_cents: number;
          }>(
            'SELECT unit_price_cents, quantity, tax_cents, refunded_cents FROM order_items WHERE id = $1',
            [refund.item_id],
          )
        ).rows[0]!;
        if (li.refunded_cents >= li.unit_price_cents * li.quantity + li.tax_cents)
          effects = await applyRefundEffects(tx, order, {
            itemId: refund.item_id,
            restock: refund.restock,
          });
      }
    }
  }
  await audit(
    ctx,
    {
      actorId: refund.decided_by,
      actorType: refund.auto ? 'system' : 'service',
      action: 'refund.succeeded',
      targetType: 'refund',
      targetId: refund.id,
      metadata: {
        orderId: refund.order_id,
        paymentId: pay.id,
        amountCents: refund.amount_cents,
        currency: pay.currency,
        feeReturnedCents: feeReturned,
        full,
        providerRef: providerRef ?? null,
      },
    },
    undefined,
    tx,
  );
  return { refund, order, effects };
}

/** Side effects that must not run inside the money transaction: event ticket release (events module) and notifications. */
export async function afterRefundFinalized(ctx: AppContext, done: FinalizedRefund): Promise<void> {
  for (const rel of done.effects.eventReleases) {
    try {
      await releaseEventTicket(ctx, rel);
    } catch (err) {
      ctx.log.error(
        { ...rel, err: (err as Error).message },
        'could not release event tickets after refund',
      );
      await audit(ctx, {
        actorType: 'system',
        action: 'refund.ticket_release_failed',
        targetType: 'order',
        targetId: rel.orderId,
        metadata: { eventId: rel.eventId },
      });
    }
  }
  ctx.metrics.events.inc({ name: 'refund_succeeded' });
  if (done.order) {
    await notifyUser(ctx, done.order.buyer_id, {
      kind: 'refund_succeeded',
      targetType: 'refund',
      targetId: done.refund.id,
      data: {
        orderId: done.order.id,
        amountCents: done.refund.amount_cents,
        currency: done.refund.currency,
      },
    });
    await notifySeller(ctx, orderSeller(done.order), {
      kind: 'refund_succeeded',
      targetType: 'refund',
      targetId: done.refund.id,
      data: { orderId: done.order.id, amountCents: done.refund.amount_cents },
    });
  }
}

export async function finalizeRefund(
  ctx: AppContext,
  refundId: string,
  providerRef?: string | null,
): Promise<boolean> {
  const done = await withTransaction(ctx.db, (tx) =>
    finalizeRefundTx(ctx, tx, refundId, providerRef),
  );
  if (!done) return false;
  await afterRefundFinalized(ctx, done);
  return true;
}

export async function loadRefund(db: Queryable, id: string): Promise<RefundRow> {
  const { rows } = await db.query<RefundRow>(
    `SELECT ${REFUND_COLS} FROM refunds r WHERE r.id = $1`,
    [id],
  );
  if (!rows[0]) throw notFound('Refund');
  return rows[0];
}

export { invalid };
