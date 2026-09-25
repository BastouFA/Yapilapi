import { randomUUID } from 'node:crypto';
import {
  clampLimit,
  decodeCursor,
  encodeCursor,
  forbidden,
  invalid,
  notFound,
  type Page,
} from '@yapilapi/shared';
import { withTransaction, type Tx } from '@yapilapi/database';
import type { AppContext } from '../../lib/context.js';
import { notify } from '../../lib/notify.js';
import { screenText } from '../../lib/moderation-hook.js';
import { assertCanContactPeer, requireAccess, requireSend, type ConvAccess } from './access.js';
import { publishConv } from './events.js';
import {
  hydrateMessages,
  isTombstone,
  MSG_COLS,
  type MessageRow,
  type MessageView,
} from './views.js';

export const MAX_BODY = 8000;
export const MAX_ATTACHMENTS = 10;

export interface SendMessageInput {
  conversationId: string;
  senderId: string;
  kind?: 'text' | 'media' | 'file' | 'voice';
  body?: string;
  replyToId?: string | undefined;
  attachmentIds?: string[] | undefined;
  /** Client-generated id; resending the same id returns the ORIGINAL message and never creates a duplicate. */
  clientMessageId?: string | undefined;
  poll?: { question: string; options: string[]; multiple?: boolean } | undefined;
  /** Server-side only (other modules, e.g. AI drafts a human confirmed). Never accepted from HTTP clients. */
  metadata?: Record<string, unknown> | undefined;
}

export interface InsertMessage {
  conversationId: string;
  senderId: string | null;
  kind: string;
  body: string;
  replyToId?: string | null | undefined;
  metadata?: Record<string, unknown> | undefined;
  clientMessageId?: string | null | undefined;
  attachmentIds?: string[] | undefined;
}

const MEDIA_KINDS: Record<string, readonly string[]> = {
  media: ['image', 'video'],
  file: ['file', 'image', 'video', 'audio'],
  voice: ['audio'],
};

/** Low-level insert used by every message producer (send, poll, plan, call). Runs inside the caller's transaction. */
export async function insertMessageTx(
  ctx: AppContext,
  tx: Tx,
  m: InsertMessage,
): Promise<{ row: MessageRow; created: boolean }> {
  const ins = await tx.query<MessageRow>(
    `INSERT INTO messages AS m (conversation_id, sender_id, kind, body, reply_to_id, metadata, client_message_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (conversation_id, sender_id, client_message_id) WHERE client_message_id IS NOT NULL DO NOTHING
     RETURNING ${MSG_COLS}`,
    [
      m.conversationId,
      m.senderId,
      m.kind,
      m.body,
      m.replyToId ?? null,
      JSON.stringify(m.metadata ?? {}),
      m.clientMessageId ?? null,
    ],
  );
  if (!ins.rows[0]) {
    const existing = await tx.query<MessageRow>(
      `SELECT ${MSG_COLS} FROM messages m WHERE m.conversation_id = $1 AND m.sender_id = $2 AND m.client_message_id = $3`,
      [m.conversationId, m.senderId, m.clientMessageId],
    );
    return { row: existing.rows[0]!, created: false };
  }
  const row = ins.rows[0];
  for (const [i, mediaId] of (m.attachmentIds ?? []).entries()) {
    await tx.query(
      'INSERT INTO message_attachments (message_id, media_id, position) VALUES ($1,$2,$3)',
      [row.id, mediaId, i],
    );
  }
  // Timestamps are taken from the row itself in SQL: JS Dates would truncate microseconds and skew read/unread comparisons.
  await tx.query(
    `UPDATE conversations SET last_message_at = GREATEST(COALESCE(last_message_at, '-infinity'), (SELECT created_at FROM messages WHERE id = $2)) WHERE id = $1`,
    [m.conversationId, row.id],
  );
  if (m.senderId) {
    // Sending implies having read everything up to now.
    await tx.query(
      `UPDATE conversation_members SET last_read_at = GREATEST(COALESCE(last_read_at, '-infinity'), (SELECT created_at FROM messages WHERE id = $3)) WHERE conversation_id = $1 AND user_id = $2`,
      [m.conversationId, m.senderId, row.id],
    );
  }
  if (
    m.senderId &&
    m.body.trim() &&
    ['text', 'media', 'file', 'voice', 'poll', 'plan'].includes(m.kind)
  ) {
    const res = await screenText(ctx, tx, {
      type: 'message',
      id: row.id,
      authorId: m.senderId,
      text: m.body,
    });
    row.moderation_status = res.status;
  }
  return { row, created: true };
}

