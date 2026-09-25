'use client';

import type { UserCard, Page } from '@yapilapi/api-client';
import { Dialog, Button, Spinner } from '@yapilapi/ui';
import { useI18n } from '@/i18n';
import { useInfinite } from '@/lib/hooks';
import { ErrorView } from '@/components/common';
import { UserRow } from './UserRow';

/** Paged list of people (followers, following, …) in a dialog. Fetches only while open. */
export function UserListDialog({
  open,
  title,
  onClose,
  load,
  cacheKey,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  cacheKey: string;
  load: (cursor: string | undefined, signal: AbortSignal) => Promise<Page<UserCard>>;
}) {
  const { t } = useI18n();
  const state = useInfinite(load, cacheKey, open);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      closeLabel={t('common.close')}
      footer={
        <Button variant="secondary" onClick={onClose}>
          {t('common.close')}
        </Button>
      }
    >
      {state.loading ? <Spinner label={t('common.loading')} /> : null}
      {state.error ? <ErrorView error={state.error} onRetry={state.reload} /> : null}
      {!state.loading && !state.error && state.items.length === 0 ? (
        <p className="muted">{t('people.none')}</p>
      ) : null}
      {state.items.length ? (
        <ul className="person-list" aria-label={title}>
          {state.items.map((u) => (
            <UserRow key={u.id} user={u} />
          ))}
        </ul>
      ) : null}
      {state.moreError ? (
        <ErrorView error={state.moreError} onRetry={state.loadMore} title={t('error.moreTitle')} />
      ) : null}
      {state.hasMore && !state.moreError ? (
        <Button
          variant="secondary"
          onClick={state.loadMore}
          loading={state.loadingMore}
          loadingLabel={t('common.loading')}
        >
          {t('common.loadMore')}
        </Button>
      ) : null}
    </Dialog>
  );
}
