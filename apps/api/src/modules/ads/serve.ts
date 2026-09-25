import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { withTransaction, type Queryable } from '@yapilapi/database';
import { hashIp } from '@yapilapi/security';
import { AppError, conflict, invalid } from '@yapilapi/shared';
import type { AppContext } from '../../lib/context.js';
import { hasConsent } from '../privacy/consent.js';
import {
  PLACEMENTS,
  SPONSORED_LABEL,
  clickCostMilli,
  clickVerdict,
  dayFraction,
  ecpmCents,
  frequencyAllows,
  impressionCostMilli,
  impressionVerdict,
  matchTargeting,
  paceAllowsSpend,
  rankValue,
  smoothedCtr,
  utcDay,
  withinSchedule,
  type BidModel,
  type InvalidReason,
  type Placement,
  type Targeting,
} from './rules.js';

// ------------------------------------------------------------------ impression tokens (server-issued, HMAC-signed, bound to the viewer)
interface TokenPayload {
  a: string;
  n: string;
  v: string;
  p: Placement;
  t: number;
}
const tokenKey = (ctx: AppContext) =>
  createHmac('sha256', ctx.config.dataEncryptionKey).update('yapilapi:ads:token:v1').digest();
const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64url');
export function signToken(ctx: AppContext, p: TokenPayload): string {
  const body = b64(JSON.stringify(p));
  return `${body}.${b64(createHmac('sha256', tokenKey(ctx)).update(body).digest())}`;
}
export function verifyToken(ctx: AppContext, token: string): TokenPayload | null {
  const [body, sig, extra] = token.split('.');
  if (!body || !sig || extra !== undefined) return null;
  const want = createHmac('sha256', tokenKey(ctx)).update(body).digest();
  let got: Buffer;
  try {
    got = Buffer.from(sig, 'base64url');
  } catch {
    return null;
  }
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as TokenPayload;
    return typeof p.a === 'string' &&
      typeof p.n === 'string' &&
      typeof p.v === 'string' &&
      typeof p.t === 'number' &&
      (PLACEMENTS as readonly string[]).includes(p.p)
      ? p
      : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ selection
export const serveQuery = z.object({
  placement: z.enum(PLACEMENTS),
  n: z.coerce.number().int().min(1).max(3).default(1),
  /** Topics of the page the ad appears next to (contextual targeting). */
  topics: z
    .string()
    .trim()
    .max(400)
    .optional()
    .transform((s) =>
      s
        ? s
            .split(',')
            .map((x) => x.trim().toLowerCase())
            .filter((x) => /^[a-z0-9-]{2,40}$/.test(x))
            .slice(0, 10)
        : [],
    ),
  language: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z]{2,3}$/)
    .optional(),
  country: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{2}$/)
    .optional(),
  city: z.string().trim().max(60).optional(),
});
export interface ServeContext {
  topics?: readonly string[];
  language?: string | null | undefined;
  country?: string | null | undefined;
  city?: string | null | undefined;
}

interface Candidate {
  ad_id: string;
  headline: string;
  body: string;
  media_id: string | null;
  target_type: string | null;
  target_id: string | null;
  target_url: string | null;
  campaign_id: string;
  targeting: Targeting;
  bid_model: BidModel;
  bid_cents: number;
  frequency_cap: number;
  total_budget_cents: string;
  daily_budget_cents: string;
  spent_milli: string;
  starts_at: Date | null;
  ends_at: Date | null;
  advertiser: string | null;
  advertiser_kind: 'business' | 'creator';
  recent: number;
  spent_today: string;
  imps: string;
  clicks: string;
}
export interface ServedAd {
  adId: string;
  campaignId: string;
  sponsored: true;
  label: string;
  advertiser: { name: string | null; kind: 'business' | 'creator' };
  headline: string;
  body: string;
  mediaId: string | null;
  target: { type: string; id: string | null; url: string | null } | null;
  placement: Placement;
  impressionToken: string;
  whyThisAd: string[];
}

/**
 * Choose up to `n` ads for a viewer. Rules, in order: adults only (no ads for teens), viewer active; ad approved, campaign active and inside its schedule,
 * advertiser account active; never the viewer's own ads or those of someone they blocked (either way); language/geo/topic targeting; interests ONLY with
 * advertising consent (contextual targeting works without); per-viewer frequency cap; total and daily budget with even pacing; one ad per campaign; highest expected
 * revenue first. Nothing is recorded here: impressions are logged when the client reports the ad was actually shown.
 */
