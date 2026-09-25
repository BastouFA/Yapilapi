import type { FastifyRequest } from 'fastify';
import { withTransaction, type Queryable, type Tx } from '@yapilapi/database';
import { randomToken, sha256Hex } from '@yapilapi/security';
import {
  AppError,
  conflict,
  decodeCursor,
  encodeCursor,
  forbidden,
  invalid,
  notFound,
  clampLimit,
  type PlatformRole,
} from '@yapilapi/shared';
import {
  DEFAULT_STRIKE_POLICY,
  escalate,
  pipelineFor,
  strikePointsFor,
  type CaseState,
  type StrikeSeverity,
} from '@yapilapi/moderation';
import type { AppContext } from '../../lib/context.js';
import { audit } from '../../lib/audit.js';
import { checkIdentity } from './impersonation.js';
import { notify } from '../../lib/notify.js';
import { track } from '../analytics/track.js';
import { isSenior, outranks } from '../admin/rbac.js';
import {
  applyContentAction,
  isContentTarget,
  loadTargetForStaff,
  loadTargetForViewer,
  restoreContent,
  type ContentAction,
  type EffectOp,
  type ReportTargetType,
} from './targets.js';
import type { DbRow } from '../../lib/db-row.js';

export const APPEAL_WINDOW_DAYS = 14;
export const DECISIONS = [
  'no_action',
  'label',
  'limit_reach',
  'remove',
  'suspend_user',
  'ban_user',
] as const;
export type Decision = (typeof DECISIONS)[number];
export const REPORT_REASONS = [
  'spam',
  'harassment',
  'hate',
  'violence',
  'sexual_content',
  'self_harm',
  'misinformation',
  'scam',
  'impersonation',
  'minor_safety',
  'illegal',
  'ip_violation',
  'other',
] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

type Risk = 'low' | 'medium' | 'high' | 'critical';
const RISK_RANK: Record<Risk, number> = { low: 1, medium: 2, high: 3, critical: 4 };
const RISKS: Risk[] = ['low', 'medium', 'high', 'critical'];
const maxRisk = (a: Risk, b: Risk): Risk => (RISK_RANK[a] >= RISK_RANK[b] ? a : b);

/** Base risk and the case category for each report reason. `minor_safety` is always critical and auto-escalates. */
export const REASON_PROFILE: Record<ReportReason, { risk: Risk; category: string }> = {
  spam: { risk: 'low', category: 'spam' },
  harassment: { risk: 'medium', category: 'harassment' },
  hate: { risk: 'medium', category: 'hate' },
  violence: { risk: 'high', category: 'threat' },
  sexual_content: { risk: 'medium', category: 'sexual_content' },
  self_harm: { risk: 'high', category: 'self_harm' },
  misinformation: { risk: 'low', category: 'misinformation' },
  scam: { risk: 'medium', category: 'scam' },
  impersonation: { risk: 'medium', category: 'impersonation' },
  minor_safety: { risk: 'critical', category: 'minor_safety' },
  illegal: { risk: 'high', category: 'illegal' },
  ip_violation: { risk: 'low', category: 'ip_violation' },
  other: { risk: 'low', category: 'other' },
};

export interface StaffActor {
  userId: string;
  role: PlatformRole;
}

export async function caseEvent(
  db: Queryable,
  caseId: string,
  actorId: string | null,
  event: string,
  fromState: string | null,
  toState: string | null,
  data: Record<string, unknown> = {},
): Promise<void> {
  await db.query(
    'INSERT INTO moderation_case_events (case_id, actor_id, event, from_state, to_state, data) VALUES ($1,$2,$3,$4,$5,$6)',
    [caseId, actorId, event, fromState, toState, JSON.stringify(data)],
  );
}

// ================================================================ reports

export interface CreatedReport {
  id: string;
  status: string;
  duplicate: boolean;
}

