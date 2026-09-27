import * as Notifications from 'expo-notifications';
import { router } from 'expo-router';
import { useEffect } from 'react';
import { useSession } from './session';

/** What a notification (from the list, or the data of a push) says about where it leads. */
export type NotificationTarget = {
  type: string;
  entityType?: string | null;
  entityId?: string | null;
  actor?: { username: string } | null;
};

/**
 * Where a notification opens in the app: the same places as the web notifications page
 * (apps/web/app/(app)/notifications/page.tsx, hrefFor), at the phone app's paths. Things the
 * phone app can't show yet (an ad) open the person who did it, or nothing.
 */
export function notificationHref(n: NotificationTarget): string | null {
  const id = n.entityId ? encodeURIComponent(n.entityId) : null;
  if ((n.type === 'reel_duet' || n.type === 'reel_remix') && id) return `/reels?start=${id}`;
  if (n.type === 'recap_ready' || n.type === 'recap_failed' || n.entityType === 'recap') return id ? `/recaps?open=${id}` : '/recaps';
  // Watch together: an invite opens the session (it says when it has ended); the weekly wrap opens that week.
  if (n.type === 'watch_invite' || n.entityType === 'watch') return id ? `/watch/${id}` : null;
  if (n.type === 'weekly_wrap' || n.entityType === 'wrap') return id ? `/wraps/${id}` : '/wraps';
  if (n.type === 'account_limited' || n.type === 'account_review') return '/settings';
  // A sign-in from a new device: where you're signed in, to log it out, and your password.
  if (n.type === 'new_sign_in') return '/settings/security';
  // Money: a tip you got opens your tips and gifts; a new subscriber, a sale or a booking to confirm opens Studio.
  if (n.type === 'tip_received') return '/gifts';
  // A question for your box opens your questions; an answer to yours opens their Answers tab.
  if (n.type === 'question_received') return '/questions';
  if (n.type === 'question_answered') return n.actor ? `/u/${encodeURIComponent(n.actor.username)}?tab=answers` : '/notifications';
  if (n.type === 'subscription_started' || n.type === 'order_paid' || n.type === 'booking_request') return '/studio';
  switch (n.entityType) {
    case 'chapter':
      return id ? `/chapter/${id}` : null;
    case 'board':
      return id ? `/board/${id}` : null;
    case 'draft':
      return '/drafts';
    case 'post':
      return id ? `/p/${id}` : null;
    case 'moment':
      return id ? `/s/${id}` : null;
    case 'room':
      return id ? `/room/${id}` : null;
    case 'event':
      return id ? `/event/${id}` : null;
    case 'drop':
      return id ? `/drop/${id}` : null;
    case 'live':
      return id ? `/live/${id}` : '/live';
    case 'together':
      return id ? `/together/${id}` : '/together';
    case 'memory':
      return id ? `/memories/${id}` : '/memories';
    case 'conversation':
      return id ? `/chat/${id}` : null;
    case 'friend_request':
      return '/inbox';
    case 'family_link':
    case 'moderation_case':
      return '/settings';
  }
  return n.actor ? `/u/${encodeURIComponent(n.actor.username)}` : null;
}

/** Push taps already opened, so a cold start and the listener don't open the same one twice. */
const opened = new Set<string>();

/**
 * Opens the right screen when someone taps a push notification, whether the app was running or
 * not. Pushes carry `type`, `entityType` and `entityId` (apps/api/src/lib/services.ts, notify);
 * incoming calls are left to CallsProvider. Anything without a screen of its own opens the
 * notifications list.
 */