export async function selectAds(
  ctx: AppContext,
  viewerId: string,
  placement: Placement,
  n: number,
  sc: ServeContext = {},
  now: Date = new Date(),
): Promise<ServedAd[]> {
  const viewer = (
    await ctx.db.query<{ age_band: string; status: string }>(
      'SELECT age_band, status FROM users WHERE id = $1 AND deleted_at IS NULL',
      [viewerId],
    )
  ).rows[0];
  if (!viewer || viewer.age_band !== 'adult' || viewer.status !== 'active') return [];
  const consent = await hasConsent(ctx, viewerId, 'advertising');
  const interests = consent
    ? (
        await ctx.db.query<{ slug: string }>(
          'SELECT t.slug::text FROM user_interests ui JOIN topics t ON t.id = ui.topic_id WHERE ui.user_id = $1',
          [viewerId],
        )
      ).rows.map((r) => r.slug)
    : [];
  const { rows } = await ctx.db.query<Candidate>(
    `SELECT a.id AS ad_id, a.headline, a.body, a.media_id, a.target_type, a.target_id, a.target_url, c.id AS campaign_id, c.targeting, c.bid_model, c.bid_cents, c.frequency_cap,
            c.total_budget_cents, c.daily_budget_cents, c.spent_milli, c.starts_at, c.ends_at,
            COALESCE(b.name, p.display_name) AS advertiser, CASE WHEN c.business_id IS NULL THEN 'creator' ELSE 'business' END AS advertiser_kind,
            (SELECT count(*)::int FROM ad_impressions i WHERE i.viewer_id = $1 AND i.ad_id = a.id AND i.valid AND i.created_at > $3::timestamptz - interval '24 hours') AS recent,
            COALESCE((SELECT d.spent_milli FROM ad_daily_spend d WHERE d.campaign_id = c.id AND d.day = $4::date), 0) AS spent_today,
            (SELECT count(*) FROM ad_impressions i WHERE i.ad_id = a.id AND i.valid) AS imps, (SELECT count(*) FROM ad_clicks k WHERE k.ad_id = a.id AND k.valid) AS clicks
       FROM advertisements a JOIN ad_campaigns c ON c.id = a.campaign_id
       LEFT JOIN businesses b ON b.id = c.business_id AND b.deleted_at IS NULL LEFT JOIN profiles p ON p.user_id = c.owner_user_id
      WHERE a.status = 'approved' AND a.moderation_status = 'approved' AND a.placement = $2 AND c.status = 'active'
        AND (c.starts_at IS NULL OR c.starts_at <= $3) AND (c.ends_at IS NULL OR c.ends_at > $3)
        AND ((c.owner_user_id IS NOT NULL AND EXISTS (SELECT 1 FROM users u WHERE u.id = c.owner_user_id AND u.deleted_at IS NULL AND u.status = 'active'))
             OR (c.business_id IS NOT NULL AND b.status = 'active'))
        AND c.owner_user_id IS DISTINCT FROM $1
        AND NOT EXISTS (SELECT 1 FROM business_members m WHERE m.business_id = c.business_id AND m.user_id = $1)
        AND NOT EXISTS (SELECT 1 FROM user_blocks bl WHERE (bl.blocker_id = $1 AND bl.blocked_id = COALESCE(c.owner_user_id, b.owner_id)) OR (bl.blocker_id = COALESCE(c.owner_user_id, b.owner_id) AND bl.blocked_id = $1))
      ORDER BY c.bid_cents DESC LIMIT 300`,
    [viewerId, placement, now, utcDay(now)],
  );

  const mc = {
    contextTopics: sc.topics ?? [],
    language: sc.language ?? null,
    country: sc.country ?? null,
    city: sc.city ?? null,
    interests,
  };
  const scored: Array<{ c: Candidate; rank: number; reasons: string[] }> = [];
  for (const c of rows) {
    if (!withinSchedule(c.starts_at, c.ends_at, now)) continue;
    const m = matchTargeting(c.targeting, mc);
    if (!m.matched) continue;
    if (!frequencyAllows(c.recent, c.frequency_cap)) continue;
    const unit =
      c.bid_model === 'cpm'
        ? impressionCostMilli('cpm', c.bid_cents)
        : clickCostMilli('cpc', c.bid_cents);
    const pace = paceAllowsSpend(
      {
        totalMilli: Number(c.total_budget_cents) * 1000,
        spentMilli: Number(c.spent_milli),
        dailyMilli: Number(c.daily_budget_cents) * 1000,
        spentTodayMilli: Number(c.spent_today),
        dayFraction: dayFraction(now),
      },
      unit,
    );
    if (!pace.ok) continue;
    const ecpm = ecpmCents(c.bid_model, c.bid_cents, smoothedCtr(Number(c.clicks), Number(c.imps)));
    scored.push({ c, rank: rankValue(ecpm, m.score), reasons: m.reasons });
  }
  scored.sort((a, b) => b.rank - a.rank);
  const picked: ServedAd[] = [];
  const seen = new Set<string>();
  for (const s of scored) {
    if (picked.length >= n) break;
    if (seen.has(s.c.campaign_id)) continue;
    seen.add(s.c.campaign_id);
    const token = signToken(ctx, {
      a: s.c.ad_id,
      n: randomBytes(16).toString('base64url'),
      v: viewerId,
      p: placement,
      t: now.getTime(),
    });
    picked.push({
      adId: s.c.ad_id,
      campaignId: s.c.campaign_id,
      sponsored: true,
      label: SPONSORED_LABEL,
      advertiser: { name: s.c.advertiser, kind: s.c.advertiser_kind },
      headline: s.c.headline,
      body: s.c.body,
      mediaId: s.c.media_id,
      target: s.c.target_type
        ? { type: s.c.target_type, id: s.c.target_id, url: s.c.target_url }
        : null,
      placement,
      impressionToken: token,
      whyThisAd: s.reasons.length ? s.reasons : ['broad'],
    });
  }
  return picked;
}

