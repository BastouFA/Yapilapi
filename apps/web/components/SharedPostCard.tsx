'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { Avatar, Icon } from '@yapilapi/design-system';
import { videoPoster, videoSrc, type Post } from '@yapilapi/shared';
import { api } from '@/lib/api';
import { useSession } from '@/app/providers';

/**
 * "Send to chat" writes the post's address in the message (POST /v1/posts/:id/send). Until
 * 2026-10-31 it wrote every site the server allowed, joined by commas, in front of it.
 */
const LINK = /(?:https?:\/\/[^\s/,]+,)*https?:\/\/([^\s/,]+)\/(?:reels\?start=|p\/)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i;

// yapilapi-web.onrender.com is the old web address: messages sent before the move still link there.
const OUR_HOSTS = new Set(['yapilapi.com', 'www.yapilapi.com', 'yapilapi-web.onrender.com']);

/**
 * The post or reel a message shares, when its text has one of our post addresses: its id, the
 * address, and the text left without it (the note written with it, or nothing).
 */
export function sharedPostIn(body: string | null | undefined): { id: string; href: string; rest: string } | null {
  if (!body) return null;
  const m = LINK.exec(body);
  if (!m) return null;
  const host = m[1]!.toLowerCase();
  if (!OUR_HOSTS.has(host) && (typeof window === 'undefined' || host !== window.location.host)) return null;
  const url = new URL(m[0].slice(m[0].lastIndexOf('http')));
  return { id: m[2]!.toLowerCase(), href: url.pathname + url.search, rest: body.replace(m[0], '').trim() };
}

/** Each post is asked for once while the page is open, however many messages share it. */
const posts = new Map<string, Promise<Post | null>>();
function loadPost(id: string) {
  let p = posts.get(id);
  if (!p) {
    p = api.posts
      .get(id)
      .then((r) => r.post)
      .catch(() => null);
    posts.set(id, p);
  }
  return p;
}

/**
 * A shared post inside a chat bubble, so it can be watched right there: a reel or video plays in
 * the bubble (muted until tapped, and only while on screen), a photo shows, and the name and
 * words of whoever posted it link to the whole thing. Shows nothing when the post can't be seen
 * (deleted, private, for subscribers): the message's link is still there.
 */
export function SharedPostCard({
  id,
  href,
  onMissing,
  onWatch,
}: {
  id: string;
  href: string;
  onMissing?: () => void;
  /** In a chat where people can watch together: "Watch together" on a reel or video starts (or joins) a session with it. */
  onWatch?: () => void;
}) {
  const { t, dataSaver } = useSession();
  const [post, setPost] = useState<Post | null | undefined>(undefined);
  useEffect(() => {
    let on = true;
    void loadPost(id).then((p) => {
      if (!on) return;
      setPost(p);
      if (!p) onMissing?.();
    });
    return () => {
      on = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  if (post === undefined) return <div className="shared-post shared-post--loading" aria-hidden />;
  if (!post) return null;
  const media = post.media[0];
  const reel = post.format === 'reel';
  const words = post.body.trim();
  return (
    <div className={`shared-post${reel ? ' shared-post--reel' : ''}`}>
      {media?.kind === 'video' ? (
        <SharedVideo
          src={videoSrc(media, dataSaver.active)}
          poster={videoPoster(media, dataSaver.active)}
          label={reel ? t('chat.sharedReel') : t('m.chat.video')}
        />
      ) : media?.kind === 'image' ? (
        <Link href={href} className="shared-post__media">
          <img src={media.variants?.medium ?? media.url} alt={media.altText ?? ''} loading="lazy" decoding="async" />
        </Link>
      ) : null}
      <Link href={href} className="shared-post__info">
        <Avatar src={post.author.avatarUrl} name={post.author.displayName} size="sm" />
        <span className="shared-post__text">
          <strong>{post.author.displayName}</strong>
          {words ? <span dir="auto">{words}</span> : null}
        </span>
      </Link>
      <div className="shared-post__actions">
        <Link href={href} className="shared-post__open">
          {reel ? t('chat.watchReel') : t('chat.openPost')}
          <Icon name="chevron-right" size={16} />
        </Link>
        {onWatch && media?.kind === 'video' ? (
          <button type="button" className="shared-post__watch" onClick={onWatch}>
            <Icon name="play" size={16} />
            {t('watch.start')}
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** A video that plays muted while it's on screen (on Data saver, after a tap); the button turns the sound on or off. */
function SharedVideo({ src, poster, label }: { src: string; poster?: string; label: string }) {
  const { t, dataSaver } = useSession();
  const ref = useRef<HTMLVideoElement>(null);
  const [muted, setMuted] = useState(true);
  useEffect(() => {
    const v = ref.current;
    if (!v || dataSaver.active || typeof IntersectionObserver === 'undefined') return;
    const seen = new IntersectionObserver(
      ([e]) => {
        if (e?.isIntersecting) void v.play().catch(() => undefined);
        else v.pause();
      },
      { threshold: 0.5 },
    );
    seen.observe(v);
    return () => seen.disconnect();
  }, [dataSaver.active]);
  const sound = () => {
    const v = ref.current;
    if (!v) return;
    const on = muted || v.paused;
    v.muted = !on;
    setMuted(!on);
    if (v.paused) void v.play().catch(() => undefined);
  };
  return (
    <div className="shared-post__media shared-post__video">
      <video
        ref={ref}
        src={src}
        poster={poster}
        muted={muted}
        loop
        playsInline
        preload={dataSaver.active ? 'none' : 'metadata'}
        aria-label={label}
        onClick={sound}
      />
      <button type="button" className="shared-post__sound" aria-label={muted ? t('m.reels.soundOn') : t('m.reels.soundOff')} onClick={sound}>
        <Icon name={muted ? 'volume-off' : 'volume'} size={18} />
      </button>
    </div>
  );
}