export async function createReport(
  ctx: AppContext,
  reporterId: string,
  input: {
    targetType: ReportTargetType;
    targetId: string;
    reason: ReportReason;
    details?: string | undefined;
  },
): Promise<CreatedReport> {
  const info = await loadTargetForViewer(ctx.db, reporterId, input.targetType, input.targetId);
  if (!info) throw notFound('Target');
  if (info.subjectUserId === reporterId)
    throw new AppError('unprocessable', 'You cannot report your own content or account');

  const created = await withTransaction(ctx.db, async (tx) => {
    const ins = await tx.query<{ id: string }>(
      `INSERT INTO reports (reporter_id, target_type, target_id, reason, details) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (reporter_id, target_type, target_id, reason) DO NOTHING RETURNING id`,
      [reporterId, input.targetType, input.targetId, input.reason, input.details ?? null],
    );
    if (!ins.rows[0]) {
      const ex = await tx.query<{ id: string; status: string }>(
        'SELECT id, status FROM reports WHERE reporter_id = $1 AND target_type = $2 AND target_id = $3 AND reason = $4',
        [reporterId, input.targetType, input.targetId, input.reason],
      );
      return { id: ex.rows[0]!.id, status: ex.rows[0]!.status, duplicate: true };
    }
    const reportId = ins.rows[0].id;
    const profile = REASON_PROFILE[input.reason];

    const open = await tx.query<{
      id: string;
      risk_level: Risk;
      categories: string[];
      state: CaseState;
    }>(
      `SELECT id, risk_level, categories, state FROM moderation_cases WHERE target_type = $1 AND target_id = $2 AND state <> 'resolved' ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
      [input.targetType, input.targetId],
    );
    let caseId: string;
    let firstSelfHarm = input.reason === 'self_harm';
    if (open.rows[0]) {
      const c = open.rows[0];
      caseId = c.id;
      await tx.query('INSERT INTO report_cases (report_id, case_id) VALUES ($1,$2)', [
        reportId,
        caseId,
      ]);
      const distinct = await tx.query<{ n: number }>(
        'SELECT count(DISTINCT r.reporter_id)::int AS n FROM report_cases rc JOIN reports r ON r.id = rc.report_id WHERE rc.case_id = $1',
        [caseId],
      );
      const n = distinct.rows[0]!.n;
      let risk = maxRisk(c.risk_level, profile.risk);
      if (n >= 10) risk = maxRisk(risk, 'critical');
      else if (n >= 3) risk = maxRisk(risk, 'high');
      const categories = [...new Set([...c.categories, profile.category])];
      firstSelfHarm = input.reason === 'self_harm' && !c.categories.includes('self_harm');
      // Pending or automated-only cases become human-reviewable; minor safety always escalates. Appealed/resolved are untouched (filtered above).
      const state: CaseState =
        input.reason === 'minor_safety' ? 'escalated' : c.state === 'normal' ? 'review' : c.state;
      await tx.query(
        'UPDATE moderation_cases SET report_count = report_count + 1, risk_level = $2, categories = $3, state = $4 WHERE id = $1',
        [caseId, risk, categories, state],
      );
      await caseEvent(tx, caseId, null, 'report_attached', c.state, state, {
        reason: input.reason,
        distinctReporters: n,
      });
    } else {
      const snapshot = { ...info.snapshot, capturedAt: new Date().toISOString() };
      const state: CaseState = input.reason === 'minor_safety' ? 'escalated' : 'review';
      const created = await tx.query<{ id: string }>(
        `INSERT INTO moderation_cases (target_type, target_id, subject_user_id, source, risk_level, categories, signals, state, content_snapshot, report_count)
         VALUES ($1,$2,$3,'user_report',$4,$5,$6,$7,$8,1) RETURNING id`,
        [
          input.targetType,
          input.targetId,
          info.subjectUserId,
          profile.risk,
          [profile.category],
          JSON.stringify({ reports: [input.reason] }),
          state,
          JSON.stringify(snapshot),
        ],
      );
      caseId = created.rows[0]!.id;
      await tx.query('INSERT INTO report_cases (report_id, case_id) VALUES ($1,$2)', [
        reportId,
        caseId,
      ]);
      await caseEvent(tx, caseId, null, 'case_opened', null, state, {
        source: 'user_report',
        reason: input.reason,
      });
    }
    // Impersonation reports come with an automatic similarity analysis against protected identities.
    if (input.reason === 'impersonation' && input.targetType === 'user') {
      const s = info.snapshot as { username?: string; displayName?: string };
      const analysis = await checkIdentity(
        ctx,
        { username: s.username, displayName: s.displayName },
        input.targetId,
      );
      await tx.query(`UPDATE moderation_cases SET signals = signals || $2::jsonb WHERE id = $1`, [
        caseId,
        JSON.stringify({ impersonation: analysis }),
      ]);
    }
    // Someone may be in distress: the reported person (never the reporter's identity) gets support resources.
    if (firstSelfHarm && info.subjectUserId) {
      await notify(
        ctx,
        {
          userId: info.subjectUserId,
          kind: 'safety_support',
          data: { resources: '/v1/safety/resources' },
        },
        tx,
      );
    }
    ctx.metrics.events.inc({ name: 'report_created' });
    return { id: reportId, status: 'open', duplicate: false };
  });
  // After commit; consent-gated, aggregate-only (reason category, no ids or text).
  if (!created.duplicate)
    await track(ctx, 'report_created', { reason: input.reason }, { userId: reporterId });
  return created;
}

export async function listMyReports(
  ctx: AppContext,
  userId: string,
  q: { cursor?: string | undefined; limit?: number | undefined },
) {
  const limit = clampLimit(q.limit);
  const cur = decodeCursor<{ t: string; id: string }>(q.cursor);
  const { rows } = await ctx.db.query(
    `SELECT r.id, r.target_type, r.target_id, r.reason, r.status, r.created_at, r.created_at::text AS created_raw,
            (SELECT c.decision FROM report_cases rc JOIN moderation_cases c ON c.id = rc.case_id WHERE rc.report_id = r.id ORDER BY c.created_at DESC LIMIT 1) AS decision,
            (SELECT c.resolved_at FROM report_cases rc JOIN moderation_cases c ON c.id = rc.case_id WHERE rc.report_id = r.id ORDER BY c.created_at DESC LIMIT 1) AS resolved_at
       FROM reports r
      WHERE r.reporter_id = $1 AND ($2::timestamptz IS NULL OR (r.created_at, r.id) < ($2::timestamptz, $3::uuid))
      ORDER BY r.created_at DESC, r.id DESC LIMIT $4`,
    [userId, cur?.t ?? null, cur?.id ?? null, limit + 1],
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
      // Deliberately coarse: reporters learn the outcome class, never the subject's enforcement details.
      outcome:
        r.status === 'actioned'
          ? 'action_taken'
          : r.status === 'dismissed'
            ? 'no_violation_found'
            : r.status === 'triaged'
              ? 'under_review'
              : 'received',
      createdAt: r.created_at.toISOString(),
      resolvedAt: r.resolved_at ? r.resolved_at.toISOString() : null,
    })),
    nextCursor:
      rows.length > limit && last ? encodeCursor({ t: last.created_raw, id: last.id }) : null,
  };
}

// ================================================================ staff: case queue

export interface CaseFilters {
  state?: string | undefined;
  risk?: string | undefined;
  targetType?: string | undefined;
  source?: string | undefined;
  category?: string | undefined;
  assigned?: 'me' | 'none' | 'any' | undefined;
  cursor?: string | undefined;
  limit?: number | undefined;
}

const CASE_LIST_COLS = `mc.id, mc.target_type, mc.target_id, mc.subject_user_id, mc.source, mc.risk_level, mc.risk_rank, mc.categories, mc.state, mc.decision,
  mc.assigned_to, mc.report_count, mc.created_at, mc.created_at::text AS created_raw, mc.updated_at, mc.decided_at, sp.username AS subject_username`;

/** Queue order: highest risk first, then oldest first. Keyset over (risk_rank DESC, created_at ASC, id ASC). */
export async function listCases(ctx: AppContext, actorId: string, f: CaseFilters) {
  const limit = clampLimit(f.limit);
  const cur = decodeCursor<{ r: number; t: string; id: string }>(f.cursor);
  const params: unknown[] = [];
  const add = (v: unknown) => (params.push(v), `$${params.length}`);
  const where: string[] = [];
  if (f.state) where.push(`mc.state = ${add(f.state)}`);
  else where.push(`mc.state <> 'resolved'`);
  if (f.risk) where.push(`mc.risk_level = ${add(f.risk)}`);
  if (f.targetType) where.push(`mc.target_type = ${add(f.targetType)}`);
  if (f.source) where.push(`mc.source = ${add(f.source)}`);
  if (f.category) where.push(`${add(f.category)} = ANY (mc.categories)`);
  if (f.assigned === 'me') where.push(`mc.assigned_to = ${add(actorId)}`);
  else if (f.assigned === 'none') where.push('mc.assigned_to IS NULL');
  if (cur) {
    const r = add(cur.r),
      t = add(cur.t),
      id = add(cur.id);
    where.push(
      `(mc.risk_rank < ${r}::int OR (mc.risk_rank = ${r}::int AND (mc.created_at, mc.id) > (${t}::timestamptz, ${id}::uuid)))`,
    );
  }
  const { rows } = await ctx.db.query(
    `SELECT ${CASE_LIST_COLS} FROM moderation_cases mc LEFT JOIN profiles sp ON sp.user_id = mc.subject_user_id
      WHERE ${where.join(' AND ')} ORDER BY mc.risk_rank DESC, mc.created_at ASC, mc.id ASC LIMIT ${add(limit + 1)}`,
    params,
  );
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page.map(caseSummary),
    nextCursor:
      rows.length > limit && last
        ? encodeCursor({ r: last.risk_rank, t: last.created_raw, id: last.id })
        : null,
  };
}

function caseSummary(r: DbRow) {
  return {
    id: r.id,
    targetType: r.target_type,
    targetId: r.target_id,
    subject: r.subject_user_id
      ? { id: r.subject_user_id, username: r.subject_username ?? null }
      : null,
    source: r.source,
    riskLevel: r.risk_level,
    categories: r.categories,
    state: r.state,
    decision: r.decision,
    assignedTo: r.assigned_to,
    reportCount: r.report_count,
    createdAt: r.created_at.toISOString(),
    decidedAt: r.decided_at ? r.decided_at.toISOString() : null,
    pipeline: pipelineFor({ state: r.state, decided: Boolean(r.decided_at) }),
  };
}

export async function queueStats(ctx: AppContext) {
  const { rows } = await ctx.db.query<{
    state: string;
    risk_level: string;
    n: number;
    oldest: Date | null;
  }>(
    `SELECT state, risk_level, count(*)::int AS n, min(created_at) AS oldest FROM moderation_cases WHERE state <> 'resolved' GROUP BY state, risk_level`,
  );
  const open = await ctx.db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM appeals WHERE status = 'open'`,
  );
  return {
    queue: rows.map((r) => ({
      state: r.state,
      riskLevel: r.risk_level,
      count: r.n,
      oldest: r.oldest?.toISOString() ?? null,
    })),
    openAppeals: open.rows[0]!.n,
  };
}

export async function getCaseDetail(
  ctx: AppContext,
  caseId: string,
  opts: { includeReporters: boolean },
) {
  const { rows } = await ctx.db.query(
    `SELECT ${CASE_LIST_COLS}, mc.signals, mc.content_snapshot, mc.decision_reason, mc.decision_note, mc.decided_by, mc.effects, mc.claimed_at
      FROM moderation_cases mc LEFT JOIN profiles sp ON sp.user_id = mc.subject_user_id WHERE mc.id = $1`,
    [caseId],
  );
  const c = rows[0];
  if (!c) throw notFound('Case');
  const [reports, events, appeals, live, subject] = await Promise.all([
    ctx.db.query(
      `SELECT r.id, r.reporter_id, r.reason, r.details, r.status, r.created_at FROM report_cases rc JOIN reports r ON r.id = rc.report_id WHERE rc.case_id = $1 ORDER BY r.created_at`,
      [caseId],
    ),
    ctx.db.query(
      `SELECT id, actor_id, event, from_state, to_state, data, created_at FROM moderation_case_events WHERE case_id = $1 ORDER BY id`,
      [caseId],
    ),
    ctx.db.query(
      `SELECT id, user_id, status, statement, reviewer_id, reviewer_note, original_decider_id, created_at, decided_at FROM appeals WHERE case_id = $1 ORDER BY created_at`,
      [caseId],
    ),
    loadTargetForStaff(ctx.db, c.target_type, c.target_id),
    c.subject_user_id ? subjectSummary(ctx.db, c.subject_user_id) : Promise.resolve(null),
  ]);
  const severity = c.risk_level as StrikeSeverity;
  const preview = subject
    ? escalate({ activePoints: subject.activeStrikePoints, severity, categories: c.categories })
    : null;
  return {
    ...caseSummary(c),
    signals: c.signals,
    snapshot: c.content_snapshot,
    currentContent: live?.snapshot ?? null,
    decision: c.decision
      ? {
          decision: c.decision,
          reason: c.decision_reason,
          note: c.decision_note,
          decidedBy: c.decided_by,
          decidedAt: c.decided_at?.toISOString() ?? null,
          effects: c.effects,
        }
      : null,
    claimedAt: c.claimed_at?.toISOString() ?? null,
    reports: reports.rows.map((r) => ({
      id: r.id,
      ...(opts.includeReporters ? { reporterId: r.reporter_id } : {}),
      reason: r.reason,
      details: r.details,
      status: r.status,
      createdAt: r.created_at.toISOString(),
    })),
    timeline: events.rows.map((e) => ({
      id: e.id,
      actorId: e.actor_id,
      event: e.event,
      from: e.from_state,
      to: e.to_state,
      data: e.data,
      at: e.created_at.toISOString(),
    })),
    appeals: appeals.rows.map((a) => ({
      id: a.id,
      userId: a.user_id,
      status: a.status,
      statement: a.statement,
      reviewerId: a.reviewer_id,
      reviewerNote: a.reviewer_note,
      originalDeciderId: a.original_decider_id,
      createdAt: a.created_at.toISOString(),
      decidedAt: a.decided_at?.toISOString() ?? null,
    })),
    subjectSummary: subject,
    ladderPreview: preview
      ? {
          pointsIfViolation: preview.pointsAdded,
          totalPoints: preview.totalPoints,
          action: preview.action,
          days: preview.days,
          recommendation: preview.recommendation,
        }
      : null,
  };
}

export async function subjectSummary(db: Queryable, userId: string) {
  const [u, e, pts] = await Promise.all([
    db.query(
      `SELECT u.id, u.status, u.platform_role, u.age_band, u.created_at, p.username, p.display_name FROM users u LEFT JOIN profiles p ON p.user_id = u.id WHERE u.id = $1`,
      [userId],
    ),
    db.query(
      `SELECT id, kind, reason, strike_points, starts_at, ends_at, revoked_at, case_id FROM enforcements WHERE user_id = $1 ORDER BY starts_at DESC LIMIT 20`,
      [userId],
    ),
    activePoints(db, userId),
  ]);
  const r = u.rows[0];
  if (!r) return null;
  return {
    id: r.id,
    username: r.username,
    displayName: r.display_name,
    status: r.status,
    role: r.platform_role as PlatformRole,
    ageBand: r.age_band,
    createdAt: r.created_at.toISOString(),
    activeStrikePoints: pts,
    enforcements: e.rows.map((x) => ({
      id: x.id,
      kind: x.kind,
      reason: x.reason,
      strikePoints: x.strike_points,
      startsAt: x.starts_at.toISOString(),
      endsAt: x.ends_at?.toISOString() ?? null,
      revokedAt: x.revoked_at?.toISOString() ?? null,
      caseId: x.case_id,
    })),
  };
}

export async function activePoints(db: Queryable, userId: string): Promise<number> {
  const { rows } = await db.query<{ p: number }>(
    `SELECT COALESCE(sum(strike_points), 0)::int AS p FROM enforcements WHERE user_id = $1 AND revoked_at IS NULL AND created_at > now() - ($2 || ' days')::interval`,
    [userId, String(DEFAULT_STRIKE_POLICY.windowDays)],
  );
  return rows[0]!.p;
}

// ================================================================ staff: claim / release / escalate

export async function claimCase(
  ctx: AppContext,
  actor: StaffActor,
  caseId: string,
  req?: FastifyRequest,
): Promise<void> {
  await withTransaction(ctx.db, async (tx) => {
    const c = (
      await tx.query<{ state: CaseState; assigned_to: string | null }>(
        'SELECT state, assigned_to FROM moderation_cases WHERE id = $1 FOR UPDATE',
        [caseId],
      )
    ).rows[0];
    if (!c) throw notFound('Case');
    if (c.state === 'resolved') throw conflict('This case is already resolved');
    if (c.state === 'escalated' && !isSenior(actor.role))
      throw forbidden('Escalated cases are handled by admins');
    if (c.assigned_to && c.assigned_to !== actor.userId && !isSenior(actor.role))
      throw conflict('This case is claimed by another moderator');
    await tx.query(
      'UPDATE moderation_cases SET assigned_to = $2, claimed_at = now() WHERE id = $1',
      [caseId, actor.userId],
    );
    await tx.query(
      `UPDATE reports SET status = 'triaged' WHERE status = 'open' AND id IN (SELECT report_id FROM report_cases WHERE case_id = $1)`,
      [caseId],
    );
    await caseEvent(tx, caseId, actor.userId, 'claimed', c.state, c.state, {
      previous: c.assigned_to,
    });
    await audit(
      ctx,
      {
        actorId: actor.userId,
        actorType: 'staff',
        action: 'moderation.case_claimed',
        targetType: 'moderation_case',
        targetId: caseId,
      },
      req,
      tx,
    );
  });
}

export async function releaseCase(
  ctx: AppContext,
  actor: StaffActor,
  caseId: string,
  req?: FastifyRequest,
): Promise<void> {
  await withTransaction(ctx.db, async (tx) => {
    const c = (
      await tx.query<{ state: CaseState; assigned_to: string | null }>(
        'SELECT state, assigned_to FROM moderation_cases WHERE id = $1 FOR UPDATE',
        [caseId],
      )
    ).rows[0];
    if (!c) throw notFound('Case');
    if (c.assigned_to !== actor.userId && !isSenior(actor.role))
      throw forbidden('Only the assignee can release a case');
    await tx.query(
      'UPDATE moderation_cases SET assigned_to = NULL, claimed_at = NULL WHERE id = $1',
      [caseId],
    );
    await caseEvent(tx, caseId, actor.userId, 'released', c.state, c.state);
    await audit(
      ctx,
      {
        actorId: actor.userId,
        actorType: 'staff',
        action: 'moderation.case_released',
        targetType: 'moderation_case',
        targetId: caseId,
      },
      req,
      tx,
    );
  });
}

export async function escalateCase(
  ctx: AppContext,
  actor: StaffActor,
  caseId: string,
  note: string,
  req?: FastifyRequest,
): Promise<void> {
  await withTransaction(ctx.db, async (tx) => {
    const c = (
      await tx.query<{ state: CaseState }>(
        'SELECT state FROM moderation_cases WHERE id = $1 FOR UPDATE',
        [caseId],
      )
    ).rows[0];
    if (!c) throw notFound('Case');
    if (c.state === 'resolved' || c.state === 'appealed')
      throw conflict('This case can no longer be escalated');
    await tx.query(
      `UPDATE moderation_cases SET state = 'escalated', assigned_to = NULL, claimed_at = NULL, risk_level = CASE WHEN risk_rank < 3 THEN 'high' ELSE risk_level END WHERE id = $1`,
      [caseId],
    );
    await caseEvent(tx, caseId, actor.userId, 'escalated', c.state, 'escalated', { note });
    await audit(
      ctx,
      {
        actorId: actor.userId,
        actorType: 'staff',
        action: 'moderation.case_escalated',
        targetType: 'moderation_case',
        targetId: caseId,
        metadata: { note },
      },
      req,
      tx,
    );
  });
}

// ================================================================ enforcement primitives

export interface AppliedSuspension {
  enforcementId: string;
  endsAt: Date | null;
  appealToken: string;
}

export async function revokeAllAccess(tx: Queryable, userId: string): Promise<void> {
  await tx.query(
    'UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL',
    [userId],
  );
  await tx.query(
    'UPDATE oauth_tokens SET revoked_at = now() WHERE revoked_at IS NULL AND grant_id IN (SELECT id FROM oauth_grants WHERE user_id = $1)',
    [userId],
  );
  await tx.query('DELETE FROM ws_tickets WHERE user_id = $1', [userId]);
}

/**
 * Suspend (temporary) or ban (permanent) an account: creates the enforcement, flips users.status, and revokes every
 * session and OAuth token so the account is locked out immediately. Runs in the caller's transaction.
 */
export async function applySuspension(
  tx: Tx,
  p: {
    userId: string;
    kind: 'suspension' | 'ban';
    days?: number | null | undefined;
    reason: string;
    caseId?: string | null | undefined;
    actorId: string | null;
    strikePoints?: number | undefined;
    scope?: string | undefined;
  },
): Promise<AppliedSuspension> {
  const cur = await tx.query<{ status: string }>(
    'SELECT status FROM users WHERE id = $1 FOR UPDATE',
    [p.userId],
  );
  if (!cur.rows[0]) throw notFound('User');
  const token = randomToken(32);
  const endsAt = p.kind === 'ban' || !p.days ? null : new Date(Date.now() + p.days * 86_400_000);
  const ins = await tx.query<{ id: string }>(
    `INSERT INTO enforcements (case_id, user_id, kind, reason, ends_at, created_by, strike_points, metadata, appeal_token_hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [
      p.caseId ?? null,
      p.userId,
      p.kind,
      p.reason,
      endsAt,
      p.actorId,
      p.strikePoints ?? 0,
      JSON.stringify({ previousStatus: cur.rows[0].status, scope: p.scope ?? 'account' }),
      sha256Hex(token),
    ],
  );
  if (['active', 'deactivated'].includes(cur.rows[0].status))
    await tx.query(`UPDATE users SET status = 'suspended' WHERE id = $1`, [p.userId]);
  await revokeAllAccess(tx, p.userId);
  return { enforcementId: ins.rows[0]!.id, endsAt, appealToken: token };
}

/** If nothing active suspends the account any more, put it back to the status it had before. Returns true if reinstated. */
export async function reinstateIfClear(tx: Queryable, userId: string): Promise<boolean> {
  const st = await tx.query<{ status: string }>(
    'SELECT status FROM users WHERE id = $1 FOR UPDATE',
    [userId],
  );
  if (st.rows[0]?.status !== 'suspended') return false;
  const active = await tx.query(
    `SELECT 1 FROM enforcements WHERE user_id = $1 AND kind IN ('suspension','ban') AND revoked_at IS NULL AND (ends_at IS NULL OR ends_at > now()) LIMIT 1`,
    [userId],
  );
  if (active.rowCount) return false;
  const prev = await tx.query<{ previous: string | null }>(
    `SELECT metadata->>'previousStatus' AS previous FROM enforcements WHERE user_id = $1 AND kind IN ('suspension','ban') ORDER BY created_at DESC LIMIT 1`,
    [userId],
  );
  const target = ['active', 'deactivated'].includes(prev.rows[0]?.previous ?? '')
    ? prev.rows[0]!.previous!
    : 'active';
  await tx.query('UPDATE users SET status = $2 WHERE id = $1', [userId, target]);
  return true;
}

/**
 * Job: reinstate accounts whose time-limited suspension has ended. Idempotent; safe to run every few minutes
 * (scripts/expire-enforcements.ts). Only touches accounts that HAVE an ended suspension enforcement and no active one.
 */
export async function expireEnforcements(ctx: AppContext): Promise<{ reinstated: number }> {
  const { rows } = await ctx.db.query<{ user_id: string }>(
    `SELECT DISTINCT e.user_id FROM enforcements e JOIN users u ON u.id = e.user_id
      WHERE e.kind = 'suspension' AND e.revoked_at IS NULL AND e.ends_at IS NOT NULL AND e.ends_at <= now() AND u.status = 'suspended'`,
  );
  let reinstated = 0;
  for (const r of rows) {
    const ok = await withTransaction(ctx.db, (tx) => reinstateIfClear(tx, r.user_id));
    if (ok) {
      reinstated++;
      await audit(ctx, {
        actorType: 'system',
        action: 'moderation.suspension_expired',
        targetType: 'user',
        targetId: r.user_id,
      });
      await notify(ctx, { userId: r.user_id, kind: 'account_reinstated', actorId: null, data: {} });
    }
  }
  return { reinstated };
}

// ================================================================ staff: decisions

export interface DecisionInput {
  decision: Decision;
  /** Shown to the affected user. */
  reason: string;
  /** Internal, staff-only. */
  note?: string | undefined;
  durationDays?: number | undefined;
}

export interface DecisionResult {
  caseId: string;
  decision: Decision;
  state: 'resolved';
  enforcementIds: string[];
  strike: {
    pointsAdded: number;
    totalPoints: number;
    ladderAction: string;
    ladderDays: number | null;
    recommendation: { action: string; days: number | null } | null;
  } | null;
  contentEffects: number;
}

const CONTENT_ACTION: Record<Decision, ContentAction> = {
  no_action: 'no_action',
  label: 'label',
  limit_reach: 'limit_reach',
  remove: 'remove',
  suspend_user: 'remove',
  ban_user: 'remove',
};

export async function decideCase(
  ctx: AppContext,
  actor: StaffActor,
  caseId: string,
  input: DecisionInput,
  req?: FastifyRequest,
): Promise<DecisionResult> {
  const pending: Array<() => Promise<void>> = [];
  const result = await withTransaction(ctx.db, async (tx) => {
    const c = (
      await tx.query<DbRow>('SELECT * FROM moderation_cases WHERE id = $1 FOR UPDATE', [caseId])
    ).rows[0];
    if (!c) throw notFound('Case');
    if (c.state === 'resolved') throw conflict('This case has already been decided');
    if (c.state === 'appealed')
      throw conflict('This case is under appeal; the appeal reviewer decides it');
    if (c.state === 'escalated' && !isSenior(actor.role))
      throw forbidden('Escalated cases can only be decided by an admin');
    if (input.decision === 'ban_user' && !isSenior(actor.role))
      throw forbidden('Only admins can ban accounts');
    if (c.assigned_to && c.assigned_to !== actor.userId && !isSenior(actor.role))
      throw conflict('This case is claimed by another moderator');

    const type = c.target_type as ReportTargetType;
    const target = await loadTargetForStaff(tx, type, c.target_id);
    const subjectId: string | null = c.subject_user_id ?? target?.subjectUserId ?? null;
    if (subjectId && subjectId === actor.userId)
      throw forbidden('You cannot decide a case about yourself');
    if (type === 'user' && input.decision === 'remove')
      throw invalid('Use suspend_user or ban_user to act against an account');
    if ((input.decision === 'suspend_user' || input.decision === 'ban_user') && !subjectId)
      throw invalid('This case has no account to act against');

    let subjectRole: PlatformRole = 'user';
    if (subjectId) {
      const s = await tx.query<{ platform_role: PlatformRole }>(
        'SELECT platform_role FROM users WHERE id = $1',
        [subjectId],
      );
      subjectRole = s.rows[0]?.platform_role ?? 'user';
      if (
        ['suspend_user', 'ban_user'].includes(input.decision) &&
        subjectRole !== 'user' &&
        !outranks(actor.role, subjectRole)
      ) {
        throw forbidden('You cannot take account action against staff of equal or higher rank');
      }
    }

    // 1. effects on the content itself
    let ops: EffectOp[] = [];
    if (target && isContentTarget(type))
      ops = await applyContentAction(
        tx,
        type,
        c.target_id,
        CONTENT_ACTION[input.decision],
        input.reason,
      );

    // 2. enforcement rows + strike ladder
    const enforcementIds: string[] = [];
    let strike: DecisionResult['strike'] = null;
    let suspension: AppliedSuspension | null = null;
    const severity = c.risk_level as StrikeSeverity;
    const mk = async (
      kind: string,
      points: number,
      endsAt: Date | null,
      meta: Record<string, unknown> = {},
    ) => {
      const r = await tx.query<{ id: string }>(
        `INSERT INTO enforcements (case_id, user_id, kind, reason, ends_at, created_by, strike_points, metadata) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [caseId, subjectId, kind, input.reason, endsAt, actor.userId, points, JSON.stringify(meta)],
      );
      enforcementIds.push(r.rows[0]!.id);
    };
    if (subjectId && input.decision !== 'no_action') {
      const before = await activePoints(tx, subjectId);
      if (input.decision === 'label') {
        await mk('warning', 0, null, { scope: 'content' });
      } else if (input.decision === 'limit_reach' || input.decision === 'remove') {
        const esc = escalate(
          { activePoints: before, severity, categories: c.categories },
          DEFAULT_STRIKE_POLICY,
        );
        await mk(
          input.decision === 'remove' ? 'content_removed' : 'limit_reach',
          esc.pointsAdded,
          null,
          { scope: 'content' },
        );
        if (esc.action === 'limit_reach')
          await mk('limit_reach', 0, new Date(Date.now() + (esc.days ?? 3) * 86_400_000), {
            scope: 'account',
            ladder: true,
          });
        else if (esc.action === 'suspension') {
          suspension = await applySuspension(tx, {
            userId: subjectId,
            kind: 'suspension',
            days: esc.days ?? 3,
            reason: input.reason,
            caseId,
            actorId: actor.userId,
            scope: 'account',
          });
          enforcementIds.push(suspension.enforcementId);
        }
        strike = {
          pointsAdded: esc.pointsAdded,
          totalPoints: esc.totalPoints,
          ladderAction: esc.action,
          ladderDays: esc.days,
          recommendation: esc.recommendation,
        };
      } else {
        const points = strikePointsFor(severity);
        const kind = input.decision === 'ban_user' ? 'ban' : 'suspension';
        suspension = await applySuspension(tx, {
          userId: subjectId,
          kind,
          days: kind === 'ban' ? null : (input.durationDays ?? 7),
          reason: input.reason,
          caseId,
          actorId: actor.userId,
          strikePoints: points,
        });
        enforcementIds.push(suspension.enforcementId);
        strike = {
          pointsAdded: points,
          totalPoints: before + points,
          ladderAction: kind,
          ladderDays: input.durationDays ?? (kind === 'ban' ? null : 7),
          recommendation: null,
        };
      }
    }

    // 3. close the case
    const effects = { ops, enforcementIds, strike };
    await tx.query(
      `UPDATE moderation_cases SET state = 'resolved', decision = $2, decided_by = $3, decided_at = now(), resolved_at = now(), decision_reason = $4, decision_note = $5,
              effects = $6, assigned_to = COALESCE(assigned_to, $3) WHERE id = $1`,
      [
        caseId,
        input.decision,
        actor.userId,
        input.reason,
        input.note ?? null,
        JSON.stringify(effects),
      ],
    );
    await tx.query(
      `UPDATE reports SET status = $2 WHERE id IN (SELECT report_id FROM report_cases WHERE case_id = $1)`,
      [caseId, input.decision === 'no_action' ? 'dismissed' : 'actioned'],
    );
    await caseEvent(tx, caseId, actor.userId, 'decided', c.state, 'resolved', {
      decision: input.decision,
      reason: input.reason,
      enforcementIds,
    });
    await audit(
      ctx,
      {
        actorId: actor.userId,
        actorType: 'staff',
        action: 'moderation.decision',
        targetType: 'moderation_case',
        targetId: caseId,
        metadata: {
          decision: input.decision,
          targetType: type,
          targetId: c.target_id,
          subjectId,
          enforcementIds,
          contentOps: ops.length,
          strike,
        },
      },
      req,
      tx,
    );

    // 4. notifications (after commit)
    const reporters = await tx.query<{ reporter_id: string }>(
      `SELECT DISTINCT r.reporter_id FROM report_cases rc JOIN reports r ON r.id = rc.report_id WHERE rc.case_id = $1`,
      [caseId],
    );
    const suspended = suspension;
    if (subjectId && input.decision !== 'no_action') {
      pending.push(async () => {
        const deadline = new Date(Date.now() + APPEAL_WINDOW_DAYS * 86_400_000).toISOString();
        await notify(ctx, {
          userId: subjectId,
          kind: suspended ? 'account_suspended' : 'moderation_decision',
          actorId: null,
          targetType: type,
          targetId: c.target_id,
          data: {
            caseId,
            decision: input.decision,
            reason: input.reason,
            appealable: true,
            appealBy: deadline,
            endsAt: suspended?.endsAt?.toISOString() ?? null,
          },
        });
        if (suspended) {
          const u = await ctx.db.query<{ email: string }>('SELECT email FROM users WHERE id = $1', [
            subjectId,
          ]);
          if (u.rows[0]) {
            await ctx.email
              .send({
                to: u.rows[0].email,
                subject:
                  input.decision === 'ban_user'
                    ? 'Your YAPILAPI account has been banned'
                    : 'Your YAPILAPI account has been suspended',
                text: `We took action on your account: ${input.reason}\n\nYou can appeal this decision within ${APPEAL_WINDOW_DAYS} days: ${ctx.config.WEB_PUBLIC_URL}/appeal?token=${suspended.appealToken}\n\nThis link is personal to you. Do not share it.`,
              })
              .catch((err: unknown) => ctx.log.warn({ err }, 'appeal email failed'));
          }
        }
      });
    }
    for (const r of reporters.rows) {
      pending.push(() =>
        notify(ctx, {
          userId: r.reporter_id,
          kind: 'report_update',
          actorId: null,
          targetType: type,
          targetId: c.target_id,
          data: { outcome: input.decision === 'no_action' ? 'no_violation_found' : 'action_taken' },
        }),
      );
    }
    const out: DecisionResult = {
      caseId,
      decision: input.decision,
      state: 'resolved',
      enforcementIds,
      strike,
      contentEffects: ops.length,
    };
    return out;
  });
  for (const fn of pending) await fn();
  ctx.metrics.events.inc({ name: `moderation_decision_${input.decision}` });
  return result;
}

