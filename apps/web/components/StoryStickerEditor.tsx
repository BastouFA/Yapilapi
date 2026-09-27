'use client';

import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { Button, Icon, TextField, type IconName } from '@yapilapi/design-system';
import { INTERACTIVE_STICKERS, linkDomain, type MessageKey, type StoryStickerInput } from '@yapilapi/shared';
import { api } from '@/lib/api';
import { stickerStyle, timeLeft } from '@/components/StoryStickers';
import { useSession } from '@/app/providers';

/** The music sticker's key while dragging it. */
const MUSIC = 'music';

/** A sticker being placed, with what to show for it before it's published. */
export type DraftSticker = StoryStickerInput & { key: string; label: string };
type Kind = StoryStickerInput['type'];

const KINDS: { type: Kind; label: MessageKey; icon: IconName }[] = [
  { type: 'mention', label: 'm.sticker.kind.mention', icon: 'user' },
  { type: 'hashtag', label: 'm.sticker.kind.hashtag', icon: 'compass' },
  { type: 'poll', label: 'm.sticker.kind.poll', icon: 'poll' },
  { type: 'question', label: 'm.sticker.kind.question', icon: 'message' },
  { type: 'slider', label: 'm.sticker.kind.slider', icon: 'heart' },
  { type: 'countdown', label: 'm.sticker.kind.countdown', icon: 'calendar' },
  { type: 'link', label: 'm.sticker.kind.link', icon: 'link' },
  { type: 'place', label: 'm.sticker.kind.place', icon: 'map-pin' },
];

const clamp = (n: number) => Math.min(0.95, Math.max(0.05, n));

/**
 * Place stickers on a story: add a mention, hashtag, poll, question, emoji
 * slider, countdown, link or place, then drag it where you want it on the
 * preview (or focus it and use the arrow keys). The server checks everything
 * again: mentioned people must exist, links need an account at least 7 days
 * old, and a story takes one of each interactive sticker.
 */
