import { router, useLocalSearchParams } from 'expo-router';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Alert, findNodeHandle, FlatList, Pressable, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { MessageKey } from '../../../../packages/shared/src/i18n';
import type { Comment, CommentPage, Post, PublicUser } from '../../../../packages/shared/src/types';
import type { CommentPolicy, CommentSort } from '../../../../packages/shared/src/constants';
import { formatReelTime } from '../../../../packages/shared/src/reels';
import { client, errorMessage, isGone } from '../../lib/api';
import { useT } from '../../lib/i18n';
import { useAutocomplete } from '../../lib/autocomplete';
import { PostCard } from '../../lib/post';
import { useReport } from '../../lib/report';
import { TranslatableText } from '../../lib/translation';
import { useSession } from '../../lib/session';
import { elevation, radius, space } from '../../lib/theme';
import { Avatar, Button, EmptyState, ErrorState, Icon, KeyboardAvoid, Loading, Notice, ScreenError, Segmented, useColors, userText } from '../../lib/ui';

const POLICIES: { id: CommentPolicy; label: MessageKey }[] = [
  { id: 'everyone', label: 'comments.policy.everyone' },
  { id: 'following', label: 'comments.policy.following' },
  { id: 'followers', label: 'comments.policy.followers' },
  { id: 'off', label: 'comments.policy.off' },
];
const CLOSED: Record<CommentPolicy, MessageKey> = {
  everyone: 'comments.closed.off',
  following: 'comments.closed.following',
  followers: 'comments.closed.followers',
  off: 'comments.closed.off',
};

type Thread = { open: boolean; items: Comment[]; cursor: string | null; loading: boolean };
type Controls = Omit<CommentPage, 'items' | 'nextCursor'>;
type Editing = { id: string; body: string; busy: boolean };
type Likers = { id: string; items: PublicUser[] | null };
/** What a comment row's buttons do; the screen keeps the latest ones in a ref. */
type CommentHandlers = {
  like: (x: Comment) => void;
  reply: (x: Comment) => void;
  replyButton: (commentId: string, v: View | null) => void;
  edit: (x: Comment) => void;
  editText: (body: string) => void;
  saveEdit: () => void;
  cancelEdit: () => void;
  pin: (x: Comment) => void;
  showLikers: (x: Comment) => void;
  remove: (x: Comment) => void;
  report: (x: Comment) => void;
  toggleThread: (x: Comment, more?: boolean) => void;
};

/** The edit box or likers list, for the row it's about: the comment itself or one of its replies. */
function forRow<T extends { id: string }>(value: T | null, x: Comment, th: Thread | undefined): T | null {
  return value && (value.id === x.id || th?.items.some((r) => r.id === value.id)) ? value : null;
}

/**
 * A single post with its comments (link target for notifications, search and the feed):
 * Top or Newest, one level of threads ("View 3 replies"), likes, a pinned comment,
 * edits within 15 minutes, and the post author's tools (who can comment, pin, hidden comments).
 */
