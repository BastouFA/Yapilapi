import type { Pool, PoolClient } from 'pg';
import { CHAT_LIST_MAX_ITEMS, type ChatList, type ChatPoll, type Message, type PublicUser } from '@yapilapi/shared';
import { messagePreviews } from './chat.ts';
import { enqueue } from './jobs.ts';
import type { RealtimeHub } from './realtime.ts';
import { notify } from './services.ts';
import { usersByIds } from './users.ts';

type Q = Pool | PoolClient;

/**
 * Polls, shared lists and reminders in chats. A poll or a list is a message with a row
 * in chat_polls or chat_lists (see migration 0036); these helpers build what each member
 * sees and send the live updates. Used by modules/chat-polls-lists.ts and the job worker.
 */
export interface ChatPollDeps {
  db: Pool;
  realtime: RealtimeHub;
}

/** For each reader, the people among `people` they blocked. */
async function blockedBy(db: Q, readers: string[], people: string[]): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  if (!readers.length || !people.length) return out;
  const { rows } = await db.query<{ blocker_id: string; blocked_id: string }>(
    `SELECT blocker_id, blocked_id FROM blocks WHERE blocker_id = ANY($1::uuid[]) AND blocked_id = ANY($2::uuid[])`,
    [[...new Set(readers)], [...new Set(people)]],
  );
  for (const r of rows) {
    const set = out.get(r.blocker_id) ?? new Set<string>();
    set.add(r.blocked_id);
    out.set(r.blocker_id, set);
  }
  return out;
}

/** The people in a chat who see a message from `senderId`: members who haven't blocked them. */
export async function readersOf(db: Q, conversationId: string, senderId: string): Promise<string[]> {
  const { rows } = await db.query<{ user_id: string }>(
    `SELECT cm.user_id FROM conversation_members cm
     WHERE cm.conversation_id = $1 AND cm.left_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM blocks b WHERE b.blocker_id = cm.user_id AND b.blocked_id = $2)`,
    [conversationId, senderId],
  );
  return rows.map((r) => r.user_id);
}

// ─── Polls ──────────────────────────────────────────────────────────────

export type PollView = (messageId: string, reader: string) => ChatPoll | undefined;

/**
 * The polls on these messages, as each of `readers` sees them: their own choices marked,
 * and (unless the poll is anonymous) who voted for what. Votes from people a reader
 * blocked are left out for them, like their reactions.
 */
export async function pollsFor(db: Q, ids: string[], readers: string[]): Promise<PollView> {
  const unique = [...new Set(ids)];
  if (!unique.length) return () => undefined;
  const { rows: polls } = await db.query(
    `SELECT message_id, created_by, question, multiple, anonymous, allow_add_options, ends_at, ended_at,
            (ends_at IS NOT NULL AND ends_at <= now()) AS due
     FROM chat_polls WHERE message_id = ANY($1::uuid[])`,
    [unique],
  );
  if (!polls.length) return () => undefined;
  const pollIds = polls.map((p) => p.message_id as string);
  const { rows: options } = await db.query<{ id: string; message_id: string; text: string; added_by: string }>(
    `SELECT id, message_id, text, added_by FROM chat_poll_options WHERE message_id = ANY($1::uuid[]) ORDER BY position, created_at`,
    [pollIds],
  );
  const { rows: votes } = await db.query<{ option_id: string; message_id: string; user_id: string }>(
    `SELECT option_id, message_id, user_id FROM chat_poll_votes WHERE message_id = ANY($1::uuid[]) ORDER BY voted_at`,
    [pollIds],
  );
  const voterIds = [...new Set(votes.map((v) => v.user_id))];
  const named = polls.some((p) => !p.anonymous);
  const users = named ? await usersByIds(db, voterIds) : new Map<string, PublicUser>();
  const blocks = await blockedBy(db, readers, voterIds);
  const byId = new Map(polls.map((p) => [p.message_id as string, p]));
  return (id, reader) => {
    const p = byId.get(id);
    if (!p) return undefined;
    const hidden = blocks.get(reader);
    const counted = votes.filter((v) => v.message_id === id && (v.user_id === reader || !hidden?.has(v.user_id)));
    const endedAt: Date | null = p.ended_at ?? (p.due ? p.ends_at : null);
    return {
      question: p.question,
      options: options
        .filter((o) => o.message_id === id)
        .map((o) => {
          const picked = counted.filter((v) => v.option_id === o.id);
          return {
            id: o.id,
            text: o.text,
            votes: picked.length,
            mine: picked.some((v) => v.user_id === reader),
            addedBy: o.added_by,
            ...(p.anonymous ? {} : { voters: picked.map((v) => users.get(v.user_id)).filter((x): x is PublicUser => !!x) }),
          };
        }),
      multiple: p.multiple,
      anonymous: p.anonymous,
      allowAddOptions: p.allow_add_options,
      endsAt: p.ends_at ? p.ends_at.toISOString() : null,
      ended: !!endedAt,
      endedAt: endedAt ? endedAt.toISOString() : null,
      createdBy: p.created_by,
      voterCount: new Set(counted.map((v) => v.user_id)).size,
    };
  };
}

