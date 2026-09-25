import { z } from 'zod';
import {
  AppError,
  clampLimit,
  conflict,
  decodeCursor,
  encodeCursor,
  invalid,
  notFound,
} from '@yapilapi/shared';
import { route } from '../../lib/route.js';
import { audit } from '../../lib/audit.js';
import type { ApiModule } from '../types.js';
import { requireSellerAccess } from '../commerce/access.js';
import {
  IDEMPOTENCY_KEY,
  ORDER_COLS,
  loadOrder,
  orderViewer,
  orderViews,
  type OrderRow,
} from '../commerce/orders.js';
import { ORDER_STATUSES } from '../commerce/order-state.js';
import {
  confirmBody,
  confirmPayment,
  getOwnPayment,
  payBody,
  payCommunityMembership,
  payOrder,
  paymentView,
} from './pay.js';
import {
  REFUND_COLS,
  createRefund,
  decideRefund,
  executeRefund,
  loadRefund,
  refundView,
  type RefundRow,
} from './refunds.js';
import {
  accountView,
  createPayoutAccount,
  failPayout,
  findAccount,
  listPayouts,
  payoutView,
  refreshPayoutAccount,
  requestPayout,
  resolvePayee,
  sendPayout,
  setAccountKyc,
  type PayoutRow,
} from './payouts.js';
import { payeeBalances } from './ledger.js';
import { getPaymentProvider } from './provider.js';
import { runReconciliation } from './reconciliation.js';
import { reviewOrder } from './review.js';
import { processWebhook } from './webhook.js';

export { releaseExpiredReservations } from '../commerce/orders.js';
export { processWebhook, deliverLocalWebhooks } from './webhook.js';
export { retryPendingFulfilments, fulfilPayment } from './fulfilment.js';
export { retryProcessingRefunds, createRefund, decideRefund, executeRefund } from './refunds.js';
export { requestPayout, sendPayout } from './payouts.js';
export { runReconciliation, integrityChecks } from './reconciliation.js';
export { getPaymentProvider, overridePaymentProvider } from './provider.js';
export { payeeBalances, accountBalance, postLedger } from './ledger.js';

const idParams = z.object({ id: z.uuid() });
const pageQuery = z.object({
  cursor: z.string().max(300).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});
const STAFF = ['admin', 'superadmin'] as const;
const W = { limit: 60, windowSec: 600, by: 'user' } as const;
const MONEY_W = { limit: 20, windowSec: 3600, by: 'user' } as const;
type Cursor = { t: string; id: string };

const optionalKey = (req: {
  headers: Record<string, string | string[] | undefined>;
}): string | undefined => {
  const raw = req.headers['idempotency-key'];
  const key = Array.isArray(raw) ? raw[0] : raw;
  if (key === undefined) return undefined;
  if (!IDEMPOTENCY_KEY.test(key))
    throw invalid('Idempotency-Key must be 8-128 characters (letters, digits, . _ : -)');
  return key;
};
const requiredKey = (req: { headers: Record<string, string | string[] | undefined> }): string => {
  const k = optionalKey(req);
  if (!k)
    throw invalid(
      'An Idempotency-Key header (8-128 characters: letters, digits, . _ : -) is required',
    );
  return k;
};

