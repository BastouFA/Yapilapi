import type { FastifyInstance } from 'fastify';
import { tx } from '@yapilapi/database';
import {
  CHAT_LIST_MAX_ITEMS,
  CHAT_POLL_MAX_DAYS,
  CHAT_POLL_MAX_OPTIONS,
  CHAT_REMINDER_MAX_DAYS,
  CHAT_REMINDER_MAX_PENDING,
  chatListItemPatchSchema,
  chatListItemSchema,
  chatListOrderSchema,
  chatPollOptionSchema,
  chatPollVoteSchema,
  chatReminderSchema,
  createChatListSchema,
  createChatPollSchema,
  type ChatReminder,
  type Message,
} from '@yapilapi/shared';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { AppContext } from '../lib/context.ts';
import { messagePreviews } from '../lib/chat.ts';
import { listsFor, pollsFor, publishList, publishMyReminder, publishPoll } from '../lib/chat-polls.ts';
import { AppError, badRequest, forbidden, notFound, parse } from '../lib/errors.ts';
import { enqueue, enqueueAt } from '../lib/jobs.ts';
import { analyzeText } from '../lib/moderation.ts';
import { assertMessagePace, assessMessage } from '../lib/spam.ts';
import { areFriends, isBlockedEitherWay } from '../lib/users.ts';
import { me, requireAuth, type AuthUser } from '../plugins/auth.ts';

/** What the messaging module shares with this one (see modules/messaging.ts). */
export interface ChatHelpers {
  assertMember: (conversationId: string, userId: string) => Promise<void>;
  memberIds: (conversationId: string) => Promise<string[]>;
  notBlocking: (senderId: string, ids: string[]) => Promise<string[]>;
  assertCanMessage: (senderId: string, senderBirth: Date | null, recipientId: string) => Promise<void>;
  assertGroupSafe: (adding: string[], members: string[]) => Promise<void>;
  messageFor: (messageId: string, userId: string) => Promise<Record<string, any>>;
  loadMessage: (messageId: string, reader: string) => Promise<Message | null>;
}

const idParam = z.object({ id: z.string().uuid() });
const itemParams = z.object({ id: z.string().uuid(), itemId: z.string().uuid() });

const blocked = () => new AppError(422, 'content_blocked', "This wasn't sent because it may put someone at risk.");
const spammy = () => new AppError(422, 'content_blocked', "This wasn't sent because it looks like spam.");
const pollEnded = () => new AppError(409, 'poll_ended', 'This poll has ended.');

/**
 * Polls, shared lists and reminders in chats (one-to-one and groups). Only people in the chat
 * can see or change them; each change goes live to the members who can see the message, and
 * none of it sends a push (a reminder you set does, at its time).
 */
