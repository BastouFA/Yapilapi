'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Avatar, AvatarGroup, BottomSheet, Button, EmptyState, List, ListItem, Skeleton, TextField } from '@yapilapi/design-system';
import { formatRelativeTime, lastMessageText, type Conversation, type PublicUser } from '@yapilapi/shared';
import { api, errorMessage, sharedRequest } from '@/lib/api';
import { NextLink } from '@/lib/link';
import { PeoplePicker } from '@/components/PeoplePicker';
import { useRealtime, useSession } from '../../providers';

function conversationTitle(c: Conversation, meId: string, justYou: string): string {
  if (c.title) return c.title;
  const others = c.members.filter((m) => m.id !== meId);
  return others.map((m) => m.displayName).join(', ') || justYou;
}

export default function Inbox() {
  const { me, t, tp, locale, toast, unread } = useSession();
  const router = useRouter();
  const [items, setItems] = useState<Conversation[] | null>(null);
  const [requests, setRequests] = useState<{ id: string; from: PublicUser }[]>([]);
  const [newGroup, setNewGroup] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  const load = () =>
    sharedRequest('conversations', () => api.conversations.list()).then(
      (r) => {
        setItems(r.items);
        setFailed(null);
      },
      (e) => setFailed(errorMessage(e)),
    );
  useEffect(() => {
    void load();
    api.me
      .friendRequests()
      .then((r) => setRequests(r.items))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useRealtime((e) => {
    if (['message.created', 'conversation.created', 'conversation.changed', 'conversation.removed'].includes(e.type)) void load();
  });

  return (
    <div className="yp-shell__inner">
      <div className="yp-topbar">
        <h1>{t('inbox.title')}</h1>
        <div className="row">
          <Link href="/notifications" className="yp-btn yp-btn--ghost yp-btn--sm">
            {t('notifications.title')} {unread.notifications ? <span className="yp-unread">{unread.notifications}</span> : null}
          </Link>
          <Button size="sm" icon="users" onClick={() => setNewGroup(true)}>
            {t('inbox.newGroup')}
          </Button>
        </div>
      </div>

      {requests.length ? (
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
                    <Button
                      size="sm"
                      onClick={async () => {
                        try {
                          await api.me.acceptFriend(r.id);
                          setRequests((x) => x.filter((y) => y.id !== r.id));
                          toast(t('chat.nowFriends', { name: r.from.displayName }));
                        } catch (e) {
                          toast(errorMessage(e));
                        }
                      }}
                    >
                      {t('m.common.accept')}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={async () => {
                        try {
                          await api.me.declineFriend(r.id);
                          setRequests((x) => x.filter((y) => y.id !== r.id));
                        } catch (e) {
                          toast(errorMessage(e));
                        }
                      }}
                    >
                      {t('m.common.decline')}
                    </Button>
                  </>
                }
              />
            ))}
          </List>
        </section>
      ) : null}

      {items === null && failed ? (
        <EmptyState
          title={t('inbox.loadFailed')}
          body={failed}
          action={
            <Button
              onClick={() => {
                setFailed(null);
                void load();
              }}
            >
              {t('m.common.retry')}
            </Button>
          }
        />
      ) : items === null ? (
        <Skeleton height={240} />
      ) : items.length ? (
        <List label={t('chat.conversations')}>
          {items.map((c) => {
            const others = c.members.filter((m) => m.id !== me?.id);
            const last = c.lastMessage;
            // Said from what it is (a location, a game, an offer, a story reply, a call), in your language.
            const lastText = last ? lastMessageText(last, { t, tp, locale, meId: me?.id }) : '';
            return (
              <ListItem
                key={c.id}
                href={`/inbox/${c.id}`}
                linkAs={NextLink}
                start={
                  others.length > 1 ? (
                    <AvatarGroup>
                      {others.slice(0, 2).map((m) => (
                        <Avatar key={m.id} name={m.displayName} src={m.avatarUrl} size="sm" />
                      ))}
                    </AvatarGroup>
                  ) : (
                    <Avatar name={others[0]?.displayName ?? '?'} src={others[0]?.avatarUrl} />
                  )
                }
                primary={conversationTitle(c, me!.id, t('m.chat.justYou'))}
                secondary={
                  last ? (last.sender.id === me?.id && last.kind !== 'system' ? t('chat.lastFromYou', { text: lastText }) : lastText) : t('m.inbox.noMessages')
                }
                end={
                  <>
                    {formatRelativeTime(c.updatedAt, locale)}
                    {c.unreadCount ? <span className="yp-unread">{c.unreadCount}</span> : null}
                  </>
                }
              />
            );
          })}
        </List>
      ) : (
        <EmptyState title={t('m.inbox.empty.title')} body={t('inbox.empty')} />
      )}

      <NewGroupSheet open={newGroup} onClose={() => setNewGroup(false)} onCreated={(id) => router.push(`/inbox/${id}`)} />
    </div>
  );
}

function NewGroupSheet({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (id: string) => void }) {
  const { t, toast } = useSession();
  const [title, setTitle] = useState('');
  const [picked, setPicked] = useState<PublicUser[]>([]);
  const [busy, setBusy] = useState(false);
  return (
    <BottomSheet open={open} onClose={onClose} title={t('inbox.newGroup')}>
      <div className="stack">
        <TextField label={t('chat.groupName')} value={title} onChange={(e) => setTitle(e.currentTarget.value)} maxLength={80} />
        <PeoplePicker picked={picked} onChange={setPicked} />
        <Button
          disabled={!picked.length}
          loading={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const { conversation } = await api.conversations.create(
                picked.map((p) => p.id),
                title.trim() || (picked.length > 1 ? picked.map((p) => p.displayName.split(' ')[0]).join(', ') : undefined),
              );
              onCreated(conversation.id);
            } catch (e) {
              toast(errorMessage(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          {t('m.group.start')}
        </Button>
      </div>
    </BottomSheet>
  );
}
