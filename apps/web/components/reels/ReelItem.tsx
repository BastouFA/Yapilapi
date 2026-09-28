'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Avatar, CaptionTracks, Icon, SensitiveCover, TaggedText, TranslatableText, useLongPress, videoCrossOrigin } from '@yapilapi/design-system';
import { formatReelTime, videoPoster, videoSrc, type MessageKey, type Post, type ReelMoment } from '@yapilapi/shared';
import { NextLink } from '@/lib/link';
import { musicHref, useMusicCredit, useMusicLoop } from '@/components/StoryMusic';
import { useSession } from '@/app/providers';
import { Scrubber } from './Scrubber';
import { prefersReducedMotion, type ReelPrefs } from './prefs';

/** What the viewer does for a reel (it owns the list, the sheets and the shared settings). */
export interface ReelViewerApi {
  like: (p: Post, force?: boolean) => void;
  follow: (p: Post) => void;
  comments: (p: Post, atMs: number | null) => void;
  share: (p: Post) => void;
  options: (p: Post) => void;
  save: (p: Post) => void;
  saveTo?: (p: Post) => void;
  toggleMute: () => void;
  toggleClear: () => void;
  next: () => void;
  previous: () => void;
  back: () => void;
  announce: (text: string) => void;
  soundHintSeen: () => void;
  watched: (p: Post) => void;
  /** The reel's video element, so sheets (comments, highlights) can read and set its time. */
  register: (id: string, el: HTMLVideoElement | null) => void;
  /** Where the viewer stopped, sent now and then (the server keeps it only mid-way). */
  resume: (p: Post, positionMs: number, durationMs: number) => void;
  clearResume: (p: Post) => void;
  /** Your echo whose original is gone: keep it to yourself, or delete it. */
  keepEchoPrivate: (p: Post) => void;
  deleteEcho: (p: Post) => void;
}

type AuthorStat = { followers: number; following: boolean } | undefined;

const TAP_MS = 260;
const HOLD_MS = 380;
/** The UI fades to a faint state after this much playback without a touch, a hover or a pause. */
const FADE_MS = 3000;

/** Keep a companion (the duet's original, or a borrowed sound) in step with the reel's own video. */
function sync(v: HTMLVideoElement, other: HTMLMediaElement | null, event: 'play' | 'pause' | 'time') {
  if (!other) return;
  if (event === 'pause') return other.pause();
  other.playbackRate = v.playbackRate;
  const target = other.duration && Number.isFinite(other.duration) ? v.currentTime % other.duration : v.currentTime;
  if (Math.abs(other.currentTime - target) > 0.35) other.currentTime = target;
  if (event === 'play' && other.paused) void other.play().catch(() => {});
}

/**
 * One reel, one screen. The video fills the frame when it's vertical and is shown whole over a
 * blurred copy of its poster when it's landscape or square. A tap plays or pauses (with a brief
 * sign), a double tap likes (the YAPILAPI blocks burst from where you tapped), holding pauses
 * while held (or plays at 2× on the right edge of a touch screen). The info strip stays low and
 * fades after a few seconds; "more" opens the full details. Everything stays in the page for
 * screen readers, whatever is shown.
 */
