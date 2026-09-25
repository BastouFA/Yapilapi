import { z } from 'zod';
import type { FastifyRequest } from 'fastify';
import { withTransaction, type Queryable } from '@yapilapi/database';
import { hashIp } from '@yapilapi/security';
import { AppError, forbidden, invalid, notFound } from '@yapilapi/shared';
import {
  PaymentProviderError,
  calculatePlatformFee,
  containsCardNumber,
  isPaymentMethodRef,
  type PaymentIntentResult,
  type PaymentMethodInfo,
} from '@yapilapi/payments';
import type { AppContext } from '../../lib/context.js';
import { audit } from '../../lib/audit.js';
import {
  IDEMPOTENCY_KEY,
  loadOrder,
  requestHash,
  transitionOrder,
  type OrderRow,
} from '../commerce/orders.js';
import { loadCommunity } from '../communities/service.js';
import { assess, storeSignal, type Assessment, type SignalContext } from './fraud.js';
import type { Payee } from './ledger.js';
import { getPaymentProvider } from './provider.js';
import { deliverLocalWebhooks } from './webhook.js';
import { PAYMENT_COLS, type PaymentRow } from './refunds.js';

/**
 * A payment method is ONLY an opaque provider token/id (`tok_...`, `pm_...`) created in the browser/app by the provider's SDK. Anything
 * else, and anything that even looks like a card number, is rejected before it can reach a log, a row or the provider.
 */
export const paymentMethodSchema = z
  .string()
  .trim()
  .max(160)
  .refine(
    (v) => isPaymentMethodRef(v) && !containsCardNumber(v),
    'Send the payment method token from the payment SDK, never card details',
  );

export const payBody = z.object({
  paymentMethod: paymentMethodSchema.optional(),
  returnUrl: z.url().max(500).optional(),
});
export type PayBody = z.infer<typeof payBody>;

export const confirmBody = z.object({
  paymentMethod: paymentMethodSchema.optional(),
  returnUrl: z.url().max(500).optional(),
});

export interface PaymentOutcome {
  payment: PaymentRow;
  replayed: boolean;
  /** Set when the pay-time rules moved the order into manual review instead of charging. */
  held: boolean;
  nextAction: PaymentIntentResult['nextAction'];
}

/** Client-facing payment status: `authorized` means "sent to the provider, waiting for the confirmation webhook". */
export const clientPaymentStatus = (s: string): string => (s === 'authorized' ? 'processing' : s);

export function paymentView(p: PaymentRow, extra: Record<string, unknown> = {}) {
  return {
    id: p.id,
    orderId: p.order_id,
    purpose: p.purpose,
    status: clientPaymentStatus(p.status),
    amountCents: p.amount_cents,
    currency: p.currency,
    provider: p.provider,
    failureCode: p.failure_code,
    refundedCents: p.refunded_cents,
    // The client secret is an opaque handle for the provider's client SDK (never a card number); only its owner ever sees it.
    clientSecret: ['requires_payment_method', 'requires_action', 'authorized'].includes(p.status)
      ? p.client_secret_ref
      : null,
    createdAt: p.created_at.toISOString(),
    ...extra,
  };
}

const OPEN = ['requires_payment_method', 'requires_action', 'authorized'];

async function loadPayment(db: Queryable, id: string, lock = false): Promise<PaymentRow | null> {
  const { rows } = await db.query<PaymentRow>(
    `SELECT ${PAYMENT_COLS} FROM payments p WHERE p.id = $1 ${lock ? 'FOR UPDATE' : ''}`,
    [id],
  );
  return rows[0] ?? null;
}

async function describe(
  ctx: AppContext,
  paymentMethod: string | undefined,
): Promise<PaymentMethodInfo | null> {
  if (!paymentMethod) return null;
  try {
    return await getPaymentProvider(ctx).describePaymentMethod(paymentMethod);
  } catch (err) {
    if (err instanceof PaymentProviderError && !err.retryable)
      throw new AppError('unprocessable', 'That payment method cannot be used', {
        reason: err.code,
      });
    return null; // provider hiccup: fraud signals fall back to account/IP data, the charge itself will surface the real error
  }
}