export default function PostScreen() {
  // From Reels, `atMs` is where the viewer was: a new comment on the reel can point to that moment.
  const { id, atMs: atParam } = useLocalSearchParams<{ id: string; atMs?: string }>();
  const momentMs = atParam !== undefined && /^\d+$/.test(atParam) ? Number(atParam) : null;
  const [pointAt, setPointAt] = useState(false);
  const c = useColors();
  const { t, tp } = useT();
  const insets = useSafeAreaInsets();
  const { me } = useSession();
  const [post, setPost] = useState<Post | null | undefined>(undefined);
  // Kept apart from the post, so the card keeps a like or an edit made here as comments come and go.
  const [commentCount, setCommentCount] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sort, setSort] = useState<CommentSort>('top');
  const [controls, setControls] = useState<Controls | null>(null);
  const [comments, setComments] = useState<Comment[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [threads, setThreads] = useState<Record<string, Thread>>({});
  const [body, setBody] = useState('');
  const [replyTo, setReplyTo] = useState<Comment | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [likers, setLikers] = useState<Likers | null>(null);
  const [hidden, setHidden] = useState<Comment[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ac = useAutocomplete(body, setBody);
  // The Reply buttons, so focus can go back to the one used once the reply is sent.
  const replyButtons = useRef<Record<string, View | null>>({});
  // The list, to bring a comment you just posted into view (it goes near the top, after the pinned ones).
  const list = useRef<FlatList<Comment>>(null);
  const retried = useRef(false);
  // The end of the list can be reached more than once before the next page arrives: ask once.
  const fetchingMore = useRef<string | null>(null);
  const showComment = (index: number) => {
    retried.current = false;
    requestAnimationFrame(() => list.current?.scrollToIndex({ index, viewPosition: 0.3 }));
  };
  // Report a comment; blocking its writer from there too hides their comments here.
  const report = useReport({
    onBlocked: (userId) => {
      setComments((cur) => cur.filter((x) => x.author.id !== userId));
      setThreads((cur) => Object.fromEntries(Object.entries(cur).map(([k, th]) => [k, { ...th, items: th.items.filter((x) => x.author.id !== userId) }])));
    },
  });

  const focusReplyButton = (commentId: string | undefined) => {
    const node = commentId ? findNodeHandle(replyButtons.current[commentId] ?? null) : null;
    if (node) setTimeout(() => AccessibilityInfo.setAccessibilityFocus(node), 100);
  };

  const loadComments = useCallback(
    async (next?: string) => {
      const page = await (await client()).posts.comments(id, next, sort);
      const { items, nextCursor, ...rest } = page;
      setComments((cur) => (next ? [...cur, ...items.filter((x) => !cur.some((y) => y.id === x.id))] : items));
      setCursor(nextCursor);
      setControls(rest);
      if (!next) setThreads({});
    },
    [id, sort],
  );

  const loadPost = useCallback(async () => {
    try {
      const r = await (await client()).posts.get(id);
      setPost(r.post);
      setCommentCount(r.post.counts.comments);
      setLoadError(null);
    } catch (e) {
      if (isGone(e)) setPost(null);
      else setLoadError(errorMessage(e));
    }
  }, [id]);
  useEffect(() => {
    void loadPost();
  }, [loadPost]);

  useEffect(() => {
    // Comments on a post for subscribers are for subscribers too.
    if (post && !post.locked) void loadComments().catch((e) => setError(errorMessage(e)));
  }, [post?.id, post?.locked, loadComments]); // eslint-disable-line react-hooks/exhaustive-deps

  // The rows call the screen's latest handlers through this ref (filled in below), so a memoised
  // row keeps the same props while you type a comment and only renders again when it changes.
  const latest = useRef<CommentHandlers | null>(null);
  const meId = me?.id;
  const canReply = !!me && !!controls?.canComment;
  const isPostAuthor = !!controls?.isPostAuthor;
  const renderTop = useCallback(
    ({ item }: { item: Comment }) => {
      const th = threads[item.id];
      return (
        <CommentRow
          x={item}
          reply={false}
          meId={meId}
          canReply={canReply}
          isPostAuthor={isPostAuthor}
          thread={th}
          editing={forRow(editing, item, th)}
          likers={forRow(likers, item, th)}
          h={latest}
        />
      );
    },
    [threads, meId, canReply, isPostAuthor, editing, likers],
  );

  if (post === undefined) return loadError ? <ScreenError message={loadError} onRetry={loadPost} /> : <Loading />;
  if (post === null)
    return (
      <View style={{ flex: 1, backgroundColor: c.ground }}>
        <EmptyState title={t('m.post.unavailable.title')} body={t('m.post.unavailable.body')} />
      </View>
    );

  const bump = (delta: number) => setCommentCount((n) => Math.max(0, n + delta));
  /** Apply a change to a comment wherever it shows (top level or in a thread). */
  const update = (commentId: string, fn: (x: Comment) => Comment) => {
    setComments((cur) => cur.map((x) => (x.id === commentId ? fn(x) : x)));
    setThreads((cur) => Object.fromEntries(Object.entries(cur).map(([k, th]) => [k, { ...th, items: th.items.map((x) => (x.id === commentId ? fn(x) : x)) }])));
  };

  const run = async (fn: () => Promise<void>) => {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const toggleThread = (top: Comment, more = false) =>
    run(async () => {
      const th = threads[top.id];
      if (th && !more) {
        setThreads((cur) => ({ ...cur, [top.id]: { ...th, open: !th.open } }));
        if (th.items.length || th.open) return;
      }
      setThreads((cur) => ({ ...cur, [top.id]: { open: true, items: cur[top.id]?.items ?? [], cursor: cur[top.id]?.cursor ?? null, loading: true } }));
      const page = await (await client()).comments.replies(top.id, more ? (th?.cursor ?? undefined) : undefined);
      setThreads((cur) => {
        const before = more ? (cur[top.id]?.items ?? []) : [];
        return {
          ...cur,
          [top.id]: {
            open: true,
            items: [...before, ...page.items.filter((x) => !before.some((y) => y.id === x.id))],
            cursor: page.nextCursor,
            loading: false,
          },
        };
      });
    });

  const startReply = (x: Comment) => {
    setReplyTo(x);
    // A reply to a reply joins the top-level thread, so it names the person answered.
    if (x.parentId && x.author.id !== me?.id) setBody((b) => (b.startsWith(`@${x.author.username} `) ? b : `@${x.author.username} ${b}`));
    requestAnimationFrame(() => ac.inputProps.ref.current?.focus());
  };

  const send = () =>
    run(async () => {
      setBusy(true);
      try {
        const atMs = pointAt && !replyTo && momentMs !== null && post.format === 'reel' ? momentMs : undefined;
        const { comment } = await (await client()).posts.comment(post.id, body.trim(), replyTo?.id, atMs);
        setPointAt(false);
        if (comment.parentId) {
          const parentId = comment.parentId;
          setThreads((cur) => {
            const th = cur[parentId] ?? { open: true, items: [], cursor: null, loading: false };
            return { ...cur, [parentId]: { ...th, open: true, items: [...th.items, comment] } };
          });
          update(parentId, (x) => ({ ...x, replies: x.replies + 1 }));
        } else {
          setComments((cur) => [...cur.filter((x) => x.pinned), comment, ...cur.filter((x) => !x.pinned)]);
          // Scrolled down reading the others, you'd otherwise not see it arrive.
          showComment(comments.filter((x) => x.pinned).length);
        }
        bump(1);
        setBody('');
        const answered = replyTo?.id;
        setReplyTo(null);
        ac.inputProps.ref.current?.blur();
        focusReplyButton(answered);
      } finally {
        setBusy(false);
      }
    });

  const like = (x: Comment) =>
    run(async () => {
      const liked = !x.viewer.liked;
      update(x.id, (y) => ({ ...y, likes: y.likes + (liked ? 1 : -1), viewer: { ...y.viewer, liked } }));
      try {
        const api = await client();
        const r = await (liked ? api.comments.like(x.id) : api.comments.unlike(x.id));
        update(x.id, (y) => ({ ...y, likes: r.likes, likedByAuthor: controls?.isPostAuthor ? r.liked && y.author.id !== me?.id : y.likedByAuthor }));
      } catch (e) {
        update(x.id, (y) => ({ ...y, likes: x.likes, viewer: { ...y.viewer, liked: x.viewer.liked } }));
        throw e;
      }
    });

  const remove = (x: Comment, fromHidden = false) =>
    Alert.alert(t('comments.deleteConfirm'), undefined, [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('m.common.delete'),
        style: 'destructive',
        onPress: () =>
          void run(async () => {
            await (await client()).comments.remove(x.id);
            if (fromHidden) {
              setHidden((cur) => cur?.filter((y) => y.id !== x.id) ?? cur);
              setControls((cur) => (cur ? { ...cur, hiddenCount: Math.max(0, (cur.hiddenCount ?? 1) - 1) } : cur));
              return;
            }
            if (x.parentId) {
              const parentId = x.parentId;
              setThreads((cur) =>
                cur[parentId] ? { ...cur, [parentId]: { ...cur[parentId]!, items: cur[parentId]!.items.filter((y) => y.id !== x.id) } } : cur,
              );
              update(parentId, (y) => ({ ...y, replies: Math.max(0, y.replies - 1) }));
            } else setComments((cur) => cur.filter((y) => y.id !== x.id));
            // A top-level comment goes with its thread.
            bump(x.parentId ? -1 : -(1 + x.replies));
          }),
      },
    ]);

  const saveEdit = () =>
    run(async () => {
      if (!editing?.body.trim()) return;
      setEditing({ ...editing, busy: true });
      try {
        const { comment } = await (await client()).comments.edit(editing.id, editing.body.trim());
        update(comment.id, () => comment);
        setEditing(null);
      } catch (e) {
        setEditing((cur) => (cur ? { ...cur, busy: false } : cur));
        throw e;
      }
    });

  const pin = (x: Comment) =>
    run(async () => {
      await (await client()).posts.pinComment(post.id, x.pinned ? null : x.id);
      AccessibilityInfo.announceForAccessibility(t(x.pinned ? 'comments.unpinned' : 'comments.pinnedToast'));
      await loadComments();
    });

  const showLikers = (x: Comment) =>
    run(async () => {
      if (likers?.id === x.id) return setLikers(null);
      setLikers({ id: x.id, items: null });
      setLikers({ id: x.id, items: (await (await client()).comments.likers(x.id)).items });
    });

  const setPolicy = (policy: CommentPolicy) =>
    run(async () => {
      if (!controls) return;
      const before = controls;
      setControls({ ...controls, commentPolicy: policy, canComment: policy !== 'off' });
      try {
        await (await client()).posts.setCommentPolicy(post.id, policy);
      } catch (e) {
        setControls(before);
        throw e;
      }
    });

  const toggleHidden = () =>
    run(async () => {
      if (hidden) return setHidden(null);
      setHidden((await (await client()).posts.hiddenComments(post.id)).items);
    });

  const unhide = (x: Comment) =>
    run(async () => {
      await (await client()).comments.unhide(x.id);
      setHidden((cur) => cur?.filter((y) => y.id !== x.id) ?? cur);
      bump(1);
      AccessibilityInfo.announceForAccessibility(t('comments.hidden.shown'));
      await loadComments();
    });

  latest.current = {
    like: (x) => void like(x),
    reply: startReply,
    replyButton: (commentId, v) => {
      replyButtons.current[commentId] = v;
    },
    edit: (x) => setEditing({ id: x.id, body: x.body, busy: false }),
    editText: (v) => setEditing((cur) => (cur ? { ...cur, body: v } : cur)),
    saveEdit: () => void saveEdit(),
    cancelEdit: () => setEditing(null),
    pin: (x) => void pin(x),
    showLikers: (x) => void showLikers(x),
    remove: (x) => remove(x),
    report: (x) => report.open({ type: 'comment', id: x.id, authorId: x.author.id, authorName: x.author.displayName }),
    toggleThread: (x, more) => void toggleThread(x, more),
  };

  const header = (
    <View style={{ gap: space[3], marginBottom: space[2] }}>
      <PostCard post={post} open={false} commentCount={commentCount} onDeleted={() => (router.canGoBack() ? router.back() : router.replace('/'))} />
      <Text accessibilityRole="header" style={{ color: c.ink, fontWeight: '800', fontSize: 17 }}>
        {t('post.comments')}
      </Text>
      <Segmented
        label={t('comments.sort.label')}
        value={sort}
        onChange={setSort}
        options={[
          { id: 'top', label: t('comments.sort.top') },
          { id: 'newest', label: t('comments.sort.newest') },
        ]}
      />
      {controls?.isPostAuthor ? (
        <View style={{ gap: space[2] }}>
          <Text style={{ color: c.ink, fontWeight: '700' }}>{t('comments.settings.title')}</Text>
          <View
            accessibilityRole="radiogroup"
            accessibilityLabel={t('comments.settings.title')}
            style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}
          >
            {POLICIES.map((p) => {
              const on = controls.commentPolicy === p.id;
              return (
                <Pressable
                  key={p.id}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: on }}
                  onPress={() => !on && void setPolicy(p.id)}
                  style={{
                    minHeight: 36,
                    paddingHorizontal: space[3],
                    justifyContent: 'center',
                    borderRadius: radius.full,
                    borderWidth: 1,
                    borderColor: on ? c.yapi : c.line,
                    backgroundColor: on ? c.yapiSoft : c.surface,
                  }}
                >
                  <Text style={{ color: on ? c.yapi : c.ink, fontWeight: on ? '700' : '500', fontSize: 13 }}>{t(p.label)}</Text>
                </Pressable>
              );
            })}
          </View>
          {(controls.hiddenCount ?? 0) > 0 || hidden !== null ? (
            <View style={{ backgroundColor: c.surfaceSunken, borderRadius: radius.md, padding: space[3], gap: space[2] }}>
              <Text accessibilityRole="header" style={{ color: c.ink, fontWeight: '700' }}>
                {t('comments.hidden.title')}
              </Text>
              <Text style={{ color: c.inkMuted, fontSize: 13 }}>{t('comments.hidden.body')}</Text>
              <Button
                size="sm"
                variant="secondary"
                label={hidden ? t('comments.hidden.close') : tp('comments.hidden.review', controls.hiddenCount ?? 0)}
                onPress={() => toggleHidden()}
              />
              {hidden
                ? hidden.length
                  ? hidden.map((x) => (
                      <View key={x.id} style={{ gap: 4 }}>
                        <Text style={[{ color: c.ink, fontWeight: '700', fontSize: 13 }, userText]}>{x.author.displayName}</Text>
                        <TranslatableText
                          kind="comment"
                          id={x.id}
                          text={x.body}
                          lang={x.lang}
                          own={x.author.id === me?.id}
                          style={{ color: c.ink, fontSize: 15 }}
                        />
                        <View style={{ flexDirection: 'row', columnGap: space[3] }}>
                          <LinkAction label={t('comments.hidden.unhide')} onPress={() => void unhide(x)} />
                          <LinkAction label={t('m.common.delete')} onPress={() => remove(x, true)} />
                        </View>
                      </View>
                    ))
                  : [
                      <Text key="none" style={{ color: c.inkMuted }}>
                        {t('comments.hidden.none')}
                      </Text>,
                    ]
                : null}
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );

  return (
    <KeyboardAvoid style={{ backgroundColor: c.ground }}>
      <FlatList
        ref={list}
        data={comments}
        keyExtractor={(x) => x.id}
        onScrollToIndexFailed={(info) => {
          // Not laid out yet (far from where you are): get close, then try once more.
          list.current?.scrollToOffset({ offset: info.averageItemLength * info.index, animated: false });
          if (retried.current) return;
          retried.current = true;
          setTimeout(() => list.current?.scrollToIndex({ index: info.index, viewPosition: 0.3 }), 100);
        }}
        contentContainerStyle={{ padding: space[4], gap: space[3] }}
        ListHeaderComponent={header}
        ListEmptyComponent={
          // Comments on a post for subscribers are for subscribers too; until the first page comes, a spinner (or why it didn't).
          post.locked ? null : controls === null ? (
            error ? (
              <ErrorState message={error} onRetry={() => loadComments().then(() => setError(null), (e) => setError(errorMessage(e)))} />
            ) : (
              <Loading />
            )
          ) : (
            <Text style={{ color: c.inkMuted }}>{t('m.comment.none')}</Text>
          )
        }
        onEndReached={() => {
          if (!cursor || fetchingMore.current === cursor) return;
          fetchingMore.current = cursor;
          void loadComments(cursor)
            .catch(() => {})
            .finally(() => {
              fetchingMore.current = null;
            });
        }}
        keyboardShouldPersistTaps="handled"
        // Scrolling tucks the keyboard away, so the whole conversation is readable again.
        keyboardDismissMode="on-drag"
        renderItem={renderTop}
      />
      {me ? (
        <View
          style={{
            padding: space[3],
            paddingBottom: Math.max(insets.bottom, space[3]),
            gap: space[2],
            borderTopWidth: 1,
            borderTopColor: c.line,
            backgroundColor: c.ground,
          }}
        >
          {/* Comments that didn't load say so in the list, with Try again. */}
          {error && controls ? <Notice tone="danger">{error}</Notice> : null}
          {controls && !controls.canComment ? (
            <Text style={{ color: c.inkMuted }} accessibilityLiveRegion="polite">
              {t(CLOSED[controls.commentPolicy])}
            </Text>
          ) : (
            <>
              {replyTo ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[2] }}>
                  <Text style={{ color: c.inkMuted, flex: 1 }} numberOfLines={1}>
                    {t('comments.replyingTo', { name: replyTo.author.displayName })}
                  </Text>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t('comments.cancelReply')}
                    onPress={() => {
                      const answered = replyTo.id;
                      setReplyTo(null);
                      focusReplyButton(answered);
                    }}
                    hitSlop={6}
                  >
                    <Text style={{ color: c.yapi, fontWeight: '700' }}>{t('common.cancel')}</Text>
                  </Pressable>
                </View>
              ) : null}
              {ac.list}
              {momentMs !== null && post.format === 'reel' && !replyTo ? (
                <Pressable
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: pointAt }}
                  onPress={() => setPointAt((v) => !v)}
                  style={{ flexDirection: 'row', alignItems: 'center', gap: space[2], minHeight: 44 }}
                >
                  <Icon name={pointAt ? 'checkbox' : 'square-outline'} size={22} color={pointAt ? c.yapi : c.inkMuted} />
                  <Text style={{ color: c.ink, fontSize: 14 }}>{t('reel.moment.attach', { time: formatReelTime(momentMs) })}</Text>
                </Pressable>
              ) : null}
              <View style={{ flexDirection: 'row', gap: space[2], alignItems: 'flex-end' }}>
                <TextInput
                  {...ac.inputProps}
                  accessibilityLabel={replyTo ? t('comments.replyingTo', { name: replyTo.author.displayName }) : t('comment.placeholder')}
                  placeholder={replyTo ? t('comments.replyPlaceholder') : t('comment.placeholder')}
                  placeholderTextColor={c.inkMuted}
                  multiline
                  maxLength={2000}
                  style={[
                    {
                      flex: 1,
                      minHeight: 44,
                      maxHeight: 120,
                      borderRadius: radius.lg,
                      borderWidth: 1,
                      borderColor: c.line,
                      backgroundColor: c.surface,
                      color: c.ink,
                      paddingHorizontal: space[4],
                      paddingTop: 12,
                      paddingBottom: 12,
                      fontSize: 15,
                    },
                    userText,
                  ]}
                />
                <Button label={busy ? t('m.comment.posting') : t('m.comment.post')} disabled={!body.trim() || busy} onPress={() => send()} />
              </View>
            </>
          )}
        </View>
      ) : null}
      {report.sheet}
    </KeyboardAvoid>
  );
}

