'use client';

import Link from 'next/link';
import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { Avatar, Badge, BottomSheet, Button, EmptyState, PostCard, Select, Skeleton, TaggedText, TextField } from '@yapilapi/design-system';
import type { SponsoredAd } from '@yapilapi/api-client';
import { formatRelativeTime, REPORT_REASONS, type Comment, type Page, type Post } from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';
import { NextLink } from '@/lib/link';
import { AutocompleteText } from '@/components/Autocomplete';
import { useSession } from '@/app/providers';
import { signInHref, useSignIn } from './SignedOut';

/**
 * A paginated list of posts with every post interaction wired to the API:
 * like, comment, save, poll vote, feed controls, "why am I seeing this", report, delete.
 */
export function PostList({
  load,
  empty,
  reloadKey,
  sponsored = false,
}: {
  load: (cursor?: string) => Promise<Page<Post>>;
  empty?: string;
  reloadKey?: string;
  /** Allow one labelled sponsored post (only served to adults who opted in to advertising). */
  sponsored?: boolean;
}) {
  const { me, toast, t, locale, flags } = useSession();
  const [memoryFor, setMemoryFor] = useState<Post | null>(null);
  const [posts, setPosts] = useState<Post[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [commentsFor, setCommentsFor] = useState<Post | null>(null);
  const [why, setWhy] = useState<{ post: Post; reasons: string[] } | null>(null);
  const [reporting, setReporting] = useState<Post | null>(null);
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
    load()
      .then((p) => {
        if (cancelled) return;
        setPosts(p.items);
        setCursor(p.nextCursor);
      })
      .catch((e) => !cancelled && (setPosts([]), toast(errorMessage(e))));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadKey]);

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
      toast(reposted ? 'Reposted to your followers' : 'Repost removed');
    } catch (e) {
      patch(p.id, () => p);
      toast(errorMessage(e));
    }
  }

  async function save(p: Post) {
    const saved = !p.viewer.saved;
    patch(p.id, (x) => ({ ...x, viewer: { ...x.viewer, saved } }));
    try {
      if (saved) await api.posts.save(p.id);
      else await api.posts.unsave(p.id);
      toast(saved ? t('common.saved') : 'Removed from saved');
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
          ? "We'll show more like this."
          : signal === 'less_like_this'
            ? "We'll show less like this."
            : signal === 'mute_creator'
              ? `Muted ${p.author.displayName}.`
              : 'Hidden.',
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
      toast(p.pinned ? 'Unpinned from your profile' : 'Pinned to the top of your profile');
    } catch (e) {
      toast(errorMessage(e));
    }
  }

  async function remove(p: Post) {
    try {
      await api.posts.remove(p.id);
      setPosts((cur) => cur?.filter((x) => x.id !== p.id) ?? cur);
      toast('Post deleted');
    } catch (e) {
      toast(errorMessage(e));
    }
  }

  // The sponsored post follows the third post in the list (or the last, in a short list).
  const renderAd = (slotAd: SponsoredAd) => (
    <section className="yp-sponsored" aria-label="Sponsored post">
      <div className="yp-sponsored__bar">
        <Badge tone="neutral">{slotAd.label}</Badge>
        <span className="yp-spacer" />
        <Button size="sm" variant="ghost" onClick={() => setAdWhy(true)}>
          Why this ad?
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={async () => {
            setAd(null);
            await api.ads.hide(slotAd.campaignId).catch(() => {});
            toast("You won't see this ad again.");
          }}
        >
          Hide
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
          onVote={vote}
          onComment={setCommentsFor}
          onReport={setReporting}
        />
      </div>
    </section>
  );

  if (posts === null)
    return (
      <div className="stack" aria-busy>
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} height={180} />
        ))}
      </div>
    );
  if (!posts.length) return <EmptyState title="Nothing here yet" body={empty ?? t('feed.empty')} />;

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
            onRepost={guard(repost)}
            onVote={guard(vote)}
            onComment={setCommentsFor}
            onFeedback={me ? feedback : undefined}
            onWhy={me ? async (post) => setWhy({ post, reasons: (await api.posts.why(post.id)).reasons }) : undefined}
            onReport={guard(setReporting)}
            onDelete={remove}
            onPin={me ? pin : undefined}
            onAddToMemory={me && flags.MEMORY ? setMemoryFor : undefined}
          />
          {ad && i === Math.min(2, posts.length - 1) ? renderAd(ad) : null}
        </Fragment>
      ))}
      <div ref={sentinel} />
      {cursor ? (
        <Button variant="secondary" loading={loadingMore} onClick={more}>
          {t('feed.loadMore')}
        </Button>
      ) : (
        <p className="muted" style={{ textAlign: 'center' }}>
          {t('feed.end')}
        </p>
      )}

      {commentsFor ? (
        <CommentsSheet
          post={commentsFor}
          onClose={() => setCommentsFor(null)}
          onAdded={() => patch(commentsFor.id, (x) => ({ ...x, counts: { ...x.counts, comments: x.counts.comments + 1 } }))}
        />
      ) : null}

      <BottomSheet open={!!why} onClose={() => setWhy(null)} title={t('post.why')}>
        <ul className="stack-sm" style={{ paddingLeft: 20, margin: 0 }}>
          {why?.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
        <div className="row" style={{ marginTop: 16 }}>
          <Button variant="secondary" size="sm" onClick={() => why && (feedback(why.post, 'less_like_this'), setWhy(null))}>
            {t('post.lessLikeThis')}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => why && (feedback(why.post, 'more_like_this'), setWhy(null))}>
            {t('post.moreLikeThis')}
          </Button>
        </div>
      </BottomSheet>

      <BottomSheet open={adWhy && !!ad} onClose={() => setAdWhy(false)} title="Why you're seeing this ad">
        <ul className="stack-sm" style={{ paddingLeft: 20, margin: 0 }}>
          {ad?.why.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
        <p className="muted">
          Ads are paid for by the account that posted them. You can turn advertising off in Settings, under Privacy, and no ads are ever shown to people under
          18.
        </p>
      </BottomSheet>

      <ReportSheet target={reporting ? { type: 'post', id: reporting.id } : null} onClose={() => setReporting(null)} />
      {memoryFor ? <AddToMemorySheet post={memoryFor} onClose={() => setMemoryFor(null)} /> : null}
    </div>
  );
}

