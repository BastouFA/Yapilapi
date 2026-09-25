import { z } from 'zod';
import { route } from '../../lib/route.js';
import { registerDeletionHook } from '../../lib/hooks.js';
import type { AppContext } from '../../lib/context.js';
import type { ApiModule } from '../types.js';
import { registerExportSection } from '../privacy/index.js';
import { hasConsent } from '../privacy/consent.js';
import { runAdsMaintenance } from './billing.js';
import {
  adBody,
  adPatch,
  adView,
  campaignBody,
  campaignPatch,
  campaignView,
  createAd,
  createCampaign,
  listAds,
  listCampaigns,
  loadManagedCampaign,
  patchAd,
  patchCampaign,
  removeAd,
  setCampaignState,
  submitCampaign,
} from './campaigns.js';
import { campaignReport, reportQuery } from './reports.js';
import {
  adReviewBody,
  reasonBody,
  reinstateCampaign,
  reviewAd,
  reviewBody,
  reviewCampaign,
  reviewQueue,
  staffCampaignDetail,
  suspendCampaign,
} from './review.js';
import { SPONSORED_LABEL } from './rules.js';
import { logClick, logImpression, selectAds, serveQuery, tokenBody } from './serve.js';

export { selectAds, logImpression, logClick, verifyToken, signToken } from './serve.js';
export { settleAdSpend, runAdsMaintenance } from './billing.js';
export { validateTargeting } from './rules.js';

const STAFF = ['moderator', 'admin', 'superadmin'] as const;
const idParams = z.object({ id: z.uuid() });
const adParams = z.object({ id: z.uuid(), adId: z.uuid() });
const R = { limit: 240, windowSec: 600, by: 'user' } as const;
const W = { limit: 90, windowSec: 600, by: 'user' } as const;
const SERVE = { limit: 120, windowSec: 60, by: 'user' } as const;

