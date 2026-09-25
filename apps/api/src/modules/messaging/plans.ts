import type { FastifyRequest } from 'fastify';
import { conflict, forbidden, invalid, notFound } from '@yapilapi/shared';
import { withTransaction } from '@yapilapi/database';
import type { AppContext } from '../../lib/context.js';
import { audit } from '../../lib/audit.js';
import { notify } from '../../lib/notify.js';
import { screenText } from '../../lib/moderation-hook.js';
import {
  assertCanContactPeer,
  loadAccess,
  requireAccess,
  requireSend,
  type ConvAccess,
} from './access.js';
import { publishConv } from './events.js';
import { announceMessage, announceMessageUpdated, insertMessageTx } from './service.js';
import { hydrateMessages, MSG_COLS, type MessageRow } from './views.js';

export const MAX_PLAN_TASKS = 100;

interface PlanRow {
  id: string;
  conversation_id: string | null;
  created_by: string;
  title: string;
  status: string;
  destination: string | null;
  starts_on: string | null;
  ends_on: string | null;
  budget_cents: number | null;
  currency: string | null;
  details: Record<string, unknown>;
  created_at: Date;
}
const PLAN_COLS =
  'id, conversation_id, created_by, title, status, destination, starts_on::text AS starts_on, ends_on::text AS ends_on, budget_cents, currency, details, created_at';

export interface CreatePlanInput {
  title: string;
  destination?: string | undefined;
  startsOn?: string | undefined;
  endsOn?: string | undefined;
  budgetCents?: number | undefined;
  currency?: string | undefined;
  details?: Record<string, unknown> | undefined;
  tasks?: Array<{ title: string; assigneeId?: string | undefined }> | undefined;
}

async function activeMemberIds(ctx: AppContext, conversationId: string): Promise<string[]> {
  const { rows } = await ctx.db.query<{ user_id: string }>(
    'SELECT user_id FROM conversation_members WHERE conversation_id = $1 AND left_at IS NULL',
    [conversationId],
  );
  return rows.map((r) => r.user_id);
}

/** A plan proposal lives in a direct or group conversation: creates plan + participants + tasks + a 'plan' message. */
export async function createPlan(
  ctx: AppContext,
  userId: string,
  conversationId: string,
  input: CreatePlanInput,
  req?: FastifyRequest,
) {
  const access = await requireAccess(ctx.db, conversationId, userId);
  requireSend(access);
  if (access.conv.kind === 'community_channel')
    throw invalid('Plans can be proposed in direct and group conversations');
  await assertCanContactPeer(ctx.db, access, userId);
  if (input.startsOn && input.endsOn && input.endsOn < input.startsOn)
    throw invalid('endsOn must not be before startsOn');
  const members = await activeMemberIds(ctx, conversationId);
  for (const t of input.tasks ?? [])
    if (t.assigneeId && !members.includes(t.assigneeId))
      throw invalid('Task assignees must be conversation members');
  if ((input.budgetCents !== undefined) !== (input.currency !== undefined))
    throw invalid('Provide both budgetCents and currency');

  const { planId, row } = await withTransaction(ctx.db, async (tx) => {
    const p = await tx.query<{ id: string }>(
      `INSERT INTO plans (conversation_id, created_by, title, status, destination, starts_on, ends_on, budget_cents, currency, details)
       VALUES ($1,$2,$3,'proposed',$4,$5,$6,$7,$8,$9) RETURNING id`,
      [
        conversationId,
        userId,
        input.title.trim(),
        input.destination ?? null,
        input.startsOn ?? null,
        input.endsOn ?? null,
        input.budgetCents ?? null,
        input.currency?.toUpperCase() ?? null,
        JSON.stringify(input.details ?? {}),
      ],
    );
    const id = p.rows[0]!.id;
    for (const m of members)
      await tx.query('INSERT INTO plan_participants (plan_id, user_id, rsvp) VALUES ($1,$2,$3)', [
        id,
        m,
        m === userId ? 'going' : 'invited',
      ]);
    for (const t of input.tasks ?? [])
      await tx.query(
        'INSERT INTO plan_tasks (plan_id, title, assignee_id, created_at) VALUES ($1,$2,$3, clock_timestamp())',
        [id, t.title.trim(), t.assigneeId ?? null],
      );
    const msg = await insertMessageTx(ctx, tx, {
      conversationId,
      senderId: userId,
      kind: 'plan',
      body: input.title.trim(),
      metadata: { planId: id },
    });
    await screenText(ctx, tx, {
      type: 'message',
      id: msg.row.id,
      authorId: userId,
      text: `${input.title} ${input.destination ?? ''}`,
    });
    await audit(
      ctx,
      {
        actorId: userId,
        action: 'plan.created',
        targetType: 'plan',
        targetId: id,
        metadata: { conversationId },
      },
      req,
      tx,
    );
    return { planId: id, row: msg.row };
  });
  const { rows } = await ctx.db.query<MessageRow>(
    `SELECT ${MSG_COLS} FROM messages m WHERE m.id = $1`,
    [row.id],
  );
  await announceMessage(ctx, rows[0]!, access);
  return {
    plan: await getPlanView(ctx, userId, planId),
    message: (await hydrateMessages(ctx, rows, userId))[0]!,
  };
}

