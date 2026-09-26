'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Button, Switch, Tabs } from '@yapilapi/design-system';
import {
  ADJUSTMENT_KEYS,
  effectiveAdjustments,
  NEUTRAL_ADJUSTMENTS,
  sharpenAmount,
  type Adjustments,
  type EditorParamsInput,
  type FilterId,
  type TextOverlay,
} from '@yapilapi/shared';
import {
  AdjustPanel,
  clock,
  EditorShell,
  FilterStrip,
  previewFilter,
  SharpenFilterDef,
  TextOnStage,
  TextPanel,
  useFit,
  useHistory,
  VignetteOverlay,
} from './parts';

interface VideoState {
  /** Seconds on the original's timeline. */
  start: number;
  end: number;
  filter: FilterId;
  adjustments: Adjustments;
  muted: boolean;
  /** The cover frame, in seconds on the original's timeline; null for the default. */
  cover: number | null;
  text: TextOverlay | null;
}

const MIN_LENGTH = 1;
const THUMBS = 10;
const round = (n: number) => Math.round(n * 10) / 10;

/** Frames across the video for the trim strip (and the filter thumbnails), drawn from a second, hidden player. */
async function stripFrames(url: string, duration: number, count: number, signal: { cancelled: boolean }): Promise<string[]> {
  const v = document.createElement('video');
  v.muted = true;
  v.preload = 'auto';
  v.playsInline = true;
  v.src = url;
  await new Promise<void>((resolve, reject) => {
    v.onloadeddata = () => resolve();
    v.onerror = () => reject(new Error('load'));
  });
  const h = 96;
  const w = Math.max(1, Math.round((v.videoWidth / Math.max(1, v.videoHeight)) * h));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    if (signal.cancelled) break;
    const t = Math.min(duration - 0.05, (duration * (i + 0.5)) / count);
    await new Promise<void>((resolve) => {
      v.onseeked = () => resolve();
      v.currentTime = Math.max(0, t);
    });
    ctx.drawImage(v, 0, 0, w, h);
    out.push(c.toDataURL('image/jpeg', 0.7));
  }
  v.removeAttribute('src');
  v.load();
  return out;
}

/**
 * Video editor: trim with start and end handles over a strip of frames, a look and adjustments
 * previewed live on the player, text, a cover frame and muting. The video is uploaded as it is;
 * `onDone` gets the edits for POST /v1/media/:id/edit (or null when nothing changed).
 */
