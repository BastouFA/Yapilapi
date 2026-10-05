'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Avatar, BottomSheet, Button, cx, Icon, TextField, useDataSaver } from '@yapilapi/design-system';
import {
  momentDayLabel,
  momentGroups,
  peopleGroups,
  TOGETHER_ADD_BATCH,
  TOGETHER_CAPTION_MAX,
  TOGETHER_WINDOWS,
  togetherClosesAt,
  togetherClosesAtOk,
  type MessageKey,
  type TogetherCover,
  type TogetherDetail,
  type TogetherItem,
  type TogetherSummary,
  type TogetherWindow,
} from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';
import { useSession, type Session } from '@/app/providers';

/*
 * Together on the web: shared albums (packages/shared/src/together.ts). The album page
 * (app/(app)/together/[id]) puts these together: the three views, the full-screen viewer with
 * stars, reactions and comments, the slideshow for a TV, the invite sheet with its QR code,
 * adding several photos and videos at once, and what to make of it afterwards. The viewer and
 * the slideshow are in TogetherViewer.tsx and download when they're opened.
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

export function tileLabel(item: TogetherItem, t: T, locale: string): string {
  const time = whenShort(item.takenAt, locale);
  const base = t(item.media.kind === 'video' ? 'together.tile.video' : 'together.tile.photo', { name: item.author.displayName, time });
  return item.starred ? `${base}. ${t('together.tile.starred')}` : base;
}

// ── Covers and cards ────────────────────────────────────────────────────

export function AlbumCover({ cover, className }: { cover: TogetherCover | null; className?: string }) {
  return (
    <span className={cx('tg-cover', className)} aria-hidden>
      {cover?.thumbUrl ? <img src={cover.thumbUrl} alt="" loading="lazy" decoding="async" /> : <Icon name="image" size={28} />}
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
        <img src={src} alt="" loading="lazy" decoding="async" className={item.media.sensitive ? 'yp-blurred' : undefined} />
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
        const from = fmt.format(new Date(first.takenAt));
        const to = fmt.format(new Date(last.takenAt));
        // One time when the run starts and ends in the same minute.
        const range = from === to ? from : `${from} – ${to}`;
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
    // Counted here: `list` is this render's copy, so it doesn't see the states set below.
    let failures = 0;
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
        failures++;
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
        failures += batch.length;
        for (const b of batch) patch(b.key, { state: 'failed' });
      }
    }
    setBusy(false);
    if (added.length) {
      onAdded(added);
      toast(tp('together.add.done', added.length));
    }
    // Anything that failed stays in the sheet, marked, with Try again.
    if (!failures) onClose();
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
