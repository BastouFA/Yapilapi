'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { BottomSheet, Button, Icon, Segments } from '@yapilapi/design-system';
import {
  MUSIC_CLIP_DEFAULT_MS,
  MUSIC_CLIP_MIN_MS,
  STORY_MUSIC_MAX_MS,
  storyMusicPart,
  waveformBars,
  type MessageKey,
  type MusicSourceInfo,
  type MusicTab,
  type MusicTrack,
  type Sound,
  type StoryMusicStyle,
} from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/app/providers';
import { SoundPlayButton, soundLength } from '@/components/SoundPicker';
import { useMusicCredit, useMusicLoop } from '@/components/StoryMusic';

export { musicHref, useMusicCredit } from '@/components/StoryMusic';

/** Where music is being added: the part's longest length and what the field says depend on it. */
export type MusicUse = 'post' | 'reel' | 'story';

/** Music chosen in Create that isn't posted yet: a song or a sound, the part that plays, and (stories) its sticker. */
export interface DraftMusic {
  track: MusicTrack;
  startMs: number;
  durationMs: number;
  style: StoryMusicStyle;
  x: number;
  y: number;
}

/** The longest part this song may play here: its licence, and 15 seconds on stories. */
export const clipMax = (track: Pick<MusicTrack, 'maxClipMs'>, use: MusicUse) =>
  use === 'story' ? Math.min(track.maxClipMs, STORY_MUSIC_MAX_MS) : track.maxClipMs;

export const draftMusic = (track: MusicTrack, use: MusicUse, part?: { startMs: number; durationMs: number }): DraftMusic => ({
  track,
  startMs: part?.startMs ?? 0,
  durationMs: Math.max(MUSIC_CLIP_MIN_MS, Math.min(part?.durationMs ?? MUSIC_CLIP_DEFAULT_MS, clipMax(track, use))),
  style: 'compact',
  x: 0.5,
  y: 0.78,
});

/** What the API takes: a sound or a song, and the part. */
export function musicInput(m: DraftMusic) {
  return {
    ...(m.track.source === 'library' ? { soundId: m.track.id } : { trackId: m.track.id }),
    startMs: m.startMs,
    durationMs: m.durationMs,
    style: m.style,
    x: m.x,
    y: m.y,
  };
}

/** A sound from the library as a picker track (for "Use this sound" links). */
export function soundAsTrack(s: Sound): MusicTrack {
  return {
    source: 'library',
    id: s.id,
    title: s.title,
    artist: s.owner.displayName,
    album: null,
    durationMs: s.durationMs,
    coverUrl: s.coverUrl,
    previewUrl: s.audioUrl,
    licence: {
      name: 'Original sound',
      url: null,
      commercialUse: true,
      regions: null,
      excludedRegions: [],
      maxClipSeconds: 30,
      attribution: null,
      expiresAt: null,
      cacheAllowed: true,
    },
    attribution: `${s.title} by ${s.owner.displayName} · Original sound`,
    maxClipMs: 30_000,
    uses: s.reels + s.stories + (s.posts ?? 0),
    saved: !!s.saved,
    canUse: s.canUse,
  };
}

/** "0:30" style time. */
export const clock = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

const TABS: MusicTab[] = ['for_you', 'trending', 'saved', 'original'];

/** A source's name in the reader's language (a partner keeps its own name). */
export function useSourceLabel() {
  const { t } = useSession();
  return (s: MusicSourceInfo) =>
    s.id === 'library' ? t('music.tab.original') : s.id === 'jamendo' ? t('music.source.jamendo') : s.id === 'dev' ? t('music.source.dev') : s.label;
}

/**
 * The one music picker for reels, posts and stories: search every source that's on, or browse For
 * you, Trending, Saved and Original sounds. Each row plays a preview, shows the licence and credit,
 * and can be saved. Songs you can't use say why; business accounts only get songs cleared for
 * commercial use.
 */
