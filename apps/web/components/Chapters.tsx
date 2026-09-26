'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Avatar, BottomSheet, Button, Checkbox, Icon, SensitiveCover, Select, TextField, useModalFocus, type IconName } from '@yapilapi/design-system';
import type { Chapter, ChapterDetail, ChapterStory } from '@yapilapi/api-client';
import {
  CHAPTER_AUDIENCES,
  CHAPTER_DESCRIPTION_MAX,
  CHAPTER_GRADIENT_NAMES,
  CHAPTER_GRADIENTS,
  CHAPTER_GUESTBOOK_MAX,
  CHAPTER_SYMBOLS,
  CHAPTER_TITLE_MAX,
  type ChapterAudience,
  type ChapterGradient,
  type ChapterSymbol,
} from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/app/providers';

const PHOTO_MS = 5000;

export const AUDIENCE_LABEL: Record<ChapterAudience, string> = {
  public: 'Everyone',
  followers: 'Followers',
  friends: 'Friends',
  close_friends: 'Close friends',
  only_me: 'Only me',
};

const GRADIENT_LABEL: Record<ChapterGradient, string> = {
  yapi: 'YAPILAPI red',
  sunrise: 'Sunrise',
  saffron: 'Saffron',
  dusk: 'Dusk',
  lagoon: 'Lagoon',
  ink: 'Ink',
};

const SYMBOL_LABEL: Record<ChapterSymbol, string> = {
  star: 'Star',
  sparkle: 'Sparkle',
  heart: 'Heart',
  music: 'Music',
  globe: 'Globe',
  calendar: 'Calendar',
  compass: 'Compass',
  home: 'Home',
  bookmark: 'Bookmark',
  image: 'Picture',
};

export const gradientCss = (g: ChapterGradient) => `linear-gradient(135deg, ${CHAPTER_GRADIENTS[g][0]}, ${CHAPTER_GRADIENTS[g][1]})`;
export const formatDay = (d: string, locale: string) => new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(d));
export const isSealed = (c: Chapter) => !!c.capsule && !c.capsule.open;

/** A chapter's cover: one of its stories, or its gradient and symbol. A sealed capsule shows a lock. */
export function ChapterCover({ chapter, size = 72 }: { chapter: Chapter; size?: number }) {
  const sealed = isSealed(chapter);
  const c = chapter.cover;
  const style = { width: size, height: size, background: gradientCss(chapter.coverGradient) };
  if (c.kind === 'story' && !sealed) {
    const src = c.mediaKind === 'image' ? c.mediaUrl : c.posterUrl;
    if (src)
      return (
        <span className="chapter-cover" style={style} aria-hidden>
          <img src={src} alt="" />
        </span>
      );
  }
  return (
    <span className="chapter-cover" style={style} aria-hidden>
      <Icon name={sealed ? 'lock' : ((c.kind === 'gradient' ? c.symbol : chapter.coverSymbol) as IconName)} size={Math.round(size * 0.4)} />
    </span>
  );
}

/** "Opens 12 Mar 2027 · 4 stories" or "6 stories · Shared". */
export function chapterMeta(c: Chapter, locale: string) {
  const parts: string[] = [];
  if (isSealed(c)) parts.push(`Opens ${formatDay(c.capsule!.opensAt, locale)}`);
  parts.push(c.storyCount === 1 ? '1 story' : `${c.storyCount} stories`);
  if (c.shared) parts.push('Shared');
  return parts.join(' · ');
}

/**
 * The row of chapter covers on a profile, above the posts. Open chapters play right away;
 * a sealed time capsule opens its page (cover, date and count only). On your own profile it
 * starts a new chapter and links to your archive.
 */
