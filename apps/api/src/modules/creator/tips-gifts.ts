import { z } from 'zod';
import type { FastifyRequest } from 'fastify';
import type { Queryable } from '@yapilapi/database';
import { classifyText } from '@yapilapi/moderation';
import { AppError, conflict, invalid, notFound } from '@yapilapi/shared';
import type { AppContext } from '../../lib/context.js';
import type { AuthContext } from '../../lib/auth-context.js';
import { audit } from '../../lib/audit.js';
import { loadVisiblePost } from '../../lib/visibility.js';
import { requestHash } from '../commerce/orders.js';
import { MAX_CHARGE_CENTS, MIN_CHARGE_CENTS, chargeToCreator, paymentSummary } from './charge.js';
import { paymentMethodSchema, settleSimple } from './subscriptions.js';

const currencySchema = z
  .string()
  .trim()
  .length(3)
  .transform((s) => s.toUpperCase());

// ------------------------------------------------------------------ tips
export const tipBody = z.object({
  amountCents: z.number().int().min(MIN_CHARGE_CENTS).max(MAX_CHARGE_CENTS),
  currency: currencySchema,
  message: z.string().trim().max(500).default(''),
  postId: z.uuid().optional(),
  paymentMethod: paymentMethodSchema,
  returnUrl: z.url().max(500).optional(),
});

/** Free text that goes to another person must pass the same screening as any message: risky text is refused, not silently stored. */
export function assertCleanText(text: string, what: string): void {
  if (!text) return;
  const c = classifyText(text);
  if (c.status !== 'approved')
    throw new AppError('unprocessable', `That ${what} cannot be sent`, {
      reason: 'text_not_allowed',
    });
}

