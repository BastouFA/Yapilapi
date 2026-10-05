'use client';

import { Reposters } from '@/components/Reposters';
import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Avatar,
  Badge,
  BottomSheet,
  Button,
  EmptyState,
  Icon,
  List,
  ListItem,
  PostCard,
  PostHistory,
  Select,
  Skeleton,
  TextField,
} from '@yapilapi/design-system';
import type { SponsoredAd } from '@yapilapi/api-client';
import {
  adWhyText,
  noticeText,
  MAX_COLLABORATORS,
  REPORT_REASONS,
  whyReasonText,
  type MessageKey,
  type Page,
  type PhotoTag,
  type Post,
  type PostVersion,
  type PublicUser,
} from '@yapilapi/shared';
import { api, errorMessage, fieldErrors, isGone } from '@/lib/api';
import { NextLink } from '@/lib/link';
import { AutocompleteText } from '@/components/Autocomplete';
import { PeoplePicker } from '@/components/PeoplePicker';
import { useSession } from '@/app/providers';
import { useSignIn } from './SignedOut';
import { BoostSheet, type BoostChoices } from './Boost';
import { SaveToSheet } from './Boards';
import { CommentsSheet } from './Comments';
import { ReportSheet } from './ReportSheet';

export { ReportSheet };
import { SuggestAltText } from './AiHelpers';
import { hasVideo, WatchChatPicker } from './WatchTogether';

export { CommentsSheet };

/**
 * A paginated list of posts with every post interaction wired to the API:
 * like, comment, save, poll vote, feed controls, "why am I seeing this", report, edit, delete.
 */
