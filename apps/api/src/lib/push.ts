import webpush from 'web-push';
import type { Pool } from 'pg';
import type { Config } from '../config.ts';

export interface PushMessage {
  title: string;
  body: string;
  url?: string;
  tag?: string;
  /** Small string map for the app to act on (for example the call id on call_incoming). */
  data?: Record<string, string>;
}

export type PushSender = (userId: string, msg: PushMessage) => Promise<void>;

/**
 * Sends a notification to every device a person registered: browsers via Web Push
 * (VAPID), phones via Expo's push service. Dead subscriptions are removed.
 */
export function createPushSender(db: Pool, config: Config, fetchImpl: typeof fetch = fetch): PushSender {
  const vapid = !!(config.VAPID_PUBLIC_KEY && config.VAPID_PRIVATE_KEY);
  if (vapid) webpush.setVapidDetails(config.VAPID_SUBJECT, config.VAPID_PUBLIC_KEY, config.VAPID_PRIVATE_KEY);
  return async (userId, msg) => {
    const { rows } = await db.query(`SELECT id, kind, endpoint, keys FROM push_subscriptions WHERE user_id = $1`, [userId]);
    for (const s of rows) {
      try {
        if (s.kind === 'webpush' && vapid) {
          await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, JSON.stringify(msg), { TTL: 3600 });
        } else if (s.kind === 'expo') {
          const res = await fetchImpl('https://exp.host/--/api/v2/push/send', {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({
              to: s.endpoint,
              title: msg.title,
              body: msg.body,
              data: { url: msg.url, ...msg.data },
              // Incoming calls ring: high priority, a sound, the "calls" Android channel and
              // the call_incoming category (Answer / Decline actions) registered by the app.
              ...(msg.tag === 'call_incoming' ? { priority: 'high', sound: 'default', channelId: 'calls', categoryId: 'call_incoming', ttl: 45 } : {}),
            }),
          });
          const out = (await res.json().catch(() => ({}))) as { data?: { status?: string; details?: { error?: string } } };
          if (out.data?.details?.error === 'DeviceNotRegistered') throw Object.assign(new Error('gone'), { statusCode: 410 });
        } else continue;
        await db.query(`UPDATE push_subscriptions SET last_ok_at = now() WHERE id = $1`, [s.id]);
      } catch (e) {
        const code = (e as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410) await db.query(`DELETE FROM push_subscriptions WHERE id = $1`, [s.id]);
      }
    }
  };
}

const TEXT: Record<string, (actor: string) => string> = {
  follow: (a) => `${a} started following you`,
  friend_request: (a) => `${a} sent you a friend request`,
  friend_accepted: (a) => `${a} accepted your friend request`,
  post_reaction: (a) => `${a} liked your post`,
  post_comment: (a) => `${a} commented on your post`,
  event_rsvp: (a) => `${a} is going to your event`,
  call_incoming: (a) => `${a} is calling you`,
  live_started: (a) => `${a} is live now`,
  together_invite: (a) => `${a} invited you to a Together`,
  order_paid: () => 'You have a new paid order',
  booking_request: (a) => `${a} asked to book`,
  booking_decided: () => 'Your booking was updated',
  tip_received: (a) => `${a} sent you a tip`,
  post_repost: (a) => `${a} reposted your post`,
  post_mention: (a) => `${a} mentioned you in a post`,
  comment_mention: (a) => `${a} mentioned you in a comment`,
  family_invite: (a) => `${a} asked to supervise your account`,
  ad_approved: () => 'Your ad was approved',
  ad_rejected: () => "Your ad wasn't approved",
  family_accepted: (a) => `${a} accepted your family link`,
  family_ended: (a) => `${a} ended your family link`,
  family_controls_changed: (a) => `${a} changed your family settings`,
  subscription_started: (a) => `${a} subscribed to you`,
};

/** Human text for a notification type, or null for types that shouldn't push. */
export function pushTextFor(type: string, actorName: string | null): string | null {
  const f = TEXT[type];
  return f ? f(actorName ?? 'Someone') : null;
}
