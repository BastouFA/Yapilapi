import type { Message } from '@yapilapi/api-client';
import type { OutboxItem } from '../offline/outbox';

/** A row in the chat list: a delivered message, or one still in the outbox (shown as "sending" / "not sent"). */
export type ChatRow =
  | { id: string; kind: 'message'; message: Message }
  | { id: string; kind: 'pending'; item: Extract<OutboxItem, { kind: 'message' }> };

/**
 * Newest-first rows for an inverted list: queued messages first (they are the newest), then delivered ones.
 * A queued item whose `clientMessageId` already came back from the server (via socket or REST) is hidden, so a message
 * never shows twice during the moment between delivery and outbox cleanup.
 */
export function buildChatRows(
  messages: Message[],
  outbox: readonly OutboxItem[],
  conversationId: string,
): ChatRow[] {
  const known = new Set(
    messages.map((m) => m.clientMessageId).filter((x): x is string => Boolean(x)),
  );
  const pending = outbox
    .filter(
      (i): i is Extract<OutboxItem, { kind: 'message' }> =>
        i.kind === 'message' &&
        i.conversationId === conversationId &&
        !known.has(i.clientMessageId),
    )
    .sort((a, b) => b.createdAt - a.createdAt)
    .map<ChatRow>((item) => ({ id: `pending:${item.id}`, kind: 'pending', item }));
  return [
    ...pending,
    ...messages.map<ChatRow>((message) => ({ id: message.id, kind: 'message', message })),
  ];
}
