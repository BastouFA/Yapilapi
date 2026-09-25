import { createHash } from 'node:crypto';
import { withTransaction, type Tx } from '@yapilapi/database';
import { AppError } from '@yapilapi/shared';
import {
  WebhookSignatureError,
  paymentCapturedEntries,
  refundEntries,
  type NormalisedEvent,
} from '@yapilapi/payments';
import type { AppContext } from '../../lib/context.js';
import { audit } from '../../lib/audit.js';
import { orderSeller } from '../commerce/access.js';
import { loadOrder, transitionOrder } from '../commerce/orders.js';
import { createEntitlements, fulfilPayment, refundWholePayment } from './fulfilment.js';
import { postLedger } from './ledger.js';
import { notifySeller, notifyUser } from './notify.js';
import { onAccountEvent, onPayoutEvent } from './payouts.js';
import { getPaymentProvider } from './provider.js';
import {
  afterRefundFinalized,
  applyRefundEffects,
  finalizeRefundTx,
  paymentPayee,
  PAYMENT_COLS,
  REFUND_COLS,
  type FinalizedRefund,
  type PaymentRow,
  type RefundRow,
} from './refunds.js';

type After = () => Promise<void>;

export interface WebhookResult {
  events: number;
  processed: number;
  duplicates: number;
}

/**
 * Entry point for provider webhooks (HTTP route and the dev provider's in-process delivery share it).
 *  1. verify signature + timestamp on the RAW body (invalid => 400, nothing stored);
 *  2. per event, in ONE transaction: insert the receipt (unique provider+event id: a duplicate, even a concurrent one, is a no-op) and
 *     apply the event; commit;
 *  3. only after commit: fulfilment, notifications (idempotent, retried by jobs if the process dies here).
 */
export async function processWebhook(
  ctx: AppContext,
  providerName: string,
  rawBody: string,
  headers: Record<string, string | string[] | undefined>,
): Promise<WebhookResult> {
  const provider = getPaymentProvider(ctx);
  if (provider.name !== providerName) throw new AppError('not_found', 'Unknown payment provider');
  let events: NormalisedEvent[];
  try {
    events = provider.verifyWebhook(rawBody, headers);
  } catch (err) {
    if (err instanceof WebhookSignatureError) {
      ctx.metrics.events.inc({ name: 'payment_webhook_rejected' });
      await audit(ctx, {
        actorType: 'system',
        action: 'payment.webhook_rejected',
        targetType: 'payment_provider',
        targetId: providerName,
        metadata: {
          reason: err.reason,
          bodySha256: createHash('sha256').update(rawBody).digest('hex').slice(0, 16),
        },
      }).catch(() => undefined);
      throw new AppError('validation_failed', 'Invalid webhook', { reason: 'invalid_signature' });
    }
    throw err;
  }
  const result: WebhookResult = { events: events.length, processed: 0, duplicates: 0 };
  for (const ev of events) {
    const r = await handleEvent(ctx, provider.name, ev);
    if (r.duplicate) result.duplicates += 1;
    else result.processed += 1;
  }
  return result;
}

async function handleEvent(
  ctx: AppContext,
  provider: string,
  ev: NormalisedEvent,
): Promise<{ duplicate: boolean }> {
  const out = await withTransaction(ctx.db, async (tx) => {
    const receipt = await tx.query<{ id: string }>(
      `INSERT INTO payment_webhook_events (provider, event_id, event_type, payload, signature_valid) VALUES ($1,$2,$3,$4,true) ON CONFLICT (provider, event_id) DO NOTHING RETURNING id`,
      [provider, ev.id, ev.type, JSON.stringify(ev)],
    );
    if (!receipt.rows[0]) return null; // already received (and processed, or being processed by a concurrent delivery that we waited for)
    const { note, after } = await applyEvent(ctx, tx, provider, ev);
    await tx.query(
      'UPDATE payment_webhook_events SET processed_at = now(), error = $2 WHERE id = $1',
      [receipt.rows[0].id, note ?? null],
    );
    return { after };
  });
  if (!out) return { duplicate: true };
  ctx.metrics.events.inc({ name: `payment_webhook_${ev.type.replace('.', '_')}` });
  for (const fn of out.after) {
    try {
      await fn();
    } catch (err) {
      ctx.log.error({ eventId: ev.id, err: (err as Error).message }, 'post-webhook action failed');
    }
  }
  return { duplicate: false };
}

