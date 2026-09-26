'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Avatar, EmptyState, Icon, Menu, Skeleton, TaggedText } from '@yapilapi/design-system';
import type { Post } from '@yapilapi/shared';
import { NextLink } from '@/lib/link';
import { api, errorMessage } from '@/lib/api';
import { CommentsSheet, PostList, ReportSheet } from '@/components/PostList';
import { JoinNote, NeedsAccount } from '@/components/SignedOut';
import { useSession } from '../../providers';

type AuthorStats = Record<string, { followers: number; following: boolean }>;

/**
 * Reels: short vertical videos, one per screen. The reel on screen plays
 * (muted until you turn sound on) and loops; scroll or ↑/↓ for the next.
 * Double-tap to like; the side rail has like, comments, repost, save, share,
 * duet or remix, and more; follow the author from their picture. Duets play
 * side by side with the original; reels using another sound play that sound.
 */
function Reels() {
  const { toast, me, locale } = useSession();
  const router = useRouter();
  const start = useSearchParams().get('start');
  const [items, setItems] = useState<Post[] | null>(null);
  const [authors, setAuthors] = useState<AuthorStats>({});
  const [cursor, setCursor] = useState<string | null>(null);
  const [muted, setMuted] = useState(true);
  const [commentsFor, setCommentsFor] = useState<Post | null>(null);
  const [reporting, setReporting] = useState<Post | null>(null);
  const loading = useRef(false);
  const list = useRef<HTMLDivElement>(null);
  const compact = new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 });

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

  async function toggle(p: Post, what: 'like' | 'repost' | 'save', force?: boolean) {
    const on = force ?? !(what === 'like' ? p.viewer.liked : what === 'repost' ? p.viewer.reposted : p.viewer.saved);
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
        toast(on ? 'Reposted to your followers' : 'Repost removed');
      } else {
        await (on ? api.posts.save(p.id) : api.posts.unsave(p.id));
        toast(on ? 'Saved' : 'Removed from saved');
      }
    } catch (e) {
      patch(p.id, () => p);
      toast(errorMessage(e));
    }
  }

  async function follow(authorId: string, name: string) {
    setAuthors((a) => ({ ...a, [authorId]: { followers: (a[authorId]?.followers ?? 0) + 1, following: true } }));
    try {
      await api.users.follow(authorId);
      toast(`Following ${name}`);
    } catch (e) {
      setAuthors((a) => ({ ...a, [authorId]: { followers: Math.max(0, (a[authorId]?.followers ?? 1) - 1), following: false } }));
      toast(errorMessage(e));
    }
  }

  async function setAllowRemix(p: Post, allowRemix: boolean) {
    patch(p.id, (x) => ({ ...x, allowRemix }));
    try {
      await api.posts.setAllowRemix(p.id, allowRemix);
      toast(allowRemix ? 'People can duet and remix this reel' : 'Duets and remixes are off for this reel');
    } catch (e) {
      patch(p.id, (x) => ({ ...x, allowRemix: !allowRemix }));
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
      <button
        type="button"
        className="reels__sound"
        onClick={() => setMuted((m) => !m)}
        aria-pressed={!muted}
        aria-label={muted ? 'Turn sound on' : 'Turn sound off'}
      >
        <Icon name={muted ? 'volume-off' : 'volume'} size={20} />
      </button>
      {items.map((p, i) => {
        const a = authors[p.author.id];
        const mine = p.author.id === me?.id;
        return (
          <article key={p.id} className="reel" aria-label={`Reel by ${p.author.displayName}`}>
            <ReelVideo
              post={p}
              muted={muted}
              onDoubleTap={() => void toggle(p, 'like', true)}
              onVisible={() => {
                if (i >= items.length - 2 && cursor) void more(cursor);
              }}
              onWatched={() => {
                if (mine) return;
                void api.posts.view(p.id).then(
                  (r) => setItems((cur) => cur?.map((x) => (x.id === p.id ? { ...x, counts: { ...x.counts, views: r.views } } : x)) ?? cur),
                  () => {},
                );
              }}
            />
            <div className="reel__info">
              <div className="reel__byline">
                <Link href={`/u/${p.author.username}`} className="reel__author">
                  <bdi>{p.author.displayName}</bdi>
                </Link>
                {!mine && a && !a.following ? (
                  <button type="button" className="reel__follow" onClick={() => follow(p.author.id, p.author.displayName)}>
                    Follow
                  </button>
                ) : null}
              </div>
              <span className="reel__stats">
                {[
                  p.counts.views ? `${compact.format(p.counts.views)} ${p.counts.views === 1 ? 'view' : 'views'}` : null,
                  a ? `${compact.format(a.followers)} ${a.followers === 1 ? 'follower' : 'followers'}` : null,
                  a?.following && !mine ? 'Following' : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
              {p.remixOf ? <RemixCredit remix={p.remixOf} /> : null}
              {p.body ? <Caption text={p.body} /> : null}
              {p.sound ? (
                <Link href={`/sounds/${p.sound.id}`} className="reel__soundlink">
                  <Icon name="music" size={14} />
                  <bdi>{p.sound.title}</bdi>
                </Link>
              ) : null}
              {p.topics.length ? (
                <div className="reel__tags">
                  {p.topics.map((t) => (
                    <Link key={t} href={`/t/${encodeURIComponent(t)}`}>
                      <bdi>#{t}</bdi>
                    </Link>
                  ))}
                </div>
              ) : null}
            </div>
            <div className="reel__rail">
              <Link href={`/u/${p.author.username}`} className="reel__avatar" aria-label={`${p.author.displayName}'s profile`}>
                <Avatar name={p.author.displayName} src={p.author.avatarUrl} size="md" />
              </Link>
              <RailButton
                label={p.viewer.liked ? 'Unlike' : 'Like'}
                pressed={p.viewer.liked}
                count={p.counts.likes}
                fmt={compact}
                onClick={() => toggle(p, 'like')}
                tone="like"
              >
                <Icon name="heart" filled={p.viewer.liked} size={26} />
              </RailButton>
              <RailButton label="Comments" count={p.counts.comments} fmt={compact} onClick={() => setCommentsFor(p)}>
                <Icon name="message" size={26} />
              </RailButton>
              {!mine && p.visibility === 'public' ? (
                <RailButton
                  label={p.viewer.reposted ? 'Undo repost' : 'Repost'}
                  pressed={p.viewer.reposted}
                  count={p.counts.reposts}
                  fmt={compact}
                  onClick={() => toggle(p, 'repost')}
                  tone="repost"
                >
                  <Icon name="repost" size={26} />
                </RailButton>
              ) : null}
              <RailButton label={p.viewer.saved ? 'Remove from saved' : 'Save'} pressed={p.viewer.saved} onClick={() => toggle(p, 'save')} tone="save">
                <Icon name="bookmark" filled={p.viewer.saved} size={26} />
              </RailButton>
              {p.allowRemix && p.visibility === 'public' ? (
                <div className="reel__remix">
                  <Menu
                    label="Duet or remix"
                    icon="duet"
                    actions={[
                      { label: 'Duet', icon: 'duet', onSelect: () => router.push(`/create?mode=reel&remixOf=${p.id}&remixMode=duet`) },
                      { label: 'Remix with this sound', icon: 'music', onSelect: () => router.push(`/create?mode=reel&remixOf=${p.id}&remixMode=remix`) },
                      ...(p.counts.remixes
                        ? [
                            {
                              label: `See remixes (${compact.format(p.counts.remixes)})`,
                              icon: 'repost' as const,
                              onSelect: () => router.push(`/reels/${p.id}/remixes`),
                            },
                          ]
                        : []),
                    ]}
                  />
                  <span className="reel__count">{p.counts.remixes ? compact.format(p.counts.remixes) : ''}</span>
                </div>
              ) : null}
              <RailButton label="Share" onClick={() => share(p)}>
                <Icon name="send" size={26} />
              </RailButton>
              <div className="reel__more">
                <Menu
                  label="More"
                  actions={[
                    {
                      label: 'Not interested',
                      icon: 'eye',
                      onSelect: async () => {
                        await api.feedback({ signal: 'not_interested', postId: p.id }).catch(() => {});
                        setItems((cur) => cur?.filter((x) => x.id !== p.id) ?? cur);
                        toast("We'll show fewer like this.");
                      },
                    },
                    {
                      label: 'Copy link',
                      icon: 'link',
                      onSelect: async () => {
                        await navigator.clipboard.writeText(`${location.origin}/reels?start=${p.id}`).catch(() => {});
                        toast('Link copied');
                      },
                    },
                    ...((!p.allowRemix || p.visibility !== 'public') && p.counts.remixes
                      ? [{ label: 'See remixes', icon: 'repost' as const, onSelect: () => router.push(`/reels/${p.id}/remixes`) }]
                      : []),
                    ...(mine
                      ? [
                          {
                            label: p.allowRemix ? 'Turn off duets and remixes' : 'Allow duets and remixes',
                            icon: 'duet' as const,
                            onSelect: () => void setAllowRemix(p, !p.allowRemix),
                          },
                        ]
                      : []),
                    ...(mine ? [] : [{ label: 'Report', icon: 'flag' as const, danger: true, onSelect: () => setReporting(p) }]),
                  ]}
                />
              </div>
            </div>
          </article>
        );
      })}
      {!cursor ? (
        <div className="reels__end">
          <p>You&apos;re all caught up.</p>
          <Link href="/create?mode=reel" className="yp-btn yp-btn--primary yp-btn--sm">
            Make a reel
          </Link>
        </div>
      ) : null}
      {commentsFor ? (
        <CommentsSheet
          post={commentsFor}
          onClose={() => setCommentsFor(null)}
          onAdded={() => patch(commentsFor.id, (x) => ({ ...x, counts: { ...x.counts, comments: x.counts.comments + 1 } }))}
        />
      ) : null}
      <ReportSheet target={reporting ? { type: 'post', id: reporting.id } : null} onClose={() => setReporting(null)} />
    </div>
  );
}

function RailButton({
  label,
  pressed,
  count,
  fmt,
  onClick,
  tone,
  children,
}: {
  label: string;
  pressed?: boolean;
  count?: number;
  fmt?: Intl.NumberFormat;
  onClick: () => void;
  tone?: 'like' | 'repost' | 'save';
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className={`reel__btn${tone ? ` reel__btn--${tone}` : ''}`}
      onClick={onClick}
      aria-pressed={pressed}
      aria-label={count !== undefined ? `${label}, ${count}` : label}
    >
      <span className="reel__disc">{children}</span>
      {count !== undefined ? <span className="reel__count">{count ? fmt?.format(count) : ''}</span> : null}
    </button>
  );
}

function Caption({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 90;
  return (
    <p className={`reel__caption${open ? ' reel__caption--open' : ''}`} dir="auto">
      <TaggedText text={open || !long ? text : `${text.slice(0, 90)}…`} linkAs={NextLink} />{' '}
      {long ? (
        <button type="button" className="reel__more-text" onClick={() => setOpen((o) => !o)}>
          {open ? 'less' : 'more'}
        </button>
      ) : null}
    </p>
  );
}

/** "Duet with @name" or "Remix of @name", linking to the original reel. */
function RemixCredit({ remix }: { remix: NonNullable<Post['remixOf']> }) {
  const verb = remix.mode === 'duet' ? 'Duet with' : 'Remix of';
  if (!remix.post)
    return (
      <span className="reel__credit">
        <Icon name="duet" size={14} />
        {verb} a reel that is no longer available
      </span>
    );
  return (
    <Link href={`/reels?start=${remix.post.id}`} className="reel__credit">
      <Icon name="duet" size={14} />
      {verb} <bdi>@{remix.post.author.username}</bdi>
    </Link>
  );
}

/** Keep a companion (the duet's original, or a borrowed sound) in step with the reel's own video. */
function follow(v: HTMLVideoElement, other: HTMLMediaElement | null, event: 'play' | 'pause' | 'time') {
  if (!other) return;
  if (event === 'pause') return other.pause();
  const target = other.duration && Number.isFinite(other.duration) ? v.currentTime % other.duration : v.currentTime;
  if (Math.abs(other.currentTime - target) > 0.35) other.currentTime = target;
  if (event === 'play' && other.paused) void other.play().catch(() => {});
}

function ReelVideo({
  post,
  muted,
  onDoubleTap,
  onVisible,
  onWatched,
}: {
  post: Post;
  muted: boolean;
  onDoubleTap: () => void;
  onVisible: () => void;
  /** Played for 2 seconds (or half of a shorter reel): counts as a view. */
  onWatched: () => void;
}) {
  const watched = useRef(false);
  const box = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [burst, setBurst] = useState(0);
  const lastTap = useRef(0);
  const tapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const media = post.media[0];
  const src = (media?.variants as Record<string, string> | undefined)?.mp4 ?? media?.url;
  // Duets play beside the original (left); reels using another sound play that sound instead of their own.
  const original = post.remixOf?.mode === 'duet' ? (post.remixOf.post?.media ?? null) : null;
  const originalSrc = original ? ((original.variants as Record<string, string> | undefined)?.mp4 ?? original.url) : null;
  const borrowed = !original && post.sound && !post.sound.original ? post.sound.audioUrl : null;
  const companion = useRef<HTMLVideoElement & HTMLAudioElement>(null);

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

  const togglePlay = () => {
    const v = video.current;
    if (!v) return;
    if (v.paused) void v.play().then(() => setPlaying(true));
    else {
      v.pause();
      setPlaying(false);
    }
  };

  return (
    <div ref={box} className={`reel__stage${originalSrc ? ' reel__stage--duet' : ''}`}>
      {originalSrc ? (
        <video
          ref={companion}
          className="reel__video reel__video--original"
          src={originalSrc}
          poster={original?.posterUrl ?? undefined}
          muted={muted}
          loop
          playsInline
          preload="metadata"
          aria-label={`Original reel by ${post.remixOf?.post?.author.displayName ?? ''}`}
          onClick={togglePlay}
        />
      ) : null}
      {borrowed ? <audio ref={companion} src={borrowed} muted={muted} loop preload="metadata" /> : null}
      {src ? (
        <video
          ref={video}
          className="reel__video"
          src={src}
          poster={media?.posterUrl ?? undefined}
          muted={muted || !!borrowed}
          loop
          playsInline
          preload="metadata"
          aria-label={media?.altText || post.body || `Video by ${post.author.displayName}`}
          onPlay={(e) => follow(e.currentTarget, companion.current, 'play')}
          onPause={(e) => follow(e.currentTarget, companion.current, 'pause')}
          onSeeked={(e) => follow(e.currentTarget, companion.current, 'time')}
          onTimeUpdate={(e) => {
            const v = e.currentTarget;
            follow(v, companion.current, 'time');
            if (v.duration) setProgress(v.currentTime / v.duration);
            if (!watched.current && v.duration && v.currentTime >= Math.min(2, v.duration / 2)) {
              watched.current = true;
              onWatched();
            }
          }}
          onClick={() => {
            // One tap pauses; a quick second tap likes instead.
            const now = Date.now();
            if (now - lastTap.current < 280) {
              if (tapTimer.current) clearTimeout(tapTimer.current);
              lastTap.current = 0;
              setBurst((b) => b + 1);
              onDoubleTap();
              return;
            }
            lastTap.current = now;
            tapTimer.current = setTimeout(togglePlay, 280);
          }}
        />
      ) : null}
      {!playing ? (
        <span className="reel__paused" aria-hidden>
          <svg viewBox="0 0 24 24" width="64" height="64">
            <path d="M8 5v14l11-7z" fill="currentColor" />
          </svg>
        </span>
      ) : null}
      {burst ? (
        <span key={burst} className="reel__burst" aria-hidden>
          <Icon name="heart" filled size={96} />
        </span>
      ) : null}
      <span className="reel__progress" aria-hidden>
        <span style={{ width: `${progress * 100}%` }} />
      </span>
    </div>
  );
}

/**
 * Reels for people with an account. Without one, a shared public reel (?start=) opens on
 * its own, readable, with its actions leading to sign in; the Reels feed itself needs an account.
 */
export default function ReelsPageClient({ start, isPublic }: { start: string | null; isPublic: boolean }) {
  const { me } = useSession();
  if (me) return <Reels />;
  if (!start || !isPublic) return <NeedsAccount title="Sign in to watch reels" body="Reels are short videos from people and communities on YAPILAPI." />;
  return <SharedReel id={start} />;
}

function SharedReel({ id }: { id: string }) {
  const load = useCallback(() => api.posts.get(id).then((r) => ({ items: [r.post], nextCursor: null })), [id]);
  return (
    <div className="yp-shell__inner">
      <div className="yp-topbar">
        <h1>Reel</h1>
      </div>
      <PostList load={load} reloadKey={id} empty="This reel isn't available. It may have been removed." />
      <JoinNote text="Join YAPILAPI to watch more reels and follow the people who make them." />
    </div>
  );
}
