'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Avatar, Button, EmptyState, Icon, List, ListItem, Skeleton } from '@yapilapi/design-system';
import {
  askNoticePost,
  askNoticeText,
  echoNoticeText,
  formatRelativeTime,
  fullCount,
  milestoneNoticeText,
  micNoticeHref,
  micNoticeText,
  miniAppNoticeText,
  reportOutcomeText,
  appealDecidedText,
  scheduledPostFailedText,
  signInNoticeText,
  squadNoticeHref,
  squadNoticeText,
  togetherNoticeText,
  type MessageKey,
  type NotificationItem,
  type PublicUser,
} from '@yapilapi/shared';
import { api, errorMessage, sharedRequest } from '@/lib/api';
import { NextLink } from '@/lib/link';
import { useRealtime, useSession, type Session } from '../../providers';

/**
 * Whole sentences for each kind of notification, in the viewer's language. `name` is who did it
 * (for grouped rows, "Ada, Tunde and 2 others"); a notification about your own account ignores it.
 */
type TextFn = (n: NotificationItem, name: string, t: Session['t'], tp: Session['tp'], people: number) => string;
const TEXT: Record<string, TextFn> = {
  // Grouped kinds read "Ada and 2 others liked…", or one person with a singular verb (it matters in French and others).
  follow: (_n, name, t, _tp, people) => (people > 1 ? t('m.notif.group.follow', { names: name }) : t('m.notif.follow', { name })),
  friend_request: (_n, name, t) => t('m.notif.friendRequest', { name }),
  friend_accepted: (_n, name, t) => t('m.notif.friendAccepted', { name }),
  follow_request: (_n, name, t) => t('profile.followRequestFrom', { name }),
  follow_accepted: (_n, name, t) => t('profile.followAccepted', { name }),
  post_reaction: (_n, name, t, _tp, people) => (people > 1 ? t('m.notif.group.like', { names: name }) : t('m.notif.like', { name })),
  post_comment: (_n, name, t, _tp, people) => (people > 1 ? t('m.notif.group.comment', { names: name }) : t('m.notif.comment', { name })),
  post_repost: (_n, name, t, _tp, people) => (people > 1 ? t('m.notif.group.repost', { names: name }) : t('m.notif.repost', { name })),
  reel_duet: (_n, name, t) => t('m.notif.reelDuet', { name }),
  reel_remix: (_n, name, t) => t('m.notif.reelRemix', { name }),
  post_mention: (_n, name, t) => t('m.notif.postMention', { name }),
  comment_mention: (_n, name, t) => t('m.notif.commentMention', { name }),
  story_mention: (_n, name, t) => t('notifList.storyMention', { name }),
  story_reshare: (_n, name, t) => t('m.notif.storyReshare', { name }),
  story_countdown: (n, _name, t) => t('m.notif.countdownEnded', { title: String(n.data.title ?? '') }),
  join_request: (_n, name, t) => t('m.notif.joinRequest', { name }),
  join_approved: (_n, name, t) => t('m.notif.joinApproved', { name }),
  event_rsvp: (_n, name, t) => t('m.notif.eventRsvp', { name }),
  event_cancelled: (_n, name, t) => t('m.notif.eventCancelled', { name }),
  event_updated: (_n, name, t) => t('m.notif.eventUpdated', { name }),
  event_waitlist_in: (_n, name, t) => t('m.notif.waitlistIn', { name }),
  order_paid: (_n, name, t) => t('m.notif.orderPaid', { name }),
  enforcement: (n, _name, t) => t('notifList.enforcement', { decision: decisionLabel(n.data.decision, t) }),
  tip_received: (_n, name, t) => t('m.notif.tip', { name }),
  subscription_started: (_n, name, t) => t('m.notif.subscribed', { name }),
  payout_paid: (_n, _name, t) => t('m.notif.payoutPaid'),
  payout_failed: (_n, _name, t) => t('m.notif.payoutFailed'),
  invite_joined: (_n, name, t) => t('m.notif.inviteJoined', { name }),
  plus_referral_reward: (n, _name, _t, tp) => tp('m.notif.plusReward', Number(n.data.days ?? 30)),
  live_started: (_n, name, t) => t('m.notif.liveStarted', { name }),
  room_live: (n, name, t) => t('notifList.roomLive', { name, title: String(n.data.title ?? '') }),
  booking_request: (_n, name, t) => t('m.notif.bookingRequest', { name }),
  booking_decided: (_n, _name, t) => t('m.notif.bookingDecided'),
  call_incoming: (_n, name, t) => t('m.notif.called', { name }),
  together_invite: (_n, name, t) => t('m.notif.togetherInvite', { name }),
  collab_invite: (_n, name, t) => t('m.notif.collabInvite', { name }),
  collab_accepted: (_n, name, t) => t('m.notif.collabAccepted', { name }),
  photo_tag: (_n, name, t) => t('m.notif.photoTag', { name }),
  family_invite: (_n, name, t) => t('notifList.familyInvite', { name }),
  family_accepted: (_n, name, t) => t('m.notif.familyAccepted', { name }),
  family_ended: (_n, name, t) => t('m.notif.familyEnded', { name }),
  family_controls_changed: (_n, name, t) => t('m.notif.familyChanged', { name }),
  ad_approved: (n, _name, t) => t('m.notif.adApproved', { title: String(n.data.name ?? '') }),
  ad_rejected: (n, _name, t) =>
    n.data.note
      ? t('notifList.adRejected', { title: String(n.data.name ?? ''), note: String(n.data.note) })
      : t('notifList.adRejectedNoNote', { title: String(n.data.name ?? '') }),
  mfa_enabled: (_n, _name, t) => t('m.notif.mfaOn'),
  mfa_disabled: (_n, _name, t) => t('m.notif.mfaOff'),
  mfa_recovery_code_used: (_n, _name, t) => t('m.notif.recoveryCodeUsed'),
  passkey_added: (_n, _name, t) => t('m.notif.passkeyAdded'),
  media_blocked: (_n, _name, t) => t('notifList.mediaBlocked'),
  media_restored: (_n, _name, t) => t('notifList.mediaRestored'),
  yap_received: (_n, name, t) => t('m.notif.yap', { name }),
  view_once_screenshot: (_n, name, t) => t('m.notif.viewOnceScreenshot', { name }),
  chat_reminder: (_n, _name, t) => t('m.notif.chatReminder'),
  // With the reason, when there is one, in your language.
  scheduled_post_failed: (n, _name, t) => scheduledPostFailedText(n, t),
  account_limited: (_n, _name, t) => t('notifList.accountLimited'),
  chapter_invite: (n, name, t) => t('m.notif.chapterInvite', { name, title: String(n.data.title ?? '') }),
  board_invite: (n, name, t) => t('m.notif.boardInvite', { name, board: String(n.data.name ?? '') }),
  board_item_added: (n, name, _t, tp) => tp('m.notif.boardItemAdded', Number(n.data.count ?? 1), { name, board: String(n.data.name ?? '') }),
  chapter_opened: (n, _name, t) => t('m.notif.capsuleOpened', { title: String(n.data.title ?? '') }),
  recap_ready: (n, _name, t) => t('notifList.recapReady', { title: String(n.data.title ?? '') }),
  recap_failed: (n, _name, t) => t('notifList.recapFailed', { title: String(n.data.title ?? '') }),
  account_review: (n, _name, t) => (n.data.outcome === 'cleared' ? t('notifList.reviewCleared') : t('notifList.reviewLimited')),
};