async function loadPlanAccess(
  ctx: AppContext,
  userId: string,
  planId: string,
): Promise<{ plan: PlanRow; access: ConvAccess | null }> {
  const { rows } = await ctx.db.query<PlanRow>(`SELECT ${PLAN_COLS} FROM plans WHERE id = $1`, [
    planId,
  ]);
  const plan = rows[0];
  if (!plan) throw notFound('Plan');
  if (plan.conversation_id) {
    const access = await loadAccess(ctx.db, plan.conversation_id, userId);
    if (!access) throw notFound('Plan');
    return { plan, access };
  }
  // Orphaned plan (its conversation was deleted): only creator/participants keep access.
  const p = await ctx.db.query(
    'SELECT 1 FROM plan_participants WHERE plan_id = $1 AND user_id = $2',
    [planId, userId],
  );
  if (plan.created_by !== userId && !p.rowCount) throw notFound('Plan');
  return { plan, access: null };
}

export async function getPlanView(ctx: AppContext, userId: string, planId: string) {
  const { plan } = await loadPlanAccess(ctx, userId, planId);
  const [parts, tasks] = await Promise.all([
    ctx.db.query<{ user_id: string; rsvp: string }>(
      'SELECT user_id, rsvp FROM plan_participants WHERE plan_id = $1 ORDER BY user_id',
      [planId],
    ),
    ctx.db.query<{ id: string; title: string; assignee_id: string | null; done: boolean }>(
      'SELECT id, title, assignee_id, done FROM plan_tasks WHERE plan_id = $1 ORDER BY created_at, id',
      [planId],
    ),
  ]);
  return {
    id: plan.id,
    conversationId: plan.conversation_id,
    createdBy: plan.created_by,
    title: plan.title,
    status: plan.status,
    destination: plan.destination,
    startsOn: plan.starts_on,
    endsOn: plan.ends_on,
    budgetCents: plan.budget_cents,
    currency: plan.currency,
    details: plan.details,
    createdAt: plan.created_at.toISOString(),
    participants: parts.rows.map((p) => ({ userId: p.user_id, rsvp: p.rsvp })),
    tasks: tasks.rows.map((t) => ({
      id: t.id,
      title: t.title,
      assigneeId: t.assignee_id,
      done: t.done,
    })),
  };
}

async function touchPlan(ctx: AppContext, plan: PlanRow): Promise<void> {
  if (!plan.conversation_id) return;
  const m = await ctx.db.query<{ id: string }>(
    `SELECT id FROM messages WHERE conversation_id = $1 AND kind = 'plan' AND metadata @> $2::jsonb LIMIT 1`,
    [plan.conversation_id, JSON.stringify({ planId: plan.id })],
  );
  if (m.rows[0]) await announceMessageUpdated(ctx, m.rows[0].id);
  publishConv(ctx, plan.conversation_id, { type: 'plan.updated', planId: plan.id });
}

