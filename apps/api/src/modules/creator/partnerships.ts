import { z } from 'zod';
import type { FastifyRequest } from 'fastify';
import { withTransaction, type Queryable, type Tx } from '@yapilapi/database';
import { AppError, conflict, forbidden, invalid, notFound } from '@yapilapi/shared';
import type { AppContext } from '../../lib/context.js';
import type { AuthContext } from '../../lib/auth-context.js';
import { audit } from '../../lib/audit.js';
import { notify } from '../../lib/notify.js';
import { getBusinessAccess } from '../business/access.js';
import { teamWith } from '../business/service.js';
import { requestHash } from '../commerce/orders.js';
import { MAX_CHARGE_CENTS, MIN_CHARGE_CENTS, chargeToCreator, paymentSummary } from './charge.js';
import { requireCreator } from './profile.js';
import { nextPartnershipStatus, type PartnershipAction, type PartnershipStatus } from './rules.js';
import { paymentMethodSchema } from './subscriptions.js';

export const SPONSORED_LABEL = 'Paid partnership';
const currencySchema = z
  .string()
  .trim()
  .length(3)
  .transform((s) => s.toUpperCase());

const deliverableInput = z.object({
  title: z.string().trim().min(1).max(200),
  kind: z.enum(['post', 'video', 'story', 'live', 'other']).default('post'),
  dueAt: z.iso.datetime({ offset: true }).optional(),
});
const termsFields = {
  title: z.string().trim().min(1).max(160),
  brief: z.string().trim().max(4000).default(''),
  amountCents: z.number().int().min(MIN_CHARGE_CENTS).max(MAX_CHARGE_CENTS),
  currency: currencySchema,
  deliverables: z.array(deliverableInput).min(1).max(10),
};
export const proposeByBusinessBody = z.object({ creatorId: z.uuid(), ...termsFields });
export const proposeByCreatorBody = z.object({ businessId: z.uuid(), ...termsFields });
export const counterBody = z
  .object({
    title: termsFields.title.optional(),
    brief: termsFields.brief.optional(),
    amountCents: termsFields.amountCents.optional(),
    currency: currencySchema.optional(),
    deliverables: termsFields.deliverables.optional(),
    note: z.string().trim().max(500).optional(),
  })
  .refine(
    (b) =>
      Object.keys(b).some((k) => k !== 'note' && (b as Record<string, unknown>)[k] !== undefined),
    'Change at least one term',
  );
export const noteBody = z.object({ note: z.string().trim().max(500).optional() });
export const reviewBody = z
  .object({ decision: z.enum(['approve', 'reject']), note: z.string().trim().max(500).optional() })
  .refine((b) => b.decision === 'approve' || Boolean(b.note), 'Say what needs to change');
export const submitBody = z.object({ postId: z.uuid() });
export const payBody = z.object({
  paymentMethod: paymentMethodSchema,
  returnUrl: z.url().max(500).optional(),
});

export interface PartnershipRow {
  id: string;
  creator_id: string;
  business_id: string;
  status: PartnershipStatus;
  title: string;
  brief: string;
  amount_cents: number | null;
  currency: string | null;
  proposed_by: 'creator' | 'business';
  terms_by: 'creator' | 'business';
  terms_version: number;
  creator_accepted_version: number | null;
  business_accepted_version: number | null;
  payment_id: string | null;
  created_at: Date;
  updated_at: Date;
}
const COLS =
  'id, creator_id, business_id, status, title, brief, amount_cents, currency, proposed_by, terms_by, terms_version, creator_accepted_version, business_accepted_version, payment_id, created_at, updated_at';
export type Side = 'creator' | 'business';

interface DeliverableRow {
  id: string;
  partnership_id: string;
  title: string;
  kind: string;
  due_at: Date | null;
  status: string;
  post_id: string | null;
  review_note: string | null;
  submitted_at: Date | null;
  decided_at: Date | null;
}
const DCOLS =
  'id, partnership_id, title, kind, due_at, status, post_id, review_note, submitted_at, decided_at';

