'use client';

import { useEffect, useRef, useState } from 'react';
import { Button, Icon, Segments } from '@yapilapi/design-system';
import { STORY_MUSIC_MAX_MS, storyMusicMaxStart, storyMusicPart, type Sound, type StoryMusic, type StoryMusicStyle } from '@yapilapi/shared';
import { SoundPicker } from '@/components/SoundPicker';
import { stickerStyle } from '@/components/StoryStickers';

/** Music chosen for a story that isn't posted yet. */
export interface DraftMusic {
  sound: Sound;
  startMs: number;
  style: StoryMusicStyle;
  x: number;
  y: number;
}

export const draftMusic = (sound: Sound): DraftMusic => ({ sound, startMs: 0, style: 'compact', x: 0.5, y: 0.78 });

/** What the API takes for the draft. */
export const musicInput = (m: DraftMusic) => ({ soundId: m.sound.id, startMs: m.startMs, durationMs: STORY_MUSIC_MAX_MS, style: m.style, x: m.x, y: m.y });

/** The part as a viewer will get it, for previews before posting. */
export function draftAsStoryMusic(m: DraftMusic): StoryMusic {
  const part = storyMusicPart(m.startMs, STORY_MUSIC_MAX_MS, m.sound.durationMs) ?? { startMs: 0, durationMs: STORY_MUSIC_MAX_MS };
  return {
    sound: {
      id: m.sound.id,
      title: m.sound.title,
      artist: m.sound.owner.displayName,
      username: m.sound.owner.username,
      durationMs: m.sound.durationMs,
      audioUrl: m.sound.audioUrl,
      coverUrl: m.sound.coverUrl,
    },
    ...part,
    style: m.style,
    x: m.x,
    y: m.y,
  };
}

/** "0:30" style time. */
const clock = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/**
 * Play the part of a sound in a loop while `playing`. Nothing loads until it is asked to play,
 * so stories stay silent (and cost no data) for people who keep music off.
 */
export function useMusicLoop(music: Pick<StoryMusic, 'startMs' | 'durationMs' | 'sound'> | null, playing: boolean) {
  const audio = useRef<HTMLAudioElement | null>(null);
  const url = music?.sound.audioUrl ?? null;
  const start = (music?.startMs ?? 0) / 1000;
  const end = start + (music?.durationMs ?? 0) / 1000;

  useEffect(() => {
    if (!url || !playing) return;
    const a = audio.current ?? new Audio();
    audio.current = a;
    a.preload = 'auto';
    const toStart = () => {
      try {
        a.currentTime = start;
      } catch {
        // Not seekable yet: loadedmetadata tries again.
      }
    };
    const onTime = () => {
      if (a.currentTime >= end - 0.05 || a.currentTime < start - 0.5) toStart();
    };
    const onEnded = () => {
      toStart();
      void a.play().catch(() => {});
    };
    a.addEventListener('loadedmetadata', toStart);
    a.addEventListener('timeupdate', onTime);
    a.addEventListener('ended', onEnded);
    if (a.src !== new URL(url, location.href).toString()) {
      a.src = url;
      a.load();
    }
    if (a.readyState >= 1) toStart();
    void a.play().catch(() => {});
    return () => {
      a.pause();
      a.removeEventListener('loadedmetadata', toStart);
      a.removeEventListener('timeupdate', onTime);
      a.removeEventListener('ended', onEnded);
    };
  }, [url, start, end, playing]);

  // Let go of the file when the component goes away.
  useEffect(
    () => () => {
      if (audio.current) {
        audio.current.pause();
        audio.current.removeAttribute('src');
        audio.current.load();
        audio.current = null;
      }
    },
    [],
  );
}

const SOUND_KEY = 'yp.stories.music';

/**
 * Whether story music plays out loud. Off until the viewer turns it on once; the choice is
 * remembered on this device.
 */
export function useStoryMusicOn(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(false);
  useEffect(() => {
    try {
      setOn(localStorage.getItem(SOUND_KEY) === 'on');
    } catch {
      // Storage blocked: stay silent.
    }
  }, []);
  return [
    on,
    (next: boolean) => {
      setOn(next);
      try {
        localStorage.setItem(SOUND_KEY, next ? 'on' : 'off');
      } catch {
        // Not remembered this time.
      }
    },
  ];
}

/**
 * The music sticker on a story: the sound's title and who made it, as a small pill or a card with
 * the sound's cover. Tapping it opens the sound's page.
 */
