/* eslint-disable @typescript-eslint/no-explicit-any -- artifact payloads are JSON validated per kind at edit/confirm time */
import { PlanPayloadSchema } from '@yapilapi/ai';
import { classifyText } from '@yapilapi/moderation';
import { AppError, conflict, forbidden, invalid, notFound } from '@yapilapi/shared';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { audit } from '../../lib/audit.js';
import type { AppContext } from '../../lib/context.js';
import { screenText } from '../../lib/moderation-hook.js';
import { loadVisiblePost } from '../../lib/visibility.js';
import { hasCommunityPermission } from '../../lib/community-access.js';
import { notify } from '../../lib/notify.js';
import { withTransaction } from '@yapilapi/database';
import { createPost } from '../content/service.js';
import { createPlan } from '../messaging/plans.js';
import { sendMessage } from '../messaging/service.js';
import type { Principal } from './permissions.js';

export interface ArtifactView {
  id: string;
  kind: string;
  status: string;
  tool: string | null;
  provider: string | null;
  payload: unknown;
  sources: unknown;
  edited: boolean;
  conversationId: string | null;
  result: unknown;
  createdAt: string;
  confirmedAt: string | null;
}

interface Row {
  id: string;
  user_id: string;
  kind: string;
  status: string;
  tool: string | null;
  provider: string | null;
  payload: Record<string, any>;
  sources: unknown;
  edited: boolean;
  conversation_id: string | null;
  result_ref: unknown;
  created_at: Date;
  confirmed_at: Date | null;
}
const COLS =
  'id, user_id, kind, status, tool, provider, payload, sources, edited, conversation_id, result_ref, created_at, confirmed_at';
const view = (r: Row): ArtifactView => ({
  id: r.id,
  kind: r.kind,
  status: r.status,
  tool: r.tool,
  provider: r.provider,
  payload: r.payload,
  sources: r.sources,
  edited: r.edited,
  conversationId: r.conversation_id,
  result: r.result_ref,
  createdAt: r.created_at.toISOString(),
  confirmedAt: r.confirmed_at?.toISOString() ?? null,
});

export async function listArtifacts(
  ctx: AppContext,
  userId: string,
  opts: { status?: string | undefined; limit: number },
): Promise<ArtifactView[]> {
  const { rows } = await ctx.db.query<Row>(
    `SELECT ${COLS} FROM ai_artifacts WHERE user_id = $1 AND ($2::text IS NULL OR status = $2) ORDER BY created_at DESC, id LIMIT $3`,
    [userId, opts.status ?? null, opts.limit],
  );
  return rows.map(view);
}

async function load(ctx: AppContext, userId: string, id: string): Promise<Row> {
  const { rows } = await ctx.db.query<Row>(
    `SELECT ${COLS} FROM ai_artifacts WHERE id = $1 AND user_id = $2`,
    [id, userId],
  );
  if (!rows[0]) throw notFound('Draft');
  return rows[0];
}
export async function getArtifact(
  ctx: AppContext,
  userId: string,
  id: string,
): Promise<ArtifactView> {
  return view(await load(ctx, userId, id));
}

// ------------------------------------------------------------------ edit (the human changes the draft)
const VISIBILITY = z.enum([
  'public',
  'followers',
  'friends',
  'circle',
  'selected',
  'private',
  'community',
]);
const EDIT: Record<string, z.ZodType> = {
  post_draft: z.object({
    body: z.string().trim().min(1).max(5000).optional(),
    visibility: VISIBILITY.optional(),
    communityId: z.uuid().nullable().optional(),
    topics: z.array(z.string().max(60)).max(10).optional(),
  }),
  reply_draft: z.object({ body: z.string().trim().min(1).max(4000) }),
  caption: z.object({
    options: z.array(z.string().trim().min(1).max(500)).min(1).max(5).optional(),
    selected: z.number().int().min(0).max(4).optional(),
  }),
  plan: z.object({ plan: PlanPayloadSchema.shape.plan.partial() }),
  event_draft: z.object({
    title: z.string().trim().min(2).max(160).optional(),
    description: z.string().trim().max(2000).optional(),
    startsAt: z.iso.datetime({ offset: true }).nullable().optional(),
    endsAt: z.iso.datetime({ offset: true }).nullable().optional(),
    locationText: z.string().trim().max(200).nullable().optional(),
    visibility: z.enum(['public', 'friends', 'private']).optional(),
  }),
  other: z.object({
    text: z.string().trim().min(1).max(4000).optional(),
    titles: z.array(z.string().trim().min(1).max(200)).max(8).optional(),
    selected: z.number().int().min(0).max(8).optional(),
  }),
};