/** A moderation decision in plain words (the server sends a code like `suspend_user`). */
const DECISIONS: Record<string, MessageKey> = {
  no_action: 'notifList.decision.noAction',
  warn: 'notifList.decision.warn',
  restrict: 'notifList.decision.restrict',
  remove: 'notifList.decision.remove',
  suspend_user: 'notifList.decision.suspendUser',
};
function decisionLabel(decision: unknown, t: Session['t']): string {
  const key = DECISIONS[String(decision)];
  return key ? t(key) : String(decision ?? '').replace(/_/g, ' ');
}

/** Notifications about a comment, which open the post with its comments. */
const COMMENT_TYPES = new Set(['post_comment', 'comment_reply', 'comment_like', 'comment_mention']);

function hrefFor(n: NotificationItem, meUsername?: string): string | undefined {
  if (n.type === 'new_sign_in') return '/settings/security?review=sign-in';
  // Squads: the squad's page (its feed, story, chat and weekly memory).
  const squad = squadNoticeHref(n);
  if (squad) return `/squads/${squad}`;
  // Ask the city: the question, with its answers open.
  const question = askNoticePost(n);
  if (question) return `/p/${question}?comments=1`;
  // Pass the Mic and Fair start: the chain's page, or the reel.
  const mic = micNoticeHref(n);
  if (mic) return 'chain' in mic ? `/chains/${mic.chain}` : 'post' in mic ? `/p/${mic.post}` : `/reels?start=${mic.reel}`;
  // A call opens the chat it was in (older call notifications open the caller).
  if (n.type === 'call_incoming' && typeof n.data.conversationId === 'string') return `/inbox/${n.data.conversationId}`;
  // Market: a rating opens your profile's Market tab; the rest open the listing (offers open the chat, below).
  if (n.type === 'market_rated' && meUsername) return `/u/${meUsername}?tab=market`;
  if (n.entityType === 'listing') return `/market/${n.entityId}`;
  // Questions for your box open your questions; an answer to yours opens their Answers tab.
  if (n.type === 'question_received') return '/questions';
  if (n.type === 'question_answered' && n.actor) return `/u/${n.actor.username}?tab=answers`;
  if (n.type === 'reel_duet' || n.type === 'reel_remix') return `/reels?start=${n.entityId}`;
  // Echoes of your reel (batched): all of them, or the one when only one person echoed it.
  if (n.type === 'reel_echo')
    return Number(n.data.count ?? 1) > 1 && typeof n.data.originalId === 'string' ? `/reels/${n.data.originalId}/echoes` : `/reels?start=${n.entityId}`;
  if (n.type === 'weekly_wrap' || n.entityType === 'wrap') return n.entityId ? `/wraps/${n.entityId}` : '/wraps';
  // "Your Today is ready": it's at the top of Pulse.
  if (n.type === 'today_ready') return '/home';
  if (n.type === 'watch_invite' || n.entityType === 'watch') return n.entityId ? `/watch/${n.entityId}` : '/inbox';
  // A ticket a friend gave you opens your Tickets; being made a co-host opens the event's check-in.
  if (n.type === 'ticket_received') return '/tickets';
  if (n.type === 'event_cohost' && n.entityId) return `/events/${n.entityId}/check-in`;
  // A request to join opens the community's settings; being let in opens the community.
  if (n.type === 'join_request' && typeof n.data.slug === 'string') return `/c/${n.data.slug}/manage?tab=requests`;
  if (n.type === 'join_approved' && typeof n.data.slug === 'string') return `/c/${n.data.slug}`;
  // A booking to answer opens Studio; an answer to yours opens the place.
  if (n.type === 'booking_request') return '/studio';
  if (n.type === 'booking_decided' && typeof n.data.placeId === 'string') return `/places/${n.data.placeId}`;
  if (n.entityType === 'chapter') return `/chapters/${n.entityId}`;
  if (n.entityType === 'drop') return `/drops/${n.entityId}`;
  if (n.entityType === 'recap' || n.type === 'recap_ready' || n.type === 'recap_failed') return n.entityId ? `/recaps?open=${n.entityId}` : '/recaps';
  if (n.entityType === 'board') return `/boards/${n.entityId}`;
  if (n.entityType === 'draft') return `/create?draft=${n.entityId}`;
  // About a comment: the post with its comments open.
  if (n.entityType === 'post' && COMMENT_TYPES.has(n.type)) return `/p/${n.entityId}?comments=1`;
  if (n.entityType === 'post') return `/p/${n.entityId}`;
  if (n.entityType === 'moment') return `/s/${n.entityId}`;
  if (n.entityType === 'live') return `/live/${n.entityId}`;
  if (n.entityType === 'room') return `/rooms/${n.entityId}`;
  if (n.entityType === 'family_link') return '/settings';
  if (n.entityType === 'ad_campaign') return '/studio';
  // A Mini App's review opens its developer app on the developers page.
  if (n.entityType === 'mini_app') return typeof n.data.appId === 'string' ? `/developers?app=${encodeURIComponent(n.data.appId)}` : '/developers';
  if (n.entityType === 'plus') return '/plus';
  if (n.entityType === 'together') return `/together/${n.entityId}`;
  if (n.entityType === 'user' && n.actor) return `/u/${n.actor.username}`;
  if (n.entityType === 'event') return `/events/${n.entityId}`;
  if (n.entityType === 'friend_request') return '/inbox';
  if (n.entityType === 'conversation') return `/inbox/${n.entityId}`;
  if (n.entityType === 'moderation_case') return '/settings/safety#moderation';
  if (n.type === 'account_limited' || n.type === 'account_review') return '/settings/safety#moderation';
  if (n.actor) return `/u/${n.actor.username}`;
  return undefined;
}