export function MusicSticker({ music, playing, onOpen }: { music: StoryMusic; playing: boolean; onOpen?: () => void }) {
  const label = `Sound: ${music.sound.title}, by ${music.sound.artist}`;
  const inner = (
    <>
      {music.style === 'card' ? (
        <span className="music-sticker__cover" style={music.sound.coverUrl ? { backgroundImage: `url(${music.sound.coverUrl})` } : undefined} aria-hidden>
          {music.sound.coverUrl ? null : <Icon name="music" size={20} />}
        </span>
      ) : (
        <Icon name="music" size={16} />
      )}
      <span className="music-sticker__text">
        <bdi className="music-sticker__title">{music.sound.title}</bdi>
        <bdi className="music-sticker__artist">{music.sound.artist}</bdi>
      </span>
      <span className={`music-sticker__bars${playing ? ' music-sticker__bars--on' : ''}`} aria-hidden>
        <span />
        <span />
        <span />
      </span>
    </>
  );
  const className = `music-sticker music-sticker--${music.style}`;
  return onOpen ? (
    <button type="button" className={className} style={stickerStyle(music)} aria-label={`${label}. Open the sound`} onClick={onOpen}>
      {inner}
    </button>
  ) : (
    <span className={className} style={stickerStyle(music)} aria-label={label} role="img">
      {inner}
    </span>
  );
}

/**
 * Music for a story in Create: pick a sound (search, or the most used ones), choose the 15 second
 * part that plays, and how the sticker looks. The sticker is moved on the sticker preview.
 */
export function StoryMusicField({ value, onChange, video }: { value: DraftMusic | null; onChange: (m: DraftMusic | null) => void; video: boolean }) {
  const [picking, setPicking] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  // After a sound is picked the "Add music" button is gone: focus goes to "Choose another sound".
  const another = useRef<HTMLButtonElement>(null);
  const [picked, setPicked] = useState(0);
  useEffect(() => {
    if (picked) another.current?.focus();
  }, [picked]);
  const preview = value ? draftAsStoryMusic(value) : null;
  useMusicLoop(preview, previewing);
  useEffect(() => {
    if (!value) setPreviewing(false);
  }, [value]);

  const maxStart = value ? storyMusicMaxStart(value.sound.durationMs) : 0;
  return (
    <section className="stack-sm" aria-labelledby="music-heading">
      <h2 id="music-heading" className="yp-field__label" style={{ margin: 0 }}>
        Music
      </h2>
      {value && preview ? (
        <div className="stack-sm">
          <div className="sound-row sound-row--picked">
            <button
              type="button"
              className="sound-play"
              aria-label={previewing ? 'Stop the part' : 'Play the part'}
              disabled={!value.sound.audioUrl}
              onClick={() => setPreviewing((p) => !p)}
            >
              <Icon name={previewing ? 'pause' : 'play'} filled size={18} />
            </button>
            <span className="sound-row__text">
              <bdi className="sound-row__title">{value.sound.title}</bdi>
              <span className="sound-row__meta">
                <bdi>@{value.sound.owner.username}</bdi> · Plays {clock(preview.startMs)} to {clock(preview.startMs + preview.durationMs)}, in a loop
              </span>
            </span>
            <Button size="sm" variant="ghost" onClick={() => onChange(null)}>
              Remove
            </Button>
          </div>
          {maxStart > 0 ? (
            <label className="yp-field">
              <span className="yp-field__label">Start of the part</span>
              <input
                type="range"
                className="music-range"
                min={0}
                max={maxStart}
                step={500}
                value={Math.min(value.startMs, maxStart)}
                aria-valuetext={`Starts at ${clock(value.startMs)}`}
                onChange={(e) => onChange({ ...value, startMs: Number(e.currentTarget.value) })}
              />
            </label>
          ) : (
            <p className="muted" style={{ margin: 0, fontSize: 13 }}>
              This sound is short, so all of it plays.
            </p>
          )}
          <Segments
            label="Sticker"
            value={value.style}
            onChange={(style) => onChange({ ...value, style })}
            options={[
              { id: 'compact', label: 'Compact' },
              { id: 'card', label: 'Card with cover' },
            ]}
          />
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>
            {video
              ? "On a video, the music plays instead of the video's own sound. Remove the music to keep the video's sound."
              : 'Drag the music sticker on the preview to move it.'}
          </p>
          <div className="row">
            <Button ref={another} size="sm" variant="secondary" icon="music" onClick={() => (setPreviewing(false), setPicking(true))}>
              Choose another sound
            </Button>
          </div>
        </div>
      ) : (
        <div className="row">
          <Button size="sm" variant="secondary" icon="music" onClick={() => setPicking(true)}>
            Add music
          </Button>
        </div>
      )}
      <SoundPicker
        open={picking}
        onClose={() => setPicking(false)}
        onPick={(s) => {
          onChange(value ? { ...value, sound: s, startMs: 0 } : draftMusic(s));
          setPicking(false);
          setPicked((n) => n + 1);
        }}
      />
    </section>
  );
}
