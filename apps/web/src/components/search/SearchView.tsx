'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { ApiError, type SearchResultItem, type SearchResultType } from '@yapilapi/api-client';
import {
  Avatar,
  Badge,
  Button,
  Card,
  EmptyState,
  IconButton,
  Input,
  SearchIcon,
  CloseIcon,
  LockIcon,
  CheckIcon,
  StarIcon,
  cx,
} from '@yapilapi/ui';
import { useI18n } from '@/i18n';
import { useApi } from '@/lib/api';
import { useAsync, useInfinite, usePageTitle } from '@/lib/hooks';
import { describeError } from '@/lib/errors';
import { tKey } from '@/lib/dyn-key';
import { PageHeader } from '@/components/PageHeader';
import { ErrorView, InfiniteFooter, PageSpinner, LiveText } from '@/components/common';
import { VisibilityBadge } from '@/components/communities/CommunityCard';
import { FollowToggle } from '@/components/FollowToggle';

const ALL_TYPES: SearchResultType[] = [
  'people',
  'creators',
  'posts',
  'videos',
  'communities',
  'events',
  'places',
  'businesses',
  'products',
  'topics',
];

function ResultRow({ type, item }: { type: SearchResultType; item: SearchResultItem }) {
  const { t, fmt } = useI18n();
  const i = item as Record<string, unknown>;
  if (type === 'people' || type === 'creators') {
    return (
      <Card as="li" padding="md" className="search-row">
        <Avatar
          name={String(i['displayName'])}
          src={i['avatarUrl'] as string | null}
          size="md"
          decorative
        />
        <div className="search-row__text">
          <Link
            href={`/u/${encodeURIComponent(String(i['username']))}`}
            className="search-row__title"
          >
            {String(i['displayName'])}
          </Link>
          <span className="muted" dir="ltr">
            @{String(i['username'])}
          </span>
          {i['bio'] ? <p className="search-row__desc">{String(i['bio'])}</p> : null}
        </div>
        {(i['isPrivate'] as boolean) ? (
          <Badge icon={<LockIcon size={12} />}>{t('search.private')}</Badge>
        ) : null}
        <FollowToggle
          username={String(i['username'] ?? '')}
          initial={
            ((i['viewer'] as { following?: string } | undefined)?.following as
              'none' | 'pending' | 'active' | undefined) ?? 'none'
          }
        />
      </Card>
    );
  }
  if (type === 'posts' || type === 'videos') {
    const author = i['author'] as { username: string; displayName: string } | undefined;
    return (
      <Card as="li" padding="md" className="search-row">
        <div className="search-row__text">
          <Link href={`/post/${encodeURIComponent(String(i['id']))}`} className="search-row__title">
            {String(i['body'] ?? '').slice(0, 140) || t(`search.filter.${type}`)}
          </Link>
          {author ? (
            <span className="muted">{t('post.authorLink', { name: author.displayName })}</span>
          ) : null}
        </div>
      </Card>
    );
  }
  if (type === 'communities') {
    return (
      <Card as="li" padding="md" className="search-row">
        <div className="search-row__text">
          <Link
            href={`/communities/${encodeURIComponent(String(i['slug']))}`}
            className="search-row__title"
          >
            {String(i['name'])}
          </Link>
          <span className="muted">
            {t('communities.members', { count: Number(i['memberCount'] ?? 0) })}
          </span>
          {i['description'] ? <p className="search-row__desc">{String(i['description'])}</p> : null}
        </div>
        <VisibilityBadge
          community={{ visibility: i['visibility'] as 'public' | 'private' | 'secret' }}
        />
      </Card>
    );
  }
  if (type === 'events') {
    return (
      <Card as="li" padding="md" className="search-row">
        <div className="search-row__text">
          <Link
            href={`/events/${encodeURIComponent(String(i['id']))}`}
            className="search-row__title"
          >
            {String(i['title'])}
          </Link>
          <span className="muted">{fmt.dateTime(String(i['startsAt']))}</span>
          {i['distanceKm'] !== undefined ? (
            <span className="muted">{t('search.distanceKm', { km: Number(i['distanceKm']) })}</span>
          ) : null}
        </div>
      </Card>
    );
  }
  if (type === 'places') {
    return (
      <Card as="li" padding="md" className="search-row">
        <div className="search-row__text">
          <Link
            href={`/places/${encodeURIComponent(String(i['id']))}`}
            className="search-row__title"
          >
            {String(i['name'])}
          </Link>
          <span className="muted">
            {tKey(t, `places.kind.${String(i['kind'])}`)}
            {i['distanceKm'] !== undefined
              ? ` · ${t('search.distanceKm', { km: Number(i['distanceKm']) })}`
              : ''}
          </span>
        </div>
        {Number((i['ratingAvg'] as number) ?? 0) > 0 ? (
          <Badge icon={<StarIcon size={12} />}>
            {fmt.number(Number(i['ratingAvg']), { maximumFractionDigits: 1 })}
          </Badge>
        ) : null}
      </Card>
    );
  }
  if (type === 'businesses') {
    return (
      <Card as="li" padding="md" className="search-row">
        <div className="search-row__text">
          <Link
            href={`/businesses/${encodeURIComponent(String(i['slug']))}`}
            className="search-row__title"
          >
            {String(i['name'])}
          </Link>
          <span className="muted">{String(i['category'] ?? '')}</span>
        </div>
        {i['verified'] ? (
          <Badge icon={<CheckIcon size={12} />}>{t('search.verified')}</Badge>
        ) : null}
      </Card>
    );
  }
  if (type === 'products') {
    return (
      <Card as="li" padding="md" className="search-row">
        <div className="search-row__text">
          <Link href={`/shop/${encodeURIComponent(String(i['id']))}`} className="search-row__title">
            {String(i['title'])}
          </Link>
          <span className="muted">
            {fmt.currency(Number(i['priceCents'] ?? 0) / 100, String(i['currency'] ?? 'USD'))}
          </span>
        </div>
      </Card>
    );
  }
  // topics
  return (
    <Card as="li" padding="sm" className="search-row">
      <span className="search-row__title">#{String(i['name'])}</span>
    </Card>
  );
}

