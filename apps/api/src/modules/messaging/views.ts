import type { AppContext } from '../../lib/context.js';
import { mediaUrl } from '../../lib/media-url.js';

export interface MessageRow {
  id: string;
  conversation_id: string;
  sender_id: string | null;
  kind: string;
  body: string;
  reply_to_id: string | null;
  metadata: Record<string, unknown>;
  client_message_id: string | null;
  moderation_status: string;
  created_at: Date;
  edited_at: Date | null;
  deleted_at: Date | null;
}

export const MSG_COLS =
  'm.id, m.conversation_id, m.sender_id, m.kind, m.body, m.reply_to_id, m.metadata, m.client_message_id, m.moderation_status, m.created_at, m.edited_at, m.deleted_at';

export interface MessageView {
  id: string;
  conversationId: string;
  senderId: string | null;
  sender: { id: string; username: string; displayName: string; avatarUrl: string | null } | null;
  kind: string;
  body: string;
  /** True for messages deleted by their sender (or removed by moderation): content is gone for every reader. */
  deleted: boolean;
  replyTo: {
    id: string;
    senderId: string | null;
    kind: string;
    body: string;
    deleted: boolean;
  } | null;
  attachments: Array<{
    id: string;
    kind: string;
    url: string;
    mimeType: string;
    sizeBytes: number;
    width: number | null;
    height: number | null;
    durationMs: number | null;
    altText: string | null;
  }>;
  metadata: Record<string, unknown>;
  reactions: { counts: Record<string, number>; mine: string | null };
  poll: {
    question: string;
    multiple: boolean;
    options: Array<{ id: string; label: string; votes: number }>;
    myVotes: string[];
    totalVotes: number;
  } | null;
  plan: {
    id: string;
    title: string;
    status: string;
    destination: string | null;
    startsOn: string | null;
    endsOn: string | null;
    rsvp: Record<string, number>;
    myRsvp: string | null;
  } | null;
  moderationStatus?: string;
  clientMessageId?: string | null;
  createdAt: string;
  editedAt: string | null;
}

const PREVIEW = 140;
const dateOnly = (d: Date | string | null) =>
  d instanceof Date ? d.toISOString().slice(0, 10) : d;

/**
 * Turn message rows into API views in a fixed number of queries. `viewerId` null builds the viewer-neutral
 * shape that is pushed over realtime channels (no "mine" fields such as reactions.mine/myRsvp/moderationStatus).
 * `clientMessageId` is the exception: it's a client-generated correlation UUID with no meaning to anyone but
 * the sender's own browser tab, so it's always included when present rather than gated behind `mineSender` —
 * the sender's tab needs it to reconcile its optimistic UI against the realtime broadcast of its own message,
 * which is always hydrated with viewerId: null (see messaging/service.ts announceMessage).
 */
