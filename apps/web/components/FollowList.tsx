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
  const { me, toast } = useSession();
  const [tab, setTab] = useState(initial);
  const [items, setItems] = useState<PublicUser[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [follows, setFollows] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

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
    <BottomSheet open={open} onClose={onClose} title={name}>
      <div className="stack">
        <Segments
          label="List"
          value={tab}
          onChange={setTab}
          options={[
            { id: 'followers', label: 'Followers' },
            { id: 'following', label: 'Following' },
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
                    u.id === me?.id ? null : follows.has(u.id) ? (
                      <span className="muted" style={{ fontSize: 13 }}>
                        Following
                      </span>
                    ) : (
                      <Button
                        size="sm"
                        onClick={async () => {
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
                        Follow
                      </Button>
                    )
                  }
                />
              ))}
            </List>
            {cursor ? (
              <Button variant="secondary" size="sm" onClick={more}>
                Show more
              </Button>
            ) : null}
          </>
        ) : (
          <p className="muted">
            {userId === me?.id
              ? tab === 'followers'
                ? 'Nobody follows you yet. Share your profile to get started.'
                : "You aren't following anyone yet. Discover has people to start with."
              : tab === 'followers'
                ? `Nobody follows ${name} yet.`
                : `${name} isn't following anyone yet.`}
          </p>
        )}
      </div>
    </BottomSheet>
  );
}