function TypeSection({
  type,
  items,
  total,
  onShowAll,
}: {
  type: SearchResultType;
  items: SearchResultItem[];
  total: number | null;
  onShowAll: () => void;
}) {
  const { t } = useI18n();
  return (
    <section aria-labelledby={`search-sec-${type}`} className="stack-sm">
      <h2 id={`search-sec-${type}`} className="section-title">
        {t(`search.filter.${type}`)}
      </h2>
      <ul className="stack-sm search-list" aria-label={t(`search.filter.${type}`)}>
        {items.map((it) => (
          <ResultRow key={it.id} type={type} item={it} />
        ))}
      </ul>
      {total !== null && total > items.length ? (
        <button type="button" className="link-btn" onClick={onShowAll}>
          {t('search.showAll', { count: total, type: t(`search.filter.${type}`) })}
        </button>
      ) : null}
    </section>
  );
}

export function SearchView() {
  const api = useApi();
  const { t } = useI18n();
  const router = useRouter();
  const params = useSearchParams();
  usePageTitle(t('search.title'), t('app.name'));

  const [input, setInput] = useState(params.get('q') ?? '');
  const [query, setQuery] = useState(params.get('q') ?? '');
  const [activeType, setActiveType] = useState<SearchResultType | null>(
    (params.get('type') as SearchResultType | null) ?? null,
  );

  useEffect(() => {
    const q = params.get('q') ?? '';
    setInput(q);
    setQuery(q);
    setActiveType((params.get('type') as SearchResultType | null) ?? null);
  }, [params]);

  const submit = (q: string, type: SearchResultType | null) => {
    const usp = new URLSearchParams();
    if (q) usp.set('q', q);
    if (type) usp.set('type', type);
    router.push(`/search${usp.toString() ? `?${usp.toString()}` : ''}`);
  };

  const history = useAsync(
    (signal) => (query ? Promise.resolve(null) : api.search.history({ signal })),
    [api, query],
  );

  const overview = useAsync(
    async (signal) => {
      if (!query || activeType) return null;
      return api.search.run({ q: query, limit: 5 }, { signal });
    },
    [api, query, activeType],
  );

  const paged = useInfinite<SearchResultItem>(
    async (cursor, signal) => {
      if (!query || !activeType) return { items: [], nextCursor: null };
      const r = await api.search.run(
        { q: query, types: [activeType], limit: 20, ...(cursor ? { cursor } : {}) },
        { signal },
      );
      const g = r.results[activeType];
      return { items: g?.items ?? [], nextCursor: g?.nextCursor ?? null };
    },
    `${query}::${activeType ?? ''}`,
    Boolean(query && activeType),
  );

  const clearHistory = async () => {
    try {
      await api.search.clearHistory(undefined, {});
      history.reload();
    } catch {
      /* best-effort */
    }
  };

  const typesToShow = overview.data
    ? ALL_TYPES.filter((t2) => (overview.data!.results[t2]?.items.length ?? 0) > 0)
    : [];

  return (
    <>
      <PageHeader title={t('search.title')} lead={t('search.lead')} />
      <form
        role="search"
        className="inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          submit(input.trim(), activeType);
        }}
      >
        <div className="yl-field search-input-field">
          <label htmlFor="search-q" className="yl-sr-only">
            {t('search.title')}
          </label>
          <Input
            id="search-q"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={t('search.placeholder')}
            endAdornment={
              input ? (
                <IconButton
                  label={t('search.clear')}
                  size="sm"
                  icon={<CloseIcon size={16} />}
                  onClick={() => {
                    setInput('');
                    submit('', activeType);
                  }}
                />
              ) : undefined
            }
          />
        </div>
        <Button type="submit" leadingIcon={<SearchIcon size={16} />}>
          {t('search.submit')}
        </Button>
      </form>

      {query ? (
        <ul className="chips" aria-label={t('search.filterAll')}>
          <li>
            <button
              type="button"
              className={cx('chip', !activeType && 'is-on')}
              aria-pressed={!activeType}
              onClick={() => submit(query, null)}
            >
              {t('search.filterAll')}
            </button>
          </li>
          {ALL_TYPES.map((t2) => (
            <li key={t2}>
              <button
                type="button"
                className={cx('chip', activeType === t2 && 'is-on')}
                aria-pressed={activeType === t2}
                onClick={() => submit(query, t2)}
              >
                {t(`search.filter.${t2}`)}
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {!query ? (
        <section aria-labelledby="recent-h" className="stack-sm">
          <div className="button-row button-row--between">
            <h2 id="recent-h" className="section-title">
              {t('search.recentTitle')}
            </h2>
            {history.data && history.data.items.length > 0 ? (
              <Button variant="ghost" size="sm" onClick={() => void clearHistory()}>
                {t('search.clearHistory')}
              </Button>
            ) : null}
          </div>
          {history.loading ? <PageSpinner /> : null}
          {history.error ? <ErrorView error={history.error} onRetry={history.reload} /> : null}
          {history.data && !history.data.recording ? (
            <p className="muted">{t('search.recentNotRecorded')}</p>
          ) : null}
          {history.data && history.data.items.length === 0 ? (
            <EmptyState icon={<SearchIcon size={28} />} title={t('search.empty')} />
          ) : null}
          {history.data && history.data.items.length > 0 ? (
            <ul className="chips" aria-label={t('search.recentTitle')}>
              {history.data.items.map((h) => (
                <li key={h.query}>
                  <button type="button" className="chip" onClick={() => submit(h.query, null)}>
                    {h.query}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}

      {query && !activeType ? (
        <>
          {overview.loading ? <PageSpinner /> : null}
          {overview.error ? (
            overview.error instanceof ApiError && overview.error.status === 400 ? (
              <p className="yl-notice yl-notice--danger" role="alert">
                {describeError(overview.error, t).message}
              </p>
            ) : (
              <ErrorView error={overview.error} onRetry={overview.reload} />
            )
          ) : null}
          {overview.data ? (
            <>
              <LiveText>{t('search.resultsCount', { count: overview.data.total })}</LiveText>
              {overview.data.interpretedAs.fellBack ? (
                <p className="yl-notice yl-notice--info" role="status">
                  {t('search.fellBack')}
                </p>
              ) : null}
              {overview.data.interpretedAs.needsLocation ? (
                <p className="yl-notice yl-notice--info" role="status">
                  {t('search.needsLocation')}
                </p>
              ) : null}
              {(overview.data.interpretedAs.nearMe ||
                overview.data.interpretedAs.timeWindow ||
                overview.data.interpretedAs.partySize ||
                overview.data.interpretedAs.priceHint) && (
                <ul className="chips" aria-label={t('search.interpretedTitle')}>
                  {overview.data.interpretedAs.nearMe ? (
                    <li>
                      <span className="chip">{t('search.chip.nearMe')}</span>
                    </li>
                  ) : null}
                  {overview.data.interpretedAs.timeWindow ? (
                    <li>
                      <span className="chip">
                        {t('search.chip.timeWindow', {
                          label: overview.data.interpretedAs.timeWindow.label,
                        })}
                      </span>
                    </li>
                  ) : null}
                  {overview.data.interpretedAs.partySize ? (
                    <li>
                      <span className="chip">
                        {t('search.chip.partySize', {
                          count: overview.data.interpretedAs.partySize,
                        })}
                      </span>
                    </li>
                  ) : null}
                  {overview.data.interpretedAs.priceHint ? (
                    <li>
                      <span className="chip">
                        {t(`search.chip.price.${overview.data.interpretedAs.priceHint}`)}
                      </span>
                    </li>
                  ) : null}
                </ul>
              )}
              {overview.data.total === 0 ? (
                <EmptyState
                  icon={<SearchIcon size={28} />}
                  title={t('search.emptyResults', { query })}
                  description={t('search.emptyResultsHint')}
                />
              ) : (
                <div className="stack">
                  {typesToShow.map((t2) => (
                    <TypeSection
                      key={t2}
                      type={t2}
                      items={overview.data!.results[t2]!.items}
                      total={overview.data!.results[t2]!.items.length >= 5 ? 6 : null}
                      onShowAll={() => submit(query, t2)}
                    />
                  ))}
                </div>
              )}
            </>
          ) : null}
        </>
      ) : null}

      {query && activeType ? (
        <div className="stack">
          {paged.loading ? <PageSpinner /> : null}
          {paged.error ? <ErrorView error={paged.error} onRetry={paged.reload} /> : null}
          {!paged.loading && !paged.error && paged.items.length === 0 ? (
            <EmptyState
              icon={<SearchIcon size={28} />}
              title={t('search.emptyResults', { query })}
              description={t('search.emptyResultsHint')}
            />
          ) : null}
          {paged.items.length > 0 ? (
            <ul className="stack-sm search-list" aria-label={t(`search.filter.${activeType}`)}>
              {paged.items.map((it) => (
                <ResultRow key={it.id} type={activeType} item={it} />
              ))}
            </ul>
          ) : null}
          <InfiniteFooter
            hasMore={paged.hasMore}
            loading={paged.loadingMore}
            error={paged.moreError}
            onLoadMore={paged.loadMore}
            onRetry={paged.loadMore}
          />
        </div>
      ) : null}
    </>
  );
}