/** Store what the provider said about the attempt. Never downgrades a payment the webhook already settled. */
async function applyIntentResult(
  ctx: AppContext,
  payment: PaymentRow,
  res: PaymentIntentResult,
): Promise<void> {
  const status =
    res.status === 'failed'
      ? 'failed'
      : res.status === 'requires_action'
        ? 'requires_action'
        : res.status === 'succeeded' || res.status === 'processing'
          ? 'authorized'
          : res.status === 'canceled'
            ? 'cancelled'
            : 'requires_payment_method';
  const upd = await ctx.db.query(
    `UPDATE payments SET provider_ref = COALESCE(provider_ref, $2), client_secret_ref = COALESCE($3, client_secret_ref), status = $4,
            failure_code = $5, card_fingerprint = COALESCE($6, card_fingerprint), card_country = COALESCE($7, card_country)
      WHERE id = $1 AND status IN ('requires_payment_method','requires_action','authorized','failed')`,
    [
      payment.id,
      res.ref,
      res.clientSecret,
      status,
      res.failureCode,
      res.fingerprint,
      res.cardCountry,
    ],
  );
  if (upd.rowCount && status === 'failed') {
    await audit(ctx, {
      actorId: payment.payer_id,
      action: 'payment.failed',
      targetType: 'payment',
      targetId: payment.id,
      metadata: { code: res.failureCode, orderId: payment.order_id, purpose: payment.purpose },
    });
  }
}

async function callProvider(
  ctx: AppContext,
  payment: PaymentRow,
  paymentMethod: string | undefined,
  returnUrl: string | undefined,
): Promise<{ next: PaymentIntentResult['nextAction'] }> {
  const provider = getPaymentProvider(ctx);
  try {
    const res = payment.provider_ref
      ? await provider.confirmPayment(payment.provider_ref, { paymentMethod, returnUrl })
      : await provider.createPaymentIntent({
          amount: payment.amount_cents,
          currency: payment.currency,
          idempotencyKey: `pay:${payment.id}`,
          description: payment.order_id ? `Order ${payment.order_id}` : 'Membership',
          metadata: {
            paymentId: payment.id,
            ...(payment.order_id ? { orderId: payment.order_id } : {}),
          },
          paymentMethod,
          returnUrl,
        });
    await applyIntentResult(ctx, payment, res);
    ctx.metrics.events.inc({ name: `payment_attempt_${res.status}` });
    return { next: res.nextAction };
  } catch (err) {
    if (err instanceof PaymentProviderError) {
      if (!err.retryable) {
        await ctx.db.query(
          `UPDATE payments SET status = 'failed', failure_code = $2 WHERE id = $1 AND status IN ('requires_payment_method','requires_action')`,
          [payment.id, err.code.slice(0, 100)],
        );
      } else {
        ctx.log.warn(
          { paymentId: payment.id, code: err.code },
          'payment provider temporarily unavailable',
        );
        throw new AppError(
          'payment_failed',
          'The payment service is temporarily unavailable. Nothing was charged; try again shortly.',
          { reason: 'provider_unavailable', retryable: true, paymentId: payment.id },
        );
      }
      return { next: null };
    }
    throw err;
  }
}

const signalFor = (
  ctx: AppContext,
  userId: string,
  clientIp: string,
  amount: number,
  currency: string,
  pm: PaymentMethodInfo | null,
  shippingCountry?: string | null,
): SignalContext => ({
  userId,
  ipHash: hashIp(clientIp, ctx.config.IP_HASH_SALT ?? 'dev-salt'),
  amountMinor: amount,
  currency,
  shippingCountry: shippingCountry ?? null,
  cardFingerprint: pm?.fingerprint ?? null,
  cardCountry: pm?.country ?? null,
});

async function rejectBlocked(
  ctx: AppContext,
  userId: string,
  a: Assessment,
  sig: SignalContext,
  subject: { type: 'order' | 'payment'; id: string },
  req?: FastifyRequest,
): Promise<never> {
  await storeSignal(
    ctx.db,
    { ...sig, stage: 'payment', subjectType: subject.type, subjectId: subject.id },
    a,
  );
  await audit(
    ctx,
    {
      actorId: userId,
      action: 'payment.blocked',
      targetType: subject.type,
      targetId: subject.id,
      metadata: {
        score: a.result.score,
        reasons: a.result.reasons.map((r) => r.code),
        amountCents: sig.amountMinor,
        currency: sig.currency,
      },
    },
    req,
  );
  ctx.metrics.events.inc({ name: 'payment_blocked' });
  throw new AppError(
    'forbidden',
    'We could not process this payment. Please contact support if you think this is a mistake.',
    { reason: 'risk_declined' },
  );
}