export async function loadPartnership(
  db: Queryable,
  id: string,
  lock = false,
): Promise<PartnershipRow | null> {
  return (
    (
      await db.query<PartnershipRow>(
        `SELECT ${COLS} FROM brand_partnerships WHERE id = $1 ${lock ? 'FOR UPDATE' : ''}`,
        [id],
      )
    ).rows[0] ?? null
  );
}

/** Which side is this user on? Creators are the creator; business side needs an active team member who can manage the team (owner/admin). */
export async function sideOf(
  ctx: Pick<AppContext, 'db'>,
  p: Pick<PartnershipRow, 'creator_id' | 'business_id'>,
  userId: string,
): Promise<Side | null> {
  if (p.creator_id === userId) return 'creator';
  const a = await getBusinessAccess(ctx.db, p.business_id, userId);
  return a && a.status === 'active' && a.permissions.includes('team.manage') ? 'business' : null;
}
async function requireSide(
  ctx: AppContext,
  id: string,
  userId: string,
  lock: Queryable = ctx.db,
): Promise<{ p: PartnershipRow; side: Side }> {
  const p = await loadPartnership(lock, id, lock !== ctx.db);
  const side = p ? await sideOf(ctx, p, userId) : null;
  if (!p || !side) throw notFound('Partnership'); // never reveal a deal to people outside it
  return { p, side };
}

async function event(
  db: Queryable,
  id: string,
  actorId: string | null,
  side: Side | 'system',
  ev: string,
  from: string | null,
  to: string | null,
  data: Record<string, unknown> = {},
): Promise<void> {
  await db.query(
    'INSERT INTO partnership_events (partnership_id, actor_id, actor_side, event, from_status, to_status, data) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [id, actorId, side, ev, from, to, JSON.stringify(data)],
  );
}

async function notifyOther(
  ctx: AppContext,
  p: PartnershipRow,
  side: Side | 'system',
  kind: string,
  actorId: string | null,
): Promise<void> {
  if (side === 'business' || side === 'system')
    await notify(ctx, {
      userId: p.creator_id,
      kind,
      actorId,
      targetType: 'partnership',
      targetId: p.id,
      data: { title: p.title },
    }).catch(() => undefined);
  if (side === 'creator' || side === 'system')
    for (const u of await teamWith(ctx.db, p.business_id, 'team.manage').catch(
      () => [] as string[],
    ))
      await notify(ctx, {
        userId: u,
        kind,
        actorId,
        targetType: 'partnership',
        targetId: p.id,
        data: { title: p.title },
      }).catch(() => undefined);
}

export async function partnershipView(db: Queryable, p: PartnershipRow, side: Side) {
  const [d, ev, pay] = await Promise.all([
    db.query<DeliverableRow>(
      `SELECT ${DCOLS} FROM partnership_deliverables WHERE partnership_id = $1 ORDER BY created_at, id`,
      [p.id],
    ),
    db.query(
      'SELECT actor_side, event, from_status, to_status, data, created_at FROM partnership_events WHERE partnership_id = $1 ORDER BY id',
      [p.id],
    ),
    p.payment_id
      ? db.query<{ status: string }>('SELECT status FROM payments WHERE id = $1', [p.payment_id])
      : Promise.resolve({ rows: [] as { status: string }[] }),
  ]);
  return {
    id: p.id,
    creatorId: p.creator_id,
    businessId: p.business_id,
    yourSide: side,
    status: p.status,
    title: p.title,
    brief: p.brief,
    amountCents: p.amount_cents,
    currency: p.currency,
    termsVersion: p.terms_version,
    termsBy: p.terms_by,
    acceptedBy: {
      creator: p.creator_accepted_version === p.terms_version,
      business: p.business_accepted_version === p.terms_version,
    },
    disclosureRequired: true,
    disclosureLabel: SPONSORED_LABEL,
    paymentStatus: pay.rows[0]?.status ?? null,
    createdAt: p.created_at.toISOString(),
    updatedAt: p.updated_at.toISOString(),
    deliverables: d.rows.map((x) => ({
      id: x.id,
      title: x.title,
      kind: x.kind,
      dueAt: x.due_at?.toISOString() ?? null,
      status: x.status,
      postId: x.post_id,
      reviewNote: x.review_note,
      submittedAt: x.submitted_at?.toISOString() ?? null,
    })),
    events: ev.rows.map((e) => ({
      side: e.actor_side as string,
      event: e.event as string,
      from: e.from_status as string | null,
      to: e.to_status as string | null,
      at: (e.created_at as Date).toISOString(),
    })),
  };
}

