'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Avatar, Button, EmptyState, List, ListItem, Skeleton } from '@yapilapi/design-system';
import { formatRelativeTime, type NotificationItem } from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';
import { NextLink } from '@/lib/link';
import { useRealtime, useSession, type Session } from '../../providers';

const TEXT: Record<string, (n: NotificationItem) => string> = {
  follow: () => 'started following you',
  friend_request: () => 'sent you a friend request',
  friend_accepted: () => 'accepted your friend request',
  post_reaction: () => 'liked your post',
  post_comment: () => 'commented on your post',
  post_repost: () => 'reposted your post',
  reel_duet: () => 'made a duet with your reel',
  reel_remix: () => 'remixed your reel',
  post_mention: () => 'mentioned you in a post',
  comment_mention: () => 'mentioned you in a comment',
  story_mention: () => 'mentioned you in their story. You can add it to yours.',
  story_reshare: () => 'added your story to theirs',
  story_countdown: (n) => `The countdown “${String(n.data.title ?? '')}” has ended`,
  join_request: () => 'asked to join your community',
  join_approved: () => 'approved your request to join',
  event_rsvp: () => 'is going to your event',
  event_cancelled: () => 'cancelled an event you were going to',
  event_updated: () => "changed the time or place of an event you're going to",
  order_paid: () => 'paid for an order',
  enforcement: (n) => `A moderator took action on your content (${String(n.data.decision).replace('_', ' ')}). You can appeal from Settings.`,
  tip_received: () => 'sent you a tip',
  subscription_started: () => 'subscribed to you',
  invite_joined: () => 'joined YAPILAPI with your invite',
  plus_referral_reward: (n) => `You have ${Number(n.data.days ?? 30)} more days of YAPILAPI Plus, thanks to friends you invited.`,
  live_started: () => 'is live now',
  room_live: (n) => `started the room “${String(n.data.title ?? '')}” you asked about`,
  booking_request: () => 'asked to book',
  booking_decided: () => 'Your booking was updated',
  call_incoming: () => 'called you',
  together_invite: () => 'invited you to a Together',
  collab_invite: () => 'invited you to co-author a post',
  collab_accepted: () => 'accepted your invite to co-author your post',
  photo_tag: () => 'tagged you in a photo',
  family_invite: () => 'asked to supervise your account. You can accept or decline in Settings.',
  family_accepted: () => 'accepted your family link',
  family_ended: () => 'ended your family link',
  family_controls_changed: () => 'changed your family settings',
  ad_approved: (n) => `Your ad "${String(n.data.name ?? '')}" was approved and is running.`,
  ad_rejected: (n) => `Your ad "${String(n.data.name ?? '')}" wasn't approved: ${String(n.data.note ?? 'see Studio for details')}`,
  mfa_enabled: () => 'Two-step verification was turned on for your account.',
  mfa_disabled: () => 'Two-step verification was turned off for your account.',
  mfa_recovery_code_used: () => 'A recovery code was used to sign in to your account.',
  passkey_added: () => 'A passkey was added to your account.',
  media_blocked: () =>
    'A photo or video you shared looks like it goes against our community rules, so it isn’t shown for now. Someone on our team will check it, and we’ll let you know.',
  media_restored: () => 'We checked your photo or video and it’s back up. Sorry for the trouble.',
  yap_received: () => 'sent you a Yap',
  view_once_screenshot: () => 'took a screenshot of your view-once photo or video',
  chat_reminder: () => 'You asked to be reminded about a message in a chat.',
  scheduled_post_failed: (n) => `A scheduled post couldn't be published, so it's back in your drafts. ${String(n.data.reason ?? '')}`.trim(),
  account_limited: () =>
    'Some of your recent posts or messages were flagged, so your account is limited while our team takes a look. You can still post for yourself and message friends.',
  chapter_invite: (n) => `invited you to add your stories to the chapter "${String(n.data.title ?? '')}"`,
  board_invite: (n) => `invited you to add to the board “${String(n.data.name ?? '')}”`,
  board_item_added: (n) => {
    const count = Number(n.data.count ?? 1);
    return `added ${count === 1 ? '1 post' : `${count} posts`} to “${String(n.data.name ?? '')}”`;
  },
  chapter_opened: (n) => `The time capsule "${String(n.data.title ?? '')}" has opened.`,
  recap_ready: (n) => `Your recap video “${String(n.data.title ?? '')}” is ready.`,
  recap_failed: (n) => `We couldn't make your recap video “${String(n.data.title ?? '')}”.`,
  account_review: (n) =>
    n.data.outcome === 'cleared'
      ? 'We reviewed your account and lifted the limit. Held posts and messages are now shared.'
      : 'We reviewed your account. It stays limited for now. You can see decisions and appeal from Settings.',
};

