'use client';

import { useEffect, useState } from 'react';
import { Avatar, Button, List, ListItem } from '@yapilapi/design-system';
import type { PublicUser } from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';
import { useRealtime, useSession } from '@/app/providers';

/**
 * Friend requests waiting for an answer, with Accept and Decline: in Yap (the chat list) and at the
 * top of Pulse, so a new one is seen without going to look. A request that arrives while the page is
 * open shows up at once (its notification comes over realtime). Nothing shows when there are none.
 */
export function FriendRequests() {
  const { t, toast } = useSession();
  const [requests, setRequests] = useState<{ id: string; from: PublicUser }[]>([]);

  const load = () =>
    api.me
      .friendRequests()
      .then((r) => setRequests(r.items))
      .catch(() => {});
  useEffect(() => {
    void load();
  }, []);
  useRealtime((e) => {
    if (e.type === 'notification.created' && (e.data as { type?: string } | undefined)?.type === 'friend_request') void load();
  });

  if (!requests.length) return null;
  const answer = async (id: string, accept: boolean, name: string) => {
    try {
      await (accept ? api.me.acceptFriend(id) : api.me.declineFriend(id));
      setRequests((x) => x.filter((y) => y.id !== id));
      if (accept) toast(t('chat.nowFriends', { name }));
    } catch (e) {
      toast(errorMessage(e));
    }
  };
  return (
    <section className="stack-sm">
      <h2 className="section-title">{t('chat.friendRequests')}</h2>
      <List>
        {requests.map((r) => (
          <ListItem
            key={r.id}
            start={<Avatar name={r.from.displayName} src={r.from.avatarUrl} />}
            primary={r.from.displayName}
            secondary={`@${r.from.username}`}
            end={
              <>
                <Button size="sm" onClick={() => void answer(r.id, true, r.from.displayName)}>
                  {t('m.common.accept')}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => void answer(r.id, false, r.from.displayName)}>
                  {t('m.common.decline')}
                </Button>
              </>
            }
          />
        ))}
      </List>
    </section>
  );
}