export function VideoEditor({
  file,
  maxSeconds,
  mustFit = false,
  title = 'Edit video',
  onDone,
  onCancel,
}: {
  file: File;
  /** The longest an edited video can be (the reel limit). */
  maxSeconds: number;
  /** A reel: longer videos must be trimmed. Otherwise a longer video can still be posted whole, without edits. */
  mustFit?: boolean;
  title?: string;
  onDone: (edits: EditorParamsInput | null) => void;
  onCancel: () => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [duration, setDuration] = useState(0);
  const [size, setSize] = useState({ w: 16, h: 9 });
  const [frames, setFrames] = useState<string[]>([]);
  const [failed, setFailed] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [now, setNow] = useState(0);
  const [tab, setTab] = useState('trim');
  const h = useHistory<VideoState>({ start: 0, end: 0, filter: 'original', adjustments: NEUTRAL_ADJUSTMENTS, muted: false, cover: null, text: null });
  const s = h.value;
  const videoRef = useRef<HTMLVideoElement>(null);
  const sharpenId = `yp-sharpen-${useId().replace(/:/g, '')}`;
  const fit = useFit(size.w, size.h);

  useEffect(() => {
    const u = URL.createObjectURL(file);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);

  // React doesn't keep the muted property in step on its own.
  useEffect(() => {
    if (videoRef.current) videoRef.current.muted = s.muted;
  }, [s.muted]);

  useEffect(() => {
    if (!url || !duration) return;
    const signal = { cancelled: false };
    stripFrames(url, duration, THUMBS, signal).then(
      (f) => !signal.cancelled && setFrames(f),
      () => undefined,
    );
    return () => {
      signal.cancelled = true;
    };
  }, [url, duration]);

  const tooLong = duration > maxSeconds + 0.05;
  const length = s.end - s.start;
  const seek = (t: number) => {
    if (videoRef.current) videoRef.current.currentTime = t;
  };
  const setStart = (v: number) => {
    const start = round(Math.max(0, Math.min(v, s.end - MIN_LENGTH, duration - MIN_LENGTH)));
    // Keep within the length limit by pulling the end along.
    const end = Math.min(s.end, start + maxSeconds);
    h.set((cur) => ({ ...cur, start, end, cover: cur.cover === null ? null : Math.min(Math.max(cur.cover, start), end) }), 'trim-start');
    seek(start);
  };
  const setEnd = (v: number) => {
    const end = round(Math.min(duration, Math.max(v, s.start + MIN_LENGTH)));
    const start = Math.max(s.start, end - maxSeconds);
    h.set((cur) => ({ ...cur, start, end, cover: cur.cover === null ? null : Math.min(Math.max(cur.cover, start), end) }), 'trim-end');
    seek(end);
  };

  function done() {
    if (!duration || (!h.changed && !(mustFit && tooLong))) return onDone(null);
    const full = s.start <= 0.05 && s.end >= duration - 0.05;
    const adjustments = Object.fromEntries(ADJUSTMENT_KEYS.filter((k) => s.adjustments[k]).map((k) => [k, s.adjustments[k]]));
    const text = s.text?.value.trim() ? { ...s.text, value: s.text.value.trim() } : undefined;
    const unchanged = full && s.filter === 'original' && !Object.keys(adjustments).length && !s.muted && s.cover === null && !text;
    if (unchanged) return onDone(null);
    onDone({
      filter: s.filter,
      adjustments,
      trim: full ? undefined : { startMs: Math.round(s.start * 1000), endMs: Math.round(s.end * 1000) },
      muted: s.muted || undefined,
      coverMs: s.cover === null ? undefined : Math.round(s.cover * 1000),
      text,
    });
  }

  const pct = (t: number) => (duration ? `${(t / duration) * 100}%` : '0%');
  const filterCss = previewFilter(s.filter, s.adjustments, sharpenId);

  const tools = (
    <Tabs
      value={tab}
      onChange={(t) => {
        setTab(t);
        if (t === 'cover' && s.cover !== null) {
          videoRef.current?.pause();
          seek(s.cover);
        }
      }}
      tabs={[
        {
          id: 'trim',
          label: 'Trim',
          content: (
            <div className="stack-sm">
              <div className="ed__strip" style={{ ['--from' as string]: pct(s.start), ['--to' as string]: pct(s.end) }}>
                <div className="ed__strip-frames" aria-hidden>
                  {frames.map((f, i) => (
                    <img key={i} src={f} alt="" />
                  ))}
                </div>
                <div className="yp-scrubber ed__scrubber">
                  <input
                    type="range"
                    aria-label="Start"
                    aria-valuetext={clock(s.start)}
                    min={0}
                    max={duration}
                    step={0.1}
                    value={s.start}
                    onChange={(e) => setStart(Number(e.currentTarget.value))}
                  />
                  <input
                    type="range"
                    aria-label="End"
                    aria-valuetext={clock(s.end)}
                    min={0}
                    max={duration}
                    step={0.1}
                    value={s.end}
                    onChange={(e) => setEnd(Number(e.currentTarget.value))}
                  />
                </div>
              </div>
              <div className="row">
                <Button variant="secondary" size="sm" onClick={() => setStart(videoRef.current?.currentTime ?? 0)}>
                  Start here
                </Button>
                <Button variant="secondary" size="sm" onClick={() => setEnd(videoRef.current?.currentTime ?? duration)}>
                  End here
                </Button>
              </div>
              <p className="muted ed__hint" role="status">
                {`Keeping ${clock(s.start)} to ${clock(s.end)}, ${length.toFixed(1)} seconds of ${clock(duration)}.`}
                {tooLong
                  ? mustFit
                    ? ` Reels can be up to ${Math.round(maxSeconds / 60)} minutes, so choose the part to keep.`
                    : ` Edited videos can be up to ${Math.round(maxSeconds / 60)} minutes. Without edits, the whole video is posted.`
                  : ''}
              </p>
            </div>
          ),
        },
        {
          id: 'filters',
          label: 'Filters',
          content: <FilterStrip thumb={frames[0] ?? null} value={s.filter} onChange={(filter) => h.set((cur) => ({ ...cur, filter }))} />,
        },
        {
          id: 'adjust',
          label: 'Adjust',
          content: (
            <AdjustPanel value={s.adjustments} onChange={(k, v) => h.set((cur) => ({ ...cur, adjustments: { ...cur.adjustments, [k]: v } }), `adj-${k}`)} />
          ),
        },
        { id: 'text', label: 'Text', content: <TextPanel text={s.text} onChange={(text, group) => h.set((cur) => ({ ...cur, text }), group ?? null)} /> },
        {
          id: 'cover',
          label: 'Cover',
          content: (
            <div className="stack-sm">
              <div className="ed__slider">
                <label htmlFor={`${sharpenId}-cover`}>Cover frame</label>
                <input
                  id={`${sharpenId}-cover`}
                  type="range"
                  min={s.start}
                  max={s.end}
                  step={0.1}
                  value={s.cover ?? s.start}
                  aria-valuetext={clock(s.cover ?? s.start)}
                  onChange={(e) => {
                    const t = Number(e.currentTarget.value);
                    videoRef.current?.pause();
                    seek(t);
                    h.set((cur) => ({ ...cur, cover: t }), 'cover');
                  }}
                />
                <output className="ed__value">{clock(s.cover ?? s.start)}</output>
              </div>
              <div className="row">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    const t = round(Math.min(s.end, Math.max(s.start, videoRef.current?.currentTime ?? s.start)));
                    h.set((cur) => ({ ...cur, cover: t }));
                  }}
                >
                  Use this frame
                </Button>
                {s.cover !== null ? (
                  <Button variant="ghost" size="sm" onClick={() => h.set((cur) => ({ ...cur, cover: null }))}>
                    Use the default
                  </Button>
                ) : null}
              </div>
              <p className="muted ed__hint">The cover shows before your video plays. It gets the same look and text.</p>
            </div>
          ),
        },
        {
          id: 'sound',
          label: 'Sound',
          content: (
            <div className="stack-sm">
              <Switch label="Mute the original sound" checked={s.muted} onChange={(muted) => h.set((cur) => ({ ...cur, muted }))} />
              <p className="muted ed__hint">Your video is posted without its sound.</p>
            </div>
          ),
        },
      ]}
    />
  );

  return (
    <EditorShell
      title={title}
      onCancel={onCancel}
      onDone={done}
      doneLabel={h.changed || (mustFit && tooLong) ? 'Done' : 'Use video'}
      canUndo={h.canUndo}
      onUndo={h.undo}
      onReset={h.reset}
      tools={tools}
      stage={
        failed ? (
          <p className="ed__notice">This video can&apos;t be played here. Cancel to use it as it is.</p>
        ) : (
          <div className="ed__video">
            <SharpenFilterDef id={sharpenId} amount={sharpenAmount(effectiveAdjustments(s.filter, s.adjustments))} />
            <div ref={fit.ref} className="ed__fit">
              <div className="ed__frame" style={{ width: fit.width, height: fit.height }}>
                {url ? (
                  <video
                    ref={videoRef}
                    src={url}
                    playsInline
                    preload="auto"
                    muted={s.muted}
                    aria-label="Preview of your edited video"
                    style={{ width: '100%', height: '100%', filter: filterCss }}
                    onLoadedMetadata={(e) => {
                      const v = e.currentTarget;
                      const d = Number.isFinite(v.duration) ? v.duration : 0;
                      setDuration(d);
                      setSize({ w: v.videoWidth || 16, h: v.videoHeight || 9 });
                      // The first state is the untouched video (cut to the limit when it is longer).
                      h.replace({ ...h.value, start: 0, end: round(Math.min(d, maxSeconds)) });
                    }}
                    onError={() => setFailed(true)}
                    onPlay={() => setPlaying(true)}
                    onPause={() => setPlaying(false)}
                    onTimeUpdate={(e) => {
                      const v = e.currentTarget;
                      setNow(v.currentTime);
                      // Play only the part being kept, round and round.
                      if (!v.paused && (v.currentTime >= s.end || v.currentTime < s.start - 0.25)) v.currentTime = s.start;
                    }}
                  />
                ) : null}
                <VignetteOverlay filter={s.filter} adjustments={s.adjustments} />
                {s.text?.value.trim() ? (
                  <TextOnStage
                    text={s.text}
                    width={fit.width}
                    onMove={(x, y) => h.set((cur) => (cur.text ? { ...cur, text: { ...cur.text, x, y } } : cur), 'text-move')}
                  />
                ) : null}
              </div>
            </div>
            <div className="row ed__transport">
              <Button
                variant="secondary"
                size="sm"
                icon={playing ? 'pause' : 'play'}
                onClick={() => {
                  const v = videoRef.current;
                  if (!v) return;
                  if (v.paused) {
                    if (v.currentTime < s.start || v.currentTime >= s.end) v.currentTime = s.start;
                    void v.play();
                  } else v.pause();
                }}
              >
                {playing ? 'Pause' : 'Play'}
              </Button>
              <span className="muted" aria-live="off">
                {clock(now)} / {clock(duration)}
              </span>
            </div>
          </div>
        )
      }
    />
  );
}
