'use client';

import { useEffect, useRef, useState } from 'react';
import { BottomSheet, Button, Icon } from '@yapilapi/design-system';
import type { Sound } from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';

/** "1:05" style length. */
export function soundLength(ms: number | null | undefined): string | null {
  if (!ms) return null;
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * Play or pause a sound. The audio is the source reel's video track, played
 * without the picture. Only one sound plays at a time on the page.
 */
export function SoundPlayButton({ sound, size = 'md' }: { sound: Pick<Sound, 'title' | 'audioUrl'>; size?: 'md' | 'lg' }) {
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    const stopOthers = (e: Event) => {
      if (e.target !== audio.current) audio.current?.pause();
    };
    document.addEventListener('play', stopOthers, true);
    return () => document.removeEventListener('play', stopOthers, true);
  }, []);
  if (!sound.audioUrl) return null;
  return (
    <>
      <button
        type="button"
        className={`sound-play${size === 'lg' ? ' sound-play--lg' : ''}`}
        aria-pressed={playing}
        aria-label={playing ? `Pause ${sound.title}` : `Play ${sound.title}`}
        onClick={() => {
          const a = audio.current;
          if (!a) return;
          if (a.paused) void a.play().catch(() => setPlaying(false));
          else a.pause();
        }}
      >
        <Icon name={playing ? 'pause' : 'play'} filled size={size === 'lg' ? 28 : 18} />
      </button>
      <audio
        ref={audio}
        src={sound.audioUrl}
        preload="none"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
      />
    </>
  );
}

/** Pick a sound for a reel: the most used ones you can use, searchable by name or by who made it. */
export function SoundPicker({ open, onClose, onPick }: { open: boolean; onClose: () => void; onPick: (s: Sound) => void }) {
  const [q, setQ] = useState('');
  const [items, setItems] = useState<Sound[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const req = useRef(0);

  useEffect(() => {
    if (!open) return;
    const n = ++req.current;
    const timer = setTimeout(
      () =>
        api.sounds.list(q.trim(), 20).then(
          (r) => n === req.current && (setItems(r.items), setError(null)),
          (e) => n === req.current && setError(errorMessage(e)),
        ),
      q ? 200 : 0,
    );
    return () => clearTimeout(timer);
  }, [q, open]);

  return (
    <BottomSheet open={open} onClose={onClose} title="Choose a sound">
      <div className="stack">
        <label className="yp-visually-hidden" htmlFor="sound-search">
          Search sounds
        </label>
        <input
          id="sound-search"
          className="yp-input"
          type="search"
          placeholder="Search by name or creator"
          value={q}
          maxLength={60}
          onChange={(e) => setQ(e.currentTarget.value)}
        />
        {error ? <p className="muted">{error}</p> : null}
        {items === null ? (
          <p className="muted">Loading sounds</p>
        ) : items.length ? (
          <ul className="sound-list">
            {items.map((s) => (
              <li key={s.id} className="sound-row">
                <SoundPlayButton sound={s} />
                <span className="sound-row__text">
                  <bdi className="sound-row__title">{s.title}</bdi>
                  <span className="sound-row__meta">
                    <bdi>@{s.owner.username}</bdi>
                    {soundLength(s.durationMs) ? ` · ${soundLength(s.durationMs)}` : ''} · {s.reels} {s.reels === 1 ? 'reel' : 'reels'}
                  </span>
                </span>
                <Button size="sm" variant="secondary" onClick={() => onPick(s)}>
                  Use
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">{q.trim() ? `No sounds match "${q.trim()}".` : 'No sounds to use yet.'}</p>
        )}
      </div>
    </BottomSheet>
  );
}
