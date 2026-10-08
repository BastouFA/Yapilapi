import webpush from 'web-push';
import type { Pool } from 'pg';
// Every language, loaded up front: a push is written in its recipient's.
import { t, tp, type MessageKey } from '@yapilapi/shared/i18n';
import { messagePreviewText, milestoneNoticeText, type MessagePreview } from '@yapilapi/shared';
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
 * What the Yap phone app (apps/yap, a messenger on its own) is sent: chats and calls, and sign-in
 * alerts, which go to every device. Phones running Yap register with `app: 'yap'`
 * (modules/push.ts); everything else goes to YAPILAPI and the browser only.
 */
export const YAP_APP_PUSH_TYPES: ReadonlySet<string> = new Set([
  'message',
  'call_incoming',
  'yap_received',
  'view_once_screenshot',
  'chat_reminder',
  'scheduled_message_failed',
  'location_shared',
  'market_offer',
  'market_offer_accepted',
  'market_offer_declined',
  'market_offer_countered',
  'new_sign_in',
]);

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
          const yap = s.keys?.app === 'yap';
          // The notification's type (a new message's tag also names its chat).
          if (yap && !YAP_APP_PUSH_TYPES.has(msg.data?.type ?? msg.tag ?? '')) continue;
          const res = await fetchImpl('https://exp.host/--/api/v2/push/send', {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({
              to: s.endpoint,
              title: yap ? 'Yap' : msg.title,
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

type Data = Record<string, unknown>;
type Text = (name: string, d: Data, locale: string) => string;

/** A sentence from the catalog with the person's name ({name}) and nothing else to fill in. */
const say =
  (key: MessageKey): Text =>
  (name, _d, locale) =>
    t(key, locale, { name });

/** A Together album's title ({title}; each catalog puts it in its language's own quotes). */
const albumTitle = (d: Data) => String(d.title ?? '');

/** "Ada added 12 photos to “Lagos weekend”", "a video", "5 photos and videos": what someone added to a Together album. */
function addedText(name: string, d: Data, locale: string): string {
  const count = Math.max(1, Number(d.count ?? 1) || 1);
  const videos = Number(d.videos ?? 0) || 0;
  const vars = { name, title: albumTitle(d) };
  if (!videos) return tp('push.together_added.photos', count, locale, vars);
  if (videos >= count) return tp('push.together_added.videos', count, locale, vars);
  return t('push.together_added', locale, { ...vars, count });
}

/** A Market listing's title, or a stand-in when a notification has none. */
function listing(d: Data, fallback: MessageKey, locale: string): string {
  return typeof d.title === 'string' && d.title ? d.title : t(fallback, locale);
}
/**
 * A new message (lib/message-push.ts): "Ada: See you at six", "Ada in Family: Photo", or "Ada: 3 new
 * messages" once several came in. `d.preview` is the message as the recipient sees it, `d.chat` a
 * group's name, `d.private` a disappearing message, `d.transcript` a voice note's first words
 * ("Ada: Voice message: See you at six").
 */
function messageText(name: string, d: Data, locale: string): string {
  const count = Math.max(1, Number(d.count ?? 1) || 1);
  const preview = d.preview as MessagePreview | undefined;
  const text =
    count > 1 || !preview
      ? tp('push.message.count', count, locale)
      : typeof d.transcript === 'string' && d.transcript && !d.private && !preview.viewOnce
        ? t('push.message.voice', locale, { text: d.transcript })
        : messageLine(preview, !!d.private, locale);
  const chat = typeof d.chat === 'string' && d.chat ? d.chat : null;
  return chat ? t('push.message.group', locale, { name, group: chat, text }) : t('push.message', locale, { name, text });
}

/**
 * One message, as the chat list says it (a photo, a poll, a reply to your story), shortened. A
 * disappearing message only says what it is ("Photo", "Voice message", "New message"), never its
 * words, a poll's question or a title; view once already never says more.
 */
function messageLine(p: MessagePreview, hidden: boolean, locale: string): string {
  const tr = { t: (key: MessageKey, vars?: Record<string, string | number>) => t(key, locale, vars), locale };
  if (hidden) {
    if (p.viewOnce || p.yap || p.kind === 'location' || p.kind === 'game') return messagePreviewText(p, tr);
    if (!p.kind && !p.storyReply && p.attachmentKind) return messagePreviewText({ ...p, body: '' }, tr);
    return tp('push.message.count', 1, locale);
  }
  const line = [...messagePreviewText(p, tr).replace(/\s+/g, ' ').trim()];
  return line.length > 100 ? `${line.slice(0, 99).join('').trimEnd()}…` : line.join('');
}

/** The stand-in at the start of a sentence ("Your listing ends in 3 days"). */
const capitalized = (s: string, locale: string) => (s ? s[0]!.toLocaleUpperCase(locale) + s.slice(1) : s);

const TEXT: Record<string, Text> = {
  follow: say('push.follow'),
  friend_request: say('push.friend_request'),
  friend_accepted: say('push.friend_accepted'),
  follow_request: say('push.follow_request'),
  follow_accepted: say('push.follow_accepted'),
  post_reaction: say('push.post_reaction'),
  post_comment: say('push.post_comment'),
  event_rsvp: say('push.event_rsvp'),
  event_updated: say('push.event_updated'),
  event_waitlist_in: say('push.event_waitlist_in'),
  ticket_received: say('push.ticket_received'),
  event_cohost: say('push.event_cohost'),
  call_incoming: say('push.call_incoming'),
  live_started: say('push.live_started'),
  room_live: say('push.room_live'),
  together_invite: (name, d, locale) =>
    d.title ? t('push.together_invite.album', locale, { name, title: albumTitle(d) }) : t('push.together_invite', locale, { name }),
  // Together albums: additions are coalesced (lib/together.ts, noticeAdded) and stars batched, so each pushes once.
  together_added: addedText,
  together_starred: (name, d, locale) => t('push.together_starred', locale, { name, title: albumTitle(d) }),
  together_closing: (_n, d, locale) => t('push.together_closing', locale, { title: albumTitle(d) }),
  together_closed: (_n, d, locale) => t('push.together_closed', locale, { title: albumTitle(d) }),
  together_request: (name, d, locale) => t('push.together_request', locale, { name, title: albumTitle(d) }),
  together_approved: (_n, d, locale) => t('push.together_approved', locale, { title: albumTitle(d) }),
  order_paid: say('push.order_paid'),
  booking_request: say('push.booking_request'),
  booking_decided: say('push.booking_decided'),
  tip_received: say('push.tip_received'),
  payout_paid: say('push.payout_paid'),
  payout_failed: say('push.payout_failed'),
  post_repost: say('push.post_repost'),
  reel_duet: say('push.reel_duet'),
  reel_remix: say('push.reel_remix'),
  // Echoes of one reel are batched (lib/echoes.ts), so this pushes for the first one only.
  reel_echo: say('push.reel_echo'),
  // Pass the Mic: batched per chain (lib/chains.ts), so each chain pushes once until it's read.
  chain_link: say('push.chain_link'),
  chain_next: say('push.chain_next'),
  chain_pass: say('push.chain_pass'),
  // The report is in the app; the push says it's ready.
  fair_start_done: (_n, d, locale) => t(d.format === 'yap' ? 'push.fair_start_done_yap' : 'push.fair_start_done', locale),
  // Squads. New posts are batched per squad, so each squad pushes once until it's read.
  squad_invite: (name, d, locale) => t('push.squad_invite', locale, { name, squad: String(d.name ?? '') }),
  squad_joined: (name, d, locale) => t('push.squad_joined', locale, { name, squad: String(d.name ?? '') }),
  squad_post: (name, d, locale) => t('push.squad_post', locale, { name, squad: String(d.name ?? '') }),
  squad_memory: (_n, d, locale) => t('push.squad_memory', locale, { squad: String(d.name ?? '') }),
  post_mention: say('push.post_mention'),
  comment_mention: say('push.comment_mention'),
  comment_like: say('push.comment_like'),
  comment_reply: say('push.comment_reply'),
  collab_invite: say('push.collab_invite'),
  collab_accepted: say('push.collab_accepted'),
  photo_tag: say('push.photo_tag'),
  story_mention: say('push.story_mention'),
  story_reshare: say('push.story_reshare'),
  story_countdown: say('push.story_countdown'),
  family_invite: say('push.family_invite'),
  ad_approved: say('push.ad_approved'),
  ad_rejected: say('push.ad_rejected'),
  // A Mini App's review: the reason, when the admin gave one, is in the app, not on the lock screen.
  mini_app_approved: say('push.mini_app_approved'),
  mini_app_rejected: say('push.mini_app_rejected'),
  family_accepted: say('push.family_accepted'),
  family_ended: say('push.family_ended'),
  family_controls_changed: say('push.family_controls_changed'),
  subscription_started: say('push.subscription_started'),
  invite_joined: say('push.invite_joined'),
  plus_referral_reward: (_n, d, locale) => tp('push.plus_referral_reward', Number(d.days) || 30, locale),
  media_blocked: say('push.media_blocked'),
  media_restored: say('push.media_restored'),
  account_limited: say('push.account_limited'),
  account_review: say('push.account_review'),
  // What happened is in the app, in the reader's language; the push only says there's an answer.
  report_outcome: say('push.report_outcome'),
  // A decision about your own things, and the answer to an appeal: what it was is in the app, never on the lock screen.
  enforcement: say('push.enforcement'),
  appeal_decided: say('push.appeal_decided'),
  chapter_invite: say('push.chapter_invite'),
  // Posts added to a shared board are batched in the inbox and never pushed.
  board_invite: say('push.board_invite'),
  chapter_opened: say('push.chapter_opened'),
  // New messages in a chat: one per chat while unread, saying how many (lib/message-push.ts).
  message: messageText,
  yap_received: say('push.yap_received'),
  view_once_screenshot: say('push.view_once_screenshot'),
  // A reminder you set yourself on a chat message (there is no one else in it).
  chat_reminder: say('push.chat_reminder'),
  scheduled_post_failed: say('push.scheduled_post_failed'),
  scheduled_message_failed: say('push.scheduled_message_failed'),
  new_sign_in: say('push.new_sign_in'),
  recap_ready: say('push.recap_ready'),
  recap_failed: say('push.recap_failed'),
  watch_invite: say('push.watch_invite'),
  // Quiet: no sound, like every push but calls. Never says where.
  location_shared: say('push.location_shared'),
  // Market (never an amount on a lock screen).
  market_offer: (name, d, locale) => t('push.market_offer', locale, { name, title: listing(d, 'push.market.yourListing', locale) }),
  market_offer_accepted: (name, d, locale) => t('push.market_offer_accepted', locale, { name, title: listing(d, 'push.market.aListing', locale) }),
  market_offer_declined: (name, d, locale) => t('push.market_offer_declined', locale, { name, title: listing(d, 'push.market.aListing', locale) }),
  market_offer_countered: (name, d, locale) => t('push.market_offer_countered', locale, { name, title: listing(d, 'push.market.aListing', locale) }),
  market_sold_to_you: (name, d, locale) => t('push.market_sold_to_you', locale, { name, title: listing(d, 'push.market.aListing', locale) }),
  market_rated: (name, d, locale) => t('push.market_rated', locale, { name, title: listing(d, 'push.market.aSale', locale) }),
  market_expiring: (_n, d, locale) =>
    tp('push.market_expiring', Number(d.days ?? 3), locale, { title: capitalized(listing(d, 'push.market.yourListing', locale), locale) }),
  market_expired: (_n, d, locale) => t('push.market_expired', locale, { title: capitalized(listing(d, 'push.market.yourListing', locale), locale) }),
  weekly_wrap: say('push.weekly_wrap'),
  // "Your reel passed 1,000 views": once per post and milestone (lib/milestones.ts).
  post_milestone: (_n, d, locale) =>
    d.threshold ? milestoneNoticeText({ type: 'post_milestone', data: d }, (key, vars) => t(key, locale, vars), locale)! : t('push.post_milestone', locale),
  // Questions asked without a name have no actor, so they read "Someone asked you a question".
  question_received: say('push.question_received'),
  question_answered: say('push.question_answered'),
  drop_opened: say('push.drop_opened'),
  drop_cancelled: say('push.drop_cancelled'),
  drop_sold_out: say('push.drop_sold_out'),
};

/** Every notification type that pushes. */
export const PUSH_TYPES: readonly string[] = Object.keys(TEXT);

/**
 * Human text for a notification type in the recipient's language (English when there's no catalog
 * for it), or null for types that shouldn't push. `data` is the notification's data.
 */
export function pushTextFor(type: string, actorName: string | null, data: object = {}, locale = 'en'): string | null {
  const f = TEXT[type];
  return f ? f(actorName ?? t('push.someone', locale), data as Data, locale) : null;
}
