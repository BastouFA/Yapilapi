import type { FastifyInstance } from 'fastify';
import { tx } from '@yapilapi/database';
import {
  chatTheme,
  conversationYapsSchema,
  createConversationSchema,
  disappearingSchema,
  editMessageSchema,
  MAX_PINNED_MESSAGES,
  MESSAGE_EDIT_MINUTES,
  messageSearchSchema,
  pageQuerySchema,
  sendMessageSchema,
  yapSettingsSchema,
  type Conversation,
  type Message,
  type PinnedMessage,
  type YapEvent,
} from '@yapilapi/shared';
import { z } from 'zod';
import { activeControls } from '../lib/family.ts';
import { enqueue } from '../lib/jobs.ts';
import { openPrivate } from '../lib/private-files.ts';
import { assertRecapUse } from '../lib/recap-sharing.ts';
import { issueViewToken, OPEN_WINDOW_MINUTES, publishViewOnce, readViewToken, VIEW_ONCE_DAYS, viewOnceFor } from '../lib/view-once.ts';
import { planYap, recentYaps, YAP_LENGTH_SLACK_MS, YAP_MAX_MEMBERS, YAP_MAX_MS, YAP_PER_MINUTE } from '../lib/yaps.ts';
import { AppError, badRequest, forbidden, notFound, parse } from '../lib/errors.ts';
import type { AppContext } from '../lib/context.ts';
import { decodeCursor, keyCursorOf, type KeyCursor } from '../lib/cursor.ts';
import { analyzeText } from '../lib/moderation.ts';
import { isEnabled, notify, track } from '../lib/services.ts';
import { smartRepliesEverywhereSql, smartRepliesState } from '../lib/ai/assists.ts';
import { ageOf, areFriends, isBlockedEitherWay, publicUserFrom, usersByIds } from '../lib/users.ts';
import { messagesAllowed, seesSensitiveMedia, seesSensitiveSql } from '../lib/interactions.ts';
import { MEDIA_BLOCKED_MESSAGE } from '../lib/media-moderation.ts';
import { assertMessagePace, assessMessage, flagContent, isRestricted, restrictedError } from '../lib/spam.ts';
import { requireVerified } from '../lib/verification.ts';
import { me, requireAuth, resolveSession, sessionTokenOf } from '../plugins/auth.ts';
import { issueTicket, readTicket } from '../lib/realtime-ticket.ts';
import { canSeeStory, storyCards } from '../lib/stories.ts';
import { nowStatusesFor } from '../lib/now-status.ts';
import { mediaIdsOf, messagePreviews, messageVisibleSql, reactionSummaries, revokeChatMedia } from '../lib/chat.ts';
import { langOf } from '../lib/translation.ts';
import { listsFor, myReminders, pollsFor } from '../lib/chat-polls.ts';
import { registerChatPollsLists } from './chat-polls-lists.ts';
import { gamesFor } from '../lib/chat-games.ts';
import { registerChatGames } from './chat-games.ts';
import { mixCardsForMessages } from '../lib/mixes.ts';
import { registerMixChats } from './mixes.ts';
import { registerChatLater } from './chat-later.ts';
import { registerWatch } from './watch.ts';

const idParam = z.object({ id: z.string().uuid() });

/** Who sends a message: enough to apply the rules (minor safety needs the birth date). */
type Sender = { id: string; birthDate: Date | null };
type SendInput = z.output<typeof sendMessageSchema>;

const MESSAGE_COLS = `m.id, m.conversation_id, m.body, m.lang, m.reply_to_id, m.attachments, m.created_at, m.client_id, m.moderation_status, m.kind, m.story_id,
  m.edited_at, m.unsent_at, m.expires_at, m.meta,
  EXISTS (SELECT 1 FROM conversation_pins p WHERE p.message_id = m.id) AS pinned,
  pr.user_id AS s_id, pr.username AS s_username, pr.display_name AS s_display_name, pr.avatar_url AS s_avatar_url, pr.mode AS s_mode`;

/** The messages reader $2 sees (see messageVisibleSql). */
const VISIBLE_TO_READER = messageVisibleSql('$2');

