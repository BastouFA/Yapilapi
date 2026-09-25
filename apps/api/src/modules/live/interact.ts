import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { withTransaction, type Queryable } from '@yapilapi/database';
import { classifyText } from '@yapilapi/moderation';
import { AppError, conflict, forbidden, invalid, notFound } from '@yapilapi/shared';
import type { AppContext } from '../../lib/context.js';
import type { AuthContext } from '../../lib/auth-context.js';
import { audit } from '../../lib/audit.js';
import { publishLive } from './events.js';
import { loadAccess, requireCan, type LiveAccess } from './access.js';
import {
  clampReactionCount,
  isMuted,
  matchesBlockedTerm,
  MAX_MESSAGE,
  outranks,
  REACTIONS,
  slowModeWaitMs,
  validatePoll,
  validateVote,
  type LiveAction,
  type LiveRole,
} from './rules.js';

/** Common gate for anything a person does INSIDE a live room: flag, visibility (404), role, on air, ticket, present in the room, not muted. */
export async function inRoom(
  ctx: AppContext,
  auth: AuthContext,
  id: string,
  action: LiveAction,
  opts: { mutable?: boolean } = {},
): Promise<LiveAccess> {
  await ctx.flags.require('LIVE', auth.userId);
  const a = await loadAccess(ctx.db, auth.userId, id);
  requireCan(a, action);
  if (a.session.status !== 'live')
    throw conflict('This session is not on air', { reason: 'not_live', status: a.session.status });
  if (!a.entitled)
    throw new AppError('payment_required', 'You need a ticket for this live session', {
      reason: 'ticket_required',
    });
  if (!a.present) throw conflict('Join the session first', { reason: 'not_joined' });
  if (opts.mutable && isMuted(a.participant?.muted_until ?? null, new Date()))
    throw forbidden('You are muted in this session');
  return a;
}
/** Reading a room's content needs visibility + the ticket (the room's content is part of what a ticket buys). */
export async function readRoom(ctx: AppContext, viewerId: string, id: string): Promise<LiveAccess> {
  await ctx.flags.require('LIVE', viewerId);
  const a = await loadAccess(ctx.db, viewerId, id);
  if (!a.entitled)
    throw new AppError('payment_required', 'You need a ticket for this live session', {
      reason: 'ticket_required',
    });
  return a;
}

function screen(a: LiveAccess, text: string): void {
  if (a.role === 'audience' && matchesBlockedTerm(text, a.session.blocked_terms))
    throw new AppError('unprocessable', 'That message contains a term this host blocks', {
      reason: 'blocked_term',
    });
  const c = classifyText(text);
  if (c.status !== 'approved')
    throw new AppError('unprocessable', 'That message may violate our community guidelines', {
      reason: 'text_not_allowed',
    });
}

const blockedEitherWay = (viewer: string, col: string) =>
  `NOT EXISTS (SELECT 1 FROM user_blocks bl WHERE (bl.blocker_id = ${viewer} AND bl.blocked_id = ${col}) OR (bl.blocker_id = ${col} AND bl.blocked_id = ${viewer}))`;

// ------------------------------------------------------------------ chat
export const messageBody = z.object({ body: z.string().trim().min(1).max(MAX_MESSAGE) });
export const messagesQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  before: z.uuid().optional(),
});

interface MsgRow {
  id: string;
  user_id: string | null;
  kind: string;
  body: string;
  hidden_at: Date | null;
  created_at: Date;
  username: string | null;
  display_name: string | null;
}
const msgView = (m: MsgRow, team = false) => ({
  id: m.id,
  userId: m.user_id,
  author: m.username ? { username: m.username, displayName: m.display_name } : null,
  kind: m.kind,
  body: m.hidden_at && !team ? null : m.body,
  ...(team ? { hidden: Boolean(m.hidden_at) } : {}),
  createdAt: m.created_at.toISOString(),
});

