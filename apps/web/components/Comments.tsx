'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Avatar, BottomSheet, Button, Checkbox, Icon, Segments, Select, Skeleton, TaggedText, TranslatableText, VoicePlayer } from '@yapilapi/design-system';
import {
  COMMENT_POLICIES,
  formatRelativeTime,
  formatReelTime,
  voiceClock,
  VOICE_MAX_MS,
  type Comment,
  type CommentPage,
  type CommentPolicy,
  type CommentSort,
  type MessageKey,
  type Post,
  type PublicUser,
} from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';
import { NextLink } from '@/lib/link';
import { AutocompleteText } from '@/components/Autocomplete';
import { useSession } from '@/app/providers';
import { signInHref, useSignIn } from './SignedOut';
import { ReportSheet } from './ReportSheet';
import { uploadVoice, voiceError, YapRecorder, type Recording } from './YapRecorder';

const POLICY_LABEL: Record<CommentPolicy, MessageKey> = {
  everyone: 'comments.policy.everyone',
  following: 'comments.policy.following',
  followers: 'comments.policy.followers',
  off: 'comments.policy.off',
};
const CLOSED: Record<CommentPolicy, MessageKey> = {
  everyone: 'comments.closed.off',
  following: 'comments.closed.following',
  followers: 'comments.closed.followers',
  off: 'comments.closed.off',
};

type Thread = { open: boolean; items: Comment[]; cursor: string | null; loading: boolean };

/**
 * Moment comments on a reel: where the viewer was when they opened the comments (a new comment
 * can point to it), how to go to a comment's moment, and what to do with a new one.
 */
export interface CommentMoment {
  atMs: number | null;
  seek: (ms: number) => void;
  onMoment?: (c: Comment) => void;
}

/** A voice reply's clip again, for its transcript once it's made. */
const refreshVoice = (id: string) => api.voice.get(id).then((r) => r.voice);
const speakVoice = (id: string, target: string) => api.voice.speech(id, target).then((r) => r.url);

/** The comments of a post in a bottom sheet. `onCountChange` gets +1 or minus the comments removed. */
export function CommentsSheet({
  post,
  onClose,
  onCountChange,
  moment,
}: {
  post: Post;
  onClose: () => void;
  onCountChange: (delta: number) => void;
  moment?: CommentMoment;
}) {
  const { t } = useSession();
  return (
    <BottomSheet open onClose={onClose} title={t('post.comments')}>
      <Comments post={post} onCountChange={onCountChange} moment={moment} />
    </BottomSheet>
  );
}

/**
 * Comments with one level of threads: Top or Newest, likes, a pinned comment,
 * edits within 15 minutes, and the post author's tools (who can comment, pin,
 * hidden comments). Replying to a reply stays in the thread and starts with an @mention.
 */
