import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { withTransaction, type Queryable } from '@yapilapi/database';
import { AppError, conflict, forbidden, invalid, notFound } from '@yapilapi/shared';
import type { AppContext } from '../../lib/context.js';
import type { AuthContext } from '../../lib/auth-context.js';
import { audit } from '../../lib/audit.js';
import { assertTextAllowed } from '../../lib/text-guard.js';
import { getBusinessAccess } from '../business/access.js';
import { requireCreator } from '../creator/profile.js';
import {
  PLACEMENTS,
  canCampaignMove,
  isEditable,
  validateTargetUrl,
  validateTargeting,
  type CampaignStatus,
  type Targeting,
} from './rules.js';

export interface CampaignRow {
  id: string;
  business_id: string | null;
  owner_user_id: string | null;
  name: string;
  objective: string;
  status: CampaignStatus;
  daily_budget_cents: string;
  total_budget_cents: string;
  spent_cents: string;
  currency: string;
  starts_at: Date | null;
  ends_at: Date | null;
  targeting: Targeting;
  bid_model: 'cpm' | 'cpc';
  bid_cents: number;
  spent_milli: string;
  settled_milli: string;
  submitted_at: Date | null;
  review_note: string | null;
  reviewed_at: Date | null;
  frequency_cap: number;
  created_at: Date;
  updated_at: Date;
}
export const CAMPAIGN_COLS = `id, business_id, owner_user_id, name, objective, status, daily_budget_cents, total_budget_cents, spent_cents, currency, starts_at, ends_at, targeting, bid_model, bid_cents,
  spent_milli, settled_milli, submitted_at, review_note, reviewed_at, frequency_cap, created_at, updated_at`;

export interface AdRow {
  id: string;
  campaign_id: string;
  headline: string;
  body: string;
  media_id: string | null;
  target_type: string | null;
  target_id: string | null;
  target_url: string | null;
  status: string;
  placement: string;
  review_note: string | null;
  created_at: Date;
}
export const AD_COLS =
  'id, campaign_id, headline, body, media_id, target_type, target_id, target_url, status, placement, review_note, created_at';

const MAX_MONEY = 100_000_000; // 1M in cents
const money = z.number().int().min(1).max(MAX_MONEY);
export const campaignBody = z.object({
  businessId: z.uuid().optional(),
  name: z.string().trim().min(2).max(120),
  objective: z.enum(['awareness', 'traffic', 'events', 'sales', 'bookings']).default('awareness'),
  dailyBudgetCents: z.number().int().min(100).max(MAX_MONEY),
  totalBudgetCents: money,
  currency: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{3}$/),
  startsAt: z.iso.datetime().optional(),
  endsAt: z.iso.datetime().optional(),
  targeting: z.unknown().default({}),
  bidModel: z.enum(['cpm', 'cpc']).default('cpm'),
  bidCents: z.number().int().min(1).max(100_000),
  frequencyCap: z.number().int().min(1).max(20).default(3),
});
export const campaignPatch = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    objective: z.enum(['awareness', 'traffic', 'events', 'sales', 'bookings']).optional(),
    dailyBudgetCents: z.number().int().min(100).max(MAX_MONEY).optional(),
    totalBudgetCents: money.optional(),
    startsAt: z.iso.datetime().nullable().optional(),
    endsAt: z.iso.datetime().nullable().optional(),
    targeting: z.unknown().optional(),
    bidModel: z.enum(['cpm', 'cpc']).optional(),
    bidCents: z.number().int().min(1).max(100_000).optional(),
    frequencyCap: z.number().int().min(1).max(20).optional(),
  })
  .refine((b) => Object.keys(b).length > 0, 'Nothing to change');

