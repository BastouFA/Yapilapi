'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Avatar, Button, EmptyState, List, ListItem, Skeleton } from '@yapilapi/design-system';
import { formatRelativeTime, type NotificationItem } from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';
import { NextLink } from '@/lib/link';
import { useRealtime, useSession } from '../../providers';

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
  join_request: () => 'asked to join your community',
  join_approved: () => 'approved your request to join',
  event_rsvp: () => 'is going to your event',
  event_cancelled: () => 'cancelled an event you were going to',
  order_paid: () => 'paid for an order',
  enforcement: (n) => `A moderator took action on your content (${String(n.data.decision).replace('_', ' ')}). You can appeal from Settings.`,
  tip_received: () => 'sent you a tip',
  subscription_started: () => 'subscribed to you',
  invite_joined: () => 'joined YAPILAPI with your invite',
  plus_referral_reward: (n) => `You have ${Number(n.data.days ?? 30)} more days of YAPILAPI Plus, thanks to friends you invited.`,
  live_started: () => 'is live now',
  booking_request: () => 'asked to book',
  booking_decided: () => 'Your booking was updated',
  call_incoming: () => 'called you',
  together_invite: () => 'invited you to a Together',
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
};

function hrefFor(n: NotificationItem): string | undefined {
  if (n.type === 'reel_duet' || n.type === 'reel_remix') return `/reels?start=${n.entityId}`;
  if (n.entityType === 'post') return `/p/${n.entityId}`;
  if (n.entityType === 'live') return `/live/${n.entityId}`;
  if (n.entityType === 'family_link') return '/settings';
  if (n.entityType === 'ad_campaign') return '/studio';
  if (n.entityType === 'plus') return '/plus';
  if (n.entityType === 'together') return `/together/${n.entityId}`;
  if (n.entityType === 'user' && n.actor) return `/u/${n.actor.username}`;
  if (n.entityType === 'event') return `/events/${n.entityId}`;
  if (n.entityType === 'friend_request') return '/inbox';
  if (n.entityType === 'moderation_case') return '/settings#moderation';
  if (n.actor) return `/u/${n.actor.username}`;
  return undefined;
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
  const { t, locale, toast, setUnread } = useSession();
  const [items, setItems] = useState<NotificationItem[] | null>(null);
  const [followed, setFollowed] = useState<Set<string>>(new Set());
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
                  const text = (
                    <span style={{ fontWeight: unread ? 600 : 400, whiteSpace: 'normal' }}>
                      {n.actor && n.type !== 'enforcement' ? `${names(g)} ` : ''}
                      {(TEXT[n.type] ?? (() => n.type.replace(/_/g, ' ')))(n)}
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