// ─── Lists ──────────────────────────────────────────────────────────────

export type ListView = (messageId: string, reader: string) => ChatList | undefined;

/**
 * The shared lists on these messages, as each of `readers` sees them. Items added by
 * someone a reader blocked are left out for them, and a tick by someone they blocked
 * shows without the name.
 */
export async function listsFor(db: Q, ids: string[], readers: string[]): Promise<ListView> {
  const unique = [...new Set(ids)];
  if (!unique.length) return () => undefined;
  const { rows: lists } = await db.query<{ message_id: string; created_by: string; title: string }>(
    `SELECT message_id, created_by, title FROM chat_lists WHERE message_id = ANY($1::uuid[])`,
    [unique],
  );
  if (!lists.length) return () => undefined;
  const { rows: items } = await db.query<{
    id: string;
    message_id: string;
    text: string;
    added_by: string;
    done_by: string | null;
    done_at: Date | null;
  }>(`SELECT id, message_id, text, added_by, done_by, done_at FROM chat_list_items WHERE message_id = ANY($1::uuid[]) ORDER BY position, created_at`, [
    lists.map((l) => l.message_id),
  ]);
  const people = [...new Set(items.flatMap((i) => (i.done_by ? [i.added_by, i.done_by] : [i.added_by])))];
  const users = await usersByIds(db, people);
  const blocks = await blockedBy(db, readers, people);
  const byId = new Map(lists.map((l) => [l.message_id, l]));
  return (id, reader) => {
    const l = byId.get(id);
    if (!l) return undefined;
    const hidden = blocks.get(reader);
    return {
      title: l.title,
      createdBy: l.created_by,
      max: CHAT_LIST_MAX_ITEMS,
      items: items
        .filter((i) => i.message_id === id && !hidden?.has(i.added_by))
        .map((i) => ({
          id: i.id,
          text: i.text,
          addedBy: users.get(i.added_by) ?? null,
          done: !!i.done_at,
          doneBy: i.done_by && !hidden?.has(i.done_by) ? (users.get(i.done_by) ?? null) : null,
          doneAt: i.done_at ? i.done_at.toISOString() : null,
        })),
    };
  };
}

// ─── Live updates ───────────────────────────────────────────────────────

/** The chat and sender of a poll or list message that is still there, or null. */
async function liveMessage(db: Q, messageId: string) {
  const { rows } = await db.query<{ conversation_id: string; sender_id: string }>(
    `SELECT conversation_id, sender_id FROM messages WHERE id = $1 AND deleted_at IS NULL AND (expires_at IS NULL OR expires_at > now())`,
    [messageId],
  );
  return rows[0] ?? null;
}

/** `poll.updated` to each member who sees the poll, with their own view of it. Nothing is pushed to phones. */
export async function publishPoll(deps: ChatPollDeps, messageId: string): Promise<void> {
  const m = await liveMessage(deps.db, messageId);
  if (!m) return;
  const readers = await readersOf(deps.db, m.conversation_id, m.sender_id);
  const view = await pollsFor(deps.db, [messageId], readers);
  for (const reader of readers) {
    const poll = view(messageId, reader);
    if (poll) await deps.realtime.publish([reader], { type: 'poll.updated', data: { id: messageId, conversationId: m.conversation_id, poll } });
  }
}

/** `list.updated` to each member who sees the list, with their own view of it. Nothing is pushed to phones. */
export async function publishList(deps: ChatPollDeps, messageId: string): Promise<void> {
  const m = await liveMessage(deps.db, messageId);
  if (!m) return;
  const readers = await readersOf(deps.db, m.conversation_id, m.sender_id);
  const view = await listsFor(deps.db, [messageId], readers);
  for (const reader of readers) {
    const list = view(messageId, reader);
    if (list) await deps.realtime.publish([reader], { type: 'list.updated', data: { id: messageId, conversationId: m.conversation_id, list } });
  }
}

// ─── Reminders ──────────────────────────────────────────────────────────

/** Your earliest waiting "Remind me" on each of these messages. */
export async function myReminders(db: Q, ids: string[], userId: string): Promise<Map<string, { id: string; remindAt: string }>> {
  const out = new Map<string, { id: string; remindAt: string }>();
  if (!ids.length) return out;
  const { rows } = await db.query<{ id: string; message_id: string; remind_at: Date }>(
    `SELECT DISTINCT ON (message_id) id, message_id, remind_at FROM chat_reminders
     WHERE user_id = $1 AND scope = 'me' AND sent_at IS NULL AND message_id = ANY($2::uuid[])
     ORDER BY message_id, remind_at`,
    [userId, ids],
  );
  for (const r of rows) out.set(r.message_id, { id: r.id, remindAt: r.remind_at.toISOString() });
  return out;
}