async function replaceDeliverables(
  tx: Tx,
  id: string,
  items: z.infer<typeof deliverableInput>[],
): Promise<void> {
  await tx.query(`DELETE FROM partnership_deliverables WHERE partnership_id = $1`, [id]);
  for (const d of items)
    await tx.query(
      'INSERT INTO partnership_deliverables (partnership_id, title, kind, due_at) VALUES ($1,$2,$3,$4)',
      [id, d.title, d.kind, d.dueAt ?? null],
    );
}

// ------------------------------------------------------------------ propose
export async function propose(
  ctx: AppContext,
  auth: AuthContext,
  side: Side,
  b: { creatorId?: string; businessId?: string } & {
    title: string;
    brief: string;
    amountCents: number;
    currency: string;
    deliverables: z.infer<typeof deliverableInput>[];
  },
  req?: FastifyRequest,
): Promise<PartnershipRow> {
  if (auth.ageBand === 'teen') throw forbidden('Accounts under 18 cannot enter partnerships');
  let creatorId: string;
  let businessId: string;
  if (side === 'business') {
    businessId = b.businessId!;
    creatorId = b.creatorId!;
    const a = await getBusinessAccess(ctx.db, businessId, auth.userId);
    if (!a) throw notFound('Business');
    if (!a.permissions.includes('team.manage')) throw forbidden('Your role does not allow that');
    if (a.status !== 'active') throw forbidden('This business is not active');
    await requireCreator(ctx.db, creatorId).catch(() => {
      throw notFound('Creator');
    });
  } else {
    creatorId = auth.userId;
    businessId = b.businessId!;
    await requireCreator(ctx.db, creatorId);
    const biz = await ctx.db.query<{ status: string }>(
      'SELECT status FROM businesses WHERE id = $1 AND deleted_at IS NULL',
      [businessId],
    );
    if (!biz.rows[0] || biz.rows[0].status !== 'active') throw notFound('Business');
  }
  // A creator cannot contract with a business they work for: money would just move between one person's two roles.
  const conflictRow = await ctx.db.query(
    'SELECT 1 FROM business_members WHERE business_id = $1 AND user_id = $2',
    [businessId, creatorId],
  );
  if (conflictRow.rowCount)
    throw new AppError(
      'unprocessable',
      'A creator cannot partner with a business they are a team member of',
      { reason: 'conflict_of_interest' },
    );
  return withTransaction(ctx.db, async (tx) => {
    const { rows } = await tx.query<PartnershipRow>(
      `INSERT INTO brand_partnerships (creator_id, business_id, status, title, brief, amount_cents, currency, proposed_by, terms_by, terms_version, creator_accepted_version, business_accepted_version, terms)
       VALUES ($1,$2,'proposed',$3,$4,$5,$6,$7,$7,1,$8,$9,'{}'::jsonb) RETURNING ${COLS}`,
      [
        creatorId,
        businessId,
        b.title,
        b.brief,
        b.amountCents,
        b.currency,
        side,
        side === 'creator' ? 1 : null,
        side === 'business' ? 1 : null,
      ],
    );
    const p = rows[0]!;
    await replaceDeliverables(tx, p.id, b.deliverables);
    await event(tx, p.id, auth.userId, side, 'proposed', null, 'proposed', {
      amountCents: b.amountCents,
      currency: b.currency,
    });
    await audit(
      ctx,
      {
        actorId: auth.userId,
        action: 'partnership.proposed',
        targetType: 'partnership',
        targetId: p.id,
        metadata: {
          by: side,
          creatorId,
          businessId,
          amountCents: b.amountCents,
          currency: b.currency,
        },
      },
      req,
      tx,
    );
    return p;
  }).then(async (p) => {
    await notifyOther(ctx, p, side, 'business_partnership_proposed', auth.userId);
    return p;
  });
}