export function ChaptersRow({ userId, isSelf }: { userId: string; isSelf: boolean }) {
  const { toast, locale } = useSession();
  const router = useRouter();
  const [items, setItems] = useState<Chapter[] | null>(null);
  const [playing, setPlaying] = useState<ChapterDetail | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(
    () =>
      api.chapters.forUser(userId).then(
        (r) => setItems(r.items),
        () => setItems([]),
      ),
    [userId],
  );
  useEffect(() => {
    void load();
  }, [load]);

  if (!items || (!items.length && !isSelf)) return null;

  return (
    <section className="chapters" aria-labelledby="chapters-title">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2 id="chapters-title" className="section-title" style={{ margin: 0 }}>
          Chapters
        </h2>
        {isSelf ? (
          <Link href="/archive" className="yp-btn yp-btn--ghost yp-btn--sm">
            Your archive
          </Link>
        ) : null}
      </div>
      <ul className="chapters__row">
        {isSelf ? (
          <li>
            <button type="button" className="chapters__item" onClick={() => setCreating(true)}>
              <span className="chapter-cover chapter-cover--new" style={{ width: 72, height: 72 }} aria-hidden>
                <Icon name="plus" size={28} />
              </span>
              <span className="chapters__title">New chapter</span>
            </button>
          </li>
        ) : null}
        {items.map((c) => (
          <li key={c.id}>
            <button
              type="button"
              className="chapters__item"
              aria-label={`${c.title}, ${chapterMeta(c, locale)}`}
              onClick={async () => {
                if (isSealed(c) || !c.storyCount) return router.push(`/chapters/${c.id}`);
                try {
                  setPlaying(await api.chapters.get(c.id));
                } catch (e) {
                  toast(errorMessage(e));
                }
              }}
            >
              <ChapterCover chapter={c} />
              <span className="chapters__title" dir="auto">
                {c.title}
              </span>
              {isSealed(c) ? <span className="chapters__meta">Opens {formatDay(c.capsule!.opensAt, locale)}</span> : null}
            </button>
          </li>
        ))}
      </ul>
      {playing ? <ChapterPlayer detail={playing} onClose={() => setPlaying(null)} /> : null}
      <ChapterEditor
        open={creating}
        onClose={() => setCreating(false)}
        onSaved={(c) => {
          setCreating(false);
          router.push(`/chapters/${c.id}`);
        }}
      />
    </section>
  );
}

/**
 * Plays a chapter in the story viewer: its stories in order, each with its date and who
 * shared it. When it finishes, viewers can leave one short line in the guestbook.
 */
