'use client';

import Link from 'next/link';
import { EmptyState, BookmarkIcon, buttonClass } from '@yapilapi/ui';
import { useI18n } from '@/i18n';
import { useApi } from '@/lib/api';
import { useInfinite, usePageTitle } from '@/lib/hooks';
import { PageHeader } from '@/components/PageHeader';
import { PostList } from '@/components/PostList';

export function SavedView() {
  const api = useApi();
  const { t } = useI18n();
  usePageTitle(t('nav.saved'), t('app.name'));
  const state = useInfinite(
    (cursor, signal) => api.saves.list({ ...(cursor ? { cursor } : {}), limit: 15, signal }),
    'saved',
  );
  return (
    <>
      <PageHeader title={t('saved.title')} lead={t('saved.lead')} />
      <PostList
        state={state}
        label={t('saved.title')}
        explain={false}
        empty={
          <EmptyState
            icon={<BookmarkIcon size={28} />}
            title={t('saved.emptyTitle')}
            description={t('saved.emptyBody')}
            action={
              <Link href="/discover" className={buttonClass({ variant: 'primary' })}>
                {t('nav.discover')}
              </Link>
            }
          />
        }
      />
    </>
  );
}