// ------------------------------------------------------------------ negotiate
export async function counter(
  ctx: AppContext,
  auth: AuthContext,
  id: string,
  b: z.infer<typeof counterBody>,
  req?: FastifyRequest,
): Promise<PartnershipRow> {
  const out = await withTransaction(ctx.db, async (tx) => {
    const { p, side } = await requireSide(ctx, id, auth.userId, tx);
    const to = nextPartnershipStatus(p.status, 'counter');
    if (!to)
      throw conflict(`This partnership is ${p.status}`, {
        reason: 'wrong_state',
        status: p.status,
      });
    if (p.terms_by === side)
      throw conflict('Wait for the other side to respond to your terms', {
        reason: 'not_your_turn',
      });
    await tx.query(
      `UPDATE brand_partnerships SET status = 'negotiating', title = COALESCE($2, title), brief = COALESCE($3, brief), amount_cents = COALESCE($4, amount_cents), currency = COALESCE($5, currency),
              terms_version = terms_version + 1, terms_by = $6, creator_accepted_version = CASE WHEN $6 = 'creator' THEN terms_version + 1 END, business_accepted_version = CASE WHEN $6 = 'business' THEN terms_version + 1 END WHERE id = $1`,
      [id, b.title ?? null, b.brief ?? null, b.amountCents ?? null, b.currency ?? null, side],
    );
    if (b.deliverables) await replaceDeliverables(tx, id, b.deliverables);
    await event(tx, id, auth.userId, side, 'countered', p.status, 'negotiating', {
      termsVersion: p.terms_version + 1,
      note: b.note ?? null,
      amountCents: b.amountCents ?? null,
    });
    await audit(
      ctx,
      {
        actorId: auth.userId,
        action: 'partnership.countered',
        targetType: 'partnership',
        targetId: id,
        metadata: {
          by: side,
          termsVersion: p.terms_version + 1,
          amountCents: b.amountCents ?? null,
        },
      },
      req,
      tx,
    );
    return { p: (await loadPartnership(tx, id))!, side };
  });
  await notifyOther(ctx, out.p, out.side, 'business_partnership_countered', auth.userId);
  return out.p;
}

async function simpleTransition(
  ctx: AppContext,
  auth: AuthContext,
  id: string,
  action: PartnershipAction,
  opts: {
    note?: string | undefined;
    onlySide?: Side;
    guard?: (tx: Tx, p: PartnershipRow, side: Side) => Promise<void>;
    set?: string;
  },
  req?: FastifyRequest,
): Promise<PartnershipRow> {
  const out = await withTransaction(ctx.db, async (tx) => {
    const { p, side } = await requireSide(ctx, id, auth.userId, tx);
    if (opts.onlySide && opts.onlySide !== side) throw forbidden('That is up to the other side');
    const to = nextPartnershipStatus(p.status, action);
    if (!to)
      throw conflict(`This partnership is ${p.status}`, {
        reason: 'wrong_state',
        status: p.status,
      });
    await opts.guard?.(tx, p, side);
    await tx.query(
      `UPDATE brand_partnerships SET status = $2 ${opts.set ? `, ${opts.set}` : ''} WHERE id = $1`,
      [id, to],
    );
    await event(tx, id, auth.userId, side, action, p.status, to, { note: opts.note ?? null });
    await audit(
      ctx,
      {
        actorId: auth.userId,
        action: `partnership.${action}`,
        targetType: 'partnership',
        targetId: id,
        metadata: { by: side, from: p.status, to, note: opts.note ?? null },
      },
      req,
      tx,
    );
    return { p: (await loadPartnership(tx, id))!, side };
  });
  await notifyOther(ctx, out.p, out.side, `business_partnership_${action}`, auth.userId);
  return out.p;
}

