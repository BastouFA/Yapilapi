import type { FastifyRequest } from 'fastify';
import { withTransaction, type Queryable, type Tx } from '@yapilapi/database';
import { hashIp } from '@yapilapi/security';
import { AppError, forbidden, notFound } from '@yapilapi/shared';
import {
  PaymentProviderError,
  calculatePlatformFee,
  type PaymentMethodInfo,
} from '@yapilapi/payments';
import type { AppContext } from '../../lib/context.js';
import { audit } from '../../lib/audit.js';
import { isBlockedEitherWay } from '../../lib/users.js';
import { assess, storeSignal, type SignalContext } from '../payments/fraud.js';
import { getPaymentProvider } from '../payments/provider.js';
import { PAYMENT_COLS, type PaymentRow } from '../payments/refunds.js';
import { deliverLocalWebhooks } from '../payments/webhook.js';

/** Smallest and largest single charge (minor units) any creator-economy flow accepts. */
export const MIN_CHARGE_CENTS = 50;
export const MAX_CHARGE_CENTS = 500_000;

export interface ChargeInput {
  payer: { userId: string; ageBand: 'teen' | 'adult' };
  creatorId: string;
  purpose: 'subscription' | 'tip' | 'gift' | 'partnership';
  amount: number;
  currency: string;
  /** Full idempotency key as stored in payments.idempotency_key (unique per payer). Callers scope it by purpose and target. */
  idem: string;
  /** Hash of the request body: the same key with a different body is a 409. */
  hash: string;
  paymentMethod?: string | undefined;
  returnUrl?: string | undefined;
  metadata: Record<string, string>;
  description: string;
  /** Request IP for the fraud rules; renewals run without a request and skip the network signals. */
  clientIp?: string | undefined;
  /** Insert the domain rows (tip, gift, subscription payment...) in the SAME transaction as the payment row. */
  onCreated?: (tx: Tx, payment: PaymentRow) => Promise<void>;
  req?: FastifyRequest | undefined;
  /** Off-session renewal: the payer is not present, so blocks/age gates were checked when the subscription was created. */
  offSession?: boolean;
}

export interface ChargeOutcome {
  payment: PaymentRow;
  replayed: boolean;
  /** Set when the provider needs the customer (3-D Secure style challenge). */
  nextAction: { type: string; url?: string | null } | null;
}

const OPEN = ['requires_payment_method', 'requires_action', 'authorized'];

