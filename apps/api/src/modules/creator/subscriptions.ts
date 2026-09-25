import { z } from 'zod';
import type { FastifyRequest } from 'fastify';
import { withTransaction, type Queryable } from '@yapilapi/database';
import { decrypt, encrypt } from '@yapilapi/security';
import { AppError, conflict, forbidden, invalid, notFound } from '@yapilapi/shared';
import { PaymentProviderError, isPaymentMethodRef, containsCardNumber } from '@yapilapi/payments';
import type { AppContext } from '../../lib/context.js';
import type { AuthContext } from '../../lib/auth-context.js';
import { audit } from '../../lib/audit.js';
import { notify } from '../../lib/notify.js';
import { requestHash } from '../commerce/orders.js';
import { refundWholePayment } from '../payments/fulfilment.js';
import { getPaymentProvider } from '../payments/provider.js';
import {
  MAX_CHARGE_CENTS,
  MIN_CHARGE_CENTS,
  assertCanReceive,
  chargeToCreator,
  paymentSummary,
} from './charge.js';
import { requireCreator } from './profile.js';
import { addInterval, renewalFailure, type Interval, type SubscriptionStatus } from './rules.js';

// ------------------------------------------------------------------ plans
export const paymentMethodSchema = z
  .string()
  .trim()
  .max(160)
  .refine(
    (v) => isPaymentMethodRef(v) && !containsCardNumber(v),
    'Send the payment method token from the payment SDK, never card details',
  );
const currencySchema = z
  .string()
  .trim()
  .length(3)
  .transform((s) => s.toUpperCase());

export const planBody = z.object({
  name: z.string().trim().min(1).max(60),
  description: z.string().trim().max(500).default(''),
  priceCents: z.number().int().min(100).max(MAX_CHARGE_CENTS),
  currency: currencySchema,
  interval: z.enum(['month', 'year']),
  tier: z.number().int().min(1).max(10).default(1),
  benefits: z.array(z.string().trim().min(1).max(120)).max(10).default([]),
});
export const planPatch = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  description: z.string().trim().max(500).optional(),
  benefits: z.array(z.string().trim().min(1).max(120)).max(10).optional(),
  active: z.boolean().optional(),
});
export const MAX_ACTIVE_PLANS = 5;

interface PlanRow {
  id: string;
  creator_id: string;
  name: string;
  description: string;
  price_cents: number;
  currency: string;
  interval: Interval;
  tier: number;
  benefits: string[];
  active: boolean;
  created_at: Date;
}
const PLAN_COLS =
  'id, creator_id, name, description, price_cents, currency, interval, tier, benefits, active, created_at';
export const planView = (p: PlanRow) => ({
  id: p.id,
  creatorId: p.creator_id,
  name: p.name,
  description: p.description,
  priceCents: p.price_cents,
  currency: p.currency,
  interval: p.interval,
  tier: p.tier,
  benefits: p.benefits,
  active: p.active,
});

export async function createPlan(
  ctx: AppContext,
  creatorId: string,
  b: z.infer<typeof planBody>,
  req?: FastifyRequest,
): Promise<PlanRow> {
  await requireCreator(ctx.db, creatorId);
  return withTransaction(ctx.db, async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`plans:${creatorId}`]);
    const n = await tx.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM subscription_plans WHERE creator_id = $1 AND active',
      [creatorId],
    );
    if (n.rows[0]!.n >= MAX_ACTIVE_PLANS)
      throw new AppError('unprocessable', `You can have at most ${MAX_ACTIVE_PLANS} active plans`, {
        reason: 'too_many_plans',
      });
    const { rows } = await tx
      .query<PlanRow>(
        `INSERT INTO subscription_plans (creator_id, name, description, price_cents, currency, interval, tier, benefits) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ${PLAN_COLS}`,
        [
          creatorId,
          b.name,
          b.description,
          b.priceCents,
          b.currency,
          b.interval,
          b.tier,
          JSON.stringify(b.benefits),
        ],
      )
      .catch((err: { code?: string }) => {
        if (err.code === '23505')
          throw conflict('You already have an active plan for that tier and interval', {
            reason: 'tier_taken',
          });
        throw err;
      });
    await audit(
      ctx,
      {
        actorId: creatorId,
        action: 'creator.plan_created',
        targetType: 'subscription_plan',
        targetId: rows[0]!.id,
        metadata: {
          priceCents: b.priceCents,
          currency: b.currency,
          interval: b.interval,
          tier: b.tier,
        },
      },
      req,
      tx,
    );
    return rows[0]!;
  });
}

