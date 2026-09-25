import type { Pool, PoolClient } from 'pg';
import { FEATURE_FLAGS, type FeatureFlag } from '@yapilapi/shared';
import type { RealtimeHub } from './realtime.ts';
import { pushTextFor, type PushSender } from './push.ts';
import { activeControls } from './family.ts';

type Q = Pool | PoolClient;

/** Append-only audit trail for security- and moderation-relevant actions. */
export async function audit(
  db: Q,
  entry: { actorId?: string | null; action: string; entityType?: string; entityId?: string; ip?: string; requestId?: string; metadata?: object },
): Promise<void> {
  await db.query(`INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, ip, request_id, metadata) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [
    entry.actorId ?? null,
    entry.action,
    entry.entityType ?? null,
    entry.entityId ?? null,
    entry.ip ?? null,
    entry.requestId ?? null,
    entry.metadata ?? {},
  ]);
}

export async function securityEvent(db: Q, userId: string | null, type: string, ip?: string, userAgent?: string, metadata: object = {}) {
  await db.query(`INSERT INTO security_events (user_id, type, ip, user_agent, metadata) VALUES ($1,$2,$3,$4,$5)`, [
    userId,
    type,
    ip ?? null,
    userAgent ?? null,
    metadata,
  ]);
}

/**
 * Meaningful social actions (the North Star) are flagged so they can be counted
 * separately from passive engagement.
 */
const MEANINGFUL = new Set([
  'post_created',
  'comment_created',
  'message_sent',
  'follow',
  'friend_accepted',
  'community_joined',
  'event_rsvp_going',
  'order_paid',
  'moment_created',
]);

export function track(db: Q, userId: string | null, name: string, properties: object = {}): void {
  db.query(`INSERT INTO analytics_events (user_id, name, meaningful, properties) VALUES ($1,$2,$3,$4)`, [userId, name, MEANINGFUL.has(name), properties]).catch(
    () => {
      /* analytics must never break a request */
    },
  );
}

/** Create a notification unless the recipient disabled the category or paused notifications. */
export async function notify(
  db: Q,
  realtime: RealtimeHub,
  n: { userId: string; category: string; type: string; actorId?: string; entityType?: string; entityId?: string; data?: object },
): Promise<void> {
  if (n.actorId && n.actorId === n.userId) return;
  const prefs = await db.query<{ notification_categories: Record<string, boolean>; notifications_paused_until: Date | null; focus_mode: boolean }>(
    `SELECT notification_categories, notifications_paused_until, focus_mode FROM user_preferences WHERE user_id = $1`,
    [n.userId],
  );
  const p = prefs.rows[0];
  if (p?.notification_categories?.[n.category] === false) return;
  if (n.actorId) {
    const blocked = await db.query(
      `SELECT 1 FROM blocks WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)
       UNION ALL SELECT 1 FROM mutes WHERE muter_id = $1 AND muted_id = $2`,
      [n.userId, n.actorId],
    );
    if (blocked.rowCount) return;
  }
  const { rows } = await db.query<{ id: string; created_at: Date }>(
    `INSERT INTO notifications (user_id, category, type, actor_id, entity_type, entity_id, data)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, created_at`,
    [n.userId, n.category, n.type, n.actorId ?? null, n.entityType ?? null, n.entityId ?? null, n.data ?? {}],
  );
  // Security notifications always go out; others respect a pause.
  const paused = p?.notifications_paused_until && p.notifications_paused_until > new Date() && n.category !== 'security';
  if (paused) return;
  await realtime.publish([n.userId], { type: 'notification.created', data: { id: rows[0]!.id, category: n.category, type: n.type } });
  // Push to devices, except when the person is in focus mode. Fire and forget.
  // A supervised teen's quiet hours hold pushes too; the notification still lands in the inbox.
  if (pushSender && !p?.focus_mode && !(n.category !== 'security' && (await activeControls(db, n.userId))?.quietNow)) {
    const text = pushTextFor(
      n.type,
      n.actorId ? ((await db.query(`SELECT display_name FROM profiles WHERE user_id = $1`, [n.actorId])).rows[0]?.display_name ?? null) : null,
    );
    const data: Record<string, string> = { type: n.type };
    if (n.entityType) data.entityType = n.entityType;
    if (n.entityId) data.entityId = n.entityId;
    if (text) void pushSender(n.userId, { title: 'YAPILAPI', body: text, tag: n.type, url: '/notifications', data }).catch(() => {});
  }
}

let pushSender: PushSender | null = null;
/** Called once at startup with the configured push sender. */
export function setPushSender(sender: PushSender | null) {
  pushSender = sender;
}

export async function getFlags(db: Q): Promise<Record<FeatureFlag, boolean>> {
  const { rows } = await db.query<{ key: string; enabled: boolean }>(`SELECT key, enabled FROM feature_flags`);
  const out = Object.fromEntries(Object.entries(FEATURE_FLAGS).map(([k, v]) => [k, v.default])) as Record<FeatureFlag, boolean>;
  for (const r of rows) if (r.key in out) out[r.key as FeatureFlag] = r.enabled;
  return out;
}

export async function isEnabled(db: Q, flag: FeatureFlag): Promise<boolean> {
  return (await getFlags(db))[flag];
}