export async function loadPaymentRow(db: Queryable, id: string): Promise<PaymentRow | null> {
  const { rows } = await db.query<PaymentRow>(
    `SELECT ${PAYMENT_COLS} FROM payments p WHERE p.id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

export const isSettled = (p: Pick<PaymentRow, 'status'>): boolean =>
  ['captured', 'partially_refunded', 'refunded', 'disputed'].includes(p.status);

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
    return null;
  }
}

/** The creator must be active, have accepted the terms, and (for a user-initiated charge) not be in a block relationship with the payer. */
export async function assertCanReceive(
  ctx: AppContext,
  creatorId: string,
  payerId: string | null,
): Promise<void> {
  const { rows } = await ctx.db.query<{ status: string; terms: boolean; suspended: boolean }>(
    `SELECT c.status, (c.terms_accepted_at IS NOT NULL) AS terms, (u.status <> 'active') AS suspended FROM creators c JOIN users u ON u.id = c.user_id AND u.deleted_at IS NULL WHERE c.user_id = $1`,
    [creatorId],
  );
  const c = rows[0];
  if (!c) throw notFound('Creator');
  if (payerId && (await isBlockedEitherWay(ctx.db, payerId, creatorId))) throw notFound('Creator');
  if (c.status !== 'active' || !c.terms || c.suspended)
    throw new AppError('conflict', 'This creator cannot receive payments right now', {
      reason: 'creator_unavailable',
    });
}

/**
 * ONE money path for subscriptions, tips, gifts and partnership payments: an idempotent `payments` row (payee = the creator, platform fee applied)
 * created in the same transaction as the domain rows, then a provider intent. The capture is decided ONLY by the signed webhook
 * (payments/webhook.ts posts the double-entry ledger); nothing here ever books money or marks anything paid.
 */
export async function chargeToCreator(ctx: AppContext, c: ChargeInput): Promise<ChargeOutcome> {
  if (c.payer.ageBand === 'teen') throw forbidden('Accounts under 18 cannot make purchases');
  if (c.creatorId === c.payer.userId) throw forbidden('You cannot pay yourself');
  if (
    !Number.isSafeInteger(c.amount) ||
    c.amount < MIN_CHARGE_CENTS ||
    c.amount > MAX_CHARGE_CENTS
  ) {
    throw new AppError(
      'validation_failed',
      `The amount must be between ${MIN_CHARGE_CENTS} and ${MAX_CHARGE_CENTS} minor units`,
    );
  }
  const lookup = async (db: Queryable): Promise<PaymentRow | null> => {
    const { rows } = await db.query<PaymentRow & { request_hash: string | null }>(
      `SELECT ${PAYMENT_COLS}, p.request_hash FROM payments p WHERE p.payer_id = $1 AND p.idempotency_key = $2`,
      [c.payer.userId, c.idem],
    );
    const p = rows[0];
    if (!p) return null;
    if (p.request_hash !== c.hash)
      throw new AppError(
        'conflict',
        'This Idempotency-Key was already used with a different request',
        { reason: 'idempotency_key_reuse' },
      );
    return p;
  };
  const prior = await lookup(ctx.db);
  if (prior)
    return {
      payment: prior,
      replayed: true,
      nextAction: prior.status === 'requires_action' ? { type: 'requires_action' } : null,
    };
  if (!c.offSession) await assertCanReceive(ctx, c.creatorId, c.payer.userId);

  const provider = getPaymentProvider(ctx);
  const pm = await describe(ctx, c.paymentMethod);
  const ipHash = c.clientIp ? hashIp(c.clientIp, ctx.config.IP_HASH_SALT ?? 'dev-salt') : null;
  const sig: SignalContext = {
    userId: c.payer.userId,
    ipHash,
    amountMinor: c.amount,
    currency: c.currency,
    cardFingerprint: pm?.fingerprint ?? null,
    cardCountry: pm?.country ?? null,
  };
  if (!c.offSession) {
    const a = await assess(ctx.db, sig);
    if (a.result.decision === 'block') {
      await storeSignal(
        ctx.db,
        { ...sig, stage: 'payment', subjectType: 'payment', subjectId: null },
        a,
      );
      await audit(
        ctx,
        {
          actorId: c.payer.userId,
          action: 'payment.blocked',
          targetType: 'creator',
          targetId: c.creatorId,
          metadata: {
            purpose: c.purpose,
            score: a.result.score,
            reasons: a.result.reasons.map((r) => r.code),
            amountCents: c.amount,
            currency: c.currency,
          },
        },
        c.req,
      );
      throw new AppError(
        'forbidden',
        'We could not process this payment. Please contact support if you think this is a mistake.',
        { reason: 'risk_declined' },
      );
    }
  }

  const fee = calculatePlatformFee(c.amount, { bps: ctx.config.PLATFORM_FEE_BPS }).fee;
  let payment: PaymentRow;
  try {
    payment = await withTransaction(ctx.db, async (tx) => {
      const ins = await tx.query<{ id: string }>(
        `INSERT INTO payments (payer_id, order_id, purpose, amount_cents, currency, platform_fee_cents, provider, idempotency_key, request_hash, seller_user_id, card_fingerprint, card_country, ip_hash, metadata)
         VALUES ($1,NULL,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
        [
          c.payer.userId,
          c.purpose,
          c.amount,
          c.currency,
          fee,
          provider.name,
          c.idem,
          c.hash,
          c.creatorId,
          pm?.fingerprint ?? null,
          pm?.country ?? null,
          ipHash,
          JSON.stringify(c.metadata),
        ],
      );
      const row = (
        await tx.query<PaymentRow>(`SELECT ${PAYMENT_COLS} FROM payments p WHERE p.id = $1`, [
          ins.rows[0]!.id,
        ])
      ).rows[0]!;
      await c.onCreated?.(tx, row);
      await audit(
        ctx,
        {
          actorId: c.payer.userId,
          action: 'payment.created',
          targetType: 'payment',
          targetId: row.id,
          metadata: {
            purpose: c.purpose,
            creatorId: c.creatorId,
            amountCents: c.amount,
            currency: c.currency,
            feeCents: fee,
          },
        },
        c.req,
        tx,
      );
      return row;
    });
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      const again = await lookup(ctx.db);
      if (again) return { payment: again, replayed: true, nextAction: null };
    }
    throw err;
  }

  let nextAction: ChargeOutcome['nextAction'] = null;
  try {
    const res = await provider.createPaymentIntent({
      amount: c.amount,
      currency: c.currency,
      idempotencyKey: `pay:${payment.id}`,
      description: c.description,
      metadata: { paymentId: payment.id, purpose: c.purpose, ...c.metadata },
      paymentMethod: c.paymentMethod,
      returnUrl: c.returnUrl,
    });
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
    await ctx.db.query(
      `UPDATE payments SET provider_ref = COALESCE(provider_ref, $2), client_secret_ref = COALESCE($3, client_secret_ref), status = $4, failure_code = $5,
              card_fingerprint = COALESCE($6, card_fingerprint), card_country = COALESCE($7, card_country)
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
    nextAction = res.nextAction;
    if (status === 'failed')
      await audit(
        ctx,
        {
          actorId: c.payer.userId,
          action: 'payment.failed',
          targetType: 'payment',
          targetId: payment.id,
          metadata: { code: res.failureCode, purpose: c.purpose },
        },
        c.req,
      );
  } catch (err) {
    if (!(err instanceof PaymentProviderError)) throw err;
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
      // The payment row stays (open): the client retries with the same Idempotency-Key. Off-session callers record a failed attempt instead.
      if (!c.offSession)
        throw new AppError(
          'payment_failed',
          'The payment service is temporarily unavailable. Nothing was charged; try again shortly.',
          { reason: 'provider_unavailable', retryable: true, paymentId: payment.id },
        );
      await ctx.db.query(
        `UPDATE payments SET status = 'failed', failure_code = 'provider_unavailable' WHERE id = $1 AND status IN ('requires_payment_method','requires_action')`,
        [payment.id],
      );
    }
  }
  await deliverLocalWebhooks(ctx);
  return { payment: (await loadPaymentRow(ctx.db, payment.id))!, replayed: false, nextAction };
}

export const paymentSummary = (p: PaymentRow) => ({
  id: p.id,
  status: p.status === 'authorized' ? 'processing' : p.status,
  amountCents: p.amount_cents,
  currency: p.currency,
  failureCode: p.failure_code,
  clientSecret: ['requires_payment_method', 'requires_action', 'authorized'].includes(p.status)
    ? p.client_secret_ref
    : null,
});

export { OPEN as OPEN_PAYMENT_STATUSES };