export async function updatePlan(
  ctx: AppContext,
  creatorId: string,
  planId: string,
  p: z.infer<typeof planPatch>,
  req?: FastifyRequest,
): Promise<PlanRow> {
  const cur = (
    await ctx.db.query<PlanRow>(
      `SELECT ${PLAN_COLS} FROM subscription_plans WHERE id = $1 AND creator_id = $2`,
      [planId, creatorId],
    )
  ).rows[0];
  if (!cur) throw notFound('Plan');
  if (p.active === true && !cur.active) {
    const n = await ctx.db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM subscription_plans WHERE creator_id = $1 AND active',
      [creatorId],
    );
    if (n.rows[0]!.n >= MAX_ACTIVE_PLANS)
      throw new AppError('unprocessable', `You can have at most ${MAX_ACTIVE_PLANS} active plans`, {
        reason: 'too_many_plans',
      });
  }
  const { rows } = await ctx.db
    .query<PlanRow>(
      `UPDATE subscription_plans SET name = COALESCE($3, name), description = COALESCE($4, description), benefits = COALESCE($5, benefits), active = COALESCE($6, active)
      WHERE id = $1 AND creator_id = $2 RETURNING ${PLAN_COLS}`,
      [
        planId,
        creatorId,
        p.name ?? null,
        p.description ?? null,
        p.benefits ? JSON.stringify(p.benefits) : null,
        p.active ?? null,
      ],
    )
    .catch((err: { code?: string }) => {
      if (err.code === '23505')
        throw conflict('You already have an active plan for that tier and interval', {
          reason: 'tier_taken',
        });
      throw err;
    });
  await audit(
    ctx,
    {
      actorId: creatorId,
      action: 'creator.plan_updated',
      targetType: 'subscription_plan',
      targetId: planId,
      metadata: { fields: Object.keys(p) },
    },
    req,
  );
  return rows[0]!;
}

export async function listPlans(
  db: Queryable,
  creatorId: string,
  includeInactive: boolean,
): Promise<PlanRow[]> {
  const { rows } = await db.query<PlanRow>(
    `SELECT ${PLAN_COLS} FROM subscription_plans WHERE creator_id = $1 AND ($2::boolean OR active) ORDER BY tier, price_cents, id`,
    [creatorId, includeInactive],
  );
  return rows;
}

// ------------------------------------------------------------------ subscriptions
export interface SubscriptionRow {
  id: string;
  subscriber_id: string;
  plan_id: string;
  creator_id: string;
  status: SubscriptionStatus;
  current_period_end: Date;
  cancel_at_period_end: boolean;
  renewal_attempts: number;
  next_retry_at: Date | null;
  last_failure_code: string | null;
  started_at: Date | null;
  cancelled_at: Date | null;
  ended_at: Date | null;
  end_reason: string | null;
  created_at: Date;
  price_cents: number;
  currency: string;
  interval: Interval;
  tier: number;
  plan_name: string;
}
const SUB_SELECT = `SELECT s.id, s.subscriber_id, s.plan_id, s.creator_id, s.status, s.current_period_end, s.cancel_at_period_end, s.renewal_attempts, s.next_retry_at, s.last_failure_code,
  s.started_at, s.cancelled_at, s.ended_at, s.end_reason, s.created_at, p.price_cents, p.currency, p.interval, p.tier, p.name AS plan_name
  FROM subscriptions s JOIN subscription_plans p ON p.id = s.plan_id`;

export const subscriptionView = (s: SubscriptionRow) => ({
  id: s.id,
  creatorId: s.creator_id,
  planId: s.plan_id,
  planName: s.plan_name,
  tier: s.tier,
  priceCents: s.price_cents,
  currency: s.currency,
  interval: s.interval,
  status: s.status,
  currentPeriodEnd: s.current_period_end.toISOString(),
  cancelAtPeriodEnd: s.cancel_at_period_end,
  renewalAttempts: s.renewal_attempts,
  nextRetryAt: s.next_retry_at?.toISOString() ?? null,
  lastFailureCode: s.last_failure_code,
  startedAt: s.started_at?.toISOString() ?? null,
  endedAt: s.ended_at?.toISOString() ?? null,
  endReason: s.end_reason,
});

export async function loadSubscription(
  db: Queryable,
  id: string,
  lock = false,
): Promise<SubscriptionRow | null> {
  const { rows } = await db.query<SubscriptionRow>(
    `${SUB_SELECT} WHERE s.id = $1 ${lock ? 'FOR UPDATE OF s' : ''}`,
    [id],
  );
  return rows[0] ?? null;
}

const pmAad = (subId: string) => `sub-pm:${subId}`;
const sealMethod = (ctx: AppContext, subId: string, token: string) =>
  encrypt(token, ctx.config.dataEncryptionKey, ctx.config.DATA_ENCRYPTION_KEY_ID, pmAad(subId));