export async function postMessage(
  ctx: AppContext,
  auth: AuthContext,
  id: string,
  body: string,
  req?: FastifyRequest,
) {
  const a = await inRoom(ctx, auth, id, 'chat', { mutable: true });
  if (!a.session.chat_enabled && a.role === 'audience')
    throw forbidden('Chat is turned off for this session');
  screen(a, body);
  const m = await withTransaction(ctx.db, async (tx) => {
    // Serialise one person's messages so two parallel requests cannot both slip past slow mode.
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      `live-chat:${id}:${auth.userId}`,
    ]);
    if (a.session.slow_mode_sec && a.role === 'audience') {
      const last =
        (
          await tx.query<{ at: Date | null }>(
            `SELECT max(created_at) AS at FROM live_messages WHERE live_id = $1 AND user_id = $2 AND kind = 'chat'`,
            [id, auth.userId],
          )
        ).rows[0]?.at ?? null;
      const wait = slowModeWaitMs(last, new Date(), a.session.slow_mode_sec, a.role);
      if (wait > 0)
        throw new AppError('rate_limited', `Slow mode is on: wait ${Math.ceil(wait / 1000)} s`, {
          reason: 'slow_mode',
          retryAfterSec: Math.ceil(wait / 1000),
        });
    }
    return (
      await tx.query<MsgRow>(
        `WITH ins AS (INSERT INTO live_messages (live_id, user_id, body) VALUES ($1,$2,$3) RETURNING id, user_id, kind, body, hidden_at, created_at)
       SELECT ins.*, p.username::text, p.display_name FROM ins LEFT JOIN profiles p ON p.user_id = ins.user_id`,
        [id, auth.userId, body],
      )
    ).rows[0]!;
  });
  publishLive(ctx, id, { type: 'chat.message', message: msgView(m) });
  void req;
  return msgView(m);
}

export async function listMessages(
  ctx: AppContext,
  viewerId: string,
  id: string,
  q: z.infer<typeof messagesQuery>,
) {
  const a = await readRoom(ctx, viewerId, id);
  const team = a.role !== 'audience';
  const { rows } = await ctx.db.query<MsgRow>(
    `SELECT m.id, m.user_id, m.kind, m.body, m.hidden_at, m.created_at, p.username::text, p.display_name
       FROM live_messages m LEFT JOIN profiles p ON p.user_id = m.user_id
      WHERE m.live_id = $2 AND ($4::boolean OR m.hidden_at IS NULL) AND (m.user_id IS NULL OR m.user_id = $1 OR ${blockedEitherWay('$1::uuid', 'm.user_id')})
        AND ($5::uuid IS NULL OR (m.created_at, m.id) < (SELECT created_at, id FROM live_messages WHERE id = $5 AND live_id = $2))
      ORDER BY m.created_at DESC, m.id DESC LIMIT $3`,
    [viewerId, id, q.limit + 1, team, q.before ?? null],
  );
  const page = rows.slice(0, q.limit);
  return {
    items: page.map((m) => msgView(m, team)),
    nextBefore: rows.length > q.limit ? page[page.length - 1]!.id : null,
  };
}

/** Recent messages for the join response (already filtered for this viewer). */
export async function recentMessages(ctx: AppContext, viewerId: string, id: string, limit = 30) {
  return (await listMessages(ctx, viewerId, id, { limit, before: undefined })).items.reverse();
}

export async function hideMessage(
  ctx: AppContext,
  auth: AuthContext,
  id: string,
  messageId: string,
  req?: FastifyRequest,
): Promise<void> {
  await ctx.flags.require('LIVE', auth.userId);
  const a = await loadAccess(ctx.db, auth.userId, id);
  const m = (
    await ctx.db.query<{ user_id: string | null; hidden_at: Date | null }>(
      'SELECT user_id, hidden_at FROM live_messages WHERE id = $1 AND live_id = $2',
      [messageId, id],
    )
  ).rows[0];
  if (!m) throw notFound('Message');
  const own = m.user_id === auth.userId;
  if (!own) {
    requireCan(a, 'hide_message');
    const target = m.user_id ? await roleOf(ctx.db, a, m.user_id) : 'audience';
    if (!outranks(a.role, target)) throw forbidden('You cannot remove that message');
  }
  if (m.hidden_at) return;
  await ctx.db.query(
    'UPDATE live_messages SET hidden_at = now(), hidden_by = $2 WHERE id = $1 AND hidden_at IS NULL',
    [messageId, auth.userId],
  );
  if (!own)
    await audit(
      ctx,
      {
        actorId: auth.userId,
        action: 'live.message_hidden',
        targetType: 'live_message',
        targetId: messageId,
        metadata: { liveId: id, authorId: m.user_id },
      },
      req,
    );
  publishLive(ctx, id, { type: 'chat.hidden', messageId });
}

export async function roleOf(
  db: Queryable,
  a: Pick<LiveAccess, 'session'>,
  userId: string,
): Promise<LiveRole> {
  if (userId === a.session.host_id) return 'host';
  const r = (
    await db.query<{ role: LiveRole }>(
      'SELECT role FROM live_participants WHERE live_id = $1 AND user_id = $2',
      [a.session.id, userId],
    )
  ).rows[0];
  return r && r.role !== 'host' ? r.role : 'audience';
}