export const targetPath = (
  t: ServedAd['target'] | { type: string; id: string | null; url: string | null } | null,
): string | null =>
  !t
    ? null
    : t.type === 'url'
      ? t.url
      : t.type === 'product'
        ? `/products/${t.id}`
        : t.type === 'event'
          ? `/events/${t.id}`
          : t.type === 'business'
            ? `/businesses/${t.id}`
            : null;

// ------------------------------------------------------------------ impressions
export const tokenBody = z.object({ token: z.string().min(20).max(600) });
interface EventMeta {
  ip: string;
  userAgent: string | null;
  now?: Date;
}
interface AdContext {
  ad_id: string;
  campaign_id: string;
  ad_status: string;
  campaign_status: string;
  bid_model: BidModel;
  bid_cents: number;
  frequency_cap: number;
  total_budget_cents: string;
  daily_budget_cents: string;
  spent_milli: string;
  owner_user_id: string | null;
  business_id: string | null;
  starts_at: Date | null;
  ends_at: Date | null;
}
const AD_CTX_SQL = `SELECT a.id AS ad_id, c.id AS campaign_id, a.status AS ad_status, c.status AS campaign_status, c.bid_model, c.bid_cents, c.frequency_cap, c.total_budget_cents, c.daily_budget_cents,
  c.spent_milli, c.owner_user_id, c.business_id, c.starts_at, c.ends_at FROM advertisements a JOIN ad_campaigns c ON c.id = a.campaign_id WHERE a.id = $1`;
async function isOwn(db: Queryable, c: AdContext, viewerId: string): Promise<boolean> {
  if (c.owner_user_id === viewerId) return true;
  return c.business_id
    ? (
        await db.query('SELECT 1 FROM business_members WHERE business_id = $1 AND user_id = $2', [
          c.business_id,
          viewerId,
        ])
      ).rowCount === 1
    : false;
}

/** Charge (spend) atomically and never past the total or daily budget. Returns the milli-cents actually charged (0 when the budget could not take it). */
async function charge(
  tx: Queryable,
  c: AdContext,
  costMilli: number,
  now: Date,
): Promise<'ok' | 'budget_exhausted'> {
  if (costMilli <= 0) return 'ok';
  const day = utcDay(now);
  const cur = (
    await tx.query<{ spent_milli: string; total_budget_cents: string; daily_budget_cents: string }>(
      'SELECT spent_milli, total_budget_cents, daily_budget_cents FROM ad_campaigns WHERE id = $1 FOR UPDATE',
      [c.campaign_id],
    )
  ).rows[0]!;
  const today = Number(
    (
      await tx.query<{ s: string }>(
        'SELECT COALESCE((SELECT spent_milli FROM ad_daily_spend WHERE campaign_id = $1 AND day = $2::date), 0) AS s',
        [c.campaign_id, day],
      )
    ).rows[0]!.s,
  );
  const spent = Number(cur.spent_milli);
  if (
    spent + costMilli > Number(cur.total_budget_cents) * 1000 ||
    today + costMilli > Number(cur.daily_budget_cents) * 1000
  )
    return 'budget_exhausted';
  await tx.query(
    'UPDATE ad_campaigns SET spent_milli = spent_milli + $2, spent_cents = (spent_milli + $2) / 1000 WHERE id = $1',
    [c.campaign_id, costMilli],
  );
  await tx.query(
    `INSERT INTO ad_daily_spend (campaign_id, day, spent_milli) VALUES ($1,$2::date,$3) ON CONFLICT (campaign_id, day) DO UPDATE SET spent_milli = ad_daily_spend.spent_milli + EXCLUDED.spent_milli`,
    [c.campaign_id, day, costMilli],
  );
  // Out of budget for even one more unit: the campaign ends now instead of waiting for the next serve to notice.
  const unit = c.bid_model === 'cpm' ? c.bid_cents : c.bid_cents * 1000;
  if (spent + costMilli + unit > Number(cur.total_budget_cents) * 1000)
    await tx.query(`UPDATE ad_campaigns SET status = 'ended' WHERE id = $1 AND status = 'active'`, [
      c.campaign_id,
    ]);
  return 'ok';
}

