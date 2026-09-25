'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { Place, PlaceKind } from '@yapilapi/api-client';
import {
  Badge,
  Button,
  Card,
  Checkbox,
  EmptyState,
  FormField,
  IconButton,
  Input,
  Select,
  SearchIcon,
  CloseIcon,
  StarIcon,
  StoreIcon,
  buttonClass,
} from '@yapilapi/ui';
import { useI18n } from '@/i18n';
import { useApi } from '@/lib/api';
import { useInfinite, usePageTitle } from '@/lib/hooks';
import { hasLocationOptIn, requestCoarsePosition, setLocationOptIn } from '@/lib/geo';
import { PageHeader } from '@/components/PageHeader';
import { ErrorView, InfiniteFooter, PageSpinner } from '@/components/common';

const KINDS: PlaceKind[] = ['restaurant', 'store', 'venue', 'attraction', 'service'];

function PlaceCard({ p }: { p: Place }) {
  const { t, fmt } = useI18n();
  return (
    <Card as="li" padding="md" className="entity-card">
      {p.coverUrl ? <img src={p.coverUrl} alt="" className="entity-card__media" /> : null}
      <Link href={`/places/${encodeURIComponent(p.id)}`} className="entity-card__title">
        {p.name}
      </Link>
      <span className="entity-card__meta">
        <span>{t(`places.kind.${p.kind}`)}</span>
        {p.distanceKm !== undefined ? (
          <span>
            {t('places.distanceKm', { km: fmt.number(p.distanceKm, { maximumFractionDigits: 1 }) })}
          </span>
        ) : null}
      </span>
      <span className="entity-card__meta">
        {p.rating.count > 0 ? (
          <Badge icon={<StarIcon size={12} />}>
            {t('places.rating', {
              rating: fmt.number(p.rating.average, { maximumFractionDigits: 1 }),
              count: p.rating.count,
            })}
          </Badge>
        ) : (
          <span>{t('places.noRatingsYet')}</span>
        )}
        {p.isOpenNow === true ? <Badge tone="success">{t('places.openNow')}</Badge> : null}
        {p.isOpenNow === false ? <Badge tone="neutral">{t('places.closedNow')}</Badge> : null}
      </span>
    </Card>
  );
}

export function PlacesListView() {
  const api = useApi();
  const { t } = useI18n();
  usePageTitle(t('places.title'), t('app.name'));

  const [q, setQ] = useState('');
  const [kind, setKind] = useState<PlaceKind | ''>('');
  const [openNow, setOpenNow] = useState(false);
  const [nearMe, setNearMe] = useState(false);
  const [pos, setPos] = useState<{ latitude: number; longitude: number } | null>(null);
  const [needsLocation, setNeedsLocation] = useState(false);

  const share = async () => {
    const r = await requestCoarsePosition();
    if (r.ok) {
      setLocationOptIn(true);
      setPos(r.position);
      setNeedsLocation(false);
      setNearMe(true);
    } else {
      setNeedsLocation(true);
    }
  };

  useEffect(() => {
    if (hasLocationOptIn()) void share();
  }, []);

  const key =
    nearMe && pos
      ? `nearby:${pos.latitude}:${pos.longitude}:${kind}:${openNow}`
      : `list:${q}:${kind}`;
  const state = useInfinite<Place>(async (cursor, signal) => {
    if (nearMe) {
      if (!pos) return { items: [], nextCursor: null };
      return api.places.nearby({
        lat: pos.latitude,
        lng: pos.longitude,
        kind: kind || undefined,
        openNow: openNow || undefined,
        limit: 15,
        signal,
        ...(cursor ? { cursor } : {}),
      });
    }
    return api.places.list({
      q: q || undefined,
      kind: kind || undefined,
      limit: 15,
      signal,
      ...(cursor ? { cursor } : {}),
    });
  }, key);

  return (
    <>
      <PageHeader
        title={t('places.title')}
        lead={t('places.lead')}
        actions={
          <Link href="/places/new" className={buttonClass({ variant: 'primary' })}>
            {t('places.add')}
          </Link>
        }
      />
      <form
        role="search"
        className="inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          state.reload();
        }}
      >
        <div className="yl-field search-input-field">
          <label htmlFor="places-q" className="yl-sr-only">
            {t('places.searchPlaceholder')}
          </label>
          <Input
            id="places-q"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t('places.searchPlaceholder')}
            endAdornment={
              q ? (
                <IconButton
                  label={t('search.clear')}
                  size="sm"
                  icon={<CloseIcon size={16} />}
                  onClick={() => setQ('')}
                />
              ) : undefined
            }
          />
        </div>
        <Button type="submit" leadingIcon={<SearchIcon size={16} />}>
          {t('search.submit')}
        </Button>
      </form>
      <div className="inline-form">
        <FormField label={t('places.filter.kind')} hideLabel>
          <Select value={kind} onChange={(e) => setKind(e.target.value as PlaceKind | '')}>
            <option value="">{t('places.filter.kind')}</option>
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {t(`places.kind.${k}`)}
              </option>
            ))}
          </Select>
        </FormField>
        <Checkbox
          label={t('places.filter.openNow')}
          checked={openNow}
          onChange={(e) => setOpenNow(e.target.checked)}
        />
        <Checkbox
          label={t('places.nearMe')}
          checked={nearMe}
          onChange={(e) => {
            if (e.target.checked && !pos) void share();
            else setNearMe(e.target.checked);
          }}
        />
      </div>
      {nearMe && needsLocation ? (
        <Card padding="md" className="stack-sm">
          <p>{t('places.nearMeNeedsLocation')}</p>
          <Button size="sm" onClick={() => void share()}>
            {t('places.shareLocation')}
          </Button>
        </Card>
      ) : null}
      {state.loading ? <PageSpinner /> : null}
      {state.error ? <ErrorView error={state.error} onRetry={state.reload} /> : null}
      {!state.loading && !state.error && state.items.length === 0 ? (
        <EmptyState
          icon={<StoreIcon size={28} />}
          title={t('places.emptyTitle')}
          description={t('places.emptyBody')}
        />
      ) : null}
      {state.items.length > 0 ? (
        <ul className="card-grid">
          {state.items.map((p) => (
            <PlaceCard key={p.id} p={p} />
          ))}
        </ul>
      ) : null}
      <InfiniteFooter
        hasMore={state.hasMore}
        loading={state.loadingMore}
        error={state.moreError}
        onLoadMore={state.loadMore}
        onRetry={state.loadMore}
      />
    </>
  );
}
