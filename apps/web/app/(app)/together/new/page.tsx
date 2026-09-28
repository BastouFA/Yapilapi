'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';
import { Avatar, Button, Icon, Select, Switch, TextField } from '@yapilapi/design-system';
import { TOGETHER_DESCRIPTION_MAX, TOGETHER_TITLE_MAX, type EventItem, type PublicUser, type TogetherWindow } from '@yapilapi/shared';
import { FeatureOff } from '@/components/FeatureOff';
import { PeoplePicker } from '@/components/PeoplePicker';
import { WindowPicker, windowClosesAt } from '@/components/Together';
import { api, errorMessage, fieldErrors } from '@/lib/api';
import { useSession } from '../../../providers';

/**
 * Start an album: a name, a description, a cover, when it's open for adding, and who's in it:
 * friends you pick (any of them can be a co-host), everyone in a chat (from the chat's menu,
 * `?chat=`), or everyone going to an event (`?event=`, or chosen here). Guests who aren't
 * friends can ask to join with the invite link.
 */
function NewAlbum() {
  const { flags, t, tp, toast } = useSession();
  const router = useRouter();
  const params = useSearchParams();
  const chatId = params.get('chat');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [win, setWin] = useState<TogetherWindow>('weekend');
  const [custom, setCustom] = useState('');
  const [picked, setPicked] = useState<PublicUser[]>([]);
  const [cohosts, setCohosts] = useState<Set<string>>(new Set());
  const [chatName, setChatName] = useState<string | null>(null);
  const [events, setEvents] = useState<EventItem[]>([]);
  const [eventId, setEventId] = useState(params.get('event') ?? '');
  const [link, setLink] = useState(false);
  const [cover, setCover] = useState<File | null>(null);
  const [coverUrl, setCoverUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const coverInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!flags.REAL_TOGETHER) return;
    if (chatId)
      api.conversations.get(chatId).then(
        (r) => setChatName(r.conversation.title || r.conversation.members.map((m) => m.displayName).join(', ')),
        () => setChatName(null),
      );
    void Promise.all([api.events.list('going').catch(() => ({ items: [] })), api.events.list('hosting').catch(() => ({ items: [] }))]).then(([a, b]) => {
      const seen = new Set<string>();
      setEvents([...b.items, ...a.items].filter((e) => !seen.has(e.id) && seen.add(e.id)));
    });
  }, [flags.REAL_TOGETHER, chatId]);

  if (!flags.REAL_TOGETHER) return <FeatureOff name="Together" />;
  const closesAt = windowClosesAt(win, custom);

  async function submit() {
    if (!title.trim() || closesAt === undefined || busy) return;
    setBusy(true);
    setErrors({});
    try {
      const r = await api.together.create({
        title: title.trim(),
        description: description.trim(),
        closesAt,
        memberIds: picked.map((p) => p.id),
        cohostIds: [...cohosts].filter((c) => picked.some((p) => p.id === c)),
        ...(chatId ? { conversationId: chatId } : {}),
        ...(eventId ? { eventId } : {}),
        inviteLink: link,
      });
      if (r.skipped) toast(tp('together.create.skipped', r.skipped));
      // The cover goes in the album as its first photo.
      if (cover) {
        try {
          const { media } = await api.uploads.resumable(cover);
          const added = await api.together.addItems(r.together.id, [{ mediaId: media.id, takenAt: new Date(cover.lastModified || Date.now()).toISOString() }]);
          if (added.items[0]) await api.together.update(r.together.id, { coverItemId: added.items[0].id });
        } catch (e) {
          toast(errorMessage(e));
        }
      }
      router.push(`/together/${r.together.id}`);
    } catch (e) {
      setErrors(fieldErrors(e));
      toast(errorMessage(e));
      setBusy(false);
    }
  }

  return (
    <div className="yp-shell__inner tg-page">
      <div className="yp-topbar">
        <div className="row">
          <Link href="/together" className="yp-action" aria-label={t('together.title')}>
            <Icon name="arrow-left" />
          </Link>
          <h1>{t('together.create.title')}</h1>
        </div>
      </div>
      <form
        className="tg-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <TextField
          label={t('together.create.name')}
          placeholder={t('together.create.namePlaceholder')}
          value={title}
          maxLength={TOGETHER_TITLE_MAX}
          required
          error={errors.title}
          onChange={(e) => setTitle(e.currentTarget.value)}
        />
        <TextField
          label={t('together.create.description')}
          placeholder={t('together.create.descriptionPlaceholder')}
          multiline
          rows={2}
          value={description}
          maxLength={TOGETHER_DESCRIPTION_MAX}
          error={errors.description}
          onChange={(e) => setDescription(e.currentTarget.value)}
        />

        <div className="tg-form__cover">
          <span className="yp-field__label">{t('together.create.cover')}</span>
          <div className="row">
            <span className="tg-cover tg-cover--pick" aria-hidden>
              {coverUrl ? <img src={coverUrl} alt="" /> : <Icon name="image" size={28} />}
            </span>
            <div className="stack-sm">
              <Button size="sm" variant="secondary" onClick={() => coverInput.current?.click()}>
                {cover ? t('together.create.coverChange') : t('together.create.coverPick')}
              </Button>
              <span className="yp-field__hint">{t('together.create.coverHint')}</span>
            </div>
          </div>
          <input
            ref={coverInput}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => {
              const f = e.currentTarget.files?.[0];
              if (f) {
                if (coverUrl) URL.revokeObjectURL(coverUrl);
                setCover(f);
                setCoverUrl(URL.createObjectURL(f));
              }
              e.currentTarget.value = '';
            }}
          />
        </div>

        <WindowPicker value={win} custom={custom} onChange={(w, c) => (setWin(w), setCustom(c))} />

        <fieldset className="tg-who">
          <legend className="yp-field__label">{t('together.who.label')}</legend>
          {chatId ? (
            <p className="tg-who__chat">
              <Icon name="users" /> {chatName ? t('together.who.chat', { name: chatName }) : t('together.who.chatSome')}
              <span className="yp-field__hint">{t('together.who.chatNote')}</span>
            </p>
          ) : null}
          <PeoplePicker
            picked={picked}
            onChange={setPicked}
            label={t('together.who.friends')}
            hint={t('together.who.friendsHint')}
            canPick={(s) => s.relation === 'friend'}
            unavailable={t('together.who.friendsOnly')}
          />
          {picked.length ? (
            <ul className="tg-who__list">
              {picked.map((p) => (
                <li key={p.id}>
                  <Avatar name={p.displayName} src={p.avatarUrl} size="sm" />
                  <bdi className="tg-who__name">{p.displayName}</bdi>
                  <Switch
                    label={t('together.who.cohost')}
                    checked={cohosts.has(p.id)}
                    onChange={(on) =>
                      setCohosts((s) => {
                        const n = new Set(s);
                        if (on) n.add(p.id);
                        else n.delete(p.id);
                        return n;
                      })
                    }
                  />
                </li>
              ))}
            </ul>
          ) : null}
          {picked.length ? <p className="yp-field__hint">{t('together.who.cohostHint')}</p> : null}
          <Select label={t('together.who.event')} value={eventId} onChange={(e) => setEventId(e.currentTarget.value)} hint={t('together.who.eventHint')}>
            <option value="">{t('together.who.eventNone')}</option>
            {eventId && !events.some((e) => e.id === eventId) ? <option value={eventId}>{t('together.who.eventThis')}</option> : null}
            {events.map((e) => (
              <option key={e.id} value={e.id}>
                {e.title}
              </option>
            ))}
          </Select>
        </fieldset>

        <div className="tg-form__link">
          <Switch label={t('together.link.label')} checked={link} onChange={setLink} />
          <span className="yp-field__hint">{t('together.link.hint')}</span>
        </div>

        <Button type="submit" size="lg" loading={busy} disabled={!title.trim() || closesAt === undefined}>
          {t('together.create.submit')}
        </Button>
      </form>
    </div>
  );
}

export default function NewTogetherPage() {
  return (
    <Suspense>
      <NewAlbum />
    </Suspense>
  );
}