export function MusicPicker({ open, onClose, onPick }: { open: boolean; onClose: () => void; onPick: (track: MusicTrack) => void }) {
  const { t, me } = useSession();
  const credit = useMusicCredit();
  const sourceLabel = useSourceLabel();
  const [q, setQ] = useState('');
  const [tab, setTab] = useState<MusicTab>('for_you');
  const [items, setItems] = useState<MusicTrack[] | null>(null);
  const [sources, setSources] = useState<MusicSourceInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const req = useRef(0);

  useEffect(() => {
    if (!open) return;
    const n = ++req.current;
    setItems(null);
    const timer = setTimeout(
      () =>
        api.music.list({ q: q.trim(), tab: q.trim() && tab !== 'saved' ? undefined : tab, limit: 24 }).then(
          (r) => n === req.current && (setItems(r.items), setSources(r.sources), setError(null)),
          (e) => n === req.current && (setItems([]), setError(errorMessage(e))),
        ),
      q ? 250 : 0,
    );
    return () => clearTimeout(timer);
  }, [q, tab, open]);

  const on = sources.filter((s) => s.enabled);
  const off = sources.filter((s) => !s.enabled);

  async function toggleSave(track: MusicTrack) {
    const next = !track.saved;
    setItems((list) => list?.map((x) => (x.id === track.id ? { ...x, saved: next } : x)) ?? null);
    try {
      await api.music.save(track, next);
    } catch (e) {
      setItems((list) => list?.map((x) => (x.id === track.id ? { ...x, saved: !next } : x)) ?? null);
      setError(errorMessage(e));
    }
  }

  return (
    <BottomSheet open={open} onClose={onClose} title={t('music.picker.title')}>
      <div className="stack">
        <label className="yp-visually-hidden" htmlFor="music-search">
          {t('music.picker.search')}
        </label>
        <input
          id="music-search"
          className="yp-input"
          type="search"
          placeholder={t('music.picker.search')}
          value={q}
          maxLength={80}
          onChange={(e) => setQ(e.currentTarget.value)}
        />
        <Segments label={t('music.tabs')} value={tab} onChange={setTab} options={TABS.map((id) => ({ id, label: t(`music.tab.${id}` as MessageKey) }))} />
        {on.length ? (
          <p className="music-sources muted">
            {t('music.sources', { sources: on.map(sourceLabel).join(', ') })}
            {off.length ? ` · ${t('music.sourcesOff', { sources: off.map(sourceLabel).join(', ') })}` : ''}
          </p>
        ) : null}
        {me?.mode === 'business' ? <p className="music-sources muted">{t('music.businessNote')}</p> : null}
        {error ? <p className="muted">{error}</p> : null}
        {items === null ? (
          <p className="muted" role="status">
            {t('music.loading')}
          </p>
        ) : items.length ? (
          <ul className="sound-list">
            {items.map((s) => (
              <li key={`${s.source}:${s.id}`} className="sound-row music-row">
                <SoundPlayButton sound={{ title: s.title, audioUrl: s.canUse ? s.previewUrl : null }} />
                <span className="sound-row__text">
                  <bdi className="sound-row__title">{s.title}</bdi>
                  <span className="sound-row__meta">
                    <bdi>{s.artist}</bdi>
                    {soundLength(s.durationMs) ? ` · ${soundLength(s.durationMs)}` : ''}
                  </span>
                  <span className="music-row__credit">{credit({ ...s, licenceName: s.licence.name })}</span>
                  {s.blocked ? <span className="music-row__blocked">{t(`music.blocked.${s.blocked}` as MessageKey)}</span> : null}
                </span>
                <button
                  type="button"
                  className="music-row__save"
                  aria-pressed={s.saved}
                  aria-label={t(s.saved ? 'music.unsave' : 'music.save', { title: s.title })}
                  onClick={() => void toggleSave(s)}
                >
                  <Icon name="bookmark" filled={s.saved} size={18} />
                </button>
                <Button size="sm" variant="secondary" disabled={!s.canUse} aria-label={t('m.music.useTitle', { title: s.title })} onClick={() => onPick(s)}>
                  {t('m.music.use')}
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">{q.trim() ? t('music.noMatch', { q: q.trim() }) : tab === 'saved' ? t('music.emptySaved') : t('music.empty')}</p>
        )}
      </div>
    </BottomSheet>
  );
}

/**
 * Choose the part that plays: a waveform-style strip of the song with the part highlighted (drag
 * along it, or use the arrow keys), and the part's length within what the licence allows.
 */
function PartChooser({ value, onChange, max }: { value: DraftMusic; onChange: (m: DraftMusic) => void; max: number }) {
  const { t } = useSession();
  const bars = useMemo(() => waveformBars(value.track.id, 56), [value.track.id]);
  const songMs = value.track.durationMs ?? Math.max(60_000, value.startMs + value.durationMs);
  const maxStart = Math.max(0, songMs - value.durationMs);
  const from = songMs ? value.startMs / songMs : 0;
  const width = songMs ? Math.min(1, value.durationMs / songMs) : 1;
  const min = Math.min(MUSIC_CLIP_MIN_MS, max);
  return (
    <div className="stack-sm">
      <div className="music-wave">
        <div className="music-wave__bars" aria-hidden>
          {bars.map((h, i) => {
            const at = (i + 0.5) / bars.length;
            return (
              <span
                key={i}
                className={at >= from && at <= from + width ? 'music-wave__bar music-wave__bar--in' : 'music-wave__bar'}
                style={{ height: `${h * 100}%` }}
              />
            );
          })}
          <span className="music-wave__window" style={{ insetInlineStart: `${from * 100}%`, width: `${width * 100}%` }} />
        </div>
        {maxStart > 0 ? (
          <input
            type="range"
            className="music-wave__range"
            min={0}
            max={maxStart}
            step={500}
            value={Math.min(value.startMs, maxStart)}
            aria-label={t('music.scrubber')}
            aria-valuetext={t('m.music.part', { from: clock(value.startMs), to: clock(value.startMs + value.durationMs) })}
            onChange={(e) => onChange({ ...value, startMs: Number(e.currentTarget.value) })}
          />
        ) : null}
      </div>
      <p className="muted music-hint">{maxStart > 0 ? t('music.scrubberHint') : t('m.music.short')}</p>
      {max > min ? (
        <label className="yp-field">
          <span className="yp-field__label">
            {t('music.length')}: {t('music.seconds', { seconds: Math.round(value.durationMs / 1000) })}
          </span>
          <input
            type="range"
            className="music-range"
            min={min}
            max={max}
            step={1000}
            value={value.durationMs}
            aria-label={t('music.length')}
            aria-valuetext={t('music.seconds', { seconds: Math.round(value.durationMs / 1000) })}
            onChange={(e) => {
              const durationMs = Number(e.currentTarget.value);
              const song = value.track.durationMs;
              onChange({ ...value, durationMs, startMs: song ? Math.min(value.startMs, Math.max(0, song - durationMs)) : value.startMs });
            }}
          />
          <span className="muted music-hint">{t('music.lengthMax', { seconds: Math.round(max / 1000) })}</span>
        </label>
      ) : null}
    </div>
  );
}

/**
 * Music for a post, reel or story in Create: pick from the music picker, choose the part (5 to 30
 * seconds, 15 on stories, never longer than the song's licence allows) and see the credit that
 * shows with it. On a reel, a sound from the library plays in full instead of the video's own sound.
 */
export function MusicField({
  use,
  value,
  onChange,
  video = false,
  children,
}: {
  use: MusicUse;
  value: DraftMusic | null;
  onChange: (m: DraftMusic | null) => void;
  video?: boolean;
  /** Extra controls for the picked music (the sticker style on stories). */
  children?: React.ReactNode;
}) {
  const { t } = useSession();
  const credit = useMusicCredit();
  const [picking, setPicking] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  // After a song is picked the "Add music" button is gone: focus goes to "Choose another".
  const another = useRef<HTMLButtonElement>(null);
  const [picked, setPicked] = useState(0);
  useEffect(() => {
    if (picked) another.current?.focus();
  }, [picked]);
  const wholeSound = use === 'reel' && value?.track.source === 'library';
  const part = value ? (storyMusicPart(value.startMs, value.durationMs, value.track.durationMs) ?? { startMs: 0, durationMs: value.durationMs }) : null;
  useMusicLoop(value && part && !wholeSound ? { sound: { audioUrl: value.track.previewUrl }, ...part } : null, previewing);
  useEffect(() => {
    if (!value) setPreviewing(false);
  }, [value]);
  const headingId = `music-heading-${use}`;

  return (
    <section className="stack-sm" aria-labelledby={headingId}>
      <h2 id={headingId} className="yp-field__label" style={{ margin: 0 }}>
        {t(use === 'reel' ? 'm.sound.title' : 'm.music.title')}
      </h2>
      {value && part ? (
        <div className="stack-sm">
          <div className="sound-row sound-row--picked">
            {wholeSound ? (
              <SoundPlayButton sound={{ title: value.track.title, audioUrl: value.track.previewUrl }} />
            ) : (
              <button
                type="button"
                className="sound-play"
                // The name says what pressing does, so no aria-pressed as well.
                aria-label={t(previewing ? 'm.music.stopPart' : 'm.music.playPart')}
                disabled={!value.track.previewUrl}
                onClick={() => setPreviewing((p) => !p)}
              >
                <Icon name={previewing ? 'pause' : 'play'} filled size={18} />
              </button>
            )}
            <span className="sound-row__text">
              <bdi className="sound-row__title">{value.track.title}</bdi>
              <span className="sound-row__meta">
                <bdi>{value.track.artist}</bdi>
                {wholeSound
                  ? ` · ${t('compose.soundReplaces')}`
                  : ` · ${t('m.music.part', { from: clock(part.startMs), to: clock(part.startMs + part.durationMs) })}`}
              </span>
            </span>
            <Button size="sm" variant="ghost" onClick={() => onChange(null)}>
              {t('m.common.remove')}
            </Button>
          </div>
          {wholeSound ? null : <PartChooser value={value} onChange={onChange} max={clipMax(value.track, use)} />}
          <p className="music-row__credit">{credit({ ...value.track, licenceName: value.track.licence.name })}</p>
          {children}
          <p className="muted music-hint">
            {use === 'post'
              ? t('music.postHint')
              : use === 'reel'
                ? t(wholeSound ? 'compose.soundReplaces' : 'music.reelHint')
                : t(video ? 'm.music.videoHint' : 'm.music.moveHint')}
          </p>
          <div className="row">
            <Button ref={another} size="sm" variant="secondary" icon="music" onClick={() => (setPreviewing(false), setPicking(true))}>
              {t('m.music.another')}
            </Button>
          </div>
        </div>
      ) : (
        <div className="row">
          <Button size="sm" variant="secondary" icon="music" onClick={() => setPicking(true)}>
            {t('m.music.add')}
          </Button>
        </div>
      )}
      <MusicPicker
        open={picking}
        onClose={() => setPicking(false)}
        onPick={(track) => {
          onChange(draftMusic(track, use, value ? { startMs: 0, durationMs: value.durationMs } : undefined));
          setPicking(false);
          setPicked((n) => n + 1);
        }}
      />
    </section>
  );
}
