import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { withTransaction, type Queryable } from '@yapilapi/database';
import { AppError, conflict, forbidden, notFound } from '@yapilapi/shared';
import type { AppContext } from '../../lib/context.js';
import type { AuthContext } from '../../lib/auth-context.js';
import { audit } from '../../lib/audit.js';
import { notify } from '../../lib/notify.js';
import {
  AD_COLS,
  CAMPAIGN_COLS,
  adView,
  campaignView,
  moveCampaign,
  type AdRow,
  type CampaignRow,
} from './campaigns.js';
import { validateTargeting } from './rules.js';

const reason = z.string().trim().min(5).max(500);
export const reviewBody = z.object({
  decision: z.enum(['approve', 'reject']),
  reason: reason.optional(),
  ads: z
    .array(
      z.object({
        adId: z.uuid(),
        decision: z.enum(['approve', 'reject']),
        reason: reason.optional(),
      }),
    )
    .max(10)
    .default([]),
});
export const adReviewBody = z.object({
  decision: z.enum(['approve', 'reject']),
  reason: reason.optional(),
});
export const reasonBody = z.object({ reason });

/** Who should hear about a decision: the creator, or the business owner. */
async function advertiserUser(
  db: Queryable,
  c: Pick<CampaignRow, 'business_id' | 'owner_user_id'>,
): Promise<string | null> {
  if (c.owner_user_id) return c.owner_user_id;
  return (
    (
      await db.query<{ owner_id: string }>('SELECT owner_id FROM businesses WHERE id = $1', [
        c.business_id,
      ])
    ).rows[0]?.owner_id ?? null
  );
}
/** Staff never review ads they could benefit from: their own creator campaigns, or any business they belong to. */
async function assertNoConflict(db: Queryable, c: CampaignRow, staffId: string): Promise<void> {
  if (c.owner_user_id === staffId) throw forbidden('You cannot review your own campaign');
  if (
    c.business_id &&
    (
      await db.query('SELECT 1 FROM business_members WHERE business_id = $1 AND user_id = $2', [
        c.business_id,
        staffId,
      ])
    ).rowCount
  )
    throw forbidden('You cannot review a campaign of a business you belong to');
}
const need = (r: string | undefined, what: string): string => {
  if (!r)
    throw new AppError('validation_failed', `A reason is required to ${what}`, {
      reason: 'reason_required',
    });
  return r;
};

async function loadCampaign(db: Queryable, id: string, forUpdate = false): Promise<CampaignRow> {
  const c = (
    await db.query<CampaignRow>(
      `SELECT ${CAMPAIGN_COLS} FROM ad_campaigns WHERE id = $1${forUpdate ? ' FOR UPDATE' : ''}`,
      [id],
    )
  ).rows[0];
  if (!c) throw notFound('Campaign');
  return c;
}

export async function reviewQueue(
  db: Queryable,
  status: 'pending_review' | 'active' | 'paused' | 'rejected' = 'pending_review',
) {
  const { rows } = await db.query<CampaignRow & { advertiser: string | null; ad_count: number }>(
    `SELECT ${CAMPAIGN_COLS.split(', ')
      .map((c) => `c.${c}`)
      .join(
        ', ',
      )}, COALESCE(b.name, p.display_name) AS advertiser, (SELECT count(*)::int FROM advertisements a WHERE a.campaign_id = c.id) AS ad_count
       FROM ad_campaigns c LEFT JOIN businesses b ON b.id = c.business_id LEFT JOIN profiles p ON p.user_id = c.owner_user_id
      WHERE c.status = $1 ORDER BY c.submitted_at NULLS LAST, c.created_at LIMIT 100`,
    [status],
  );
  return {
    items: rows.map((c) => campaignView(c, { advertiser: c.advertiser, adCount: c.ad_count })),
  };
}

export async function staffCampaignDetail(db: Queryable, id: string) {
  const c = await loadCampaign(db, id);
  const ads = (
    await db.query<AdRow>(
      `SELECT ${AD_COLS} FROM advertisements WHERE campaign_id = $1 ORDER BY created_at`,
      [id],
    )
  ).rows;
  const events = (
    await db.query<{
      id: string;
      event: string;
      from_status: string | null;
      to_status: string | null;
      reason: string | null;
      ad_id: string | null;
      actor_id: string | null;
      created_at: Date;
    }>(
      'SELECT id, event, from_status, to_status, reason, ad_id, actor_id, created_at FROM ad_review_events WHERE campaign_id = $1 ORDER BY id',
      [id],
    )
  ).rows;
  return {
    campaign: campaignView(c),
    ads: ads.map((a) => ({ ...adView(a), reviewNote: a.review_note })),
    history: events.map((e) => ({
      id: e.id,
      event: e.event,
      from: e.from_status,
      to: e.to_status,
      reason: e.reason,
      adId: e.ad_id,
      actorId: e.actor_id,
      at: e.created_at.toISOString(),
    })),
  };
}

