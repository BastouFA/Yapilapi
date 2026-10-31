'use client';

import { WATCH_PHOTO_MS } from '@yapilapi/shared';

/**
 * What the watch together sync engine (useWatchSync in WatchScreen.tsx) drives: a <video>
 * element, or something that behaves like one. Photos (PhotoClock) and YouTube videos
 * (YouTubeMedia) get the same few properties and events (play, pause, ended, seeked,
 * timeupdate, durationchange, loadedmetadata), so one engine keeps every kind in step.
 */
export interface WatchMedia extends EventTarget {
  readonly readyState: number;
  readonly duration: number;
  currentTime: number;
  readonly paused: boolean;
  readonly ended: boolean;
  playbackRate: number;
  muted: boolean;
  /** `item`: the queue item it shows. */
  readonly dataset: { item?: string };
  /** False when the rate can't be nudged smoothly: drift is fixed by seeking (driftFix's `canNudge`). */
  readonly canNudge?: boolean;
  play(): Promise<void>;
  pause(): void;
}

/** The events the engine listens to, wired onto a media that isn't a <video> element. */
export const MEDIA_EVENTS = ['loadedmetadata', 'ended', 'play', 'pause'] as const;

const fire = (t: EventTarget, type: string) => t.dispatchEvent(new Event(type));

/**
 * A photo in the queue: a clock that runs for WATCH_PHOTO_MS while playing and then ends (so the
 * queue moves on for everyone at the same moment); paused, the photo stays up. Seeking moves the
 * clock like a video's position.
 */
export class PhotoClock extends EventTarget implements WatchMedia {
  readonly canNudge = false;
  readonly readyState = 4;
  readonly duration = WATCH_PHOTO_MS / 1000;
  readonly dataset: { item?: string };
  playbackRate = 1;
  muted = false;
  private base = 0;
  private startedAt: number | null = null;
  private done = false;
  private timer: ReturnType<typeof setInterval>;

  constructor(item: string) {
    super();
    this.dataset = { item };
    this.timer = setInterval(() => this.tick(), 250);
  }

  get currentTime(): number {
    const run = this.startedAt === null ? 0 : (performance.now() - this.startedAt) / 1000;
    return Math.min(this.duration, this.base + run);
  }
  set currentTime(t: number) {
    this.base = Math.max(0, Math.min(this.duration, t));
    if (this.startedAt !== null) this.startedAt = performance.now();
    this.done = this.base >= this.duration;
    fire(this, 'seeked');
    fire(this, 'timeupdate');
  }
  get paused(): boolean {
    return this.startedAt === null;
  }
  get ended(): boolean {
    return this.done;
  }
  play(): Promise<void> {
    if (this.startedAt === null && !this.done) {
      this.startedAt = performance.now();
      fire(this, 'play');
    }
    return Promise.resolve();
  }
  pause(): void {
    if (this.startedAt === null) return;
    this.base = this.currentTime;
    this.startedAt = null;
    fire(this, 'pause');
  }
  private tick() {
    if (this.startedAt === null) return;
    fire(this, 'timeupdate');
    if (this.currentTime >= this.duration && !this.done) {
      this.done = true;
      this.base = this.duration;
      this.startedAt = null;
      fire(this, 'ended');
    }
  }
  destroy() {
    clearInterval(this.timer);
  }
}

// ── YouTube ───────────────────────────────────────────────────────────────

