import type { Pool, PoolClient } from 'pg';
import { FEATURE_FLAGS, type FeatureFlag } from '@yapilapi/shared';
import type { RealtimeHub } from './realtime.ts';
import { pushTextFor, type PushSender } from './push.ts';
import { activeControls } from './family.ts';
import { inQuietHours } from './interactions.ts';
import { deliverable, securityEmail, SECURITY_EMAILS, type EmailSender } from './email.ts';

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
  if (userId && SECURITY_EMAILS[type]) securityMailerFn?.(userId, type);
}

type SecurityMailer = (userId: string, type: string) => void;
let securityMailerFn: SecurityMailer | null = null;
/** Called once at startup: security events listed in SECURITY_EMAILS also email the account. */
export function setSecurityMailer(mailer: SecurityMailer | null) {
  securityMailerFn = mailer;
}
/** On shutdown: stop using this app's mailer (another app in the same process may have replaced it). */
export function unsetSecurityMailer(mailer: SecurityMailer) {
  if (securityMailerFn === mailer) securityMailerFn = null;
}

/**
 * Emails a security notice to the account's current address, in the background: a slow or
 * failing mail server never holds up or fails the request. Failures are logged.
 */
export function securityMailer(
  deps: { db: Pool; email: EmailSender; config: { WEB_ORIGIN: string } },
  log: { warn(obj: object, msg: string): void },
): SecurityMailer {
  return (userId, type) => {
    void (async () => {
      const { rows } = await deps.db.query<{ email: string }>(`SELECT email FROM users WHERE id = $1 AND status <> 'deleted'`, [userId]);
      const to = rows[0]?.email;
      if (!deliverable(to)) return;
      const mail = securityEmail(type, to, deps.config.WEB_ORIGIN);
      if (mail) await deps.email.send(mail);
    })().catch((err: Error) => log.warn({ err: err.message, type }, 'security email not sent'));
  };
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

/**
 * Record a product analytics event. Nothing is recorded for someone who turned "Analytics" off
 * in Settings (Privacy): the consent is checked in the same statement, so there is no window.
 * Returns when the write has finished; callers normally don't wait for it.
 */
export function track(db: Q, userId: string | null, name: string, properties: object = {}): Promise<void> {
  return db
    .query(
      `INSERT INTO analytics_events (user_id, name, meaningful, properties)
       SELECT $1, $2, $3, $4
       WHERE $1::uuid IS NULL OR NOT EXISTS (SELECT 1 FROM consents WHERE user_id = $1 AND purpose = 'analytics' AND NOT granted)`,
      [userId, name, MEANINGFUL.has(name), properties],
    )
    .then(
      () => undefined,
      () => {
        /* analytics must never break a request */
      },
    );
}

/**
 * Whether recommendations may use what we know about this person (interests, feedback, who they
 * follow and talk to). Off when they turned "Personalization" off in Settings (Privacy): For you,
 * Reels and suggestions then rank the same way for everyone. On when never set.
 */
export async function personalizationAllowed(db: Q, userId: string): Promise<boolean> {
  const { rows } = await db.query<{ granted: boolean }>(`SELECT granted FROM consents WHERE user_id = $1 AND purpose = 'personalization'`, [userId]);
  return rows[0]?.granted ?? true;
}

/**
 * Create a notification unless the recipient disabled the category or paused notifications.
 * With `group`, it joins an unread notification of the same type and group from the last day
 * instead ("Ada and 3 others liked your comment"): the newest person becomes its actor,
 * `data.count` says how many people, and it isn't pushed again. The same person counts once.
 */
export async function notify(
  db: Q,
  realtime: RealtimeHub,
  n: { userId: string; category: string; type: string; actorId?: string; entityType?: string; entityId?: string; data?: object; group?: string },
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
  if (n.group && n.actorId) {
    const open = await db.query<{ id: string; actors: string[] }>(
      `SELECT id, coalesce(data->'actors', '[]'::jsonb) AS actors FROM notifications
       WHERE user_id = $1 AND type = $2 AND data->>'group' = $3 AND read_at IS NULL AND created_at > now() - interval '1 day'
       ORDER BY created_at DESC LIMIT 1`,
      [n.userId, n.type, n.group],
    );
    const row = open.rows[0];
    if (row) {
      if (row.actors.includes(n.actorId)) return;
      await db.query(
        `UPDATE notifications SET actor_id = $2, created_at = now(),
                data = data || jsonb_build_object('count', $3::int, 'actors', $4::jsonb)
         WHERE id = $1`,
        [row.id, n.actorId, row.actors.length + 1, JSON.stringify([...row.actors, n.actorId].slice(-50))],
      );
      const pausedNow = p?.notifications_paused_until && p.notifications_paused_until > new Date();
      if (!pausedNow) await realtime.publish([n.userId], { type: 'notification.created', data: { id: row.id, category: n.category, type: n.type } });
      return;
    }
  }
  const data = n.group && n.actorId ? { ...(n.data ?? {}), group: n.group, count: 1, actors: [n.actorId] } : (n.data ?? {});
  const { rows } = await db.query<{ id: string; created_at: Date }>(
    `INSERT INTO notifications (user_id, category, type, actor_id, entity_type, entity_id, data)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, created_at`,
    [n.userId, n.category, n.type, n.actorId ?? null, n.entityType ?? null, n.entityId ?? null, data],
  );
  // Security notifications always go out; others respect a pause.
  const paused = p?.notifications_paused_until && p.notifications_paused_until > new Date() && n.category !== 'security';
  if (paused) return;
  await realtime.publish([n.userId], { type: 'notification.created', data: { id: rows[0]!.id, category: n.category, type: n.type } });
  // Push to devices, except when the person is in focus mode. Fire and forget.
  // A supervised teen's quiet hours, and the person's own, hold pushes too; the notification still lands in the inbox.
  if (pushSender && !p?.focus_mode && !(n.category !== 'security' && ((await activeControls(db, n.userId))?.quietNow || (await inQuietHours(db, n.userId))))) {
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