export const adBody = z.object({
  headline: z.string().trim().min(1).max(120),
  body: z.string().trim().max(500).default(''),
  mediaId: z.uuid().optional(),
  placement: z.enum(PLACEMENTS).default('feed'),
  target: z.discriminatedUnion('type', [
    z.object({ type: z.literal('url'), url: z.string().trim().max(500) }),
    z.object({ type: z.enum(['business', 'product', 'event']), id: z.uuid() }),
  ]),
});
export const adPatch = z
  .object({
    headline: z.string().trim().min(1).max(120).optional(),
    body: z.string().trim().max(500).optional(),
    mediaId: z.uuid().nullable().optional(),
    placement: z.enum(PLACEMENTS).optional(),
    target: adBody.shape.target.optional(),
  })
  .refine((b) => Object.keys(b).length > 0, 'Nothing to change');

const num = (v: string | number): number => Number(v);
export const campaignView = (c: CampaignRow, extra: Record<string, unknown> = {}) => ({
  id: c.id,
  businessId: c.business_id,
  ownerUserId: c.owner_user_id,
  name: c.name,
  objective: c.objective,
  status: c.status,
  dailyBudgetCents: num(c.daily_budget_cents),
  totalBudgetCents: num(c.total_budget_cents),
  spentCents: Math.floor(num(c.spent_milli) / 1000),
  currency: c.currency,
  startsAt: c.starts_at?.toISOString() ?? null,
  endsAt: c.ends_at?.toISOString() ?? null,
  targeting: c.targeting,
  bidModel: c.bid_model,
  bidCents: c.bid_cents,
  frequencyCap: c.frequency_cap,
  submittedAt: c.submitted_at?.toISOString() ?? null,
  reviewNote:
    c.status === 'rejected' || c.status === 'paused' || c.status === 'active'
      ? c.review_note
      : null,
  reviewedAt: c.reviewed_at?.toISOString() ?? null,
  createdAt: c.created_at.toISOString(),
  updatedAt: c.updated_at.toISOString(),
  ...extra,
});
export const adView = (a: AdRow) => ({
  id: a.id,
  campaignId: a.campaign_id,
  headline: a.headline,
  body: a.body,
  mediaId: a.media_id,
  placement: a.placement,
  status: a.status,
  target:
    a.target_type === 'url'
      ? { type: 'url', url: a.target_url }
      : a.target_type
        ? { type: a.target_type, id: a.target_id }
        : null,
  reviewNote: a.status === 'rejected' ? a.review_note : null,
  createdAt: a.created_at.toISOString(),
});

// ------------------------------------------------------------------ access
export interface Advertiser {
  businessId: string | null;
  userId: string | null;
}
/** Who is advertising: a business the user runs (owner/admin, business active) or the user themself as an active creator. Adults only. */
async function resolveAdvertiser(
  ctx: AppContext,
  auth: AuthContext,
  businessId: string | undefined,
): Promise<Advertiser> {
  if (auth.ageBand === 'teen') throw forbidden('Accounts under 18 cannot advertise');
  if (businessId) {
    const a = await getBusinessAccess(ctx.db, businessId, auth.userId);
    if (!a) throw notFound('Business');
    if (a.role !== 'owner' && a.role !== 'admin')
      throw forbidden('Only owners and admins can run ads for a business');
    if (a.status !== 'active') throw forbidden('This business is not active');
    return { businessId, userId: null };
  }
  await requireCreator(ctx.db, auth.userId);
  return { businessId: null, userId: auth.userId };
}

/** The campaign if the user manages it (own creator campaign, or owner/admin of the business), else 404. */
export async function loadManagedCampaign(
  db: Queryable,
  id: string,
  userId: string,
  forUpdate = false,
): Promise<CampaignRow> {
  const { rows } = await db.query<CampaignRow>(
    `SELECT ${CAMPAIGN_COLS} FROM ad_campaigns c WHERE id = $1 AND (owner_user_id = $2 OR EXISTS (SELECT 1 FROM business_members m JOIN businesses b ON b.id = m.business_id AND b.deleted_at IS NULL
        WHERE m.business_id = c.business_id AND m.user_id = $2 AND m.role IN ('owner','admin')))${forUpdate ? ' FOR UPDATE' : ''}`,
    [id, userId],
  );
  if (!rows[0]) throw notFound('Campaign');
  return rows[0];
}

