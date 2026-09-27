'use client';

import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import { formatReelTime, type ReelHighlight, type ReelMoment } from '@yapilapi/shared';
import { useSession } from '@/app/providers';

/**
 * The reel's progress, always visible at the bottom of the frame: drag (or click) to scrub, with
 * the time in a tooltip; arrow keys, Page up/down, Home and End as a slider. The creator's
 * highlights are ticks on it and moment comments small bubbles. The fill follows the video every
 * frame while it plays, without re-rendering the reel.
 */
export function Scrubber({
  video,
  active,
  current,
  duration,
  highlights,
  moments,
  onSeek,
  onScrubbing,
}: {
  video: RefObject<HTMLVideoElement | null>;
  /** Only the reel on screen follows its video frame by frame. */
  active: boolean;
  /** Seconds, for the slider's value (updated a few times a second). */
  current: number;
  duration: number;
  highlights: ReelHighlight[];
  moments: ReelMoment[];
  onSeek: (seconds: number) => void;
  /** Dragging started or ended: the reel holds its UI awake and pauses the fill meanwhile. */
  onScrubbing?: (on: boolean) => void;
}) {
  const { t } = useSession();
  const root = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const dragging = useRef(false);

  // The fill and thumb follow the video frame by frame (a CSS variable, no React state).
  useEffect(() => {
    const v = video.current;
    if (!active) {
      if (v?.duration) root.current?.style.setProperty('--p', String(Math.min(1, v.currentTime / v.duration)));
      return;
    }
    let raf = 0;
    const tick = () => {
      const v = video.current;
      const el = root.current;
      if (v && el && !dragging.current && v.duration) el.style.setProperty('--p', String(Math.min(1, v.currentTime / v.duration)));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [video, active]);

  const fractionAt = (clientX: number) => {
    const el = root.current;
    if (!el) return 0;
    const r = el.getBoundingClientRect();
    const rtl = getComputedStyle(el).direction === 'rtl';
    const f = (clientX - r.left) / r.width;
    return Math.max(0, Math.min(1, rtl ? 1 - f : f));
  };

  const setFill = (f: number) => root.current?.style.setProperty('--p', String(f));

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !duration) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragging.current = true;
    onScrubbing?.(true);
    const f = fractionAt(e.clientX);
    setDrag(f);
    setFill(f);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!duration) return;
    const f = fractionAt(e.clientX);
    if (dragging.current) {
      setDrag(f);
      setFill(f);
    } else if (e.pointerType === 'mouse') setHover(f);
  };
  const end = (e: ReactPointerEvent<HTMLDivElement>, commit: boolean) => {
    if (!dragging.current) return;
    dragging.current = false;
    const f = fractionAt(e.clientX);
    setDrag(null);
    onScrubbing?.(false);
    if (commit) onSeek(f * duration);
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!duration) return;
    const rtl = root.current ? getComputedStyle(root.current).direction === 'rtl' : false;
    const step = e.shiftKey ? 5 : 1;
    const moves: Record<string, number> = {
      ArrowRight: rtl ? -step : step,
      ArrowLeft: rtl ? step : -step,
      ArrowUp: step,
      ArrowDown: -step,
      PageUp: 5,
      PageDown: -5,
    };
    let to: number | null = null;
    if (e.key in moves) to = current + moves[e.key]!;
    else if (e.key === 'Home') to = 0;
    else if (e.key === 'End') to = Math.max(0, duration - 0.25);
    if (to === null) return;
    e.preventDefault();
    // The viewer's own keys (up and down move between reels) don't also act.
    e.stopPropagation();
    onSeek(Math.max(0, Math.min(duration - 0.05, to)));
  };

  const shown = drag ?? hover;
  const at = (ms: number) => (duration ? `${Math.min(100, (ms / 1000 / duration) * 100)}%` : '0%');
  const nearTick = shown !== null && duration ? highlights.find((h) => Math.abs(h.atMs / 1000 - shown * duration) < Math.max(0.6, duration * 0.02)) : undefined;

  return (
    <div
      ref={root}
      className={`reel-scrub${drag !== null ? ' reel-scrub--drag' : ''}`}
      role="slider"
      tabIndex={0}
      aria-label={t('reel.seek')}
      aria-valuemin={0}
      aria-valuemax={Math.max(0, Math.round(duration))}
      aria-valuenow={Math.round(current)}
      aria-valuetext={t('reel.seek.value', { current: formatReelTime(current * 1000), total: formatReelTime(duration * 1000) })}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(e) => end(e, true)}
      onPointerCancel={(e) => end(e, false)}
      onPointerLeave={() => setHover(null)}
      onKeyDown={onKeyDown}
      onClick={(e) => e.stopPropagation()}
    >
      <span className="reel-scrub__track" aria-hidden>
        <span className="reel-scrub__fill" />
      </span>
      {highlights.map((h) => (
        <span key={`h${h.atMs}`} className="reel-scrub__tick" style={{ insetInlineStart: at(h.atMs) }} aria-hidden />
      ))}
      {moments.map((m) => (
        <span key={m.id} className="reel-scrub__bubble" style={{ insetInlineStart: at(m.atMs) }} aria-hidden />
      ))}
      <span className="reel-scrub__thumb" aria-hidden />
      {shown !== null && duration ? (
        <span className="reel-scrub__tip" style={{ insetInlineStart: `${shown * 100}%` }} aria-hidden>
          {nearTick ? <bdi className="reel-scrub__tip-label">{nearTick.label}</bdi> : null}
          {formatReelTime(shown * duration * 1000)}
        </span>
      ) : null}
    </div>
  );
}
