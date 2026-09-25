import type { FastifyInstance } from 'fastify';
import { tx } from '@yapilapi/database';
import { z } from 'zod';
import { AppError, badRequest, featureDisabled, forbidden, notFound, parse } from '../lib/errors.ts';
import type { AppContext } from '../lib/context.ts';
import { hydratePosts } from '../lib/posts.ts';
import { audit, isEnabled } from '../lib/services.ts';
import { ageOf } from '../lib/users.ts';
import { postVisibleSql } from '../lib/visibility.ts';
import { me, requireAuth } from '../plugins/auth.ts';

const FREQUENCY_CAP_PER_DAY = 3;

/**
 * Sponsored posts. An advertiser promotes one of their own public posts and
 * funds the campaign through the payment provider (the budget only exists
 * once the signed webhook marks the order paid). Ads are only served to
 * adults who opted in to advertising and have no active family link, are
 * always labelled, explain why they were shown and can be hidden.
 * Each impression is charged at the campaign's CPM, in millicents.
 */
export default async function adsModule(app: FastifyInstance, ctx: AppContext) {
  const db = ctx.db;
  const adsOn = async () => {
    if (!(await isEnabled(db, 'ADS'))) throw featureDisabled('Sponsored posts');
  };

  const dto = (r: Record<string, any>) => ({
    id: r.id,
    name: r.name,
    status: r.status,
    postId: r.post_id,
    topics: r.topics,
    locales: r.locales,
    cpmCents: r.cpm_cents,
    currency: r.currency,
    budgetCents: Math.floor(Number(r.budget_millicents) / 1000),
    spentCents: Math.ceil(Number(r.spent_millicents) / 1000),
    impressions: r.impressions,
    clicks: r.clicks,
    ctr: r.impressions ? Number(((r.clicks / r.impressions) * 100).toFixed(2)) : 0,
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    createdAt: r.created_at,
  });

  async function mine(id: string, userId: string) {
    const r = (await db.query(`SELECT * FROM ad_campaigns WHERE id = $1`, [id])).rows[0];
    if (!r) throw notFound('Campaign');
    if (r.advertiser_id !== userId) throw forbidden();
    return r;
  }

  const campaignInput = z.object({
    postId: z.string().uuid(),
    name: z.string().trim().min(1).max(80),
    topics: z.array(z.string().trim().toLowerCase().min(1).max(40)).max(10).default([]),
    locales: z.array(z.string().min(2).max(10)).max(10).default([]),
    cpmCents: z.number().int().min(100).max(10_000).default(500),
    currency: z.string().length(3).toUpperCase().default('USD'),
    startsAt: z.coerce.date().optional(),
    endsAt: z.coerce.date().optional(),
  });

  app.post('/v1/ads/campaigns', { preHandler: requireAuth, config: { rateLimit: { max: 20, timeWindow: '1 hour' } } }, async (req, reply) => {
    await adsOn();
    const u = me(req);
    const input = parse(campaignInput, req.body);
    if (input.startsAt && input.endsAt && input.endsAt <= input.startsAt) throw badRequest('The end must be after the start.');
    const post = (await db.query(`SELECT author_id, visibility, moderation_status, deleted_at FROM posts WHERE id = $1`, [input.postId])).rows[0];
    if (!post || post.deleted_at) throw notFound('Post');
    if (post.author_id !== u.id) throw forbidden('You can only promote your own posts.');
    if (post.visibility !== 'public') throw badRequest('Only public posts can be promoted.');
    if (post.moderation_status !== 'normal') throw new AppError(422, 'content_blocked', "This post can't be promoted.");
    const { rows } = await db.query(
      `INSERT INTO ad_campaigns (advertiser_id, post_id, name, topics, locales, cpm_cents, currency, starts_at, ends_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [u.id, input.postId, input.name, input.topics, input.locales, input.cpmCents, input.currency, input.startsAt ?? null, input.endsAt ?? null],
    );
    await audit(db, { actorId: u.id, action: 'ads.campaign.create', entityType: 'ad_campaign', entityId: rows[0].id });
    reply.code(201);
    return { campaign: dto(rows[0]) };
  });

  app.get('/v1/ads/campaigns', { preHandler: requireAuth }, async (req) => {
    const { rows } = await db.query(`SELECT * FROM ad_campaigns WHERE advertiser_id = $1 ORDER BY created_at DESC LIMIT 100`, [me(req).id]);
    return { items: rows.map(dto) };
  });

  app.patch('/v1/ads/campaigns/:id', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const { status } = parse(z.object({ status: z.enum(['active', 'paused', 'ended']) }), req.body);
    const c = await mine(id, u.id);
    if (c.status === 'ended' || c.status === 'rejected') throw new AppError(409, 'conflict', 'This campaign has finished.');
    if (status === 'active') {
      await adsOn();
      if (Number(c.budget_millicents) - Number(c.spent_millicents) < c.cpm_cents) throw new AppError(409, 'no_budget', 'Add budget before starting this campaign.');
    }
    const { rows } = await db.query(`UPDATE ad_campaigns SET status = $2 WHERE id = $1 RETURNING *`, [id, status]);
    await audit(db, { actorId: u.id, action: `ads.campaign.${status}`, entityType: 'ad_campaign', entityId: id });
    return { campaign: dto(rows[0]) };
  });

  /** Add budget. The money only lands on the campaign when the payment webhook confirms it. */
  app.post('/v1/ads/campaigns/:id/fund', { preHandler: requireAuth, config: { rateLimit: { max: 20, timeWindow: '1 hour' } } }, async (req, reply) => {
    await adsOn();
    if (!(await isEnabled(db, 'COMMERCE'))) throw featureDisabled('Payments');
    const u = me(req);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const input = parse(z.object({ amountCents: z.number().int().min(500).max(1_000_000), idempotencyKey: z.string().min(8).max(100) }), req.body);
    const c = await mine(id, u.id);
    if (c.status === 'ended' || c.status === 'rejected') throw new AppError(409, 'conflict', 'This campaign has finished.');
    const result = await tx(db, async (q) => {
      const { rows } = await q.query(
        `INSERT INTO orders (buyer_id, total_cents, platform_fee_cents, currency, idempotency_key, purpose, campaign_id)
         VALUES ($1,$2,$2,$3,$4,'ad_budget',$5) RETURNING id`,
        [u.id, input.amountCents, c.currency, input.idempotencyKey, id],
      );
      const orderId = rows[0].id as string;
      const intent = await ctx.payments.createIntent({ amountCents: input.amountCents, currency: c.currency, orderId, idempotencyKey: input.idempotencyKey });
      await q.query(`INSERT INTO payments (order_id, provider, provider_ref, status, amount_cents, currency) VALUES ($1,$2,$3,$4,$5,$6)`, [
        orderId,
        ctx.payments.name,
        intent.providerRef,
        intent.status,
        input.amountCents,
        c.currency,
      ]);
      return { payment: { provider: ctx.payments.name, clientSecret: intent.clientSecret, orderId } };
    });
    reply.code(201);
    return result;
  });

  app.get('/v1/ads/campaigns/:id/stats', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const c = await mine(id, u.id);
    const { rows } = await db.query(
      `SELECT date_trunc('day', created_at)::date AS day,
              count(*) FILTER (WHERE kind = 'impression') AS impressions,
              count(*) FILTER (WHERE kind = 'click') AS clicks,
              count(*) FILTER (WHERE kind = 'hide') AS hides,
              count(DISTINCT user_id) FILTER (WHERE kind = 'impression') AS reach
       FROM ad_events WHERE campaign_id = $1 AND created_at > now() - interval '30 days' GROUP BY 1 ORDER BY 1`,
      [id],
    );
    return {
      campaign: dto(c),
      days: rows.map((r) => ({ day: r.day, impressions: Number(r.impressions), clicks: Number(r.clicks), hides: Number(r.hides), reach: Number(r.reach) })),
    };
  });

  // ── Serving ───────────────────────────────────────────────────────────
  async function eligible(userId: string, birthDate: Date | null): Promise<boolean> {
    const age = ageOf(birthDate);
    if (age === null || age < 18) return false;
    const { rows } = await db.query(
      `SELECT (SELECT granted FROM consents WHERE user_id = $1 AND purpose = 'advertising') AS ads,
              EXISTS (SELECT 1 FROM family_links WHERE teen_id = $1 AND status = 'active') AS supervised`,
      [userId],
    );
    return rows[0].ads === true && !rows[0].supervised;
  }

  /** One sponsored post for the feed, or null. Charging and the impression are one statement, so a campaign never overspends. */
  app.get('/v1/ads/next', { preHandler: requireAuth, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
    const u = me(req);
    if (!(await isEnabled(db, 'ADS'))) return { ad: null };
    if (!(await eligible(u.id, u.birthDate ?? null))) return { ad: null };
    const { rows } = await db.query(
      `WITH me AS (
         SELECT (SELECT locale FROM profiles WHERE user_id = $1) AS locale,
                coalesce((SELECT array_agg(t.slug) FROM user_interests ui JOIN topics t ON t.id = ui.topic_id WHERE ui.user_id = $1), '{}') AS interests
       )
       SELECT c.id, c.post_id, c.cpm_cents, c.topics, c.locales, (c.topics && me.interests) AS topic_match
       FROM ad_campaigns c CROSS JOIN me
       JOIN posts p ON p.id = c.post_id JOIN profiles ap ON ap.user_id = p.author_id JOIN users au ON au.id = p.author_id
       WHERE c.status = 'active' AND c.advertiser_id <> $1
         AND (c.starts_at IS NULL OR c.starts_at <= now()) AND (c.ends_at IS NULL OR c.ends_at > now())
         AND c.budget_millicents - c.spent_millicents >= c.cpm_cents
         AND (cardinality(c.locales) = 0 OR split_part(me.locale, '-', 1) = ANY(c.locales))
         AND (cardinality(c.topics) = 0 OR c.topics && me.interests)
         AND p.visibility = 'public' AND p.moderation_status = 'normal' AND ${postVisibleSql('$1')}
         AND NOT EXISTS (SELECT 1 FROM ad_events e WHERE e.campaign_id = c.id AND e.user_id = $1 AND e.kind = 'hide')
         AND (SELECT count(*) FROM ad_events e WHERE e.campaign_id = c.id AND e.user_id = $1 AND e.kind = 'impression' AND e.created_at > now() - interval '1 day') < ${FREQUENCY_CAP_PER_DAY}
       ORDER BY c.cpm_cents DESC, random() LIMIT 5`,
      [u.id],
    );
    for (const cand of rows) {
      const charged = await db.query(
        `UPDATE ad_campaigns SET spent_millicents = spent_millicents + cpm_cents, impressions = impressions + 1
         WHERE id = $1 AND status = 'active' AND budget_millicents - spent_millicents >= cpm_cents RETURNING id`,
        [cand.id],
      );
      if (!charged.rowCount) continue;
      await db.query(`INSERT INTO ad_events (campaign_id, user_id, kind) VALUES ($1,$2,'impression')`, [cand.id, u.id]);
      const [post] = await hydratePosts(db, [cand.post_id], u.id);
      if (!post) continue;
      const why = ['You turned on advertising in your privacy settings.'];
      if (cand.topic_match) why.push(`It's about ${cand.topics.slice(0, 2).join(' and ')}, which you follow.`);
      if (cand.locales.length) why.push('It matches your language.');
      return { ad: { campaignId: cand.id, label: 'Sponsored', post, why } };
    }
    return { ad: null };
  });

  const campaignParam = z.object({ id: z.string().uuid() });
  for (const kind of ['click', 'hide'] as const) {
    app.post(`/v1/ads/:id/${kind}`, { preHandler: requireAuth, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
      const u = me(req);
      const { id } = parse(campaignParam, req.params);
      // Only count interactions with an ad this person was actually shown in the last day.
      const seen = await db.query(
        `SELECT 1 FROM ad_events WHERE campaign_id = $1 AND user_id = $2 AND kind = 'impression' AND created_at > now() - interval '1 day' LIMIT 1`,
        [id, u.id],
      );
      if (!seen.rowCount) throw notFound('Ad');
      const dup = await db.query(`SELECT 1 FROM ad_events WHERE campaign_id = $1 AND user_id = $2 AND kind = $3 AND created_at > now() - interval '1 day'`, [
        id,
        u.id,
        kind,
      ]);
      if (!dup.rowCount) {
        await db.query(`INSERT INTO ad_events (campaign_id, user_id, kind) VALUES ($1,$2,$3)`, [id, u.id, kind]);
        if (kind === 'click') await db.query(`UPDATE ad_campaigns SET clicks = clicks + 1 WHERE id = $1`, [id]);
      }
      return { ok: true };
    });
  }
}