async function describeMethod(ctx: AppContext, token: string): Promise<void> {
  try {
    await getPaymentProvider(ctx).describePaymentMethod(token);
  } catch (err) {
    if (err instanceof PaymentProviderError && !err.retryable)
      throw new AppError('unprocessable', 'That payment method cannot be used', {
        reason: err.code,
      });
  }
}

/**
 * Subscribe to a creator's plan: an idempotent first charge (Idempotency-Key required), the subscription starts `incomplete` and becomes `active` ONLY
 * when the signed capture webhook has landed and `settleCreatorPayments` applies it. The reusable payment method is stored encrypted for renewals.
 */
export async function subscribe(
  ctx: AppContext,
  auth: AuthContext,
  creatorId: string,
  b: { planId: string; paymentMethod: string; returnUrl?: string | undefined },
  key: string,
  clientIp: string,
  req?: FastifyRequest,
): Promise<{
  subscription: SubscriptionRow;
  payment: ReturnType<typeof paymentSummary>;
  replayed: boolean;
  nextAction: { type: string; url?: string | null } | null;
}> {
  if (auth.ageBand === 'teen') throw forbidden('Accounts under 18 cannot make purchases');
  if (creatorId === auth.userId) throw forbidden('You cannot subscribe to yourself');
  await assertCanReceive(ctx, creatorId, auth.userId);
  const plan = (
    await ctx.db.query<PlanRow>(
      `SELECT ${PLAN_COLS} FROM subscription_plans WHERE id = $1 AND creator_id = $2 AND active`,
      [b.planId, creatorId],
    )
  ).rows[0];
  if (!plan) throw notFound('Plan');
  await describeMethod(ctx, b.paymentMethod);
  const idem = `sub:${creatorId}:${key}`;
  const hash = requestHash({ creatorId, planId: plan.id, paymentMethod: b.paymentMethod });

  // A never-paid `incomplete` attempt older than half an hour must not block a new one (the unique index counts it as a live subscription).
  await expireStaleIncomplete(ctx, auth.userId, creatorId);
  const live = (
    await ctx.db.query<{ id: string; status: string; plan_id: string }>(
      `SELECT id, status, plan_id FROM subscriptions WHERE subscriber_id = $1 AND creator_id = $2 AND status IN ('incomplete','active','past_due')`,
      [auth.userId, creatorId],
    )
  ).rows[0];
  let subId = live?.id ?? null;
  const replayCheck = await ctx.db.query<{ subscription_id: string }>(
    `SELECT sp.subscription_id FROM payments p JOIN subscription_payments sp ON sp.payment_id = p.id WHERE p.payer_id = $1 AND p.idempotency_key = $2`,
    [auth.userId, idem],
  );
  if (live && !replayCheck.rows[0])
    throw conflict('You are already subscribed to this creator', {
      reason: 'already_subscribed',
      subscriptionId: live.id,
      status: live.status,
    });
  if (replayCheck.rows[0]) subId = replayCheck.rows[0].subscription_id;

  const now = new Date();
  const periodEnd = addInterval(now, plan.interval);
  const out = await chargeToCreator(ctx, {
    payer: { userId: auth.userId, ageBand: auth.ageBand },
    creatorId,
    purpose: 'subscription',
    amount: plan.price_cents,
    currency: plan.currency,
    idem,
    hash,
    paymentMethod: b.paymentMethod,
    returnUrl: b.returnUrl,
    metadata: { creatorId, planId: plan.id, kind: 'initial' },
    description: `Subscription: ${plan.name}`,
    clientIp,
    req,
    onCreated: async (tx, payment) => {
      const ins = await tx.query<{ id: string }>(
        `INSERT INTO subscriptions (subscriber_id, plan_id, creator_id, status, current_period_end, payment_method_enc) VALUES ($1,$2,$3,'incomplete',$4,NULL) RETURNING id`,
        [auth.userId, plan.id, creatorId, periodEnd],
      );
      subId = ins.rows[0]!.id;
      await tx.query('UPDATE subscriptions SET payment_method_enc = $2 WHERE id = $1', [
        subId,
        sealMethod(ctx, subId, b.paymentMethod),
      ]);
      await tx.query(
        `INSERT INTO subscription_payments (payment_id, subscription_id, kind, period_start, period_end) VALUES ($1,$2,'initial',$3,$4)`,
        [payment.id, subId, now, periodEnd],
      );
      await audit(
        ctx,
        {
          actorId: auth.userId,
          action: 'subscription.created',
          targetType: 'subscription',
          targetId: subId,
          metadata: { creatorId, planId: plan.id, paymentId: payment.id },
        },
        req,
        tx,
      );
    },
  }).catch((err: { code?: string }) => {
    if (err.code === '23505')
      throw conflict('You are already subscribed to this creator', {
        reason: 'already_subscribed',
      });
    throw err;
  });
  await settleCreatorPayments(ctx, { subscriptionId: subId! });
  const subscription = (await loadSubscription(ctx.db, subId!))!;
  if (subscription.status === 'expired' && out.payment.status === 'failed') {
    throw new AppError('payment_failed', 'The payment was declined', {
      reason: out.payment.failure_code ?? 'payment_failed',
      paymentId: out.payment.id,
    });
  }
  return {
    subscription,
    payment: paymentSummary(out.payment),
    replayed: out.replayed,
    nextAction: out.nextAction,
  };
}

