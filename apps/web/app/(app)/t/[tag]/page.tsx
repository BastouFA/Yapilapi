'use client';

import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { Button, EmptyState, MomentsStrip, Segments, Skeleton } from '@yapilapi/design-system';
import type { StoryGroup, TagSummary } from '@yapilapi/api-client';
import { normalizeTag } from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';
import { PostList } from '@/components/PostList';
import { ScreenLoading } from '@/components/Loading';
import { useSession } from '../../../providers';

// The story viewer opens full screen when a story is tapped, so it downloads then.
const StoryViewer = dynamic(() => import('@/components/StoryViewer').then((m) => m.StoryViewer), {
  ssr: false,
  loading: () => <ScreenLoading className="story" />,
});

/**
 * One hashtag: how many people use it, related tags, public stories with it right now, and its recent or top posts.
 * Follow it to see more of it in For you.
 */
export default function TagPage() {
  const params = useParams<{ tag: string }>();
  const tag = normalizeTag(decodeURIComponent(params.tag));
  const { me, toast, locale, t, tp } = useSession();
  const router = useRouter();
  const [info, setInfo] = useState<TagSummary | null>(null);
  const [missing, setMissing] = useState(false);
  const [sort, setSort] = useState<'recent' | 'top'>('recent');
  const [busy, setBusy] = useState(false);
  // "Stories now": active public stories with the tag (never followers-only or close friends ones).
  const [stories, setStories] = useState<StoryGroup[]>([]);
  const [viewing, setViewing] = useState<number | null>(null);
  const n = new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 });
  // "{number} posts" with the number in bold, in whatever order the language puts them.
  const stat = (text: string, value: number) => {
    const [before = '', after = ''] = text.split('{number}');
    return (
      <span>
        {before}
        <strong>{n.format(value)}</strong>
        {after}
      </span>
    );
  };

  useEffect(() => {
    setInfo(null);
    setMissing(false);
    api.tags.get(tag).then(setInfo, () => setMissing(true));
    setStories([]);
    api.tags.stories(tag).then(
      (r) => setStories(r.items),
      () => {},
    );
  }, [tag]);

  const load = useCallback((cursor?: string) => api.tags.posts(tag, sort, cursor), [tag, sort]);

  if (missing) return <EmptyState title={t('tag.invalid.title')} body={t('tag.invalid.body')} />;

  return (
    <div className="yp-shell__inner stack">
      <section className="tag-hero" aria-labelledby="tag-title">
        <h1 id="tag-title">
          <bdi>#{tag}</bdi>
        </h1>
        {info ? (
          <div className="tag-hero__stats">
            {stat(tp('trending.posts', info.posts), info.posts)}
            {stat(tp('trending.people', info.people), info.people)}
            {info.comments > 0 ? stat(tp('tag.stat.comments', info.comments), info.comments) : null}
            {stat(t('tag.stat.thisWeek'), info.postsThisWeek)}
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
                  toast(r.following ? t('tag.followed', { tag }) : t('tag.unfollowed', { tag }));
                } catch (e) {
                  toast(errorMessage(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              {info.following ? t('m.tag.following') : t('m.tag.follow')}
            </Button>
          ) : null}
          <Button variant="secondary" size="sm" icon="plus" onClick={() => router.push(`/create?text=${encodeURIComponent(`#${tag} `)}`)}>
            {t('tag.postWith', { tag })}
          </Button>
          {me ? (
            <Button variant="secondary" size="sm" onClick={() => router.push(`/create?mode=story&text=${encodeURIComponent(`#${tag} `)}`)}>
              {t('tag.storyWith', { tag })}
            </Button>
          ) : null}
        </div>
      </section>

      {info?.related.length ? (
        <nav aria-label={t('tag.related')} className="row" style={{ flexWrap: 'wrap' }}>
          {info.related.map((r) => (
            <Link key={r} href={`/t/${encodeURIComponent(r)}`} className="yp-chip">
              <bdi>#{r}</bdi>
            </Link>
          ))}
        </nav>
      ) : null}

      {stories.length ? (
        <section className="stack-sm" aria-labelledby="stories-now">
          <h2 id="stories-now" className="tag-stories__title">
            {t('m.tag.storiesNow')}
          </h2>
          <MomentsStrip groups={stories} onOpen={setViewing} locale={locale} />
        </section>
      ) : null}
      {viewing !== null && stories[viewing] ? <StoryViewer groups={stories} start={viewing} onClose={() => setViewing(null)} onChange={setStories} /> : null}

      <Segments
        label={t('tag.sort')}
        value={sort}
        onChange={setSort}
        options={[
          { id: 'recent', label: t('m.tag.recent') },
          { id: 'top', label: t('m.tag.top') },
        ]}
      />
      <PostList load={load} reloadKey={`${tag}-${sort}`} empty={t('tag.empty', { tag })} />
    </div>
  );
}