/** Accept the CURRENT terms. Only the side that did not author them can (you cannot accept your own offer), and the terms cannot have changed meanwhile. */
export async function accept(
  ctx: AppContext,
  auth: AuthContext,
  id: string,
  expectedVersion: number | undefined,
  req?: FastifyRequest,
): Promise<PartnershipRow> {
  return simpleTransition(
    ctx,
    auth,
    id,
    'accept',
    {
      guard: async (tx, p, side) => {
        if (p.terms_by === side)
          throw conflict('You proposed these terms: the other side must accept them', {
            reason: 'not_your_turn',
          });
        if (expectedVersion !== undefined && expectedVersion !== p.terms_version)
          throw conflict('The terms changed: review them again', {
            reason: 'terms_changed',
            termsVersion: p.terms_version,
          });
        await tx.query(
          `UPDATE brand_partnerships SET ${side}_accepted_version = terms_version WHERE id = $1`,
          [p.id],
        );
      },
    },
    req,
  );
}
export const decline = (
  ctx: AppContext,
  auth: AuthContext,
  id: string,
  note: string | undefined,
  req?: FastifyRequest,
) => simpleTransition(ctx, auth, id, 'decline', { note }, req);
export const start = (ctx: AppContext, auth: AuthContext, id: string, req?: FastifyRequest) =>
  simpleTransition(
    ctx,
    auth,
    id,
    'start',
    {
      onlySide: 'creator',
      guard: async (tx, p) => {
        if (
          p.creator_accepted_version !== p.terms_version ||
          p.business_accepted_version !== p.terms_version
        )
          throw conflict('Both sides must accept the current terms', {
            reason: 'terms_not_accepted',
          });
        await requireCreator(tx, p.creator_id);
      },
    },
    req,
  );

export async function cancel(
  ctx: AppContext,
  auth: AuthContext,
  id: string,
  note: string | undefined,
  req?: FastifyRequest,
): Promise<PartnershipRow> {
  return simpleTransition(
    ctx,
    auth,
    id,
    'cancel',
    {
      note,
      guard: async (tx, p) => {
        const pay = p.payment_id
          ? (
              await tx.query<{ status: string }>('SELECT status FROM payments WHERE id = $1', [
                p.payment_id,
              ])
            ).rows[0]
          : null;
        if (pay && !['failed', 'cancelled'].includes(pay.status))
          throw conflict('A payment for this partnership is in progress or done', {
            reason: 'payment_started',
          });
      },
    },
    req,
  );
}

// ------------------------------------------------------------------ sponsored content: disclosure is enforced, never optional
/**
 * Metadata for a sponsored post. A partnership id can be attached ONLY by the creator of an in-progress partnership AND only with an explicit disclosure
 * confirmation; the post then carries `metadata.sponsored` which every post view exposes (clients must show the label).
 */
export async function sponsoredMetadata(
  db: Queryable,
  creatorId: string,
  partnershipId: string,
  disclosureConfirmed: boolean,
): Promise<{ sponsored: { partnershipId: string; businessId: string; label: string } }> {
  if (!disclosureConfirmed)
    throw new AppError(
      'unprocessable',
      'Sponsored posts must be labelled: confirm the paid-partnership disclosure',
      { reason: 'disclosure_required' },
    );
  const p = await loadPartnership(db, partnershipId);
  if (!p || p.creator_id !== creatorId) throw notFound('Partnership');
  if (p.status !== 'in_progress')
    throw conflict(`This partnership is ${p.status}`, { reason: 'wrong_state', status: p.status });
  return { sponsored: { partnershipId: p.id, businessId: p.business_id, label: SPONSORED_LABEL } };
}