// ================================================================ user-facing enforcement history + appeals

export async function listUserEnforcements(ctx: AppContext, userId: string) {
  const { rows } = await ctx.db.query(
    `SELECT e.id, e.kind, e.reason, e.starts_at, e.ends_at, e.revoked_at, e.case_id, c.target_type, c.decided_at, c.state AS case_state,
            (SELECT a.status FROM appeals a WHERE a.case_id = e.case_id AND a.user_id = e.user_id) AS appeal_status
       FROM enforcements e LEFT JOIN moderation_cases c ON c.id = e.case_id
      WHERE e.user_id = $1 ORDER BY e.starts_at DESC, e.id LIMIT 100`,
    [userId],
  );
  const now = Date.now();
  return rows.map((r) => {
    const decidedAt: Date | null = r.decided_at;
    const deadline = decidedAt
      ? new Date(decidedAt.getTime() + APPEAL_WINDOW_DAYS * 86_400_000)
      : null;
    const active = !r.revoked_at && (!r.ends_at || r.ends_at.getTime() > now);
    return {
      id: r.id,
      kind: r.kind,
      reason: r.reason,
      startsAt: r.starts_at.toISOString(),
      endsAt: r.ends_at?.toISOString() ?? null,
      active,
      revoked: Boolean(r.revoked_at),
      caseId: r.case_id,
      targetType: r.target_type ?? null,
      appeal: {
        status: r.appeal_status ?? null,
        canAppeal: Boolean(
          r.case_id &&
          decidedAt &&
          r.kind !== 'warning' &&
          !r.appeal_status &&
          deadline &&
          deadline.getTime() > now &&
          r.case_state === 'resolved',
        ),
        deadline: deadline?.toISOString() ?? null,
      },
    };
  });
}

