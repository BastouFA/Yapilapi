import type { AppContext } from './context.js';
import { PUSH_COPY, type NotificationCategory } from './notification-policy.js';
import type { PushMessage } from './push.js';

/**
 * Send a content-free push for a stored notification to all of the user's active push tokens. Fire-and-forget from
 * notify(): failures are logged, never thrown. Tokens the provider reports as permanently invalid are disabled.
 */
export async function dispatchPush(
  ctx: AppContext,
  userId: string,
  n: {
    id: string;
    category: NotificationCategory;
    kind: string;
    targetType?: string | undefined;
    targetId?: string | undefined;
  },
): Promise<number> {
  const { rows } = await ctx.db.query<{ token: string }>(
    'SELECT token FROM push_tokens WHERE user_id = $1 AND disabled_at IS NULL LIMIT 20',
    [userId],
  );
  if (!rows.length) return 0;
  const copy = PUSH_COPY[n.category];
  const data: Record<string, string> = { notificationId: n.id, category: n.category, kind: n.kind };
  if (n.targetType) data.targetType = n.targetType;
  if (n.targetId) data.targetId = n.targetId;
  const messages: PushMessage[] = rows.map((r) => ({
    token: r.token,
    title: copy.title,
    body: copy.body,
    data,
  }));
  const results = await ctx.push.send(messages);
  const invalid = results.filter((r) => r.invalidToken).map((r) => r.token);
  if (invalid.length)
    await ctx.db.query('UPDATE push_tokens SET disabled_at = now() WHERE token = ANY($1::text[])', [
      invalid,
    ]);
  const okTokens = results.filter((r) => r.ok).map((r) => r.token);
  if (okTokens.length)
    await ctx.db.query(
      'UPDATE push_tokens SET last_used_at = now() WHERE token = ANY($1::text[])',
      [okTokens],
    );
  return okTokens.length;
}