export function Comments({
  post,
  onCountChange,
  moment,
  startVoice,
}: {
  post: Post;
  onCountChange: (delta: number) => void;
  moment?: CommentMoment;
  /** Open with the voice reply recorder showing (Yap Radio's "Reply by voice"). */
  startVoice?: boolean;
}) {
  const { toast, t, tp, locale, me, flags, voice } = useSession();
  const signIn = useSignIn();
  // Talk back: a voice reply, recorded here (with the words typed so far, if any).
  const voiceOn = flags.YAPS !== false;
  const [voiceOpen, setVoiceOpen] = useState(!!startVoice);
  const [voiceRec, setVoiceRec] = useState<Recording | null>(null);
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [sort, setSort] = useState<CommentSort>('top');
  const [page, setPage] = useState<Omit<CommentPage, 'items' | 'nextCursor'> | null>(null);
  const [items, setItems] = useState<Comment[] | null>(null);
  // Why the comments couldn't load (shown with Try again, not as "No comments yet").
  const [loadError, setLoadError] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [threads, setThreads] = useState<Record<string, Thread>>({});
  const [body, setBody] = useState('');
  const [replyTo, setReplyTo] = useState<Comment | null>(null);
  const [busy, setBusy] = useState(false);
  // Reels: point a new comment to the moment the viewer was at.
  const [pointAt, setPointAt] = useState(false);
  const momentMs = post.format === 'reel' && moment && moment.atMs !== null ? moment.atMs : null;
  const [editing, setEditing] = useState<{ id: string; body: string; busy: boolean } | null>(null);
  const [reporting, setReporting] = useState<string | null>(null);
  const [likers, setLikers] = useState<{ comment: Comment; items: PublicUser[] | null } | null>(null);
  const [hidden, setHidden] = useState<Comment[] | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  // Where focus goes back to once a reply, an edit or a panel is done.
  const returnTo = useRef<string | null>(null);
  const inputId = `comment-${post.id}`;
  // Focus moves once the element is on screen: after the next render, or right away if nothing re-renders.
  const pendingFocus = useRef<string | null>(null);
  useEffect(() => {
    const el = pendingFocus.current && document.getElementById(pendingFocus.current);
    if (el) {
      el.focus();
      pendingFocus.current = null;
    }
  });
  const focusLater = (id: string | null) => {
    if (!id) return;
    pendingFocus.current = id;
    setTimeout(() => {
      const el = pendingFocus.current === id && document.getElementById(id);
      if (el) {
        el.focus();
        pendingFocus.current = null;
      }
    }, 50);
  };

  const load = useCallback(
    async (s: CommentSort) => {
      try {
        const r = await api.posts.comments(post.id, undefined, s);
        const { items: list, nextCursor, ...rest } = r;
        setItems(list);
        setCursor(nextCursor);
        setPage(rest);
        setThreads({});
        setLoadError(null);
      } catch (e) {
        setLoadError(errorMessage(e));
      }
    },
    [post.id],
  );
  useEffect(() => {
    void load(sort);
  }, [load, sort]);

  /** Apply a change to a comment wherever it is shown (top level or in a thread). */
  const update = (id: string, fn: (c: Comment) => Comment) => {
    setItems((cur) => cur?.map((c) => (c.id === id ? fn(c) : c)) ?? cur);
    setThreads((cur) => Object.fromEntries(Object.entries(cur).map(([k, th]) => [k, { ...th, items: th.items.map((c) => (c.id === id ? fn(c) : c)) }])));
  };

  const openThread = async (c: Comment, more = false) => {
    const th = threads[c.id];
    if (th && !more) {
      setThreads((cur) => ({ ...cur, [c.id]: { ...th, open: !th.open } }));
      if (th.items.length || !th.open) return;
    }
    setThreads((cur) => ({ ...cur, [c.id]: { open: true, items: cur[c.id]?.items ?? [], cursor: cur[c.id]?.cursor ?? null, loading: true } }));
    try {
      const r = await api.comments.replies(c.id, more ? (th?.cursor ?? undefined) : undefined);
      setThreads((cur) => {
        const before = more ? (cur[c.id]?.items ?? []) : [];
        return {
          ...cur,
          [c.id]: { open: true, items: [...before, ...r.items.filter((x) => !before.some((y) => y.id === x.id))], cursor: r.nextCursor, loading: false },
        };
      });
    } catch (e) {
      setThreads((cur) => ({ ...cur, [c.id]: { ...(cur[c.id] ?? { items: [], cursor: null }), open: true, loading: false } }));
      toast(errorMessage(e));
    }
  };

  const startReply = (c: Comment) => {
    setReplyTo(c);
    returnTo.current = `reply-${c.id}`;
    // A reply to a reply goes to the top-level thread, so it names the person answered.
    if (c.parentId && c.author.id !== me?.id) setBody((b) => (b.startsWith(`@${c.author.username} `) ? b : `@${c.author.username} ${b}`));
    focusLater(inputId);
  };
  const cancelReply = () => {
    setReplyTo(null);
    focusLater(returnTo.current);
    returnTo.current = null;
  };

  /** A comment was posted (written or spoken): it shows in its place, and the composer is cleared. */
  const added = (comment: Comment) => {
    if (comment.atMs !== null && comment.atMs !== undefined) moment?.onMoment?.(comment);
    setPointAt(false);
    if (comment.parentId) {
      const parentId = comment.parentId;
      setThreads((cur) => {
        const th = cur[parentId] ?? { open: true, items: [], cursor: null, loading: false };
        return { ...cur, [parentId]: { ...th, open: true, items: [...th.items, comment] } };
      });
      update(parentId, (c) => ({ ...c, replies: c.replies + 1 }));
    } else {
      // Your new comment shows first, after a pinned one.
      setItems((cur) => {
        const list = cur ?? [];
        const pinned = list.filter((c) => c.pinned);
        return [...pinned, comment, ...list.filter((c) => !c.pinned)];
      });
    }
    setBody('');
    onCountChange(1);
    if (replyTo) {
      setReplyTo(null);
      focusLater(returnTo.current);
      returnTo.current = null;
    }
  };

  const submit = async () => {
    const text = body.trim();
    if (!text) return;
    setBusy(true);
    try {
      const atMs = pointAt && !replyTo && momentMs !== null ? momentMs : undefined;
      const { comment } = await api.posts.comment(post.id, text, replyTo?.id, atMs);
      added(comment);
    } catch (err) {
      toast(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  /** Send the voice reply: the recording first, then the reply with it (and any words typed). */
  const sendVoice = async () => {
    if (!voiceRec) return;
    setVoiceBusy(true);
    try {
      let voiceId: string;
      try {
        voiceId = (await uploadVoice(voiceRec, 'comment')).id;
      } catch (err) {
        toast(voiceError(err, t));
        return;
      }
      const { comment } = await api.posts.voiceComment(post.id, voiceId, { body: body.trim() || undefined, parentId: replyTo?.id });
      added(comment);
      setVoiceRec(null);
      setVoiceOpen(false);
      focusLater('voice-reply-open');
    } catch (err) {
      toast(errorMessage(err));
    } finally {
      setVoiceBusy(false);
    }
  };

  /** A voice reply's player and its transcript (a reply may be only the recording). */
  const voiceOf = (c: Comment) =>
    c.voice ? (
      <VoicePlayer
        clip={c.voice}
        label={t('voice.replyA11y', { duration: voiceClock(c.voice.durationMs) })}
        locale={locale}
        size="sm"
        own={c.author.id === me?.id}
        refresh={refreshVoice}
        speak={me && voice.listen ? speakVoice : undefined}
        className="comment__voice"
        testId="comment-voice"
      />
    ) : null;

  const like = async (c: Comment) => {
    const liked = !c.viewer.liked;
    update(c.id, (x) => ({ ...x, likes: x.likes + (liked ? 1 : -1), viewer: { ...x.viewer, liked } }));
    try {
      const r = await (liked ? api.comments.like(c.id) : api.comments.unlike(c.id));
      update(c.id, (x) => ({ ...x, likes: r.likes, likedByAuthor: page?.isPostAuthor ? r.liked && x.author.id !== me?.id : x.likedByAuthor }));
    } catch (e) {
      update(c.id, (x) => ({ ...x, likes: c.likes, viewer: { ...x.viewer, liked: c.viewer.liked } }));
      toast(errorMessage(e));
    }
  };

  const remove = async (c: Comment, opts: { hidden?: boolean } = {}) => {
    if (!confirm(t('comments.deleteConfirm'))) return;
    try {
      await api.comments.remove(c.id);
      if (opts.hidden) {
        setHidden((cur) => cur?.filter((x) => x.id !== c.id) ?? cur);
        setPage((p) => (p ? { ...p, hiddenCount: Math.max(0, (p.hiddenCount ?? 1) - 1) } : p));
        toast(t('comments.deleted'));
        return;
      }
      if (c.parentId) {
        setThreads((cur) => {
          const th = cur[c.parentId!];
          return th ? { ...cur, [c.parentId!]: { ...th, items: th.items.filter((x) => x.id !== c.id) } } : cur;
        });
        update(c.parentId, (x) => ({ ...x, replies: Math.max(0, x.replies - 1) }));
      } else setItems((cur) => cur?.filter((x) => x.id !== c.id) ?? cur);
      // A top-level comment goes with its thread.
      onCountChange(c.parentId ? -1 : -(1 + c.replies));
      toast(t('comments.deleted'));
    } catch (e) {
      toast(errorMessage(e));
    }
  };

  const saveEdit = async () => {
    if (!editing?.body.trim()) return;
    setEditing({ ...editing, busy: true });
    try {
      const { comment } = await api.comments.edit(editing.id, editing.body.trim());
      update(comment.id, () => comment);
      setEditing(null);
      focusLater(`edit-${comment.id}`);
    } catch (e) {
      setEditing((cur) => (cur ? { ...cur, busy: false } : cur));
      toast(errorMessage(e));
    }
  };

  const pin = async (c: Comment) => {
    try {
      await api.posts.pinComment(post.id, c.pinned ? null : c.id);
      toast(t(c.pinned ? 'comments.unpinned' : 'comments.pinnedToast'));
      await load(sort);
      focusLater(`pin-${c.id}`);
    } catch (e) {
      toast(errorMessage(e));
    }
  };

  const showLikers = async (c: Comment) => {
    returnTo.current = `likes-${c.id}`;
    setLikers({ comment: c, items: null });
    focusLater('comment-likers-title');
    try {
      setLikers({ comment: c, items: (await api.comments.likers(c.id)).items });
    } catch (e) {
      setLikers(null);
      toast(errorMessage(e));
    }
  };
  const closeLikers = () => {
    setLikers(null);
    focusLater(returnTo.current);
  };

  const setPolicy = async (policy: CommentPolicy) => {
    if (!page) return;
    const before = page;
    setPage({ ...page, commentPolicy: policy, canComment: policy !== 'off' });
    try {
      await api.posts.setCommentPolicy(post.id, policy);
      toast(t('common.saved'));
    } catch (e) {
      setPage(before);
      toast(errorMessage(e));
    }
  };

  const toggleHidden = async () => {
    const next = !showHidden;
    setShowHidden(next);
    if (!next) return;
    try {
      setHidden((await api.posts.hiddenComments(post.id)).items);
    } catch (e) {
      toast(errorMessage(e));
    }
  };
  const unhide = async (c: Comment) => {
    try {
      await api.comments.unhide(c.id);
      setHidden((cur) => cur?.filter((x) => x.id !== c.id) ?? cur);
      setPage((p) => (p ? { ...p, hiddenCount: Math.max(0, (p.hiddenCount ?? 1) - 1) } : p));
      onCountChange(1);
      toast(t('comments.hidden.shown'));
      await load(sort);
      focusLater('comments-hidden-toggle');
    } catch (e) {
      toast(errorMessage(e));
    }
  };

  const more = async () => {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const r = await api.posts.comments(post.id, cursor, sort);
      setItems((cur) => [...(cur ?? []), ...r.items.filter((x) => !cur?.some((y) => y.id === x.id))]);
      setCursor(r.nextCursor);
    } catch (e) {
      toast(errorMessage(e));
    } finally {
      setLoadingMore(false);
    }
  };

  const row = (c: Comment, reply: boolean) => {
    const name = c.author.displayName;
    const th = threads[c.id];
    const own = me?.id === c.author.id;
    return (
      <div key={c.id} className={reply ? 'comment comment--reply' : 'comment'} id={`c-${c.id}`}>
        <Avatar name={name} src={c.author.avatarUrl} size="sm" />
        <div className="comment__main">
          <div className="comment__bubble">
            {c.pinned ? <span className="comment__label">{t('comments.pinned')}</span> : null}
            <strong>
              <Link href={`/u/${c.author.username}`} className="comment__name">
                {name}
              </Link>{' '}
              <span className="muted">
                · {formatRelativeTime(c.createdAt, locale)}
                {c.editedAt ? ` · ${t('comments.edited')}` : ''}
              </span>
            </strong>
            {c.atMs !== null && c.atMs !== undefined ? (
              moment ? (
                <button
                  type="button"
                  className="comment__moment"
                  onClick={() => moment.seek(c.atMs!)}
                  aria-label={t('reel.moment.seek', { time: formatReelTime(c.atMs) })}
                >
                  <Icon name="play" size={10} filled />
                  {t('reel.moment.at', { time: formatReelTime(c.atMs) })}
                </button>
              ) : (
                <span className="comment__moment comment__moment--static">{t('reel.moment.at', { time: formatReelTime(c.atMs) })}</span>
              )
            ) : null}
            {editing?.id === c.id ? (
              <form
                className="stack-sm"
                onSubmit={(e) => {
                  e.preventDefault();
                  void saveEdit();
                }}
              >
                <label className="yp-visually-hidden" htmlFor={`edit-input-${c.id}`}>
                  {t('comments.editLabel')}
                </label>
                <AutocompleteText
                  id={`edit-input-${c.id}`}
                  className="yp-input"
                  value={editing.body}
                  onValueChange={(v) => setEditing((cur) => (cur ? { ...cur, body: v } : cur))}
                  maxLength={2000}
                  rows={2}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      e.preventDefault();
                      // Keeps the sheet open: its Escape listener sits on the document, next to React's.
                      e.nativeEvent.stopImmediatePropagation();
                      setEditing(null);
                      focusLater(`edit-${c.id}`);
                    }
                  }}
                />
                <div className="row" style={{ gap: 8 }}>
                  <Button size="sm" type="submit" loading={editing.busy} disabled={!editing.body.trim()}>
                    {t('common.save')}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setEditing(null);
                      focusLater(`edit-${c.id}`);
                    }}
                  >
                    {t('common.cancel')}
                  </Button>
                </div>
              </form>
            ) : (
              <>
                {voiceOf(c)}
                {c.body.trim() || !c.voice ? (
                  <TranslatableText
                    kind="comment"
                    id={c.id}
                    text={c.body}
                    lang={c.lang}
                    own={c.author.id === me?.id}
                    locale={locale}
                    render={(text) => <TaggedText text={text} linkAs={NextLink} />}
                  />
                ) : null}
              </>
            )}
          </div>
          <div className="comment__actions">
            <button
              type="button"
              className="comment__action comment__like"
              aria-pressed={c.viewer.liked}
              aria-label={`${t('comments.likeLabel', { name })}, ${tp('comments.likes', c.likes)}`}
              onClick={() => (me ? void like(c) : signIn())}
            >
              <Icon name="heart" size={16} />
              {c.likes > 0 ? <span aria-hidden>{c.likes}</span> : null}
            </button>
            {me && page?.canComment ? (
              <button type="button" id={`reply-${c.id}`} className="comment__action" aria-label={t('comments.replyTo', { name })} onClick={() => startReply(c)}>
                {t('comments.reply')}
              </button>
            ) : null}
            {c.viewer.canEdit && editing?.id !== c.id ? (
              <button
                type="button"
                id={`edit-${c.id}`}
                className="comment__action"
                onClick={() => {
                  setEditing({ id: c.id, body: c.body, busy: false });
                  focusLater(`edit-input-${c.id}`);
                }}
              >
                {t('comments.edit')}
              </button>
            ) : null}
            {page?.isPostAuthor && !reply ? (
              <button type="button" id={`pin-${c.id}`} className="comment__action" onClick={() => void pin(c)}>
                {t(c.pinned ? 'comments.unpin' : 'comments.pin')}
              </button>
            ) : null}
            {own && c.likes > 0 ? (
              <button type="button" id={`likes-${c.id}`} className="comment__action" onClick={() => void showLikers(c)}>
                {t('comments.likers.show')}
              </button>
            ) : null}
            {c.viewer.canDelete ? (
              <button type="button" className="comment__action" onClick={() => void remove(c)}>
                {t('m.common.delete')}
              </button>
            ) : null}
            {me && !own ? (
              <button type="button" className="comment__action" aria-label={t('m.report.commentBy', { name })} onClick={() => setReporting(c.id)}>
                {t('post.report')}
              </button>
            ) : null}
            {c.likedByAuthor ? (
              <span className="comment__author-like">
                <Icon name="heart" size={12} />
                {t('comments.likedByAuthor')}
              </span>
            ) : null}
          </div>
          {!reply && (c.replies > 0 || th?.items.length) ? (
            <div className="stack-sm">
              <button
                type="button"
                className="comment__action comment__thread-toggle"
                aria-expanded={!!th?.open}
                aria-controls={`replies-${c.id}`}
                onClick={() => void openThread(c)}
              >
                {th?.open ? t('comments.hideReplies') : tp('comments.viewReplies', Math.max(c.replies, th?.items.length ?? 0))}
              </button>
              {th?.open ? (
                <div className="comment__replies stack-sm" id={`replies-${c.id}`}>
                  {th.items.map((r) => row(r, true))}
                  {th.loading ? <Skeleton height={40} /> : null}
                  {th.cursor && !th.loading ? (
                    <button type="button" className="comment__action" onClick={() => void openThread(c, true)}>
                      {t('comments.moreReplies')}
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    );
  };

  return (
    <div className="stack comments">
      <div className="row comments__bar" style={{ justifyContent: 'space-between', alignItems: 'flex-end', flexWrap: 'wrap', gap: 8 }}>
        <Segments
          label={t('comments.sort.label')}
          value={sort}
          onChange={setSort}
          options={[
            { id: 'top', label: t('comments.sort.top') },
            { id: 'newest', label: t('comments.sort.newest') },
          ]}
        />
        {page?.isPostAuthor ? (
          <Select label={t('comments.settings.title')} value={page.commentPolicy} onChange={(e) => void setPolicy(e.currentTarget.value as CommentPolicy)}>
            {COMMENT_POLICIES.map((p) => (
              <option key={p} value={p}>
                {t(POLICY_LABEL[p])}
              </option>
            ))}
          </Select>
        ) : null}
      </div>

      {page?.isPostAuthor && ((page.hiddenCount ?? 0) > 0 || showHidden) ? (
        <section className="stack-sm comments__hidden" aria-labelledby="comments-hidden-title">
          <h3 id="comments-hidden-title" className="section-title" style={{ margin: 0 }}>
            {t('comments.hidden.title')}
          </h3>
          <p className="muted" style={{ margin: 0 }}>
            {t('comments.hidden.body')}
          </p>
          <div>
            <Button id="comments-hidden-toggle" size="sm" variant="secondary" aria-expanded={showHidden} onClick={() => void toggleHidden()}>
              {showHidden ? t('comments.hidden.close') : tp('comments.hidden.review', page.hiddenCount ?? 0)}
            </Button>
          </div>
          {showHidden ? (
            hidden === null ? (
              <Skeleton height={60} />
            ) : hidden.length ? (
              hidden.map((c) => (
                <div key={c.id} className="comment">
                  <Avatar name={c.author.displayName} src={c.author.avatarUrl} size="sm" />
                  <div className="comment__main">
                    <div className="comment__bubble">
                      <strong>
                        {c.author.displayName} <span className="muted">· {formatRelativeTime(c.createdAt, locale)}</span>
                      </strong>
                      {voiceOf(c)}
                      {c.body.trim() || !c.voice ? (
                        <TranslatableText
                          kind="comment"
                          id={c.id}
                          text={c.body}
                          lang={c.lang}
                          own={c.author.id === me?.id}
                          locale={locale}
                          render={(text) => <TaggedText text={text} linkAs={NextLink} />}
                        />
                      ) : null}
                    </div>
                    <div className="comment__actions">
                      <button type="button" className="comment__action" onClick={() => void unhide(c)}>
                        {t('comments.hidden.unhide')}
                      </button>
                      <button type="button" className="comment__action" onClick={() => void remove(c, { hidden: true })}>
                        {t('m.common.delete')}
                      </button>
                    </div>
                  </div>
                </div>
              ))
            ) : (
              <p className="muted">{t('comments.hidden.none')}</p>
            )
          ) : null}
        </section>
      ) : null}

      <ReportSheet target={reporting ? { type: 'comment', id: reporting } : null} onClose={() => setReporting(null)} />
      {likers ? (
        <section className="stack-sm comments__likers" aria-labelledby="comment-likers-title">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h3 id="comment-likers-title" className="section-title" style={{ margin: 0 }} tabIndex={-1}>
              {t('comments.likers.title')}
            </h3>
            <Button size="sm" variant="ghost" onClick={closeLikers}>
              {t('m.common.close')}
            </Button>
          </div>
          {likers.items === null ? (
            <Skeleton height={40} />
          ) : likers.items.length ? (
            <ul className="stack-sm" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {likers.items.map((u) => (
                <li key={u.id} className="row" style={{ gap: 8 }}>
                  <Avatar name={u.displayName} src={u.avatarUrl} size="sm" />
                  <Link href={`/u/${u.username}`}>{u.displayName}</Link>
                  <span className="muted">@{u.username}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">{t('comments.likers.none')}</p>
          )}
        </section>
      ) : null}

      {loadError ? (
        <div className="stack-sm" role="alert">
          <p className="muted" style={{ margin: 0 }}>
            {loadError}
          </p>
          <div>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                setLoadError(null);
                void load(sort);
              }}
            >
              {t('m.common.retry')}
            </Button>
          </div>
        </div>
      ) : items === null ? (
        <Skeleton height={60} />
      ) : items.length ? (
        <div className="stack">{items.map((c) => row(c, false))}</div>
      ) : (
        <p className="muted">{t('postList.noComments')}</p>
      )}
      {cursor ? (
        <Button variant="secondary" size="sm" loading={loadingMore} onClick={() => void more()}>
          {t('comments.loadMore')}
        </Button>
      ) : null}

      {!me ? (
        <div className="row">
          <span className="muted">{t('postList.signInToComment')}</span>
          <Link href={signInHref()} className="yp-btn yp-btn--primary yp-btn--sm">
            {t('postList.signIn')}
          </Link>
        </div>
      ) : page && !page.canComment ? (
        <p className="muted" role="status">
          {t(CLOSED[page.commentPolicy])}
        </p>
      ) : (
        <form
          className="stack-sm"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          {replyTo ? (
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <span className="muted">{t('comments.replyingTo', { name: replyTo.author.displayName })}</span>
              <Button size="sm" variant="ghost" onClick={cancelReply}>
                {t('comments.cancelReply')}
              </Button>
            </div>
          ) : null}
          <label className="yp-visually-hidden" htmlFor={inputId}>
            {replyTo ? t('comments.replyingTo', { name: replyTo.author.displayName }) : t('comment.placeholder')}
          </label>
          <AutocompleteText
            as="input"
            id={inputId}
            className="yp-input"
            placeholder={replyTo ? t('comments.replyPlaceholder') : t('comment.placeholder')}
            value={body}
            onValueChange={setBody}
            maxLength={2000}
            autoComplete="off"
            onKeyDown={(e) => {
              if (e.key === 'Escape' && replyTo) {
                e.preventDefault();
                // Keeps the sheet open: its Escape listener sits on the document, next to React's.
                e.nativeEvent.stopImmediatePropagation();
                cancelReply();
              }
            }}
          />
          {momentMs !== null && !replyTo ? (
            <Checkbox
              label={t('reel.moment.attach', { time: formatReelTime(momentMs) })}
              checked={pointAt}
              onChange={(e) => setPointAt(e.currentTarget.checked)}
            />
          ) : null}
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <Button type="submit" loading={busy} disabled={!body.trim()}>
              {replyTo ? t('comments.postReply') : t('comment.submit')}
            </Button>
            {voiceOn && !voiceOpen ? (
              <Button id="voice-reply-open" variant="secondary" icon="mic" onClick={() => setVoiceOpen(true)} data-testid="voice-reply">
                {t('voice.reply')}
              </Button>
            ) : null}
          </div>
          {voiceOn && voiceOpen ? (
            <div className="stack-sm" role="group" aria-label={t('voice.reply')}>
              <YapRecorder
                compact
                maxMs={VOICE_MAX_MS}
                label={t('voice.reply')}
                onDone={(blob, durationMs, filename) => setVoiceRec({ blob, durationMs, filename })}
                onReset={() => setVoiceRec(null)}
                actions={
                  <Button size="sm" icon="send" loading={voiceBusy} onClick={() => void sendVoice()}>
                    {replyTo ? t('comments.postReply') : t('comment.submit')}
                  </Button>
                }
              />
              <div>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={voiceBusy}
                  onClick={() => {
                    setVoiceOpen(false);
                    setVoiceRec(null);
                    focusLater('voice-reply-open');
                  }}
                >
                  {t('common.cancel')}
                </Button>
              </div>
            </div>
          ) : null}
        </form>
      )}
    </div>
  );
}
