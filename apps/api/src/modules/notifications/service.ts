import { clampLimit, decodeCursor, encodeCursor, notFound } from '@yapilapi/shared';
import type { AppContext } from '../../lib/context.js';
import {
  DEFAULT_CHANNELS,
  KIND_CATEGORY,
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_CHANNELS,
  PREFIX_CATEGORY,
  UNDISABLEABLE,
  categoryFor,
  type NotificationCategory,
  type NotificationChannel,
} from '../../lib/notification-policy.js';

export const CATEGORY_LABELS: Record<NotificationCategory, string> = {
  messages: 'Messages',
  friends: 'Friends and follows',
  creators: 'Reactions and comments',
  communities: 'Communities',
  events: 'Events',
  commerce: 'Orders, bookings and business',
  security: 'Security and privacy',
  moderation: 'Safety notices about your account',
  system: 'Product updates',
};

const isCategory = (s: string): s is NotificationCategory =>
  (NOTIFICATION_CATEGORIES as readonly string[]).includes(s);
/** A preference key is either a category or an exact notification kind we know about. */
export const isPreferenceKey = (s: string): boolean =>
  isCategory(s) || Object.hasOwn(KIND_CATEGORY, s);
export const categoryOfKey = (key: string): NotificationCategory =>
  isCategory(key) ? key : categoryFor(key);

/**
 * SQL predicate (with parameters) selecting notifications whose kind belongs to `category`, mirroring `categoryFor`:
 * exact mappings win over prefix mappings, everything unknown is "system".
 */
export function categoryFilter(
  category: NotificationCategory,
  firstParam: number,
  col = 'kind',
): { sql: string; params: unknown[] } {
  const exactIn = Object.entries(KIND_CATEGORY)
    .filter(([, c]) => c === category)
    .map(([k]) => k);
  const exactOut = Object.entries(KIND_CATEGORY)
    .filter(([, c]) => c !== category)
    .map(([k]) => k);
  const p = (n: number) => `$${firstParam + n}`;
  if (category === 'system') {
    return {
      sql: `(${col} = ANY(${p(0)}::text[]) OR (${col} <> ALL(${p(1)}::text[]) AND NOT ${col} LIKE ANY(${p(2)}::text[])))`,
      params: [exactIn, exactOut, PREFIX_CATEGORY.map(([pre]) => `${pre}%`)],
    };
  }
  return {
    sql: `(${col} = ANY(${p(0)}::text[]) OR (${col} LIKE ANY(${p(1)}::text[]) AND ${col} <> ALL(${p(2)}::text[])))`,
    params: [
      exactIn,
      PREFIX_CATEGORY.filter(([, c]) => c === category).map(([pre]) => `${pre}%`),
      exactOut,
    ],
  };
}

export interface NotificationView {
  id: string;
  kind: string;
  category: NotificationCategory;
  actor: { id: string; username: string; displayName: string; avatarUrl: string | null } | null;
  targetType: string | null;
  targetId: string | null;
  data: Record<string, unknown>;
  read: boolean;
  createdAt: string;
}

export async function listNotifications(
  ctx: AppContext,
  userId: string,
  q: { category?: NotificationCategory; unread?: boolean; cursor?: string; limit?: number },
): Promise<{ items: NotificationView[]; nextCursor: string | null }> {
  const limit = clampLimit(q.limit);
  const cur = decodeCursor<{ t: string; id: string }>(q.cursor);
  const params: unknown[] = [userId, cur?.t ?? null, cur?.id ?? null, limit + 1];
  let where = '';
  if (q.category) {
    const f = categoryFilter(q.category, params.length + 1, 'n.kind');
    where += ` AND ${f.sql}`;
    params.push(...f.params);
  }
  if (q.unread) where += ' AND n.read_at IS NULL';
  const { rows } = await ctx.db.query(
    `SELECT n.id, n.kind, n.target_type, n.target_id, n.data, n.read_at, n.created_at, n.created_at::text AS created_raw,
            CASE WHEN n.actor_id IS NOT NULL AND NOT EXISTS (
                   SELECT 1 FROM user_blocks b WHERE (b.blocker_id = n.user_id AND b.blocked_id = n.actor_id) OR (b.blocker_id = n.actor_id AND b.blocked_id = n.user_id))
                 THEN n.actor_id END AS actor_id,
            p.username, p.display_name, p.avatar_url
       FROM notifications n LEFT JOIN profiles p ON p.user_id = n.actor_id
      WHERE n.user_id = $1 AND ($2::timestamptz IS NULL OR (n.created_at, n.id) < ($2::timestamptz, $3::uuid))${where}
      ORDER BY n.created_at DESC, n.id DESC LIMIT $4`,
    params,
  );
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return {
    items: items.map((r) => ({
      id: r.id,
      kind: r.kind,
      category: categoryFor(r.kind),
      // The actor is only shown while the recipient and actor have not blocked each other.
      actor:
        r.actor_id && r.username
          ? {
              id: r.actor_id,
              username: r.username,
              displayName: r.display_name,
              avatarUrl: r.avatar_url,
            }
          : null,
      targetType: r.target_type,
      targetId: r.target_id,
      data: r.data ?? {},
      read: r.read_at !== null,
      createdAt: new Date(r.created_at).toISOString(),
    })),
    nextCursor:
      rows.length > limit && last ? encodeCursor({ t: last.created_raw, id: last.id }) : null,
  };
}

