import type { Queryable } from '@yapilapi/database';
import type { AppContext } from './context.js';

/**
 * Notification categories, the single mapping from notification `kind` to category, default channel settings, and the
 * delivery decision (`shouldDeliver`) that lib/notify.ts calls for every notification.
 *
 * Rules (all enforced in `decideDelivery`, which is pure and unit tested):
 *  - in_app: the notification row is always stored unless the user turned that kind/category off. Security and
 *    moderation notifications can never be turned off in-app.
 *  - push/email: additionally suppressed by quiet hours, an active pause and focus mode. Security and moderation are
 *    urgent and bypass quiet hours / pause / focus.
 *  - Teen accounts get default quiet hours (22:00-07:00) unless they set their own.
 *  - A preference for the exact kind wins over a preference for its category.
 */

export const NOTIFICATION_CATEGORIES = [
  'messages',
  'friends',
  'creators',
  'communities',
  'events',
  'commerce',
  'security',
  'moderation',
  'system',
] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];
export const NOTIFICATION_CHANNELS = ['in_app', 'push', 'email'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

/** Categories whose in-app channel can never be disabled (users must always be able to see them). */
export const UNDISABLEABLE: ReadonlySet<NotificationCategory> = new Set(['security', 'moderation']);
/** Categories that bypass quiet hours, pause and focus mode. */
export const URGENT: ReadonlySet<NotificationCategory> = new Set(['security', 'moderation']);

/** THE mapping from notification kind to category. Add new kinds here. */
export const KIND_CATEGORY: Record<string, NotificationCategory> = {
  // graph
  follow: 'friends',
  follow_request: 'friends',
  follow_accepted: 'friends',
  friend_request: 'friends',
  friend_accepted: 'friends',
  // Real / Real Together (docs/product/real.md): invitations and reminders are personal, reactions and contributions are content activity
  real_reminder: 'friends',
  together_invite: 'friends',
  together_joined: 'friends',
  real_reaction: 'creators',
  together_contribution: 'creators',
  // reactions on your content
  reaction: 'creators',
  comment: 'creators',
  reply: 'creators',
  moment_reaction: 'creators',
  mention: 'creators',
  // messaging
  message: 'messages',
  plan_rsvp: 'messages',
  call_missed: 'messages',
  // communities
  community_invite: 'communities',
  community_join_request: 'communities',
  community_request_approved: 'communities',
  community_post_approved: 'communities',
  community_role_changed: 'communities',
  community_ownership: 'communities',
  community_removed: 'communities',
  community_banned: 'moderation',
  community_content_removed: 'moderation',
  // events
  event_invitation: 'events',
  event_cohost_added: 'events',
  event_updated: 'events',
  event_cancelled: 'events',
  event_reminder: 'events',
  event_waitlist_promoted: 'events',
  // commerce
  booking_requested: 'commerce',
  booking_confirmed: 'commerce',
  booking_cancelled: 'commerce',
  review_reply: 'commerce',
  business_team_invitation: 'commerce',
  business_team_removed: 'commerce',
  business_role_changed: 'commerce',
  business_ownership_received: 'commerce',
  business_verified: 'commerce',
  business_unverified: 'commerce',
  business_suspended: 'commerce',
  business_reinstated: 'commerce',
  // safety / moderation
  moderation_decision: 'moderation',
  moderation_appeal_result: 'moderation',
  moderation_appeal_received: 'moderation',
  account_suspended: 'moderation',
  account_reinstated: 'moderation',
  safety_support: 'moderation',
  report_update: 'moderation',
  // security & privacy
  guardian_invitation: 'security',
  guardian_accepted: 'security',
  guardian_revoked: 'security',
  oauth_app_authorized: 'security',
  security_alert: 'security',
  login_new_device: 'security',
  privacy_export_ready: 'system',
  deletion_completed: 'system',
  webhook_endpoint_disabled: 'system',
  mini_app_review: 'system',
  // staff actions on things you own or hold
  community_suspended: 'moderation',
  community_restored: 'moderation',
  creator_suspended: 'moderation',
  creator_reinstated: 'moderation',
  role_changed: 'security',
};

export const PREFIX_CATEGORY: Array<[string, NotificationCategory]> = [
  ['event_', 'events'],
  ['community_', 'communities'],
  ['booking_', 'commerce'],
  ['business_', 'commerce'],
  ['place_', 'commerce'],
  ['order_', 'commerce'],
  ['payment_', 'commerce'],
  ['moderation_', 'moderation'],
  ['security_', 'security'],
  ['message_', 'messages'],
];

export function categoryFor(kind: string): NotificationCategory {
  const exact = KIND_CATEGORY[kind];
  if (exact) return exact;
  for (const [prefix, cat] of PREFIX_CATEGORY) if (kind.startsWith(prefix)) return cat;
  return 'system';
}

/** Defaults when the user has not chosen anything. */
export const DEFAULT_CHANNELS: Record<
  NotificationCategory,
  Record<NotificationChannel, boolean>
> = {
  messages: { in_app: true, push: true, email: false },
  friends: { in_app: true, push: true, email: false },
  creators: { in_app: true, push: false, email: false },
  communities: { in_app: true, push: false, email: false },
  events: { in_app: true, push: true, email: false },
  commerce: { in_app: true, push: true, email: false },
  security: { in_app: true, push: true, email: true },
  moderation: { in_app: true, push: true, email: true },
  system: { in_app: true, push: false, email: false },
};

/** Generic push copy per category. Deliberately content-free (lock screens are public). */
export const PUSH_COPY: Record<NotificationCategory, { title: string; body: string }> = {
  messages: { title: 'New message', body: 'Open YAPILAPI to read it.' },
  friends: { title: 'New activity from people you know', body: 'Open YAPILAPI to see it.' },
  creators: { title: 'Someone interacted with your post', body: 'Open YAPILAPI to see it.' },
  communities: { title: 'Community update', body: 'Open YAPILAPI to see it.' },
  events: { title: 'Event update', body: 'Open YAPILAPI to see the details.' },
  commerce: { title: 'Update on your order or booking', body: 'Open YAPILAPI to see the details.' },
  security: {
    title: 'Security notice',
    body: 'Open YAPILAPI to review this activity on your account.',
  },
  moderation: { title: 'Important notice about your account', body: 'Open YAPILAPI to read it.' },
  system: { title: 'YAPILAPI', body: 'You have a new notification.' },
};

export interface DeliveryContext {
  category: NotificationCategory;
  /** Explicit preference rows: exact-kind first, then category. `undefined` = not set. */
  prefs: Partial<Record<NotificationChannel, boolean>>;
  quietHours: { start: number | null; end: number | null };
  timezone: string;
  focusMode: boolean;
  pausedUntil: Date | null;
  ageBand: 'teen' | 'adult';
  now: Date;
}

export interface DeliveryDecision {
  inApp: boolean;
  push: boolean;
  email: boolean;
  category: NotificationCategory;
  /** Why push/email were suppressed (for tests and support), if they were. */
  suppressedBy: 'quiet_hours' | 'paused' | 'focus_mode' | null;
}

export const TEEN_QUIET_HOURS = { start: 22 * 60, end: 7 * 60 } as const;

/** Local minutes-since-midnight for `now` in `timeZone` (falls back to UTC for an invalid zone). */
export function localMinutes(now: Date, timeZone: string): number {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now);
  } catch {
    parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'UTC',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now);
  }
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  return (h % 24) * 60 + m;
}