/** A small text button under a comment (Reply, Edit, Pin, Delete…). */
function LinkAction({ label, onPress, a11y, buttonRef }: { label: string; onPress: () => void; a11y?: string; buttonRef?: (v: View | null) => void }) {
  const c = useColors();
  return (
    <Pressable
      ref={buttonRef}
      accessibilityRole="button"
      accessibilityLabel={a11y ?? label}
      onPress={onPress}
      hitSlop={8}
      style={{ minHeight: 32, justifyContent: 'center' }}
    >
      <Text style={{ color: c.inkMuted, fontWeight: '700', fontSize: 12 }}>{label}</Text>
    </Pressable>
  );
}

/**
 * One comment, with its thread of replies under it when open. Memoised: typing a comment renders
 * the box you type in, not the comments above it. `editing` and `likers` are only passed to the
 * row they're about (a reply's go to its top-level comment).
 */
const CommentRow = memo(function CommentRow({
  x,
  reply,
  meId,
  canReply,
  isPostAuthor,
  thread: th,
  editing,
  likers,
  h,
}: {
  x: Comment;
  reply: boolean;
  meId: string | undefined;
  /** Signed in, and comments are open to you. */
  canReply: boolean;
  isPostAuthor: boolean;
  thread: Thread | undefined;
  editing: Editing | null;
  likers: Likers | null;
  h: { current: CommentHandlers | null };
}) {
  const c = useColors();
  const { t, tp, timeAgo } = useT();
  const name = x.author.displayName;
  const own = meId === x.author.id;
  return (
    <View style={{ gap: space[2] }}>
      <View style={{ flexDirection: 'row', gap: space[2] }}>
        <Pressable accessibilityRole="link" accessibilityLabel={name} onPress={() => router.push(`/u/${x.author.username}`)}>
          <Avatar name={name} url={x.author.avatarUrl} size={reply ? 28 : 32} />
        </Pressable>
        <View style={{ flex: 1, gap: 4 }}>
          <View style={[{ backgroundColor: c.surface, borderRadius: radius.md, padding: space[3], gap: 2 }, elevation(c)]}>
            {x.pinned ? (
              <Text style={{ color: c.inkMuted, fontSize: 12, fontWeight: '700' }} accessibilityRole="text">
                {t('comments.pinned')}
              </Text>
            ) : null}
            <Text style={[{ color: c.ink, fontWeight: '700', fontSize: 13 }, userText]}>
              {name}{' '}
              <Text style={{ color: c.inkMuted, fontWeight: '400' }}>
                · {timeAgo(x.createdAt)}
                {x.editedAt ? ` · ${t('comments.edited')}` : ''}
              </Text>
            </Text>
            {x.atMs !== null && x.atMs !== undefined ? (
              // A moment comment: plays the reel from that moment.
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t('reel.moment.seek', { time: formatReelTime(x.atMs) })}
                hitSlop={10}
                onPress={() => router.push({ pathname: '/reels', params: { start: x.postId, at: String(x.atMs) } })}
                style={{
                  alignSelf: 'flex-start',
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 4,
                  minHeight: 28,
                  paddingHorizontal: 8,
                  borderRadius: 8,
                  backgroundColor: c.yapiSoft,
                }}
              >
                <Icon name="play" size={11} color={c.ink} />
                <Text style={{ color: c.ink, fontWeight: '700', fontSize: 12, fontVariant: ['tabular-nums'] }}>
                  {t('reel.moment.at', { time: formatReelTime(x.atMs) })}
                </Text>
              </Pressable>
            ) : null}
            {editing?.id === x.id ? (
              <View style={{ gap: space[2] }}>
                <TextInput
                  accessibilityLabel={t('comments.editLabel')}
                  value={editing.body}
                  onChangeText={(v) => h.current?.editText(v)}
                  multiline
                  autoFocus
                  maxLength={2000}
                  style={[
                    { minHeight: 44, borderRadius: radius.md, borderWidth: 1, borderColor: c.line, color: c.ink, padding: space[2], fontSize: 15 },
                    userText,
                  ]}
                />
                <View style={{ flexDirection: 'row', gap: space[2] }}>
                  <Button
                    label={editing.busy ? t('m.common.saving') : t('common.save')}
                    size="sm"
                    disabled={editing.busy || !editing.body.trim()}
                    onPress={() => h.current?.saveEdit()}
                  />
                  <Button label={t('common.cancel')} size="sm" variant="secondary" onPress={() => h.current?.cancelEdit()} />
                </View>
              </View>
            ) : (
              <TranslatableText kind="comment" id={x.id} text={x.body} lang={x.lang} own={own} style={{ color: c.ink, fontSize: 15, lineHeight: 21 }} />
            )}
          </View>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: space[3], paddingStart: space[2] }}>
            <Pressable
              accessibilityRole="togglebutton"
              accessibilityState={{ checked: x.viewer.liked, disabled: !meId }}
              accessibilityLabel={`${t('comments.likeLabel', { name })}, ${tp('comments.likes', x.likes)}`}
              disabled={!meId}
              onPress={() => h.current?.like(x)}
              hitSlop={8}
              style={{ flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 32 }}
            >
              <Icon name={x.viewer.liked ? 'heart' : 'heart-outline'} size={16} color={x.viewer.liked ? c.yapi : c.inkMuted} />
              {x.likes > 0 ? <Text style={{ color: x.viewer.liked ? c.yapi : c.inkMuted, fontSize: 12, fontWeight: '700' }}>{x.likes}</Text> : null}
            </Pressable>
            {canReply ? (
              <LinkAction
                label={t('comments.reply')}
                onPress={() => h.current?.reply(x)}
                a11y={t('comments.replyTo', { name })}
                buttonRef={(v) => h.current?.replyButton(x.id, v)}
              />
            ) : null}
            {x.viewer.canEdit && editing?.id !== x.id ? <LinkAction label={t('comments.edit')} onPress={() => h.current?.edit(x)} /> : null}
            {isPostAuthor && !reply ? <LinkAction label={t(x.pinned ? 'comments.unpin' : 'comments.pin')} onPress={() => h.current?.pin(x)} /> : null}
            {own && x.likes > 0 ? <LinkAction label={t('comments.likers.show')} onPress={() => h.current?.showLikers(x)} /> : null}
            {x.viewer.canDelete ? <LinkAction label={t('m.common.delete')} onPress={() => h.current?.remove(x)} /> : null}
            {meId && !own ? <LinkAction label={t('post.report')} onPress={() => h.current?.report(x)} a11y={t('m.report.commentBy', { name })} /> : null}
            {x.likedByAuthor ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                <Icon name="heart" size={12} color={c.yapi} />
                <Text style={{ color: c.inkMuted, fontSize: 12 }}>{t('comments.likedByAuthor')}</Text>
              </View>
            ) : null}
          </View>
          {likers?.id === x.id ? (
            <View style={{ backgroundColor: c.surfaceSunken, borderRadius: radius.md, padding: space[3], gap: space[2] }}>
              <Text accessibilityRole="header" style={{ color: c.ink, fontWeight: '700' }}>
                {t('comments.likers.title')}
              </Text>
              {likers.items === null ? (
                <Loading />
              ) : likers.items.length ? (
                likers.items.map((u) => (
                  <Pressable
                    key={u.id}
                    accessibilityRole="link"
                    onPress={() => router.push(`/u/${u.username}`)}
                    style={{ flexDirection: 'row', alignItems: 'center', gap: space[2], minHeight: 36 }}
                  >
                    <Avatar name={u.displayName} url={u.avatarUrl} size={28} />
                    <Text style={[{ color: c.ink }, userText]}>{u.displayName}</Text>
                  </Pressable>
                ))
              ) : (
                <Text style={{ color: c.inkMuted }}>{t('comments.likers.none')}</Text>
              )}
            </View>
          ) : null}
          {!reply && (x.replies > 0 || th?.items.length) ? (
            <View style={{ gap: space[2] }}>
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ expanded: !!th?.open }}
                onPress={() => h.current?.toggleThread(x)}
                hitSlop={6}
                style={{ minHeight: 32, justifyContent: 'center', paddingStart: space[2] }}
              >
                <Text style={{ color: c.yapi, fontWeight: '700', fontSize: 12 }}>
                  {th?.open ? t('comments.hideReplies') : tp('comments.viewReplies', Math.max(x.replies, th?.items.length ?? 0))}
                </Text>
              </Pressable>
              {th?.open ? (
                <View style={{ gap: space[2], paddingStart: space[2], borderStartWidth: 2, borderStartColor: c.line }}>
                  {th.items.map((r) => (
                    <CommentRow
                      key={r.id}
                      x={r}
                      reply
                      meId={meId}
                      canReply={canReply}
                      isPostAuthor={isPostAuthor}
                      thread={undefined}
                      editing={editing?.id === r.id ? editing : null}
                      likers={likers?.id === r.id ? likers : null}
                      h={h}
                    />
                  ))}
                  {th.loading ? <Loading /> : null}
                  {th.cursor && !th.loading ? <LinkAction label={t('comments.moreReplies')} onPress={() => h.current?.toggleThread(x, true)} /> : null}
                </View>
              ) : null}
            </View>
          ) : null}
        </View>
      </View>
    </View>
  );
});