/**
 * Likes on a comment and replies to it are batched on the server into one notification:
 * the newest person is its actor and `data.count` says how many people.
 */
function batchedText(n: NotificationItem, t: Session['t'], tp: Session['tp']): string | null {
  // About your own account, in your language: a sign-in from a new device, a scheduled message that couldn't go out.
  const signIn = signInNoticeText(n, t);
  if (signIn) return signIn;
  if (n.type === 'scheduled_message_failed') return t('m.notif.scheduledMessageFailed');
  // What happened to something you reported, in plain words.
  const report = reportOutcomeText(n, t);
  if (report) return report;
  // The answer to your appeal.
  const appeal = appealDecidedText(n, t);
  if (appeal) return appeal;
  // How a Mini App's review went, with the admin's reason when there is one.
  const mini = miniAppNoticeText(n, t);
  if (mini) return mini;
  // Together albums: whole sentences with the album's name ("Ada added 12 photos to Lagos weekend").
  const together = togetherNoticeText(n, t, tp);
  if (together) return together;
  // "Ada and 3 others echoed your reel".
  const echo = echoNoticeText(n, t, tp);
  if (echo) return echo;
  // "Ada and 2 others took the mic on your chain", "Fair start finished: 1,000 people saw your reel".
  const mic = micNoticeText(n, t, tp);
  if (mic) return mic;
  // "Ada invited you to join Crew", "Ada and 2 others shared in Crew", "Your week in Crew is ready".
  const squad = squadNoticeText(n, t, tp);
  if (squad) return squad;
  // Ask the city: "New question in Yaba, Lagos: Food", "Ada found your answer helpful".
  const asked = askNoticeText(n, t);
  if (asked) return asked;
  // Whole sentences in your language (the name, when there is one, is part of them).
  if (n.type === 'weekly_wrap') return t('wrap.notif');
  if (n.type === 'today_ready') return t('push.today_ready');
  if (n.type === 'watch_invite') return t('watch.invite', { name: n.actor?.displayName ?? t('m.calls.someone') });
  // Someone started sharing where they are with a chat you're in (it opens the chat).
  if (n.type === 'location_shared') return t('location.notif', { name: n.actor?.displayName ?? t('m.calls.someone') });
  if (n.type === 'ticket_received') return t('tickets.notif.received', { name: n.actor?.displayName ?? t('m.calls.someone') });
  if (n.type === 'event_cohost') return t('tickets.notif.cohost', { name: n.actor?.displayName ?? t('m.calls.someone') });
  // A question asked without a name has no actor: it never says who.
  if (n.type === 'question_received') return n.actor ? t('ask.notif.received', { name: n.actor.displayName }) : t('ask.notif.receivedHidden');
  if (n.type === 'question_answered') return t('ask.notif.answered', { name: n.actor?.displayName ?? '' });
  // Drops: plain words, with the drop's name.
  const title = String(n.data.title ?? '');
  if (n.type === 'drop_opened') return t('m.notif.dropOpened', { name: n.actor?.displayName ?? '', title });
  if (n.type === 'drop_cancelled') return t('m.notif.dropCancelled', { name: n.actor?.displayName ?? '', title });
  if (n.type === 'drop_sold_out') return t('m.notif.dropSoldOut', { title });
  // Market: offers and answers (they open the chat), a sale to you, a rating, and a listing ending.
  const someone = n.actor?.displayName ?? t('m.calls.someone');
  if (n.type === 'market_offer') return t('market.notif.offer', { name: someone, title });
  if (n.type === 'market_offer_accepted') return t('market.notif.offerAccepted', { name: someone, title });
  if (n.type === 'market_offer_declined') return t('market.notif.offerDeclined', { name: someone, title });
  if (n.type === 'market_offer_countered') return t('market.notif.offerCountered', { name: someone, title });
  if (n.type === 'market_sold_to_you') return t('market.notif.soldToYou', { name: someone, title });
  if (n.type === 'market_rated') return t('market.notif.rated', { name: someone, title });
  if (n.type === 'market_expiring') return tp('market.notif.expiring', Number(n.data.days ?? 3), { title });
  if (n.type === 'market_expired') return t('market.notif.expired', { title });
  if (n.type !== 'comment_like' && n.type !== 'comment_reply') return null;
  const name = n.actor?.displayName ?? '';
  const others = Math.max(0, Number(n.data.count ?? 1) - 1);
  if (n.type === 'comment_like') return others ? tp('comments.notif.likeOthers', others, { name }) : t('comments.notif.like', { name });
  return others ? tp('comments.notif.replyOthers', others, { name }) : t('comments.notif.reply', { name });
}