// ------------------------------------------------------------------ reactions
export const reactionBody = z.object({
  kind: z.enum(REACTIONS),
  count: z.number().int().min(1).max(10).default(1),
});
export async function react(
  ctx: AppContext,
  auth: AuthContext,
  id: string,
  b: z.infer<typeof reactionBody>,
): Promise<{ kind: string; total: number }> {
  const a = await inRoom(ctx, auth, id, 'react');
  const n = clampReactionCount(b.count);
  const { rows } = await ctx.db.query<{ n: number }>(
    `INSERT INTO live_reactions (live_id, user_id, kind, n) VALUES ($1,$2,$3,$4) ON CONFLICT (live_id, user_id, kind) DO UPDATE SET n = live_reactions.n + EXCLUDED.n, updated_at = now() RETURNING n`,
    [a.session.id, auth.userId, b.kind, n],
  );
  publishLive(ctx, id, { type: 'reaction', kind: b.kind, count: n });
  return { kind: b.kind, total: rows[0]!.n };
}
export async function reactionTotals(
  ctx: AppContext,
  viewerId: string,
  id: string,
): Promise<Record<string, number>> {
  await readRoom(ctx, viewerId, id);
  const { rows } = await ctx.db.query<{ kind: string; total: string }>(
    'SELECT kind, sum(n)::bigint AS total FROM live_reactions WHERE live_id = $1 GROUP BY kind',
    [id],
  );
  const out: Record<string, number> = Object.fromEntries(REACTIONS.map((k) => [k, 0]));
  for (const r of rows) out[r.kind] = Number(r.total);
  return out;
}

// ------------------------------------------------------------------ polls
export const pollBody = z.object({
  question: z.string().trim().min(1).max(200),
  options: z.array(z.string().trim().min(1).max(100)).min(2).max(6),
  multiple: z.boolean().default(false),
});
export const voteBody = z.object({ optionIds: z.array(z.uuid()).min(1).max(6) });

interface PollRow {
  id: string;
  question: string;
  multiple: boolean;
  status: string;
  created_at: Date;
  closed_at: Date | null;
}
async function pollViews(
  db: Queryable,
  viewerId: string,
  liveId: string,
  only?: string,
): Promise<ReturnType<typeof pollShape>[]> {
  const polls = (
    await db.query<PollRow>(
      `SELECT id, question, multiple, status, created_at, closed_at FROM live_polls WHERE live_id = $1 AND ($2::uuid IS NULL OR id = $2) ORDER BY created_at DESC LIMIT 20`,
      [liveId, only ?? null],
    )
  ).rows;
  if (!polls.length) return [];
  const ids = polls.map((p) => p.id);
  const opts = (
    await db.query<{ id: string; poll_id: string; label: string; votes: number }>(
      'SELECT id, poll_id, label, votes FROM live_poll_options WHERE poll_id = ANY($1::uuid[]) ORDER BY poll_id, position',
      [ids],
    )
  ).rows;
  const mine = (
    await db.query<{ poll_id: string; option_id: string }>(
      'SELECT poll_id, option_id FROM live_poll_votes WHERE poll_id = ANY($1::uuid[]) AND user_id = $2',
      [ids, viewerId],
    )
  ).rows;
  const voters = (
    await db.query<{ poll_id: string; n: number }>(
      'SELECT poll_id, count(DISTINCT user_id)::int AS n FROM live_poll_votes WHERE poll_id = ANY($1::uuid[]) GROUP BY poll_id',
      [ids],
    )
  ).rows;
  return polls.map((p) =>
    pollShape(
      p,
      opts.filter((o) => o.poll_id === p.id),
      mine.filter((m) => m.poll_id === p.id).map((m) => m.option_id),
      voters.find((v) => v.poll_id === p.id)?.n ?? 0,
    ),
  );
}
const pollShape = (
  p: PollRow,
  options: Array<{ id: string; label: string; votes: number }>,
  myVotes: string[],
  voters: number,
) => ({
  id: p.id,
  question: p.question,
  multiple: p.multiple,
  status: p.status,
  options: options.map((o) => ({ id: o.id, label: o.label, votes: o.votes })),
  voters,
  myVotes,
  createdAt: p.created_at.toISOString(),
  closedAt: p.closed_at?.toISOString() ?? null,
});
const pollPublic = (p: ReturnType<typeof pollShape>) => ({
  id: p.id,
  question: p.question,
  multiple: p.multiple,
  status: p.status,
  options: p.options,
  voters: p.voters,
});