async function expireStaleIncomplete(
  ctx: AppContext,
  subscriberId: string | null,
  creatorId: string | null,
): Promise<void> {
  await ctx.db.query(
    `UPDATE subscriptions s SET status = 'expired', ended_at = now(), end_reason = 'initial_payment_failed'
      WHERE s.status = 'incomplete' AND s.created_at < now() - interval '30 minutes' AND ($1::uuid IS NULL OR s.subscriber_id = $1) AND ($2::uuid IS NULL OR s.creator_id = $2)
        AND NOT EXISTS (SELECT 1 FROM subscription_payments sp JOIN payments p ON p.id = sp.payment_id WHERE sp.subscription_id = s.id AND sp.applied_at IS NULL AND p.status IN ('captured','partially_refunded'))`,
    [subscriberId, creatorId],
  );
}

// ------------------------------------------------------------------ cancel / resume / method
export async function cancelSubscription(
  ctx: AppContext,
  actor: { userId: string },
  subId: string,
  opts: { immediately?: boolean | undefined; asCreator?: boolean | undefined },
  req?: FastifyRequest,
): Promise<SubscriptionRow> {
  return withTransaction(ctx.db, async (tx) => {
    const s = await loadSubscription(tx, subId, true);
    const own =
      s && (opts.asCreator ? s.creator_id === actor.userId : s.subscriber_id === actor.userId);
    if (!s || !own) throw notFound('Subscription');
    if (!['active', 'past_due', 'incomplete'].includes(s.status))
      throw conflict(`This subscription is already ${s.status}`, {
        reason: 'not_cancellable',
        status: s.status,
      });
    // A creator removing a subscriber ends it now (no refund of the running period: use the refund tools for that); a subscriber ends it at period end.
    const now = opts.asCreator || opts.immediately || s.status === 'incomplete';
    if (now) {
      await tx.query(
        `UPDATE subscriptions SET status = 'cancelled', cancel_at_period_end = false, cancelled_at = now(), ended_at = now(), end_reason = $2, next_retry_at = NULL, payment_method_enc = NULL WHERE id = $1`,
        [subId, opts.asCreator ? 'cancelled_by_creator' : 'cancelled_by_subscriber'],
      );
    } else {
      await tx.query(
        'UPDATE subscriptions SET cancel_at_period_end = true, cancelled_at = COALESCE(cancelled_at, now()) WHERE id = $1',
        [subId],
      );
    }
    await audit(
      ctx,
      {
        actorId: actor.userId,
        action: 'subscription.cancelled',
        targetType: 'subscription',
        targetId: subId,
        metadata: {
          immediately: now,
          by: opts.asCreator ? 'creator' : 'subscriber',
          creatorId: s.creator_id,
        },
      },
      req,
      tx,
    );
    return (await loadSubscription(tx, subId))!;
  });
}

export async function resumeSubscription(
  ctx: AppContext,
  userId: string,
  subId: string,
  req?: FastifyRequest,
): Promise<SubscriptionRow> {
  const s = await loadSubscription(ctx.db, subId);
  if (!s || s.subscriber_id !== userId) throw notFound('Subscription');
  if (!['active', 'past_due'].includes(s.status) || !s.cancel_at_period_end)
    throw conflict('Only a subscription that is set to end can be resumed', {
      reason: 'not_resumable',
      status: s.status,
    });
  await ctx.db.query(
    'UPDATE subscriptions SET cancel_at_period_end = false, cancelled_at = NULL WHERE id = $1',
    [subId],
  );
  await audit(
    ctx,
    {
      actorId: userId,
      action: 'subscription.resumed',
      targetType: 'subscription',
      targetId: subId,
      metadata: { creatorId: s.creator_id },
    },
    req,
  );
  return (await loadSubscription(ctx.db, subId))!;
}

