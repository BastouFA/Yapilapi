import type { FastifyInstance } from 'fastify';
import { tx } from '@yapilapi/database';
import {
  chatTheme,
  chatThemeSchema,
  editScheduledMessageSchema,
  SCHEDULED_MESSAGE_MAX_DAYS,
  SCHEDULED_MESSAGE_MAX_PENDING,
  SCHEDULED_MESSAGE_MIN_SECONDS,
  scheduleMessageSchema,
  type ChatTheme,
  type Message,
  type ScheduledMessage,
} from '@yapilapi/shared';
import { z } from 'zod';
import type { AppContext } from '../lib/context.ts';
import { AppError, badRequest, notFound, parse } from '../lib/errors.ts';
import { enqueue, enqueueAt } from '../lib/jobs.ts';
import { analyzeText } from '../lib/moderation.ts';
import { messageVisibleSql } from '../lib/chat.ts';
import { notify } from '../lib/services.ts';
import { me, requireAuth } from '../plugins/auth.ts';

/** The job that sends a scheduled message at its time. */
export const SEND_LATER_JOB = 'messages.send_later';

/** What the messaging module shares with this one (see modules/messaging.ts). */
export interface ChatLaterHelpers {
  assertMember: (conversationId: string, userId: string) => Promise<void>;
  memberIds: (conversationId: string) => Promise<string[]>;
  loadMessage: (messageId: string, reader: string) => Promise<Message | null>;
  /** Sends a normal message with every rule that applies now. */
  sendMessage: (
    u: { id: string; birthDate: Date | null },
    conversationId: string,
    input: {
      body: string;
      replyToId?: string;
      attachments: { mediaId: string; name?: string }[];
      clientId?: string;
      kind: 'message' | 'yap';
      viewOnce: boolean;
      storyId?: string;
    },
  ) => Promise<{ message: Message; notice?: string }>;
}

const idParam = z.object({ id: z.string().uuid() });

const SCHEDULED_COLS = `id, conversation_id, body, reply_to_id, send_at, status, failure, message_id, created_at`;

function toScheduled(r: Record<string, any>): ScheduledMessage {
  return {
    id: r.id,
    conversationId: r.conversation_id,
    body: r.body,
    replyToId: r.reply_to_id ?? null,
    sendAt: r.send_at.toISOString(),
    status: r.status,
    ...(r.failure ? { failure: r.failure } : {}),
    ...(r.message_id ? { messageId: r.message_id } : {}),
    createdAt: r.created_at.toISOString(),
  };
}

/** A time for sending later: at least a minute and at most a year from now. */
function sendTime(iso: string): Date {
  const at = new Date(iso);
  const now = Date.now();
  if (Number.isNaN(at.getTime()) || at.getTime() < now + SCHEDULED_MESSAGE_MIN_SECONDS * 1000 - 5_000)
    throw badRequest('Choose a time at least a minute from now.', { fields: { sendAt: 'Choose a later time.' } });
  if (at.getTime() > now + SCHEDULED_MESSAGE_MAX_DAYS * 86_400_000)
    throw badRequest('Choose a time within the next year.', { fields: { sendAt: 'Choose an earlier time.' } });
  return at;
}

const riskyText = () => new AppError(422, 'content_blocked', "This message wasn't scheduled because it may put someone at risk.");

/**
 * "Send later" (messages written now and sent at a chosen time, seen only by their sender until
 * then) and chat wallpapers and bubble colours.
 */
