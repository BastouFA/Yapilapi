'use client';

import { useState } from 'react';
import Link from 'next/link';
import type {
  MemoryItemType,
  MemoryPrivacy,
  MemorySummary,
  MemoryTimelineEntry,
  MemoryTripSuggestion,
  OnThisDaySuggestion,
} from '@yapilapi/api-client';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  FeedTabs,
  FormField,
  ImageIcon,
  Input,
  Select,
  Textarea,
  useToast,
} from '@yapilapi/ui';
import { useI18n } from '@/i18n';
import { useApi } from '@/lib/api';
import { useAsync, useInfinite, usePageTitle } from '@/lib/hooks';
import { describeError } from '@/lib/errors';
import { PageHeader } from '@/components/PageHeader';
import { ErrorView, InfiniteFooter, PageSpinner } from '@/components/common';

type Tab = 'mine' | 'timeline' | 'onThisDay' | 'trips';

const KIND_KEYS = {
  highlight: 'memory.kind.highlight',
  recap: 'memory.kind.recap',
  timeline: 'memory.kind.timeline',
  collection: 'memory.kind.collection',
  trip: 'memory.kind.trip',
  on_this_day: 'memory.kind.on_this_day',
} as const;

const ITEM_TYPE_KEYS = {
  post: 'memory.items.type.post',
  moment: 'memory.items.type.moment',
  media: 'memory.items.type.media',
  event: 'memory.items.type.event',
  real_capture: 'memory.items.type.real_capture',
  experience: 'memory.items.type.experience',
  message: 'memory.items.type.message',
} as const satisfies Record<MemoryItemType, string>;

const ITEM_TYPES: MemoryItemType[] = [
  'post',
  'moment',
  'media',
  'event',
  'real_capture',
  'experience',
  'message',
];

// ------------------------------------------------------------------ mine
function MemoryCard({ m }: { m: MemorySummary }) {
  const { t, fmt } = useI18n();
  return (
    <Card as="li" padding="md" className="stack-sm">
      <Link href={`/memory/${encodeURIComponent(m.id)}`} className="entity-card__title">
        {m.title}
      </Link>
      <span className="entity-card__meta">
        <Badge>{t(KIND_KEYS[m.kind])}</Badge>
        <span>{t('memory.itemCount', { count: m.itemCount })}</span>
        <span>{fmt.relative(m.createdAt)}</span>
      </span>
      {m.summary ? <p className="muted">{m.summary}</p> : null}
    </Card>
  );
}