/** After commit: push to conversation subscribers and notify offline-capable members (never with the message text). */
export async function announceMessage(
  ctx: AppContext,
  row: MessageRow,
  access: ConvAccess | null,
): Promise<void> {
  if (row.moderation_status !== 'approved') return; // restricted / queued content is not pushed to other people
  const [view] = await hydrateMessages(ctx, [row], null);
  publishConv(ctx, row.conversation_id, { type: 'message.new', message: view });
  if (access?.conv.kind === 'community_channel' || !row.sender_id) return;
  try {
    const { rows } = await ctx.db.query<{ user_id: string; muted: boolean; restricted: boolean }>(
      `SELECT cm.user_id,
              (cm.muted_until IS NOT NULL AND cm.muted_until > now()) AS muted,
              EXISTS (SELECT 1 FROM user_restrictions r WHERE r.restrictor_id = cm.user_id AND r.restricted_id = $2) AS restricted
         FROM conversation_members cm
        WHERE cm.conversation_id = $1 AND cm.left_at IS NULL AND cm.user_id <> $2`,
      [row.conversation_id, row.sender_id],
    );
    for (const r of rows) {
      // Restricted senders may still message, but the restrictor is not pinged; muted conversations stay quiet.
      if (r.muted || r.restricted) continue;
      await notify(ctx, {
        userId: r.user_id,
        kind: 'message',
        actorId: row.sender_id,
        targetType: 'conversation',
        targetId: row.conversation_id,
        data: { messageId: row.id, conversationId: row.conversation_id },
      });
    }
  } catch (err) {
    ctx.log.warn({ err }, 'message notification failed');
  }
}

/** Re-publish a message after a change (edit, reaction, vote, RSVP). No-op for content that is not public yet. */
export async function announceMessageUpdated(ctx: AppContext, messageId: string): Promise<void> {
  const { rows } = await ctx.db.query<MessageRow>(
    `SELECT ${MSG_COLS} FROM messages m WHERE m.id = $1`,
    [messageId],
  );
  const row = rows[0];
  if (!row) return;
  if (isTombstone(row)) {
    publishConv(ctx, row.conversation_id, { type: 'message.deleted', messageId: row.id });
    return;
  }
  if (row.moderation_status !== 'approved') return;
  const [view] = await hydrateMessages(ctx, [row], null);
  publishConv(ctx, row.conversation_id, { type: 'message.updated', message: view });
}

