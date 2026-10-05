'use client';

import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { Badge, Button, EmptyState, List, ListItem, Select, TextField } from '@yapilapi/design-system';
import type { CaptionCue, CaptionTrack, MediaEdit, StudioVideo } from '@yapilapi/api-client';
import { captionErrorText, formatRelativeTime, mediaEditErrorText, type MessageKey } from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/app/providers';

const MIN_SEGMENT = 1;
const MAX_SEGMENT = 600;
const MAX_CLIPS = 20;
const MAX_VTT_BYTES = 512 * 1024;
const LANGS = ['en', 'fr', 'es', 'pt', 'pt-BR', 'de', 'it', 'nl', 'ar', 'sw', 'yo', 'ha', 'ig', 'wo', 'am', 'hi', 'zh', 'ja', 'ko', 'ru', 'tr'];

const EDIT_STATUS: Record<MediaEdit['status'], { label: MessageKey; tone: 'neutral' | 'warning' | 'success' | 'danger' }> = {
  queued: { label: 'recaps.status.queued', tone: 'neutral' },
  rendering: { label: 'videoEditor.status.rendering' as MessageKey, tone: 'warning' },
  processing: { label: 'videoEditor.status.processing' as MessageKey, tone: 'warning' },
  ready: { label: 'm.recap.status.ready', tone: 'success' },
  failed: { label: 'videoEditor.status.failed' as MessageKey, tone: 'danger' },
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
  const { toast, locale, t, tp } = useSession();
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
      ? t('videoEditor.range.tooShort')
      : length > MAX_SEGMENT
        ? t('videoEditor.range.tooLong')
        : end > duration + 0.01
          ? t('videoEditor.range.pastEnd')
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
  // A start typed past the end moves the end along (and an end typed before the start moves the
  // start back), so typing the start and then the end gives the part that was typed.
  const typedStart = () => {
    const s = round(Math.max(0, Math.min(start, duration - MIN_SEGMENT)));
    const e = end - s < MIN_SEGMENT ? round(Math.min(duration, s + MIN_SEGMENT)) : end;
    setRange([s, e]);
    seek(s);
  };
  const typedEnd = () => {
    const e = round(Math.min(duration, Math.max(end, MIN_SEGMENT)));
    const s = e - start < MIN_SEGMENT ? round(Math.max(0, e - MIN_SEGMENT)) : start;
    setRange([s, e]);
    seek(e);
  };

  const submit = async (kind: 'trim' | 'clip', segments: [number, number][]) => {
    if (!video) return;
    setBusy(true);
    try {
      await api.studio.createEdits(video.id, { kind, segments: segments.map(([s, e]) => ({ start: s, end: e })) });
      if (kind === 'clip') setPending([]);
      toast(kind === 'trim' ? t('videoEditor.trimming') : t('videoEditor.clipping'));
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
        {t('m.editor.videoTitle')}
      </h2>
      {!videos.length ? (
        <EmptyState title={t('videoEditor.empty.title')} body={t('videoEditor.empty.body')} />
      ) : (
        <div className="yp-card stack" style={{ padding: 16 }}>
          <Select label={t('m.create.video')} value={selectedId} onChange={(e) => setSelectedId(e.currentTarget.value)}>
            {videos.map((v) => {
              const when = formatRelativeTime(v.createdAt, locale);
              const name = v.durationMs
                ? t(v.editOf ? 'videoEditor.option.editedLength' : 'videoEditor.option.videoLength', { length: formatSeconds(v.durationMs / 1000), when })
                : t(v.editOf ? 'videoEditor.option.edited' : 'videoEditor.option.video', { when });
              return (
                <option key={v.id} value={v.id} disabled={!v.processed}>
                  {v.processed ? name : t(v.failed ? 'videoEditor.option.failed' : 'videoEditor.option.processing', { label: name })}
                </option>
              );
            })}
          </Select>

          {video && !video.processed ? <p className="muted">{t(video.failed ? 'error.processingFailed' : 'videoEditor.stillProcessing')}</p> : null}

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
                aria-label={t('videoEditor.preview')}
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
                  .filter((tr) => tr.status === 'ready' && tr.url)
                  .map((tr) => (
                    <track key={tr.url} kind="subtitles" src={tr.url!} srcLang={tr.lang} label={tr.label} />
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
                    aria-label={t('m.editor.start')}
                    aria-valuetext={formatSeconds(start)}
                    min={0}
                    max={duration}
                    step={0.1}
                    value={start}
                    onChange={(e) => setStart(Number(e.currentTarget.value))}
                  />
                  <input
                    type="range"
                    aria-label={t('m.editor.end')}
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
                    label={t('videoEditor.startSeconds')}
                    type="number"
                    min={0}
                    max={duration}
                    step={0.1}
                    value={start}
                    onChange={(e) => setRange([round(Number(e.currentTarget.value) || 0), end])}
                    onBlur={typedStart}
                    style={{ width: 120 }}
                  />
                  <Button variant="secondary" size="sm" onClick={() => setStart(now())}>
                    {t('videoEditor.setStartNow')}
                  </Button>
                  <TextField
                    label={t('videoEditor.endSeconds')}
                    type="number"
                    min={0}
                    max={duration}
                    step={0.1}
                    value={end}
                    onChange={(e) => setRange([start, round(Number(e.currentTarget.value) || 0)])}
                    onBlur={typedEnd}
                    style={{ width: 120 }}
                  />
                  <Button variant="secondary" size="sm" onClick={() => setEnd(now())}>
                    {t('videoEditor.setEndNow')}
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
                    {t('videoEditor.playSelection')}
                  </Button>
                </div>
                <p className={rangeError ? 'yp-field__error' : 'muted'} style={{ margin: 0 }} role="status">
                  {rangeError ??
                    t('videoEditor.selected', {
                      start: formatSeconds(start),
                      end: formatSeconds(end),
                      length: length.toLocaleString(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
                      total: formatSeconds(duration),
                    })}
                </p>
                <div className="row">
                  <Button onClick={() => submit('trim', [[start, end]])} disabled={!!rangeError} loading={busy}>
                    {t('m.editor.tab.trim')}
                  </Button>
                  <Button variant="secondary" onClick={() => setPending((p) => [...p, [start, end]])} disabled={!!rangeError || pending.length >= MAX_CLIPS}>
                    {t('videoEditor.addClip')}
                  </Button>
                  {pending.length ? (
                    <Button variant="secondary" onClick={() => submit('clip', pending)} loading={busy}>
                      {tp('videoEditor.makeClips', pending.length)}
                    </Button>
                  ) : null}
                </div>
                <p className="muted" style={{ margin: 0, fontSize: 13 }}>
                  {t('videoEditor.newVideosNote')}
                </p>
              </div>

              {pending.length ? (
                <List label={t('videoEditor.clipsToMake')}>
                  {pending.map(([s, e], i) => (
                    <ListItem
                      key={`${s}-${e}-${i}`}
                      primary={t('videoEditor.clipRange', { number: i + 1, start: formatSeconds(s), end: formatSeconds(e) })}
                      end={
                        <Button variant="ghost" size="sm" onClick={() => setPending((p) => p.filter((_, j) => j !== i))}>
                          {t('m.common.remove')}
                        </Button>
                      }
                    />
                  ))}
                </List>
              ) : null}

              {edits.length ? (
                <div className="stack-sm">
                  <h3 style={{ margin: 0 }}>{t('videoEditor.edits')}</h3>
                  <List label={t('videoEditor.edits')}>
                    {edits.map((e) => (
                      <ListItem
                        key={e.id}
                        primary={
                          <span className="row">
                            {t(e.kind === 'trim' ? 'videoEditor.edit.trim' : 'videoEditor.edit.clip', {
                              start: formatSeconds(e.start),
                              end: formatSeconds(e.end),
                            })}
                            <Badge tone={EDIT_STATUS[e.status].tone}>{t(EDIT_STATUS[e.status].label)}</Badge>
                          </span>
                        }
                        secondary={mediaEditErrorText(e, t) ?? formatRelativeTime(e.createdAt, locale)}
                        end={
                          e.status === 'ready' && e.result ? (
                            <Button variant="ghost" size="sm" onClick={() => setSelectedId(e.result!.id)}>
                              {t('rooms.open')}
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
  const { toast, locale, t, tp } = useSession();
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
      <h3 style={{ margin: 0 }}>{t('reel.captions')}</h3>
      {tracks.length ? (
        <p className="muted" style={{ margin: 0 }}>
          {tracks
            .map((tr) =>
              tr.status === 'ready'
                ? tp('videoEditor.captions.trackReady', tr.cueCount, { label: tr.label })
                : t(tr.status === 'processing' ? 'videoEditor.captions.trackMaking' : 'videoEditor.captions.trackFailed', { label: tr.label }),
            )
            .join(' · ')}
        </p>
      ) : (
        <p className="muted" style={{ margin: 0 }}>
          {t('videoEditor.captions.none')}
        </p>
      )}
      <div className="row" style={{ alignItems: 'flex-end' }}>
        <Select
          label={t('settings.language')}
          value={lang}
          onChange={(e) => {
            const code = e.currentTarget.value;
            setLang(code);
            void loadCues(code, tracks);
          }}
        >
          {options.map((code) => (
            <option key={code} value={code}>
              {tracks.some((tr) => tr.lang === code) ? t('videoEditor.captions.hasCaptions', { language: names(code) }) : names(code)}
            </option>
          ))}
        </Select>
        <TextField
          label={t('videoEditor.captions.label')}
          value={label}
          maxLength={60}
          onChange={(e) => ((dirty.current = true), setLabel(e.currentTarget.value))}
        />
      </div>
      {current?.status === 'failed' && captionErrorText(current, t) ? <p className="yp-field__error">{captionErrorText(current, t)}</p> : null}
      {current?.status === 'processing' ? <p className="muted">{t('videoEditor.captions.making')}</p> : null}

      <ol className="stack-sm" style={{ listStyle: 'none', padding: 0, margin: 0 }} aria-label={t('reel.captions')}>
        {cues.map((c, i) => (
          <li key={c.key} className="row" style={{ alignItems: 'flex-end' }}>
            <TextField
              label={t('m.editor.start')}
              type="number"
              min={0}
              max={duration}
              step={0.1}
              value={c.start}
              onChange={(e) => update(c.key, { start: Number(e.currentTarget.value) })}
              aria-label={t('videoEditor.captions.cueStart', { number: i + 1 })}
              style={{ width: 90 }}
            />
            <TextField
              label={t('m.editor.end')}
              type="number"
              min={0}
              max={duration}
              step={0.1}
              value={c.end}
              onChange={(e) => update(c.key, { end: Number(e.currentTarget.value) })}
              aria-label={t('videoEditor.captions.cueEnd', { number: i + 1 })}
              style={{ width: 90 }}
              error={c.end <= c.start ? t('videoEditor.captions.endsBefore') : undefined}
            />
            <TextField
              label={t('m.post.text')}
              value={c.text}
              maxLength={1000}
              onChange={(e) => update(c.key, { text: e.currentTarget.value })}
              aria-label={t('videoEditor.captions.cueText', { number: i + 1 })}
              style={{ minWidth: 240 }}
            />
            <Button
              variant="ghost"
              size="sm"
              onClick={() => ((dirty.current = true), setCues((cs) => cs.filter((x) => x.key !== c.key)))}
              aria-label={t('videoEditor.captions.cueRemove', { number: i + 1 })}
            >
              {t('m.common.remove')}
            </Button>
          </li>
        ))}
      </ol>

      <div className="row">
        <Button variant="secondary" onClick={addCue}>
          {t('videoEditor.captions.add')}
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
              t('videoEditor.captions.saved'),
            )
          }
        >
          {t('videoEditor.captions.save')}
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
            if (file.size > MAX_VTT_BYTES) return toast(t('videoEditor.captions.tooBig'));
            void act(() => api.studio.uploadCaptions(mediaId, lang, file, label.trim() || names(lang)), t('videoEditor.captions.uploaded'));
          }}
        />
        <Button variant="secondary" onClick={() => fileRef.current?.click()} disabled={saving}>
          {t('videoEditor.captions.upload')}
        </Button>
        {current ? (
          <Button variant="danger" onClick={() => act(() => api.studio.deleteCaptions(mediaId, lang), t('videoEditor.captions.deleted'))} disabled={saving}>
            {t('videoEditor.captions.delete')}
          </Button>
        ) : null}
        {autoCaptions && (!current || current.status === 'failed') ? (
          <Button
            variant="ghost"
            onClick={() => act(() => api.studio.transcribe(mediaId, { lang, label: label.trim() || names(lang) }), t('videoEditor.captions.autoStarted'))}
            disabled={saving}
          >
            {t('videoEditor.captions.auto')}
          </Button>
        ) : null}
      </div>
      {!autoCaptions ? (
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>
          {t('videoEditor.captions.autoOff')}
        </p>
      ) : null}
    </div>
  );
}