export async function createAppeal(
  ctx: AppContext,
  who: { userId: string } | { token: string },
  input: { caseId?: string | undefined; enforcementId?: string | undefined; statement: string },
  req?: FastifyRequest,
): Promise<{ id: string; status: 'open' }> {
  const appeal = await withTransaction(ctx.db, async (tx) => {
    let userId: string;
    let caseId: string | undefined = input.caseId;
    let enforcementId: string | undefined = input.enforcementId;
    if ('token' in who) {
      const e = await tx.query<{ id: string; user_id: string; case_id: string | null }>(
        'SELECT id, user_id, case_id FROM enforcements WHERE appeal_token_hash = $1',
        [sha256Hex(who.token)],
      );
      if (!e.rows[0]?.case_id)
        throw new AppError('unauthenticated', 'This appeal link is not valid');
      userId = e.rows[0].user_id;
      caseId = e.rows[0].case_id;
      enforcementId = e.rows[0].id;
    } else {
      userId = who.userId;
      if (!caseId && enforcementId) {
        const e = await tx.query<{ case_id: string | null }>(
          'SELECT case_id FROM enforcements WHERE id = $1 AND user_id = $2',
          [enforcementId, userId],
        );
        caseId = e.rows[0]?.case_id ?? undefined;
      }
      if (!caseId) throw invalid('Provide the caseId or enforcementId you are appealing');
    }
    const c = (
      await tx.query<{
        id: string;
        subject_user_id: string | null;
        state: CaseState;
        decision: string | null;
        decided_at: Date | null;
        decided_by: string | null;
      }>(
        'SELECT id, subject_user_id, state, decision, decided_at, decided_by FROM moderation_cases WHERE id = $1 FOR UPDATE',
        [caseId],
      )
    ).rows[0];
    // Never reveal cases of other people.
    if (!c || c.subject_user_id !== userId || !c.decided_at || c.decision === 'no_action')
      throw notFound('Decision');
    if (Date.now() - c.decided_at.getTime() > APPEAL_WINDOW_DAYS * 86_400_000)
      throw new AppError('unprocessable', `The ${APPEAL_WINDOW_DAYS}-day appeal window has closed`);
    if (c.state !== 'resolved') throw conflict('This decision is already under appeal');
    const ins = await tx.query<{ id: string }>(
      `INSERT INTO appeals (case_id, enforcement_id, user_id, statement, original_decider_id) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (case_id, user_id) DO NOTHING RETURNING id`,
      [caseId, enforcementId ?? null, userId, input.statement, c.decided_by],
    );
    if (!ins.rows[0]) throw conflict('You have already appealed this decision');
    await tx.query(
      `UPDATE moderation_cases SET state = 'appealed', assigned_to = NULL, claimed_at = NULL WHERE id = $1`,
      [caseId],
    );
    await caseEvent(tx, caseId!, userId, 'appeal_opened', 'resolved', 'appealed');
    await audit(
      ctx,
      {
        actorId: userId,
        action: 'moderation.appeal_opened',
        targetType: 'moderation_case',
        targetId: caseId,
        metadata: { appealId: ins.rows[0].id },
      },
      req,
      tx,
    );
    return { id: ins.rows[0].id, status: 'open' as const };
  });
  if ('userId' in who) await track(ctx, 'appeal_created', {}, { userId: who.userId });
  return appeal;
}

