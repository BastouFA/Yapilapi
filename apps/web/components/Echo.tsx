'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Alert, Avatar, Button, EmptyState, Select, Skeleton, Switch, TextField } from '@yapilapi/design-system';
import {
  noticeText,
  ECHO_BALANCE_DEFAULT,
  ECHO_BLOCK_KEYS,
  ECHO_CUT_MAX_MS,
  ECHO_CUT_MIN_MS,
  ECHO_LAYOUTS,
  echoFrame,
  echoShare,
  formatReelTime,
  isVideoFile,
  videoPoster,
  videoSrc,
  VIDEO_ACCEPT,
  type EchoLayout,
  type EchoOptions,
  type EchoRender,
  type MessageKey,
} from '@yapilapi/shared';
import { api, errorMessage, isGone } from '@/lib/api';
import { takeEchoMedia } from '@/lib/pending-media';
import { useSession } from '@/app/providers';

const LAYOUT_KEYS: Record<EchoLayout, { label: MessageKey; hint: MessageKey }> = {
  side: { label: 'echo.layout.side', hint: 'echo.layout.sideHint' },
  stack: { label: 'echo.layout.stack', hint: 'echo.layout.stackHint' },
  corner: { label: 'echo.layout.corner', hint: 'echo.layout.cornerHint' },
};
const AUDIENCES = ['public', 'followers', 'friends', 'private'] as const;

/** Where each video sits in a layout, as percentages of the frame (the same numbers the server uses). */
function place(layout: EchoLayout, who: 'theirs' | 'yours') {
  const f = echoFrame(layout);
  const r = echoShare(f[who], f);
  return { left: `${r.left * 100}%`, top: `${r.top * 100}%`, width: `${r.width * 100}%`, height: `${r.height * 100}%` };
}

/** A small drawing of a layout for its choice: their place shaded, yours outlined. */
function LayoutGlyph({ layout }: { layout: EchoLayout }) {
  const f = echoFrame(layout);
  return (
    <span className="echo-glyph" style={{ aspectRatio: `${f.width} / ${f.height}` }} aria-hidden>
      <span className="echo-glyph__yours" style={place(layout, 'yours')} />
      <span className="echo-glyph__theirs" style={place(layout, 'theirs')} />
    </span>
  );
}

/**
 * Echo: answer a reel with your own video. Record one with the in-app camera or choose one, pick
 * how the two sit together, optionally a part of theirs to play first ("Echo after") and the
 * balance of the two sounds. The preview is drawn from the same layout the server uses; the echo is
 * made on the server, watched here, then posted as a reel linked to the original.
 */
