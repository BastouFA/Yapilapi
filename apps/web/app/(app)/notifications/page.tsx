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
  join_request: () => 'asked to join your community',
  join_approved: () => 'approved your request to join',
  event_rsvp: () => 'is going to your event',
  event_cancelled: () => 'cancelled an event you were going to',
  order_paid: () => 'paid for an order',
  enforcement: (n) => `A moderator took action on your content (${String(n.data.decision).replace('_', ' ')}). You can appeal from Settings.`,
};

function hrefFor(n: NotificationItem): string | undefined {
  if (n.entityType === 'post') return `/home`;
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