export async function listMyAppeals(ctx: AppContext, userId: string) {
  const { rows } = await ctx.db.query(
    `SELECT id, case_id, status, statement, created_at, decided_at FROM appeals WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
    [userId],
  );
  return rows.map((a) => ({
    id: a.id,
    caseId: a.case_id,
    status: a.status,
    statement: a.statement,
    createdAt: a.created_at.toISOString(),
    decidedAt: a.decided_at?.toISOString() ?? null,
  }));
}

export async function listAppeals(
  ctx: AppContext,
  status: string | undefined,
  cursor: string | undefined,
  limitIn: number | undefined,
) {
  const limit = clampLimit(limitIn);
  const cur = decodeCursor<{ t: string; id: string }>(cursor);
  const { rows } = await ctx.db.query(
    `SELECT a.id, a.case_id, a.user_id, a.status, a.statement, a.original_decider_id, a.reviewer_id, a.created_at, a.created_at::text AS created_raw, a.decided_at, c.decision, c.target_type, c.risk_level
       FROM appeals a JOIN moderation_cases c ON c.id = a.case_id
      WHERE ($1::text IS NULL OR a.status = $1) AND ($2::timestamptz IS NULL OR (a.created_at, a.id) > ($2::timestamptz, $3::uuid))
      ORDER BY a.created_at, a.id LIMIT $4`,
    [status ?? null, cur?.t ?? null, cur?.id ?? null, limit + 1],
  );
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page.map((a) => ({
      id: a.id,
      caseId: a.case_id,
      userId: a.user_id,
      status: a.status,
      statement: a.statement,
      decision: a.decision,
      targetType: a.target_type,
      riskLevel: a.risk_level,
      originalDeciderId: a.original_decider_id,
      reviewerId: a.reviewer_id,
      createdAt: a.created_at.toISOString(),
      decidedAt: a.decided_at?.toISOString() ?? null,
    })),
    nextCursor:
      rows.length > limit && last ? encodeCursor({ t: last.created_raw, id: last.id }) : null,
  };
}

export async function reviewAppeal(
  ctx: AppContext,
  actor: StaffActor,
  appealId: string,
  input: { outcome: 'upheld' | 'overturned'; note: string },
  req?: FastifyRequest,
): Promise<{ id: string; status: string; restored: number }> {
  const pending: Array<() => Promise<void>> = [];
  const out = await withTransaction(ctx.db, async (tx) => {
    const a = (await tx.query<DbRow>('SELECT * FROM appeals WHERE id = $1 FOR UPDATE', [appealId]))
      .rows[0];
    if (!a) throw notFound('Appeal');
    if (a.status !== 'open') throw conflict('This appeal has already been decided');
    // Separation of duties: a fresh pair of eyes, never the original decider and never the appellant.
    if (a.original_decider_id && a.original_decider_id === actor.userId)
      throw forbidden(
        'An appeal must be reviewed by a different staff member than the one who made the original decision',
      );
    if (a.user_id === actor.userId) throw forbidden('You cannot review your own appeal');
    const c = (
      await tx.query<DbRow>('SELECT * FROM moderation_cases WHERE id = $1 FOR UPDATE', [a.case_id])
    ).rows[0]!;
    if (c.decision === 'ban_user' && !isSenior(actor.role))
      throw forbidden('Only admins can review appeals of bans');

    let restored = 0;
    if (input.outcome === 'overturned') {
      const ops: EffectOp[] = c.effects?.ops ?? [];
      restored = await restoreContent(tx, ops);
      await tx.query(
        'UPDATE enforcements SET revoked_at = now() WHERE case_id = $1 AND revoked_at IS NULL',
        [a.case_id],
      );
      if (a.user_id) await reinstateIfClear(tx, a.user_id);
      await tx.query(
        `UPDATE reports SET status = 'dismissed' WHERE id IN (SELECT report_id FROM report_cases WHERE case_id = $1)`,
        [a.case_id],
      );
    }
    await tx.query(
      `UPDATE appeals SET status = $2, reviewer_id = $3, reviewer_note = $4, decided_at = now() WHERE id = $1`,
      [appealId, input.outcome, actor.userId, input.note],
    );
    await tx.query(
      `UPDATE moderation_cases SET state = 'resolved', resolved_at = now() WHERE id = $1`,
      [a.case_id],
    );
    await caseEvent(
      tx,
      a.case_id,
      actor.userId,
      `appeal_${input.outcome}`,
      'appealed',
      'resolved',
      { appealId, restored },
    );
    await audit(
      ctx,
      {
        actorId: actor.userId,
        actorType: 'staff',
        action: `moderation.appeal_${input.outcome}`,
        targetType: 'appeal',
        targetId: appealId,
        metadata: { caseId: a.case_id, restored, originalDecider: a.original_decider_id },
      },
      req,
      tx,
    );
    pending.push(() =>
      notify(ctx, {
        userId: a.user_id,
        kind: 'moderation_appeal_result',
        actorId: null,
        targetType: 'moderation_case',
        targetId: a.case_id,
        data: { outcome: input.outcome, caseId: a.case_id },
      }),
    );
    return { id: appealId, status: input.outcome as string, restored };
  });
  for (const fn of pending) await fn();
  return out;
}

export { RISKS };
