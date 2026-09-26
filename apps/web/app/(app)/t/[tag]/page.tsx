'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { Button, EmptyState, Segments, Skeleton } from '@yapilapi/design-system';
import type { TagSummary } from '@yapilapi/api-client';
import { normalizeTag } from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';
import { PostList } from '@/components/PostList';
import { useSession } from '../../../providers';

/** One hashtag: how many people use it, related tags, and its recent or top posts. Follow it to see more of it in For you. */
export default function TagPage() {
  const params = useParams<{ tag: string }>();
  const tag = normalizeTag(decodeURIComponent(params.tag));
  const { me, toast, locale } = useSession();
  const router = useRouter();
  const [info, setInfo] = useState<TagSummary | null>(null);
  const [missing, setMissing] = useState(false);
  const [sort, setSort] = useState<'recent' | 'top'>('recent');
  const [busy, setBusy] = useState(false);
  const n = new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 });

  useEffect(() => {
    setInfo(null);
    setMissing(false);
    api.tags.get(tag).then(setInfo, () => setMissing(true));
  }, [tag]);

  const load = useCallback((cursor?: string) => api.tags.posts(tag, sort, cursor), [tag, sort]);

  if (missing) return <EmptyState title="That isn't a hashtag" body="Tags are 2 to 40 letters, numbers or underscores." />;

  return (
    <div className="yp-shell__inner stack">
      <section className="tag-hero" aria-labelledby="tag-title">
        <h1 id="tag-title">
          <bdi>#{tag}</bdi>
        </h1>
        {info ? (
          <div className="tag-hero__stats">
            <span>
              <strong>{n.format(info.posts)}</strong> {info.posts === 1 ? 'post' : 'posts'}
            </span>
            <span>
              <strong>{n.format(info.people)}</strong> {info.people === 1 ? 'person' : 'people'}
            </span>
            <span>
              <strong>{n.format(info.postsThisWeek)}</strong> this week
            </span>
          </div>
        ) : (
          <Skeleton height={24} />
        )}
        <div className="row">
          {me && info ? (
            <Button
              variant={info.following ? 'secondary' : 'primary'}
              size="sm"
              loading={busy}
              aria-pressed={info.following}
              onClick={async () => {
                setBusy(true);
                try {
                  const r = info.following ? await api.tags.unfollow(tag) : await api.tags.follow(tag);
                  setInfo({ ...info, following: r.following });
                  toast(r.following ? `You'll see more #${tag} in For you` : `Unfollowed #${tag}`);
                } catch (e) {
                  toast(errorMessage(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              {info.following ? 'Following' : 'Follow tag'}
            </Button>
          ) : null}
          <Button variant="secondary" size="sm" icon="plus" onClick={() => router.push(`/create?text=${encodeURIComponent(`#${tag} `)}`)}>
            Post with #{tag}
          </Button>
        </div>
      </section>

      {info?.related.length ? (
        <nav aria-label="Related tags" className="row" style={{ flexWrap: 'wrap' }}>
          {info.related.map((r) => (
            <Link key={r} href={`/t/${encodeURIComponent(r)}`} className="yp-chip">
              <bdi>#{r}</bdi>
            </Link>
          ))}
        </nav>
      ) : null}

      <Segments
        label="Sort posts"
        value={sort}
        onChange={setSort}
        options={[
          { id: 'recent', label: 'Recent' },
          { id: 'top', label: 'Top' },
        ]}
      />
      <PostList load={load} reloadKey={`${tag}-${sort}`} empty={`No posts with #${tag} yet. Be the first.`} />
    </div>
  );
}
