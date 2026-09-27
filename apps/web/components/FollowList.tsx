'use client';

import { useEffect, useState } from 'react';
import { Avatar, BottomSheet, Button, List, ListItem, Segments, Skeleton } from '@yapilapi/design-system';
import type { PublicUser } from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';
import Link from 'next/link';
import { useSession } from '@/app/providers';

/** Followers and following of one person, with Follow buttons for people you don't follow yet. */
export function FollowList({
  userId,
  name,
  initial,
  open,
  onClose,
  onFollowChange,
}: {
  userId: string;
  name: string;
  initial: 'followers' | 'following';
  open: boolean;
  onClose: () => void;
  onFollowChange?: () => void;
}) {
  const { me, toast, t } = useSession();
  const [tab, setTab] = useState(initial);
  const [items, setItems] = useState<PublicUser[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [follows, setFollows] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  // People followed from this list just now keep a (no longer active) button, so focus isn't lost.
  const [justFollowed, setJustFollowed] = useState<Set<string>>(new Set());

  useEffect(() => setTab(initial), [initial, open]);
  useEffect(() => {
    if (!open) return;
    let current = true;
    setItems(null);
    setError(null);
    (tab === 'followers' ? api.users.followers(userId) : api.users.following(userId)).then(
      (r) => {
        if (!current) return;
        setItems(r.items);
        setCursor(r.nextCursor);
        setFollows(new Set(r.viewerFollows));
      },
      (e) => current && (setItems([]), setError(errorMessage(e))),
    );
    return () => {
      current = false;
    };
  }, [tab, userId, open]);

  const more = async () => {
    if (!cursor) return;
    const r = await (tab === 'followers' ? api.users.followers(userId, cursor) : api.users.following(userId, cursor));
    setItems((cur) => [...(cur ?? []), ...r.items]);
    setCursor(r.nextCursor);
    setFollows((f) => new Set([...f, ...r.viewerFollows]));
  };

  return (
    <BottomSheet open={open} onClose={onClose} title={t(tab === 'followers' ? 'follow.titleFollowers' : 'follow.titleFollowing', { name })}>
      <div className="stack">
        <Segments
          label={t('follow.list')}
          value={tab}
          onChange={setTab}
          options={[
            { id: 'followers', label: t('profile.followers') },
            { id: 'following', label: t('profile.following') },
          ]}
        />
        {error ? (
          <p className="muted">{error}</p>
        ) : items === null ? (
          <Skeleton height={160} />
        ) : items.length ? (
          <>
            <List>
              {items.map((u) => (
                <ListItem
                  key={u.id}
                  start={<Avatar name={u.displayName} src={u.avatarUrl} size="sm" />}
                  primary={
                    <Link href={`/u/${u.username}`} className="follow-list__name" onClick={onClose}>
                      {u.displayName}
                    </Link>
                  }
                  secondary={`@${u.username}`}
                  end={
                    u.id === me?.id ? null : justFollowed.has(u.id) && follows.has(u.id) ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        aria-disabled="true"
                        aria-label={t('follow.followingName', { name: u.displayName })}
                        onClick={() => {}}
                      >
                        {t('profile.unfollow')}
                      </Button>
                    ) : follows.has(u.id) ? (
                      <span className="muted" style={{ fontSize: 13 }}>
                        {t('profile.unfollow')}
                      </span>
                    ) : (
                      <Button
                        size="sm"
                        aria-label={t('follow.followName', { name: u.displayName })}
                        onClick={async () => {
                          setJustFollowed((f) => new Set(f).add(u.id));
                          setFollows((f) => new Set(f).add(u.id));
                          try {
                            await api.users.follow(u.id);
                            onFollowChange?.();
                          } catch (err) {
                            setFollows((f) => {
                              const n = new Set(f);
                              n.delete(u.id);
                              return n;
                            });
                            toast(errorMessage(err));
                          }
                        }}
                      >
                        {t('profile.follow')}
                      </Button>
                    )
                  }
                />
              ))}
            </List>
            {cursor ? (
              <Button variant="secondary" size="sm" onClick={more}>
                {t('follow.showMore')}
              </Button>
            ) : null}
          </>
        ) : (
          <p className="muted">
            {userId === me?.id
              ? tab === 'followers'
                ? t('follow.emptyFollowersSelf')
                : t('follow.emptyFollowingSelf')
              : tab === 'followers'
                ? t('follow.emptyFollowers', { name })
                : t('follow.emptyFollowing', { name })}
          </p>
        )}
      </div>
    </BottomSheet>
  );
}
