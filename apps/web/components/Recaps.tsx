'use client';

import { useEffect, useState } from 'react';
import { Avatar, AvatarGroup, BottomSheet, Button, Select, TextField } from '@yapilapi/design-system';
import type { Conversation, MessageKey, Recap, RecapStatus } from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '../app/providers';

/** Message keys for each status; translate with t() at render. */
export const RECAP_STATUS_LABEL: Record<RecapStatus, MessageKey> = {
  queued: 'recaps.status.queued',
  rendering: 'recaps.status.rendering',
  ready: 'm.recap.status.ready',
  failed: 'recaps.status.failed',
};

export const RECAP_STYLE_CHOICES = [
  { id: 'calm', label: 'm.recap.style.calm', hint: 'recaps.style.calmHint' },
  { id: 'quick', label: 'm.recap.style.quick', hint: 'recaps.style.quickHint' },
  { id: 'film', label: 'm.recap.style.film', hint: 'recaps.style.filmHint' },
] as const satisfies readonly { id: string; label: MessageKey; hint: MessageKey }[];

/** `hint` is a message key, or null when the ratio itself (the id) is the hint. */
export const RECAP_ASPECT_CHOICES = [
  { id: '9:16', label: 'm.recap.shape.tall', hint: 'recaps.shape.tallHint' },
  { id: '1:1', label: 'm.recap.shape.square', hint: null },
] as const satisfies readonly { id: string; label: MessageKey; hint: MessageKey | null }[];

export function isPending(r: Recap): boolean {
  return r.status === 'queued' || r.status === 'rendering';
}

/** "0:12" style length. */
export function clipLength(ms: number | null | undefined): string | null {
  if (!ms) return null;
  const s = Math.max(1, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Save the finished video under its own file name. Media is served through this origin (/media/…), which lets the browser do that. */
export function downloadRecap(r: Recap) {
  if (!r.video) return;
  const url = new URL(r.video.url, location.origin);
  const a = document.createElement('a');
  a.href = url.pathname.startsWith('/media/') ? url.pathname : r.video.url;
  a.download = r.fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

const REEL_AUDIENCES = ['public', 'followers', 'friends', 'private'] as const;

/** Post a finished recap as a reel, through the normal post path. */
export function RecapPostForm({ recap, onDone, onCancel }: { recap: Recap; onDone: (postId: string) => void; onCancel: () => void }) {
  const { t, toast } = useSession();
  const [caption, setCaption] = useState('');
  const [visibility, setVisibility] = useState<(typeof REEL_AUDIENCES)[number]>('public');
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="stack-sm recap-inline"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!recap.video) return;
        setBusy(true);
        try {
          const r = await api.posts.create({
            format: 'reel',
            body: caption.trim(),
            visibility,
            media: [{ id: recap.video.mediaId, url: new URL(recap.video.url, location.origin).toString(), kind: 'video' }],
            ...(recap.sound ? { soundId: recap.sound.id } : {}),
          });
          toast(r.moderation ? r.moderation.message : t('m.recap.posted'));
          onDone(r.post.id);
        } catch (err) {
          toast(errorMessage(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <TextField label={t('recaps.captionOptional')} multiline rows={3} value={caption} maxLength={2200} onChange={(e) => setCaption(e.currentTarget.value)} />
      <Select label={t('m.chapters.audience')} value={visibility} onChange={(e) => setVisibility(e.currentTarget.value as (typeof REEL_AUDIENCES)[number])}>
        {REEL_AUDIENCES.map((v) => (
          <option key={v} value={v}>
            {t(`visibility.${v}` as MessageKey)}
          </option>
        ))}
      </Select>
      <div className="row">
        <Button type="submit" loading={busy}>
          {t('m.recap.post')}
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          {t('common.cancel')}
        </Button>
      </div>
    </form>
  );
}

function conversationTitle(c: Conversation, meId: string | undefined, justYou: string): string {
  if (c.title) return c.title;
  const others = c.members.filter((m) => m.id !== meId);
  return others.map((m) => m.displayName).join(', ') || justYou;
}

/** Pick one of your chats and send the recap there as a video message. */
export function RecapSendSheet({ recap, open, onClose }: { recap: Recap; open: boolean; onClose: () => void }) {
  const { me, toast, t } = useSession();
  const [items, setItems] = useState<Conversation[] | null>(null);
  const [q, setQ] = useState('');
  const [sending, setSending] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setQ('');
    api.conversations.list().then(
      (r) => setItems(r.items.filter((c) => c.kind !== 'community')),
      (e) => (setItems([]), toast(errorMessage(e))),
    );
  }, [open, toast]);

  const shown = (items ?? []).filter((c) => !q.trim() || conversationTitle(c, me?.id, t('recaps.justYou')).toLowerCase().includes(q.trim().toLowerCase()));

  return (
    <BottomSheet open={open} onClose={onClose} title={t('m.recap.send')}>
      <div className="stack-sm">
        <label className="yp-visually-hidden" htmlFor="recap-send-q">
          {t('recaps.searchChats')}
        </label>
        <input
          id="recap-send-q"
          className="yp-input"
          type="search"
          placeholder={t('recaps.searchChats')}
          value={q}
          onChange={(e) => setQ(e.currentTarget.value)}
        />
        {items === null ? (
          <p className="muted">{t('recaps.loadingChats')}</p>
        ) : shown.length ? (
          <ul className="guestbook">
            {shown.map((c) => {
              const others = c.members.filter((m) => m.id !== me?.id);
              const name = conversationTitle(c, me?.id, t('recaps.justYou'));
              return (
                <li key={c.id} style={{ alignItems: 'center' }}>
                  {others.length > 1 ? (
                    <AvatarGroup>
                      {others.slice(0, 2).map((m) => (
                        <Avatar key={m.id} name={m.displayName} src={m.avatarUrl} size="sm" />
                      ))}
                    </AvatarGroup>
                  ) : (
                    <Avatar name={others[0]?.displayName ?? '?'} src={others[0]?.avatarUrl} size="sm" />
                  )}
                  <div>
                    <bdi>{name}</bdi>
                  </div>
                  <Button
                    size="sm"
                    loading={sending === c.id}
                    disabled={!!sending}
                    aria-label={t('recaps.sendTo', { name })}
                    onClick={async () => {
                      if (!recap.video) return;
                      setSending(c.id);
                      try {
                        const r = await api.conversations.send(c.id, '', crypto.randomUUID(), [{ mediaId: recap.video.mediaId }]);
                        toast(r.notice ?? t('m.recap.sent', { name }));
                        onClose();
                      } catch (e) {
                        toast(errorMessage(e));
                      } finally {
                        setSending(null);
                      }
                    }}
                  >
                    {t('inbox.send')}
                  </Button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="muted">{q.trim() ? t('recaps.noChatsMatch', { query: q.trim() }) : t('recaps.noChats')}</p>
        )}
      </div>
    </BottomSheet>
  );
}