export async function rsvp(
  ctx: AppContext,
  userId: string,
  planId: string,
  answer: 'going' | 'maybe' | 'declined',
) {
  const { plan, access } = await loadPlanAccess(ctx, userId, planId);
  if (!access) throw forbidden('This plan is no longer attached to a conversation');
  if (['cancelled', 'done'].includes(plan.status)) throw conflict('This plan is closed');
  await ctx.db.query(
    `INSERT INTO plan_participants (plan_id, user_id, rsvp) VALUES ($1,$2,$3) ON CONFLICT (plan_id, user_id) DO UPDATE SET rsvp = EXCLUDED.rsvp`,
    [planId, userId, answer],
  );
  await touchPlan(ctx, plan);
  if (plan.created_by !== userId) {
    await notify(ctx, {
      userId: plan.created_by,
      kind: 'plan_rsvp',
      actorId: userId,
      targetType: 'plan',
      targetId: planId,
      data: { rsvp: answer, conversationId: plan.conversation_id },
    }).catch(() => undefined);
  }
  return getPlanView(ctx, userId, planId);
}

export async function setPlanStatus(
  ctx: AppContext,
  userId: string,
  planId: string,
  status: 'confirmed' | 'cancelled' | 'done',
) {
  const { plan } = await loadPlanAccess(ctx, userId, planId);
  if (plan.created_by !== userId)
    throw forbidden('Only the person who proposed the plan can change its status');
  const allowed: Record<string, string[]> = {
    proposed: ['confirmed', 'cancelled'],
    confirmed: ['done', 'cancelled'],
    draft: ['confirmed', 'cancelled'],
  };
  if (!allowed[plan.status]?.includes(status))
    throw conflict(`A ${plan.status} plan cannot become ${status}`);
  await ctx.db.query('UPDATE plans SET status = $2 WHERE id = $1', [planId, status]);
  await touchPlan(ctx, plan);
  return getPlanView(ctx, userId, planId);
}

export async function addTask(
  ctx: AppContext,
  userId: string,
  planId: string,
  input: { title: string; assigneeId?: string | undefined },
) {
  const { plan, access } = await loadPlanAccess(ctx, userId, planId);
  if (!access) throw forbidden('This plan is no longer attached to a conversation');
  requireSend(access);
  if (['cancelled', 'done'].includes(plan.status)) throw conflict('This plan is closed');
  if (input.assigneeId) {
    const m = await ctx.db.query(
      'SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2 AND left_at IS NULL',
      [plan.conversation_id, input.assigneeId],
    );
    if (!m.rowCount) throw invalid('The assignee must be a conversation member');
  }
  const count = await ctx.db.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM plan_tasks WHERE plan_id = $1',
    [planId],
  );
  if (count.rows[0]!.n >= MAX_PLAN_TASKS)
    throw conflict(`A plan can have at most ${MAX_PLAN_TASKS} tasks`);
  const { rows } = await ctx.db.query<{ id: string }>(
    'INSERT INTO plan_tasks (plan_id, title, assignee_id) VALUES ($1,$2,$3) RETURNING id',
    [planId, input.title.trim(), input.assigneeId ?? null],
  );
  await touchPlan(ctx, plan);
  return { id: rows[0]!.id, view: await getPlanView(ctx, userId, planId) };
}

export async function updateTask(
  ctx: AppContext,
  userId: string,
  planId: string,
  taskId: string,
  patch: { done?: boolean | undefined; title?: string | undefined },
) {
  const { plan, access } = await loadPlanAccess(ctx, userId, planId);
  if (!access) throw forbidden('This plan is no longer attached to a conversation');
  requireSend(access);
  const r = await ctx.db.query(
    `UPDATE plan_tasks SET done = COALESCE($3::boolean, done), title = COALESCE($4::text, title) WHERE id = $1 AND plan_id = $2`,
    [taskId, planId, patch.done ?? null, patch.title?.trim() ?? null],
  );
  if (!r.rowCount) throw notFound('Task');
  await touchPlan(ctx, plan);
  return getPlanView(ctx, userId, planId);
}