export async function editArtifact(
  ctx: AppContext,
  userId: string,
  id: string,
  patch: unknown,
  req?: FastifyRequest,
): Promise<ArtifactView> {
  const row = await load(ctx, userId, id);
  if (row.status !== 'draft') throw conflict(`A ${row.status} draft cannot be edited`);
  const schema = EDIT[row.kind];
  if (!schema) throw invalid('This kind of draft cannot be edited');
  const parsed = schema.safeParse(patch);
  if (!parsed.success)
    throw invalid(
      `Invalid edit: ${parsed.error.issues
        .map((i) => i.path.join('.') + ' ' + i.message)
        .join('; ')
        .slice(0, 200)}`,
    );
  const text = JSON.stringify(parsed.data);
  if (classifyText(text).status !== 'approved')
    throw new AppError('unprocessable', 'That edit cannot be saved', { reason: 'edit_rejected' });
  let payload: Record<string, unknown>;
  if (row.kind === 'plan')
    payload = {
      ...row.payload,
      plan: { ...row.payload.plan, ...(parsed.data as { plan: Record<string, unknown> }).plan },
    };
  else payload = { ...row.payload, ...(parsed.data as Record<string, unknown>) };
  if (row.kind === 'plan' && !PlanPayloadSchema.safeParse(payload).success)
    throw invalid('The edited plan is not valid');
  const { rows } = await ctx.db.query<Row>(
    `UPDATE ai_artifacts SET payload = $3, edited = true WHERE id = $1 AND user_id = $2 AND status = 'draft' RETURNING ${COLS}`,
    [id, userId, JSON.stringify(payload)],
  );
  if (!rows[0]) throw conflict('That draft is no longer editable');
  await audit(
    ctx,
    {
      actorId: userId,
      action: 'ai.artifact.edited',
      targetType: 'ai_artifact',
      targetId: id,
      metadata: { kind: row.kind },
    },
    req,
  );
  return view(rows[0]);
}

export async function discardArtifact(
  ctx: AppContext,
  userId: string,
  id: string,
  req?: FastifyRequest,
): Promise<void> {
  const r = await ctx.db.query(
    `UPDATE ai_artifacts SET status = 'discarded' WHERE id = $1 AND user_id = $2 AND status = 'draft'`,
    [id, userId],
  );
  if (!r.rowCount) {
    await load(ctx, userId, id); // 404 when it is not theirs
    throw conflict('That draft was already confirmed or discarded');
  }
  await audit(
    ctx,
    { actorId: userId, action: 'ai.artifact.discarded', targetType: 'ai_artifact', targetId: id },
    req,
  );
}

// ------------------------------------------------------------------ confirm (the human's decision, executed by the normal services)
export const ConfirmBody = z.object({
  /** post_draft */ visibility: VISIBILITY.optional(),
  communityId: z.uuid().optional(),
  circleId: z.uuid().optional(),
  audience: z.array(z.uuid()).max(100).optional(),
  topics: z.array(z.string().max(60)).max(10).optional(),
  /** plan (required unless the draft already names its conversation) / reply_draft to a conversation */ conversationId:
    z.uuid().optional(),
  /** caption / titles: which option the user picked */ selected: z
    .number()
    .int()
    .min(0)
    .max(8)
    .optional(),
});
type Confirm = z.infer<typeof ConfirmBody>;