/** True when `minute` falls in [start, end); windows may wrap past midnight. start === end means "no quiet hours". */
export function inQuietWindow(minute: number, start: number | null, end: number | null): boolean {
  if (start === null || end === null || start === end) return false;
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}

export function decideDelivery(c: DeliveryContext): DeliveryDecision {
  const chan = (ch: NotificationChannel) => c.prefs[ch] ?? DEFAULT_CHANNELS[c.category][ch];
  let inApp = chan('in_app');
  let push = chan('push');
  let email = chan('email');
  if (UNDISABLEABLE.has(c.category)) inApp = true;

  let suppressedBy: DeliveryDecision['suppressedBy'] = null;
  if (!URGENT.has(c.category) && (push || email)) {
    const custom = c.quietHours.start !== null && c.quietHours.end !== null;
    const window = custom
      ? c.quietHours
      : c.ageBand === 'teen'
        ? TEEN_QUIET_HOURS
        : { start: null, end: null };
    if (c.pausedUntil && c.pausedUntil.getTime() > c.now.getTime()) suppressedBy = 'paused';
    else if (c.focusMode) suppressedBy = 'focus_mode';
    else if (inQuietWindow(localMinutes(c.now, c.timezone), window.start, window.end))
      suppressedBy = 'quiet_hours';
    if (suppressedBy) {
      push = false;
      email = false;
    }
  }
  return { inApp, push, email, category: c.category, suppressedBy };
}

interface PolicyRow {
  quiet_hours_start: number | null;
  quiet_hours_end: number | null;
  timezone: string | null;
  focus_mode: boolean | null;
  notifications_paused_until: Date | null;
  age_band: 'teen' | 'adult';
}

/**
 * THE delivery decision for one notification to one user. Called by notify() for every notification; use it anywhere
 * else that wants to reach a user through push or email so the same rules apply.
 */
export async function shouldDeliver(
  ctx: Pick<AppContext, 'db'>,
  userId: string,
  kind: string,
  now: Date = new Date(),
  db: Queryable = ctx.db,
): Promise<DeliveryDecision> {
  const category = categoryFor(kind);
  const [prefRows, userRows] = await Promise.all([
    db.query<{ kind: string; channel: NotificationChannel; enabled: boolean }>(
      `SELECT kind, channel, enabled FROM notification_preferences WHERE user_id = $1 AND kind = ANY($2::text[])`,
      [userId, [kind, category]],
    ),
    db.query<PolicyRow>(
      `SELECT up.quiet_hours_start, up.quiet_hours_end, COALESCE(up.timezone, u.timezone) AS timezone, up.focus_mode,
              up.notifications_paused_until, u.age_band
         FROM users u LEFT JOIN user_preferences up ON up.user_id = u.id WHERE u.id = $1`,
      [userId],
    ),
  ]);
  const prefs: DeliveryContext['prefs'] = {};
  // category rows first, exact-kind rows override
  for (const r of prefRows.rows.filter((x) => x.kind !== kind)) prefs[r.channel] = r.enabled;
  for (const r of prefRows.rows.filter((x) => x.kind === kind)) prefs[r.channel] = r.enabled;
  const u = userRows.rows[0];
  return decideDelivery({
    category,
    prefs,
    quietHours: { start: u?.quiet_hours_start ?? null, end: u?.quiet_hours_end ?? null },
    timezone: u?.timezone ?? 'UTC',
    focusMode: u?.focus_mode ?? false,
    pausedUntil: u?.notifications_paused_until ?? null,
    ageBand: u?.age_band ?? 'adult',
    now,
  });
}