/** Replace the stored payment method. On a past_due subscription the next dunning attempt is brought forward to the next job run. */
export async function updatePaymentMethod(
  ctx: AppContext,
  userId: string,
  subId: string,
  token: string,
  req?: FastifyRequest,
): Promise<SubscriptionRow> {
  const s = await loadSubscription(ctx.db, subId);
  if (!s || s.subscriber_id !== userId) throw notFound('Subscription');
  if (!['active', 'past_due'].includes(s.status))
    throw conflict(`This subscription is ${s.status}`, {
      reason: 'not_updatable',
      status: s.status,
    });
  await describeMethod(ctx, token);
  await ctx.db.query(
    `UPDATE subscriptions SET payment_method_enc = $2, next_retry_at = CASE WHEN status = 'past_due' THEN now() ELSE next_retry_at END WHERE id = $1`,
    [subId, sealMethod(ctx, subId, token)],
  );
  await audit(
    ctx,
    {
      actorId: userId,
      action: 'subscription.payment_method_updated',
      targetType: 'subscription',
      targetId: subId,
    },
    req,
  );
  return (await loadSubscription(ctx.db, subId))!;
}

export async function mySubscriptions(db: Queryable, userId: string): Promise<SubscriptionRow[]> {
  const { rows } = await db.query<SubscriptionRow>(
    `${SUB_SELECT} WHERE s.subscriber_id = $1 ORDER BY s.created_at DESC LIMIT 100`,
    [userId],
  );
  return rows;
}

// ------------------------------------------------------------------ applying payment results (exactly once)
export interface SettleResult {
  subscriptionsActivated: number;
  renewed: number;
  failed: number;
  tips: number;
  gifts: number;
  refundedLate: number;
}

/**
 * Apply what the signed webhooks decided to the creator-economy rows: subscription payments (first charge / renewal), tips and gifts.
 * Idempotent (`applied_at`, status guards, row locks with SKIP LOCKED): safe to call from request paths, the renewal job and cron, concurrently.
 * With an asynchronous provider (Stripe) the webhook lands after the request returned, so `creator:maintenance` must run every minute or so.
 */