export interface ConfirmResult {
  artifact: ArtifactView;
  /** What happened. Only the four kinds that map to a real action create anything; text artifacts are just accepted (nothing is created). */
  action:
    | 'post_created'
    | 'comment_created'
    | 'message_sent'
    | 'plan_created'
    | 'event_draft_created'
    | 'accepted';
  created: { type: string; id: string } | null;
  text?: string;
}

const isoDate = (d: unknown) => (typeof d === 'string' ? d : null);

async function executeConfirm(
  ctx: AppContext,
  p: Principal,
  row: Row,
  o: Confirm,
  req?: FastifyRequest,
): Promise<{ action: ConfirmResult['action']; created: ConfirmResult['created']; text?: string }> {
  const payload = row.payload;
  switch (row.kind) {
    case 'post_draft': {
      const body = String(payload.body ?? '');
      const communityId = o.communityId ?? (payload.communityId as string | undefined);
      const visibility =
        o.visibility ?? (payload.visibility as z.infer<typeof VISIBILITY> | undefined);
      const topics = o.topics ?? (payload.topics as string[] | undefined);
      // createPost re-checks EVERYTHING at confirm time (community permission, teen rules, circles, topics, moderation screening).
      const postId = await createPost(
        ctx,
        { userId: p.userId, ageBand: p.ageBand },
        {
          body,
          visibility,
          communityId,
          circleId: o.circleId,
          audience: o.audience,
          topics: topics?.length ? topics : undefined,
          aiAssistance: { tools: [row.tool ?? 'draft_post'] },
        },
      );
      // Honest provenance: untouched draft => generated; the human rewrote it => AI-assisted.
      await ctx.db.query('UPDATE posts SET ai_provenance = $3 WHERE id = $1 AND author_id = $2', [
        postId,
        p.userId,
        JSON.stringify({
          generated: !row.edited,
          assisted: [row.tool ?? 'draft_post'],
          disclosed: true,
          artifactId: row.id,
        }),
      ]);
      return { action: 'post_created', created: { type: 'post', id: postId } };
    }
    case 'reply_draft': {
      const body = String(payload.body ?? '');
      const target = (payload.target ?? {}) as { type?: string; id?: string; postId?: string };
      const meta = { ai: { generated: !row.edited, assisted: true, artifactId: row.id } };
      if (target.type === 'conversation' || o.conversationId) {
        const conversationId = o.conversationId ?? target.id!;
        const m = await sendMessage(ctx, {
          conversationId,
          senderId: p.userId,
          kind: 'text',
          body,
          metadata: meta,
        });
        return { action: 'message_sent', created: { type: 'message', id: m.id } };
      }
      const postId = target.type === 'comment' ? target.postId : target.id;
      if (!postId) throw invalid('This reply has no target');
      const id = await createCommentAsUser(
        ctx,
        p,
        postId,
        target.type === 'comment' ? target.id! : null,
        body,
      );
      return { action: 'comment_created', created: { type: 'comment', id } };
    }
    case 'plan': {
      const parsed = PlanPayloadSchema.safeParse(payload);
      if (!parsed.success) throw invalid('This plan draft is not valid any more; edit it first');
      const conversationId = o.conversationId ?? parsed.data.conversationId;
      if (!conversationId)
        throw invalid('conversationId is required: choose the conversation to propose the plan in');
      const plan = parsed.data.plan;
      const members = await ctx.db.query<{ user_id: string }>(
        'SELECT user_id FROM conversation_members WHERE conversation_id = $1 AND left_at IS NULL',
        [conversationId],
      );
      const memberIds = new Set(members.rows.map((m) => m.user_id));
      // createPlan (messaging) re-checks membership, send permission, blocks and contact rules for the CONFIRMING user, and adds a 'plan' message.
      const created = await createPlan(
        ctx,
        p.userId,
        conversationId,
        {
          title: plan.title,
          destination: plan.destination ?? undefined,
          startsOn: plan.startsOn ?? undefined,
          endsOn: plan.endsOn ?? undefined,
          ...(plan.budget
            ? { budgetCents: plan.budget.amountCents, currency: plan.budget.currency }
            : {}),
          details: {
            transport: plan.transport,
            accommodation: plan.accommodation,
            activities: plan.activities,
            missing: plan.missing,
          },
          tasks: plan.tasks.map((t) => ({
            title: t.title,
            assigneeId: t.assigneeId && memberIds.has(t.assigneeId) ? t.assigneeId : undefined,
          })),
        },
        req,
      );
      const planId = created.plan.id;
      await ctx.db.query(
        'UPDATE plans SET ai_generated = $3, ai_provenance = $4 WHERE id = $1 AND created_by = $2',
        [
          planId,
          p.userId,
          !row.edited,
          JSON.stringify({
            tool: row.tool,
            artifactId: row.id,
            assisted: true,
            edited: row.edited,
          }),
        ],
      );
      return { action: 'plan_created', created: { type: 'plan', id: planId } };
    }
    case 'event_draft': {
      const id = await createEventDraft(ctx, p, payload, req);
      return { action: 'event_draft_created', created: { type: 'event', id } };
    }
    default: {
      // caption / titles / description / summary / translation ...: nothing to create. The human takes the text into the normal flow.
      const text =
        typeof payload.text === 'string'
          ? payload.text
          : Array.isArray(payload.options)
            ? String(
                payload.options[o.selected ?? (payload.selected as number | undefined) ?? 0] ?? '',
              )
            : Array.isArray(payload.titles)
              ? String(
                  payload.titles[o.selected ?? (payload.selected as number | undefined) ?? 0] ?? '',
                )
              : undefined;
      return { action: 'accepted', created: null, ...(text !== undefined ? { text } : {}) };
    }
  }
}

