'use client';

import { Fragment, useState } from 'react';
import Link from 'next/link';
import { ApiError, type Booking, type EventSummary, type Post } from '@yapilapi/api-client';
import {
  Badge,
  Button,
  Card,
  CheckIcon,
  EmptyState,
  FormField,
  Input,
  Radio,
  RadioGroup,
  Select,
  StoreIcon,
  Tabs,
  TabList,
  Tab,
  TabPanel,
  Textarea,
  useToast,
} from '@yapilapi/ui';
import { useI18n } from '@/i18n';
import { useApi } from '@/lib/api';
import { useAsync, useInfinite, usePageTitle } from '@/lib/hooks';
import { describeError } from '@/lib/errors';
import { PageHeader } from '@/components/PageHeader';
import { PostList } from '@/components/PostList';
import { ErrorView, InfiniteFooter, PageSpinner } from '@/components/common';

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;

function AboutTab({ id }: { id: string }) {
  const api = useApi();
  const { t } = useI18n();
  const biz = useAsync((signal) => api.business.get(id, { signal }), [api, id]);
  if (biz.loading) return <PageSpinner />;
  if (biz.error) return <ErrorView error={biz.error} onRetry={biz.reload} />;
  const b = biz.data;
  if (!b) return null;
  return (
    <div className="stack">
      {b.description ? <p>{b.description}</p> : null}
      {b.contact ? (
        <section aria-labelledby="biz-contact-h" className="stack-sm">
          <h2 id="biz-contact-h" className="section-title">
            {t('business.contact')}
          </h2>
          <ul className="stack-sm">
            {b.contact.email ? <li>{b.contact.email}</li> : null}
            {b.contact.phone ? <li dir="ltr">{b.contact.phone}</li> : null}
            {b.contact.website ? (
              <li>
                <a href={b.contact.website}>{b.contact.website}</a>
              </li>
            ) : null}
          </ul>
        </section>
      ) : null}
      {b.address ? (
        <section aria-labelledby="biz-address-h" className="stack-sm">
          <h2 id="biz-address-h" className="section-title">
            {t('business.addressTitle')}
          </h2>
          <p>{[b.address.line1, b.address.city, b.address.country].filter(Boolean).join(', ')}</p>
        </section>
      ) : null}
      {b.hours ? (
        <section aria-labelledby="biz-hours-h" className="stack-sm">
          <h2 id="biz-hours-h" className="section-title">
            {t('business.hoursTitle')}
          </h2>
          <dl className="hours-table">
            {DAYS.map((d) => (
              <Fragment key={d}>
                <dt>{t(`places.hours.${d}`)}</dt>
                <dd>
                  {b.hours?.[d]?.length
                    ? b.hours[d]!.map(([a, c]) => `${a}–${c}`).join(', ')
                    : t('places.hours.closed')}
                </dd>
              </Fragment>
            ))}
          </dl>
        </section>
      ) : null}
    </div>
  );
}

function PostsTab({ id }: { id: string }) {
  const api = useApi();
  const { t } = useI18n();
  const state = useInfinite<Post>(
    (cursor, signal) =>
      api.business.posts(id, { limit: 15, signal, ...(cursor ? { cursor } : {}) }),
    'posts',
  );
  return (
    <PostList
      state={state}
      label={t('business.tab.posts')}
      explain={false}
      empty={<EmptyState title={t('business.postsEmpty')} />}
    />
  );
}