export async function settleCreatorPayments(
  ctx: AppContext,
  opts: { subscriptionId?: string; now?: Date } = {},
): Promise<SettleResult> {
  const res: SettleResult = {
    subscriptionsActivated: 0,
    renewed: 0,
    failed: 0,
    tips: 0,
    gifts: 0,
    refundedLate: 0,
  };
  const { rows: open } = await ctx.db.query<{ payment_id: string }>(
    `SELECT sp.payment_id FROM subscription_payments sp WHERE sp.applied_at IS NULL AND ($1::uuid IS NULL OR sp.subscription_id = $1) ORDER BY sp.created_at LIMIT 500`,
    [opts.subscriptionId ?? null],
  );
  const late: string[] = [];
  const notifications: Array<() => Promise<void>> = [];
  for (const o of open) {
    await withTransaction(ctx.db, async (tx) => {
      const r = (
        await tx.query<{
          payment_id: string;
          subscription_id: string;
          kind: 'initial' | 'renewal';
          period_start: Date;
          period_end: Date;
          attempt: number;
          pstatus: string;
          failure_code: string | null;
          pcreated: Date;
        }>(
          `SELECT sp.payment_id, sp.subscription_id, sp.kind, sp.period_start, sp.period_end, sp.attempt, p.status AS pstatus, p.failure_code, p.created_at AS pcreated
           FROM subscription_payments sp JOIN payments p ON p.id = sp.payment_id WHERE sp.payment_id = $1 AND sp.applied_at IS NULL FOR UPDATE OF sp SKIP LOCKED`,
          [o.payment_id],
        )
      ).rows[0];
      if (!r) return;
      const paid = ['captured', 'partially_refunded', 'refunded', 'disputed'].includes(r.pstatus);
      // Off-session renewals cannot complete a customer challenge or wait for a method: after ten minutes they count as failed.
      // Age is REAL elapsed time (not the job's logical `now`): `authorized` only waits for the provider's webhook, so it gets a day before we give up.
      const age = Date.now() - r.pcreated.getTime();
      const stuck =
        r.kind === 'renewal' &&
        ((['requires_action', 'requires_payment_method'].includes(r.pstatus) &&
          age > 10 * 60_000) ||
          (r.pstatus === 'authorized' && age > 24 * 3_600_000));
      const failed = ['failed', 'cancelled'].includes(r.pstatus) || stuck;
      if (!paid && !failed) return;
      const s = await loadSubscription(tx, r.subscription_id, true);
      if (!s) return;
      if (paid) {
        if (!['incomplete', 'active', 'past_due'].includes(s.status)) {
          // Money arrived for a subscription that already ended (abandoned first charge, cancelled during a slow payment): give it back.
          await tx.query(
            `UPDATE subscription_payments SET applied_at = now(), outcome = 'failed' WHERE payment_id = $1`,
            [r.payment_id],
          );
          await audit(
            ctx,
            {
              actorType: 'system',
              action: 'subscription.late_payment_refund',
              targetType: 'subscription',
              targetId: s.id,
              metadata: { paymentId: r.payment_id, status: s.status },
            },
            undefined,
            tx,
          );
          late.push(r.payment_id);
          return;
        }
        const end = new Date(Math.max(s.current_period_end.getTime(), r.period_end.getTime()));
        await tx.query(
          `UPDATE subscriptions SET status = 'active', current_period_end = $2, renewal_attempts = 0, next_retry_at = NULL, last_failure_code = NULL, started_at = COALESCE(started_at, now()) WHERE id = $1`,
          [s.id, r.kind === 'initial' ? r.period_end : end],
        );
        await tx.query(
          `UPDATE subscription_payments SET applied_at = now(), outcome = 'paid' WHERE payment_id = $1`,
          [r.payment_id],
        );
        await audit(
          ctx,
          {
            actorType: 'system',
            action: r.kind === 'initial' ? 'subscription.activated' : 'subscription.renewed',
            targetType: 'subscription',
            targetId: s.id,
            metadata: {
              paymentId: r.payment_id,
              periodEnd: end.toISOString(),
              creatorId: s.creator_id,
            },
          },
          undefined,
          tx,
        );
        if (r.kind === 'initial') {
          res.subscriptionsActivated += 1;
          notifications.push(() =>
            notify(ctx, {
              userId: s.creator_id,
              kind: 'payment_subscription_started',
              actorId: s.subscriber_id,
              targetType: 'subscription',
              targetId: s.id,
              data: { tier: s.tier, priceCents: s.price_cents, currency: s.currency },
            }),
          );
        } else res.renewed += 1;
        return;
      }
      // failed
      await tx.query(
        `UPDATE subscription_payments SET applied_at = now(), outcome = 'failed' WHERE payment_id = $1`,
        [r.payment_id],
      );
      res.failed += 1;
      const code = (r.failure_code ?? (stuck ? 'requires_action' : 'payment_failed')).slice(0, 100);
      if (r.kind === 'initial') {
        if (s.status === 'incomplete') {
          await tx.query(
            `UPDATE subscriptions SET status = 'expired', ended_at = now(), end_reason = 'initial_payment_failed', last_failure_code = $2, payment_method_enc = NULL WHERE id = $1`,
            [s.id, code],
          );
          await audit(
            ctx,
            {
              actorType: 'system',
              action: 'subscription.initial_payment_failed',
              targetType: 'subscription',
              targetId: s.id,
              metadata: { code, paymentId: r.payment_id },
            },
            undefined,
            tx,
          );
        }
        return;
      }
      if (!['active', 'past_due'].includes(s.status)) return;
      const outcome = renewalFailure(s.renewal_attempts, s.current_period_end);
      if (outcome.status === 'expired') {
        await tx.query(
          `UPDATE subscriptions SET status = 'expired', renewal_attempts = $2, next_retry_at = NULL, last_failure_code = $3, ended_at = now(), end_reason = 'payment_failed', payment_method_enc = NULL WHERE id = $1`,
          [s.id, outcome.attempts, code],
        );
        notifications.push(() =>
          notify(ctx, {
            userId: s.subscriber_id,
            kind: 'payment_subscription_expired',
            targetType: 'subscription',
            targetId: s.id,
            data: { creatorId: s.creator_id },
          }),
        );
      } else {
        await tx.query(
          `UPDATE subscriptions SET status = 'past_due', renewal_attempts = $2, next_retry_at = $3, last_failure_code = $4 WHERE id = $1`,
          [s.id, outcome.attempts, outcome.nextRetryAt, code],
        );
        notifications.push(() =>
          notify(ctx, {
            userId: s.subscriber_id,
            kind: 'payment_subscription_past_due',
            targetType: 'subscription',
            targetId: s.id,
            data: { creatorId: s.creator_id, retryAt: outcome.nextRetryAt?.toISOString() },
          }),
        );
      }
      await audit(
        ctx,
        {
          actorType: 'system',
          action: outcome.status === 'expired' ? 'subscription.expired' : 'subscription.past_due',
          targetType: 'subscription',
          targetId: s.id,
          metadata: { attempts: outcome.attempts, code, paymentId: r.payment_id },
        },
        undefined,
        tx,
      );
    });
  }
  for (const id of late) {
    await refundWholePayment(
      ctx,
      id,
      'Automatic refund: the subscription had already ended',
      `sublate:${id}`,
    )
      .then(() => {
        res.refundedLate += 1;
      })
      .catch((err: Error) =>
        ctx.log.error({ paymentId: id, err: err.message }, 'late subscription refund failed'),
      );
  }
  for (const n of notifications) await n().catch(() => undefined);
  if (!opts.subscriptionId) {
    const t = await settleSimple(ctx, 'tips');
    const g = await settleSimple(ctx, 'gifts');
    res.tips = t;
    res.gifts = g;
  }
  return res;
}

