import type { FastifyInstance } from 'fastify';
import { tx } from '@yapilapi/database';
import { appealSchema, FEATURE_FLAG_KEYS, moderationDecisionSchema, reportSchema } from '@yapilapi/shared';
import { z } from 'zod';
import { badRequest, conflict, notFound, parse } from '../lib/errors.ts';
import type { AppContext } from '../lib/context.ts';
import { audit, getFlags, notify } from '../lib/services.ts';
import { me, requireAuth, requireRole } from '../plugins/auth.ts';

const idParam = z.object({ id: z.string().uuid() });

// Reports in these categories skip the queue and are escalated immediately.
const URGENT = new Set(['minor_safety', 'self_harm', 'violence']);

/**
 * Trust & safety: reports → moderation cases → decisions → enforcement → appeals.
 * Moderators and admins act through RBAC-protected endpoints; every decision is audited.
 */
export default async function safetyModule(app: FastifyInstance, ctx: AppContext) {
  const db = ctx.db;

  async function subjectOf(type: string, id: string): Promise<string | null> {
    const q: Record<string, string> = {
      user: `SELECT id AS uid FROM users WHERE id = $1`,
      post: `SELECT author_id AS uid FROM posts WHERE id = $1`,
      comment: `SELECT author_id AS uid FROM comments WHERE id = $1`,
      message: `SELECT sender_id AS uid FROM messages WHERE id = $1`,
      community: `SELECT owner_id AS uid FROM communities WHERE id = $1`,
      event: `SELECT host_id AS uid FROM events WHERE id = $1`,
      product: `SELECT seller_id AS uid FROM products WHERE id = $1`,
    };
    const r = await db.query(q[type]!, [id]);
    return r.rows[0]?.uid ?? null;
  }

  app.post('/v1/reports', { preHandler: requireAuth, config: { rateLimit: { max: 20, timeWindow: '1 hour' } } }, async (req, reply) => {
    const u = me(req);
    const input = parse(reportSchema, req.body);
    const subject = await subjectOf(input.targetType, input.targetId);
    if (!subject) throw notFound('The item you reported');
    if (subject === u.id) throw badRequest("You can't report your own content.");
    // A reported message must be one the reporter could actually see.
    if (input.targetType === 'message') {
      const ok = await db.query(`SELECT 1 FROM messages m JOIN conversation_members cm ON cm.conversation_id = m.conversation_id WHERE m.id = $1 AND cm.user_id = $2`, [input.targetId, u.id]);
      if (!ok.rowCount) throw notFound('The item you reported');
    }
    const report = await tx(db, async (c) => {
      const r = await c.query(
        `INSERT INTO reports (reporter_id, target_type, target_id, reason, details) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING id`,
        [u.id, input.targetType, input.targetId, input.reason, input.details ?? null],
      );
      if (!r.rows[0]) throw conflict('You already reported this. We’ll let you know when it’s reviewed.');
      const risk = URGENT.has(input.reason) ? 'escalate' : 'review';
      await c.query(
        `INSERT INTO moderation_cases (target_type, target_id, subject_user_id, source, risk, signals) VALUES ($1,$2,$3,'report',$4,$5)
         ON CONFLICT (target_type, target_id) WHERE status = 'open'
         DO UPDATE SET signals = moderation_cases.signals || jsonb_build_object('reports', coalesce((moderation_cases.signals->>'reports')::int, 1) + 1),
                       risk = CASE WHEN EXCLUDED.risk = 'escalate' THEN 'escalate' ELSE moderation_cases.risk END`,
        [input.targetType, input.targetId, subject, risk, { reports: 1, reasons: [input.reason] }],
      );
      // Content reported for minor safety is hidden immediately pending review.
      if (input.reason === 'minor_safety' && input.targetType === 'post') await c.query(`UPDATE posts SET moderation_status = 'restricted' WHERE id = $1`, [input.targetId]);
      return r.rows[0];
    });
    reply.code(201);
    return { report: { id: report.id }, message: 'Thanks for reporting. Our team will review it. You can also block this account.' };
  });

  // ── Moderator console ─────────────────────────────────────────────────
  app.get('/v1/admin/moderation/cases', { preHandler: requireRole('moderator', 'admin') }, async (req) => {
    const q = parse(z.object({ status: z.enum(['open', 'decided', 'appealed', 'final']).default('open') }), req.query);
    const { rows } = await db.query(
      `SELECT mc.*, pr.username AS subject_username,
         CASE mc.target_type WHEN 'post' THEN (SELECT body FROM posts WHERE id = mc.target_id)
                             WHEN 'comment' THEN (SELECT body FROM comments WHERE id = mc.target_id) END AS excerpt
       FROM moderation_cases mc LEFT JOIN profiles pr ON pr.user_id = mc.subject_user_id
       WHERE mc.status = $1 ORDER BY CASE mc.risk WHEN 'escalate' THEN 0 WHEN 'restrict' THEN 1 ELSE 2 END, mc.created_at LIMIT 100`,
      [q.status],
    );
    return { items: rows };
  });

  app.post('/v1/admin/moderation/cases/:id/decide', { preHandler: requireRole('moderator', 'admin') }, async (req) => {
    const mod = me(req);
    const { id } = parse(idParam, req.params);
    const input = parse(moderationDecisionSchema, req.body);
    if (input.decision === 'suspend_user' && mod.role !== 'admin') throw badRequest('Only admins can suspend accounts.');
    await tx(db, async (c) => {
      const { rows } = await c.query(`SELECT * FROM moderation_cases WHERE id = $1 AND status IN ('open','appealed') FOR UPDATE`, [id]);
      const mc = rows[0];
      if (!mc) throw notFound('Case');
      await applyDecision(c, mc, input.decision);
      await c.query(`UPDATE moderation_cases SET status = $2, decision = $3, reviewer_id = $4, note = $5, decided_at = now() WHERE id = $1`, [
        id, mc.status === 'appealed' ? 'final' : 'decided', input.decision, mod.id, input.note ?? null,
      ]);
      await c.query(`UPDATE reports SET status = 'closed' WHERE target_type = $1 AND target_id = $2 AND status <> 'closed'`, [mc.target_type, mc.target_id]);
      if (input.decision !== 'no_action' && mc.subject_user_id) {
        await c.query(`INSERT INTO enforcements (case_id, user_id, action) VALUES ($1,$2,$3)`, [id, mc.subject_user_id, input.decision]);
        await notify(c, ctx.realtime, { userId: mc.subject_user_id, category: 'moderation', type: 'enforcement', entityType: 'moderation_case', entityId: id, data: { decision: input.decision, canAppeal: mc.status !== 'appealed' } });
      }
      await audit(c, { actorId: mod.id, action: `moderation.${input.decision}`, entityType: mc.target_type, entityId: mc.target_id, metadata: { caseId: id, note: input.note } });
    });
    return { ok: true };
  });

  async function applyDecision(c: { query: typeof db.query }, mc: { target_type: string; target_id: string; subject_user_id: string | null }, decision: string) {
    const table: Record<string, string> = { post: 'posts', comment: 'comments' };
    const t = table[mc.target_type];
    if (decision === 'no_action' && t) await c.query(`UPDATE ${t} SET moderation_status = 'normal' WHERE id = $1`, [mc.target_id]);
    if (decision === 'restrict' && t) await c.query(`UPDATE ${t} SET moderation_status = 'restricted' WHERE id = $1`, [mc.target_id]);
    if (decision === 'remove') {
      if (t) await c.query(`UPDATE ${t} SET moderation_status = 'removed', deleted_at = coalesce(deleted_at, now()) WHERE id = $1`, [mc.target_id]);
      if (mc.target_type === 'message') await c.query(`UPDATE messages SET deleted_at = now(), body = '' WHERE id = $1`, [mc.target_id]);
      if (mc.target_type === 'community') await c.query(`UPDATE communities SET deleted_at = now() WHERE id = $1`, [mc.target_id]);
      if (mc.target_type === 'event') await c.query(`UPDATE events SET deleted_at = now() WHERE id = $1`, [mc.target_id]);
      if (mc.target_type === 'product') await c.query(`UPDATE products SET deleted_at = now() WHERE id = $1`, [mc.target_id]);
    }
    if (decision === 'suspend_user' && mc.subject_user_id) {
      await c.query(`UPDATE users SET status = 'suspended' WHERE id = $1 AND role = 'user'`, [mc.subject_user_id]);
      await c.query(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [mc.subject_user_id]);
    }
  }

  // ── Appeals ───────────────────────────────────────────────────────────
  app.post('/v1/appeals', { preHandler: requireAuth }, async (req, reply) => {
    const u = me(req);
    const input = parse(appealSchema, req.body);
    await tx(db, async (c) => {
      const mc = await c.query(`SELECT status FROM moderation_cases WHERE id = $1 AND subject_user_id = $2 FOR UPDATE`, [input.caseId, u.id]);
      if (!mc.rows[0]) throw notFound('Case');
      if (mc.rows[0].status !== 'decided') throw badRequest('This decision can’t be appealed.');
      await c.query(`INSERT INTO appeals (case_id, user_id, statement) VALUES ($1,$2,$3)`, [input.caseId, u.id, input.statement]).catch((e) => {
        if (e.code === '23505') throw conflict('You already appealed this decision.');
        throw e;
      });
      await c.query(`UPDATE moderation_cases SET status = 'appealed' WHERE id = $1`, [input.caseId]);
    });
    reply.code(201);
    return { status: 'appealed', message: 'Your appeal was sent. A different reviewer will look at it.' };
  });

  app.get('/v1/me/moderation', { preHandler: requireAuth }, async (req) => {
    const { rows } = await db.query(
      `SELECT mc.id, mc.target_type, mc.target_id, mc.status, mc.decision, mc.decided_at,
              (SELECT status FROM appeals a WHERE a.case_id = mc.id) AS appeal_status
       FROM moderation_cases mc WHERE mc.subject_user_id = $1 AND mc.decision IS NOT NULL AND mc.decision <> 'no_action' ORDER BY mc.decided_at DESC`,
      [me(req).id],
    );
    return { items: rows };
  });

  // ── Admin ─────────────────────────────────────────────────────────────
  app.get('/v1/admin/users', { preHandler: requireRole('admin') }, async (req) => {
    const q = parse(z.object({ q: z.string().max(100).default('') }), req.query);
    const { rows } = await db.query(
      `SELECT u.id, u.email, u.role, u.status, u.created_at, u.is_dev_data, pr.username, pr.display_name FROM users u JOIN profiles pr ON pr.user_id = u.id
       WHERE $1 = '' OR pr.username ILIKE $2 OR u.email ILIKE $2 ORDER BY u.created_at DESC LIMIT 50`,
      [q.q, `%${q.q.replace(/[%_]/g, '')}%`],
    );
    return { items: rows };
  });

  app.put('/v1/admin/users/:id/status', { preHandler: requireRole('admin') }, async (req) => {
    const { id } = parse(idParam, req.params);
    const { status } = parse(z.object({ status: z.enum(['active', 'suspended']) }), req.body);
    if (id === me(req).id) throw badRequest("You can't change your own status.");
    const r = await db.query(`UPDATE users SET status = $2 WHERE id = $1 AND status <> 'deleted'`, [id, status]);
    if (!r.rowCount) throw notFound('User');
    if (status === 'suspended') await db.query(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [id]);
    await audit(db, { actorId: me(req).id, action: `user.${status}`, entityType: 'user', entityId: id, ip: req.ip, requestId: req.id });
    return { status };
  });

  app.put('/v1/admin/users/:id/role', { preHandler: requireRole('admin') }, async (req) => {
    const { id } = parse(idParam, req.params);
    const { role } = parse(z.object({ role: z.enum(['user', 'moderator', 'admin']) }), req.body);
    await db.query(`UPDATE users SET role = $2 WHERE id = $1`, [id, role]);
    await audit(db, { actorId: me(req).id, action: 'user.role', entityType: 'user', entityId: id, metadata: { role } });
    return { role };
  });

  app.get('/v1/admin/audit-logs', { preHandler: requireRole('admin') }, async () => {
    const { rows } = await db.query(`SELECT id, actor_id, action, entity_type, entity_id, host(ip) AS ip, request_id, metadata, created_at FROM audit_logs ORDER BY id DESC LIMIT 200`);
    return { items: rows };
  });

  app.get('/v1/admin/analytics/summary', { preHandler: requireRole('admin') }, async () => {
    const { rows } = await db.query(
      `SELECT
         (SELECT count(*) FROM users WHERE status = 'active' AND NOT is_dev_data) AS users,
         (SELECT count(DISTINCT user_id) FROM analytics_events WHERE created_at > now() - interval '1 day') AS dau,
         (SELECT count(*) FROM analytics_events WHERE meaningful AND created_at > now() - interval '1 day') AS meaningful_actions_24h,
         (SELECT count(*) FROM analytics_events WHERE name = 'signup' AND created_at > now() - interval '7 days') AS signups_7d,
         (SELECT count(*) FROM moderation_cases WHERE status = 'open') AS open_cases,
         (SELECT count(*) FROM orders WHERE status = 'paid' AND created_at > now() - interval '7 days') AS paid_orders_7d`,
    );
    const byAction = await db.query(`SELECT name, count(*) AS n FROM analytics_events WHERE meaningful AND created_at > now() - interval '7 days' GROUP BY name ORDER BY n DESC`);
    return { northStar: 'meaningful social actions', summary: rows[0], meaningfulByAction: byAction.rows };
  });

  app.get('/v1/admin/ai/calls', { preHandler: requireRole('admin') }, async () => {
    const { rows } = await db.query(`SELECT task, provider, model, status, count(*) AS n, avg(latency_ms)::int AS avg_ms FROM ai_tool_calls WHERE created_at > now() - interval '7 days' GROUP BY 1,2,3,4 ORDER BY n DESC`);
    return { items: rows };
  });

  // ── Feature flags ─────────────────────────────────────────────────────
  app.get('/v1/flags', async () => ({ flags: await getFlags(db) }));

  app.put('/v1/admin/flags/:key', { preHandler: requireRole('admin') }, async (req) => {
    const { key } = parse(z.object({ key: z.enum(FEATURE_FLAG_KEYS as [string, ...string[]]) }), req.params);
    const { enabled } = parse(z.object({ enabled: z.boolean() }), req.body);
    await db.query(`INSERT INTO feature_flags (key, enabled) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()`, [key, enabled]);
    await audit(db, { actorId: me(req).id, action: 'flag.set', entityType: 'feature_flag', entityId: key, metadata: { enabled } });
    return { flags: await getFlags(db) };
  });
}