async function checkTopics(db: Queryable, t: Targeting): Promise<void> {
  if (!t.topics.length) return;
  const { rows } = await db.query<{ slug: string }>(
    'SELECT slug::text FROM topics WHERE slug = ANY($1::citext[])',
    [t.topics],
  );
  const known = new Set(rows.map((r) => r.slug));
  const unknown = t.topics.filter((x) => !known.has(x));
  if (unknown.length)
    throw new AppError('unprocessable', `Unknown topics: ${unknown.join(', ')}`, {
      reason: 'unknown_topic',
      topics: unknown,
    });
}
function parseTargeting(raw: unknown): Targeting {
  const r = validateTargeting(raw);
  if (!r.ok)
    throw new AppError('unprocessable', 'That targeting is not allowed', {
      reason: 'targeting_not_allowed',
      issues: r.issues,
    });
  return r.targeting;
}
function checkSchedule(starts: Date | null, ends: Date | null): void {
  if (starts && ends && ends <= starts) throw invalid('The end must be after the start');
  if (ends && ends.getTime() < Date.now()) throw invalid('The end date is in the past');
}

// ------------------------------------------------------------------ campaigns
export async function createCampaign(
  ctx: AppContext,
  auth: AuthContext,
  b: z.infer<typeof campaignBody>,
  req?: FastifyRequest,
): Promise<CampaignRow> {
  const who = await resolveAdvertiser(ctx, auth, b.businessId);
  if (b.dailyBudgetCents > b.totalBudgetCents)
    throw invalid('The daily budget cannot exceed the total budget');
  const targeting = parseTargeting(b.targeting);
  await checkTopics(ctx.db, targeting);
  assertTextAllowed(b.name);
  const starts = b.startsAt ? new Date(b.startsAt) : null;
  const ends = b.endsAt ? new Date(b.endsAt) : null;
  checkSchedule(starts, ends);
  const { rows } = await ctx.db.query<CampaignRow>(
    `INSERT INTO ad_campaigns (business_id, owner_user_id, name, objective, daily_budget_cents, total_budget_cents, currency, starts_at, ends_at, targeting, bid_model, bid_cents, frequency_cap)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING ${CAMPAIGN_COLS}`,
    [
      who.businessId,
      who.userId,
      b.name,
      b.objective,
      b.dailyBudgetCents,
      b.totalBudgetCents,
      b.currency,
      starts,
      ends,
      JSON.stringify(targeting),
      b.bidModel,
      b.bidCents,
      b.frequencyCap,
    ],
  );
  await audit(
    ctx,
    {
      actorId: auth.userId,
      action: 'ads.campaign_created',
      targetType: 'ad_campaign',
      targetId: rows[0]!.id,
      metadata: {
        businessId: who.businessId,
        totalBudgetCents: b.totalBudgetCents,
        bidModel: b.bidModel,
      },
    },
    req,
  );
  return rows[0]!;
}