export async function sendMessageDetailed(
  ctx: AppContext,
  input: SendMessageInput,
): Promise<{ message: MessageView; created: boolean }> {
  const access = await requireAccess(ctx.db, input.conversationId, input.senderId);
  requireSend(access);
  await assertCanContactPeer(ctx.db, access, input.senderId);

  // Idempotency first: a retry returns the original even if its attachments are already consumed.
  if (input.clientMessageId) {
    const { rows } = await ctx.db.query<MessageRow>(
      `SELECT ${MSG_COLS} FROM messages m WHERE m.conversation_id = $1 AND m.sender_id = $2 AND m.client_message_id = $3`,
      [input.conversationId, input.senderId, input.clientMessageId],
    );
    if (rows[0])
      return { message: (await hydrateMessages(ctx, rows, input.senderId))[0]!, created: false };
  }

  const body = (input.body ?? '').trim();
  if (body.length > MAX_BODY) throw invalid('Message is too long');
  const attachmentIds = [...new Set(input.attachmentIds ?? [])];
  if (attachmentIds.length > MAX_ATTACHMENTS)
    throw invalid(`At most ${MAX_ATTACHMENTS} attachments per message`);

  let kind: string = input.kind ?? (attachmentIds.length ? 'media' : 'text');
  const metadata: Record<string, unknown> = { ...(input.metadata ?? {}) };
  if (input.poll) {
    if (attachmentIds.length || (input.kind && input.kind !== 'text'))
      throw invalid('A poll cannot carry attachments');
    kind = 'poll';
    const labels = input.poll.options.map((o) => o.trim());
    if (labels.length < 2 || labels.length > 10 || labels.some((l) => !l || l.length > 200))
      throw invalid('A poll needs 2 to 10 options');
    if (new Set(labels.map((l) => l.toLowerCase())).size !== labels.length)
      throw invalid('Poll options must be unique');
  } else if (kind === 'text') {
    if (attachmentIds.length) throw invalid('Use kind media, file or voice for attachments');
    if (!body) throw invalid('Message text is required');
  } else if (MEDIA_KINDS[kind]) {
    if (!attachmentIds.length) throw invalid('Attachments are required for this kind of message');
    if (kind === 'voice' && attachmentIds.length !== 1)
      throw invalid('A voice message has exactly one audio attachment');
  } else {
    throw invalid('Unsupported message kind');
  }

  if (attachmentIds.length) {
    const { rows } = await ctx.db.query<{ id: string; kind: string }>(
      `SELECT m.id, m.kind FROM media m
        WHERE m.id = ANY($1::uuid[]) AND m.owner_id = $2 AND m.deleted_at IS NULL AND m.status IN ('uploaded','processing','ready')
          AND NOT EXISTS (SELECT 1 FROM message_attachments ma WHERE ma.media_id = m.id)`,
      [attachmentIds, input.senderId],
    );
    if (rows.length !== attachmentIds.length)
      throw invalid('One or more attachments are unavailable');
    const allowed = MEDIA_KINDS[kind]!;
    if (rows.some((r) => !allowed.includes(r.kind)))
      throw invalid('Attachment type does not match the message kind');
  }

  if (input.replyToId) {
    const r = await ctx.db.query(
      'SELECT 1 FROM messages WHERE id = $1 AND conversation_id = $2 AND deleted_at IS NULL',
      [input.replyToId, input.conversationId],
    );
    if (!r.rowCount) throw invalid('The message you are replying to is unavailable');
  }

  const { row, created } = await withTransaction(ctx.db, async (tx) => {
    const res = await insertMessageTx(ctx, tx, {
      conversationId: input.conversationId,
      senderId: input.senderId,
      kind,
      body,
      replyToId: input.replyToId,
      metadata,
      clientMessageId: input.clientMessageId,
      attachmentIds,
    });
    if (res.created && input.poll) {
      const options = input.poll.options.map((label, i) => ({
        id: `o${i + 1}`,
        label: label.trim(),
      }));
      await tx.query(
        'INSERT INTO message_polls (message_id, question, multiple, options) VALUES ($1,$2,$3,$4)',
        [
          res.row.id,
          input.poll.question.trim(),
          input.poll.multiple ?? false,
          JSON.stringify(options),
        ],
      );
      await screenText(ctx, tx, {
        type: 'message',
        id: res.row.id,
        authorId: input.senderId,
        text: `${input.poll.question} ${options.map((o) => o.label).join(' ')}`,
      });
    }
    return res;
  });
  const fresh = (await reload(ctx, row.id)) ?? row;
  if (created) {
    ctx.metrics.events.inc({ name: 'message_sent' });
    await announceMessage(ctx, fresh, access);
  }
  return { message: (await hydrateMessages(ctx, [fresh], input.senderId))[0]!, created };
}