export async function createPoll(
  ctx: AppContext,
  auth: AuthContext,
  id: string,
  b: z.infer<typeof pollBody>,
  req?: FastifyRequest,
) {
  const a = await inRoom(ctx, auth, id, 'poll');
  const v = validatePoll(b);
  if (!v.ok) throw invalid(v.error);
  screen({ ...a, role: 'host' }, [b.question, ...v.options].join('\n'));
  const pollId = await withTransaction(ctx.db, async (tx) => {
    await tx.query('SELECT 1 FROM live_sessions WHERE id = $1 FOR UPDATE', [id]);
    if (
      (await tx.query(`SELECT 1 FROM live_polls WHERE live_id = $1 AND status = 'open'`, [id]))
        .rowCount
    )
      throw conflict('Close the open poll first', { reason: 'poll_open' });
    const p = (
      await tx.query<{ id: string }>(
        'INSERT INTO live_polls (live_id, created_by, question, multiple) VALUES ($1,$2,$3,$4) RETURNING id',
        [id, auth.userId, b.question, b.multiple],
      )
    ).rows[0]!;
    for (const [i, label] of v.options.entries())
      await tx.query('INSERT INTO live_poll_options (poll_id, label, position) VALUES ($1,$2,$3)', [
        p.id,
        label,
        i,
      ]);
    return p.id;
  });
  const [view] = await pollViews(ctx.db, auth.userId, id, pollId);
  await audit(
    ctx,
    {
      actorId: auth.userId,
      action: 'live.poll_created',
      targetType: 'live_poll',
      targetId: pollId,
      metadata: { liveId: id },
    },
    req,
  );
  publishLive(ctx, id, { type: 'poll.created', poll: pollPublic(view!) });
  return view!;
}

export async function votePoll(
  ctx: AppContext,
  auth: AuthContext,
  id: string,
  pollId: string,
  optionIds: string[],
) {
  await inRoom(ctx, auth, id, 'vote');
  await withTransaction(ctx.db, async (tx) => {
    const p = (
      await tx.query<{ multiple: boolean; status: string }>(
        'SELECT multiple, status FROM live_polls WHERE id = $1 AND live_id = $2 FOR UPDATE',
        [pollId, id],
      )
    ).rows[0];
    if (!p) throw notFound('Poll');
    if (p.status !== 'open') throw conflict('This poll is closed', { reason: 'poll_closed' });
    const valid = new Set(
      (
        await tx.query<{ id: string }>('SELECT id FROM live_poll_options WHERE poll_id = $1', [
          pollId,
        ])
      ).rows.map((r) => r.id),
    );
    const err = validateVote(optionIds, valid, p.multiple);
    if (err) throw invalid(err);
    if (
      (
        await tx.query('SELECT 1 FROM live_poll_votes WHERE poll_id = $1 AND user_id = $2', [
          pollId,
          auth.userId,
        ])
      ).rowCount
    )
      throw conflict('You already voted in this poll', { reason: 'already_voted' });
    for (const o of optionIds) {
      await tx.query(
        'INSERT INTO live_poll_votes (poll_id, option_id, user_id) VALUES ($1,$2,$3)',
        [pollId, o, auth.userId],
      );
      await tx.query('UPDATE live_poll_options SET votes = votes + 1 WHERE id = $1', [o]);
    }
  });
  const [view] = await pollViews(ctx.db, auth.userId, id, pollId);
  publishLive(ctx, id, { type: 'poll.updated', poll: pollPublic(view!) });
  return view!;
}

export async function closePoll(
  ctx: AppContext,
  auth: AuthContext,
  id: string,
  pollId: string,
  req?: FastifyRequest,
) {
  await ctx.flags.require('LIVE', auth.userId);
  const a = await loadAccess(ctx.db, auth.userId, id);
  requireCan(a, 'poll');
  const r = await ctx.db.query(
    `UPDATE live_polls SET status = 'closed', closed_at = now() WHERE id = $1 AND live_id = $2 AND status = 'open' RETURNING id`,
    [pollId, id],
  );
  if (!r.rowCount) {
    if (
      !(await ctx.db.query('SELECT 1 FROM live_polls WHERE id = $1 AND live_id = $2', [pollId, id]))
        .rowCount
    )
      throw notFound('Poll');
    throw conflict('This poll is already closed', { reason: 'poll_closed' });
  }
  const [view] = await pollViews(ctx.db, auth.userId, id, pollId);
  await audit(
    ctx,
    {
      actorId: auth.userId,
      action: 'live.poll_closed',
      targetType: 'live_poll',
      targetId: pollId,
      metadata: { liveId: id },
    },
    req,
  );
  publishLive(ctx, id, { type: 'poll.closed', poll: pollPublic(view!) });
  return view!;
}