export const paymentsModule: ApiModule = {
  name: 'payments',
  register(app, ctx) {
    const gate = (userId?: string) => ctx.flags.require('COMMERCE', userId);

    // ================================================================== webhook (own scope: the signature covers the exact raw bytes)
    void app.register(async (hook) => {
      hook.addContentTypeParser(
        'application/json',
        { parseAs: 'string', bodyLimit: 1_048_576 },
        (_req, body, done) => done(null, body),
      );
      route(hook, ctx, {
        method: 'POST',
        url: '/v1/webhooks/payments/:provider',
        summary:
          'Payment provider webhook (signature and timestamp verified on the raw body; deduplicated)',
        tags: ['payments'],
        auth: 'public',
        params: z.object({ provider: z.enum(['dev', 'stripe']) }),
        rateLimit: { limit: 600, windowSec: 60, by: 'ip' },
        handler: async ({ req, params }) => {
          const raw = typeof req.body === 'string' ? req.body : '';
          const r = await processWebhook(ctx, params.provider, raw, req.headers);
          return { received: true, events: r.events, duplicates: r.duplicates };
        },
      });
    });

    // ================================================================== paying
    route(app, ctx, {
      method: 'POST',
      url: '/v1/orders/:id/pay',
      summary:
        'Pay for an order with a provider payment-method token. Requires an Idempotency-Key header. Never send card numbers.',
      tags: ['payments'],
      auth: 'user',
      params: idParams,
      body: payBody,
      rateLimit: { limit: 20, windowSec: 600, by: 'user' },
      handler: async ({ auth, req, reply, params, body }) => {
        await gate(auth.userId);
        const key = requiredKey(req);
        const r = await payOrder(
          ctx,
          { userId: auth.userId, ageBand: auth.ageBand },
          params.id,
          key,
          body,
          req.clientIp,
          req,
        );
        if (r.replayed) void reply.header('idempotent-replayed', 'true');
        if (r.held) {
          void reply.code(202);
          return {
            held: true,
            message: 'Your order needs a quick review before it can be paid. We will notify you.',
            order: (await orderViews(ctx, [await loadOrder(ctx.db, params.id)], 'buyer'))[0],
          };
        }
        if (r.payment.status === 'failed') {
          throw new AppError(
            'payment_failed',
            'Your payment was declined. Try another payment method.',
            { paymentId: r.payment.id, failureCode: r.payment.failure_code },
          );
        }
        void reply.code(r.replayed ? 200 : 201);
        return {
          payment: paymentView(r.payment),
          nextAction: r.nextAction,
          order: (await orderViews(ctx, [await loadOrder(ctx.db, params.id)], 'buyer'))[0],
        };
      },
    });

    route(app, ctx, {
      method: 'POST',
      url: '/v1/payments/:id/confirm',
      summary: 'Continue a payment that needs a payment method or a customer action',
      tags: ['payments'],
      auth: 'user',
      params: idParams,
      body: confirmBody,
      rateLimit: { limit: 20, windowSec: 600, by: 'user' },
      handler: async ({ auth, req, params, body }) => {
        await gate(auth.userId);
        const r = await confirmPayment(
          ctx,
          { userId: auth.userId, ageBand: auth.ageBand },
          params.id,
          body,
          req.clientIp,
          req,
        );
        if (r.payment.status === 'failed')
          throw new AppError(
            'payment_failed',
            'Your payment was declined. Try another payment method.',
            { paymentId: r.payment.id, failureCode: r.payment.failure_code },
          );
        return {
          payment: paymentView(r.payment),
          nextAction: r.nextAction,
          order: r.payment.order_id
            ? (await orderViews(ctx, [await loadOrder(ctx.db, r.payment.order_id)], 'buyer'))[0]
            : null,
        };
      },
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/payments/:id',
      summary: 'One of my payments',
      tags: ['payments'],
      auth: 'user',
      params: idParams,
      rateLimit: W,
      handler: async ({ auth, params }) => {
        await gate(auth.userId);
        return paymentView(await getOwnPayment(ctx, auth.userId, params.id));
      },
    });

    route(app, ctx, {
      method: 'POST',
      url: '/v1/communities/:ref/membership/pay',
      summary: 'Pay for a paid community membership. Requires an Idempotency-Key header.',
      tags: ['payments'],
      auth: 'user',
      params: z.object({ ref: z.string().trim().min(1).max(60) }),
      body: payBody,
      rateLimit: { limit: 20, windowSec: 600, by: 'user' },
      handler: async ({ auth, req, reply, params, body }) => {
        await gate(auth.userId);
        const r = await payCommunityMembership(
          ctx,
          { userId: auth.userId, ageBand: auth.ageBand },
          params.ref,
          requiredKey(req),
          body,
          req.clientIp,
          req,
        );
        if (r.replayed) void reply.header('idempotent-replayed', 'true');
        if (r.payment.status === 'failed')
          throw new AppError(
            'payment_failed',
            'Your payment was declined. Try another payment method.',
            { paymentId: r.payment.id, failureCode: r.payment.failure_code },
          );
        void reply.code(r.replayed ? 200 : 201);
        return { payment: paymentView(r.payment), nextAction: r.nextAction };
      },
    });

    // ================================================================== refunds
    route(app, ctx, {
      method: 'POST',
      url: '/v1/orders/:id/refunds',
      summary: 'Request a refund (buyer), or issue one (seller). Full, per-item or partial amount.',
      tags: ['payments'],
      auth: 'user',
      params: idParams,
      body: z.object({
        amountCents: z.number().int().min(1).max(100_000_000_000).optional(),
        itemId: z.uuid().optional(),
        reason: z.string().trim().min(3).max(1000),
        restock: z.boolean().optional(),
      }),
      rateLimit: MONEY_W,
      handler: async ({ auth, req, reply, params, body }) => {
        await gate(auth.userId);
        const o = await loadOrder(ctx.db, params.id).catch(() => null);
        const who = o ? await orderViewer(ctx.db, o, auth.userId, 'orders') : null;
        if (!o || !who) throw notFound('Order');
        const { refund, created } = await createRefund(
          ctx,
          {
            orderId: o.id,
            actor: who,
            actorId: auth.userId,
            amountCents: body.amountCents,
            itemId: body.itemId,
            reason: body.reason,
            key: optionalKey(req),
            restock: who === 'seller' ? body.restock : undefined,
          },
          req,
        );
        if (who === 'seller' && created) await executeRefund(ctx, refund.id);
        void reply.code(created ? 201 : 200);
        return refundView(await loadRefund(ctx.db, refund.id));
      },
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/orders/:id/refunds',
      summary: 'Refunds of an order (buyer or seller side)',
      tags: ['payments'],
      auth: 'user',
      params: idParams,
      rateLimit: W,
      handler: async ({ auth, params }) => {
        await gate(auth.userId);
        const o = await loadOrder(ctx.db, params.id).catch(() => null);
        const who = o ? await orderViewer(ctx.db, o, auth.userId, 'orders') : null;
        if (!o || !who) throw notFound('Order');
        const { rows } = await ctx.db.query<RefundRow>(
          `SELECT ${REFUND_COLS} FROM refunds r WHERE r.order_id = $1 ORDER BY r.created_at, r.id`,
          [o.id],
        );
        return { items: rows.map(refundView) };
      },
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/seller/refunds',
      summary: 'Refund requests for my orders',
      tags: ['payments'],
      auth: 'user',
      query: pageQuery.extend({
        businessId: z.uuid().optional(),
        status: z
          .enum(['requested', 'approved', 'processing', 'succeeded', 'failed', 'rejected'])
          .optional(),
      }),
      rateLimit: W,
      handler: async ({ auth, query }) => {
        await gate(auth.userId);
        if (query.businessId)
          await requireSellerAccess(
            ctx.db,
            { type: 'business', id: query.businessId },
            auth.userId,
            'orders',
            { allowInactive: true },
          );
        const limit = clampLimit(query.limit);
        const cur = decodeCursor<Cursor>(query.cursor);
        const { rows } = await ctx.db.query<RefundRow>(
          `SELECT ${REFUND_COLS} FROM refunds r JOIN orders o ON o.id = r.order_id
            WHERE ($1::uuid IS NULL AND o.seller_user_id = $2 OR o.seller_business_id = $1) AND ($3::text IS NULL OR r.status = $3)
              AND ($4::timestamptz IS NULL OR (r.created_at, r.id) < ($4::timestamptz, $5::uuid))
            ORDER BY r.created_at DESC, r.id DESC LIMIT $6`,
          [
            query.businessId ?? null,
            auth.userId,
            query.status ?? null,
            cur?.t ?? null,
            cur?.id ?? null,
            limit + 1,
          ],
        );
        const page = rows.slice(0, limit);
        const last = page[page.length - 1];
        return {
          items: page.map(refundView),
          nextCursor:
            rows.length > limit && last
              ? encodeCursor({ t: last.created_at.toISOString(), id: last.id })
              : null,
        };
      },
    });

    const decisionBody = z
      .object({ note: z.string().trim().max(1000).optional(), restock: z.boolean().optional() })
      .default({});
    for (const decision of ['approve', 'deny'] as const) {
      route(app, ctx, {
        method: 'POST',
        url: `/v1/refunds/:id/${decision}`,
        summary: `${decision === 'approve' ? 'Approve' : 'Deny'} a refund request (seller side)`,
        tags: ['payments'],
        auth: 'user',
        params: idParams,
        body: decisionBody,
        rateLimit: MONEY_W,
        handler: async ({ auth, req, params, body }) => {
          await gate(auth.userId);
          return refundView(
            await decideRefund(
              ctx,
              {
                refundId: params.id,
                decidedBy: auth.userId,
                actor: 'seller',
                decision,
                note: body.note,
                restock: body.restock,
              },
              req,
            ),
          );
        },
      });
      route(app, ctx, {
        method: 'POST',
        url: `/v1/staff/refunds/:id/${decision}`,
        summary: `${decision === 'approve' ? 'Approve' : 'Deny'} a refund request (staff, e.g. when the seller does not respond)`,
        tags: ['payments', 'staff'],
        auth: { staff: STAFF },
        params: idParams,
        body: decisionBody,
        rateLimit: MONEY_W,
        handler: async ({ auth, req, params, body }) =>
          refundView(
            await decideRefund(
              ctx,
              {
                refundId: params.id,
                decidedBy: auth.userId,
                actor: 'staff',
                decision,
                note: body.note,
                restock: body.restock,
              },
              req,
            ),
          ),
      });
    }

    // ================================================================== payout accounts, balance, payouts
    route(app, ctx, {
      method: 'POST',
      url: '/v1/payout-accounts',
      summary: "Create my (or my business's) payout account with the payment provider",
      tags: ['payments'],
      auth: 'user',
      body: z.object({
        businessId: z.uuid().optional(),
        country: z
          .string()
          .trim()
          .length(2)
          .transform((s) => s.toUpperCase()),
        email: z.email().max(254).optional(),
        returnUrl: z.url().max(500).optional(),
      }),
      rateLimit: { limit: 10, windowSec: 3600, by: 'user' },
      handler: async ({ auth, req, reply, body }) => {
        await gate(auth.userId);
        const { account, onboardingUrl } = await createPayoutAccount(
          ctx,
          { userId: auth.userId, ageBand: auth.ageBand },
          body,
          req,
        );
        void reply.code(201);
        return accountView(account, { onboardingUrl });
      },
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/payout-accounts',
      summary: 'My payout account',
      tags: ['payments'],
      auth: 'user',
      query: z.object({ businessId: z.uuid().optional() }),
      rateLimit: W,
      handler: async ({ auth, query }) => {
        await gate(auth.userId);
        const payee = await resolvePayee(
          ctx,
          { userId: auth.userId, ageBand: auth.ageBand },
          query.businessId,
        );
        const a = await findAccount(ctx.db, payee);
        return { account: a ? accountView(a) : null };
      },
    });

    route(app, ctx, {
      method: 'POST',
      url: '/v1/payout-accounts/:id/refresh',
      summary: 'Re-read verification status from the provider',
      tags: ['payments'],
      auth: 'user',
      params: idParams,
      rateLimit: MONEY_W,
      handler: async ({ auth, req, params }) => {
        await gate(auth.userId);
        return accountView(
          await refreshPayoutAccount(
            ctx,
            { userId: auth.userId, ageBand: auth.ageBand },
            params.id,
            req,
          ),
        );
      },
    });

    route(app, ctx, {
      method: 'PUT',
      url: '/v1/staff/payout-accounts/:id/kyc',
      summary:
        "Staff: set a payout account's verification state (marking verified is only possible with the dev provider; real KYC comes from the provider)",
      tags: ['payments', 'staff'],
      auth: { staff: STAFF },
      params: idParams,
      body: z.object({
        kycStatus: z.enum(['unverified', 'pending', 'verified', 'rejected']),
        reason: z.string().trim().min(3).max(500),
      }),
      rateLimit: MONEY_W,
      handler: async ({ auth, req, params, body }) => {
        const cur = await ctx.db.query<{ kyc_status: string; provider: string }>(
          'SELECT kyc_status, provider FROM payout_accounts WHERE id = $1',
          [params.id],
        );
        if (!cur.rows[0]) throw notFound('Payout account');
        if (body.kycStatus === 'verified' && cur.rows[0].provider !== 'dev')
          throw new AppError(
            'forbidden',
            'Verification comes from the payment provider and cannot be granted manually',
            { reason: 'kyc_provider_only' },
          );
        const updated = await setAccountKyc(ctx.db, params.id, body.kycStatus);
        await audit(
          ctx,
          {
            actorId: auth.userId,
            actorType: 'staff',
            action: 'payout_account.kyc_set_by_staff',
            targetType: 'payout_account',
            targetId: params.id,
            metadata: { from: cur.rows[0].kyc_status, to: body.kycStatus, reason: body.reason },
          },
          req,
        );
        return accountView(updated!);
      },
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/payouts/balance',
      summary: 'My balance: total owed, available to pay out now, and still on hold',
      tags: ['payments'],
      auth: 'user',
      query: z.object({ businessId: z.uuid().optional() }),
      rateLimit: W,
      handler: async ({ auth, query }) => {
        await gate(auth.userId);
        const payee = await resolvePayee(
          ctx,
          { userId: auth.userId, ageBand: auth.ageBand },
          query.businessId,
        );
        const acc = await findAccount(ctx.db, payee);
        return {
          holdDays: ctx.config.PAYOUT_HOLD_DAYS,
          balances: (await payeeBalances(ctx.db, payee, ctx.config.PAYOUT_HOLD_DAYS)).map((b) => ({
            currency: b.currency,
            totalCents: b.total,
            availableCents: b.available,
            pendingCents: b.pending,
          })),
          payoutAccount: acc
            ? {
                id: acc.id,
                kycStatus: acc.kyc_status,
                payoutsEnabled: acc.kyc_status === 'verified' && acc.status === 'active',
              }
            : null,
        };
      },
    });

    route(app, ctx, {
      method: 'POST',
      url: '/v1/payouts',
      summary: 'Request a payout of my available balance. Requires an Idempotency-Key header.',
      tags: ['payments'],
      auth: 'user',
      body: z.object({
        businessId: z.uuid().optional(),
        currency: z
          .string()
          .trim()
          .toUpperCase()
          .regex(/^[A-Z]{3}$/),
        amountCents: z.number().int().min(1).max(100_000_000_000).optional(),
      }),
      rateLimit: MONEY_W,
      handler: async ({ auth, req, reply, body }) => {
        await gate(auth.userId);
        const r = await requestPayout(
          ctx,
          { userId: auth.userId, ageBand: auth.ageBand },
          { ...body, key: requiredKey(req) },
          req,
        );
        void reply.code(r.replayed ? 200 : 201);
        if (r.replayed) void reply.header('idempotent-replayed', 'true');
        return payoutView(r.payout);
      },
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/payouts',
      summary: 'My payouts',
      tags: ['payments'],
      auth: 'user',
      query: z.object({ businessId: z.uuid().optional() }),
      rateLimit: W,
      handler: async ({ auth, query }) => {
        await gate(auth.userId);
        const payee = await resolvePayee(
          ctx,
          { userId: auth.userId, ageBand: auth.ageBand },
          query.businessId,
        );
        return { items: (await listPayouts(ctx.db, payee)).map(payoutView) };
      },
    });

    // ================================================================== staff: payouts
    route(app, ctx, {
      method: 'GET',
      url: '/v1/staff/payouts',
      summary: 'Staff: payouts by status',
      tags: ['payments', 'staff'],
      auth: { staff: STAFF },
      query: pageQuery.extend({
        status: z.enum(['pending', 'verifying', 'approved', 'paid', 'failed', 'held']).optional(),
      }),
      rateLimit: W,
      handler: async ({ query }) => {
        const limit = clampLimit(query.limit);
        const cur = decodeCursor<Cursor>(query.cursor);
        const { rows } = await ctx.db.query<PayoutRow>(
          `SELECT * FROM payouts WHERE ($1::text IS NULL OR status = $1) AND ($2::timestamptz IS NULL OR (created_at, id) < ($2::timestamptz, $3::uuid)) ORDER BY created_at DESC, id DESC LIMIT $4`,
          [query.status ?? null, cur?.t ?? null, cur?.id ?? null, limit + 1],
        );
        const page = rows.slice(0, limit);
        const last = page[page.length - 1];
        return {
          items: page.map(payoutView),
          nextCursor:
            rows.length > limit && last
              ? encodeCursor({ t: last.created_at.toISOString(), id: last.id })
              : null,
        };
      },
    });

    route(app, ctx, {
      method: 'POST',
      url: '/v1/staff/payouts/:id/retry',
      summary:
        'Staff: retry the provider transfer of a held/pending payout (same idempotency key: cannot pay twice)',
      tags: ['payments', 'staff'],
      auth: { staff: STAFF },
      params: idParams,
      rateLimit: MONEY_W,
      handler: async ({ auth, req, params }) => {
        const { rows } = await ctx.db.query<PayoutRow>('SELECT * FROM payouts WHERE id = $1', [
          params.id,
        ]);
        if (!rows[0]) throw notFound('Payout');
        if (!['pending', 'held'].includes(rows[0].status))
          throw conflict(`This payout is ${rows[0].status}`, { reason: 'payout_not_retryable' });
        await audit(
          ctx,
          {
            actorId: auth.userId,
            actorType: 'staff',
            action: 'payout.retried_by_staff',
            targetType: 'payout',
            targetId: params.id,
          },
          req,
        );
        await sendPayout(ctx, params.id);
        return payoutView(
          (await ctx.db.query<PayoutRow>('SELECT * FROM payouts WHERE id = $1', [params.id]))
            .rows[0]!,
        );
      },
    });

    route(app, ctx, {
      method: 'POST',
      url: '/v1/staff/payouts/:id/fail',
      summary: 'Staff: cancel a held/pending payout and return the money to the seller balance',
      tags: ['payments', 'staff'],
      auth: { staff: STAFF },
      params: idParams,
      body: z.object({ reason: z.string().trim().min(3).max(200) }),
      rateLimit: MONEY_W,
      handler: async ({ auth, req, params, body }) => {
        const { rows } = await ctx.db.query<PayoutRow>('SELECT * FROM payouts WHERE id = $1', [
          params.id,
        ]);
        if (!rows[0]) throw notFound('Payout');
        if (!['pending', 'held'].includes(rows[0].status))
          throw conflict(`This payout is ${rows[0].status}`, { reason: 'payout_not_cancellable' });
        await audit(
          ctx,
          {
            actorId: auth.userId,
            actorType: 'staff',
            action: 'payout.cancelled_by_staff',
            targetType: 'payout',
            targetId: params.id,
            metadata: { reason: body.reason },
          },
          req,
        );
        await failPayout(ctx, params.id, `staff:${body.reason}`.slice(0, 100));
        return payoutView(
          (await ctx.db.query<PayoutRow>('SELECT * FROM payouts WHERE id = $1', [params.id]))
            .rows[0]!,
        );
      },
    });

    // ================================================================== staff: orders held for review, refunds, disputes, fraud, reconciliation
    route(app, ctx, {
      method: 'GET',
      url: '/v1/staff/orders',
      summary: 'Staff: orders by status (default: held for fraud review)',
      tags: ['payments', 'staff'],
      auth: { staff: STAFF },
      query: pageQuery.extend({ status: z.enum(ORDER_STATUSES).default('pending_review') }),
      rateLimit: W,
      handler: async ({ query }) => {
        const limit = clampLimit(query.limit);
        const cur = decodeCursor<Cursor>(query.cursor);
        const { rows } = await ctx.db.query<OrderRow>(
          `SELECT ${ORDER_COLS} FROM orders o WHERE o.status = $1 AND ($2::timestamptz IS NULL OR (o.created_at, o.id) < ($2::timestamptz, $3::uuid)) ORDER BY o.created_at DESC, o.id DESC LIMIT $4`,
          [query.status, cur?.t ?? null, cur?.id ?? null, limit + 1],
        );
        const page = rows.slice(0, limit);
        const last = page[page.length - 1];
        return {
          items: await orderViews(ctx, page, 'staff'),
          nextCursor:
            rows.length > limit && last
              ? encodeCursor({ t: last.created_at.toISOString(), id: last.id })
              : null,
        };
      },
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/staff/orders/:id',
      summary: 'Staff: one order with its fraud assessment',
      tags: ['payments', 'staff'],
      auth: { staff: STAFF },
      params: idParams,
      rateLimit: W,
      handler: async ({ auth, req, params }) => {
        const o = await loadOrder(ctx.db, params.id);
        await audit(
          ctx,
          {
            actorId: auth.userId,
            actorType: 'staff',
            action: 'order.staff_viewed',
            targetType: 'order',
            targetId: o.id,
          },
          req,
        );
        const signals = await ctx.db.query(
          'SELECT stage, decision, score, reasons, created_at FROM fraud_signals WHERE subject_id = $1 ORDER BY created_at',
          [o.id],
        );
        return { order: (await orderViews(ctx, [o], 'staff'))[0], fraudSignals: signals.rows };
      },
    });

    route(app, ctx, {
      method: 'POST',
      url: '/v1/staff/orders/:id/review',
      summary:
        'Staff: approve (buyer may pay) or reject (order cancelled) an order held for review',
      tags: ['payments', 'staff'],
      auth: { staff: STAFF },
      params: idParams,
      body: z.object({
        decision: z.enum(['approve', 'reject']),
        note: z.string().trim().max(500).optional(),
      }),
      rateLimit: MONEY_W,
      handler: async ({ auth, req, params, body }) => {
        const r = await reviewOrder(ctx, auth.userId, params.id, body.decision, body.note, req);
        return { id: params.id, status: r.status };
      },
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/staff/refunds',
      summary: 'Staff: refunds by status (default: requested)',
      tags: ['payments', 'staff'],
      auth: { staff: STAFF },
      query: pageQuery.extend({
        status: z
          .enum(['requested', 'approved', 'processing', 'succeeded', 'failed', 'rejected'])
          .default('requested'),
      }),
      rateLimit: W,
      handler: async ({ query }) => {
        const limit = clampLimit(query.limit);
        const cur = decodeCursor<Cursor>(query.cursor);
        const { rows } = await ctx.db.query<RefundRow>(
          `SELECT ${REFUND_COLS} FROM refunds r WHERE r.status = $1 AND ($2::timestamptz IS NULL OR (r.created_at, r.id) < ($2::timestamptz, $3::uuid)) ORDER BY r.created_at DESC, r.id DESC LIMIT $4`,
          [query.status, cur?.t ?? null, cur?.id ?? null, limit + 1],
        );
        const page = rows.slice(0, limit);
        const last = page[page.length - 1];
        return {
          items: page.map(refundView),
          nextCursor:
            rows.length > limit && last
              ? encodeCursor({ t: last.created_at.toISOString(), id: last.id })
              : null,
        };
      },
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/staff/disputes',
      summary: 'Staff: payment disputes',
      tags: ['payments', 'staff'],
      auth: { staff: STAFF },
      query: pageQuery.extend({ status: z.enum(['open', 'won', 'lost']).optional() }),
      rateLimit: W,
      handler: async ({ query }) => {
        const limit = clampLimit(query.limit);
        const { rows } = await ctx.db.query(
          `SELECT id, payment_id, order_id, provider, provider_ref, status, reason, amount_cents, currency, opened_at, closed_at FROM disputes WHERE ($1::text IS NULL OR status = $1) ORDER BY opened_at DESC LIMIT $2`,
          [query.status ?? null, limit],
        );
        return { items: rows };
      },
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/staff/webhook-events',
      summary: 'Staff: received payment webhooks (payload omitted)',
      tags: ['payments', 'staff'],
      auth: { staff: STAFF },
      query: pageQuery.extend({
        unprocessed: z
          .enum(['true', 'false'])
          .transform((v) => v === 'true')
          .optional(),
      }),
      rateLimit: W,
      handler: async ({ query }) => {
        const limit = clampLimit(query.limit);
        const { rows } = await ctx.db.query(
          `SELECT id, provider, event_id, event_type, signature_valid, received_at, processed_at, error FROM payment_webhook_events WHERE ($1::boolean IS NOT TRUE OR processed_at IS NULL) ORDER BY received_at DESC LIMIT $2`,
          [query.unprocessed ?? null, limit],
        );
        return { items: rows };
      },
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/staff/fraud-signals',
      summary: 'Staff: stored fraud-rule decisions',
      tags: ['payments', 'staff'],
      auth: { staff: STAFF },
      query: pageQuery.extend({
        decision: z.enum(['allow', 'review', 'block']).optional(),
        userId: z.uuid().optional(),
      }),
      rateLimit: W,
      handler: async ({ auth, req, query }) => {
        const limit = clampLimit(query.limit);
        const { rows } = await ctx.db.query(
          `SELECT id, user_id, subject_type, subject_id, stage, decision, score, reasons, signals, created_at FROM fraud_signals
            WHERE ($1::text IS NULL OR decision = $1) AND ($2::uuid IS NULL OR user_id = $2) ORDER BY created_at DESC, id DESC LIMIT $3`,
          [query.decision ?? null, query.userId ?? null, limit],
        );
        await audit(
          ctx,
          {
            actorId: auth.userId,
            actorType: 'staff',
            action: 'fraud_signals.viewed',
            metadata: { decision: query.decision ?? null, userId: query.userId ?? null },
          },
          req,
        );
        return { items: rows };
      },
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/staff/reconciliation',
      summary: 'Staff: provider records vs ledger discrepancies, plus internal integrity checks',
      tags: ['payments', 'staff'],
      auth: { staff: STAFF },
      query: z.object({
        from: z.iso.datetime({ offset: true }).optional(),
        to: z.iso.datetime({ offset: true }).optional(),
      }),
      rateLimit: { limit: 20, windowSec: 600, by: 'user' },
      handler: async ({ auth, req, query }) => {
        const to = query.to ? new Date(query.to) : new Date();
        const from = query.from ? new Date(query.from) : new Date(to.getTime() - 7 * 86_400_000);
        if (from >= to) throw invalid('from must be before to');
        if (to.getTime() - from.getTime() > 92 * 86_400_000)
          throw invalid('The window can be at most 92 days');
        const report = await runReconciliation(ctx, { from, to });
        await audit(
          ctx,
          {
            actorId: auth.userId,
            actorType: 'staff',
            action: 'reconciliation.run',
            metadata: {
              ok: report.ok,
              discrepancies: report.discrepancies.length,
              integrity: report.integrity.length,
              provider: getPaymentProvider(ctx).name,
            },
          },
          req,
        );
        return report;
      },
    });
  },
};