export function ChapterPlayer({ detail, start = 0, onClose }: { detail: ChapterDetail; start?: number; onClose: () => void }) {
  const { me, toast, locale } = useSession();
  const { chapter, stories } = detail;
  const [i, setI] = useState(start);
  const [paused, setPaused] = useState(false);
  const [progress, setProgress] = useState(0);
  const [done, setDone] = useState(stories.length === 0);
  const [line, setLine] = useState('');
  const [signed, setSigned] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<string[]>([]);
  const root = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  useModalFocus(root, true, onClose);
  const story: ChapterStory | undefined = stories[i];
  const covered = !!story?.sensitive && !revealed.includes(story.id);

  const next = useCallback(() => {
    if (i < stories.length - 1) setI(i + 1);
    else setDone(true);
  }, [i, stories.length]);
  const prev = useCallback(() => {
    if (done) setDone(false);
    else if (i > 0) setI(i - 1);
  }, [i, done]);

  useEffect(() => {
    setProgress(0);
    if (covered) setPaused(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [story?.id]);

  useEffect(() => {
    if (!story || done || story.mediaKind === 'video' || paused) return;
    const started = performance.now() - progress * PHOTO_MS;
    let frame = 0;
    const tick = () => {
      const p = (performance.now() - started) / PHOTO_MS;
      if (p >= 1) return next();
      setProgress(p);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [story?.id, paused, done]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (paused || done) v.pause();
    else void v.play().catch(() => {});
  }, [paused, done, story?.id]);

  const canSign = !!me && !isSealed(chapter);
  const hold = { onPointerDown: () => setPaused(true), onPointerUp: () => setPaused(false), onPointerLeave: () => setPaused(false) };

  return (
    <div
      ref={root}
      className="story"
      role="dialog"
      aria-modal="true"
      aria-label={done ? `${chapter.title}, the end` : `${chapter.title}, story ${i + 1} of ${stories.length}`}
      tabIndex={-1}
      onKeyDown={(e) => {
        if ((e.target as HTMLElement).tagName === 'INPUT') return;
        if (e.key === 'ArrowRight') next();
        else if (e.key === 'ArrowLeft') prev();
        else if (e.key === ' ') {
          e.preventDefault();
          setPaused((p) => !p);
        }
      }}
    >
      <div className="story__frame">
        <div className="story__bars" aria-hidden>
          {stories.map((s, si) => (
            <span key={s.id} className="story__bar">
              <span style={{ width: `${done || si < i ? 100 : si > i ? 0 : Math.round(progress * 100)}%` }} />
            </span>
          ))}
        </div>
        <div className="story__head">
          {story && !done ? <Avatar name={story.author.displayName} src={story.author.avatarUrl} size="sm" /> : <ChapterCover chapter={chapter} size={32} />}
          <span className="story__who">
            <bdi>{chapter.title}</bdi>
            {story && !done ? (
              <span>
                <bdi>{story.author.displayName}</bdi> · <time dateTime={story.createdAt}>{formatDay(story.createdAt, locale)}</time>
              </span>
            ) : (
              <span>{chapter.owner.displayName}</span>
            )}
          </span>
          {!done ? (
            <button type="button" className="story__icon" onClick={() => setPaused((p) => !p)} aria-label={paused ? 'Play' : 'Pause'}>
              <Icon name={paused ? 'play' : 'pause'} filled />
            </button>
          ) : null}
          <button type="button" className="story__icon" onClick={onClose} aria-label="Close">
            <Icon name="x" />
          </button>
        </div>

        {done ? (
          <div className="chapter-end">
            <ChapterCover chapter={chapter} size={96} />
            <h2 dir="auto">{chapter.title}</h2>
            {chapter.description ? (
              <p className="chapter-end__desc" dir="auto">
                {chapter.description}
              </p>
            ) : null}
            {canSign ? (
              signed ? (
                <p role="status">{signed}</p>
              ) : (
                <form
                  className="chapter-end__form"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    const body = line.trim();
                    if (!body) return;
                    try {
                      const { entry } = await api.chapters.sign(chapter.id, body);
                      setSigned(entry.pending ? 'Thanks. Your line shows to others after a quick check.' : 'Your line is in the guestbook.');
                    } catch (err) {
                      toast(errorMessage(err));
                    }
                  }}
                >
                  <label htmlFor="chapter-line" className="yp-visually-hidden">
                    A line for the guestbook
                  </label>
                  <input
                    id="chapter-line"
                    className="story__reply"
                    value={line}
                    maxLength={CHAPTER_GUESTBOOK_MAX}
                    placeholder="Leave a line in the guestbook"
                    onChange={(e) => setLine(e.currentTarget.value)}
                  />
                  <button type="submit" className="story__icon" aria-label="Sign the guestbook" disabled={!line.trim()}>
                    <Icon name="send" />
                  </button>
                </form>
              )
            ) : null}
            <div className="row" style={{ justifyContent: 'center' }}>
              {stories.length ? (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    setDone(false);
                    setI(0);
                  }}
                >
                  Play again
                </Button>
              ) : null}
              {me ? (
                <Link href={`/chapters/${chapter.id}`} className="yp-btn yp-btn--ghost yp-btn--sm" onClick={onClose}>
                  See the guestbook
                </Link>
              ) : null}
            </div>
          </div>
        ) : story ? (
          <div className="story__media" {...hold}>
            {story.mediaKind === 'video' && story.mediaUrl ? (
              <video
                key={story.id}
                ref={videoRef}
                src={story.mediaUrl}
                poster={story.posterUrl ?? undefined}
                className={covered ? 'yp-blurred' : undefined}
                autoPlay={!covered}
                playsInline
                onTimeUpdate={(e) => {
                  const v = e.currentTarget;
                  if (v.duration) setProgress(v.currentTime / v.duration);
                }}
                onEnded={next}
              />
            ) : story.mediaKind === 'image' && story.mediaUrl ? (
              <img
                key={story.id}
                src={story.mediaUrl}
                alt={covered ? '' : story.body || `Story from ${story.author.displayName}`}
                className={covered ? 'yp-blurred' : undefined}
              />
            ) : (
              <p className="story__text" dir="auto">
                {story.body}
              </p>
            )}
            {story.body && story.mediaUrl ? (
              <p className="story__caption" dir="auto">
                {story.body}
              </p>
            ) : null}
            {covered ? (
              <SensitiveCover
                onReveal={() => {
                  setRevealed((r) => [...r, story.id]);
                  setPaused(false);
                  void videoRef.current?.play().catch(() => {});
                }}
              />
            ) : null}
            <button type="button" className="story__tap story__tap--prev" onClick={prev} aria-label="Previous" />
            <button type="button" className="story__tap story__tap--next" onClick={next} aria-label="Next" />
          </div>
        ) : null}
        <div className="story__foot" />
      </div>
    </div>
  );
}