export async function patchCampaign(
  ctx: AppContext,
  auth: AuthContext,
  id: string,
  b: z.infer<typeof campaignPatch>,
  req?: FastifyRequest,
): Promise<CampaignRow> {
  if (auth.ageBand === 'teen') throw forbidden('Accounts under 18 cannot advertise');
  const cur = await loadManagedCampaign(ctx.db, id, auth.userId);
  if (!isEditable(cur.status))
    throw conflict(
      cur.status === 'active'
        ? 'Pause the campaign before editing it'
        : `A ${cur.status.replace('_', ' ')} campaign cannot be edited`,
      { reason: 'not_editable', status: cur.status },
    );
  const daily = b.dailyBudgetCents ?? num(cur.daily_budget_cents);
  const total = b.totalBudgetCents ?? num(cur.total_budget_cents);
  if (daily > total) throw invalid('The daily budget cannot exceed the total budget');
  if (total * 1000 < num(cur.spent_milli))
    throw invalid('The total budget cannot be below what was already spent');
  let targeting: Targeting | null = null;
  if (b.targeting !== undefined) {
    targeting = parseTargeting(b.targeting);
    await checkTopics(ctx.db, targeting);
  }
  if (b.name) assertTextAllowed(b.name);
  const starts =
    b.startsAt === undefined ? cur.starts_at : b.startsAt === null ? null : new Date(b.startsAt);
  const ends = b.endsAt === undefined ? cur.ends_at : b.endsAt === null ? null : new Date(b.endsAt);
  checkSchedule(starts, ends);
  // What a reviewer approved is the content, targeting and bid. A budget/schedule/name-only edit keeps the approval; anything else needs a new review.
  const reviewedFieldsChanged =
    b.targeting !== undefined ||
    b.objective !== undefined ||
    b.bidModel !== undefined ||
    b.bidCents !== undefined;
  const nextStatus: CampaignStatus =
    cur.status === 'paused' && reviewedFieldsChanged ? 'draft' : cur.status;
  const { rows } = await ctx.db.query<CampaignRow>(
    `UPDATE ad_campaigns SET name = COALESCE($2,name), objective = COALESCE($3,objective), daily_budget_cents = $4, total_budget_cents = $5, starts_at = $6, ends_at = $7, targeting = COALESCE($8::jsonb, targeting),
        bid_model = COALESCE($9,bid_model), bid_cents = COALESCE($10,bid_cents), frequency_cap = COALESCE($11,frequency_cap), status = $12 WHERE id = $1 RETURNING ${CAMPAIGN_COLS}`,
    [
      id,
      b.name ?? null,
      b.objective ?? null,
      daily,
      total,
      starts,
      ends,
      targeting ? JSON.stringify(targeting) : null,
      b.bidModel ?? null,
      b.bidCents ?? null,
      b.frequencyCap ?? null,
      nextStatus,
    ],
  );
  if (nextStatus !== cur.status)
    await ctx.db.query(
      `UPDATE advertisements SET status = 'draft' WHERE campaign_id = $1 AND status IN ('approved','pending_review')`,
      [id],
    );
  await audit(
    ctx,
    {
      actorId: auth.userId,
      action: 'ads.campaign_updated',
      targetType: 'ad_campaign',
      targetId: id,
      metadata: { fields: Object.keys(b), backToDraft: nextStatus !== cur.status },
    },
    req,
  );
  return rows[0]!;
}

async function moveCampaign(
  ctx: AppContext,
  tx: Queryable,
  c: CampaignRow,
  to: CampaignStatus,
  by: { id: string | null; type: 'user' | 'staff' | 'system' },
  reason: string | null,
  req?: FastifyRequest,
): Promise<CampaignRow> {
  if (!canCampaignMove(c.status, to))
    throw conflict(
      `A ${c.status.replace('_', ' ')} campaign cannot become ${to.replace('_', ' ')}`,
      { reason: 'invalid_state', status: c.status },
    );
  const { rows } = await tx.query<CampaignRow>(
    `UPDATE ad_campaigns SET status = $2 WHERE id = $1 RETURNING ${CAMPAIGN_COLS}`,
    [c.id, to],
  );
  await tx.query(
    'INSERT INTO ad_review_events (campaign_id, actor_id, event, from_status, to_status, reason) VALUES ($1,$2,$3,$4,$5,$6)',
    [c.id, by.id, `campaign_${to}`, c.status, to, reason],
  );
  await audit(
    ctx,
    {
      actorId: by.id,
      actorType: by.type,
      action: `ads.campaign_${to}`,
      targetType: 'ad_campaign',
      targetId: c.id,
      metadata: { from: c.status, reason },
    },
    req,
    tx,
  );
  return rows[0]!;
}
export { moveCampaign };

