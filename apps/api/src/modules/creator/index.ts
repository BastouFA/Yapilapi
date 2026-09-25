import { z } from 'zod';
import { invalid, notFound } from '@yapilapi/shared';
import type { FastifyRequest } from 'fastify';
import { route } from '../../lib/route.js';
import { audit } from '../../lib/audit.js';
import { registerDeletionHook } from '../../lib/hooks.js';
import { isBlockedEitherWay } from '../../lib/users.js';
import { hydratePosts, postFrom, postSelect } from '../../lib/post-view.js';
import type { AppContext } from '../../lib/context.js';
import type { AuthContext } from '../../lib/auth-context.js';
import type { ApiModule } from '../types.js';
import { IDEMPOTENCY_KEY } from '../commerce/orders.js';
import {
  findAccount,
  listPayouts,
  payoutView,
  requestPayout,
  resolvePayee,
} from '../payments/payouts.js';
import { payeeBalances } from '../payments/ledger.js';
import { registerExportSection } from '../privacy/index.js';
import { createPost } from '../content/service.js';
import {
  affiliateStats,
  createLink,
  linkBody,
  linkView,
  listConversions,
  optInBody,
  recordClick,
  setLinkActive,
  setProductAffiliateOptIn,
} from './affiliate.js';
import { dashboard, revenue } from './dashboard.js';
import { runCreatorMaintenance } from './maintenance.js';
import * as partnerships from './partnerships.js';
import {
  CREATOR_TERMS_VERSION,
  becomeCreator,
  creatorView,
  decideKyc,
  kycHistory,
  loadCreator,
  requireCreator,
  submitKyc,
  switchProfileMode,
} from './profile.js';
import { affiliateAttributionNote } from './rules.js';
import {
  cancelSubscription,
  createPlan,
  listPlans,
  mySubscriptions,
  paymentMethodSchema,
  planBody,
  planPatch,
  planView,
  resumeSubscription,
  subscribe,
  subscriptionView,
  updatePaymentMethod,
  updatePlan,
} from './subscriptions.js';
import {
  createGiftType,
  giftBody,
  giftCatalogView,
  giftCreateBody,
  giftPatchBody,
  listGiftCatalog,
  sendGift,
  sendTip,
  tipBody,
  updateGiftType,
} from './tips-gifts.js';

export { hasActiveSubscription } from './entitlements.js';
export { processSubscriptionRenewals, settleCreatorPayments } from './subscriptions.js';
export { settlePartnershipPayments } from './partnerships.js';
export { attributeConversions, settleConversions, recordClick } from './affiliate.js';
export { runCreatorMaintenance } from './maintenance.js';
export { CREATOR_TERMS_VERSION, requireCreator, loadCreator } from './profile.js';
export { sponsoredMetadata } from './partnerships.js';

const idParams = z.object({ id: z.uuid() });
const staffIdParams = idParams;
const STAFF = ['admin', 'superadmin'] as const;
const W = { limit: 120, windowSec: 600, by: 'user' } as const;
const WRITE = { limit: 40, windowSec: 600, by: 'user' } as const;
const MONEY = { limit: 20, windowSec: 3600, by: 'user' } as const;
const daysQuery = z.object({ days: z.coerce.number().int().min(1).max(365).default(30) });

const requiredKey = (req: { headers: Record<string, string | string[] | undefined> }): string => {
  const raw = req.headers['idempotency-key'];
  const key = Array.isArray(raw) ? raw[0] : raw;
  if (!key || !IDEMPOTENCY_KEY.test(key))
    throw invalid(
      'An Idempotency-Key header (8-128 characters: letters, digits, . _ : -) is required',
    );
  return key;
};

const creatorPostBody = z.object({
  body: z.string().max(10_000).default(''),
  visibility: z.enum(['public', 'followers', 'subscribers']).default('subscribers'),
  minTier: z.number().int().min(1).max(10).optional(),
  mediaIds: z.array(z.uuid()).max(10).optional(),
  topics: z.array(z.string().min(1).max(50)).max(10).optional(),
  language: z.string().min(2).max(35).optional(),
  license: z.string().min(1).max(60).optional(),
  aiAssistance: z.object({ tools: z.array(z.string().min(1).max(60)).max(10) }).optional(),
  /** Sponsored content: publishing through a partnership requires the explicit disclosure confirmation. */
  partnership: z.object({ id: z.uuid(), disclosureConfirmed: z.boolean() }).optional(),
});

