'use client';

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
  join_request: () => 'asked to join your community',
  join_approved: () => 'approved your request to join',
  event_rsvp: () => 'is going to your event',
  event_cancelled: () => 'cancelled an event you were going to',
  order_paid: () => 'paid for an order',
  enforcement: (n) => `A moderator took action on your content (${String(n.data.decision).replace('_', ' ')}). You can appeal from Settings.`,
  tip_received: () => 'sent you a tip',
  subscription_started: () => 'subscribed to you',
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
  if (n.entityType === 'post') return `/p/${n.entityId}`;
  if (n.entityType === 'live') return `/live/${n.entityId}`;
  if (n.entityType === 'family_link') return '/settings';
  if (n.entityType === 'ad_campaign') return '/studio';
  if (n.entityType === 'together') return `/together/${n.entityId}`;
  if (n.entityType === 'user' && n.actor) return `/u/${n.actor.username}`;
  if (n.entityType === 'event') return `/events/${n.entityId}`;
  if (n.entityType === 'friend_request') return '/inbox';
  if (n.entityType === 'moderation_case') return '/settings#moderation';
  if (n.actor) return `/u/${n.actor.username}`;
  return undefined;
}

export default function Notifications() {
  const { t, locale, toast, setUnread } = useSession();
  const [items, setItems] = useState<NotificationItem[] | null>(null);
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
        <List>
          {items.map((n) => (
            <ListItem
              key={n.id}
              href={hrefFor(n)}
              linkAs={NextLink}
              start={n.actor ? <Avatar name={n.actor.displayName} src={n.actor.avatarUrl} size="sm" /> : undefined}
              primary={
                <span style={{ fontWeight: n.readAt ? 400 : 600, whiteSpace: 'normal' }}>
                  {n.actor && n.type !== 'enforcement' ? `${n.actor.displayName} ` : ''}
                  {(TEXT[n.type] ?? (() => n.type.replace(/_/g, ' ')))(n)}
                </span>
              }
              end={
                <>
                  {formatRelativeTime(n.createdAt, locale)}
                  {!n.readAt ? <span className="yp-unread" aria-label="Unread" style={{ minWidth: 8, height: 8, padding: 0 }} /> : null}
                </>
              }
            />
          ))}
        </List>
      ) : (
        <EmptyState title="You're all caught up" body="Likes, comments, follows and event updates show up here." />
      )}
    </div>
  );
}