async function reload(ctx: AppContext, id: string): Promise<MessageRow | null> {
  const { rows } = await ctx.db.query<MessageRow>(
    `SELECT ${MSG_COLS} FROM messages m WHERE m.id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

/**
 * Reusable entry point for other modules (AI drafts a human confirmed, commerce order chats, ...).
 * Enforces exactly the same rules as the HTTP route: membership/community permission, blocks, contact preferences,
 * teen restrictions, attachment ownership, moderation.
 */
export async function sendMessage(ctx: AppContext, input: SendMessageInput): Promise<MessageView> {
  return (await sendMessageDetailed(ctx, input)).message;
}

/** Load a message the viewer may see, plus their access; 404 for everything else (never reveals existence). */
export async function loadMessageForViewer(
  ctx: AppContext,
  userId: string,
  messageId: string,
): Promise<{ row: MessageRow; access: ConvAccess }> {
  const row = await reload(ctx, messageId);
  if (!row) throw notFound('Message');
  const access = await requireAccess(ctx.db, row.conversation_id, userId).catch(() => {
    throw notFound('Message');
  });
  if (access.joinedAtRaw) {
    const seen = await ctx.db.query(
      'SELECT 1 FROM messages WHERE id = $1 AND created_at >= $2::timestamptz',
      [messageId, access.joinedAtRaw],
    );
    if (!seen.rowCount) throw notFound('Message');
  }
  if (row.moderation_status !== 'approved' && row.sender_id !== userId && !isTombstone(row))
    throw notFound('Message');
  return { row, access };
}

export async function listMessages(
  ctx: AppContext,
  userId: string,
  conversationId: string,
  opts: { cursor?: string | undefined; limit?: number | undefined },
): Promise<Page<MessageView>> {
  const access = await requireAccess(ctx.db, conversationId, userId);
  const limit = clampLimit(opts.limit);
  const cur = decodeCursor<{ t: string; id: string }>(opts.cursor);
  const { rows } = await ctx.db.query<MessageRow & { cursor_ts: string }>(
    `SELECT ${MSG_COLS}, m.created_at::text AS cursor_ts FROM messages m
      WHERE m.conversation_id = $1
        AND ($2::timestamptz IS NULL OR m.created_at >= $2::timestamptz)
        AND (m.moderation_status IN ('approved','removed') OR m.sender_id = $3)
        AND ($4::timestamptz IS NULL OR (m.created_at, m.id) < ($4::timestamptz, $5::uuid))
      ORDER BY m.created_at DESC, m.id DESC LIMIT $6`,
    [conversationId, access.joinedAtRaw, userId, cur?.t ?? null, cur?.id ?? null, limit + 1],
  );
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: await hydrateMessages(ctx, page, userId),
    nextCursor:
      rows.length > limit && last ? encodeCursor({ t: last.cursor_ts, id: last.id }) : null,
  };
}

const EDITABLE = new Set(['text', 'media', 'file']);

export async function editMessage(
  ctx: AppContext,
  userId: string,
  messageId: string,
  newBody: string,
): Promise<MessageView> {
  const { row, access } = await loadMessageForViewer(ctx, userId, messageId);
  if (isTombstone(row)) throw notFound('Message');
  if (row.sender_id !== userId) throw forbidden('You can only edit your own messages');
  requireSend(access);
  if (!EDITABLE.has(row.kind)) throw invalid('This kind of message cannot be edited');
  const body = newBody.trim();
  if (row.kind === 'text' && !body) throw invalid('Message text is required');
  if (body.length > MAX_BODY) throw invalid('Message is too long');
  await withTransaction(ctx.db, async (tx) => {
    await tx.query('UPDATE messages SET body = $2, edited_at = now() WHERE id = $1', [
      messageId,
      body,
    ]);
    if (body)
      await screenText(ctx, tx, { type: 'message', id: messageId, authorId: userId, text: body });
  });
  await announceMessageUpdated(ctx, messageId);
  return (await hydrateMessages(ctx, [(await reload(ctx, messageId))!], userId))[0]!;
}

/** Delete for everyone: the row is kept as a tombstone, but text, attachments and reactions are removed. */
export async function deleteMessage(
  ctx: AppContext,
  userId: string,
  messageId: string,
): Promise<void> {
  const { row } = await loadMessageForViewer(ctx, userId, messageId);
  if (row.sender_id !== userId) throw forbidden('You can only delete your own messages');
  if (row.deleted_at) return;
  await withTransaction(ctx.db, async (tx) => {
    await tx.query(
      `UPDATE messages SET deleted_at = now(), body = '', metadata = '{}'::jsonb WHERE id = $1`,
      [messageId],
    );
    await tx.query('DELETE FROM message_attachments WHERE message_id = $1', [messageId]);
    await tx.query(`DELETE FROM reactions WHERE target_type = 'message' AND target_id = $1`, [
      messageId,
    ]);
  });
  publishConv(ctx, row.conversation_id, { type: 'message.deleted', messageId });
}

export const REACTION_KINDS = ['like', 'love', 'laugh', 'wow', 'sad', 'insightful'] as const;

export async function setMessageReaction(
  ctx: AppContext,
  userId: string,
  messageId: string,
  kind: string | null,
): Promise<MessageView> {
  const { row } = await loadMessageForViewer(ctx, userId, messageId);
  if (isTombstone(row)) throw notFound('Message');
  if (kind) {
    await ctx.db.query(
      `INSERT INTO reactions (user_id, target_type, target_id, kind) VALUES ($1,'message',$2,$3)
       ON CONFLICT (user_id, target_type, target_id) DO UPDATE SET kind = EXCLUDED.kind`,
      [userId, messageId, kind],
    );
  } else {
    await ctx.db.query(
      `DELETE FROM reactions WHERE user_id = $1 AND target_type = 'message' AND target_id = $2`,
      [userId, messageId],
    );
  }
  await announceMessageUpdated(ctx, messageId);
  return (await hydrateMessages(ctx, [row], userId))[0]!;
}

export async function votePoll(
  ctx: AppContext,
  userId: string,
  messageId: string,
  optionIds: string[],
): Promise<MessageView> {
  const { row } = await loadMessageForViewer(ctx, userId, messageId);
  if (isTombstone(row) || row.kind !== 'poll') throw notFound('Poll');
  const { rows } = await ctx.db.query<{ multiple: boolean; options: Array<{ id: string }> }>(
    'SELECT multiple, options FROM message_polls WHERE message_id = $1',
    [messageId],
  );
  const poll = rows[0];
  if (!poll) throw notFound('Poll');
  const chosen = [...new Set(optionIds)];
  if (chosen.some((id) => !poll.options.some((o) => o.id === id)))
    throw invalid('Unknown poll option');
  if (!poll.multiple && chosen.length > 1) throw invalid('This poll allows a single choice');
  await withTransaction(ctx.db, async (tx) => {
    await tx.query('DELETE FROM message_poll_votes WHERE message_id = $1 AND user_id = $2', [
      messageId,
      userId,
    ]);
    for (const id of chosen)
      await tx.query(
        'INSERT INTO message_poll_votes (message_id, user_id, option_id) VALUES ($1,$2,$3)',
        [messageId, userId, id],
      );
  });
  await announceMessageUpdated(ctx, messageId);
  return (await hydrateMessages(ctx, [row], userId))[0]!;
}

export async function markRead(
  ctx: AppContext,
  userId: string,
  conversationId: string,
  messageId?: string,
): Promise<{ lastReadAt: string }> {
  await requireAccess(ctx.db, conversationId, userId);
  if (messageId) {
    const r = await ctx.db.query('SELECT 1 FROM messages WHERE id = $1 AND conversation_id = $2', [
      messageId,
      conversationId,
    ]);
    if (!r.rowCount) throw notFound('Message');
  }
  // Community channels have no membership row until the reader first marks something read.
  const { rows } = await ctx.db.query<{ last_read_at: Date }>(
    `INSERT INTO conversation_members (conversation_id, user_id, role, last_read_at) VALUES ($1,$2,'member', COALESCE((SELECT created_at FROM messages WHERE id = $3::uuid), now()))
     ON CONFLICT (conversation_id, user_id) DO UPDATE SET last_read_at = GREATEST(COALESCE(conversation_members.last_read_at, '-infinity'), EXCLUDED.last_read_at)
     RETURNING last_read_at`,
    [conversationId, userId, messageId ?? null],
  );
  const lastReadAt = rows[0]!.last_read_at.toISOString();
  publishConv(ctx, conversationId, { type: 'conversation.read', userId, lastReadAt });
  return { lastReadAt };
}

export const newRoomId = () => `room_${randomUUID().replace(/-/g, '')}`;
