import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../lib/context.js';
import { adminRoute } from './rbac.js';

const days = z.coerce.number().int().min(1).max(365).default(30);

/**
 * Run one read-only section. Money, fraud and AI tables are owned by other modules that evolve independently: a
 * problem in one section must never blank the whole overview, so failures degrade to `{ available: false }`.
 */
export async function section<T>(
  ctx: AppContext,
  name: string,
  fn: () => Promise<T>,
): Promise<T | { available: false }> {
  try {
    return await fn();
  } catch (err) {
    ctx.log.warn({ err, section: name }, 'admin overview section failed');
    return { available: false };
  }
}

export function registerAdminOpsRoutes(app: FastifyInstance, ctx: AppContext): void {
  // ------------------------------------------------------------------ payments & fraud (read-only overviews; actions live in /v1/staff/*)
  adminRoute(app, ctx, 'payments.read', {
    method: 'GET',
    url: '/v1/admin/payments/summary',
    summary:
      'Orders, payments, refunds and payouts by status (aggregates only; actions via /v1/staff/*)',
    tags: ['admin'],
    query: z.object({ days }),
    handler: async ({ query }) => {
      const d = query.days;
      const [orders, payments, refunds, payouts] = await Promise.all([
        section(
          ctx,
          'orders',
          async () =>
            (
              await ctx.db.query(
                `SELECT status, currency, count(*)::int AS count, COALESCE(sum(total_cents),0)::bigint AS total_cents FROM orders WHERE created_at > now() - make_interval(days => $1) GROUP BY status, currency ORDER BY status, currency`,
                [d],
              )
            ).rows,
        ),
        section(
          ctx,
          'payments',
          async () =>
            (
              await ctx.db.query(
                `SELECT status, currency, count(*)::int AS count, COALESCE(sum(amount_cents),0)::bigint AS amount_cents, COALESCE(sum(platform_fee_cents),0)::bigint AS platform_fee_cents
             FROM payments WHERE created_at > now() - make_interval(days => $1) GROUP BY status, currency ORDER BY status, currency`,
                [d],
              )
            ).rows,
        ),
        section(
          ctx,
          'refunds',
          async () =>
            (
              await ctx.db.query(
                `SELECT status, currency, count(*)::int AS count, COALESCE(sum(amount_cents),0)::bigint AS amount_cents FROM refunds WHERE created_at > now() - make_interval(days => $1) GROUP BY status, currency ORDER BY status, currency`,
                [d],
              )
            ).rows,
        ),
        section(
          ctx,
          'payouts',
          async () =>
            (
              await ctx.db.query(
                `SELECT status, currency, count(*)::int AS count, COALESCE(sum(amount_cents),0)::bigint AS amount_cents FROM payouts WHERE created_at > now() - make_interval(days => $1) GROUP BY status, currency ORDER BY status, currency`,
                [d],
              )
            ).rows,
        ),
      ]);
      return {
        periodDays: d,
        orders,
        payments,
        refunds,
        payouts,
        actions: {
          orders: '/v1/staff/orders',
          refunds: '/v1/staff/refunds',
          payouts: '/v1/staff/payouts',
          disputes: '/v1/staff/disputes',
        },
      };
    },
  });

  adminRoute(app, ctx, 'fraud.read', {
    method: 'GET',
    url: '/v1/admin/fraud/summary',
    summary: 'Fraud signals in orders and payments (aggregates; review queue is /v1/staff/orders)',
    tags: ['admin'],
    query: z.object({ days }),
    handler: async ({ query }) => {
      const d = query.days;
      const [held, flags, disputes, scoreBands] = await Promise.all([
        section(
          ctx,
          'held',
          async () =>
            (
              await ctx.db.query(
                `SELECT count(*)::int AS n FROM orders WHERE status = 'pending_review'`,
              )
            ).rows[0].n as number,
        ),
        section(
          ctx,
          'flags',
          async () =>
            (
              await ctx.db.query(
                `SELECT f AS flag, count(*)::int AS count FROM orders, unnest(fraud_flags) AS f WHERE created_at > now() - make_interval(days => $1) GROUP BY f ORDER BY count DESC LIMIT 20`,
                [d],
              )
            ).rows,
        ),
        section(
          ctx,
          'disputes',
          async () =>
            (
              await ctx.db.query(
                `SELECT count(*)::int AS n FROM payments WHERE status = 'disputed' AND updated_at > now() - make_interval(days => $1)`,
                [d],
              )
            ).rows[0].n as number,
        ),
        section(
          ctx,
          'scoreBands',
          async () =>
            (
              await ctx.db.query(
                `SELECT CASE WHEN fraud_score >= 80 THEN 'high' WHEN fraud_score >= 40 THEN 'medium' ELSE 'low' END AS band, count(*)::int AS count
             FROM orders WHERE created_at > now() - make_interval(days => $1) GROUP BY band ORDER BY band`,
                [d],
              )
            ).rows,
        ),
      ]);
      return {
        periodDays: d,
        ordersHeldForReview: held,
        topFlags: flags,
        disputedPayments: disputes,
        scoreBands,
        reviewQueue: '/v1/staff/orders',
      };
    },
  });

  // ------------------------------------------------------------------ AI usage (never content)
  adminRoute(app, ctx, 'ai.read', {
    method: 'GET',
    url: '/v1/admin/ai/usage',
    summary: 'AI usage and safety outcomes (counts only; conversation content is never shown here)',
    tags: ['admin'],
    query: z.object({ days }),
    handler: async ({ query }) => {
      const d = query.days;
      const [messages, tools, artifacts, daily] = await Promise.all([
        section(
          ctx,
          'messages',
          async () =>
            (
              await ctx.db.query(
                `SELECT COALESCE(provider,'unknown') AS provider, COALESCE(model,'unknown') AS model, count(*)::int AS count
             FROM ai_messages WHERE role = 'assistant' AND created_at > now() - make_interval(days => $1) GROUP BY 1, 2 ORDER BY count DESC`,
                [d],
              )
            ).rows,
        ),
        section(
          ctx,
          'tools',
          async () =>
            (
              await ctx.db.query(
                `SELECT tool, outcome, count(*)::int AS count FROM ai_tool_calls WHERE created_at > now() - make_interval(days => $1) GROUP BY tool, outcome ORDER BY count DESC LIMIT 50`,
                [d],
              )
            ).rows,
        ),
        section(
          ctx,
          'artifacts',
          async () =>
            (
              await ctx.db.query(
                `SELECT kind, status, count(*)::int AS count FROM ai_artifacts WHERE created_at > now() - make_interval(days => $1) GROUP BY kind, status ORDER BY kind, status`,
                [d],
              )
            ).rows,
        ),
        section(
          ctx,
          'daily',
          async () =>
            (
              await ctx.db.query(
                `SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day, count(*)::int AS assistant_messages, count(DISTINCT conversation_id)::int AS conversations
             FROM ai_messages WHERE role = 'assistant' AND created_at > now() - make_interval(days => $1) GROUP BY 1 ORDER BY 1`,
                [d],
              )
            ).rows,
        ),
      ]);
      const consent = await section(
        ctx,
        'consent',
        async () =>
          (
            await ctx.db.query(
              `SELECT count(*)::int AS users_with_ai_consent FROM (SELECT DISTINCT ON (user_id) user_id, granted FROM consents WHERE purpose = 'ai_processing' ORDER BY user_id, created_at DESC, id DESC) c WHERE granted`,
            )
          ).rows[0],
      );
      return {
        periodDays: d,
        assistantMessages: messages,
        toolCalls: tools,
        drafts: artifacts,
        daily,
        consent,
      };
    },
  });

  // ------------------------------------------------------------------ audit log viewer
  adminRoute(app, ctx, 'audit.read', {
    method: 'GET',
    url: '/v1/admin/audit',
    summary: 'Search the immutable audit log (newest first)',
    tags: ['admin'],
    query: z.object({
      actorId: z.uuid().optional(),
      action: z.string().trim().min(1).max(80).optional(),
      actionPrefix: z.string().trim().min(1).max(40).optional(),
      targetType: z.string().trim().min(1).max(40).optional(),
      targetId: z.string().trim().min(1).max(80).optional(),
      from: z.iso.datetime().optional(),
      to: z.iso.datetime().optional(),
      cursor: z.string().max(400).optional(),
      limit: z.coerce.number().int().min(1).max(100).optional(),
    }),
    handler: async ({ query }) => {
      const limit = Math.min(100, Math.max(1, query.limit ?? 50));
      const before = query.cursor
        ? Number(Buffer.from(query.cursor, 'base64url').toString())
        : null;
      const { rows } = await ctx.db.query(
        `SELECT id, actor_id, actor_type, action, target_type, target_id, request_id, metadata, created_at
           FROM audit_logs
          WHERE ($1::uuid IS NULL OR actor_id = $1) AND ($2::text IS NULL OR action = $2) AND ($3::text IS NULL OR action LIKE $3 ESCAPE '\\')
            AND ($4::text IS NULL OR target_type = $4) AND ($5::text IS NULL OR target_id = $5)
            AND ($6::timestamptz IS NULL OR created_at >= $6) AND ($7::timestamptz IS NULL OR created_at <= $7)
            AND ($8::bigint IS NULL OR id < $8)
          ORDER BY id DESC LIMIT ${limit + 1}`,
        [
          query.actorId ?? null,
          query.action ?? null,
          query.actionPrefix ? `${query.actionPrefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null,
          query.targetType ?? null,
          query.targetId ?? null,
          query.from ?? null,
          query.to ?? null,
          before !== null && Number.isFinite(before) ? before : null,
        ],
      );
      const items = rows.slice(0, limit);
      const last = items[items.length - 1];
      return {
        items: items.map((r) => ({
          id: r.id,
          actorId: r.actor_id,
          actorType: r.actor_type,
          action: r.action,
          targetType: r.target_type,
          targetId: r.target_id,
          requestId: r.request_id,
          metadata: r.metadata,
          createdAt: r.created_at,
        })),
        nextCursor:
          rows.length > limit && last ? Buffer.from(String(last.id)).toString('base64url') : null,
      };
    },
  });

  // ------------------------------------------------------------------ system health
  adminRoute(app, ctx, 'system.read', {
    method: 'GET',
    url: '/v1/admin/system/health',
    summary: 'Service health: database, migrations, queues and backlogs',
    tags: ['admin'],
    handler: async () => {
      const t0 = process.hrtime.bigint();
      let database: Record<string, unknown>;
      try {
        await ctx.db.query('SELECT 1');
        const latencyMs = Number((process.hrtime.bigint() - t0) / 1_000_000n);
        const mig = await ctx.db.query(
          `SELECT count(*)::int AS applied, max(name) AS latest FROM schema_migrations`,
        );
        database = {
          ok: true,
          latencyMs,
          pool: { total: ctx.db.totalCount, idle: ctx.db.idleCount, waiting: ctx.db.waitingCount },
          migrations: mig.rows[0],
        };
      } catch (err) {
        ctx.log.error({ err }, 'health: database check failed');
        database = { ok: false };
      }
      const n = async (sqlText: string) =>
        section(
          ctx,
          sqlText.slice(0, 30),
          async () => (await ctx.db.query(sqlText)).rows[0].n as number,
        );
      const [
        webhookPending,
        webhookFailed,
        dueDeletions,
        pendingDeletions,
        expiredExports,
        openCases,
        oldestCaseHours,
        digestBacklog,
        undeliveredPush,
      ] = await Promise.all([
        n(
          `SELECT count(*)::int AS n FROM webhook_deliveries WHERE status IN ('pending','delivering') AND next_attempt_at <= now()`,
        ),
        n(
          `SELECT count(*)::int AS n FROM webhook_deliveries WHERE status = 'failed' AND created_at > now() - interval '24 hours'`,
        ),
        n(
          `SELECT count(*)::int AS n FROM users WHERE status = 'pending_deletion' AND deletion_scheduled_for <= now()`,
        ),
        n(`SELECT count(*)::int AS n FROM users WHERE status = 'pending_deletion'`),
        n(`SELECT count(*)::int AS n FROM privacy_exports WHERE expires_at <= now()`),
        n(`SELECT count(*)::int AS n FROM moderation_cases WHERE state <> 'resolved'`),
        n(
          `SELECT COALESCE(round(EXTRACT(epoch FROM now() - min(created_at)) / 3600), 0)::int AS n FROM moderation_cases WHERE state <> 'resolved'`,
        ),
        n(
          `SELECT count(*)::int AS n FROM notifications WHERE read_at IS NULL AND emailed_at IS NULL AND created_at > now() - interval '7 days'`,
        ),
        n(`SELECT count(*)::int AS n FROM push_tokens WHERE disabled_at IS NOT NULL`),
      ]);
      const flags = await section(
        ctx,
        'flags',
        async () =>
          (
            await ctx.db.query(
              `SELECT count(*) FILTER (WHERE enabled)::int AS enabled, count(*)::int AS total FROM feature_flags`,
            )
          ).rows[0],
      );
      return {
        time: new Date().toISOString(),
        uptimeSec: Math.round(process.uptime()),
        runtime: {
          node: process.version,
          env: ctx.config.APP_ENV,
          memoryMb: Math.round(process.memoryUsage().rss / 1_048_576),
        },
        database,
        adapters: {
          rateLimiter: ctx.limiter.constructor.name,
          pubsub: ctx.pubsub.constructor.name,
          email: ctx.email.constructor.name,
          push: ctx.push.constructor.name,
        },
        backlogs: {
          webhooksDue: webhookPending,
          webhooksFailed24h: webhookFailed,
          deletionsDue: dueDeletions,
          deletionsPending: pendingDeletions,
          exportsAwaitingPurge: expiredExports,
          openModerationCases: openCases,
          oldestOpenCaseHours: oldestCaseHours,
          unreadEmailDigestBacklog: digestBacklog,
          deadPushTokens: undeliveredPush,
        },
        featureFlags: flags,
      };
    },
  });
}