/** Approve or reject a submitted campaign, with reasons, per-ad decisions, an event trail and an audit entry. */
export async function reviewCampaign(
  ctx: AppContext,
  staff: AuthContext,
  id: string,
  b: z.infer<typeof reviewBody>,
  req?: FastifyRequest,
): Promise<CampaignRow> {
  const res = await withTransaction(ctx.db, async (tx) => {
    const c = await loadCampaign(tx, id, true);
    await assertNoConflict(tx, c, staff.userId);
    if (c.status !== 'pending_review')
      throw conflict(`This campaign is ${c.status.replace('_', ' ')}, not waiting for review`, {
        reason: 'invalid_state',
        status: c.status,
      });
    const ads = (
      await tx.query<AdRow>(
        `SELECT ${AD_COLS} FROM advertisements WHERE campaign_id = $1 AND status = 'pending_review' FOR UPDATE`,
        [id],
      )
    ).rows;
    const byAd = new Map(b.ads.map((a) => [a.adId, a]));
    for (const a of b.ads)
      if (!ads.some((x) => x.id === a.adId))
        throw new AppError('unprocessable', 'That ad is not waiting for review in this campaign', {
          reason: 'unknown_ad',
          adId: a.adId,
        });
    let to: 'active' | 'rejected';
    let note: string | null;
    let approved = 0;
    if (b.decision === 'reject') {
      to = 'rejected';
      note = need(b.reason, 'reject a campaign');
    } else {
      // Defence in depth: whatever was stored must still satisfy today's targeting policy.
      const t = validateTargeting(c.targeting);
      if (!t.ok)
        throw new AppError('unprocessable', 'The campaign targeting violates policy', {
          reason: 'targeting_not_allowed',
          issues: t.issues,
        });
      to = 'active';
      note = b.reason ?? null;
    }
    for (const a of ads) {
      const d = byAd.get(a.id);
      const approve = b.decision === 'approve' && (d?.decision ?? 'approve') === 'approve';
      const why = approve
        ? null
        : need(d?.reason ?? (b.decision === 'reject' ? b.reason : undefined), 'reject an ad');
      await tx.query(
        `UPDATE advertisements SET status = $2, moderation_status = $3, review_note = $4, reviewed_by = $5, reviewed_at = now() WHERE id = $1`,
        [
          a.id,
          approve ? 'approved' : 'rejected',
          approve ? 'approved' : 'removed',
          why,
          staff.userId,
        ],
      );
      await tx.query(
        'INSERT INTO ad_review_events (campaign_id, ad_id, actor_id, event, from_status, to_status, reason) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [
          id,
          a.id,
          staff.userId,
          approve ? 'ad_approved' : 'ad_rejected',
          'pending_review',
          approve ? 'approved' : 'rejected',
          why,
        ],
      );
      if (approve) approved += 1;
    }
    if (b.decision === 'approve' && approved === 0)
      throw new AppError('unprocessable', 'Approve at least one ad, or reject the campaign', {
        reason: 'no_approved_ads',
      });
    const moved = await moveCampaign(
      ctx,
      tx,
      c,
      to,
      { id: staff.userId, type: 'staff' },
      note,
      req,
    );
    await tx.query(
      'UPDATE ad_campaigns SET reviewed_by = $2, reviewed_at = now(), review_note = $3 WHERE id = $1',
      [id, staff.userId, note],
    );
    return { moved: { ...moved, review_note: note }, c };
  });
  const owner = await advertiserUser(ctx.db, res.c);
  if (owner)
    await notify(ctx, {
      userId: owner,
      kind: b.decision === 'approve' ? 'ads_campaign_approved' : 'ads_campaign_rejected',
      actorId: null,
      targetType: 'ad_campaign',
      targetId: id,
      data: { name: res.c.name, reason: b.decision === 'reject' ? b.reason : undefined },
    });
  return res.moved;
}