export function useNotificationLinks() {
  const signedIn = !!useSession().me;
  useEffect(() => {
    if (!signedIn) return;
    const handle = (resp: Notifications.NotificationResponse | null) => {
      if (!resp || resp.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return;
      const key = resp.notification.request.identifier;
      if (opened.has(key)) return;
      const data = (resp.notification.request.content.data ?? {}) as { type?: string; entityType?: string; entityId?: string };
      if (!data.type || data.type === 'call_incoming') return;
      opened.add(key);
      router.push((notificationHref({ type: data.type, entityType: data.entityType, entityId: data.entityId }) ?? '/notifications') as never);
    };
    void Notifications.getLastNotificationResponseAsync()
      .then(handle)
      .catch(() => {});
    const sub = Notifications.addNotificationResponseReceivedListener(handle);
    return () => sub.remove();
  }, [signedIn]);
}

/** First path segments on the web whose screen has another name in the phone app. */
const RENAMED: Record<string, string> = {
  boards: 'board',
  rooms: 'room',
  chapters: 'chapter',
  events: 'event',
  drops: 'drop',
  places: 'place',
  post: 'p',
  posts: 'p',
  profile: 'u',
  tag: 't',
  tags: 't',
  stories: 's',
  story: 's',
  memory: 'memories',
  lives: 'live',
};

/**
 * Turns a link into a path the app can open: `yapilapi://…` links, and the web app's own links
 * (https://…/boards/1, /inbox/2, /search?q=…) when the phone opens them in the app. Paths the app
 * doesn't know are returned as they came, so Expo's development links keep working.
 */
export function appPath(link: string): string {
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(link);
  // Expo's own links (the development client, Expo Go) are not ours to change.
  if (scheme && scheme[1]!.toLowerCase() !== 'yapilapi' && !/^https?$/i.test(scheme[1]!)) return link;
  // Nor are development server addresses (Metro on this computer, Expo's "/--/" paths).
  if (scheme && (link.includes('/--/') || /^https?:\/\/(localhost|127\.|10\.|192\.168\.|\[?::1|[^/]*\.local\b)/i.test(link))) return link;
  let rest = scheme ? link.slice(scheme[0].length) : link;
  // A web link names a host first; a yapilapi:// link starts with the path.
  if (scheme && /^https?$/i.test(scheme[1]!)) rest = rest.replace(/^[^/?#]*/, '');
  const [pathPart, query = ''] = rest.split('?', 2) as [string, string?];
  const parts = pathPart.split('#')[0]!.split('/').filter(Boolean);
  const [first, second] = parts;
  // The query goes along as it came (?q=…, ?start=…, ?open=…).
  const q = query ? `?${query}` : '';
  if (!first) return '/';
  // The development app's own "open this server" link isn't a page: land on Pulse.
  if (first === 'expo-development-client') return '/';
  if (first === 'home') return '/';
  if (first === 'search') return `/discover${q}`;
  if (first === 'inbox') return second ? `/chat/${second}` : '/inbox';
  if (first === 'recaps' && second === 'new') return '/recap-new';
  // Making and running things: a new community or event, an event's edit page, a community's settings.
  if (first === 'communities' && second === 'new') return '/community-new';
  if (first === 'events' && second === 'new') return `/event-edit${q}`;
  if (first === 'events' && second && parts[2] === 'edit') return `/event-edit?id=${encodeURIComponent(second)}`;
  if (first === 'c' && second && parts[2] === 'settings') return `/community-settings?slug=${encodeURIComponent(second)}`;
  if (first === 'plus') return '/plus';
  // Making or changing a drop happens on the web; the phone opens your drops.
  if (first === 'drops' && (second === 'new' || parts[2] === 'edit')) return '/drops';
  // A friend's invite link opens sign-up with their code filled in.
  if (first === 'join' && second) return `/signup?invite=${encodeURIComponent(second)}`;
  // Creators and money: Studio, a creator's plans, one thing from a shop, boosting and a post's insights.
  if (first === 'studio') return '/studio';
  if (first === 'plans' && second) return `/plans?username=${encodeURIComponent(second)}`;
  const params = queryParams(query);
  const profileName = first.startsWith('@') ? first.slice(1) : (first === 'u' || first === 'profile') && second ? second : null;
  if (profileName && params.subscribe !== undefined) return `/plans?username=${encodeURIComponent(profileName)}`;
  if (profileName && params.product) return `/product?username=${encodeURIComponent(profileName)}&id=${encodeURIComponent(params.product)}`;
  if ((first === 'p' || first === 'post' || first === 'posts') && second && parts[2] === 'insights') return `/insights/${encodeURIComponent(second)}`;
  if ((first === 'p' || first === 'post' || first === 'posts') && second && params.boost !== undefined) return `/boost?id=${encodeURIComponent(second)}`;
  // A reel's remixes open the reel itself; the phone app has no remixes page yet.
  if ((first === 'reels' || first === 'reel') && second) return `/reels?start=${encodeURIComponent(second)}`;
  if (first.startsWith('@') && first.length > 1) return `/u/${first.slice(1)}`;
  const renamed = RENAMED[first];
  if (renamed && second) return `/${renamed}/${parts.slice(1).join('/')}${q}`;
  return scheme ? `/${parts.join('/')}${q}` : link;
}

/** A link's query as plain values (`a=1&b` gives { a: '1', b: '' }), without relying on URLSearchParams. */
function queryParams(query: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of query.split('#')[0]!.split('&')) {
    if (!pair) continue;
    const at = pair.indexOf('=');
    const k = at < 0 ? pair : pair.slice(0, at);
    const v = at < 0 ? '' : pair.slice(at + 1);
    try {
      out[decodeURIComponent(k)] = decodeURIComponent(v.replace(/\+/g, ' '));
    } catch {
      // A badly encoded value is left out.
    }
  }
  return out;
}
