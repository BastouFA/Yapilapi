'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Avatar,
  BottomSheet,
  Button,
  cx,
  Icon,
  Menu,
  SensitiveCover,
  Switch,
  TextField,
  useDataSaver,
  useModalFocus,
  type MenuAction,
} from '@yapilapi/design-system';
import {
  momentDayLabel,
  momentGroups,
  peopleGroups,
  TOGETHER_ADD_BATCH,
  TOGETHER_CAPTION_MAX,
  TOGETHER_COMMENT_MAX,
  TOGETHER_REACTIONS,
  TOGETHER_WINDOWS,
  togetherClosesAt,
  togetherClosesAtOk,
  type MessageKey,
  type TogetherComment,
  type TogetherCover,
  type TogetherDetail,
  type TogetherItem,
  type TogetherReaction,
  type TogetherSummary,
  type TogetherWindow,
} from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';
import { REACTION_LABEL } from '@/components/Rooms';
import { ReportSheet } from '@/components/PostList';
import { useSession, type Session } from '@/app/providers';

/*
 * Together on the web: shared albums (packages/shared/src/together.ts). The album page
 * (app/(app)/together/[id]) puts these together: the three views, the full-screen viewer with
 * stars, reactions and comments, the slideshow for a TV, the invite sheet with its QR code,
 * adding several photos and videos at once, and what to make of it afterwards.
 */

type T = Session['t'];

// ── Words ───────────────────────────────────────────────────────────────

/** "Sat 04:00", or with the date when it's more than a week away (and the year when it's another year). */
export function whenShort(iso: string, locale: string): string {
  const at = new Date(iso);
  const far = Math.abs(at.getTime() - Date.now()) > 6 * 86_400_000;
  // Another year gets the year too, so an old photo doesn't read as this year's.
  const year = at.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' as const } : {};
  try {
    return new Intl.DateTimeFormat(
      locale,
      far ? { day: 'numeric', month: 'short', ...year, hour: 'numeric', minute: '2-digit' } : { weekday: 'short', hour: 'numeric', minute: '2-digit' },
    ).format(at);
  } catch {
    return at.toLocaleString();
  }
}

/** "Open until Sat 04:00", "Open until a host closes it", "Closed". */
export function statusText(s: Pick<TogetherSummary, 'status' | 'closesAt' | 'closedAt'>, t: T, locale: string): string {
  if (s.status === 'closed') return s.closedAt ? t('together.status.closedAt', { time: whenShort(s.closedAt, locale) }) : t('together.status.closed');
  return s.closesAt ? t('together.status.until', { time: whenShort(s.closesAt, locale) }) : t('together.status.untilClosed');
}

/** The media a small tile shows: a thumbnail (or a video's poster). */
export function thumbOf(item: TogetherItem, big = false): string | null {
  const v = item.media.variants ?? {};
  if (item.media.kind === 'video') return item.media.posterUrl ?? v.thumb ?? null;
  return (big ? (v.medium ?? v.large) : (v.thumb ?? v.medium)) ?? item.media.url;
}

function tileLabel(item: TogetherItem, t: T, locale: string): string {
  const time = whenShort(item.takenAt, locale);
  const base = t(item.media.kind === 'video' ? 'together.tile.video' : 'together.tile.photo', { name: item.author.displayName, time });
  return item.starred ? `${base}. ${t('together.tile.starred')}` : base;
}

// ── Covers and cards ────────────────────────────────────────────────────

export function AlbumCover({ cover, className }: { cover: TogetherCover | null; className?: string }) {
  return (
    <span className={cx('tg-cover', className)} aria-hidden>
      {cover?.thumbUrl ? <img src={cover.thumbUrl} alt="" loading="lazy" /> : <Icon name="image" size={28} />}
    </span>
  );
}

export function AlbumCard({ album }: { album: TogetherSummary }) {
  const { t, tp, locale } = useSession();
  return (
    <Link href={`/together/${album.id}`} className={cx('tg-card', album.status === 'open' && 'tg-card--open')}>
      <AlbumCover cover={album.cover} />
      <span className="tg-card__body">
        <span className="tg-card__title">
          <bdi>{album.title}</bdi>
        </span>
        <span className="tg-card__meta">
          {tp('together.items', album.itemCount)} · {tp('together.people', album.memberCount)}
        </span>
        <span className={cx('tg-status', album.status === 'open' && 'tg-status--open')}>{statusText(album, t, locale)}</span>
        {album.requestCount ? <span className="tg-card__requests">{tp('together.requests.count', album.requestCount)}</span> : null}
      </span>
      <Icon name="chevron-right" />
    </Link>
  );
}

// ── When it's open ──────────────────────────────────────────────────────