function assertKey(key: string): void {
  if (!IDEMPOTENCY_KEY.test(key))
    throw invalid('Idempotency-Key must be 8-128 characters (letters, digits, . _ : -)');
}

/**
 * POST /v1/orders/:id/pay. Idempotent per (buyer, Idempotency-Key): the same key + same payload returns the same payment, a different payload is
 * a 409. At most one payment can be in flight per order (partial unique index), so a double click can never charge twice.
 * The order is locked, the rules run once more with the card's fingerprint/country, and only then is the provider called (after COMMIT).
 * The outcome that matters (paid) is decided by the signed webhook, never by this request.
 */
export async function payOrder(
  ctx: AppContext,
  buyer: { userId: string; ageBand: 'teen' | 'adult' },
  orderId: string,
  key: string,
  body: PayBody,
  clientIp: string,
  req?: FastifyRequest,
): Promise<PaymentOutcome> {
  assertKey(key);
  if (buyer.ageBand === 'teen') throw forbidden('Accounts under 18 cannot make purchases');
  const idem = `order:${orderId}:${key}`;
  const hash = requestHash({ orderId, paymentMethod: body.paymentMethod ?? null });

  const replay = async (db: Queryable): Promise<PaymentOutcome | null> => {
    const { rows } = await db.query<PaymentRow & { request_hash: string | null }>(
      `SELECT ${PAYMENT_COLS}, p.request_hash FROM payments p WHERE p.payer_id = $1 AND p.idempotency_key = $2`,
      [buyer.userId, idem],
    );
    const p = rows[0];
    if (!p) return null;
    if (p.request_hash !== hash)
      throw new AppError(
        'conflict',
        'This Idempotency-Key was already used with a different request',
        { reason: 'idempotency_key_reuse' },
      );
    return {
      payment: p,
      replayed: true,
      held: false,
      nextAction: p.status === 'requires_action' ? { type: 'requires_action' } : null,
    };
  };

  const order0 = await loadOrder(ctx.db, orderId).catch(() => null);
  if (!order0 || order0.buyer_id !== buyer.userId) throw notFound('Order');
  const prior = await replay(ctx.db);
  if (prior) return prior;

  const pm = await describe(ctx, body.paymentMethod);
  const sig = signalFor(
    ctx,
    buyer.userId,
    clientIp,
    order0.total_cents,
    order0.currency,
    pm,
    order0.shipping_country,
  );
  const assessment = await assess(ctx.db, sig);
  if (assessment.result.decision === 'block')
    await rejectBlocked(ctx, buyer.userId, assessment, sig, { type: 'order', id: order0.id }, req);

  type Locked = { held: true; order: OrderRow } | { held: false; payment: PaymentRow };
  let locked: Locked;
  try {
    locked = await withTransaction(ctx.db, async (tx): Promise<Locked> => {
      const order = await loadOrder(tx, orderId, { lock: true });
      if (order.buyer_id !== buyer.userId) throw notFound('Order');
      if (order.status === 'pending_review')
        throw new AppError(
          'conflict',
          'This order is being reviewed. We will notify you when you can pay.',
          { reason: 'order_under_review' },
        );
      if (order.status !== 'pending_payment') {
        throw new AppError(
          'conflict',
          ['paid', 'fulfilled', 'completed', 'partially_refunded', 'disputed', 'refunded'].includes(
            order.status,
          )
            ? 'This order is already paid'
            : `This order is ${order.status.replace(/_/g, ' ')}`,
          {
            reason: order.status === 'cancelled' ? 'order_cancelled' : 'order_not_payable',
            status: order.status,
          },
        );
      }
      if (order.reserved_until && order.reserved_until.getTime() < Date.now())
        throw new AppError('conflict', 'The reservation for this order has expired', {
          reason: 'reservation_expired',
        });
      const staffCleared = order.fraud_flags.includes('staff_approved');
      if (assessment.result.decision === 'review' && !staffCleared) {
        await transitionOrder(tx, order.id, 'pending_review', 'system', {
          reservedUntil: new Date(Date.now() + ctx.config.ORDER_REVIEW_HOLD_HOURS * 3_600_000),
        });
        await tx.query(
          'UPDATE orders SET fraud_decision = $2, fraud_score = GREATEST(fraud_score, $3), fraud_flags = (SELECT COALESCE(array_agg(DISTINCT f), ARRAY[]::text[]) FROM unnest(fraud_flags || $4::text[]) f) WHERE id = $1',
          [
            order.id,
            'review',
            assessment.result.score,
            assessment.result.reasons.map((r) => r.code),
          ],
        );
        await storeSignal(
          tx,
          { ...sig, stage: 'payment', subjectType: 'order', subjectId: order.id },
          assessment,
        );
        await audit(
          ctx,
          {
            actorId: buyer.userId,
            action: 'order.held_for_review',
            targetType: 'order',
            targetId: order.id,
            metadata: {
              stage: 'payment',
              score: assessment.result.score,
              reasons: assessment.result.reasons.map((r) => r.code),
            },
          },
          req,
          tx,
        );
        return { held: true, order };
      }
      const open = await tx.query<{ id: string }>(
        `SELECT id FROM payments WHERE order_id = $1 AND status = ANY($2::text[])`,
        [order.id, OPEN],
      );
      if (open.rows[0])
        throw new AppError(
          'conflict',
          'A payment for this order is already in progress. Confirm it, or wait for it to finish.',
          { reason: 'payment_in_progress', paymentId: open.rows[0].id },
        );
      const ins = await tx.query<{ id: string }>(
        `INSERT INTO payments (payer_id, order_id, purpose, amount_cents, currency, platform_fee_cents, provider, idempotency_key, request_hash, seller_user_id, seller_business_id, card_fingerprint, card_country, ip_hash, metadata)
         VALUES ($1,$2,'order',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
        [
          buyer.userId,
          order.id,
          order.total_cents,
          order.currency,
          order.platform_fee_cents,
          getPaymentProvider(ctx).name,
          idem,
          hash,
          order.seller_user_id,
          order.seller_business_id,
          pm?.fingerprint ?? null,
          pm?.country ?? null,
          sig.ipHash,
          JSON.stringify({ orderId: order.id }),
        ],
      );
      await storeSignal(
        tx,
        { ...sig, stage: 'payment', subjectType: 'payment', subjectId: ins.rows[0]!.id },
        assessment,
      );
      await audit(
        ctx,
        {
          actorId: buyer.userId,
          action: 'payment.created',
          targetType: 'payment',
          targetId: ins.rows[0]!.id,
          metadata: {
            orderId: order.id,
            amountCents: order.total_cents,
            currency: order.currency,
            feeCents: order.platform_fee_cents,
          },
        },
        req,
        tx,
      );
      return { held: false, payment: (await loadPayment(tx, ins.rows[0]!.id))! };
    });
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === '23505') {
      const again = await replay(ctx.db);
      if (again) return again;
      const open = await ctx.db.query<{ id: string }>(
        `SELECT id FROM payments WHERE order_id = $1 AND status = ANY($2::text[])`,
        [orderId, OPEN],
      );
      throw new AppError(
        'conflict',
        'A payment for this order is already in progress. Confirm it, or wait for it to finish.',
        { reason: 'payment_in_progress', paymentId: open.rows[0]?.id },
      );
    }
    throw err;
  }
  if (locked.held) {
    const { rows } = await ctx.db.query<PaymentRow>(
      `SELECT ${PAYMENT_COLS} FROM payments p WHERE p.order_id = $1 ORDER BY p.created_at DESC LIMIT 1`,
      [orderId],
    );
    return { payment: rows[0] as PaymentRow, replayed: false, held: true, nextAction: null };
  }

  const { next } = await callProvider(ctx, locked.payment, body.paymentMethod, body.returnUrl);
  await deliverLocalWebhooks(ctx);
  return {
    payment: (await loadPayment(ctx.db, locked.payment.id))!,
    replayed: false,
    held: false,
    nextAction: next,
  };
}

/**
 * POST /v1/payments/:id/confirm: continue a payment that needs a (new) payment method or a customer action (3-D Secure style challenge).
 * Only the payer can do it, and only while the payment is open and its order still reserved.
 */
export async function confirmPayment(
  ctx: AppContext,
  buyer: { userId: string; ageBand: 'teen' | 'adult' },
  paymentId: string,
  body: PayBody,
  clientIp: string,
  req?: FastifyRequest,
): Promise<PaymentOutcome> {
  if (buyer.ageBand === 'teen') throw forbidden('Accounts under 18 cannot make purchases');
  const p0 = await loadPayment(ctx.db, paymentId);
  if (!p0 || p0.payer_id !== buyer.userId) throw notFound('Payment');
  if (!['requires_payment_method', 'requires_action'].includes(p0.status)) {
    if (
      p0.status === 'authorized' ||
      ['captured', 'partially_refunded', 'refunded', 'disputed'].includes(p0.status)
    )
      return { payment: p0, replayed: true, held: false, nextAction: null };
    throw new AppError(
      'conflict',
      `This payment is ${p0.status}. Start a new payment for the order.`,
      { reason: 'payment_not_confirmable', status: p0.status },
    );
  }
  const pm = await describe(ctx, body.paymentMethod);
  if (p0.order_id) {
    const order = await loadOrder(ctx.db, p0.order_id);
    if (order.status !== 'pending_payment')
      throw new AppError('conflict', `This order is ${order.status.replace(/_/g, ' ')}`, {
        reason: 'order_not_payable',
        status: order.status,
      });
    if (order.reserved_until && order.reserved_until.getTime() < Date.now())
      throw new AppError('conflict', 'The reservation for this order has expired', {
        reason: 'reservation_expired',
      });
  }
  if (pm) {
    const sig = signalFor(ctx, buyer.userId, clientIp, p0.amount_cents, p0.currency, pm);
    const a = await assess(ctx.db, sig);
    if (a.result.decision === 'block')
      await rejectBlocked(ctx, buyer.userId, a, sig, { type: 'payment', id: p0.id }, req);
    await ctx.db.query(
      'UPDATE payments SET card_fingerprint = $2, card_country = $3 WHERE id = $1',
      [p0.id, pm.fingerprint, pm.country],
    );
  }
  await audit(
    ctx,
    {
      actorId: buyer.userId,
      action: 'payment.confirm_attempted',
      targetType: 'payment',
      targetId: p0.id,
      metadata: { orderId: p0.order_id, withNewMethod: Boolean(body.paymentMethod) },
    },
    req,
  );
  const { next } = await callProvider(
    ctx,
    (await loadPayment(ctx.db, p0.id))!,
    body.paymentMethod,
    body.returnUrl,
  );
  await deliverLocalWebhooks(ctx);
  return {
    payment: (await loadPayment(ctx.db, p0.id))!,
    replayed: false,
    held: false,
    nextAction: next,
  };
}

// ------------------------------------------------------------------ paid community membership
/**
 * Pay for a paid community. The payee is the community's creator (an individual seller); the platform fee applies like any sale. Entry to the
 * community happens ONLY when the capture webhook lands (entitlement -> grantCommunityMembership), never from this request.
 */
export async function payCommunityMembership(
  ctx: AppContext,
  buyer: { userId: string; ageBand: 'teen' | 'adult' },
  communityRef: string,
  key: string,
  body: PayBody,
  clientIp: string,
  req?: FastifyRequest,
): Promise<PaymentOutcome> {
  assertKey(key);
  if (buyer.ageBand === 'teen') throw forbidden('Accounts under 18 cannot make purchases');
  const { c, me } = await loadCommunity(ctx.db, communityRef, buyer.userId);
  if (!c.is_paid || c.price_cents === null || !c.currency)
    throw new AppError('conflict', 'This community does not have a paid membership', {
      reason: 'not_paid_community',
    });
  if (me?.status === 'banned') throw forbidden('You cannot join this community');
  if (!c.created_by)
    throw new AppError('conflict', 'This community cannot take payments right now', {
      reason: 'no_payee',
    });
  const seller: Payee = { type: 'user', id: c.created_by };
  if (seller.id === buyer.userId) throw forbidden('You cannot buy your own membership');
  const currency = c.currency.toUpperCase();
  const idem = `community:${c.id}:${key}`;
  const hash = requestHash({ communityId: c.id, paymentMethod: body.paymentMethod ?? null });

  const replay = async (db: Queryable): Promise<PaymentOutcome | null> => {
    const { rows } = await db.query<PaymentRow & { request_hash: string | null }>(
      `SELECT ${PAYMENT_COLS}, p.request_hash FROM payments p WHERE p.payer_id = $1 AND p.idempotency_key = $2`,
      [buyer.userId, idem],
    );
    const p = rows[0];
    if (!p) return null;
    if (p.request_hash !== hash)
      throw new AppError(
        'conflict',
        'This Idempotency-Key was already used with a different request',
        { reason: 'idempotency_key_reuse' },
      );
    return { payment: p, replayed: true, held: false, nextAction: null };
  };
  const prior = await replay(ctx.db);
  if (prior) return prior;
  if (me?.status === 'active')
    throw new AppError('conflict', 'You are already a member', { reason: 'already_member' });

  const pm = await describe(ctx, body.paymentMethod);
  const sig = signalFor(ctx, buyer.userId, clientIp, c.price_cents, currency, pm);
  const assessment = await assess(ctx.db, sig);
  if (assessment.result.decision === 'block')
    await rejectBlocked(ctx, buyer.userId, assessment, sig, { type: 'payment', id: c.id }, req);

  const fee = calculatePlatformFee(c.price_cents, { bps: ctx.config.PLATFORM_FEE_BPS }).fee;
  let payment: PaymentRow;
  try {
    payment = await withTransaction(ctx.db, async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `community-pay:${buyer.userId}:${c.id}`,
      ]);
      const open = await tx.query<{ id: string }>(
        `SELECT id FROM payments WHERE payer_id = $1 AND purpose = 'community_membership' AND metadata->>'communityId' = $2 AND status = ANY($3::text[])`,
        [buyer.userId, c.id, OPEN],
      );
      if (open.rows[0])
        throw new AppError('conflict', 'A payment for this membership is already in progress', {
          reason: 'payment_in_progress',
          paymentId: open.rows[0].id,
        });
      const ins = await tx.query<{ id: string }>(
        `INSERT INTO payments (payer_id, order_id, purpose, amount_cents, currency, platform_fee_cents, provider, idempotency_key, request_hash, seller_user_id, card_fingerprint, card_country, ip_hash, metadata)
         VALUES ($1,NULL,'community_membership',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
        [
          buyer.userId,
          c.price_cents,
          currency,
          fee,
          getPaymentProvider(ctx).name,
          idem,
          hash,
          seller.id,
          pm?.fingerprint ?? null,
          pm?.country ?? null,
          sig.ipHash,
          JSON.stringify({ communityId: c.id }),
        ],
      );
      const id = ins.rows[0]!.id;
      await storeSignal(
        tx,
        { ...sig, stage: 'payment', subjectType: 'payment', subjectId: id },
        assessment,
      );
      await audit(
        ctx,
        {
          actorId: buyer.userId,
          action: 'payment.created',
          targetType: 'payment',
          targetId: id,
          metadata: { communityId: c.id, amountCents: c.price_cents, currency, feeCents: fee },
        },
        req,
        tx,
      );
      return (await loadPayment(tx, id))!;
    });
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      const again = await replay(ctx.db);
      if (again) return again;
    }
    throw err;
  }
  const { next } = await callProvider(ctx, payment, body.paymentMethod, body.returnUrl);
  await deliverLocalWebhooks(ctx);
  return {
    payment: (await loadPayment(ctx.db, payment.id))!,
    replayed: false,
    held: false,
    nextAction: next,
  };
}

/** Buyer-side read of one payment (payer only; everyone else gets 404). */
export async function getOwnPayment(
  ctx: AppContext,
  userId: string,
  paymentId: string,
): Promise<PaymentRow> {
  const p = await loadPayment(ctx.db, paymentId);
  if (!p || p.payer_id !== userId) throw notFound('Payment');
  return p;
}
