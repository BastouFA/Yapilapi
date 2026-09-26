'use client';

import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { Badge, Button, EmptyState, List, ListItem, Select, TextField } from '@yapilapi/design-system';
import type { CaptionCue, CaptionTrack, MediaEdit, StudioVideo } from '@yapilapi/api-client';
import { formatRelativeTime } from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/app/providers';

const MIN_SEGMENT = 1;
const MAX_SEGMENT = 600;
const MAX_CLIPS = 20;
const MAX_VTT_BYTES = 512 * 1024;
const LANGS = ['en', 'fr', 'es', 'pt', 'pt-BR', 'de', 'it', 'nl', 'ar', 'sw', 'yo', 'ha', 'ig', 'wo', 'am', 'hi', 'zh', 'ja', 'ko', 'ru', 'tr'];

const EDIT_STATUS: Record<MediaEdit['status'], { label: string; tone: 'neutral' | 'warning' | 'success' | 'danger' }> = {
  queued: { label: 'Waiting', tone: 'neutral' },
  rendering: { label: 'Cutting', tone: 'warning' },
  processing: { label: 'Preparing for playback', tone: 'warning' },
  ready: { label: 'Ready', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
};

/** 83.4 → "1:23.4" */
export function formatSeconds(s: number): string {
  const m = Math.floor(s / 60);
  const rest = (s - m * 60).toFixed(1).padStart(4, '0');
  return `${m}:${rest}`;
}

const round = (n: number) => Math.round(n * 10) / 10;

/**
 * Creator Studio video editing: pick one of your videos, choose a part with the
 * start and end handles (or type the times), then trim it or cut clips. Each
 * trim or clip becomes a new video; the original is never changed.
 */
export function VideoEditor() {
  const { toast, locale } = useSession();
  const [videos, setVideos] = useState<StudioVideo[] | null>(null);
  const [selectedId, setSelectedId] = useState('');
  const [range, setRange] = useState<[number, number]>([0, 0]);
  const [pending, setPending] = useState<[number, number][]>([]);
  const [edits, setEdits] = useState<MediaEdit[]>([]);
  const [tracks, setTracks] = useState<CaptionTrack[]>([]);
  const [busy, setBusy] = useState(false);
  // Videos processed before durations were recorded: read the length from the player.
  const [metaDuration, setMetaDuration] = useState(0);
  const videoRef = useRef<HTMLVideoElement>(null);
  const stopAt = useRef<number | null>(null);

  const loadVideos = () =>
    api.studio.videos().then(
      (r) => {
        setVideos(r.items);
        setSelectedId((cur) => cur || r.items.find((v) => v.processed)?.id || '');
      },
      () => setVideos([]),
    );
  useEffect(() => {
    void loadVideos();
  }, []);

  const video = videos?.find((v) => v.id === selectedId) ?? null;
  const duration = video?.durationMs ? video.durationMs / 1000 : metaDuration;

  const loadEdits = (id: string) =>
    api.studio.edits(id).then(
      (r) => setEdits(r.items),
      () => setEdits([]),
    );
  useEffect(() => {
    setPending([]);
    setEdits([]);
    setTracks([]);
    setMetaDuration(0);
    if (!video?.processed) return;
    setRange([0, round(Math.min(duration, MAX_SEGMENT))]);
    void loadEdits(video.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [video?.id, video?.processed]);

  // Poll while any edit is still being made; refresh the video list when one finishes.
  const working = edits.some((e) => e.status !== 'ready' && e.status !== 'failed');
  // Read by the poller, which would otherwise see the edits from when it started.
  const readyCount = useRef(0);
  readyCount.current = edits.filter((e) => e.status === 'ready').length;
  useEffect(() => {
    if (!working || !video) return;
    const timer = setInterval(async () => {
      const r = await api.studio.edits(video.id).catch(() => null);
      if (!r) return;
      const ready = r.items.filter((e) => e.status === 'ready').length;
      const finished = ready > readyCount.current;
      setEdits(r.items);
      if (finished) void loadVideos();
    }, 3000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [working, video?.id]);

  if (!videos) return null;

  const [start, end] = range;
  const length = end - start;
  const rangeError =
    length < MIN_SEGMENT
      ? 'Choose at least 1 second.'
      : length > MAX_SEGMENT
        ? 'Choose 10 minutes or less.'
        : end > duration + 0.01
          ? 'The end is past the end of the video.'
          : null;

  const seek = (t: number) => {
    if (videoRef.current) videoRef.current.currentTime = t;
  };
  const setStart = (v: number) => {
    const s = round(Math.max(0, Math.min(v, end - MIN_SEGMENT)));
    setRange([s, end]);
    seek(s);
  };
  const setEnd = (v: number) => {
    const e = round(Math.min(duration, Math.max(v, start + MIN_SEGMENT)));
    setRange([start, e]);
    seek(e);
  };
  const now = () => round(videoRef.current?.currentTime ?? 0);

  const submit = async (kind: 'trim' | 'clip', segments: [number, number][]) => {
    if (!video) return;
    setBusy(true);
    try {
      await api.studio.createEdits(video.id, { kind, segments: segments.map(([s, e]) => ({ start: s, end: e })) });
      if (kind === 'clip') setPending([]);
      toast(kind === 'trim' ? 'Trimming. The new video will show up below.' : 'Making clips. They will show up below.');
      await loadEdits(video.id);
    } catch (err) {
      toast(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="stack-sm" aria-labelledby="edit-video-title">
      <h2 className="section-title" id="edit-video-title">
        Edit video
      </h2>
      {!videos.length ? (
        <EmptyState title="No videos yet" body="Upload a video from Create, then come back here to trim it, cut clips or add captions." />
      ) : (
        <div className="yp-card stack" style={{ padding: 16 }}>
          <Select label="Video" value={selectedId} onChange={(e) => setSelectedId(e.currentTarget.value)}>
            {videos.map((v) => (
              <option key={v.id} value={v.id} disabled={!v.processed}>
                {`${v.editOf ? 'Edited video' : 'Video'}${v.durationMs ? `, ${formatSeconds(v.durationMs / 1000)}` : ''} · ${formatRelativeTime(v.createdAt, locale)}${v.processed ? '' : ' (processing)'}`}
              </option>
            ))}
          </Select>

          {video && !video.processed ? <p className="muted">This video is still processing. You can edit it once it is ready.</p> : null}

          {video?.processed ? (
            <>
              <video
                key={video.id}
                ref={videoRef}
                src={video.variants.mp4 ?? video.url}
                poster={video.posterUrl ?? undefined}
                crossOrigin="anonymous"
                controls
                playsInline
                preload="metadata"
                aria-label="Video preview"
                style={{ width: '100%', maxHeight: 360, background: '#000', borderRadius: 8 }}
                onLoadedMetadata={(e) => {
                  const d = e.currentTarget.duration;
                  if (!video.durationMs && Number.isFinite(d) && d > 0) {
                    setMetaDuration(d);
                    setRange([0, round(Math.min(d, MAX_SEGMENT))]);
                  }
                }}
                onTimeUpdate={(e) => {
                  if (stopAt.current !== null && e.currentTarget.currentTime >= stopAt.current) {
                    e.currentTarget.pause();
                    stopAt.current = null;
                  }
                }}
              >
                {tracks
                  .filter((t) => t.status === 'ready' && t.url)
                  .map((t) => (
                    <track key={t.url} kind="subtitles" src={t.url!} srcLang={t.lang} label={t.label} />
                  ))}
              </video>

              <div className="stack-sm">
                <div
                  className="yp-scrubber"
                  style={{
                    ['--from' as string]: `${duration ? (start / duration) * 100 : 0}%`,
                    ['--to' as string]: `${duration ? (end / duration) * 100 : 0}%`,
                  }}
                >
                  <input
                    type="range"
                    aria-label="Start"
                    aria-valuetext={formatSeconds(start)}
                    min={0}
                    max={duration}
                    step={0.1}
                    value={start}
                    onChange={(e) => setStart(Number(e.currentTarget.value))}
                  />
                  <input
                    type="range"
                    aria-label="End"
                    aria-valuetext={formatSeconds(end)}
                    min={0}
                    max={duration}
                    step={0.1}
                    value={end}
                    onChange={(e) => setEnd(Number(e.currentTarget.value))}
                  />
                </div>
                <div className="row" style={{ alignItems: 'flex-end' }}>
                  <TextField
                    label="Start (seconds)"
                    type="number"
                    min={0}
                    max={duration}
                    step={0.1}
                    value={start}
                    onChange={(e) => setRange([round(Number(e.currentTarget.value) || 0), end])}
                    onBlur={() => setStart(start)}
                    style={{ width: 120 }}
                  />
                  <Button variant="secondary" size="sm" onClick={() => setStart(now())}>
                    Set start to now
                  </Button>
                  <TextField
                    label="End (seconds)"
                    type="number"
                    min={0}
                    max={duration}
                    step={0.1}
                    value={end}
                    onChange={(e) => setRange([start, round(Number(e.currentTarget.value) || 0)])}
                    onBlur={() => setEnd(end)}
                    style={{ width: 120 }}
                  />
                  <Button variant="secondary" size="sm" onClick={() => setEnd(now())}>
                    Set end to now
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      seek(start);
                      stopAt.current = end;
                      void videoRef.current?.play();
                    }}
                  >
                    Play selection
                  </Button>
                </div>
                <p className={rangeError ? 'yp-field__error' : 'muted'} style={{ margin: 0 }} role="status">
                  {rangeError ?? `Selected ${formatSeconds(start)} to ${formatSeconds(end)} (${length.toFixed(1)} seconds) of ${formatSeconds(duration)}.`}
                </p>
                <div className="row">
                  <Button onClick={() => submit('trim', [[start, end]])} disabled={!!rangeError} loading={busy}>
                    Trim
                  </Button>
                  <Button variant="secondary" onClick={() => setPending((p) => [...p, [start, end]])} disabled={!!rangeError || pending.length >= MAX_CLIPS}>
                    Add clip
                  </Button>
                  {pending.length ? (
                    <Button variant="secondary" onClick={() => submit('clip', pending)} loading={busy}>
                      {pending.length === 1 ? 'Make 1 clip' : `Make ${pending.length} clips`}
                    </Button>
                  ) : null}
                </div>
                <p className="muted" style={{ margin: 0, fontSize: 13 }}>
                  Trim and clips make new videos. Your original stays as it is.
                </p>
              </div>

              {pending.length ? (
                <List label="Clips to make">
                  {pending.map(([s, e], i) => (
                    <ListItem
                      key={`${s}-${e}-${i}`}
                      primary={`Clip ${i + 1}: ${formatSeconds(s)} to ${formatSeconds(e)}`}
                      end={
                        <Button variant="ghost" size="sm" onClick={() => setPending((p) => p.filter((_, j) => j !== i))}>
                          Remove
                        </Button>
                      }
                    />
                  ))}
                </List>
              ) : null}

              {edits.length ? (
                <div className="stack-sm">
                  <h3 style={{ margin: 0 }}>Trims and clips</h3>
                  <List label="Trims and clips">
                    {edits.map((e) => (
                      <ListItem
                        key={e.id}
                        primary={
                          <span className="row">
                            {e.kind === 'trim' ? 'Trim' : 'Clip'} {formatSeconds(e.start)} to {formatSeconds(e.end)}
                            <Badge tone={EDIT_STATUS[e.status].tone}>{EDIT_STATUS[e.status].label}</Badge>
                          </span>
                        }
                        secondary={e.error ?? formatRelativeTime(e.createdAt, locale)}
                        end={
                          e.status === 'ready' && e.result ? (
                            <Button variant="ghost" size="sm" onClick={() => setSelectedId(e.result!.id)}>
                              Open
                            </Button>
                          ) : undefined
                        }
                      />
                    ))}
                  </List>
                </div>
              ) : null}

              <CaptionsEditor mediaId={video.id} duration={duration} videoRef={videoRef} onTracks={setTracks} />
            </>
          ) : null}
        </div>
      )}
    </section>
  );
}

interface CueRow extends CaptionCue {
  key: number;
}

/** Captions for one video: write cues, upload a .vtt file, or (when set up) create them automatically. */
function CaptionsEditor({
  mediaId,
  duration,
  videoRef,
  onTracks,
}: {
  mediaId: string;
  duration: number;
  videoRef: RefObject<HTMLVideoElement | null>;
  onTracks: (t: CaptionTrack[]) => void;
}) {
  const { toast, locale } = useSession();
  const [tracks, setTracks] = useState<CaptionTrack[]>([]);
  const [autoCaptions, setAutoCaptions] = useState(false);
  const [lang, setLang] = useState('en');
  const [label, setLabel] = useState('');
  const [cues, setCues] = useState<CueRow[]>([]);
  const [saving, setSaving] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const nextKey = useRef(0);

  const names = useMemo(() => {
    try {
      const dn = new Intl.DisplayNames([locale], { type: 'language' });
      return (code: string) => dn.of(code) ?? code;
    } catch {
      return (code: string) => code;
    }
  }, [locale]);

  const loadTracks = async () => {
    const r = await api.studio.captions(mediaId).catch(() => null);
    if (!r) return [];
    setTracks(r.items);
    setAutoCaptions(!!r.autoCaptions);
    onTracks(r.items);
    return r.items;
  };

  // Only the latest request may fill the editor (switching language quickly must not load one language into another).
  const cueRequest = useRef(0);
  // Unsaved edits in the editor; background refreshes never replace them.
  const dirty = useRef(false);
  const loadCues = async (code: string, list: CaptionTrack[]) => {
    const req = ++cueRequest.current;
    const track = list.find((t) => t.lang === code);
    setLabel(track?.label ?? names(code));
    dirty.current = false;
    if (!track || track.status !== 'ready') return setCues([]);
    const r = await api.studio.captionCues(mediaId, code).catch(() => null);
    if (req !== cueRequest.current) return;
    setCues((r?.cues ?? []).map((c) => ({ ...c, key: nextKey.current++ })));
  };

  useEffect(() => {
    void loadTracks().then((list) => {
      const first = list[0]?.lang ?? 'en';
      setLang(first);
      void loadCues(first, list);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mediaId]);

  // Automatic captions take a while; check back until they finish.
  const making = tracks.some((t) => t.status === 'processing');
  const tracksRef = useRef(tracks);
  tracksRef.current = tracks;
  useEffect(() => {
    if (!making) return;
    const timer = setInterval(async () => {
      const before = tracksRef.current.find((t) => t.lang === lang)?.status;
      const list = await loadTracks();
      // Refresh the editor only when the language being edited just finished, and nothing unsaved would be lost.
      const now = list.find((t) => t.lang === lang)?.status;
      if (before === 'processing' && now === 'ready' && !dirty.current) void loadCues(lang, list);
    }, 4000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [making, lang]);

  const current = tracks.find((t) => t.lang === lang);
  const options = Array.from(new Set([...LANGS, ...tracks.map((t) => t.lang)]));

  const update = (key: number, patch: Partial<CaptionCue>) => {
    dirty.current = true;
    setCues((cs) => cs.map((c) => (c.key === key ? { ...c, ...patch } : c)));
  };
  const addCue = () => {
    dirty.current = true;
    const at = round(videoRef.current?.currentTime ?? cues.at(-1)?.end ?? 0);
    const s = Math.min(at, Math.max(0, duration - 0.5));
    setCues((cs) => [...cs, { key: nextKey.current++, start: s, end: round(Math.min(duration, s + 2)), text: '' }].sort((a, b) => a.start - b.start));
  };

  const act = async (fn: () => Promise<unknown>, done: string) => {
    setSaving(true);
    try {
      await fn();
      toast(done);
      const list = await loadTracks();
      await loadCues(lang, list);
    } catch (err) {
      toast(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="stack-sm">
      <h3 style={{ margin: 0 }}>Captions</h3>
      {tracks.length ? (
        <p className="muted" style={{ margin: 0 }}>
          {tracks
            .map(
              (t) =>
                `${t.label} (${t.status === 'ready' ? `${t.cueCount} caption${t.cueCount === 1 ? '' : 's'}` : t.status === 'processing' ? 'being made' : 'failed'})`,
            )
            .join(' · ')}
        </p>
      ) : (
        <p className="muted" style={{ margin: 0 }}>
          No captions yet. Captions show as subtitles wherever this video plays.
        </p>
      )}
      <div className="row" style={{ alignItems: 'flex-end' }}>
        <Select
          label="Language"
          value={lang}
          onChange={(e) => {
            const code = e.currentTarget.value;
            setLang(code);
            void loadCues(code, tracks);
          }}
        >
          {options.map((code) => (
            <option key={code} value={code}>
              {`${names(code)}${tracks.some((t) => t.lang === code) ? ' (has captions)' : ''}`}
            </option>
          ))}
        </Select>
        <TextField label="Label shown to viewers" value={label} maxLength={60} onChange={(e) => ((dirty.current = true), setLabel(e.currentTarget.value))} />
      </div>
      {current?.status === 'failed' && current.error ? <p className="yp-field__error">{current.error}</p> : null}
      {current?.status === 'processing' ? <p className="muted">Making captions automatically. This can take a few minutes.</p> : null}

      <ol className="stack-sm" style={{ listStyle: 'none', padding: 0, margin: 0 }} aria-label="Captions">
        {cues.map((c, i) => (
          <li key={c.key} className="row" style={{ alignItems: 'flex-end' }}>
            <TextField
              label="Start"
              type="number"
              min={0}
              max={duration}
              step={0.1}
              value={c.start}
              onChange={(e) => update(c.key, { start: Number(e.currentTarget.value) })}
              aria-label={`Caption ${i + 1} start in seconds`}
              style={{ width: 90 }}
            />
            <TextField
              label="End"
              type="number"
              min={0}
              max={duration}
              step={0.1}
              value={c.end}
              onChange={(e) => update(c.key, { end: Number(e.currentTarget.value) })}
              aria-label={`Caption ${i + 1} end in seconds`}
              style={{ width: 90 }}
              error={c.end <= c.start ? 'Ends before it starts' : undefined}
            />
            <TextField
              label="Text"
              value={c.text}
              maxLength={1000}
              onChange={(e) => update(c.key, { text: e.currentTarget.value })}
              aria-label={`Caption ${i + 1} text`}
              style={{ minWidth: 240 }}
            />
            <Button
              variant="ghost"
              size="sm"
              onClick={() => ((dirty.current = true), setCues((cs) => cs.filter((x) => x.key !== c.key)))}
              aria-label={`Remove caption ${i + 1}`}
            >
              Remove
            </Button>
          </li>
        ))}
      </ol>

      <div className="row">
        <Button variant="secondary" onClick={addCue}>
          Add caption
        </Button>
        <Button
          loading={saving}
          disabled={!label.trim() || cues.some((c) => !c.text.trim() || c.end <= c.start)}
          onClick={() =>
            act(
              () =>
                api.studio.saveCaptions(mediaId, lang, {
                  label: label.trim(),
                  cues: cues.map(({ start, end, text }) => ({ start, end, text })),
                }),
              'Captions saved.',
            )
          }
        >
          Save captions
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept=".vtt,text/vtt"
          hidden
          onChange={(e) => {
            const file = e.currentTarget.files?.[0];
            e.currentTarget.value = '';
            if (!file) return;
            if (file.size > MAX_VTT_BYTES) return toast('Caption files can be up to 512 KB.');
            void act(() => api.studio.uploadCaptions(mediaId, lang, file, label.trim() || names(lang)), 'Captions uploaded.');
          }}
        />
        <Button variant="secondary" onClick={() => fileRef.current?.click()} disabled={saving}>
          Upload .vtt file
        </Button>
        {current ? (
          <Button variant="danger" onClick={() => act(() => api.studio.deleteCaptions(mediaId, lang), 'Captions deleted.')} disabled={saving}>
            Delete captions
          </Button>
        ) : null}
        {autoCaptions && (!current || current.status === 'failed') ? (
          <Button
            variant="ghost"
            onClick={() =>
              act(() => api.studio.transcribe(mediaId, { lang, label: label.trim() || names(lang) }), 'Making captions. Check back in a few minutes.')
            }
            disabled={saving}
          >
            Make captions automatically
          </Button>
        ) : null}
      </div>
      {!autoCaptions ? (
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>
          Automatic captions are not set up on this server. Write them here or upload a .vtt file.
        </p>
      ) : null}
    </div>
  );
}
