import { z } from 'zod';
import { clampLimit, decodeCursor, encodeCursor, unauthenticated } from '@yapilapi/shared';
import { route } from '../../lib/route.js';
import { audit } from '../../lib/audit.js';
import type { ApiModule } from '../types.js';
import { adminRoute } from '../admin/rbac.js';
import { REPORT_TARGET_TYPES } from './targets.js';
import { supportResources } from './resources.js';
import {
  DECISIONS,
  REPORT_REASONS,
  claimCase,
  createAppeal,
  createReport,
  decideCase,
  escalateCase,
  getCaseDetail,
  listAppeals,
  listCases,
  listMyAppeals,
  listMyReports,
  listUserEnforcements,
  queueStats,
  releaseCase,
  reviewAppeal,
} from './service.js';
import { checkIdentity } from './impersonation.js';
import {
  acceptGuardianship,
  guardianSummary,
  inviteGuardian,
  listGuardianLinks,
  revokeGuardianLink,
} from './guardians.js';

export * from './service.js';
export { supportResources } from './resources.js';
export { checkIdentity, loadProtectedIdentities, screenProfileIdentity } from './impersonation.js';
export { REPORT_TARGET_TYPES, loadTargetForStaff, loadTargetForViewer } from './targets.js';

const idParams = z.object({ id: z.uuid() });
const pageQuery = z.object({
  cursor: z.string().max(400).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

const reportBody = z.object({
  targetType: z.enum(REPORT_TARGET_TYPES),
  targetId: z.uuid(),
  reason: z.enum(REPORT_REASONS),
  details: z.string().trim().max(2000).optional(),
});

const caseQuery = pageQuery.extend({
  state: z.enum(['normal', 'review', 'restricted', 'escalated', 'appealed', 'resolved']).optional(),
  risk: z.enum(['low', 'medium', 'high', 'critical']).optional(),
  targetType: z.enum(REPORT_TARGET_TYPES).optional(),
  source: z.enum(['user_report', 'automated', 'staff']).optional(),
  category: z.string().trim().max(40).optional(),
  assigned: z.enum(['me', 'none', 'any']).optional(),
});

const decisionBody = z.object({
  decision: z.enum(DECISIONS),
  /** Shown to the affected user: keep it factual. */
  reason: z.string().trim().min(3).max(500),
  note: z.string().trim().max(2000).optional(),
  durationDays: z.number().int().min(1).max(365).optional(),
});

const appealBody = z.object({
  caseId: z.uuid().optional(),
  enforcementId: z.uuid().optional(),
  token: z.string().min(20).max(200).optional(),
  statement: z.string().trim().min(1).max(4000),
});

const STAFF = ['moderator', 'admin', 'superadmin'] as const;

export const safetyModule: ApiModule = {
  name: 'safety',
  register(app, ctx) {
    // ================================================================== user-facing
    route(app, ctx, {
      method: 'POST',
      url: '/v1/reports',
      summary:
        'Report a user, post, comment, moment, message, community, event, product, place, business, review or live session',
      tags: ['safety'],
      auth: 'user',
      body: reportBody,
      rateLimit: { limit: 20, windowSec: 3600, by: 'user' },
      handler: async ({ auth, req, body, reply }) => {
        const r = await createReport(ctx, auth.userId, body);
        if (!r.duplicate)
          await audit(
            ctx,
            {
              actorId: auth.userId,
              action: 'report.created',
              targetType: body.targetType,
              targetId: body.targetId,
              metadata: { reason: body.reason },
            },
            req,
          );
        void reply.code(r.duplicate ? 200 : 201);
        return {
          ...r,
          message: r.duplicate
            ? 'You already reported this for the same reason.'
            : 'Thank you. Our safety team will review this.',
        };
      },
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/reports/mine',
      summary: 'My reports and their status',
      tags: ['safety'],
      auth: 'user',
      query: pageQuery,
      handler: ({ auth, query }) => listMyReports(ctx, auth.userId, query),
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/safety/enforcements',
      summary:
        'My enforcement history (warnings, removals, restrictions, suspensions) and appeal options',
      tags: ['safety'],
      auth: 'user',
      handler: async ({ auth }) => ({ items: await listUserEnforcements(ctx, auth.userId) }),
    });

    route(app, ctx, {
      method: 'POST',
      url: '/v1/appeals',
      summary:
        'Appeal a moderation decision (session, or the personal link token from the suspension email)',
      tags: ['safety'],
      auth: 'optional',
      body: appealBody,
      rateLimit: { limit: 10, windowSec: 3600 },
      handler: async ({ auth, req, body, reply }) => {
        let who: { userId: string } | { token: string };
        if (body.token) who = { token: body.token };
        else if (auth) who = { userId: auth.userId };
        else throw unauthenticated();
        const a = await createAppeal(ctx, who, body, req);
        void reply.code(201);
        return a;
      },
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/appeals/mine',
      summary: 'My appeals',
      tags: ['safety'],
      auth: 'user',
      handler: async ({ auth }) => ({ items: await listMyAppeals(ctx, auth.userId) }),
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/safety/resources',
      summary: 'Support resources for people who may be at risk (curated; needs regional review)',
      tags: ['safety'],
      auth: 'public',
      query: z.object({ region: z.string().trim().length(2).optional() }),
      handler: ({ query }) => supportResources(query.region),
    });

    // ------------------------------------------------------------------ guardians (minor safety)
    route(app, ctx, {
      method: 'POST',
      url: '/v1/safety/guardians',
      summary: 'Teen: invite a guardian by username',
      tags: ['safety'],
      auth: 'user',
      body: z.object({ guardianUsername: z.string().trim().min(3).max(30) }),
      rateLimit: { limit: 10, windowSec: 3600, by: 'user' },
      handler: async ({ auth, req, body, reply }) => {
        const r = await inviteGuardian(ctx, auth, body.guardianUsername, req);
        void reply.code(201);
        return r;
      },
    });
    route(app, ctx, {
      method: 'GET',
      url: '/v1/safety/guardians',
      summary: 'My guardians and the teens I guard',
      tags: ['safety'],
      auth: 'user',
      handler: ({ auth }) => listGuardianLinks(ctx, auth.userId),
    });
    route(app, ctx, {
      method: 'POST',
      url: '/v1/safety/guardians/:id/accept',
      summary: "Guardian: accept a teen's invitation (:id = the teen's user id)",
      tags: ['safety'],
      auth: 'user',
      params: idParams,
      handler: async ({ auth, req, params }) => {
        await acceptGuardianship(ctx, auth, params.id, req);
        return { status: 'active' };
      },
    });
    route(app, ctx, {
      method: 'DELETE',
      url: '/v1/safety/guardians/:id',
      summary: "End a guardian link or decline an invitation (:id = the other user's id)",
      tags: ['safety'],
      auth: 'user',
      params: idParams,
      handler: async ({ auth, req, params }) => {
        await revokeGuardianLink(ctx, auth, params.id, req);
      },
    });
    route(app, ctx, {
      method: 'GET',
      url: '/v1/safety/guardian/minors/:id/summary',
      summary:
        "Guardian: a linked teen's safety settings and enforcement summary (never message content)",
      tags: ['safety'],
      auth: 'user',
      params: idParams,
      handler: ({ auth, params }) => guardianSummary(ctx, auth.userId, params.id),
    });

    // ================================================================== staff moderation console
    route(app, ctx, {
      method: 'GET',
      url: '/v1/staff/moderation/queue-stats',
      summary: 'Moderation queue counts by state and risk',
      tags: ['moderation'],
      auth: { staff: STAFF },
      handler: () => queueStats(ctx),
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/staff/moderation/cases',
      summary: 'Case queue (risk level, then age) with filters',
      tags: ['moderation'],
      auth: { staff: STAFF },
      query: caseQuery,
      handler: ({ auth, query }) => listCases(ctx, auth.userId, query),
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/staff/moderation/cases/:id',
      summary: 'Case detail: evidence snapshot, signals, reports, history',
      tags: ['moderation'],
      auth: { staff: STAFF },
      params: idParams,
      handler: async ({ auth, req, params }) => {
        const d = await getCaseDetail(ctx, params.id, { includeReporters: true });
        await audit(
          ctx,
          {
            actorId: auth.userId,
            actorType: 'staff',
            action: 'moderation.case_viewed',
            targetType: 'moderation_case',
            targetId: params.id,
          },
          req,
        );
        return d;
      },
    });

    route(app, ctx, {
      method: 'POST',
      url: '/v1/staff/moderation/cases/:id/claim',
      summary: 'Claim (assign to me) a case',
      tags: ['moderation'],
      auth: { staff: STAFF },
      params: idParams,
      handler: async ({ auth, req, params }) => {
        await claimCase(ctx, { userId: auth.userId, role: auth.platformRole }, params.id, req);
        return { assignedTo: auth.userId };
      },
    });
    route(app, ctx, {
      method: 'POST',
      url: '/v1/staff/moderation/cases/:id/release',
      summary: 'Release a claimed case',
      tags: ['moderation'],
      auth: { staff: STAFF },
      params: idParams,
      handler: async ({ auth, req, params }) => {
        await releaseCase(ctx, { userId: auth.userId, role: auth.platformRole }, params.id, req);
        return { assignedTo: null };
      },
    });
    route(app, ctx, {
      method: 'POST',
      url: '/v1/staff/moderation/cases/:id/escalate',
      summary: 'Escalate a case to admins',
      tags: ['moderation'],
      auth: { staff: STAFF },
      params: idParams,
      body: z.object({ note: z.string().trim().min(3).max(1000) }),
      handler: async ({ auth, req, params, body }) => {
        await escalateCase(
          ctx,
          { userId: auth.userId, role: auth.platformRole },
          params.id,
          body.note,
          req,
        );
        return { state: 'escalated' };
      },
    });
    route(app, ctx, {
      method: 'POST',
      url: '/v1/staff/moderation/cases/:id/decision',
      summary: 'Decide a case: no_action | label | limit_reach | remove | suspend_user | ban_user',
      tags: ['moderation'],
      auth: { staff: STAFF },
      params: idParams,
      body: decisionBody,
      rateLimit: { limit: 300, windowSec: 3600, by: 'user' },
      handler: ({ auth, req, params, body }) =>
        decideCase(ctx, { userId: auth.userId, role: auth.platformRole }, params.id, body, req),
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/staff/moderation/impersonation-check',
      summary: 'Check a username / display name against verified and staff identities',
      tags: ['moderation'],
      auth: { staff: STAFF },
      query: z.object({
        username: z.string().trim().max(60).optional(),
        displayName: z.string().trim().max(80).optional(),
      }),
      handler: ({ query }) => checkIdentity(ctx, query),
    });

    route(app, ctx, {
      method: 'GET',
      url: '/v1/staff/moderation/appeals',
      summary: 'Appeals awaiting review',
      tags: ['moderation'],
      auth: { staff: STAFF },
      query: pageQuery.extend({ status: z.enum(['open', 'upheld', 'overturned']).default('open') }),
      handler: ({ query }) => listAppeals(ctx, query.status, query.cursor, query.limit),
    });
    route(app, ctx, {
      method: 'POST',
      url: '/v1/staff/moderation/appeals/:id/review',
      summary: 'Review an appeal (a different staff member than the original decider)',
      tags: ['moderation'],
      auth: { staff: STAFF },
      params: idParams,
      body: z.object({
        outcome: z.enum(['upheld', 'overturned']),
        note: z.string().trim().min(3).max(2000),
      }),
      handler: ({ auth, req, params, body }) =>
        reviewAppeal(ctx, { userId: auth.userId, role: auth.platformRole }, params.id, body, req),
    });

    // Read-only lookup for support staff (cases without reporter identities).
    adminRoute(app, ctx, 'cases.read', {
      method: 'GET',
      url: '/v1/admin/cases',
      summary: 'Admin: case list (read-only, all staff roles)',
      tags: ['admin'],
      query: caseQuery,
      handler: ({ auth, query }) => listCases(ctx, auth.userId, query),
    });
    adminRoute(app, ctx, 'cases.read', {
      method: 'GET',
      url: '/v1/admin/cases/:id',
      summary: 'Admin: case detail (reporter identities only for moderators and above)',
      tags: ['admin'],
      params: idParams,
      handler: async ({ auth, params }) =>
        getCaseDetail(ctx, params.id, { includeReporters: auth.platformRole !== 'support' }),
    });
    adminRoute(app, ctx, 'reports.read', {
      method: 'GET',
      url: '/v1/admin/reports',
      summary: 'Admin: reports (read-only)',
      tags: ['admin'],
      query: pageQuery.extend({
        status: z.enum(['open', 'triaged', 'actioned', 'dismissed']).optional(),
        reason: z.enum(REPORT_REASONS).optional(),
      }),
      handler: async ({ auth, query }) => {
        const limit = clampLimit(query.limit);
        const cur = decodeCursor<{ t: string; id: string }>(query.cursor);
        const { rows } = await ctx.db.query(
          `SELECT r.id, r.target_type, r.target_id, r.reason, r.status, r.created_at, r.created_at::text AS created_raw, ${auth.platformRole === 'support' ? 'NULL::uuid' : 'r.reporter_id'} AS reporter_id
             FROM reports r WHERE ($1::text IS NULL OR r.status = $1) AND ($2::text IS NULL OR r.reason = $2) AND ($3::timestamptz IS NULL OR (r.created_at, r.id) < ($3::timestamptz, $4::uuid))
            ORDER BY r.created_at DESC, r.id DESC LIMIT $5`,
          [query.status ?? null, query.reason ?? null, cur?.t ?? null, cur?.id ?? null, limit + 1],
        );
        const page = rows.slice(0, limit);
        const last = page[page.length - 1];
        return {
          items: page.map((r) => ({
            id: r.id,
            targetType: r.target_type,
            targetId: r.target_id,
            reason: r.reason,
            status: r.status,
            reporterId: r.reporter_id,
            createdAt: r.created_at.toISOString(),
          })),
          nextCursor:
            rows.length > limit && last ? encodeCursor({ t: last.created_raw, id: last.id }) : null,
        };
      },
    });
  },
};
