'use client';

import { useState } from 'react';
import type { AiArtifact } from '@yapilapi/api-client';
import { EmptyState, FeedTabs, SparkIcon } from '@yapilapi/ui';
import { useI18n } from '@/i18n';
import { useApi } from '@/lib/api';
import { useAsync, usePageTitle } from '@/lib/hooks';
import { PageHeader } from '@/components/PageHeader';
import { ErrorView, PageSpinner } from '@/components/common';
import { ArtifactCard } from './ArtifactCard';

type Status = 'draft' | 'confirmed' | 'discarded';
const TABS: Status[] = ['draft', 'confirmed', 'discarded'];

/** Every draft the assistant has proposed. Nothing here was applied unless it is shown as confirmed. */
export function ArtifactsView() {
  const api = useApi();
  const { t } = useI18n();
  usePageTitle(t('ai.drafts.title'), t('app.name'));
  const [status, setStatus] = useState<Status>('draft');
  const [items, setItems] = useState<AiArtifact[] | null>(null);

  const state = useAsync(
    async (signal) => {
      const r = await api.ai.artifacts({ status, limit: 50, signal });
      return r.items;
    },
    [api, status],
  );
  const list = items ?? state.data ?? [];

  return (
    <>
      <PageHeader title={t('ai.drafts.title')} lead={t('ai.drafts.lead')} />
      <FeedTabs
        label={t('ai.drafts.title')}
        value={status}
        onChange={(v) => {
          setItems(null);
          setStatus(v as Status);
        }}
        tabs={TABS.map((id) => ({ id, label: t(`ai.drafts.tab.${id}`) }))}
      >
        {state.loading ? <PageSpinner /> : null}
        {state.error ? <ErrorView error={state.error} onRetry={state.reload} /> : null}
        {!state.loading && !state.error && list.length === 0 ? (
          <EmptyState
            icon={<SparkIcon size={28} />}
            title={t('ai.drafts.emptyTitle')}
            description={t('ai.drafts.emptyBody')}
          />
        ) : null}
        {list.length > 0 ? (
          <div className="stack-sm">
            {list.map((a) => (
              <ArtifactCard
                key={a.id}
                artifact={a}
                onChanged={(updated) =>
                  setItems(list.map((x) => (x.id === updated.id ? updated : x)))
                }
                onRemoved={(id) => setItems(list.filter((x) => x.id !== id))}
              />
            ))}
          </div>
        ) : null}
      </FeedTabs>
    </>
  );
}
