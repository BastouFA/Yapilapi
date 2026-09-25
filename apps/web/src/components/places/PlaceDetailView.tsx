'use client';

import { Fragment, useState } from 'react';
import Link from 'next/link';
import { ApiError, type EventSummary, type PlaceReview } from '@yapilapi/api-client';
import {
  Avatar,
  Badge,
  Button,
  Card,
  CheckIcon,
  EmptyState,
  FlagIcon,
  FormField,
  IconButton,
  Select,
  StarIcon,
  StoreIcon,
  Textarea,
  useToast,
} from '@yapilapi/ui';
import { useI18n } from '@/i18n';
import { useApi } from '@/lib/api';
import { useAsync, useInfinite, usePageTitle } from '@/lib/hooks';
import { describeError } from '@/lib/errors';
import { PageHeader } from '@/components/PageHeader';
import { ConfirmDialog, ErrorView, InfiniteFooter, PageSpinner } from '@/components/common';

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;

function ReviewRow({ r }: { r: PlaceReview }) {
  const { t, fmt } = useI18n();
  const api = useApi();
  const toast = useToast();
  const [reported, setReported] = useState(false);
  const report = async () => {
    try {
      await api.places.reportReview(r.id, 'inappropriate');
      setReported(true);
      toast.show({ tone: 'success', title: t('common.done') });
    } catch (e) {
      toast.show({
        tone: 'danger',
        title: t('error.actionFailed'),
        description: describeError(e, t).message,
      });
    }
  };
  return (
    <li className="review-row">
      <div className="review-row__head">
        <Avatar
          name={r.author?.displayName ?? '?'}
          src={r.author?.avatarUrl ?? null}
          size="sm"
          decorative
        />
        <span>{r.author?.displayName ?? t('profile.private')}</span>
        <Badge icon={<StarIcon size={12} />}>{r.rating}</Badge>
        {r.verifiedPurchase ? <Badge tone="success">{t('places.reviewVerified')}</Badge> : null}
        <span className="muted">{fmt.relative(r.createdAt)}</span>
      </div>
      {r.body ? <p>{r.body}</p> : null}
      {r.ownerReply ? (
        <div className="owner-reply">
          <strong>{t('places.reviewOwnerReply')}</strong>
          <p>{r.ownerReply.body}</p>
        </div>
      ) : null}
      {!r.viewer.isAuthor ? (
        <IconButton
          size="sm"
          label={t('places.reviewReport')}
          icon={<FlagIcon size={14} />}
          disabled={reported}
          onClick={() => void report()}
        />
      ) : null}
    </li>
  );
}

