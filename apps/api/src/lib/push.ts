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

/** A Together album's title, in quotes. */
const album = (d: Record<string, unknown>) => `“${String(d.title ?? '')}”`;

/** "12 photos", "a video", "5 photos and videos": what someone added to a Together album. */
function addedWhat(d: Record<string, unknown>): string {
  const n = Math.max(1, Number(d.count ?? 1));
  const videos = Number(d.videos ?? 0);
  if (!videos) return n === 1 ? 'a photo' : `${n} photos`;
  if (videos >= n) return n === 1 ? 'a video' : `${n} videos`;
  return `${n} photos and videos`;
}

const TEXT: Record<string, (actor: string, data: Record<string, unknown>) => string> = {
  follow: (a) => `${a} started following you`,
  friend_request: (a) => `${a} sent you a friend request`,
  friend_accepted: (a) => `${a} accepted your friend request`,
  post_reaction: (a) => `${a} liked your post`,
  post_comment: (a) => `${a} commented on your post`,
  event_rsvp: (a) => `${a} is going to your event`,
  event_updated: (a) => `${a} changed the time or place of an event you're going to`,
  call_incoming: (a) => `${a} is calling you`,
  live_started: (a) => `${a} is live now`,
  room_live: () => 'A room you asked about has started',
  together_invite: (a, d) => (d.title ? `${a} added you to the shared album ${album(d)}` : `${a} invited you to a Together`),
  // Together albums: additions are coalesced (lib/together.ts, noticeAdded) and stars batched, so each pushes once.
  together_added: (a, d) => `${a} added ${addedWhat(d)} to ${album(d)}`,
  together_starred: (a, d) => `${a} starred your photo in ${album(d)}`,
  together_closing: (_a, d) => `${album(d)} closes in an hour. Add your last photos`,
  together_closed: (_a, d) => `${album(d)} is closed. Look back at the best of it`,
  together_request: (a, d) => `${a} asked to join ${album(d)}`,
  together_approved: (_a, d) => `You're in ${album(d)}`,
  order_paid: () => 'You have a new paid order',
  booking_request: (a) => `${a} asked to book`,
  booking_decided: () => 'Your booking was updated',
  tip_received: (a) => `${a} sent you a tip`,
  post_repost: (a) => `${a} reposted your post`,
  reel_duet: (a) => `${a} made a duet with your reel`,
  reel_remix: (a) => `${a} remixed your reel`,
  post_mention: (a) => `${a} mentioned you in a post`,
  comment_mention: (a) => `${a} mentioned you in a comment`,
  comment_like: (a) => `${a} liked your comment`,
  comment_reply: (a) => `${a} replied to your comment`,
  collab_invite: (a) => `${a} invited you to co-author a post`,
  collab_accepted: (a) => `${a} accepted your invite to co-author your post`,
  photo_tag: (a) => `${a} tagged you in a photo`,
  story_mention: (a) => `${a} mentioned you in their story`,
  story_reshare: (a) => `${a} added your story to theirs`,
  story_countdown: () => 'A countdown you asked about has ended',
  family_invite: (a) => `${a} asked to supervise your account`,
  ad_approved: () => 'Your ad was approved',
  ad_rejected: () => "Your ad wasn't approved",
  family_accepted: (a) => `${a} accepted your family link`,
  family_ended: (a) => `${a} ended your family link`,
  family_controls_changed: (a) => `${a} changed your family settings`,
  subscription_started: (a) => `${a} subscribed to you`,
  invite_joined: (a) => `${a} joined YAPILAPI with your invite`,
  plus_referral_reward: () => 'You have 30 more days of YAPILAPI Plus, thanks to friends you invited',
  media_blocked: () => "A photo or video you shared wasn't posted. Our team will check it",
  media_restored: () => 'Your photo or video is back up after review',
  account_limited: () => 'Your account is limited while our team reviews some recent activity',
  account_review: () => 'Our team finished reviewing your account',
  chapter_invite: (a) => `${a} invited you to add stories to a chapter`,
  // Posts added to a shared board are batched in the inbox and never pushed.
  board_invite: (a) => `${a} invited you to add to a board`,
  chapter_opened: () => 'A time capsule you are part of has opened',
  yap_received: (a) => `${a} sent you a Yap`,
  view_once_screenshot: (a) => `${a} took a screenshot of your view-once photo or video`,
  // A reminder you set yourself on a chat message (there is no one else in it).
  chat_reminder: () => 'You asked to be reminded about a message',
  scheduled_post_failed: () => "A scheduled post couldn't be published. It's back in your drafts",
  scheduled_message_failed: () => "A message you scheduled couldn't be sent",
  new_sign_in: () => 'New sign-in to your account from a device we haven’t seen before',
  recap_ready: () => 'Your recap video is ready',
  recap_failed: () => "We couldn't make your recap video",
  watch_invite: (a) => `${a} wants to watch together`,
  weekly_wrap: () => 'Your week in YAPILAPI is ready to look back on',
  // Questions asked without a name have no actor, so they read "Someone asked you a question".
  question_received: (a) => `${a} asked you a question`,
  question_answered: (a) => `${a} answered your question`,
  drop_opened: (a) => `A drop from ${a} you asked about is open`,
  drop_cancelled: (a) => `${a} cancelled a drop you were waiting for`,
  drop_sold_out: () => 'Everything in your drop has sold',
};

/** Human text for a notification type, or null for types that shouldn't push. `data` is the notification's data. */
export function pushTextFor(type: string, actorName: string | null, data: object = {}): string | null {
  const f = TEXT[type];
  return f ? f(actorName ?? 'Someone', data as Record<string, unknown>) : null;
}