/** draft/rejected/paused(edited) -> pending_review. Needs at least one ad, every submitted ad valid; ads move to review together with the campaign. */
export async function submitCampaign(
  ctx: AppContext,
  auth: AuthContext,
  id: string,
  req?: FastifyRequest,
): Promise<CampaignRow> {
  if (auth.ageBand === 'teen') throw forbidden('Accounts under 18 cannot advertise');
  return withTransaction(ctx.db, async (tx) => {
    const c = await loadManagedCampaign(tx, id, auth.userId, true);
    if (!canCampaignMove(c.status, 'pending_review'))
      throw conflict(`A ${c.status.replace('_', ' ')} campaign cannot be submitted`, {
        reason: 'invalid_state',
        status: c.status,
      });
    const ads = (
      await tx.query<{ id: string; status: string }>(
        `SELECT id, status FROM advertisements WHERE campaign_id = $1`,
        [id],
      )
    ).rows;
    if (!ads.some((a) => a.status === 'draft' || a.status === 'rejected'))
      throw new AppError('unprocessable', 'Add at least one ad before submitting', {
        reason: 'no_ads',
      });
    if (c.ends_at && c.ends_at.getTime() < Date.now()) throw invalid('The end date is in the past');
    const r = await moveCampaign(
      ctx,
      tx,
      c,
      'pending_review',
      { id: auth.userId, type: 'user' },
      null,
      req,
    );
    await tx.query(
      `UPDATE ad_campaigns SET submitted_at = now(), review_note = NULL WHERE id = $1`,
      [id],
    );
    await tx.query(
      `UPDATE advertisements SET status = 'pending_review', moderation_status = 'pending_review' WHERE campaign_id = $1 AND status IN ('draft','rejected')`,
      [id],
    );
    return { ...r, submitted_at: new Date() };
  });
}

/** Owner controls once approved: pause <-> resume (resume needs the campaign to still have budget and time left), end for good. */
export async function setCampaignState(
  ctx: AppContext,
  auth: AuthContext,
  id: string,
  action: 'pause' | 'resume' | 'end',
  req?: FastifyRequest,
): Promise<CampaignRow> {
  return withTransaction(ctx.db, async (tx) => {
    const c = await loadManagedCampaign(tx, id, auth.userId, true);
    const to: CampaignStatus =
      action === 'pause' ? 'paused' : action === 'resume' ? 'active' : 'ended';
    if (action === 'resume') {
      if (
        c.reviewed_at === null ||
        (
          await tx.query(
            `SELECT 1 FROM advertisements WHERE campaign_id = $1 AND status = 'approved' LIMIT 1`,
            [id],
          )
        ).rowCount === 0
      )
        throw conflict('This campaign has no approved ads: submit it for review', {
          reason: 'not_approved',
        });
      if (num(c.spent_milli) >= num(c.total_budget_cents) * 1000)
        throw conflict('The campaign has spent its budget', { reason: 'budget_exhausted' });
      if (c.ends_at && c.ends_at <= new Date())
        throw conflict('The campaign has passed its end date', { reason: 'expired' });
      const last = (
        await tx.query<{ event: string }>(
          `SELECT event FROM ad_review_events WHERE campaign_id = $1 AND event IN ('campaign_suspended','campaign_reinstated') ORDER BY id DESC LIMIT 1`,
          [id],
        )
      ).rows[0];
      if (last?.event === 'campaign_suspended')
        throw conflict('This campaign was suspended by review: contact support', {
          reason: 'suspended',
        });
    }
    return moveCampaign(ctx, tx, c, to, { id: auth.userId, type: 'user' }, null, req);
  });
}

export async function listCampaigns(
  ctx: AppContext,
  userId: string,
  q: { status?: string | undefined; businessId?: string | undefined },
) {
  const { rows } = await ctx.db.query<CampaignRow>(
    `SELECT ${CAMPAIGN_COLS} FROM ad_campaigns c WHERE (owner_user_id = $1 OR EXISTS (SELECT 1 FROM business_members m JOIN businesses b ON b.id = m.business_id AND b.deleted_at IS NULL
        WHERE m.business_id = c.business_id AND m.user_id = $1 AND m.role IN ('owner','admin')))
      AND ($2::text IS NULL OR status = $2) AND ($3::uuid IS NULL OR business_id = $3) ORDER BY created_at DESC LIMIT 100`,
    [userId, q.status ?? null, q.businessId ?? null],
  );
  return { items: rows.map((c) => campaignView(c)) };
}