export async function listPolls(ctx: AppContext, viewerId: string, id: string) {
  await readRoom(ctx, viewerId, id);
  return { items: await pollViews(ctx.db, viewerId, id) };
}

// ------------------------------------------------------------------ Q&A
export const questionBody = z.object({ body: z.string().trim().min(1).max(MAX_MESSAGE) });
export const questionsQuery = z.object({
  status: z.enum(['open', 'answered']).default('open'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export const answerBody = z.object({ answer: z.string().trim().min(1).max(1000) });
const MAX_OPEN_QUESTIONS_PER_USER = 3;

interface QRow {
  id: string;
  asker_id: string;
  body: string;
  status: string;
  upvotes: number;
  answer: string | null;
  answered_at: Date | null;
  created_at: Date;
  username: string | null;
  display_name: string | null;
  voted: boolean;
}
const qView = (q: QRow) => ({
  id: q.id,
  body: q.body,
  status: q.status,
  upvotes: q.upvotes,
  answer: q.answer,
  answeredAt: q.answered_at?.toISOString() ?? null,
  viewerUpvoted: q.voted,
  asker: q.username
    ? { id: q.asker_id, username: q.username, displayName: q.display_name }
    : { id: q.asker_id },
  createdAt: q.created_at.toISOString(),
});
const Q_SELECT = `SELECT q.id, q.asker_id, q.body, q.status, q.upvotes, q.answer, q.answered_at, q.created_at, p.username::text, p.display_name,
  EXISTS (SELECT 1 FROM live_question_votes v WHERE v.question_id = q.id AND v.user_id = $1) AS voted FROM live_questions q LEFT JOIN profiles p ON p.user_id = q.asker_id`;

export async function askQuestion(ctx: AppContext, auth: AuthContext, id: string, body: string) {
  const a = await inRoom(ctx, auth, id, 'ask', { mutable: true });
  screen(a, body);
  const q = await withTransaction(ctx.db, async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`live-q:${id}:${auth.userId}`]);
    const n = Number(
      (
        await tx.query(
          `SELECT count(*)::int AS n FROM live_questions WHERE live_id = $1 AND asker_id = $2 AND status = 'open' AND hidden_at IS NULL`,
          [id, auth.userId],
        )
      ).rows[0]!.n,
    );
    if (n >= MAX_OPEN_QUESTIONS_PER_USER)
      throw new AppError(
        'rate_limited',
        `You can have ${MAX_OPEN_QUESTIONS_PER_USER} open questions at a time`,
        { reason: 'too_many_questions' },
      );
    return (
      await tx.query<{ id: string }>(
        'INSERT INTO live_questions (live_id, asker_id, body) VALUES ($1,$2,$3) RETURNING id',
        [id, auth.userId, body],
      )
    ).rows[0]!.id;
  });
  const row = (await ctx.db.query<QRow>(`${Q_SELECT} WHERE q.id = $2`, [auth.userId, q])).rows[0]!;
  publishLive(ctx, id, {
    type: 'question.new',
    question: { ...qView(row), viewerUpvoted: undefined },
  });
  return qView(row);
}

export async function listQuestions(
  ctx: AppContext,
  viewerId: string,
  id: string,
  q: z.infer<typeof questionsQuery>,
) {
  await readRoom(ctx, viewerId, id);
  const { rows } = await ctx.db.query<QRow>(
    `${Q_SELECT} WHERE q.live_id = $2 AND q.status = $3 AND q.hidden_at IS NULL AND (q.asker_id = $1 OR ${blockedEitherWay('$1::uuid', 'q.asker_id')})
      ORDER BY q.upvotes DESC, q.created_at ASC LIMIT $4`,
    [viewerId, id, q.status, q.limit],
  );
  return { items: rows.map(qView) };
}