async function findPayment(
  tx: Tx,
  provider: string,
  ev: NormalisedEvent,
): Promise<PaymentRow | null> {
  const ref = ev.type.startsWith('payment.') ? ev.providerRef : ev.paymentRef;
  const paymentId =
    ev.metadata.paymentId && /^[0-9a-f-]{36}$/i.test(ev.metadata.paymentId)
      ? ev.metadata.paymentId
      : null;
  const { rows } = await tx.query<PaymentRow>(
    `SELECT ${PAYMENT_COLS} FROM payments p WHERE (p.provider = $1 AND p.provider_ref = $2) OR ($3::uuid IS NOT NULL AND p.id = $3::uuid AND p.provider = $1) LIMIT 1`,
    [provider, ref, paymentId],
  );
  return rows[0] ?? null;
}

async function applyEvent(
  ctx: AppContext,
  tx: Tx,
  provider: string,
  ev: NormalisedEvent,
): Promise<{ note?: string; after: After[] }> {
  switch (ev.type) {
    case 'payment.succeeded':
      return capturePayment(ctx, tx, provider, ev);
    case 'payment.failed':
    case 'payment.requires_action':
    case 'payment.canceled': {
      const pay = await findPayment(tx, provider, ev);
      if (!pay) return { note: 'unknown_payment', after: [] };
      const next =
        ev.type === 'payment.failed'
          ? 'failed'
          : ev.type === 'payment.canceled'
            ? 'cancelled'
            : 'requires_action';
      const res = await tx.query(
        `UPDATE payments SET status = $2, failure_code = CASE WHEN $2 = 'failed' THEN $3 ELSE failure_code END, provider_ref = COALESCE(provider_ref, $4)
          WHERE id = $1 AND status IN ('requires_payment_method','requires_action','authorized')`,
        [pay.id, next, ev.failureCode, ev.providerRef],
      );
      if (res.rowCount && next === 'failed')
        await audit(
          ctx,
          {
            actorType: 'system',
            action: 'payment.failed',
            targetType: 'payment',
            targetId: pay.id,
            metadata: { code: ev.failureCode, orderId: pay.order_id },
          },
          undefined,
          tx,
        );
      return { note: res.rowCount ? undefined : 'no_state_change', after: [] };
    }
    case 'refund.succeeded':
    case 'refund.failed': {
      const refundId =
        ev.metadata.refundId && /^[0-9a-f-]{36}$/i.test(ev.metadata.refundId)
          ? ev.metadata.refundId
          : null;
      const { rows } = await tx.query<RefundRow>(
        `SELECT ${REFUND_COLS} FROM refunds r WHERE (r.provider_ref IS NOT NULL AND r.provider_ref = $1) OR ($2::uuid IS NOT NULL AND r.id = $2::uuid) LIMIT 1`,
        [ev.providerRef, refundId],
      );
      const refund = rows[0];
      if (!refund) return { note: 'unknown_refund', after: [] };
      if (ev.type === 'refund.failed') {
        await tx.query(
          `UPDATE refunds SET status = 'failed', failure_code = $2 WHERE id = $1 AND status IN ('approved','processing')`,
          [refund.id, ev.failureCode ?? 'refund_failed'],
        );
        return { after: [] };
      }
      const done: FinalizedRefund | null = await finalizeRefundTx(
        ctx,
        tx,
        refund.id,
        ev.providerRef,
      );
      return {
        after: done ? [() => afterRefundFinalized(ctx, done)] : [],
        ...(done ? {} : { note: 'already_finalized' }),
      };
    }
    case 'dispute.opened':
      return openDispute(ctx, tx, provider, ev);
    case 'dispute.closed':
      return closeDispute(ctx, tx, provider, ev);
    case 'payout.paid':
    case 'payout.failed': {
      const note = await onPayoutEvent(ctx, tx, ev);
      return { ...(note ? { note } : {}), after: [] };
    }
    case 'account.updated': {
      const note = await onAccountEvent(ctx, tx, provider, ev);
      return { ...(note ? { note } : {}), after: [] };
    }
    default:
      return { note: 'ignored', after: [] };
  }
}

