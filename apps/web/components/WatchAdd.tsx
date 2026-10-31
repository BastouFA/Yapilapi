'use client';

import { useEffect, useRef, useState, type DragEvent, type FormEvent } from 'react';
import { BottomSheet, Button, Icon, Segments, Skeleton } from '@yapilapi/design-system';
import { youtubeIdFrom, type Post } from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';
import { prepareUpload } from '@/lib/data-saver';
import { useSession } from '@/app/providers';
import { hasVideo, postIdFrom, postThumb } from '@/components/WatchTogether';

// Adding to a watch together queue: one sheet with three choices (from YAPILAPI, from this
// device, a YouTube link), dropping a file on the player, and what to watch next when the queue
// runs out. The watch screen (WatchScreen.tsx) uses these.

/** What can be added at once. */
export interface Addition {
  postIds?: string[];
  mediaIds?: string[];
  links?: string[];
}

/** Photos and videos only, as POST /v1/media?for=watch takes them. */
const ACCEPT = 'image/*,video/*,.heic,.heif,.mov';
const isMediaFile = (f: File) => /^(image|video)\//.test(f.type) || /\.(heic|heif|mov|mp4|m4v|webm|jpe?g|png|gif|webp)$/i.test(f.name);

/**
 * Upload a photo or video for watch together through the usual upload path (POST /v1/media,
 * ?for=watch), reporting progress as it goes. It's shown only through the session, to the people
 * in its chat, and deleted when the session ends.
 */
export async function uploadForWatch(file: File, onProgress: (fraction: number) => void): Promise<string> {
  const ready = await prepareUpload(file);
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/v1/media?for=watch');
    xhr.withCredentials = true;
    const lang = document.documentElement.lang;
    if (lang) xhr.setRequestHeader('x-locale', lang);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      let body: { media?: { id: string }; error?: { message?: string } } | null = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        /* not JSON: said below */
      }
      if (xhr.status >= 200 && xhr.status < 300 && body?.media?.id) resolve(body.media.id);
      else reject(new Error(body?.error?.message || ''));
    };
    xhr.onerror = () => reject(new Error(''));
    const fd = new FormData();
    fd.append('file', ready);
    xhr.send(fd);
  });
}

/** An upload on its way: how far it got. */
export interface UploadState {
  name: string;
  progress: number;
}

/**
 * Uploading from this device: the file, then adding it to the queue. One at a time; `state` is
 * what to show while it goes.
 */
export function useWatchUpload(add: (a: Addition) => Promise<boolean>) {
  const { t, toast } = useSession();
  const [state, setState] = useState<UploadState | null>(null);
  const send = async (file: File | undefined) => {
    if (!file || state) return;
    if (!isMediaFile(file)) return toast(t('watch.uploadPick'));
    setState({ name: file.name, progress: 0 });
    try {
      const id = await uploadForWatch(file, (p) => setState({ name: file.name, progress: p }));
      await add({ mediaIds: [id] });
    } catch (e) {
      toast((e as Error).message || errorMessage(e));
    } finally {
      setState(null);
    }
  };
  return { state, send };
}