/** Likes, comments, reposts and follows on the same thing collapse into one row ("Ada and 2 others liked your post"). */
const GROUPED = new Set(['post_reaction', 'post_comment', 'post_repost', 'follow']);

type Group = { key: string; items: NotificationItem[] };
type Bucket = 'today' | 'thisWeek' | 'earlier';
const BUCKET_TITLE: Record<Bucket, MessageKey> = { today: 'm.notif.today', thisWeek: 'm.notif.thisWeek', earlier: 'm.notif.earlier' };

function bucket(iso: string): Bucket {
  const age = Date.now() - new Date(iso).getTime();
  return age < 86_400_000 ? 'today' : age < 7 * 86_400_000 ? 'thisWeek' : 'earlier';
}

function group(items: NotificationItem[]): { title: Bucket; groups: Group[] }[] {
  const sections: { title: Bucket; groups: Group[] }[] = [];
  for (const n of items) {
    // Follow requests are answered in their own list above.
    if (n.type === 'follow_request') continue;
    const title = bucket(n.createdAt);
    let section = sections.at(-1);
    if (!section || section.title !== title) sections.push((section = { title, groups: [] }));
    // New followers group together ("Ada and 3 others started following you"); the rest by what they're about.
    const key = n.type === 'follow' ? 'follow' : GROUPED.has(n.type) ? `${n.type}:${n.entityId ?? ''}` : n.id;
    const existing = section.groups.find((g) => g.key === key);
    if (existing) existing.items.push(n);
    else section.groups.push({ key, items: [n] });
  }
  return sections;
}

