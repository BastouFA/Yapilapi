'use client';

import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Avatar,
  AvatarGroup,
  BottomSheet,
  Button,
  Dialog,
  EmptyState,
  Icon,
  Menu,
  Segments,
  Select,
  Skeleton,
  Switch,
  TextField,
  type MenuAction,
} from '@yapilapi/design-system';
import {
  noticeText,
  CHAPTER_AUDIENCES,
  TOGETHER_DESCRIPTION_MAX,
  TOGETHER_POST_MAX,
  TOGETHER_TITLE_MAX,
  type MessageKey,
  type PublicUser,
  type TogetherDetail,
  type TogetherItem,
  type TogetherJoinRequest,
  type TogetherView,
  type TogetherWindow,
  withItems,
} from '@yapilapi/shared';
import { FeatureOff } from '@/components/FeatureOff';
import { PeoplePicker } from '@/components/PeoplePicker';
import { QrCode } from '@/components/ProfilePlus';
import {
  AddButtons,
  AddSheet,
  AlbumCover,
  BestOf,
  GridView,
  MomentsView,
  PeopleView,
  Section,
  statusText,
  thumbOf,
  WindowPicker,
  windowClosesAt,
} from '@/components/Together';
import { ScreenLoading } from '@/components/Loading';
import { api, errorMessage, isGone } from '@/lib/api';
import { useRealtime, useSession } from '../../../providers';

// The full-screen viewer and the slideshow download when one of them opens.
const Viewer = dynamic(() => import('@/components/TogetherViewer').then((m) => m.Viewer), {
  ssr: false,
  loading: () => <ScreenLoading className="tg-viewer" />,
});
const Slideshow = dynamic(() => import('@/components/TogetherViewer').then((m) => m.Slideshow), {
  ssr: false,
  loading: () => <ScreenLoading className="tg-show" />,
});

const VIEW_KEY = 'yp.together.view';

function readView(): TogetherView {
  try {
    const v = localStorage.getItem(VIEW_KEY);
    return v === 'people' || v === 'grid' ? v : 'moments';
  } catch {
    return 'moments';
  }
}

/** Hosts: people asking to join with the invite link. */
function Requests({ album, onChanged }: { album: TogetherDetail; onChanged: () => void }) {
  const { t, toast } = useSession();
  const [items, setItems] = useState<TogetherJoinRequest[] | null>(null);
  const load = useCallback(
    () =>
      api.together.requests(album.id).then(
        (r) => setItems(r.items),
        () => setItems([]),
      ),
    [album.id],
  );
  useEffect(() => {
    void load();
  }, [load, album.requestCount]);
  if (!items?.length) return null;
  return (
    <Section title={t('together.requests.title')}>
      <ul className="tg-requests">
        {items.map((r) => (
          <li key={r.user.id}>
            <Avatar name={r.user.displayName} src={r.user.avatarUrl} size="sm" />
            <span className="tg-requests__who">
              <bdi>{r.user.displayName}</bdi>
              <span className="tg-muted">
                @{r.user.username}
                {r.friend ? ` · ${t('together.requests.friend')}` : ''}
              </span>
            </span>
            <Button
              size="sm"
              onClick={async () => {
                try {
                  await api.together.decide(album.id, r.user.id, true);
                  await load();
                  onChanged();
                } catch (e) {
                  toast(errorMessage(e));
                }
              }}
            >
              {t('together.requests.approve')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={async () => {
                try {
                  await api.together.decide(album.id, r.user.id, false);
                  await load();
                  onChanged();
                } catch (e) {
                  toast(errorMessage(e));
                }
              }}
            >
              {t('together.requests.decline')}
            </Button>
          </li>
        ))}
      </ul>
    </Section>
  );
}

/** Hosts: the invite link and its QR code, for guests at the event. */
function InviteSheet({ album, open, onClose, onChanged }: { album: TogetherDetail; open: boolean; onClose: () => void; onChanged: () => void }) {
  const { t, toast } = useSession();
  const [invite, setInvite] = useState(album.invite);
  useEffect(() => setInvite(album.invite), [album.invite]);
  const url = invite?.code && typeof location !== 'undefined' ? `${location.origin}/together/join/${invite.code}` : null;
  const set = async (enabled: boolean, reset = false) => {
    try {
      setInvite((await api.together.setInvite(album.id, enabled, reset)).invite);
      onChanged();
    } catch (e) {
      toast(errorMessage(e));
    }
  };
  return (
    <BottomSheet open={open} onClose={onClose} title={t('together.inviteSheet.title')}>
      <div className="stack">
        <Switch label={t('together.inviteSheet.on')} checked={!!invite?.enabled} onChange={(on) => void set(on)} />
        <p className="tg-muted">{t('together.inviteSheet.hint')}</p>
        {invite?.enabled && url ? (
          <div className="tg-invite">
            <div className="tg-invite__qr">
              <QrCode value={url} label={t('together.inviteSheet.qr', { title: album.title })} />
            </div>
            <code className="tg-invite__url">{url}</code>
            <div className="row">
              <Button
                icon="link"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(url);
                    toast(t('together.inviteSheet.copied'));
                  } catch {
                    toast(url);
                  }
                }}
              >
                {t('together.inviteSheet.copy')}
              </Button>
              <Button variant="ghost" onClick={() => void set(true, true)}>
                {t('together.inviteSheet.reset')}
              </Button>
            </div>
            <span className="yp-field__hint">{t('together.inviteSheet.resetHint')}</span>
          </div>
        ) : null}
      </div>
    </BottomSheet>
  );
}

