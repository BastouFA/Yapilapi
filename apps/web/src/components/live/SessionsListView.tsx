'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { LiveMediaMode, LiveVisibility } from '@yapilapi/api-client';
import {
  Button,
  Card,
  EmptyState,
  FeedTabs,
  FormField,
  Input,
  MicIcon,
  Select,
  Textarea,
  useToast,
} from '@yapilapi/ui';
import { useI18n } from '@/i18n';
import { useApi } from '@/lib/api';
import { useAsync, usePageTitle } from '@/lib/hooks';
import { describeError } from '@/lib/errors';
import { PageHeader } from '@/components/PageHeader';
import { ErrorView, PageSpinner } from '@/components/common';

type Tab = 'live' | 'scheduled' | 'ended' | 'mine';

function SessionRow({
  id,
  title,
  status,
  viewerCount,
  scheduledFor,
  host,
}: {
  id: string;
  title: string;
  status: string;
  viewerCount: number;
  scheduledFor: string | null;
  host?: { username: string } | undefined;
}) {
  const { t, fmt } = useI18n();
  return (
    <li className="search-row">
      <Link href={`/live/${encodeURIComponent(id)}`} className="search-row__text">
        <span>{title}</span>
        <span className="muted">
          {t(`live.status.${status}` as 'live.status.live')}
          {status === 'live' ? ` · ${t('live.viewerCount', { count: viewerCount })}` : ''}
          {status === 'scheduled' && scheduledFor
            ? ` · ${t('live.scheduledFor', { date: fmt.dateTime(scheduledFor) })}`
            : ''}
          {host ? ` · @${host.username}` : ''}
        </span>
      </Link>
    </li>
  );
}

function NewSessionForm({ onCreated }: { onCreated: () => void }) {
  const api = useApi();
  const { t } = useI18n();
  const toast = useToast();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [visibility, setVisibility] = useState<LiveVisibility>('followers');
  const [mediaMode, setMediaMode] = useState<LiveMediaMode>('interactive');
  const [scheduledFor, setScheduledFor] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const create = async () => {
    setBusy(true);
    setError('');
    try {
      await api.live.create({
        title: title.trim(),
        description: description.trim() || undefined,
        visibility,
        mediaMode,
        scheduledFor: scheduledFor ? new Date(scheduledFor).toISOString() : undefined,
      });
      toast.show({ tone: 'success', title: t('live.created') });
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
      <h3 className="section-title">{t('live.new')}</h3>
      <FormField label={t('live.form.title')} required>
        <Input value={title} onChange={(e) => setTitle(e.target.value)} />
      </FormField>
      <FormField label={t('live.form.description')}>
        <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
      </FormField>
      <FormField label={t('live.form.visibility')}>
        <Select
          value={visibility}
          onChange={(e) => setVisibility(e.target.value as LiveVisibility)}
        >
          <option value="public">{t('live.form.visibility.public')}</option>
          <option value="followers">{t('live.form.visibility.followers')}</option>
          <option value="subscribers">{t('live.form.visibility.subscribers')}</option>
          <option value="private">{t('live.form.visibility.private')}</option>
        </Select>
      </FormField>
      <FormField label={t('live.form.mediaMode')}>
        <Select value={mediaMode} onChange={(e) => setMediaMode(e.target.value as LiveMediaMode)}>
          <option value="interactive">{t('live.form.mediaMode.interactive')}</option>
          <option value="video">{t('live.form.mediaMode.video')}</option>
        </Select>
      </FormField>
      {mediaMode === 'video' ? <p className="muted">{t('live.videoUnavailable')}</p> : null}
      <FormField label={t('live.form.scheduledFor')}>
        <Input
          type="datetime-local"
          value={scheduledFor}
          onChange={(e) => setScheduledFor(e.target.value)}
        />
      </FormField>
      {error ? (
        <p className="yl-notice yl-notice--danger" role="alert">
          {error}
        </p>
      ) : null}
      <Button loading={busy} disabled={!title.trim()} onClick={() => void create()}>
        {t('live.form.create')}
      </Button>
    </Card>
  );
}

function StatusPanel({ status }: { status: 'live' | 'scheduled' | 'ended' }) {
  const api = useApi();
  const { t } = useI18n();
  const state = useAsync((signal) => api.live.list({ status, signal }), [api, status]);
  if (state.loading) return <PageSpinner />;
  if (state.error) return <ErrorView error={state.error} onRetry={state.reload} />;
  const items = state.data?.items ?? [];
  if (items.length === 0)
    return <EmptyState icon={<MicIcon size={28} />} title={t('live.empty')} />;
  return (
    <ul className="stack-sm">
      {items.map((s) => (
        <SessionRow
          key={s.id}
          id={s.id}
          title={s.title}
          status={s.status}
          viewerCount={s.viewerCount}
          scheduledFor={s.scheduledFor}
          host={s.host}
        />
      ))}
    </ul>
  );
}

function MinePanel() {
  const api = useApi();
  const { t } = useI18n();
  const state = useAsync((signal) => api.live.mine({ signal }), [api]);
  if (state.loading) return <PageSpinner />;
  if (state.error) return <ErrorView error={state.error} onRetry={state.reload} />;
  const items = state.data?.items ?? [];
  return (
    <div className="stack">
      <NewSessionForm onCreated={state.reload} />
      {items.length === 0 ? (
        <p className="muted">{t('live.empty')}</p>
      ) : (
        <ul className="stack-sm">
          {items.map((s) => (
            <SessionRow
              key={s.id}
              id={s.id}
              title={s.title}
              status={s.status}
              viewerCount={s.viewerCount}
              scheduledFor={s.scheduledFor}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

export function SessionsListView() {
  const { t } = useI18n();
  usePageTitle(t('live.title'), t('app.name'));
  const [tab, setTab] = useState<Tab>('live');

  return (
    <>
      <PageHeader title={t('live.title')} lead={t('live.lead')} />
      <FeedTabs
        label={t('live.title')}
        value={tab}
        onChange={(v) => setTab(v as Tab)}
        tabs={[
          { id: 'live', label: t('live.tab.live') },
          { id: 'scheduled', label: t('live.tab.scheduled') },
          { id: 'ended', label: t('live.tab.ended') },
          { id: 'mine', label: t('live.mine') },
        ]}
      >
        {tab === 'live' ? <StatusPanel key="live" status="live" /> : null}
        {tab === 'scheduled' ? <StatusPanel key="scheduled" status="scheduled" /> : null}
        {tab === 'ended' ? <StatusPanel key="ended" status="ended" /> : null}
        {tab === 'mine' ? <MinePanel key="mine" /> : null}
      </FeedTabs>
    </>
  );
}
