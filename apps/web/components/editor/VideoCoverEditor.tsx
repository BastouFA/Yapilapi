'use client';

import { useRef, useState } from 'react';
import { Alert, Button } from '@yapilapi/design-system';
import type { MediaItem, Post } from '@yapilapi/shared';
import { clock, EditorShell, useFit } from './parts';
import { PhotoEditor } from './PhotoEditor';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/app/providers';

/**
 * The cover of a video already posted (a reel, or a video in a post): any moment of it, one of
 * your photos cut to the video's shape, or the default. Each choice is saved as it is made
 * (PUT /v1/posts/:id/cover) and `onSaved` gets the updated post.
 */
export function VideoCoverEditor({ post, media, onSaved, onClose }: { post: Post; media: MediaItem; onSaved: (p: Post) => void; onClose: () => void }) {
  const { t, toast } = useSession();
  const [current, setCurrent] = useState<MediaItem>(media);
  const [duration, setDuration] = useState(0);
  const [at, setAt] = useState((media.coverMs ?? 0) / 1000);
  const [size, setSize] = useState({ w: media.width || 9, h: media.height || 16 });
  const [busy, setBusy] = useState<null | 'frame' | 'photo' | 'default'>(null);
  const [stage, setStage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [photo, setPhoto] = useState<File | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const fit = useFit(size.w, size.h);

  async function save(kind: 'frame' | 'photo' | 'default', run: () => Promise<{ post: Post }>) {
    setBusy(kind);
    setError(null);
    try {
      const { post: updated } = await run();
      const m = updated.media.find((x) => x.id === media.id);
      if (m) setCurrent(m);
      onSaved(updated);
      toast(t(kind === 'default' ? 'postCover.backToDefault' : 'postCover.saved'));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
      setStage(null);
    }
  }

  const pickFrame = () => save('frame', () => api.posts.setCover(post.id, { mediaId: media.id, atMs: Math.round(at * 1000) }));
  const pickDefault = () => save('default', () => api.posts.setCover(post.id, { mediaId: media.id, reset: true }));
  const pickPhoto = (file: File) =>
    save('photo', async () => {
      setStage(t('profilePlus.uploading'));
      const { media: up } = await api.media.upload(file);
      setStage(t('m.cover.preparing'));
      return api.posts.setCoverWhenReady(post.id, { mediaId: media.id, imageMediaId: up.id });
    });

  const poster = current.posterUrl ?? current.variants?.thumb ?? null;
  return (
    <>
      <EditorShell
        title={t('postCover.edit')}
        onCancel={onClose}
        onDone={onClose}
        doneLabel={t('m.common.done')}
        canUndo={false}
        busy={!!busy}
        stage={
          <div className="ed__video">
            <div ref={fit.ref} className="ed__fit">
              <div className="ed__frame" style={{ width: fit.width, height: fit.height }}>
                <video
                  ref={videoRef}
                  src={media.variants?.mp4 ?? media.url}
                  poster={poster ?? undefined}
                  playsInline
                  muted
                  preload="auto"
                  aria-label={t('postCover.preview')}
                  style={{ width: '100%', height: '100%', objectFit: 'contain' }}
                  onLoadedMetadata={(e) => {
                    const v = e.currentTarget;
                    setDuration(Number.isFinite(v.duration) ? v.duration : 0);
                    if (v.videoWidth && v.videoHeight) setSize({ w: v.videoWidth, h: v.videoHeight });
                    v.currentTime = Math.min(at, Number.isFinite(v.duration) ? v.duration : at);
                  }}
                />
              </div>
            </div>
          </div>
        }
        tools={
          <div className="stack-sm">
            {error ? <Alert tone="danger">{error}</Alert> : null}
            <div className="row" style={{ alignItems: 'center', flexWrap: 'nowrap', gap: 12 }}>
              {poster ? <img src={poster} alt={t('postCover.current')} className="cover-ed__current" /> : null}
              <p className="muted ed__hint" style={{ margin: 0 }} role="status">
                {stage ?? (current.customCover ? t('postCover.customNow') : t('postCover.defaultNow'))}
              </p>
            </div>
            <div className="ed__slider">
              <label htmlFor={`cover-at-${media.id}`}>{t('postCover.moment')}</label>
              <input
                id={`cover-at-${media.id}`}
                type="range"
                min={0}
                max={duration || 0}
                step={0.1}
                value={Math.min(at, duration || at)}
                disabled={!duration}
                aria-valuetext={clock(at)}
                onChange={(e) => {
                  const v = Number(e.currentTarget.value);
                  setAt(v);
                  if (videoRef.current) {
                    videoRef.current.pause();
                    videoRef.current.currentTime = v;
                  }
                }}
              />
              <output className="ed__value">{clock(at)}</output>
            </div>
            <div className="row">
              <Button size="sm" onClick={pickFrame} loading={busy === 'frame'} disabled={!!busy || !duration}>
                {t('videoEditor.cover.useFrame')}
              </Button>
              <Button variant="secondary" size="sm" onClick={() => fileRef.current?.click()} loading={busy === 'photo'} disabled={!!busy}>
                {t('postCover.uploadPhoto')}
              </Button>
              <Button variant="ghost" size="sm" onClick={pickDefault} loading={busy === 'default'} disabled={!!busy || !current.customCover}>
                {t('videoEditor.cover.useDefault')}
              </Button>
            </div>
            <input
              ref={fileRef}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
              hidden
              aria-label={t('postCover.uploadPhoto')}
              onChange={(e) => {
                const f = e.currentTarget.files?.[0];
                e.currentTarget.value = '';
                if (f) setPhoto(f);
              }}
            />
            <p className="muted ed__hint">{t('postCover.hint')}</p>
          </div>
        }
      />
      {/* On top, keeping the video editor (and its place in the video) underneath. */}
      {photo ? (
        <PhotoEditor
          file={photo}
          title={t('postCover.photoTitle')}
          lockRatio={size.w / size.h}
          onCancel={() => setPhoto(null)}
          onDone={(f) => {
            setPhoto(null);
            void pickPhoto(f);
          }}
        />
      ) : null}
    </>
  );
}
