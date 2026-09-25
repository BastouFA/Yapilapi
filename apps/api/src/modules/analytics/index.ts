import { z } from 'zod';
import type { ApiModule } from '../types.js';
import { route } from '../../lib/route.js';
import { adminRoute } from '../admin/rbac.js';
import { section } from '../admin/ops.js';
import { hasConsent } from '../privacy/consent.js';
import { ANON_ID_RE, clientEventCatalog, validateEvent } from './events.js';
import * as q from './queries.js';

export { track, purgeOldAnalytics } from './track.js';
export { validateEvent, CLIENT_EVENTS, SERVER_EVENTS } from './events.js';
export * from './msa.js';

const MAX_EVENTS_PER_REQUEST = 20;

const ingestBody = z.object({
  platform: z.enum(['web', 'ios', 'android']).default('web'),
  /** Random client-generated id for people who are not signed in. Ignored (never stored) for signed-in users. */
  anonId: z.string().max(100).optional(),
  events: z
    .array(
      z.object({
        name: z.string().max(64),
        properties: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .min(1)
    .max(MAX_EVENTS_PER_REQUEST),
});

const days = z.coerce.number().int().min(1).max(365).default(30);
const weeks = z.coerce.number().int().min(1).max(12).default(8);
const msaWeeks = z.coerce.number().int().min(1).max(12).default(4);

export const analyticsModule: ApiModule = {
  name: 'analytics',
  register(app, ctx) {
    route(app, ctx, {
      method: 'GET',
      url: '/v1/analytics/events/schema',
      summary: 'The complete allowlist of analytics events a client may send',
      tags: ['analytics'],
      auth: 'public',
      handler: () => ({
        maxEventsPerRequest: MAX_EVENTS_PER_REQUEST,
        rules: [
          'Nothing is sent unless the person consented (signed in: the analytics consent; signed out: the x-analytics-consent: 1 header set by your consent banner).',
          'Do Not Track (DNT: 1) and Global Privacy Control (Sec-GPC: 1) are honoured: events are discarded.',
          'Teen accounts never send analytics.',
          'No free text, names, ids or URLs: every property is an enum, boolean or bounded number and unknown keys are rejected.',
          'Timestamps are set by the server.',
        ],
        events: clientEventCatalog(),
      }),
    });

    route(app, ctx, {
      method: 'POST',
      url: '/v1/analytics/events',
      summary: 'Send a batch of consented, allowlisted product analytics events',
      tags: ['analytics'],
      auth: 'optional',
      body: ingestBody,
      rateLimit: { limit: 120, windowSec: 60, by: 'user' },
      handler: async ({ req, reply, auth, body }) => {
        const discard = (why: string) =>
          reply.code(202).send({ accepted: 0, rejected: [], discarded: why });
        // 1. Do Not Track / Global Privacy Control win over everything, including consent.
        if (req.headers.dnt === '1' || req.headers['sec-gpc'] === '1')
          return discard('do_not_track');

        // 2. Consent. Signed-in: the account's latest analytics consent (teens can never have it). Signed-out: the client
        //    asserts consent from its own banner and must send a random anonymous id.
        let userId: string | null = null;
        let anonId: string | null = null;
        if (auth) {
          if (auth.ageBand !== 'adult' || !(await hasConsent(ctx, auth.userId, 'analytics')))
            return discard('no_consent');
          userId = auth.userId;
        } else {
          if (req.headers['x-analytics-consent'] !== '1') return discard('no_consent');
          if (!body.anonId || !ANON_ID_RE.test(body.anonId)) return discard('invalid_anon_id');
          anonId = body.anonId;
        }

        // 3. Allowlist validation, event by event.
        const ok: Array<{ name: string; props: Record<string, unknown> }> = [];
        const rejected: Array<{ index: number; name: string; reason: string }> = [];
        body.events.forEach((e, index) => {
          const v = validateEvent(e.name, e.properties ?? {}, 'client');
          if (v.ok) ok.push({ name: v.name, props: v.props });
          else rejected.push({ index, name: e.name.slice(0, 64), reason: v.reason });
        });

        if (ok.length) {
          await ctx.db.query(
            `INSERT INTO analytics_events (user_id, anon_id, name, properties, platform, source)
             SELECT $1, $2, e.name, e.props, $3, 'client' FROM jsonb_to_recordset($4::jsonb) AS e(name text, props jsonb)`,
            [userId, anonId, body.platform, JSON.stringify(ok)],
          );
          ctx.metrics.events.inc({ name: 'analytics_client_batch' }, ok.length);
        }
        return reply.code(202).send({ accepted: ok.length, rejected });
      },
    });

    // ------------------------------------------------------------------ staff aggregates (admin and above)
    const tag = ['admin', 'analytics'];
    adminRoute(app, ctx, 'analytics.read', {
      method: 'GET',
      url: '/v1/admin/analytics/acquisition',
      summary: 'Signups, onboarding completion and funnel (aggregates)',
      tags: tag,
      query: z.object({ days }),
      handler: async ({ query }) =>
        section(ctx, 'acquisition', () => q.acquisition(ctx, query.days)),
    });
    adminRoute(app, ctx, 'analytics.read', {
      method: 'GET',
      url: '/v1/admin/analytics/engagement',
      summary: 'DAU / WAU / MAU by write action (aggregates)',
      tags: tag,
      query: z.object({ days }),
      handler: async ({ query }) => section(ctx, 'engagement', () => q.engagement(ctx, query.days)),
    });
    adminRoute(app, ctx, 'analytics.read', {
      method: 'GET',
      url: '/v1/admin/analytics/retention',
      summary: 'Weekly signup cohorts and retention (aggregates)',
      tags: tag,
      query: z.object({ weeks }),
      handler: async ({ query }) => section(ctx, 'retention', () => q.retention(ctx, query.weeks)),
    });
    adminRoute(app, ctx, 'analytics.read', {
      method: 'GET',
      url: '/v1/admin/analytics/msa',
      summary: 'Meaningful Social Actions and Meaningful Weekly Participants (aggregates)',
      tags: tag,
      query: z.object({ weeks: msaWeeks }),
      handler: async ({ query }) => section(ctx, 'msa', () => q.msa(ctx, query.weeks)),
    });
    adminRoute(app, ctx, 'analytics.read', {
      method: 'GET',
      url: '/v1/admin/analytics/creators',
      summary: 'Creator programme aggregates',
      tags: tag,
      query: z.object({ days }),
      handler: async ({ query }) => section(ctx, 'creators', () => q.creators(ctx, query.days)),
    });
    adminRoute(app, ctx, 'analytics.read', {
      method: 'GET',
      url: '/v1/admin/analytics/commerce',
      summary: 'Order and GMV aggregates',
      tags: tag,
      query: z.object({ days }),
      handler: async ({ query }) => section(ctx, 'commerce', () => q.commerce(ctx, query.days)),
    });
    adminRoute(app, ctx, 'analytics.read', {
      method: 'GET',
      url: '/v1/admin/analytics/safety',
      summary: 'Trust and safety aggregates (reports, cases, appeals, time to decision)',
      tags: tag,
      query: z.object({ days }),
      handler: async ({ query }) => section(ctx, 'safety', () => q.safety(ctx, query.days)),
    });
    adminRoute(app, ctx, 'analytics.read', {
      method: 'GET',
      url: '/v1/admin/analytics/technical',
      summary: 'Web vitals p75 and client errors (consented client events)',
      tags: tag,
      query: z.object({ days }),
      handler: async ({ query }) => section(ctx, 'technical', () => q.technical(ctx, query.days)),
    });
  },
};
