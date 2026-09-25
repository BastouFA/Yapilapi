'use client';

import { EmptyState, LockIcon } from '@yapilapi/ui';
import { useI18n } from '@/i18n';
import { useApi } from '@/lib/api';
import { useAsync } from '@/lib/hooks';
import { ErrorView, PageSpinner } from '@/components/common';
import { EventFormView } from './EventFormView';

export function EventEditView({ id }: { id: string }) {
  const api = useApi();
  const { t } = useI18n();
  const ev = useAsync((signal) => api.events.get(id, { signal }), [api, id]);

  if (ev.loading) return <PageSpinner />;
  if (ev.error) return <ErrorView error={ev.error} onRetry={ev.reload} />;
  if (!ev.data) return null;
  if (!ev.data.viewer.isOrganiser && !ev.data.viewer.isManager) {
    return <EmptyState icon={<LockIcon size={28} />} title={t('events.notFound')} />;
  }
  return <EventFormView existing={ev.data} />;
}