function names(g: Group, t: Session['t'], tp: Session['tp']): string {
  const people = [...new Map(g.items.filter((n) => n.actor).map((n) => [n.actor!.id, n.actor!.displayName])).values()];
  if (people.length <= 1) return people[0] ?? t('m.calls.someone');
  if (people.length === 2) return t('m.notif.names.two', { first: people[0]!, second: people[1]! });
  return tp('m.notif.names.many', people.length - 2, { first: people[0]!, second: people[1]! });
}

export default function Notifications() {
  const { t, tp, locale, toast, setUnread, me } = useSession();
  const [items, setItems] = useState<NotificationItem[] | null>(null);
  const [followed, setFollowed] = useState<Set<string>>(new Set());
  // Co-author invites answered here, by post id.
  const [answered, setAnswered] = useState<Record<string, 'accepted' | 'declined'>>({});
  const [answering, setAnswering] = useState<string | null>(null);
  // Board invites answered here, by board id.
  const [boardAnswered, setBoardAnswered] = useState<Record<string, 'accepted' | 'declined'>>({});
  const answerBoard = async (boardId: string, accept: boolean) => {
    setAnswering(boardId);
    try {
      await (accept ? api.boards.join(boardId) : api.boards.leave(boardId));
      setBoardAnswered((a) => ({ ...a, [boardId]: accept ? 'accepted' : 'declined' }));
    } catch (e) {
      toast(errorMessage(e));
    } finally {
      setAnswering(null);
    }
  };
  const answer = async (postId: string, accept: boolean) => {
    setAnswering(postId);
    try {
      await (accept ? api.posts.acceptCollab(postId) : api.posts.declineCollab(postId));
      setAnswered((a) => ({ ...a, [postId]: accept ? 'accepted' : 'declined' }));
    } catch (e) {
      toast(errorMessage(e));
    } finally {
      setAnswering(null);
    }
  };
  // Why the list couldn't load (shown with Try again), and the cursor for older ones.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  // People asking to follow you (a private account), answered here.
  const [requests, setRequests] = useState<{ user: PublicUser; createdAt: string }[]>([]);
  const [requestBusy, setRequestBusy] = useState<string | null>(null);
  const load = () => {
    setLoadError(null);
    void api.users.followRequests().then(
      (r) => setRequests(r.items),
      () => {},
    );
    return sharedRequest('notifications', () => api.notifications.list()).then(
      (r) => {
        setItems(r.items);
        setNext(r.nextCursor);
        // Seen now, as on the phone: the badge clears and the unread dots stay for this visit.
        // (Again once marked: a count asked for at the same time may have landed after this.)
        setUnread({ notifications: 0 });
        if (r.unread)
          void api.notifications.markRead().then(
            () => setUnread({ notifications: 0 }),
            () => {},
          );
      },
      (e) => setLoadError(errorMessage(e)),
    );
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useRealtime((e) => e.type === 'notification.created' && void load());
  const loadMore = async () => {
    if (!next) return;
    setMore(true);
    try {
      const r = await api.notifications.list(next);
      setItems((cur) => [...(cur ?? []), ...r.items.filter((n) => !cur?.some((c) => c.id === n.id))]);
      setNext(r.nextCursor);
    } catch (e) {
      toast(errorMessage(e));
    } finally {
      setMore(false);
    }
  };
  const answerRequest = async (user: PublicUser, accept: boolean) => {
    setRequestBusy(user.id);
    try {
      await (accept ? api.users.acceptFollow(user.id) : api.users.declineFollow(user.id));
      setRequests((cur) => cur.filter((r) => r.user.id !== user.id));
      toast(accept ? t('followRequests.accepted', { name: user.displayName }) : t('followRequests.declined'));
      void load();
    } catch (e) {
      toast(errorMessage(e));
    } finally {
      setRequestBusy(null);
    }
  };

  return (
    <div className="yp-shell__inner">
      <div className="yp-topbar">
        <h1>{t('notifications.title')}</h1>
        <Button
          size="sm"
          variant="ghost"
          onClick={async () => {
            await api.notifications.markRead();
            setUnread({ notifications: 0 });
            setItems((cur) => cur?.map((n) => ({ ...n, readAt: n.readAt ?? new Date().toISOString() })) ?? cur);
          }}
        >
          {t('notifList.markAllRead')}
        </Button>
      </div>
      {requests.length ? (
        <section className="stack-sm" aria-labelledby="n-requests">
          <h2 id="n-requests" className="section-title">
            {t('followRequests.title')}
          </h2>
          <List>
            {requests.map((r) => (
              <ListItem
                key={r.user.id}
                start={<Avatar name={r.user.displayName} src={r.user.avatarUrl} size="sm" />}
                primary={
                  <Link href={`/u/${r.user.username}`} className="notif__link">
                    <span style={{ whiteSpace: 'normal' }}>{t('profile.followRequestFrom', { name: r.user.displayName })}</span>
                  </Link>
                }
                secondary={formatRelativeTime(r.createdAt, locale)}
                end={
                  <span className="row" style={{ gap: 4, flexWrap: 'nowrap' }}>
                    <Button size="sm" loading={requestBusy === r.user.id} disabled={!!requestBusy} onClick={() => answerRequest(r.user, true)}>
                      {t('m.common.accept')}
                    </Button>
                    <Button size="sm" variant="ghost" disabled={!!requestBusy} onClick={() => answerRequest(r.user, false)}>
                      {t('m.common.decline')}
                    </Button>
                  </span>
                }
              />
            ))}
          </List>
        </section>
      ) : null}
      {items === null && loadError ? (
        <EmptyState title={loadError} action={<Button onClick={() => void load()}>{t('m.common.retry')}</Button>} />
      ) : items === null ? (
        <Skeleton height={240} />
      ) : items.some((n) => n.type !== 'follow_request') ? (
        <div className="stack">
          {group(items).map((section) => (
            <section key={section.title} className="stack-sm" aria-labelledby={`n-${section.title}`}>
              <h2 id={`n-${section.title}`} className="section-title">
                {t(BUCKET_TITLE[section.title])}
              </h2>
              <List>
                {section.groups.map((g) => {
                  const n = g.items[0]!;
                  const unread = g.items.some((x) => !x.readAt);
                  const actors = [...new Map(g.items.filter((x) => x.actor).map((x) => [x.actor!.id, x.actor!])).values()];
                  const followBack = n.type === 'follow' && actors.length === 1 && !n.followsActor && !followed.has(actors[0]!.id);
                  const batched = batchedText(n, t, tp);
                  const text = (
                    <span style={{ fontWeight: unread ? 600 : 400, whiteSpace: 'normal' }}>
                      {batched ??
                        (TEXT[n.type]
                          ? TEXT[n.type]!(n, names(g, t, tp), t, tp, actors.length)
                          : n.actor
                            ? t('m.notif.other', { name: names(g, t, tp) })
                            : t('m.notif.otherNoActor'))}
                    </span>
                  );
                  const start = actors.length ? (
                    <span className={actors.length > 1 ? 'notif__stack' : undefined}>
                      {actors.slice(0, 3).map((a) => (
                        <Avatar key={a.id} name={a.displayName} src={a.avatarUrl} size="sm" />
                      ))}
                    </span>
                  ) : undefined;
                  const when = (
                    <>
                      {formatRelativeTime(n.createdAt, locale)}
                      {unread ? <span className="yp-unread" aria-label={t('m.notif.unread')} style={{ minWidth: 8, height: 8, padding: 0 }} /> : null}
                    </>
                  );
                  if (n.type === 'post_milestone' && n.entityId) {
                    // A small card of its own: the number, the sentence and a way to the post.
                    const reel = n.data.format === 'reel';
                    const threshold = Number(n.data.threshold) || 0;
                    return (
                      <li key={g.key} className="notif-milestone">
                        <p className="notif-milestone__label">
                          <Icon name="star" size={14} />
                          {t('milestone.card.label')}
                        </p>
                        {/* The sentence says the same in words, for screen readers. */}
                        <p className="notif-milestone__figure" aria-hidden>
                          <span className="notif-milestone__number">{fullCount(threshold, locale)}</span>{' '}
                          <span>{t(n.data.metric === 'likes' ? 'milestone.card.likes' : 'milestone.card.views')}</span>
                        </p>
                        <p className="notif-milestone__text" style={{ fontWeight: unread ? 600 : 400 }}>
                          {milestoneNoticeText(n, t, locale)}
                          <span className="notif-milestone__when">{when}</span>
                        </p>
                        <Link href={reel ? `/reels?start=${n.entityId}` : `/p/${n.entityId}`} className="notif-milestone__link">
                          {t(reel ? 'milestone.card.see.reel' : 'milestone.card.see.post')}
                          <Icon name="chevron-right" size={16} className="notif-milestone__chevron" />
                        </Link>
                      </li>
                    );
                  }
                  if (n.type === 'collab_invite' && n.entityId) {
                    const postId = n.entityId;
                    const outcome = answered[postId];
                    return (
                      <ListItem
                        key={g.key}
                        start={start}
                        primary={
                          <Link href={`/p/${postId}`} className="notif__link">
                            {text}
                          </Link>
                        }
                        secondary={formatRelativeTime(n.createdAt, locale)}
                        end={
                          outcome ? (
                            <span className="muted" role="status">
                              {outcome === 'accepted' ? t('m.collab.acceptedNote') : t('postList.collabDeclined')}
                            </span>
                          ) : (
                            <span className="row" style={{ gap: 4, flexWrap: 'nowrap' }}>
                              <Button size="sm" loading={answering === postId} disabled={!!answering} onClick={() => answer(postId, true)}>
                                {t('m.common.accept')}
                              </Button>
                              <Button size="sm" variant="ghost" disabled={!!answering} onClick={() => answer(postId, false)}>
                                {t('m.common.decline')}
                              </Button>
                            </span>
                          )
                        }
                      />
                    );
                  }
                  if (n.type === 'board_invite' && n.entityId) {
                    const boardId = n.entityId;
                    const outcome = boardAnswered[boardId];
                    return (
                      <ListItem
                        key={g.key}
                        start={start}
                        primary={
                          <Link href={`/boards/${boardId}`} className="notif__link">
                            {text}
                          </Link>
                        }
                        secondary={formatRelativeTime(n.createdAt, locale)}
                        end={
                          outcome ? (
                            <span className="muted" role="status">
                              {outcome === 'accepted' ? t('notifList.boardJoined') : t('postList.collabDeclined')}
                            </span>
                          ) : (
                            <span className="row" style={{ gap: 4, flexWrap: 'nowrap' }}>
                              <Button size="sm" loading={answering === boardId} disabled={!!answering} onClick={() => answerBoard(boardId, true)}>
                                {t('m.common.accept')}
                              </Button>
                              <Button size="sm" variant="ghost" disabled={!!answering} onClick={() => answerBoard(boardId, false)}>
                                {t('m.common.decline')}
                              </Button>
                            </span>
                          )
                        }
                      />
                    );
                  }
                  return followBack ? (
                    <ListItem
                      key={g.key}
                      start={start}
                      primary={
                        <Link href={`/u/${actors[0]!.username}`} className="notif__link">
                          {text}
                        </Link>
                      }
                      secondary={formatRelativeTime(n.createdAt, locale)}
                      end={
                        <Button
                          size="sm"
                          onClick={async () => {
                            setFollowed((f) => new Set(f).add(actors[0]!.id));
                            try {
                              const r = await api.users.follow(actors[0]!.id);
                              toast(
                                r.requested
                                  ? t('profile.requestedToast', { name: actors[0]!.displayName })
                                  : t('m.notif.nowFollowing', { name: actors[0]!.displayName }),
                              );
                            } catch (e) {
                              setFollowed((f) => {
                                const next = new Set(f);
                                next.delete(actors[0]!.id);
                                return next;
                              });
                              toast(errorMessage(e));
                            }
                          }}
                        >
                          {t('m.notif.followBack')}
                        </Button>
                      }
                    />
                  ) : (
                    <ListItem key={g.key} href={hrefFor(n, me?.username)} linkAs={NextLink} start={start} primary={text} end={when} />
                  );
                })}
              </List>
            </section>
          ))}
          {next ? (
            <Button variant="ghost" loading={more} onClick={() => void loadMore()}>
              {t('feed.loadMore')}
            </Button>
          ) : null}
        </div>
      ) : (
        <EmptyState title={t('m.notif.caughtUp')} body={t('m.notif.caughtUpBody')} />
      )}
    </div>
  );
}
