import type { AppContext } from '../../lib/context.js';

/** Fire-and-forget realtime publish: a broken pub/sub backend must never fail the write that already committed. */
export function publishConv(
  ctx: AppContext,
  conversationId: string,
  payload: Record<string, unknown>,
): void {
  void ctx.pubsub
    .publish(`conv:${conversationId}`, { conversationId, ...payload })
    .catch((err) => ctx.log.warn({ err }, 'realtime publish failed'));
}

export function publishUser(
  ctx: AppContext,
  userId: string,
  payload: Record<string, unknown>,
): void {
  void ctx.pubsub
    .publish(`user:${userId}`, payload)
    .catch((err) => ctx.log.warn({ err }, 'realtime publish failed'));
}