/** Everyone in it; hosts add people, choose co-hosts and take people out. */
function PeopleSheet({
  album,
  open,
  onClose,
  onChanged,
}: {
  album: TogetherDetail;
  open: boolean;
  onClose: () => void;
  onChanged: (a: TogetherDetail) => void;
}) {
  const { t, tp, toast, me } = useSession();
  const [adding, setAdding] = useState<PublicUser[]>([]);
  const [busy, setBusy] = useState(false);
  const run = async (p: Promise<{ together: TogetherDetail; added?: number; skipped?: number }>) => {
    setBusy(true);
    try {
      const r = await p;
      onChanged(r.together);
      if (r.added !== undefined) toast(tp('together.members.added', r.added));
      if (r.skipped) toast(tp('together.create.skipped', r.skipped));
    } catch (e) {
      toast(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <BottomSheet open={open} onClose={onClose} title={t('together.members.title')}>
      <div className="stack">
        <ul className="tg-members">
          {album.members.map((m) => {
            const actions: MenuAction[] = [];
            if (album.myRole === 'host' && m.role !== 'host')
              actions.push({
                label: m.role === 'cohost' ? t('together.members.makeMember') : t('together.members.makeCohost'),
                icon: 'user',
                onSelect: () => void run(api.together.setRole(album.id, m.user.id, m.role === 'cohost' ? 'member' : 'cohost')),
              });
            if (album.canManage && m.user.id !== me?.id && m.role !== 'host' && (album.myRole === 'host' || m.role === 'member'))
              actions.push({
                label: t('together.members.remove'),
                icon: 'x',
                danger: true,
                onSelect: () => void run(api.together.removeMember(album.id, m.user.id)),
              });
            return (
              <li key={m.user.id}>
                <Avatar name={m.user.displayName} src={m.user.avatarUrl} size="sm" />
                <span className="tg-members__who">
                  <Link href={`/u/${m.user.username}`}>
                    <bdi>{m.user.displayName}</bdi>
                  </Link>
                  <span className="tg-muted">
                    {t(`together.role.${m.role}` as MessageKey)} · {tp('together.items', m.items)}
                  </span>
                </span>
                {actions.length ? <Menu label={t('together.members.options', { name: m.user.displayName })} actions={actions} /> : null}
              </li>
            );
          })}
        </ul>
        {album.canManage ? (
          <div className="stack-sm">
            <PeoplePicker
              picked={adding}
              onChange={setAdding}
              label={t('together.members.add')}
              canPick={(s) => s.relation === 'friend'}
              unavailable={t('together.who.friendsOnly')}
              exclude={album.members.map((m) => m.user.id)}
            />
            <div className="row">
              <Button
                disabled={!adding.length}
                loading={busy}
                onClick={() => void run(api.together.addMembers(album.id, { userIds: adding.map((p) => p.id) })).then(() => setAdding([]))}
              >
                {t('together.members.addPicked')}
              </Button>
              {album.conversationId ? (
                <Button variant="secondary" disabled={busy} onClick={() => void run(api.together.addMembers(album.id, { fromChat: true }))}>
                  {t('together.members.fromChat')}
                </Button>
              ) : null}
              {album.eventId ? (
                <Button variant="secondary" disabled={busy} onClick={() => void run(api.together.addMembers(album.id, { fromEvent: true }))}>
                  {t('together.members.fromEvent')}
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </BottomSheet>
  );
}

/** Hosts: rename, describe, choose the cover and change when it closes. */
function EditSheet({ album, open, onClose, onSaved }: { album: TogetherDetail; open: boolean; onClose: () => void; onSaved: (a: TogetherDetail) => void }) {
  const { t, toast } = useSession();
  const [title, setTitle] = useState(album.title);
  const [description, setDescription] = useState(album.description);
  const [coverId, setCoverId] = useState<string | null>(null);
  const [changeEnd, setChangeEnd] = useState(false);
  const [win, setWin] = useState<TogetherWindow>('day');
  const [custom, setCustom] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setTitle(album.title);
    setDescription(album.description);
    setCoverId(null);
    setChangeEnd(false);
  }, [open, album.title, album.description]);
  const closesAt = windowClosesAt(win, custom);
  const photos = album.items.filter((i) => !i.media.sensitive).slice(-60);
  return (
    <BottomSheet open={open} onClose={onClose} title={t('together.edit')}>
      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          if (changeEnd && closesAt === undefined) return;
          setBusy(true);
          try {
            const r = await api.together.update(album.id, {
              title: title.trim(),
              description: description.trim(),
              ...(coverId ? { coverItemId: coverId } : {}),
              ...(changeEnd ? { closesAt } : {}),
            });
            onSaved(r.together);
            toast(t('together.saved'));
            onClose();
          } catch (err) {
            toast(errorMessage(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <TextField label={t('together.create.name')} value={title} maxLength={TOGETHER_TITLE_MAX} required onChange={(e) => setTitle(e.currentTarget.value)} />
        <TextField
          label={t('together.create.description')}
          multiline
          rows={2}
          value={description}
          maxLength={TOGETHER_DESCRIPTION_MAX}
          onChange={(e) => setDescription(e.currentTarget.value)}
        />
        {photos.length ? (
          <fieldset className="tg-cover-pick">
            <legend className="yp-field__label">{t('together.create.cover')}</legend>
            <div className="tg-cover-pick__grid">
              {photos.map((p) => (
                <label key={p.id} className="tg-cover-pick__item">
                  <input type="radio" name="tg-cover" value={p.id} checked={coverId === p.id} onChange={() => setCoverId(p.id)} />
                  <img
                    src={thumbOf(p) ?? ''}
                    alt={t(p.media.kind === 'video' ? 'together.tile.video' : 'together.tile.photo', { name: p.author.displayName, time: '' })}
                    loading="lazy"
                    decoding="async"
                  />
                </label>
              ))}
            </div>
          </fieldset>
        ) : null}
        {album.status === 'open' ? (
          <>
            <Switch label={t('together.edit.changeEnd')} checked={changeEnd} onChange={setChangeEnd} />
            {changeEnd ? <WindowPicker value={win} custom={custom} onChange={(w, c) => (setWin(w), setCustom(c))} /> : null}
          </>
        ) : null}
        <Button type="submit" loading={busy} disabled={!title.trim() || (changeEnd && closesAt === undefined)}>
          {t('common.save')}
        </Button>
      </form>
    </BottomSheet>
  );
}

/** Hosts: open it again, until a time or until a host closes it. */
function ReopenSheet({ album, open, onClose, onSaved }: { album: TogetherDetail; open: boolean; onClose: () => void; onSaved: (a: TogetherDetail) => void }) {
  const { t, toast } = useSession();
  const [win, setWin] = useState<TogetherWindow>('day');
  const [custom, setCustom] = useState('');
  const closesAt = windowClosesAt(win, custom);
  return (
    <BottomSheet open={open} onClose={onClose} title={t('together.reopenTitle')}>
      <div className="stack">
        <WindowPicker value={win} custom={custom} onChange={(w, c) => (setWin(w), setCustom(c))} />
        <Button
          disabled={closesAt === undefined}
          onClick={async () => {
            if (closesAt === undefined) return;
            try {
              onSaved((await api.together.reopen(album.id, closesAt)).together);
              onClose();
            } catch (e) {
              toast(errorMessage(e));
            }
          }}
        >
          {t('together.reopen')}
        </Button>
      </div>
    </BottomSheet>
  );
}

/** Your own photos from it as one post (up to the carousel limit), best of first. */
function PostSheet({ album, open, onClose }: { album: TogetherDetail; open: boolean; onClose: () => void }) {
  const { t, toast } = useSession();
  const mine = useMemo(() => album.items.filter((i) => i.mine && !i.media.processing), [album.items]);
  const [picked, setPicked] = useState<string[]>([]);
  const [caption, setCaption] = useState('');
  const [visibility, setVisibility] = useState<'friends' | 'followers' | 'public'>('friends');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    const best = mine.filter((i) => i.best).map((i) => i.id);
    setPicked((best.length ? best : mine.map((i) => i.id)).slice(0, TOGETHER_POST_MAX));
    setCaption(album.title);
  }, [open, mine, album.title]);
  return (
    <BottomSheet open={open} onClose={onClose} title={t('together.post.title')}>
      {mine.length ? (
        <form
          className="stack"
          onSubmit={async (e) => {
            e.preventDefault();
            const chosen = mine.filter((i) => picked.includes(i.id));
            if (!chosen.length) return;
            setBusy(true);
            try {
              const r = await api.posts.create({
                body: caption.trim(),
                visibility,
                media: chosen.map((i) => ({ id: i.media.id, url: new URL(i.media.url, location.origin).toString(), kind: i.media.kind })),
              });
              toast(noticeText(r.moderation, t) ?? t('together.post.done'));
              onClose();
            } catch (err) {
              toast(errorMessage(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          <fieldset className="tg-cover-pick">
            <legend className="yp-field__label">{t('together.post.pick', { count: TOGETHER_POST_MAX })}</legend>
            <div className="tg-cover-pick__grid">
              {mine.map((p) => (
                <label key={p.id} className="tg-cover-pick__item">
                  <input
                    type="checkbox"
                    checked={picked.includes(p.id)}
                    disabled={!picked.includes(p.id) && picked.length >= TOGETHER_POST_MAX}
                    onChange={(e) => {
                      const on = e.currentTarget.checked;
                      setPicked((cur) => (on ? [...cur, p.id] : cur.filter((x) => x !== p.id)));
                    }}
                  />
                  <img
                    src={thumbOf(p) ?? ''}
                    loading="lazy"
                    decoding="async"
                    alt={p.caption || t(p.media.kind === 'video' ? 'together.tile.video' : 'together.tile.photo', { name: p.author.displayName, time: '' })}
                  />
                </label>
              ))}
            </div>
          </fieldset>
          <TextField
            label={t('together.post.caption')}
            multiline
            rows={2}
            value={caption}
            maxLength={2200}
            onChange={(e) => setCaption(e.currentTarget.value)}
          />
          <Select label={t('m.chapters.audience')} value={visibility} onChange={(e) => setVisibility(e.currentTarget.value as typeof visibility)}>
            {(['friends', 'followers', 'public'] as const).map((v) => (
              <option key={v} value={v}>
                {t(`visibility.${v}` as MessageKey)}
              </option>
            ))}
          </Select>
          <Button type="submit" loading={busy} disabled={!picked.length}>
            {t('together.post.submit')}
          </Button>
        </form>
      ) : (
        <p className="tg-muted">{t('together.after.noneOwn')}</p>
      )}
    </BottomSheet>
  );
}

/** A chapter from your own photos in it. */
function ChapterSheet({ album, open, onClose }: { album: TogetherDetail; open: boolean; onClose: () => void }) {
  const { t, toast } = useSession();
  const router = useRouter();
  const [audience, setAudience] = useState<(typeof CHAPTER_AUDIENCES)[number]>('friends');
  const [busy, setBusy] = useState(false);
  const mine = album.items.filter((i) => i.mine).length;
  return (
    <BottomSheet open={open} onClose={onClose} title={t('together.after.chapter')}>
      {mine ? (
        <div className="stack">
          <p className="tg-muted">{t('together.chapter.body')}</p>
          <Select label={t('m.chapters.audience')} value={audience} onChange={(e) => setAudience(e.currentTarget.value as typeof audience)}>
            {CHAPTER_AUDIENCES.map((a) => (
              <option key={a} value={a}>
                {t(`m.chapters.audience.${a}` as MessageKey)}
              </option>
            ))}
          </Select>
          <Button
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const r = await api.together.chapter(album.id, { audience });
                toast(t('together.after.chapterDone'));
                router.push(`/chapters/${r.chapter.id}`);
              } catch (e) {
                toast(errorMessage(e));
                setBusy(false);
              }
            }}
          >
            {t('together.chapter.submit')}
          </Button>
        </div>
      ) : (
        <p className="tg-muted">{t('together.after.noneOwn')}</p>
      )}
    </BottomSheet>
  );
}

type Sheet = 'invite' | 'people' | 'edit' | 'reopen' | 'post' | 'chapter' | null;
type Confirm = 'close' | 'leave' | 'delete' | null;

export default function TogetherPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { flags, t, tp, toast, locale } = useSession();
  const [album, setAlbum] = useState<TogetherDetail | null>(null);
  const [missing, setMissing] = useState(false);
  // Why it couldn't load, when that isn't because it's gone or private; an album already showing stays.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [view, setView] = useState<TogetherView>('moments');
  const [open, setOpen] = useState<string | null>(null);
  const [show, setShow] = useState(false);
  const [files, setFiles] = useState<File[] | null>(null);
  const [sheet, setSheet] = useState<Sheet>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [announce, setAnnounce] = useState('');
  const [making, setMaking] = useState(false);

  useEffect(() => setView(readView()), []);
  const load = useCallback(() => {
    setLoadError(null);
    return api.together.get(id).then(
      (r) => (setAlbum(r.together), setMissing(false)),
      (e) => (isGone(e) ? setMissing(true) : setLoadError(errorMessage(e))),
    );
  }, [id]);
  useEffect(() => {
    if (flags.REAL_TOGETHER) void load();
  }, [load, flags.REAL_TOGETHER]);

  useRealtime((e) => {
    if (e.data?.togetherId !== id) return;
    if (e.type === 'together.items') {
      const before = album?.items.length ?? 0;
      void api.together.get(id).then(
        (r) => {
          setAlbum(r.together);
          const more = r.together.items.length - before;
          if (more > 0 && !e.data?.removed) setAnnounce(tp('together.show.new', more));
        },
        () => {},
      );
    }
    if (e.type === 'together.item')
      void api.together.item(id, e.data.itemId).then(
        (r) =>
          setAlbum((a) =>
            a
              ? withItems(
                  a,
                  a.items.map((x) => (x.id === r.item.id ? r.item : x)),
                )
              : a,
          ),
        () => {},
      );
    if (e.type === 'together.updated' || e.type === 'together.requests') void load();
  });

  // The best of follows stars and reactions straight away.
  const replaceItem = useCallback(
    (item: TogetherItem) =>
      setAlbum((a) =>
        a
          ? withItems(
              a,
              a.items.map((x) => (x.id === item.id ? item : x)),
            )
          : a,
      ),
    [],
  );

  if (!flags.REAL_TOGETHER) return <FeatureOff name="Together" />;
  if (missing)
    return (
      <div className="yp-shell__inner">
        <EmptyState
          level={1}
          title={t('together.missing')}
          body={t('together.missingBody')}
          action={
            <Link href="/together" className="yp-btn yp-btn--secondary">
              {t('together.title')}
            </Link>
          }
        />
      </div>
    );
  if (!album && loadError)
    return (
      <div className="yp-shell__inner">
        <EmptyState level={1} title={loadError} action={<Button onClick={() => void load()}>{t('m.common.retry')}</Button>} />
      </div>
    );
  if (!album)
    return (
      <div className="yp-shell__inner stack">
        <Skeleton height={220} />
        <Skeleton height={120} />
      </div>
    );

  const a = album;
  const pickView = (v: TogetherView) => {
    setView(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      /* private mode */
    }
  };
  const onOpen = (itemId: string) => setOpen(itemId);
  const hero = a.cover?.url ?? a.cover?.thumbUrl ?? null;

  const menu: MenuAction[] = [
    { label: t('together.members.title'), icon: 'users', onSelect: () => setSheet('people') },
    ...(a.canManage
      ? [
          { label: t('together.edit'), icon: 'edit' as const, onSelect: () => setSheet('edit') },
          { label: t('together.invite'), icon: 'user-plus' as const, onSelect: () => setSheet('invite') },
          a.status === 'open'
            ? { label: t('together.close'), icon: 'lock' as const, onSelect: () => setConfirm('close') }
            : { label: t('together.reopen'), icon: 'clock' as const, onSelect: () => setSheet('reopen') },
        ]
      : []),
    ...(a.myRole !== 'host' ? [{ label: t('together.leave'), icon: 'logout' as const, onSelect: () => setConfirm('leave') }] : []),
    ...(a.myRole === 'host' ? [{ label: t('together.delete'), icon: 'trash' as const, danger: true, onSelect: () => setConfirm('delete') }] : []),
  ];

  async function makeRecap() {
    setMaking(true);
    try {
      const r = await api.together.recap(a.id);
      toast(t('together.after.recapStarted'));
      router.push(`/recaps?open=${r.recap.id}`);
    } catch (e) {
      toast(errorMessage(e));
      setMaking(false);
    }
  }

  const confirmCopy: Record<Exclude<Confirm, null>, { title: MessageKey; body: MessageKey; ok: MessageKey }> = {
    close: { title: 'together.closeTitle', body: 'together.closeBody', ok: 'together.close' },
    leave: { title: 'together.leaveTitle', body: 'together.leaveBody', ok: 'together.leave' },
    delete: { title: 'together.deleteTitle', body: 'together.deleteBody', ok: 'together.deleteConfirm' },
  };

  return (
    <div className="yp-shell__inner tg-page">
      <header className="tg-hero">
        <div className="tg-hero__art" aria-hidden>
          {hero ? <img src={hero} alt="" /> : <span className="tg-hero__blank" />}
        </div>
        <div className="tg-hero__top">
          <Link href="/together" className="tg-hero__btn" aria-label={t('together.title')}>
            <Icon name="arrow-left" />
          </Link>
          <Menu label={t('together.options')} actions={menu} />
        </div>
        <div className="tg-hero__text">
          <span className={a.status === 'open' ? 'tg-status tg-status--open tg-status--hero' : 'tg-status tg-status--hero'}>{statusText(a, t, locale)}</span>
          <h1>
            <bdi>{a.title}</bdi>
          </h1>
          {a.description ? (
            <p className="tg-hero__desc" dir="auto">
              {a.description}
            </p>
          ) : null}
          <button type="button" className="tg-hero__people" onClick={() => setSheet('people')}>
            <AvatarGroup>
              {a.members.slice(0, 5).map((m) => (
                <Avatar key={m.user.id} name={m.user.displayName} src={m.user.avatarUrl} size="sm" />
              ))}
            </AvatarGroup>
            <span>
              {tp('together.people', a.memberCount)} · {tp('together.items', a.items.length)}
            </span>
          </button>
          {a.event ? (
            <Link href={`/events/${a.event.id}`} className="tg-hero__event">
              <Icon name="calendar" size={16} /> {t('together.event', { title: a.event.title })}
            </Link>
          ) : null}
        </div>
      </header>

      <div className="tg-actions">
        {a.canAdd ? <AddButtons onFiles={setFiles} /> : <p className="tg-muted">{t('together.add.closed')}</p>}
        {a.items.length ? (
          <Button variant="secondary" icon="play" onClick={() => setShow(true)}>
            {t('together.slideshow')}
          </Button>
        ) : null}
        {a.canManage ? (
          <Button variant="ghost" icon="user-plus" onClick={() => setSheet('invite')}>
            {t('together.invite')}
          </Button>
        ) : null}
      </div>
      <p className="yp-visually-hidden" aria-live="polite">
        {announce}
      </p>

      {a.canManage && a.requestCount ? <Requests album={a} onChanged={() => void load()} /> : null}

      {a.status === 'closed' && a.items.length ? (
        <section className="tg-after" aria-labelledby="tg-after-title">
          <h2 id="tg-after-title">{t('together.after.title')}</h2>
          <p className="tg-muted">{t('together.after.body')}</p>
          <div className="tg-after__row">
            <button type="button" className="tg-after__card" onClick={() => void makeRecap()} disabled={making} aria-busy={making || undefined}>
              <Icon name="play" />
              <strong>{t('together.after.recap')}</strong>
              <span>{t('together.after.recapHint')}</span>
            </button>
            <button type="button" className="tg-after__card" onClick={() => setSheet('post')}>
              <Icon name="create" />
              <strong>{t('together.after.post')}</strong>
              <span>{t('together.after.postHint', { count: TOGETHER_POST_MAX })}</span>
            </button>
            <button type="button" className="tg-after__card" onClick={() => setSheet('chapter')}>
              <Icon name="bookmark" />
              <strong>{t('together.after.chapter')}</strong>
              <span>{t('together.after.chapterHint')}</span>
            </button>
          </div>
        </section>
      ) : null}

      {a.items.length ? (
        <>
          <BestOf album={a} onOpen={onOpen} />
          <div className="tg-viewbar">
            <Segments<TogetherView>
              label={t('together.view.label')}
              value={view}
              onChange={pickView}
              options={[
                { id: 'moments', label: t('together.view.moments') },
                { id: 'people', label: t('together.view.people') },
                { id: 'grid', label: t('together.view.grid') },
              ]}
            />
          </div>
          {view === 'moments' ? (
            <MomentsView items={a.items} onOpen={onOpen} />
          ) : view === 'people' ? (
            <PeopleView items={a.items} onOpen={onOpen} />
          ) : (
            <GridView items={a.items} onOpen={onOpen} />
          )}
        </>
      ) : (
        <EmptyState title={t('together.noItems')} body={a.canAdd ? t('together.noItemsBody') : t('together.noItemsClosed')} />
      )}

      {open ? (
        <Viewer
          album={a}
          items={a.items}
          startId={open}
          onClose={() => setOpen(null)}
          onItem={replaceItem}
          onRemoved={(rid) =>
            setAlbum((x) =>
              x
                ? withItems(
                    x,
                    x.items.filter((i) => i.id !== rid),
                  )
                : x,
            )
          }
        />
      ) : null}
      {show ? <Slideshow album={a} onClose={() => setShow(false)} /> : null}
      {files ? (
        <AddSheet
          album={a}
          files={files}
          onClose={() => setFiles(null)}
          onAdded={() => {
            void load();
          }}
        />
      ) : null}
      <InviteSheet album={a} open={sheet === 'invite'} onClose={() => setSheet(null)} onChanged={() => void load()} />
      <PeopleSheet album={a} open={sheet === 'people'} onClose={() => setSheet(null)} onChanged={setAlbum} />
      <EditSheet album={a} open={sheet === 'edit'} onClose={() => setSheet(null)} onSaved={setAlbum} />
      <ReopenSheet album={a} open={sheet === 'reopen'} onClose={() => setSheet(null)} onSaved={setAlbum} />
      <PostSheet album={a} open={sheet === 'post'} onClose={() => setSheet(null)} />
      <ChapterSheet album={a} open={sheet === 'chapter'} onClose={() => setSheet(null)} />
      <Dialog
        open={!!confirm}
        onClose={() => setConfirm(null)}
        title={confirm ? t(confirmCopy[confirm].title) : ''}
        footer={
          confirm ? (
            <>
              <Button variant="ghost" onClick={() => setConfirm(null)}>
                {t('common.cancel')}
              </Button>
              <Button
                variant={confirm === 'close' ? 'primary' : 'danger'}
                onClick={async () => {
                  const what = confirm;
                  setConfirm(null);
                  try {
                    if (what === 'close') setAlbum((await api.together.close(a.id)).together);
                    if (what === 'leave') {
                      await api.together.leave(a.id);
                      router.push('/together');
                    }
                    if (what === 'delete') {
                      await api.together.remove(a.id);
                      router.push('/together');
                    }
                  } catch (e) {
                    toast(errorMessage(e));
                  }
                }}
              >
                {t(confirmCopy[confirm].ok)}
              </Button>
            </>
          ) : null
        }
      >
        {confirm ? <p>{t(confirmCopy[confirm].body)}</p> : null}
      </Dialog>
    </div>
  );
}