// ------------------------------------------------------------------ deliverables
export async function submitDeliverable(
  ctx: AppContext,
  auth: AuthContext,
  id: string,
  deliverableId: string,
  postId: string,
  req?: FastifyRequest,
): Promise<PartnershipRow> {
  const out = await withTransaction(ctx.db, async (tx) => {
    const { p, side } = await requireSide(ctx, id, auth.userId, tx);
    if (side !== 'creator') throw forbidden('Only the creator submits deliverables');
    if (p.status !== 'in_progress')
      throw conflict(`This partnership is ${p.status}`, {
        reason: 'wrong_state',
        status: p.status,
      });
    const d = (
      await tx.query<DeliverableRow>(
        `SELECT ${DCOLS} FROM partnership_deliverables WHERE id = $1 AND partnership_id = $2 FOR UPDATE`,
        [deliverableId, id],
      )
    ).rows[0];
    if (!d) throw notFound('Deliverable');
    if (!['pending', 'rejected'].includes(d.status))
      throw conflict(`This deliverable is ${d.status}`, { reason: 'deliverable_state' });
    const post = (
      await tx.query<{ author_id: string; s: string | null }>(
        `SELECT author_id, metadata->'sponsored'->>'partnershipId' AS s FROM posts WHERE id = $1 AND deleted_at IS NULL`,
        [postId],
      )
    ).rows[0];
    if (!post || post.author_id !== auth.userId) throw notFound('Post');
    if (post.s !== id)
      throw new AppError(
        'unprocessable',
        'That post is not labelled as this partnership: publish it through the partnership (disclosure required)',
        { reason: 'disclosure_required' },
      );
    await tx.query(
      `UPDATE partnership_deliverables SET status = 'submitted', post_id = $2, submitted_at = now(), review_note = NULL WHERE id = $1`,
      [deliverableId, postId],
    );
    await event(tx, id, auth.userId, 'creator', 'deliverable_submitted', p.status, p.status, {
      deliverableId,
      postId,
    });
    await audit(
      ctx,
      {
        actorId: auth.userId,
        action: 'partnership.deliverable_submitted',
        targetType: 'partnership',
        targetId: id,
        metadata: { deliverableId, postId },
      },
      req,
      tx,
    );
    return p;
  });
  await notifyOther(ctx, out, 'creator', 'business_partnership_deliverable_submitted', auth.userId);
  return (await loadPartnership(ctx.db, id))!;
}

