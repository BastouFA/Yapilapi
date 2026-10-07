'use client';

import { useEffect, useState } from 'react';
import { Avatar, BottomSheet, Button, Skeleton, TextField } from '@yapilapi/design-system';
import type { Conversation, Post } from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/app/providers';
import { chatName } from './WatchTogether';

const MAX_CHATS = 20;

/**
 * "Send in a chat": pick one or more of your chats (one-to-one or groups), add a note if you
 * like, and the post or reel goes there as a message with its link. The server counts it as a
 * share, so this doesn't record a feed 'share' event as well.
 */
export function SendToChatSheet({ post, onClose, onSent }: { post: Post | null; onClose: () => void; onSent?: (post: Post, chats: number) => void }) {
  const { me, t, toast } = useSession();
  const [chats, setChats] = useState<Conversation[] | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const open = !!post;

  useEffect(() => {
    if (!open) return;
    let live = true;
    setChats(null);
    setPicked([]);
    setNote('');
    api.conversations.list().then(
      (r) => live && setChats(r.items.filter((c) => c.kind === 'direct' || c.kind === 'group')),
      (e) => {
        if (!live) return;
        setChats([]);
        toast(errorMessage(e));
      },
    );
    return () => {
      live = false;
    };
  }, [open, toast]);

  // Up to 20 chats at a time (as the server allows).
  const toggle = (id: string) => setPicked((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : cur.length >= MAX_CHATS ? cur : [...cur, id]));

  async function send() {
    if (!post || !picked.length) return;
    setBusy(true);
    try {
      const body = note.trim();
      const r = await api.posts.send(post.id, { conversationIds: picked, ...(body ? { body } : {}) });
      const failed = r.failed[0]?.message;
      if (r.conversationIds.length) {
        toast(failed ? `${t('post.send.sent')} ${failed}` : t('post.send.sent'));
        onSent?.(post, r.conversationIds.length);
        onClose();
      } else if (failed) {
        toast(failed);
      }
    } catch (e) {
      toast(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <BottomSheet open={open} onClose={onClose} title={t('post.send.action')}>
      <p className="muted watch-pick__hint">{t('post.send.hint')}</p>
      {chats === null ? (
        <Skeleton height={160} />
      ) : chats.length ? (
        <>
          <ul className="watch-pick send-pick">
            {chats.map((c) => {
              const others = c.members.filter((m) => m.id !== me?.id);
              const face = others[0] ?? c.members[0];
              const on = picked.includes(c.id);
              return (
                <li key={c.id}>
                  <label className="watch-pick__row send-pick__row">
                    <input
                      type="checkbox"
                      className="send-pick__check"
                      checked={on}
                      disabled={busy || (!on && picked.length >= MAX_CHATS)}
                      onChange={() => toggle(c.id)}
                    />
                    {face ? (
                      <span aria-hidden>
                        <Avatar name={c.title || face.displayName} src={c.kind === 'direct' ? face.avatarUrl : null} size="sm" />
                      </span>
                    ) : null}
                    <span className="watch-pick__text">
                      <bdi className="watch-pick__name">{chatName(c, me?.id)}</bdi>
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
          <TextField label={t('post.send.note')} value={note} maxLength={1000} onChange={(e) => setNote(e.currentTarget.value)} className="send-pick__note" />
          <div className="send-pick__actions">
            <Button icon="send" onClick={() => void send()} disabled={!picked.length} loading={busy}>
              {t('inbox.send')}
            </Button>
          </div>
        </>
      ) : (
        <p className="muted">{t('post.send.empty')}</p>
      )}
    </BottomSheet>
  );
}