export function registerChatPollsLists(app: FastifyInstance, ctx: AppContext, h: ChatHelpers) {
  const db = ctx.db;
  const deps = { db, realtime: ctx.realtime };

  /**
   * Before someone puts new words in a chat (a poll, an option, a list or an item): the same
   * rules as a message. One-to-one: blocks, minor safety, family settings, and the spam check
   * for people who aren't friends. Groups: the group-safety rule for the person writing.
   */
  async function assertCanWrite(u: AuthUser, conversationId: string, texts: string[]) {
    const conv = (await db.query<{ kind: string }>(`SELECT kind FROM conversations WHERE id = $1`, [conversationId])).rows[0];
    if (!conv) throw notFound('Conversation');
    const members = await h.memberIds(conversationId);
    let stranger = false;
    if (conv.kind === 'direct') {
      const other = members.find((m) => m !== u.id);
      if (other) {
        await h.assertCanMessage(u.id, u.birthDate, other);
        stranger = !(await areFriends(db, u.id, other));
      }
    } else if (conv.kind === 'group') {
      await h.assertGroupSafe([u.id], members);
    }
    await assertMessagePace(db, ctx.config, u.id);
    if (texts.some((x) => analyzeText(x).risk === 'escalate')) throw blocked();
    if (stranger && (await assessMessage(db, ctx.config, u.id, conversationId, texts.join('\n'))).flags.length) throw spammy();
  }

  /** Voting and ticking: in a one-to-one chat, not with someone who blocked you (or you them). */
  async function assertCanInteract(userId: string, conversationId: string) {
    const conv = (await db.query<{ kind: string }>(`SELECT kind FROM conversations WHERE id = $1`, [conversationId])).rows[0];
    if (conv?.kind !== 'direct') return;
    const other = (await h.memberIds(conversationId)).find((m) => m !== userId);
    if (other && (await isBlockedEitherWay(db, userId, other))) throw forbidden("You can't message this person.");
  }

  /** A message you can see and act on: in your chat, still there, not from someone you blocked. */
  async function visibleMessage(messageId: string, userId: string) {
    const m = await h.messageFor(messageId, userId);
    if (m.deleted_at) throw notFound('Message');
    const b = await db.query(`SELECT 1 FROM blocks WHERE blocker_id = $1 AND blocked_id = $2`, [userId, m.sender_id]);
    if (b.rowCount) throw notFound('Message');
    return m;
  }

  /** Insert a poll or list message and its rows in one go, then send it to everyone in the chat. */
  async function createRichMessage(
    u: AuthUser,
    conversationId: string,
    body: string,
    clientId: string | undefined,
    fill: (c: PoolClient, messageId: string) => Promise<void>,
  ): Promise<Message> {
    const conv = (await db.query(`SELECT disappearing_seconds FROM conversations WHERE id = $1`, [conversationId])).rows[0];
    const seconds: number | null = conv?.disappearing_seconds ?? null;
    const row = await tx(db, async (c) => {
      const { rows } = await c.query(
        `INSERT INTO messages (conversation_id, sender_id, body, client_id, kind, expires_at)
         VALUES ($1,$2,$3,$4,'message', now() + make_interval(secs => $5::int))
         ON CONFLICT (sender_id, client_id) WHERE client_id IS NOT NULL DO UPDATE SET client_id = EXCLUDED.client_id
         RETURNING id, conversation_id, (xmax = 0) AS inserted`,
        [conversationId, u.id, body, clientId ?? null, seconds],
      );
      const r = rows[0] as { id: string; conversation_id: string; inserted: boolean };
      if (r.conversation_id !== conversationId) throw badRequest('That clientId was used in another chat.');
      // The same clientId again (a retry): the first one stands.
      if (!r.inserted) return r;
      await fill(c, r.id);
      // A disappearing message takes its poll or list with it.
      if (seconds) await enqueue(c, 'messages.expire', { messageId: r.id }, seconds + 1);
      await c.query(`UPDATE conversations SET last_message_at = now() WHERE id = $1`, [conversationId]);
      await c.query(`UPDATE conversation_members SET last_read_at = now() WHERE conversation_id = $1 AND user_id = $2`, [conversationId, u.id]);
      return r;
    });
    const message = await h.loadMessage(row.id, u.id);
    if (!message) throw notFound('Message');
    // Nobody has voted or ticked anything yet, so everyone sees the same thing.
    if (row.inserted) await ctx.realtime.publish(await h.notBlocking(u.id, await h.memberIds(conversationId)), { type: 'message.created', data: message });
    return message;
  }

  // ── Polls ─────────────────────────────────────────────────────────────
  app.post('/v1/conversations/:id/polls', { preHandler: requireAuth, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const input = parse(createChatPollSchema, req.body);
    await h.assertMember(id, u.id);
    let endsAt: Date | null = null;
    if (input.endsAt) {
      endsAt = new Date(input.endsAt);
      const ms = endsAt.getTime() - Date.now();
      if (ms < 5 * 60_000 || ms > CHAT_POLL_MAX_DAYS * 86_400_000)
        throw new AppError(400, 'poll_end_time', `Choose an end time between 5 minutes and ${CHAT_POLL_MAX_DAYS} days from now.`);
    }
    await assertCanWrite(u, id, [input.question, ...input.options]);
    const message = await createRichMessage(u, id, input.question, input.clientId, async (c, messageId) => {
      await c.query(
        `INSERT INTO chat_polls (message_id, conversation_id, created_by, question, multiple, anonymous, allow_add_options, ends_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [messageId, id, u.id, input.question, input.multiple, input.anonymous, input.allowAddOptions, endsAt],
      );
      await c.query(
        `INSERT INTO chat_poll_options (message_id, text, position, added_by) SELECT $1, t.text, t.n - 1, $3 FROM unnest($2::text[]) WITH ORDINALITY AS t(text, n)`,
        [messageId, input.options, u.id],
      );
      if (endsAt) await enqueueAt(c, 'chat.poll.end', { messageId }, endsAt);
    });
    reply.code(201);
    return { message };
  });

  /** The poll of a message, locked for a change. Missing (unsent, disappeared) is "not found". */
  async function lockPoll(c: PoolClient, messageId: string) {
    const p = (
      await c.query(
        `SELECT message_id, created_by, multiple, allow_add_options, (ended_at IS NOT NULL OR (ends_at IS NOT NULL AND ends_at <= now())) AS ended
         FROM chat_polls WHERE message_id = $1 FOR UPDATE`,
        [messageId],
      )
    ).rows[0];
    if (!p) throw notFound('Poll');
    return p as { message_id: string; created_by: string; multiple: boolean; allow_add_options: boolean; ended: boolean };
  }

  const myPoll = async (messageId: string, userId: string) => (await pollsFor(db, [messageId], [userId]))(messageId, userId) ?? null;

  /** Vote, change your vote, or take it back (no options). Until the poll ends. */
  app.put('/v1/messages/:id/poll/vote', { preHandler: requireAuth, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const { optionIds } = parse(chatPollVoteSchema, req.body);
    const m = await visibleMessage(id, u.id);
    await assertCanInteract(u.id, m.conversation_id);
    const chosen = [...new Set(optionIds)];
    await tx(db, async (c) => {
      const p = await lockPoll(c, id);
      if (p.ended) throw pollEnded();
      if (!p.multiple && chosen.length > 1) throw new AppError(400, 'single_choice', 'This poll takes one choice.');
      if (chosen.length) {
        const known = await c.query(`SELECT id FROM chat_poll_options WHERE message_id = $1 AND id = ANY($2::uuid[])`, [id, chosen]);
        if (known.rowCount !== chosen.length) throw new AppError(400, 'unknown_option', 'That option isn’t in this poll.');
      }
      await c.query(`DELETE FROM chat_poll_votes WHERE message_id = $1 AND user_id = $2 AND NOT (option_id = ANY($3::uuid[]))`, [id, u.id, chosen]);
      if (chosen.length)
        await c.query(
          `INSERT INTO chat_poll_votes (option_id, message_id, user_id) SELECT unnest($3::uuid[]), $1, $2 ON CONFLICT (option_id, user_id) DO NOTHING`,
          [id, u.id, chosen],
        );
    });
    await publishPoll(deps, id);
    return { poll: await myPoll(id, u.id) };
  });

  /** Add an option: the poll's creator, or anyone when the poll allows it. Up to 10 options. */
  app.post('/v1/messages/:id/poll/options', { preHandler: requireAuth, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const { text } = parse(chatPollOptionSchema, req.body);
    const m = await visibleMessage(id, u.id);
    const pre = (await db.query(`SELECT created_by, allow_add_options FROM chat_polls WHERE message_id = $1`, [id])).rows[0];
    if (!pre) throw notFound('Poll');
    if (!pre.allow_add_options && pre.created_by !== u.id) throw new AppError(403, 'options_closed', 'Only the person who made this poll can add options.');
    await assertCanWrite(u, m.conversation_id, [text]);
    await tx(db, async (c) => {
      const p = await lockPoll(c, id);
      if (p.ended) throw pollEnded();
      const n = (
        await c.query<{ n: number; last: number }>(
          `SELECT count(*)::int AS n, coalesce(max(position), -1)::int AS last FROM chat_poll_options WHERE message_id = $1`,
          [id],
        )
      ).rows[0]!;
      if (n.n >= CHAT_POLL_MAX_OPTIONS) throw new AppError(409, 'poll_full', `A poll can have up to ${CHAT_POLL_MAX_OPTIONS} options.`);
      await c
        .query(`INSERT INTO chat_poll_options (message_id, text, position, added_by) VALUES ($1,$2,$3,$4)`, [id, text, n.last + 1, u.id])
        .catch((e: { code?: string }) => {
          if (e.code === '23505') throw new AppError(409, 'option_exists', 'That option is already in the poll.');
          throw e;
        });
    });
    await publishPoll(deps, id);
    return { poll: await myPoll(id, u.id) };
  });

  /** End the poll now (its creator only). Votes stay as they are. */
  app.post('/v1/messages/:id/poll/end', { preHandler: requireAuth, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    await visibleMessage(id, u.id);
    await tx(db, async (c) => {
      const p = await lockPoll(c, id);
      if (p.created_by !== u.id) throw new AppError(403, 'not_poll_creator', 'Only the person who made this poll can end it.');
      if (!p.ended) await c.query(`UPDATE chat_polls SET ended_at = now() WHERE message_id = $1`, [id]);
    });
    await publishPoll(deps, id);
    return { poll: await myPoll(id, u.id) };
  });

  // ── Shared lists ──────────────────────────────────────────────────────
  app.post('/v1/conversations/:id/lists', { preHandler: requireAuth, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const input = parse(createChatListSchema, req.body);
    await h.assertMember(id, u.id);
    await assertCanWrite(u, id, [input.title, ...input.items]);
    const message = await createRichMessage(u, id, input.title, input.clientId, async (c, messageId) => {
      await c.query(`INSERT INTO chat_lists (message_id, conversation_id, created_by, title) VALUES ($1,$2,$3,$4)`, [messageId, id, u.id, input.title]);
      if (input.items.length)
        await c.query(
          `INSERT INTO chat_list_items (message_id, text, position, added_by) SELECT $1, t.text, t.n - 1, $3 FROM unnest($2::text[]) WITH ORDINALITY AS t(text, n)`,
          [messageId, input.items, u.id],
        );
    });
    reply.code(201);
    return { message };
  });

  async function lockList(c: PoolClient, messageId: string) {
    const l = (await c.query(`SELECT message_id, created_by FROM chat_lists WHERE message_id = $1 FOR UPDATE`, [messageId])).rows[0];
    if (!l) throw notFound('List');
    return l as { message_id: string; created_by: string };
  }

  const myList = async (messageId: string, userId: string) => (await listsFor(db, [messageId], [userId]))(messageId, userId) ?? null;

  /** Add an item to the end of the list. Up to 100. */
  app.post('/v1/messages/:id/list/items', { preHandler: requireAuth, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req, reply) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const { text } = parse(chatListItemSchema, req.body);
    const m = await visibleMessage(id, u.id);
    await assertCanWrite(u, m.conversation_id, [text]);
    await tx(db, async (c) => {
      await lockList(c, id);
      const n = (
        await c.query<{ n: number; last: number }>(
          `SELECT count(*)::int AS n, coalesce(max(position), -1)::int AS last FROM chat_list_items WHERE message_id = $1`,
          [id],
        )
      ).rows[0]!;
      if (n.n >= CHAT_LIST_MAX_ITEMS) throw new AppError(409, 'list_full', `A list can have up to ${CHAT_LIST_MAX_ITEMS} items.`);
      await c.query(`INSERT INTO chat_list_items (message_id, text, position, added_by) VALUES ($1,$2,$3,$4)`, [id, text, n.last + 1, u.id]);
    });
    await publishList(deps, id);
    reply.code(201);
    return { list: await myList(id, u.id) };
  });

  /** Tick an item off (or back on). Anyone in the chat can; the list shows who did. */
  app.patch('/v1/messages/:id/list/items/:itemId', { preHandler: requireAuth, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req) => {
    const u = me(req);
    const { id, itemId } = parse(itemParams, req.params);
    const { done } = parse(chatListItemPatchSchema, req.body);
    const m = await visibleMessage(id, u.id);
    await assertCanInteract(u.id, m.conversation_id);
    const r = done
      ? await db.query(`UPDATE chat_list_items SET done_by = $3, done_at = now() WHERE id = $1 AND message_id = $2 AND done_at IS NULL RETURNING id`, [
          itemId,
          id,
          u.id,
        ])
      : await db.query(`UPDATE chat_list_items SET done_by = NULL, done_at = NULL WHERE id = $1 AND message_id = $2 AND done_at IS NOT NULL RETURNING id`, [
          itemId,
          id,
        ]);
    if (!r.rowCount && !(await db.query(`SELECT 1 FROM chat_list_items WHERE id = $1 AND message_id = $2`, [itemId, id])).rowCount) throw notFound('Item');
    if (r.rowCount) await publishList(deps, id);
    return { list: await myList(id, u.id) };
  });

  /** Remove an item: the person who added it, or the person who made the list. */
  app.delete('/v1/messages/:id/list/items/:itemId', { preHandler: requireAuth, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req) => {
    const u = me(req);
    const { id, itemId } = parse(itemParams, req.params);
    await visibleMessage(id, u.id);
    await tx(db, async (c) => {
      const l = await lockList(c, id);
      const item = (await c.query(`SELECT added_by FROM chat_list_items WHERE id = $1 AND message_id = $2`, [itemId, id])).rows[0];
      if (!item) throw notFound('Item');
      if (item.added_by !== u.id && l.created_by !== u.id) throw new AppError(403, 'not_your_item', 'You can remove the items you added.');
      await c.query(`DELETE FROM chat_list_items WHERE id = $1`, [itemId]);
    });
    await publishList(deps, id);
    return { list: await myList(id, u.id) };
  });

  /** Put the items in a new order. Send every item: if the list changed meanwhile, try again. */
  app.put('/v1/messages/:id/list/order', { preHandler: requireAuth, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const { itemIds } = parse(chatListOrderSchema, req.body);
    const m = await visibleMessage(id, u.id);
    await assertCanInteract(u.id, m.conversation_id);
    await tx(db, async (c) => {
      await lockList(c, id);
      const current = (await c.query<{ id: string }>(`SELECT id FROM chat_list_items WHERE message_id = $1`, [id])).rows.map((r) => r.id);
      const given = new Set(itemIds);
      if (given.size !== itemIds.length || given.size !== current.length || current.some((x) => !given.has(x)))
        throw new AppError(409, 'list_changed', 'The list changed while you were moving things. Try again.');
      await c.query(
        `UPDATE chat_list_items i SET position = t.n - 1 FROM unnest($2::uuid[]) WITH ORDINALITY AS t(id, n) WHERE i.id = t.id AND i.message_id = $1`,
        [id, itemIds],
      );
    });
    await publishList(deps, id);
    return { list: await myList(id, u.id) };
  });

  // ── Reminders ─────────────────────────────────────────────────────────
  async function reminderViews(rows: Record<string, any>[], reader: string): Promise<ChatReminder[]> {
    const previews = await messagePreviews(
      db,
      rows.map((r) => r.message_id),
      reader,
    );
    return rows.map((r) => ({
      id: r.id,
      messageId: r.message_id,
      conversationId: r.conversation_id,
      scope: r.scope,
      remindAt: r.remind_at.toISOString(),
      createdAt: r.created_at.toISOString(),
      message: previews.get(r.message_id) ?? null,
    }));
  }

  /**
   * "Remind me" (just you: a notification at that time) or, for group admins, "Remind the
   * group" (a line in the chat at that time). A disappearing message can't have a reminder
   * after it disappears.
   */
  app.post('/v1/messages/:id/reminders', { preHandler: requireAuth, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const input = parse(chatReminderSchema, req.body);
    const m = await visibleMessage(id, u.id);
    if (m.kind === 'system') throw new AppError(400, 'not_remindable', 'You can’t set a reminder on this line.');
    const at = new Date(input.at);
    const ms = at.getTime() - Date.now();
    if (ms < 60_000 || ms > CHAT_REMINDER_MAX_DAYS * 86_400_000)
      throw new AppError(400, 'reminder_time', `Choose a time between a minute and ${CHAT_REMINDER_MAX_DAYS} days from now.`);
    if (m.expires_at && at >= m.expires_at)
      throw new AppError(400, 'reminder_after_expiry', 'This message will disappear before then. Choose an earlier time.');
    if (input.scope === 'group') {
      const r = (
        await db.query(
          `SELECT c.kind, cm.role FROM conversations c JOIN conversation_members cm ON cm.conversation_id = c.id
           WHERE c.id = $1 AND cm.user_id = $2 AND cm.left_at IS NULL`,
          [m.conversation_id, u.id],
        )
      ).rows[0];
      if (r?.kind === 'direct') throw new AppError(400, 'groups_only', 'Group reminders are for group chats.');
      if (r?.role !== 'admin') throw new AppError(403, 'admins_only', 'Only group admins can remind the group.');
    }
    const row = await tx(db, async (c) => {
      await c.query(`SELECT pg_advisory_xact_lock(hashtext('reminders:' || $1))`, [u.id]);
      const pending = (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM chat_reminders WHERE user_id = $1 AND sent_at IS NULL`, [u.id])).rows[0]!.n;
      if (pending >= CHAT_REMINDER_MAX_PENDING)
        throw new AppError(409, 'too_many_reminders', `You can have up to ${CHAT_REMINDER_MAX_PENDING} reminders waiting. Cancel one to add another.`);
      const { rows } = await c.query(
        `INSERT INTO chat_reminders (message_id, conversation_id, user_id, scope, remind_at) VALUES ($1,$2,$3,$4,$5)
         RETURNING id, message_id, conversation_id, scope, remind_at, created_at`,
        [id, m.conversation_id, u.id, input.scope, at],
      );
      await enqueueAt(c, 'chat.reminder', { reminderId: rows[0].id }, at);
      return rows[0];
    });
    if (input.scope === 'me') await publishMyReminder(deps, u.id, id, m.conversation_id);
    reply.code(201);
    return { reminder: (await reminderViews([row], u.id))[0] };
  });

  /** Your reminders waiting in this chat (yours for you, and the group ones you set). */
  app.get('/v1/conversations/:id/reminders', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    await h.assertMember(id, u.id);
    const { rows } = await db.query(
      `SELECT id, message_id, conversation_id, scope, remind_at, created_at FROM chat_reminders
       WHERE conversation_id = $1 AND user_id = $2 AND sent_at IS NULL ORDER BY remind_at LIMIT 100`,
      [id, u.id],
    );
    return { items: await reminderViews(rows, u.id) };
  });

  /** Cancel one of your reminders before its time. */
  app.delete('/v1/reminders/:id', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const r = (
      await db.query<{ message_id: string; conversation_id: string; scope: string }>(
        `DELETE FROM chat_reminders WHERE id = $1 AND user_id = $2 AND sent_at IS NULL RETURNING message_id, conversation_id, scope`,
        [id, u.id],
      )
    ).rows[0];
    if (!r) throw notFound('Reminder');
    if (r.scope === 'me') await publishMyReminder(deps, u.id, r.message_id, r.conversation_id);
    return { ok: true };
  });
}
