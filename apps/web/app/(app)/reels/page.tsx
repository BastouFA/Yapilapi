'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Avatar, EmptyState, Icon, Skeleton } from '@yapilapi/design-system';
import type { Post } from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';
import { CommentsSheet } from '@/components/PostList';
import { useSession } from '../../providers';

/**
 * Reels: short vertical videos, one per screen. The one on screen plays
 * (muted until you turn sound on) and loops; scroll or use ↑/↓ for the next.
 * Like, comment and share from the side; tap the video to pause.
 */
export default function Reels() {
  const { toast } = useSession();
  const start = useSearchParams().get('start');
  const [items, setItems] = useState<Post[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [muted, setMuted] = useState(true);
  const [commentsFor, setCommentsFor] = useState<Post | null>(null);
  const loading = useRef(false);
  const list = useRef<HTMLDivElement>(null);

  const more = useCallback(
    async (c?: string | null) => {
      if (loading.current) return;
      loading.current = true;
      try {
        const r = await api.reels(c ?? undefined);
        setItems((cur) => [...(cur ?? []), ...r.items.filter((x) => !cur?.some((y) => y.id === x.id))]);
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
    void (async () => {
      // Opening a particular reel (from a post or a link) puts it first.
      const first = start
        ? await api.posts.get(start).then(
            (r) => (r.post.format === 'reel' ? [r.post] : []),
            () => [],
          )
        : [];
      setItems(first);
      await more();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [start]);

  const patch = (id: string, fn: (p: Post) => Post) => setItems((cur) => cur?.map((p) => (p.id === id ? fn(p) : p)) ?? cur);
  async function like(p: Post) {
    const liked = !p.viewer.liked;
    patch(p.id, (x) => ({ ...x, viewer: { ...x.viewer, liked }, counts: { ...x.counts, likes: x.counts.likes + (liked ? 1 : -1) } }));
    try {
      const r = liked ? await api.posts.like(p.id) : await api.posts.unlike(p.id);
      patch(p.id, (x) => ({ ...x, counts: { ...x.counts, likes: r.likes } }));
    } catch (e) {
      patch(p.id, () => p);
      toast(errorMessage(e));
    }
  }
  async function share(p: Post) {
    const url = `${location.origin}/reels?start=${p.id}`;
    try {
      if (navigator.share) await navigator.share({ title: `${p.author.displayName} on YAPILAPI`, url });
      else {
        await navigator.clipboard.writeText(url);
        toast('Link copied');
      }
    } catch {
      /* the person closed the share sheet */
    }
  }

  if (items === null) return <Skeleton height={600} />;
  if (!items.length)
    return (
      <div className="yp-shell__inner">
        <div className="yp-topbar">
          <h1>Reels</h1>
        </div>
        <EmptyState title="No reels yet" body="Short videos from people you follow and topics you like show up here." />
        <Link href="/create?mode=reel" className="yp-btn yp-btn--primary" style={{ alignSelf: 'center' }}>
          Make a reel
        </Link>
      </div>
    );

  return (
    <div
      className="reels"
      ref={list}
      onKeyDown={(e) => {
        if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
        e.preventDefault();
        list.current?.scrollBy({ top: (e.key === 'ArrowDown' ? 1 : -1) * list.current.clientHeight, behavior: 'smooth' });
      }}
    >
      <h1 className="yp-visually-hidden">Reels</h1>
      {items.map((p, i) => (
        <Reel
          key={p.id}
          post={p}
          muted={muted}
          onToggleMute={() => setMuted((m) => !m)}
          onLike={() => like(p)}
          onComments={() => setCommentsFor(p)}
          onShare={() => share(p)}
          onVisible={() => {
            if (i >= items.length - 2 && cursor) void more(cursor);
          }}
        />
      ))}
      {!cursor ? <p className="reels__end">You&apos;re all caught up.</p> : null}
      {commentsFor ? (
        <CommentsSheet
          post={commentsFor}
          onClose={() => setCommentsFor(null)}
          onAdded={() => patch(commentsFor.id, (x) => ({ ...x, counts: { ...x.counts, comments: x.counts.comments + 1 } }))}
        />
      ) : null}
    </div>
  );
}

function Reel({
  post,
  muted,
  onToggleMute,
  onLike,
  onComments,
  onShare,
  onVisible,
}: {
  post: Post;
  muted: boolean;
  onToggleMute: () => void;
  onLike: () => void;
  onComments: () => void;
  onShare: () => void;
  onVisible: () => void;
}) {
  const box = useRef<HTMLElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const media = post.media[0];
  const src = (media?.variants as Record<string, string> | undefined)?.mp4 ?? media?.url;

  // Play only the reel that is mostly on screen.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        const v = video.current;
        if (!v) return;
        if (entry!.intersectionRatio >= 0.6) {
          onVisible();
          void v.play().then(
            () => setPlaying(true),
            () => setPlaying(false),
          );
        } else {
          v.pause();
          setPlaying(false);
        }
      },
      { threshold: [0, 0.6, 1] },
    );
    io.observe(el);
    return () => io.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <article ref={box} className="reel" aria-label={`Reel by ${post.author.displayName}`}>
      {src ? (
        <video
          ref={video}
          className="reel__video"
          src={src}
          poster={media?.posterUrl ?? undefined}
          muted={muted}
          loop
          playsInline
          preload="metadata"
          aria-label={media?.altText || post.body || `Video by ${post.author.displayName}`}
          onClick={() => {
            const v = video.current;
            if (!v) return;
            if (v.paused) void v.play().then(() => setPlaying(true));
            else {
              v.pause();
              setPlaying(false);
            }
          }}
        />
      ) : null}
      {!playing ? (
        <span className="reel__paused" aria-hidden>
          ▶
        </span>
      ) : null}
      <div className="reel__info">
        <Link href={`/u/${post.author.username}`} className="reel__author">
          <Avatar name={post.author.displayName} src={post.author.avatarUrl} size="sm" />
          <bdi>{post.author.displayName}</bdi>
        </Link>
        {post.body ? (
          <p className="reel__caption" dir="auto">
            {post.body}
          </p>
        ) : null}
      </div>
      <div className="reel__actions">
        <button type="button" onClick={onLike} aria-pressed={post.viewer.liked} aria-label={`${post.viewer.liked ? 'Unlike' : 'Like'}, ${post.counts.likes}`}>
          <Icon name="heart" filled={post.viewer.liked} size={28} />
          <span>{post.counts.likes || ''}</span>
        </button>
        <button type="button" onClick={onComments} aria-label={`Comments, ${post.counts.comments}`}>
          <Icon name="message" size={28} />
          <span>{post.counts.comments || ''}</span>
        </button>
        <button type="button" onClick={onShare} aria-label="Share">
          <Icon name="send" size={28} />
        </button>
        <button type="button" onClick={onToggleMute} aria-pressed={!muted} aria-label={muted ? 'Turn sound on' : 'Turn sound off'}>
          <span className="reel__sound">{muted ? 'Sound off' : 'Sound on'}</span>
        </button>
      </div>
    </article>
  );
}
