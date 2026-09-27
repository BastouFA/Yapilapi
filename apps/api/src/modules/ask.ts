import type { FastifyInstance } from 'fastify';
import { tx } from '@yapilapi/database';
import {
  ASK_LIMITS,
  answerQuestionSchema,
  askBoxSchema,
  askInboxQuerySchema,
  askQuestionSchema,
  createPostSchema,
  pageQuerySchema,
  type AnswerCard,
  type AskFilter,
  type AskRefusal,
  type InboxQuestion,
  type Page,
} from '@yapilapi/shared';
import { z } from 'zod';
import { AppError, badRequest, conflict, forbidden, notFound, parse } from '../lib/errors.ts';
import type { AppContext } from '../lib/context.ts';
import { decodeCursor, encodeCursor, type KeyCursor } from '../lib/cursor.ts';
import { ANSWER_FROM, answerCards, answerVisibleSql, checkAsk, inboxQuestions, ownBox } from '../lib/ask.ts';
import { hasHiddenWord, hiddenWordsOf } from '../lib/comments.ts';
import { analyzeText, statusForRisk } from '../lib/moderation.ts';
import { announcePost, moderationNotice, recordFlags, screenPost, writePost } from '../lib/publishing.ts';
import { hydratePosts } from '../lib/posts.ts';
import { notify, track } from '../lib/services.ts';
import { assessQuestion, flagContent, isRestricted, recordSignals } from '../lib/spam.ts';
import { areFriends, blockUser } from '../lib/users.ts';
import { requireVerified } from '../lib/verification.ts';
import { me, requireAuth } from '../plugins/auth.ts';

const idParam = z.object({ id: z.string().uuid() });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A keyset cursor we made, or a 400 (never a malformed timestamp reaching SQL). */
function keyCursor(s: string | undefined): KeyCursor | null {
  const c = decodeCursor<KeyCursor>(s);
  if (c && (typeof c.t !== 'string' || Number.isNaN(Date.parse(c.t)) || typeof c.id !== 'string' || !UUID.test(c.id))) throw badRequest('Invalid cursor.');
  return c;
}

const unauthorizedAsk = () => new AppError(401, 'unauthorized', 'Log in to ask a question.');

/** Plain reasons a question can't be asked, by what checkAsk found. */
function refusalError(r: AskRefusal, audience: string | undefined): AppError {
  switch (r) {
    case 'off':
      return new AppError(403, 'ask_off', 'This person’s question box is off.');
    case 'self':
      return badRequest('You can’t ask yourself a question.');
    case 'blocked':
      return forbidden('You can’t ask this person questions.');
    case 'minor':
      return new AppError(403, 'minor_protection', 'To keep younger people safe, you can only ask them questions once you are friends.');
    case 'audience':
      return new AppError(
        403,
        'ask_audience',
        audience === 'friends' ? 'Only friends can ask this person questions.' : 'Only people this person follows can ask them questions.',
      );
    case 'private':
      return new AppError(403, 'ask_private', 'This account is private. Follow it to ask a question.');
    default:
      return unauthorizedAsk();
  }
}

/**
 * "Ask me": question boxes on profiles. People turn theirs on with a prompt, choose who can ask and
 * whether askers may hide their name from the public; visitors ask; the owner answers, hides,
 * deletes, reports or blocks from their inbox; answers show on the Answers tab and can be shared as
 * a post quoting the question.
 *
 * A question asked without a name keeps its asker on the server (blocks, limits and moderators all
 * see them) and no response here ever says who it was, to the owner included. Blocking the asker of
 * such a question is a "question block" (ask_blocks): they can't ask again and don't see the box or
 * the answers, and the owner learns nothing about who they are.
 */