/** Drop a photo or video on this element to add it (on computers; a phone has the file button). */
export function useDropFile(onFile: (f: File) => void) {
  const [over, setOver] = useState(false);
  const has = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
  return {
    over,
    props: {
      onDragOver: (e: DragEvent) => {
        if (!has(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        if (!over) setOver(true);
      },
      onDragLeave: (e: DragEvent) => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        setOver(false);
      },
      onDrop: (e: DragEvent) => {
        if (!has(e)) return;
        e.preventDefault();
        setOver(false);
        const f = e.dataTransfer.files?.[0];
        if (f) onFile(f);
      },
    },
  };
}

/** "Uploading 42%", then "Getting it ready" once it's on its way to the queue. */
export function UploadProgress({ state }: { state: UploadState }) {
  const { t, locale } = useSession();
  const pct = Math.round(state.progress * 100);
  const label = t('watch.uploadingProgress', { progress: new Intl.NumberFormat(locale, { style: 'percent' }).format(state.progress) });
  return (
    <div className="watch-upload" role="status">
      <span className="watch-upload__label">{pct >= 100 ? t('watch.preparing') : label}</span>
      <progress className="watch-upload__bar" max={100} value={pct} aria-label={label} />
    </div>
  );
}

type Source = 'app' | 'device' | 'link';

/**
 * "Add to watch together": one sheet with three choices. From YAPILAPI (reels and saved videos,
 * or a link to a post), from this device (a file button, or drop a file), or a YouTube link.
 */
export function AddSheet({
  open,
  onClose,
  queued,
  busy,
  add,
  upload,
}: {
  open: boolean;
  onClose: () => void;
  queued: Set<string>;
  busy: boolean;
  add: (a: Addition) => Promise<boolean>;
  upload: { state: UploadState | null; send: (f: File | undefined) => Promise<void> };
}) {
  const { t, toast } = useSession();
  const [source, setSource] = useState<Source>('app');
  const [postLink, setPostLink] = useState('');
  const [ytLink, setYtLink] = useState('');
  const file = useRef<HTMLInputElement>(null);
  const drop = useDropFile((f) => void upload.send(f));

  async function addPost(e: FormEvent) {
    e.preventDefault();
    const postId = postIdFrom(postLink);
    if (!postId) return toast(t('watch.badLink'));
    if (await add({ postIds: [postId] })) setPostLink('');
  }
  async function addYouTube(e: FormEvent) {
    e.preventDefault();
    // Checked on the server too (only YouTube, a real video id); this saves a round trip.
    if (!youtubeIdFrom(ytLink)) return toast(t('watch.linkLabel'));
    if (await add({ links: [ytLink.trim()] })) {
      setYtLink('');
      onClose();
    }
  }

  return (
    <BottomSheet open={open} onClose={onClose} title={t('watch.add')}>
      <Segments
        label={t('watch.add')}
        value={source}
        onChange={setSource}
        options={[
          { id: 'app', label: t('watch.addFrom.app') },
          { id: 'device', label: t('watch.addFrom.device') },
          { id: 'link', label: t('watch.addFrom.link') },
        ]}
      />
      {source === 'app' ? (
        <>
          <WatchPicks queued={queued} busy={busy} onAdd={(pid) => void add({ postIds: [pid] })} />
          <form className="watch-add" onSubmit={(e) => void addPost(e)}>
            <label htmlFor="watch-add" className="watch-add__label">
              {t('watch.addPlaceholder')}
            </label>
            <div className="watch-add__row">
              <input
                id="watch-add"
                className="yp-input"
                type="text"
                inputMode="url"
                autoComplete="off"
                value={postLink}
                onChange={(e) => setPostLink(e.currentTarget.value)}
              />
              <Button type="submit" variant="secondary" loading={busy} disabled={!postLink.trim()}>
                {t('watch.addButton')}
              </Button>
            </div>
          </form>
        </>
      ) : source === 'device' ? (
        <div className={`watch-drop${drop.over ? ' watch-drop--over' : ''}`} {...drop.props}>
          <input
            ref={file}
            type="file"
            accept={ACCEPT}
            hidden
            onChange={(e) => {
              const f = e.currentTarget.files?.[0];
              e.currentTarget.value = '';
              void upload.send(f);
            }}
          />
          {upload.state ? (
            <UploadProgress state={upload.state} />
          ) : (
            <>
              <Button icon="image" onClick={() => file.current?.click()}>
                {t('watch.uploadPick')}
              </Button>
              <p className="muted watch-drop__hint">{t('watch.dropHint')}</p>
            </>
          )}
          <p className="muted watch-note">{t('watch.uploadNote')}</p>
        </div>
      ) : (
        <form className="watch-add" onSubmit={(e) => void addYouTube(e)}>
          <label htmlFor="watch-yt" className="watch-add__label">
            {t('watch.linkLabel')}
          </label>
          <div className="watch-add__row">
            <input
              id="watch-yt"
              className="yp-input"
              type="url"
              inputMode="url"
              autoComplete="off"
              placeholder="https://youtu.be/…"
              value={ytLink}
              onChange={(e) => setYtLink(e.currentTarget.value)}
            />
            <Button type="submit" variant="secondary" loading={busy} disabled={!ytLink.trim()}>
              {t('watch.addButton')}
            </Button>
          </div>
        </form>
      )}
    </BottomSheet>
  );
}

/** Something to add without leaving: reels, or the videos you saved. */
function WatchPicks({ queued, busy, onAdd }: { queued: Set<string>; busy: boolean; onAdd: (postId: string) => void }) {
  const { t } = useSession();
  const [source, setSource] = useState<'reels' | 'saved'>('reels');
  const [picks, setPicks] = useState<Post[] | null>(null);
  useEffect(() => {
    let live = true;
    setPicks(null);
    (source === 'reels' ? api.reels() : api.me.saved('videos'))
      .then((page) => live && setPicks(page.items.filter((p) => hasVideo(p) && !p.status && !p.locked)))
      .catch(() => live && setPicks([]));
    return () => {
      live = false;
    };
  }, [source]);
  return (
    <div className="watch-picks">
      <Segments
        label={t('watch.pickFrom')}
        value={source}
        onChange={setSource}
        options={[
          { id: 'reels', label: t('watch.pickReels') },
          { id: 'saved', label: t('watch.pickSaved') },
        ]}
      />
      {picks === null ? (
        <Skeleton height={150} />
      ) : picks.length ? (
        <PostTiles posts={picks} queued={queued} busy={busy} onAdd={onAdd} />
      ) : (
        <p className="muted watch-note">{source === 'reels' ? t('watch.pickNoReels') : t('watch.pickNoSaved')}</p>
      )}
    </div>
  );
}

/** A row of reels and videos, each one tap to add (named so, and "in the queue" once it is). */
function PostTiles({ posts, queued, busy, onAdd }: { posts: Post[]; queued: Set<string>; busy: boolean; onAdd: (postId: string) => void }) {
  const { t } = useSession();
  return (
    <ul className="watch-picks__row">
      {posts.map((p) => {
        const thumb = postThumb(p);
        const inQueue = queued.has(p.id);
        const title = p.body.trim() || t('watch.pickUntitled', { name: p.author.displayName });
        return (
          <li key={p.id}>
            <button
              type="button"
              className="watch-picks__item"
              // Stays focusable while it's added and once it's queued (named so), so focus isn't lost.
              aria-disabled={inQueue || busy || undefined}
              aria-label={inQueue ? t('watch.pickQueued', { title }) : t('watch.pickAdd', { title })}
              onClick={() => !inQueue && !busy && onAdd(p.id)}
            >
              <span className="watch-picks__thumb">
                {thumb ? <img src={thumb} alt="" loading="lazy" decoding="async" /> : null}
                <span className="watch-picks__badge" aria-hidden>
                  <Icon name={inQueue ? 'check' : 'plus'} size={16} />
                </span>
              </span>
              <span className="watch-picks__title" dir="auto">
                {title}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * When the queue runs out: a few reels and videos everyone in the chat can watch (the server
 * picks the same ones for everyone), one tap to add. Read again when the queue changes.
 */
export function WatchSuggestions({
  sessionId,
  queued,
  busy,
  onAdd,
}: {
  sessionId: string;
  queued: Set<string>;
  busy: boolean;
  onAdd: (postId: string) => void;
}) {
  const { t } = useSession();
  const [items, setItems] = useState<Post[] | null>(null);
  const key = [...queued].sort().join(',');
  useEffect(() => {
    let live = true;
    api.watch.suggestions(sessionId).then(
      (r) => live && setItems(r.items.filter((p) => hasVideo(p))),
      () => live && setItems([]),
    );
    return () => {
      live = false;
    };
  }, [sessionId, key]);
  if (!items?.length) return null;
  return (
    <section className="watch-suggest" aria-labelledby="watch-suggest-title">
      <h2 id="watch-suggest-title" className="watch-section__title">
        {t('watch.suggestions')}
      </h2>
      <p className="muted watch-note">{t('watch.suggestionsHint')}</p>
      <PostTiles posts={items} queued={queued} busy={busy} onAdd={onAdd} />
    </section>
  );
}