/** payment.succeeded: mark captured, book the ledger, move the order to paid and queue the entitlements. Late payments are refunded. */
async function capturePayment(
  ctx: AppContext,
  tx: Tx,
  provider: string,
  ev: NormalisedEvent,
): Promise<{ note?: string; after: After[] }> {
  const peek = await findPayment(tx, provider, ev);
  if (!peek) return { note: 'unknown_payment', after: [] };
  // Lock order first, then payment (same order as every other flow).
  const order = peek.order_id ? await loadOrder(tx, peek.order_id, { lock: true }) : null;
  const pay = (
    await tx.query<PaymentRow>(
      `SELECT ${PAYMENT_COLS} FROM payments p WHERE p.id = $1 FOR UPDATE`,
      [peek.id],
    )
  ).rows[0]!;
  if (['captured', 'partially_refunded', 'refunded', 'disputed'].includes(pay.status))
    return { note: 'already_captured', after: [] };
  if (
    ev.amount !== null &&
    (ev.amount !== pay.amount_cents || (ev.currency && ev.currency !== pay.currency))
  ) {
    await audit(
      ctx,
      {
        actorType: 'system',
        action: 'payment.amount_mismatch',
        targetType: 'payment',
        targetId: pay.id,
        metadata: {
          expected: pay.amount_cents,
          received: ev.amount,
          currency: pay.currency,
          receivedCurrency: ev.currency,
        },
      },
      undefined,
      tx,
    );
    return { note: 'amount_mismatch', after: [] };
  }
  await tx.query(
    `UPDATE payments SET status = 'captured', captured_at = now(), failure_code = NULL, provider_ref = COALESCE(provider_ref, $2) WHERE id = $1`,
    [pay.id, ev.providerRef],
  );
  await postLedger(tx, {
    kind: 'payment_captured',
    refType: 'payment',
    refId: pay.id,
    currency: pay.currency,
    entries: paymentCapturedEntries({
      payee: paymentPayee(pay),
      amount: pay.amount_cents,
      fee: pay.platform_fee_cents,
    }),
  });
  const after: After[] = [];
  let late = false;
  if (order) {
    if (order.status === 'pending_payment') {
      await transitionOrder(tx, order.id, 'paid', 'system');
      await tx.query(
        `UPDATE order_items SET stock_state = 'committed' WHERE order_id = $1 AND stock_state = 'held'`,
        [order.id],
      );
    } else {
      late = true; // cancelled/expired/under review: the money arrived after the order was given up
    }
  }
  if (!late) await createEntitlements(tx, pay);
  await audit(
    ctx,
    {
      actorType: 'system',
      action: late ? 'payment.captured_late' : 'payment.captured',
      targetType: 'payment',
      targetId: pay.id,
      metadata: {
        orderId: pay.order_id,
        amountCents: pay.amount_cents,
        feeCents: pay.platform_fee_cents,
        currency: pay.currency,
        purpose: pay.purpose,
      },
    },
    undefined,
    tx,
  );
  if (late) {
    after.push(() =>
      refundWholePayment(
        ctx,
        pay.id,
        'Automatic refund: payment arrived after the order was released',
        `late:${pay.id}`,
      ),
    );
  } else {
    after.push(() => fulfilPayment(ctx, pay.id).then(() => undefined));
    after.push(async () => {
      ctx.metrics.events.inc({ name: 'payment_captured' });
      await notifyUser(ctx, pay.payer_id, {
        kind: 'payment_succeeded',
        targetType: pay.order_id ? 'order' : 'payment',
        targetId: pay.order_id ?? pay.id,
        data: { amountCents: pay.amount_cents, currency: pay.currency },
      });
      if (order)
        await notifySeller(ctx, orderSeller(order), {
          kind: 'order_paid',
          actorId: pay.payer_id,
          targetType: 'order',
          targetId: order.id,
          data: { totalCents: order.total_cents, currency: order.currency },
        });
    });
  }
  return { ...(late ? { note: 'late_payment_refunding' } : {}), after };
}

// ------------------------------------------------------------------ disputes (minimal state)
async function openDispute(
  ctx: AppContext,
  tx: Tx,
  provider: string,
  ev: NormalisedEvent,
): Promise<{ note?: string; after: After[] }> {
  const peek = await findPayment(tx, provider, ev);
  if (!peek || !ev.providerRef) return { note: 'unknown_payment', after: [] };
  const order = peek.order_id ? await loadOrder(tx, peek.order_id, { lock: true }) : null;
  const pay = (
    await tx.query<PaymentRow>(
      `SELECT ${PAYMENT_COLS} FROM payments p WHERE p.id = $1 FOR UPDATE`,
      [peek.id],
    )
  ).rows[0]!;
  await tx.query(
    `INSERT INTO disputes (payment_id, order_id, provider, provider_ref, reason, amount_cents, currency) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (provider, provider_ref) DO NOTHING`,
    [
      pay.id,
      pay.order_id,
      provider,
      ev.providerRef,
      ev.disputeReason,
      ev.amount && ev.amount > 0 ? ev.amount : pay.amount_cents,
      pay.currency,
    ],
  );
  if (['captured', 'partially_refunded'].includes(pay.status))
    await tx.query(`UPDATE payments SET status = 'disputed' WHERE id = $1`, [pay.id]);
  if (order && ['paid', 'fulfilled', 'completed', 'partially_refunded'].includes(order.status))
    await transitionOrder(tx, order.id, 'disputed', 'system', { priorStatus: order.status });
  await audit(
    ctx,
    {
      actorType: 'system',
      action: 'dispute.opened',
      targetType: 'payment',
      targetId: pay.id,
      metadata: { orderId: pay.order_id, reason: ev.disputeReason, providerRef: ev.providerRef },
    },
    undefined,
    tx,
  );
  return {
    after: [
      async () => {
        if (order)
          await notifySeller(ctx, orderSeller(order), {
            kind: 'dispute_opened',
            targetType: 'order',
            targetId: order.id,
            data: { reason: ev.disputeReason },
          });
      },
    ],
  };
}

