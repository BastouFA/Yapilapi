'use client';

import { useCallback, useRef, useState } from 'react';
import { ApiError, type MediaObject } from '@yapilapi/api-client';
import type { ComposerMediaItem } from '@yapilapi/ui';
import { useApi } from './api';
import { useI18n } from '@/i18n';

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_VIDEO_BYTES = 500 * 1024 * 1024;
const MAX_AUDIO_BYTES = 100 * 1024 * 1024;

function kindOf(file: File): ComposerMediaItem['kind'] {
  if (file.type.startsWith('image/')) return 'image';
  if (file.type.startsWith('video/')) return 'video';
  if (file.type.startsWith('audio/')) return 'audio';
  return 'file';
}

/**
 * Uploads attachments for the post composer (or Moments) through `POST /v1/media` (simple, single-request upload).
 * Tracks per-file progress as `uploading -> ready | failed` so the Composer can render thumbnails immediately.
 * See `docs/architecture/media.md`: the resumable/chunked upload flow exists for large video but is not wired into
 * this web UI yet (documented in the roadmap gaps).
 */
export function useMediaUploads(maxItems = 10) {
  const api = useApi();
  const { t } = useI18n();
  const [items, setItems] = useState<ComposerMediaItem[]>([]);
  const idSeq = useRef(0);

  const addFiles = useCallback(
    (files: FileList) => {
      const room = maxItems - items.length;
      const list = Array.from(files).slice(0, Math.max(0, room));
      for (const file of list) {
        const localId = `local-${++idSeq.current}`;
        const kind = kindOf(file);
        const limit =
          kind === 'video' ? MAX_VIDEO_BYTES : kind === 'audio' ? MAX_AUDIO_BYTES : MAX_IMAGE_BYTES;
        if (file.size > limit) {
          setItems((prev) => [
            ...prev,
            { id: localId, url: null, kind, status: 'failed', error: t('media.tooLarge') },
          ]);
          continue;
        }
        const url = kind === 'image' || kind === 'video' ? URL.createObjectURL(file) : null;
        setItems((prev) => [...prev, { id: localId, url, kind, status: 'uploading' }]);
        api.media.upload(file, { fileName: file.name, purpose: 'attachment' }).then(
          (media: MediaObject) => {
            setItems((prev) =>
              prev.map((m) =>
                m.id === localId
                  ? { ...m, id: media.id, url: media.url ?? url, status: 'ready' as const }
                  : m,
              ),
            );
          },
          (err: unknown) => {
            const msg =
              err instanceof ApiError && err.status === 415
                ? t('media.unsupportedType')
                : err instanceof ApiError && err.status === 413
                  ? t('media.tooLarge')
                  : t('media.uploadFailedGeneric');
            setItems((prev) =>
              prev.map((m) =>
                m.id === localId ? { ...m, status: 'failed' as const, error: msg } : m,
              ),
            );
          },
        );
      }
    },
    [api, items.length, maxItems, t],
  );

  const remove = useCallback(
    (id: string) => {
      setItems((prev) => {
        const found = prev.find((m) => m.id === id);
        if (found?.url && found.url.startsWith('blob:')) URL.revokeObjectURL(found.url);
        // Best-effort: a media object already uploaded and then removed from the draft is deleted server-side too.
        if (!id.startsWith('local-')) void api.media.delete(id).catch(() => undefined);
        return prev.filter((m) => m.id !== id);
      });
    },
    [api],
  );

  const setAltText = useCallback(
    (id: string, altText: string) => {
      setItems((prev) => prev.map((m) => (m.id === id ? { ...m, altText } : m)));
      if (!id.startsWith('local-')) void api.media.update(id, { altText }).catch(() => undefined);
    },
    [api],
  );

  const reset = useCallback(() => {
    for (const m of items) if (m.url?.startsWith('blob:')) URL.revokeObjectURL(m.url);
    setItems([]);
  }, [items]);

  return { items, addFiles, remove, setAltText, reset, maxItems };
}