export async function confirmArtifact(
  ctx: AppContext,
  p: Principal,
  id: string,
  options: Confirm,
  req?: FastifyRequest,
): Promise<ConfirmResult> {
  // Claim first (atomic): two concurrent confirms cannot both execute.
  const claim = await ctx.db.query<Row>(
    `UPDATE ai_artifacts SET status = 'confirmed', confirmed_at = now() WHERE id = $1 AND user_id = $2 AND status = 'draft' RETURNING ${COLS}`,
    [id, p.userId],
  );
  const row = claim.rows[0];
  if (!row) {
    await load(ctx, p.userId, id);
    throw conflict('That draft was already confirmed or discarded');
  }
  try {
    const out = await executeConfirm(ctx, p, row, options, req);
    if (out.created)
      await ctx.db.query('UPDATE ai_artifacts SET result_ref = $2 WHERE id = $1', [
        id,
        JSON.stringify(out.created),
      ]);
    await audit(
      ctx,
      {
        actorId: p.userId,
        action: 'ai.artifact.confirmed',
        targetType: 'ai_artifact',
        targetId: id,
        metadata: { kind: row.kind, action: out.action, created: out.created, edited: row.edited },
      },
      req,
    );
    ctx.metrics.events.inc({ name: `ai_confirm_${row.kind}` });
    return { artifact: await getArtifact(ctx, p.userId, id), ...out };
  } catch (err) {
    // The confirmation failed (permission changed, validation...): the draft stays a draft so the human can fix it and retry.
    await ctx.db.query(
      `UPDATE ai_artifacts SET status = 'draft', confirmed_at = NULL WHERE id = $1 AND user_id = $2`,
      [id, p.userId],
    );
    throw err;
  }
}

