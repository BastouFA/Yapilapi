'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { EmptyState, Skeleton } from '@yapilapi/design-system';
import type { Post, ReelHighlight, ReelMoment } from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';
import { CommentsSheet, ReportSheet } from '@/components/PostList';
import { SaveToSheet } from '@/components/Boards';
import { useSession } from '@/app/providers';
import { ReelItem, type ReelViewerApi } from './ReelItem';
import { HighlightsSheet, OptionsSheet, ShareSheet } from './sheets';
import { prefersReducedMotion, readPrefs, writePrefs, DEFAULT_PREFS, type ReelPrefs } from './prefs';

type AuthorStats = Record<string, { followers: number; following: boolean }>;
type Sheet =
  | { kind: 'comments'; post: Post; atMs: number | null }
  | { kind: 'share'; post: Post }
  | { kind: 'options'; post: Post }
  | { kind: 'highlights'; post: Post }
  | { kind: 'report'; post: Post }
  | { kind: 'saveTo'; post: Post }
  | null;

/** Keys that belong to what has focus (typing, a menu), not to the viewer. */
const typing = (el: EventTarget | null) => el instanceof HTMLElement && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));

/**
 * Reels: one short video per screen, between the top of the screen and the navigation dock on
 * phones, and a centred 9:16 column with its actions beside it on larger screens. Scroll, swipe,
 * ↑/↓ or J/K for the next one; the one on screen plays (muted until you turn sound on) and loops.
 * `?start=<id>` opens a reel first, and the address follows the reel on screen so coming back
 * returns to it.
 */
