/** What a message you sent has reached: their devices (delivered), then their eyes (read). */
export type MessageReceipt = 'sent' | 'delivered' | 'read';

/**
 * A message's state, from the chat's receipts. In a group it counts once it has reached everyone
 * else. Reading implies delivery. `others` is how many other people are in the chat.
 */
export function messageReceipt(
  createdAt: string,
  others: number,
  readBy: readonly { userId: string; lastReadAt: string }[] = [],
  deliveredTo: readonly { userId: string; lastDeliveredAt: string }[] = [],
): MessageReceipt {
  if (others < 1) return 'sent';
  const at = new Date(createdAt).getTime();
  const read = readBy.filter((r) => new Date(r.lastReadAt).getTime() >= at).map((r) => r.userId);
  if (read.length >= others) return 'read';
  const reached = new Set([...read, ...deliveredTo.filter((d) => new Date(d.lastDeliveredAt).getTime() >= at).map((d) => d.userId)]);
  return reached.size >= others ? 'delivered' : 'sent';
}
