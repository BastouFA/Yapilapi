import type { Queryable } from '@yapilapi/database';
import type { AppContext } from './context.js';
import { shouldDeliver } from './notification-policy.js';
import { dispatchPush } from './push-dispatch.js';

export interface NotificationInput {
  userId: string;
  kind: string;
  actorId?: string | null;
  targetType?: string;
  targetId?: string;
  data?: Record<string, unknown>;
}

/**
 * Create an in-app notification (respecting the recipient's preferences) and publish it to the realtime channel.
 * Never notifies a user about their own actions or about users who have blocked/been blocked by them.
 */
export async function notify(
  ctx: AppContext,
  n: NotificationInput,
  db: Queryable = ctx.db,
): Promise<void> {
  if (n.actorId && n.actorId === n.userId) return;
  if (n.actorId) {
    const b = await db.query(
      `SELECT 1 FROM user_blocks WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)`,
      [n.userId, n.actorId],
    );
    if (b.rowCount) return;
  }
  // Single source of truth for preferences, quiet hours, pause and focus mode (lib/notification-policy.ts).
  const decision = await shouldDeliver(ctx, n.userId, n.kind, new Date(), db);
  if (!decision.inApp) return;
  const { rows } = await db.query<{ id: string; created_at: Date }>(
    `INSERT INTO notifications (user_id, kind, actor_id, target_type, target_id, data, pushed_at) VALUES ($1,$2,$3,$4,$5,$6, CASE WHEN $7::boolean THEN now() END) RETURNING id, created_at`,
    [
      n.userId,
      n.kind,
      n.actorId ?? null,
      n.targetType ?? null,
      n.targetId ?? null,
      JSON.stringify(n.data ?? {}),
      decision.push,
    ],
  );
  if (decision.push) {
    void dispatchPush(ctx, n.userId, {
      id: rows[0]!.id,
      category: decision.category,
      kind: n.kind,
      targetType: n.targetType,
      targetId: n.targetId,
    }).catch((err: unknown) => ctx.log.warn({ err }, 'push dispatch failed'));
  }
  void ctx.pubsub
    .publish(`user:${n.userId}`, {
      type: 'notification',
      id: rows[0]!.id,
      kind: n.kind,
      createdAt: rows[0]!.created_at.toISOString(),
    })
    .catch(() => undefined);
}