function ReviewsSection({ id, onSubmitted }: { id: string; onSubmitted: () => void }) {
  const api = useApi();
  const { t } = useI18n();
  const toast = useToast();
  const state = useInfinite<PlaceReview>(
    (cursor, signal) =>
      api.places.reviews(id, { limit: 20, signal, ...(cursor ? { cursor } : {}) }),
    'reviews',
  );
  const [rating, setRating] = useState('5');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      await api.places.addReview(id, Number(rating), body.trim() || undefined);
      setBody('');
      state.reload();
      onSubmitted();
      toast.show({
        tone: 'success',
        title: t('places.reviewSubmitted'),
        description: t('places.reviewPending'),
      });
    } catch (e) {
      toast.show({
        tone: 'danger',
        title: t('error.actionFailed'),
        description: describeError(e, t).message,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="reviews-h" className="stack">
      <h2 id="reviews-h" className="section-title">
        {t('places.reviewsTitle')}
      </h2>
      <Card padding="md" className="stack-sm">
        <FormField label={t('places.yourRating')}>
          <Select value={rating} onChange={(e) => setRating(e.target.value)}>
            {[5, 4, 3, 2, 1].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField label={t('places.reviewBody')}>
          <Textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder={t('places.reviewPlaceholder')}
            rows={3}
          />
        </FormField>
        <div className="button-row">
          <Button onClick={() => void submit()} loading={busy} loadingLabel={t('common.saving')}>
            {t('places.reviewSubmit')}
          </Button>
        </div>
      </Card>
      {state.loading ? <PageSpinner /> : null}
      {state.error ? <ErrorView error={state.error} onRetry={state.reload} /> : null}
      {!state.loading && !state.error && state.items.length === 0 ? (
        <p className="muted">{t('places.reviewsEmpty')}</p>
      ) : null}
      {state.items.length > 0 ? (
        <ul className="stack">
          {state.items.map((r) => (
            <ReviewRow key={r.id} r={r} />
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
    </section>
  );
}

function ClaimDialog({
  id,
  open,
  onClose,
  onClaimed,
}: {
  id: string;
  open: boolean;
  onClose: () => void;
  onClaimed: () => void;
}) {
  const api = useApi();
  const { t } = useI18n();
  const mine = useAsync(
    (signal) => (open ? api.business.mine({ signal }) : Promise.resolve(null)),
    [api, open],
  );
  const [businessId, setBusinessId] = useState('');
  const [evidence, setEvidence] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    if (!businessId) return;
    setBusy(true);
    setError('');
    try {
      await api.places.claim(id, businessId, evidence.trim() || undefined);
      onClaimed();
      onClose();
    } catch (e) {
      setError(describeError(e, t).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <ConfirmDialog
      open={open}
      title={t('places.claimDialog')}
      confirmLabel={t('places.claimSubmit')}
      busy={busy}
      onConfirm={() => void submit()}
      onClose={onClose}
    >
      {!mine.data || mine.data.items.length === 0 ? (
        <p className="muted">{t('places.claimNoBusiness')}</p>
      ) : (
        <>
          <FormField label={t('places.claimBusiness')}>
            <Select value={businessId} onChange={(e) => setBusinessId(e.target.value)}>
              <option value="">—</option>
              {mine.data.items.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField label={t('places.claimEvidence')}>
            <Textarea value={evidence} onChange={(e) => setEvidence(e.target.value)} rows={3} />
          </FormField>
        </>
      )}
      {error ? (
        <p className="yl-notice yl-notice--danger" role="alert">
          {error}
        </p>
      ) : null}
    </ConfirmDialog>
  );
}

export function PlaceDetailView({ id }: { id: string }) {
  const api = useApi();
  const { t, fmt } = useI18n();
  const toast = useToast();
  const place = useAsync((signal) => api.places.get(id, { signal }), [api, id]);
  const [claimOpen, setClaimOpen] = useState(false);
  usePageTitle(place.data?.name, t('app.name'));

  const events = useInfinite<EventSummary>(
    (cursor, signal) => api.places.events(id, { limit: 10, signal, ...(cursor ? { cursor } : {}) }),
    'place-events',
  );
  const photos = useAsync((signal) => api.places.photos(id, { signal }), [api, id]);

  const toggleSave = async () => {
    if (!place.data) return;
    const wasSaved = place.data.viewer.saved;
    try {
      if (wasSaved) await api.places.unsave(id);
      else await api.places.save(id);
      place.setData((p) => (p ? { ...p, viewer: { ...p.viewer, saved: !p.viewer.saved } } : p));
      if (!wasSaved) toast.show({ tone: 'success', title: t('places.saved') });
    } catch (e) {
      toast.show({
        tone: 'danger',
        title: t('error.actionFailed'),
        description: describeError(e, t).message,
      });
    }
  };

  if (place.loading) return <PageSpinner />;
  if (place.error) {
    if (place.error instanceof ApiError && place.error.status === 404) {
      return <EmptyState icon={<StoreIcon size={28} />} title={t('places.notFound')} />;
    }
    return <ErrorView error={place.error} onRetry={place.reload} />;
  }
  const p = place.data;
  if (!p) return null;

  return (
    <>
      <PageHeader
        title={p.name}
        actions={
          <IconButton
            label={p.viewer.saved ? t('places.unsave') : t('places.save')}
            icon={<CheckIcon size={16} />}
            pressed={p.viewer.saved}
            onClick={() => void toggleSave()}
          />
        }
      />
      {p.coverUrl ? <img src={p.coverUrl} alt="" className="event-detail__cover" /> : null}
      <div className="entity-card__meta">
        <span>{t(`places.kind.${p.kind}`)}</span>
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
        <Badge tone={p.claimed ? 'success' : 'neutral'}>
          {p.claimed ? t('places.claimed') : t('places.unclaimed')}
        </Badge>
      </div>
      {p.description ? <p>{p.description}</p> : null}
      {p.address || p.phone || p.website ? (
        <dl className="hours-table">
          {p.address ? (
            <>
              <dt>{t('places.address')}</dt>
              <dd>
                {[p.address.line1, p.address.city, p.address.country].filter(Boolean).join(', ')}
              </dd>
            </>
          ) : null}
          {p.phone ? (
            <>
              <dt>{t('places.phone')}</dt>
              <dd dir="ltr">{p.phone}</dd>
            </>
          ) : null}
          {p.website ? (
            <>
              <dt>{t('places.website')}</dt>
              <dd>
                <a href={p.website}>{p.website}</a>
              </dd>
            </>
          ) : null}
        </dl>
      ) : null}

      <section aria-labelledby="hours-h" className="stack-sm">
        <h2 id="hours-h" className="section-title">
          {t('places.hoursTitle')}
        </h2>
        {p.hours ? (
          <dl className="hours-table">
            {DAYS.map((d) => (
              <Fragment key={d}>
                <dt>{t(`places.hours.${d}`)}</dt>
                <dd>
                  {p.hours?.[d]?.length
                    ? p.hours[d]!.map(([a, b]) => `${a}–${b}`).join(', ')
                    : t('places.hours.closed')}
                </dd>
              </Fragment>
            ))}
          </dl>
        ) : (
          <p className="muted">{t('places.hoursUnknown')}</p>
        )}
      </section>

      <section aria-labelledby="photos-h" className="stack-sm">
        <h2 id="photos-h" className="section-title">
          {t('places.photosTitle')}
        </h2>
        {photos.loading ? <PageSpinner /> : null}
        {photos.error ? <ErrorView error={photos.error} onRetry={photos.reload} /> : null}
        {photos.data && photos.data.items.length === 0 ? (
          <p className="muted">{t('places.photosEmpty')}</p>
        ) : null}
        {photos.data && photos.data.items.length > 0 ? (
          <ul className="photo-grid">
            {photos.data.items.map((ph) => (
              <li key={ph.mediaId}>
                <img src={ph.url} alt={ph.caption ?? ''} />
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <section aria-labelledby="place-events-h" className="stack-sm">
        <h2 id="place-events-h" className="section-title">
          {t('places.eventsTitle')}
        </h2>
        {events.loading ? <PageSpinner /> : null}
        {events.error ? <ErrorView error={events.error} onRetry={events.reload} /> : null}
        {!events.loading && !events.error && events.items.length === 0 ? (
          <p className="muted">{t('events.emptyBody')}</p>
        ) : null}
        {events.items.length > 0 ? (
          <ul className="stack-sm search-list">
            {events.items.map((ev) => (
              <Card key={ev.id} as="li" padding="md" className="search-row">
                <div className="search-row__text">
                  <Link href={`/events/${encodeURIComponent(ev.id)}`} className="search-row__title">
                    {ev.title}
                  </Link>
                  <span className="muted">{fmt.dateTime(ev.startsAt)}</span>
                </div>
              </Card>
            ))}
          </ul>
        ) : null}
        <InfiniteFooter
          hasMore={events.hasMore}
          loading={events.loadingMore}
          error={events.moreError}
          onLoadMore={events.loadMore}
          onRetry={events.loadMore}
        />
      </section>

      <ReviewsSection id={id} onSubmitted={() => undefined} />

      {!p.claimed ? (
        <section aria-labelledby="claim-h" className="stack-sm">
          <h2 id="claim-h" className="section-title">
            {t('places.claim')}
          </h2>
          <Button variant="secondary" onClick={() => setClaimOpen(true)}>
            {t('places.claim')}
          </Button>
        </section>
      ) : null}
      <ClaimDialog
        id={id}
        open={claimOpen}
        onClose={() => setClaimOpen(false)}
        onClaimed={() => {
          toast.show({ tone: 'success', title: t('places.claimSubmitted') });
        }}
      />
    </>
  );
}