/** tips/gifts: pending -> completed | failed | refunded from the payment's state. Returns rows moved to completed. */
export async function settleSimple(
  ctx: AppContext,
  table: 'tips' | 'gifts',
  paymentId?: string,
): Promise<number> {
  const idCol = table === 'tips' ? 'from_user_id' : 'from_user_id';
  const done = await ctx.db.query<{
    id: string;
    creator_id: string;
    from_user_id: string;
    live_session_id?: string | null;
    amount_cents: string;
    currency: string;
  }>(
    `UPDATE ${table} t SET status = 'completed', settled_at = now() FROM payments p
      WHERE p.id = t.payment_id AND t.status = 'pending' AND p.status IN ('captured','partially_refunded','disputed') AND ($1::uuid IS NULL OR p.id = $1)
      RETURNING t.id, t.creator_id, t.${idCol} AS from_user_id, ${table === 'gifts' ? 't.live_session_id' : 'NULL::uuid AS live_session_id'}, p.amount_cents, p.currency`,
    [paymentId ?? null],
  );
  await ctx.db.query(
    `UPDATE ${table} t SET status = 'failed', settled_at = now() FROM payments p WHERE p.id = t.payment_id AND t.status = 'pending' AND p.status IN ('failed','cancelled') AND ($1::uuid IS NULL OR p.id = $1)`,
    [paymentId ?? null],
  );
  await ctx.db.query(
    `UPDATE ${table} t SET status = 'refunded' FROM payments p WHERE p.id = t.payment_id AND t.status = 'completed' AND p.status = 'refunded' AND ($1::uuid IS NULL OR p.id = $1)`,
    [paymentId ?? null],
  );
  for (const r of done.rows) {
    await notify(ctx, {
      userId: r.creator_id,
      kind: table === 'tips' ? 'payment_tip_received' : 'payment_gift_received',
      actorId: r.from_user_id,
      targetType: table === 'tips' ? 'tip' : 'gift',
      targetId: r.id,
      data: { amountCents: Number(r.amount_cents), currency: r.currency },
    });
    if (table === 'gifts' && r.live_session_id) {
      // Realtime fan-out for the live module's WebSocket (channel naming is part of that module's contract: `live:<id>`).
      void ctx.pubsub
        .publish(`live:${r.live_session_id}`, {
          type: 'gift',
          giftId: r.id,
          fromUserId: r.from_user_id,
          creatorId: r.creator_id,
          amountCents: Number(r.amount_cents),
          currency: r.currency,
        })
        .catch(() => undefined);
    }
  }
  return done.rows.length;
}

// ------------------------------------------------------------------ renewals job
export interface RenewalResult {
  ended: number;
  charged: number;
  renewed: number;
  pastDue: number;
  expired: number;
  refundedLate: number;
  incompleteExpired: number;
}

/**
 * THE renewal job (scripts/creator-maintenance.ts runs it every minute or so; nothing in the API process schedules it):
 *  1. apply results of earlier charges (settle), 2. expire abandoned first charges, 3. end subscriptions set to cancel at period end,
 *  4. charge due renewals: `active` past their period end, and `past_due` whose dunning retry time has come (days 1, 3, 5 after the first failure,
 *     then `expired`). Every attempt has its own idempotency key `sub:<id>:<periodEnd>:a<n>`, so two workers can never bill one attempt twice.
 */