/** The parts of YouTube's IFrame Player API used here (https://developers.google.com/youtube/iframe_api_reference). */
interface YTPlayer {
  playVideo(): void;
  pauseVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  getCurrentTime(): number;
  getDuration(): number;
  getPlayerState(): number;
  mute(): void;
  unMute(): void;
  destroy(): void;
}
interface YTNamespace {
  Player: new (
    el: HTMLElement,
    o: {
      host?: string;
      videoId: string;
      width?: string;
      height?: string;
      playerVars?: Record<string, string | number>;
      events?: { onReady?: () => void; onStateChange?: (e: { data: number }) => void; onError?: (e: { data: number }) => void };
    },
  ) => YTPlayer;
}
declare global {
  interface Window {
    YT?: YTNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

let loading: Promise<YTNamespace> | null = null;

/** YouTube's player script, loaded once and only when a YouTube video comes up. */
function loadYouTube(): Promise<YTNamespace> {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (!loading)
    loading = new Promise((resolve, reject) => {
      const before = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => {
        before?.();
        resolve(window.YT!);
      };
      const s = document.createElement('script');
      s.src = 'https://www.youtube.com/iframe_api';
      s.async = true;
      s.onerror = () => {
        loading = null;
        reject(new Error('YouTube player script failed to load'));
      };
      document.head.appendChild(s);
    });
  return loading;
}

const YT_ENDED = 0;
const YT_PLAYING = 1;
const YT_PAUSED = 2;
const YT_BUFFERING = 3;

/**
 * A YouTube video in YouTube's own player (the privacy-enhanced youtube-nocookie.com embed, never
 * covered or changed). Its rate can't be nudged, so drift is fixed by seeking. `play()` fails with
 * NotAllowedError when the browser won't let it start with sound (the engine then starts it
 * muted, with "Tap for sound"). `onError` gets YouTube's error code (101 and 150: the owner
 * doesn't allow embedding; 100: gone).
 */
export class YouTubeMedia extends EventTarget implements WatchMedia {
  readonly canNudge = false;
  readonly dataset: { item?: string };
  private player: YTPlayer | null = null;
  private state = -1;
  private ready = false;
  private wantMuted = false;
  private gone = false;
  private timer: ReturnType<typeof setInterval>;

  constructor(host: HTMLElement, videoId: string, item: string, onError: (code: number) => void) {
    super();
    this.dataset = { item };
    const el = document.createElement('div');
    host.appendChild(el);
    loadYouTube().then(
      (YT) => {
        if (this.gone) return;
        this.player = new YT.Player(el, {
          host: 'https://www.youtube-nocookie.com',
          videoId,
          width: '100%',
          height: '100%',
          // Its own controls stay off so play, pause and seeking go through the shared controls
          // (everyone moves together); inline on iPhones.
          playerVars: { playsinline: 1, controls: 0, disablekb: 1, rel: 0, fs: 0, origin: window.location.origin },
          events: {
            onReady: () => {
              this.ready = true;
              if (this.wantMuted) this.player?.mute();
              fire(this, 'durationchange');
              fire(this, 'loadedmetadata');
            },
            onStateChange: (e) => {
              const prev = this.state;
              this.state = e.data;
              if (e.data === YT_PLAYING && prev !== YT_PLAYING && prev !== YT_BUFFERING) fire(this, 'play');
              if (e.data === YT_PAUSED) fire(this, 'pause');
              if (e.data === YT_ENDED) fire(this, 'ended');
              fire(this, 'timeupdate');
            },
            onError: (e) => onError(e.data),
          },
        });
      },
      () => onError(-1),
    );
    this.timer = setInterval(() => this.ready && fire(this, 'timeupdate'), 250);
  }

  get readyState(): number {
    return this.ready ? 4 : 0;
  }
  get duration(): number {
    const d = this.player?.getDuration?.();
    return d && d > 0 ? d : Number.NaN;
  }
  get currentTime(): number {
    return this.player?.getCurrentTime?.() ?? 0;
  }
  set currentTime(t: number) {
    this.player?.seekTo(t, true);
    fire(this, 'seeked');
    fire(this, 'timeupdate');
  }
  get paused(): boolean {
    return this.state !== YT_PLAYING && this.state !== YT_BUFFERING;
  }
  get ended(): boolean {
    return this.state === YT_ENDED;
  }
  get playbackRate(): number {
    return 1;
  }
  set playbackRate(_r: number) {
    // YouTube only has coarse rates: drift is fixed by seeking instead.
  }
  get muted(): boolean {
    return this.wantMuted;
  }
  set muted(m: boolean) {
    this.wantMuted = m;
    if (!this.player || !this.ready) return;
    if (m) this.player.mute();
    else this.player.unMute();
  }
  play(): Promise<void> {
    if (!this.player || !this.ready) return Promise.resolve();
    this.player.playVideo();
    // A browser that wants a tap before sound leaves it unstarted: say so like a <video> would.
    return new Promise((resolve, reject) => {
      const startedAt = performance.now();
      const check = () => {
        if (this.gone || this.state === YT_PLAYING) return resolve();
        if (performance.now() - startedAt > 2500) return this.state === YT_BUFFERING ? resolve() : reject(new DOMException('Needs a tap', 'NotAllowedError'));
        setTimeout(check, 150);
      };
      check();
    });
  }
  pause(): void {
    this.player?.pauseVideo();
  }
  destroy() {
    this.gone = true;
    clearInterval(this.timer);
    this.player?.destroy();
  }
}