export default async function askModule(app: FastifyInstance, ctx: AppContext) {
  const db = ctx.db;

  // ── Your box ──────────────────────────────────────────────────────────
  app.get('/v1/me/ask-box', { preHandler: requireAuth }, async (req) => ({ box: await ownBox(db, me(req).id) }));

  app.put('/v1/me/ask-box', { preHandler: requireAuth, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    const u = me(req);
    const input = parse(askBoxSchema, req.body);
    const before = await ownBox(db, u.id);
    if (input.allowHiddenNames && !before.hiddenNamesAvailable)
      throw new AppError(403, 'minor_protection', 'Accounts of people under 18 only get questions with the asker’s name.');
    const next = { ...before, ...input };
    await tx(db, async (c) => {
      await c.query(
        `INSERT INTO ask_boxes (user_id, enabled, prompt, audience, allow_hidden_names) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (user_id) DO UPDATE SET enabled = EXCLUDED.enabled, prompt = EXCLUDED.prompt, audience = EXCLUDED.audience,
           allow_hidden_names = EXCLUDED.allow_hidden_names, updated_at = now()`,
        [u.id, next.enabled, next.prompt ?? null, next.audience, next.allowHiddenNames && next.hiddenNamesAvailable],
      );
      // Turning the box on puts Answers on a profile that chose its tabs (at the end; it can be moved or hidden there).
      if (next.enabled && !before.enabled)
        await c.query(`UPDATE profiles SET tabs = array_append(tabs, 'answers') WHERE user_id = $1 AND tabs IS NOT NULL AND NOT ('answers' = ANY(tabs))`, [
          u.id,
        ]);
    });
    return { box: await ownBox(db, u.id) };
  });

  // ── Asking ────────────────────────────────────────────────────────────
  /**
   * Ask someone a question. Blocks, the box's audience, private accounts and minor safety apply to
   * every question, with or without a name; people under 18 never get questions without a name.
   * Harmful text is refused, spam and flagged text wait for a moderator, and the owner's hidden
   * words send it straight to their hidden questions. Paced per asker and per person asked.
   */
  app.post('/v1/users/:id/questions', { preHandler: requireAuth, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const u = me(req);
    const { id: owner } = parse(idParam, req.params);
    const input = parse(askQuestionSchema, req.body);
    const check = await checkAsk(db, u.id, owner);
    if (!check.ownerActive) throw notFound('That person');
    if (check.refusal) throw refusalError(check.refusal, check.box?.audience);
    if (input.hideName && !check.box?.hiddenNamesAllowed)
      throw new AppError(403, 'hidden_names_off', 'This person only gets questions with the asker’s name. Turn off “Ask without your name shown” to ask.');
    // Reaching people you aren't friends with needs a confirmed email or phone, as for messages.
    const friends = await areFriends(db, u.id, owner);
    if (!friends) await requireVerified(db, ctx.config, u.id, 'ask');

    const { rows: pace } = await db.query<{ mine_hour: number; to_them: number; theirs_hour: number }>(
      `SELECT (SELECT count(*) FROM ask_questions WHERE asker_id = $1 AND created_at > now() - interval '1 hour')::int AS mine_hour,
              (SELECT count(*) FROM ask_questions WHERE asker_id = $1 AND recipient_id = $2 AND created_at > now() - interval '1 day')::int AS to_them,
              (SELECT count(*) FROM ask_questions WHERE recipient_id = $2 AND created_at > now() - interval '1 hour')::int AS theirs_hour`,
      [u.id, owner],
    );
    const p = pace[0]!;
    if (p.mine_hour >= ASK_LIMITS.perAskerPerHour)
      throw new AppError(429, 'slow_down', `You can ask up to ${ASK_LIMITS.perAskerPerHour} questions an hour. You can ask more a little later.`);
    if (p.to_them >= ASK_LIMITS.perAskerPerRecipientPerDay)
      throw new AppError(429, 'slow_down', 'You’ve asked this person several questions today. Give them time to answer, or ask again tomorrow.');
    if (p.theirs_hour >= ASK_LIMITS.perRecipientPerHour)
      throw new AppError(429, 'box_busy', 'This question box is getting a lot of questions right now. Try again later.');

    const analysis = analyzeText(input.body);
    if (analysis.risk === 'escalate') throw new AppError(422, 'content_blocked', "This question can't be sent because it may put someone at risk.");
    const spam = await assessQuestion(db, ctx.config, u.id, owner, input.body);
    const status = spam.restricted ? 'restricted' : analysis.risk !== 'normal' ? statusForRisk(analysis.risk) : spam.flags.length ? 'review' : 'normal';
    const hidden = hasHiddenWord(input.body, await hiddenWordsOf(db, owner));

    const questionId = await tx(db, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO ask_questions (recipient_id, asker_id, body, hide_name, moderation_status, hidden_at) VALUES ($1,$2,$3,$4,$5, CASE WHEN $6 THEN now() END) RETURNING id`,
        [owner, u.id, input.body, input.hideName, status, hidden],
      );
      const qid = rows[0]!.id;
      // Flagged questions go to a moderator, who sees who asked.
      if (analysis.risk !== 'normal' || spam.flags.length)
        await c.query(
          `INSERT INTO moderation_cases (target_type, target_id, subject_user_id, source, risk, signals) VALUES ('question',$1,$2,'automated',$3,$4) ON CONFLICT DO NOTHING`,
          [
            qid,
            u.id,
            analysis.risk !== 'normal' ? analysis.risk : 'review',
            { signals: [...analysis.signals, ...spam.flags.map((f) => f.kind)], ...(spam.flags.length ? { spam: spam.flags } : {}) },
          ],
        );
      await flagContent(c, ctx.realtime, u.id, { type: 'question', id: qid }, spam.flags);
      if (spam.restricted) await recordSignals(c, u.id, [{ kind: 'held_while_limited', weight: 0 }], { type: 'question', id: qid });
      return qid;
    });
    // Held and hidden questions reach no one, so they notify no one. Questions without a name have no actor.
    if (status === 'normal' && !hidden) {
      await notify(db, ctx.realtime, {
        userId: owner,
        category: 'friends',
        type: 'question_received',
        ...(input.hideName ? {} : { actorId: u.id }),
        entityType: 'question',
        entityId: questionId,
      });
      await ctx.realtime.publish([owner], { type: 'question.received', data: { id: questionId } });
    }
    track(db, u.id, 'question_asked', { hideName: input.hideName });
    reply.code(201);
    return {
      question: { id: questionId },
      ...(status === 'normal' ? {} : { notice: 'Your question will reach them once our team has reviewed it.' }),
    };
  });

  // ── Answers on a profile ──────────────────────────────────────────────
  app.get('/v1/users/:id/answers', async (req): Promise<Page<AnswerCard>> => {
    const viewer = req.user?.id ?? null;
    const { id } = parse(idParam, req.params);
    const q = parse(pageQuerySchema, req.query);
    const c = keyCursor(q.cursor);
    const { rows } = await db.query(
      `SELECT q.id, q.answered_at::text AS t ${ANSWER_FROM} WHERE q.recipient_id = $2 AND ${answerVisibleSql('$1')}
         ${c ? 'AND (q.answered_at, q.id) < ($4::timestamptz, $5::uuid)' : ''}
       ORDER BY q.answered_at DESC, q.id DESC LIMIT $3`,
      c ? [viewer, id, q.limit + 1, c.t, c.id] : [viewer, id, q.limit + 1],
    );
    const page = rows.slice(0, q.limit);
    return {
      items: await answerCards(
        db,
        page.map((r) => r.id),
        viewer,
      ),
      nextCursor: rows.length > q.limit ? encodeCursor({ t: page.at(-1)!.t, id: page.at(-1)!.id }) : null,
    };
  });

  /** One answer, for links from notifications and posts. */
  app.get('/v1/questions/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    const [answer] = await answerCards(db, [id], req.user?.id ?? null);
    if (!answer) throw notFound('That answer');
    return { answer };
  });

  // ── Your inbox ────────────────────────────────────────────────────────
  const STATE_SQL: Record<AskFilter, string> = {
    new: 'q.answered_at IS NULL AND q.hidden_at IS NULL',
    answered: 'q.answered_at IS NOT NULL AND q.hidden_at IS NULL',
    hidden: 'q.hidden_at IS NOT NULL',
  };
  // What reaches the owner: cleared questions, and their own answers while a moderator looks at them.
  const IN_INBOX = `q.recipient_id = $1 AND q.deleted_at IS NULL AND (q.moderation_status = 'normal' OR (q.answered_at IS NOT NULL AND q.moderation_status IN ('review', 'restricted')))`;

  app.get('/v1/me/questions', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const q = parse(askInboxQuerySchema, req.query);
    const c = keyCursor(q.cursor);
    const { rows } = await db.query(
      `SELECT q.id, q.created_at::text AS t FROM ask_questions q WHERE ${IN_INBOX} AND ${STATE_SQL[q.filter]}
         ${c ? 'AND (q.created_at, q.id) < ($3::timestamptz, $4::uuid)' : ''}
       ORDER BY q.created_at DESC, q.id DESC LIMIT $2`,
      c ? [u.id, q.limit + 1, c.t, c.id] : [u.id, q.limit + 1],
    );
    const page = rows.slice(0, q.limit);
    const counts = (
      await db.query<Record<AskFilter, number>>(
        `SELECT count(*) FILTER (WHERE ${STATE_SQL.new})::int AS new, count(*) FILTER (WHERE ${STATE_SQL.answered})::int AS answered,
                count(*) FILTER (WHERE ${STATE_SQL.hidden})::int AS hidden
         FROM ask_questions q WHERE ${IN_INBOX}`,
        [u.id],
      )
    ).rows[0]!;
    return {
      items: await inboxQuestions(
        db,
        page.map((r) => r.id),
        u.id,
      ),
      nextCursor: rows.length > q.limit ? encodeCursor({ t: page.at(-1)!.t, id: page.at(-1)!.id }) : null,
      counts,
    };
  });

  /** One of your questions, or a 404 (it isn't yours, it was deleted, or it's waiting for a moderator). */
  async function ownQuestion(id: string, owner: string) {
    const { rows } = await db.query(
      `SELECT q.id, q.asker_id, q.hide_name, q.body, q.answered_at, q.hidden_at, q.moderation_status FROM ask_questions q WHERE q.id = $2 AND ${IN_INBOX}`,
      [owner, id],
    );
    if (!rows[0]) throw notFound('That question');
    return rows[0] as { id: string; asker_id: string; hide_name: boolean; body: string; answered_at: Date | null; hidden_at: Date | null };
  }
  const one = async (id: string, owner: string): Promise<InboxQuestion> => (await inboxQuestions(db, [id], owner))[0]!;

  /**
   * Answer a question. The answer card shows on your Answers tab; with `share`, it's also posted
   * (the post's text is the answer and it quotes the question). The answer is checked like a
   * comment and the post like any post; flagged ones wait for a moderator and only you see them.
   * The asker is told, whether or not their name was shown.
   */
  app.post('/v1/questions/:id/answer', { preHandler: requireAuth, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const input = parse(answerQuestionSchema, req.body);
    const q = await ownQuestion(id, u.id);
    if (q.answered_at) throw conflict('You already answered this question.');
    const analysis = analyzeText(input.answer);
    if (analysis.risk === 'escalate')
      throw new AppError(
        422,
        'content_blocked',
        "This answer can't be shared because it may put someone at risk. If you or someone else is in danger, contact local emergency services.",
      );
    const limited = await isRestricted(db, u.id);
    const status = limited ? 'restricted' : statusForRisk(analysis.risk);
    // The post goes through every check a post does (confirmed email for public posts, pace, spam) before anything is saved.
    const post = input.share ? createPostSchema.parse({ body: input.answer, visibility: input.share.visibility }) : null;
    const screening = post ? await screenPost(db, ctx.config, u.id, { body: post.body, pollText: '', visibility: post.visibility, communityId: null }) : null;
    let limitedNow = false;
    const written = await tx(db, async (c) => {
      const r = await c.query(
        `UPDATE ask_questions SET answer = $2, answered_at = now(), hidden_at = NULL, moderation_status = $3 WHERE id = $1 AND answered_at IS NULL RETURNING id`,
        [id, input.answer, status],
      );
      if (!r.rowCount) throw conflict('You already answered this question.');
      if (analysis.risk !== 'normal')
        await c.query(
          `INSERT INTO moderation_cases (target_type, target_id, subject_user_id, source, risk, signals) VALUES ('answer',$1,$2,'automated',$3,$4) ON CONFLICT DO NOTHING`,
          [id, u.id, analysis.risk, { signals: analysis.signals }],
        );
      if (!post || !screening) return null;
      const w = await writePost(c, u.id, post, { state: 'published', moderationStatus: screening.status, music: null });
      await c.query(`UPDATE posts SET question_id = $2 WHERE id = $1`, [w.id, id]);
      limitedNow = await recordFlags(c, ctx.realtime, u.id, w.id, screening);
      return w;
    });
    if (written && post && screening)
      await announcePost(ctx, {
        postId: written.id,
        authorId: u.id,
        kind: written.kind,
        visibility: post.visibility,
        communityId: null,
        body: post.body,
        status: screening.status,
        taggedIds: written.taggedIds,
        collaborators: [],
        remixAuthor: null,
        remixOf: null,
        remixMode: null,
      });
    // Answers waiting for a moderator reach no one yet.
    if (status === 'normal')
      await notify(db, ctx.realtime, {
        userId: q.asker_id,
        category: 'friends',
        type: 'question_answered',
        actorId: u.id,
        entityType: 'question',
        entityId: id,
      });
    track(db, u.id, 'question_answered', { shared: !!written });
    const [sharedPost] = written ? await hydratePosts(db, [written.id], u.id) : [];
    return {
      question: await one(id, u.id),
      ...(sharedPost ? { post: sharedPost } : {}),
      ...(status !== 'normal'
        ? { moderation: { status, message: 'Your answer is visible only to you until it has been reviewed.' } }
        : screening
          ? { moderation: moderationNotice(screening, limitedNow) }
          : {}),
    };
  });

  /** Hide a question (it leaves your new or answered list, and your Answers tab), or bring it back. */
  app.post('/v1/questions/:id/hide', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    await ownQuestion(id, u.id);
    await db.query(`UPDATE ask_questions SET hidden_at = coalesce(hidden_at, now()) WHERE id = $1`, [id]);
    return { question: await one(id, u.id) };
  });

  app.delete('/v1/questions/:id/hide', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    await ownQuestion(id, u.id);
    await db.query(`UPDATE ask_questions SET hidden_at = NULL WHERE id = $1`, [id]);
    return { question: await one(id, u.id) };
  });

  /** Delete a question (and its answer). A post that shared the answer stays, without the question. */
  app.delete('/v1/questions/:id', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    await ownQuestion(id, u.id);
    await db.query(`UPDATE ask_questions SET deleted_at = now() WHERE id = $1`, [id]);
    return { ok: true };
  });

  /**
   * Block whoever asked a question. With a name: an ordinary block. Without a name: a question
   * block, so they can't ask you anything again and don't see your box or answers, without you
   * learning who they are (an ordinary block would show it in your blocked list and on their
   * profile). The question moves to hidden if it hadn't been answered.
   */
  app.post('/v1/questions/:id/block-asker', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const q = await ownQuestion(id, u.id);
    await tx(db, async (c) => {
      if (q.hide_name)
        await c.query(`INSERT INTO ask_blocks (recipient_id, asker_id, question_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [u.id, q.asker_id, id]);
      else await blockUser(c, u.id, q.asker_id);
      if (!q.answered_at) await c.query(`UPDATE ask_questions SET hidden_at = coalesce(hidden_at, now()) WHERE id = $1`, [id]);
    });
    return { blocked: true, scope: q.hide_name ? 'questions' : 'account', question: await one(id, u.id) };
  });

  app.delete('/v1/questions/:id/block-asker', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const q = await ownQuestion(id, u.id);
    if (q.hide_name) await db.query(`DELETE FROM ask_blocks WHERE recipient_id = $1 AND question_id = $2`, [u.id, id]);
    else await db.query(`DELETE FROM blocks WHERE blocker_id = $1 AND blocked_id = $2`, [u.id, q.asker_id]);
    return { blocked: false, question: await one(id, u.id) };
  });
}