function EventsTab({ id }: { id: string }) {
  const api = useApi();
  const { t, fmt } = useI18n();
  const state = useInfinite<EventSummary>(
    (cursor, signal) =>
      api.business.events(id, { limit: 15, signal, ...(cursor ? { cursor } : {}) }),
    'events',
  );
  if (state.loading) return <PageSpinner />;
  if (state.error) return <ErrorView error={state.error} onRetry={state.reload} />;
  if (state.items.length === 0) return <EmptyState title={t('business.eventsEmpty')} />;
  return (
    <div className="stack">
      <ul className="stack-sm search-list">
        {state.items.map((ev) => (
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
      <InfiniteFooter
        hasMore={state.hasMore}
        loading={state.loadingMore}
        error={state.moreError}
        onLoadMore={state.loadMore}
        onRetry={state.loadMore}
      />
    </div>
  );
}

function OffersTab({ id }: { id: string }) {
  const api = useApi();
  const { t } = useI18n();
  const offers = useAsync((signal) => api.business.offers(id, { signal }), [api, id]);
  if (offers.loading) return <PageSpinner />;
  if (offers.error) return <ErrorView error={offers.error} onRetry={offers.reload} />;
  const items = offers.data?.items ?? [];
  if (items.length === 0) return <EmptyState title={t('business.offersEmpty')} />;
  return (
    <ul className="stack-sm search-list">
      {items.map((o) => (
        <Card key={o.id} as="li" padding="md" className="search-row">
          <div className="search-row__text">
            <span className="search-row__title">{o.title}</span>
            {o.description ? <p className="search-row__desc">{o.description}</p> : null}
            {o.code ? (
              <span className="muted">{t('business.offerCode', { code: o.code })}</span>
            ) : null}
          </div>
          {o.status === 'expired' ? (
            <Badge tone="neutral">{t('business.offerExpired')}</Badge>
          ) : null}
        </Card>
      ))}
    </ul>
  );
}

function ServicesTab({ id }: { id: string }) {
  const api = useApi();
  const { t, fmt } = useI18n();
  const services = useAsync((signal) => api.business.services(id, { signal }), [api, id]);
  if (services.loading) return <PageSpinner />;
  if (services.error) return <ErrorView error={services.error} onRetry={services.reload} />;
  const items = services.data?.items ?? [];
  if (items.length === 0) return <EmptyState title={t('business.servicesEmpty')} />;
  return (
    <ul className="stack-sm search-list">
      {items.map((s) => (
        <Card key={s.id} as="li" padding="md" className="search-row">
          <div className="search-row__text">
            <span className="search-row__title">{s.title}</span>
            {s.description ? <p className="search-row__desc">{s.description}</p> : null}
          </div>
          <span className="muted">
            {t('business.servicePrice', { price: fmt.currency(s.priceCents / 100, s.currency) })}
          </span>
        </Card>
      ))}
    </ul>
  );
}

function BookTab({ id }: { id: string }) {
  const api = useApi();
  const { t } = useI18n();
  const toast = useToast();
  const bookable = useAsync((signal) => api.business.bookable(id, { signal }), [api, id]);
  const mine = useInfinite<Booking>(
    (cursor, signal) =>
      api.bookings.mine({ when: 'upcoming', limit: 20, signal, ...(cursor ? { cursor } : {}) }),
    'my-bookings',
  );
  const [choice, setChoice] = useState<'place' | 'service'>('place');
  const [targetId, setTargetId] = useState('');
  const [startsAt, setStartsAt] = useState('');
  const [duration, setDuration] = useState('60');
  const [partySize, setPartySize] = useState('1');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  if (bookable.loading) return <PageSpinner />;
  if (bookable.error) return <ErrorView error={bookable.error} onRetry={bookable.reload} />;
  const info = bookable.data;
  if (!info) return null;
  if (info.places.length === 0 && info.services.length === 0) {
    return <EmptyState title={t('business.bookingNotBookable')} />;
  }

  const options = choice === 'place' ? info.places : info.services;

  const submit = async () => {
    setError('');
    if (!targetId || !startsAt) return;
    setBusy(true);
    try {
      await api.bookings.create({
        ...(choice === 'place' ? { placeId: targetId } : { productId: targetId }),
        startsAt: new Date(startsAt).toISOString(),
        durationMinutes: Number(duration) || 60,
        partySize: Number(partySize) || 1,
        notes: notes.trim() || undefined,
      });
      toast.show({
        tone: 'success',
        title: info.settings.autoConfirm
          ? t('business.bookingAutoConfirm')
          : t('business.bookingSubmitted'),
      });
      setTargetId('');
      setStartsAt('');
      setNotes('');
      mine.reload();
    } catch (e) {
      setError(
        e instanceof ApiError && e.status === 409
          ? t('business.bookingUnavailable')
          : describeError(e, t).message,
      );
    } finally {
      setBusy(false);
    }
  };

  const cancelBooking = async (bookingId: string) => {
    try {
      await api.bookings.cancel(bookingId);
      mine.reload();
      toast.show({ tone: 'success', title: t('business.bookingCancelled') });
    } catch (e) {
      toast.show({
        tone: 'danger',
        title: t('error.actionFailed'),
        description: describeError(e, t).message,
      });
    }
  };

  return (
    <div className="stack">
      <Card padding="lg" className="stack">
        <h2 className="section-title">{t('business.bookingTitle')}</h2>
        {info.places.length > 0 && info.services.length > 0 ? (
          <RadioGroup
            legend={t('business.bookingChooseWhat')}
            value={choice}
            onValueChange={(v) => {
              setChoice(v as 'place' | 'service');
              setTargetId('');
            }}
          >
            <Radio value="place" label={t('business.bookingChoosePlace')} />
            <Radio value="service" label={t('business.bookingChooseService')} />
          </RadioGroup>
        ) : null}
        <FormField
          label={
            choice === 'place'
              ? t('business.bookingChoosePlace')
              : t('business.bookingChooseService')
          }
        >
          <Select value={targetId} onChange={(e) => setTargetId(e.target.value)}>
            <option value="">—</option>
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {'name' in o ? o.name : o.title}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField label={t('business.bookingDate')}>
          <Input
            type="datetime-local"
            value={startsAt}
            onChange={(e) => setStartsAt(e.target.value)}
          />
        </FormField>
        <div className="inline-form">
          <FormField label={t('business.bookingParty')}>
            <Input
              type="number"
              min={1}
              value={partySize}
              onChange={(e) => setPartySize(e.target.value)}
            />
          </FormField>
          <FormField label={t('business.bookingDuration')}>
            <Input
              type="number"
              min={5}
              step={5}
              value={duration}
              onChange={(e) => setDuration(e.target.value)}
            />
          </FormField>
        </div>
        <FormField label={t('business.bookingNotes')}>
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} />
        </FormField>
        {error ? (
          <p className="yl-notice yl-notice--danger" role="alert">
            {error}
          </p>
        ) : null}
        <div className="button-row">
          <Button
            onClick={() => void submit()}
            loading={busy}
            loadingLabel={t('common.saving')}
            disabled={!targetId || !startsAt}
          >
            {t('business.bookingSubmit')}
          </Button>
        </div>
      </Card>
      <section aria-labelledby="my-bookings-h" className="stack-sm">
        <h2 id="my-bookings-h" className="section-title">
          {t('business.myBookingsTitle')}
        </h2>
        {mine.loading ? <PageSpinner /> : null}
        {mine.error ? <ErrorView error={mine.error} onRetry={mine.reload} /> : null}
        {!mine.loading &&
        !mine.error &&
        mine.items.filter((b) => b.businessId === id).length === 0 ? (
          <p className="muted">{t('business.myBookingsEmpty')}</p>
        ) : null}
        <ul className="stack-sm">
          {mine.items
            .filter((b) => b.businessId === id)
            .map((b) => (
              <li key={b.id} className="search-row">
                <div className="search-row__text">
                  <span>{b.targetName ?? b.business?.name}</span>
                  <span className="muted">{new Date(b.startsAt).toLocaleString()}</span>
                </div>
                <Badge>{t(`business.booking.status.${b.status}`)}</Badge>
                {b.status === 'requested' || b.status === 'confirmed' ? (
                  <Button variant="ghost" size="sm" onClick={() => void cancelBooking(b.id)}>
                    {t('business.bookingCancel')}
                  </Button>
                ) : null}
              </li>
            ))}
        </ul>
      </section>
    </div>
  );
}

export function BusinessProfileView({ ref }: { ref: string }) {
  const api = useApi();
  const { t } = useI18n();
  const toast = useToast();
  const biz = useAsync((signal) => api.business.get(ref, { signal }), [api, ref]);
  usePageTitle(biz.data?.name, t('app.name'));

  const toggleFollow = async () => {
    if (!biz.data) return;
    try {
      if (biz.data.viewer.following) {
        await api.business.unfollow(biz.data.id);
        biz.setData((b) =>
          b
            ? {
                ...b,
                followerCount: b.followerCount - 1,
                viewer: { ...b.viewer, following: false },
              }
            : b,
        );
      } else {
        const r = await api.business.follow(biz.data.id);
        biz.setData((b) =>
          b
            ? { ...b, followerCount: r.followerCount, viewer: { ...b.viewer, following: true } }
            : b,
        );
      }
    } catch (e) {
      toast.show({
        tone: 'danger',
        title: t('error.actionFailed'),
        description: describeError(e, t).message,
      });
    }
  };

  if (biz.loading) return <PageSpinner />;
  if (biz.error) {
    if (biz.error instanceof ApiError && biz.error.status === 404) {
      return <EmptyState icon={<StoreIcon size={28} />} title={t('business.notFound')} />;
    }
    if (biz.error instanceof ApiError && biz.error.status === 403) {
      return <EmptyState icon={<StoreIcon size={28} />} title={t('business.suspended')} />;
    }
    return <ErrorView error={biz.error} onRetry={biz.reload} />;
  }
  const b = biz.data;
  if (!b) return null;

  return (
    <>
      <PageHeader
        title={b.name}
        lead={
          <span className="button-row">
            <span>{b.category}</span>
            {b.verified ? (
              <Badge icon={<CheckIcon size={12} />}>{t('business.verified')}</Badge>
            ) : null}
            <span>{t('business.followers', { count: b.followerCount })}</span>
          </span>
        }
        actions={
          <Button
            variant={b.viewer.following ? 'soft' : 'primary'}
            onClick={() => void toggleFollow()}
          >
            {b.viewer.following ? t('business.unfollow') : t('business.follow')}
          </Button>
        }
      />
      {b.coverUrl ? <img src={b.coverUrl} alt="" className="event-detail__cover" /> : null}
      <Tabs defaultValue="about">
        <TabList label={b.name} className="yl-tablist--scroll">
          <Tab value="about">{t('business.tab.about')}</Tab>
          <Tab value="posts">{t('business.tab.posts')}</Tab>
          <Tab value="events">{t('business.tab.events')}</Tab>
          <Tab value="offers">{t('business.tab.offers')}</Tab>
          <Tab value="services">{t('business.tab.services')}</Tab>
          <Tab value="book">{t('business.tab.book')}</Tab>
        </TabList>
        <TabPanel value="about">
          <AboutTab id={b.id} />
        </TabPanel>
        <TabPanel value="posts">
          <PostsTab id={b.id} />
        </TabPanel>
        <TabPanel value="events">
          <EventsTab id={b.id} />
        </TabPanel>
        <TabPanel value="offers">
          <OffersTab id={b.id} />
        </TabPanel>
        <TabPanel value="services">
          <ServicesTab id={b.id} />
        </TabPanel>
        <TabPanel value="book">
          <BookTab id={b.id} />
        </TabPanel>
      </Tabs>
    </>
  );
}
