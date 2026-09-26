import type { PoolClient } from 'pg';
import { refundUnspentBudget } from '../lib/ad-refunds.ts';
import type { FastifyInstance } from 'fastify';
import { tx } from '@yapilapi/database';
import { appealSchema, FEATURE_FLAG_KEYS, moderationDecisionSchema, reportSchema } from '@yapilapi/shared';
import { z } from 'zod';
import { badRequest, conflict, notFound, parse } from '../lib/errors.ts';
import type { AppContext } from '../lib/context.ts';
import { audit, getFlags, notify } from '../lib/services.ts';
import { applyMediaDecision } from '../lib/media-moderation.ts';
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
      const ok = await db.query(
        `SELECT 1 FROM messages m JOIN conversation_members cm ON cm.conversation_id = m.conversation_id WHERE m.id = $1 AND cm.user_id = $2`,
        [input.targetId, u.id],
      );
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
      if (input.reason === 'minor_safety' && input.targetType === 'post')
        await c.query(`UPDATE posts SET moderation_status = 'restricted' WHERE id = $1`, [input.targetId]);
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
                             WHEN 'comment' THEN (SELECT body FROM comments WHERE id = mc.target_id)
                             WHEN 'message' THEN (SELECT body FROM messages WHERE id = mc.target_id)
                             WHEN 'ad_campaign' THEN (SELECT p.body FROM ad_campaigns a JOIN posts p ON p.id = a.post_id WHERE a.id = mc.target_id) END AS excerpt,
         CASE WHEN mc.target_type = 'media' THEN (SELECT json_build_object('kind', m.kind, 'url', coalesce(m.variants->>'medium', m.poster_url, m.url), 'moderation', m.moderation)
                                                    FROM media m WHERE m.id = mc.target_id) END AS media
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
      const isAd = mc.target_type === 'ad_campaign';
      if (isAd !== (input.decision === 'approve_ad' || input.decision === 'reject_ad'))
        throw badRequest(isAd ? 'Approve or reject this ad.' : 'That decision is only for ad reviews.');
      if (input.decision === 'reject_ad' && !input.note?.trim()) throw badRequest('Say why the ad was rejected. The advertiser sees this.');
      if (isAd) await applyAdDecision(c, mc, input.decision === 'approve_ad', mod.id, input.note ?? null);
      else if (mc.target_type === 'media') {
        await applyMediaDecision(c, ctx.realtime, mc, input.decision);
        if (input.decision === 'suspend_user') await applyDecision(c, mc, input.decision);
      } else await applyDecision(c, mc, input.decision);
      // Spam signals attached to this item follow the decision.
      if (!isAd)
        await c.query(
          `UPDATE risk_signals SET status = $3, reviewed_by = $4, reviewed_at = now() WHERE target_type = $1 AND target_id = $2 AND status = 'open'`,
          [mc.target_type, mc.target_id, input.decision === 'no_action' ? 'cleared' : 'confirmed', mod.id],
        );
      await c.query(`UPDATE moderation_cases SET status = $2, decision = $3, reviewer_id = $4, note = $5, decided_at = now() WHERE id = $1`, [
        id,
        mc.status === 'appealed' ? 'final' : 'decided',
        input.decision,
        mod.id,
        input.note ?? null,
      ]);
      await c.query(`UPDATE reports SET status = 'closed' WHERE target_type = $1 AND target_id = $2 AND status <> 'closed'`, [mc.target_type, mc.target_id]);
      if (input.decision !== 'no_action' && !isAd && mc.subject_user_id) {
        await c.query(`INSERT INTO enforcements (case_id, user_id, action) VALUES ($1,$2,$3)`, [id, mc.subject_user_id, input.decision]);
        await notify(c, ctx.realtime, {
          userId: mc.subject_user_id,
          category: 'moderation',
          type: 'enforcement',
          entityType: 'moderation_case',
          entityId: id,
          data: { decision: input.decision, canAppeal: mc.status !== 'appealed' },
        });
      }
      await audit(c, {
        actorId: mod.id,
        action: `moderation.${input.decision}`,
        entityType: mc.target_type,
        entityId: mc.target_id,
        metadata: { caseId: id, note: input.note },
      });
    });
    return { ok: true };
  });

  /** Ad reviews aren't enforcement: approval starts the campaign (paused if its budget ran out meanwhile); rejection tells the advertiser why. */
  async function applyAdDecision(
    c: PoolClient,
    mc: { target_id: string; subject_user_id: string | null },
    approve: boolean,
    reviewer: string,
    note: string | null,
  ) {
    const { rows } = await c.query(
      approve
        ? `UPDATE ad_campaigns SET status = CASE WHEN budget_millicents - spent_millicents >= cpm_cents THEN 'active' ELSE 'paused' END,
             approved_at = now(), reviewed_by = $2, review_note = NULL,
             -- A boost runs for its number of days from approval.
             ends_at = coalesce(ends_at, CASE WHEN boost_days IS NOT NULL THEN now() + make_interval(days => boost_days) END)
           WHERE id = $1 AND status = 'pending_review' RETURNING advertiser_id, name`
        : `UPDATE ad_campaigns SET status = 'rejected', reviewed_by = $2, review_note = $3 WHERE id = $1 AND status = 'pending_review' RETURNING advertiser_id, name`,
      approve ? [mc.target_id, reviewer] : [mc.target_id, reviewer, note],
    );
    if (!rows[0]) throw badRequest('This campaign is no longer waiting for review.');
    // A rejected campaign can't run, so whatever budget it holds goes back to the advertiser.
    if (!approve) await refundUnspentBudget(c, ctx.paymentProviders, mc.target_id, reviewer);
    await notify(c, ctx.realtime, {
      userId: rows[0].advertiser_id,
      category: 'moderation',
      type: approve ? 'ad_approved' : 'ad_rejected',
      entityType: 'ad_campaign',
      entityId: mc.target_id,
      data: { name: rows[0].name, note: approve ? null : note },
    });
  }

  async function applyDecision(
    c: { query: typeof db.query },
    mc: { target_type: string; target_id: string; subject_user_id: string | null },
    decision: string,
  ) {
    const table: Record<string, string> = { post: 'posts', comment: 'comments' };
    const t = table[mc.target_type];
    if (decision === 'no_action' && t) await c.query(`UPDATE ${t} SET moderation_status = 'normal' WHERE id = $1`, [mc.target_id]);
    // A held message is delivered once a moderator lets it through.
    if (decision === 'no_action' && mc.target_type === 'message') await releaseMessages(c, [mc.target_id]);
    if (decision === 'restrict' && t) await c.query(`UPDATE ${t} SET moderation_status = 'restricted' WHERE id = $1`, [mc.target_id]);
    if (decision === 'remove') {
      if (t) await c.query(`UPDATE ${t} SET moderation_status = 'removed', deleted_at = coalesce(deleted_at, now()) WHERE id = $1`, [mc.target_id]);
      if (mc.target_type === 'message')
        await c.query(`UPDATE messages SET deleted_at = now(), body = '', attachments = '[]', moderation_status = 'removed' WHERE id = $1`, [mc.target_id]);
      if (mc.target_type === 'community') await c.query(`UPDATE communities SET deleted_at = now() WHERE id = $1`, [mc.target_id]);
      if (mc.target_type === 'event') await c.query(`UPDATE events SET deleted_at = now() WHERE id = $1`, [mc.target_id]);
      if (mc.target_type === 'product') await c.query(`UPDATE products SET deleted_at = now() WHERE id = $1`, [mc.target_id]);
    }
    if (decision === 'suspend_user' && mc.subject_user_id) {
      await c.query(`UPDATE users SET status = 'suspended' WHERE id = $1 AND role = 'user'`, [mc.subject_user_id]);
      await c.query(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [mc.subject_user_id]);
    }
  }

  /** Let held messages through and tell the conversation, so they show up without a reload. */
  async function releaseMessages(c: { query: typeof db.query }, ids: string[]) {
    if (!ids.length) return;
    const { rows } = await c.query(
      `UPDATE messages SET moderation_status = 'normal' WHERE id = ANY($1::uuid[]) AND moderation_status = 'review' AND deleted_at IS NULL RETURNING id, conversation_id`,
      [ids],
    );
    for (const r of rows) {
      await c.query(`UPDATE conversations SET last_message_at = now() WHERE id = $1`, [r.conversation_id]);
      const members = await c.query(`SELECT user_id FROM conversation_members WHERE conversation_id = $1 AND left_at IS NULL`, [r.conversation_id]);
      await ctx.realtime.publish(
        members.rows.map((m) => m.user_id),
        { type: 'message.released', data: { id: r.id, conversationId: r.conversation_id } },
      );
    }
  }

  // ── Account risk (spam and bot signals) ───────────────────────────────
  // Accounts with open signals, or limited after repeated flags. Moderators clear
  // the signals (and lift any limit, releasing held posts and messages) or confirm them.
  app.get('/v1/admin/risk/accounts', { preHandler: requireRole('moderator', 'admin') }, async (req) => {
    const q = parse(z.object({ status: z.enum(['open', 'reviewed']).default('open') }), req.query);
    const where =
      q.status === 'open'
        ? `u.restricted_at IS NOT NULL OR EXISTS (SELECT 1 FROM risk_signals s WHERE s.user_id = u.id AND s.status = 'open' AND s.weight > 0)`
        : `EXISTS (SELECT 1 FROM risk_signals s WHERE s.user_id = u.id AND s.status <> 'open' AND s.reviewed_at > now() - interval '30 days')`;
    const { rows } = await db.query(
      `SELECT u.id, u.email, u.created_at, u.status, u.restricted_at, u.email_verified_at IS NOT NULL AS email_verified,
              u.phone_verified_at IS NOT NULL AS phone_verified, pr.username, pr.display_name,
              (SELECT coalesce(sum(weight), 0) FROM risk_signals s WHERE s.user_id = u.id AND s.status = 'open')::int AS score,
              (SELECT coalesce(json_agg(json_build_object(
                  'id', s.id, 'kind', s.kind, 'weight', s.weight, 'detail', s.detail, 'status', s.status, 'createdAt', s.created_at,
                  'targetType', s.target_type, 'targetId', s.target_id,
                  'excerpt', CASE s.target_type WHEN 'post' THEN (SELECT left(p.body, 200) FROM posts p WHERE p.id = s.target_id)
                                                WHEN 'message' THEN (SELECT left(m.body, 200) FROM messages m WHERE m.id = s.target_id) END)
                ORDER BY s.created_at DESC), '[]')
               FROM (SELECT * FROM risk_signals x WHERE x.user_id = u.id ORDER BY x.created_at DESC LIMIT 50) s) AS signals
       FROM users u JOIN profiles pr ON pr.user_id = u.id
       WHERE u.deleted_at IS NULL AND (${where})
       ORDER BY u.restricted_at IS NULL, score DESC, u.created_at DESC LIMIT 100`,
    );
    return {
      items: rows.map((r) => ({
        user: {
          id: r.id,
          username: r.username,
          displayName: r.display_name,
          email: r.email,
          status: r.status,
          createdAt: r.created_at,
          emailVerified: r.email_verified,
          phoneVerified: r.phone_verified,
        },
        restrictedAt: r.restricted_at,
        score: r.score,
        signals: r.signals,
      })),
    };
  });

  app.post('/v1/admin/risk/accounts/:id/review', { preHandler: requireRole('moderator', 'admin') }, async (req) => {
    const mod = me(req);
    const { id } = parse(idParam, req.params);
    const input = parse(z.object({ action: z.enum(['clear', 'confirm']), note: z.string().trim().max(2000).optional() }), req.body);
    if (id === mod.id) throw badRequest("You can't review your own account.");
    const result = await tx(db, async (c) => {
      const u = await c.query(`SELECT restricted_at FROM users WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [id]);
      if (!u.rows[0]) throw notFound('User');
      const signals = await c.query<{ kind: string; target_type: string | null; target_id: string | null }>(
        `UPDATE risk_signals SET status = $2, reviewed_by = $3, reviewed_at = now() WHERE user_id = $1 AND status = 'open' RETURNING kind, target_type, target_id`,
        [id, input.action === 'clear' ? 'cleared' : 'confirmed', mod.id],
      );
      if (!signals.rowCount && !u.rows[0].restricted_at) throw badRequest('This account has nothing waiting for review.');
      const ids = (type: string, held: boolean) => [
        ...new Set(
          signals.rows.filter((s) => s.target_type === type && s.target_id && (s.kind === 'held_while_limited') === held).map((s) => s.target_id as string),
        ),
      ];
      const flaggedPosts = ids('post', false);
      const flaggedMessages = ids('message', false);
      const heldPosts = ids('post', true);
      const decision = input.action === 'clear' ? 'no_action' : 'remove';
      if (input.action === 'clear') {
        await c.query(`UPDATE users SET restricted_at = NULL WHERE id = $1`, [id]);
        await c.query(`UPDATE posts SET moderation_status = 'normal' WHERE id = ANY($1::uuid[]) AND moderation_status = 'review'`, [flaggedPosts]);
        // Posts made while the account was limited were only visible to their author.
        await c.query(`UPDATE posts SET moderation_status = 'normal' WHERE id = ANY($1::uuid[]) AND moderation_status = 'restricted'`, [heldPosts]);
        await releaseMessages(c, flaggedMessages);
      } else {
        await c.query(`UPDATE users SET restricted_at = coalesce(restricted_at, now()) WHERE id = $1 AND role = 'user'`, [id]);
        await c.query(`UPDATE posts SET moderation_status = 'removed' WHERE id = ANY($1::uuid[]) AND moderation_status IN ('review', 'restricted')`, [
          flaggedPosts,
        ]);
        await c.query(
          `UPDATE messages SET moderation_status = 'removed', deleted_at = coalesce(deleted_at, now()) WHERE id = ANY($1::uuid[]) AND moderation_status = 'review'`,
          [flaggedMessages],
        );
      }
      // The automated cases for the flagged items are decided along with the account.
      const cases = await c.query<{ id: string }>(
        `UPDATE moderation_cases SET status = 'decided', decision = $3, reviewer_id = $4, note = $5, decided_at = now()
         WHERE status = 'open' AND source = 'automated' AND subject_user_id = $1
           AND ((target_type = 'post' AND target_id = ANY($2::uuid[])) OR (target_type = 'message' AND target_id = ANY($6::uuid[])))
         RETURNING id`,
        [id, flaggedPosts, decision, mod.id, input.note ?? null, flaggedMessages],
      );
      if (decision === 'remove')
        for (const k of cases.rows) await c.query(`INSERT INTO enforcements (case_id, user_id, action) VALUES ($1,$2,'remove')`, [k.id, id]);
      await audit(c, {
        actorId: mod.id,
        action: `account_risk.${input.action}`,
        entityType: 'user',
        entityId: id,
        metadata: { signals: signals.rowCount, posts: flaggedPosts.length, messages: flaggedMessages.length, note: input.note },
      });
      await notify(c, ctx.realtime, {
        userId: id,
        category: 'moderation',
        type: 'account_review',
        entityType: 'user',
        entityId: id,
        data: { outcome: input.action === 'clear' ? 'cleared' : 'confirmed' },
      });
      return { restricted: input.action === 'confirm', signals: signals.rowCount ?? 0 };
    });
    return result;
  });

  // ── Regional rules ────────────────────────────────────────────────────
  // Content that is legal in most places but not in one country is withheld
  // for viewers in that country only, never deleted. Every change is audited.
  const ruleDto = (r: Record<string, any>) => ({
    id: r.id,
    country: r.country,
    kind: r.kind,
    term: r.term,
    topic: r.topic,
    legalBasis: r.legal_basis,
    withheldPosts: Number(r.withheld ?? 0),
    createdAt: r.created_at,
  });

  app.get('/v1/admin/regional-rules', { preHandler: requireRole('admin') }, async () => {
    const { rows } = await db.query(
      `SELECT r.*, (SELECT count(*) FROM post_withholdings w WHERE w.rule_id = r.id) AS withheld FROM regional_rules r ORDER BY r.country, r.created_at`,
    );
    return { items: rows.map(ruleDto) };
  });

  app.post('/v1/admin/regional-rules', { preHandler: requireRole('admin') }, async (req, reply) => {
    const admin = me(req);
    const input = parse(
      z.discriminatedUnion('kind', [
        z.object({
          kind: z.literal('blocked_term'),
          country: z.string().regex(/^[A-Za-z]{2}$/),
          term: z.string().trim().min(2).max(100),
          legalBasis: z.string().trim().min(3).max(1000),
        }),
        z.object({
          kind: z.literal('restrict_topic'),
          country: z.string().regex(/^[A-Za-z]{2}$/),
          topic: z
            .string()
            .trim()
            .toLowerCase()
            .regex(/^[a-z0-9_-]{1,40}$/),
          legalBasis: z.string().trim().min(3).max(1000),
        }),
      ]),
      req.body,
    );
    const { rows } = await db
      .query(`INSERT INTO regional_rules (country, kind, term, topic, legal_basis, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [
        input.country.toUpperCase(),
        input.kind,
        input.kind === 'blocked_term' ? input.term : null,
        input.kind === 'restrict_topic' ? input.topic : null,
        input.legalBasis,
        admin.id,
      ])
      .catch((e) => {
        if (e.code === '23505') throw badRequest('That rule already exists for this country.');
        throw e;
      });
    await audit(db, { actorId: admin.id, action: 'regional_rule.create', entityType: 'regional_rule', entityId: rows[0].id, metadata: input });
    const withheld = await db.query(`SELECT count(*) AS n FROM post_withholdings WHERE rule_id = $1`, [rows[0].id]);
    reply.code(201);
    return { rule: ruleDto({ ...rows[0], withheld: withheld.rows[0].n }) };
  });

  app.delete('/v1/admin/regional-rules/:id', { preHandler: requireRole('admin') }, async (req, reply) => {
    const admin = me(req);
    const { id } = parse(idParam, req.params);
    const r = await db.query(`DELETE FROM regional_rules WHERE id = $1 RETURNING country, kind, term, topic`, [id]);
    if (!r.rowCount) throw notFound('Rule');
    await audit(db, { actorId: admin.id, action: 'regional_rule.delete', entityType: 'regional_rule', entityId: id, metadata: r.rows[0] });
    reply.code(204);
  });

  // ── Appeals ───────────────────────────────────────────────────────────
  app.post('/v1/appeals', { preHandler: requireAuth }, async (req, reply) => {
    const u = me(req);
    const input = parse(appealSchema, req.body);
    await tx(db, async (c) => {
      // Ad reviews aren't penalties: the advertiser sees the reason in Studio and can promote the post again after fixing it.
      const mc = await c.query(`SELECT status FROM moderation_cases WHERE id = $1 AND subject_user_id = $2 AND target_type <> 'ad_campaign' FOR UPDATE`, [
        input.caseId,
        u.id,
      ]);
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
       FROM moderation_cases mc WHERE mc.subject_user_id = $1 AND mc.decision IS NOT NULL AND mc.decision <> 'no_action'
         AND mc.target_type <> 'ad_campaign' ORDER BY mc.decided_at DESC`,
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
    const { rows } = await db.query(
      `SELECT id, actor_id, action, entity_type, entity_id, host(ip) AS ip, request_id, metadata, created_at FROM audit_logs ORDER BY id DESC LIMIT 200`,
    );
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
    const byAction = await db.query(
      `SELECT name, count(*) AS n FROM analytics_events WHERE meaningful AND created_at > now() - interval '7 days' GROUP BY name ORDER BY n DESC`,
    );
    return { northStar: 'meaningful social actions', summary: rows[0], meaningfulByAction: byAction.rows };
  });

  app.get('/v1/admin/ai/calls', { preHandler: requireRole('admin') }, async () => {
    const { rows } = await db.query(
      `SELECT task, provider, model, status, count(*) AS n, avg(latency_ms)::int AS avg_ms FROM ai_tool_calls WHERE created_at > now() - interval '7 days' GROUP BY 1,2,3,4 ORDER BY n DESC`,
    );
    return { items: rows };
  });

  // ── Feature flags ─────────────────────────────────────────────────────
  app.get('/v1/flags', async () => ({ flags: await getFlags(db) }));

  app.put('/v1/admin/flags/:key', { preHandler: requireRole('admin') }, async (req) => {
    const { key } = parse(z.object({ key: z.enum(FEATURE_FLAG_KEYS as [string, ...string[]]) }), req.params);
    const { enabled } = parse(z.object({ enabled: z.boolean() }), req.body);
    await db.query(`INSERT INTO feature_flags (key, enabled) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()`, [
      key,
      enabled,
    ]);
    await audit(db, { actorId: me(req).id, action: 'flag.set', entityType: 'feature_flag', entityId: key, metadata: { enabled } });
    return { flags: await getFlags(db) };
  });
}