/**
 * Add one of your stories to a chapter you own or contribute to, or start a new chapter with it.
 */
export function AddToChapter({ momentId, open, onClose, onAdded }: { momentId: string | null; open: boolean; onClose: () => void; onAdded?: () => void }) {
  const { toast } = useSession();
  const [items, setItems] = useState<Chapter[] | null>(null);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setItems(null);
    setTitle('');
    api.chapters.mine().then(
      (r) => setItems(r.items.filter((c) => c.canAdd)),
      () => setItems([]),
    );
  }, [open]);

  async function run(fn: () => Promise<string>) {
    setBusy(true);
    try {
      toast(await fn());
      onAdded?.();
      onClose();
    } catch (e) {
      toast(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <BottomSheet open={open && !!momentId} onClose={onClose} title="Add to a chapter">
      <div className="stack-sm">
        {items === null ? (
          <p className="muted">Loading your chapters</p>
        ) : items.length ? (
          <ul className="chapter-pick">
            {items.map((c) => (
              <li key={c.id}>
                <button type="button" disabled={busy} onClick={() => run(async () => (await api.chapters.addStory(c.id, momentId!), `Added to ${c.title}`))}>
                  <ChapterCover chapter={c} size={44} />
                  <span>
                    <strong dir="auto">{c.title}</strong>
                    <span className="muted">
                      {c.role === 'contributor' ? `${c.owner.displayName}'s chapter · ` : ''}
                      {c.storyCount === 1 ? '1 story' : `${c.storyCount} stories`}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">No chapters yet. Start one with this story.</p>
        )}
        <form
          className="row"
          style={{ alignItems: 'flex-end' }}
          onSubmit={(e) => {
            e.preventDefault();
            if (title.trim()) void run(async () => (await api.chapters.create({ title: title.trim(), momentIds: [momentId!] }), `Started ${title.trim()}`));
          }}
        >
          <TextField
            label="New chapter"
            placeholder="Summer in Accra"
            value={title}
            maxLength={CHAPTER_TITLE_MAX}
            onChange={(e) => setTitle(e.currentTarget.value)}
          />
          <Button type="submit" disabled={!title.trim() || busy}>
            Create
          </Button>
        </form>
      </div>
    </BottomSheet>
  );
}

const localDay = (iso: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/**
 * Start or edit a chapter: title, description, audience, cover (one of its stories, or a
 * gradient and symbol), and "Seal until" to make it a time capsule.
 */
export function ChapterEditor({
  open,
  onClose,
  onSaved,
  chapter,
  stories = [],
}: {
  open: boolean;
  onClose: () => void;
  onSaved: (c: Chapter) => void;
  chapter?: Chapter;
  stories?: ChapterStory[];
}) {
  const { toast } = useSession();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [audience, setAudience] = useState<ChapterAudience>('followers');
  const [gradient, setGradient] = useState<ChapterGradient>('yapi');
  const [symbol, setSymbol] = useState<ChapterSymbol>('star');
  const [coverStoryId, setCoverStoryId] = useState<string>('');
  const [capsule, setCapsule] = useState(false);
  const [until, setUntil] = useState('');
  const [busy, setBusy] = useState(false);
  const dateLocked = !!chapter?.capsule && (chapter.capsule.sealed || chapter.capsule.open);

  useEffect(() => {
    if (!open) return;
    setTitle(chapter?.title ?? '');
    setDescription(chapter?.description ?? '');
    setAudience(chapter?.audience ?? 'followers');
    setGradient(chapter?.coverGradient ?? 'yapi');
    setSymbol(chapter?.coverSymbol ?? 'star');
    setCoverStoryId(chapter?.coverStoryId ?? '');
    setCapsule(!!chapter?.capsule);
    setUntil(chapter?.capsule ? localDay(chapter.capsule.opensAt) : '');
  }, [open, chapter]);

  const tomorrow = localDay(new Date(Date.now() + 86_400_000).toISOString());

  return (
    <BottomSheet open={open} onClose={onClose} title={chapter ? 'Edit chapter' : 'New chapter'}>
      <form
        className="stack-sm"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            const opensAt = dateLocked ? undefined : capsule && until ? new Date(`${until}T00:00:00`).toISOString() : null;
            const base = { title: title.trim(), description: description.trim(), audience, coverGradient: gradient, coverSymbol: symbol };
            const r = chapter
              ? await api.chapters.update(chapter.id, { ...base, ...(opensAt !== undefined ? { opensAt } : {}), coverStoryId: coverStoryId || null })
              : await api.chapters.create({ ...base, opensAt: opensAt ?? null });
            onSaved(r.chapter);
          } catch (err) {
            toast(errorMessage(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <TextField
          label="Title"
          value={title}
          maxLength={CHAPTER_TITLE_MAX}
          required
          onChange={(e) => setTitle(e.currentTarget.value)}
          hint={`${title.length}/${CHAPTER_TITLE_MAX}`}
        />
        <TextField
          label="Description (optional)"
          multiline
          rows={2}
          value={description}
          maxLength={CHAPTER_DESCRIPTION_MAX}
          onChange={(e) => setDescription(e.currentTarget.value)}
        />
        <Select label="Who can see it" value={audience} onChange={(e) => setAudience(e.currentTarget.value as ChapterAudience)}>
          {CHAPTER_AUDIENCES.map((a) => (
            <option key={a} value={a}>
              {AUDIENCE_LABEL[a]}
            </option>
          ))}
        </Select>
        {stories.length ? (
          <Select label="Cover" value={coverStoryId} onChange={(e) => setCoverStoryId(e.currentTarget.value)}>
            <option value="">Colour and symbol</option>
            {stories.map((s, n) => (
              <option key={s.id} value={s.id}>
                Story {n + 1}
                {s.body ? `: ${s.body.slice(0, 40)}` : ''}
              </option>
            ))}
          </Select>
        ) : null}
        <fieldset className="chapter-swatches">
          <legend className="yp-field__label">Colour</legend>
          {CHAPTER_GRADIENT_NAMES.map((g) => (
            <label key={g} className="chapter-swatch" style={{ background: gradientCss(g) }} title={GRADIENT_LABEL[g]}>
              <input type="radio" name="chapter-gradient" value={g} checked={gradient === g} onChange={() => setGradient(g)} />
              <span className="yp-visually-hidden">{GRADIENT_LABEL[g]}</span>
            </label>
          ))}
        </fieldset>
        <fieldset className="chapter-swatches">
          <legend className="yp-field__label">Symbol</legend>
          {CHAPTER_SYMBOLS.map((s) => (
            <label key={s} className="chapter-symbol" title={SYMBOL_LABEL[s]}>
              <input type="radio" name="chapter-symbol" value={s} checked={symbol === s} onChange={() => setSymbol(s)} />
              <Icon name={s as IconName} />
              <span className="yp-visually-hidden">{SYMBOL_LABEL[s]}</span>
            </label>
          ))}
        </fieldset>
        <Checkbox
          label="Time capsule"
          description="Seal it until a date. Until then people see the cover, the date and how many stories are inside, nothing more."
          checked={capsule}
          disabled={dateLocked}
          onChange={(e) => setCapsule(e.currentTarget.checked)}
        />
        {capsule ? (
          <TextField
            label="Seal until"
            type="date"
            min={tomorrow}
            required
            value={until}
            disabled={dateLocked}
            hint={dateLocked ? 'The date is fixed once a capsule is sealed.' : undefined}
            onChange={(e) => setUntil(e.currentTarget.value)}
          />
        ) : null}
        <Button type="submit" loading={busy} disabled={!title.trim()}>
          {chapter ? 'Save' : 'Create chapter'}
        </Button>
      </form>
    </BottomSheet>
  );
}