export function EchoComposer({ postId }: { postId: string }) {
  const { t, toast, dataSaver } = useSession();
  const router = useRouter();
  const [options, setOptions] = useState<EchoOptions | null>(null);
  const [missing, setMissing] = useState<string | null>(null);
  // Why it couldn't load, when that isn't because the reel is gone or private.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [uploaded, setUploaded] = useState<{ id: string; forFile: File } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [layout, setLayout] = useState<EchoLayout>('side');
  const [after, setAfter] = useState(false);
  const [cut, setCut] = useState({ startMs: 0, endMs: 5000 });
  const [balance, setBalance] = useState(ECHO_BALANCE_DEFAULT);
  const [muteTheirs, setMuteTheirs] = useState(false);
  const [body, setBody] = useState('');
  const [visibility, setVisibility] = useState<(typeof AUDIENCES)[number]>('public');
  const [busy, setBusy] = useState<null | 'making' | 'posting'>(null);
  const [render, setRender] = useState<EchoRender | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const theirVideo = useRef<HTMLVideoElement>(null);
  const yourVideo = useRef<HTMLVideoElement>(null);
  const waiting = useRef<AbortController | null>(null);
  const ids = useId();

  const loadOptions = useCallback(() => {
    setLoadError(null);
    api.posts.echoOptions(postId).then(
      (o) => {
        setOptions(o);
        const len = o.original.durationMs ?? 0;
        if (len) setCut({ startMs: 0, endMs: Math.min(len, 5000) });
      },
      (e) => (isGone(e) ? setMissing(errorMessage(e)) : setLoadError(errorMessage(e))),
    );
  }, [postId]);
  useEffect(() => {
    loadOptions();
    // A video just recorded with the camera for this echo.
    const recorded = takeEchoMedia(postId);
    if (recorded) choose(recorded);
    return () => waiting.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [postId]);

  useEffect(() => () => void (preview && URL.revokeObjectURL(preview)), [preview]);

  function choose(f: File) {
    if (!isVideoFile(f)) return toast(t('compose.reelIsVideo'));
    setFile(f);
    setPreview(URL.createObjectURL(f));
    setRender(null);
    setFailed(null);
  }

  // The two previews play together, from the start of the part of theirs that plays.
  const playBoth = () => {
    const a = theirVideo.current;
    const b = yourVideo.current;
    if (a) {
      a.currentTime = after ? cut.startMs / 1000 : 0;
      void a.play().catch(() => {});
    }
    if (b) {
      b.currentTime = 0;
      void b.play().catch(() => {});
    }
  };

  if (missing) return <EmptyState level={1} title={t('echo.block.unavailable')} body={missing} />;
  if (!options && loadError) return <EmptyState level={1} title={loadError} action={<Button onClick={loadOptions}>{t('m.common.retry')}</Button>} />;
  if (!options) return <Skeleton height={320} />;

  const name = options.original.author.username;
  const theirMedia = options.original.media;
  const durationMs = options.original.durationMs ?? 0;
  const hasCaptions = !!theirMedia?.captions?.length;
  const theirSrc = theirMedia ? videoSrc(theirMedia, dataSaver.active) : undefined;

  const setStart = (ms: number) =>
    setCut((c) => {
      const startMs = Math.max(0, Math.min(ms, Math.max(0, durationMs - ECHO_CUT_MIN_MS)));
      const len = Math.min(Math.max(c.endMs - c.startMs, ECHO_CUT_MIN_MS), ECHO_CUT_MAX_MS);
      return { startMs, endMs: Math.min(durationMs, startMs + len) };
    });
  const setEnd = (ms: number) =>
    setCut((c) => ({ startMs: c.startMs, endMs: Math.max(c.startMs + ECHO_CUT_MIN_MS, Math.min(ms, c.startMs + ECHO_CUT_MAX_MS, durationMs)) }));

  async function make() {
    if (!file) return;
    setFailed(null);
    setBusy('making');
    waiting.current?.abort();
    const ctrl = new AbortController();
    waiting.current = ctrl;
    try {
      let mediaId = uploaded?.forFile === file ? uploaded.id : null;
      if (!mediaId) {
        setUploading(true);
        const { media } = await api.media.upload(file).finally(() => setUploading(false));
        mediaId = media.id;
        setUploaded({ id: media.id, forFile: file });
      }
      const { echo } = await api.posts.echo(postId, {
        mediaId,
        layout,
        cut: after ? cut : null,
        balance,
        muteTheirs,
      });
      setRender(echo);
      setRender(await api.echoes.waitUntilReady(echo.id, { signal: ctrl.signal }));
    } catch (e) {
      if (!ctrl.signal.aborted) setFailed(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  async function post() {
    if (!render?.media) return;
    setBusy('posting');
    try {
      const { post: created, moderation } = await api.posts.create({
        format: 'reel',
        body,
        visibility,
        media: [{ id: render.media.id, url: render.media.url, kind: 'video' }],
        echo: render.id,
      });
      toast(noticeText(moderation, t) ?? t('echo.posted'));
      router.push(`/reels?start=${created.id}`);
    } catch (e) {
      toast(errorMessage(e));
      setBusy(null);
    }
  }

  const ready = render?.status === 'ready' && render.media;
  const audioNote =
    options.theirAudio === 'song' && options.song
      ? t('echo.audio.song', { title: options.song.title })
      : options.theirAudio === 'dropped'
        ? t('echo.audio.dropped')
        : options.theirAudio === 'none'
          ? t('echo.audio.none')
          : null;

  return (
    <div className="yp-shell__inner stack echo">
      <div className="yp-topbar">
        <h1>{t('echo.heading', { name })}</h1>
      </div>
      <p className="muted echo__intro">{t('echo.intro', { name })}</p>

      <Link href={`/reels?start=${options.original.id}`} className="echo__original">
        <Avatar name={options.original.author.displayName} src={options.original.author.avatarUrl} size="sm" />
        <span>
          <strong>
            <bdi>{t('echo.theirReel', { name: options.original.author.displayName })}</bdi>
          </strong>
          {options.original.body ? (
            <span className="muted echo__original-body" dir="auto">
              {options.original.body}
            </span>
          ) : null}
        </span>
      </Link>

      {!options.canEcho && options.reason ? (
        <Alert tone="warning">{t(ECHO_BLOCK_KEYS[options.reason])}</Alert>
      ) : ready ? (
        <section className="stack" aria-labelledby={`${ids}-ready`}>
          <h2 id={`${ids}-ready`} className="echo__h2">
            {t('echo.preview')}
          </h2>
          <p className="muted">{t('echo.ready')}</p>
          <video
            className="echo__result"
            src={render.media!.url}
            poster={render.media!.posterUrl ?? undefined}
            controls
            playsInline
            style={{ aspectRatio: `${render.media!.width ?? 9} / ${render.media!.height ?? 16}` }}
            aria-label={t('echo.preview')}
          />
          {render.theirAudio === 'dropped' ? <p className="muted echo__note">{t('echo.audioDropped')}</p> : null}
          <TextField
            label={t('echo.caption')}
            multiline
            rows={3}
            maxLength={5000}
            value={body}
            placeholder={t('echo.captionPlaceholder')}
            onChange={(e) => setBody(e.currentTarget.value)}
          />
          <Select label={t('create.visibility')} value={visibility} onChange={(e) => setVisibility(e.currentTarget.value as (typeof AUDIENCES)[number])}>
            {AUDIENCES.map((a) => (
              <option key={a} value={a}>
                {t(`visibility.${a}` as MessageKey)}
              </option>
            ))}
          </Select>
          <div className="row">
            <Button onClick={() => void post()} loading={busy === 'posting'}>
              {t('echo.post')}
            </Button>
            <Button variant="ghost" onClick={() => setRender(null)} disabled={busy === 'posting'}>
              {t('echo.startOver')}
            </Button>
          </div>
        </section>
      ) : (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            void make();
          }}
        >
          {/* The preview: their reel and yours in the chosen layout. */}
          <div className="echo__stage" style={{ aspectRatio: `${echoFrame(layout).width} / ${echoFrame(layout).height}` }}>
            {theirSrc ? (
              <video
                ref={theirVideo}
                className={`echo__video echo__video--theirs echo__video--${layout}`}
                style={place(layout, 'theirs')}
                src={theirSrc}
                poster={theirMedia ? videoPoster(theirMedia, dataSaver.active) : undefined}
                muted
                loop
                playsInline
                autoPlay
                aria-label={t('echo.theirReel', { name: options.original.author.displayName })}
              />
            ) : null}
            {preview ? (
              <video
                ref={yourVideo}
                className="echo__video echo__video--yours"
                style={place(layout, 'yours')}
                src={preview}
                muted
                loop
                playsInline
                autoPlay
                aria-label={t('echo.yourVideo')}
              />
            ) : (
              <span className="echo__slot" style={place(layout, 'yours')}>
                {t('echo.noVideo')}
              </span>
            )}
            <span className="echo__credit" aria-hidden>
              {t('echo.of', { name })}
            </span>
          </div>
          {preview ? (
            <Button variant="ghost" size="sm" icon="play" onClick={playBoth}>
              {t('m.common.play')}
            </Button>
          ) : null}

          <fieldset className="echo__group">
            <legend>{t('echo.yourVideo')}</legend>
            <div className="row">
              <Link href={`/camera?mode=reel&echo=${postId}`} className="yp-btn yp-btn--secondary">
                {t('echo.record')}
              </Link>
              <Button variant="secondary" icon="image" onClick={() => picker.current?.click()}>
                {file ? t('echo.replace') : t('echo.pick')}
              </Button>
            </div>
            {file ? <p className="muted echo__note">{file.name}</p> : null}
            <input
              ref={picker}
              type="file"
              hidden
              accept={VIDEO_ACCEPT}
              onChange={(e) => {
                const f = e.currentTarget.files?.[0];
                e.currentTarget.value = '';
                if (f) choose(f);
              }}
            />
          </fieldset>

          <fieldset className="echo__group">
            <legend>{t('echo.layout')}</legend>
            <div className="echo__layouts">
              {ECHO_LAYOUTS.map((l) => (
                <label key={l} className="echo__layout">
                  <input
                    type="radio"
                    name={`${ids}-layout`}
                    value={l}
                    checked={layout === l}
                    onChange={() => setLayout(l)}
                    aria-describedby={`${ids}-${l}-hint`}
                  />
                  <LayoutGlyph layout={l} />
                  <span className="echo__layout-text">
                    <strong>{t(LAYOUT_KEYS[l].label)}</strong>
                    <span id={`${ids}-${l}-hint`} className="muted">
                      {t(LAYOUT_KEYS[l].hint)}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          {durationMs >= ECHO_CUT_MIN_MS ? (
            <fieldset className="echo__group">
              <legend>{t('echo.after')}</legend>
              <Switch label={t('echo.afterHint')} checked={after} onChange={setAfter} />
              {after ? (
                <div className="stack-sm">
                  <label className="echo__range">
                    <span>
                      {t('echo.after.start')} <span className="muted">{formatReelTime(cut.startMs)}</span>
                    </span>
                    <input
                      type="range"
                      min={0}
                      max={Math.max(0, durationMs - ECHO_CUT_MIN_MS)}
                      step={100}
                      value={cut.startMs}
                      aria-valuetext={formatReelTime(cut.startMs)}
                      onChange={(e) => setStart(Number(e.currentTarget.value))}
                    />
                  </label>
                  <label className="echo__range">
                    <span>
                      {t('echo.after.end')} <span className="muted">{formatReelTime(cut.endMs)}</span>
                    </span>
                    <input
                      type="range"
                      min={ECHO_CUT_MIN_MS}
                      max={durationMs}
                      step={100}
                      value={cut.endMs}
                      aria-valuetext={formatReelTime(cut.endMs)}
                      onChange={(e) => setEnd(Number(e.currentTarget.value))}
                    />
                  </label>
                  <p className="muted echo__note" aria-live="polite">
                    {t('echo.after.summary', { start: formatReelTime(cut.startMs), end: formatReelTime(cut.endMs) })}
                  </p>
                </div>
              ) : null}
            </fieldset>
          ) : null}

          <fieldset className="echo__group">
            <legend>{t('echo.sound')}</legend>
            {options.theirAudio === 'mixed' ? (
              <>
                <label className="echo__range">
                  <span>{t('echo.balance')}</span>
                  <span className="echo__balance">
                    <span aria-hidden>{t('echo.balance.theirs')}</span>
                    <input
                      type="range"
                      min={0}
                      max={100}
                      step={5}
                      value={balance}
                      disabled={muteTheirs}
                      aria-valuetext={t('echo.balance.value', { theirs: 100 - balance, yours: balance })}
                      onChange={(e) => setBalance(Number(e.currentTarget.value))}
                    />
                    <span aria-hidden>{t('echo.balance.yours')}</span>
                  </span>
                </label>
                <Switch label={t('echo.muteTheirs')} checked={muteTheirs} onChange={setMuteTheirs} />
              </>
            ) : (
              <>
                {audioNote ? <p className="muted echo__note">{audioNote}</p> : null}
                {options.theirAudio === 'song' ? <Switch label={t('echo.muteTheirs')} checked={muteTheirs} onChange={setMuteTheirs} /> : null}
              </>
            )}
            {hasCaptions ? <p className="muted echo__note">{t('echo.captionsNote')}</p> : null}
          </fieldset>

          {failed ? <Alert tone="danger">{failed}</Alert> : null}
          {busy === 'making' ? (
            <p className="muted echo__note" role="status">
              {uploading ? t('echo.uploading') : t('echo.making')}
            </p>
          ) : null}
          <div className="row">
            <Button type="submit" disabled={!file} loading={busy === 'making'}>
              {t('echo.make')}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