export function CommentsSheet({ post, onClose, onAdded }: { post: Post; onClose: () => void; onAdded: () => void }) {
  const { toast, t, locale, me } = useSession();
  const [items, setItems] = useState<Comment[] | null>(null);
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.posts.comments(post.id).then(
      (r) => setItems(r.items),
      (e) => toast(errorMessage(e)),
    );
  }, [post.id, toast]);
  return (
    <BottomSheet open onClose={onClose} title={t('post.comments')}>
      <div className="stack">
        {items === null ? (
          <Skeleton height={60} />
        ) : items.length ? (
          items.map((c) => (
            <div key={c.id} className="comment">
              <Avatar name={c.author.displayName} src={c.author.avatarUrl} size="sm" />
              <div className="comment__bubble">
                <strong>
                  {c.author.displayName} <span className="muted">· {formatRelativeTime(c.createdAt, locale)}</span>
                </strong>
                <TaggedText text={c.body} linkAs={NextLink} />
              </div>
            </div>
          ))
        ) : (
          <p className="muted">No comments yet. Start the conversation.</p>
        )}
        {!me ? (
          <div className="row">
            <span className="muted">Sign in to join the conversation.</span>
            <Link href={signInHref()} className="yp-btn yp-btn--primary yp-btn--sm">
              Sign in
            </Link>
          </div>
        ) : (
          <form
            className="stack-sm"
            onSubmit={async (e) => {
              e.preventDefault();
              if (!body.trim()) return;
              setBusy(true);
              try {
                const { comment } = await api.posts.comment(post.id, body.trim());
                setItems((cur) => [...(cur ?? []), comment]);
                setBody('');
                onAdded();
              } catch (err) {
                toast(errorMessage(err));
              } finally {
                setBusy(false);
              }
            }}
          >
            <label className="yp-visually-hidden" htmlFor={`comment-${post.id}`}>
              {t('comment.placeholder')}
            </label>
            <AutocompleteText
              as="input"
              id={`comment-${post.id}`}
              className="yp-input"
              placeholder={t('comment.placeholder')}
              value={body}
              onValueChange={setBody}
              maxLength={2000}
              autoComplete="off"
            />
            <Button type="submit" loading={busy} disabled={!body.trim()}>
              {t('comment.submit')}
            </Button>
          </form>
        )}
      </div>
    </BottomSheet>
  );
}

const REASON_LABEL: Record<string, string> = {
  spam: 'Spam',
  harassment: 'Harassment or bullying',
  hate: 'Hate speech',
  violence: 'Violence or threats',
  nudity: 'Nudity or sexual content',
  self_harm: 'Self-harm',
  impersonation: 'Impersonation',
  fraud: 'Scam or fraud',
  minor_safety: 'Puts a young person at risk',
  other: 'Something else',
};

export function ReportSheet({ target, onClose }: { target: { type: string; id: string } | null; onClose: () => void }) {
  const { toast } = useSession();
  const [reason, setReason] = useState<string>('spam');
  const [details, setDetails] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <BottomSheet open={!!target} onClose={onClose} title="Report">
      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!target) return;
          setBusy(true);
          try {
            toast((await api.reports.create({ targetType: target.type, targetId: target.id, reason, details: details || undefined })).message);
            onClose();
          } catch (err) {
            toast(errorMessage(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <Select label="What's wrong?" value={reason} onChange={(e) => setReason(e.currentTarget.value)}>
          {REPORT_REASONS.map((r) => (
            <option key={r} value={r}>
              {REASON_LABEL[r]}
            </option>
          ))}
        </Select>
        <TextField
          label="Anything else we should know? (optional)"
          multiline
          value={details}
          onChange={(e) => setDetails(e.currentTarget.value)}
          maxLength={2000}
        />
        <Button type="submit" variant="danger" loading={busy}>
          Send report
        </Button>
      </form>
    </BottomSheet>
  );
}

function AddToMemorySheet({ post, onClose }: { post: Post; onClose: () => void }) {
  const { toast } = useSession();
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
      toast(`Added to ${name}`);
      onClose();
    } catch (e) {
      toast(errorMessage(e));
    }
  };
  return (
    <BottomSheet open onClose={onClose} title="Add to a memory">
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
            const { memory } = await api.memories.create({ title });
            await add(memory.id, memory.title);
          }}
        >
          <TextField label="Or start a new memory" value={title} onChange={(e) => setTitle(e.currentTarget.value)} maxLength={120} />
          <Button type="submit" disabled={!title.trim()}>
            Create and add
          </Button>
        </form>
      </div>
    </BottomSheet>
  );
}