export function StoryStickerEditor({
  stickers,
  onChange,
  preview,
  music,
  onMoveMusic,
}: {
  stickers: DraftSticker[];
  onChange: (s: DraftSticker[]) => void;
  preview: { mediaUrl?: string; mediaKind?: string; body: string };
  /** The music sticker, moved here like the others. */
  music?: { title: string; artist: string; style: 'compact' | 'card'; x: number; y: number } | null;
  onMoveMusic?: (x: number, y: number) => void;
}) {
  const { t } = useSession();
  const frame = useRef<HTMLDivElement>(null);
  const [adding, setAdding] = useState<Kind | null>(null);
  const drag = useRef<{ key: string; pointer: number } | null>(null);

  const move = (key: string, x: number, y: number) =>
    key === MUSIC ? onMoveMusic?.(clamp(x), clamp(y)) : onChange(stickers.map((s) => (s.key === key ? { ...s, x: clamp(x), y: clamp(y) } : s)));
  const onPointerMove = (e: PointerEvent) => {
    const d = drag.current;
    const box = frame.current?.getBoundingClientRect();
    if (!d || !box || d.pointer !== e.pointerId) return;
    const rtl = getComputedStyle(frame.current!).direction === 'rtl';
    const fromStart = rtl ? box.right - e.clientX : e.clientX - box.left;
    move(d.key, fromStart / box.width, (e.clientY - box.top) / box.height);
  };
  const onKey = (s: { key: string; x: number; y: number }, e: KeyboardEvent) => {
    const step = 0.02;
    const rtl = frame.current ? getComputedStyle(frame.current).direction === 'rtl' : false;
    const dx = e.key === 'ArrowRight' ? step : e.key === 'ArrowLeft' ? -step : 0;
    const dy = e.key === 'ArrowDown' ? step : e.key === 'ArrowUp' ? -step : 0;
    if ((e.key === 'Delete' || e.key === 'Backspace') && s.key !== MUSIC) {
      e.preventDefault();
      onChange(stickers.filter((x) => x.key !== s.key));
      return;
    }
    if (!dx && !dy) return;
    e.preventDefault();
    move(s.key, s.x + (rtl ? -dx : dx), s.y + dy);
  };
  const taken = (k: Kind) => (INTERACTIVE_STICKERS as readonly string[]).includes(k) && stickers.some((s) => s.type === k);

  return (
    <section className="stack-sm" aria-labelledby="stickers-heading">
      <h2 id="stickers-heading" className="yp-field__label" style={{ margin: 0 }}>
        {t('m.sticker.title')}
      </h2>
      <div className="sticker-editor">
        <div
          ref={frame}
          className="sticker-editor__frame"
          onPointerMove={onPointerMove}
          onPointerUp={() => (drag.current = null)}
          onPointerCancel={() => (drag.current = null)}
        >
          {preview.mediaKind === 'video' && preview.mediaUrl ? (
            <video src={preview.mediaUrl} muted playsInline aria-hidden />
          ) : preview.mediaKind === 'image' && preview.mediaUrl ? (
            <img src={preview.mediaUrl} alt="" />
          ) : (
            <p className="sticker-editor__text" dir="auto">
              {preview.body}
            </p>
          )}
          {stickers.map((s) => (
            <button
              key={s.key}
              type="button"
              className="sticker-editor__sticker"
              style={stickerStyle({ x: s.x, y: s.y })}
              aria-label={t('stickers.dragLabel', { label: s.label })}
              onKeyDown={(e) => onKey(s, e)}
              onPointerDown={(e) => {
                e.currentTarget.setPointerCapture(e.pointerId);
                drag.current = { key: s.key, pointer: e.pointerId };
              }}
              onPointerMove={onPointerMove}
              onPointerUp={() => (drag.current = null)}
            >
              <bdi>{s.label}</bdi>
            </button>
          ))}
          {music ? (
            <button
              type="button"
              className={`sticker-editor__sticker sticker-editor__sticker--music${music.style === 'card' ? ' sticker-editor__sticker--card' : ''}`}
              style={stickerStyle({ x: music.x, y: music.y })}
              aria-label={t('stickers.musicLabel', { title: music.title, artist: music.artist })}
              onKeyDown={(e) => onKey({ key: MUSIC, x: music.x, y: music.y }, e)}
              onPointerDown={(e) => {
                e.currentTarget.setPointerCapture(e.pointerId);
                drag.current = { key: MUSIC, pointer: e.pointerId };
              }}
              onPointerMove={onPointerMove}
              onPointerUp={() => (drag.current = null)}
            >
              <Icon name="music" size={12} /> <bdi>{music.title}</bdi> · <bdi>{music.artist}</bdi>
            </button>
          ) : null}
        </div>
        <div className="stack-sm">
          <div className="sticker-editor__kinds" role="group" aria-label={t('stickers.addGroup')}>
            {KINDS.map((k) => (
              <Button
                key={k.type}
                size="sm"
                variant={adding === k.type ? 'primary' : 'secondary'}
                icon={k.icon}
                disabled={taken(k.type) || stickers.length >= 10}
                aria-pressed={adding === k.type}
                onClick={() => setAdding(adding === k.type ? null : k.type)}
              >
                {t(k.label)}
              </Button>
            ))}
          </div>
          {adding ? (
            <StickerForm
              key={adding}
              kind={adding}
              onCancel={() => setAdding(null)}
              onAdd={(s) => {
                // New stickers land near the middle, a little apart from each other.
                const offset = (stickers.length % 5) * 0.08;
                onChange([...stickers, { ...s, x: 0.5, y: clamp(0.3 + offset), key: `${Date.now()}-${stickers.length}` } as DraftSticker]);
                setAdding(null);
              }}
            />
          ) : null}
          {stickers.length ? (
            <ul className="sticker-editor__list">
              {stickers.map((s) => (
                <li key={s.key}>
                  <bdi>{s.label}</bdi>
                  <Button size="sm" variant="ghost" onClick={() => onChange(stickers.filter((x) => x.key !== s.key))}>
                    {t('m.common.remove')}
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted" style={{ margin: 0, fontSize: 13 }}>
              {t('m.sticker.hint')}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}

type NewSticker = StoryStickerInput & { label: string };

function StickerForm({ kind, onAdd, onCancel }: { kind: Kind; onAdd: (s: NewSticker) => void; onCancel: () => void }) {
  const { t } = useSession();
  const [a, setA] = useState(() => (kind === 'question' ? t('m.sticker.askMe') : ''));
  const [b, setB] = useState('');
  const [c, setC] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [places, setPlaces] = useState<{ id: string; name: string; city: string | null }[]>([]);

  // Places: search by name as you type.
  useEffect(() => {
    if (kind !== 'place' || a.trim().length < 2) return setPlaces([]);
    const timer = setTimeout(
      () =>
        api.search(a.trim(), 'places').then(
          (r) => setPlaces(((r.results.places as { id: string; name: string; city: string | null }[] | undefined) ?? []).slice(0, 6)),
          () => setPlaces([]),
        ),
      200,
    );
    return () => clearTimeout(timer);
  }, [kind, a]);

  const base = { x: 0.5, y: 0.5 };
  const submit = () => {
    setError(null);
    switch (kind) {
      case 'mention': {
        const username = a.trim().replace(/^@/, '');
        if (!/^[a-z0-9_.]{3,30}$/i.test(username)) return setError(t('stickers.error.username'));
        return onAdd({ type: 'mention', ...base, username, label: `@${username}` });
      }
      case 'hashtag': {
        const tag = a.trim().replace(/^#/, '');
        if (!/^[\p{L}\p{M}\p{N}_]{2,40}$/u.test(tag)) return setError(t('m.sticker.error.tag'));
        return onAdd({ type: 'hashtag', ...base, tag, label: `#${tag}` });
      }
      case 'poll':
        if (!b.trim() || !c.trim()) return setError(t('stickers.error.options'));
        return onAdd({
          type: 'poll',
          ...base,
          question: a.trim(),
          options: [b.trim(), c.trim()],
          label: t('stickers.pollLabel', { question: a.trim() || t('m.sticker.kind.poll'), first: b.trim(), second: c.trim() }),
        });
      case 'question':
        if (!a.trim()) return setError(t('stickers.error.prompt'));
        return onAdd({ type: 'question', ...base, prompt: a.trim(), label: a.trim() });
      case 'slider':
        if (!a.trim()) return setError(t('stickers.error.prompt'));
        if (!b.trim()) return setError(t('stickers.error.emoji'));
        return onAdd({ type: 'slider', ...base, prompt: a.trim(), emoji: b.trim(), label: `${b.trim()} ${a.trim()}` });
      case 'countdown': {
        const ends = b ? new Date(b) : null;
        if (!a.trim()) return setError(t('stickers.error.title'));
        if (!ends || !(ends.getTime() > Date.now())) return setError(t('stickers.error.future'));
        return onAdd({
          type: 'countdown',
          ...base,
          title: a.trim(),
          endsAt: ends.toISOString(),
          label: `${a.trim()}, ${timeLeft(ends.toISOString(), Date.now(), t)}`,
        });
      }
      case 'link': {
        const url = /^https?:\/\//i.test(a.trim()) ? a.trim() : `https://${a.trim()}`;
        const domain = linkDomain(url);
        if (!domain || !domain.includes('.')) return setError(t('stickers.error.url'));
        return onAdd({ type: 'link', ...base, url, label: b.trim() || domain });
      }
      case 'place':
        return setError(t('stickers.error.place'));
    }
  };

  return (
    <div
      className="sticker-editor__form stack-sm"
      onKeyDown={(e) => {
        // Enter adds the sticker instead of publishing the story.
        if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') {
          e.preventDefault();
          if (kind !== 'place') submit();
        }
      }}
    >
      {kind === 'mention' ? (
        <TextField label={t('m.sticker.username')} value={a} maxLength={31} placeholder="@username" onChange={(e) => setA(e.currentTarget.value)} />
      ) : null}
      {kind === 'hashtag' ? (
        <TextField label={t('m.sticker.kind.hashtag')} value={a} maxLength={41} placeholder="#tag" onChange={(e) => setA(e.currentTarget.value)} />
      ) : null}
      {kind === 'poll' ? (
        <>
          <TextField label={t('m.sticker.pollQuestion')} value={a} maxLength={80} onChange={(e) => setA(e.currentTarget.value)} />
          <TextField label={t('m.sticker.option', { number: 1 })} value={b} maxLength={30} onChange={(e) => setB(e.currentTarget.value)} />
          <TextField label={t('m.sticker.option', { number: 2 })} value={c} maxLength={30} onChange={(e) => setC(e.currentTarget.value)} />
        </>
      ) : null}
      {kind === 'question' ? <TextField label={t('m.sticker.prompt')} value={a} maxLength={80} onChange={(e) => setA(e.currentTarget.value)} /> : null}
      {kind === 'slider' ? (
        <>
          <TextField label={t('m.sticker.prompt')} value={a} maxLength={80} onChange={(e) => setA(e.currentTarget.value)} />
          <TextField label={t('m.sticker.emoji')} hint={t('stickers.emojiHint')} value={b} maxLength={8} onChange={(e) => setB(e.currentTarget.value)} />
        </>
      ) : null}
      {kind === 'countdown' ? (
        <>
          <TextField label={t('m.sticker.countdownTitle')} value={a} maxLength={60} onChange={(e) => setA(e.currentTarget.value)} />
          <TextField label={t('stickers.ends')} type="datetime-local" value={b} onChange={(e) => setB(e.currentTarget.value)} />
        </>
      ) : null}
      {kind === 'link' ? (
        <>
          <TextField
            label={t('m.sticker.url')}
            hint={t('m.sticker.linkHint')}
            value={a}
            inputMode="url"
            maxLength={2000}
            onChange={(e) => setA(e.currentTarget.value)}
          />
          <TextField label={t('m.sticker.label')} value={b} maxLength={40} onChange={(e) => setB(e.currentTarget.value)} />
        </>
      ) : null}
      {kind === 'place' ? (
        <>
          <TextField label={t('m.sticker.findPlace')} value={a} maxLength={100} onChange={(e) => setA(e.currentTarget.value)} />
          {places.length ? (
            <ul className="sticker-editor__list" aria-label={t('discover.places')}>
              {places.map((p) => (
                <li key={p.id}>
                  <span>
                    <Icon name="map-pin" size={16} /> <bdi>{p.name}</bdi>
                    {p.city ? <span className="muted"> · {p.city}</span> : null}
                  </span>
                  <Button size="sm" variant="secondary" onClick={() => onAdd({ type: 'place', x: 0.5, y: 0.5, placeId: p.id, label: p.name })}>
                    {t('m.closeFriends.add')}
                  </Button>
                </li>
              ))}
            </ul>
          ) : a.trim().length >= 2 ? (
            <p className="muted" style={{ margin: 0, fontSize: 13 }}>
              {t('m.sticker.noPlaces')}
            </p>
          ) : null}
        </>
      ) : null}
      {error ? (
        <span className="yp-field__error" role="alert">
          {error}
        </span>
      ) : null}
      <div className="row">
        {kind !== 'place' ? (
          <Button size="sm" onClick={submit}>
            {t('m.sticker.add')}
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
      </div>
    </div>
  );
}