// ------------------------------------------------------------------ ads (creatives)
const MAX_ADS = 10;
async function checkTarget(
  ctx: AppContext,
  c: CampaignRow,
  t: z.infer<typeof adBody>['target'],
): Promise<{ type: string; id: string | null; url: string | null }> {
  if (t.type === 'url') {
    const err = validateTargetUrl(t.url);
    if (err) throw invalid(err);
    return { type: 'url', id: null, url: new URL(t.url).toString() };
  }
  const mine = c.business_id
    ? { biz: c.business_id, user: null }
    : { biz: null, user: c.owner_user_id };
  let ok = false;
  if (t.type === 'business')
    ok =
      c.business_id === t.id &&
      (
        await ctx.db.query(
          `SELECT 1 FROM businesses WHERE id = $1 AND status = 'active' AND deleted_at IS NULL`,
          [t.id],
        )
      ).rowCount === 1;
  if (t.type === 'product')
    ok =
      (
        await ctx.db.query(
          `SELECT 1 FROM products WHERE id = $1 AND deleted_at IS NULL AND status = 'active' AND (business_id = $2 OR seller_user_id = $3)`,
          [t.id, mine.biz, mine.user],
        )
      ).rowCount === 1;
  if (t.type === 'event')
    ok =
      (
        await ctx.db.query(
          `SELECT 1 FROM events WHERE id = $1 AND deleted_at IS NULL AND status = 'published' AND (host_id = $2 OR host_business_id = $3)`,
          [t.id, mine.user, mine.biz],
        )
      ).rowCount === 1;
  if (!ok)
    throw new AppError(
      'unprocessable',
      `That ${t.type} is not yours to promote, or is not available`,
      { reason: 'target_not_allowed' },
    );
  return { type: t.type, id: t.id, url: null };
}
async function checkMedia(ctx: AppContext, userId: string, mediaId: string): Promise<void> {
  const m = (
    await ctx.db.query<{ kind: string; status: string }>(
      `SELECT kind, status FROM media WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL AND purged_at IS NULL`,
      [mediaId, userId],
    )
  ).rows[0];
  if (!m) throw notFound('Media');
  if (!['image', 'video'].includes(m.kind) || m.status !== 'ready')
    throw new AppError('unprocessable', 'An ad uses a ready image or video', {
      reason: 'unsupported_media',
    });
}

export async function createAd(
  ctx: AppContext,
  auth: AuthContext,
  campaignId: string,
  b: z.infer<typeof adBody>,
  req?: FastifyRequest,
): Promise<AdRow> {
  if (auth.ageBand === 'teen') throw forbidden('Accounts under 18 cannot advertise');
  const c = await loadManagedCampaign(ctx.db, campaignId, auth.userId);
  if (c.status === 'ended') throw conflict('This campaign has ended', { reason: 'invalid_state' });
  assertTextAllowed(b.headline, b.body);
  if (b.mediaId) await checkMedia(ctx, auth.userId, b.mediaId);
  const tgt = await checkTarget(ctx, c, b.target);
  if (
    num(
      (
        await ctx.db.query('SELECT count(*)::int AS n FROM advertisements WHERE campaign_id = $1', [
          campaignId,
        ])
      ).rows[0]!.n,
    ) >= MAX_ADS
  )
    throw conflict(`At most ${MAX_ADS} ads per campaign`, { reason: 'too_many_ads' });
  // An ad added to a campaign already in (or past) review is reviewed on its own; drafts wait for the campaign's submission.
  const status = c.status === 'active' || c.status === 'paused' ? 'pending_review' : 'draft';
  const { rows } = await ctx.db.query<AdRow>(
    `INSERT INTO advertisements (campaign_id, headline, body, media_id, target_type, target_id, target_url, placement, status, moderation_status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending_review') RETURNING ${AD_COLS}`,
    [
      campaignId,
      b.headline,
      b.body,
      b.mediaId ?? null,
      tgt.type,
      tgt.id,
      tgt.url,
      b.placement,
      status,
    ],
  );
  await audit(
    ctx,
    {
      actorId: auth.userId,
      action: 'ads.ad_created',
      targetType: 'advertisement',
      targetId: rows[0]!.id,
      metadata: { campaignId, status },
    },
    req,
  );
  return rows[0]!;
}