function hrefFor(n: NotificationItem): string | undefined {
  if (n.type === 'reel_duet' || n.type === 'reel_remix') return `/reels?start=${n.entityId}`;
  if (n.entityType === 'chapter') return `/chapters/${n.entityId}`;
  if (n.entityType === 'recap' || n.type === 'recap_ready' || n.type === 'recap_failed') return n.entityId ? `/recaps?open=${n.entityId}` : '/recaps';
  if (n.entityType === 'board') return `/boards/${n.entityId}`;
  if (n.entityType === 'draft') return `/create?draft=${n.entityId}`;
  if (n.entityType === 'post') return `/p/${n.entityId}`;
  if (n.entityType === 'moment') return `/s/${n.entityId}`;
  if (n.entityType === 'live') return `/live/${n.entityId}`;
  if (n.entityType === 'room') return `/rooms/${n.entityId}`;
  if (n.entityType === 'family_link') return '/settings';
  if (n.entityType === 'ad_campaign') return '/studio';
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
  if (n.type !== 'comment_like' && n.type !== 'comment_reply') return null;
  const name = n.actor?.displayName ?? '';
  const others = Math.max(0, Number(n.data.count ?? 1) - 1);
  if (n.type === 'comment_like') return others ? tp('comments.notif.likeOthers', others, { name }) : t('comments.notif.like', { name });
  return others ? tp('comments.notif.replyOthers', others, { name }) : t('comments.notif.reply', { name });
}

/** Likes, comments, reposts and follows on the same thing collapse into one row ("Ada and 2 others liked your post"). */
const GROUPED = new Set(['post_reaction', 'post_comment', 'post_repost', 'follow']);

type Group = { key: string; items: NotificationItem[] };

function bucket(iso: string): 'Today' | 'This week' | 'Earlier' {
  const age = Date.now() - new Date(iso).getTime();
  return age < 86_400_000 ? 'Today' : age < 7 * 86_400_000 ? 'This week' : 'Earlier';
}

function group(items: NotificationItem[]): { title: string; groups: Group[] }[] {
  const sections: { title: string; groups: Group[] }[] = [];
  for (const n of items) {
    const title = bucket(n.createdAt);
    let section = sections.at(-1);
    if (!section || section.title !== title) sections.push((section = { title, groups: [] }));
    const key = GROUPED.has(n.type) ? `${n.type}:${n.entityId ?? ''}` : n.id;
    const existing = section.groups.find((g) => g.key === key);
    if (existing) existing.items.push(n);
    else section.groups.push({ key, items: [n] });
  }
  return sections;
}

function names(g: Group): string {
  const people = [...new Map(g.items.filter((n) => n.actor).map((n) => [n.actor!.id, n.actor!.displayName])).values()];
  if (people.length <= 1) return people[0] ?? '';
  if (people.length === 2) return `${people[0]} and ${people[1]}`;
  const others = people.length - 2;
  return `${people[0]}, ${people[1]} and ${others} ${others === 1 ? 'other' : 'others'}`;
}

export default function Notifications() {
  const { t, tp, locale, toast, setUnread } = useSession();
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
  const load = () =>
    api.notifications.list().then(
      (r) => setItems(r.items),
      (e) => toast(errorMessage(e)),
    );
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useRealtime((e) => e.type === 'notification.created' && void load());

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
          Mark all read
        </Button>
      </div>
      {items === null ? (
        <Skeleton height={240} />
      ) : items.length ? (
        <div className="stack">
          {group(items).map((section) => (
            <section key={section.title} className="stack-sm" aria-labelledby={`n-${section.title}`}>
              <h2 id={`n-${section.title}`} className="section-title">
                {section.title}
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
                      {batched ?? (
                        <>
                          {n.actor && n.type !== 'enforcement' && n.type !== 'story_countdown' ? `${names(g)} ` : ''}
                          {(TEXT[n.type] ?? (() => n.type.replace(/_/g, ' ')))(n)}
                        </>
                      )}
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
                      {unread ? <span className="yp-unread" aria-label="Unread" style={{ minWidth: 8, height: 8, padding: 0 }} /> : null}
                    </>
                  );
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
                              {outcome === 'accepted' ? "You're a co-author now" : 'Declined'}
                            </span>
                          ) : (
                            <span className="row" style={{ gap: 4, flexWrap: 'nowrap' }}>
                              <Button size="sm" loading={answering === postId} disabled={!!answering} onClick={() => answer(postId, true)}>
                                Accept
                              </Button>
                              <Button size="sm" variant="ghost" disabled={!!answering} onClick={() => answer(postId, false)}>
                                Decline
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
                              {outcome === 'accepted' ? 'You can add to it now' : 'Declined'}
                            </span>
                          ) : (
                            <span className="row" style={{ gap: 4, flexWrap: 'nowrap' }}>
                              <Button size="sm" loading={answering === boardId} disabled={!!answering} onClick={() => answerBoard(boardId, true)}>
                                Accept
                              </Button>
                              <Button size="sm" variant="ghost" disabled={!!answering} onClick={() => answerBoard(boardId, false)}>
                                Decline
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
                              await api.users.follow(actors[0]!.id);
                              toast(`You follow ${actors[0]!.displayName} now`);
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
                          Follow back
                        </Button>
                      }
                    />
                  ) : (
                    <ListItem key={g.key} href={hrefFor(n)} linkAs={NextLink} start={start} primary={text} end={when} />
                  );
                })}
              </List>
            </section>
          ))}
        </div>
      ) : (
        <EmptyState title="You're all caught up" body="Likes, comments, follows and event updates show up here." />
      )}
    </div>
  );
}
