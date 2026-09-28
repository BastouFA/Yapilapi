'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Avatar, Button, cx, Icon, Menu, SensitiveCover, Switch, TextField, useDataSaver, useModalFocus, type MenuAction } from '@yapilapi/design-system';
import {
  TOGETHER_CAPTION_MAX,
  TOGETHER_COMMENT_MAX,
  TOGETHER_REACTIONS,
  type TogetherComment,
  type TogetherDetail,
  type TogetherItem,
  type TogetherReaction,
} from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';
import { REACTION_LABEL } from '@/components/Rooms';
import { ReportSheet } from '@/components/PostList';
import { useSession } from '@/app/providers';
import { downloadItem, tileLabel, whenShort } from '@/components/Together';

// The full-screen viewer and the slideshow of a Together album. The album page loads this file
// when one of them opens (see Together.tsx for the rest of the album).

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