export const creatorModule: ApiModule = {
  name: 'creator',
  register(app, ctx: AppContext) {
    const gate = (userId?: string) => ctx.flags.require('COMMERCE', userId);
    const me = (a: { userId: string; ageBand: 'teen' | 'adult' }) => ({
      userId: a.userId,
      ageBand: a.ageBand,
    });

    // ---------------------------------------------------------------- privacy integration
    registerExportSection({
      key: 'creator_economy',
      description:
        'Creator profile and verification history, plans, subscriptions (never payment tokens), tips and gifts, affiliate links, partnerships',
      collect: async (_c, db, u) => ({
        creator:
          (
            await db.query(
              'SELECT user_id, status, kyc_status, category, terms_version, terms_accepted_at, created_at FROM creators WHERE user_id = $1',
              [u],
            )
          ).rows[0] ?? null,
        kycEvents: (
          await db.query(
            'SELECT from_status, to_status, actor_type, note, created_at FROM creator_kyc_events WHERE creator_id = $1 ORDER BY id',
            [u],
          )
        ).rows,
        plans: (
          await db.query(
            'SELECT id, name, price_cents, currency, interval, tier, active FROM subscription_plans WHERE creator_id = $1',
            [u],
          )
        ).rows,
        subscriptions: (
          await db.query(
            'SELECT id, creator_id, plan_id, status, current_period_end, cancel_at_period_end, started_at, ended_at, end_reason FROM subscriptions WHERE subscriber_id = $1 OR creator_id = $1',
            [u],
          )
        ).rows,
        tipsSent: (
          await db.query(
            'SELECT id, creator_id, amount_cents, currency, message, status, created_at FROM tips WHERE from_user_id = $1',
            [u],
          )
        ).rows,
        tipsReceived: (
          await db.query(
            'SELECT id, amount_cents, currency, message, status, created_at FROM tips WHERE creator_id = $1',
            [u],
          )
        ).rows,
        giftsSent: (
          await db.query(
            'SELECT id, creator_id, gift_id, amount_cents, currency, message, status, created_at FROM gifts WHERE from_user_id = $1',
            [u],
          )
        ).rows,
        affiliateLinks: (
          await db.query(
            'SELECT id, product_id, code, commission_bps, active, created_at FROM affiliate_links WHERE creator_id = $1',
            [u],
          )
        ).rows,
        partnerships: (
          await db.query(
            'SELECT id, business_id, status, title, amount_cents, currency, created_at FROM brand_partnerships WHERE creator_id = $1',
            [u],
          )
        ).rows,
      }),
    });
    registerDeletionHook(async (_c, tx, userId) => {
      // Money history stays (ledger, payments), but nothing keeps charging or paying a deleted account.
      await tx.query(
        `UPDATE subscriptions SET status = 'cancelled', cancel_at_period_end = false, cancelled_at = COALESCE(cancelled_at, now()), ended_at = now(), end_reason = 'account_deleted', next_retry_at = NULL, payment_method_enc = NULL
          WHERE (subscriber_id = $1 OR creator_id = $1) AND status IN ('incomplete','active','past_due')`,
        [userId],
      );
      await tx.query(
        `UPDATE creators SET status = 'closed' WHERE user_id = $1 AND status <> 'closed'`,
        [userId],
      );
      await tx.query(
        'UPDATE subscription_plans SET active = false WHERE creator_id = $1 AND active',
        [userId],
      );
      await tx.query('UPDATE affiliate_links SET active = false WHERE creator_id = $1 AND active', [
        userId,
      ]);
    });

    // ================================================================== become a creator, mode, verification
    route(app, ctx, {
      method: 'POST',
      url: '/v1/creator/join',
      summary: 'Become a creator: accept the current creator terms (adults only). Idempotent.',
      tags: ['creator'],
      auth: 'user',
      body: z.object({
        termsVersion: z.string().trim().min(1).max(40),
        category: z.string().trim().min(1).max(60).optional(),
      }),
      rateLimit: WRITE,
      handler: async ({ auth, req, reply, body }) => {
        await gate(auth.userId);
        const r = await becomeCreator(ctx, auth, body, req);
        void reply.code(r.created ? 201 : 200);
        return creatorView(r.creator, 'creator');
      },
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/creator/me',
      summary: 'My creator account: status, terms, verification, payout readiness',
      tags: ['creator'],
      auth: 'user',
      rateLimit: W,
      handler: async ({ auth }) => {
        await gate(auth.userId);
        const c = await loadCreator(ctx.db, auth.userId);
        const mode =
          (
            await ctx.db.query<{ mode: string }>('SELECT mode FROM profiles WHERE user_id = $1', [
              auth.userId,
            ])
          ).rows[0]?.mode ?? null;
        const acc = c ? await findAccount(ctx.db, { type: 'user', id: auth.userId }) : null;
        return {
          creator: c ? creatorView(c, mode) : null,
          currentTermsVersion: CREATOR_TERMS_VERSION,
          verification: c ? await kycHistory(ctx.db, auth.userId) : [],
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
      method: 'PUT',
      url: '/v1/creator/mode',
      summary:
        'Switch the profile between creator and personal presentation (the creator account, balances and subscribers are kept)',
      tags: ['creator'],
      auth: 'user',
      body: z.object({ mode: z.enum(['creator', 'personal']) }),
      rateLimit: WRITE,
      handler: async ({ auth, req, body }) => {
        await gate(auth.userId);
        return switchProfileMode(ctx, auth, body.mode, req);
      },
    });

    route(app, ctx, {
      method: 'POST',
      url: '/v1/creator/kyc',
      summary:
        'Submit identity verification (creates the payout account with the payment provider; staff/provider decide)',
      tags: ['creator'],
      auth: 'user',
      body: z.object({
        country: z
          .string()
          .trim()
          .length(2)
          .transform((s) => s.toUpperCase()),
        returnUrl: z.url().max(500).optional(),
      }),
      rateLimit: { limit: 10, windowSec: 3600, by: 'user' },
      handler: async ({ auth, req, body }) => {
        await gate(auth.userId);
        const r = await submitKyc(ctx, auth, body, req);
        return { ...creatorView(r.creator), onboardingUrl: r.onboardingUrl };
      },
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/staff/creators/kyc',
      summary: 'Staff: creators awaiting (or with) a verification decision',
      tags: ['creator', 'staff'],
      auth: { staff: STAFF },
      query: z.object({
        status: z.enum(['pending', 'verified', 'rejected', 'unverified']).default('pending'),
      }),
      rateLimit: W,
      handler: async ({ query }) => {
        const { rows } = await ctx.db.query(
          `SELECT c.user_id, c.kyc_status, c.kyc_submitted_at, c.kyc_decided_at, c.kyc_note, pr.username FROM creators c JOIN profiles pr ON pr.user_id = c.user_id
            WHERE c.kyc_status = $1 ORDER BY c.kyc_submitted_at NULLS LAST, c.created_at LIMIT 100`,
          [query.status],
        );
        return {
          items: rows.map((r) => ({
            userId: r.user_id as string,
            username: r.username as string,
            kycStatus: r.kyc_status as string,
            submittedAt: (r.kyc_submitted_at as Date | null)?.toISOString() ?? null,
            decidedAt: (r.kyc_decided_at as Date | null)?.toISOString() ?? null,
            note: r.kyc_note as string | null,
          })),
        };
      },
    });

    route(app, ctx, {
      method: 'POST',
      url: '/v1/staff/creators/:id/kyc',
      summary: 'Staff: verify or reject a submitted creator (audited, with a mandatory note)',
      tags: ['creator', 'staff'],
      auth: { staff: STAFF },
      params: staffIdParams,
      body: z.object({
        decision: z.enum(['verify', 'reject']),
        note: z.string().trim().min(3).max(500),
      }),
      rateLimit: MONEY,
      handler: async ({ auth, req, params, body }) => {
        const c = await decideKyc(ctx, auth, params.id, body.decision, body.note, req);
        return creatorView(c);
      },
    });

    // ================================================================== dashboard, revenue, payouts
    route(app, ctx, {
      method: 'GET',
      url: '/v1/creator/dashboard',
      summary:
        'Creator analytics from real data: audience growth, content performance, subscribers (k-anonymous geography)',
      tags: ['creator'],
      auth: 'user',
      query: daysQuery,
      rateLimit: W,
      handler: async ({ auth, query }) => {
        await gate(auth.userId);
        await requireCreator(ctx.db, auth.userId, { active: false });
        return dashboard(ctx.db, auth.userId, query.days);
      },
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/creator/revenue',
      summary: 'Creator revenue from the ledger: earnings by source, refunds, payouts',
      tags: ['creator'],
      auth: 'user',
      query: daysQuery,
      rateLimit: W,
      handler: async ({ auth, query }) => {
        await gate(auth.userId);
        await requireCreator(ctx.db, auth.userId, { active: false });
        return revenue(ctx.db, auth.userId, query.days);
      },
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/creator/payouts/balance',
      summary:
        'Creator payout dashboard: total, available and on-hold balance plus payout readiness',
      tags: ['creator'],
      auth: 'user',
      rateLimit: W,
      handler: async ({ auth }) => {
        await gate(auth.userId);
        await requireCreator(ctx.db, auth.userId, { active: false });
        const payee = await resolvePayee(ctx, me(auth));
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
      url: '/v1/creator/payouts',
      summary:
        'Request a payout of the available creator balance (Idempotency-Key required; identity verification required)',
      tags: ['creator'],
      auth: 'user',
      body: z.object({
        currency: z
          .string()
          .trim()
          .toUpperCase()
          .regex(/^[A-Z]{3}$/),
        amountCents: z.number().int().min(1).max(100_000_000_000).optional(),
      }),
      rateLimit: MONEY,
      handler: async ({ auth, req, reply, body }) => {
        await gate(auth.userId);
        await requireCreator(ctx.db, auth.userId, { active: false });
        const r = await requestPayout(ctx, me(auth), { ...body, key: requiredKey(req) }, req);
        void reply.code(r.replayed ? 200 : 201);
        if (r.replayed) void reply.header('idempotent-replayed', 'true');
        return payoutView(r.payout);
      },
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/creator/payouts',
      summary: 'My payouts',
      tags: ['creator'],
      auth: 'user',
      rateLimit: W,
      handler: async ({ auth }) => {
        await gate(auth.userId);
        await requireCreator(ctx.db, auth.userId, { active: false });
        return {
          items: (await listPayouts(ctx.db, await resolvePayee(ctx, me(auth)))).map(payoutView),
        };
      },
    });

    // ================================================================== plans and subscriptions
    route(app, ctx, {
      method: 'GET',
      url: '/v1/creators/:id/plans',
      summary: "A creator's active subscription plans",
      tags: ['creator'],
      auth: 'optional',
      params: idParams,
      rateLimit: W,
      handler: async ({ auth, params }) => {
        await gate(auth?.userId);
        const c = await loadCreator(ctx.db, params.id);
        if (!c || c.status !== 'active' || !c.terms_accepted_at) throw notFound('Creator');
        if (
          auth &&
          auth.userId !== params.id &&
          (await isBlockedEitherWay(ctx.db, auth.userId, params.id))
        )
          throw notFound('Creator');
        return { items: (await listPlans(ctx.db, params.id, false)).map(planView) };
      },
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/creator/plans',
      summary: 'My plans including inactive ones',
      tags: ['creator'],
      auth: 'user',
      rateLimit: W,
      handler: async ({ auth }) => {
        await gate(auth.userId);
        await requireCreator(ctx.db, auth.userId, { active: false });
        return { items: (await listPlans(ctx.db, auth.userId, true)).map(planView) };
      },
    });

    route(app, ctx, {
      method: 'POST',
      url: '/v1/creator/plans',
      summary: 'Create a subscription plan (tier, price, interval, benefits)',
      tags: ['creator'],
      auth: 'user',
      body: planBody,
      rateLimit: WRITE,
      handler: async ({ auth, req, reply, body }) => {
        await gate(auth.userId);
        const p = await createPlan(ctx, auth.userId, body, req);
        void reply.code(201);
        return planView(p);
      },
    });

    route(app, ctx, {
      method: 'PATCH',
      url: '/v1/creator/plans/:id',
      summary:
        "Edit a plan's name, description, benefits or availability (price and tier are immutable: create a new plan)",
      tags: ['creator'],
      auth: 'user',
      params: idParams,
      body: planPatch,
      rateLimit: WRITE,
      handler: async ({ auth, req, params, body }) => {
        await gate(auth.userId);
        await requireCreator(ctx.db, auth.userId);
        return planView(await updatePlan(ctx, auth.userId, params.id, body, req));
      },
    });

    route(app, ctx, {
      method: 'POST',
      url: '/v1/creators/:id/subscribe',
      summary:
        'Subscribe to a creator plan. Idempotency-Key required; active once the signed payment webhook confirms the capture.',
      tags: ['creator'],
      auth: 'user',
      params: idParams,
      body: z.object({
        planId: z.uuid(),
        paymentMethod: paymentMethodSchema,
        returnUrl: z.url().max(500).optional(),
      }),
      rateLimit: MONEY,
      handler: async ({ auth, req, reply, params, body }) => {
        await gate(auth.userId);
        const r = await subscribe(ctx, auth, params.id, body, requiredKey(req), req.clientIp, req);
        void reply.code(r.replayed ? 200 : 201);
        if (r.replayed) void reply.header('idempotent-replayed', 'true');
        return {
          subscription: subscriptionView(r.subscription),
          payment: r.payment,
          nextAction: r.nextAction,
        };
      },
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/me/subscriptions',
      summary: 'My subscriptions',
      tags: ['creator'],
      auth: 'user',
      rateLimit: W,
      handler: async ({ auth }) => {
        await gate(auth.userId);
        return { items: (await mySubscriptions(ctx.db, auth.userId)).map(subscriptionView) };
      },
    });

    route(app, ctx, {
      method: 'POST',
      url: '/v1/subscriptions/:id/cancel',
      summary: 'Cancel my subscription: at the end of the paid period by default, or immediately',
      tags: ['creator'],
      auth: 'user',
      params: idParams,
      body: z.object({ immediately: z.boolean().default(false) }),
      rateLimit: WRITE,
      handler: async ({ auth, req, params, body }) => {
        await gate(auth.userId);
        return subscriptionView(
          await cancelSubscription(ctx, auth, params.id, { immediately: body.immediately }, req),
        );
      },
    });

    route(app, ctx, {
      method: 'POST',
      url: '/v1/subscriptions/:id/resume',
      summary: 'Undo cancel-at-period-end',
      tags: ['creator'],
      auth: 'user',
      params: idParams,
      rateLimit: WRITE,
      handler: async ({ auth, req, params }) => {
        await gate(auth.userId);
        return subscriptionView(await resumeSubscription(ctx, auth.userId, params.id, req));
      },
    });

    route(app, ctx, {
      method: 'PUT',
      url: '/v1/subscriptions/:id/payment-method',
      summary: 'Replace the payment method used for renewals (token only; never returned)',
      tags: ['creator'],
      auth: 'user',
      params: idParams,
      body: z.object({ paymentMethod: paymentMethodSchema }),
      rateLimit: WRITE,
      handler: async ({ auth, req, params, body }) => {
        await gate(auth.userId);
        return subscriptionView(
          await updatePaymentMethod(ctx, auth.userId, params.id, body.paymentMethod, req),
        );
      },
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/creator/subscribers',
      summary: 'My subscribers (no payment details)',
      tags: ['creator'],
      auth: 'user',
      query: z.object({
        status: z.enum(['active', 'past_due', 'cancelled', 'expired']).optional(),
      }),
      rateLimit: W,
      handler: async ({ auth, query }) => {
        await gate(auth.userId);
        await requireCreator(ctx.db, auth.userId, { active: false });
        const { rows } = await ctx.db.query(
          `SELECT s.id, s.subscriber_id, pr.username, sp.tier, sp.name AS plan_name, s.status, s.current_period_end, s.cancel_at_period_end, s.started_at
             FROM subscriptions s JOIN subscription_plans sp ON sp.id = s.plan_id JOIN profiles pr ON pr.user_id = s.subscriber_id
            WHERE s.creator_id = $1 AND s.status <> 'incomplete' AND ($2::text IS NULL OR s.status = $2) ORDER BY s.created_at DESC, s.id LIMIT 200`,
          [auth.userId, query.status ?? null],
        );
        return {
          items: rows.map((r) => ({
            id: r.id as string,
            subscriberId: r.subscriber_id as string,
            username: r.username as string,
            tier: r.tier as number,
            plan: r.plan_name as string,
            status: r.status as string,
            currentPeriodEnd: (r.current_period_end as Date).toISOString(),
            cancelAtPeriodEnd: r.cancel_at_period_end as boolean,
            startedAt: (r.started_at as Date | null)?.toISOString() ?? null,
          })),
        };
      },
    });

    route(app, ctx, {
      method: 'POST',
      url: '/v1/creator/subscribers/:id/cancel',
      summary:
        'Remove a subscriber (ends the subscription now; refunds go through the payment refund tools)',
      tags: ['creator'],
      auth: 'user',
      params: idParams,
      rateLimit: WRITE,
      handler: async ({ auth, req, params }) => {
        await gate(auth.userId);
        await requireCreator(ctx.db, auth.userId, { active: false });
        return subscriptionView(
          await cancelSubscription(ctx, auth, params.id, { asCreator: true }, req),
        );
      },
    });

    // ---------------------------------------------------------------- creator posts (subscriber-only tiers, sponsored disclosure)
    route(app, ctx, {
      method: 'POST',
      url: '/v1/creator/posts',
      summary:
        'Publish a creator post: subscribers-only (optionally from a minimum tier) or public/followers; sponsored posts need the partnership id AND a disclosure confirmation',
      tags: ['creator'],
      auth: 'user',
      body: creatorPostBody,
      rateLimit: { limit: 30, windowSec: 3600, by: 'user' },
      handler: async ({ auth, req, reply, body }) => {
        await gate(auth.userId);
        await requireCreator(ctx.db, auth.userId);
        if (body.minTier !== undefined && body.visibility !== 'subscribers')
          throw invalid('minTier is only valid with subscribers visibility');
        const metadata = body.partnership
          ? await partnerships.sponsoredMetadata(
              ctx.db,
              auth.userId,
              body.partnership.id,
              body.partnership.disclosureConfirmed,
            )
          : undefined;
        const { partnership: _p, ...rest } = body;
        const id = await createPost(ctx, me(auth), { ...rest, metadata });
        await audit(
          ctx,
          {
            actorId: auth.userId,
            action: 'creator.post_created',
            targetType: 'post',
            targetId: id,
            metadata: {
              visibility: body.visibility,
              minTier: body.minTier ?? null,
              sponsored: Boolean(body.partnership),
            },
          },
          req,
        );
        const { rows } = await ctx.db.query(
          `SELECT ${postSelect('$1::uuid')} FROM ${postFrom} WHERE p.id = $2`,
          [auth.userId, id],
        );
        void reply.code(201);
        return (await hydratePosts(ctx, auth.userId, rows))[0];
      },
    });

    // ================================================================== tips and gifts
    route(app, ctx, {
      method: 'POST',
      url: '/v1/creators/:id/tips',
      summary: 'Tip a creator (Idempotency-Key required)',
      tags: ['creator'],
      auth: 'user',
      params: idParams,
      body: tipBody,
      rateLimit: MONEY,
      handler: async ({ auth, req, reply, params, body }) => {
        await gate(auth.userId);
        const r = await sendTip(ctx, auth, params.id, body, requiredKey(req), req.clientIp, req);
        void reply.code(r.replayed ? 200 : 201);
        if (r.replayed) void reply.header('idempotent-replayed', 'true');
        return r;
      },
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/gifts/catalog',
      summary: 'Gift catalog (staff-managed)',
      tags: ['creator'],
      auth: 'user',
      rateLimit: W,
      handler: async ({ auth }) => {
        await gate(auth.userId);
        return { items: (await listGiftCatalog(ctx.db, false)).map(giftCatalogView) };
      },
    });

    route(app, ctx, {
      method: 'POST',
      url: '/v1/creators/:id/gifts',
      summary:
        'Send a gift to a creator, optionally during a live session (Idempotency-Key required)',
      tags: ['creator'],
      auth: 'user',
      params: idParams,
      body: giftBody,
      rateLimit: MONEY,
      handler: async ({ auth, req, reply, params, body }) => {
        await gate(auth.userId);
        const r = await sendGift(ctx, auth, params.id, body, requiredKey(req), req.clientIp, req);
        void reply.code(r.replayed ? 200 : 201);
        if (r.replayed) void reply.header('idempotent-replayed', 'true');
        return r;
      },
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/creator/supporters',
      summary: 'Tips and gifts I received (settled only)',
      tags: ['creator'],
      auth: 'user',
      rateLimit: W,
      handler: async ({ auth }) => {
        await gate(auth.userId);
        await requireCreator(ctx.db, auth.userId, { active: false });
        const [tips, gifts] = await Promise.all([
          ctx.db.query(
            `SELECT t.id, t.from_user_id, pr.username, t.amount_cents, t.currency, t.message, t.created_at FROM tips t JOIN profiles pr ON pr.user_id = t.from_user_id WHERE t.creator_id = $1 AND t.status = 'completed' ORDER BY t.created_at DESC, t.id LIMIT 100`,
            [auth.userId],
          ),
          ctx.db.query(
            `SELECT g.id, g.from_user_id, pr.username, gc.code, gc.name, g.amount_cents, g.currency, g.message, g.live_session_id, g.created_at FROM gifts g JOIN gift_catalog gc ON gc.id = g.gift_id JOIN profiles pr ON pr.user_id = g.from_user_id WHERE g.creator_id = $1 AND g.status = 'completed' ORDER BY g.created_at DESC, g.id LIMIT 100`,
            [auth.userId],
          ),
        ]);
        return {
          tips: tips.rows.map((r) => ({
            id: r.id as string,
            from: { userId: r.from_user_id as string, username: r.username as string },
            amountCents: Number(r.amount_cents),
            currency: r.currency as string,
            message: r.message as string,
            createdAt: (r.created_at as Date).toISOString(),
          })),
          gifts: gifts.rows.map((r) => ({
            id: r.id as string,
            from: { userId: r.from_user_id as string, username: r.username as string },
            code: r.code as string,
            name: r.name as string,
            amountCents: Number(r.amount_cents),
            currency: r.currency as string,
            message: r.message as string,
            liveSessionId: r.live_session_id as string | null,
            createdAt: (r.created_at as Date).toISOString(),
          })),
        };
      },
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/staff/gifts',
      summary: 'Staff: full gift catalog including inactive gifts',
      tags: ['creator', 'staff'],
      auth: { staff: STAFF },
      rateLimit: W,
      handler: async () => ({ items: (await listGiftCatalog(ctx.db, true)).map(giftCatalogView) }),
    });
    route(app, ctx, {
      method: 'POST',
      url: '/v1/staff/gifts',
      summary: 'Staff: add a gift to the catalog',
      tags: ['creator', 'staff'],
      auth: { staff: STAFF },
      body: giftCreateBody,
      rateLimit: WRITE,
      handler: async ({ auth, req, reply, body }) => {
        const g = await createGiftType(ctx, auth.userId, body, req);
        void reply.code(201);
        return giftCatalogView(g);
      },
    });
    route(app, ctx, {
      method: 'PATCH',
      url: '/v1/staff/gifts/:id',
      summary: 'Staff: change a gift (price changes apply to future purchases only)',
      tags: ['creator', 'staff'],
      auth: { staff: STAFF },
      params: idParams,
      body: giftPatchBody,
      rateLimit: WRITE,
      handler: async ({ auth, req, params, body }) =>
        giftCatalogView(await updateGiftType(ctx, auth.userId, params.id, body, req)),
    });

    // ================================================================== affiliate
    route(app, ctx, {
      method: 'PUT',
      url: '/v1/products/:id/affiliate',
      summary: 'Seller: offer affiliate commission (basis points, 0 = off) on a product I sell',
      tags: ['creator'],
      auth: 'user',
      params: idParams,
      body: optInBody,
      rateLimit: WRITE,
      handler: async ({ auth, req, params, body }) => {
        await gate(auth.userId);
        return setProductAffiliateOptIn(ctx, auth.userId, params.id, body.maxBps, req);
      },
    });

    route(app, ctx, {
      method: 'POST',
      url: '/v1/creator/affiliate/links',
      summary: 'Create an affiliate link for a product that offers commission',
      tags: ['creator'],
      auth: 'user',
      body: linkBody,
      rateLimit: WRITE,
      handler: async ({ auth, req, reply, body }) => {
        await gate(auth.userId);
        const l = await createLink(ctx, auth.userId, body, req);
        void reply.code(201);
        return linkView(l);
      },
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/creator/affiliate/links',
      summary:
        'My affiliate links with click and conversion statistics (bot/duplicate clicks reported separately)',
      tags: ['creator'],
      auth: 'user',
      rateLimit: W,
      handler: async ({ auth }) => {
        await gate(auth.userId);
        await requireCreator(ctx.db, auth.userId, { active: false });
        return {
          items: await affiliateStats(ctx.db, auth.userId),
          attribution: affiliateAttributionNote,
        };
      },
    });

    route(app, ctx, {
      method: 'PATCH',
      url: '/v1/creator/affiliate/links/:id',
      summary: 'Enable or disable one of my links',
      tags: ['creator'],
      auth: 'user',
      params: idParams,
      body: z.object({ active: z.boolean() }),
      rateLimit: WRITE,
      handler: async ({ auth, req, params, body }) => {
        await gate(auth.userId);
        return linkView(await setLinkActive(ctx, auth.userId, params.id, body.active, req));
      },
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/creator/affiliate/conversions',
      summary:
        'Orders attributed to my links (read from paid orders; commission settles after the hold period)',
      tags: ['creator'],
      auth: 'user',
      rateLimit: W,
      handler: async ({ auth }) => {
        await gate(auth.userId);
        await requireCreator(ctx.db, auth.userId, { active: false });
        return { items: await listConversions(ctx.db, auth.userId) };
      },
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/affiliate/r/:code',
      summary:
        'Resolve an affiliate link: records ONE counted click per visitor per day (bots and floods are recorded but not counted) and returns the product to open',
      tags: ['creator'],
      auth: 'optional',
      params: z.object({
        code: z
          .string()
          .trim()
          .min(4)
          .max(40)
          .regex(/^[a-z0-9]+$/i),
      }),
      rateLimit: { limit: 120, windowSec: 60, by: 'ip' },
      handler: async ({ auth, req, params }) => {
        await gate(auth?.userId);
        const r = await recordClick(ctx, params.code, {
          ip: req.clientIp,
          userAgent: req.headers['user-agent'],
          viewerId: auth?.userId ?? null,
        });
        return { productId: r.productId, counted: r.counted };
      },
    });

    // ================================================================== brand partnerships
    route(app, ctx, {
      method: 'POST',
      url: '/v1/creator/partnerships',
      summary: 'Creator proposes a partnership to a business',
      tags: ['creator'],
      auth: 'user',
      body: partnerships.proposeByCreatorBody,
      rateLimit: WRITE,
      handler: async ({ auth, req, reply, body }) => {
        await gate(auth.userId);
        const p = await partnerships.propose(ctx, auth, 'creator', body, req);
        void reply.code(201);
        return partnerships.getForUser(ctx, p.id, auth.userId);
      },
    });

    route(app, ctx, {
      method: 'POST',
      url: '/v1/businesses/:id/partnerships',
      summary: 'Business proposes a partnership to a creator (team.manage)',
      tags: ['creator'],
      auth: 'user',
      params: idParams,
      body: partnerships.proposeByBusinessBody,
      rateLimit: WRITE,
      handler: async ({ auth, req, reply, params, body }) => {
        await gate(auth.userId);
        const p = await partnerships.propose(
          ctx,
          auth,
          'business',
          { ...body, businessId: params.id },
          req,
        );
        void reply.code(201);
        return partnerships.getForUser(ctx, p.id, auth.userId);
      },
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/creator/partnerships',
      summary: 'My partnerships as a creator',
      tags: ['creator'],
      auth: 'user',
      rateLimit: W,
      handler: async ({ auth }) => {
        await gate(auth.userId);
        const rows = await partnerships.listForCreator(ctx.db, auth.userId);
        return {
          items: await Promise.all(
            rows.map((p) => partnerships.partnershipView(ctx.db, p, 'creator')),
          ),
        };
      },
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/businesses/:id/partnerships',
      summary: "A business's partnerships (team.manage)",
      tags: ['creator'],
      auth: 'user',
      params: idParams,
      rateLimit: W,
      handler: async ({ auth, params }) => {
        await gate(auth.userId);
        const rows = await partnerships.listForBusiness(ctx, params.id, auth.userId);
        return {
          items: await Promise.all(
            rows.map((p) => partnerships.partnershipView(ctx.db, p, 'business')),
          ),
        };
      },
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/partnerships/:id',
      summary: 'A partnership (only its two sides can see it)',
      tags: ['creator'],
      auth: 'user',
      params: idParams,
      rateLimit: W,
      handler: async ({ auth, params }) => {
        await gate(auth.userId);
        return partnerships.getForUser(ctx, params.id, auth.userId);
      },
    });

    const act = (
      name: string,
      summary: string,
      run: (a: {
        auth: AuthContext;
        req: FastifyRequest;
        id: string;
        body: { note?: string | undefined; expectedVersion?: number | undefined };
      }) => Promise<unknown>,
    ) =>
      route(app, ctx, {
        method: 'POST',
        url: `/v1/partnerships/:id/${name}`,
        summary,
        tags: ['creator'],
        auth: 'user',
        params: idParams,
        body: z.object({
          note: z.string().trim().max(500).optional(),
          expectedVersion: z.number().int().min(1).optional(),
        }),
        rateLimit: WRITE,
        handler: async ({ auth, req, params, body }) => {
          await gate(auth.userId);
          await run({ auth, req, id: params.id, body });
          return partnerships.getForUser(ctx, params.id, auth.userId);
        },
      });
    act(
      'accept',
      'Accept the current terms (only the side that did not write them)',
      ({ auth, req, id, body }) => partnerships.accept(ctx, auth, id, body.expectedVersion, req),
    );
    act('decline', 'Decline a proposal', ({ auth, req, id, body }) =>
      partnerships.decline(ctx, auth, id, body.note, req),
    );
    act(
      'start',
      'Creator starts the work once both sides accepted the same terms',
      ({ auth, req, id }) => partnerships.start(ctx, auth, id, req),
    );
    act('cancel', 'Cancel before any payment started', ({ auth, req, id, body }) =>
      partnerships.cancel(ctx, auth, id, body.note, req),
    );

    route(app, ctx, {
      method: 'POST',
      url: '/v1/partnerships/:id/counter',
      summary: 'Counter-propose changed terms (resets both acceptances)',
      tags: ['creator'],
      auth: 'user',
      params: idParams,
      body: partnerships.counterBody,
      rateLimit: WRITE,
      handler: async ({ auth, req, params, body }) => {
        await gate(auth.userId);
        await partnerships.counter(ctx, auth, params.id, body, req);
        return partnerships.getForUser(ctx, params.id, auth.userId);
      },
    });

    route(app, ctx, {
      method: 'POST',
      url: '/v1/partnerships/:id/deliverables/:deliverableId/submit',
      summary: 'Creator submits a deliverable: a sponsored post published through this partnership',
      tags: ['creator'],
      auth: 'user',
      params: z.object({ id: z.uuid(), deliverableId: z.uuid() }),
      body: partnerships.submitBody,
      rateLimit: WRITE,
      handler: async ({ auth, req, params, body }) => {
        await gate(auth.userId);
        await partnerships.submitDeliverable(
          ctx,
          auth,
          params.id,
          params.deliverableId,
          body.postId,
          req,
        );
        return partnerships.getForUser(ctx, params.id, auth.userId);
      },
    });

    route(app, ctx, {
      method: 'POST',
      url: '/v1/partnerships/:id/deliverables/:deliverableId/review',
      summary:
        'Business approves or rejects a deliverable; all approved makes the partnership payable',
      tags: ['creator'],
      auth: 'user',
      params: z.object({ id: z.uuid(), deliverableId: z.uuid() }),
      body: partnerships.reviewBody,
      rateLimit: WRITE,
      handler: async ({ auth, req, params, body }) => {
        await gate(auth.userId);
        await partnerships.reviewDeliverable(ctx, auth, params.id, params.deliverableId, body, req);
        return partnerships.getForUser(ctx, params.id, auth.userId);
      },
    });

    route(app, ctx, {
      method: 'POST',
      url: '/v1/partnerships/:id/pay',
      summary:
        'Business owner pays the creator once every deliverable is approved (Idempotency-Key required)',
      tags: ['creator'],
      auth: 'user',
      params: idParams,
      body: partnerships.payBody,
      rateLimit: MONEY,
      handler: async ({ auth, req, reply, params, body }) => {
        await gate(auth.userId);
        const r = await partnerships.payPartnership(
          ctx,
          auth,
          params.id,
          body,
          requiredKey(req),
          req.clientIp,
          req,
        );
        void reply.code(r.replayed ? 200 : 201);
        if (r.replayed) void reply.header('idempotent-replayed', 'true');
        return {
          partnership: await partnerships.getForUser(ctx, params.id, auth.userId),
          payment: r.payment,
          nextAction: r.nextAction,
        };
      },
    });

    // ================================================================== staff: run the periodic work now
    route(app, ctx, {
      method: 'POST',
      url: '/v1/staff/creator/maintenance',
      summary:
        'Staff: run one creator-economy maintenance pass now (renewals, settlement, attribution). Also scheduled via scripts/creator-maintenance.ts.',
      tags: ['creator', 'staff'],
      auth: { staff: STAFF },
      rateLimit: { limit: 6, windowSec: 60, by: 'user' },
      handler: async ({ auth, req }) => {
        const r = await runCreatorMaintenance(ctx);
        await audit(
          ctx,
          {
            actorId: auth.userId,
            actorType: 'staff',
            action: 'creator.maintenance_run',
            targetType: 'system',
            targetId: auth.userId,
            metadata: { renewals: r.renewals, settle: r.settle },
          },
          req,
        );
        return r;
      },
    });
  },
};