export function ReelItem({
  post,
  stats,
  index,
  active,
  near,
  muted,
  clear,
  prefs,
  saver,
  frameRatio,
  moments,
  showSoundHint,
  pageVisible,
  meId,
  viewer,
}: {
  post: Post;
  stats: AuthorStat;
  index: number;
  active: boolean;
  /** The next reel: its video loads ahead. */
  near: boolean;
  muted: boolean;
  clear: boolean;
  prefs: ReelPrefs;
  /** Play the small file and wait for a tap (Data saver or the "Data saver" quality). */
  saver: boolean;
  /** Width over height of the frame, to choose between filling it and showing the whole video. */
  frameRatio: number;
  moments: ReelMoment[];
  showSoundHint: boolean;
  pageVisible: boolean;
  meId: string | undefined;
  viewer: ReelViewerApi;
}) {
  const { t, tp, locale } = useSession();
  const credit = useMusicCredit();
  const compact = new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 });
  const mine = post.author.id === meId;
  const media = post.media.find((m) => m.kind === 'video') ?? post.media[0];

  const video = useRef<HTMLVideoElement>(null);
  const companion = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  const [started, setStarted] = useState(false);
  const [userPaused, setUserPaused] = useState(false);
  const [holding, setHolding] = useState<null | 'pause' | 'fast'>(null);
  const [playing, setPlaying] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [time, setTime] = useState({ current: 0, duration: 0 });
  const [awake, setAwake] = useState(true);
  const [scrubbing, setScrubbing] = useState(false);
  const [details, setDetails] = useState(false);
  const [indicator, setIndicator] = useState<{ kind: 'play' | 'pause'; key: number } | null>(null);
  const [bursts, setBursts] = useState<{ key: number; x: number; y: number }[]>([]);
  const [pop, setPop] = useState<ReelMoment | null>(null);
  const [resumed, setResumed] = useState<number | null>(null);
  const [natural, setNatural] = useState<number | null>(null);
  const [revealed, setRevealed] = useState(false);

  const covered = !!media?.sensitive && !revealed;
  const waiting = saver && !started;
  const src = media ? videoSrc(media, saver) : undefined;
  const poster = media ? videoPoster(media, saver) : undefined;
  // Duets play beside the original; reels using another sound play that sound; a catalogue song loops its part.
  const original = post.remixOf?.mode === 'duet' ? (post.remixOf.post?.media ?? null) : null;
  const originalSrc = original ? videoSrc(original, saver) : null;
  const borrowed = !original && post.sound && !post.sound.original ? post.sound.audioUrl : null;
  const song = !original && !borrowed && post.music?.audioUrl ? post.music : null;
  // An echo keeping the original's song plays it with the echo's own sound (their voice and yours).
  const songWithVideo = !!song && !!post.echoOf;
  const echoGone = !!post.echoOf && !post.echoOf.post;
  const echoes = post.counts.echoes ?? 0;
  const captions = media?.captions ?? [];
  const highlights = post.highlights ?? [];

  const shouldPlay = active && pageVisible && !userPaused && !holding && !covered && !waiting && !scrubbing;
  useMusicLoop(song ? { startMs: song.startMs, durationMs: song.durationMs, sound: { audioUrl: song.audioUrl } } : null, playing && !muted);

  // Vertical videos fill the frame; landscape and square ones are shown whole.
  const ratio = media?.width && media?.height ? media.width / media.height : natural;
  const fit: 'cover' | 'contain' = !originalSrc && ratio && ratio > frameRatio * 1.25 ? 'contain' : 'cover';

  useEffect(() => {
    viewer.register(post.id, video.current);
    return () => viewer.register(post.id, null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [post.id, src]);

  // Play the reel on screen; pause the others.
  useEffect(() => {
    const v = video.current;
    if (!v) return;
    if (shouldPlay) {
      void v.play().then(
        () => {
          setPlaying(true);
          setBlocked(false);
        },
        () => {
          setPlaying(false);
          setBlocked(true);
        },
      );
    } else {
      v.pause();
      setPlaying(false);
    }
  }, [shouldPlay, src]);

  // Speed (and 2× while holding the edge).
  useEffect(() => {
    const v = video.current;
    if (v) v.playbackRate = holding === 'fast' ? 2 : prefs.speed;
    if (companion.current) companion.current.playbackRate = holding === 'fast' ? 2 : prefs.speed;
  }, [prefs.speed, holding, src]);

  // Subtitles: shown or hidden, in the viewer's language when there is one.
  useEffect(() => {
    const v = video.current;
    if (!v) return;
    const tracks = [...v.textTracks];
    const base = locale.split('-')[0];
    const pick = tracks.find((x) => x.language === base) ?? tracks[0];
    for (const tr of tracks) tr.mode = prefs.captions && tr === pick ? 'showing' : 'hidden';
  }, [prefs.captions, locale, src, captions.length]);

  // Leaving a reel: it starts playing again next time, from where it was; remember that position.
  const wasActive = useRef(active);
  const lastSent = useRef<number | null>(post.viewer.resumeMs ?? null);
  const sendResume = useCallback(() => {
    const v = video.current;
    if (!v || !v.duration || !Number.isFinite(v.duration)) return;
    const ms = Math.round(v.currentTime * 1000);
    if (lastSent.current !== null && Math.abs(lastSent.current - ms) < 1000) return;
    if (lastSent.current === null && ms < 3000) return;
    lastSent.current = ms;
    viewer.resume(post, ms, Math.round(v.duration * 1000));
  }, [post, viewer]);
  useEffect(() => {
    if (wasActive.current && !active) {
      sendResume();
      setUserPaused(false);
      setDetails(false);
      setHolding(null);
    }
    wasActive.current = active;
  }, [active, sendResume]);
  // While watching, every 10 seconds; and when the page is hidden or closed.
  useEffect(() => {
    if (!active || !playing) return;
    const id = setInterval(sendResume, 10_000);
    return () => clearInterval(id);
  }, [active, playing, sendResume]);
  const sendResumeRef = useRef(sendResume);
  sendResumeRef.current = sendResume;
  useEffect(() => {
    if (!active) return;
    const leave = () => sendResumeRef.current();
    window.addEventListener('pagehide', leave);
    return () => {
      window.removeEventListener('pagehide', leave);
      leave();
    };
  }, [active]);

  // Continue where I left off: the first time this reel plays here.
  const resumeApplied = useRef(false);
  const applyResume = () => {
    const v = video.current;
    const ms = post.viewer.resumeMs;
    if (resumeApplied.current || !v || !ms || !v.duration) return;
    resumeApplied.current = true;
    if (ms / 1000 < v.duration - 1) {
      v.currentTime = ms / 1000;
      setResumed(ms);
    }
  };
  useEffect(() => {
    if (resumed === null) return;
    const id = setTimeout(() => setResumed(null), 6000);
    return () => clearTimeout(id);
  }, [resumed]);

  // The UI fades to a faint strip while it plays untouched, and wakes on a tap, a hover, focus or a pause.
  const fadeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wake = useCallback(() => {
    setAwake(true);
    if (fadeTimer.current) clearTimeout(fadeTimer.current);
    fadeTimer.current = setTimeout(() => setAwake(false), FADE_MS);
  }, []);
  useEffect(() => {
    if (active) wake();
    return () => {
      if (fadeTimer.current) clearTimeout(fadeTimer.current);
    };
  }, [active, wake]);
  const faint = !awake && playing && !details && !scrubbing;

  // "Tap for sound" shows once: it goes after a few seconds on screen (or when sound goes on).
  const hintShown = showSoundHint && active && muted && playing && !clear;
  useEffect(() => {
    if (!hintShown) return;
    const id = setTimeout(() => viewer.soundHintSeen(), 8000);
    return () => clearTimeout(id);
  }, [hintShown, viewer]);

  const flash = (kind: 'play' | 'pause') => setIndicator({ kind, key: Date.now() });
  useEffect(() => {
    if (!indicator) return;
    const id = setTimeout(() => setIndicator(null), 700);
    return () => clearTimeout(id);
  }, [indicator]);

  const togglePlay = () => {
    if (covered) return;
    if (waiting) {
      setStarted(true);
      setUserPaused(false);
      return;
    }
    const pausing = playing && !userPaused;
    setUserPaused(pausing);
    if (!pausing && blocked) {
      // Autoplay was refused: this tap is the gesture that lets it play.
      void video.current?.play().then(
        () => {
          setPlaying(true);
          setBlocked(false);
        },
        () => {},
      );
    }
    flash(pausing ? 'pause' : 'play');
    viewer.announce(t(pausing ? 'reel.paused' : 'reel.playing'));
    if (pausing) sendResume();
    wake();
  };

  // ── Gestures on the video: tap, double tap, hold ─────────────────────
  const gesture = useRef<{ x: number; y: number; timer: ReturnType<typeof setTimeout> | null; held: boolean; id: number } | null>(null);
  const lastTap = useRef(0);
  const tapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (tapTimer.current) clearTimeout(tapTimer.current);
      if (gesture.current?.timer) clearTimeout(gesture.current.timer);
    },
    [],
  );

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || covered) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const rtl = getComputedStyle(e.currentTarget).direction === 'rtl';
    // On a touch screen, holding the far edge (the end side of the frame) plays at 2×.
    const edge = e.pointerType === 'touch' && (rtl ? e.clientX - rect.left < rect.width * 0.22 : rect.right - e.clientX < rect.width * 0.22);
    const g = { x: e.clientX, y: e.clientY, timer: null as ReturnType<typeof setTimeout> | null, held: false, id: e.pointerId };
    g.timer = setTimeout(() => {
      g.held = true;
      if (!playing || waiting) return;
      setHolding(edge ? 'fast' : 'pause');
      if (!edge) viewer.announce(t('reel.paused'));
    }, HOLD_MS);
    gesture.current = g;
  };
  const cancelHold = () => {
    const g = gesture.current;
    if (g?.timer) clearTimeout(g.timer);
    if (g?.held) setHolding(null);
    gesture.current = null;
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse') wake();
    const g = gesture.current;
    // Moving is scrolling to another reel, not a tap or a hold.
    if (g && Math.hypot(e.clientX - g.x, e.clientY - g.y) > 12) cancelHold();
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g) return;
    if (g.timer) clearTimeout(g.timer);
    gesture.current = null;
    if (g.held) {
      setHolding(null);
      return;
    }
    if (clear) {
      viewer.toggleClear();
      return;
    }
    const now = Date.now();
    if (now - lastTap.current < TAP_MS + 60) {
      // A double tap likes (never unlikes), with a burst where it was tapped.
      if (tapTimer.current) clearTimeout(tapTimer.current);
      lastTap.current = 0;
      const rect = e.currentTarget.getBoundingClientRect();
      if (!prefersReducedMotion()) setBursts((b) => [...b.slice(-2), { key: now, x: e.clientX - rect.left, y: e.clientY - rect.top }]);
      if (!post.viewer.liked) viewer.announce(t('reel.liked'));
      viewer.like(post, true);
      wake();
      return;
    }
    lastTap.current = now;
    tapTimer.current = setTimeout(togglePlay, TAP_MS);
  };

  // Moment comments: a bubble near the bottom as the video passes each one.
  const prevTime = useRef(0);
  const watched = useRef(false);
  const onTimeUpdate = (v: HTMLVideoElement) => {
    sync(v, companion.current, 'time');
    const cur = v.currentTime;
    const dur = Number.isFinite(v.duration) ? v.duration : 0;
    setTime({ current: cur, duration: dur });
    if (active && !clear && moments.length) {
      const prev = prevTime.current;
      const hit = moments.find((m) => m.atMs / 1000 > prev && m.atMs / 1000 <= cur && cur - prev < 1.5);
      if (hit) setPop(hit);
    }
    prevTime.current = cur;
  };
  useEffect(() => {
    if (!pop) return;
    const id = setTimeout(() => setPop(null), 3200);
    return () => clearTimeout(id);
  }, [pop]);

  const seek = (seconds: number) => {
    const v = video.current;
    if (!v) return;
    v.currentTime = seconds;
    prevTime.current = seconds;
    setTime((x) => ({ ...x, current: seconds }));
    wake();
  };

  const hold = useLongPress(viewer.saveTo ? () => viewer.saveTo!(post) : undefined);
  const canFollow = !mine && !!stats && !stats.following;
  const caption = post.body.trim();
  const detailsId = `reel-details-${post.id}`;

  if (post.locked) return <LockedReel post={post} index={index} active={active} />;

  return (
    <article
      className={[
        'reel',
        active && 'reel--active',
        faint && 'reel--faint',
        clear && 'reel--clear',
        details && 'reel--details',
        prefs.bigCaptions && 'reel--big',
      ]
        .filter(Boolean)
        .join(' ')}
      data-index={index}
      aria-label={t('m.reels.by', { name: post.author.displayName })}
      aria-roledescription={t('reel.single')}
      inert={!active || undefined}
      onPointerMove={(e) => {
        if (e.pointerType === 'mouse') wake();
      }}
      onFocus={wake}
    >
      <div className="reel__frame">
        <div className={`reel__stage${originalSrc ? ' reel__stage--duet' : ''} reel__stage--${fit}`}>
          {fit === 'contain' && (poster || media?.placeholder) ? (
            <img className="reel__backdrop" src={poster ?? media?.placeholder ?? undefined} alt="" aria-hidden />
          ) : null}
          {originalSrc ? (
            <video
              ref={companion}
              className="reel__video reel__video--original"
              src={active || near ? originalSrc : undefined}
              poster={original ? videoPoster(original, saver) : undefined}
              muted={muted}
              loop
              playsInline
              preload={saver ? 'none' : 'metadata'}
              aria-label={t('reel.duet.original', { name: post.remixOf?.post?.author.displayName ?? '' })}
            />
          ) : null}
          {borrowed ? <audio ref={companion} src={active || near ? borrowed : undefined} muted={muted} loop preload={saver ? 'none' : 'metadata'} /> : null}
          {src ? (
            <video
              ref={video}
              className={['reel__video', covered && 'yp-blurred', prefs.bigCaptions && 'reel__video--big-captions', fit === 'contain' && 'reel__video--contain']
                .filter(Boolean)
                .join(' ')}
              src={active || near || started ? src : undefined}
              poster={poster}
              muted={muted || !!borrowed || (!!song && !songWithVideo)}
              loop
              playsInline
              crossOrigin={videoCrossOrigin(captions)}
              preload={saver ? 'none' : active ? 'auto' : 'metadata'}
              aria-label={media?.altText || post.body || t('reel.videoBy', { name: post.author.displayName })}
              onLoadedMetadata={(e) => {
                const v = e.currentTarget;
                if (v.videoWidth && v.videoHeight) setNatural(v.videoWidth / v.videoHeight);
                setTime({ current: v.currentTime, duration: Number.isFinite(v.duration) ? v.duration : 0 });
                v.playbackRate = prefs.speed;
                applyResume();
              }}
              onPlay={(e) => {
                sync(e.currentTarget, companion.current, 'play');
                setPlaying(true);
              }}
              onPause={(e) => {
                sync(e.currentTarget, companion.current, 'pause');
                setPlaying(false);
              }}
              onSeeked={(e) => sync(e.currentTarget, companion.current, 'time')}
              onEnded={(e) => {
                // Reels repeat; some files and browsers still end, so start again from the top.
                const v = e.currentTarget;
                v.currentTime = 0;
                void v.play().catch(() => {});
              }}
              onTimeUpdate={(e) => {
                const v = e.currentTarget;
                onTimeUpdate(v);
                // Played for 2 seconds (or half of a shorter reel): counts as a view.
                if (!watched.current && v.duration && v.currentTime >= Math.min(2, v.duration / 2)) {
                  watched.current = true;
                  viewer.watched(post);
                }
              }}
            >
              <CaptionTracks captions={captions} />
            </video>
          ) : null}
        </div>

        {/* The gesture layer: taps, double taps and holds. Keyboard and screen readers use the buttons. */}
        <div
          className="reel__tap"
          aria-hidden
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={cancelHold}
          onContextMenu={(e) => {
            if (e.nativeEvent instanceof PointerEvent && e.nativeEvent.pointerType === 'touch') e.preventDefault();
          }}
        />
        {covered ? <SensitiveCover onReveal={() => setRevealed(true)} locale={locale} /> : null}

        {waiting || (blocked && !playing && !covered) ? (
          <button type="button" className="reel__start" onClick={togglePlay} aria-label={t('dataSaver.play')}>
            <Icon name="play" size={34} filled />
          </button>
        ) : null}
        {indicator ? (
          <span key={indicator.key} className="reel__sign" aria-hidden>
            <Icon name={indicator.kind} size={30} filled />
          </span>
        ) : userPaused && !covered ? (
          <span className="reel__sign reel__sign--still" aria-hidden>
            <Icon name="play" size={26} filled />
          </span>
        ) : null}
        {holding === 'fast' ? (
          <span className="reel__badge" aria-hidden>
            {t('reel.speed.hold')}
          </span>
        ) : null}
        {bursts.map((b) => (
          <span
            key={b.key}
            className="reel-burst"
            style={{ left: b.x, top: b.y }}
            aria-hidden
            onAnimationEnd={() => setBursts((all) => all.filter((x) => x.key !== b.key))}
          >
            <span className="reel-burst__a" />
            <span className="reel-burst__b" />
            <span className="reel-burst__c" />
            <span className="reel-burst__ring" />
          </span>
        ))}

        <div className="reel__top">
          <button type="button" className="reel__icon-btn" onClick={viewer.back} aria-label={t('m.common.back')}>
            <Icon name="arrow-left" size={22} />
          </button>
          <span className="reel__top-title" aria-hidden>
            {t('m.title.reels')}
          </span>
          <button type="button" className="reel__icon-btn" onClick={viewer.toggleMute} aria-pressed={!muted} aria-label={t('m.reels.sound')}>
            <Icon name={muted ? 'volume-off' : 'volume'} size={20} />
          </button>
          <button type="button" className="reel__icon-btn reel__clear-btn" onClick={viewer.toggleClear} aria-pressed={clear} aria-label={t('reel.clearView')}>
            <ClearViewIcon />
          </button>
        </div>
        {clear && active ? (
          <p className="reel__clear-hint" aria-hidden>
            {t('reel.clearView.hint')}
          </p>
        ) : null}

        {hintShown ? (
          <button type="button" className="reel__sound-hint" onClick={viewer.toggleMute}>
            <Icon name="volume-off" size={16} />
            {t('reel.tapForSound')}
          </button>
        ) : null}
        {resumed !== null && active && !clear ? (
          <div className="reel__resume" role="status">
            <span>{t('reel.resume.from', { time: formatReelTime(resumed) })}</span>
            <button
              type="button"
              onClick={() => {
                seek(0);
                setResumed(null);
                lastSent.current = null;
                viewer.clearResume(post);
              }}
            >
              {t('reel.resume.startOver')}
            </button>
          </div>
        ) : null}

        <div className="reel__info">
          <div className="reel__byline">
            <Link href={`/u/${post.author.username}`} className="reel__author">
              <bdi>{post.author.displayName}</bdi>
            </Link>
            {post.collaborators?.length ? (
              <span className="reel__with">
                +{post.collaborators.length}
                <span className="yp-visually-hidden">{post.collaborators.map((c) => c.displayName).join(', ')}</span>
              </span>
            ) : null}
            {canFollow ? (
              <button
                type="button"
                className="reel__follow"
                onClick={() => viewer.follow(post)}
                aria-label={t('reel.followName', { name: post.author.displayName })}
              >
                {t('reel.follow')}
              </button>
            ) : null}
          </div>
          <div className="reel__caption-row">
            {caption ? (
              <p className="reel__caption" dir="auto">
                <TaggedText text={caption} linkAs={NextLink} />
              </p>
            ) : (
              <span className="reel__caption reel__caption--empty" />
            )}
            <button
              type="button"
              className="reel__more-btn"
              aria-expanded={details}
              aria-controls={detailsId}
              aria-label={t('reel.moreLabel')}
              onClick={() => {
                setDetails(true);
                wake();
              }}
            >
              {t('reel.more')}
            </button>
          </div>
          {post.sound || post.music || post.remixOf || post.echoOf ? (
            <div className="reel__chips">
              {echoGone && mine ? (
                <button type="button" className="reel__chip" onClick={() => setDetails(true)} aria-controls={detailsId} aria-expanded={details}>
                  <Icon name="repost" size={13} />
                  <bdi>{t('echo.title')}</bdi>
                </button>
              ) : null}
              {post.echoOf?.post ? (
                <Link
                  href={`/reels?start=${post.echoOf.post.id}`}
                  className="reel__chip"
                  aria-label={t('echo.ofLabel', { name: post.echoOf.post.author.displayName })}
                >
                  <Icon name="repost" size={13} />
                  <bdi>{t('echo.of', { name: post.echoOf.post.author.username })}</bdi>
                </Link>
              ) : null}
              {post.remixOf?.post ? (
                <Link href={`/reels?start=${post.remixOf.post.id}`} className="reel__chip">
                  <Icon name="duet" size={13} />
                  <bdi>{t(post.remixOf.mode === 'duet' ? 'm.reels.duetWith' : 'm.reels.remixOf', { name: post.remixOf.post.author.username })}</bdi>
                </Link>
              ) : null}
              {post.sound ? (
                <Link href={`/sounds/${post.sound.id}`} className="reel__chip reel__chip--sound">
                  <Icon name="music" size={13} />
                  <bdi>{post.sound.title}</bdi>
                </Link>
              ) : null}
              {post.music ? (
                <Link href={musicHref(post.music)} className="reel__chip reel__chip--sound" aria-label={t('music.open', { title: post.music.title })}>
                  <Icon name="music" size={13} />
                  <bdi>
                    {post.music.title} · {post.music.artist}
                  </bdi>
                </Link>
              ) : null}
            </div>
          ) : null}
        </div>

        {details ? (
          <section className="reel__details" id={detailsId} aria-label={t('reel.details')}>
            <div className="reel__details-head">
              <Link href={`/u/${post.author.username}`} className="reel__details-who">
                <Avatar name={post.author.displayName} src={post.author.avatarUrl} size="sm" />
                <span>
                  <strong>
                    <bdi>{post.author.displayName}</bdi>
                  </strong>
                  <span className="reel__details-meta">
                    {[
                      `@${post.author.username}`,
                      post.counts.views ? tp('reel.views', post.counts.views, { count: compact.format(post.counts.views) }) : null,
                      stats ? tp('reel.followers', stats.followers, { count: compact.format(stats.followers) }) : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </span>
              </Link>
              <button
                type="button"
                className="reel__icon-btn reel__icon-btn--quiet"
                aria-label={t('reel.details.close')}
                onClick={() => {
                  setDetails(false);
                  wake();
                }}
              >
                <Icon name="x" size={20} />
              </button>
            </div>
            <div className="reel__details-body">
              {caption ? (
                <TranslatableText
                  kind="post"
                  id={post.id}
                  text={caption}
                  lang={post.lang}
                  own={mine}
                  locale={locale}
                  className="reel__details-caption"
                  render={(text) => <TaggedText text={text} linkAs={NextLink} />}
                />
              ) : null}
              {post.topics.length ? (
                <div className="reel__tags">
                  {post.topics.map((tag) => (
                    <Link key={tag} href={`/t/${encodeURIComponent(tag)}`}>
                      <bdi>#{tag}</bdi>
                    </Link>
                  ))}
                </div>
              ) : null}
              {post.remixOf && !post.remixOf.post ? <p className="reel__credit">{t('m.reels.remixUnavailable')}</p> : null}
              {echoGone && mine ? (
                <div className="reel__echo-gone" role="note">
                  <p>{t('echo.unavailable')}</p>
                  <div className="row">
                    {post.visibility !== 'private' ? (
                      <button type="button" className="yp-btn yp-btn--secondary yp-btn--sm" onClick={() => viewer.keepEchoPrivate(post)}>
                        {t('echo.keepPrivate')}
                      </button>
                    ) : null}
                    <button type="button" className="yp-btn yp-btn--danger yp-btn--sm" onClick={() => viewer.deleteEcho(post)}>
                      {t('echo.delete')}
                    </button>
                  </div>
                </div>
              ) : null}
              {post.echoOf?.theirAudio === 'dropped' ? <p className="reel__credit">{t('echo.audioDropped')}</p> : null}
              {echoes ? (
                <Link href={`/reels/${post.id}/echoes`} className="reel__soundlink">
                  <Icon name="repost" size={14} />
                  {tp('echo.count', echoes, { count: compact.format(echoes) })}
                </Link>
              ) : null}
              {post.sound ? (
                <Link href={`/sounds/${post.sound.id}`} className="reel__soundlink">
                  <Icon name="music" size={14} />
                  <bdi>{post.sound.title}</bdi>
                </Link>
              ) : null}
              {post.music ? (
                <>
                  <Link href={musicHref(post.music)} className="reel__soundlink">
                    <Icon name="music" size={14} />
                    <bdi>{post.music.title}</bdi> · <bdi>{post.music.artist}</bdi>
                  </Link>
                  <span className="reel__credit">
                    {post.music.unavailable ? t(`music.unavailable.${post.music.unavailable}` as MessageKey) : credit(post.music)}
                  </span>
                </>
              ) : null}
              {highlights.length ? (
                <div className="reel__marks">
                  <h2>{t('reel.highlights')}</h2>
                  <ul>
                    {highlights.map((h) => (
                      <li key={h.atMs}>
                        <button
                          type="button"
                          onClick={() => {
                            seek(h.atMs / 1000);
                            setUserPaused(false);
                          }}
                          aria-label={t('reel.highlights.jump', { label: h.label, time: formatReelTime(h.atMs) })}
                        >
                          <span className="reel__mark-time">{formatReelTime(h.atMs)}</span>
                          <bdi>{h.label}</bdi>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {moments.length ? (
                <button type="button" className="reel__moments-link" onClick={() => viewer.comments(post, null)}>
                  <Icon name="message" size={14} />
                  {tp('reel.moments', moments.length)}
                </button>
              ) : null}
            </div>
          </section>
        ) : null}

        {pop && !details ? (
          <button
            type="button"
            className="reel__pop"
            style={{ insetInlineStart: `clamp(12px, calc(${time.duration ? (pop.atMs / 1000 / time.duration) * 100 : 0}% - 60px), calc(100% - 232px))` }}
            onClick={() => viewer.comments(post, null)}
            tabIndex={-1}
            aria-hidden
          >
            <Avatar name={pop.author.displayName} src={pop.author.avatarUrl} size="sm" />
            <span>
              <bdi className="reel__pop-name">{pop.author.displayName}</bdi> <bdi dir="auto">{pop.body}</bdi>
            </span>
          </button>
        ) : null}

        <div className="reel__controls">
          <button type="button" className="reel__play" onClick={togglePlay} aria-label={playing && !userPaused ? t('m.common.pause') : t('m.common.play')}>
            <Icon name={playing && !userPaused ? 'pause' : 'play'} size={16} filled />
          </button>
          <Scrubber
            video={video}
            active={active}
            current={time.current}
            duration={time.duration}
            highlights={highlights}
            moments={moments}
            onSeek={seek}
            onScrubbing={setScrubbing}
          />
          <span className="reel__time" aria-hidden>
            {formatReelTime(time.current * 1000)} / {formatReelTime(time.duration * 1000)}
          </span>
        </div>
      </div>

      <div className="reel__rail">
        <div className="reel__who">
          <Link href={`/u/${post.author.username}`} className="reel__avatar" aria-label={t('reel.profile', { name: post.author.displayName })}>
            <Avatar name={post.author.displayName} src={post.author.avatarUrl} size="md" />
          </Link>
          {canFollow ? (
            <button
              type="button"
              className="reel__follow-badge"
              onClick={() => viewer.follow(post)}
              aria-label={t('reel.followName', { name: post.author.displayName })}
            >
              <Icon name="plus" size={14} />
            </button>
          ) : null}
        </div>
        <RailButton
          label={post.viewer.liked ? t('post.unlike') : t('post.like')}
          pressed={post.viewer.liked}
          count={post.counts.likes}
          fmt={compact}
          tone="like"
          onClick={() => viewer.like(post)}
        >
          <Icon name="heart" filled={post.viewer.liked} size={24} />
        </RailButton>
        <RailButton
          label={t('post.comments')}
          count={post.counts.comments}
          fmt={compact}
          onClick={() => viewer.comments(post, Math.round(time.current * 1000))}
        >
          <Icon name="message" size={24} />
        </RailButton>
        <RailButton label={t('m.common.share')} count={post.counts.reposts || undefined} fmt={compact} onClick={() => viewer.share(post)} haspopup>
          <Icon name="send" size={24} />
        </RailButton>
        <RailButton
          label={post.viewer.saved ? t('m.reels.unsave') : t('post.save')}
          pressed={post.viewer.saved}
          tone="save"
          onClick={() => viewer.save(post)}
          hold={hold}
        >
          <Icon name="bookmark" filled={post.viewer.saved} size={24} />
        </RailButton>
        <RailButton label={t('reel.options')} onClick={() => viewer.options(post)} haspopup>
          <Icon name="more" size={24} />
        </RailButton>
        <div className="reel__skip">
          <button type="button" className="reel__icon-btn" onClick={viewer.previous} aria-label={t('reel.previous')} disabled={index === 0}>
            <Icon name="chevron-down" size={20} className="reel__up" />
          </button>
          <button type="button" className="reel__icon-btn" onClick={viewer.next} aria-label={t('reel.next')}>
            <Icon name="chevron-down" size={20} />
          </button>
        </div>
      </div>
    </article>
  );
}

function RailButton({
  label,
  pressed,
  count,
  fmt,
  onClick,
  hold,
  tone,
  haspopup,
  children,
}: {
  label: string;
  pressed?: boolean;
  count?: number;
  fmt?: Intl.NumberFormat;
  onClick: () => void;
  /** A long press or right-click (the save button opens "Save to a board"). */
  hold?: ReturnType<typeof useLongPress>;
  tone?: 'like' | 'save';
  haspopup?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className={`reel__btn${tone ? ` reel__btn--${tone}` : ''}${hold?.handlers && 'onPointerDown' in hold.handlers ? ' yp-action--hold' : ''}`}
      {...(hold?.handlers ?? {})}
      onClick={() => {
        if (hold?.wasHeld()) return;
        onClick();
      }}
      aria-pressed={pressed}
      aria-haspopup={haspopup ? 'dialog' : undefined}
      aria-label={count ? `${label}, ${count}` : label}
    >
      <span className="reel__disc">{children}</span>
      <span className="reel__count" aria-hidden>
        {count ? fmt?.format(count) : ''}
      </span>
    </button>
  );
}

/** Clear view: an eye inside a frame (everything but the video steps aside). */
function ClearViewIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8" />
      <path d="M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8" />
      <path d="M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16" />
      <path d="M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16" />
      <path d="M7 12s1.8-3 5-3 5 3 5 3-1.8 3-5 3-5-3-5-3z" />
      <circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none" />
    </svg>
  );
}

function LockedReel({ post, index, active }: { post: Post; index: number; active: boolean }) {
  const { t } = useSession();
  const placeholder = post.locked?.placeholder;
  const bg = placeholder && /^data:image\/[a-z+]+;base64,[A-Za-z0-9+/=]+$/.test(placeholder) ? { backgroundImage: `url(${placeholder})` } : undefined;
  return (
    <article className="reel reel--locked" data-index={index} aria-label={t('m.reels.by', { name: post.author.displayName })} inert={!active || undefined}>
      <div className="reel__frame reel__locked" style={bg}>
        <div className="reel__locked-inner">
          <Icon name="lock" size={32} />
          <strong>{t('post.locked.title')}</strong>
          <span>{t('post.locked.body', { name: post.author.displayName })}</span>
          <Link href={`/u/${post.author.username}?subscribe=1`} className="yp-btn yp-btn--primary yp-btn--sm">
            {t('post.locked.cta')}
          </Link>
        </div>
      </div>
    </article>
  );
}