/** Review one ad on its own: newly added ads of a running campaign, or a takedown of an approved one. */
export async function reviewAd(
  ctx: AppContext,
  staff: AuthContext,
  adId: string,
  b: z.infer<typeof adReviewBody>,
  req?: FastifyRequest,
): Promise<AdRow> {
  const out = await withTransaction(ctx.db, async (tx) => {
    const a = (
      await tx.query<AdRow>(`SELECT ${AD_COLS} FROM advertisements WHERE id = $1 FOR UPDATE`, [
        adId,
      ])
    ).rows[0];
    if (!a) throw notFound('Ad');
    const c = await loadCampaign(tx, a.campaign_id);
    await assertNoConflict(tx, c, staff.userId);
    if (b.decision === 'approve') {
      if (a.status !== 'pending_review')
        throw conflict(`This ad is ${a.status.replace('_', ' ')}, not waiting for review`, {
          reason: 'invalid_state',
          status: a.status,
        });
      if (c.status !== 'active' && c.status !== 'paused')
        throw conflict('Review the whole campaign first', {
          reason: 'campaign_not_reviewed',
          status: c.status,
        });
    } else if (a.status !== 'pending_review' && a.status !== 'approved')
      throw conflict(`This ad is ${a.status.replace('_', ' ')}`, {
        reason: 'invalid_state',
        status: a.status,
      });
    const why = b.decision === 'reject' ? need(b.reason, 'reject an ad') : (b.reason ?? null);
    const to = b.decision === 'approve' ? 'approved' : 'rejected';
    const { rows } = await tx.query<AdRow>(
      `UPDATE advertisements SET status = $2, moderation_status = $3, review_note = $4, reviewed_by = $5, reviewed_at = now() WHERE id = $1 RETURNING ${AD_COLS}`,
      [adId, to, to === 'approved' ? 'approved' : 'removed', why, staff.userId],
    );
    await tx.query(
      'INSERT INTO ad_review_events (campaign_id, ad_id, actor_id, event, from_status, to_status, reason) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [c.id, adId, staff.userId, `ad_${to}`, a.status, to, why],
    );
    await audit(
      ctx,
      {
        actorId: staff.userId,
        actorType: 'staff',
        action: `ads.ad_${to}`,
        targetType: 'advertisement',
        targetId: adId,
        metadata: { campaignId: c.id, from: a.status, reason: why },
      },
      req,
      tx,
    );
    return { ad: rows[0]!, c };
  });
  const owner = await advertiserUser(ctx.db, out.c);
  if (owner)
    await notify(ctx, {
      userId: owner,
      kind: b.decision === 'approve' ? 'ads_ad_approved' : 'ads_ad_rejected',
      targetType: 'advertisement',
      targetId: adId,
      data: { reason: b.decision === 'reject' ? b.reason : undefined },
    });
  return out.ad;
}

/** Take a running campaign off air (policy, complaints, fraud). The owner cannot resume it; staff reinstate it. */
export async function suspendCampaign(
  ctx: AppContext,
  staff: AuthContext,
  id: string,
  why: string,
  req?: FastifyRequest,
): Promise<CampaignRow> {
  const out = await withTransaction(ctx.db, async (tx) => {
    const c = await loadCampaign(tx, id, true);
    await assertNoConflict(tx, c, staff.userId);
    if (c.status !== 'active')
      throw conflict(
        `Only an active campaign can be suspended (this one is ${c.status.replace('_', ' ')})`,
        { reason: 'invalid_state', status: c.status },
      );
    const moved = await moveCampaign(
      ctx,
      tx,
      c,
      'paused',
      { id: staff.userId, type: 'staff' },
      why,
      req,
    );
    await tx.query(
      `INSERT INTO ad_review_events (campaign_id, actor_id, event, from_status, to_status, reason) VALUES ($1,$2,'campaign_suspended','active','paused',$3)`,
      [id, staff.userId, why],
    );
    await tx.query('UPDATE ad_campaigns SET review_note = $2 WHERE id = $1', [id, why]);
    return { moved: { ...moved, review_note: why }, c };
  });
  const owner = await advertiserUser(ctx.db, out.c);
  if (owner)
    await notify(ctx, {
      userId: owner,
      kind: 'ads_campaign_suspended',
      targetType: 'ad_campaign',
      targetId: id,
      data: { name: out.c.name, reason: why },
    });
  return out.moved;
}

export async function reinstateCampaign(
  ctx: AppContext,
  staff: AuthContext,
  id: string,
  why: string,
  req?: FastifyRequest,
): Promise<CampaignRow> {
  return withTransaction(ctx.db, async (tx) => {
    const c = await loadCampaign(tx, id, true);
    await assertNoConflict(tx, c, staff.userId);
    const last = (
      await tx.query<{ event: string }>(
        `SELECT event FROM ad_review_events WHERE campaign_id = $1 AND event IN ('campaign_suspended','campaign_reinstated') ORDER BY id DESC LIMIT 1`,
        [id],
      )
    ).rows[0];
    if (c.status !== 'paused' || last?.event !== 'campaign_suspended')
      throw conflict('This campaign is not suspended', {
        reason: 'invalid_state',
        status: c.status,
      });
    const moved = await moveCampaign(
      ctx,
      tx,
      c,
      'active',
      { id: staff.userId, type: 'staff' },
      why,
      req,
    );
    await tx.query(
      `INSERT INTO ad_review_events (campaign_id, actor_id, event, from_status, to_status, reason) VALUES ($1,$2,'campaign_reinstated','paused','active',$3)`,
      [id, staff.userId, why],
    );
    return moved;
  });
}