export async function unreadCounts(
  ctx: AppContext,
  userId: string,
): Promise<{ total: number; byCategory: Record<NotificationCategory, number> }> {
  const { rows } = await ctx.db.query<{ kind: string; n: number }>(
    `SELECT kind, count(*)::int AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL GROUP BY kind`,
    [userId],
  );
  const byCategory = Object.fromEntries(NOTIFICATION_CATEGORIES.map((c) => [c, 0])) as Record<
    NotificationCategory,
    number
  >;
  let total = 0;
  for (const r of rows) {
    byCategory[categoryFor(r.kind)] += r.n;
    total += r.n;
  }
  return { total, byCategory };
}

export async function markRead(ctx: AppContext, userId: string, id: string): Promise<void> {
  const r = await ctx.db.query(
    'UPDATE notifications SET read_at = COALESCE(read_at, now()) WHERE id = $1 AND user_id = $2',
    [id, userId],
  );
  if (!r.rowCount) throw notFound('Notification');
}

export async function markAllRead(
  ctx: AppContext,
  userId: string,
  category?: NotificationCategory,
): Promise<number> {
  const params: unknown[] = [userId];
  let where = '';
  if (category) {
    const f = categoryFilter(category, 2);
    where = ` AND ${f.sql}`;
    params.push(...f.params);
  }
  const r = await ctx.db.query(
    `UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL${where}`,
    params,
  );
  return r.rowCount ?? 0;
}

export async function deleteNotification(
  ctx: AppContext,
  userId: string,
  id: string,
): Promise<void> {
  const r = await ctx.db.query('DELETE FROM notifications WHERE id = $1 AND user_id = $2', [
    id,
    userId,
  ]);
  if (!r.rowCount) throw notFound('Notification');
}

/** Retention job: notifications are not an archive. */
export async function purgeOldNotifications(ctx: AppContext, olderThanDays = 90): Promise<number> {
  const r = await ctx.db.query(
    `DELETE FROM notifications WHERE created_at < now() - make_interval(days => $1)`,
    [olderThanDays],
  );
  return r.rowCount ?? 0;
}

// ------------------------------------------------------------------ preferences

export interface PreferenceState {
  categories: Array<{
    category: NotificationCategory;
    label: string;
    inAppLocked: boolean;
    channels: Record<NotificationChannel, { enabled: boolean; default: boolean; custom: boolean }>;
  }>;
  overrides: Array<{
    kind: string;
    category: NotificationCategory;
    channel: NotificationChannel;
    enabled: boolean;
  }>;
}

export async function loadPreferences(ctx: AppContext, userId: string): Promise<PreferenceState> {
  const { rows } = await ctx.db.query<{
    kind: string;
    channel: NotificationChannel;
    enabled: boolean;
  }>(
    'SELECT kind, channel, enabled FROM notification_preferences WHERE user_id = $1 ORDER BY kind, channel',
    [userId],
  );
  const catRows = new Map(
    rows.filter((r) => isCategory(r.kind)).map((r) => [`${r.kind}:${r.channel}`, r.enabled]),
  );
  return {
    categories: NOTIFICATION_CATEGORIES.map((category) => ({
      category,
      label: CATEGORY_LABELS[category],
      inAppLocked: UNDISABLEABLE.has(category),
      channels: Object.fromEntries(
        NOTIFICATION_CHANNELS.map((ch) => {
          const def = DEFAULT_CHANNELS[category][ch];
          const custom = catRows.has(`${category}:${ch}`);
          const enabled =
            ch === 'in_app' && UNDISABLEABLE.has(category)
              ? true
              : (catRows.get(`${category}:${ch}`) ?? def);
          return [ch, { enabled, default: def, custom }];
        }),
      ) as Record<NotificationChannel, { enabled: boolean; default: boolean; custom: boolean }>,
    })),
    overrides: rows
      .filter((r) => !isCategory(r.kind))
      .map((r) => ({
        kind: r.kind,
        category: categoryFor(r.kind),
        channel: r.channel,
        enabled: r.enabled,
      })),
  };
}