export function registerChatLater(app: FastifyInstance, ctx: AppContext, h: ChatLaterHelpers) {
  const db = ctx.db;

  /** Tell the sender's devices their list of scheduled messages changed. */
  const changed = (userId: string, s: { id: string; conversation_id: string; status: string }) =>
    ctx.realtime.publish([userId], { type: 'scheduled.updated', data: { id: s.id, conversationId: s.conversation_id, status: s.status } });

  /** A reply must quote a message in the same chat that the sender can see. */
  async function assertReplyTarget(conversationId: string, userId: string, replyToId: string | undefined | null) {
    if (!replyToId) return;
    const r = await db.query(
      `SELECT 1 FROM messages m WHERE m.id = $1 AND m.conversation_id = $3 AND m.deleted_at IS NULL AND m.kind <> 'system' AND ${messageVisibleSql('$2')}`,
      [replyToId, userId, conversationId],
    );
    if (!r.rowCount) throw new AppError(400, 'reply_unavailable', 'You can only reply to a message in this chat.');
  }

  async function ownScheduled(id: string, userId: string) {
    const r = (await db.query(`SELECT ${SCHEDULED_COLS}, sender_id FROM scheduled_messages WHERE id = $1`, [id])).rows[0];
    if (!r || r.sender_id !== userId) throw notFound('That scheduled message');
    return r;
  }

  /**
   * Send a scheduled message now, as a normal message with the chat's rules at this moment. A
   * reply whose original is gone goes out without the quote. Returns the message; errors are
   * the same as sending one yourself.
   */
  async function deliver(s: Record<string, any>): Promise<Message> {
    const u = (await db.query<{ birth_date: Date | null; status: string }>(`SELECT birth_date, status FROM users WHERE id = $1`, [s.sender_id])).rows[0];
    if (!u || u.status !== 'active') throw new AppError(403, 'account_inactive', 'Your account can’t send messages right now.');
    const member = await db.query(`SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2 AND left_at IS NULL`, [
      s.conversation_id,
      s.sender_id,
    ]);
    if (!member.rowCount) throw new AppError(403, 'not_member', 'You’re no longer in this chat.');
    const input = { body: s.body as string, attachments: [], clientId: `later:${s.id}`, kind: 'message' as const, viewOnce: false };
    const send = (replyToId?: string) =>
      h.sendMessage({ id: s.sender_id, birthDate: u.birth_date }, s.conversation_id, { ...input, ...(replyToId ? { replyToId } : {}) });
    let out: { message: Message };
    try {
      out = await send(s.reply_to_id ?? undefined);
    } catch (e) {
      if (!(e instanceof AppError && e.code === 'reply_unavailable')) throw e;
      out = await send();
    }
    const done = await db.query(
      `UPDATE scheduled_messages SET status = 'sent', message_id = $2, failure = NULL, updated_at = now() WHERE id = $1 AND status IN ('scheduled', 'failed') RETURNING id, conversation_id, status`,
      [s.id, out.message.id],
    );
    if (done.rows[0]) await changed(s.sender_id, done.rows[0]);
    return out.message;
  }

  // The job at each message's time. One that was sent, cancelled or moved later is left alone.
  // Too many messages at once (the pace limit) waits a minute and tries again; anything else that
  // stops it (you left the chat, you can't message this person any more) marks it as not sent,
  // with the reason, and tells you.
  ctx.jobs[SEND_LATER_JOB] = async ({ id }: { id: string }) => {
    const s = (await db.query(`SELECT * FROM scheduled_messages WHERE id = $1 AND status = 'scheduled' AND send_at <= now()`, [id])).rows[0];
    if (!s) return;
    try {
      await deliver(s);
    } catch (e) {
      if (!(e instanceof AppError)) throw e;
      if (e.status === 429) {
        await enqueue(db, SEND_LATER_JOB, { id }, 60);
        return;
      }
      const failed = await db.query(
        `UPDATE scheduled_messages SET status = 'failed', failure = $2, updated_at = now() WHERE id = $1 AND status = 'scheduled' RETURNING id, conversation_id, status`,
        [id, e.message.slice(0, 300)],
      );
      if (!failed.rows[0]) return;
      await changed(s.sender_id, failed.rows[0]);
      await notify(db, ctx.realtime, {
        userId: s.sender_id,
        category: 'messages',
        type: 'scheduled_message_failed',
        entityType: 'conversation',
        entityId: s.conversation_id,
        data: { scheduledId: id, reason: e.message.slice(0, 300) },
      });
    }
  };

  /** Your messages waiting to be sent in this chat (and ones that couldn't be sent), soonest first. */
  app.get('/v1/conversations/:id/scheduled', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    await h.assertMember(id, u.id);
    const { rows } = await db.query(
      `SELECT ${SCHEDULED_COLS} FROM scheduled_messages WHERE conversation_id = $1 AND sender_id = $2 AND status IN ('scheduled', 'failed') ORDER BY send_at, created_at`,
      [id, u.id],
    );
    return { items: rows.map(toScheduled) };
  });

  /** Write a message now and have it sent at a later time. Only you see it until then. */
  app.post('/v1/conversations/:id/scheduled', { preHandler: requireAuth, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const input = parse(scheduleMessageSchema, req.body);
    await h.assertMember(id, u.id);
    const at = sendTime(input.sendAt);
    if (analyzeText(input.body).risk === 'escalate') throw riskyText();
    await assertReplyTarget(id, u.id, input.replyToId);
    const row = await tx(db, async (c) => {
      await c.query(`SELECT pg_advisory_xact_lock(hashtext('later:' || $1))`, [u.id]);
      const pending = await c.query(`SELECT count(*)::int AS n FROM scheduled_messages WHERE sender_id = $1 AND status = 'scheduled'`, [u.id]);
      if (pending.rows[0].n >= SCHEDULED_MESSAGE_MAX_PENDING)
        throw new AppError(
          409,
          'too_many_scheduled',
          `You can have up to ${SCHEDULED_MESSAGE_MAX_PENDING} messages waiting to be sent. Send or cancel some first.`,
        );
      const { rows } = await c.query(
        `INSERT INTO scheduled_messages (conversation_id, sender_id, body, reply_to_id, send_at) VALUES ($1,$2,$3,$4,$5) RETURNING ${SCHEDULED_COLS}`,
        [id, u.id, input.body, input.replyToId ?? null, at],
      );
      await enqueueAt(c, SEND_LATER_JOB, { id: rows[0].id }, at);
      return rows[0];
    });
    await changed(u.id, row);
    reply.code(201);
    return { scheduled: toScheduled(row) };
  });

  /** Change the text or the time of a message waiting to be sent (or one that couldn't be, to try again). */
  app.patch('/v1/scheduled-messages/:id', { preHandler: requireAuth, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const input = parse(editScheduledMessageSchema, req.body);
    const s = await ownScheduled(id, u.id);
    if (s.status === 'sent' || s.status === 'cancelled') throw new AppError(409, 'scheduled_done', 'This message was already sent or cancelled.');
    const at = input.sendAt ? sendTime(input.sendAt) : null;
    if (input.body !== undefined && analyzeText(input.body).risk === 'escalate') throw riskyText();
    // A failed one needs a new time to be tried again.
    if (s.status === 'failed' && !at) throw badRequest('Choose a new time to try again, or send it now.', { fields: { sendAt: 'Choose a new time.' } });
    const row = await tx(db, async (c) => {
      const { rows } = await c.query(
        `UPDATE scheduled_messages SET body = coalesce($2, body), send_at = coalesce($3, send_at), status = 'scheduled', failure = NULL, updated_at = now()
         WHERE id = $1 AND status IN ('scheduled', 'failed') RETURNING ${SCHEDULED_COLS}`,
        [id, input.body ?? null, at],
      );
      if (!rows[0]) throw new AppError(409, 'scheduled_done', 'This message was already sent or cancelled.');
      // The job at the old time finds it moved and does nothing.
      if (at) await enqueueAt(c, SEND_LATER_JOB, { id }, at);
      return rows[0];
    });
    await changed(u.id, row);
    return { scheduled: toScheduled(row) };
  });

  /** Send it now instead of waiting. */
  app.post('/v1/scheduled-messages/:id/send-now', { preHandler: requireAuth, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const s = await ownScheduled(id, u.id);
    if (s.status === 'sent' || s.status === 'cancelled') throw new AppError(409, 'scheduled_done', 'This message was already sent or cancelled.');
    const message = await deliver({ ...s, sender_id: u.id });
    return { message };
  });

  /** Cancel a message waiting to be sent (or dismiss one that couldn't be). */
  app.delete('/v1/scheduled-messages/:id', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    await ownScheduled(id, u.id);
    const { rows } = await db.query(
      `UPDATE scheduled_messages SET status = 'cancelled', updated_at = now() WHERE id = $1 AND status IN ('scheduled', 'failed') RETURNING id, conversation_id, status`,
      [id],
    );
    if (!rows[0]) throw new AppError(409, 'scheduled_done', 'This message was already sent.');
    await changed(u.id, rows[0]);
    return { ok: true };
  });

  // ── Wallpaper and bubble colour ───────────────────────────────────────
  /**
   * Change the chat's wallpaper, bubble colour, or both. Everyone in it sees the same, and a line
   * in the chat says who changed it. Anyone in a one-to-one chat or a group can; in community
   * chats, admins.
   */
  app.put('/v1/conversations/:id/theme', { preHandler: requireAuth, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const input = parse(chatThemeSchema, req.body);
    const member = (
      await db.query(
        `SELECT c.kind, cm.role FROM conversations c JOIN conversation_members cm ON cm.conversation_id = c.id WHERE c.id = $1 AND cm.user_id = $2 AND cm.left_at IS NULL`,
        [id, u.id],
      )
    ).rows[0];
    if (!member) throw notFound('Conversation');
    if (member.kind === 'community' && member.role !== 'admin') throw new AppError(403, 'admins_only', 'Only admins can change how this chat looks.');
    const result = await tx(db, async (c) => {
      const cur = (await c.query(`SELECT wallpaper, accent FROM conversations WHERE id = $1 FOR UPDATE`, [id])).rows[0];
      const next: ChatTheme = chatTheme({ wallpaper: input.wallpaper ?? cur.wallpaper, accent: input.accent ?? cur.accent });
      if (next.wallpaper === cur.wallpaper && next.accent === cur.accent)
        return { theme: next, lineId: null as string | null, replaced: null as string | null };
      await c.query(`UPDATE conversations SET wallpaper = $2, accent = $3 WHERE id = $1`, [id, next.wallpaper, next.accent]);
      // Trying a few looks in a row leaves one line, not one per tap: when the chat's newest
      // message is your own look line from the last few minutes, it's replaced.
      const replaced = (
        await c.query(
          `DELETE FROM messages WHERE id = (
             SELECT id FROM messages WHERE conversation_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1
           ) AND sender_id = $2 AND kind = 'system' AND meta->>'type' = 'theme' AND created_at > now() - interval '10 minutes'
           RETURNING id`,
          [id, u.id],
        )
      ).rows[0]?.id as string | undefined;
      const { rows } = await c.query(`INSERT INTO messages (conversation_id, sender_id, body, kind, meta) VALUES ($1,$2,'','system',$3) RETURNING id`, [
        id,
        u.id,
        { type: 'theme', wallpaper: next.wallpaper, accent: next.accent },
      ]);
      return { theme: next, lineId: rows[0].id as string, replaced: replaced ?? null };
    });
    if (!result.lineId) return { theme: result.theme, message: null };
    const members = await h.memberIds(id);
    const line = await h.loadMessage(result.lineId, u.id);
    if (result.replaced) await ctx.realtime.publish(members, { type: 'message.deleted', data: { id: result.replaced, conversationId: id } });
    await ctx.realtime.publish(members, { type: 'message.created', data: line });
    await ctx.realtime.publish(members, { type: 'conversation.theme', data: { id, theme: result.theme } });
    return { theme: result.theme, message: line };
  });
}