export const adsModule: ApiModule = {
  name: 'ads',
  register(app, ctx: AppContext) {
    registerExportSection({
      key: 'advertising',
      description: 'Ads you saw or clicked (which ad, where, when) and the campaigns you run',
      collect: async (_c, db, u) => ({
        impressions: (
          await db.query(
            'SELECT ad_id, placement, valid, created_at FROM ad_impressions WHERE viewer_id = $1 ORDER BY created_at DESC LIMIT 5000',
            [u],
          )
        ).rows,
        clicks: (
          await db.query(
            'SELECT ad_id, valid, created_at FROM ad_clicks WHERE viewer_id = $1 ORDER BY created_at DESC LIMIT 5000',
            [u],
          )
        ).rows,
        campaigns: (
          await db.query(
            'SELECT id, name, objective, status, daily_budget_cents, total_budget_cents, spent_cents, currency, targeting, created_at FROM ad_campaigns WHERE owner_user_id = $1',
            [u],
          )
        ).rows,
      }),
    });
    registerDeletionHook(async (_c, tx, userId) => {
      // Billing needs the counts, not the person: unlink the viewer from what they saw, and stop the campaigns they ran as themselves.
      await tx.query(
        'UPDATE ad_impressions SET viewer_id = NULL, ip_hash = NULL WHERE viewer_id = $1',
        [userId],
      );
      await tx.query('UPDATE ad_clicks SET viewer_id = NULL, ip_hash = NULL WHERE viewer_id = $1', [
        userId,
      ]);
      await tx.query(
        `UPDATE ad_campaigns SET status = 'ended' WHERE owner_user_id = $1 AND status IN ('draft','pending_review','active','paused','rejected')`,
        [userId],
      );
    });

    // ================================================================== advertisers
    route(app, ctx, {
      method: 'POST',
      url: '/v1/ads/campaigns',
      summary:
        'Create an ad campaign (draft) for a business I run, or as myself if I am an active creator. Adults only; contextual/interest/geo targeting only',
      tags: ['ads'],
      auth: 'user',
      body: campaignBody,
      rateLimit: W,
      handler: async ({ auth, req, reply, body }) => {
        const c = await createCampaign(ctx, auth, body, req);
        void reply.code(201);
        return campaignView(c, { ads: [] });
      },
    });
    route(app, ctx, {
      method: 'GET',
      url: '/v1/ads/campaigns',
      summary: 'My campaigns (and those of businesses I run)',
      tags: ['ads'],
      auth: 'user',
      query: z.object({
        status: z
          .enum(['draft', 'pending_review', 'active', 'paused', 'ended', 'rejected'])
          .optional(),
        businessId: z.uuid().optional(),
      }),
      rateLimit: R,
      handler: async ({ auth, query }) => listCampaigns(ctx, auth.userId, query),
    });
    route(app, ctx, {
      method: 'GET',
      url: '/v1/ads/campaigns/:id',
      summary: 'One campaign with its ads',
      tags: ['ads'],
      auth: 'user',
      params: idParams,
      rateLimit: R,
      handler: async ({ auth, params }) => {
        const c = await loadManagedCampaign(ctx.db, params.id, auth.userId);
        return campaignView(c, { ads: (await listAds(ctx.db, c.id)).map(adView) });
      },
    });
    route(app, ctx, {
      method: 'PATCH',
      url: '/v1/ads/campaigns/:id',
      summary:
        'Edit a draft, rejected or paused campaign (changes to targeting or bid on an approved campaign need a new review)',
      tags: ['ads'],
      auth: 'user',
      params: idParams,
      body: campaignPatch,
      rateLimit: W,
      handler: async ({ auth, req, params, body }) =>
        campaignView(await patchCampaign(ctx, auth, params.id, body, req)),
    });
    route(app, ctx, {
      method: 'POST',
      url: '/v1/ads/campaigns/:id/submit',
      summary: 'Submit for staff review',
      tags: ['ads'],
      auth: 'user',
      params: idParams,
      rateLimit: W,
      handler: async ({ auth, req, params }) =>
        campaignView(await submitCampaign(ctx, auth, params.id, req)),
    });
    for (const action of ['pause', 'resume', 'end'] as const) {
      route(app, ctx, {
        method: 'POST',
        url: `/v1/ads/campaigns/:id/${action}`,
        summary: `${action[0]!.toUpperCase()}${action.slice(1)} a campaign`,
        tags: ['ads'],
        auth: 'user',
        params: idParams,
        rateLimit: W,
        handler: async ({ auth, req, params }) =>
          campaignView(await setCampaignState(ctx, auth, params.id, action, req)),
      });
    }
    route(app, ctx, {
      method: 'POST',
      url: '/v1/ads/campaigns/:id/ads',
      summary: 'Add an ad (creative + destination) to a campaign',
      tags: ['ads'],
      auth: 'user',
      params: idParams,
      body: adBody,
      rateLimit: W,
      handler: async ({ auth, req, reply, params, body }) => {
        const a = await createAd(ctx, auth, params.id, body, req);
        void reply.code(201);
        return adView(a);
      },
    });
    route(app, ctx, {
      method: 'PATCH',
      url: '/v1/ads/campaigns/:id/ads/:adId',
      summary: 'Edit a draft or rejected ad',
      tags: ['ads'],
      auth: 'user',
      params: adParams,
      body: adPatch,
      rateLimit: W,
      handler: async ({ auth, req, params, body }) =>
        adView(await patchAd(ctx, auth, params.id, params.adId, body, req)),
    });
    route(app, ctx, {
      method: 'DELETE',
      url: '/v1/ads/campaigns/:id/ads/:adId',
      summary: 'Remove an ad (deleted if it never ran, otherwise paused for good)',
      tags: ['ads'],
      auth: 'user',
      params: adParams,
      rateLimit: W,
      handler: async ({ auth, req, params }) => {
        await removeAd(ctx, auth, params.id, params.adId, req);
      },
    });
    route(app, ctx, {
      method: 'GET',
      url: '/v1/ads/campaigns/:id/report',
      summary:
        'Advertiser report: impressions, clicks, spend, filtered traffic, by day/ad/placement (aggregates only)',
      tags: ['ads'],
      auth: 'user',
      params: idParams,
      query: reportQuery,
      rateLimit: R,
      handler: async ({ auth, params, query }) =>
        campaignReport(ctx.db, auth.userId, params.id, query.days),
    });

    // ================================================================== serving (viewers)
    route(app, ctx, {
      method: 'GET',
      url: '/v1/ads/serve',
      summary:
        'Ads for a placement. Adults who are signed in only; every ad is labelled Sponsored; interests are used only with advertising consent',
      tags: ['ads'],
      auth: 'user',
      query: serveQuery,
      rateLimit: SERVE,
      handler: async ({ auth, query }) => {
        const items = await selectAds(ctx, auth.userId, query.placement, query.n, {
          topics: query.topics,
          language: query.language,
          country: query.country,
          city: query.city,
        });
        return {
          label: SPONSORED_LABEL,
          personalized: await hasConsent(ctx, auth.userId, 'advertising'),
          items,
        };
      },
    });
    route(app, ctx, {
      method: 'POST',
      url: '/v1/ads/impressions',
      summary:
        'Report that a served ad was shown (idempotent per token). Invalid traffic is recorded but never billed',
      tags: ['ads'],
      auth: 'user',
      body: tokenBody,
      rateLimit: { limit: 300, windowSec: 60, by: 'user' },
      handler: async ({ auth, req, body }) => {
        const r = await logImpression(ctx, auth.userId, body.token, {
          ip: req.clientIp,
          userAgent: req.headers['user-agent'] ?? null,
        });
        return { recorded: r.recorded, duplicate: r.duplicate, valid: r.valid };
      },
    });
    route(app, ctx, {
      method: 'POST',
      url: '/v1/ads/clicks',
      summary: 'Report a click on a served ad (needs its impression) and get the destination',
      tags: ['ads'],
      auth: 'user',
      body: tokenBody,
      rateLimit: { limit: 120, windowSec: 60, by: 'user' },
      handler: async ({ auth, req, body }) => {
        const r = await logClick(
          ctx,
          auth.userId,
          body.token,
          { ip: req.clientIp, userAgent: req.headers['user-agent'] ?? null },
          req,
        );
        return {
          recorded: r.recorded,
          duplicate: r.duplicate,
          valid: r.valid,
          redirectTo: r.redirectTo,
        };
      },
    });

    // ================================================================== staff review
    route(app, ctx, {
      method: 'GET',
      url: '/v1/staff/ads/campaigns',
      summary: 'Staff: campaigns by status (default: waiting for review)',
      tags: ['ads', 'staff'],
      auth: { staff: STAFF },
      query: z.object({
        status: z
          .enum(['pending_review', 'active', 'paused', 'rejected'])
          .default('pending_review'),
      }),
      rateLimit: R,
      handler: async ({ query }) => reviewQueue(ctx.db, query.status),
    });
    route(app, ctx, {
      method: 'GET',
      url: '/v1/staff/ads/campaigns/:id',
      summary: 'Staff: a campaign with its ads and review history',
      tags: ['ads', 'staff'],
      auth: { staff: STAFF },
      params: idParams,
      rateLimit: R,
      handler: async ({ params }) => staffCampaignDetail(ctx.db, params.id),
    });
    route(app, ctx, {
      method: 'POST',
      url: '/v1/staff/ads/campaigns/:id/review',
      summary:
        'Staff: approve or reject a submitted campaign (reasons mandatory for rejections; per-ad decisions; audited)',
      tags: ['ads', 'staff'],
      auth: { staff: STAFF },
      params: idParams,
      body: reviewBody,
      rateLimit: W,
      handler: async ({ auth, req, params, body }) =>
        campaignView(await reviewCampaign(ctx, auth, params.id, body, req)),
    });
    route(app, ctx, {
      method: 'POST',
      url: '/v1/staff/ads/ads/:id/review',
      summary: 'Staff: approve or reject one ad (new ads of a running campaign, or a takedown)',
      tags: ['ads', 'staff'],
      auth: { staff: STAFF },
      params: idParams,
      body: adReviewBody,
      rateLimit: W,
      handler: async ({ auth, req, params, body }) =>
        adView(await reviewAd(ctx, auth, params.id, body, req)),
    });
    route(app, ctx, {
      method: 'POST',
      url: '/v1/staff/ads/campaigns/:id/suspend',
      summary:
        'Staff: take an active campaign off air (reason mandatory; the advertiser cannot resume it)',
      tags: ['ads', 'staff'],
      auth: { staff: STAFF },
      params: idParams,
      body: reasonBody,
      rateLimit: W,
      handler: async ({ auth, req, params, body }) =>
        campaignView(await suspendCampaign(ctx, auth, params.id, body.reason, req)),
    });
    route(app, ctx, {
      method: 'POST',
      url: '/v1/staff/ads/campaigns/:id/reinstate',
      summary: 'Staff: put a suspended campaign back on air',
      tags: ['ads', 'staff'],
      auth: { staff: STAFF },
      params: idParams,
      body: reasonBody,
      rateLimit: W,
      handler: async ({ auth, req, params, body }) =>
        campaignView(await reinstateCampaign(ctx, auth, params.id, body.reason, req)),
    });
    route(app, ctx, {
      method: 'POST',
      url: '/v1/staff/ads/maintenance',
      summary:
        'Staff: run the ads maintenance job once (end finished campaigns, settle spend to the ledger)',
      tags: ['ads', 'staff'],
      auth: { staff: ['admin', 'superadmin'] },
      rateLimit: W,
      handler: async () => runAdsMaintenance(ctx),
    });
  },
};