/** Tell your devices what your next "Remind me" on a message is now (null when there is none). */
export async function publishMyReminder(deps: ChatPollDeps, userId: string, messageId: string, conversationId: string): Promise<void> {
  const next = (await myReminders(deps.db, [messageId], userId)).get(messageId) ?? null;
  await deps.realtime.publish([userId], { type: 'message.reminder', data: { id: messageId, conversationId, reminder: next } });
}

/**
 * Deliver one reminder at its time. "Remind me" becomes a notification (and a push, as the
 * person's settings allow); "Remind the group" becomes a line in the chat from the admin who
 * set it. Nothing happens when the message is gone (unsent, disappeared), the person left
 * the chat, blocked the sender, or (for the group) is no longer an admin.
 */
export async function deliverReminder(deps: ChatPollDeps, reminderId: string): Promise<boolean> {
  const { db, realtime } = deps;
  const r = (
    await db.query<{ id: string; message_id: string; conversation_id: string; user_id: string; scope: 'me' | 'group' }>(
      `UPDATE chat_reminders SET sent_at = now() WHERE id = $1 AND sent_at IS NULL AND remind_at <= now()
       RETURNING id, message_id, conversation_id, user_id, scope`,
      [reminderId],
    )
  ).rows[0];
  if (!r) return false;
  const m = (
    await db.query(
      `SELECT m.sender_id, m.deleted_at, m.moderation_status, m.kind, (m.expires_at IS NOT NULL AND m.expires_at <= now()) AS expired,
              c.disappearing_seconds, cm.role,
              EXISTS (SELECT 1 FROM blocks b WHERE b.blocker_id = $2 AND b.blocked_id = m.sender_id) AS blocked
       FROM messages m JOIN conversations c ON c.id = m.conversation_id
       LEFT JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = $2 AND cm.left_at IS NULL
       WHERE m.id = $1`,
      [r.message_id, r.user_id],
    )
  ).rows[0];
  if (!m || m.deleted_at || m.expired || !m.role || m.blocked || m.kind === 'system') return false;
  if (m.moderation_status !== 'normal' && m.sender_id !== r.user_id) return false;

  if (r.scope === 'me') {
    await notify(db, realtime, {
      userId: r.user_id,
      category: 'messages',
      type: 'chat_reminder',
      entityType: 'conversation',
      entityId: r.conversation_id,
      data: { messageId: r.message_id },
    });
    await publishMyReminder(deps, r.user_id, r.message_id, r.conversation_id);
    return true;
  }

  if (m.role !== 'admin') return false;
  // The line follows the chat's disappearing setting, like any new message.
  const seconds: number | null = m.disappearing_seconds ?? null;
  const { rows } = await db.query<{ id: string; created_at: Date; expires_at: Date | null }>(
    `INSERT INTO messages (conversation_id, sender_id, body, kind, meta, expires_at)
     VALUES ($1,$2,'','system',$3, now() + make_interval(secs => $4::int)) RETURNING id, created_at, expires_at`,
    [r.conversation_id, r.user_id, { type: 'reminder', messageId: r.message_id }, seconds],
  );
  const line = rows[0]!;
  if (seconds) await enqueue(db, 'messages.expire', { messageId: line.id }, seconds + 1);
  await db.query(`UPDATE conversations SET last_message_at = now() WHERE id = $1`, [r.conversation_id]);
  const sender = (await usersByIds(db, [r.user_id])).get(r.user_id);
  if (!sender) return true;
  for (const reader of await readersOf(db, r.conversation_id, r.user_id)) {
    const preview = (await messagePreviews(db, [r.message_id], reader)).get(r.message_id) ?? null;
    const message: Message = {
      id: line.id,
      conversationId: r.conversation_id,
      sender,
      body: '',
      replyToId: null,
      attachments: [],
      createdAt: line.created_at.toISOString(),
      kind: 'system',
      system: { type: 'reminder', messageId: r.message_id, message: preview },
      ...(line.expires_at ? { expiresAt: line.expires_at.toISOString() } : {}),
    };
    await realtime.publish([reader], { type: 'message.created', data: message });
  }
  return true;
}

export function chatPollJobHandlers(deps: ChatPollDeps) {
  return {
    /** Queued for a poll's end time: marks it ended and tells everyone in the chat. */
    'chat.poll.end': async (payload: { messageId: string }) => {
      const r = await deps.db.query(`UPDATE chat_polls SET ended_at = ends_at WHERE message_id = $1 AND ended_at IS NULL AND ends_at <= now()`, [
        payload.messageId,
      ]);
      if (r.rowCount) await publishPoll(deps, payload.messageId);
    },
    /** Queued for each reminder's time. */
    'chat.reminder': async (payload: { reminderId: string }) => {
      await deliverReminder(deps, payload.reminderId);
    },
  };
}