export async function upvoteQuestion(
  ctx: AppContext,
  auth: AuthContext,
  id: string,
  qid: string,
  on: boolean,
) {
  await inRoom(ctx, auth, id, 'vote');
  await withTransaction(ctx.db, async (tx) => {
    const q = (
      await tx.query<{ asker_id: string; status: string }>(
        `SELECT asker_id, status FROM live_questions WHERE id = $1 AND live_id = $2 AND hidden_at IS NULL FOR UPDATE`,
        [qid, id],
      )
    ).rows[0];
    if (!q) throw notFound('Question');
    if (on) {
      if (q.asker_id === auth.userId) throw forbidden('You cannot upvote your own question');
      if (q.status !== 'open')
        throw conflict('This question is no longer open', { reason: 'question_closed' });
      const ins = await tx.query(
        'INSERT INTO live_question_votes (question_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING 1',
        [qid, auth.userId],
      );
      if (ins.rowCount)
        await tx.query('UPDATE live_questions SET upvotes = upvotes + 1 WHERE id = $1', [qid]);
    } else {
      const del = await tx.query(
        'DELETE FROM live_question_votes WHERE question_id = $1 AND user_id = $2 RETURNING 1',
        [qid, auth.userId],
      );
      if (del.rowCount)
        await tx.query(
          'UPDATE live_questions SET upvotes = GREATEST(0, upvotes - 1) WHERE id = $1',
          [qid],
        );
    }
  });
  const row = (await ctx.db.query<QRow>(`${Q_SELECT} WHERE q.id = $2`, [auth.userId, qid]))
    .rows[0]!;
  publishLive(ctx, id, {
    type: 'question.updated',
    questionId: qid,
    upvotes: row.upvotes,
    status: row.status,
  });
  return qView(row);
}

export async function answerQuestion(
  ctx: AppContext,
  auth: AuthContext,
  id: string,
  qid: string,
  answer: string,
  req?: FastifyRequest,
) {
  await ctx.flags.require('LIVE', auth.userId);
  const a = await loadAccess(ctx.db, auth.userId, id);
  requireCan(a, 'answer');
  screen({ ...a, role: 'host' }, answer);
  const r = await ctx.db.query(
    `UPDATE live_questions SET status = 'answered', answer = $3, answered_by = $4, answered_at = now() WHERE id = $1 AND live_id = $2 AND status = 'open' AND hidden_at IS NULL RETURNING id`,
    [qid, id, answer, auth.userId],
  );
  if (!r.rowCount) {
    if (
      !(
        await ctx.db.query(
          'SELECT 1 FROM live_questions WHERE id = $1 AND live_id = $2 AND hidden_at IS NULL',
          [qid, id],
        )
      ).rowCount
    )
      throw notFound('Question');
    throw conflict('This question was already answered', { reason: 'question_closed' });
  }
  await audit(
    ctx,
    {
      actorId: auth.userId,
      action: 'live.question_answered',
      targetType: 'live_question',
      targetId: qid,
      metadata: { liveId: id },
    },
    req,
  );
  const row = (await ctx.db.query<QRow>(`${Q_SELECT} WHERE q.id = $2`, [auth.userId, qid]))
    .rows[0]!;
  publishLive(ctx, id, {
    type: 'question.updated',
    questionId: qid,
    upvotes: row.upvotes,
    status: 'answered',
    answer,
  });
  return qView(row);
}

export async function dismissQuestion(
  ctx: AppContext,
  auth: AuthContext,
  id: string,
  qid: string,
  req?: FastifyRequest,
): Promise<void> {
  await ctx.flags.require('LIVE', auth.userId);
  const a = await loadAccess(ctx.db, auth.userId, id);
  const q = (
    await ctx.db.query<{ asker_id: string }>(
      'SELECT asker_id FROM live_questions WHERE id = $1 AND live_id = $2 AND hidden_at IS NULL',
      [qid, id],
    )
  ).rows[0];
  if (!q) throw notFound('Question');
  if (q.asker_id !== auth.userId) {
    requireCan(a, 'hide_message');
    if (!outranks(a.role, await roleOf(ctx.db, a, q.asker_id)))
      throw forbidden('You cannot remove that question');
  }
  await ctx.db.query(
    `UPDATE live_questions SET status = 'dismissed', hidden_at = now() WHERE id = $1`,
    [qid],
  );
  if (q.asker_id !== auth.userId)
    await audit(
      ctx,
      {
        actorId: auth.userId,
        action: 'live.question_hidden',
        targetType: 'live_question',
        targetId: qid,
        metadata: { liveId: id },
      },
      req,
    );
  publishLive(ctx, id, { type: 'question.updated', questionId: qid, status: 'dismissed' });
}