export function ReelsViewer() {
  const { toast, me, t, dataSaver } = useSession();
  const router = useRouter();
  const start = useSearchParams().get('start');
  const [items, setItems] = useState<Post[] | null>(null);
  const [authors, setAuthors] = useState<AuthorStats>({});
  const [cursor, setCursor] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const [muted, setMuted] = useState(true);
  const [clear, setClear] = useState(false);
  const [prefs, setPrefsState] = useState<ReelPrefs>(DEFAULT_PREFS);
  const [sheet, setSheet] = useState<Sheet>(null);
  const [moments, setMoments] = useState<Record<string, ReelMoment[]>>({});
  const [announce, setAnnounce] = useState('');
  const [frameRatio, setFrameRatio] = useState(9 / 16);
  const [pageVisible, setPageVisible] = useState(true);
  const loading = useRef(false);
  const list = useRef<HTMLDivElement>(null);
  const videos = useRef(new Map<string, HTMLVideoElement>());
  const watched = useRef(new Set<string>());
  // The address we set ourselves as reels scroll by: not a request to open another reel.
  const synced = useRef<string | null>(null);

  useEffect(() => setPrefsState(readPrefs()), []);
  const setPrefs = (p: Partial<ReelPrefs>) =>
    setPrefsState((cur) => {
      const next = { ...cur, ...p };
      writePrefs(next);
      return next;
    });
  const saver = prefs.quality === 'saver' || (prefs.quality === 'auto' && dataSaver.active);

  const more = useCallback(
    async (c?: string | null) => {
      if (loading.current) return;
      loading.current = true;
      try {
        const r = await api.reels(c ?? undefined);
        setItems((cur) => [...(cur ?? []), ...r.items.filter((x) => !cur?.some((y) => y.id === x.id))]);
        setAuthors((a) => ({ ...a, ...r.authors }));
        setCursor(r.nextCursor);
      } catch (e) {
        setItems((cur) => cur ?? []);
        toast(errorMessage(e));
      } finally {
        loading.current = false;
      }
    },
    [toast],
  );

  useEffect(() => {
    if (start && start === synced.current) return;
    let live = true;
    void (async () => {
      // Opening a particular reel (from a post, a grid or a link) puts it first.
      const first = start
        ? await api.posts.get(start).then(
            (r) => (r.post.format === 'reel' ? [r.post] : []),
            () => [],
          )
        : [];
      if (!live) return;
      setItems(first);
      setActive(0);
      list.current?.scrollTo({ top: 0 });
      await more();
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [start]);

  // The reel on screen is the one mostly in view.
  const count = items?.length ?? 0;
  useEffect(() => {
    const root = list.current;
    if (!root || !count) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) if (e.isIntersecting && e.intersectionRatio >= 0.6) setActive(Number((e.target as HTMLElement).dataset.index));
      },
      { root, threshold: [0.6] },
    );
    root.querySelectorAll<HTMLElement>('.reel').forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [count]);

  // The frame's shape decides whether a video fills it or shows whole.
  useEffect(() => {
    const root = list.current;
    if (!root) return;
    const wide = window.matchMedia('(min-width: 900px)');
    const measure = () => setFrameRatio(wide.matches ? 9 / 16 : root.clientWidth / Math.max(1, root.clientHeight));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(root);
    return () => ro.disconnect();
  }, [count]);

  useEffect(() => {
    const on = () => setPageVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);

  const current = items?.[active];
  // Load more near the end; the moments of the reel on screen; the address follows it.
  useEffect(() => {
    if (!items || !current) return;
    if (active >= items.length - 2 && cursor) void more(cursor);
    if (current.counts.comments > 0 && !moments[current.id])
      api.posts.momentComments(current.id).then(
        (r) => setMoments((m) => ({ ...m, [current.id]: r.items })),
        () => setMoments((m) => ({ ...m, [current.id]: [] })),
      );
    const url = `/reels?start=${current.id}`;
    if (`${location.pathname}${location.search}` !== url) {
      synced.current = current.id;
      window.history.replaceState(window.history.state, '', url);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, current?.id, cursor]);

  const go = (i: number) => {
    const root = list.current;
    if (!root || !items) return;
    const to = Math.max(0, Math.min(items.length - (cursor ? 1 : 0), i));
    root.scrollTo({ top: to * root.clientHeight, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  };

  const patch = (id: string, fn: (p: Post) => Post) => setItems((cur) => cur?.map((p) => (p.id === id ? fn(p) : p)) ?? cur);

  async function toggle(p: Post, what: 'like' | 'repost' | 'save', force?: boolean) {
    const was = what === 'like' ? p.viewer.liked : what === 'repost' ? p.viewer.reposted : p.viewer.saved;
    const on = force ?? !was;
    if (on === was) return;
    const d = on ? 1 : -1;
    patch(p.id, (x) => ({
      ...x,
      viewer: { ...x.viewer, ...(what === 'like' ? { liked: on } : what === 'repost' ? { reposted: on } : { saved: on }) },
      counts: { ...x.counts, ...(what === 'like' ? { likes: x.counts.likes + d } : what === 'repost' ? { reposts: x.counts.reposts + d } : {}) },
    }));
    try {
      if (what === 'like') {
        const r = on ? await api.posts.like(p.id) : await api.posts.unlike(p.id);
        patch(p.id, (x) => ({ ...x, counts: { ...x.counts, likes: r.likes } }));
      } else if (what === 'repost') {
        const r = on ? await api.posts.repost(p.id) : await api.posts.unrepost(p.id);
        patch(p.id, (x) => ({ ...x, counts: { ...x.counts, reposts: r.reposts } }));
        toast(t(on ? 'reel.share.reposted' : 'reel.share.repostRemoved'));
      } else {
        await (on ? api.posts.save(p.id) : api.posts.unsave(p.id));
        if (on) toast(t('reel.saved'), { label: t('m.boards.saveTo'), onClick: () => setSheet({ kind: 'saveTo', post: p }) });
        else toast(t('reel.unsaved'));
      }
    } catch (e) {
      patch(p.id, () => p);
      toast(errorMessage(e));
    }
  }

  async function follow(p: Post) {
    const id = p.author.id;
    setAuthors((a) => ({ ...a, [id]: { followers: (a[id]?.followers ?? 0) + 1, following: true } }));
    try {
      await api.users.follow(id);
      toast(t('reel.followed', { name: p.author.displayName }));
    } catch (e) {
      setAuthors((a) => ({ ...a, [id]: { followers: Math.max(0, (a[id]?.followers ?? 1) - 1), following: false } }));
      toast(errorMessage(e));
    }
  }

  const copyLink = async (p: Post) => {
    const url = `${location.origin}/reels?start=${p.id}`;
    try {
      await navigator.clipboard.writeText(url);
      toast(t('reel.share.copied'));
    } catch {
      toast(url);
    }
  };

  /** The reel as a video with a small YAPILAPI watermark and an end card, rendered once on the server. */
  async function downloadToShare(p: Post) {
    toast(t('share.video.preparing'));
    try {
      let state = await api.posts.shareVideo(p.id);
      for (let i = 0; i < 90 && (state.status === 'queued' || state.status === 'processing'); i++) {
        await new Promise((r) => setTimeout(r, 2000));
        state = await api.posts.shareVideoStatus(p.id);
      }
      if (state.status !== 'ready' || !state.url) {
        toast(t('share.video.failed'));
        return;
      }
      // Media is served through this origin too (/media/…), which lets the browser save it under our file name.
      const url = new URL(state.url, location.origin);
      const a = document.createElement('a');
      a.href = url.pathname.startsWith('/media/') ? url.pathname : state.url;
      a.download = state.fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (e) {
      toast(errorMessage(e));
    }
  }

  async function setAllowRemix(p: Post, allowRemix: boolean) {
    patch(p.id, (x) => ({ ...x, allowRemix }));
    try {
      await api.posts.setAllowRemix(p.id, allowRemix);
      toast(t(allowRemix ? 'reel.remixes.on' : 'reel.remixes.off'));
    } catch (e) {
      patch(p.id, (x) => ({ ...x, allowRemix: !allowRemix }));
      toast(errorMessage(e));
    }
  }

  async function leaveCollab(p: Post) {
    try {
      await api.posts.leaveCollab(p.id);
      patch(p.id, (x) => ({ ...x, collaborators: x.collaborators?.filter((c) => c.id !== me?.id), viewer: { ...x.viewer, collab: undefined } }));
      toast(t('reel.collab.left'));
    } catch (e) {
      toast(errorMessage(e));
    }
  }

  const seekTo = (id: string, ms: number) => {
    const v = videos.current.get(id);
    if (!v) return;
    v.currentTime = ms / 1000;
    void v.play().catch(() => {});
  };

  const pip = async () => {
    const v = current && videos.current.get(current.id);
    if (!v) return;
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await v.requestPictureInPicture();
    } catch (e) {
      toast(errorMessage(e));
    }
  };
  const pipAvailable = typeof document !== 'undefined' && !!document.pictureInPictureEnabled && !!current && !current.remixOf;

  const toggleMute = () => {
    setMuted((m) => !m);
    if (!prefs.soundHintSeen) setPrefs({ soundHintSeen: true });
  };

  // One stable object for every reel: its methods always call the latest versions of the above.
  const impl = useRef<ReelViewerApi>(null!);
  impl.current = {
    like: (p, force) => void toggle(p, 'like', force),
    follow: (p) => void follow(p),
    comments: (p, atMs) => setSheet({ kind: 'comments', post: p, atMs }),
    share: (p) => setSheet({ kind: 'share', post: p }),
    options: (p) => setSheet({ kind: 'options', post: p }),
    save: (p) => void toggle(p, 'save'),
    saveTo: me ? (p) => setSheet({ kind: 'saveTo', post: p }) : undefined,
    toggleMute,
    toggleClear: () => setClear((c) => !c),
    next: () => go(active + 1),
    previous: () => go(active - 1),
    back: () => (window.history.length > 1 ? router.back() : router.push('/home')),
    announce: (text) => setAnnounce(text),
    soundHintSeen: () => setPrefs({ soundHintSeen: true }),
    watched: (p) => {
      if (p.author.id === me?.id || watched.current.has(p.id)) return;
      watched.current.add(p.id);
      void api.posts.view(p.id).then(
        (r) => patch(p.id, (x) => ({ ...x, counts: { ...x.counts, views: r.views } })),
        () => {},
      );
    },
    register: (id, el) => {
      if (el) videos.current.set(id, el);
      else videos.current.delete(id);
    },
    resume: (p, positionMs, durationMs) => {
      void api.posts.resume(p.id, positionMs, durationMs).then(
        (r) => patch(p.id, (x) => ({ ...x, viewer: { ...x.viewer, resumeMs: r.resumeMs ?? undefined } })),
        () => {},
      );
    },
    clearResume: (p) => void api.posts.clearResume(p.id).catch(() => {}),
  };
  const [viewer] = useState<ReelViewerApi>(() => {
    const call =
      <K extends keyof ReelViewerApi>(k: K) =>
      (...args: unknown[]) =>
        (impl.current[k] as ((...a: unknown[]) => void) | undefined)?.(...args);
    return {
      like: call('like'),
      follow: call('follow'),
      comments: call('comments'),
      share: call('share'),
      options: call('options'),
      save: call('save'),
      saveTo: (p: Post) => impl.current.saveTo?.(p),
      toggleMute: call('toggleMute'),
      toggleClear: call('toggleClear'),
      next: call('next'),
      previous: call('previous'),
      back: call('back'),
      announce: call('announce'),
      soundHintSeen: call('soundHintSeen'),
      watched: call('watched'),
      register: call('register'),
      resume: call('resume'),
      clearResume: call('clearResume'),
    } as ReelViewerApi;
  });

  // Keys: ↑/↓ or K/J move between reels, Space plays or pauses, ←/→ move 5 seconds, M sound, C clear view.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || typing(e.target)) return;
      if (document.querySelector('.yp-sheet__backdrop')) return;
      const target = e.target as HTMLElement | null;
      const onControl = !!target?.closest('button, a, [role="slider"], [role="menu"]');
      const v = current ? videos.current.get(current.id) : undefined;
      switch (e.key) {
        case 'ArrowDown':
        case 'j':
        case 'J':
          e.preventDefault();
          impl.current.next();
          break;
        case 'ArrowUp':
        case 'k':
        case 'K':
          e.preventDefault();
          impl.current.previous();
          break;
        case ' ':
          if (onControl) return;
          e.preventDefault();
          if (v) {
            // The reel's own play button does the rest (state, sign, announcement).
            const btn = list.current?.querySelector<HTMLButtonElement>('.reel--active .reel__play');
            btn?.click();
          }
          break;
        case 'ArrowLeft':
        case 'ArrowRight':
          if (!v || onControl) return;
          e.preventDefault();
          v.currentTime = Math.max(0, Math.min((v.duration || 0) - 0.1, v.currentTime + (e.key === 'ArrowRight' ? 5 : -5)));
          break;
        case 'm':
        case 'M':
          impl.current.toggleMute();
          break;
        case 'c':
        case 'C':
          setClear((c) => !c);
          break;
        case 'Escape':
          if (clear) setClear(false);
          break;
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [current, clear]);

  if (items === null)
    return (
      <div className="reels-page">
        <div className="reels reels--loading" aria-busy>
          <Skeleton height={600} />
        </div>
      </div>
    );
  if (!items.length)
    return (
      <div className="yp-shell__inner">
        <div className="yp-topbar">
          <h1>{t('m.title.reels')}</h1>
        </div>
        <EmptyState title={t('m.reels.empty.title')} body={t('m.reels.empty.body')} />
        <Link href="/create?mode=reel" className="yp-btn yp-btn--primary" style={{ alignSelf: 'center' }}>
          {t('m.reels.make')}
        </Link>
      </div>
    );

  const open = sheet;
  const closeSheet = () => setSheet(null);
  return (
    <div className="reels-page">
      <h1 className="yp-visually-hidden">{t('m.title.reels')}</h1>
      <p className="yp-visually-hidden" id="reels-keys">
        {t('reel.keys')}
      </p>
      <p className="yp-visually-hidden" aria-live="polite">
        {announce}
      </p>
      <div className={`reels${clear ? ' reels--clear' : ''}`} ref={list} aria-describedby="reels-keys">
        {items.map((p, i) => (
          <ReelItem
            key={p.id}
            post={p}
            stats={authors[p.author.id]}
            index={i}
            active={i === active}
            near={i === active + 1 || i === active - 1}
            muted={muted}
            clear={clear}
            prefs={prefs}
            saver={saver}
            frameRatio={frameRatio}
            moments={moments[p.id] ?? []}
            showSoundHint={!prefs.soundHintSeen}
            pageVisible={pageVisible}
            meId={me?.id}
            viewer={viewer}
          />
        ))}
        {!cursor ? (
          <div className="reels__end" data-index={items.length}>
            <p>{t('m.reels.caughtUp')}</p>
            <Link href="/create?mode=reel" className="yp-btn yp-btn--primary yp-btn--sm">
              {t('m.reels.make')}
            </Link>
          </div>
        ) : null}
      </div>

      {open?.kind === 'comments' ? (
        <CommentsSheet
          post={open.post}
          onClose={closeSheet}
          onCountChange={(d) => patch(open.post.id, (x) => ({ ...x, counts: { ...x.counts, comments: Math.max(0, x.counts.comments + d) } }))}
          moment={{
            atMs: open.atMs,
            seek: (ms) => {
              closeSheet();
              seekTo(open.post.id, ms);
            },
            onMoment: (c) =>
              c.atMs !== null && c.atMs !== undefined
                ? setMoments((m) => ({
                    ...m,
                    [open.post.id]: [
                      ...(m[open.post.id] ?? []),
                      { id: c.id, atMs: c.atMs!, body: c.body, likes: 0, author: { ...c.author, avatarUrl: c.author.avatarUrl ?? null } },
                    ].sort((a, b) => a.atMs - b.atMs),
                  }))
                : undefined,
          }}
        />
      ) : null}
      <ShareSheet
        post={open?.kind === 'share' ? open.post : null}
        mine={open?.post.author.id === me?.id}
        signedIn={!!me}
        onClose={closeSheet}
        onRepost={(p) => void toggle(p, 'repost')}
        onRemix={(p, mode) => router.push(`/create?mode=reel&remixOf=${p.id}&remixMode=${mode}`)}
        onRemixes={(p) => router.push(`/reels/${p.id}/remixes`)}
        onDownload={(p) => void downloadToShare(p)}
        onSaveTo={(p) => setSheet({ kind: 'saveTo', post: p })}
      />
      <OptionsSheet
        post={open?.kind === 'options' ? open.post : null}
        mine={open?.post.author.id === me?.id}
        prefs={prefs}
        onPrefs={setPrefs}
        onClose={closeSheet}
        pip={pipAvailable}
        onPip={() => void pip()}
        onNotInterested={async (p) => {
          await api.feedback({ signal: 'not_interested', postId: p.id }).catch(() => {});
          setItems((cur) => cur?.filter((x) => x.id !== p.id) ?? cur);
          toast(t('reel.notInterested.done'));
        }}
        onCopy={(p) => void copyLink(p)}
        onDownload={(p) => void downloadToShare(p)}
        onHighlights={(p) => setSheet({ kind: 'highlights', post: p })}
        onAllowRemix={(p, allow) => void setAllowRemix(p, allow)}
        onLeaveCollab={(p) => void leaveCollab(p)}
        onReport={(p) => setSheet({ kind: 'report', post: p })}
      />
      {open?.kind === 'highlights' ? (
        <HighlightsSheet
          post={open.post}
          currentMs={() => Math.round((videos.current.get(open.post.id)?.currentTime ?? 0) * 1000)}
          onClose={closeSheet}
          onSeek={(ms) => seekTo(open.post.id, ms)}
          onSaved={(p, h: ReelHighlight[]) => patch(p.id, (x) => ({ ...x, highlights: h.length ? h : undefined }))}
        />
      ) : null}
      <ReportSheet target={open?.kind === 'report' ? { type: 'post', id: open.post.id } : null} onClose={closeSheet} />
      <SaveToSheet
        post={open?.kind === 'saveTo' ? open.post : null}
        onClose={closeSheet}
        onSaved={(id) => patch(id, (x) => ({ ...x, viewer: { ...x.viewer, saved: true } }))}
      />
    </div>
  );
}
