'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { ExperienceVisibility, TogetherExperience } from '@yapilapi/api-client';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  FeedTabs,
  FormField,
  Input,
  PeopleIcon,
  Select,
  Textarea,
  useToast,
} from '@yapilapi/ui';
import { useI18n } from '@/i18n';
import { useApi } from '@/lib/api';
import { useInfinite, usePageTitle } from '@/lib/hooks';
import { describeError } from '@/lib/errors';
import { PageHeader } from '@/components/PageHeader';
import { ConfirmDialog, ErrorView, InfiniteFooter, PageSpinner } from '@/components/common';

type Tab = 'joined' | 'invited';

const STATUS_KEYS = {
  open: 'together.status.open',
  closed: 'together.status.closed',
  archived: 'together.status.archived',
} as const;

function fail(toast: ReturnType<typeof useToast>, t: ReturnType<typeof useI18n>['t'], e: unknown) {
  toast.show({
    tone: 'danger',
    title: t('error.actionFailed'),
    description: describeError(e, t).message,
  });
}

// ------------------------------------------------------------------ card
function ExperienceCard({
  x,
  showInvite,
  onChanged,
}: {
  x: TogetherExperience;
  showInvite: boolean;
  onChanged: () => void;
}) {
  const api = useApi();
  const { t } = useI18n();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [declineOpen, setDeclineOpen] = useState(false);

  const accept = async () => {
    setBusy(true);
    try {
      await api.together.accept(x.id);
      toast.show({ tone: 'success', title: t('together.accepted') });
      onChanged();
    } catch (e) {
      fail(toast, t, e);
    } finally {
      setBusy(false);
    }
  };
  const decline = async () => {
    setBusy(true);
    try {
      await api.together.decline(x.id);
      toast.show({ tone: 'success', title: t('together.declined') });
      setDeclineOpen(false);
      onChanged();
    } catch (e) {
      fail(toast, t, e);
      setDeclineOpen(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card as="li" padding="md" className="stack-sm">
      <Link href={`/together/${encodeURIComponent(x.id)}`} className="entity-card__title">
        {x.title}
      </Link>
      <span className="entity-card__meta">
        <Badge>{t(STATUS_KEYS[x.status])}</Badge>
        <span>{t('together.members.count', { count: x.counts.members })}</span>
        <span>{t('together.contribute.count', { count: x.counts.contributions })}</span>
      </span>
      {x.description ? <p className="muted">{x.description}</p> : null}
      {showInvite ? (
        <div className="button-row">
          <Button size="sm" loading={busy} onClick={() => void accept()}>
            {t('together.accept')}
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setDeclineOpen(true)}>
            {t('together.decline')}
          </Button>
        </div>
      ) : null}
      <ConfirmDialog
        open={declineOpen}
        title={t('together.declineConfirm.title')}
        description={t('together.declineConfirm.body')}
        confirmLabel={t('together.decline')}
        danger
        busy={busy}
        onConfirm={() => void decline()}
        onClose={() => setDeclineOpen(false)}
      />
    </Card>
  );
}

// ------------------------------------------------------------------ new
function NewExperienceForm({ onCreated }: { onCreated: () => void }) {
  const api = useApi();
  const { t } = useI18n();
  const toast = useToast();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [visibility, setVisibility] = useState<ExperienceVisibility>('private');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const create = async () => {
    setBusy(true);
    setError('');
    try {
      await api.together.create({
        title: title.trim(),
        description: description.trim(),
        visibility,
      });
      toast.show({ tone: 'success', title: t('together.created') });
      setTitle('');
      setDescription('');
      onCreated();
    } catch (e) {
      setError(describeError(e, t).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card padding="md" className="stack-sm">
      <h3 className="section-title">{t('together.new')}</h3>
      <FormField label={t('together.form.title')} required>
        <Input value={title} onChange={(e) => setTitle(e.target.value)} />
      </FormField>
      <FormField label={t('together.form.description')}>
        <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
      </FormField>
      <FormField label={t('together.form.visibility')}>
        <Select
          value={visibility}
          onChange={(e) => setVisibility(e.target.value as ExperienceVisibility)}
        >
          <option value="private">{t('together.form.visibility.private')}</option>
          <option value="friends">{t('together.form.visibility.friends')}</option>
          <option value="public">{t('together.form.visibility.public')}</option>
        </Select>
      </FormField>
      {error ? (
        <p className="yl-notice yl-notice--danger" role="alert">
          {error}
        </p>
      ) : null}
      <Button loading={busy} disabled={!title.trim()} onClick={() => void create()}>
        {t('together.form.create')}
      </Button>
    </Card>
  );
}

// ------------------------------------------------------------------ panels
function JoinedPanel() {
  const api = useApi();
  const { t } = useI18n();
  const state = useInfinite<TogetherExperience>(
    (cursor, signal) => api.together.mine({ membership: 'joined', limit: 15, cursor, signal }),
    'joined',
  );
  return (
    <div className="stack">
      <NewExperienceForm onCreated={state.reload} />
      {state.loading ? <PageSpinner /> : null}
      {state.error ? <ErrorView error={state.error} onRetry={state.reload} /> : null}
      {!state.loading && !state.error && state.items.length === 0 ? (
        <EmptyState icon={<PeopleIcon size={28} />} title={t('together.empty')} />
      ) : null}
      {state.items.length > 0 ? (
        <ul className="stack-sm">
          {state.items.map((x) => (
            <ExperienceCard key={x.id} x={x} showInvite={false} onChanged={state.reload} />
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

function InvitedPanel() {
  const api = useApi();
  const { t } = useI18n();
  const state = useInfinite<TogetherExperience>(
    (cursor, signal) => api.together.mine({ membership: 'invited', limit: 15, cursor, signal }),
    'invited',
  );
  return (
    <div className="stack">
      {state.loading ? <PageSpinner /> : null}
      {state.error ? <ErrorView error={state.error} onRetry={state.reload} /> : null}
      {!state.loading && !state.error && state.items.length === 0 ? (
        <EmptyState icon={<PeopleIcon size={28} />} title={t('together.empty')} />
      ) : null}
      {state.items.length > 0 ? (
        <ul className="stack-sm">
          {state.items.map((x) => (
            <ExperienceCard key={x.id} x={x} showInvite onChanged={state.reload} />
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

// ------------------------------------------------------------------ shell
export function TogetherListView() {
  const { t } = useI18n();
  usePageTitle(t('together.title'), t('app.name'));
  const [tab, setTab] = useState<Tab>('joined');

  return (
    <>
      <PageHeader title={t('together.title')} lead={t('together.lead')} />
      <FeedTabs
        label={t('together.title')}
        value={tab}
        onChange={(v) => setTab(v as Tab)}
        tabs={[
          { id: 'joined', label: t('together.tab.joined') },
          { id: 'invited', label: t('together.tab.invited') },
        ]}
      >
        {tab === 'joined' ? <JoinedPanel key="joined" /> : null}
        {tab === 'invited' ? <InvitedPanel key="invited" /> : null}
      </FeedTabs>
    </>
  );
}