// ------------------------------------------------------------------ helpers mirroring the normal endpoints
/** Mirrors POST /v1/posts/:id/comments (visibility, community 'comment' permission, restriction, counters, moderation screening, notifications). */
async function createCommentAsUser(
  ctx: AppContext,
  p: Principal,
  postId: string,
  parentCommentId: string | null,
  body: string,
): Promise<string> {
  const post = await loadVisiblePost<{ author_id: string; community_id: string | null }>(
    ctx.db,
    p.userId,
    postId,
  );
  if (!post) throw notFound('Post');
  if (
    post.community_id &&
    !(await hasCommunityPermission(ctx.db, post.community_id, p.userId, 'comment'))
  )
    throw forbidden('Join this community to comment');
  let parentId: string | null = null;
  if (parentCommentId) {
    const par = await ctx.db.query<{ id: string; parent_id: string | null }>(
      'SELECT id, parent_id FROM comments WHERE id = $1 AND post_id = $2 AND deleted_at IS NULL',
      [parentCommentId, postId],
    );
    if (!par.rows[0]) throw notFound('Comment');
    parentId = par.rows[0].parent_id ?? par.rows[0].id;
  }
  const restricted = await ctx.db.query(
    'SELECT 1 FROM user_restrictions WHERE restrictor_id = $1 AND restricted_id = $2',
    [post.author_id, p.userId],
  );
  const id = await withTransaction(ctx.db, async (tx) => {
    const r = await tx.query<{ id: string }>(
      'INSERT INTO comments (post_id, author_id, parent_id, body, hidden_by_restriction) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [postId, p.userId, parentId, body, Boolean(restricted.rowCount)],
    );
    await tx.query('UPDATE posts SET comment_count = comment_count + 1 WHERE id = $1', [postId]);
    if (parentId)
      await tx.query('UPDATE comments SET reply_count = reply_count + 1 WHERE id = $1', [parentId]);
    await screenText(ctx, tx, {
      type: 'comment',
      id: r.rows[0]!.id,
      authorId: p.userId,
      text: body,
    });
    return r.rows[0]!.id;
  });
  if (!restricted.rowCount)
    await notify(ctx, {
      userId: post.author_id,
      kind: 'comment',
      actorId: p.userId,
      targetType: 'post',
      targetId: postId,
      data: { commentId: id },
    });
  return id;
}

/** Creates an UNPUBLISHED (draft, private-by-default) event hosted by the confirming user. Publishing stays a separate human action on the events API. */
async function createEventDraft(
  ctx: AppContext,
  p: Principal,
  payload: Record<string, any>,
  req?: FastifyRequest,
): Promise<string> {
  const title = String(payload.title ?? '').trim();
  if (title.length < 2) throw invalid('The event needs a title');
  const startsAt = isoDate(payload.startsAt);
  if (!startsAt) throw invalid('Set a start time on the draft first (edit the draft)');
  if (new Date(startsAt).getTime() <= Date.now()) throw invalid('startsAt must be in the future');
  const endsAt = isoDate(payload.endsAt);
  if (endsAt && new Date(endsAt) < new Date(startsAt))
    throw invalid('endsAt must not be before startsAt');
  const description = String(payload.description ?? '');
  if (classifyText(`${title} ${description}`).status !== 'approved')
    throw new AppError('unprocessable', 'That event text cannot be saved', {
      reason: 'event_text_rejected',
    });
  // Teens never get public/follower visibility; drafts default to organiser-only ('private').
  let visibility = String(payload.visibility ?? 'private');
  if (!['public', 'friends', 'private'].includes(visibility)) visibility = 'private';
  if (p.ageBand === 'teen' && visibility === 'public') visibility = 'friends';
  const tz = await ctx.db.query<{ timezone: string }>('SELECT timezone FROM users WHERE id = $1', [
    p.userId,
  ]);
  const { rows } = await ctx.db.query<{ id: string }>(
    `INSERT INTO events (title, description, host_id, starts_at, ends_at, timezone, location_text, visibility, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'draft') RETURNING id`,
    [
      title.slice(0, 160),
      description.slice(0, 2000),
      p.userId,
      startsAt,
      endsAt,
      tz.rows[0]?.timezone ?? 'UTC',
      payload.locationText ? String(payload.locationText).slice(0, 200) : null,
      visibility,
    ],
  );
  await audit(
    ctx,
    {
      actorId: p.userId,
      action: 'event.created',
      targetType: 'event',
      targetId: rows[0]!.id,
      metadata: { published: false, visibility, via: 'ai_artifact' },
    },
    req,
  );
  ctx.metrics.events.inc({ name: 'event_created' });
  return rows[0]!.id;
}