function NewMemoryForm({ onCreated }: { onCreated: (id: string) => void }) {
  const api = useApi();
  const { t } = useI18n();
  const toast = useToast();
  const [title, setTitle] = useState('');
  const [summary, setSummary] = useState('');
  const [privacy, setPrivacy] = useState<MemoryPrivacy>('private');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const create = async () => {
    setBusy(true);
    setError('');
    try {
      const m = await api.memory.create({ title: title.trim(), summary: summary.trim(), privacy });
      toast.show({ tone: 'success', title: t('memory.created') });
      setTitle('');
      setSummary('');
      onCreated(m.id);
    } catch (e) {
      setError(describeError(e, t).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card padding="md" className="stack-sm">
      <h3 className="section-title">{t('memory.new')}</h3>
      <FormField label={t('memory.form.title')} required>
        <Input value={title} onChange={(e) => setTitle(e.target.value)} />
      </FormField>
      <FormField label={t('memory.form.summary')}>
        <Textarea value={summary} onChange={(e) => setSummary(e.target.value)} rows={2} />
      </FormField>
      <FormField label={t('memory.form.privacy')}>
        <Select value={privacy} onChange={(e) => setPrivacy(e.target.value as MemoryPrivacy)}>
          <option value="private">{t('memory.form.privacy.private')}</option>
          <option value="friends">{t('memory.form.privacy.friends')}</option>
          <option value="public">{t('memory.form.privacy.public')}</option>
        </Select>
      </FormField>
      {error ? (
        <p className="yl-notice yl-notice--danger" role="alert">
          {error}
        </p>
      ) : null}
      <Button loading={busy} disabled={!title.trim()} onClick={() => void create()}>
        {t('memory.form.create')}
      </Button>
    </Card>
  );
}

function MinePanel() {
  const api = useApi();
  const { t } = useI18n();
  const [q, setQ] = useState('');
  const state = useInfinite<MemorySummary>(
    (cursor, signal) => api.memory.list({ q: q.trim() || undefined, limit: 15, cursor, signal }),
    `mine:${q}`,
  );
  return (
    <div className="stack">
      <FormField label={t('memory.search')}>
        <Input value={q} onChange={(e) => setQ(e.target.value)} />
      </FormField>
      <NewMemoryForm onCreated={state.reload} />
      {state.loading ? <PageSpinner /> : null}
      {state.error ? <ErrorView error={state.error} onRetry={state.reload} /> : null}
      {!state.loading && !state.error && state.items.length === 0 ? (
        <EmptyState icon={<ImageIcon size={28} />} title={t('memory.empty')} />
      ) : null}
      {state.items.length > 0 ? (
        <ul className="stack-sm">
          {state.items.map((m) => (
            <MemoryCard key={m.id} m={m} />
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
    </div>
  );
}

// ------------------------------------------------------------------ timeline
function TimelineRow({ i }: { i: MemoryTimelineEntry }) {
  const { t, fmt } = useI18n();
  return (
    <li className="search-row">
      <span className="search-row__text">
        <span>{i.text || t(ITEM_TYPE_KEYS[i.type])}</span>
        <span className="muted">
          {t(ITEM_TYPE_KEYS[i.type])}
          {i.at ? ` · ${fmt.dateTime(i.at)}` : ''}
        </span>
      </span>
    </li>
  );
}

function TimelinePanel() {
  const api = useApi();
  const { t } = useI18n();
  const [type, setType] = useState<MemoryItemType | ''>('');
  const state = useInfinite<MemoryTimelineEntry>(
    (cursor, signal) =>
      api.memory.timeline({
        types: type ? [type] : undefined,
        order: 'desc',
        limit: 20,
        cursor,
        signal,
      }),
    `timeline:${type}`,
  );
  return (
    <div className="stack">
      <p className="muted">{t('memory.timeline.lead')}</p>
      <FormField label={t('memory.timeline.filterType')}>
        <Select value={type} onChange={(e) => setType(e.target.value as MemoryItemType | '')}>
          <option value="">{t('memory.timeline.filterAll')}</option>
          {ITEM_TYPES.map((it) => (
            <option key={it} value={it}>
              {t(ITEM_TYPE_KEYS[it])}
            </option>
          ))}
        </Select>
      </FormField>
      {state.loading ? <PageSpinner /> : null}
      {state.error ? <ErrorView error={state.error} onRetry={state.reload} /> : null}
      {!state.loading && !state.error && state.items.length === 0 ? (
        <p className="muted">{t('memory.timeline.empty')}</p>
      ) : null}
      {state.items.length > 0 ? (
        <ul className="stack-sm">
          {state.items.map((i, idx) => (
            <TimelineRow key={`${i.type}:${i.id}:${idx}`} i={i} />
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
    </div>
  );
}

// ------------------------------------------------------------------ on this day
function OnThisDayPanel() {
  const api = useApi();
  const { t, fmt } = useI18n();
  const toast = useToast();
  const state = useAsync((signal) => api.memory.onThisDay({ signal }), [api]);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const fail = (e: unknown) =>
    toast.show({
      tone: 'danger',
      title: t('error.actionFailed'),
      description: describeError(e, t).message,
    });

  const accept = async (s: OnThisDaySuggestion) => {
    setBusyKey(s.key);
    try {
      await api.memory.acceptOnThisDay({ date: s.date, year: s.year });
      toast.show({ tone: 'success', title: t('memory.onThisDay.accepted') });
      state.setData((d) => (d ? { suggestions: d.suggestions.filter((x) => x.key !== s.key) } : d));
    } catch (e) {
      fail(e);
    } finally {
      setBusyKey(null);
    }
  };
  const dismiss = async (s: OnThisDaySuggestion) => {
    setBusyKey(s.key);
    try {
      await api.memory.dismissSuggestion(s.key);
      state.setData((d) => (d ? { suggestions: d.suggestions.filter((x) => x.key !== s.key) } : d));
    } catch (e) {
      fail(e);
    } finally {
      setBusyKey(null);
    }
  };

  if (state.loading) return <PageSpinner />;
  if (state.error) return <ErrorView error={state.error} onRetry={state.reload} />;
  const items = state.data?.suggestions ?? [];
  return (
    <div className="stack">
      <p className="muted">{t('memory.onThisDay.lead')}</p>
      {items.length === 0 ? <p className="muted">{t('memory.onThisDay.empty')}</p> : null}
      {items.map((s) => (
        <Card key={s.key} padding="md" className="stack-sm">
          <p>
            <strong>{t('memory.onThisDay.year', { year: s.year, count: s.itemCount })}</strong>
          </p>
          <ul className="stack-sm">
            {s.items.slice(0, 5).map((it, idx) => (
              <li key={idx} className="muted">
                {it.text || t(ITEM_TYPE_KEYS[it.type])}
                {it.at ? ` · ${fmt.dateTime(it.at)}` : ''}
              </li>
            ))}
          </ul>
          <div className="button-row">
            <Button size="sm" loading={busyKey === s.key} onClick={() => void accept(s)}>
              {t('memory.onThisDay.accept')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busyKey === s.key}
              onClick={() => void dismiss(s)}
            >
              {t('memory.onThisDay.dismiss')}
            </Button>
          </div>
        </Card>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ trips
function TripsPanel() {
  const api = useApi();
  const { t, fmt } = useI18n();
  const toast = useToast();
  const state = useAsync((signal) => api.memory.tripSuggestions({ signal }), [api]);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const fail = (e: unknown) =>
    toast.show({
      tone: 'danger',
      title: t('error.actionFailed'),
      description: describeError(e, t).message,
    });

  const accept = async (s: MemoryTripSuggestion) => {
    setBusyKey(s.key);
    try {
      await api.memory.acceptTrip({ key: s.key });
      toast.show({ tone: 'success', title: t('memory.trips.accepted') });
      state.setData((d) => (d ? { suggestions: d.suggestions.filter((x) => x.key !== s.key) } : d));
    } catch (e) {
      fail(e);
    } finally {
      setBusyKey(null);
    }
  };
  const dismiss = async (s: MemoryTripSuggestion) => {
    setBusyKey(s.key);
    try {
      await api.memory.dismissSuggestion(`trip:${s.key}`);
      state.setData((d) => (d ? { suggestions: d.suggestions.filter((x) => x.key !== s.key) } : d));
    } catch (e) {
      fail(e);
    } finally {
      setBusyKey(null);
    }
  };

  if (state.loading) return <PageSpinner />;
  if (state.error) return <ErrorView error={state.error} onRetry={state.reload} />;
  const items = state.data?.suggestions ?? [];
  return (
    <div className="stack">
      <p className="muted">{t('memory.trips.lead')}</p>
      {items.length === 0 ? <p className="muted">{t('memory.trips.empty')}</p> : null}
      {items.map((s) => (
        <Card key={s.key} padding="md" className="stack-sm">
          <p>
            <strong>
              {t('memory.trips.range', {
                start: fmt.dateTime(s.startAt),
                end: fmt.dateTime(s.endAt),
              })}
            </strong>
          </p>
          <p className="muted">
            {t('memory.trips.stats', { count: s.itemCount, days: s.distinctDays })}
          </p>
          <div className="button-row">
            <Button size="sm" loading={busyKey === s.key} onClick={() => void accept(s)}>
              {t('memory.trips.accept')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busyKey === s.key}
              onClick={() => void dismiss(s)}
            >
              {t('memory.trips.dismiss')}
            </Button>
          </div>
        </Card>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ shell
export function MemoriesListView() {
  const { t } = useI18n();
  usePageTitle(t('memory.title'), t('app.name'));
  const [tab, setTab] = useState<Tab>('mine');

  return (
    <>
      <PageHeader title={t('memory.title')} lead={t('memory.lead')} />
      <FeedTabs
        label={t('memory.title')}
        value={tab}
        onChange={(v) => setTab(v as Tab)}
        tabs={[
          { id: 'mine', label: t('memory.tab.mine') },
          { id: 'timeline', label: t('memory.tab.timeline') },
          { id: 'onThisDay', label: t('memory.tab.onThisDay') },
          { id: 'trips', label: t('memory.tab.trips') },
        ]}
      >
        {tab === 'mine' ? <MinePanel key="mine" /> : null}
        {tab === 'timeline' ? <TimelinePanel key="timeline" /> : null}
        {tab === 'onThisDay' ? <OnThisDayPanel key="onThisDay" /> : null}
        {tab === 'trips' ? <TripsPanel key="trips" /> : null}
      </FeedTabs>
    </>
  );
}

export { ITEM_TYPE_KEYS, ITEM_TYPES, KIND_KEYS };
