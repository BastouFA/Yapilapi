import type { AppContext } from '../../lib/context.js';

/** Fire-and-forget fan-out on `live:<id>` (the channel the creator module also publishes gifts on). A broken pub/sub never fails a committed write. */
export function publishLive(
  ctx: AppContext,
  liveId: string,
  payload: Record<string, unknown>,
): void {
  void ctx.pubsub
    .publish(`live:${liveId}`, { liveId, ...payload })
    .catch((err) => ctx.log.warn({ err }, 'live publish failed'));
}
/** Event types a WebSocket may forward to viewers (anything else on the channel is ignored). */
export const LIVE_EVENTS = new Set([
  'live.started',
  'live.ended',
  'live.updated',
  'viewers',
  'chat.message',
  'chat.hidden',
  'reaction',
  'poll.created',
  'poll.updated',
  'poll.closed',
  'question.new',
  'question.updated',
  'product.pinned',
  'product.unpinned',
  'participant.muted',
  'participant.banned',
  'gift',
  'marker',
]);
