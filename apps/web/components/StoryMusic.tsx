'use client';

import { useEffect, useRef, useState } from 'react';
import { Icon } from '@yapilapi/design-system';
import type { MessageKey, StoryMusic } from '@yapilapi/shared';
import { stickerStyle } from '@/components/StoryStickers';
import { useSession } from '@/app/providers';

/** Where a song or sound's page is: sounds under /sounds, catalogue songs under /music. */
export const musicHref = (m: { source?: string; id: string }) => (!m.source || m.source === 'library' ? `/sounds/${m.id}` : `/music/${m.id}`);

/** "Music: Title by Artist · CC BY 4.0" (and a partner's own credit), or "Original sound by Ada" for sounds. */
export function useMusicCredit() {
  const { t } = useSession();
  return (m: { source?: string; title: string; artist: string; licenceName?: string | null; attribution?: string | null }) => {
    if (!m.source || m.source === 'library') return t('music.originalCredit', { artist: m.artist });
    const line = t('music.credit', { title: m.title, artist: m.artist, licence: m.licenceName ?? '' });
    // A partner's own credit (a label line) goes after, when it isn't the same line.
    return m.attribution && !m.attribution.startsWith(m.title) ? `${line} · ${m.attribution}` : line;
  };
}

/**
 * Play the part of a sound in a loop while `playing`. Nothing loads until it is asked to play,
 * so stories stay silent (and cost no data) for people who keep music off.
 */
export function useMusicLoop(music: { startMs: number; durationMs: number; sound: { audioUrl: string | null } } | null, playing: boolean) {
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
  const { t } = useSession();
  const credit = useMusicCredit();
  const catalogue = !!music.sound.source && music.sound.source !== 'library';
  const names = { title: music.sound.title, artist: music.sound.artist };
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
        {catalogue ? <span className="music-sticker__credit">{credit(music.sound)}</span> : null}
        {music.sound.unavailable ? <span className="music-sticker__credit">{t(`music.unavailable.${music.sound.unavailable}` as MessageKey)}</span> : null}
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
    <button type="button" className={className} style={stickerStyle(music)} aria-label={t('m.music.sticker', names)} onClick={onOpen}>
      {inner}
    </button>
  ) : (
    <span className={className} style={stickerStyle(music)} aria-label={t('storyMusic.stickerLabel', names)} role="img">
      {inner}
    </span>
  );
}