export async function processSubscriptionRenewals(
  ctx: AppContext,
  opts: { now?: Date; limit?: number } = {},
): Promise<RenewalResult> {
  const now = opts.now ?? new Date();
  const out: RenewalResult = {
    ended: 0,
    charged: 0,
    renewed: 0,
    pastDue: 0,
    expired: 0,
    refundedLate: 0,
    incompleteExpired: 0,
  };
  const s0 = await settleCreatorPayments(ctx, { now });
  out.refundedLate += s0.refundedLate;
  out.renewed += s0.renewed;
  const st = await ctx.db.query(
    `UPDATE subscriptions s SET status = 'expired', ended_at = $1, end_reason = 'initial_payment_failed' WHERE s.status = 'incomplete' AND s.created_at < $1::timestamptz - interval '30 minutes'
      AND NOT EXISTS (SELECT 1 FROM subscription_payments sp JOIN payments p ON p.id = sp.payment_id WHERE sp.subscription_id = s.id AND sp.applied_at IS NULL AND p.status IN ('captured','partially_refunded'))`,
    [now],
  );
  out.incompleteExpired = st.rowCount ?? 0;

  const ended = await ctx.db.query<{ id: string; creator_id: string; subscriber_id: string }>(
    `UPDATE subscriptions SET status = 'cancelled', ended_at = current_period_end, end_reason = 'cancelled_by_subscriber', next_retry_at = NULL, payment_method_enc = NULL
      WHERE status IN ('active','past_due') AND cancel_at_period_end AND current_period_end <= $1 RETURNING id, creator_id, subscriber_id`,
    [now],
  );
  out.ended = ended.rowCount ?? 0;
  for (const e of ended.rows)
    await audit(ctx, {
      actorType: 'system',
      action: 'subscription.ended',
      targetType: 'subscription',
      targetId: e.id,
      metadata: { reason: 'cancel_at_period_end', creatorId: e.creator_id },
    });

  const due = await ctx.db.query<{ id: string }>(
    `SELECT s.id FROM subscriptions s
      WHERE ((s.status = 'active' AND s.current_period_end <= $1 AND NOT s.cancel_at_period_end) OR (s.status = 'past_due' AND s.next_retry_at IS NOT NULL AND s.next_retry_at <= $1))
        AND s.payment_method_enc IS NOT NULL
        AND EXISTS (SELECT 1 FROM creators c WHERE c.user_id = s.creator_id AND c.status = 'active')
        AND NOT EXISTS (SELECT 1 FROM subscription_payments sp WHERE sp.subscription_id = s.id AND sp.applied_at IS NULL)
      ORDER BY s.current_period_end LIMIT $2`,
    [now, opts.limit ?? 200],
  );
  for (const d of due.rows) {
    const s = await loadSubscription(ctx.db, d.id);
    if (!s) continue;
    const enc = (
      await ctx.db.query<{ payment_method_enc: string | null }>(
        'SELECT payment_method_enc FROM subscriptions WHERE id = $1',
        [s.id],
      )
    ).rows[0]?.payment_method_enc;
    if (!enc) continue;
    let token: string;
    try {
      token = decrypt(enc, ctx.config.dataEncryptionKey, pmAad(s.id));
    } catch (err) {
      ctx.log.error(
        { subscriptionId: s.id, err: (err as Error).message },
        'stored payment method cannot be decrypted',
      );
      continue;
    }
    const attempt = s.renewal_attempts + 1;
    const anchor = s.current_period_end;
    const base = now.getTime() - anchor.getTime() > 3 * 86_400_000 ? now : anchor;
    const periodEnd = addInterval(base, s.interval);
    try {
      const charged = await chargeToCreator(ctx, {
        payer: { userId: s.subscriber_id, ageBand: 'adult' },
        creatorId: s.creator_id,
        purpose: 'subscription',
        amount: s.price_cents,
        currency: s.currency,
        idem: `sub:${s.id}:${anchor.toISOString()}:a${attempt}`,
        hash: requestHash({ subscriptionId: s.id, anchor: anchor.toISOString(), attempt }),
        paymentMethod: token,
        metadata: {
          creatorId: s.creator_id,
          planId: s.plan_id,
          kind: 'renewal',
          subscriptionId: s.id,
        },
        description: `Subscription renewal: ${s.plan_name}`,
        offSession: true,
        onCreated: async (tx, payment) => {
          await tx.query(
            `INSERT INTO subscription_payments (payment_id, subscription_id, kind, period_start, period_end, attempt) VALUES ($1,$2,'renewal',$3,$4,$5)`,
            [payment.id, s.id, base, periodEnd, attempt],
          );
        },
      });
      if (!charged.replayed) out.charged += 1;
    } catch (err) {
      ctx.log.error(
        { subscriptionId: s.id, err: (err as Error).message },
        'renewal charge failed to start',
      );
      continue;
    }
    const before = await settleCreatorPayments(ctx, { subscriptionId: s.id, now });
    out.renewed += before.renewed;
    out.refundedLate += before.refundedLate;
    const after = await loadSubscription(ctx.db, s.id);
    if (after?.status === 'past_due') out.pastDue += 1;
    if (after?.status === 'expired') out.expired += 1;
  }
  return out;
}

export const MIN_PLAN_PRICE = MIN_CHARGE_CENTS;
export { invalid };