export async function hydrateMessages(
  ctx: AppContext,
  rows: MessageRow[],
  viewerId: string | null,
): Promise<MessageView[]> {
  if (!rows.length) return [];
  const live = rows.filter((r) => !isTombstone(r));
  const liveIds = live.map((r) => r.id);
  const senderIds = [...new Set(rows.map((r) => r.sender_id).filter((x): x is string => !!x))];
  const replyIds = [...new Set(rows.map((r) => r.reply_to_id).filter((x): x is string => !!x))];
  const pollIds = live.filter((r) => r.kind === 'poll').map((r) => r.id);
  const planIds = [
    ...new Set(
      live
        .filter((r) => r.kind === 'plan')
        .map((r) => String(r.metadata?.planId ?? ''))
        .filter((x) => /^[0-9a-f-]{36}$/.test(x)),
    ),
  ];
  const convIds = [...new Set(rows.map((r) => r.conversation_id))];
  const q = ctx.db.query.bind(ctx.db);

  const [senders, atts, replies, reacts, polls, votes, plans, rsvps] = await Promise.all([
    senderIds.length
      ? q<{ user_id: string; username: string; display_name: string; avatar_url: string | null }>(
          'SELECT user_id, username, display_name, avatar_url FROM profiles WHERE user_id = ANY($1::uuid[])',
          [senderIds],
        )
      : { rows: [] },
    liveIds.length
      ? q<{
          message_id: string;
          id: string;
          kind: string;
          storage_key: string;
          mime_type: string;
          size_bytes: number;
          width: number | null;
          height: number | null;
          duration_ms: number | null;
          alt_text: string | null;
        }>(
          `SELECT ma.message_id, m.id, m.kind, m.storage_key, m.mime_type, m.size_bytes, m.width, m.height, m.duration_ms, m.alt_text
             FROM message_attachments ma JOIN media m ON m.id = ma.media_id WHERE ma.message_id = ANY($1::uuid[]) ORDER BY ma.position`,
          [liveIds],
        )
      : { rows: [] },
    replyIds.length
      ? q<{
          id: string;
          sender_id: string | null;
          kind: string;
          body: string;
          deleted_at: Date | null;
          moderation_status: string;
        }>(
          'SELECT id, sender_id, kind, body, deleted_at, moderation_status FROM messages WHERE id = ANY($1::uuid[]) AND conversation_id = ANY($2::uuid[])',
          [replyIds, convIds],
        )
      : { rows: [] },
    q<{ target_id: string; kind: string; n: number; mine: boolean }>(
      `SELECT target_id, kind, count(*)::int AS n, COALESCE(bool_or(user_id = $2::uuid), false) AS mine
         FROM reactions WHERE target_type = 'message' AND target_id = ANY($1::uuid[]) GROUP BY target_id, kind`,
      [liveIds, viewerId],
    ),
    pollIds.length
      ? q<{
          message_id: string;
          question: string;
          multiple: boolean;
          options: Array<{ id: string; label: string }>;
        }>(
          'SELECT message_id, question, multiple, options FROM message_polls WHERE message_id = ANY($1::uuid[])',
          [pollIds],
        )
      : { rows: [] },
    pollIds.length
      ? q<{ message_id: string; option_id: string; n: number; mine: boolean }>(
          `SELECT message_id, option_id, count(*)::int AS n, COALESCE(bool_or(user_id = $2::uuid), false) AS mine
             FROM message_poll_votes WHERE message_id = ANY($1::uuid[]) GROUP BY message_id, option_id`,
          [pollIds, viewerId],
        )
      : { rows: [] },
    planIds.length
      ? q<{
          id: string;
          title: string;
          status: string;
          destination: string | null;
          starts_on: Date | string | null;
          ends_on: Date | string | null;
        }>(
          'SELECT id, title, status, destination, starts_on::text AS starts_on, ends_on::text AS ends_on FROM plans WHERE id = ANY($1::uuid[])',
          [planIds],
        )
      : { rows: [] },
    planIds.length
      ? q<{ plan_id: string; rsvp: string; n: number; mine: boolean }>(
          `SELECT plan_id, rsvp, count(*)::int AS n, COALESCE(bool_or(user_id = $2::uuid), false) AS mine FROM plan_participants WHERE plan_id = ANY($1::uuid[]) GROUP BY plan_id, rsvp`,
          [planIds, viewerId],
        )
      : { rows: [] },
  ]);

  const senderMap = new Map(
    senders.rows.map((s) => [
      s.user_id,
      { id: s.user_id, username: s.username, displayName: s.display_name, avatarUrl: s.avatar_url },
    ]),
  );
  const replyMap = new Map(replies.rows.map((r) => [r.id, r]));

  return rows.map((r): MessageView => {
    const dead = isTombstone(r);
    const mineSender = viewerId !== null && r.sender_id === viewerId;
    const reactions = { counts: {} as Record<string, number>, mine: null as string | null };
    for (const x of reacts.rows)
      if (x.target_id === r.id) {
        reactions.counts[x.kind] = x.n;
        if (x.mine && viewerId) reactions.mine = x.kind;
      }

    let poll: MessageView['poll'] = null;
    const pr = polls.rows.find((p) => p.message_id === r.id);
    if (pr && !dead) {
      const mv = votes.rows.filter((v) => v.message_id === r.id);
      poll = {
        question: pr.question,
        multiple: pr.multiple,
        options: pr.options.map((o) => ({
          id: o.id,
          label: o.label,
          votes: mv.find((v) => v.option_id === o.id)?.n ?? 0,
        })),
        myVotes: mv.filter((v) => v.mine && viewerId).map((v) => v.option_id),
        totalVotes: mv.reduce((a, v) => a + v.n, 0),
      };
    }
    let plan: MessageView['plan'] = null;
    if (r.kind === 'plan' && !dead) {
      const pl = plans.rows.find((p) => p.id === r.metadata?.planId);
      if (pl) {
        const rs = rsvps.rows.filter((x) => x.plan_id === pl.id);
        plan = {
          id: pl.id,
          title: pl.title,
          status: pl.status,
          destination: pl.destination,
          startsOn: dateOnly(pl.starts_on),
          endsOn: dateOnly(pl.ends_on),
          rsvp: Object.fromEntries(rs.map((x) => [x.rsvp, x.n])),
          myRsvp: viewerId ? (rs.find((x) => x.mine)?.rsvp ?? null) : null,
        };
      }
    }
    const rep = r.reply_to_id ? replyMap.get(r.reply_to_id) : undefined;
    const view: MessageView = {
      id: r.id,
      conversationId: r.conversation_id,
      senderId: r.sender_id,
      sender: r.sender_id ? (senderMap.get(r.sender_id) ?? null) : null,
      kind: r.kind,
      body: dead ? '' : r.body,
      deleted: dead,
      replyTo: rep
        ? {
            id: rep.id,
            senderId: rep.sender_id,
            kind: rep.kind,
            deleted: isTombstone(rep),
            body:
              isTombstone(rep) || rep.moderation_status !== 'approved'
                ? ''
                : rep.body.slice(0, PREVIEW),
          }
        : null,
      attachments: dead
        ? []
        : atts.rows
            .filter((a) => a.message_id === r.id)
            .map((a) => ({
              id: a.id,
              kind: a.kind,
              url: mediaUrl(ctx.config, a.storage_key),
              mimeType: a.mime_type,
              sizeBytes: a.size_bytes,
              width: a.width,
              height: a.height,
              durationMs: a.duration_ms,
              altText: a.alt_text,
            })),
      metadata: dead ? {} : r.metadata,
      reactions: dead ? { counts: {}, mine: null } : reactions,
      poll,
      plan,
      createdAt: r.created_at.toISOString(),
      editedAt: r.edited_at?.toISOString() ?? null,
    };
    if (r.client_message_id !== null) view.clientMessageId = r.client_message_id;
    if (mineSender && r.moderation_status !== 'approved')
      view.moderationStatus = r.moderation_status;
    return view;
  });
}

export function isTombstone(r: { deleted_at: Date | null; moderation_status: string }): boolean {
  return r.deleted_at !== null || r.moderation_status === 'removed';
}

export async function loadMessageViews(
  ctx: AppContext,
  ids: string[],
  viewerId: string | null,
): Promise<MessageView[]> {
  const { rows } = await ctx.db.query<MessageRow>(
    `SELECT ${MSG_COLS} FROM messages m WHERE m.id = ANY($1::uuid[]) ORDER BY m.created_at, m.id`,
    [ids],
  );
  return hydrateMessages(ctx, rows, viewerId);
}
