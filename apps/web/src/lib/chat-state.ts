import type { InboxItem, Message, ReactionKind } from '@yapilapi/api-client';

export interface ChatItem {
  message: Message;
  status: 'sending' | 'failed' | 'sent';
}

/** Pure helpers for chat state. Messages are kept oldest-first; the API returns pages newest-first. */

const byTime = (a: ChatItem, b: ChatItem): number => {
  const d = Date.parse(a.message.createdAt) - Date.parse(b.message.createdAt);
  return d !== 0 ? d : a.message.id < b.message.id ? -1 : 1;
};

export const sent = (message: Message): ChatItem => ({ message, status: 'sent' });

/** Turn one API page (newest first) into display order. */
export function pageToItems(page: Message[]): ChatItem[] {
  return [...page].reverse().map(sent);
}

/** Older page goes in front; duplicates (by id) are dropped in favour of what is already shown. */
export function prependOlder(items: ChatItem[], olderPageNewestFirst: Message[]): ChatItem[] {
  const have = new Set(items.map((i) => i.message.id));
  return [...pageToItems(olderPageNewestFirst).filter((i) => !have.has(i.message.id)), ...items];
}

/**
 * Insert or update a message that arrived over the socket or from a REST response.
 * Socket payloads are viewer-neutral, so the viewer's own reaction (`mine`) is kept from local state unless the
 * update is `authoritative` (a REST response computed for this viewer).
 */
export function upsertMessage(
  items: ChatItem[],
  message: Message,
  opts: { authoritative?: boolean } = {},
): ChatItem[] {
  const cid = message.clientMessageId ?? null;
  let idx = items.findIndex((i) => i.message.id === message.id);
  if (idx === -1 && cid) idx = items.findIndex((i) => i.status !== 'sent' && i.message.id === cid);
  if (idx === -1) return [...items, sent(message)].sort(byTime);
  const existing = items[idx]!;
  const next: Message =
    !opts.authoritative && existing.status === 'sent'
      ? {
          ...message,
          reactions: { counts: message.reactions.counts, mine: existing.message.reactions.mine },
        }
      : message;
  const copy = items.slice();
  copy[idx] = sent(next);
  return copy.sort(byTime);
}

export function markDeleted(items: ChatItem[], id: string): ChatItem[] {
  return items.map((i) =>
    i.message.id === id
      ? {
          ...i,
          message: { ...i.message, deleted: true, body: '', reactions: { counts: {}, mine: null } },
        }
      : i,
  );
}

/** Optimistically set (or clear, with null) the viewer's reaction and adjust counts. */
export function withReaction(message: Message, kind: ReactionKind | null): Message {
  const counts = { ...message.reactions.counts };
  const prev = message.reactions.mine;
  if (prev) counts[prev] = Math.max(0, (counts[prev] ?? 1) - 1);
  if (kind) counts[kind] = (counts[kind] ?? 0) + 1;
  for (const k of Object.keys(counts) as ReactionKind[]) if (!counts[k]) delete counts[k];
  return { ...message, reactions: { counts, mine: kind } };
}

export function replaceMessage(
  items: ChatItem[],
  id: string,
  fn: (m: Message) => Message,
): ChatItem[] {
  return items.map((i) => (i.message.id === id ? { ...i, message: fn(i.message) } : i));
}

export interface PendingInput {
  clientId: string;
  body: string;
  replyTo: Message | null;
  sender: { id: string; username: string; displayName: string; avatarUrl: string | null };
  conversationId: string;
  now?: Date;
}

/** A message that has been typed but not yet acknowledged. Its id is the client id until the server answers. */
export function makePending(p: PendingInput): ChatItem {
  return {
    status: 'sending',
    message: {
      id: p.clientId,
      conversationId: p.conversationId,
      senderId: p.sender.id,
      sender: p.sender,
      kind: 'text',
      body: p.body,
      deleted: false,
      replyTo: p.replyTo
        ? {
            id: p.replyTo.id,
            senderId: p.replyTo.senderId,
            kind: p.replyTo.kind,
            body: p.replyTo.body,
            deleted: p.replyTo.deleted,
          }
        : null,
      attachments: [],
      metadata: {},
      reactions: { counts: {}, mine: null },
      poll: null,
      plan: null,
      clientMessageId: p.clientId,
      createdAt: (p.now ?? new Date()).toISOString(),
      editedAt: null,
    },
  };
}

export const failPending = (items: ChatItem[], clientId: string): ChatItem[] =>
  items.map((i) =>
    i.message.id === clientId && i.status === 'sending' ? { ...i, status: 'failed' as const } : i,
  );

export const retryPending = (items: ChatItem[], clientId: string): ChatItem[] =>
  items.map((i) =>
    i.message.id === clientId && i.status === 'failed' ? { ...i, status: 'sending' as const } : i,
  );

export const discardPending = (items: ChatItem[], clientId: string): ChatItem[] =>
  items.filter((i) => !(i.message.id === clientId && i.status !== 'sent'));

/** The server confirmed a send: swap the pending row for the real message (or merge if the socket beat the response). */
export function resolvePending(items: ChatItem[], clientId: string, message: Message): ChatItem[] {
  const without = items.filter((i) => !(i.message.id === clientId && i.status !== 'sent'));
  return upsertMessage(without, message, { authoritative: true });
}

/** Inbox order: pinned first, then most recent activity. */
export function sortInbox<T extends Pick<InboxItem, 'pinned' | 'lastMessageAt' | 'createdAt'>>(
  list: T[],
): T[] {
  const stamp = (x: T) => Date.parse(x.lastMessageAt ?? x.createdAt);
  return list.slice().sort((a, b) => Number(b.pinned) - Number(a.pinned) || stamp(b) - stamp(a));
}

/** Title shown for an inbox row or chat header. */
export function conversationTitle(
  c: {
    kind: string;
    title: string | null;
    channelName: string | null;
    peer?: { displayName: string } | null;
  },
  fallback: { group: string; channel: string; person: string },
): string {
  if (c.kind === 'direct') return c.peer?.displayName ?? fallback.person;
  if (c.kind === 'community_channel') return c.channelName ? `#${c.channelName}` : fallback.channel;
  return c.title?.trim() || fallback.group;
}

/** Highest of the other members' read timestamps that covers `createdAt`: used for the "Seen" line in direct chats. */
export function isSeenBy(lastReadAt: string | null | undefined, messageCreatedAt: string): boolean {
  return Boolean(lastReadAt) && Date.parse(lastReadAt!) >= Date.parse(messageCreatedAt);
}

/** Typing indicators expire on their own if a "stop" frame is lost. */
export function pruneTyping(
  typing: Record<string, number>,
  now: number,
  ttlMs = 6000,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(typing)) if (now - v < ttlMs) out[k] = v;
  return out;
}

export const newClientId = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `c-${Date.now()}-${Math.random().toString(16).slice(2)}`;

/** http(s) API origin + the relative ws url the API hands out -> ws(s) URL. */
export function wsUrlFrom(apiBase: string, relative: string): string {
  const u = new URL(relative, apiBase.endsWith('/') ? apiBase : `${apiBase}/`);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  return u.toString();
}

/** Reconnect delay with exponential backoff and jitter, capped. */
export function backoffMs(attempt: number, rand: () => number = Math.random): number {
  const base = Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5));
  return Math.round(base / 2 + rand() * (base / 2));
}