async function closeDispute(
  ctx: AppContext,
  tx: Tx,
  provider: string,
  ev: NormalisedEvent,
): Promise<{ note?: string; after: After[] }> {
  const { rows: dr } = await tx.query<{
    id: string;
    payment_id: string;
    order_id: string | null;
    status: string;
  }>(
    'SELECT id, payment_id, order_id, status FROM disputes WHERE provider = $1 AND provider_ref = $2 FOR UPDATE',
    [provider, ev.providerRef],
  );
  const d = dr[0];
  if (!d) return { note: 'unknown_dispute', after: [] };
  if (d.status !== 'open' || !ev.disputeOutcome) return { note: 'dispute_not_open', after: [] };
  const order = d.order_id ? await loadOrder(tx, d.order_id, { lock: true }) : null;
  const pay = (
    await tx.query<PaymentRow>(
      `SELECT ${PAYMENT_COLS} FROM payments p WHERE p.id = $1 FOR UPDATE`,
      [d.payment_id],
    )
  ).rows[0]!;
  await tx.query(`UPDATE disputes SET status = $2, closed_at = now() WHERE id = $1`, [
    d.id,
    ev.disputeOutcome,
  ]);
  const after: After[] = [];
  if (ev.disputeOutcome === 'won') {
    await tx.query(
      `UPDATE payments SET status = CASE WHEN refunded_cents > 0 THEN 'partially_refunded' ELSE 'captured' END WHERE id = $1 AND status = 'disputed'`,
      [pay.id],
    );
    if (order?.status === 'disputed')
      await transitionOrder(tx, order.id, (order.prior_status as never) ?? 'paid', 'system');
  } else {
    // Lost: the provider took the money back. Reverse whatever is still on the books (append-only) and treat the order as refunded.
    const remaining = pay.amount_cents - pay.refunded_cents;
    if (remaining > 0) {
      const { entries } = refundEntries({
        payee: paymentPayee(pay),
        paymentAmount: pay.amount_cents,
        paymentFee: pay.platform_fee_cents,
        refundedBefore: pay.refunded_cents,
        refund: remaining,
      });
      await postLedger(tx, {
        kind: 'adjustment',
        refType: 'dispute_lost',
        refId: d.id,
        currency: pay.currency,
        entries,
      });
    }
    await tx.query(
      `UPDATE payments SET status = 'refunded', refunded_cents = amount_cents WHERE id = $1`,
      [pay.id],
    );
    if (order) {
      await tx.query('UPDATE orders SET refunded_cents = total_cents WHERE id = $1', [order.id]);
      if (order.status === 'disputed') await transitionOrder(tx, order.id, 'refunded', 'system');
      const effects = await applyRefundEffects(tx, order, { itemId: null, restock: false });
      after.push(async () => {
        const { releaseEventTicket } = await import('../events/index.js');
        for (const rel of effects.eventReleases) await releaseEventTicket(ctx, rel);
      });
    }
  }
  await audit(
    ctx,
    {
      actorType: 'system',
      action: `dispute.${ev.disputeOutcome}`,
      targetType: 'payment',
      targetId: pay.id,
      metadata: { orderId: pay.order_id, disputeId: d.id },
    },
    undefined,
    tx,
  );
  return { after };
}

/**
 * Deliver the dev provider's queued webhooks to our own handler, signature verification and all (there is no network hop, but every
 * byte goes through the same code path as a real delivery). No-op for providers without an outbox (Stripe pushes over HTTP).
 */
export async function deliverLocalWebhooks(ctx: AppContext): Promise<number> {
  const provider = getPaymentProvider(ctx);
  if (!provider.drainWebhookOutbox) return 0;
  let n = 0;
  for (let round = 0; round < 5; round++) {
    const batch = provider.drainWebhookOutbox();
    if (!batch.length) break;
    for (const w of batch) {
      try {
        await processWebhook(ctx, provider.name, w.rawBody, w.headers);
        n += 1;
      } catch (err) {
        ctx.log.error({ err: (err as Error).message }, 'local webhook delivery failed');
      }
    }
  }
  return n;
}