export async function reviewDeliverable(
  ctx: AppContext,
  auth: AuthContext,
  id: string,
  deliverableId: string,
  b: z.infer<typeof reviewBody>,
  req?: FastifyRequest,
): Promise<PartnershipRow> {
  const out = await withTransaction(ctx.db, async (tx) => {
    const { p, side } = await requireSide(ctx, id, auth.userId, tx);
    if (side !== 'business') throw forbidden('Only the business reviews deliverables');
    if (p.status !== 'in_progress')
      throw conflict(`This partnership is ${p.status}`, {
        reason: 'wrong_state',
        status: p.status,
      });
    const d = (
      await tx.query<DeliverableRow>(
        `SELECT ${DCOLS} FROM partnership_deliverables WHERE id = $1 AND partnership_id = $2 FOR UPDATE`,
        [deliverableId, id],
      )
    ).rows[0];
    if (!d) throw notFound('Deliverable');
    if (d.status !== 'submitted')
      throw conflict(`This deliverable is ${d.status}`, { reason: 'deliverable_state' });
    await tx.query(
      `UPDATE partnership_deliverables SET status = $2, review_note = $3, decided_at = now() WHERE id = $1`,
      [deliverableId, b.decision === 'approve' ? 'approved' : 'rejected', b.note ?? null],
    );
    await event(
      tx,
      id,
      auth.userId,
      'business',
      b.decision === 'approve' ? 'deliverable_approved' : 'deliverable_rejected',
      p.status,
      p.status,
      { deliverableId, note: b.note ?? null },
    );
    await audit(
      ctx,
      {
        actorId: auth.userId,
        action:
          b.decision === 'approve'
            ? 'partnership.deliverable_approved'
            : 'partnership.deliverable_rejected',
        targetType: 'partnership',
        targetId: id,
        metadata: { deliverableId, note: b.note ?? null },
      },
      req,
      tx,
    );
    // Every deliverable approved -> delivered (the only way to become payable).
    const left = await tx.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM partnership_deliverables WHERE partnership_id = $1 AND status <> 'approved'`,
      [id],
    );
    if (
      b.decision === 'approve' &&
      left.rows[0]!.n === 0 &&
      nextPartnershipStatus(p.status, 'deliver')
    ) {
      await tx.query(`UPDATE brand_partnerships SET status = 'delivered' WHERE id = $1`, [id]);
      await event(tx, id, null, 'system', 'deliver', p.status, 'delivered');
      await audit(
        ctx,
        {
          actorType: 'system',
          action: 'partnership.deliver',
          targetType: 'partnership',
          targetId: id,
          metadata: { from: p.status, to: 'delivered' },
        },
        undefined,
        tx,
      );
    }
    return p;
  });
  await notifyOther(ctx, out, 'business', 'business_partnership_deliverable_reviewed', auth.userId);
  return (await loadPartnership(ctx.db, id))!;
}

// ------------------------------------------------------------------ pay (business owner) and settle
export async function payPartnership(
  ctx: AppContext,
  auth: AuthContext,
  id: string,
  b: z.infer<typeof payBody>,
  key: string,
  clientIp: string,
  req?: FastifyRequest,
) {
  const p0 = await loadPartnership(ctx.db, id);
  const acc = p0 ? await getBusinessAccess(ctx.db, p0.business_id, auth.userId) : null;
  if (!p0 || !acc) throw notFound('Partnership');
  if (acc.role !== 'owner') throw forbidden('Only the business owner can pay');
  if (!p0.amount_cents || !p0.currency) throw invalid('This partnership has no amount');
  if (!['delivered', 'paid'].includes(p0.status))
    throw conflict(
      `This partnership is ${p0.status}: it can be paid once every deliverable is approved`,
      { reason: 'wrong_state', status: p0.status },
    );
  const out = await chargeToCreator(ctx, {
    payer: { userId: auth.userId, ageBand: auth.ageBand },
    creatorId: p0.creator_id,
    purpose: 'partnership',
    amount: p0.amount_cents,
    currency: p0.currency,
    idem: `partnership:${id}:${key}`,
    hash: requestHash({ id, pm: b.paymentMethod }),
    paymentMethod: b.paymentMethod,
    returnUrl: b.returnUrl,
    metadata: { creatorId: p0.creator_id, partnershipId: id },
    description: `Partnership: ${p0.title}`.slice(0, 200),
    clientIp,
    req,
    onCreated: async (tx, payment) => {
      const p = await loadPartnership(tx, id, true);
      if (!p || p.status !== 'delivered')
        throw conflict('This partnership cannot be paid right now', {
          reason: 'wrong_state',
          status: p?.status,
        });
      const upd = await tx.query(
        `UPDATE brand_partnerships SET payment_id = $2 WHERE id = $1 AND (payment_id IS NULL OR payment_id IN (SELECT id FROM payments WHERE status IN ('failed','cancelled')))`,
        [id, payment.id],
      );
      if (!upd.rowCount)
        throw conflict('A payment for this partnership is already in progress or done', {
          reason: 'payment_in_progress',
        });
      await event(tx, id, auth.userId, 'business', 'payment_started', p.status, p.status, {
        paymentId: payment.id,
        amountCents: p.amount_cents,
      });
    },
  });
  await settlePartnershipPayments(ctx, { partnershipId: id });
  const p = (await loadPartnership(ctx.db, id))!;
  if (out.payment.status === 'failed')
    throw new AppError('payment_failed', 'The payment was declined', {
      reason: out.payment.failure_code ?? 'payment_failed',
      paymentId: out.payment.id,
    });
  return {
    partnership: p,
    payment: paymentSummary(out.payment),
    replayed: out.replayed,
    nextAction: out.nextAction,
  };
}

/** delivered + captured payment -> paid. A failed/cancelled payment frees the partnership for a new attempt. Exactly-once by status guards. */
export async function settlePartnershipPayments(
  ctx: AppContext,
  opts: { partnershipId?: string } = {},
): Promise<number> {
  let paid = 0;
  const { rows } = await ctx.db.query<{ id: string; pstatus: string }>(
    `SELECT bp.id, p.status AS pstatus FROM brand_partnerships bp JOIN payments p ON p.id = bp.payment_id WHERE bp.status = 'delivered' AND ($1::uuid IS NULL OR bp.id = $1)`,
    [opts.partnershipId ?? null],
  );
  for (const r of rows) {
    const done = ['captured', 'partially_refunded', 'refunded', 'disputed'].includes(r.pstatus);
    const failed = ['failed', 'cancelled'].includes(r.pstatus);
    if (!done && !failed) continue;
    const p = await withTransaction(ctx.db, async (tx) => {
      const cur = await loadPartnership(tx, r.id, true);
      if (!cur || cur.status !== 'delivered' || !cur.payment_id) return null;
      if (done) {
        await tx.query(`UPDATE brand_partnerships SET status = 'paid' WHERE id = $1`, [r.id]);
        await event(tx, r.id, null, 'system', 'pay', 'delivered', 'paid', {
          paymentId: cur.payment_id,
        });
        await audit(
          ctx,
          {
            actorType: 'system',
            action: 'partnership.pay',
            targetType: 'partnership',
            targetId: r.id,
            metadata: {
              paymentId: cur.payment_id,
              amountCents: cur.amount_cents,
              currency: cur.currency,
            },
          },
          undefined,
          tx,
        );
        return cur;
      }
      await tx.query('UPDATE brand_partnerships SET payment_id = NULL WHERE id = $1', [r.id]);
      await event(tx, r.id, null, 'system', 'payment_failed', 'delivered', 'delivered', {
        paymentId: cur.payment_id,
      });
      return null;
    });
    if (p) {
      paid += 1;
      await notifyOther(ctx, p, 'system', 'payment_partnership_paid', null);
    }
  }
  return paid;
}

// ------------------------------------------------------------------ lists
export async function listForCreator(db: Queryable, creatorId: string): Promise<PartnershipRow[]> {
  return (
    await db.query<PartnershipRow>(
      `SELECT ${COLS} FROM brand_partnerships WHERE creator_id = $1 ORDER BY updated_at DESC, id LIMIT 100`,
      [creatorId],
    )
  ).rows;
}
export async function listForBusiness(
  ctx: AppContext,
  businessId: string,
  userId: string,
): Promise<PartnershipRow[]> {
  const a = await getBusinessAccess(ctx.db, businessId, userId);
  if (!a) throw notFound('Business');
  if (!a.permissions.includes('team.manage')) throw forbidden('Your role does not allow that');
  return (
    await ctx.db.query<PartnershipRow>(
      `SELECT ${COLS} FROM brand_partnerships WHERE business_id = $1 ORDER BY updated_at DESC, id LIMIT 100`,
      [businessId],
    )
  ).rows;
}
export async function getForUser(ctx: AppContext, id: string, userId: string) {
  const { p, side } = await requireSide(ctx, id, userId);
  return partnershipView(ctx.db, p, side);
}
