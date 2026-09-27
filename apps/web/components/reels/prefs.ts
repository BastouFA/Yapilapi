import { REEL_SPEEDS, type ReelSpeed } from '@yapilapi/shared';

/** How this viewer likes to watch reels, kept in this browser only (a convenience, never sent). */
export interface ReelPrefs {
  speed: ReelSpeed;
  /** Subtitle tracks on, when a reel has them. */
  captions: boolean;
  /** Bigger subtitles and caption text. */
  bigCaptions: boolean;
  /** 'auto' follows Data saver; 'saver' always plays the 360p file; 'best' the full one. */
  quality: 'auto' | 'saver' | 'best';
  /** The "Tap for sound" hint was seen (it shows once). */
  soundHintSeen: boolean;
}

const KEY = 'yp.reels.prefs';
export const DEFAULT_PREFS: ReelPrefs = { speed: 1, captions: true, bigCaptions: false, quality: 'auto', soundHintSeen: false };

export function readPrefs(): ReelPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<ReelPrefs>;
    return {
      speed: (REEL_SPEEDS as readonly number[]).includes(raw.speed as number) ? (raw.speed as ReelSpeed) : 1,
      captions: raw.captions !== false,
      bigCaptions: raw.bigCaptions === true,
      quality: raw.quality === 'saver' || raw.quality === 'best' ? raw.quality : 'auto',
      soundHintSeen: raw.soundHintSeen === true,
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

export function writePrefs(p: ReelPrefs) {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* private mode or storage off: the choice lasts for this page */
  }
}

/** Whether the viewer asked for less motion (no bursts, no fades that move). */
export function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}