export function PostList({
  load,
  empty,
  emptyTitle,
  reloadKey,
  sponsored = false,
  showEnd = true,
  boost,
  openComments,
}: {
  load: (cursor?: string) => Promise<Page<Post>>;
  empty?: string;
  emptyTitle?: string;
  reloadKey?: string;
  /** Allow one labelled sponsored post (only served to adults who opted in to advertising). */
  sponsored?: boolean;
  /** Show "You're all caught up" at the end (off for short embedded lists such as search results). */
  showEnd?: boolean;
  /** Open the boost sheet for this post once it loads, with these choices filled in (a link from the phone app). */
  boost?: { postId: string; choices?: BoostChoices };
  /** Open this post's comments once it loads (a notification about a comment). */
  openComments?: string;
}) {
  const { me, toast, t, tp, locale, flags } = useSession();
  const [memoryFor, setMemoryFor] = useState<Post | null>(null);
  const [posts, setPosts] = useState<Post[] | null>(null);
  // Why the first page couldn't load, when that isn't because it's gone or private (which shows as empty).
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [commentsFor, setCommentsFor] = useState<Post | null>(null);
  // The reasons, and which feed controls apply (no less or more like this while personalization is off).
  const [why, setWhy] = useState<{ post: Post; reasons: string[]; controls?: string[] } | null>(null);
  const [reporting, setReporting] = useState<Post | null>(null);
  const [boosting, setBoosting] = useState<Post | null>(null);
  const [coauthorsFor, setCoauthorsFor] = useState<string | null>(null);
  const [repostersOf, setRepostersOf] = useState<string | null>(null);
  const [saveTo, setSaveTo] = useState<Post | null>(null);
  const [editing, setEditing] = useState<Post | null>(null);
  const [historyFor, setHistoryFor] = useState<Post | null>(null);
  // Video posts: sharing offers "Watch together" too, which picks a chat.
  const [shareFor, setShareFor] = useState<Post | null>(null);
  const [watchFor, setWatchFor] = useState<Post | null>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const [ad, setAd] = useState<SponsoredAd | null>(null);
  const [adWhy, setAdWhy] = useState(false);
  const adClicked = useRef(false);
  // Without an account, anything that acts on a post goes to sign in first (reading comments doesn't).
  const signIn = useSignIn();
  const guard =
    <A extends unknown[]>(fn: (...a: A) => unknown) =>
    (...a: A) =>
      me ? fn(...a) : signIn();

  useEffect(() => {
    setAd(null);
    adClicked.current = false;
    if (!sponsored || !flags.ADS) return;
    api.ads.next().then(
      (r) => setAd(r.ad),
      () => {},
    );
  }, [sponsored, flags.ADS, reloadKey]);

  useEffect(() => {
    let cancelled = false;
    setPosts(null);
    setLoadError(null);
    load()
      .then((p) => {
        if (cancelled) return;
        setPosts(p.items);
        setCursor(p.nextCursor);
      })
      .catch((e) => {
        if (cancelled) return;
        if (!isGone(e)) return setLoadError(errorMessage(e));
        setPosts([]);
        toast(errorMessage(e));
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadKey, attempt]);

  const more = useCallback(async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const p = await load(cursor);
      setPosts((cur) => [...(cur ?? []), ...p.items.filter((x) => !cur?.some((c) => c.id === x.id))]);
      setCursor(p.nextCursor);
    } catch (e) {
      toast(errorMessage(e));
    } finally {
      setLoadingMore(false);
    }
  }, [cursor, loadingMore, load, toast]);

  // A link asked to boost one of these posts: open the sheet once, when it's your own post.
  const boostOpened = useRef(false);
  useEffect(() => {
    if (!boost || boostOpened.current || !posts || !me || !flags.ADS || flags.COMMERCE === false) return;
    const target = posts.find((x) => x.id === boost.postId && x.author.id === me.id);
    if (!target) return;
    boostOpened.current = true;
    setBoosting(target);
  }, [boost, posts, me, flags.ADS, flags.COMMERCE]);

  // A link to a post's comments: open them once, when the post is there.
  const commentsOpened = useRef(false);
  useEffect(() => {
    if (!openComments || commentsOpened.current || !posts) return;
    const target = posts.find((x) => x.id === openComments);
    if (!target) return;
    commentsOpened.current = true;
    setCommentsFor(target);
  }, [openComments, posts]);

  // Load the next page when the reader reaches the end, but the feed still ends.
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => entries[0]?.isIntersecting && void more(), { rootMargin: '600px' });
    io.observe(el);
    return () => io.disconnect();
  }, [more]);

  const patch = (id: string, fn: (p: Post) => Post) => setPosts((cur) => cur?.map((p) => (p.id === id ? fn(p) : p)) ?? cur);

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

  async function repost(p: Post) {
    const reposted = !p.viewer.reposted;
    patch(p.id, (x) => ({ ...x, viewer: { ...x.viewer, reposted }, counts: { ...x.counts, reposts: Math.max(0, x.counts.reposts + (reposted ? 1 : -1)) } }));
    try {
      const r = reposted ? await api.posts.repost(p.id) : await api.posts.unrepost(p.id);
      patch(p.id, (x) => ({ ...x, viewer: { ...x.viewer, reposted: r.reposted }, counts: { ...x.counts, reposts: r.reposts } }));
      toast(t(reposted ? 'postList.reposted' : 'postList.repostRemoved'));
    } catch (e) {
      patch(p.id, () => p);
      toast(errorMessage(e));
    }
  }

  /** The system share sheet where there is one (phones), otherwise copy the link. */
  async function share(p: Post) {
    const url = `${location.origin}${p.format === 'reel' ? `/reels?start=${p.id}` : `/p/${p.id}`}`;
    const title = t('postList.shareTitle', { name: p.author.displayName });
    try {
      if (navigator.share) {
        await navigator.share({ title, text: p.body ? p.body.slice(0, 120) : title, url });
        return;
      }
      await navigator.clipboard.writeText(url);
      toast(t('invite.copied'));
    } catch (e) {
      // Closing the share sheet isn't an error.
      if ((e as Error).name !== 'AbortError') toast(t('postList.shareFailed'));
    }
  }

  async function save(p: Post) {
    const saved = !p.viewer.saved;
    patch(p.id, (x) => ({ ...x, viewer: { ...x.viewer, saved } }));
    try {
      if (saved) await api.posts.save(p.id);
      else await api.posts.unsave(p.id);
      if (saved) toast(t('m.saved.done'), { label: t('m.saved.addToBoard'), onClick: () => setSaveTo(p) });
      else toast(t('postList.unsaved'));
    } catch (e) {
      patch(p.id, () => p);
      toast(errorMessage(e));
    }
  }

  async function vote(p: Post, optionId: string) {
    try {
      const r = await api.posts.vote(p.id, optionId);
      patch(p.id, (x) => ({ ...x, poll: r.poll }));
    } catch (e) {
      toast(errorMessage(e));
    }
  }

  async function feedback(p: Post, signal: 'more_like_this' | 'less_like_this' | 'not_interested' | 'mute_creator') {
    try {
      await api.feedback({ signal, postId: p.id });
      if (signal === 'not_interested' || signal === 'mute_creator')
        setPosts((cur) => cur?.filter((x) => (signal === 'mute_creator' ? x.author.id !== p.author.id : x.id !== p.id)) ?? cur);
      toast(
        signal === 'more_like_this'
          ? t('postList.moreLikeThis')
          : signal === 'less_like_this'
            ? t('postList.lessLikeThis')
            : signal === 'mute_creator'
              ? t('postList.muted', { name: p.author.displayName })
              : t('postList.hidden'),
      );
    } catch (e) {
      toast(errorMessage(e));
    }
  }

  async function pin(p: Post) {
    try {
      await api.posts.pin(p.pinned ? null : p.id);
      // Only one post is pinned at a time; the list order changes on the next load.
      setPosts((cur) => cur?.map((x) => ({ ...x, pinned: x.id === p.id ? !p.pinned : false })) ?? cur);
      toast(t(p.pinned ? 'postList.unpinned' : 'postList.pinned'));
    } catch (e) {
      toast(errorMessage(e));
    }
  }

  async function acceptCollab(p: Post) {
    try {
      const r = await api.posts.acceptCollab(p.id);
      patch(p.id, () => r.post);
      toast(t('postList.collabAccepted'));
    } catch (e) {
      toast(errorMessage(e));
    }
  }

  async function declineCollab(p: Post) {
    try {
      await api.posts.declineCollab(p.id);
      patch(p.id, (x) => ({ ...x, viewer: { ...x.viewer, collab: undefined } }));
      toast(t('postList.collabDeclined'));
    } catch (e) {
      toast(errorMessage(e));
    }
  }

  async function leaveCollab(p: Post) {
    try {
      await api.posts.leaveCollab(p.id);
      patch(p.id, (x) => ({
        ...x,
        collaborators: x.collaborators?.filter((c) => c.id !== me?.id),
        viewer: { ...x.viewer, collab: undefined },
      }));
      toast(t('postList.collabLeft'));
    } catch (e) {
      toast(errorMessage(e));
    }
  }

  async function removeTag(p: Post, mediaId: string, tag: PhotoTag) {
    try {
      await api.posts.removeTag(p.id, tag.id);
      patch(p.id, (x) => ({
        ...x,
        media: x.media.map((m) => (m.id === mediaId ? { ...m, tags: m.tags?.filter((t) => t.id !== tag.id) } : m)),
      }));
      toast(t(tag.user.id === me?.id ? 'postList.tagRemovedSelf' : 'postList.tagRemoved'));
    } catch (e) {
      toast(errorMessage(e));
    }
  }

  async function remove(p: Post) {
    try {
      await api.posts.remove(p.id);
      setPosts((cur) => cur?.filter((x) => x.id !== p.id) ?? cur);
      toast(t('postList.deleted'));
    } catch (e) {
      toast(errorMessage(e));
    }
  }

  // The sponsored post follows the third post in the list (or the last, in a short list).
  const renderAd = (slotAd: SponsoredAd) => (
    <section className="yp-sponsored" aria-label={t('postList.sponsoredPost')}>
      <div className="yp-sponsored__bar">
        <Badge tone="neutral">{t('ads.sponsored')}</Badge>
        <span className="yp-spacer" />
        <Button size="sm" variant="ghost" onClick={() => setAdWhy(true)}>
          {t('postList.whyAd')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={async () => {
            setAd(null);
            await api.ads.hide(slotAd.campaignId).catch(() => {});
            toast(t('postList.adHidden'));
          }}
        >
          {t('m.chapters.hide')}
        </Button>
      </div>
      <div
        onClickCapture={() => {
          if (adClicked.current) return;
          adClicked.current = true;
          void api.ads.click(slotAd.campaignId).catch(() => {});
        }}
      >
        <PostCard
          post={slotAd.post}
          locale={locale}
          linkAs={NextLink}
          isOwn={false}
          onLike={like}
          onSave={save}
          onShare={share}
          onVote={vote}
          onComment={setCommentsFor}
          onReport={setReporting}
        />
      </div>
    </section>
  );

  if (posts === null && loadError)
    return <EmptyState title={loadError} action={<Button onClick={() => setAttempt((n) => n + 1)}>{t('m.common.retry')}</Button>} />;
  if (posts === null)
    return (
      <div className="stack" aria-busy>
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} height={180} />
        ))}
      </div>
    );
  if (!posts.length) return <EmptyState title={emptyTitle ?? t('m.feed.empty.title')} body={empty ?? t('m.feed.empty.body')} />;

  return (
    <div className="stack">
      {posts.map((p, i) => (
        <Fragment key={p.id}>
          <PostCard
            key={p.id}
            post={p}
            locale={locale}
            linkAs={NextLink}
            isOwn={p.author.id === me?.id}
            onLike={guard(like)}
            onSave={guard(save)}
            onSaveTo={me ? setSaveTo : undefined}
            onRepost={guard(repost)}
            onReposters={(p) => setRepostersOf(p.id)}
            onShare={(post) => (me && hasVideo(post) ? setShareFor(post) : void share(post))}
            onVote={guard(vote)}
            onComment={setCommentsFor}
            onFeedback={me ? feedback : undefined}
            onWhy={
              me
                ? async (post) => {
                    try {
                      const why = await api.posts.why(post.id);
                      // Each line in the reader's language; an older API only sends them in English.
                      setWhy({
                        post,
                        reasons: why.details ? why.details.map((d) => whyReasonText(d, { t, tp, locale })) : why.reasons,
                        controls: why.controls,
                      });
                    } catch (e) {
                      toast(errorMessage(e));
                    }
                  }
                : undefined
            }
            onReport={guard(setReporting)}
            onDelete={remove}
            onPin={me ? pin : undefined}
            onBoost={me && flags.ADS && flags.COMMERCE !== false ? setBoosting : undefined}
            onAddToMemory={me && flags.MEMORY ? setMemoryFor : undefined}
            viewerId={me?.id}
            onAcceptCollab={me ? acceptCollab : undefined}
            onDeclineCollab={me ? declineCollab : undefined}
            onLeaveCollab={me ? leaveCollab : undefined}
            onRemoveTag={me ? removeTag : undefined}
            onManageCollaborators={me ? (post) => setCoauthorsFor(post.id) : undefined}
            onEdit={me ? setEditing : undefined}
            onHistory={setHistoryFor}
          />
          {ad && i === Math.min(2, posts.length - 1) ? renderAd(ad) : null}
        </Fragment>
      ))}
      <div ref={sentinel} />
      {cursor ? (
        <Button variant="secondary" loading={loadingMore} onClick={more}>
          {t('feed.loadMore')}
        </Button>
      ) : showEnd ? (
        <p className="muted" style={{ textAlign: 'center' }}>
          {t('feed.end')}
        </p>
      ) : null}

      {commentsFor ? (
        <CommentsSheet
          post={commentsFor}
          onClose={() => setCommentsFor(null)}
          onCountChange={(d) => patch(commentsFor.id, (x) => ({ ...x, counts: { ...x.counts, comments: Math.max(0, x.counts.comments + d) } }))}
        />
      ) : null}

      <BottomSheet open={!!shareFor} onClose={() => setShareFor(null)} title={t('m.common.share')}>
        <ul className="reel-sheet__list">
          <li>
            <button
              type="button"
              className="reel-sheet__item"
              onClick={() => {
                const p = shareFor;
                setShareFor(null);
                if (p) void share(p);
              }}
            >
              <span className="reel-sheet__icon">
                <Icon name="send" size={20} />
              </span>
              <span>{t('reel.share.link')}</span>
            </button>
          </li>
          <li>
            <button
              type="button"
              className="reel-sheet__item"
              onClick={() => {
                setWatchFor(shareFor);
                setShareFor(null);
              }}
            >
              <span className="reel-sheet__icon">
                <Icon name="play" size={20} />
              </span>
              <span>{t('watch.start')}</span>
            </button>
          </li>
        </ul>
      </BottomSheet>
      <WatchChatPicker post={watchFor} onClose={() => setWatchFor(null)} />

      <Reposters postId={repostersOf} onClose={() => setRepostersOf(null)} />
      <BottomSheet open={!!why} onClose={() => setWhy(null)} title={t('post.why')}>
        <ul className="stack-sm" style={{ paddingInlineStart: 20, margin: 0 }}>
          {why?.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
        <div className="row" style={{ marginTop: 16 }}>
          {!why?.controls || why.controls.includes('less_like_this') ? (
            <Button variant="secondary" size="sm" onClick={() => why && (feedback(why.post, 'less_like_this'), setWhy(null))}>
              {t('post.lessLikeThis')}
            </Button>
          ) : null}
          {!why?.controls || why.controls.includes('more_like_this') ? (
            <Button variant="ghost" size="sm" onClick={() => why && (feedback(why.post, 'more_like_this'), setWhy(null))}>
              {t('post.moreLikeThis')}
            </Button>
          ) : null}
        </div>
      </BottomSheet>

      <BottomSheet open={adWhy && !!ad} onClose={() => setAdWhy(false)} title={t('postList.whyAdTitle')}>
        <ul className="stack-sm" style={{ paddingInlineStart: 20, margin: 0 }}>
          {(ad?.whyDetails ? ad.whyDetails.map((w) => adWhyText(w, { t, locale })) : (ad?.why ?? [])).map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
        <p className="muted">{t('postList.adBody')}</p>
      </BottomSheet>

      <ReportSheet target={reporting ? { type: 'post', id: reporting.id } : null} onClose={() => setReporting(null)} />
      <BoostSheet
        post={boosting}
        choices={boosting && boost?.postId === boosting.id ? boost.choices : undefined}
        onClose={() => setBoosting(null)}
        onDone={() => {
          // Show the boost's status (and later its results) on the post.
          const id = boosting?.id;
          if (id)
            void api.posts.get(id).then(
              (r) => patch(id, () => r.post),
              () => {},
            );
        }}
      />
      <SaveToSheet post={saveTo} onClose={() => setSaveTo(null)} onSaved={(id) => patch(id, (x) => ({ ...x, viewer: { ...x.viewer, saved: true } }))} />
      {memoryFor ? <AddToMemorySheet post={memoryFor} onClose={() => setMemoryFor(null)} /> : null}
      {editing ? <EditPostSheet post={editing} onClose={() => setEditing(null)} onSaved={(post) => patch(post.id, () => post)} /> : null}
      {historyFor ? <HistorySheet post={historyFor} onClose={() => setHistoryFor(null)} /> : null}
      {coauthorsFor && posts.some((x) => x.id === coauthorsFor) ? (
        <CoauthorsSheet
          post={posts.find((x) => x.id === coauthorsFor)!}
          onClose={() => setCoauthorsFor(null)}
          onChanged={(post) => patch(post.id, () => post)}
        />
      ) : null}
    </div>
  );
}

/** Who an edited post can be for: the audiences that need no extra choice (circles and chosen people are set when posting). */
const EDIT_AUDIENCES = ['public', 'followers', 'friends', 'private', 'subscribers'] as const;

/**
 * Change your post: its text, who can see it, and the description of each photo
 * or video. Photos, polls and links stay as they are. Earlier text stays in the
 * post's history, which anyone who can see the post can open.
 */
export function EditPostSheet({ post, onClose, onSaved }: { post: Post; onClose: () => void; onSaved: (p: Post) => void }) {
  const { toast, t, me } = useSession();
  const [body, setBody] = useState(post.body);
  const [visibility, setVisibility] = useState(post.visibility);
  const [alts, setAlts] = useState<Record<string, string>>(() => Object.fromEntries(post.media.map((m) => [m.id, m.altText ?? ''])));
  const [hasPlans, setHasPlans] = useState(post.visibility === 'subscribers');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  useEffect(() => {
    if (me && post.visibility !== 'subscribers')
      api.economy.plans(me.id).then(
        (r) => setHasPlans(r.items.length > 0),
        () => {},
      );
  }, [me, post.visibility]);
  const describable = post.media.filter((m) => m.kind !== 'audio');
  const changedAlts = describable.filter((m) => (alts[m.id] ?? '') !== (m.altText ?? ''));
  const changed = body.trim() !== post.body || visibility !== post.visibility || changedAlts.length > 0;
  const audiences = EDIT_AUDIENCES.filter((v) => v !== 'subscribers' || hasPlans);
  return (
    <BottomSheet open onClose={onClose} title={t('m.post.editTitle')}>
      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          setFields({});
          try {
            const r = await api.posts.edit(post.id, {
              ...(body.trim() !== post.body ? { body: body.trim() } : {}),
              ...(visibility !== post.visibility ? { visibility: visibility as (typeof EDIT_AUDIENCES)[number] } : {}),
              ...(changedAlts.length ? { media: changedAlts.map((m) => ({ id: m.id, altText: (alts[m.id] ?? '').trim() })) } : {}),
            });
            onSaved(r.post);
            toast(noticeText(r.moderation, t) ?? t('m.post.updated'));
            onClose();
          } catch (err) {
            setError(errorMessage(err));
            setFields(fieldErrors(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        {error ? <Alert tone="danger">{error}</Alert> : null}
        <label className="yp-field__label" htmlFor={`edit-${post.id}`}>
          {t('m.post.text')}
        </label>
        <AutocompleteText
          id={`edit-${post.id}`}
          className="yp-input"
          value={body}
          onValueChange={setBody}
          maxLength={post.format === 'reel' ? 2200 : 5000}
          rows={5}
          aria-invalid={!!fields.body}
        />
        {fields.body ? <span className="yp-field__error">{fields.body}</span> : null}
        {describable.length ? (
          <div className="stack-sm">
            <span className="yp-field__label">{t('postList.describeMedia')}</span>
            {describable.map((m, i) => (
              <div key={m.id} className="row" style={{ alignItems: 'center', flexWrap: 'nowrap' }}>
                {m.kind === 'video' ? (
                  <video
                    src={m.variants?.mp4 ?? m.url}
                    poster={m.posterUrl ?? undefined}
                    muted
                    style={{ width: 56, height: 56, objectFit: 'cover', borderRadius: 8 }}
                  />
                ) : (
                  <img src={m.variants?.thumb ?? m.url} alt="" style={{ width: 56, height: 56, objectFit: 'cover', borderRadius: 8 }} />
                )}
                <input
                  className="yp-input"
                  style={{ flex: 1 }}
                  placeholder={t('postList.altPlaceholder')}
                  aria-label={t(m.kind === 'video' ? 'postList.describeVideo' : 'postList.describePhoto', { index: i + 1 })}
                  maxLength={500}
                  value={alts[m.id] ?? ''}
                  onChange={(e) => {
                    const v = e.currentTarget.value;
                    setAlts((cur) => ({ ...cur, [m.id]: v }));
                  }}
                />
                {m.kind === 'image' && post.author.id === me?.id ? (
                  <SuggestAltText mediaId={m.id} index={i} compact onSuggested={(text) => setAlts((cur) => ({ ...cur, [m.id]: text.slice(0, 500) }))} />
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
        {post.community ? (
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>
            {t('postList.communityAudience')}
          </p>
        ) : (
          <Select label={t('create.visibility')} value={visibility} onChange={(e) => setVisibility(e.currentTarget.value as Post['visibility'])}>
            {!(EDIT_AUDIENCES as readonly string[]).includes(post.visibility) ? (
              <option value={post.visibility}>{t(`visibility.${post.visibility}` as MessageKey)}</option>
            ) : null}
            {audiences.map((v) => (
              <option key={v} value={v}>
                {t(`visibility.${v}` as MessageKey)}
              </option>
            ))}
          </Select>
        )}
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>
          {t('m.post.editNote')}
        </p>
        <Button type="submit" loading={busy} disabled={!changed}>
          {t('m.post.saveChanges')}
        </Button>
      </form>
    </BottomSheet>
  );
}

/** The versions of an edited post's text, newest first. */
export function HistorySheet({ post, onClose }: { post: Post; onClose: () => void }) {
  const { toast, locale, t } = useSession();
  const [items, setItems] = useState<PostVersion[] | null>(null);
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });
  useEffect(() => {
    api.posts.history(post.id).then(
      (r) => setItems(r.items),
      (e) => {
        toast(errorMessage(e));
        close.current();
      },
    );
  }, [post.id, toast]);
  return (
    <BottomSheet open onClose={onClose} title={t('m.post.history')}>
      {items === null ? <Skeleton height={80} /> : <PostHistory versions={items} locale={locale} linkAs={NextLink} />}
    </BottomSheet>
  );
}

/** The original author invites co-authors to a post, cancels invites, or takes a co-author off. */
function CoauthorsSheet({ post, onClose, onChanged }: { post: Post; onClose: () => void; onChanged: (p: Post) => void }) {
  const { toast, t, tp } = useSession();
  const [picked, setPicked] = useState<PublicUser[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const people = [
    ...(post.collaborators ?? []).map((user) => ({ user, pending: false })),
    ...(post.pendingCollaborators ?? []).map((user) => ({ user, pending: true })),
  ];
  const room = MAX_COLLABORATORS - people.length;
  const run = async (key: string, fn: () => Promise<{ post: Post }>, done: string) => {
    setBusy(key);
    try {
      onChanged((await fn()).post);
      toast(done);
    } catch (e) {
      toast(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <BottomSheet open onClose={onClose} title={t('postList.coauthors')}>
      <div className="stack">
        {people.length ? (
          <List label={t('postList.coauthors')}>
            {people.map(({ user, pending }) => (
              <ListItem
                key={user.id}
                start={<Avatar name={user.displayName} src={user.avatarUrl} size="sm" />}
                primary={user.displayName}
                secondary={t(pending ? 'boards.pending' : 'postList.coauthor')}
                end={
                  <Button
                    size="sm"
                    variant="ghost"
                    loading={busy === user.id}
                    disabled={!!busy}
                    onClick={() =>
                      run(
                        user.id,
                        () => api.posts.removeCollaborator(post.id, user.id),
                        pending ? t('boards.inviteCancelled') : t('postList.coauthorRemoved', { name: user.displayName }),
                      )
                    }
                  >
                    {t(pending ? 'boards.cancelInvite' : 'm.common.remove')}
                  </Button>
                }
              />
            ))}
          </List>
        ) : (
          <p className="muted" style={{ margin: 0 }}>
            {t('postList.noCoauthors')}
          </p>
        )}
        {room > 0 ? (
          <>
            <PeoplePicker
              label={t('m.collab.inviteTitle')}
              hint={t('postList.coauthorHint')}
              scope="mutuals"
              max={room}
              canPick={() => true}
              exclude={people.map((p) => p.user.id)}
              picked={picked}
              onChange={setPicked}
            />
            <Button
              disabled={!picked.length || !!busy}
              loading={busy === 'invite'}
              onClick={() =>
                run(
                  'invite',
                  async () => {
                    const r = await api.posts.inviteCollaborators(
                      post.id,
                      picked.map((u) => u.id),
                    );
                    setPicked([]);
                    return r;
                  },
                  tp('boards.invitesSent', picked.length),
                )
              }
            >
              {tp('boards.sendInvites', picked.length)}
            </Button>
          </>
        ) : (
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>
            {t('postList.coauthorMax', { count: MAX_COLLABORATORS })}
          </p>
        )}
      </div>
    </BottomSheet>
  );
}

function AddToMemorySheet({ post, onClose }: { post: Post; onClose: () => void }) {
  const { toast, t } = useSession();
  const [memories, setMemories] = useState<{ id: string; title: string; mine: boolean }[] | null>(null);
  const [title, setTitle] = useState('');
  useEffect(() => {
    api.memories.list().then(
      (r) => setMemories(r.items.filter((m) => m.mine)),
      (e) => toast(errorMessage(e)),
    );
  }, [toast]);
  const add = async (memoryId: string, name: string) => {
    try {
      await api.memories.addItem(memoryId, 'post', post.id);
      toast(t('boards.addedTo', { name }));
      onClose();
    } catch (e) {
      toast(errorMessage(e));
    }
  };
  return (
    <BottomSheet open onClose={onClose} title={t('postList.addToMemory')}>
      <div className="stack-sm">
        {memories === null ? (
          <Skeleton height={60} />
        ) : (
          memories.map((m) => (
            <Button key={m.id} variant="secondary" block onClick={() => add(m.id, m.title)}>
              {m.title}
            </Button>
          ))
        )}
        <form
          className="stack-sm"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              const { memory } = await api.memories.create({ title });
              await add(memory.id, memory.title);
            } catch (err) {
              toast(errorMessage(err));
            }
          }}
        >
          <TextField label={t('postList.newMemory')} value={title} onChange={(e) => setTitle(e.currentTarget.value)} maxLength={120} />
          <Button type="submit" disabled={!title.trim()}>
            {t('postList.createAndAdd')}
          </Button>
        </form>
      </div>
    </BottomSheet>
  );
}
