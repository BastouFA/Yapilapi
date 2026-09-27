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
  type MessageKey,
  type PluralKey,
} from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/app/providers';

const PHOTO_MS = 5000;

/** Message keys; translate with t() at render. */
export const AUDIENCE_LABEL: Record<ChapterAudience, MessageKey> = {
  public: 'm.chapters.audience.public',
  followers: 'm.chapters.audience.followers',
  friends: 'm.chapters.audience.friends',
  close_friends: 'm.chapters.audience.close_friends',
  only_me: 'm.chapters.audience.only_me',
};

const GRADIENT_LABEL: Record<ChapterGradient, MessageKey> = {
  yapi: 'chapters.gradient.yapi',
  sunrise: 'chapters.gradient.sunrise',
  saffron: 'chapters.gradient.saffron',
  dusk: 'chapters.gradient.dusk',
  lagoon: 'chapters.gradient.lagoon',
  ink: 'chapters.gradient.ink',
};

const SYMBOL_LABEL: Record<ChapterSymbol, MessageKey> = {
  star: 'chapters.symbol.star',
  sparkle: 'chapters.symbol.sparkle',
  heart: 'chapters.symbol.heart',
  music: 'chapters.symbol.music',
  globe: 'chapters.symbol.globe',
  calendar: 'chapters.symbol.calendar',
  compass: 'chapters.symbol.compass',
  home: 'chapters.symbol.home',
  bookmark: 'chapters.symbol.bookmark',
  image: 'chapters.symbol.image',
};

/** What chapterMeta needs from the session: pass useSession()'s result. */
export interface Translate {
  t: (key: MessageKey, vars?: Record<string, string | number>) => string;
  tp: (key: PluralKey, count: number, vars?: Record<string, string | number>) => string;
  locale: string;
}

export const gradientCss = (g: ChapterGradient) => `linear-gradient(135deg, ${CHAPTER_GRADIENTS[g][0]}, ${CHAPTER_GRADIENTS[g][1]})`;
export const formatDay = (d: string, locale: string) => new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(d));
export const isSealed = (c: Chapter) => !!c.capsule && !c.capsule.open;

/**
 * A chapter's cover: one of its stories, or its gradient and symbol. A time capsule keeps its
 * gradient and symbol with a small lock, since people may see the cover before it opens.
 */
export function ChapterCover({ chapter, size = 72 }: { chapter: Chapter; size?: number }) {
  const sealed = isSealed(chapter);
  const c = chapter.cover;
  if (c.kind === 'story' && !sealed) {
    const src = c.mediaKind === 'image' ? c.mediaUrl : c.posterUrl;
    if (src) return <CoverPreview size={size} gradient={chapter.coverGradient} image={src} />;
  }
  return (
    <CoverPreview
      size={size}
      gradient={chapter.coverGradient}
      symbol={(c.kind === 'gradient' ? c.symbol : chapter.coverSymbol) as ChapterSymbol}
      locked={!!chapter.capsule && !chapter.capsule.open}
    />
  );
}

/** The cover square itself, also used as the live preview while choosing a colour and symbol. */
function CoverPreview({
  size,
  gradient,
  symbol,
  image,
  locked,
}: {
  size: number;
  gradient: ChapterGradient;
  symbol?: ChapterSymbol;
  image?: string | null;
  locked?: boolean;
}) {
  return (
    <span className="chapter-cover" style={{ width: size, height: size, background: gradientCss(gradient) }} aria-hidden>
      {image ? <img src={image} alt="" /> : <Icon name={(symbol ?? 'star') as IconName} size={Math.round(size * 0.4)} />}
      {locked ? (
        <span className="chapter-cover__lock">
          <Icon name="lock" size={Math.max(12, Math.round(size * 0.18))} />
        </span>
      ) : null}
    </span>
  );
}

/** "Opens 12 Mar 2027 · 4 stories" or "6 stories · Shared". */
export function chapterMeta(c: Chapter, { t, tp, locale }: Translate) {
  const parts: string[] = [];
  if (isSealed(c)) parts.push(t('m.chapters.opens', { date: formatDay(c.capsule!.opensAt, locale) }));
  parts.push(tp('m.chapters.stories', c.storyCount));
  if (c.shared) parts.push(t('m.chapters.shared'));
  return parts.join(' · ');
}

/**
 * The row of chapter covers on a profile, above the posts. Open chapters play right away;
 * a sealed time capsule opens its page (cover, date and count only). On your own profile it
 * starts a new chapter and links to your archive.
 */