export async function sendTip(
  ctx: AppContext,
  auth: AuthContext,
  creatorId: string,
  b: z.infer<typeof tipBody>,
  key: string,
  clientIp: string,
  req?: FastifyRequest,
) {
  assertCleanText(b.message, 'message');
  if (b.postId) {
    const post = await loadVisiblePost<{ author_id: string }>(ctx.db, auth.userId, b.postId);
    if (!post || post.author_id !== creatorId) throw notFound('Post');
  }
  let tipId = '';
  const out = await chargeToCreator(ctx, {
    payer: { userId: auth.userId, ageBand: auth.ageBand },
    creatorId,
    purpose: 'tip',
    amount: b.amountCents,
    currency: b.currency,
    idem: `tip:${creatorId}:${key}`,
    hash: requestHash({ creatorId, ...b, paymentMethod: undefined, pm: b.paymentMethod }),
    paymentMethod: b.paymentMethod,
    returnUrl: b.returnUrl,
    metadata: { creatorId },
    description: 'Tip',
    clientIp,
    req,
    onCreated: async (tx, payment) => {
      const ins = await tx.query<{ id: string }>(
        `INSERT INTO tips (from_user_id, creator_id, amount_cents, currency, message, post_id, payment_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [
          auth.userId,
          creatorId,
          b.amountCents,
          b.currency,
          b.message,
          b.postId ?? null,
          payment.id,
        ],
      );
      tipId = ins.rows[0]!.id;
    },
  });
  await settleSimple(ctx, 'tips', out.payment.id);
  const tip = (
    await ctx.db.query<{ id: string; status: string }>(
      'SELECT id, status FROM tips WHERE payment_id = $1',
      [out.payment.id],
    )
  ).rows[0]!;
  if (tip.status === 'failed')
    throw new AppError('payment_failed', 'The payment was declined', {
      reason: out.payment.failure_code ?? 'payment_failed',
      paymentId: out.payment.id,
    });
  return {
    tip: {
      id: tip.id || tipId,
      status: tip.status,
      amountCents: b.amountCents,
      currency: b.currency,
    },
    payment: paymentSummary(out.payment),
    replayed: out.replayed,
    nextAction: out.nextAction,
  };
}

// ------------------------------------------------------------------ gift catalog (staff) and gifts
export const giftCreateBody = z.object({
  code: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9_]{2,40}$/),
  name: z.string().trim().min(1).max(60),
  description: z.string().trim().max(200).default(''),
  priceCents: z.number().int().min(MIN_CHARGE_CENTS).max(100_000),
  currency: currencySchema,
  sortOrder: z.number().int().min(0).max(10_000).default(0),
});
export const giftPatchBody = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  description: z.string().trim().max(200).optional(),
  priceCents: z.number().int().min(MIN_CHARGE_CENTS).max(100_000).optional(),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
  active: z.boolean().optional(),
});

interface GiftCatalogRow {
  id: string;
  code: string;
  name: string;
  description: string;
  price_cents: number;
  currency: string;
  active: boolean;
  sort_order: number;
}
const GC = 'id, code, name, description, price_cents, currency, active, sort_order';
export const giftCatalogView = (g: GiftCatalogRow) => ({
  id: g.id,
  code: g.code,
  name: g.name,
  description: g.description,
  priceCents: g.price_cents,
  currency: g.currency,
  active: g.active,
  sortOrder: g.sort_order,
});

export async function listGiftCatalog(
  db: Queryable,
  includeInactive: boolean,
): Promise<GiftCatalogRow[]> {
  return (
    await db.query<GiftCatalogRow>(
      `SELECT ${GC} FROM gift_catalog WHERE ($1::boolean OR active) ORDER BY sort_order, price_cents, code`,
      [includeInactive],
    )
  ).rows;
}

export async function createGiftType(
  ctx: AppContext,
  staffId: string,
  b: z.infer<typeof giftCreateBody>,
  req?: FastifyRequest,
): Promise<GiftCatalogRow> {
  const { rows } = await ctx.db.query<GiftCatalogRow>(
    `INSERT INTO gift_catalog (code, name, description, price_cents, currency, sort_order, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (code) DO NOTHING RETURNING ${GC}`,
    [b.code, b.name, b.description, b.priceCents, b.currency, b.sortOrder, staffId],
  );
  if (!rows[0]) throw conflict('A gift with that code already exists', { reason: 'code_taken' });
  await audit(
    ctx,
    {
      actorId: staffId,
      actorType: 'staff',
      action: 'gift_catalog.created',
      targetType: 'gift_catalog',
      targetId: rows[0].id,
      metadata: { code: b.code, priceCents: b.priceCents, currency: b.currency },
    },
    req,
  );
  return rows[0];
}

export async function updateGiftType(
  ctx: AppContext,
  staffId: string,
  id: string,
  b: z.infer<typeof giftPatchBody>,
  req?: FastifyRequest,
): Promise<GiftCatalogRow> {
  const cur = (
    await ctx.db.query<GiftCatalogRow>(`SELECT ${GC} FROM gift_catalog WHERE id = $1`, [id])
  ).rows[0];
  if (!cur) throw notFound('Gift');
  const { rows } = await ctx.db.query<GiftCatalogRow>(
    `UPDATE gift_catalog SET name = COALESCE($2, name), description = COALESCE($3, description), price_cents = COALESCE($4, price_cents), sort_order = COALESCE($5, sort_order), active = COALESCE($6, active)
      WHERE id = $1 RETURNING ${GC}`,
    [
      id,
      b.name ?? null,
      b.description ?? null,
      b.priceCents ?? null,
      b.sortOrder ?? null,
      b.active ?? null,
    ],
  );
  // Past gifts keep the price they were bought at (gifts.amount_cents); only future purchases see the new price.
  await audit(
    ctx,
    {
      actorId: staffId,
      actorType: 'staff',
      action: 'gift_catalog.updated',
      targetType: 'gift_catalog',
      targetId: id,
      metadata: { before: { priceCents: cur.price_cents, active: cur.active }, changes: b },
    },
    req,
  );
  return rows[0]!;
}

export const giftBody = z.object({
  giftCode: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9_]{2,40}$/),
  liveSessionId: z.uuid().optional(),
  message: z.string().trim().max(200).default(''),
  paymentMethod: paymentMethodSchema,
  returnUrl: z.url().max(500).optional(),
});

/** Live sessions validate who may gift whom (session live, recipient host/co-host, sender allowed in): the live module owns those rules. */
async function assertLiveGiftable(
  ctx: AppContext,
  viewerId: string,
  liveId: string,
  recipientId: string,
): Promise<void> {
  const m = (await import('../live/access.js')) as {
    assertLiveGiftable?: (
      ctx: AppContext,
      viewerId: string,
      liveId: string,
      recipientId: string,
    ) => Promise<void>;
  };
  if (typeof m.assertLiveGiftable !== 'function')
    throw new AppError('conflict', 'Live gifts are not available', { reason: 'live_unavailable' });
  await m.assertLiveGiftable(ctx, viewerId, liveId, recipientId);
}

export async function sendGift(
  ctx: AppContext,
  auth: AuthContext,
  creatorId: string,
  b: z.infer<typeof giftBody>,
  key: string,
  clientIp: string,
  req?: FastifyRequest,
) {
  assertCleanText(b.message, 'message');
  const g = (
    await ctx.db.query<GiftCatalogRow>(
      `SELECT ${GC} FROM gift_catalog WHERE code = $1 AND active`,
      [b.giftCode],
    )
  ).rows[0];
  if (!g) throw notFound('Gift');
  if (b.liveSessionId) await assertLiveGiftable(ctx, auth.userId, b.liveSessionId, creatorId);
  let giftId = '';
  const out = await chargeToCreator(ctx, {
    payer: { userId: auth.userId, ageBand: auth.ageBand },
    creatorId,
    purpose: 'gift',
    amount: g.price_cents,
    currency: g.currency,
    idem: `gift:${creatorId}:${key}`,
    hash: requestHash({
      creatorId,
      giftCode: g.code,
      liveSessionId: b.liveSessionId ?? null,
      message: b.message,
      pm: b.paymentMethod,
    }),
    paymentMethod: b.paymentMethod,
    returnUrl: b.returnUrl,
    metadata: { creatorId, giftCode: g.code },
    description: `Gift: ${g.name}`,
    clientIp,
    req,
    onCreated: async (tx, payment) => {
      const ins = await tx.query<{ id: string }>(
        `INSERT INTO gifts (from_user_id, creator_id, gift_id, live_session_id, payment_id, amount_cents, currency, message) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [
          auth.userId,
          creatorId,
          g.id,
          b.liveSessionId ?? null,
          payment.id,
          g.price_cents,
          g.currency,
          b.message,
        ],
      );
      giftId = ins.rows[0]!.id;
    },
  });
  await settleSimple(ctx, 'gifts', out.payment.id);
  const row = (
    await ctx.db.query<{ id: string; status: string }>(
      'SELECT id, status FROM gifts WHERE payment_id = $1',
      [out.payment.id],
    )
  ).rows[0]!;
  if (row.status === 'failed')
    throw new AppError('payment_failed', 'The payment was declined', {
      reason: out.payment.failure_code ?? 'payment_failed',
      paymentId: out.payment.id,
    });
  return {
    gift: {
      id: row.id || giftId,
      status: row.status,
      code: g.code,
      name: g.name,
      amountCents: g.price_cents,
      currency: g.currency,
      liveSessionId: b.liveSessionId ?? null,
    },
    payment: paymentSummary(out.payment),
    replayed: out.replayed,
    nextAction: out.nextAction,
  };
}

export { invalid };
