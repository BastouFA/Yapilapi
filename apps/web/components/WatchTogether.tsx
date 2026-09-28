'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { Avatar, BottomSheet, Icon, Skeleton } from '@yapilapi/design-system';
import {
  videoPoster,
  WATCH_MAX_MEMBERS,
  type Conversation,
  type MessageKey,
  type Post,
  type PublicUser,
  type WatchSkipReason,
  type WatchSummary,
} from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';
import { useRealtime, useSession, type Session } from '@/app/providers';

/**
 * Watch together: people in a one-to-one chat or a small group watch reels and video posts at
 * the same time, react over the video and talk in the chat beside it.
 *
 * Here: the chat picker (from a reel or a video post) and the "Watching together now" banner in a
 * chat. The sync engine (useWatchSync) and the watch screen are in WatchScreen.tsx, so feeds and
 * chats that only link to a session don't load the player.
 */

type T = Session['t'];
type TP = Session['tp'];

/** A post has something to watch together: a video. */
export const hasVideo = (p: Post) => p.media.some((m) => m.kind === 'video');

/** A small picture for a post: its video's poster or its first photo, in the smallest size. */
export function postThumb(p: Post): string | null {
  const m = p.media.find((x) => x.kind === 'video') ?? p.media.find((x) => x.kind === 'image');
  if (!m) return null;
  if (m.kind === 'video') return videoPoster(m, true) ?? null;
  return m.variants?.thumb ?? m.variants?.medium ?? m.url;
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** The post in a pasted link (`/reels?start=<id>`, `/p/<id>`) or a bare id; null when there's none. */
export function postIdFrom(text: string): string | null {
  const s = text.trim();
  if (!s) return null;
  try {
    const u = new URL(s, 'https://yapilapi.invalid');
    const start = u.searchParams.get('start');
    if (start && UUID.test(start)) return UUID.exec(start)![0].toLowerCase();
    const path = /\/(?:p|reels)\/([0-9a-f-]{36})(?:\/|$)/i.exec(u.pathname);
    if (path && UUID.test(path[1]!)) return path[1]!.toLowerCase();
  } catch {
    /* not a link: look for an id in the text */
  }
  const m = UUID.exec(s);
  return m ? m[0].toLowerCase() : null;
}

/** What didn't go in the queue, and why, in one sentence per reason. */
export function addNotes(t: T, skipped: { reason: WatchSkipReason }[]): string | null {
  const reasons = [...new Set(skipped.map((s) => s.reason))];
  return reasons.length ? reasons.map((r) => t(`watch.skip.${r}` as MessageKey)).join(' ') : null;
}

/** Items passed over when their turn came. */
export function playbackNotes(t: T, tp: TP, skipped: WatchSkipReason[]): string | null {
  const hidden = skipped.filter((r) => r === 'not_visible').length;
  const parts: string[] = [];
  if (hidden) parts.push(tp('watch.skipped', hidden));
  if (skipped.some((r) => r !== 'not_visible')) parts.push(t('watch.skip.unavailable'));
  return parts.length ? parts.join(' ') : null;
}

/** A chat's name: its title, or the other people in it. */
export function chatName(c: { title: string | null; members: PublicUser[] }, meId?: string): string {
  return (
    c.title ||
    c.members
      .filter((m) => m.id !== meId)
      .map((m) => m.displayName)
      .join(', ') ||
    c.members[0]?.displayName ||
    ''
  );
}

// ── Starting from a reel or a video post ──────────────────────────────────

/**
 * Pick a chat to watch with: one-to-one chats and groups of up to 8 people. Starting puts the
 * post in the queue (or joins the session already running there) and opens the watch screen.
 */
export function WatchChatPicker({ post, onClose }: { post: Post | null; onClose: () => void }) {
  const { me, t, toast } = useSession();
  const router = useRouter();
  const [chats, setChats] = useState<Conversation[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const open = !!post;

  useEffect(() => {
    if (!open) return;
    let live = true;
    setChats(null);
    api.conversations.list().then(
      (r) => live && setChats(r.items.filter((c) => c.kind === 'direct' || c.kind === 'group')),
      (e) => {
        if (!live) return;
        setChats([]);
        toast(errorMessage(e));
      },
    );
    return () => {
      live = false;
    };
  }, [open, toast]);

  async function start(c: Conversation) {
    if (!post) return;
    setBusy(c.id);
    try {
      const r = await api.watch.start(c.id, [post.id]);
      const note = addNotes(t, r.skipped);
      if (note) toast(note);
      onClose();
      router.push(`/watch/${r.session.id}`);
    } catch (e) {
      toast(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <BottomSheet open={open} onClose={onClose} title={t('watch.pickChat')}>
      <p className="muted watch-pick__hint">{t('watch.startHint')}</p>
      <p className="muted watch-pick__hint">{t('watch.pickChatHint')}</p>
      {chats === null ? (
        <Skeleton height={160} />
      ) : chats.length ? (
        <ul className="watch-pick">
          {chats.map((c) => {
            const tooBig = c.members.length > WATCH_MAX_MEMBERS;
            const others = c.members.filter((m) => m.id !== me?.id);
            const face = others[0] ?? c.members[0];
            return (
              <li key={c.id}>
                <button
                  type="button"
                  className="watch-pick__row"
                  disabled={tooBig || !!busy}
                  aria-describedby={tooBig ? `watch-big-${c.id}` : undefined}
                  aria-busy={busy === c.id || undefined}
                  onClick={() => void start(c)}
                >
                  {face ? <Avatar name={c.title || face.displayName} src={c.kind === 'direct' ? face.avatarUrl : null} size="sm" /> : null}
                  <span className="watch-pick__text">
                    <bdi className="watch-pick__name">{chatName(c, me?.id)}</bdi>
                    {tooBig ? (
                      <span className="muted watch-pick__note" id={`watch-big-${c.id}`}>
                        {t('watch.chatTooBig')}
                      </span>
                    ) : null}
                  </span>
                  {busy === c.id ? <span className="yp-btn__spin" aria-hidden /> : <Icon name="chevron-right" size={18} />}
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="muted">{t('watch.noChats')}</p>
      )}
    </BottomSheet>
  );
}

// ── In a chat ────────────────────────────────────────────────────────────

/** The session running in a chat, kept fresh as sessions start, end and people come and go. */
export function useChatWatch(conversationId: string) {
  const [session, setSession] = useState<WatchSummary | null>(null);
  const load = useCallback(
    () =>
      api.watch.forChat(conversationId).then(
        (r) => setSession(r.session),
        () => {},
      ),
    [conversationId],
  );
  useEffect(() => {
    setSession(null);
    void load();
  }, [load]);
  // People watching change without a word to those not watching: look again now and then.
  const running = !!session;
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => void load(), 30_000);
    return () => clearInterval(timer);
  }, [running, load]);
  useRealtime((e) => {
    if ((e.type === 'watch.started' || e.type === 'watch.ended') && e.data?.conversationId === conversationId) void load();
    if (e.type === 'watch.updated' && session && e.data?.sessionId === session.id) void load();
  });
  return { session, reload: load };
}

/** "Watching together now" at the top of a chat, with who's watching and a way to join. */
export function WatchBanner({ session }: { session: WatchSummary | null }) {
  const { t, tp } = useSession();
  if (!session) return null;
  const n = session.watching.length;
  return (
    <div className="watch-banner" role="region" aria-label={t('watch.now')}>
      <span className="watch-banner__icon" aria-hidden>
        <Icon name="play" size={16} />
      </span>
      <div className="watch-banner__text">
        <strong>{t('watch.now')}</strong>
        {n ? <span className="muted">{tp('watch.watching', n)}</span> : null}
      </div>
      {n ? (
        <span className="watch-banner__faces" aria-hidden>
          {session.watching.slice(0, 3).map((u) => (
            <Avatar key={u.id} name={u.displayName} src={u.avatarUrl} size="sm" />
          ))}
        </span>
      ) : null}
      <Link href={`/watch/${session.id}`} className="yp-btn yp-btn--primary yp-btn--sm">
        {t('watch.join')}
      </Link>
    </div>
  );
}