export default async function messagingModule(app: FastifyInstance, ctx: AppContext) {
  const db = ctx.db;

  async function assertMember(conversationId: string, userId: string) {
    const r = await db.query(`SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2 AND left_at IS NULL`, [conversationId, userId]);
    if (!r.rowCount) throw notFound('Conversation');
  }

  /** Of these people, the ones who haven't blocked the sender: people who did never see their messages (in a group they share), live or when they load the chat. */
  async function notBlocking(senderId: string, ids: string[]): Promise<string[]> {
    const { rows } = await db.query<{ id: string }>(`SELECT blocker_id AS id FROM blocks WHERE blocked_id = $1 AND blocker_id = ANY($2::uuid[])`, [
      senderId,
      ids,
    ]);
    const blockers = new Set(rows.map((r) => r.id));
    return ids.filter((id) => !blockers.has(id));
  }

  async function memberIds(conversationId: string): Promise<string[]> {
    const { rows } = await db.query<{ user_id: string }>(`SELECT user_id FROM conversation_members WHERE conversation_id = $1 AND left_at IS NULL`, [
      conversationId,
    ]);
    return rows.map((r) => r.user_id);
  }

  /**
   * Minor safety + anti-abuse: nobody can message someone who blocked them, and
   * adults can only message a minor they are already friends with.
   */
  async function assertCanMessage(senderId: string, senderBirth: Date | null, recipientId: string) {
    if (await isBlockedEitherWay(db, senderId, recipientId)) throw forbidden("You can't message this person.");
    const r = await db.query<{ birth_date: Date | null; status: string }>(`SELECT birth_date, status FROM users WHERE id = $1`, [recipientId]);
    if (!r.rows[0] || r.rows[0].status !== 'active') throw notFound('That person');
    const recipientAge = ageOf(r.rows[0].birth_date);
    const senderAge = ageOf(senderBirth);
    const minorInvolved = (recipientAge !== null && recipientAge < 18) !== (senderAge !== null && senderAge < 18);
    // A guardian the teen accepted through a family link counts like a friend here.
    const linked = minorInvolved
      ? (
          await db.query(
            `SELECT 1 FROM family_links WHERE status = 'active' AND ((guardian_id = $1 AND teen_id = $2) OR (guardian_id = $2 AND teen_id = $1))`,
            [senderId, recipientId],
          )
        ).rowCount
      : 0;
    if (minorInvolved && !linked && !(await areFriends(db, senderId, recipientId)))
      throw new AppError(403, 'minor_protection', 'To keep younger people safe, you can only message them once you are friends.');
    // Family controls apply both ways: a supervised teen's setting limits who they can message and who can message them. Guardians can always.
    for (const [teen, other] of [
      [recipientId, senderId],
      [senderId, recipientId],
    ] as const) {
      const controls = await activeControls(db, teen);
      if (!controls || controls.guardianIds.includes(other)) continue;
      if (controls.messagesFrom === 'nobody' || !(await areFriends(db, senderId, recipientId)))
        throw new AppError(403, 'family_controls', 'Family settings on this account limit who it can message.');
    }
    // The recipient's own "Who can message you" (friends, and chats they started, always get through).
    if (!(await messagesAllowed(db, senderId, recipientId)))
      throw new AppError(403, 'messages_limited', 'This person only gets messages from people they know.');
    // Messaging people who aren't friends needs a confirmed email or phone, and isn't open to limited accounts.
    if (!(await areFriends(db, senderId, recipientId))) {
      await requireVerified(db, ctx.config, senderId, 'message');
      if (await isRestricted(db, senderId)) throw restrictedError('message');
    }
  }

  /**
   * Minor safety in groups: everyone in a group can message everyone else in it, so the rule for
   * direct messages holds between each pair. An adult and someone under 18 can be in a group
   * together only when they're friends (or linked through family). `adding` are the people joining;
   * `members` everyone who will be in the group, them included.
   */
  async function assertGroupSafe(adding: string[], members: string[]) {
    const { rows } = await db.query(
      `WITH m AS (SELECT u.id, coalesce(u.birth_date > current_date - interval '18 years', false) AS minor FROM users u WHERE u.id = ANY($2::uuid[]))
       SELECT 1 FROM m a JOIN m b ON a.minor AND NOT b.minor
       WHERE (a.id = ANY($1::uuid[]) OR b.id = ANY($1::uuid[]))
         AND NOT EXISTS (SELECT 1 FROM friendships fr WHERE fr.user_a = LEAST(a.id, b.id) AND fr.user_b = GREATEST(a.id, b.id))
         AND NOT EXISTS (SELECT 1 FROM family_links fl WHERE fl.status = 'active'
                         AND ((fl.guardian_id = a.id AND fl.teen_id = b.id) OR (fl.guardian_id = b.id AND fl.teen_id = a.id)))
       LIMIT 1`,
      [adding, [...new Set(members)]],
    );
    if (rows.length)
      throw new AppError(
        403,
        'minor_protection',
        'To keep younger people safe, adults and people under 18 can be in a group together only when they are friends.',
      );
  }

  type Attachment = Message['attachments'][number];
  /**
   * Attachments follow the media's current moderation verdict when they're read:
   * blocked media is replaced by an empty placeholder for everyone, sensitive
   * media is marked (shown blurred) for adults and replaced for everyone else.
   */
  async function withVerdicts<T extends { attachments: Attachment[] | null }>(items: T[], adult: boolean): Promise<T[]> {
    const ids = [...new Set(items.flatMap((m) => (m.attachments ?? []).map((a) => a.mediaId).filter((x): x is string => !!x)))];
    if (!ids.length) return items;
    const { rows } = await db.query<{ id: string; moderation: string }>(`SELECT id, moderation FROM media WHERE id = ANY($1::uuid[])`, [ids]);
    const verdict = new Map(rows.map((r) => [r.id, r.moderation]));
    const hide = (a: Attachment): Attachment => ({ kind: a.kind, mediaId: a.mediaId, url: '', removed: true });
    return items.map((m) => ({
      ...m,
      attachments: (m.attachments ?? []).map((a) => {
        const v = a.mediaId ? verdict.get(a.mediaId) : undefined;
        if (v === 'blocked') return hide(a);
        if (v === 'sensitive') return adult ? { ...a, sensitive: true } : hide(a);
        return a;
      }),
    }));
  }

  /** View-once messages carry their state for this reader (and, for the sender, who opened them). */
  async function withViewOnce(items: Message[], viewerId: string): Promise<Message[]> {
    const info = await viewOnceFor(
      db,
      items.map((m) => m.id),
      viewerId,
    );
    return info.size ? items.map((m) => (info.has(m.id) ? { ...m, viewOnce: info.get(m.id)! } : m)) : items;
  }

  /** Shared stories become cards for the reader: each opens only if the reader can see the story. */
  async function withStories<T extends { story_id?: string | null }>(items: T[], reader: string): Promise<(T & { story?: Message['story'] })[]> {
    const ids = items.flatMap((m) => (m.story_id ? [m.story_id] : []));
    if (!ids.length) return items;
    const cards = await storyCards(db, ids, reader);
    return items.map((m) => (m.story_id ? { ...m, story: cards.get(m.story_id) ?? { id: m.story_id, available: false } } : m));
  }

  async function loadConversations(userId: string, ids?: string[]): Promise<Conversation[]> {
    const { rows } = await db.query(
      `SELECT c.id, c.kind, c.title, c.last_message_at, c.disappearing_seconds, c.wallpaper, c.accent, cm.last_read_at, cm.yaps_out_loud, cm.role, cm.smart_replies,
         EXISTS (SELECT 1 FROM conversation_members o JOIN friendships f ON f.user_a = LEAST(o.user_id, $1::uuid) AND f.user_b = GREATEST(o.user_id, $1::uuid)
                 WHERE o.conversation_id = c.id AND o.user_id <> $1 AND o.left_at IS NULL) AS has_friend,
         (SELECT count(*) FROM messages m WHERE m.conversation_id = c.id AND m.created_at > cm.last_read_at AND m.sender_id <> $1 AND m.deleted_at IS NULL
            AND m.moderation_status = 'normal' AND m.kind <> 'system') AS unread,
         (SELECT array_agg(user_id) FROM conversation_members WHERE conversation_id = c.id AND left_at IS NULL) AS member_ids,
         lm.id AS lm_id, lm.body AS lm_body, lm.created_at AS lm_created_at, lm.sender_id AS lm_sender, lm.attachments AS lm_attachments, lm.story_id
       FROM conversation_members cm JOIN conversations c ON c.id = cm.conversation_id
       LEFT JOIN LATERAL (SELECT x.id, x.body, x.created_at, x.sender_id, x.attachments, x.story_id FROM messages x
                          WHERE x.conversation_id = c.id AND x.deleted_at IS NULL AND x.kind <> 'system'
                            AND (x.moderation_status = 'normal' OR (x.moderation_status = 'review' AND x.sender_id = $1))
                            AND (x.expires_at IS NULL OR x.expires_at > now())
                            AND NOT EXISTS (SELECT 1 FROM message_hides h WHERE h.user_id = $1 AND h.message_id = x.id)
                            AND NOT EXISTS (SELECT 1 FROM blocks b WHERE b.blocker_id = $1 AND b.blocked_id = x.sender_id)
                          ORDER BY x.created_at DESC LIMIT 1) lm ON true
       WHERE cm.user_id = $1 AND cm.left_at IS NULL ${ids ? 'AND c.id = ANY($2)' : ''}
       ORDER BY c.last_message_at DESC LIMIT 100`,
      ids ? [userId, ids] : [userId],
    );
    const users = await usersByIds(db, [...new Set(rows.flatMap((r) => r.member_ids ?? []))]);
    // One-to-one chats show the other person's "Now" status in the header, when you're in its audience.
    const otherOf = (r: { kind: string; member_ids: string[] | null }) => (r.kind === 'direct' ? (r.member_ids ?? []).find((id) => id !== userId) : undefined);
    const statuses = await nowStatusesFor(
      db,
      rows.map(otherOf).filter((id): id is string => !!id),
      userId,
    );
    const adult = await seesSensitiveMedia(db, userId);
    const paused = !!(await db.query(`SELECT yaps_paused FROM user_preferences WHERE user_id = $1`, [userId])).rows[0]?.yaps_paused;
    const smartEverywhere = !!(await db.query(`SELECT ${smartRepliesEverywhereSql('$1')} AS on`, [userId])).rows[0]?.on;
    const smartFlag = await isEnabled(db, 'AI_SMART_REPLIES');
    const withLast = await withStories(
      await withVerdicts(
        rows.map((r) => ({ ...r, attachments: r.lm_attachments as Attachment[] | null })),
        adult,
      ),
      userId,
    );
    return withLast.map((r) => ({
      id: r.id,
      kind: r.kind,
      title: r.title,
      members: (r.member_ids ?? []).map((id: string) => users.get(id)).filter(Boolean),
      lastMessage: r.lm_id
        ? {
            id: r.lm_id,
            conversationId: r.id,
            sender: users.get(r.lm_sender)!,
            body: r.lm_body,
            replyToId: null,
            attachments: r.attachments ?? [],
            ...(r.story ? { story: r.story } : {}),
            createdAt: r.lm_created_at.toISOString(),
          }
        : null,
      unreadCount: r.unread,
      updatedAt: r.last_message_at.toISOString(),
      yaps: {
        available: r.kind !== 'community' && (r.member_ids ?? []).length >= 2 && (r.member_ids ?? []).length <= YAP_MAX_MEMBERS,
        playOutLoud: r.yaps_out_loud,
        // One-to-one: on when you are friends. Groups: yaps from friends play.
        defaultOutLoud: r.kind === 'direct' ? r.has_friend : true,
        paused,
      },
      ...(r.kind === 'direct' ? { nowStatus: statuses.get(otherOf(r) ?? '') ?? null } : {}),
      disappearingSeconds: r.disappearing_seconds ?? null,
      myRole: r.role,
      smartReplies: smartRepliesState(r.kind, r.smart_replies ?? null, smartEverywhere, smartFlag),
      theme: chatTheme({ wallpaper: r.wallpaper, accent: r.accent }),
    }));
  }

  app.get('/v1/conversations', { preHandler: requireAuth }, async (req) => ({ items: await loadConversations(me(req).id) }));

  app.get('/v1/conversations/:id', { preHandler: requireAuth }, async (req) => {
    const { id } = parse(idParam, req.params);
    await assertMember(id, me(req).id);
    const [conversation] = await loadConversations(me(req).id, [id]);
    return { conversation };
  });

  /** One member → direct conversation (reused if it exists). Several → a group. */
  app.post('/v1/conversations', { preHandler: requireAuth, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const u = me(req);
    const input = parse(createConversationSchema, req.body);
    const others = [...new Set(input.memberIds.filter((id) => id !== u.id))];
    if (!others.length) throw badRequest('Add at least one other person.');
    for (const id of others) await assertCanMessage(u.id, u.birthDate, id);

    if (others.length === 1 && !input.title) {
      const key = [u.id, others[0]!].sort().join(':');
      const id = await tx(db, async (c) => {
        const existing = await c.query<{ id: string }>(`SELECT id FROM conversations WHERE direct_key = $1`, [key]);
        if (existing.rows[0]) {
          await c.query(`UPDATE conversation_members SET left_at = NULL WHERE conversation_id = $1 AND user_id = $2`, [existing.rows[0].id, u.id]);
          return existing.rows[0].id;
        }
        const { rows } = await c.query<{ id: string }>(`INSERT INTO conversations (kind, direct_key, created_by) VALUES ('direct',$1,$2) RETURNING id`, [
          key,
          u.id,
        ]);
        await c.query(`INSERT INTO conversation_members (conversation_id, user_id) VALUES ($1,$2),($1,$3)`, [rows[0]!.id, u.id, others[0]]);
        return rows[0]!.id;
      });
      reply.code(201);
      return { conversation: (await loadConversations(u.id, [id]))[0] };
    }

    await assertGroupSafe(others, [u.id, ...others]);
    const id = await tx(db, async (c) => {
      const { rows } = await c.query<{ id: string }>(`INSERT INTO conversations (kind, title, created_by) VALUES ('group',$1,$2) RETURNING id`, [
        input.title ?? null,
        u.id,
      ]);
      const cid = rows[0]!.id;
      await c.query(`INSERT INTO conversation_members (conversation_id, user_id, role) VALUES ($1,$2,'admin')`, [cid, u.id]);
      await c.query(`INSERT INTO conversation_members (conversation_id, user_id) SELECT $1, unnest($2::uuid[])`, [cid, others]);
      return cid;
    });
    await ctx.realtime.publish(others, { type: 'conversation.created', data: { id } });
    reply.code(201);
    return { conversation: (await loadConversations(u.id, [id]))[0] };
  });

  app.post('/v1/conversations/:id/members', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const { userIds } = parse(z.object({ userIds: z.array(z.string().uuid()).min(1).max(50) }), req.body);
    const conv = await db.query(
      `SELECT c.kind, cm.role FROM conversations c JOIN conversation_members cm ON cm.conversation_id = c.id WHERE c.id = $1 AND cm.user_id = $2 AND cm.left_at IS NULL`,
      [id, u.id],
    );
    if (!conv.rows[0]) throw notFound('Conversation');
    if (conv.rows[0].kind !== 'group') throw badRequest('You can only add people to group conversations.');
    for (const other of userIds) await assertCanMessage(u.id, u.birthDate, other);
    await assertGroupSafe(userIds, [...(await memberIds(id)), ...userIds]);
    await db.query(
      `INSERT INTO conversation_members (conversation_id, user_id) SELECT $1, unnest($2::uuid[]) ON CONFLICT (conversation_id, user_id) DO UPDATE SET left_at = NULL`,
      [id, userIds],
    );
    return { ok: true };
  });

  app.post('/v1/conversations/:id/leave', { preHandler: requireAuth }, async (req) => {
    const { id } = parse(idParam, req.params);
    await assertMember(id, me(req).id);
    await db.query(`UPDATE conversation_members SET left_at = now() WHERE conversation_id = $1 AND user_id = $2`, [id, me(req).id]);
    return { ok: true };
  });

  app.get('/v1/conversations/:id/messages', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const q = parse(pageQuerySchema, req.query);
    await assertMember(id, u.id);
    const c = decodeCursor<KeyCursor>(q.cursor);
    const { rows } = await db.query(
      `SELECT ${MESSAGE_COLS}
       FROM messages m JOIN profiles pr ON pr.user_id = m.sender_id
       WHERE m.conversation_id = $1 AND ${VISIBLE_TO_READER}
         ${c ? 'AND (m.created_at, m.id) < ($4::timestamptz, $5::uuid)' : ''}
       ORDER BY m.created_at DESC, m.id DESC LIMIT $3`,
      c ? [id, u.id, q.limit + 1, c.t, c.id] : [id, u.id, q.limit + 1],
    );
    const page = rows.slice(0, q.limit);
    const items = (await present(page, u.id)).reverse();
    return { items, nextCursor: rows.length > q.limit ? keyCursorOf(page.at(-1)!) : null };
  });

  /** Messages as one reader sees them: attachment verdicts, story cards, view once, the quoted reply and reactions. */
  async function present(rows: Record<string, any>[], reader: string): Promise<Message[]> {
    const items = await withViewOnce(await withVerdicts((await withStories(rows, reader)).map(toMessage), await seesSensitiveMedia(db, reader)), reader);
    return decorate(items, reader);
  }

  async function decorate(items: Message[], reader: string): Promise<Message[]> {
    // A "Remind the group" line quotes the message it's about, as this reader sees it.
    const remindedOf = (m: Message) => (m.system?.type === 'reminder' ? m.system.messageId : null);
    const previews = await messagePreviews(
      db,
      items.flatMap((m) => [m.replyToId, remindedOf(m)].filter((x): x is string => !!x)),
      reader,
    );
    const ids = items.map((m) => m.id);
    const reactions = await reactionSummaries(db, ids, reader);
    // Polls and shared lists (an unsent one has none left), and your own "Remind me".
    const live = items.filter((m) => !m.unsent && m.kind !== 'system').map((m) => m.id);
    const polls = await pollsFor(db, live, [reader]);
    const lists = await listsFor(db, live, [reader]);
    const games = await gamesFor(db, live);
    const mixes = await mixCardsForMessages(db, live, reader);
    const reminders = await myReminders(db, live, reader);
    return items.map((m) => {
      const out: Message = { ...m };
      if (m.replyToId) out.replyTo = previews.get(m.replyToId) ?? null;
      if (reactions.has(m.id)) out.reactions = reactions.get(m.id);
      const poll = polls(m.id, reader);
      if (poll) out.poll = poll;
      const list = lists(m.id, reader);
      if (list) out.list = list;
      const game = games.get(m.id);
      if (game) out.game = game;
      const mix = mixes.get(m.id);
      if (mix) out.mix = mix;
      if (reminders.has(m.id)) out.reminder = reminders.get(m.id);
      const reminded = remindedOf(m);
      if (reminded && m.system?.type === 'reminder') out.system = { ...m.system, message: previews.get(reminded) ?? null };
      // An unsent view-once message has nothing left to open.
      if (m.unsent) delete out.viewOnce;
      return out;
    });
  }

  /** One message as a member sees it, or null when they can't. */
  async function loadMessage(messageId: string, reader: string): Promise<Message | null> {
    const { rows } = await db.query(
      `SELECT ${MESSAGE_COLS} FROM messages m JOIN profiles pr ON pr.user_id = m.sender_id WHERE m.id = $1 AND ${VISIBLE_TO_READER}`,
      [messageId, reader],
    );
    return rows[0] ? (await present(rows, reader))[0]! : null;
  }

  /**
   * A message someone wants to act on. People outside the conversation get "not found"
   * (nothing is revealed); with `ownOnly`, members who didn't send it get a clear refusal.
   */
  async function messageFor(messageId: string, userId: string, o: { ownOnly?: string } = {}) {
    const m = (
      await db.query(
        `SELECT id, conversation_id, sender_id, kind, body, attachments, story_id, view_once, created_at, deleted_at, unsent_at, moderation_status, expires_at,
                (created_at > now() - make_interval(mins => $2)) AS editable,
                EXISTS (SELECT 1 FROM chat_polls p WHERE p.message_id = messages.id) OR EXISTS (SELECT 1 FROM chat_lists l WHERE l.message_id = messages.id)
                  OR EXISTS (SELECT 1 FROM chat_games g WHERE g.message_id = messages.id) OR (messages.meta ? 'mixId') AS rich
         FROM messages WHERE id = $1`,
        [messageId, MESSAGE_EDIT_MINUTES],
      )
    ).rows[0];
    if (!m || (m.expires_at && m.expires_at <= new Date())) throw notFound('Message');
    await assertMember(m.conversation_id, userId);
    if (m.sender_id !== userId && m.moderation_status !== 'normal') throw notFound('Message');
    if (o.ownOnly && m.sender_id !== userId) throw new AppError(403, 'not_sender', o.ownOnly);
    return m;
  }

  app.post('/v1/conversations/:id/messages', { preHandler: requireAuth, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req, reply) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const input = parse(sendMessageSchema, req.body);
    const out = await sendMessage(u, id, input);
    reply.code(201);
    return out;
  });

  /**
   * Send a message as `u` into conversation `id`, with every rule that applies at this moment:
   * membership, blocks and who can message whom, minor safety, pace limits, spam checks and the
   * chat's disappearing timer. Used when you press Send and when a message scheduled for later
   * goes out.
   */
  async function sendMessage(u: Sender, id: string, input: SendInput): Promise<{ message: Message; notice?: string }> {
    await assertMember(id, u.id);
    const members = await memberIds(id);
    const conv = (await db.query(`SELECT kind, disappearing_seconds FROM conversations WHERE id = $1`, [id])).rows[0];
    const yap = input.kind === 'yap';
    // A reply quotes a message from this same chat that the sender can see.
    if (input.replyToId) {
      const original = await db.query(
        `SELECT 1 FROM messages m WHERE m.id = $1 AND m.conversation_id = $3 AND m.deleted_at IS NULL AND m.kind <> 'system' AND ${VISIBLE_TO_READER}`,
        [input.replyToId, u.id, id],
      );
      if (!original.rowCount) throw new AppError(400, 'reply_unavailable', 'You can only reply to a message in this chat.');
    }
    if (yap && input.viewOnce) throw badRequest('A Yap can’t be view once.');
    if (yap) {
      if (conv.kind === 'community' || members.length > YAP_MAX_MEMBERS)
        throw new AppError(400, 'yaps_unavailable', `Yaps work in one-to-one chats and groups of up to ${YAP_MAX_MEMBERS} people.`);
      if (input.attachments.length !== 1) throw badRequest('A Yap is one voice clip.');
    }
    if (input.viewOnce && input.attachments.length !== 1) throw badRequest('Send one photo or video at a time to view once.');
    let toStranger = false;
    if (conv.kind === 'direct') {
      const other = members.find((m) => m !== u.id);
      if (other) {
        await assertCanMessage(u.id, u.birthDate, other);
        toStranger = !(await areFriends(db, u.id, other));
      }
    }
    await assertMessagePace(db, ctx.config, u.id);
    if (yap && (await recentYaps(db, u.id)) >= YAP_PER_MINUTE) throw yapRateError();
    // A shared story must be one you can see yourself.
    if (input.storyId && !(await canSeeStory(db, input.storyId, u.id))) throw notFound('Story');
    const analysis = analyzeText(input.body);
    if (analysis.risk === 'escalate') {
      await db.query(
        `INSERT INTO moderation_cases (target_type, target_id, subject_user_id, source, risk, signals) VALUES ('message', $1, $2, 'automated', 'escalate', $3) ON CONFLICT DO NOTHING`,
        [id, u.id, { signals: analysis.signals }],
      );
      throw new AppError(422, 'content_blocked', "This message wasn't sent because it may put someone at risk.");
    }
    // Attachments are the sender's own uploads; their address and kind come from storage, never from the request.
    let attachments: Message['attachments'] = [];
    if (input.attachments.length) {
      const ids = input.attachments.map((a) => a.mediaId);
      const { rows: media } = await db.query(
        `SELECT id, kind, url, variants, poster_url, duration_ms, moderation, private FROM media
         WHERE id = ANY($1::uuid[]) AND owner_id = $2 AND status <> 'failed' AND deleted_at IS NULL`,
        [ids, u.id],
      );
      if (media.length !== new Set(ids).size) throw notFound('That photo, video or voice message');
      if (media.some((m) => m.moderation === 'blocked')) throw new AppError(422, 'media_blocked', MEDIA_BLOCKED_MESSAGE);
      // A recap video: everything in it must be yours or already public.
      await assertRecapUse(db, u.id, ids, 'chat');
      if (yap) {
        const clip = media[0]!;
        if (clip.kind !== 'audio') throw new AppError(422, 'yap_not_voice', 'A Yap has to be a voice clip.');
        if (clip.duration_ms == null) throw new AppError(422, 'yap_length_unknown', 'We couldn’t tell how long this clip is. Try recording it again.');
        if (clip.duration_ms > YAP_MAX_MS + YAP_LENGTH_SLACK_MS) throw new AppError(422, 'yap_too_long', 'Yaps can be up to 60 seconds.');
      }
      if (input.viewOnce) {
        const m = media[0]!;
        if (!m.private || !['image', 'video', 'audio'].includes(m.kind))
          throw new AppError(400, 'view_once_upload', 'To send a photo, video or voice note to view once, upload it as view once first.');
      } else if (media.some((m) => m.private)) {
        throw new AppError(400, 'view_once_only', 'This photo or video was uploaded to view once. Send it as view once.');
      }
      const byId = new Map(media.map((m) => [m.id as string, m]));
      attachments = input.attachments.map((a) => {
        const m = byId.get(a.mediaId)!;
        // A view-once file has no address: each recipient asks for a short-lived link when they open it.
        if (input.viewOnce) return { mediaId: m.id, kind: m.kind, url: '', durationMs: m.duration_ms ?? null, posterUrl: null };
        return {
          mediaId: m.id,
          kind: m.kind,
          url: m.variants?.mp4 ?? m.variants?.large ?? m.url,
          name: a.name,
          durationMs: m.duration_ms ?? null,
          posterUrl: m.poster_url ?? null,
        };
      });
    }
    // Messages to people who aren't friends are checked for spam; flagged ones wait for a moderator before delivery.
    const spam = toStranger ? await assessMessage(db, ctx.config, u.id, id, input.body) : null;
    const held = !!spam?.flags.length;
    const viewOnceMediaId = input.viewOnce ? attachments[0]!.mediaId! : null;
    const row = await tx(db, async (c) => {
      if (yap) {
        // Counted again under a per-sender lock, so parallel requests can't slip past 30 a minute.
        await c.query(`SELECT pg_advisory_xact_lock(hashtext('yap:' || $1))`, [u.id]);
        if ((await recentYaps(c, u.id)) >= YAP_PER_MINUTE) throw yapRateError();
      }
      const { rows } = await c
        .query(
          `INSERT INTO messages (conversation_id, sender_id, body, reply_to_id, attachments, client_id, moderation_status, kind, view_once, view_once_media_id, story_id, expires_at, lang)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now() + make_interval(secs => $12::int), $13)
           ON CONFLICT (sender_id, client_id) WHERE client_id IS NOT NULL DO UPDATE SET client_id = EXCLUDED.client_id
           RETURNING id, conversation_id, body, lang, reply_to_id, attachments, created_at, client_id, moderation_status, kind, view_once, story_id, expires_at, (xmax = 0) AS inserted`,
          [
            id,
            u.id,
            input.body,
            input.replyToId ?? null,
            JSON.stringify(attachments),
            input.clientId ?? null,
            held ? 'review' : 'normal',
            input.kind,
            input.viewOnce,
            viewOnceMediaId,
            input.storyId ?? null,
            // Disappearing messages: deleted this long after sending (NULL when off).
            conv.disappearing_seconds ?? null,
            langOf(input.body),
          ],
        )
        .catch((e: { code?: string; constraint?: string }) => {
          if (e.code === '23505' && e.constraint === 'messages_view_once_media_key')
            throw new AppError(409, 'view_once_used', 'This photo or video was already sent.');
          throw e;
        });
      // The file is deleted 14 days after sending at the latest (sooner once everyone has viewed it).
      if (rows[0].view_once && rows[0].inserted) await enqueue(c, 'viewonce.check', { messageId: rows[0].id }, VIEW_ONCE_DAYS * 86_400 + 60);
      if (rows[0].expires_at && rows[0].inserted) await enqueue(c, 'messages.expire', { messageId: rows[0].id }, conv.disappearing_seconds + 1);
      if (!held) await c.query(`UPDATE conversations SET last_message_at = now() WHERE id = $1`, [id]);
      await c.query(`UPDATE conversation_members SET last_read_at = now() WHERE conversation_id = $1 AND user_id = $2`, [id, u.id]);
      if (held && spam) {
        await c.query(
          `INSERT INTO moderation_cases (target_type, target_id, subject_user_id, source, risk, signals) VALUES ('message', $1, $2, 'automated', 'review', $3)
           ON CONFLICT DO NOTHING`,
          [rows[0].id, u.id, { signals: spam.flags.map((f) => f.kind), spam: spam.flags }],
        );
        await flagContent(c, ctx.realtime, u.id, { type: 'message', id: rows[0].id }, spam.flags);
      }
      return rows[0];
    });
    const sender = (await usersByIds(db, [u.id])).get(u.id)!;
    const storyId = (row.story_id as string | null) ?? null;
    /** The message as one reader sees it: with the story card opening only if they can see the story. */
    const cardFor = async (reader: string): Promise<Pick<Message, 'story'>> =>
      storyId ? { story: (await storyCards(db, [storyId], reader)).get(storyId) ?? { id: storyId, available: false } } : {};
    const message: Message = {
      id: row.id,
      conversationId: id,
      sender,
      body: row.body,
      lang: row.lang ?? null,
      replyToId: row.reply_to_id,
      attachments: row.attachments,
      createdAt: row.created_at.toISOString(),
      clientId: row.client_id,
      ...(row.moderation_status === 'review' ? { moderation: 'review' as const } : {}),
      ...(row.kind === 'yap' ? { kind: 'yap' as const } : {}),
      ...(row.expires_at ? { expiresAt: row.expires_at.toISOString() } : {}),
    };
    if (row.reply_to_id) message.replyTo = (await messagePreviews(db, [row.reply_to_id], u.id)).get(row.reply_to_id) ?? null;
    if (row.view_once) {
      // Everyone gets the same starting state; the sender's copy also lists who opened it (nobody yet).
      const info = (await viewOnceFor(db, [row.id], u.id)).get(row.id);
      if (info) message.viewOnce = { state: info.state, kind: info.kind, expiresAt: info.expiresAt };
    }
    const ownCopy = async (m: Message): Promise<Message> => (row.view_once ? (await withViewOnce([m], u.id))[0]! : m);
    Object.assign(message, await cardFor(u.id));
    if (row.moderation_status === 'review') {
      // Held: only the sender sees it until a moderator lets it through.
      await ctx.realtime.publish([u.id], { type: 'message.created', data: message });
      return {
        message: await ownCopy(message),
        notice:
          'We’re holding this message for a quick check before it’s delivered. This sometimes happens with messages to people you aren’t friends with yet.',
      };
    }
    // Sensitive attachments are marked for adults and replaced for everyone else.
    const adults = new Set(
      (await db.query<{ id: string }>(`SELECT u.id FROM users u WHERE u.id = ANY($1::uuid[]) AND ${seesSensitiveSql('u.id')}`, [members])).rows.map(
        (r) => r.id,
      ),
    );
    const [forAdults] = await withVerdicts([message], true);
    const [forOthers] = await withVerdicts([message], false);
    const readers = await notBlocking(u.id, members);
    if (storyId) {
      // Each reader gets the story card as they'd see it.
      for (const m of readers)
        await ctx.realtime.publish([m], { type: 'message.created', data: { ...(adults.has(m) ? forAdults : forOthers)!, ...(await cardFor(m)) } });
    } else {
      await ctx.realtime.publish(
        readers.filter((m) => adults.has(m)),
        { type: 'message.created', data: forAdults },
      );
      await ctx.realtime.publish(
        readers.filter((m) => !adults.has(m)),
        { type: 'message.created', data: forOthers },
      );
    }
    if (yap && row.inserted) await deliverYap(u.id, id, members, (userId) => (adults.has(userId) ? forAdults! : forOthers!));
    track(db, u.id, row.kind === 'yap' ? 'yap_sent' : 'message_sent', { kind: conv.kind, ...(row.view_once ? { viewOnce: true } : {}) });
    return { message: await ownCopy(adults.has(u.id) ? forAdults! : forOthers!) };
  }

  /**
   * A yap goes out as a `yap` event to everyone in the chat who hasn't blocked the sender.
   * `autoplay` is true only for people who allow it right now (see planYap); for everyone
   * else it arrives silently. People who aren't connected get a notification.
   */
  async function deliverYap(senderId: string, conversationId: string, members: string[], copyFor: (userId: string) => Message) {
    const plan = await planYap(
      db,
      senderId,
      conversationId,
      members.filter((m) => m !== senderId),
    );
    for (const r of plan) {
      if (!r.deliver) continue;
      const data: YapEvent = { message: copyFor(r.userId), conversationId, autoplay: r.autoplay };
      await ctx.realtime.publish([r.userId], { type: 'yap', data });
      if (!ctx.realtime.isOnline(r.userId))
        await notify(db, ctx.realtime, {
          userId: r.userId,
          category: 'messages',
          type: 'yap_received',
          actorId: senderId,
          entityType: 'conversation',
          entityId: conversationId,
        });
    }
  }

  app.post('/v1/conversations/:id/read', { preHandler: requireAuth }, async (req) => {
    const { id } = parse(idParam, req.params);
    await assertMember(id, me(req).id);
    await db.query(`UPDATE conversation_members SET last_read_at = now() WHERE conversation_id = $1 AND user_id = $2`, [id, me(req).id]);
    return { ok: true };
  });

  // ── Edit, unsend, delete for me ───────────────────────────────────────
  /** Edit the text of your own message, within 15 minutes of sending it. Everyone's view updates. */
  app.patch('/v1/messages/:id', { preHandler: requireAuth, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const { body } = parse(editMessageSchema, req.body);
    const m = await messageFor(id, u.id, { ownOnly: 'Only the person who sent a message can edit it.' });
    if (m.deleted_at) throw notFound('Message');
    // A poll's question and a list's title are part of what people answered, so they stay as they are.
    if (m.kind !== 'message' || m.view_once || m.rich) throw new AppError(400, 'not_editable', 'Only text messages can be edited.');
    if (!m.editable) throw new AppError(403, 'edit_window_closed', `Messages can be edited for ${MESSAGE_EDIT_MINUTES} minutes after sending.`);
    if (!body && !(m.attachments ?? []).length && !m.story_id) throw badRequest('Write a message. To remove it, unsend it instead.');
    if (body !== m.body) {
      if (analyzeText(body).risk === 'escalate') throw new AppError(422, 'content_blocked', "This edit wasn't saved because it may put someone at risk.");
      // A delivered message to someone who isn't a friend was checked for spam when it was sent; its new text is too.
      if (m.moderation_status === 'normal') {
        const conv = (await db.query(`SELECT kind FROM conversations WHERE id = $1`, [m.conversation_id])).rows[0];
        const other = conv?.kind === 'direct' ? (await memberIds(m.conversation_id)).find((x) => x !== u.id) : undefined;
        if (other && !(await areFriends(db, u.id, other))) {
          const spam = await assessMessage(db, ctx.config, u.id, m.conversation_id, body);
          if (spam.flags.length) {
            await flagContent(db, ctx.realtime, u.id, { type: 'message', id }, spam.flags);
            throw new AppError(422, 'content_blocked', "This edit wasn't saved because it looks like spam.");
          }
        }
      }
      await tx(db, async (c) => {
        // The earlier text is kept for safety reports, and removed if the message is unsent.
        await c.query(`INSERT INTO message_edits (message_id, body) SELECT id, body FROM messages WHERE id = $1`, [id]);
        await c.query(`UPDATE messages SET body = $2, lang = $3, edited_at = now() WHERE id = $1`, [id, body, langOf(body)]);
      });
      const edited = (await db.query(`SELECT body, lang, edited_at FROM messages WHERE id = $1`, [id])).rows[0];
      // A message held for a check is still only the sender's.
      const to = m.moderation_status === 'normal' ? await notBlocking(u.id, await memberIds(m.conversation_id)) : [u.id];
      await ctx.realtime.publish(to, {
        type: 'message.edited',
        data: { id, conversationId: m.conversation_id, body: edited.body, lang: edited.lang, editedAt: edited.edited_at.toISOString() },
      });
    }
    return { message: await loadMessage(id, u.id) };
  });

  /**
   * Unsend, for everyone: the text and attachments are removed and a "Message unsent" line
   * stays in its place. The files it carried stop working (unless used somewhere else).
   */
  async function unsend(messageId: string, userId: string) {
    const m = await messageFor(messageId, userId, { ownOnly: 'Only the person who sent a message can unsend it.' });
    if (m.kind === 'system') throw new AppError(400, 'not_unsendable', 'This line can’t be unsent.');
    const pinsRemoved = await tx(db, async (c) => {
      const r = await c.query(
        `UPDATE messages SET deleted_at = now(), unsent_at = now(), body = '', attachments = '[]' WHERE id = $1 AND deleted_at IS NULL RETURNING id`,
        [messageId],
      );
      if (!r.rowCount) return null;
      await c.query(`DELETE FROM message_edits WHERE message_id = $1`, [messageId]);
      await c.query(`DELETE FROM message_reactions WHERE message_id = $1`, [messageId]);
      // A poll, list or game goes with it (votes, items and moves too), and nobody gets reminded about it.
      // A mix's card ends the sharing: the mix stays with its owner.
      await c.query(`DELETE FROM chat_polls WHERE message_id = $1`, [messageId]);
      await c.query(`DELETE FROM chat_lists WHERE message_id = $1`, [messageId]);
      await c.query(`DELETE FROM chat_games WHERE message_id = $1`, [messageId]);
      await c.query(`DELETE FROM mix_chats WHERE message_id = $1`, [messageId]);
      await c.query(`DELETE FROM chat_reminders WHERE message_id = $1 AND sent_at IS NULL`, [messageId]);
      return (await c.query(`DELETE FROM conversation_pins WHERE message_id = $1`, [messageId])).rowCount ?? 0;
    });
    if (pinsRemoved === null) return; // already unsent or deleted
    await revokeChatMedia(ctx, userId, mediaIdsOf(m.attachments));
    // A view-once file is deleted by the view-once worker.
    if (m.view_once) await enqueue(db, 'viewonce.check', { messageId });
    const members = await memberIds(m.conversation_id);
    await ctx.realtime.publish(members, { type: 'message.unsent', data: { id: messageId, conversationId: m.conversation_id } });
    if (pinsRemoved) await ctx.realtime.publish(members, { type: 'conversation.pins', data: { conversationId: m.conversation_id } });
  }

  app.post('/v1/messages/:id/unsend', { preHandler: requireAuth }, async (req) => {
    const { id } = parse(idParam, req.params);
    await unsend(id, me(req).id);
    return { message: await loadMessage(id, me(req).id) };
  });

  /** The same as POST /v1/messages/:id/unsend (kept for older apps). */
  app.delete('/v1/messages/:id', { preHandler: requireAuth }, async (req) => {
    const { id } = parse(idParam, req.params);
    await unsend(id, me(req).id);
    return { ok: true };
  });

  /** Delete for me: the message goes from your view of the chat only. */
  app.post('/v1/messages/:id/delete-for-me', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const m = await messageFor(id, u.id);
    await db.query(`INSERT INTO message_hides (message_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [id, u.id]);
    // Your reminders about it go too.
    await db.query(`DELETE FROM chat_reminders WHERE message_id = $1 AND user_id = $2 AND sent_at IS NULL`, [id, u.id]);
    // Your other devices drop it too.
    await ctx.realtime.publish([u.id], { type: 'message.hidden', data: { id, conversationId: m.conversation_id } });
    return { ok: true };
  });

  // ── Reactions ─────────────────────────────────────────────────────────
  const reactionParams = z.object({ id: z.string().uuid(), emoji: z.string().min(1).max(16) });

  app.put('/v1/messages/:id/reactions/:emoji', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id, emoji } = parse(reactionParams, req.params);
    const m = await messageFor(id, u.id);
    if (m.deleted_at || m.kind === 'system') throw notFound('Message');
    const r = await db.query(`INSERT INTO message_reactions (message_id, user_id, emoji) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [id, u.id, emoji]);
    if (r.rowCount)
      await ctx.realtime.publish(await memberIds(m.conversation_id), {
        type: 'message.reaction',
        data: { id, conversationId: m.conversation_id, emoji, userId: u.id },
      });
    return { ok: true };
  });

  app.delete('/v1/messages/:id/reactions/:emoji', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id, emoji } = parse(reactionParams, req.params);
    const m = await messageFor(id, u.id);
    const r = await db.query(`DELETE FROM message_reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3`, [id, u.id, emoji]);
    if (r.rowCount)
      await ctx.realtime.publish(await memberIds(m.conversation_id), {
        type: 'message.reaction',
        data: { id, conversationId: m.conversation_id, emoji, userId: u.id, removed: true },
      });
    return { ok: true };
  });

  // ── Pinned messages ───────────────────────────────────────────────────
  /** In a one-to-one chat anyone in it can do this; in groups, only admins. */
  async function assertCanManage(conversationId: string, userId: string, what: string) {
    const r = (
      await db.query(
        `SELECT c.kind, cm.role FROM conversations c JOIN conversation_members cm ON cm.conversation_id = c.id
         WHERE c.id = $1 AND cm.user_id = $2 AND cm.left_at IS NULL`,
        [conversationId, userId],
      )
    ).rows[0];
    if (!r) throw notFound('Conversation');
    if (r.kind !== 'direct' && r.role !== 'admin') throw new AppError(403, 'admins_only', `Only group admins can ${what}.`);
  }

  async function pinsFor(conversationId: string, reader: string): Promise<PinnedMessage[]> {
    const { rows } = await db.query(`SELECT message_id, pinned_by, pinned_at FROM conversation_pins WHERE conversation_id = $1 ORDER BY pinned_at DESC`, [
      conversationId,
    ]);
    const previews = await messagePreviews(
      db,
      rows.map((r) => r.message_id),
      reader,
    );
    const users = await usersByIds(
      db,
      rows.map((r) => r.pinned_by),
    );
    return rows
      .map((r) => ({ message: previews.get(r.message_id)!, pinnedBy: users.get(r.pinned_by) ?? null, pinnedAt: r.pinned_at.toISOString() }))
      .filter((p) => p.message?.available);
  }

  app.get('/v1/conversations/:id/pins', { preHandler: requireAuth }, async (req) => {
    const { id } = parse(idParam, req.params);
    await assertMember(id, me(req).id);
    return { items: await pinsFor(id, me(req).id), max: MAX_PINNED_MESSAGES };
  });

  app.put('/v1/messages/:id/pin', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const m = await messageFor(id, u.id);
    if (m.deleted_at || m.kind === 'system' || m.moderation_status !== 'normal') throw new AppError(400, 'not_pinnable', 'This message can’t be pinned.');
    await assertCanManage(m.conversation_id, u.id, 'pin messages');
    await tx(db, async (c) => {
      // One pin at a time per chat, so two people can't both take the last place.
      await c.query(`SELECT pg_advisory_xact_lock(hashtext('pins:' || $1))`, [m.conversation_id]);
      const pins = (await c.query<{ message_id: string }>(`SELECT message_id FROM conversation_pins WHERE conversation_id = $1`, [m.conversation_id])).rows;
      if (pins.some((p) => p.message_id === id)) return;
      if (pins.length >= MAX_PINNED_MESSAGES) throw new AppError(409, 'pins_full', `You can pin up to ${MAX_PINNED_MESSAGES} messages. Unpin one to pin this.`);
      await c.query(`INSERT INTO conversation_pins (conversation_id, message_id, pinned_by) VALUES ($1,$2,$3)`, [m.conversation_id, id, u.id]);
    });
    await ctx.realtime.publish(await memberIds(m.conversation_id), { type: 'conversation.pins', data: { conversationId: m.conversation_id } });
    return { items: await pinsFor(m.conversation_id, u.id) };
  });

  app.delete('/v1/messages/:id/pin', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const m = await messageFor(id, u.id);
    await assertCanManage(m.conversation_id, u.id, 'unpin messages');
    const r = await db.query(`DELETE FROM conversation_pins WHERE message_id = $1`, [id]);
    if (r.rowCount) await ctx.realtime.publish(await memberIds(m.conversation_id), { type: 'conversation.pins', data: { conversationId: m.conversation_id } });
    return { items: await pinsFor(m.conversation_id, u.id) };
  });

  // ── Search ────────────────────────────────────────────────────────────
  /** Text search in one chat: the messages you can see there, sent since you joined. Newest first. */
  app.get('/v1/conversations/:id/search', { preHandler: requireAuth, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const q = parse(messageSearchSchema, req.query);
    const joined = (
      await db.query<{ joined_at: Date }>(`SELECT joined_at FROM conversation_members WHERE conversation_id = $1 AND user_id = $2 AND left_at IS NULL`, [
        id,
        u.id,
      ])
    ).rows[0];
    if (!joined) throw notFound('Conversation');
    const c = decodeCursor<KeyCursor>(q.cursor);
    const pattern = `%${q.q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    const limit = 30;
    const { rows } = await db.query(
      `SELECT ${MESSAGE_COLS}
       FROM messages m JOIN profiles pr ON pr.user_id = m.sender_id
       WHERE m.conversation_id = $1 AND ${VISIBLE_TO_READER} AND m.deleted_at IS NULL AND m.kind <> 'system'
         AND m.created_at >= $4 AND m.body ILIKE $5
         ${c ? 'AND (m.created_at, m.id) < ($6::timestamptz, $7::uuid)' : ''}
       ORDER BY m.created_at DESC, m.id DESC LIMIT $3`,
      c ? [id, u.id, limit + 1, joined.joined_at, pattern, c.t, c.id] : [id, u.id, limit + 1, joined.joined_at, pattern],
    );
    const page = rows.slice(0, limit);
    return { items: await present(page, u.id), nextCursor: rows.length > limit ? keyCursorOf(page.at(-1)!) : null };
  });

  // ── Disappearing messages ─────────────────────────────────────────────
  /**
   * Turn disappearing messages on (24 hours, 7 days or 90 days) or off for a chat. Anyone
   * in a one-to-one chat can; in groups, admins. A line in the chat tells everyone who
   * changed it. It applies to messages sent from then on.
   */
  app.put('/v1/conversations/:id/disappearing', { preHandler: requireAuth, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const { seconds } = parse(disappearingSchema, req.body);
    await assertCanManage(id, u.id, 'change disappearing messages');
    const row = await tx(db, async (c) => {
      const cur = (await c.query(`SELECT disappearing_seconds FROM conversations WHERE id = $1 FOR UPDATE`, [id])).rows[0];
      if ((cur.disappearing_seconds ?? null) === seconds) return null;
      await c.query(`UPDATE conversations SET disappearing_seconds = $2 WHERE id = $1`, [id, seconds]);
      const { rows } = await c.query(`INSERT INTO messages (conversation_id, sender_id, body, kind, meta) VALUES ($1,$2,'','system',$3) RETURNING id`, [
        id,
        u.id,
        { type: 'disappearing', seconds },
      ]);
      await c.query(`UPDATE conversations SET last_message_at = now() WHERE id = $1`, [id]);
      return rows[0] as { id: string };
    });
    if (!row) return { disappearingSeconds: seconds, message: null };
    const members = await memberIds(id);
    const line = await loadMessage(row.id, u.id);
    await ctx.realtime.publish(members, { type: 'message.created', data: line });
    await ctx.realtime.publish(members, { type: 'conversation.updated', data: { id, disappearingSeconds: seconds } });
    return { disappearingSeconds: seconds, message: line };
  });

  // ── Yaps: settings ────────────────────────────────────────────────────
  /** "Pause Yaps": they still arrive and stay in the chat, but never play by themselves. */
  app.get('/v1/me/yaps', { preHandler: requireAuth }, async (req) => {
    const r = await db.query(`SELECT yaps_paused FROM user_preferences WHERE user_id = $1`, [me(req).id]);
    return { paused: !!r.rows[0]?.yaps_paused };
  });

  app.put('/v1/me/yaps', { preHandler: requireAuth }, async (req) => {
    const { paused } = parse(yapSettingsSchema, req.body);
    await db.query(
      `INSERT INTO user_preferences (user_id, yaps_paused) VALUES ($1,$2) ON CONFLICT (user_id) DO UPDATE SET yaps_paused = EXCLUDED.yaps_paused, updated_at = now()`,
      [me(req).id, paused],
    );
    return { paused };
  });

  /** "Let Yaps play out loud" in one chat; null goes back to the default (on for yaps from friends). */
  app.put('/v1/conversations/:id/yaps', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const { playOutLoud } = parse(conversationYapsSchema, req.body);
    await assertMember(id, u.id);
    await db.query(`UPDATE conversation_members SET yaps_out_loud = $3 WHERE conversation_id = $1 AND user_id = $2`, [id, u.id, playOutLoud]);
    const [conversation] = await loadConversations(u.id, [id]);
    return { yaps: conversation!.yaps };
  });

  // ── View once ─────────────────────────────────────────────────────────
  const gone = (code: string, message: string) => new AppError(410, code, message);

  /** A view-once message this person can see, with their own opening record. */
  async function viewOnceMessage(messageId: string, userId: string) {
    const r = (
      await db.query(
        `SELECT m.id, m.conversation_id, m.sender_id, m.view_once, m.deleted_at, m.moderation_status, m.view_once_ended_at,
                md.kind, md.mime, md.storage_key, md.moderation, md.deleted_at AS media_deleted_at,
                v.opened_at, v.viewed_at, (v.opened_at < now() - interval '${OPEN_WINDOW_MINUTES} minutes') AS stale
         FROM messages m LEFT JOIN media md ON md.id = m.view_once_media_id
         LEFT JOIN message_views v ON v.message_id = m.id AND v.user_id = $2
         WHERE m.id = $1`,
        [messageId, userId],
      )
    ).rows[0];
    if (!r || !r.view_once || r.deleted_at || r.moderation_status !== 'normal') throw notFound('That message');
    await assertMember(r.conversation_id, userId);
    // People who blocked the sender don't see their messages at all.
    if ((await db.query(`SELECT 1 FROM blocks WHERE blocker_id = $1 AND blocked_id = $2`, [userId, r.sender_id])).rowCount) throw notFound('That message');
    return r;
  }

  async function assertCanOpen(r: Awaited<ReturnType<typeof viewOnceMessage>>, userId: string) {
    if (r.viewed_at || r.stale) throw gone('view_once_viewed', 'You already opened this. View-once photos and videos can only be opened once.');
    if (r.view_once_ended_at || !r.storage_key || r.media_deleted_at) throw gone('view_once_expired', 'This photo or video is no longer available.');
    if (r.moderation === 'blocked' || (r.moderation === 'sensitive' && !(await seesSensitiveMedia(db, userId))))
      throw gone('view_once_removed', 'This photo or video isn’t available.');
  }

  /**
   * Open a view-once photo or video: returns a link that works for a few minutes, only for
   * you. Opening again before closing it (a dropped connection) gives a fresh link; after
   * closing it, or 10 minutes after opening, it can't be opened again.
   */
  app.post('/v1/messages/:id/view-once/open', { preHandler: requireAuth, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const r = await viewOnceMessage(id, u.id);
    if (r.sender_id === u.id) throw new AppError(403, 'view_once_sender', 'You sent this, so there’s nothing to open. You can see who opened it.');
    await assertCanOpen(r, u.id);
    const first = await db.query(`INSERT INTO message_views (message_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING opened_at`, [id, u.id]);
    if (first.rowCount) await publishViewOnce(db, ctx.realtime, id, [r.sender_id]);
    const { token, expiresAt } = issueViewToken(ctx.config, id, u.id);
    return { url: `/v1/view-once/${token}`, expiresAt: expiresAt.toISOString(), kind: r.kind, mime: r.mime };
  });

  /** Closed: from now on the file is never returned to you. When everyone has viewed it, the job worker deletes it. */
  app.post('/v1/messages/:id/view-once/viewed', { preHandler: requireAuth }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const r = await viewOnceMessage(id, u.id);
    if (r.sender_id === u.id) throw badRequest('You sent this message.');
    await db.query(
      `INSERT INTO message_views (message_id, user_id, viewed_at) VALUES ($1,$2,now())
       ON CONFLICT (message_id, user_id) DO UPDATE SET viewed_at = coalesce(message_views.viewed_at, now())`,
      [id, u.id],
    );
    await enqueue(db, 'viewonce.check', { messageId: id });
    await publishViewOnce(db, ctx.realtime, id, [r.sender_id, u.id]);
    return { viewOnce: (await viewOnceFor(db, [id], u.id)).get(id) };
  });

  /** The phone saw a screenshot while it was open: the sender is told, in plain words. */
  app.post('/v1/messages/:id/view-once/screenshot', { preHandler: requireAuth, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const r = await viewOnceMessage(id, u.id);
    if (!r.opened_at) throw badRequest('Open it first.');
    const first = await db.query(
      `UPDATE message_views SET screenshot_at = now() WHERE message_id = $1 AND user_id = $2 AND screenshot_at IS NULL RETURNING 1`,
      [id, u.id],
    );
    if (first.rowCount) {
      await notify(db, ctx.realtime, {
        userId: r.sender_id,
        category: 'messages',
        type: 'view_once_screenshot',
        actorId: u.id,
        entityType: 'conversation',
        entityId: r.conversation_id,
        data: { messageId: id, kind: r.kind },
      });
      await publishViewOnce(db, ctx.realtime, id, [r.sender_id]);
    }
    return { ok: true };
  });

  /** The file itself, for the person the link was made for, while it is open. Never cached. */
  app.get('/v1/view-once/:token', { preHandler: requireAuth, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
    const u = me(req);
    const { token } = parse(z.object({ token: z.string().regex(/^[\w-]{60,80}$/) }), req.params);
    const t = readViewToken(ctx.config, token);
    if (!t || t.userId !== u.id) throw new AppError(403, 'view_once_denied', 'This link has expired or isn’t yours. Open it again from the chat.');
    const r = await viewOnceMessage(t.messageId, u.id);
    if (!r.opened_at) throw new AppError(403, 'view_once_denied', 'Open it from the chat first.');
    await assertCanOpen(r, u.id);
    const obj = await openPrivate(ctx, r.storage_key);
    if (!obj) throw gone('view_once_expired', 'This photo or video is no longer available.');
    reply
      .header('content-type', r.mime ?? 'application/octet-stream')
      .header('cache-control', 'private, no-store, max-age=0')
      .header('x-content-type-options', 'nosniff')
      .header('content-disposition', 'inline');
    if (obj.contentLength) reply.header('content-length', obj.contentLength);
    return reply.send(obj.body);
  });

  // Plans: turn a conversation into a structured activity. The AI suggests; people confirm.
  app.post('/v1/conversations/:id/plans', { preHandler: requireAuth }, async (req, reply) => {
    const u = me(req);
    const { id } = parse(idParam, req.params);
    const input = parse(z.object({ title: z.string().trim().min(1).max(120), details: z.record(z.string(), z.unknown()).default({}) }), req.body);
    await assertMember(id, u.id);
    const { rows } = await db.query(
      `INSERT INTO plans (conversation_id, created_by, title, details) VALUES ($1,$2,$3,$4) RETURNING id, title, details, status, created_at`,
      [id, u.id, input.title, input.details],
    );
    await ctx.realtime.publish(await memberIds(id), { type: 'plan.created', data: rows[0] });
    reply.code(201);
    return { plan: rows[0] };
  });

  app.get('/v1/conversations/:id/plans', { preHandler: requireAuth }, async (req) => {
    const { id } = parse(idParam, req.params);
    await assertMember(id, me(req).id);
    const { rows } = await db.query(`SELECT id, title, details, status, created_at FROM plans WHERE conversation_id = $1 ORDER BY created_at DESC`, [id]);
    return { items: rows };
  });

  // Polls, shared lists and reminders (modules/chat-polls-lists.ts), and watch together (modules/watch.ts).
  const chatHelpers = {
    assertMember,
    memberIds,
    notBlocking,
    assertCanMessage,
    assertGroupSafe,
    messageFor: (messageId: string, userId: string) => messageFor(messageId, userId),
    loadMessage,
  };
  registerChatPollsLists(app, ctx, chatHelpers);
  registerWatch(app, ctx, chatHelpers);

  // Games in chats (modules/chat-games.ts).
  registerChatGames(app, ctx, {
    assertMember,
    memberIds,
    notBlocking,
    assertCanMessage,
    assertGroupSafe,
    messageFor: (messageId, userId) => messageFor(messageId, userId),
    loadMessage,
  });

  // Mixes shared into chats (modules/mixes.ts).
  registerMixChats(app, ctx, {
    assertMember,
    memberIds,
    notBlocking,
    assertCanMessage,
    assertGroupSafe,
    messageFor: (messageId, userId) => messageFor(messageId, userId),
    loadMessage,
  });

  // Send later, and chat wallpapers and colours (modules/chat-later.ts).
  registerChatLater(app, ctx, { assertMember, memberIds, loadMessage, sendMessage });

  // ── Realtime socket ───────────────────────────────────────────────────
  /** A 60-second ticket for opening the realtime socket from another origin (see lib/realtime-ticket.ts). */
  app.post('/v1/realtime/ticket', { preHandler: requireAuth, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
    const u = me(req);
    if (u.apiKey) throw forbidden();
    return { ticket: issueTicket(ctx.config, u.sessionId) };
  });

  app.get('/v1/realtime', { websocket: true }, async (socket, req) => {
    const query = req.query as { token?: string; ticket?: string };
    let user: { id: string } | null = await resolveSession(ctx, sessionTokenOf(req) ?? query.token);
    if (!user && query.ticket) {
      const sessionId = readTicket(ctx.config, query.ticket);
      const row = sessionId
        ? (
            await db.query(
              `SELECT u.id FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND u.status = 'active'`,
              [sessionId],
            )
          ).rows[0]
        : null;
      user = row ? { id: row.id } : null;
    }
    if (!user) {
      socket.close(4401, 'unauthorized');
      return;
    }
    const remove = ctx.realtime.add(user.id, socket);
    socket.send(JSON.stringify({ type: 'ready', data: { userId: user.id } }));
    socket.on('message', async (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString()) as { type: string; conversationId?: string };
        if (msg.type === 'ping') socket.send(JSON.stringify({ type: 'pong' }));
        if (msg.type === 'typing' && msg.conversationId) {
          const ids = await memberIds(msg.conversationId);
          if (ids.includes(user.id))
            await ctx.realtime.publish(
              ids.filter((i) => i !== user.id),
              { type: 'typing', data: { conversationId: msg.conversationId, userId: user.id } },
            );
        }
      } catch {
        /* ignore malformed frames */
      }
    });
    socket.on('close', remove);
  });
}

const yapRateError = () => new AppError(429, 'yap_rate_limited', `You can send up to ${YAP_PER_MINUTE} Yaps a minute. Wait a moment, then try again.`);

function toMessage(r: Record<string, any>): Message {
  return {
    id: r.id,
    conversationId: r.conversation_id,
    sender: publicUserFrom(r, 's_'),
    body: r.body,
    lang: r.lang ?? langOf(r.body),
    replyToId: r.reply_to_id,
    attachments: r.attachments,
    createdAt: r.created_at.toISOString(),
    clientId: r.client_id,
    ...(r.moderation_status === 'review' ? { moderation: 'review' as const } : {}),
    ...(r.kind === 'yap' || r.kind === 'system' ? { kind: r.kind as 'yap' | 'system' } : {}),
    ...(r.kind === 'system' && r.meta ? { system: r.meta } : {}),
    ...(r.story ? { story: r.story } : {}),
    ...(r.edited_at ? { editedAt: r.edited_at.toISOString() } : {}),
    ...(r.unsent_at ? { unsent: true } : {}),
    ...(r.expires_at ? { expiresAt: r.expires_at.toISOString() } : {}),
    ...(r.pinned ? { pinned: true } : {}),
  };
}