export interface ImpressionResult {
  recorded: boolean;
  duplicate: boolean;
  valid: boolean;
  reason: InvalidReason | null;
  costMilli: number;
}

/**
 * The client reports an ad was shown. Idempotent per token (unique nonce): a replay records nothing new. Invalid traffic (expired token, too fast, bots, frequency
 * cap, IP floods, the advertiser's own views, budget already spent) is kept with cost 0 so reports can show what was filtered; only valid impressions accrue spend.
 */
export async function logImpression(
  ctx: AppContext,
  viewerId: string,
  token: string,
  meta: EventMeta,
): Promise<ImpressionResult> {
  const p = verifyToken(ctx, token);
  if (!p || p.v !== viewerId)
    throw invalid('That impression token is not valid', { reason: 'invalid_token' });
  const now = meta.now ?? new Date();
  const ipHash = hashIp(meta.ip, ctx.config.IP_HASH_SALT ?? 'dev-salt');
  return withTransaction(ctx.db, async (tx) => {
    const c = (await tx.query<AdContext>(AD_CTX_SQL, [p.a])).rows[0];
    if (!c) throw invalid('That ad no longer exists', { reason: 'invalid_token' });
    const existing = await tx.query('SELECT 1 FROM ad_impressions WHERE nonce = $1', [p.n]);
    if (existing.rowCount)
      return { recorded: false, duplicate: true, valid: false, reason: null, costMilli: 0 };
    const recentForViewer = Number(
      (
        await tx.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM ad_impressions WHERE viewer_id = $1 AND ad_id = $2 AND valid AND created_at > $3::timestamptz - interval '24 hours'`,
          [viewerId, p.a, now],
        )
      ).rows[0]!.n,
    );
    const recentFromIp = Number(
      (
        await tx.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM ad_impressions WHERE ip_hash = $1 AND ad_id = $2 AND created_at > $3::timestamptz - interval '1 hour'`,
          [ipHash, p.a, now],
        )
      ).rows[0]!.n,
    );
    let reason: InvalidReason | null = impressionVerdict({
      issuedAt: new Date(p.t),
      now,
      userAgent: meta.userAgent,
      recentForViewer,
      frequencyCap: c.frequency_cap,
      recentFromIp,
      isOwnAd: await isOwn(tx, c, viewerId),
    });
    if (
      !reason &&
      (c.ad_status !== 'approved' ||
        c.campaign_status !== 'active' ||
        !withinSchedule(c.starts_at, c.ends_at, now))
    )
      reason = 'not_serving';
    let cost = 0;
    if (!reason) {
      cost = impressionCostMilli(c.bid_model, c.bid_cents);
      if ((await charge(tx, c, cost, now)) === 'budget_exhausted') {
        reason = 'budget_exhausted';
        cost = 0;
      }
    }
    // The unique nonce makes a concurrent replay fail here instead of double-charging (the transaction rolls back its charge with it).
    try {
      await tx.query(
        `INSERT INTO ad_impressions (ad_id, campaign_id, viewer_id, nonce, placement, issued_at, ip_hash, valid, reason, cost_milli, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          p.a,
          c.campaign_id,
          viewerId,
          p.n,
          p.p,
          new Date(p.t),
          ipHash,
          reason === null,
          reason,
          cost,
          now,
        ],
      );
    } catch (err) {
      if ((err as { code?: string }).code === '23505')
        throw new AppError('conflict', 'Already recorded', { reason: 'duplicate' });
      throw err;
    }
    return { recorded: true, duplicate: false, valid: reason === null, reason, costMilli: cost };
  }).catch((err) => {
    if (
      err instanceof AppError &&
      (err.details as { reason?: string } | undefined)?.reason === 'duplicate'
    )
      return {
        recorded: false,
        duplicate: true,
        valid: false,
        reason: null,
        costMilli: 0,
      } as ImpressionResult;
    throw err;
  });
}

// ------------------------------------------------------------------ clicks
export interface ClickResult extends ImpressionResult {
  redirectTo: string | null;
}
/** A click needs its impression (same token, same viewer). At most one billable click per impression (unique key); repeats just return the destination. */
export async function logClick(
  ctx: AppContext,
  viewerId: string,
  token: string,
  meta: EventMeta,
  _req?: FastifyRequest,
): Promise<ClickResult> {
  const p = verifyToken(ctx, token);
  if (!p || p.v !== viewerId)
    throw invalid('That click token is not valid', { reason: 'invalid_token' });
  const now = meta.now ?? new Date();
  const ipHash = hashIp(meta.ip, ctx.config.IP_HASH_SALT ?? 'dev-salt');
  return withTransaction(ctx.db, async (tx) => {
    const c = (
      await tx.query<
        AdContext & {
          target_type: string | null;
          target_id: string | null;
          target_url: string | null;
        }
      >(
        `SELECT x.*, a.target_type, a.target_id, a.target_url FROM (${AD_CTX_SQL}) x JOIN advertisements a ON a.id = x.ad_id`,
        [p.a],
      )
    ).rows[0];
    if (!c) throw invalid('That ad no longer exists', { reason: 'invalid_token' });
    const redirectTo = targetPath({
      type: c.target_type ?? '',
      id: c.target_id,
      url: c.target_url,
    });
    const imp = (
      await tx.query<{ id: string; valid: boolean; created_at: Date }>(
        'SELECT id, valid, created_at FROM ad_impressions WHERE nonce = $1 AND viewer_id = $2',
        [p.n, viewerId],
      )
    ).rows[0];
    if (!imp) throw conflict('Report the impression before the click', { reason: 'no_impression' });
    if ((await tx.query('SELECT 1 FROM ad_clicks WHERE impression_id = $1', [imp.id])).rowCount)
      return {
        recorded: false,
        duplicate: true,
        valid: false,
        reason: null,
        costMilli: 0,
        redirectTo,
      };
    const recentFromIp = Number(
      (
        await tx.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM ad_clicks WHERE ip_hash = $1 AND campaign_id = $2 AND created_at > $3::timestamptz - interval '1 hour'`,
          [ipHash, c.campaign_id, now],
        )
      ).rows[0]!.n,
    );
    let reason = clickVerdict({
      impressionValid: imp.valid,
      impressionAt: imp.created_at,
      now,
      userAgent: meta.userAgent,
      recentFromIp,
      isOwnAd: await isOwn(tx, c, viewerId),
    });
    if (!reason && (c.ad_status !== 'approved' || c.campaign_status !== 'active'))
      reason = 'not_serving';
    let cost = 0;
    if (!reason) {
      cost = clickCostMilli(c.bid_model, c.bid_cents);
      if ((await charge(tx, c, cost, now)) === 'budget_exhausted') {
        reason = 'budget_exhausted';
        cost = 0;
      }
    }
    const ins = await tx.query(
      `INSERT INTO ad_clicks (impression_id, ad_id, campaign_id, viewer_id, ip_hash, valid, reason, cost_milli, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (impression_id) DO NOTHING RETURNING id`,
      [imp.id, p.a, c.campaign_id, viewerId, ipHash, reason === null, reason, cost, now],
    );
    if (!ins.rowCount) throw new AppError('conflict', 'Already recorded', { reason: 'duplicate' });
    return {
      recorded: true,
      duplicate: false,
      valid: reason === null,
      reason,
      costMilli: cost,
      redirectTo,
    };
  }).catch(async (err) => {
    if (
      err instanceof AppError &&
      (err.details as { reason?: string } | undefined)?.reason === 'duplicate'
    ) {
      const c = (
        await ctx.db.query<{
          target_type: string | null;
          target_id: string | null;
          target_url: string | null;
        }>('SELECT target_type, target_id, target_url FROM advertisements WHERE id = $1', [p.a])
      ).rows[0];
      return {
        recorded: false,
        duplicate: true,
        valid: false,
        reason: null,
        costMilli: 0,
        redirectTo: c
          ? targetPath({ type: c.target_type ?? '', id: c.target_id, url: c.target_url })
          : null,
      } as ClickResult;
    }
    throw err;
  });
}