export function ChaptersRow({ userId, isSelf }: { userId: string; isSelf: boolean }) {
  const session = useSession();
  const { toast, locale, t } = session;
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
          {t('m.chapters.title')}
        </h2>
        {isSelf ? (
          <Link href="/archive" className="yp-btn yp-btn--ghost yp-btn--sm">
            {t('m.archive.title')}
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
              <span className="chapters__title">{t('m.chapters.new')}</span>
            </button>
          </li>
        ) : null}
        {items.map((c) => (
          <li key={c.id}>
            <button
              type="button"
              className="chapters__item"
              aria-label={t('chapters.itemLabel', { title: c.title, meta: chapterMeta(c, session) })}
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
              {isSealed(c) ? <span className="chapters__meta">{t('m.chapters.opens', { date: formatDay(c.capsule!.opensAt, locale) })}</span> : null}
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
  const { me, toast, locale, t } = useSession();
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
      aria-label={
        done ? t('chapters.playerEnd', { title: chapter.title }) : t('m.chapters.viewer', { title: chapter.title, index: i + 1, total: stories.length })
      }
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
            <button type="button" className="story__icon" onClick={() => setPaused((p) => !p)} aria-label={t(paused ? 'm.common.play' : 'm.common.pause')}>
              <Icon name={paused ? 'play' : 'pause'} filled />
            </button>
          ) : null}
          <button type="button" className="story__icon" onClick={onClose} aria-label={t('m.common.close')}>
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
                      setSigned(t(entry.pending ? 'm.chapters.signedPending' : 'm.chapters.signed'));
                    } catch (err) {
                      toast(errorMessage(err));
                    }
                  }}
                >
                  <label htmlFor="chapter-line" className="yp-visually-hidden">
                    {t('chapters.guestbookLabel')}
                  </label>
                  <input
                    id="chapter-line"
                    className="story__reply"
                    value={line}
                    maxLength={CHAPTER_GUESTBOOK_MAX}
                    placeholder={t('m.chapters.guestbookPlaceholder')}
                    onChange={(e) => setLine(e.currentTarget.value)}
                  />
                  <button type="submit" className="story__icon" aria-label={t('chapters.signGuestbook')} disabled={!line.trim()}>
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
                  {t('m.chapters.playAgain')}
                </Button>
              ) : null}
              {me ? (
                <Link href={`/chapters/${chapter.id}`} className="yp-btn yp-btn--ghost yp-btn--sm" onClick={onClose}>
                  {t('chapters.seeGuestbook')}
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
                alt={covered ? '' : story.body || t('m.stories.photo', { name: story.author.displayName })}
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
                locale={locale}
                onReveal={() => {
                  setRevealed((r) => [...r, story.id]);
                  setPaused(false);
                  void videoRef.current?.play().catch(() => {});
                }}
              />
            ) : null}
            <button type="button" className="story__tap story__tap--prev" onClick={prev} aria-label={t('chapters.previous')} />
            <button type="button" className="story__tap story__tap--next" onClick={next} aria-label={t('chapters.next')} />
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
  const { toast, t, tp } = useSession();
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
    <BottomSheet open={open && !!momentId} onClose={onClose} title={t('m.chapters.add')}>
      <div className="stack-sm">
        {items === null ? (
          <p className="muted">{t('chapters.loading')}</p>
        ) : items.length ? (
          <ul className="chapter-pick">
            {items.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => run(async () => (await api.chapters.addStory(c.id, momentId!), t('m.chapters.added', { title: c.title })))}
                >
                  <ChapterCover chapter={c} size={44} />
                  <span>
                    <strong dir="auto">{c.title}</strong>
                    <span className="muted">
                      {c.role === 'contributor' ? `${t('m.chapters.by', { name: c.owner.displayName })} · ` : ''}
                      {tp('m.chapters.stories', c.storyCount)}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">{t('m.chapters.none')}</p>
        )}
        <form
          className="row"
          style={{ alignItems: 'flex-end' }}
          onSubmit={(e) => {
            e.preventDefault();
            if (title.trim())
              void run(
                async () => (await api.chapters.create({ title: title.trim(), momentIds: [momentId!] }), t('m.chapters.started', { title: title.trim() })),
              );
          }}
        >
          <TextField
            label={t('m.chapters.new')}
            placeholder={t('m.chapters.newPlaceholder')}
            value={title}
            maxLength={CHAPTER_TITLE_MAX}
            onChange={(e) => setTitle(e.currentTarget.value)}
          />
          <Button type="submit" disabled={!title.trim() || busy}>
            {t('m.chapters.create')}
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
  const { toast, t } = useSession();
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
  // A story picked as the cover shows instead of the colour and symbol (they're kept for when it's gone).
  const coverStory = coverStoryId ? stories.find((x) => x.id === coverStoryId) : undefined;

  return (
    <BottomSheet open={open} onClose={onClose} title={t(chapter ? 'chapters.editTitle' : 'm.chapters.new')}>
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
          label={t('m.chapters.titleLabel')}
          value={title}
          maxLength={CHAPTER_TITLE_MAX}
          required
          onChange={(e) => setTitle(e.currentTarget.value)}
          hint={`${title.length}/${CHAPTER_TITLE_MAX}`}
        />
        <TextField
          label={t('m.chapters.descriptionLabel')}
          multiline
          rows={2}
          value={description}
          maxLength={CHAPTER_DESCRIPTION_MAX}
          onChange={(e) => setDescription(e.currentTarget.value)}
        />
        <Select label={t('m.chapters.audience')} value={audience} onChange={(e) => setAudience(e.currentTarget.value as ChapterAudience)}>
          {CHAPTER_AUDIENCES.map((a) => (
            <option key={a} value={a}>
              {t(AUDIENCE_LABEL[a])}
            </option>
          ))}
        </Select>
        {stories.length ? (
          <Select label={t('m.chapters.cover')} value={coverStoryId} onChange={(e) => setCoverStoryId(e.currentTarget.value)}>
            <option value="">{t('m.chapters.coverColour')}</option>
            {stories.map((s, n) => (
              <option key={s.id} value={s.id}>
                {s.body ? t('chapters.coverStoryText', { index: n + 1, text: s.body.slice(0, 40) }) : t('chapters.coverStory', { index: n + 1 })}
              </option>
            ))}
          </Select>
        ) : null}
        <div className="chapter-preview" aria-live="polite">
          <CoverPreview
            size={64}
            gradient={gradient}
            symbol={symbol}
            image={coverStory ? (coverStory.mediaKind === 'image' ? coverStory.mediaUrl : coverStory.posterUrl) : null}
            locked={capsule}
          />
          <div className="stack-sm" style={{ gap: 2, minWidth: 0 }}>
            <strong dir="auto">{title.trim() || t('chapters.previewTitle')}</strong>
            <span className="muted">{coverStory ? t('chapters.previewStoryCover') : capsule ? t('chapters.previewCapsule') : t('chapters.previewHint')}</span>
          </div>
        </div>
        <fieldset className="chapter-swatches">
          <legend className="yp-field__label">{t('m.chapters.colour')}</legend>
          {CHAPTER_GRADIENT_NAMES.map((g) => (
            <label key={g} className="chapter-swatch" style={{ background: gradientCss(g) }} title={t(GRADIENT_LABEL[g])}>
              <input type="radio" name="chapter-gradient" value={g} checked={gradient === g} onChange={() => setGradient(g)} />
              <span className="yp-visually-hidden">{t(GRADIENT_LABEL[g])}</span>
            </label>
          ))}
        </fieldset>
        <fieldset className="chapter-swatches">
          <legend className="yp-field__label">{t('m.chapters.symbol')}</legend>
          {CHAPTER_SYMBOLS.map((s) => (
            <label key={s} className="chapter-symbol" title={t(SYMBOL_LABEL[s])}>
              <input type="radio" name="chapter-symbol" value={s} checked={symbol === s} onChange={() => setSymbol(s)} />
              <Icon name={s as IconName} />
              <span className="yp-visually-hidden">{t(SYMBOL_LABEL[s])}</span>
            </label>
          ))}
        </fieldset>
        <Checkbox
          label={t('m.chapters.capsule')}
          description={t('m.chapters.capsuleHint')}
          checked={capsule}
          disabled={dateLocked}
          onChange={(e) => setCapsule(e.currentTarget.checked)}
        />
        {capsule ? (
          <TextField
            label={t('chapters.sealUntil')}
            type="date"
            min={tomorrow}
            required
            value={until}
            disabled={dateLocked}
            hint={dateLocked ? t('m.chapters.dateFixed') : undefined}
            onChange={(e) => setUntil(e.currentTarget.value)}
          />
        ) : null}
        <Button type="submit" loading={busy} disabled={!title.trim()}>
          {t(chapter ? 'common.save' : 'chapters.createChapter')}
        </Button>
      </form>
    </BottomSheet>
  );
}