const WINDOW_LABEL: Record<TogetherWindow, MessageKey> = {
  tonight: 'together.window.tonight',
  day: 'together.window.day',
  weekend: 'together.window.weekend',
  week: 'together.window.week',
  custom: 'together.window.custom',
  open: 'together.window.open',
};

/** A value for a datetime-local input, in local time. */
export function localInput(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** The chosen window as a closing time: null for "until I close it"; undefined when a custom time isn't valid. */
export function windowClosesAt(w: TogetherWindow, custom: string): string | null | undefined {
  if (w === 'custom') {
    const at = custom ? new Date(custom) : null;
    return at && togetherClosesAtOk(at) ? at.toISOString() : undefined;
  }
  return togetherClosesAt(w)?.toISOString() ?? null;
}

/** "Open for adding": tonight, 24 hours, this weekend, a week, a chosen time, or until a host closes it. */
export function WindowPicker({ value, custom, onChange }: { value: TogetherWindow; custom: string; onChange: (w: TogetherWindow, custom: string) => void }) {
  const { t, locale } = useSession();
  const at = windowClosesAt(value, custom);
  const min = localInput(new Date(Date.now() + 15 * 60_000));
  const max = localInput(new Date(Date.now() + 59 * 86_400_000));
  return (
    <fieldset className="tg-window">
      <legend className="yp-field__label">{t('together.window.label')}</legend>
      <div className="tg-chips">
        {TOGETHER_WINDOWS.map((w) => (
          <label key={w} className={cx('tg-chip', value === w && 'tg-chip--on')}>
            <input
              type="radio"
              name="tg-window"
              value={w}
              checked={value === w}
              onChange={() => onChange(w, w === 'custom' && !custom ? localInput(new Date(Date.now() + 3 * 3_600_000)) : custom)}
            />
            {t(WINDOW_LABEL[w])}
          </label>
        ))}
      </div>
      {value === 'custom' ? (
        <TextField
          label={t('together.window.customLabel')}
          type="datetime-local"
          value={custom}
          min={min}
          max={max}
          onChange={(e) => onChange('custom', e.currentTarget.value)}
          error={at === undefined ? t('together.window.invalid') : undefined}
        />
      ) : null}
      <p className="tg-window__note" aria-live="polite">
        {at ? t('together.window.until', { time: whenShort(at, locale) }) : at === null ? t('together.status.untilClosed') : ''}
      </p>
    </fieldset>
  );
}

// ── Tiles and the three views ───────────────────────────────────────────

export function ItemTile({ item, onOpen, big }: { item: TogetherItem; onOpen: () => void; big?: boolean }) {
  const { t, locale } = useSession();
  const saver = useDataSaver();
  const src = thumbOf(item, big && !saver);
  return (
    <button type="button" className={cx('tg-tile', big && 'tg-tile--big')} onClick={onOpen} aria-label={tileLabel(item, t, locale)}>
      {src ? (
        <img src={src} alt="" loading="lazy" className={item.media.sensitive ? 'yp-blurred' : undefined} />
      ) : (
        <span className="tg-tile__wait">
          <Icon name={item.media.kind === 'video' ? 'play' : 'image'} />
        </span>
      )}
      {item.media.kind === 'video' ? (
        <span className="tg-tile__badge">
          <Icon name="play" size={12} filled />
        </span>
      ) : null}
      {item.media.sensitive ? (
        <span className="tg-tile__sensitive">
          <Icon name="eye-off" size={16} />
        </span>
      ) : null}
      {item.stars ? (
        <span className={cx('tg-tile__stars', item.starred && 'tg-tile__stars--mine')}>
          <Icon name="star" size={12} filled />
          {item.stars}
        </span>
      ) : null}
    </button>
  );
}

/** Moments: runs of the same day and time of day ("Saturday evening"), the first photo of a longer run shown larger. */
export function MomentsView({ items, onOpen }: { items: TogetherItem[]; onOpen: (id: string) => void }) {
  const { t, tp, locale } = useSession();
  const groups = useMemo(() => momentGroups(items), [items]);
  const fmt = useMemo(() => {
    try {
      return new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' });
    } catch {
      return new Intl.DateTimeFormat('en', { hour: 'numeric', minute: '2-digit' });
    }
  }, [locale]);
  return (
    <div className="tg-moments">
      {groups.map((g) => {
        const first = g.items[0]!;
        const last = g.items.at(-1)!;
        const range = first === last ? fmt.format(new Date(first.takenAt)) : `${fmt.format(new Date(first.takenAt))} – ${fmt.format(new Date(last.takenAt))}`;
        const heading = t(`together.part.${g.part}` as MessageKey, { day: momentDayLabel(g.day, locale, groups) });
        return (
          <section key={g.key} className="tg-moment" aria-label={heading}>
            <header className="tg-moment__head">
              <h3>{heading}</h3>
              <span className="tg-moment__meta">
                {range} · {tp('together.items', g.items.length)}
              </span>
            </header>
            <div className="tg-mosaic">
              {g.items.map((it, i) => (
                <ItemTile key={it.id} item={it} big={i === 0 && g.items.length >= 3} onOpen={() => onOpen(it.id)} />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

/** People: who added what, the people who added most first. */
export function PeopleView({ items, onOpen }: { items: TogetherItem[]; onOpen: (id: string) => void }) {
  const { tp } = useSession();
  const groups = useMemo(() => peopleGroups(items), [items]);
  return (
    <div className="tg-people">
      {groups.map((g) => (
        <section key={g.user.id} className="tg-person" aria-label={g.user.displayName}>
          <header className="tg-person__head">
            <Avatar name={g.user.displayName} src={g.user.avatarUrl} size="sm" />
            <h3>
              <bdi>{g.user.displayName}</bdi>
            </h3>
            <span className="tg-moment__meta">{tp('together.items', g.items.length)}</span>
          </header>
          <div className="tg-strip">
            {g.items.map((it) => (
              <ItemTile key={it.id} item={it} onOpen={() => onOpen(it.id)} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

export function GridView({ items, onOpen }: { items: TogetherItem[]; onOpen: (id: string) => void }) {
  return (
    <div className="tg-grid">
      {items.map((it) => (
        <ItemTile key={it.id} item={it} onOpen={() => onOpen(it.id)} />
      ))}
    </div>
  );
}

/** The best of: a strip of the favourites, picked from stars and reactions. */
export function BestOf({ album, onOpen }: { album: TogetherDetail; onOpen: (id: string) => void }) {
  const { t } = useSession();
  const best = album.bestOf.map((id) => album.items.find((i) => i.id === id)).filter((i): i is TogetherItem => !!i);
  return (
    <section className="tg-best" aria-labelledby="tg-best-title">
      <header className="tg-best__head">
        <h2 id="tg-best-title">
          <Icon name="star" filled /> {t('together.best.title')}
        </h2>
        <span className="tg-moment__meta">{best.length ? t('together.best.hint') : t('together.best.empty')}</span>
      </header>
      {best.length ? (
        <div className="tg-best__strip">
          {best.map((it) => (
            <ItemTile key={it.id} item={it} big onOpen={() => onOpen(it.id)} />
          ))}
        </div>
      ) : null}
    </section>
  );
}

// ── Saving a file ───────────────────────────────────────────────────────

/** Download an item: as a file where the browser allows it, else opened in a new tab to save from there. */
export async function downloadItem(item: TogetherItem) {
  const url = item.media.kind === 'video' ? item.media.url : (item.media.variants?.large ?? item.media.url);
  try {
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) throw new Error(String(res.status));
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = item.fileName;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  } catch {
    window.open(url, '_blank', 'noopener');
  }
}

// ── The viewer ──────────────────────────────────────────────────────────

function Reactions({ item, onReact }: { item: TogetherItem; onReact: (k: TogetherReaction | null) => void }) {
  const { t } = useSession();
  const mine = item.reactions.find((r) => r.mine)?.kind ?? null;
  return (
    <div className="tg-reacts" role="group" aria-label={t('together.viewer.react')}>
      {TOGETHER_REACTIONS.map((k) => {
        const n = item.reactions.find((r) => r.kind === k)?.count ?? 0;
        return (
          <button
            key={k}
            type="button"
            className={cx('tg-react', mine === k && 'tg-react--mine')}
            aria-pressed={mine === k}
            aria-label={n ? t('together.viewer.reaction', { reaction: t(REACTION_LABEL[k]), count: n }) : t(REACTION_LABEL[k])}
            title={t(REACTION_LABEL[k])}
            onClick={() => onReact(mine === k ? null : k)}
          >
            <Icon name={k} size={20} filled={mine === k} />
            {n ? <span>{n}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

function Comments({ album, item, onCount }: { album: TogetherDetail; item: TogetherItem; onCount: (n: number) => void }) {
  const { t, toast, locale } = useSession();
  const [list, setList] = useState<TogetherComment[] | null>(null);
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setList(null);
    api.together.comments(album.id, item.id).then(
      (r) => setList(r.items),
      () => setList([]),
    );
    // Reload when the count changes (someone else commented).
  }, [album.id, item.id, item.comments]);
  const done = (items: TogetherComment[]) => {
    setList(items);
    onCount(items.length);
  };
  return (
    <section className="tg-comments" aria-label={t('together.viewer.comments')}>
      {list === null ? null : list.length ? (
        <ul className="tg-comments__list">
          {list.map((c) => (
            <li key={c.id}>
              <Avatar name={c.author.displayName} src={c.author.avatarUrl} size="sm" />
              <div>
                <strong>
                  <bdi>{c.author.displayName}</bdi>
                </strong>{' '}
                <span className="tg-comments__time">{whenShort(c.createdAt, locale)}</span>
                <p dir="auto">{c.body}</p>
              </div>
              {c.canDelete ? (
                <button
                  type="button"
                  className="tg-icon-btn"
                  aria-label={t('together.viewer.deleteComment')}
                  onClick={async () => {
                    try {
                      done((await api.together.removeComment(album.id, item.id, c.id)).items);
                    } catch (e) {
                      toast(errorMessage(e));
                    }
                  }}
                >
                  <Icon name="trash" size={16} />
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="tg-muted">{t('together.viewer.noComments')}</p>
      )}
      <form
        className="tg-comments__form"
        onSubmit={async (e) => {
          e.preventDefault();
          const text = body.trim();
          if (!text || busy) return;
          setBusy(true);
          try {
            done((await api.together.comment(album.id, item.id, text)).items);
            setBody('');
          } catch (err) {
            toast(errorMessage(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <label className="yp-visually-hidden" htmlFor={`tg-c-${item.id}`}>
          {t('together.viewer.commentPlaceholder')}
        </label>
        <input
          id={`tg-c-${item.id}`}
          className="yp-input"
          value={body}
          maxLength={TOGETHER_COMMENT_MAX}
          placeholder={t('together.viewer.commentPlaceholder')}
          onChange={(e) => setBody(e.currentTarget.value)}
          dir="auto"
        />
        <Button type="submit" size="sm" loading={busy} disabled={!body.trim()}>
          {t('together.viewer.send')}
        </Button>
      </form>
    </section>
  );
}

/**
 * Full screen: one photo or video at a time, with who added it, when it was taken and its
 * caption; star it, react, comment, download, report or remove. Arrow keys and swipes move
 * through the album, Escape closes.
 */
export function Viewer({
  album,
  items,
  startId,
  onClose,
  onItem,
  onRemoved,
}: {
  album: TogetherDetail;
  items: TogetherItem[];
  startId: string;
  onClose: () => void;
  onItem: (item: TogetherItem) => void;
  onRemoved: (id: string) => void;
}) {
  const { t, tp, toast, locale } = useSession();
  const saver = useDataSaver();
  const ref = useRef<HTMLDivElement>(null);
  const [id, setId] = useState(startId);
  const index = Math.max(
    0,
    items.findIndex((i) => i.id === id),
  );
  const item = items[index];
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const [report, setReport] = useState<{ type: string; id: string } | null>(null);
  const [editing, setEditing] = useState(false);
  const [caption, setCaption] = useState('');
  const [confirmRemove, setConfirmRemove] = useState(false);
  const swipe = useRef<number | null>(null);
  useModalFocus(ref, true, onClose);
  const go = useCallback(
    (d: number) => {
      if (!items.length) return;
      setEditing(false);
      setConfirmRemove(false);
      setId(items[(index + d + items.length) % items.length]!.id);
    },
    [items, index],
  );
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return;
      if (e.key === 'ArrowRight') go(document.dir === 'rtl' ? -1 : 1);
      if (e.key === 'ArrowLeft') go(document.dir === 'rtl' ? 1 : -1);
    };
    document.addEventListener('keydown', onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
    };
  }, [go]);
  useEffect(() => {
    if (!item) onClose();
  }, [item, onClose]);
  if (!item) return null;
  const shown = !item.media.sensitive || revealed.has(item.id);
  const canRemove = item.mine || album.canManage;

  async function run(p: Promise<{ item: TogetherItem }>) {
    try {
      onItem((await p).item);
    } catch (e) {
      toast(errorMessage(e));
    }
  }

  const actions: MenuAction[] = [
    { label: t('together.viewer.download'), icon: 'download', onSelect: () => void downloadItem(item) },
    ...(item.mine ? [{ label: t('together.viewer.editCaption'), icon: 'edit' as const, onSelect: () => (setCaption(item.caption), setEditing(true)) }] : []),
    ...(album.canManage && !item.media.sensitive
      ? [
          {
            label: t('together.viewer.cover'),
            icon: 'image' as const,
            onSelect: async () => {
              try {
                await api.together.update(album.id, { coverItemId: item.id });
                toast(t('together.saved'));
              } catch (e) {
                toast(errorMessage(e));
              }
            },
          },
        ]
      : []),
    ...(!item.mine ? [{ label: t('together.viewer.report'), icon: 'flag' as const, onSelect: () => setReport({ type: 'together_item', id: item.id }) }] : []),
    ...(canRemove ? [{ label: t('together.viewer.remove'), icon: 'trash' as const, danger: true, onSelect: () => setConfirmRemove(true) }] : []),
  ];

  return (
    <div className="tg-viewer" role="dialog" aria-modal aria-label={t('together.viewer.label', { title: album.title })} ref={ref} tabIndex={-1}>
      <div className="tg-viewer__bar">
        <span aria-live="polite">{t('together.viewer.position', { index: index + 1, total: items.length })}</span>
        <span className="tg-viewer__bar-end">
          <Menu label={t('together.viewer.more')} actions={actions} />
          <button type="button" className="tg-viewer__btn" onClick={onClose} aria-label={t('m.common.close')}>
            <Icon name="x" />
          </button>
        </span>
      </div>
      <div
        className="tg-viewer__stage"
        onPointerDown={(e) => (swipe.current = e.clientX)}
        onPointerUp={(e) => {
          if (swipe.current === null) return;
          const dx = e.clientX - swipe.current;
          swipe.current = null;
          if (Math.abs(dx) > 50) go((dx < 0 ? 1 : -1) * (document.dir === 'rtl' ? -1 : 1));
        }}
      >
        {item.media.kind === 'video' ? (
          <video
            key={item.id}
            src={saver ? (item.media.variants?.mp4_360 ?? item.media.url) : item.media.url}
            poster={item.media.posterUrl ?? undefined}
            controls
            autoPlay={!saver && shown}
            preload={saver ? 'none' : 'metadata'}
            playsInline
            className={shown ? undefined : 'yp-blurred'}
            aria-label={tileLabel(item, t, locale)}
          />
        ) : (
          <img
            key={item.id}
            src={saver ? (item.media.variants?.medium ?? item.media.url) : (item.media.variants?.large ?? item.media.url)}
            alt={shown ? (item.media.altText ?? tileLabel(item, t, locale)) : ''}
            className={shown ? undefined : 'yp-blurred'}
          />
        )}
        {shown ? null : <SensitiveCover onReveal={() => setRevealed((s) => new Set(s).add(item.id))} locale={locale} />}
        {items.length > 1 ? (
          <>
            <button type="button" className="tg-viewer__nav tg-viewer__nav--prev" onClick={() => go(-1)} aria-label={t('together.viewer.prev')}>
              <Icon name="chevron-left" />
            </button>
            <button type="button" className="tg-viewer__nav tg-viewer__nav--next" onClick={() => go(1)} aria-label={t('together.viewer.next')}>
              <Icon name="chevron-right" />
            </button>
          </>
        ) : null}
      </div>
      <aside className="tg-viewer__panel">
        <div className="tg-viewer__who">
          <Avatar name={item.author.displayName} src={item.author.avatarUrl} size="sm" />
          <div>
            <strong>
              <bdi>{item.author.displayName}</bdi>
            </strong>
            <span className="tg-muted">
              {t(item.takenFromFile ? 'together.viewer.taken' : 'together.viewer.added', { time: whenShort(item.takenAt, locale) })}
            </span>
          </div>
          <button
            type="button"
            className={cx('tg-star', item.starred && 'tg-star--on')}
            aria-pressed={item.starred}
            aria-label={item.starred ? t('together.viewer.unstar') : t('together.viewer.star')}
            onClick={() => void run(api.together.star(album.id, item.id, !item.starred))}
          >
            <Icon name="star" filled={item.starred} />
            <span>{item.stars ? tp('together.viewer.stars', item.stars) : t('together.viewer.star')}</span>
          </button>
        </div>
        {editing ? (
          <form
            className="stack-sm"
            onSubmit={async (e) => {
              e.preventDefault();
              await run(api.together.setCaption(album.id, item.id, caption));
              setEditing(false);
            }}
          >
            <TextField label={t('together.add.caption')} value={caption} maxLength={TOGETHER_CAPTION_MAX} onChange={(e) => setCaption(e.currentTarget.value)} />
            <div className="row">
              <Button type="submit" size="sm">
                {t('common.save')}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                {t('common.cancel')}
              </Button>
            </div>
          </form>
        ) : item.caption ? (
          <p className="tg-viewer__caption" dir="auto">
            {item.caption}
          </p>
        ) : null}
        {confirmRemove ? (
          <div className="tg-confirm" role="alertdialog" aria-labelledby="tg-rm-title">
            <strong id="tg-rm-title">{t('together.viewer.removeTitle')}</strong>
            <p className="tg-muted">{t('together.viewer.removeBody')}</p>
            <div className="row">
              <Button
                size="sm"
                variant="danger"
                onClick={async () => {
                  try {
                    await api.together.removeItem(album.id, item.id);
                    setConfirmRemove(false);
                    onRemoved(item.id);
                  } catch (e) {
                    toast(errorMessage(e));
                  }
                }}
              >
                {t('m.common.remove')}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmRemove(false)}>
                {t('common.cancel')}
              </Button>
            </div>
          </div>
        ) : null}
        <Reactions item={item} onReact={(k) => void run(api.together.react(album.id, item.id, k))} />
        <h3 className="tg-viewer__h">{tp('together.viewer.commentsCount', item.comments)}</h3>
        <Comments album={album} item={item} onCount={(n) => n !== item.comments && onItem({ ...item, comments: n })} />
      </aside>
      <ReportSheet target={report} onClose={() => setReport(null)} />
    </div>
  );
}

// ── Slideshow ───────────────────────────────────────────────────────────

const SLIDE_MS = 6_000;

/**
 * Full screen for a TV at the event: one photo at a time with a gentle crossfade (a plain cut
 * when reduced motion is on), who added it and the caption. With "show new photos as they
 * arrive" on, new ones play next and a live region says how many came in. Space pauses,
 * arrows move, Escape leaves.
 */
export function Slideshow({ album, onClose }: { album: TogetherDetail; onClose: () => void }) {
  const { t, tp, locale, subscribe } = useSession();
  const saver = useDataSaver();
  const ref = useRef<HTMLDivElement>(null);
  const [items, setItems] = useState(album.items);
  const [bestOnly, setBestOnly] = useState(false);
  const [live, setLive] = useState(true);
  const [playing, setPlaying] = useState(true);
  const [i, setI] = useState(0);
  const [announce, setAnnounce] = useState('');
  const [chrome, setChrome] = useState(true);
  const queue = useRef<string[]>([]);
  useModalFocus(ref, true, onClose);
  const list = useMemo(() => (bestOnly ? items.filter((x) => album.bestOf.includes(x.id)) : items), [items, bestOnly, album.bestOf]);
  const current = list.length ? list[i % list.length] : undefined;

  const next = useCallback(() => {
    // New photos first, while "as they arrive" is on.
    const waiting = queue.current.shift();
    const at = waiting ? list.findIndex((x) => x.id === waiting) : -1;
    setI((x) => (at >= 0 ? at : list.length ? (x + 1) % list.length : 0));
  }, [list]);

  useEffect(() => {
    if (!playing || !current) return;
    if (current.media.kind === 'video') return; // Videos move on when they end.
    const timer = setTimeout(next, SLIDE_MS);
    return () => clearTimeout(timer);
  }, [playing, current, next]);

  useEffect(
    () =>
      subscribe((e) => {
        if (!live || e.type !== 'together.items' || e.data?.togetherId !== album.id || e.data?.removed) return;
        void api.together.get(album.id).then(
          (r) => {
            setItems((old) => {
              const known = new Set(old.map((x) => x.id));
              const fresh = r.together.items.filter((x) => !known.has(x.id));
              if (fresh.length) {
                queue.current.push(...fresh.map((x) => x.id));
                setAnnounce(tp('together.show.new', fresh.length));
              }
              return r.together.items;
            });
          },
          () => {},
        );
      }),
    [subscribe, live, album.id, tp],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement | null)?.closest?.('button, input, label')) return;
      if (e.key === ' ') {
        e.preventDefault();
        setPlaying((p) => !p);
      }
      if (e.key === 'ArrowRight') next();
      if (e.key === 'ArrowLeft') setI((x) => (list.length ? (x - 1 + list.length) % list.length : 0));
    };
    document.addEventListener('keydown', onKey);
    const el = ref.current;
    el?.requestFullscreen?.().catch(() => {});
    return () => {
      document.removeEventListener('keydown', onKey);
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    };
  }, [next, list.length]);

  // The controls fade after a few quiet seconds, and come back on any movement.
  useEffect(() => {
    if (!chrome) return;
    const timer = setTimeout(() => setChrome(false), 4_000);
    return () => clearTimeout(timer);
  }, [chrome]);

  return (
    <div
      className={cx('tg-show', !chrome && 'tg-show--quiet')}
      role="dialog"
      aria-modal
      aria-label={t('together.show.label', { title: album.title })}
      ref={ref}
      tabIndex={-1}
      onPointerMove={() => setChrome(true)}
      onFocus={() => setChrome(true)}
    >
      <div className="tg-show__stage">
        {list.map((x, k) => {
          const on = current?.id === x.id;
          // Only this slide and its neighbours are drawn.
          const near = Math.abs(k - (i % Math.max(1, list.length))) <= 1;
          if (!on && !near) return null;
          const src =
            x.media.kind === 'video' ? x.media.posterUrl : saver ? (x.media.variants?.medium ?? x.media.url) : (x.media.variants?.large ?? x.media.url);
          return (
            <figure key={x.id} className={cx('tg-show__slide', on && 'tg-show__slide--on')} aria-hidden={!on}>
              {x.media.kind === 'video' && on && !x.media.sensitive ? (
                <video src={x.media.url} poster={x.media.posterUrl ?? undefined} autoPlay={playing} muted playsInline onEnded={next} />
              ) : src && !x.media.sensitive ? (
                <img src={src} alt={on ? (x.media.altText ?? tileLabel(x, t, locale)) : ''} />
              ) : (
                <span className="tg-show__hidden">
                  <Icon name="eye-off" size={40} />
                </span>
              )}
              {on ? (
                <figcaption>
                  <Avatar name={x.author.displayName} src={x.author.avatarUrl} size="sm" />
                  <span>
                    <strong>
                      <bdi>{x.author.displayName}</bdi>
                    </strong>
                    {x.caption ? <span dir="auto"> · {x.caption}</span> : null}
                  </span>
                </figcaption>
              ) : null}
            </figure>
          );
        })}
        {!current ? <p className="tg-show__empty">{t('together.show.empty')}</p> : null}
      </div>
      <div className="tg-show__title" aria-hidden>
        <bdi>{album.title}</bdi>
      </div>
      <div className="tg-show__controls">
        <button type="button" className="tg-show__btn" onClick={() => setPlaying((p) => !p)} aria-label={playing ? t('m.common.pause') : t('m.common.play')}>
          <Icon name={playing ? 'pause' : 'play'} />
        </button>
        <button type="button" className="tg-show__btn" onClick={next} aria-label={t('together.viewer.next')}>
          <Icon name="chevron-right" />
        </button>
        <Switch label={t('together.show.live')} checked={live} onChange={setLive} />
        <Switch label={t('together.show.bestOnly')} checked={bestOnly} onChange={(v) => (setBestOnly(v), setI(0))} disabled={!album.bestOf.length} />
        <span className="tg-show__hint">{t('together.show.hint')}</span>
        <button type="button" className="tg-show__btn" onClick={onClose} aria-label={t('together.show.exit')}>
          <Icon name="x" />
        </button>
      </div>
      <p className="yp-visually-hidden" aria-live="polite">
        {announce}
      </p>
    </div>
  );
}

// ── Adding photos and videos ────────────────────────────────────────────

export interface Pending {
  key: string;
  file: File;
  preview: string | null;
  caption: string;
  progress: number;
  state: 'waiting' | 'uploading' | 'done' | 'failed';
}

/**
 * Several at once, each with an optional caption: uploaded one after another with the resumable
 * uploads (photos are made smaller first on Data saver), then added in groups of 20 with the time
 * the file says it was taken (its date, never where).
 */
export function AddSheet({
  album,
  files,
  onClose,
  onAdded,
}: {
  album: TogetherDetail;
  files: File[];
  onClose: () => void;
  onAdded: (items: TogetherItem[]) => void;
}) {
  const { t, tp, toast, dataSaver } = useSession();
  const [list, setList] = useState<Pending[]>(() =>
    files.map((f, i) => ({
      key: `${f.name}-${f.size}-${i}`,
      file: f,
      preview: f.type.startsWith('image/') ? URL.createObjectURL(f) : null,
      caption: '',
      progress: 0,
      state: 'waiting',
    })),
  );
  const [busy, setBusy] = useState(false);
  useEffect(() => () => list.forEach((p) => p.preview && URL.revokeObjectURL(p.preview)), []); // eslint-disable-line react-hooks/exhaustive-deps
  const done = list.filter((p) => p.state === 'done').length;
  const failed = list.filter((p) => p.state === 'failed').length;

  const patch = (key: string, p: Partial<Pending>) => setList((l) => l.map((x) => (x.key === key ? { ...x, ...p } : x)));

  async function start() {
    setBusy(true);
    const ready: { key: string; mediaId: string; caption: string; takenAt?: string }[] = [];
    for (const p of list) {
      if (p.state === 'done') continue;
      patch(p.key, { state: 'uploading', progress: 0 });
      try {
        const { media } = await api.uploads.resumable(p.file, (f) => patch(p.key, { progress: f }));
        const taken = p.file.lastModified ? new Date(p.file.lastModified) : null;
        ready.push({
          key: p.key,
          mediaId: media.id,
          caption: p.caption.trim(),
          takenAt: taken && taken.getTime() <= Date.now() ? taken.toISOString() : undefined,
        });
      } catch {
        patch(p.key, { state: 'failed' });
      }
    }
    const added: TogetherItem[] = [];
    for (let k = 0; k < ready.length; k += TOGETHER_ADD_BATCH) {
      const batch = ready.slice(k, k + TOGETHER_ADD_BATCH);
      try {
        const r = await api.together.addItems(
          album.id,
          batch.map(({ mediaId, caption, takenAt }) => ({ mediaId, caption, takenAt })),
        );
        added.push(...r.items);
        for (const b of batch) patch(b.key, { state: 'done', progress: 1 });
      } catch (e) {
        toast(errorMessage(e));
        for (const b of batch) patch(b.key, { state: 'failed' });
      }
    }
    setBusy(false);
    if (added.length) {
      onAdded(added);
      toast(tp('together.add.done', added.length));
    }
    if (added.length === list.filter((p) => p.state !== 'done').length + done || !list.some((p) => p.state === 'failed')) onClose();
  }

  return (
    <BottomSheet open onClose={busy ? () => {} : onClose} title={t('together.add.title', { title: album.title })}>
      <div className="stack-sm">
        {dataSaver.active ? <p className="tg-muted">{t('together.add.dataSaver')}</p> : null}
        <ul className="tg-pending">
          {list.map((p) => (
            <li key={p.key} className={cx('tg-pending__row', p.state === 'failed' && 'tg-pending__row--failed')}>
              <span className="tg-pending__thumb" aria-hidden>
                {p.preview ? <img src={p.preview} alt="" /> : <Icon name={p.file.type.startsWith('video/') ? 'play' : 'image'} />}
              </span>
              <div className="tg-pending__body">
                <TextField
                  label={t('together.add.captionFor', { name: p.file.name })}
                  className="tg-pending__caption"
                  placeholder={t('together.add.caption')}
                  value={p.caption}
                  maxLength={TOGETHER_CAPTION_MAX}
                  disabled={busy || p.state === 'done'}
                  onChange={(e) => patch(p.key, { caption: e.currentTarget.value })}
                />
                {p.state === 'uploading' || p.state === 'done' ? (
                  <progress max={1} value={p.progress} aria-label={t('together.add.progress', { name: p.file.name })} />
                ) : p.state === 'failed' ? (
                  <span className="tg-pending__error">{t('together.add.failedOne')}</span>
                ) : null}
              </div>
              {!busy && p.state !== 'done' ? (
                <button
                  type="button"
                  className="tg-icon-btn"
                  aria-label={t('together.add.removeFile', { name: p.file.name })}
                  onClick={() => setList((l) => l.filter((x) => x.key !== p.key))}
                >
                  <Icon name="x" size={16} />
                </button>
              ) : null}
            </li>
          ))}
        </ul>
        <p className="tg-muted" aria-live="polite">
          {busy ? t('together.add.uploading', { done, total: list.length }) : failed ? t('together.add.failed') : ''}
        </p>
        <div className="row">
          <Button onClick={() => void start()} loading={busy} disabled={!list.some((p) => p.state !== 'done')}>
            {failed ? t('m.common.retry') : tp('together.add.submit', list.length)}
          </Button>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
        </div>
      </div>
    </BottomSheet>
  );
}

/** A hidden file input and the buttons that open it: the library, or the camera on phones. */
export function AddButtons({ onFiles, disabled }: { onFiles: (files: File[]) => void; disabled?: boolean }) {
  const { t } = useSession();
  const library = useRef<HTMLInputElement>(null);
  const camera = useRef<HTMLInputElement>(null);
  const pick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = [...(e.currentTarget.files ?? [])].filter((f) => f.type.startsWith('image/') || f.type.startsWith('video/'));
    e.currentTarget.value = '';
    if (files.length) onFiles(files);
  };
  return (
    <>
      <Button icon="plus" onClick={() => library.current?.click()} disabled={disabled}>
        {t('together.add')}
      </Button>
      <Button icon="image" variant="secondary" onClick={() => camera.current?.click()} disabled={disabled} className="tg-camera-btn">
        {t('together.add.camera')}
      </Button>
      <input ref={library} type="file" accept="image/*,video/*" multiple hidden onChange={pick} />
      <input ref={camera} type="file" accept="image/*,video/*" capture="environment" hidden onChange={pick} />
    </>
  );
}

// ── Sections of the album page ──────────────────────────────────────────

export function Section({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="tg-section">
      <header className="tg-section__head">
        <h2>{title}</h2>
        {action}
      </header>
      {children}
    </section>
  );
}
