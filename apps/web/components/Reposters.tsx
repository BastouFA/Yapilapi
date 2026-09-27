'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Avatar, BottomSheet, Button, List, ListItem, Skeleton } from '@yapilapi/design-system';
import type { PublicUser } from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/app/providers';

/** Who reposted a post, newest first. People with private accounts show only to their followers. */
export function Reposters({ postId, onClose }: { postId: string | null; onClose: () => void }) {
  const { t } = useSession();
  const [items, setItems] = useState<PublicUser[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!postId) return;
    let current = true;
    setItems(null);
    setError(null);
    api.posts.reposters(postId).then(
      (r) => {
        if (!current) return;
        setItems(r.items);
        setCursor(r.nextCursor);
      },
      (e) => current && (setItems([]), setError(errorMessage(e))),
    );
    return () => {
      current = false;
    };
  }, [postId]);

  const more = async () => {
    if (!postId || !cursor) return;
    const r = await api.posts.reposters(postId, cursor);
    setItems((cur) => [...(cur ?? []), ...r.items]);
    setCursor(r.nextCursor);
  };

  return (
    <BottomSheet open={!!postId} onClose={onClose} title={t('reposters.title')}>
      {error ? (
        <p className="muted">{error}</p>
      ) : items === null ? (
        <Skeleton height={120} />
      ) : items.length ? (
        <div className="stack">
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
              />
            ))}
          </List>
          {cursor ? (
            <Button variant="secondary" onClick={() => void more()}>
              {t('follow.showMore')}
            </Button>
          ) : null}
        </div>
      ) : (
        <p className="muted">{t('reposters.empty')}</p>
      )}
    </BottomSheet>
  );
}