export async function patchAd(
  ctx: AppContext,
  auth: AuthContext,
  campaignId: string,
  adId: string,
  b: z.infer<typeof adPatch>,
  req?: FastifyRequest,
): Promise<AdRow> {
  if (auth.ageBand === 'teen') throw forbidden('Accounts under 18 cannot advertise');
  const c = await loadManagedCampaign(ctx.db, campaignId, auth.userId);
  const cur = (
    await ctx.db.query<AdRow>(
      `SELECT ${AD_COLS} FROM advertisements WHERE id = $1 AND campaign_id = $2`,
      [adId, campaignId],
    )
  ).rows[0];
  if (!cur) throw notFound('Ad');
  if (cur.status !== 'draft' && cur.status !== 'rejected')
    throw conflict(
      'Only a draft or rejected ad can be edited: pause and re-submit to change an approved one',
      { reason: 'not_editable', status: cur.status },
    );
  assertTextAllowed(b.headline, b.body);
  if (b.mediaId) await checkMedia(ctx, auth.userId, b.mediaId);
  const tgt = b.target ? await checkTarget(ctx, c, b.target) : null;
  const { rows } = await ctx.db.query<AdRow>(
    `UPDATE advertisements SET headline = COALESCE($3,headline), body = COALESCE($4,body), media_id = CASE WHEN $5::boolean THEN $6 ELSE media_id END, placement = COALESCE($7,placement),
        target_type = COALESCE($8,target_type), target_id = CASE WHEN $8::text IS NULL THEN target_id ELSE $9 END, target_url = CASE WHEN $8::text IS NULL THEN target_url ELSE $10 END, status = 'draft', review_note = NULL
      WHERE id = $1 AND campaign_id = $2 RETURNING ${AD_COLS}`,
    [
      adId,
      campaignId,
      b.headline ?? null,
      b.body ?? null,
      b.mediaId !== undefined,
      b.mediaId ?? null,
      b.placement ?? null,
      tgt?.type ?? null,
      tgt?.id ?? null,
      tgt?.url ?? null,
    ],
  );
  await audit(
    ctx,
    {
      actorId: auth.userId,
      action: 'ads.ad_updated',
      targetType: 'advertisement',
      targetId: adId,
      metadata: { fields: Object.keys(b) },
    },
    req,
  );
  return rows[0]!;
}

/** Remove an ad: deleted outright when it never ran, otherwise paused for good (its numbers stay in reports and billing). */
export async function removeAd(
  ctx: AppContext,
  auth: AuthContext,
  campaignId: string,
  adId: string,
  req?: FastifyRequest,
): Promise<void> {
  await loadManagedCampaign(ctx.db, campaignId, auth.userId);
  const ran =
    (await ctx.db.query('SELECT 1 FROM ad_impressions WHERE ad_id = $1 LIMIT 1', [adId]))
      .rowCount === 1;
  const r = ran
    ? await ctx.db.query(
        `UPDATE advertisements SET status = 'paused' WHERE id = $1 AND campaign_id = $2 RETURNING id`,
        [adId, campaignId],
      )
    : await ctx.db.query(
        'DELETE FROM advertisements WHERE id = $1 AND campaign_id = $2 RETURNING id',
        [adId, campaignId],
      );
  if (!r.rowCount) throw notFound('Ad');
  await audit(
    ctx,
    {
      actorId: auth.userId,
      action: ran ? 'ads.ad_paused' : 'ads.ad_deleted',
      targetType: 'advertisement',
      targetId: adId,
      metadata: { campaignId },
    },
    req,
  );
}

export async function listAds(db: Queryable, campaignId: string): Promise<AdRow[]> {
  return (
    await db.query<AdRow>(
      `SELECT ${AD_COLS} FROM advertisements WHERE campaign_id = $1 ORDER BY created_at`,
      [campaignId],
    )
  ).rows;
}
